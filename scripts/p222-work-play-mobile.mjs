// P222 作品分享手机体验守卫（2026-11-13）。
//
// 钉住：
//   ① 手机/触屏打开 /s/<code>：网页作品不再内嵌运行，出现“海报卡 + 开始体验”；
//   ② 点海报进入 /s/<code>/play?piece=… 独立全屏页，body 锁滚动、overscroll 关闭；
//   ③ 全屏页有顶部工具栏；默认不锁手势（可滚动），点“锁手势”才阻止页面滚动；
//   ④ 桌面仍保留内嵌可玩，并多一个“全屏体验”入口。
//
// 跑法：node scripts/p222-work-play-mobile.mjs（会先构建 apps/website）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(ROOT_DIR, 'apps/website/dist');
let PORT = 0;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

// 守卫必须跑当前源码：先构建一次 website（dist 是产物，不保证是最新的）。
const build = spawnSync(process.execPath, [
  path.join(ROOT_DIR, 'node_modules/vite/bin/vite.js'), 'build', 'apps/website', '--config', 'apps/website/vite.config.mjs',
], { cwd: ROOT_DIR, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('website 构建失败，p222 无法继续');
  process.exit(2);
}

const fixture = {
  code: 'test-code',
  source: 'VIBECODING',
  student: { name: '刘同学', avatarUrl: null, avatarKey: null },
  org: { name: '测试机构', phone: null, address: null },
  lessonTitle: '开发零花钱管家网页应用',
  work: { id: 'work_test', title: '开发零花钱管家网页应用', description: '' },
  allPieces: false,
  pieceCount: 1,
  pieces: [{
    key: 'artifact:index.html',
    render: 'HTML',
    name: 'index.html',
    caption: 'index.html',
    mediaUrl: null,
    coverUrl: null,
    openUrl: null,
    document: {
      files: {
        'index.html': '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#12121c;color:#fff;font-family:sans-serif}body{padding:24px}</style></head><body><h1>scroll test</h1><div style="height:1800px;background:linear-gradient(#3b1d5e,#123456)">tall content</div></body></html>',
      },
      entry: 'index.html',
      worksLlm: null,
    },
    missingAssets: [],
  }],
  document: null,
  missingAssets: [],
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html');
  response.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
PORT = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const mockApi = async (route) => {
  const url = route.request().url();
  const data = url.includes('/api/public/share-links/test-code') ? fixture : {};
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, ok: true, data }) });
};

// ── 手机：分享页海报卡 → 全屏页 ──
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
await mobile.route('**/api/**', mockApi);
// 模拟 iOS/微信：没有 screen.orientation.lock，网页无法自动横屏。
await mobile.addInitScript(() => {
  try { Object.defineProperty(screen, 'orientation', { configurable: true, get: () => ({ lock: undefined }) }); } catch { /* 已经是只读就不改 */ }
});
const page = await mobile.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(`http://127.0.0.1:${PORT}/s/test-code`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="share-playcard"]', { timeout: 10000 });
check('手机分享页出现海报卡', await page.locator('[data-testid="share-playcard"]').count() === 1);
check('手机分享页不再内嵌网页 iframe', await page.locator('.share-piece__stage iframe').count() === 0);
check('海报卡文案', (await page.locator('[data-testid="share-playcard"]').innerText()).includes('开始体验'));
await page.screenshot({ path: path.join('C:/Users/Administrator/AppData/Local/Temp', 'share-mobile-poster.png'), fullPage: true });

