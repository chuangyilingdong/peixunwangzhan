/**
 * 页面观感自查脚手架（**工具，不是守卫** —— 它不下"口径不许破"的断言，只把"页面长什么样"变成可复跑的证据）
 *
 * 为什么要有它：三端登录门之后的页面，API 断言与 p70 渲染守卫都看不见**观感**。
 * 第二十四轮重做了两个页面（平台「素材与宣传物料」、机构端课程中心卡片）却一次都没能自己截图看过
 * —— 机构端/平台端要登录，而"临时库 + 临时实例"那套只跑 API、不提供前端页面。
 * 这一份把那条路固定下来：**生产库副本 + 临时实例 + 与生产同布局的单源静态服务 + 真浏览器**，
 * 用副本里重设过密码的种子账号登进去逐页截图。
 *
 * ⚠️ 它绕开的两个必踩点（见第二十四轮交接「坑 67」，上一轮就栽在这里）：
 *   ① 临时实例**只提供 API**，前端页面得自己出 —— 这里 `vite build` 出各端 dist；
 *   ② `vite preview` 的 `/api` 代理读的是**运行时**的 `VITE_DEV_API_TARGET`（构建时设没用），
 *      而且它只绑 ::1、配了 strictPort —— 干脆不用它：自己起一个**与生产同布局**的单源静态服务
 *      （`/admin/` → admin dist、`/org/` → org dist、其余 → website dist、`/api/` 反代临时实例），
 *      于是页面里的相对请求、会话按路径分桶、SPA 回退都与线上同一套，截图里的请求不会打到空端口。
 *
 * 跑法（服务器上；本机 node 是 v16，跑不了）：
 *   export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH
 *   CHROME_PATH=/usr/bin/chromium-browser node scripts/page-shot.mjs /org/courses /admin/materials
 *   · `--as teacher-1` 换身份（默认按路由推断：/admin→root、/org→org-admin、其余→student-1）
 *   · `--no-build` 复用现有 dist（改过源码就别加，否则截出来的是旧页面 —— p111 那个坑）
 *   · `--fresh` 用种子空库（不碰生产库；本机能跑但本机 node 得够新）
 *   · `--seed <文件.sql>` / `--sql '<SQL>'` 往**副本**里灌几条数据再截 ——
 *     空状态会盖住版面问题（卡片网格、角标、分页都看不到），生产库常常就是空的
 *   · `--fixture <文件.mjs>` 页面需要**生产上不存在或不敢动**的状态时，先自己造：
 *     那个文件导出 `prepare({ api, db, hashPassword, log })`，返回一个对象作为变量表，
 *     路由里的 `{变量名}` 会被替换掉（例：`--fixture .tmp/fx.mjs /learn/canvas/{projectId}`）。
 *     `api(pathname, { method, token, body })` 打的是临时实例；`db` 是副本的 sqlite 连接。
 *     例：造一节有生成框体、已发布、学生已在课堂里的课，再把画布页面截下来。
 *   · `--text` 打印整页可见文本；`--check 文案1,文案2` 断言页面上有这些话
 *   · `--click 按钮文案` 先点一下再截（可以给多次，按顺序点）—— 向导第二步、弹窗里的样子靠它
 *     ⚠️ **同名按钮有多个时它只点第一个**（`first()`），命中哪一条完全看列表排序 ——
 *     机构端「作品管理」每一行都有一个「查看作品」（实测 8 个），"点不动/点错对象"多半是这个，
 *     不是按钮真的点不了。要挑特定那一行就用 `--then` 自己按行找。像 `--click` 一直点不开的，
 *     先数一下同名元素有几个再下结论
 *   · `--then <文件.mjs>` 点完之后再跑一段**真动作**（导出 `run({ page, api, db, log, shot })`）：
 *     要等状态翻转、要看跳没跳、要按自己的判据断言的，`--click` 按一下就完事那种做不了。
 *     返回值进 report 里的 `then`；返回 `{ expectRedirect: '/learn' }` 时底下那条"被重定向了"的
 *     断言会改成**必须**落到这个地址（是把断言换准，不是关掉）
 *   · 同一条思路，`--then` 还能返回两个"换准"开关（2026-09-23 为账号安全页加的）：
 *       `{ expectPasswordForm: true }` —— 这一页**本来就有**密码输入框（改密页），
 *         那条"落在登录页"的判据换成"会话在、且没渲染登录卡"；
 *       `{ expectedApiErrors: ['/me/password'] }` —— 这些报错是我故意造的（拿错口令验红字提示），
 *         命中的不算问题、没命中的照旧红。
 *   · `--viewport 390x844` 看窄屏（口径 57 那类"中文被折成竖排"的毛病只在窄列出现）
 *   · `--keep` 截完不退出，把地址与账号打出来，留着人肉点
 * 产物：`.tmp/page-shots/<tag>/` 下每页一张 png + `report.json`
 *
 * ⚠️ 它只能证明「这一页**登进去了**、没有 JS 异常、没有接口报错」，**不能**替你判断"这一页好不好看" ——
 *    截图是要拿眼睛看的。第一版把它当成了自己的判据，结果两页都停在登录页、脚本还报了"✓"，
 *    正是这个项目最恨的那类哑守卫；现在"会话在不在""页面上有没有密码框"都成了硬判据。
 *
 * ⚠️ 生产库是**只读**使用的：`VACUUM INTO` 取一致性快照（失败才回落成连 wal 一起复制），
 *    所有写（重设密码、`--seed` 灌的数据）都发生在 /tmp 的副本上。上传根默认也是临时目录 ——
 *    要看真实素材图/文档再加 `--prod-uploads`（那份目录仍然只读使用：脚本自身不上传、不转换、不落盘）。
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const root = process.cwd();
const DEFAULT_PROD_DB = '/srv/ai-kids-platform/production/data/platform.db';
const DEFAULT_PROD_UPLOADS = '/srv/ai-kids-platform/production/uploads';
const DEFAULT_MEDIA_ROOT = '/srv/ai-kids-platform/public-media';
const DEFAULT_DOWNLOADS_ROOT = '/srv/ai-kids-platform/downloads';

// ── 参数 ────────────────────────────────────────────────────────────────────
const opts = { as: null, tag: null, db: null, build: true, fresh: false, text: false, wait: 1600, keep: false, viewport: '1440x1000', uploads: null, prodUploads: false, out: null, seed: null, sql: null, fixture: null, vars: {}, then: null };
const routes = [];
const globalChecks = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const next = () => { i += 1; if (i >= argv.length) { console.error(`参数 ${arg} 后面缺值`); process.exit(2); } return argv[i]; };
  if (arg === '--as') opts.as = next();
  else if (arg === '--tag') opts.tag = next();
  else if (arg === '--db') opts.db = next();
  else if (arg === '--no-build') opts.build = false;
  else if (arg === '--fresh') opts.fresh = true;
  else if (arg === '--text') opts.text = true;
  else if (arg === '--wait') opts.wait = Number(next());
  else if (arg === '--keep') opts.keep = true;
  else if (arg === '--viewport') opts.viewport = next();
  else if (arg === '--uploads') opts.uploads = next();
  else if (arg === '--prod-uploads') opts.prodUploads = true;
  else if (arg === '--out') opts.out = next();
  else if (arg === '--seed') opts.seed = next();
  else if (arg === '--sql') opts.sql = next();
  else if (arg === '--fixture') opts.fixture = next();
  else if (arg === '--then') opts.then = next();
  else if (arg === '--click') {
    const texts = String(next()).split(',').map((item) => item.trim()).filter(Boolean);
    (routes.length ? routes[routes.length - 1].clicks : []).push(...texts);
  }
  else if (arg === '--check') {
    const texts = String(next()).split(',').map((item) => item.trim()).filter(Boolean);
    (routes.length ? routes[routes.length - 1].checks : globalChecks).push(...texts);
  } else if (arg.startsWith('--')) { console.error(`未知参数 ${arg}`); process.exit(2); } else routes.push({ path: arg, checks: [], clicks: [] });
}
if (!routes.length) {
  console.error('用法：node scripts/page-shot.mjs [选项] <路由...>　（例如 /org/courses /admin/materials）');
  process.exit(2);
}
for (const route of routes) if (!route.path.startsWith('/')) { console.error(`路由要以 / 开头：${route.path}`); process.exit(2); }
for (const route of routes) route.checks = [...globalChecks, ...route.checks];

const [viewW, viewH] = String(opts.viewport).split('x').map((value) => Number(value));
if (!viewW || !viewH) { console.error(`--viewport 要写成 1440x1000 这样：${opts.viewport}`); process.exit(2); }

// ── 账号与会话 ──────────────────────────────────────────────────────────────
// 这三个密码是**种子账号**的口令（packages/database/src/seed.js 里就写着），
// 脚本会在**副本**里把它们重设成同一个值（用默认 pepper），所以不依赖生产口令。
const ACCOUNTS = {
  root: { login: 'root', password: 'admin123', app: 'admin' },
  'org-admin': { login: 'org-admin', password: 'org123', app: 'org' },
  'teacher-1': { login: 'teacher-1', password: 'teach123', app: 'org' },
  'student-1': { login: 'student-1', password: 'study123', app: 'student' },
};
// 会话按应用分桶（packages/shared/src/auth.js 的 sessionStorageKey 是同一条规则：
// 键名是**完整**的 ai-kids-platform.session.v1.<桶>，别把桶名当键名用 —— 第一版就栽在这儿，
// 键写错时页面只是安静地显示登录页，脚本还报了"✓"，正是这个项目最恨的那类哑守卫）
const appForRoute = (route) => (route.path.startsWith('/admin') ? 'admin' : route.path.startsWith('/org') ? 'org' : 'website');
const accountForRoute = (route) => opts.as || (route.path.startsWith('/admin') ? 'root' : route.path.startsWith('/org') ? 'org-admin' : 'student-1');
// 路由里的 `{变量}` 由 --fixture 的返回值填（fixture 跑在临时实例起来之后，见下）。
// 必须放在 accountForRoute/appForRoute 之后 —— 放前面会撞 const 的暂时性死区。
const assignRouteTargets = () => {
  for (const route of routes) {
    route.path = String(route.path).replace(/\{(\w+)\}/g, (match, key) => (opts.vars[key] === undefined ? match : encodeURIComponent(String(opts.vars[key]))));
    route.account = accountForRoute(route);
    route.app = appForRoute(route);
    if (!ACCOUNTS[route.account]) { console.error(`--as 只认这几个账号：${Object.keys(ACCOUNTS).join(' / ')}（给的是 ${route.account}）`); process.exit(2); }
  }
};
assignRouteTargets();
const problems = [];
const warnings = [];
const fail = (label, detail) => problems.push({ label, detail });
const warn = (label, detail) => warnings.push({ label, detail });
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// ── 库：生产库副本（或 --fresh 的种子空库）──────────────────────────────────
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'page-shot-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
const uploadRoot = opts.uploads || (opts.prodUploads ? DEFAULT_PROD_UPLOADS : path.join(temp, 'uploads'));
if (opts.prodUploads) console.log(`上传根 = 生产目录 ${DEFAULT_PROD_UPLOADS}（只读使用；不传就看不到已上传的素材原文件）`);
else console.log('上传根 = 临时空目录（页面里若该有素材原文件而没显示，加 --prod-uploads 再看一次）');

if (opts.fresh) {
  console.log('库 = --fresh 的种子空库（不碰生产库）');
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp, PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath, FILE_UPLOAD_ROOT: uploadRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => (code ? reject(new Error(output.slice(-1200))) : resolve(output)));
  });
  await run(['packages/database/src/db.js', '--init']);
  await run(['packages/database/src/seed.js']);
} else {
  const source = opts.db || process.env.PAGE_SHOT_DB || DEFAULT_PROD_DB;
  if (!fs.existsSync(source)) {
    console.error(`找不到源库 ${source}。\n` +
      '　· 这份脚本是给"照生产数据自查页面"用的，要在服务器上跑；\n' +
      '　· 只想离线跑一遍就用 --fresh（种子空库）。');
    process.exit(2);
  }
  console.log(`库 = 生产库副本（源 ${source}）`);
  try {
    // VACUUM INTO 是 SQLite 的一致性快照：对**正在被写**的库也安全，不会拷到撕裂的页。
    
const { aq, arow, arows } = await import('../packages/database/src/store.js');
    await aq(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
    
  } catch (error) {
    // 回落：连 wal/shm 一起复制（缺 wal 会丢掉最近已提交的事务）
    warn('VACUUM INTO 失败，回落成复制 db+wal+shm', String(error?.message || error));
    fs.copyFileSync(source, dbPath);
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, dbPath + suffix);
  }
}

// 副本里重设种子账号口令：用**默认 pepper** 算 hash，临时实例也在默认 pepper 下跑 —— 两边必须同一套。
delete process.env.AUTH_PEPPER;
const { hashPassword } = await import('@platform/database');
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { closeDb } = await import("../packages/database/src/store.js");



const accounts = new Map();
for (const name of [...new Set(routes.map((route) => route.account))]) {
  const account = ACCOUNTS[name];
  const row = await arow('SELECT id, login, role, status FROM users WHERE login=?', [account.login]);
  if (!row) { fail(`副本里没有账号 ${account.login}`, '生产库里这个账号可能被改名/删掉了，换 --as 别的账号'); continue; }
  await aq('UPDATE users SET password_hash=? WHERE login=?', [hashPassword(account.password), account.login]);
  accounts.set(name, { ...account, id: row.id, role: row.role, status: row.status });
  if (row.status !== 'ACTIVE') warn(`账号 ${account.login} 在生产库里状态是 ${row.status}`, '登录可能被拒');
}
// 「页面在有数据时长什么样」也是观感的一部分：空状态会盖住版面问题（卡片网格、角标、分页）。
// 生产库里常常是空的（例如 promo_materials 一条都没有），所以留一个往**副本**里灌数据的口子。
if (opts.seed || opts.sql) {
  const script = opts.seed ? fs.readFileSync(opts.seed, 'utf8') : opts.sql;
  await aq(script);
  console.log(`已往副本里灌 SQL（${opts.seed || '--sql 内联'}），只影响副本`);
}


// ── 临时实例（只跑 API）────────────────────────────────────────────────────
const apiPort = await freePort();
const env = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  FILE_UPLOAD_ROOT: uploadRoot,
  AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
  PORT: String(apiPort),
};
delete env.AUTH_PEPPER;
const api = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let apiLog = '';
api.stdout.on('data', (chunk) => { apiLog += chunk; });
api.stderr.on('data', (chunk) => { apiLog += chunk; });

let browser = null;
let web = null;
let report = [];
const cleanup = async () => {
  try { api.kill('SIGTERM'); } catch { /* 已退出 */ }
  if (browser) { try { browser.close(); } catch { /* ignore */ } }
  if (web) { try { web.close(); } catch { /* ignore */ } }
  // ⚠️ 2026-09-23：在 Windows 上这一行会 EPERM —— 刚被杀掉的子进程（Chromium / 前端静态服务）
  //    还攥着临时目录里的句柄，删除当场失败，**整个脚本以 1 退出**（结论其实已经跑出来了，看着却像失败）。
  //    带上退避重试即可（Node 对 EBUSY / EPERM / ENOTEMPTY 会按 retryDelay 重试）；Linux 上行为不变。
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
fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
  catch (error) { console.log(`（临时目录没删干净：${error?.code || error?.message} —— 不影响本次结论）`); }
};
process.on('SIGINT', async () => { console.log('\n收到 Ctrl-C，收工'); await cleanup(); process.exit(130); });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
};
const serveFile = (res, file) => {
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': body.length });
  res.end(body);
};
// 与生产 nginx 同布局：/admin/ → admin dist，/org/ → org dist，其余 → website dist（SPA 回退到它的 index.html）
// /media/ 与 /downloads/ 是 nginx 的 alias（作品媒体、客户端安装包），在 release 之外，本地起服务时单独挂。
const MOUNTS = [
  { prefix: '/admin', dir: path.join(root, 'apps/admin/dist'), spa: true },
  { prefix: '/org', dir: path.join(root, 'apps/org/dist'), spa: true },
  { prefix: '/', dir: path.join(root, 'apps/website/dist'), spa: true },
  { prefix: '/media', dir: DEFAULT_MEDIA_ROOT, spa: false },
  { prefix: '/downloads', dir: DEFAULT_DOWNLOADS_ROOT, spa: false },
];

