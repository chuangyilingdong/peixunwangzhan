#!/usr/bin/env node
/**
 * P123 预览沙箱「存储可用性」守卫（2026-09-20）
 *
 * 为什么需要它：用户报「**图1 无法正常玩**」——学生那份打地鼠页面画得出来（标题、9 个洞、
 * 「开始游戏」按钮都在），但点按钮毫无反应。真因不在作品里，在我们的沙箱：
 *
 *   · 预览跑在 `sandbox="allow-scripts allow-modals allow-forms allow-popups"` 里
 *     —— **故意不带 `allow-same-origin`**（口径⑧：作品与主站同源，带了就读得到 cookie / localStorage）；
 *   · 于是学生文档的 origin 是 **opaque**，`localStorage` 一读就抛 SecurityError；
 *   · 而那份游戏的**第 165 行**正是 `let best = Number(localStorage.getItem('whack_best') || 0);`
 *     —— 顶层就抛，整个 `<script>` 当场结束，`addEventListener('click', …)` 永远没人挂上。
 *
 * 修法是 `buildPreviewDocument` 给学生文档预插一份**内存版** localStorage/sessionStorage/cookie
 * （不写盘、不跨作品共享，只是别让作品死在第一行）。这道守卫就是钉它 ——
 * **静态断言不够**：`localStorage` 在沙箱里到底抛不抛、替身有没有真的抢在前面，只有真浏览器知道。
 *
 * 钉三件事：
 *   ① 真浏览器里跑一份「顶层读 localStorage + 写回 + 读 document.cookie」的学生页面，
 *      必须收到它打完的 `SHIM_OK:…`（说明脚本活到了最后，且 getItem 拿回了 setItem 写的值）；
 *   ② 替身**没有放松隔离**：外层页面仍然读不到内层沙箱文档（`contentDocument === null`）；
 *   ③ 记忆化语义：`removeItem` / `clear` / `key` / `length` 在替身上可用（游戏会用）。
 *
 * 跑法（需要 node ≥ 20 与 Chrome/Chromium；本机 node 16 跑不了，服务器上跑）：
 *   CHROME_PATH=/usr/bin/chromium-browser node scripts/p123-preview-storage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

const root = process.cwd();
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.P123_PORT || 8796);

const { buildPreviewDocument } = await import('../packages/shared/src/vibecodingProject.js');

// ── 学生页面夹具：形状照抄那份打地鼠（顶层就读最高分） ──────────────────────
const STUDENT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>存储守卫</title></head><body>
<button id="go">开始游戏</button>
<script>
  var best = Number(localStorage.getItem('whack_best') || 0);
  localStorage.setItem('whack_best', String(best + 7));
  sessionStorage.setItem('s', 'ok');
  document.cookie = 'score=' + (best + 7);
  localStorage.setItem('temp', 'x');
  localStorage.removeItem('temp');
  localStorage.setItem('a', '1');
  localStorage.setItem('b', '2');
  var keys = [];
  for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  var survived = document.getElementById('go') ? 'go-btn' : 'no-btn';
  console.log('SHIM_OK:' + localStorage.getItem('whack_best')
    + ':cookie=' + (document.cookie.indexOf('score=') === 0 ? 'ok' : 'bad')
    + ':session=' + sessionStorage.getItem('s')
    + ':removed=' + (localStorage.getItem('temp') === null ? 'ok' : 'bad')
    + ':len=' + localStorage.length
    + ':keys=' + keys.sort().join(',')
    + ':' + survived);
</script>
</body></html>`;

// 预览文档：调用方（学生作品页 / 广场 / 机构端）就是这么拼的，还各自带一段收紧 CSP 的 meta
const previewDoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
  + 'script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src data: blob:; '
  + 'font-src data:; connect-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\'">'
  + buildPreviewDocument({ '打地鼠.html': STUDENT_HTML }, '打地鼠.html');

const shellPath = path.join(root, 'apps/website/public/vibe-preview.html');
if (!fs.existsSync(shellPath)) { console.error(`!! 找不到预览外壳：${shellPath}`); process.exit(1); }

const GUARD_HTML = `<!doctype html><html><body>
<script>
  window.__seen = [];
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source === 'vibecoding-console') { window.__seen.push(String(data.text || '')); }
  });
  window.addEventListener('DOMContentLoaded', function () {
    var frame = document.createElement('iframe');
    frame.id = 'shell';
    frame.style.width = '900px';
    frame.style.height = '600px';
    frame.src = '/vibe-preview.html';
    document.body.appendChild(frame);
  });
</script>
</body></html>`;

const server = http.createServer((request, response) => {
  if (request.url === '/vibe-preview.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fs.readFileSync(shellPath));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(GUARD_HTML);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error.message || error)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#shell');
  // 等外壳把 ready 发出来（它自己在 load 时发），再从外壳的父页面把预览文档投进去
  await page.waitForFunction(() => document.getElementById('shell')?.contentWindow !== undefined, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate((doc) => {
    document.getElementById('shell').contentWindow.postMessage({ source: 'vibecoding-preview', html: doc }, '*');
  }, previewDoc);

  // 等学生脚本把结果打回来（经外壳 → console 桥 → 本页）
  let seen = [];
  for (let i = 0; i < 40; i += 1) {
    seen = await page.evaluate(() => window.__seen || []);
    if (seen.some((line) => line.includes('SHIM_OK'))) break;
    await page.waitForTimeout(250);
  }
  const shimLine = seen.find((line) => line.includes('SHIM_OK')) || '';
  console.log(`  · 沙箱里回传：${shimLine || `（没收到，收到的是 ${JSON.stringify(seen).slice(0, 160)}）`}`);

  check('学生脚本活到了最后（顶层读 localStorage 没把它打断）', Boolean(shimLine), JSON.stringify(seen).slice(0, 200));
  check('setItem 写的值 getItem 读得回来（内存实现语义正确）', shimLine.includes('SHIM_OK:7'), shimLine);
  check('document.cookie 的替身可用（opaque origin 下读 cookie 本来会抛）', shimLine.includes('cookie=ok'), shimLine);
  check('sessionStorage 可用', shimLine.includes('session=ok'), shimLine);
  check('removeItem 生效', shimLine.includes('removed=ok'), shimLine);
  check('length / key() 可用', shimLine.includes('len=3') && shimLine.includes('keys=a,b,whack_best'), shimLine);
  check('脚本写在 body 末尾也能拿到 DOM（说明整段都在）', shimLine.includes('go-btn'), shimLine);
  check('沙箱里没有未捕获的页面错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200));

  // ② 隔离性没被这次改动放松：外层读不到内层沙箱文档
  const isolation = await page.evaluate(() => {
    const shell = document.getElementById('shell');
    const stage = shell?.contentDocument?.getElementById('stage');
    if (!stage) return 'stage-missing';
    return stage.contentDocument === null ? 'null' : 'readable';
  });
  check('沙箱仍然隔离同源（内层文档读不到 → contentDocument 为 null）', isolation === 'null', `实际 ${isolation}`);

  console.log(JSON.stringify({ name: 'preview-storage', pass: failures === 0, failures, shimLine }, null, 2));
} finally {
  await browser.close();
  server.close();
}
process.exit(failures ? 1 : 0);