await page.locator('[data-testid="share-playcard"]').click();
await page.waitForURL(/\/s\/test-code\/play\?piece=artifact%3Aindex\.html/, { timeout: 10000 });
await page.waitForSelector('.share-play__bar', { timeout: 10000 });
check('进入独立全屏页', page.url().includes('/s/test-code/play'));
check('全屏页有顶部工具栏', await page.locator('.share-play__bar').count() === 1);
check('全屏页加载作品 iframe', await page.locator('.share-play iframe').count() >= 1);
const bodyStyle = await page.evaluate(() => ({
  overflow: getComputedStyle(document.body).overflow,
  overscroll: getComputedStyle(document.body).overscrollBehavior,
}));
check('全屏页锁住 body 滚动', bodyStyle.overflow === 'hidden', JSON.stringify(bodyStyle));
check('全屏页禁止 overscroll', bodyStyle.overscroll === 'none', bodyStyle.overscroll);
const innerFrame = () => page.frames().find((frame) => frame.url() === 'about:srcdoc');
const scrollState = async () => {
  const frame = innerFrame();
  return frame ? frame.evaluate(() => ({
    touchAction: getComputedStyle(document.body).touchAction,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    scrollY: window.scrollY,
  })) : null;
};
await page.waitForTimeout(1000);
const initial = await scrollState();
check('默认不锁手势（作品可滚动）', Boolean(initial) && initial.touchAction !== 'none', JSON.stringify(initial));
check('作品内容超过视口', Boolean(initial) && initial.scrollHeight > initial.innerHeight, JSON.stringify(initial));
await innerFrame()?.evaluate(() => window.scrollTo(0, 400));
check('作品可向下滚动', ((await scrollState())?.scrollY || 0) > 0);
check('默认按钮为“锁手势”', (await page.locator('.share-play__bar').innerText()).includes('锁手势'));
await page.locator('.share-play__btn', { hasText: '锁手势' }).click();
await page.waitForTimeout(1000);
const locked = await scrollState();
check('点“锁手势”后 touch-action:none', locked?.touchAction === 'none', JSON.stringify(locked));
check('按钮变为“已锁定”', (await page.locator('.share-play__bar').innerText()).includes('已锁定'));
await page.locator('.share-play__btn', { hasText: '已锁定' }).click();
await page.waitForTimeout(1000);
const unlocked = await scrollState();
check('再点恢复页面滚动', Boolean(unlocked) && unlocked.touchAction !== 'none', JSON.stringify(unlocked));
if (await page.locator('.share-play__handle').count()) await page.locator('.share-play__handle').click();
await page.locator('.share-play__bar .share-play__btn', { hasText: '横屏说明' }).click();
await page.waitForSelector('.share-play__rotate', { timeout: 5000 });
check('iOS/微信提示无法自动横屏', (await page.locator('.share-play__rotate').innerText()).includes('不支持网页自动横屏'));
await page.locator('.share-play__rotate .share-play__btn', { hasText: '我已横过来' }).click();
check('竖屏点“我已横过来”提示竖屏锁定', (await page.locator('.share-play__rotate').innerText()).includes('还没检测到横屏'));
await page.locator('.share-play__rotate .share-play__btn', { hasText: '继续竖屏' }).click();
check('横屏提示可关闭', await page.locator('.share-play__rotate').count() === 0);
await page.screenshot({ path: path.join('C:/Users/Administrator/AppData/Local/Temp', 'share-mobile-play.png') });
check('手机端无 pageerror', errors.length === 0, errors.join(' | ').slice(0, 200));
await mobile.close();

// ── 桌面：保留内嵌可玩 + 全屏入口 ──
const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await desktop.route('**/api/**', mockApi);
const deskPage = await desktop.newPage();
await deskPage.goto(`http://127.0.0.1:${PORT}/s/test-code`, { waitUntil: 'networkidle' });
await deskPage.waitForSelector('.share-piece__stage iframe', { timeout: 10000 });
await deskPage.waitForTimeout(1500);
check('桌面分享页保留内嵌 iframe', await deskPage.locator('.share-piece__stage iframe').count() >= 1);
check('桌面没有海报卡', await deskPage.locator('[data-testid="share-playcard"]').count() === 0);
check('桌面有全屏体验入口', await deskPage.locator('[data-testid="share-fullscreen-play"]').count() === 1);
await deskPage.screenshot({ path: path.join('C:/Users/Administrator/AppData/Local/Temp', 'share-desktop.png'), fullPage: true });
await desktop.close();

await browser.close();
await new Promise((resolve) => server.close(resolve));
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