const startWeb = () => new Promise((resolve, reject) => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${webPort}`);
    if (url.pathname.startsWith('/api/')) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const upstream = await fetch(`http://127.0.0.1:${apiPort}${url.pathname}${url.search}`, {
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
          redirect: 'manual',
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        const headers = {};
        upstream.headers.forEach((value, key) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key)) headers[key] = value; });
        res.writeHead(upstream.status, { ...headers, 'content-length': body.length });
        res.end(body);
      } catch (error) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`临时实例没接住这个请求：${String(error?.message || error)}`);
      }
      return;
    }
    const mount = MOUNTS.find((item) => item.prefix !== '/' && (url.pathname === item.prefix || url.pathname.startsWith(`${item.prefix}/`))) || MOUNTS[2];
    if (!fs.existsSync(mount.dir)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`这个挂载点没有内容：${mount.prefix} → ${mount.dir}\n（前端没构建？去掉 --no-build 再来）`);
      return;
    }
    const rest = mount.prefix === '/' ? url.pathname : url.pathname.slice(mount.prefix.length) || '/';
    let decoded = rest;
    try { decoded = decodeURIComponent(rest); } catch { /* 地址里有非法转义：按原样找文件 */ }
    let file = path.join(mount.dir, decoded);
    if (!file.startsWith(mount.dir)) { res.writeHead(403).end('越界'); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (!mount.spa) { res.writeHead(404).end('没有这个文件'); return; }
      file = path.join(mount.dir, 'index.html');
    }
    serveFile(res, file);
  });
  server.on('error', reject);
  server.listen(webPort, '127.0.0.1', () => resolve(server));
});

