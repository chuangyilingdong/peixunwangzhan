"""Read publicly rendered work links from a user-controlled Douyin session.

This is a fallback for the official list API.  It neither bypasses a challenge
nor reads an existing browser profile; only the encrypted session explicitly
saved in this product is supplied through stdin.
"""
import asyncio
import contextlib
import json
import os
import re
import sys
from urllib.parse import parse_qs, urlsplit

if __package__:
    from .douyin_browser_runtime import launch_browser, browser_error_code
else:
    from douyin_browser_runtime import launch_browser, browser_error_code


def cookies(raw):
    result = []
    for part in str(raw or '').split(';'):
        name, sep, value = part.strip().partition('=')
        if sep and name and value and not any(c in name + value for c in '\r\n\x00'):
            result.append({'name': name, 'value': value, 'domain': '.douyin.com', 'path': '/'})
    return result


def video_id(url):
    parsed = urlsplit(url)
    modal = parse_qs(parsed.query).get('modal_id', [''])[0]
    if modal.isdigit():
        return modal
    match = re.search(r'/(?:share/)?(?:video|note)/(\d+)', parsed.path)
    return match.group(1) if match else ''


def is_profile_response(url, account_id):
    parsed = urlsplit(url)
    return (parsed.hostname == 'www.douyin.com'
            and parsed.path.rstrip('/') == '/aweme/v1/web/aweme/post'
            and parse_qs(parsed.query).get('sec_user_id', [''])[0] == account_id)


def profile_posts(url, data, account_id):
    """Accept only the requested profile's published-post response."""
    if not is_profile_response(url, account_id):
        return []
    return [item for item in data.get('aweme_list') or []
            if isinstance(item, dict) and (item.get('author') or {}).get('sec_uid') == account_id]


