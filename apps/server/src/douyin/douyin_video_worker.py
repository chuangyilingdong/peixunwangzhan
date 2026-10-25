"""Read one Douyin work (video/note) from its rendered page, without the signed API.

Mirror of douyin_browser_worker's approach: load the work page in a real browser and
collect the `/aweme/v1/web/aweme/detail` response the page itself requests. This works
for guests — the signed API returns 403 for our egress (see 交接文档「上游故障」).

stdout: DYRESULT:{...}
  {"status":"read","aweme":{...},"playUrl":"...","stats":{...}}
  {"status":"unavailable","error":"..."}
"""
import asyncio
import contextlib
import json
import os
import re
import sys

if __package__:
    from .douyin_browser_runtime import launch_browser, browser_error_code
else:
    from douyin_browser_runtime import launch_browser, browser_error_code

REAL_STDOUT = sys.stdout.buffer


def emit(value):
    REAL_STDOUT.write(('DYRESULT:' + json.dumps(value, ensure_ascii=False) + '\n').encode('utf-8'))
    REAL_STDOUT.flush()


def cookies(raw):
    result = []
    for part in str(raw or '').split(';'):
        name, sep, value = part.strip().partition('=')
        if sep and name and value and not any(c in name + value for c in '\r\n\x00'):
            result.append({'name': name, 'value': value, 'domain': '.douyin.com', 'path': '/'})
    return result


async def run(payload):
    from playwright.async_api import async_playwright
    target = payload['target']
    aweme_id = str(target['id'])
    captured = {}
    async with async_playwright() as playwright:
        browser = None
        try:
            browser = await launch_browser(playwright.chromium, headless=True)
            options = {'accept_downloads': False}
            if payload.get('user_agent'):
                options['user_agent'] = payload['user_agent']
            context = await browser.new_context(**options)
            saved = cookies(payload.get('cookie'))
            if saved:
                await context.add_cookies(saved)
            page = await context.new_page()

            async def capture(response):
                if '/aweme/v1/web/aweme/detail' not in response.url:
                    return
                if getattr(response, 'status', 200) != 200:
                    return
                try:
                    data = await response.json()
                except Exception:
                    return
                detail = data.get('aweme_detail') or {}
                if str(detail.get('aweme_id') or '') == aweme_id and not captured:
                    captured.update(detail)

            page.on('response', lambda response: asyncio.create_task(capture(response)))
            await page.goto(f'https://www.douyin.com/video/{aweme_id}', wait_until='domcontentloaded', timeout=45000)
            for _ in range(12):
                if captured:
                    break
                await page.wait_for_timeout(1200)
            if not captured:
                text = ''
                with contextlib.suppress(Exception):
                    text = await page.evaluate('() => (document.body?.innerText || "").slice(0, 500)')
                if re.search(r'请完成下方验证|拖动滑块|安全验证|验证后继续访问', text or ''):
                    return {'status': 'unavailable', 'error': 'verification_required'}
                if re.search(r'登录后(?:查看|观看)|请登录后', text or ''):
                    return {'status': 'unavailable', 'error': 'login_required'}
                return {'status': 'unavailable', 'error': 'no_detail'}
            video = captured.get('video') or {}
            play = video.get('play_addr') or video.get('playAddr') or {}
            stats = captured.get('statistics') or {}
            return {
                'status': 'read',
                'playUrl': (play.get('url_list') or [''])[0],
                'desc': str(captured.get('desc') or '')[:300],
                'durationMs': int(video.get('duration') or 0) or None,
                'stats': {
                    'digg': int(stats.get('digg_count') or 0),
                    'comment': int(stats.get('comment_count') or 0),
                    'share': int(stats.get('share_count') or 0),
                    'collect': int(stats.get('collect_count') or 0),
                },
            }
        except Exception as exc:
            return {'status': 'unavailable', 'error': browser_error_code(exc)}
        finally:
            if browser:
                await browser.close()


if __name__ == '__main__':
    payload = json.loads(sys.stdin.buffer.read())
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            result = asyncio.run(run(payload))
        except Exception as exc:  # noqa: BLE001
            result = {'status': 'unavailable', 'error': browser_error_code(exc)}
    emit(result)
