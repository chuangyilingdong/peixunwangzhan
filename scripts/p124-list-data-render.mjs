/**
 * P124 列表页「有数据」分支渲染守卫（2026-09-20）
 *
 * 为什么需要它：2026-09-20 新落的页面自查脚手架（`scripts/page-shot.mjs`）第一次带着数据截图就抓到
 * —— 平台端「素材与宣传物料」在**列表里有物料**时渲染期抛 `ListResultSummary is not defined`
 * （重做那一页时少写了一个 import），React 没有错误边界 → **整个 App 子树卸载 = 纯白页**；
 * 而且从此再也进不去（列表只要非空就崩，运营连"删掉那条修回来"都做不到）。
 * 生产库里 `promo_materials` 一条都没有，所以这一页一直走空状态分支，谁都没见过它有数据的样子。
 *
 * 既有守卫为什么拦不住：
 *   · `vite build` 不报这个错 —— JSX 里未定义的标识符是**运行时**错误，不是语法/打包错误；
 *   · p70 用 react-dom/server 渲染，桩 api 的 items 是空的、而且渲染是同步的（promise 还没兑现就
 *     渲染完了）→ **所有 `items.length ? 列表 : 空状态` 的列表页，它都只覆盖到空状态那一支**；
 *   · p111/p115 是"某个页面"的守卫，没覆盖这一页。
 *
 * 做法（与 p111/p115 同一套）：临时库 init+seed（**种子库，不碰生产**）→ 按用例灌夹具 →
 * 真起 apps/server → `vite preview` 出构建产物（⚠️ 代理目标用**运行时**的 VITE_DEV_API_TARGET 传，
 * 见第二十四轮坑 67）→ 真 Chrome 用种子账号登录 → 逐页断言"那个列表真的画出来了"。
 *
 * 判据（每条都必须是"有数据的页面才可能出现"的，否则等于没判）：
 *   ① 列表元素真的在页面上（选择器计数 ≥ 1）；② 该页的"共 N 条"那句在；
 *   ③ 没有 JS 异常、没有 4xx/5xx 请求、没有落在登录页（页面上不该有密码框）。
 *
 * 用例只挑"生产上真的有数据、而且坏过或最可能坏"的页；新写数据分支的页面请往 CASES 里加一条。
 *
 * ⚠️ 依赖 Chrome（与 p111/p115 同一套口径，可用 CHROME_PATH 覆盖）；
 * ⚠️ vite preview 只绑 ::1，探测与访问都要用 localhost 而不是 127.0.0.1。
 * 跑法：CHROME_PATH=/usr/bin/chromium-browser node scripts/p124-list-data-render.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const root = process.cwd();
const shotDir = path.join(root, '.tmp', 'data-branch-shots');
fs.rmSync(shotDir, { recursive: true, force: true });
fs.mkdirSync(shotDir, { recursive: true });

const problems = [];
const note = (label, detail = '') => problems.push(detail ? `${label} — ${detail}` : label);
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});


const now = () => new Date().toISOString();
const CASES = [
  {
    app: 'admin', route: '/admin/materials', account: { login: 'root', password: 'admin123' },
    // 这条就是 2026-09-20 那次白屏：列表非空才会走到渲染崩掉的那一支
    fixture: async () => await aq('INSERT OR REPLACE INTO promo_materials(id,title,description,category,mime_type,resource_url,cover_url,visibility,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', ['pm_guard_1', '守卫样例 · 招生海报', '夹具：这一页必须有物料才验得到列表分支。', 'POSTER', 'application/pdf', null, null, 'ALL_ORGS', 'ACTIVE', (await arow("SELECT id FROM users WHERE login='root'")).id, now(), now()]),
    expect: '.material-card', expectText: '个物料',
  },
  {
    app: 'org', route: '/org/courses', account: { login: 'org-admin', password: 'org123' },
    // 卡片网格（复用学生端 course-package-* 那套类）—— 2026-09-20 刚改的形状
    fixture: null, expect: '.course-package-card', expectText: '个课包',
  },
  {
    app: 'admin', route: '/admin/organizations', account: { login: 'root', password: 'admin123' },
    fixture: null, expect: 'table tbody tr', expectText: '条数据',
  },
];

// ── 临时库（种子）————————————————————————————————————————————————————
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p124-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// ── 用例：账号都是种子账号；夹具只写进临时库 ─────────────────────────────────
const { aq, arow, arows } = await import('../packages/database/src/store.js');
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { closeDb } = await import("../packages/database/src/store.js");

const env = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  FILE_UPLOAD_ROOT: path.join(temp, 'uploads'),
  AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
delete env.AUTH_PEPPER;
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => (code ? reject(new Error(output.slice(-1500))) : resolve(output)));
});

const children = [];
const cleanup = async () => {
  for (const child of children) { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } }
  // Windows 上刚 SIGTERM 的子进程还会短暂占着临时库文件，立刻删会被 EPERM 挡回来（Linux 上没这问题）
  try { // 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 留给系统的临时目录回收 */ }
};

