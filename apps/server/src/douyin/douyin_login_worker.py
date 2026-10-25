"""Douyin QR login worker.

Opens a REAL browser window (headless=False — we deliberately avoid headless,
which Douyin answers with a slider challenge), waits for the login dialog,
hands the QR image back to the caller, then polls for the session cookie.

Protocol (stdout, one JSON object per line):
  {"status":"qr","qr":"<base64 png>","sessionId":"..."}
  {"status":"waiting"}
  {"status":"connected","cookie":"a=b; c=d","userAgent":"...","nickname":"..."}
  {"status":"expired"|"error","error":"<code>"}

The caller (Node service) spawns this per login attempt and kills it on finish.
Cookies never appear in argv, logs or error messages beyond this channel.
"""
import asyncio
import base64
import contextlib
import json
import os
import re
import sys

if __package__:
    from .douyin_browser_runtime import launch_browser, browser_error_code
else:
    from douyin_browser_runtime import launch_browser, browser_error_code

LOGIN_URL = 'https://www.douyin.com/user/self'
QR_TIMEOUT_SEC = float(os.environ.get('JUNSHI_DOUYIN_QR_TIMEOUT') or 60)
LOGIN_TIMEOUT_SEC = float(os.environ.get('JUNSHI_DOUYIN_LOGIN_TIMEOUT') or 240)
SESSION_COOKIES = ('sessionid', 'sessionid_ss', 'uid_tt')


# 必须在 redirect_stdout 之前抓住真实 stdout：Playwright/F2 的杂音会被重定向到 devnull，
# 但结果行必须写到原来的管道，否则调用方永远读不到 QR 帧（2026-10-25 实测踩到）。
REAL_STDOUT = sys.stdout.buffer


def emit(value):
    REAL_STDOUT.write((json.dumps(value, ensure_ascii=False) + '\n').encode('utf-8'))
    REAL_STDOUT.flush()


def cookie_header(cookies):
    return '; '.join(f'{item["name"]}={item["value"]}' for item in cookies
                     if item.get('name') and item.get('value') is not None)


def is_logged_in(cookies):
    names = {item.get('name') for item in cookies}
    return any(name in names for name in SESSION_COOKIES)


def qr_box(info):
    """The login QR is the square 140–280px image in the dialog."""
    for item in info:
        width, height = item.get('w') or 0, item.get('h') or 0
        if 140 <= width <= 280 and abs(width - height) <= 10:
            return item
    return None


async def nudge_login(page):
    """有些会话打开 /user/self 不会自动弹登录框 —— 主动点一次「登录」。"""
    for selector in ('button:has-text("登录")', '[data-e2e="login-button"]', 'span:has-text("登录")'):
        try:
            target = page.locator(selector).first
            if await target.count() and await target.is_visible():
                await target.click(timeout=3000)
                return True
        except Exception:
            continue
    return False


async def read_identity(page):
    """Best-effort nickname/avatar label from the logged-in header."""
    try:
        text = await page.evaluate("""() => {
            const el = document.querySelector('[data-e2e="user-info"] b, [data-e2e="user-avatar"] img[alt], header img[alt]');
            if (el) return (el.getAttribute('alt') || el.textContent || '').trim();
            const link = document.querySelector('a[href^="/user/"]');
            return link ? (link.textContent || '').trim() : '';
        }""")
        return re.sub(r'\s+', ' ', str(text or ''))[:80]
    except Exception:
        return ''


async def run():
    from playwright.async_api import async_playwright
    async with async_playwright() as playwright:
        browser = None
        try:
            browser = await launch_browser(playwright.chromium, headless=False)
            context = await browser.new_context(viewport={'width': 1100, 'height': 800}, accept_downloads=False)
            page = await context.new_page()
            await page.goto(LOGIN_URL, wait_until='domcontentloaded', timeout=40000)
            # The login dialog usually opens by itself on /user/self; some sessions need a click.
            nudged = False
            for attempt in range(12):
                await page.wait_for_timeout(1200)
                if not nudged and attempt >= 2:
                    nudged = True
                    await nudge_login(page)
                    await page.wait_for_timeout(1500)
                info = await page.evaluate("""() => {
                    const out = [];
                    document.querySelectorAll('img, canvas').forEach(el => {
                        const r = el.getBoundingClientRect();
                        if (r.width >= 60 && r.height >= 60)
                            out.push({x: r.x, y: r.y, w: Math.round(r.width), h: Math.round(r.height)});
                    });
                    return out;
                }""")
                box = qr_box(info)
                if box:
                    png = await page.screenshot(clip={'x': box['x'], 'y': box['y'],
                                                      'width': box['w'], 'height': box['h']})
                    emit({'status': 'qr', 'qr': base64.b64encode(png).decode('ascii')})
                    break
            else:
                emit({'status': 'error', 'error': 'qr_not_found'})
                return

            deadline = asyncio.get_event_loop().time() + LOGIN_TIMEOUT_SEC
            while asyncio.get_event_loop().time() < deadline:
                cookies = await context.cookies('https://www.douyin.com/')
                if is_logged_in(cookies):
                    # 扫码成功后抖音有时要等页面刷新才把 sessionid 补齐/刷新有效期。
                    with contextlib.suppress(Exception):
                        await page.reload(wait_until='domcontentloaded', timeout=20000)
                        await page.wait_for_timeout(1500)
                        cookies = await context.cookies('https://www.douyin.com/')
                    nickname = await read_identity(page)
                    emit({'status': 'connected', 'cookie': cookie_header(cookies),
                          'userAgent': await page.evaluate('navigator.userAgent'),
                          'nickname': nickname})
                    return
                emit({'status': 'waiting'})
                await page.wait_for_timeout(2000)
            emit({'status': 'expired', 'error': 'login_timeout'})
        except Exception as exc:  # noqa: BLE001 — coarsen to a stable code
            emit({'status': 'error', 'error': browser_error_code(exc)})
        finally:
            if browser:
                await browser.close()


if __name__ == '__main__':
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            asyncio.run(run())
        except Exception as exc:  # noqa: BLE001
            emit({'status': 'error', 'error': browser_error_code(exc)})