async def run(payload):
    from playwright.async_api import async_playwright
    target = payload['target']
    browser = None
    async with async_playwright() as playwright:
        try:
            browser = await launch_browser(playwright.chromium, headless=True)
            context_options = {'accept_downloads': False}
            if payload.get('user_agent'):
                context_options['user_agent'] = payload['user_agent']
            context = await browser.new_context(**context_options)
            saved = cookies(payload.get('cookie'))
            if saved:
                await context.add_cookies(saved)
            page = await context.new_page()
            published = {}
            pending = set()
            page_has_more = None
            next_cursor = None
            response_count, response_status, response_error = 0, None, ''
            stop_reason = 'scroll_limit'
            scroll_count = 0

            async def capture(response):
                nonlocal page_has_more, next_cursor, response_count, response_status, response_error
                account_id = resolved_account_id or target['id']
                if not is_profile_response(response.url, account_id):
                    return
                response_count += 1
                response_status = getattr(response, 'status', 200)
                if response_status != 200:
                    response_error = 'http_error'
                    return
                try:
                    data = await response.json()
                    for item in profile_posts(response.url, data, account_id):
                        published[str(item['aweme_id'])] = item
                    if data.get('has_more') in (True, False, 0, 1) and 'has_more' in data:
                        page_has_more = bool(data['has_more'])
                    next_cursor = data.get('max_cursor')
                except Exception:
                    response_error = 'invalid_response'

            def on_response(response):
                task = asyncio.create_task(capture(response))
                pending.add(task)
                task.add_done_callback(pending.discard)

            resolved_account_id = ''
            page.on('response', on_response)
            await page.goto('https://www.douyin.com/user/' + target['id'], wait_until='domcontentloaded', timeout=30000)
            await page.wait_for_timeout(1200)
            if target.get('kind') == 'self':
                match = re.search(r'/user/([A-Za-z0-9_-]+)', page.url)
                if match and match.group(1) != 'self':
                    resolved_account_id = match.group(1)
                if not resolved_account_id:
                    urls = await page.evaluate("""() => [
                        document.querySelector('link[rel="canonical"]')?.href || '',
                        document.querySelector('meta[property="og:url"]')?.content || ''
                    ]""")
                    for candidate in urls:
                        match = re.search(r'/user/([A-Za-z0-9_-]+)', candidate)
                        if match and match.group(1) != 'self':
                            resolved_account_id = match.group(1)
                            break
                if not resolved_account_id:
                    return {'works_status': 'unavailable', 'self_resolution': 'not_found'}
            known = {str(value) for value in payload.get('known_ids', []) if str(value).isdigit()}
            found, unchanged = [], 0
            error = ''
            for _ in range(60):
                if pending:
                    await asyncio.gather(*list(pending), return_exceptions=True)
                before = len(found)
                for ident in published:
                    if ident and ident not in found:
                        found.append(ident)
                if page_has_more is False or sum(ident not in known for ident in found) >= 100:
                    stop_reason = 'end_of_account' if page_has_more is False else 'batch_limit'
                    break
                await page.evaluate("""() => {
                    const links = document.querySelectorAll('a[href*="/video/"], a[href*="/note/"], a[href*="modal_id="]');
                    let scroller = null;
                    for (const link of links) {
                        for (let parent = link.parentElement; parent; parent = parent.parentElement) {
                            if (parent.scrollHeight > parent.clientHeight + 1
                                && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
                                scroller = parent;
                                break;
                            }
                        }
                        if (scroller) break;
                    }
                    if (!scroller) scroller = document.scrollingElement;
                    scroller?.scrollBy(0, Math.max(scroller.clientHeight * 1.8, 900));
                }""")
                scroll_count += 1
                await page.wait_for_timeout(900)
                unchanged = unchanged + 1 if len(found) == before else 0
                if unchanged >= 6:
                    text = await page.evaluate('() => document.body?.innerText || ""') or ''
                    error = ('verification_required' if re.search(r'请完成下方验证|拖动滑块|安全验证|验证后继续访问', text)
                             else 'login_required' if re.search(r'登录后(?:查看|观看)|请登录后', text) else '')
                    if error:
                        stop_reason = error
                        break
                if published and unchanged >= 20:
                    stop_reason = 'no_progress'
                    break
            if pending:
                await asyncio.gather(*list(pending), return_exceptions=True)
            fresh = [ident for ident in published if ident not in known]
            diagnostics = {'stop_reason': stop_reason, 'response_count': response_count,
                           'http_status': response_status, 'response_error': response_error,
                           'scroll_count': scroll_count, 'observed_count': len(published),
                           'fresh_count': len(fresh), 'known_count': len(known), 'has_more': page_has_more}
            if not published:
                text = await page.evaluate('() => document.body?.innerText || ""') or ''
                error = ('verification_required' if re.search(r'请完成下方验证|拖动滑块|安全验证|验证后继续访问', text)
                         else 'login_required' if re.search(r'登录后(?:查看|观看)|请登录后', text)
                         else 'no_profile_posts')
                return {'works_status': 'unavailable', 'error': error,
                        'diagnostics': diagnostics,
                        'resolved_account_id': resolved_account_id}
            complete = not error and page_has_more is False and len(fresh) <= 100
            return {'works_status': 'read', 'works_source': 'browser_render',
                    'aweme_list': [published[ident] for ident in fresh[:100]],
                    'next_cursor': next_cursor, 'has_more': not complete,
                    'browser_complete': complete, 'browser_limit': 100,
                    'error': error, 'diagnostics': diagnostics,
                    'resolved_account_id': resolved_account_id}
        finally:
            if browser:
                await browser.close()


if __name__ == '__main__':
    payload = json.loads(sys.stdin.buffer.read())
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            result = asyncio.run(run(payload)) or {}
        except Exception as exc:
            result = {'works_status': 'unavailable', 'error': browser_error_code(exc)}
    sys.stdout.buffer.write(('DYRESULT:' + json.dumps(result, ensure_ascii=False) + '\n').encode('utf-8'))