const webPort = await freePort();
const origin = `http://127.0.0.1:${webPort}`;
const shotDir = path.resolve(root, opts.out || path.join('.tmp', 'page-shots', opts.tag || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 15)));

try {
  const ready = async () => {
    for (let i = 0; i < 120; i += 1) {
      try { if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) return true; } catch { /* 还在起 */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  };
  if (!(await ready())) throw new Error(`临时实例没起来：\n${apiLog.slice(-1500)}`);
  console.log(`临时实例：API http://127.0.0.1:${apiPort}（库是副本，不碰生产）`);

  // 打临时实例的接口（夹具与 --then 共用）：走真 HTTP，所以过的是与页面同一条路
  const apiCall = async (pathname, { method = 'GET', token, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null };
  };

  // --fixture：页面需要"生产上不存在或不敢动"的状态时先自己造（例：一节已发布、有生成框体、
  // 学生已在课堂里的课 —— 才看得到画布左侧的素材面板）。它返回的变量表会填进路由里的 {变量}。
  if (opts.fixture) {
    const module = await import(pathToFileURL(path.resolve(root, opts.fixture)).href);
    if (typeof module.prepare !== 'function') { console.error(`--fixture 的文件要导出 prepare({ api, db, hashPassword, log })：${opts.fixture}`); process.exit(2); }
    
    
    const api = apiCall;
    console.log(`跑夹具 ${opts.fixture} …`);
    const vars = await module.prepare({ api, db: fixtureDb, hashPassword, log: (message) => console.log(`   ${message}`) });
    
    Object.assign(opts.vars, vars || {});
    assignRouteTargets();
    console.log(`夹具返回变量：${JSON.stringify(opts.vars)}`);
  }

  // --then：页面加载（+ --click 点完）之后要跑一段**真动作**时用它 —— `--click` 只能按文案点一下，
  // 而"老师结束课堂 → 学生端自己退出""点开预览看弹窗里的东西"这类要**等状态翻转、看跳没跳**，
  // 按一下按钮是验不出来的（机构端那几页 --click 也点不动）。它导出的 run({ page, api, db, log, shot })
  // 可以任意 await / 断言，返回值进 report[i].then；返回 `{ expectRedirect: '/learn' }` 时，
  // 底下那条「被重定向了」的断言会改成**必须**落到这个地址（不是把断言关掉）。
  let thenRun = null;
  if (opts.then) {
    const module = await import(pathToFileURL(path.resolve(root, opts.then)).href);
    if (typeof module.run !== 'function') { console.error(`--then 的文件要导出 run({ page, api, db, log, shot })：${opts.then}`); process.exit(2); }
    thenRun = module.run;
  }

  // 先把要用的账号都登一遍（拿 token），再一次性注进浏览器
  const sessions = {};
  for (const [name, account] of accounts) {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: account.login, password: account.password }) });
    const payload = await response.json().catch(() => null);
    const session = payload?.data;
    if (!session?.token) { fail(`账号 ${account.login} 登不进去`, `${response.status} ${JSON.stringify(payload).slice(0, 200)}`); continue; }
    sessions[account.app] = session;
    console.log(`登录 ok：${account.login}（${session.user?.role || '?'}）`);
  }

  // 构建前端（改过源码就别 --no-build —— p111 那个"验的是旧 dist"的坑）
  if (opts.build) {
    const apps = [...new Set(routes.map((route) => route.app))];
    for (const app of apps) {
      console.log(`构建 apps/${app} …`);
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build', `apps/${app}`, '--config', `apps/${app}/vite.config.mjs`], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('close', (code) => (code ? reject(new Error(output.slice(-1500))) : resolve()));
      });
    }
  } else {
    for (const app of new Set(routes.map((route) => route.app))) if (!fs.existsSync(path.join(root, `apps/${app}/dist/index.html`))) fail(`apps/${app}/dist 不存在却给了 --no-build`, '去掉 --no-build 重新构建');
    console.log('按 --no-build 复用现有 dist（源码改过的话，截出来的是旧页面）');
  }

  web = await startWeb();
  console.log(`前端：${origin}（/admin/ 平台端、/org/ 机构端、其余 官网+学生端，/api 反代临时实例）`);
  fs.mkdirSync(shotDir, { recursive: true });

  const CHROME = process.env.CHROME_PATH || (fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'C:/Program Files/Google/Chrome/Application/chrome.exe');
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: viewW, height: viewH }, deviceScaleFactor: 1 });
  // 每次导航前把会话注回去：页面自己把会话清了（登出、401）也还在，截图不会变成登录页
  await context.addInitScript(({ byBucket }) => {
    const pathname = window.location.pathname;
    const bucket = pathname.startsWith('/admin') ? 'admin' : pathname.startsWith('/org') ? 'org' : 'student';
    const session = byBucket[bucket];
    if (session) window.localStorage.setItem(`ai-kids-platform.session.v1.${bucket}`, JSON.stringify(session));
  }, { byBucket: sessions });

  for (const [index, route] of routes.entries()) {
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const badResponses = [];
    const failedRequests = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error).slice(0, 300)));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
    page.on('response', (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });
    page.on('requestfailed', (request) => failedRequests.push(`${request.failure()?.errorText || 'failed'} ${request.url()}`));

    const url = `${origin}${route.path}`;
    console.log(`\n── ${route.path}　（${route.account}）`);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((error) => fail(`${route.path} 打不开`, String(error?.message || error)));
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(opts.wait);
    const slug = route.path.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/, '') || 'root';
    const shotName = (suffix) => path.join(shotDir, `${String(index + 1).padStart(2, '0')}-${slug}${suffix}.png`);
    const shots = [];
    // 有 --click 时先留一张"点之前"的：列表/主视图与点开之后的向导/弹窗是两回事，都值得看
    if (route.clicks.length) { const before = shotName(''); await page.screenshot({ path: before, fullPage: true }); shots.push(path.relative(root, before)); }
    // --click：一步步点下去（走向导、开弹窗），不然那些"藏在第二步/弹窗里"的东西永远看不到
    for (const label of route.clicks) {
      // ⚠️ 别只按 role=button 找：标签页是 `role="tab"`、导航是 `role="link"`，
      //    只试 button 会得到「点不到」的假失败（第一版就是这样漏掉「版本发布」这个标签的）。
      const candidates = [
        page.getByRole('button', { name: label }),
        page.getByRole('tab', { name: label }),
        page.getByRole('link', { name: label }),
        page.getByText(label),
      ];
      let target = null;
      for (const candidate of candidates) { if (await candidate.count()) { target = candidate.first(); break; } }
      if (!target) { fail(`${route.path} 点不到「${label}」`, '页面上没有这个文案的按钮/标签（文案变了？还是它还没渲染出来）'); continue; }
      await target.click().catch((error) => fail(`${route.path} 点「${label}」失败`, String(error?.message || error)));
      await page.waitForTimeout(700);
    }
    // --then：跑这一段"真动作"（等状态翻转、看跳没跳、自己截图）
    let thenResult = null;
    if (thenRun) {
      const shot = async (suffix = '-then') => { const file = shotName(suffix); await page.screenshot({ path: file, fullPage: true }); shots.push(path.relative(root, file)); return path.relative(root, file); };
      
      
      console.log(`   跑 --then ${opts.then} …`);
      try {
        thenResult = await thenRun({ page, context, api: apiCall, db: thenDb, log: (message) => console.log(`      ${message}`), shot, vars: opts.vars, route: route.path });
      } catch (error) {
        fail(`${route.path} 的 --then 自己抛了`, String(error?.message || error).slice(0, 400));
      } finally {  }
      if (thenResult && Array.isArray(thenResult.problems)) for (const item of thenResult.problems) fail(`${route.path} --then：${item}`, '');
      if (thenResult && Array.isArray(thenResult.notes)) for (const note of thenResult.notes) console.log(`      · ${note}`);
    }
    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\n{2,}/g, '\n').trim();
      const heading = document.querySelector('h1')?.innerText?.replace(/\s+/g, ' ').trim() || '';
      const bucket = window.location.pathname.startsWith('/admin') ? 'admin' : window.location.pathname.startsWith('/org') ? 'org' : 'student';
      return {
        finalUrl: location.href, title: document.title, heading, text,
        buttons: document.querySelectorAll('button').length,
        inputs: document.querySelectorAll('input, select, textarea').length,
        images: document.querySelectorAll('img').length,
        // 两个"这一页到底登进去了没有"的判据：会话在不在、页面上有没有密码框（登录页的铁证）。
        // 少了它们，键名写错这种事故的现场就是"页面看着挺正常、脚本还挺绿"。
        sessionInStorage: Boolean(window.localStorage.getItem(`ai-kids-platform.session.v1.${bucket}`)),
        hasPasswordField: document.querySelectorAll('input[type="password"]').length > 0,
        loginCard: document.querySelectorAll('.login-card').length,
      };
    });
    const after = shotName(route.clicks.length ? '-clicked' : '');
    await page.screenshot({ path: after, fullPage: true });
    shots.push(path.relative(root, after));
    await page.close();

    const apiBad = badResponses.filter((item) => item.includes('/api/'));
    const assetBad = badResponses.filter((item) => !item.includes('/api/'));
    const checks = route.checks.map((text) => ({ text, ok: state.text.includes(text) }));
    const missed = checks.filter((check) => !check.ok);

    console.log(`   h1=${state.heading || '（无）'}　会话=${state.sessionInStorage ? '✓' : '✗'}${state.hasPasswordField ? '（登录页！）' : ''}　按钮 ${state.buttons} / 输入 ${state.inputs} / 图 ${state.images}　正文 ${state.text.length} 字`);
    console.log(`   截图 ${shots.join('  ')}`);
    if (state.finalUrl.replace(origin, '') !== route.path) console.log(`   ⚠️ 落到了别的地址：${state.finalUrl.replace(origin, '')}`);
    if (opts.text) console.log(`   正文：${state.text.slice(0, 1200)}`);
    else console.log(`   正文开头：${state.text.slice(0, 160).replace(/\n/g, ' / ')}`);

    if (pageErrors.length) fail(`${route.path} 有 JS 异常`, pageErrors.join(' | '));
    if (!state.sessionInStorage) fail(`${route.path} 的会话没注进去`, '页面上读不到 ai-kids-platform.session.v1.*（键名或账号有问题）');
    if (state.hasPasswordField && thenResult?.expectPasswordForm) {
      // --then 明说了"这一页里**本来就有**密码输入框"（账号安全页 / 改密页）。
      // 不是把断言关掉 —— 换成**必须不是登录页**：会话在、而且没有渲染登录卡。
      if (state.sessionInStorage && !state.loginCard) console.log('   ✓ 页面上有密码输入框，但渲染的是账号安全页（不是登录页）—— --then 声明的');
      else fail(`${route.path} 说是账号安全页，实际渲染成了登录页`, `会话=${state.sessionInStorage ? '在' : '不在'} 登录卡=${state.loginCard} 个`);
    } else if (state.hasPasswordField) fail(`${route.path} 落在登录页`, '页面上有密码输入框 —— 这一张截图不能当"登录后的页面"用');
    if (state.text.length < 40) fail(`${route.path} 几乎是空白页`, `正文只有 ${state.text.length} 字`);
    if (thenResult?.expectRedirect) {
      // --then 明说了"这一页本来就该自己跳走"（例：老师结束课堂后学生端退出画布）。
      // 不是把断言关掉 —— 换成**必须**落到它说的那个地址，跳晚了、跳到别处、压根没跳，都还是红。
      const landed = state.finalUrl.replace(origin, '').split('?')[0];
      if (landed !== thenResult.expectRedirect) fail(`${route.path} 该自己跳到 ${thenResult.expectRedirect}`, `实际落在 ${landed}（没跳 / 跳错地方 / 还没跳完）`);
      else console.log(`   ✓ 自己跳到了 ${thenResult.expectRedirect}（--then 声明的落点）`);
    } else if (state.finalUrl.replace(origin, '') !== route.path) fail(`${route.path} 被重定向了`, `落到 ${state.finalUrl.replace(origin, '')}（多半是没登进去）`);
    if (missed.length) fail(`${route.path} 少了该出现的文案`, missed.map((check) => check.text).join(' / '));
    if (apiBad.length) {
      // --then 可以声明"这几条报错是我**故意**造出来的"（例：拿错口令打改密接口验红字提示）。
      // 同样是把判据**换准**：命中的那些不算问题，没命中的照旧红；一条没命中也不额外报错。
      const expected = (thenResult?.expectedApiErrors || []).map((pattern) => new RegExp(pattern));
      const unexpected = apiBad.filter((item) => !expected.some((pattern) => pattern.test(item)));
      if (unexpected.length) fail(`${route.path} 的接口报错`, unexpected.slice(0, 6).join(' | '));
      else console.log(`   ✓ ${apiBad.length} 条接口报错都在 --then 声明的预期内（${apiBad.slice(0, 2).join('；')}）`);
    }
    if (failedRequests.length) fail(`${route.path} 有请求根本没发出去`, failedRequests.slice(0, 6).join(' | '));
    if (assetBad.length) warn(`${route.path} 有静态资源 4xx/5xx`, assetBad.slice(0, 6).join(' | '));
    // console 里的报错里，"Failed to load resource" 已经由上面两类精确记录了 URL，别再重复报一次
    const noisy = consoleErrors.filter((item) => !/Failed to load resource/.test(item));
    if (noisy.length) warn(`${route.path} 控制台有报错`, noisy.slice(0, 4).join(' | '));

    report.push({ route: route.path, account: route.account, url, shots, ...state, then: thenResult, text: state.text.slice(0, 8000), checks, pageErrors, consoleErrors: noisy, badResponses, failedRequests });
  }

  if (opts.keep) {
    console.log(`\n--keep：留着不退出。地址 ${origin}`);
    for (const [name, account] of accounts) console.log(`　${name} → ${account.login} / ${account.password}`);
    await new Promise((resolve) => { process.on('SIGINT', resolve); process.on('SIGTERM', resolve); });
  }
} catch (error) {
  console.error(apiLog.slice(-1500));
  fail('脚本自身出错', String(error?.stack || error).slice(0, 1200));
} finally {
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(shotDir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), viewport: opts.viewport, routes: report, problems, warnings }, null, 2));
  await cleanup();
}

console.log(`\n截图目录：${path.relative(root, shotDir)}`);
for (const item of warnings) console.log(`   ⚠️ ${item.label}${item.detail ? ` — ${item.detail}` : ''}`);
if (problems.length) {
  console.log(`\n✗ ${problems.length} 处要看的：`);
  for (const item of problems) console.log(`   · ${item.label}${item.detail ? ` — ${item.detail}` : ''}`);
} else {
  console.log('\n✓ 逐页看过：没有 JS 异常、没有接口报错、没有空白页');
}
process.exit(problems.length ? 1 : 0);
