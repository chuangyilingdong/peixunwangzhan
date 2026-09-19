#!/usr/bin/env node
/**
 * P120 作品广场「网页作品」守卫（2026-09-19）
 *
 * 为什么需要它：这一轮从 aimagc.cn 抓了 9 件**静态网页作品**（点泡泡 / 贪吃蛇 / 旋转地球 …），
 * 它们是托管在**我们自己** `/media/web-works/` 下、被沙箱 iframe 跑起来的学生 HTML。
 * 这类作品有两个「**读代码看不出来、一上生产就是白屏**」的坑，都是真浏览器跑一遍才暴露的：
 *
 *   ① **`/media/` 少了 CORS 头 → 4 件 three.js 作品整片白屏**。
 *      沙箱 iframe 的文档 origin 是 opaque（`null`），里面 `import` 的 ES module 一律按
 *      **CORS 模式**取；nginx 的 /media/ 不带头就被浏览器直接挡掉
 *      （`Access to script … from origin 'null' has been blocked by CORS policy`）。
 *      ⚠️ 这一条**不是**"能不能下载到文件"的问题 —— 文件明明 200 拿得到，是浏览器拒收。
 *   ② **看图层 iframe 的 sandbox 一旦带上 `allow-same-origin` → 学生的 HTML 就能读我们的
 *      cookie / localStorage**（作品与主站**同源**，这和上一轮那些"外链件"不一样）。
 *
 * 所以这道守卫钉四件事（任一不成立就 exit 1）：
 *   ① 源码口径：`main.jsx` 里 webwork 分支的 sandbox **不许**含 `allow-same-origin`，
 *      而且必须真的用 `entryUrl` 当 src（口径见 docs/operations/新对话交接-第二十轮-*.md §五.A.1）；
 *   ② 接口口径：公开接口里带 `entryUrl` 的作品，地址必须是**本站同源**且落在 `/media/` 下
 *      （外域地址等于把"能在我们站打开"这条口径破了）；
 *   ③ 托管口径：每件 entryUrl 取回来必须是 200 + `text/html` + **带 CORS 头**（坑①）；
 *   ④ 真浏览器：把每件放进**不带 allow-same-origin 的沙箱 iframe** 里跑，断言不白屏、无报错；
 *      并用一个**本地金丝雀页面**验证这套 sandbox 参数确实隔离了同源（cookie / localStorage /
 *      父窗口文档三项都必须是 SecurityError）—— 防止"参数写对了但浏览器行为变了"。
 *
 * 跑法（需要 node ≥ 20 与 Chrome/Chromium；本机 node 16 跑不了，服务器上跑）：
 *   node scripts/p120-webworks-sandbox-check.mjs [--site https://iicili.cyou]
 *   环境变量：CHROME_PATH 覆盖浏览器路径（与 p115 同一套约定）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const SITE = (arg('--site', process.env.P120_SITE || 'https://iicili.cyou')).replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.P120_PORT || 8794);
/** 与 nginx `location /` 那条一致（见 /etc/nginx/sites-enabled/iicili.cyou）。 */
const PLAZA_CSP = "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; " +
  "img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'";
/** 看图层 webwork 分支的 sandbox（**不许**出现 allow-same-origin）。 */
const SANDBOX = 'allow-scripts allow-modals allow-forms allow-popups';
/** 取不到的外域（作品里留的运行时接口 / 没镜像的素材）—— 允许失败，不算作品的问题。 */
const ALLOW_FAIL = /upload\.wikimedia\.org|fonts\.googleapis\.com|fonts\.gstatic\.com|time\.akamai\.com/;

const problems = [];
const fail = (message) => problems.push(message);
const log = (...rest) => console.log(...rest);

