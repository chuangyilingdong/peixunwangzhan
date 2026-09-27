/**
 * P115 官网首页与登录页「真浏览器走一遍」守卫（2026-09-18）
 *
 * 为什么需要它：这一轮在官网上抓到的四个问题**全是人眼发现的**，当时所有守卫都是绿的 ——
 *   · 登录页装饰线出血 → 点一下按钮整页横向滚 224px（`overflow:hidden` 挡不住**程序化**滚动）；
 *   · 品牌主张被折成三行（字号按 vw 写，而 vw 跟文字所在盒子的宽度无关）；
 *   · 背景光斑被网格栏裁出一条硬边（装饰伸到了 `overflow:hidden` 的边界）；
 *   · 强刷先闪一帧**旧文案**（骨架屏 + CMS 兜底两处来源，接口还没回来就渲染了兜底）。
 * 既有守卫都拦不住这一类：p111 只覆盖机构端/教师端，p70 只证明「渲染不报错」。
 * 所以补这一道：真构建 → vite preview → 真 Chrome，把上面四类做成可复跑的断言。
 *
 * ⚠️ 这一道**自己构建** apps/website。p111 是直接 `vite preview` 已有 dist 的 ——
 *    改源码不重建就验不到（守卫会绿得毫无意义）。这里不重复那个坑。
 *    构建会覆盖 apps/website/dist（在 .gitignore 内），与 `pnpm build` 的行为一致。
 *
 * 断言的口径（改了先读交接文档第十六轮第三节，别当测试漂移）：
 *   ① 官网文案优先改 CMS；**代码兜底必须与 CMS 当前内容一致** ——
 *     所以这里对同一页取两遍（接口正常 / 接口失败），断言**渲染出来的文案与数字逐字相同**；
 *   ② 接口回来前不渲染文案（`ready = !cms.loading`），但视频与按钮要照常立刻在（不白屏）；
 *   ③ 空串 = 运营故意清空，**不回退显示**兜底；
 *   ④ 字号不许只按 vw；装饰不许伸到盒子边缘；要禁止程序化滚动就用 `overflow-x: clip`。
 *
 * ⚠️ 依赖 Chrome（与 p111 / verify-production-entrypoints 同一套口径，可用 CHROME_PATH 覆盖）；
 * ⚠️ vite preview 只绑 ::1，探测与访问都要用 localhost 而不是 127.0.0.1。
 * 跑法：node scripts/p115-website-ui-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const root = process.cwd();
const shotDir = path.join(root, '.tmp', 'website-ui');
fs.rmSync(shotDir, { recursive: true, force: true });
fs.mkdirSync(shotDir, { recursive: true });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'website-ui-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows, atransaction } = await import('../packages/database/src/store.js');

const env = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  FILE_UPLOAD_ROOT: path.join(temp, 'uploads'),
  AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  child.on('close', (code) => (code ? reject(new Error(output)) : resolve(output)));
});

// ── 口径常量 ────────────────────────────────────────────────────────────────
// 退役文案：口径变更之后再出现，就是有人把旧内容写回来了（不是测试漂移）。
const RETIRED_COPY = ['给机构一套', '能落地的青少年 AI 课', '领航行动', '预约演示', 'AI魔法学院', 'AI 魔法学院', '灵动值'];
// 官网主导航七项（apps/website/src/main.jsx 的 WEBSITE_NAV）：文案与顺序都算口径。
// 2026-09-19 晚口径变更（不是测试漂移）：首页 hero 下那行「下载创作客户端」小字入口按用户要求删除，
// 下载入口改到导航最后一项「VibeCoding客户端下载」→ /download。
// 2026-09-19 更晚口径变更（不是测试漂移）：用户口径「灵动介绍页面和灵动介绍的导航全部删除，
// 不需要这个了」——**去掉「灵动介绍」**（页面 / 导航 / 页脚入口 / 路由一起删，见交接文档 §二.N）。
// ⚠️ 2026-09-25 口径变更（不是测试漂移）：「灵动作品」按用户口径改成「课堂作品」——导航与页脚同一处文案。
const NAV_LABELS = ['首页', '灵动学习', '灵动课程', '课堂作品', '机构手册', '常见问题', 'VibeCoding客户端下载'];
// 品牌名只认这一个（用户口径 2026-09-18）。
const BRAND_NAME = '灵动ai学院';

console.log('准备临时库 + 构建官网…');
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
// seed 会把 websiteContentDefaults 写进 website_contents 并**直接发布** ——
// 所以新库的「CMS 当前内容」就是那份种子。守卫要在这上面验（这也正是新环境会看到的）。
await run(['node_modules/vite/bin/vite.js', 'build', 'apps/website', '--config', 'apps/website/vite.config.mjs']);

// 从库里读出「CMS 当前内容」，用来验「接口回来前不渲染」不是空转（得先知道应该出现什么）


const homeRow = await arow("SELECT published_content FROM website_contents WHERE content_key='HOME'");
assert.ok(homeRow, 'fixture: seed 之后 HOME 应该已在 website_contents 里');
// 词条：一条**导入件**（形状与服务端 scripts/import-plaza-works.mjs 写进 works.canvas_snapshot 的一致）。
// 为什么守卫要自己造：种子里只有画布作品，而「导入件怎么显示、点开是什么样」是本轮新加的展示路径 ——
// 不造一条，这条路径在守卫里永远验不到（线上有 476 件，但守卫跑的是临时库）。
{
  const nowIso = new Date().toISOString();
  const owner = await arow("SELECT id, org_id FROM users WHERE login='student-1'");
  assert.ok(owner, 'fixture: 需要 student-1 来挂导入件');
  // 封面用 1×1 的 data URI：守卫不该依赖外网图床
  const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
  await aq("INSERT OR IGNORE INTO student_projects (id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES ('project_guard_import',?,?,'导入件样例','SUBMITTED','{\"nodes\":[],\"edges\":[],\"viewport\":{\"x\":0,\"y\":0,\"zoom\":1}}',1,?,?,?)", [owner.id, owner.org_id, nowIso, nowIso, nowIso]);
  const snapshot = JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    imported: { source: 'ltai', sourceId: 1, workType: 'image', workTypeLabel: '图片', coverUrl: pixel,
      contentUrls: [pixel], externalUrl: null, authorName: '样例作者', createdAt: '2026-09-01 10:00:00' } });
  await aq("INSERT OR IGNORE INTO works (id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at) VALUES ('work_guard_import','project_guard_import',?,?,'导入件样例','',?,'PUBLISHED',?,1,'guardimport1',?)", [owner.id, owner.org_id, snapshot, nowIso, nowIso]);
  // 另加一条**我们自己的公开画布作品**：广场要同时显示两类，且筛选（类型胶囊）得有两种类型才测得出来
  await aq("INSERT OR IGNORE INTO student_projects (id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES ('project_guard_canvas',?,?,'站内画布样例','SUBMITTED','{\"nodes\":[],\"edges\":[],\"viewport\":{\"x\":0,\"y\":0,\"zoom\":1}}',1,?,?,?)", [owner.id, owner.org_id, nowIso, nowIso, nowIso]);
  await aq("INSERT OR IGNORE INTO works (id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at) VALUES ('work_guard_canvas','project_guard_canvas',?,?,'站内画布样例','','{\"nodes\":[],\"edges\":[],\"viewport\":{\"x\":0,\"y\":0,\"zoom\":1}}','PUBLISHED',?,1,'guardcanvas1',?)", [owner.id, owner.org_id, nowIso, nowIso]);
  // ⭐ 2026-09-27（用户报的图1：「网页端学生看『我的作品』画布，没法看」）：
  //    专门造一条**「横向铺开 + 存着桌面视角」**的画布作品 —— 只读查看必须**按容器适配**，
  //    照搬快照里那个视角在手机上就是"从桌面坐标的窗口往里看"（一大块深色、内容只在边上露一条）。
  //    ⚠️ 上面那些夹具的 viewport 都是 {0,0,1} 且节点为空 —— **照搬视角也看不出毛病**，
  //       所以这条不是可有可无：横向铺到 x≈1250、viewport 记成桌面形状（x:-120,y:-80,zoom:0.72），
  //       390px 下若不按容器适配，节点必然大片跑出容器。
  //    ⚠️ 它**不公开**（is_public=0）：一是别去动「作品广场每页 12 件」那条翻页断言，
  //       二是正好用它验「未公开作品的分享按钮要先弹确认，不许偷偷替学生公开」。
  const wideSnapshot = JSON.stringify({
    nodes: [0, 1, 2].map((index) => ({
      id: `node_guard_wide_${index}`,
      type: 'prompt',
      position: { x: 120 + index * 560, y: 140 + index * 80 },
      data: { title: `宽画布样例 ${index + 1}`, slotType: 'text', generatedText: `第 ${index + 1} 段文字产出` },
    })),
    edges: [],
    viewport: { x: -120, y: -80, zoom: 0.72 },
  });
  await aq("INSERT OR IGNORE INTO student_projects (id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES ('project_guard_wide',?,?,'宽画布样例','SUBMITTED',?,1,?,?,?)", [owner.id, owner.org_id, wideSnapshot, nowIso, nowIso, nowIso]);
  await aq("INSERT OR IGNORE INTO works (id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at) VALUES ('work_guard_wide','project_guard_wide',?,?,'宽画布样例','',?,'PUBLISHED',?,0,NULL,?)", [owner.id, owner.org_id, wideSnapshot, nowIso, nowIso]);
  // 再补 13 件（凑到 15 件 = 12 + 3）——**翻页这条必须超过 12 件才测得出来**。
  // 其中第 13 件是网页类型（按映射表算 VibeCoding 分类），让两个分类都有内容可测。
  for (let index = 1; index <= 13; index += 1) {
    const type = index === 13 ? 'webpage' : 'image';
    const projectId = `project_guard_more_${index}`;
    const workId = `work_guard_more_${index}`;
    const orgName = index % 3 === 0 ? '云雀AI创意学院' : '星芽少儿编程';
    await aq("INSERT OR IGNORE INTO student_projects (id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES (?,?,?,?, 'SUBMITTED','{\"nodes\":[],\"edges\":[],\"viewport\":{\"x\":0,\"y\":0,\"zoom\":1}}',1,?,?,?)", [projectId, owner.id, owner.org_id, `样例作品 ${index}`, nowIso, nowIso, nowIso]);
    const snap = JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
      imported: { source: 'ltai', sourceId: 100 + index, workType: type, workTypeLabel: type === 'webpage' ? '网页' : '图片',
        coverUrl: pixel, contentUrls: type === 'webpage' ? [] : [pixel], externalUrl: type === 'webpage' ? 'https://example.com/demo' : null,
        authorName: '样例作者', orgName, createdAt: '2026-09-02 10:00:00' } });
    await aq("INSERT OR IGNORE INTO works (id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at) VALUES (?,?,?,?,?,'',?,'PUBLISHED',?,1,?,?)", [workId, projectId, owner.id, owner.org_id, `样例作品 ${index}`, snap, nowIso, `guardmore${index}`, nowIso]);
  }
}
// ── 学生「我的作品」的 VibeCoding 网页作品夹具（2026-09-20）────────────────────
// 为什么必须造：种子里学生的作品**全是画布**，于是"VibeCoding · 网页应用"那条卡片分支、
// 以及"学生自己的网页作品点开能不能玩"这条路径，守卫里都没被走到过。
//
// ⚠️ 2026-09-27 把页面从 **700px 加高到 1400px**（用户报的图：一个 12 页的 PPT 式网页，
// 点「下一页 2/12」右侧就冒出一根滚动条）。700px 比逻辑视口下界 768 **矮**，
// 所以"内层滚动条"这条路根本走不到 —— 加高之后才测得到下面那条 `layoutH >= 内容高度` 的断言。
{
  const nowIso = new Date().toISOString();
  const owner = await arow("SELECT id, org_id FROM users WHERE login='student-1'");
  assert.ok(owner, 'fixture: 需要 student-1 来挂 VibeCoding 作品');
  const entry = '打地鼠.html';
  const page = [
    '<!doctype html><html><head><meta charset="utf-8"><title>守卫用高页面</title></head>',
    '<body style="margin:0"><div style="height:1400px;background:linear-gradient(#34b981,#0f6b4a);color:#fff;font:700 28px sans-serif;padding:24px">守卫用高页面：1400px（比逻辑视口 768 高 → 整幅得缩放进舞台，内层不许出现滚动条）</div></body></html>',
  ].join('');
  // ⚠️ 这两条**不用** `INSERT OR IGNORE`：第一版把 conversations.status 写成 'ACTIVE'（有 CHECK 只允许
  //    DRAFT/SUBMITTED/ARCHIVED），OR IGNORE 把这一行**静默吞了**，直到下面的外键才报错 ——
  //    临时库每次都是新的，不需要幂等，让它错就当场炸。
  await aq("INSERT INTO vibecoding_conversations(id,org_id,student_id,title,model,files,entry_file,status,created_at,updated_at) VALUES ('conversation_guard_web',?,?,'守卫用网页作品','local-mock','{}',?,'DRAFT',?,?)", [owner.org_id, owner.id, entry, nowIso, nowIso]);
  await aq("INSERT INTO vibecoding_submissions(id,conversation_id,student_id,org_id,title,files,round,status,submitted_at,created_at,updated_at,entry_file,artifacts,is_public) VALUES ('vibesub_guard_web','conversation_guard_web',?,?,'守卫用网页作品',?,1,'PENDING',?,?,?,?,?,0)", [owner.id, owner.org_id, JSON.stringify({ [entry]: page }), nowIso, nowIso, nowIso, entry, JSON.stringify([{ name: entry, kind: 'html', bytes: page.length }])]);
  console.log('VibeCoding 网页作品夹具：student-1 一件（页面 1400px 高 —— 故意比逻辑视口 768 高，入口 打地鼠.html）');
}

const cmsHome = JSON.parse(homeRow.published_content);
console.log(`CMS 当前 HOME：title=「${cmsHome.heroTitle}」 accent=「${cmsHome.heroAccent}」 stats=${(cmsHome.stats || []).map((s) => s.value + (s.suffix || '')).join(' / ')}`);

const apiPort = 18799;
const webPort = 6176;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(apiPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
let web = null;
const problems = [];

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  // 公开接口确实在服务「CMS 当前内容」——先证一次，否则后面「接口正常」那一遍可能是假的
  // 公开接口用 {success, data} 包装体（官网侧由 createApiClient 解包；这里是裸 fetch，得自己解）
  const homeApi = await fetch(`http://127.0.0.1:${apiPort}/api/public/website-content/HOME`).then((r) => r.json()).catch(() => null);
  assert.ok(homeApi?.data?.content?.heroTitle !== undefined, `公开接口没返回 HOME 内容：${JSON.stringify(homeApi).slice(0, 300)}`);

  web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', 'apps/website', '--config', 'apps/website/vite.config.mjs'], {
    cwd: root, env: { ...env, VITE_DEV_API_TARGET: `http://127.0.0.1:${apiPort}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let webLog = '';
  web.stdout.on('data', (c) => { webLog += c; });
  web.stderr.on('data', (c) => { webLog += c; });
  // ⚠️ vite preview 只绑 ::1（localhost）；用 127.0.0.1 会 ERR_CONNECTION_REFUSED
  const base = `http://localhost:${webPort}`;
  let webUp = false;
  for (let i = 0; i < 120; i += 1) { try { if ((await fetch(`${base}/`)).ok) { webUp = true; break; } } catch {} await new Promise((r) => setTimeout(r, 250)); }
  if (!webUp) throw new Error(`vite preview 没起来（${base}）：\n${webLog.slice(-1500)}`);

  // ⚠️ 这几个 "--disable-…-throttling / backgrounding" 不是可有可无的润色：无焦点或被遮挡的窗口里
  //    Chromium 会**节流 rAF**，而首页数据区那些数字是**从 0 滚上去**的（StatValue，900ms）——
  //    被节流后，下面就算守住 1.3 秒也照样只滚到一半，于是报成
  //    「口径①：首页数据区数字不一致」，把人带去查一个**根本不存在的回归**。
  //    2026-09-19 实测踩到过一次：读到 [2 门, 27 节, 1 类, 1 套]（全是目标值 [3,48,2,1] 的中途值），
  //    而同一份代码紧接着连跑两次都是绿的 —— 就是这条。
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
  const pageErrors = [];
  const badRequests = [];
  let ignoreNetworkFailures = false; // 故意 abort 的那一遍不算问题
  const newPage = async (options = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, ...options });
    const pg = await context.newPage();
    pg.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 300)));
    pg.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (/Failed to load resource/.test(message.text())) return;
      pageErrors.push(`console: ${message.text().slice(0, 200)}`);
    });
    pg.on('response', (response) => { if (response.status() >= 400 && !ignoreNetworkFailures) badRequests.push(`${response.status()} ${response.url()}`); });
    return { context, pg };
  };
  const { context, pg: page } = await newPage();

  const settle = async () => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(400); };
  // 写临时库的小工具。口径与 packages/database/src/schema.js 一致：写事务必须**串行**，
  // 否则「延迟事务升级」会死锁（第十六轮挖出来的真根因）。这里直接用数据层的 atransaction ——
  // 它按驱动选实现（SQLite 用 BEGIN IMMEDIATE、MySQL 用连接级事务），别在夹具里手写 BEGIN IMMEDIATE
  // （那一条在 MySQL 上是语法错：ER_PARSE_ERROR near 'IMMEDIATE'）。
  const withDb = async (fn) => await atransaction(fn);
  const bodyText = () => page.locator('body').innerText();
  const expectText = async (label, texts) => { const body = await bodyText(); for (const t of texts) if (!body.includes(t)) problems.push(`${label}：页面上找不到「${t}」`); };
  const expectNoRetired = async (label) => { const body = await bodyText(); for (const t of RETIRED_COPY) if (body.includes(t)) problems.push(`${label}：页面上出现了退役文案「${t}」——口径变更后不该再出现`); };
  const shot = async (name) => { await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); };

  // ── ① 横向程序化滚动：不查 CSS 写了什么，而是**真把每个可聚焦元素 focus 一遍**再看谁被滚走了。
  //    这才是用户看到的现象（点一下按钮整页横着挪一段）。同时查容器有没有横向溢出 ——
  //    溢出是「因」：装饰伸到盒子边缘，即使 clip 掉了症状也还在（该改的是装饰本身）。
  const sweepHorizontalScroll = async (label, containers) => {
    const entered = await page.evaluate(() => window.scrollX);
    await page.evaluate(() => {
      const selector = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
      for (const el of document.querySelectorAll(selector)) { try { el.focus(); } catch { /* 不可聚焦就跳过 */ } }
    });
    await page.waitForTimeout(250);
    const state = await page.evaluate((list) => {
      const offenders = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.scrollLeft > 1) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.')} 被滚 ${Math.round(el.scrollLeft)}px`);
      }
      const doc = document.documentElement;
      const overflowing = list.map((sel) => {
        const el = document.querySelector(sel);
        return el ? { sel, over: el.scrollWidth - el.clientWidth } : null;
      }).filter(Boolean);
      return { scrollX: window.scrollX, offenders: [...new Set(offenders)].slice(0, 5), docOverflow: doc.scrollWidth - doc.clientWidth, overflowing };
    }, containers);
    if (entered > 1) problems.push(`${label}：一进来窗口就被横向滚了 ${Math.round(entered)}px`);
    if (state.scrollX > 1) problems.push(`${label}：focus 一遍之后窗口横向滚了 ${Math.round(state.scrollX)}px（口径：要禁止就得 overflow-x: clip）`);
    if (state.offenders.length) problems.push(`${label}：focus 之后有容器被程序化横向滚动 → ${state.offenders.join(' / ')}`);
    if (state.docOverflow > 1) problems.push(`${label}：文档横向溢出 ${state.docOverflow}px`);
    for (const item of state.overflowing) {
      if (item.over > 1) problems.push(`${label}：${item.sel} 横向溢出 ${item.over}px —— 装饰/内容伸到了盒子边缘（会被裁出硬边，或让容器可被程序化滚动）`);
    }
    console.log(`  · ${label} 横向：scrollX=${Math.round(state.scrollX)} 文档溢出=${state.docOverflow}px 被滚容器=${state.offenders.length} 容器溢出=${state.overflowing.map((o) => o.sel + ':' + o.over).join(',') || '无'}`);
  };

  // ── 首页 ──────────────────────────────────────────────────────────────────
  // 先记下 CMS 文案接口的响应，好让「接口回来前不渲染」那一段能**定向**延迟它
  const CMS_HOME_URL = '**/api/public/website-content/HOME';

  const captureCopy = (target = page) => target.evaluate(() => {
    const text = (sel) => { const el = document.querySelector(sel); return el ? el.innerText.replace(/\s+/g, ' ').trim() : null; };
    return {
      title: text('.hp-title span'),
      accent: text('.hp-title em'),
      sub: text('.hp-sub'),
      trust: text('.hp-trust'),
      stats: [...document.querySelectorAll('.hp-stat strong')].map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
    };
  });
  const waitForCopy = async (target = page, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await captureCopy(target);
      if (last.title || last.accent) return last;
      await target.waitForTimeout(250);
    }
    return last;
  };
  // 数据区的数字是**从 0 滚上去**的（StatValue，900ms）。取值前必须等它滚完 ——
  // 否则接口正常那一遍读到的是中间值，会被误判成「两套数字不一致」。
  const captureSettledCopy = async (target = page) => { await waitForCopy(target); await target.waitForTimeout(1300); return captureCopy(target); };
  // 场景②专用：等 **CMS 响应真的到达** 之后再量。否则一旦有人把渲染前的 ready 门去掉
  // （正是场景②要抓的那个回归），这里量到的会是「兜底数字滚到一半」的中间值 ——
  // 断言会红，但报出来的原因会指到「两套数字不一致」上去，把人带偏。
  const captureAfterCmsResponse = async (target = page) => {
    await target.waitForResponse((response) => response.url().includes('/api/public/website-content/HOME')).catch(() => {});
    await target.waitForTimeout(1400);
    return captureCopy(target);
  };
  const compareCopy = (labelA, a, labelB, b) => {
    for (const field of ['title', 'accent', 'sub', 'trust']) {
      if ((a[field] || '') !== (b[field] || '')) problems.push(`口径①：${field} 在两处来源不一致 —— ${labelA}=「${a[field]}」 而 ${labelB}=「${b[field]}」（代码兜底必须与 CMS 当前内容一致）`);
    }
    if (a.stats.join('|') !== b.stats.join('|')) problems.push(`口径①：首页数据区数字不一致 —— ${labelA}=[${a.stats.join(', ')}] 而 ${labelB}=[${b.stats.join(', ')}]（同一页面不该因接口通/断显示两套数字）`);
  };

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  const homeNormal = await captureSettledCopy();
  await settle();
  console.log(`  首页（接口正常）：title=「${homeNormal.title}」accent=「${homeNormal.accent}」stats=[${homeNormal.stats.join(', ')}]`);

  await expectText('首页', [homeNormal.title]);
  // ⚠️ 首页**没有** footer（footer 只在非首页出现），所以品牌名在这页只出现在 <title> 与 logo 的 alt 上，
  //    别指望 body.innerText 里能搜到它。
  const homeDocTitle = await page.title();
  if (!homeDocTitle.includes(BRAND_NAME)) problems.push(`首页：浏览器标题里没有品牌名「${BRAND_NAME}」（实际「${homeDocTitle}」）`);
  await expectNoRetired('首页');
  if (!homeNormal.title || !homeNormal.accent) problems.push('首页：CMS 的标题 / 副标题没有渲染出来');
  if (homeNormal.stats.length !== 4) problems.push(`首页：数据区应当是 4 项（实际 ${homeNormal.stats.length} 项）`);
  for (const s of homeNormal.stats) if (!/^\d+\s*\S*$/.test(s)) problems.push(`首页：数据区数字格式异常「${s}」`);

  // 导航八项：文案与顺序
  const navLabels = (await page.locator('.site-topbar nav a').allInnerTexts()).map((t) => t.trim());
  if (navLabels.join('|') !== NAV_LABELS.join('|')) {
    problems.push(`首页：主导航与 WEBSITE_NAV 不一致 —— 实际 [${navLabels.join(', ')}]，应为 [${NAV_LABELS.join(', ')}]`);
  }
  // 品牌 logo：alt 必须是唯一品牌名（品牌名只认这一个常量）
  const logoAlts = await page.locator('img.brand-logo').evaluateAll((els) => els.map((el) => el.getAttribute('alt')));
  if (!logoAlts.length) problems.push('首页：没找到品牌 logo（img.brand-logo）');
  for (const alt of logoAlts) if (alt !== BRAND_NAME) problems.push(`首页：logo 的 alt 是「${alt}」，应为「${BRAND_NAME}」`);

  // 导航「页面居中」+ 右侧按钮组贴右（这两条都是这一轮修过的观感问题）
  const barGeo = await page.evaluate(() => {
    const rect = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
    const bar = document.querySelector('.site-topbar .bar');
    return { bar: rect('.site-topbar .bar'), nav: rect('.site-topbar nav'), actions: rect('.site-topbar .head-actions'), padRight: bar ? parseFloat(getComputedStyle(bar).paddingRight) : null };
  });
  if (!barGeo.bar || !barGeo.nav) problems.push('首页：顶栏 / 导航取不到几何');
  else {
    const navDelta = Math.abs((barGeo.nav.left + barGeo.nav.right) / 2 - (barGeo.bar.left + barGeo.bar.right) / 2);
    if (navDelta > 2) problems.push(`首页：导航不是在页面里居中（偏离顶栏中心 ${navDelta.toFixed(1)}px）`);
    if (barGeo.actions) {
      const expectedRight = barGeo.bar.right - barGeo.padRight;
      const actionsDelta = Math.abs(barGeo.actions.right - expectedRight);
      if (actionsDelta > 4) problems.push(`首页：右侧按钮组没有贴住顶栏右边缘（差 ${actionsDelta.toFixed(1)}px，可能是导航不占 flex 空间后又跟到 logo 后面去了）`);
    }
    console.log(`  · 顶栏几何：导航偏离中心 ${navDelta.toFixed(1)}px`);
  }

  // 首页大标题（口径不变）：**每行只占一行、不许被裁**。
  // ⚠️ 2026-09-18 晚这里换过一次 MaskedHeading（字形遮罩），用户看过实际页面后要求撤回
  // （「文字效果不好，而且看不清了」—— 那效果的原理就是「字=媒体」，视频又暗又花，必然不好读）。
  // 所以断言又回到实心字这一套：两行 span/em、字号按字数算、每行一行、不横向溢出。
  const titleGeo = await page.evaluate(() => {
    const el = document.querySelector('.hp-title');
    if (!el) return null;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    const blocks = [...el.querySelectorAll('span, em')];
    return {
      fontSize: Math.round(parseFloat(getComputedStyle(el).fontSize)),
      lines: blocks.map((b) => Math.round(b.getBoundingClientRect().height / lineHeight)),
      over: el.scrollWidth - el.clientWidth,
    };
  });
  if (!titleGeo) problems.push('首页：没找到 .hp-title');
  else {
    console.log(`  · 首页标题：字号 ${titleGeo.fontSize}px、各行行数 [${titleGeo.lines.join(', ')}]`);
    if (titleGeo.lines.some((n) => n !== 1)) problems.push(`首页：大标题折行了（各行行数 ${titleGeo.lines.join(', ')}）—— 字号自适应没算出「一行放得下」的大小`);
    if (titleGeo.over > 1) problems.push(`首页：大标题横向溢出 ${titleGeo.over}px（会被 overflow:hidden 裁掉）`);
  }

  await sweepHorizontalScroll('首页', ['.site', '.hp']);
  // 口径④的验证手法（交接文档写的）：把视频临时藏掉，整页应当是**纯黑、零边界**
  await page.evaluate(() => { const v = document.querySelector('.hp-video'); if (v) v.style.display = 'none'; const s = document.querySelector('.hp-scrim'); if (s) s.style.display = 'none'; });
  await page.waitForTimeout(200);
  await shot('01-home-no-video');
  await page.evaluate(() => { const v = document.querySelector('.hp-video'); if (v) v.style.display = ''; const s = document.querySelector('.hp-scrim'); if (s) s.style.display = ''; });
  await shot('02-home');

  // WebGL 按钮：黑底首页的 CTA 是 specular 组件（每个按钮一个 canvas）
  const homeCanvases = await page.locator('.hp-actions canvas').count();
  if (homeCanvases < 2) problems.push(`首页：两个 hero CTA 应当各有一个 specular 的 WebGL canvas（实际 ${homeCanvases} 个）`);
  // ⚠️ 判据是"**自托管**在 /assets/ 下"，不是某个固定文件名 —— 换素材时会改名（2026-09-26 换成
  //    hero-rabbit.mp4，因为 /assets/ 加了 7 天长缓存：改名才会立刻生效）。钉死文件名会把换素材搞红。
  const homeVideoSrc = await page.locator('.hp-video').getAttribute('src');
  if (!/^\/assets\/[\w.-]+\.mp4$/.test(String(homeVideoSrc || ''))) {
    problems.push(`首页：背景视频不是自托管的 /assets/*.mp4（实际 ${homeVideoSrc}）`);
  }
  // 流畅度（2026-09-26 用户口径「保证官网的流畅度」）：首屏那支视频**不许胖**。
  // 这台机公网出口只有 5 Mbps，视频每多 1MB，首屏就多等约 1.6 秒 —— 所以把体积上限钉在守卫里。
  {
    const fsmod = await import('node:fs');
    const pathmod = await import('node:path');
    const rel = String(homeVideoSrc || '').replace(/^\//, '');
    const videoFile = pathmod.join(root, 'apps/website/public', rel);
    if (!fsmod.existsSync(videoFile)) {
      problems.push(`首页：找不到背景视频文件 ${rel}（源码里写着它，文件却不在 public/assets 下）`);
    } else {
      const bytes = fsmod.statSync(videoFile).size;
      if (bytes > 1.2 * 1024 * 1024) problems.push(`首页：背景视频 ${(bytes / 1048576).toFixed(2)}MB 超上限（1.2MB）—— 首屏会明显变慢`);
      const poster = pathmod.join(root, 'apps/website/public', rel.replace(/\.mp4$/, '-poster.webp'));
      if (!fsmod.existsSync(poster)) problems.push('首页：背景视频没有配套海报（poster），首帧会白一下');
      else if (fsmod.statSync(poster).size > 160 * 1024) problems.push(`首页：海报 ${(fsmod.statSync(poster).size / 1024).toFixed(0)}KB 超上限（160KB）`);
    }
  }

  await page.route(CMS_HOME_URL, async (route) => { await new Promise((r) => setTimeout(r, 1800)); await route.continue(); });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const early = await captureCopy();
  const earlyShell = await page.evaluate(() => ({ video: document.querySelectorAll('.hp-video').length, actions: document.querySelectorAll('.hp-actions button').length, skeleton: document.querySelectorAll('.boot-shell').length }));
  // ⚠️ 先证明页面**真的挂载了**，否则「找不到文案」是空转（可能整个 React 都没起来）
  if (earlyShell.video !== 1 || earlyShell.actions < 2) problems.push(`首页（接口延迟）：骨架/首帧不对 —— 视频 ${earlyShell.video} 个、按钮 ${earlyShell.actions} 个（口径②：视频与按钮要照常立刻在，不能白屏）`);
  if (earlyShell.skeleton > 0) problems.push(`首页（接口延迟）：index.html 的骨架屏应当已被 React 替换掉（还剩 ${earlyShell.skeleton} 个 .boot-shell）`);
  if (early.title || early.accent || early.sub || early.stats.length) {
    problems.push(`口径②：CMS 接口还没回来就渲染了文案（title=「${early.title}」accent=「${early.accent}」stats=${early.stats.length} 项）—— 强刷时会先闪一帧可能与后台不符的内容`);
  }
  const homeDelayed = await captureAfterCmsResponse();
  await settle();
  compareCopy('接口正常', homeNormal, '接口延迟后到达', homeDelayed);
  await expectNoRetired('首页（延迟后）');
  await shot('03-home-delayed-arrived');
  await page.unroute(CMS_HOME_URL);

  // ── ③ 接口失败：兜底必须与 CMS 当前内容**逐字一致**（口径①的核心）
  ignoreNetworkFailures = true;
  await page.route(CMS_HOME_URL, (route) => route.abort());
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  const homeFallback = await captureSettledCopy();
  await settle();
  console.log(`  首页（接口失败）：title=「${homeFallback.title}」accent=「${homeFallback.accent}」stats=[${homeFallback.stats.join(', ')}]`);
  compareCopy('接口正常', homeNormal, '接口失败兜底', homeFallback);
  await expectNoRetired('首页（接口失败兜底）');
  await shot('04-home-cms-down-fallback');
  await page.unroute(CMS_HOME_URL);
  ignoreNetworkFailures = false;

  // ── 登录页 ────────────────────────────────────────────────────────────────
  // 用户 2026-09-18 晚报的：**未登录点「灵动学习」跳的是机构/老师登录**。
  // 那些 /learn*、/my-* 都是学生的页面，未登录必须带去**学生登录**（?as=student）。
  await page.goto(`${base}/learn`, { waitUntil: 'domcontentloaded' });
  await settle();
  const learnRedirect = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
  console.log(`  · 未登录访问 /learn → ${learnRedirect}`);
  if (learnRedirect !== '/login?as=student') problems.push(`未登录访问学生页面应当带去学生登录（/login?as=student），实际 ${learnRedirect}`);
  await expectText('学生登录页', ['学生登录']);

  // ── 「联系我们」（/demo）改成联系方式展示（2026-09-27 用户口径：
  //    「联系我们的页面重做，直接显示姓名电话微信二维码。后台可配置」）────────────
  await page.goto(`${base}/demo`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('联系我们页', ['联系我们 · 开通试用', '把 AI 课开起来', '商务联系', '联系人', '电话', '微信扫码加好友']);
  {
    const state = await page.evaluate(() => ({
      card: document.querySelectorAll('.contact-card').length,
      qr: document.querySelectorAll('.contact-qr').length,
      forms: document.querySelectorAll('form').length,
      tel: Array.from(document.querySelectorAll('.contact-card a[href^="tel:"]')).length,
      placeholder: (document.querySelector('.contact-qr')?.innerText || '').includes('待上传'),
    }));
    console.log(`  · 联系我们页：联系卡 ${state.card} 张、二维码区 ${state.qr} 个、表单 ${state.forms} 个、tel 链接 ${state.tel} 个`);
    if (!state.card || !state.qr) problems.push('联系我们页：联系信息卡没渲染出来（.contact-card / .contact-qr）');
    if (state.forms) problems.push(`联系我们页：还留着 ${state.forms} 个表单 —— 用户口径是**直接显示**姓名/电话/二维码，不再让访客填表`);
  }
  await shot('21-contact-us');

  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('登录页', ['机构 / 老师登录', '账号', '密码']);
  await expectNoRetired('登录页');
  const loginDocTitle = await page.title();
  if (!loginDocTitle.includes(BRAND_NAME)) problems.push(`登录页：浏览器标题里没有品牌名「${BRAND_NAME}」（实际「${loginDocTitle}」）`);
  // 我们没有「忘记密码」功能；也没有真实的「记住我」——放了比不放更糟（交接文档口径）
  const loginBody = await bodyText();
  for (const forbidden of ['忘记密码', '记住我']) {
    if (loginBody.includes(forbidden)) problems.push(`登录页：不该出现「${forbidden}」（这个功能不存在，放了就是骗用户）`);
  }
  // 官网登录页不挂演示账号（登录面板的 demos 传的是空数组）
  const demoList = await page.locator('.demo-list').count();
  if (demoList) problems.push('登录页：出现了「演示账号」区块 —— 官网登录页不应带演示账号（生产那两个按钮点了必定 401，口令还明文在可下载的 JS 里）');
  // 字段图标 + 密码显隐
  const fieldIcons = await page.locator('.login-field svg').count();
  if (fieldIcons < 2) problems.push(`登录页：输入框字段图标应当有 2 个以上（实际 ${fieldIcons} 个）`);
  const pwdInput = page.locator('.login-field input').nth(1);
  await page.locator('.login-eye').click();
  await page.waitForTimeout(200);
  const shownType = await pwdInput.getAttribute('type');
  await page.locator('.login-eye').click();
  await page.waitForTimeout(200);
  const hiddenType = await pwdInput.getAttribute('type');
  if (shownType !== 'text' || hiddenType !== 'password') problems.push(`登录页：密码显隐没生效（点开后 type=${shownType}，再点回 type=${hiddenType}）`);
  // 背景视频必须是**首页同一份资产**（用户口径：登录页背景按首页做）
  const loginVideoSrc = await page.locator('.login-bg video').getAttribute('src');
  if (loginVideoSrc !== homeVideoSrc) problems.push(`登录页：背景视频与首页不是同一份资产（登录页 ${loginVideoSrc} / 首页 ${homeVideoSrc}）`);
  // 登录卡必须**在暗底上**：玻璃卡靠 backdrop-filter，浅底会让它糊成一片
  const cardBg = await page.evaluate(() => { const el = document.querySelector('.login-card'); return el ? getComputedStyle(el).backgroundColor : null; });
  if (!cardBg) problems.push('登录页：没找到登录卡 .login-card');

  // 品牌主张「恒定两行」——这是这一轮的真 bug（当时折成了三行）。
  // 五档宽度都验：每个 .login-headline 必须是 1 行（height / line-height），且**不横向溢出**
  // （现在是 nowrap：一溢出就是被裁字，肉眼不容易发现）。
  const HEADLINE_WIDTHS = [1600, 1440, 1280, 1120, 960, 820, 420];
  const headlineReport = [];
  for (const width of HEADLINE_WIDTHS) {
    await page.setViewportSize({ width, height: 960 });
    await settle();
    const geo = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.login-headline')];
      return nodes.map((el) => ({
        lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
        over: el.scrollWidth - el.clientWidth,
        fontSize: Math.round(parseFloat(getComputedStyle(el).fontSize)),
      }));
    });
    headlineReport.push(`${width}px→[${geo.map((g) => `${g.fontSize}px/${g.lines}行${g.over > 1 ? '溢出' + g.over : ''}`).join(' ')}]`);
    if (geo.length !== 2) problems.push(`登录页 ${width}px：品牌主张应当是 2 段（实际 ${geo.length} 段）`);
    const totalLines = geo.reduce((n, g) => n + g.lines, 0);
    if (totalLines !== 2) problems.push(`登录页 ${width}px：品牌主张应当恒定两行（实际 ${totalLines} 行）—— ⚠️ 别把字号改回 vw：vw 跟盒子宽度无关，盒一变窄就折行`);
    for (const g of geo) if (g.over > 1) problems.push(`登录页 ${width}px：品牌主张横向溢出 ${g.over}px（nowrap 下等于被裁字）`);
  }
  console.log(`  · 品牌主张：${headlineReport.join(' ')}`);
  await page.setViewportSize({ width: 1440, height: 960 });
  await settle();
  await shot('05-login');

  await sweepHorizontalScroll('登录页', ['.website-login', '.login-page', '.login-intro']);
  // 口径④：官网登录页**不显示**那层环境光斑。它是网格一栏 .login-intro 的 ::before，
  // 原来 inset:-25% 且两个圆斑半径之和超出盒子 → 光斑到边界还没衰减到 0，
  // 被 overflow:hidden 裁出一条直线（用户报的「有明显的边框痕迹」）。官网这侧直接不显示它。
  // 这里查的是**真的没显示**（computed style），不是「CSS 文件里写了 display:none」。
  const introGlow = await page.evaluate(() => {
    const el = document.querySelector('.login-intro');
    if (!el) return null;
    return { display: getComputedStyle(el, '::before').display };
  });
  if (!introGlow) problems.push('登录页：没找到左侧品牌栏 .login-intro');
  else if (introGlow.display !== 'none') problems.push(`登录页：左侧品牌栏的环境光斑应当不显示（::before 的 display 现在是 ${introGlow.display}）—— 它会沿网格栏边界露出硬边`);
  // 口径④的验证手法（交接文档写的）：把背景视频藏掉，整页应当是**纯黑、零边界**。
  // 这里只留截图给人眼复核 —— 仓库里没有 PNG 解码库，守卫不做像素采样；
  // 「装饰伸到盒子边缘」这个**因**已经由上面的容器溢出断言拦住了。
  await page.evaluate(() => { const v = document.querySelector('.login-bg'); if (v) v.style.display = 'none'; });
  await page.waitForTimeout(250);
  await shot('06-login-no-bg');
  await page.evaluate(() => { const v = document.querySelector('.login-bg'); if (v) v.style.display = ''; });

  // ── ⑤ 内页顶栏 + 灵动课程（课包列表，2026-09-18 晚按用户给的参考设计重做）──────────────
  // ① 顶栏右上角那个「联系我们」已删除（用户口径）：导航是 `position:absolute; left:50%` **页面居中**的，
  //    视口一窄它就和右侧按钮组叠在一起 —— 用户在内页截到的「联系我们被遮挡」就是这一处。
  //    这条断言钉住「不再叠压」，并保证两个登录入口没被误删。
  for (const width of [1440, 1280, 1240]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/marketplace`, { waitUntil: 'domcontentloaded' });
    await settle();
    const bar = await page.evaluate(() => {
      const rect = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
      return { nav: rect('.site-topbar nav'), actions: rect('.site-topbar .head-actions'), text: document.querySelector('.site-topbar')?.innerText || '' };
    });
    if (bar.text.includes('联系我们')) problems.push(`顶栏 ${width}px：右上角的「联系我们」应当已删除（它会被居中的导航压住）`);
    if (!bar.text.includes('机构 / 老师登录') || !bar.text.includes('学生登录')) problems.push(`顶栏 ${width}px：两个登录入口应当还在（实际「${bar.text.replace(/\n/g, ' ')}」）`);
    if (bar.nav && bar.actions && bar.nav.right > bar.actions.left + 2) {
      problems.push(`顶栏 ${width}px：导航与右侧按钮组叠在一起（导航右边缘 ${Math.round(bar.nav.right)} > 按钮组左边缘 ${Math.round(bar.actions.left)}）`);
    }
  }

  // ② 灵动课程页头走 CMS 的 MARKETPLACE 键。先把它改成一句**只可能来自 CMS** 的文案：
  //    只有这样才能证明 CMS 通路真的活着 —— 键写错 / 白名单漏了 / 新库没补种，接口都会 404，
  //    然后静默走兜底；而兜底文案与种子文案一模一样，肉眼根本看不出来。
  const mpSeed = await arow("SELECT published_content FROM website_contents WHERE content_key='MARKETPLACE'");
  assert.ok(mpSeed, 'fixture: seed 之后 MARKETPLACE 应该已在库里（新增 CMS 键要同时改白名单 / 标签 / 种子 / 表单四处）');
  const cmsPatch = JSON.stringify({ title: '课包展示（CMS 联调）', lead: '副标题来自 CMS 的联调文案。' });
  await withDb(async () => await aq("UPDATE website_contents SET draft_content=?, published_content=?, updated_at=? WHERE content_key='MARKETPLACE'", [cmsPatch, cmsPatch, new Date().toISOString()]));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/marketplace`, { waitUntil: 'domcontentloaded' });
  let rows = 0;
  for (let i = 0; i < 40; i += 1) { rows = await page.locator('.mp-row').count(); if (rows) break; await page.waitForTimeout(250); }
  await settle();
  await expectText('灵动课程', ['课包展示（CMS 联调）', '副标题来自 CMS 的联调文案。']);
  if (!rows) problems.push('灵动课程：一个课包行都没渲染出来（.mp-row 数 0）');
  if (!(await page.title()).includes(BRAND_NAME)) problems.push('灵动课程：浏览器标题里没有品牌名');
  const rowGeo = await page.evaluate(() => {
    const first = document.querySelector('.mp-row');
    if (!first) return null;
    const cover = first.querySelector('.mp-cover');
    const cta = first.querySelector('.mp-cta');
    const features = first.querySelector('.mp-features');
    return {
      coverWidth: cover ? Math.round(cover.getBoundingClientRect().width) : null,
      coverHeight: cover ? Math.round(cover.getBoundingClientRect().height) : null,
      coverHasImage: cover ? cover.classList.contains('has-image') : null,
      featureCount: first.querySelectorAll('.mp-feature').length,
      featureLabels: [...first.querySelectorAll('.mp-feature span')].map((el) => el.textContent),
      ctaText: cta ? cta.textContent.trim() : null,
      ctaHref: cta ? cta.getAttribute('href') : null,
      // ⚠️ 2026-09-20：价格整块已按用户口径删除（「官网灵动课程这里不要显示价格和按课包开通」）——
      //    这里不再量它的位置，而是**断言它不在**（顺带钉住"按课包开通/价格面议"这些字样别再回来）。
      priceBlocks: first.querySelectorAll('.mp-price').length,
      rowText: String(first.innerText || '').replace(/\s+/g, ' '),
      ctaLeft: cta ? Math.round(cta.getBoundingClientRect().left) : null,
      ctaCenterY: cta ? Math.round(cta.getBoundingClientRect().top + cta.getBoundingClientRect().height / 2) : null,
      featuresOpacity: features ? getComputedStyle(features).opacity : null,
    };
  });
  if (!rowGeo) problems.push('灵动课程：取不到课包行的几何与文案');
  else {
    console.log(`  · 灵动课程：缩略图 ${rowGeo.coverWidth}×${rowGeo.coverHeight}px、参数 ${rowGeo.featureCount} 项 [${rowGeo.featureLabels.join(' / ')}]、CTA「${rowGeo.ctaText}」→ ${rowGeo.ctaHref}`);
    // 缩略图：**横向封面比例**（用户口径 2026-09-18 晚「可以再宽一点，左侧还有空位」）
    if (rowGeo.coverWidth == null || rowGeo.coverWidth < 150) problems.push(`灵动课程：缩略图不够宽（${rowGeo.coverWidth}px，应 ≥150px；用户要求拉宽、用上左侧空位）`);
    if (rowGeo.coverWidth && rowGeo.coverHeight && rowGeo.coverWidth <= rowGeo.coverHeight) problems.push(`灵动课程：缩略图应当是横向封面（现在是 ${rowGeo.coverWidth}×${rowGeo.coverHeight}，正方形/竖的）`);
    if (rowGeo.featureCount !== 4) problems.push(`灵动课程：关键参数应当是 4 项（实际 ${rowGeo.featureCount} 项）`);
    // 参数口径（用户口径 2026-09-18 晚：第二格从「适学年龄」换成「版本号」）
    const expectedLabels = ['难度', '版本', '课时', '课堂形式'];
    if (rowGeo.featureLabels.join('|') !== expectedLabels.join('|')) {
      problems.push(`灵动课程：四个参数位应为 [${expectedLabels.join(' / ')}]（实际 [${rowGeo.featureLabels.join(' / ')}]）`);
    }
    if (!String(rowGeo.ctaText).includes('查看课程列表')) problems.push(`灵动课程：按钮文案应为「查看课程列表」（实际「${rowGeo.ctaText}」）`);
    // 按钮里**不要箭头**（用户口径：「我们还有个箭头也要去掉」）
    if (String(rowGeo.ctaText).includes('↗')) problems.push(`灵动课程：按钮里不该有箭头（实际「${rowGeo.ctaText}」）`);
    if (!/^\/marketplace\/.+/.test(String(rowGeo.ctaHref))) problems.push(`灵动课程：按钮应当进到该课包的详细课程列表（实际 href=${rowGeo.ctaHref}）`);
    // ⚠️ 价格整块不该再出现（用户口径 2026-09-20：「不要显示价格和按课包开通，删除即可」）。
    //    原来这两条断言量的是"价格在左、与按钮同一行"—— 价格没了，改成断言它不在。
    if (rowGeo.priceBlocks) problems.push(`灵动课程：课包行里不该再有价格块（${rowGeo.priceBlocks} 个 .mp-price）`);
    if (/按课包开通|价格面议/.test(rowGeo.rowText)) problems.push('灵动课程：课包行里不该再出现「按课包开通 / 价格面议」字样');
    // 参考稿的核心交互：那一排关键参数**默认收起、悬停（或键盘聚焦进入行内）才展开**。
    // ⚠️ 上一版我把它改成常显，用户当场指出「交互跟参考稿完全不一样」—— 所以这条要钉死。
    // 只在真有悬停能力的设备上要求「先收起」；触屏/窄屏收起来等于永久看不到参数，必须是常显。
    const hoverCapable = await page.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches);
    const collapsedOpacity = await page.locator('.mp-row').first().locator('.mp-feature-grid').evaluate((el) => getComputedStyle(el).opacity);
    const collapsedRows = await page.locator('.mp-row').first().locator('.mp-features').evaluate((el) => getComputedStyle(el).gridTemplateRows);
    await page.locator('.mp-row').first().hover();
    await page.waitForTimeout(800);
    const expandedOpacity = await page.locator('.mp-row').first().locator('.mp-feature-grid').evaluate((el) => getComputedStyle(el).opacity);
    await shot('12-marketplace-row-hover');
    console.log(`  · 参数排交互：悬停能力=${hoverCapable} 收起时 grid-rows=${collapsedRows} opacity=${collapsedOpacity} → 悬停后 opacity=${expandedOpacity}`);
    if (hoverCapable) {
      if (Number(collapsedOpacity) >= 1) problems.push(`灵动课程：那一排关键参数在宽屏上应当**默认收起**（实际收起时 opacity=${collapsedOpacity}）—— 参考稿是悬停才展开`);
      if (Number(expandedOpacity) !== 1) problems.push(`灵动课程：悬停之后那一排关键参数没有展开（opacity=${expandedOpacity}）`);
    } else if (Number(expandedOpacity) < 1) {
      problems.push(`灵动课程：没有悬停能力的设备上参数必须常显（opacity=${expandedOpacity}）`);
    }
    // 筛选区**已整体删除**（用户口径 2026-09-18 晚「图1 筛选删除」）：
    // 这一页不该再有筛选开关、筛选块、搜索框 —— 参考稿首屏只有「页头 + 课包行」。
    for (const gone of ['.mp-filter-bar', '.mp-filter-toggle', '.mp .mkt-filters', '.mp .mkt-search', '#marketplace-search']) {
      if (await page.locator(gone).count()) problems.push(`灵动课程：筛选区已按用户口径删除，不该再出现 ${gone}`);
    }
  }
  await shot('09-marketplace');
  await sweepHorizontalScroll('灵动课程', ['.mp']);

  // ③ 价格与封面：公开接口**以前根本不下发 priceFen / coverAssetId**，官网那两个引用一直是死的
  //    （缩略图只剩首字、价格那段 UI 永不出现）。这里真给课包写上价格与封面，再看列表渲染没有 ——
  //    这条断言能直接抓到「接口漏字段」这一类回归。
  const seriesId = await withDb(async () => (await arow("SELECT id FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED' AND visibility='PUBLIC' ORDER BY sort LIMIT 1"))?.id);
  assert.ok(seriesId, 'fixture: 库里应当有一个已发布的平台课包');
  await withDb(async () => await aq('UPDATE course_series SET price_fen=?, cover_image_url=?, updated_at=? WHERE id=?', [19900, '/assets/lingdong-ai-logo.png', new Date().toISOString(), seriesId]));
  await page.goto(`${base}/marketplace`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i += 1) { if (await page.locator('.mp-row').count()) break; await page.waitForTimeout(250); }
  await settle();
  const priced = await page.evaluate(() => {
    const first = document.querySelector('.mp-row');
    if (!first) return null;
    const cover = first.querySelector('.mp-cover');
    return { priceBlocks: first.querySelectorAll('.mp-price').length, text: String(first.innerText || '').replace(/\s+/g, ' '), coverHasImage: cover ? cover.classList.contains('has-image') : false, background: cover ? getComputedStyle(cover).backgroundImage : '' };
  });
  console.log(`  · 灵动课程（写入价格 199 元 / 封面后）：价格块 ${priced?.priceBlocks} 个（应为 0）· 封面=${priced?.coverHasImage}`);
  // ⚠️ 反过来钉（用户口径 2026-09-20）：**即使课包配了价格，卡片也不显示价格**。
  //    这条同时挡住两种回归：谁把价格 UI 加回来、以及"按课包开通/价格面议"那类字样又冒出来。
  if (priced?.priceBlocks) problems.push(`灵动课程：课包配了价格，卡片却把价格块显示出来了（${priced.priceBlocks} 个）—— 口径是不显示价格`);
  if (/按课包开通|价格面议/.test(String(priced?.text || ''))) problems.push('灵动课程：卡片上出现了价格相关字样（按课包开通 / 价格面议）');
  if (!priced?.coverHasImage || !String(priced.background).includes('lingdong-ai-logo.png')) problems.push('灵动课程：给课包写了封面地址，缩略图却没渲染出来 —— 公开接口是不是又漏下发 coverAssetId / coverImageUrl 了');
  await shot('10-marketplace-priced');

  // ── ⑤b2 课包详情页（用户第十一轮口径：删页头 / 删课时编号 / 删「开始学习」那条 / 价格写整数）
  //    ⚠️ 这里在**信息区**里量价格，用的是本脚本上面刚写进库的 price_fen=19900（确定性，不依赖生产数据）。
  const detailHref = await page.locator('.mp-row .mp-cta').first().getAttribute('href').catch(() => null);
  if (!detailHref) problems.push('课包详情：从列表里取不到课包详情链接');
  else {
    await page.goto(`${base}${detailHref}`, { waitUntil: 'domcontentloaded' });
    await settle();
    const detail = await page.evaluate(() => ({
      pageTitle: document.querySelectorAll('.page-title').length,
      infoTitle: document.querySelector('.mkt-detail-title')?.textContent?.trim() || null,
      numbers: document.querySelectorAll('.mkt-lesson-num').length,
      cta: document.querySelectorAll('.mkt-start,.mkt-cta').length,
      priceRow: [...document.querySelectorAll('.mkt-detail-row')].find((row) => row.textContent.includes('参考价格'))?.textContent?.replace(/\s+/g, ' ').trim() || null,
      ageRow: [...document.querySelectorAll('.mkt-detail-row')].find((row) => row.textContent.includes('适学年龄'))?.textContent?.replace(/\s+/g, ' ').trim() || null,
      text: document.body.innerText.replace(/\s+/g, ' '),
    }));
    console.log(`  · 课包详情：页头 ${detail.pageTitle} 个、信息区标题「${detail.infoTitle}」、编号块 ${detail.numbers} 个、开始学习块 ${detail.cta} 个、价格行「${detail.priceRow}」、年龄行「${detail.ageRow}」`);
    if (detail.pageTitle) problems.push('课包详情：页头（课程广场眉题 + 课包标题 + 简介）应当已删除');
    if (!detail.infoTitle) problems.push('课包详情：课包名称应当写在信息区里（.mkt-detail-title）');
    if (detail.numbers) problems.push(`课包详情：课时编号块应当已删除（还有 ${detail.numbers} 个）`);
    if (detail.cta) problems.push('课包详情：「开始学习」那一条应当已删除');
    // ⚠️ 2026-09-20（用户口径）：**参考价格**与**适学年龄**两行都删掉了 —— 断言它们不在。
    //    原来这条断言的是"参考价格要写 ¥199"（夹具写了 price_fen=19900）；价格行整个删了，所以反过来钉。
    if (detail.priceRow) problems.push(`课包详情：「参考价格」那一行应当已删除（实际「${detail.priceRow}」）`);
    if (detail.ageRow) problems.push(`课包详情：「适学年龄」那一行应当已删除（实际「${detail.ageRow}」）`);
    if (detail.text.includes('线下购买') || detail.text.includes('请联系客服办理')) problems.push('课包详情：不该再出现「线下购买」或「请联系客服办理」');
    await shot('18-marketplace-detail');
  }

  // ── ⑤b 灵动课程：**没有任何筛选**（用户口径 2026-09-18 晚「筛选删除」）。
  //    ⚠️ 我上一轮把那两个「画布 / VibeCoding」分类按钮做到了这一页，用户指出地方错了
  //    （那是「灵动作品」的），所以这里改成断言"一个筛选节点都不该有"，包括 .mp-cats。
  for (const gone of ['.mp-cats', '.mp-cat', '.mp-filter-bar', '.mp-filter-toggle', '.mp .mkt-filters', '.mp .mkt-search', '#marketplace-search']) {
    if (await page.locator(gone).count()) problems.push(`灵动课程：这一页不该有任何筛选，却还有 ${gone}`);
  }

  // ── ⑤c 灵动作品（2026-09-19 晚：两个分类 + 每页 12 件翻页）
  // 用户口径：「分类目前就 2 个分类：画布作品和 VibeCoding作品…并且分类在后台可以配置」+
  //          「每一页 12 个作品然后翻页」。
  // 这一节钉：① 只有两个分类胶囊（画布作品 / VibeCoding作品），作品归哪一类由**服务端**算
  //          （work.plazaCategory，后台可配映射）；② 每页 12 件 + 翻页；③ 卡片有类型角标/日期/作者/机构名；
  //          ④ 点开有查看层；⑤ 搜索仍按标题/学生名过滤。
  await page.goto(`${base}/works`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i += 1) { if (await page.locator('.pl-card').count()) break; await page.waitForTimeout(250); }
  await settle();
  if (await page.locator('.page-title').count()) problems.push('灵动作品：页头（学员作品 / 孩子们的灵感…）应已删除');

  // ① 分类只有两个
  const pills = await page.locator('.pl-types .pl-type').evaluateAll((els) => els.map((el) => ({ type: el.getAttribute('data-type'), text: el.textContent.replace(/\s+/g, ' ').trim(), pressed: el.getAttribute('aria-pressed') })));
  console.log(`  · 灵动作品分类：[${pills.map((p) => p.text).join(' / ')}]`);
  const pillTypes = pills.map((p) => p.type);
  if (pillTypes.join('|') !== 'all|CANVAS|VIBECODING') problems.push(`灵动作品：分类应当只有 全部 / 画布作品 / VibeCoding作品（实际 [${pillTypes.join(', ')}]）`);
  if (pills[0]?.pressed !== 'true') problems.push('灵动作品：默认应当选中「全部」');

  // ② 每页 12 件 + 翻页（fixture 造了 15 件：12 + 3）
  const pageOne = await page.locator('.pl-card').count();
  const pager = await page.locator('.pl-pager').count();
  console.log(`  · 第一页卡片 ${pageOne} 张，翻页条 ${pager ? '在' : '不在'}`);
  if (pageOne !== 12) problems.push(`灵动作品：每页应当 12 件（实际 ${pageOne}）`);
  if (!pager) problems.push('灵动作品：作品超过 12 件时应当有翻页条（.pl-pager）');
  else {
    const info = await page.locator('.pl-page-info').innerText();
    console.log(`  · 翻页信息：${info.trim()}`);
    await page.locator('.pl-pager .pl-page', { hasText: '下一页' }).click();
    await settle();
    const pageTwo = await page.locator('.pl-card').count();
    console.log(`  · 下一页：${pageOne} → ${pageTwo} 张`);
    if (pageTwo === 0 || pageTwo >= pageOne) problems.push(`灵动作品：翻到第 2 页的件数不对（${pageTwo}）`);
    await page.locator('.pl-pager .pl-page', { hasText: '上一页' }).click();
    await settle();
  }

  // ③ 两个分类各自只显示自己的那一类
  for (const [type, label] of [['CANVAS', '画布作品'], ['VIBECODING', 'VibeCoding作品']]) {
    await page.locator(`.pl-types .pl-type[data-type="${type}"]`).click();
    await settle();
    // ⚠️ 判的是卡片的 **data-category**（分类），不是 data-type（类型角标）：一件导入件
    //    类型可能是「图片」，但按后台映射它属于「画布作品」这一类 —— 两者不是一回事。
    const shown = await page.locator('.pl-card').evaluateAll((els) => els.map((el) => el.getAttribute('data-category')));
    console.log(`  · 点「${label}」：${shown.length} 张（类型：${[...new Set(shown)].join(', ')}）`);
    if (!shown.length) problems.push(`灵动作品：分类「${label}」下一件都没有（fixture 里应当有）`);
    if (shown.some((key) => key !== type)) problems.push(`灵动作品：分类「${label}」里混进了别的类：${[...new Set(shown)].join(', ')}`);
    await page.locator(`.pl-types .pl-type[data-type="${type}"]`).click();
    await settle();
  }
  await shot('13-works-category');

  // ④ 卡片构成：白卡 20px、封面 14px 圆角、类型角标、日期、作者、**右下角机构名**
  const cardGeo = await page.evaluate(() => {
    const card = document.querySelector('.pl-card');
    if (!card) return null;
    const cover = card.querySelector('.pl-cover');
    const coverBox = cover ? cover.getBoundingClientRect() : null;
    const org = card.querySelector('.pl-author .pl-org');
    const author = card.querySelector('.pl-author');
    return {
      cardRadius: Math.round(parseFloat(getComputedStyle(card).borderRadius)),
      cardBg: getComputedStyle(card).backgroundColor,
      coverRadius: cover ? Math.round(parseFloat(getComputedStyle(cover).borderRadius)) : null,
      coverRatio: coverBox && coverBox.height ? +(coverBox.width / coverBox.height).toFixed(2) : null,
      badge: cover ? (cover.querySelector('.pl-badge')?.textContent || '').trim() : null,
      hasDate: Boolean(card.querySelector('.pl-date')),
      author: (author?.textContent || '').trim(),
      org: (org?.textContent || '').trim(),
      // 机构名在作者行最右：取它右边缘与卡片右边缘的距离（auto margin 的 computed 是解算后的 px，
      // 拿不到 "auto" 这个字面值 —— 所以要判"贴不贴右边"）
      orgGapToCardRight: org ? Math.round(card.getBoundingClientRect().right - org.getBoundingClientRect().right) : null,
      hitTags: [...card.querySelectorAll('.pl-hit')].map((el) => el.tagName.toLowerCase()),
    };
  });
  console.log(`  · 卡片：圆角 ${cardGeo?.cardRadius}px、封面 ${cardGeo?.coverRatio}:1 圆角 ${cardGeo?.coverRadius}px、角标「${cardGeo?.badge}」、有日期=${cardGeo?.hasDate}、作者行「${cardGeo?.author}」`);
  if (!cardGeo) problems.push('灵动作品：取不到卡片几何');
  else {
    if (cardGeo.cardRadius !== 20) problems.push(`灵动作品：卡片圆角应为 20px（实际 ${cardGeo.cardRadius}px）`);
    if (cardGeo.cardBg !== 'rgb(255, 255, 255)') problems.push(`灵动作品：卡片应为白底（实际 ${cardGeo.cardBg}）`);
    if (cardGeo.coverRadius !== 14) problems.push(`灵动作品：封面圆角应为 14px（实际 ${cardGeo.coverRadius}px）`);
    if (cardGeo.coverRatio == null || cardGeo.coverRatio < 1.4) problems.push(`灵动作品：封面应当接近 16:9（实测 ${cardGeo.coverRatio}:1）`);
    if (!cardGeo.badge) problems.push('灵动作品：封面上没有类型角标');
    if (!cardGeo.hasDate) problems.push('灵动作品：卡片上没有日期');
    if (cardGeo.hitTags.length !== 1) problems.push(`灵动作品：整卡应当只有一个可点元素（实际 ${cardGeo.hitTags.length} 个）`);
    // 用户给的图2 红框：机构名在作者行最右（靠 margin-left:auto 顶到右边）
    if (cardGeo.orgGapToCardRight == null || cardGeo.orgGapToCardRight > 30) problems.push(`灵动作品：机构名应当贴在作者行右侧（距卡片右边 ${cardGeo.orgGapToCardRight}px）`);
  }

  // ⑤ 点开有查看层（**导入件**才弹查看层；站内作品是 <Link>，点了会进详情页 —— 别点错）
  const importCard = page.locator('.pl-card[data-type="image"]').first();
  await importCard.locator('.pl-hit').click();
  await page.waitForTimeout(600);
  if (!(await page.locator('.pl-viewer').count())) problems.push('灵动作品：点导入件应当弹出查看层（.pl-viewer）');
  else {
    await shot('15b-works-viewer');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await page.locator('.pl-viewer').count()) problems.push('灵动作品：按 Esc 应当关掉查看层');
  }

  // ⑥ 搜索
  const beforeSearch = await page.locator('.pl-card').count();
  await page.locator('#works-search').fill('样例');
  await page.waitForTimeout(350);
  const searched = await page.locator('.pl-card').count();
  console.log(`  · 搜索「样例」：${beforeSearch} → ${searched} 张`);
  if (!searched) problems.push('灵动作品：用样例标题去搜，一条都没匹配上（搜索没生效）');
  if (searched > beforeSearch) problems.push('灵动作品：搜索之后条数反而变多了？');
  await shot('14-works-search');
  await page.locator('#works-search').fill('');
  await page.waitForTimeout(300);
  await shot('15-works-cards');

  // ── ⑤d 顶栏的登录入口去向 + 登录态（用户口径 2026-09-18 晚）
  // ①「机构 / 老师登录」应当**直接进机构后台**（另一个 SPA，整页跳），不再走官网那个"看着像首页"的登录页
  const orgEntryHref = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('.site-topbar .head-actions a')].find((a) => a.textContent.includes('机构'));
    if (!hit) return null;
    // ⚠️ 别只比字符串开头：生产构建会把 VITE_ORG_APP_URL 注成**绝对地址**
    //    （https://iicili.cyou/org），本地默认才是 /org/。统一解析成 pathname 再比。
    try { return new URL(hit.getAttribute('href'), window.location.origin).pathname; } catch { return hit.getAttribute('href'); }
  });
  console.log(`  · 顶栏「机构 / 老师登录」→ ${orgEntryHref}（pathname）`);
  if (!String(orgEntryHref || '').startsWith('/org')) problems.push(`顶栏：「机构 / 老师登录」应当直接进机构后台（/org/，整页跳），实际 pathname=${orgEntryHref}`);
  // ② 登录之后右上角必须显示账号徽标 —— 用户报的 bug：「我用学生登录后，为什么到首页右上角不显示」。
  //    ⚠️ 这里**真走一遍登录**（种子里的 student-1 / study123），不注入假会话：
  //    假 token 会在第一个带鉴权的请求上 401，而 onUnauthorized 会把会话清掉、页面被踢回登录页，
  //    那样既验不准，也会连带把下面「我的课程」那几条搞成假红。
  await page.goto(`${base}/login?as=student`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.locator('.login-field input').first().fill('student-1');
  await page.locator('.login-field input').nth(1).fill('study123');
  await page.locator('.login-submit').click();
  // LoginPage 用 window.location.assign 按角色分流，学生会落到 /learn（口径：一登录就进「我的课程」；
  // ⚠️ 2026-09-18 晚更正：保留的是 StudentCourseCenter 那个页面（`/learn`），
  //    `/my-courses`（指标卡 + 课时列表那一版）已删、只留重定向 —— 上一轮我两个页面搞反了）
  await page.waitForURL(/\/learn/, { timeout: 20000 }).catch(() => {});
  await settle();
  const landPath = new URL(page.url()).pathname;
  const onStudentPage = await page.locator('.classroom-center').count();
  console.log(`  · 学生登录后落在 ${landPath}（课程中心页=${onStudentPage ? '是' : '否'}）`);
  if (landPath !== '/learn') problems.push(`学生登录后应当落在 /learn（实际 ${landPath}）`);
  if (!onStudentPage) problems.push('学生登录后应当看到「我的课程」（课程中心）页');

  // ── ⑤e 学生端：保留的是课程中心页（/learn），要有返回首页；被删的那一版改成重定向
  await expectText('我的课程', ['我的课程', '返回首页', '刷新课程']);
  // 用户 2026-09-18 晚：「图1 灵动学习页面这里的提示要删除」——就是页头那条浅蓝的两步说明。
  if ((await bodyText()).includes('进操作环境要两步')) problems.push('课程中心（/learn）：页头那条「进操作环境要两步…」提示应已删除');
  const studentPage = await page.evaluate(() => ({
    backHref: document.querySelector('.page-header a[href="/"]')?.getAttribute('href') || null,
    legacyLinks: document.querySelectorAll('a[href^="/my-courses"]').length,
    courseCards: document.querySelectorAll('.course-package-card').length,
  }));
  console.log(`  · 课程中心：返回首页 → ${studentPage.backHref}、指向 /my-courses 的链接 ${studentPage.legacyLinks} 个、课程卡片 ${studentPage.courseCards} 个`);
  if (studentPage.backHref !== '/') problems.push(`课程中心：应当有一个指向首页的「返回首页」（实际 href=${studentPage.backHref}）`);
  if (studentPage.legacyLinks) problems.push(`课程中心：不该再有指向 /my-courses 的链接（${studentPage.legacyLinks} 个）—— 那一版页面已删`);
  // 用户 2026-09-18 晚：「点击『灵动课程』上方都有导航栏，点击『灵动学习』应该也要有导航栏才对」
  const learnChrome = await page.evaluate(() => ({
    topbar: document.querySelectorAll('.site-topbar').length,
    badge: document.querySelectorAll('.site-topbar .header-user').length,
    footer: document.querySelectorAll('body > #root .site > footer').length,
  }));
  console.log(`  · 课程中心的站内外壳：顶栏 ${learnChrome.topbar} 个、账号徽标 ${learnChrome.badge} 个、页脚 ${learnChrome.footer} 个`);
  if (!learnChrome.topbar) problems.push('课程中心（/learn）：应当有站内导航栏（用户口径：点灵动学习也要有导航栏）');
  if (!learnChrome.badge) problems.push('课程中心（/learn）：顶栏里应当显示当前账号徽标');

  // 课程卡片的四条口径（用户 2026-09-18 晚）
  const card = await page.evaluate(() => {
    const el = document.querySelector('.course-package-card');
    if (!el) return null;
    const cover = el.querySelector('.course-package-cover');
    const label = el.querySelector('.course-cover-label');
    const desc = el.querySelector('.course-package-desc');
    const cta = el.querySelector('.course-package-cta');
    const title = el.querySelector('.course-package-heading h2');
    const box = (node) => (node ? node.getBoundingClientRect() : null);
    return {
      coverHeight: cover ? Math.round(box(cover).height) : null,
      labelText: label ? label.textContent.trim() : null,
      titleText: title ? title.textContent.trim() : null,
      hasDescRow: Boolean(desc),
      ctaRadius: cta ? Math.round(parseFloat(getComputedStyle(cta).borderRadius)) : null,
      ctaInsideDesc: Boolean(desc && cta && desc.contains(cta)),
      text: el.innerText.replace(/\n/g, ' '),
    };
  });
  console.log(`  · 课程卡片：封面 ${card?.coverHeight}px、封面标签「${card?.labelText}」、标题「${card?.titleText}」、按钮在简介行内=${card?.ctaInsideDesc} 圆角 ${card?.ctaRadius}px`);
  if (!card) problems.push('课程中心：没找到课程卡片（.course-package-card）');
  else {
    if (card.coverHeight == null || card.coverHeight < 220) problems.push(`课程卡片：封面高度太小（${card.coverHeight}px，应 ≥220px）—— 用户口径：图展示不完`);
    if (card.labelText !== card.titleText) problems.push(`课程卡片：封面上那行字应当是课包标题（实际「${card.labelText}」，标题是「${card.titleText}」）`);
    if (!card.ctaInsideDesc) problems.push('课程卡片：「查看课程」应当和简介在同一行（.course-package-desc 里），不再单独占一行');
    if (card.ctaRadius !== 999) problems.push(`课程卡片：「查看课程」应当是药丸按钮（圆角实际 ${card.ctaRadius}px）`);
    for (const gone of ['上课形式：', '已分给你', '未授权 · 请找老师', '节课正在上课', '已完课']) {
      if (card.text.includes(gone)) problems.push(`课程卡片：应当已删掉那两行状态文字，却还出现「${gone}」`);
    }
  }
  await shot('17-my-courses');
  // ── ⑤f 主页（原「我的作品」那一页）：每张卡片都要有封面 + 头像/名字/统计 + 手机两列
  //    ⚠️ 2026-09-27 用户口径：「**现在不需要这个 my-home 了。直接跳转到对外主页就行了**」——
  //    那一页已删；导航「我的主页」现在**跳转到对外主页** `/u/<token>`。所以这一节直接跑在主页上，
  //    顺带把"跳转"这件事本身也验了。
  await page.goto(`${base}/my-home`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.waitForTimeout(900);
  const creatorUrl = page.url();
  const creatorPath = creatorUrl.replace(base, '');
  console.log(`  · 从 /my-home 落到：${creatorPath}`);
  if (!/^\/u\/ust_[0-9a-f]{24}$/.test(creatorPath)) problems.push(`我的主页：/my-home 应当**直接跳到对外主页**（实际落到 ${creatorPath}）`);
  await page.waitForSelector('.sw-card', { timeout: 20000 }).catch(() => {});
  const coverState = await page.evaluate(() => ({
    cards: document.querySelectorAll('.student-card.sw-card').length,
    art: document.querySelectorAll('.student-work-card__art').length,
    images: document.querySelectorAll('.student-work-card__cover img').length,
    chips: [...new Set(Array.from(document.querySelectorAll('.student-work-card__type')).map((el) => (el.textContent || '').trim()))],
    legacyIcons: document.querySelectorAll('.student-work-card__icon').length,
  }));
  console.log(`  · 主页：卡片 ${coverState.cards} 张、自动封面 ${coverState.art} 张、真封面 ${coverState.images} 张、类型 ${JSON.stringify(coverState.chips)}`);
  if (coverState.cards === 0) problems.push('主页：夹具下应当有作品卡片（否则下面那条封面等式是空转）');
  if (coverState.art + coverState.images !== coverState.cards) problems.push(`主页：每张卡片都要有封面（自动 ${coverState.art} + 真 ${coverState.images} ≠ 卡片 ${coverState.cards}）`);
  if (coverState.legacyIcons) problems.push(`主页：不该再有旧的 emoji 占位图标（${coverState.legacyIcons} 个）`);
  if (!coverState.chips.includes('VibeCoding · 网页应用')) problems.push(`主页：夹具里有件网页作品，类型标签应当出现「VibeCoding · 网页应用」（实际 ${JSON.stringify(coverState.chips)}）`);
  const profileState = await page.evaluate(() => ({
    avatars: document.querySelectorAll('.sw-avatar').length,
    name: (document.querySelector('.sw-profile-main h1')?.textContent || '').trim(),
    stats: Array.from(document.querySelectorAll('.sw-stats strong')).map((node) => node.textContent.trim()),
    columns: (getComputedStyle(document.querySelector('.sw-grid') || document.body).gridTemplateColumns || '').split(' ').filter(Boolean).length,
    selects: document.querySelectorAll('.sw-toolbar select, .student-work-toolbar select').length,
    cards: document.querySelectorAll('.sw-card__link').length,
  }));
  console.log(`  · 主页抬头：头像 ${profileState.avatars} 个、名字「${profileState.name}」、统计 ${JSON.stringify(profileState.stats)}、网格 ${profileState.columns} 列、可点卡片 ${profileState.cards} 条`);
  if (!profileState.avatars) problems.push('主页：顶部应当有头像（用户 2026-09-27 口径「也可以有头像这些在」）');
  if (!profileState.name) problems.push('主页：顶部应当显示学生名字（机构建号那个名字）');
  if (profileState.stats.length < 1) problems.push(`主页：统计行至少要有「作品数」（实际 ${JSON.stringify(profileState.stats)}）`);
  if (profileState.columns < 2) problems.push(`主页：应当是**多列**网格（手机上两列），实际 ${profileState.columns} 列`);
  if (profileState.selects) problems.push(`主页：不该有下拉筛选（实际还剩 ${profileState.selects} 个 select）`);
  if (profileState.cards !== coverState.cards) problems.push(`主页：每张卡都要能点开（卡片 ${coverState.cards} 张 / 可点元素 ${profileState.cards} 条）`);
  await shot('19-my-works-covers');
  // 手机视口再看一眼（用户给的图就是手机截的）：网格应恰好**两列**、头像还在、不横向溢出
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  const mobileState = await page.evaluate(() => ({
    columns: (getComputedStyle(document.querySelector('.sw-grid') || document.body).gridTemplateColumns || '').split(' ').filter(Boolean).length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    avatars: document.querySelectorAll('.sw-avatar').length,
  }));
  console.log(`  · 主页（390px 手机视口）：网格 ${mobileState.columns} 列、横向溢出 ${mobileState.overflow}px、头像 ${mobileState.avatars} 个`);
  if (mobileState.columns !== 2) problems.push(`主页：手机视口下应当是两列网格（实际 ${mobileState.columns} 列）`);
  if (mobileState.overflow > 2) problems.push(`主页：手机视口下横向溢出了 ${mobileState.overflow}px`);
  if (!mobileState.avatars) problems.push('主页：手机视口下头像不见了');
  await shot('19b-my-works-mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  await settle();

  // ── ⑤f⁗ ⭐ 2026-09-27：**主人模式**（改头像 / 分享）现在长在这一页上；点作品卡**弹窗**看
  //    口径：「头像修改要加上」「学生可以自行修改照片」「改成弹窗那样的」。
  const ownerState = await page.evaluate(() => ({
    avatarButton: document.querySelectorAll('[data-testid="home-avatar"]').length,
    panel: document.querySelectorAll('[data-testid="home-panel"]').length,
    share: document.querySelectorAll('[data-testid="share-home-public"]').length,
  }));
  console.log(`  · 主人模式：头像按钮 ${ownerState.avatarButton} 个、设置面板 ${ownerState.panel} 个（初始应 0）、分享按钮 ${ownerState.share} 个`);
  if (!ownerState.avatarButton) problems.push('主页：登录者本人看自己的主页时，头像应当是**可点的按钮**（改头像入口）');
  if (ownerState.panel) problems.push('主页：设置面板初始应当收起');
  if (!ownerState.share) problems.push('主页：应当有「分享这个主页」按钮');
  // 分享：**面板收起时**也要有可见反馈（用户报过"点了没反应" —— 提示条原来渲染在收起的面板里）
  await page.locator('[data-testid="share-home-public"]').first().click();
  await page.waitForTimeout(600);
  const shareFeedback = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="home-public-notice"]');
    if (!node) return { visible: false, text: '' };
    const rect = node.getBoundingClientRect();
    return { visible: rect.width > 0 && rect.height > 0, text: (node.textContent || '').trim() };
  });
  console.log(`  · 点「分享这个主页」：反馈可见 ${shareFeedback.visible ? '是' : '否'}、文案「${shareFeedback.text.slice(0, 60)}」`);
  if (!shareFeedback.visible) problems.push('主页：⭐ 点「分享」面板收起时也要有可见反馈（用户 2026-09-27 报的「没反应」）');
  if (!/\/u\/ust_/.test(shareFeedback.text)) problems.push(`主页：分享反馈里应当带上主页地址（实际「${shareFeedback.text.slice(0, 80)}」）`);
  // 点头像 → 设置面板
  await page.locator('[data-testid="home-avatar"]').first().click();
  await settle();
  const panelState = await page.evaluate(() => ({
    panel: document.querySelectorAll('[data-testid="home-panel"]').length,
    avatars: document.querySelectorAll('.sw-avatar-picker [data-testid^="avatar-"]').length,
    hasNone: document.querySelectorAll('[data-testid="avatar-none"]').length,
    hasUpload: document.querySelectorAll('[data-testid="avatar-upload"]').length,
  }));
  console.log(`  · 主页设置：面板 ${panelState.panel} 个、头像选项 ${panelState.avatars} 个（含"首字" ${panelState.hasNone}）、上传 ${panelState.hasUpload} 个`);
  if (!panelState.panel) problems.push('主页：点头像应当展开设置面板');
  if (panelState.avatars !== 9) problems.push(`主页：头像应当是 8 个预设 + 1 个"首字"（实际 ${panelState.avatars}）`);
  if (!panelState.hasUpload) problems.push('主页：设置面板里应当能上传自己的照片（用户口径「学生可以自行修改照片」）');
  // 选狐狸 → 头像位立刻变 + 提示"已保存"
  await page.locator('[data-testid="avatar-fox"]').first().click();
  await settle();
  const avatarAfter = await page.evaluate(() => ({
    glyph: (document.querySelector('[data-testid="home-avatar"]')?.textContent || '').trim(),
    notice: (document.querySelector('[data-testid="home-public-notice"]')?.textContent || '').trim(),
    active: document.querySelectorAll('[data-testid="avatar-fox"].is-active').length,
  }));
  console.log(`  · 选了狐狸头像：头像位「${avatarAfter.glyph}」、选中态 ${avatarAfter.active} 个、提示「${avatarAfter.notice}」`);
  if (avatarAfter.glyph !== '🦊') problems.push(`主页：选了狐狸头像后头像位应当变成 🦊（实际「${avatarAfter.glyph}」）`);
  if (!avatarAfter.notice.includes('已保存')) problems.push(`主页：保存后应当有「已保存」提示（实际「${avatarAfter.notice}」）`);
  // 上传照片：⚠️ 用 **2:1** 的图 —— 正方形图看不出"被压成竖椭圆"那个问题（夹具原来是正方形，所以没抓到）
  const avatarPng = path.join(shotDir, 'avatar-fixture.png');
  fs.writeFileSync(avatarPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4HxAQEPAfAAtgAz+XDzWtAAAAAElFTkSuQmCC', 'base64'));
  await page.locator('[data-testid="avatar-upload"]').setInputFiles(avatarPng);
  await page.waitForTimeout(1200);
  const photoState = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="home-avatar"]');
    const img = box?.querySelector('img');
    const rect = box?.getBoundingClientRect();
    const imgRect = img?.getBoundingClientRect();
    return {
      isImg: Boolean(img),
      src: img?.getAttribute('src') || '',
      loaded: Boolean(img && img.complete && img.naturalWidth > 0),
      boxW: rect ? Math.round(rect.width) : 0, boxH: rect ? Math.round(rect.height) : 0,
      imgW: imgRect ? Math.round(imgRect.width) : 0, imgH: imgRect ? Math.round(imgRect.height) : 0,
    };
  });
  console.log(`  · 上传照片当头像：头像位 ${photoState.boxW}×${photoState.boxH}px、里面的图 ${photoState.imgW}×${photoState.imgH}px、真的画出来了 ${photoState.loaded ? '是' : '否'}`);
  if (!photoState.isImg) problems.push('主页：上传照片后头像位应当变成图片');
  if (!/\/api\/public\/file-assets\/.+\/download$/.test(photoState.src)) problems.push(`主页：头像图应当走公开读口（实际「${photoState.src}」）`);
  if (!photoState.loaded) problems.push('主页：头像图应当真的加载出来（naturalWidth === 0 说明是破图）');
  if (Math.abs(photoState.boxW - photoState.boxH) > 2) problems.push(`主页：头像位必须是**正圆**（实际 ${photoState.boxW}×${photoState.boxH}）—— 用户 2026-09-27 报的"变成竖椭圆"`);
  if (Math.abs(photoState.imgW - photoState.imgH) > 2 || Math.abs(photoState.imgW - photoState.boxW) > 2) {
    problems.push(`主页：头像图应当铺满头像位（图 ${photoState.imgW}×${photoState.imgH} vs 位 ${photoState.boxW}×${photoState.boxH}）`);
  }
  await shot('19h-avatar-photo');
  // 移除照片：别把夹具状态留给后面几节
  await page.locator('[data-testid="avatar-photo-remove"]').first().click();
  await settle();

  // ⭐ 「改成弹窗那样的」：点一张作品卡应当**弹窗**看（不跳详情页）
  await page.locator('[data-testid="home-work-card"]').first().click();
  await settle();
  await page.waitForTimeout(1400);
  const modalState = await page.evaluate(() => ({
    modal: document.querySelectorAll('[data-testid="work-modal"]').length,
    title: (document.querySelector('[data-testid="work-modal"] h3')?.textContent || '').trim(),
    hasStage: Boolean(document.querySelector('[data-testid="work-modal"] .learning-canvas, [data-testid="work-modal"] .c-preview__stage')),
  }));
  console.log(`  · 点作品卡：弹窗 ${modalState.modal} 个、标题「${modalState.title}」、里面有预览 ${modalState.hasStage ? '是' : '否'}`);
  if (!modalState.modal) problems.push('主页：⭐ 点作品卡应当**弹窗**看（用户口径「改成弹窗那样的」）');
  if (!modalState.hasStage) problems.push('主页：弹窗里应当渲染出作品预览（画布或网页预览）');
  await shot('19k-work-modal');
  await page.keyboard.press('Escape');
  await settle();
  if (await page.locator('[data-testid="work-modal"]').count()) problems.push('主页：按 Esc 应当关掉作品弹窗');

  // ── ⑤f″ ⭐ 2026-09-27 用户报的图1：**只读查看的画布要按容器适配**，不能照搬快照里存的视角。
  //    夹具 `work_guard_wide`：节点横向铺到 x≈1250、viewport 是桌面形状（x:-120,y:-80,zoom:0.72）
  //    且**不公开**。390px 下如果照搬那个视角，节点会大片跑出容器 —— 用户看到的就是
  //    「一大块深色、内容只在右边露一条」。这条同时覆盖**学生自己那页**与**公开页**（用户给的就是公开页）。
  const measureCanvasFit = async () => page.evaluate(() => {
    const box = document.querySelector('.learning-canvas');
    if (!box) return { missing: true };
    const outer = box.getBoundingClientRect();
    const rects = Array.from(document.querySelectorAll('.learning-canvas .react-flow__node')).map((node) => node.getBoundingClientRect());
    const union = rects.reduce((acc, rect) => ({
      left: Math.min(acc.left, rect.left), right: Math.max(acc.right, rect.right),
      top: Math.min(acc.top, rect.top), bottom: Math.max(acc.bottom, rect.bottom),
    }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
    return {
      missing: false,
      nodes: rects.length,
      outside: rects.filter((rect) => rect.left < outer.left - 2 || rect.right > outer.right + 2 || rect.top < outer.top - 2 || rect.bottom > outer.bottom + 2).length,
      coverW: rects.length ? Number(((union.right - union.left) / (outer.width || 1)).toFixed(2)) : 0,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  const checkCanvasFit = async (label, shotName) => {
    const fit = await measureCanvasFit();
    console.log(`  · ${label}：节点 ${fit.nodes ?? 0} 个、跑出容器 ${fit.outside ?? '-'} 个、内容占容器宽 ${fit.coverW ?? '-'}、页面横向溢出 ${fit.overflow ?? '-'}px`);
    if (fit.missing) { problems.push(`${label}：找不到 .learning-canvas`); return; }
    if (fit.nodes < 3) problems.push(`${label}：只读画布上应当渲染出 3 个节点（实际 ${fit.nodes}）`);
    if (fit.outside) problems.push(`${label}：有 ${fit.outside} 个节点跑出画布容器 —— 只读查看应当按容器适配（用户 2026-09-27 图1）`);
    if (fit.coverW < 0.5) problems.push(`${label}：适配后内容只占容器宽的 ${fit.coverW}，不像"整幅装下"`);
    if (fit.overflow > 2) problems.push(`${label}：页面横向溢出了 ${fit.overflow}px`);
    if (shotName) await shot(shotName);
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/my-home/CANVAS/work_guard_wide`, { waitUntil: 'domcontentloaded' });
  await settle();
  // ⚠️ /my-home 现在跳到 creator 作用域的公开详情页，那一页的档位类名是 .work-detail__tab（创作画布）
  const wideCanvasTab = page.locator('.work-detail__tab, .mw-views button', { hasText: '画布' });
  if (await wideCanvasTab.count()) { await wideCanvasTab.first().click(); await settle(); }
  await page.waitForSelector('.learning-canvas .react-flow__node', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800); // 「下一帧再适配」那一步落定 + 容器宽度定下来
  await checkCanvasFit('宽画布（390px 学生自己那页）', '19c-wide-canvas-mobile');

  // ⭐ 「公开到广场」：学生**自己**把未公开的画布作品公开出去。
  //    ⚠️ 2026-09-27 这个入口搬到了主页的主人模式里（原来那页「我的作品·单件详情」已删）——
  //    按钮文案就写明"公开到广场"，点它等于公开（不偷偷替学生公开）。
  await page.goto(creatorUrl, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.waitForTimeout(700);
  const publishBefore = await page.locator('[data-testid="publish-work"]').count();
  console.log(`  · 未公开作品的「公开到广场」按钮：${publishBefore} 个`);
  if (!publishBefore) problems.push('主页：主人模式下，未公开的画布作品卡上应当有「公开到广场」按钮（学生自己公开作品的入口）');
  else {
    await page.locator('[data-testid="publish-work"]').first().click();
    await settle();
    await page.waitForTimeout(1200);
    const publishedNotice = await page.evaluate(() => (document.querySelector('[data-testid="home-public-notice"]')?.textContent || '').trim());
    const afterCount = await page.locator('[data-testid="publish-work"]').count();
    console.log(`  · 点「公开到广场」：提示「${publishedNotice.slice(0, 70)}」、剩下的未公开按钮 ${afterCount} 个`);
    if (!/已公开/.test(publishedNotice)) problems.push(`主页：公开后应当有可见反馈（实际「${publishedNotice.slice(0, 60)}」）`);
    if (afterCount >= publishBefore) problems.push('主页：公开成功后，那件作品卡上不该再有「公开到广场」按钮');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  await page.goto(`${base}/u/${creatorUrl.split('/u/')[1]}/w/CANVAS/work_guard_wide`, { waitUntil: 'domcontentloaded' });
  await settle();
  {
    const wideTab = page.locator('.work-detail__tab', { hasText: '创作画布' });
    if (await wideTab.count()) { await wideTab.first().click(); await settle(); }
    await page.waitForSelector('.learning-canvas .react-flow__node', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    await checkCanvasFit('宽画布（390px 公开主页里点开）', '19e-wide-canvas-public-mobile');
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await settle();

  // 静态钉子：两处"对外看作品"的详情页都要开着 `fitContent`（预览框跟着内容长，
  // 内层才不会出现滚动条 —— 用户 2026-09-27 报的那根「点下一页 2/12 出现的滚动条」）。
  for (const file of ['apps/website/src/pages/WorkDetail.jsx']) {
    if (!/<ReplayPreview[^>]*fitContent/.test(fs.readFileSync(path.join(root, file), 'utf8'))) {
      problems.push(`${file}：作品预览应当开着 fitContent（否则比逻辑视口高的作品内层会出现滚动条）`);
    }
  }

  // ── ⑤g 学生自己的**网页作品**点开：要能玩，且**内层不能出现滚动条**（口径㉕，用户报的
  //    「作品预览里出现滚动条」）。做法是"内层按不小于 640×768 的逻辑视口渲染、再整体等比缩放到
  //    可用空间"，所以这里断言的是**结构**：iframe 的布局尺寸 ≥640×768、带一个 ≤1 的 scale、
  //    外面套着裁剪的舞台。内层文档自己的滚动条在外层读不到（沙箱是 opaque origin），
  //    所以另存截图 20-work-preview 供人眼复核。
  // ⭐ 2026-09-27 新增：把**内层自报的内容高度**记下来（见 vibecodingProject.js 的 PREVIEW_HEIGHT_BRIDGE）。
  //    为什么要它：内层是 opaque origin 的沙箱，外层**读不到**内层文档，所以"内层会不会出现滚动条"
  //    只能靠"内层视口高度 ≥ 内容高度"这条不变式来判 —— 而内容高度只有内层自己知道。
  await page.addInitScript(() => {
    window.__previewHeights = [];
    window.addEventListener('message', (event) => {
      if (event?.data?.source === 'vibecoding-preview-height') window.__previewHeights.push(Number(event.data.height) || 0);
    });
  });
  await page.goto(`${base}/my-home/VIBECODING/vibesub_guard_web`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.waitForTimeout(900);
  const viewer = await page.evaluate(() => {
    const stage = document.querySelector('.c-replay__stage');
    const frame = stage ? stage.querySelector('iframe') : document.querySelector('.c-replay__frame');
    if (!frame) return { found: false };
    const style = frame.style || {};
    const box = frame.getBoundingClientRect();
    const transform = style.transform || getComputedStyle(frame).transform;
    return {
      found: true,
      hasStage: Boolean(stage),
      stageOverflow: stage ? getComputedStyle(stage).overflow : null,
      stageH: stage ? Math.round(stage.getBoundingClientRect().height) : 0,
      stageClass: stage ? String(stage.className) : '(无舞台)',
      layoutW: Math.round(parseFloat(style.width) || box.width),
      layoutH: Math.round(parseFloat(style.height) || box.height),
      scale: Number((/scale\(([\d.]+)\)/.exec(String(transform)) || [])[1]) || 1,
      transform,
      sandbox: frame.getAttribute('sandbox') || '',
      reportedHeight: Math.max(0, ...(window.__previewHeights || [0])),
    };
  });
  console.log(`  · 作品预览：舞台=${viewer.hasStage}（高 ${viewer.stageH}px，class「${viewer.stageClass}」）逻辑视口=${viewer.layoutW}×${viewer.layoutH} scale=${viewer.scale} 内层自报内容高=${viewer.reportedHeight}`);
  if (!viewer.found) problems.push('作品详情：找不到作品预览的 iframe');
  else {
    if (viewer.layoutW < 640) problems.push(`作品预览：内层逻辑视口宽度必须 ≥ 640（实际 ${viewer.layoutW}）`);
    if (viewer.layoutH < 768) problems.push(`作品预览：内层逻辑视口高度必须 ≥ 768（实际 ${viewer.layoutH}）`);
    if (!/scale\(/.test(String(viewer.transform))) problems.push(`作品预览：应当整体等比缩放（transform 实际「${viewer.transform}」）`);
    // ⭐⭐ 用户 2026-09-27 报的那根滚动条，就是这条不变式被破坏：
    //    内层视口比内容矮 → 内层文档自己滚起来 → 右侧出现滚动条。
    if (!viewer.reportedHeight) problems.push('作品预览：内层没有自报高度（PREVIEW_HEIGHT_BRIDGE 没装上？）');
    else if (viewer.layoutH + 1 < viewer.reportedHeight) {
      problems.push(`作品预览：⭐ 内层视口 ${viewer.layoutH} 比内容 ${viewer.reportedHeight} 矮 —— 内层会出现滚动条（用户 2026-09-27 报的那根）`);
    }
    // ⭐ 2026-09-27（第二轮口径）：「做成图2这样……大大方方的。自适应。」——
    //    舞台**不许跟着内容长**（那一版把页面撑到 1400px、底下按钮全出首屏：用户「下方的按钮都看不到了」），
    //    而是固定成"高一档、按屏幕自适应"的高度，作品**整幅缩放进得去**。
    // ⚠️ 这条只钉**意图**：舞台是按屏幕自适应的一档高度（62~78vh），**不许跟着内容长**
    //    （跟内容长的那一版实测 1448px，把底下按钮全顶出首屏 —— 用户报的「下方的按钮都看不到了」）。
    //    不钉精确到某个 vh：页面上可能同时存在别的预览实例，钉死了会因为无关变化假红。
    const viewportH = await page.evaluate(() => window.innerHeight);
    const stageMax = Math.min(Math.round(viewportH * 0.78), 920) + 8;
    const stageMin = Math.round(viewportH * 0.6) - 8;
    if (viewer.stageH > stageMax) problems.push(`作品预览：舞台 ${viewer.stageH}px 比 ${stageMax}px 还高 —— 它跟着内容长了（用户报过：底下按钮会被顶出首屏）`);
    if (viewer.stageH < stageMin) problems.push(`作品预览：舞台只有 ${viewer.stageH}px，太矮了（用户要的「大大方方」）`);
    if (viewer.layoutH * viewer.scale > viewer.stageH + 2) problems.push(`作品预览：缩放后的框（${Math.round(viewer.layoutH * viewer.scale)}px）比舞台（${viewer.stageH}px）还高，会被裁掉`);
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    console.log(`  · 整页高度 ${pageHeight}px（视口 ${viewportH}px，比值 ${(pageHeight / viewportH).toFixed(2)}）`);
    if (pageHeight > viewportH * 1.9) problems.push(`作品详情：整页高 ${pageHeight}px（视口的 ${(pageHeight / viewportH).toFixed(2)} 倍）—— 底下的按钮会被顶出首屏（用户 2026-09-27 报的「下方的按钮都看不到了」）`);
    if (!/allow-scripts/.test(viewer.sandbox) || /allow-same-origin/.test(viewer.sandbox)) problems.push(`作品预览：沙箱属性不对（${viewer.sandbox}）`);
    // 顺手量一下右上角那排按钮：`.c-page__actions` 是 `flex:none` **不换行**，按钮一多就会挤到一起
    // （2026-09-27 在截图里看到「分享」和「← 返回我的主页」叠在一起）。
    const actionsGeo = await page.evaluate(() => {
      const row = document.querySelector('.c-page__actions');
      if (!row) return { found: false };
      const rowBox = row.getBoundingClientRect();
      return {
        found: true,
        rowLeft: Math.round(rowBox.left),
        rowRight: Math.round(rowBox.right),
        items: Array.from(row.children).map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 14), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), box: `${el.tagName.toLowerCase()}.${el.className}`, flex: cs.flex, padding: cs.padding, width: cs.width };
        }),
      };
    });
    if (actionsGeo.found) {
      console.log(`  · 详情页动作区：[${actionsGeo.items.map((i) => `${i.text}(${i.left}~${i.right})`).join(' | ')}]`);
      for (const i of actionsGeo.items) console.log(`      · ${i.box} flex=${i.flex} padding=${i.padding} width=${i.width}`);
      for (let i = 0; i + 1 < actionsGeo.items.length; i += 1) {
        const a = actionsGeo.items[i]; const b = actionsGeo.items[i + 1];
        const sameLine = a.top < b.bottom && b.top < a.bottom;
        if (sameLine && a.right > b.left + 2) problems.push(`作品详情：动作区按钮重叠 —— 「${a.text}」与「${b.text}」（${a.right} > ${b.left}）`);
      }
      const outside = actionsGeo.items.filter((i) => i.left < actionsGeo.rowLeft - 2 || i.right > actionsGeo.rowRight + 2);
      if (outside.length) problems.push(`作品详情：动作区按钮溢出了那一行：[${outside.map((i) => i.text).join(', ')}]`);
      // ⚠️ 挤扁：flex 默认会收缩，短按钮会被压成一条缝（padding 没了，看着像半个按钮）。
      //    实测过「分享」被压到 27px —— 那时候两个按钮并不重叠，所以上面那条重叠断言抓不到它。
      const squashed = actionsGeo.items.filter((i) => i.right - i.left < 40);
      if (squashed.length) problems.push(`作品详情：动作区按钮被挤扁了：[${squashed.map((i) => `${i.text}(${i.right - i.left}px)`).join(', ')}]`);
    }
    if (Number((String(viewer.transform).match(/scale\(([\d.]+)\)/) || [])[1] || 0) > 1) problems.push('作品预览：有空间时缩放不该放大（scale 要封顶 1）');
    if (viewer.stageOverflow !== 'hidden') problems.push(`作品预览：舞台应当裁剪溢出（overflow 实际 ${viewer.stageOverflow}）`);
    if (/allow-same-origin/.test(viewer.sandbox)) problems.push('作品预览：沙箱不许带 allow-same-origin（口径⑧）');
  }
  await shot('20-work-preview');
  // ⚠️ 反过来：真正的课堂（/learn/canvas）**必须仍然没有**站内导航（那是学生干活的全屏环境）
  await page.goto(`${base}/learn/canvas`, { waitUntil: 'domcontentloaded' });
  await settle();
  const canvasChrome = await page.locator('.site-topbar').count();
  console.log(`  · 课堂页 /learn/canvas 的站内顶栏：${canvasChrome} 个（应当 0）`);
  if (canvasChrome) problems.push('/learn/canvas 那个课堂页不该有站内导航（它要让出整屏高度）');
  await page.goto(`${base}/learn`, { waitUntil: 'domcontentloaded' });
  await settle();
  // 被删的那一版：路由还在但只做重定向（老链接/老书签不 404）
  await page.goto(`${base}/my-courses`, { waitUntil: 'domcontentloaded' });
  await settle();
  const afterLegacy = new URL(page.url()).pathname;
  const stillCenter = await page.locator('.classroom-center').count();
  console.log(`  · /my-courses → ${afterLegacy}（落到课程中心=${stillCenter ? '是' : '否'}）`);
  if (afterLegacy !== '/learn') problems.push(`/my-courses 应当重定向到 /learn（实际停在 ${afterLegacy}）`);
  if (!stillCenter) problems.push('/my-courses 重定向之后应当看到课程中心页');

  // ③ 回首页看徽标（用**真实会话**，账号名应当是「小明」）
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await settle();
  const signedBar = await page.evaluate(() => {
    const bar = document.querySelector('.site-topbar');
    const badge = bar?.querySelector('.header-user');
    const box = badge?.getBoundingClientRect();
    return {
      text: bar ? bar.innerText.replace(/\n/g, ' ') : '',
      badges: bar ? bar.querySelectorAll('.header-user').length : 0,
      badgeWidth: box ? Math.round(box.width) : 0,
      roleTags: bar ? bar.querySelectorAll('.role-tag').length : 0,
      avatars: bar ? bar.querySelectorAll('.header-user-avatar').length : 0,
      nameBg: (() => { const el = bar?.querySelector('.header-user-name'); return el ? getComputedStyle(el).backgroundImage : null; })(),
      arrowSize: (() => { const el = bar?.querySelector('.dropdown-arrow'); return el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : null; })(),
      arrowColor: (() => { const el = bar?.querySelector('.dropdown-arrow'); return el ? getComputedStyle(el).color : null; })(),
      names: bar ? bar.querySelectorAll('.header-user-name').length : 0,
    };
  });
  console.log(`  · 登录态首页顶栏：「${signedBar.text}」徽标 ${signedBar.badges} 个 宽 ${signedBar.badgeWidth}px 头像 ${signedBar.avatars} 名字 ${signedBar.names} 角色标签 ${signedBar.roleTags} 箭头 ${signedBar.arrowSize}px ${signedBar.arrowColor} 名字底 ${String(signedBar.nameBg).slice(0, 46)}`);
  if (!signedBar.badges || signedBar.badgeWidth < 40) problems.push('首页（已登录）：右上角应当显示账号徽标（.header-user）—— 学生登录后回首页看不到账号就是用户报的那个 bug');
  if (signedBar.text.includes('机构 / 老师登录') || signedBar.text.includes('学生登录')) problems.push('首页（已登录）：不该再显示登录入口');
  // 2026-09-18 晚用户口径（第三次调徽标）：
  //   ①那个圆形头像**删掉**（首页与下拉里都删）；②名字要有底色凸显；③箭头放大、深色首页上换白色。
  if (signedBar.roleTags) problems.push(`首页徽标：不该再有角色标签（.role-tag，例如「小小创作者」），实际 ${signedBar.roleTags} 个`);
  if (signedBar.avatars) problems.push(`首页徽标：那个圆形头像应当已删除（还有 ${signedBar.avatars} 个 .header-user-avatar）`);
  if (!signedBar.names) problems.push('首页徽标：应当有名字（.header-user-name）');
  if (!/gradient/.test(String(signedBar.nameBg))) problems.push(`首页徽标：名字应当有一层有质感的底色（实际 background-image=${signedBar.nameBg}）`);
  if (!(signedBar.arrowSize >= 15)) problems.push(`首页徽标：下拉箭头要放大（实际 ${signedBar.arrowSize}px，应 ≥15px）`);
  if (signedBar.arrowColor !== 'rgb(255, 255, 255)') problems.push(`首页（深色底）：箭头应当是白色（实际 ${signedBar.arrowColor}）`);
  // 下拉：参考图是一张白卡 —— 顶部「名字 + 头像」+ 分隔线 + 纯文字项（不带图标）
  await page.locator('.site-topbar .header-user').click();
  await page.waitForTimeout(400);
  const dropdown = await page.evaluate(() => {
    const menu = document.querySelector('.student-dropdown-menu');
    if (!menu) return null;
    return {
      items: menu.querySelectorAll('.menu-item').length,
      labels: [...menu.querySelectorAll('.menu-item .menu-label')].map((el) => el.textContent.trim()),
      hasHead: menu.querySelectorAll('.dropdown-head').length,
      icons: menu.querySelectorAll('.menu-icon').length,
      radius: Math.round(parseFloat(getComputedStyle(menu).borderRadius)),
    };
  });
  console.log(`  · 徽标下拉：${JSON.stringify(dropdown)}`);
  if (!dropdown) problems.push('首页徽标：点一下应当弹出下拉菜单');
  else {
    if (!dropdown.hasHead) problems.push('首页徽标下拉：顶部应当有「名字 + 头像」那一块（.dropdown-head）');
    if (!dropdown.items) problems.push('首页徽标下拉：没有菜单项');
    if (dropdown.icons) problems.push(`首页徽标下拉：参考图是纯文字项，不该有图标（.menu-icon 还有 ${dropdown.icons} 个）`);
    if (dropdown.radius < 10) problems.push(`首页徽标下拉：应当是圆角卡片（实际 ${dropdown.radius}px）`);
    if (!dropdown.labels.includes('我的课程')) problems.push(`首页徽标下拉：应当有「我的课程」入口（实际 [${dropdown.labels.join(' / ')}]）`);
    if (dropdown.labels.includes('进入学习')) problems.push('首页徽标下拉：不该再有「进入学习」（那个列表页已按用户口径删除）');
  }
  await shot('16-home-signed-in');
  // 用户报的 bug：「我在首页点开这个下拉框，我切换页面还存在」。
  // 顶栏是常驻的，state 控制的菜单不会自己跟着路由走 —— 两条兜底都要验：
  //   ① Esc / 点空白处收起；② 路由一变就收起。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const afterEscape = await page.locator('.student-dropdown-menu').count();
  console.log(`  · 按 Esc 之后下拉还在吗：${afterEscape ? '还在 ✗' : '已收起 ✓'}`);
  if (afterEscape) problems.push('顶栏下拉：按 Esc 应当收起');
  await page.locator('.site-topbar .header-user').click();
  await page.waitForTimeout(300);
  if (!(await page.locator('.student-dropdown-menu').count())) problems.push('顶栏下拉：再点一次应当还能打开');
  await page.locator('.site-topbar nav a', { hasText: '课堂作品' }).first().click();   // 2026-09-25 改名
  await page.waitForTimeout(700);
  const afterNav = await page.locator('.student-dropdown-menu').count();
  console.log(`  · 用顶栏切换页面之后下拉还在吗：${afterNav ? '还在 ✗' : '已收起 ✓'}（当前 ${new URL(page.url()).pathname}）`);
  if (afterNav) problems.push('顶栏下拉：切换页面之后必须自动收起（用户报的 bug：「我切换页面还存在」）');
  await page.evaluate(() => window.localStorage.removeItem('ai-kids-platform.session.v1.student'));
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await settle();

  // ── ⑥ reduced-motion：不创建 WebGL（SpecularButton 的平台侧改造），按钮与文案仍要可用
  //    ⚠️ 放在改库之前：改完之后首页文案已经被清空了，这一段的断言会失去意义。
  const { context: rmContext, pg: rmPage } = await newPage({ reducedMotion: 'reduce' });
  await rmPage.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  const rmCopy = await captureSettledCopy(rmPage);
  const rmCanvases = await rmPage.locator('.hp-actions canvas').count();
  if (rmCanvases) problems.push(`reduced-motion：仍在创建 WebGL canvas（${rmCanvases} 个）—— 应当跳过 WebGL，按钮仍可用`);
  if (!rmCopy.title && !rmCopy.accent) problems.push('reduced-motion：首页文案没渲染出来');
  console.log(`  · reduced-motion：canvas=${rmCanvases} 文案=「${rmCopy.title || rmCopy.accent}」`);
  await rmContext.close();

  // ── ⑦ 空串 = 运营故意清空（用户报的「我在后台清空了为什么还显示」）─────────────
  // 直接改临时库里 HOME 的已发布内容（服务端每次请求直读库，没有缓存）
  const mutateHome = async (patch) => {
    const current = await withDb(async () => JSON.parse((await arow("SELECT published_content FROM website_contents WHERE content_key='HOME'")).published_content));
    const next = { ...current, ...patch };
    await withDb(async () => await aq("UPDATE website_contents SET draft_content=?, published_content=?, updated_at=? WHERE content_key='HOME'", [JSON.stringify(next), JSON.stringify(next), new Date().toISOString()]));
    return next;
  };

  await mutateHome({ heroTitle: '' });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForCopy();
  await settle();
  const cleared = await captureCopy();
  console.log(`  首页（CMS 清空 heroTitle）：title=「${cleared.title}」accent=「${cleared.accent}」`);
  if (cleared.title) {
    problems.push(`口径③：后台把标题清空后官网还在显示「${cleared.title}」—— 空串是运营故意清空，不该回退到兜底（别写 content.x || fallback：空串是 falsy）`);
  }
  if (!cleared.accent) problems.push('口径③：只清空了标题，副标题不该跟着消失');
  await shot('07-home-title-cleared');

  await mutateHome({ stats: [] });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await settle();
  const statsSection = await page.locator('.hp-stats').count();
  if (statsSection) problems.push('口径③：后台把数据区整排删空后官网还在显示数据区（空数组就是不显示）');
  await shot('08-home-stats-cleared');

  // ── ⑧ 骨架屏（静态文件）：强刷闪旧内容的**第二个来源**就在这儿，它不在任何组件里
  const skeletonHtml = fs.readFileSync(path.join(root, 'apps/website/index.html'), 'utf8');
  if (!skeletonHtml.includes('boot-shell')) problems.push('index.html：骨架屏不见了 —— 强刷会白屏一下');
  for (const t of RETIRED_COPY) if (skeletonHtml.includes(t)) problems.push(`index.html 骨架屏里还有退役文案「${t}」`);
  for (const t of [cmsHome.heroTitle, cmsHome.heroAccent]) {
    if (t && skeletonHtml.includes(t)) problems.push(`index.html 骨架屏里写死了首页文案「${t}」—— 文案一变，强刷就会先闪一帧旧内容`);
  }

  if (pageErrors.length) problems.push(`浏览器报错：${[...new Set(pageErrors)].slice(0, 5).join(' | ')}`);
  const failures = [...new Set(badRequests)];
  if (failures.length) problems.push(`请求失败：${failures.slice(0, 6).join(' | ')}`);
  const shots = fs.readdirSync(shotDir).length;
  assert.ok(shots >= 10, `截图没出全（只有 ${shots} 张）`);
  await context.close();
  await browser.close();
  console.log(`\n截图 ${shots} 张 → ${shotDir}`);
  if (problems.length) { console.error('\n发现问题：'); for (const item of problems) console.error('  ✗ ' + item); process.exitCode = 1; }
  else console.log('WEBSITE UI CHECK PASSED');
} catch (error) {
  console.error(serverLog.slice(-2500));
  throw error;
} finally {
  
  if (web) web.kill('SIGTERM');
  server.kill('SIGTERM');
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
}
