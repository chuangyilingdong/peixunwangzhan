"""Isolated F2 adapter. Input via stdin; cookies never enter logs or CLI args."""
import asyncio
import contextlib
import json
import logging
import os
import sys

import httpx


async def primary_cookie(cookie, user_agent):
    """Initialize the platform's visitor identifier, without saving a login."""
    if any(part.strip().startswith('ttwid=') and part.strip()[6:]
           for part in cookie.split(';')):
        return cookie
    try:
        async with httpx.AsyncClient(timeout=12, trust_env=False) as client:
            response = await client.post('https://ttwid.bytedance.com/ttwid/union/register/',
                json={'region': 'cn', 'aid': 1768, 'needFid': False, 'service': 'www.ixigua.com',
                      'migrate_info': {'ticket': '', 'source': 'node'}, 'cbUrlProtocol': 'https', 'union': True},
                headers={'User-Agent': user_agent})
            response.raise_for_status()
            visitor = response.cookies.get('ttwid')
            if visitor:
                return '; '.join(value for value in (cookie, 'ttwid=' + visitor) if value)
    except httpx.HTTPError:
        pass
    return cookie


async def run(payload):
    # Prevent F2's default file logger from recording request URLs or session data.
    logger = logging.getLogger('f2')
    logger.addHandler(logging.NullHandler())
    logger.disabled = True
    logger.propagate = False
    from f2.apps.douyin.crawler import DouyinCrawler
    from f2.apps.douyin.handler import DouyinHandler
    from f2.apps.douyin.model import UserProfile, UserPost, PostDetail
    from f2.apps.douyin.utils import ClientConfManager
    target = payload['target']
    headers = ClientConfManager.headers().copy()
    if payload.get('user_agent'):
        headers['User-Agent'] = payload['user_agent']
    cookie = await primary_cookie(payload.get('cookie', ''), headers.get('User-Agent', 'Mozilla/5.0'))
    options = {'cookie': cookie, 'headers': headers,
               'timeout': 12, 'max_retries': 1}
    if target['kind'] == 'video':
        async with DouyinCrawler(options) as crawler:
            return await crawler.fetch_post_detail(PostDetail(aweme_id=target['id']))
    if 'cursor' in target:
        profile = {}
    else:
        # The profile and works endpoints must use separate F2 clients.  In
        # practice the post endpoint can reject a reused client even though
        # the preceding profile request succeeded.
        async with DouyinCrawler(options) as crawler:
            profile = await crawler.fetch_user_profile(UserProfile(sec_user_id=target['id']))
    if not isinstance(profile, dict):
        return {}
    try:
        # F2's public API handles the per-page cursor and its anti-bot request
        # parameters together.  It opens a fresh crawler for the works page.
        posts = None
        handler = DouyinHandler(options)
        async for page in handler.fetch_user_post_videos(
            target['id'], max_cursor=target.get('cursor', 0), page_counts=20, max_counts=20
        ):
            posts = page._to_raw()
            break
        if not isinstance(posts, dict) or 'aweme_list' not in posts:
            # Keep a fresh direct one-page request as a compatibility fallback
            # for F2 versions whose handler cannot yield a page.
            async with DouyinCrawler(options) as crawler:
                posts = await crawler.fetch_user_post(UserPost(
                    sec_user_id=target['id'], max_cursor=target.get('cursor', 0), count=20
                ))
        profile['aweme_list'] = (posts or {}).get('aweme_list', [])[:20]
        profile['works_status'] = 'read' if isinstance(posts, dict) and 'aweme_list' in posts else 'unavailable'
        profile['next_cursor'] = posts.get('max_cursor') if isinstance(posts, dict) else None
        profile['has_more'] = bool(posts.get('has_more')) if isinstance(posts, dict) and 'has_more' in posts else None
    except Exception as exc:
        profile['works_status'] = 'unavailable'
        # Only retain a coarse category.  Request URLs, cookies, and upstream
        # details must never enter the local chat records.
        profile['works_error'] = type(exc).__name__[:80]
    return profile


if __name__ == '__main__':
    payload = json.loads(sys.stdin.buffer.read())
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            result = asyncio.run(run(payload)) or {}
        except Exception as exc:
            status = getattr(exc, 'status_code', None)
            result = {'error': 'access_denied' if status in {401, 403} else 'rate_limited' if status == 429 else 'unavailable'}
    sys.stdout.buffer.write(('DYRESULT:' + json.dumps(result, ensure_ascii=False) + '\n').encode('utf-8'))