/** ① 源码口径 */
function checkSource() {
  const file = 'apps/website/src/main.jsx';
  const source = fs.readFileSync(file, 'utf8');
  if (!/isWebWork/.test(source)) { fail(`${file}：找不到 webwork 那条看图层分支 —— 是不是被删/改名了`); return; }
  // ⚠️ 不要在整文件里搜 `sandbox="…"`：外链那条 embed 分支也有 sandbox（而且**带**
  //    allow-same-origin，那对跨域是对的）。只认**承载 entryUrl 那个 iframe 元素**上的属性，
  //    所以以 `src={work.entryUrl}` 为锚点左右取一小段 —— 别用固定长度的窗口去切分支，
  //    那段注释一长窗口就够不到了（第一版就是这么误报的）。
  const anchor = source.indexOf('src={work.entryUrl}');
  if (anchor < 0) { fail(`${file}：webwork 分支没有用 entryUrl 当 iframe 的 src`); return; }
  const element = source.slice(Math.max(0, anchor - 400), anchor + 400);
  const sandbox = /sandbox="([^"]*)"/.exec(element);
  if (!sandbox) { fail(`${file}：跑 entryUrl 的 iframe 上没有 sandbox 属性 —— 学生 HTML 会**以我们源的权限**跑`); return; }
  if (/allow-same-origin/.test(sandbox[1])) {
    fail(`${file}：webwork 的 sandbox 里出现了 allow-same-origin —— 学生 HTML 与主站同源，能读 cookie/localStorage`);
  }
  // 「在新窗口打开」只许给外链作品：同源入口页开到新窗口 = 拿我们的源跑学生代码
  if (/entryUrl[^}]*target="_blank"/.test(source)) fail(`${file}：entryUrl 被放进了新窗口链接 —— 那等于绕开沙箱`);
  log(`① 源码口径：跑 entryUrl 的 iframe sandbox="${sandbox[1]}" ✅`);
}

