/**
 * 构建期预渲染（2026-11-01，SEO 方案 B）。
 *
 * 为什么需要：官网是 Vite SPA —— 服务器返回的 HTML 只有 3060 字节，进去全是 JS，
 * 人眼能看到的文字只有「正在进入课堂」。百度不跑 JS 就什么内容都拿不到，
 * 于是 sitemap 里的 12 个页面**都能被发现、但没有任何可排名的正文**。
 * 实测（2026-11-01）：/、/handbook、/marketplace、/works 返回的是**同一份 3060 字节**。
 *
 * 这个脚本在 `vite build` 之后跑：把 dist 起一个本地静态服务（/api 反向代理到线上，
 * 这样 CMS 文案是真的），用 Chromium 逐个打开公开页，等网络空闲后把**渲染完的 DOM**
 * 存成 `dist/<路由>/index.html`。部署后 nginx 的 `try_files $uri $uri/ /index.html`
 * 会优先命中这些文件 —— **不需要改 nginx**。
 *
 * 三条刻意的取舍：
 *   ① **不改业务代码**：抓的就是真实渲染结果，前端的 title/description/canonical
 *      本来就由页面自己设置（见 main.jsx 的 SEO effect），所以每页天然不同。
 *   ② React 用的是 `createRoot().render()`（不是 hydrate），所以浏览器拿到预渲染 HTML 后
 *      会正常重新渲染 —— 不会出现 hydration mismatch，也不需要改挂载方式。
 *   ③ **内容会停留在构建那一刻**：CMS 改文案后，要等下次发布才反映到预渲染 HTML 里。
 *      对 SEO 无害（爬虫拿到的是上次发布快照），但要知道这个滞后。
 *
 * ⚠️ `/org` 不在列表里：那个路径被 nginx 301 到机构端应用（apps/org），官网这条路由根本不可达。
 *    之前 sitemap 里却列了它 —— 那份 sitemap 已同步删掉。
 *
 * 跑法（构建机，Node 22+）：
 *   node apps/website/scripts/prerender.mjs
 *   PRERENDER_API_BASE=http://127.0.0.1:8787 node apps/website/scripts/prerender.mjs   # 用本机后端
 *   PRERENDER_SKIP=1 ...   # 应急跳过（发布不会被它挡住）
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'apps/website/dist');
const PORT = Number(process.env.PRERENDER_PORT || 6187);
const API_BASE = String(process.env.PRERENDER_API_BASE || 'https://aicyld.com').replace(/\/+$/, '');
const CHROME = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/srv/ai-kids-platform/runtime/ms-playwright/chromium-1248/chrome-linux64/chrome');
const PAGE_TIMEOUT_MS = Number(process.env.PRERENDER_TIMEOUT_MS || 45000);

/**
 * 要预渲染的公开页 + 该页 title 必须包含的字样（用来判定"真的渲染出内容了"）。
 * ⚠️ 这份清单必须与 `apps/website/public/sitemap.xml` 一致 —— p199 守卫钉着这件事。
 */
export const PRERENDER_ROUTES = [
  { route: '/', expect: '灵动ai学院' },
  { route: '/marketplace', expect: '灵动课程' },
  { route: '/works', expect: '灵动作品' },
  { route: '/handbook', expect: '机构手册' },
  { route: '/faq', expect: '常见问题' },
  { route: '/download', expect: '创作客户端' },
  { route: '/compare', expect: '选型对比' },
  { route: '/demo', expect: '联系我们' },
  { route: '/terms', expect: '用户协议' },
  { route: '/privacy', expect: '隐私政策' },
  { route: '/minors', expect: '未成年人' },
];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (String(process.env.PRERENDER_SKIP || '') === '1') {
  console.log('[预渲染] PRERENDER_SKIP=1，跳过');
  process.exit(0);
}
if (!fs.existsSync(path.join(DIST, 'index.html'))) fail(`dist 不存在：${DIST}（先跑 vite build）`);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/** 静态服务 + /api 反代。反代是为了让 CMS 文案（首页/手册等）在预渲染时是真内容。 */
function startServer() {
  const isHttps = API_BASE.startsWith('https:');
  const agent = isHttps ? https : http;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      const target = new URL(`${url.pathname}${url.search}`, API_BASE);
      const headers = { ...req.headers, host: target.host };
      delete headers.connection;
      const proxyReq = agent.request(target, { method: req.method, headers }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (error) => {
        console.warn(`[预渲染] 反代失败 ${url.pathname}: ${String(error?.message || error).slice(0, 80)}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end();
      });
      req.pipe(proxyReq);
      return;
    }
    let filePath;
    try { filePath = path.join(DIST, decodeURIComponent(url.pathname)); } catch { res.writeHead(400).end(); return; }
    if (!filePath.startsWith(DIST)) { res.writeHead(403).end(); return; }
    if (url.pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');
    const send = () => {
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => { res.writeHead(404).end(); });
      stream.on('open', () => {
        res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        stream.pipe(res);
      });
    };
    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) { filePath = path.join(DIST, 'index.html'); } // SPA 兜底，与 nginx 的 try_files 同义
      send();
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/** 把渲染结果落盘。`/` 写回 dist/index.html（它就是入口文件），其余写 `dist/<路由>/index.html`。 */
function writeRoute(route, html) {
  if (route === '/') {
    fs.writeFileSync(path.join(DIST, 'index.html'), html);
    return path.join(DIST, 'index.html');
  }
  const dir = path.join(DIST, route.replace(/^\//, ''));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return file;
}

const shell = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
let server;

try {
  server = await startServer();
  const { chromium } = await import('playwright-core');
  if (!fs.existsSync(CHROME)) fail(`找不到 Chromium：${CHROME}（用 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定）`);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  console.log(`[预渲染] 目标 ${PRERENDER_ROUTES.length} 个页面 · API=${API_BASE} · 端口 ${PORT}`);

  let failed = 0;
  for (const { route, expect } of PRERENDER_ROUTES) {
    const startedAt = Date.now();
    try {
      await page.goto(`http://127.0.0.1:${PORT}${route}`, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS });
      // 留给页面的 SEO effect（title/description/canonical）落地
      await page.waitForTimeout(250);
      const html = await page.content();
      const title = await page.title();
      const textLength = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, '').length;
      if (!title.includes(expect)) throw new Error(`title="${title}" 不含「${expect}」`);
      if (textLength < 200) throw new Error(`正文只有 ${textLength} 字，像是没渲染出来`);
      const file = writeRoute(route, html);
      console.log(`  ✓ ${route.padEnd(14)} ${String(Math.round(html.length / 1024)).padStart(4)}KB · 正文 ${String(textLength).padStart(4)} 字 · ${title.slice(0, 40)} · ${Date.now() - startedAt}ms`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${route} —— ${String(error?.message || error).slice(0, 200)}`);
    }
  }
  await browser.close();

  if (failed) {
    // 首页失败时把入口文件还原成 SPA 空壳，别让整个站变成"只有一个坏页面"
    if (PRERENDER_ROUTES.some(({ route }) => route === '/' ) && !fs.existsSync(path.join(DIST, 'index.html'))) fs.writeFileSync(path.join(DIST, 'index.html'), shell);
    fail(`有 ${failed} 个页面预渲染失败`);
  }
  console.log('[预渲染] 全部完成');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
}