let browser = null;
try {
  console.log('准备临时库（init + seed）…');
  await run(['packages/database/src/db.js', '--init']);
  await run(['packages/database/src/seed.js']);
  
  
  for (const item of CASES) if (item.fixture) item.fixture();
  // 种子账号的口令就是这三个（seed.js 里写着）；临时实例跑在默认 pepper 下，与 seed 一致
  

  const apiPort = await freePort();
  const api = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(apiPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(api);
  let apiLog = '';
  api.stdout.on('data', (chunk) => { apiLog += chunk; });
  api.stderr.on('data', (chunk) => { apiLog += chunk; });
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) break; } catch { /* 还在起 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // ⚠️ 必须**自己构建**：直接 `vite preview` 已有 dist 的话，改了源码没重建就验不到 ——
  //    守卫会绿得毫无意义（p111 那个坑，p115 就是为此改成自建）。构建会覆盖 apps/*/dist（在 .gitignore 内）。
  for (const app of [...new Set(CASES.map((item) => item.app))]) {
    console.log(`构建 apps/${app} …`);
    await run(['node_modules/vite/bin/vite.js', 'build', `apps/${app}`, '--config', `apps/${app}/vite.config.mjs`]);
  }

  // 每个用到的前端各起一个 vite preview，并把代理指向临时实例
  // ⚠️ /api 代理读的是**运行时**的 VITE_DEV_API_TARGET（第二十四轮坑 67），所以它是 spawn 时的 env
  const previews = {};
  for (const app of [...new Set(CASES.map((item) => item.app))]) {
    const port = app === 'admin' ? 6173 : 6175;   // 与两个 vite.config.mjs 的 preview 端口一致
    const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', `apps/${app}`, '--config', `apps/${app}/vite.config.mjs`], {
      cwd: root, env: { ...env, VITE_DEV_API_TARGET: `http://127.0.0.1:${apiPort}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let log = '';
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    const base = `http://localhost:${port}/${app}`;
    let up = false;
    for (let i = 0; i < 150; i += 1) { try { if ((await fetch(`${base}/`)).ok) { up = true; break; } } catch { /* 还在起 */ } await new Promise((resolve) => setTimeout(resolve, 250)); }
    if (!up) throw new Error(`vite preview（${app}）没起来：\n${log.slice(-1200)}`);
    // 存**只带 host** 的地址：路由本身已经带了 /admin、/org 前缀，拼上 base 会变成 /admin/admin/…
    previews[app] = `http://localhost:${port}`;
  }

  // 登录（拿 token，按应用分桶注进 localStorage —— 与 packages/shared/src/auth.js 同一条规则）
  const sessions = {};
  for (const app of [...new Set(CASES.map((item) => item.app))]) {
    const account = CASES.find((item) => item.app === app).account;
    const payload = await fetch(`http://127.0.0.1:${apiPort}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account) }).then((response) => response.json());
    if (!payload?.data?.token) { note(`${app} 登录失败`, JSON.stringify(payload).slice(0, 200)); continue; }
    sessions[app] = payload.data;
  }

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ byApp }) => {
    const pathname = window.location.pathname;
    const app = pathname.startsWith('/admin') ? 'admin' : pathname.startsWith('/org') ? 'org' : 'student';
    if (byApp[app]) window.localStorage.setItem(`ai-kids-platform.session.v1.${app}`, JSON.stringify(byApp[app]));
  }, { byApp: sessions });

  for (const [index, item] of CASES.entries()) {
    const page = await context.newPage();
    const pageErrors = [];
    const badResponses = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error).slice(0, 260)));
    page.on('response', (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });
    const label = item.route;
    console.log(`\n── ${label}（${item.account.login}）`);
    await page.goto(`${previews[item.app]}${item.route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    // 等那个列表真的画出来：出不来就是这一条要抓的（下面的断言会说明是崩了还是空着）
    await page.waitForSelector(item.expect, { timeout: 8000 }).catch(() => {});
    const state = await page.evaluate((selector) => ({
      url: location.href,
      count: document.querySelectorAll(selector).length,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim(),
      session: Boolean(window.localStorage.getItem('ai-kids-platform.session.v1.admin') || window.localStorage.getItem('ai-kids-platform.session.v1.org') || window.localStorage.getItem('ai-kids-platform.session.v1.student')),
      passwordFields: document.querySelectorAll('input[type="password"]').length,
    }), item.expect);
    await page.screenshot({ path: path.join(shotDir, `${String(index + 1).padStart(2, '0')}-${item.app}-${item.route.replace(/[^a-zA-Z0-9]+/g, '-')}.png`), fullPage: true });
    await page.close();

    console.log(`   ${item.expect} × ${state.count}　正文 ${state.text.length} 字`);
    if (pageErrors.length) note(`${label} 渲染期抛错（整页会白屏）`, pageErrors.join(' | '));
    if (state.passwordFields) note(`${label} 落在登录页`, '页面上有密码框 —— 这一页没验到');
    if (state.text.length < 40) note(`${label} 几乎是空白页`, `正文只有 ${state.text.length} 字`);
    if (state.count < 1) note(`${label} 的列表没画出来`, `选择器 ${item.expect} 命中 0 个`);
    if (item.expectText && !state.text.includes(item.expectText)) note(`${label} 少了「${item.expectText}」`, '列表分页那句没出现');
    const apiBad = badResponses.filter((bad) => bad.includes('/api/'));
    if (apiBad.length) note(`${label} 的接口报错`, apiBad.slice(0, 4).join(' | '));
  }
} catch (error) {
  note('脚本自身出错', String(error?.stack || error).slice(0, 1200));
} finally {
  if (browser) await browser.close().catch(() => {});
  await cleanup();
}

console.log(`\n截图 ${fs.readdirSync(shotDir).length} 张 → ${shotDir}`);
if (problems.length) {
  console.error('\nP124 有未通过项：');
  for (const item of problems) console.error('  ✗ ' + item);
  process.exitCode = 1;
} else {
  console.log('P124 列表页「有数据」分支渲染：列表都画出来了、没有抛错、没有落在登录页');
}