const harness = (src) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>p120 harness</title>
<style>html,body{margin:0;background:#faf9ff}iframe{display:block;width:960px;height:600px;border:0;background:#fff}</style>
</head><body><iframe id="stage" sandbox="${SANDBOX}" src="${src}"></iframe></body></html>`;

/** 本地金丝雀：验证这套 sandbox 参数确实隔离了同源（架子与金丝雀在**同一源**下）。 */
const CANARY = `<script>
  var out = {};
  // ⚠️ 判据是「碰不到」而不是「location.origin 是不是 null」：Chrome 在 sandbox iframe 里
  //    照样把 location.origin 报成真实源，拿它当判据会误判成"隔离不成立"。
  try { out.cookie = document.cookie; } catch (e) { out.cookieErr = e.name; }
  try { localStorage.getItem('x'); out.storage = 'readable'; } catch (e) { out.storageErr = e.name; }
  try { out.parentDoc = !!window.parent.document; } catch (e) { out.parentDocErr = e.name; }
  parent.postMessage({ canary: out }, '*');
</script>`;

async function main() {
  checkSource();

  // ② 接口口径
  const response = await fetch(`${SITE}/api/public/works?limit=500`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`公开接口取失败：HTTP ${response.status}`);
  const payload = await response.json();
  const items = payload?.data?.items || payload?.items || [];
  const webWorks = items.filter((item) => item.entryUrl);
  log(`② 接口口径：广场 ${items.length} 件，其中带 entryUrl 的网页作品 ${webWorks.length} 件`);
  if (!webWorks.length) fail('公开接口里一件带 entryUrl 的作品都没有 —— 这批作品等于没上广场');
  for (const work of webWorks) {
    if (!String(work.entryUrl).startsWith(`${SITE}/media/`)) {
      fail(`作品「${work.title}」的 entryUrl 不是本站 /media/ 下的地址：${work.entryUrl}`);
    }
  }

  // ③ 托管口径：200 + text/html + CORS 头。CORS 用一件**真 module 资源**去验（那才是白屏的根因）。
  for (const work of webWorks.slice(0, 3)) {
    const head = await fetch(work.entryUrl, { method: 'HEAD' });
    const type = head.headers.get('content-type') || '';
    if (head.status !== 200 || !/text\/html/.test(type)) fail(`「${work.title}」入口页不是 200 text/html：${head.status} ${type}`);
    if (!head.headers.get('access-control-allow-origin')) {
      fail(`「${work.title}」入口页没有 CORS 头 —— 沙箱里 import 会失败（是不是 nginx /media/ 那条被改了？）`);
    }
  }
  const moduleProbe = `${SITE}/media/web-works/ff03446c-f53d-4b07-b39c-2107869379d1/vendor/three.module.js`;
  const probe = await fetch(moduleProbe, { method: 'HEAD' });
  if (probe.status !== 200) fail(`three.module.js 取不到（${probe.status}）—— 旋转地球这类作品会白屏`);
  else if (!probe.headers.get('access-control-allow-origin')) {
    fail('three.module.js 没有 CORS 头 —— 沙箱里 ES module 会被浏览器挡掉，4 件 three.js 作品白屏（本守卫要挡的就是这条）');
  }
  log('③ 托管口径：入口页 200 text/html；three.module.js 带 CORS 头 ✅');

  // ④ 真浏览器
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/canary.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(CANARY);
    }
    // 外壳自身用生产那套 CSP；frame-src 回落 default-src，所以显式把被测站放进来
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PLAZA_CSP.replace("default-src 'self';", `default-src 'self'; frame-src 'self' ${SITE};`),
    });
    res.end(harness(url.searchParams.get('src')));
  });
  await new Promise((resolve) => server.listen(PORT, resolve));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // 金丝雀：同一源下的页面，在**这套 sandbox** 里必须碰不到 cookie / localStorage / 父文档
  const canaryPage = await browser.newPage();
  await canaryPage.addInitScript(() => {
    window.__canary = null;
    window.addEventListener('message', (event) => { if (event.data && event.data.canary) window.__canary = event.data.canary; });
  });
  await canaryPage.goto(`http://localhost:${PORT}/?src=${encodeURIComponent(`http://localhost:${PORT}/canary.html`)}`);
  const canary = await canaryPage.evaluate(() => window.__canary);
  await canaryPage.close();
  const isolated = Boolean(canary) && canary.cookieErr === 'SecurityError' && canary.storageErr === 'SecurityError'
    && canary.parentDocErr === 'SecurityError' && canary.parentDoc !== true;
  if (!isolated) fail(`沙箱没有隔离同源：${JSON.stringify(canary)}`);
  else log('④ 金丝雀：cookie / localStorage / 父窗口文档在沙箱里全部 SecurityError ✅');

  let rendered = 0;
  for (const work of webWorks) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const where = message.location()?.url || '';
      if (ALLOW_FAIL.test(where) || ALLOW_FAIL.test(message.text())) return;
      if (/Permissions policy violation/.test(message.text())) return;   // p5 探测传感器，与作品无关
      if (/\/favicon\.ico$/.test(where)) return;                          // 外壳自己的 favicon
      errors.push(`console: ${message.text().slice(0, 140)}`);
    });
    let inkRatio = 0;
    try {
      // ⚠️ 用 domcontentloaded：作品里有取不到的外域资源，等 load 会卡到超时
      await page.goto(`http://localhost:${PORT}/?src=${encodeURIComponent(work.entryUrl)}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(4000);
      const shot = await page.screenshot({ clip: await page.locator('#stage').boundingBox() });
      inkRatio = await page.evaluate(async (b64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${b64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let i = 0; i < data.length; i += 4) if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 245) ink += 1;
        return ink / (data.length / 4);
      }, shot.toString('base64'));
    } catch (error) {
      errors.push(`跑不起来：${String(error.message).slice(0, 100)}`);
    }
    await page.close();
    const ok = inkRatio > 0.01 && !errors.length;
    if (ok) rendered += 1;
    else fail(`作品「${work.title}」在沙箱里没正常渲染（有墨比例 ${(inkRatio * 100).toFixed(1)}%）：${errors.slice(0, 3).join(' | ')}`);
    log(`   ${ok ? '✅' : '❌'} ${work.title}`);
  }
  await browser.close();
  server.close();
  log(`④ 真浏览器：${rendered}/${webWorks.length} 件在沙箱里正常渲染`);

  if (problems.length) {
    console.log(`\n❌ P120 不通过，共 ${problems.length} 个问题：`);
    for (const problem of problems) console.log(`   · ${problem}`);
    process.exit(1);
  }
  console.log('\nP120 PASSED：网页作品的沙箱、CORS、同源隔离与逐件渲染全部成立');
}

await main().catch((error) => { console.error('P120 运行失败：', error); process.exit(1); });
