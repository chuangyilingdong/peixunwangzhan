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
const env = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
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
const NAV_LABELS = ['首页', '灵动学习', '灵动课程', '灵动作品', '灵动介绍', '机构手册', '常见问题'];
// 品牌名只认这一个（用户口径 2026-09-18）。
const BRAND_NAME = '灵动ai学院';

console.log('准备临时库 + 构建官网…');
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
// seed 会把 websiteContentDefaults 写进 website_contents 并**直接发布** ——
// 所以新库的「CMS 当前内容」就是那份种子。守卫要在这上面验（这也正是新环境会看到的）。
await run(['node_modules/vite/bin/vite.js', 'build', 'apps/website', '--config', 'apps/website/vite.config.mjs']);

// 从库里读出「CMS 当前内容」，用来验「接口回来前不渲染」不是空转（得先知道应该出现什么）
const seedDb = new DatabaseSync(dbPath);
seedDb.exec('PRAGMA busy_timeout = 5000');
const homeRow = seedDb.prepare("SELECT published_content FROM website_contents WHERE content_key='HOME'").get();
assert.ok(homeRow, 'fixture: seed 之后 HOME 应该已在 website_contents 里');
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

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
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
  // 写临时库的小工具。口径与 packages/database/src/schema.js 一致：连接必须有 busy_timeout，
  // 写事务用 BEGIN IMMEDIATE（否则「延迟事务升级」会死锁 —— 这是第十六轮挖出来的真根因）。
  const withDb = (fn) => {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
  };
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

  // 导航七项：文案与顺序
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

  // 首页大标题：字号按字数自适应，**不许折行、不许被裁**
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
  const homeVideoSrc = await page.locator('.hp-video').getAttribute('src');
  if (homeVideoSrc !== '/assets/hero-animal.mp4') problems.push(`首页：背景视频不是自托管的 hero-animal.mp4（实际 ${homeVideoSrc}）`);

  // ── ② 接口回来前不渲染文案（口径②）：定向延迟 CMS 响应，看首帧
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
  const mpSeed = seedDb.prepare("SELECT published_content FROM website_contents WHERE content_key='MARKETPLACE'").get();
  assert.ok(mpSeed, 'fixture: seed 之后 MARKETPLACE 应该已在库里（新增 CMS 键要同时改白名单 / 标签 / 种子 / 表单四处）');
  const cmsPatch = JSON.stringify({ title: '课包展示（CMS 联调）', lead: '副标题来自 CMS 的联调文案。' });
  withDb((db) => db.prepare("UPDATE website_contents SET draft_content=?, published_content=?, updated_at=? WHERE content_key='MARKETPLACE'").run(cmsPatch, cmsPatch, new Date().toISOString()));

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
      priceText: first.querySelector('.mp-price strong')?.textContent || '',
      // 价格与按钮是否**同一行**（用户口径：参考稿是并排、价格在左，不是上下堆叠）
      priceRight: first.querySelector('.mp-price') ? Math.round(first.querySelector('.mp-price').getBoundingClientRect().right) : null,
      ctaLeft: cta ? Math.round(cta.getBoundingClientRect().left) : null,
      priceCenterY: first.querySelector('.mp-price') ? Math.round(first.querySelector('.mp-price').getBoundingClientRect().top + first.querySelector('.mp-price').getBoundingClientRect().height / 2) : null,
      ctaCenterY: cta ? Math.round(cta.getBoundingClientRect().top + cta.getBoundingClientRect().height / 2) : null,
      featuresOpacity: features ? getComputedStyle(features).opacity : null,
    };
  });
  if (!rowGeo) problems.push('灵动课程：取不到课包行的几何与文案');
  else {
    console.log(`  · 灵动课程：缩略图 ${rowGeo.coverWidth}×${rowGeo.coverHeight}px、参数 ${rowGeo.featureCount} 项 [${rowGeo.featureLabels.join(' / ')}]、价格「${rowGeo.priceText}」、CTA「${rowGeo.ctaText}」→ ${rowGeo.ctaHref}`);
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
    if (!/¥|价格面议/.test(rowGeo.priceText)) problems.push(`灵动课程：价格位上既不是价格也不是「价格面议」（实际「${rowGeo.priceText}」）`);
    // 价格在左、按钮在右，**同一行**（价格块的右边不出按钮的左边界、两者中线基本齐平）
    if (rowGeo.priceRight != null && rowGeo.ctaLeft != null && rowGeo.priceRight > rowGeo.ctaLeft + 2) {
      problems.push(`灵动课程：价格跑到按钮右边去了（价格右边缘 ${rowGeo.priceRight} > 按钮左边缘 ${rowGeo.ctaLeft}）—— 口径是价格在左`);
    }
    if (rowGeo.priceCenterY != null && rowGeo.ctaCenterY != null && Math.abs(rowGeo.priceCenterY - rowGeo.ctaCenterY) > 8) {
      problems.push(`灵动课程：价格与按钮不在同一行（中线差 ${Math.abs(rowGeo.priceCenterY - rowGeo.ctaCenterY)}px）—— 参考稿是并排，不是上下堆叠`);
    }
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
  const seriesId = withDb((db) => db.prepare("SELECT id FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED' AND visibility='PUBLIC' ORDER BY sort LIMIT 1").get()?.id);
  assert.ok(seriesId, 'fixture: 库里应当有一个已发布的平台课包');
  withDb((db) => db.prepare('UPDATE course_series SET price_fen=?, cover_image_url=?, updated_at=? WHERE id=?').run(19900, '/assets/lingdong-ai-logo.png', new Date().toISOString(), seriesId));
  await page.goto(`${base}/marketplace`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i += 1) { if (await page.locator('.mp-row').count()) break; await page.waitForTimeout(250); }
  await settle();
  const priced = await page.evaluate(() => {
    const first = document.querySelector('.mp-row');
    if (!first) return null;
    const cover = first.querySelector('.mp-cover');
    return { price: first.querySelector('.mp-price strong')?.textContent || '', coverHasImage: cover ? cover.classList.contains('has-image') : false, background: cover ? getComputedStyle(cover).backgroundImage : '' };
  });
  console.log(`  · 灵动课程（写入价格 199 元 / 封面后）：价格「${priced?.price}」封面=${priced?.coverHasImage}`);
  if (!priced || !String(priced.price).includes('199')) problems.push(`灵动课程：给课包写了 price_fen=19900，列表却没显示 ¥199（实际「${priced?.price}」）—— 公开接口是不是又漏下发 priceFen 了`);
  if (!priced?.coverHasImage || !String(priced.background).includes('lingdong-ai-logo.png')) problems.push('灵动课程：给课包写了封面地址，缩略图却没渲染出来 —— 公开接口是不是又漏下发 coverAssetId / coverImageUrl 了');
  await shot('10-marketplace-priced');

  // ── ⑤b 灵动课程：**没有任何筛选**（用户口径 2026-09-18 晚「筛选删除」）。
  //    ⚠️ 我上一轮把那两个「画布 / VibeCoding」分类按钮做到了这一页，用户指出地方错了
  //    （那是「灵动作品」的），所以这里改成断言"一个筛选节点都不该有"，包括 .mp-cats。
  for (const gone of ['.mp-cats', '.mp-cat', '.mp-filter-bar', '.mp-filter-toggle', '.mp .mkt-filters', '.mp .mkt-search', '#marketplace-search']) {
    if (await page.locator(gone).count()) problems.push(`灵动课程：这一页不该有任何筛选，却还有 ${gone}`);
  }

  // ── ⑤c 灵动作品：分类只有两个（画布 / VibeCoding）+ 搜索框 + 卡片按 zip 重做
  await page.goto(`${base}/works`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i += 1) { if (await page.locator('.work').count()) break; await page.waitForTimeout(250); }
  await settle();
  // ① 原来的分类筛选整块不要了（页面里那个「全部作品 / 小游戏 / 互动故事…」的 chips）
  if (await page.locator('.filters').count()) problems.push('灵动作品：分类筛选块应已删除（用户口径：这里全部不要）');
  // 同批删掉的还有页头与底部那条提示（用户：「图1这里怎么还在」「图2也要删除」）
  if (await page.locator('.page-title').count()) problems.push('灵动作品：页头（学员作品 / 孩子们的灵感，正在发光 / 描述）应已删除');
  if ((await bodyText()).includes('作品来自真实课堂')) problems.push('灵动作品：底部那条「作品来自真实课堂」提示应已删除');
  if ((await bodyText()).includes('了解机构作品展厅')) problems.push('灵动作品：底部那条提示里的「了解机构作品展厅」按钮应已删除');
  // 分类只有两个：画布 / VibeCoding（用户口径 2026-09-18 晚「筛选就分为 2 个板块」——
  // ⚠️ 说的**是这一页**，我上一轮做错到灵动课程上了，见 ⑤b 的注释）。
  const workCatLabels = (await page.locator('.works-cats .works-cat').allInnerTexts()).map((t) => t.trim());
  console.log(`  · 灵动作品分类：[${workCatLabels.join(' / ')}]`);
  if (workCatLabels.join('|') !== '画布|VibeCoding') problems.push(`灵动作品：分类应只有两个板块 [画布|VibeCoding]（实际 [${workCatLabels.join('|')}]）`);
  const allWorks = await page.locator('.work').count();
  await page.locator('.works-cats .works-cat').nth(1).click(); // VibeCoding（种子里那几条兜底作品都是画布 → 应当清空）
  await page.waitForTimeout(400);
  const vibeWorks = await page.locator('.work').count();
  const workCatPressed = await page.locator('.works-cats .works-cat').nth(1).getAttribute('aria-pressed');
  console.log(`  · 点 VibeCoding：作品 ${allWorks} → ${vibeWorks}、aria-pressed=${workCatPressed}`);
  if (workCatPressed !== 'true') problems.push('灵动作品：点分类后 aria-pressed 应当是 true');
  if (allWorks && vibeWorks >= allWorks) problems.push(`灵动作品：选了 VibeCoding 之后条数没变（${allWorks} → ${vibeWorks}）—— 分类没真的生效`);
  if (!vibeWorks && !(await page.locator('.note').count())) problems.push('灵动作品：分类筛成空时应当有一句空态提示');
  await page.locator('.works-cats .works-cat').nth(1).click(); // 再点一次取消 → 回到全部
  await page.waitForTimeout(400);
  if ((await page.locator('.work').count()) !== allWorks) problems.push(`灵动作品：再点一次应当取消分类、回到全部（${allWorks} → ${await page.locator('.work').count()}）`);
  await shot('13-works-category');
  // ② 换成搜索框
  if (!(await page.locator('#works-search').count())) problems.push('灵动作品：没找到搜索框（#works-search）');
  const workCount = await page.locator('.work').count();
  if (!workCount) problems.push('灵动作品：一张卡片都没有');
  const cardGeo = await page.evaluate(() => {
    const card = document.querySelector('.work');
    if (!card) return null;
    const art = card.querySelector('.art');
    const title = card.querySelector('.work-title');
    const foot = card.querySelector('.work-foot');
    const artBox = art ? art.getBoundingClientRect() : null;
    return {
      cardRadius: Math.round(parseFloat(getComputedStyle(card).borderRadius)),
      cardBg: getComputedStyle(card).backgroundColor,
      artRatio: artBox && artBox.height ? +(artBox.width / artBox.height).toFixed(2) : null,
      artRadius: art ? Math.round(parseFloat(getComputedStyle(art).borderRadius)) : null,
      titleWrap: title ? getComputedStyle(title).whiteSpace : null,
      titleEllipsis: title ? getComputedStyle(title).textOverflow : null,
      footDisplay: foot ? getComputedStyle(foot).display : null,
      footSpans: foot ? foot.querySelectorAll('span').length : null,
      buttonsInside: card.querySelectorAll('button').length,
      hitLinks: card.querySelectorAll('.work-hit').length,
      heights: { card: card.offsetHeight, art: art?.offsetHeight, body: card.querySelector('.work-body')?.offsetHeight, title: title?.offsetHeight, foot: foot?.offsetHeight },
      bodyStyle: (() => { const b = card.querySelector('.work-body'); if (!b) return null; const s = getComputedStyle(b); return { display: s.display, flex: s.flex, gap: s.gap, minHeight: s.minHeight, padding: s.padding }; })(),
      html: card.innerHTML.replace(/\s+/g, ' ').slice(0, 420),
    };
  });
  console.log(`  · 灵动作品卡片：圆角 ${cardGeo?.cardRadius}px 底色 ${cardGeo?.cardBg}、封面 ${cardGeo?.artRatio}:1 圆角 ${cardGeo?.artRadius}px、` +
    `标题 ${cardGeo?.titleWrap}/${cardGeo?.titleEllipsis}、底部 ${cardGeo?.footDisplay} ${cardGeo?.footSpans} 格高 ${cardGeo?.heights?.foot}px、卡内按钮 ${cardGeo?.buttonsInside}、可点层 ${cardGeo?.hitLinks}`);
  if (!cardGeo) problems.push('灵动作品：取不到卡片几何');
  else {
    // 底部那行必须就是一行（正常 ~20px）。踩过：用 <footer> 会命中全局的页脚样式
    // （padding 64/28/24 + 灰底），把它撑到 108px，卡片里就多出一大块空白。
    if (cardGeo.heights && cardGeo.heights.foot > 32) {
      problems.push(`灵动作品：底部那行高度异常（${cardGeo.heights.foot}px，正常一行约 20px）—— 大概率又命中全局的 footer 样式了`);
    }
    // 卡高与内容的差 = 内外边距 + 行高（正常约 70px）；超过 120 就说明有东西在撑高度
    if (cardGeo.heights && cardGeo.heights.card - (cardGeo.heights.art + cardGeo.heights.title + cardGeo.heights.foot) > 120) {
      problems.push(`灵动作品：卡片里多出一大块空白（卡高 ${cardGeo.heights.card} vs 内容 ${cardGeo.heights.art}+${cardGeo.heights.title}+${cardGeo.heights.foot}）`);
    }
    // zip 的设计：白卡、20px 圆角、封面 ≈1.43:1 且圆角 14、标题单行省略、底部一行两格、卡内没有按钮
    if (cardGeo.cardRadius !== 20) problems.push(`灵动作品：卡片圆角应为 20px（实际 ${cardGeo.cardRadius}px）`);
    if (cardGeo.cardBg !== 'rgb(255, 255, 255)') problems.push(`灵动作品：卡片应为白底（实际 ${cardGeo.cardBg}）`);
    if (cardGeo.artRatio == null || Math.abs(cardGeo.artRatio - 1.43) > 0.08) problems.push(`灵动作品：封面比例应≈1.43:1（实际 ${cardGeo.artRatio}:1）`);
    if (cardGeo.artRadius !== 14) problems.push(`灵动作品：封面圆角应为 14px（实际 ${cardGeo.artRadius}px）`);
    if (cardGeo.titleWrap !== 'nowrap' || cardGeo.titleEllipsis !== 'ellipsis') problems.push(`灵动作品：标题应当是单行省略（实际 white-space=${cardGeo.titleWrap} text-overflow=${cardGeo.titleEllipsis}）`);
    if (cardGeo.footDisplay !== 'flex' || cardGeo.footSpans < 2) problems.push(`灵动作品：底部应当是一行两格（学生名 / 机构）`);
    if (cardGeo.buttonsInside) problems.push(`灵动作品：卡片里不该再有按钮（zip 的卡里没有按钮，整卡可点）`);
  }
  // ③ 搜索真的按「标题 / 学生名字」过滤
  const firstTitle = await page.locator('.work .work-title').first().innerText();
  await page.locator('#works-search').fill(firstTitle.trim().slice(0, 3));
  await page.waitForTimeout(300);
  const searched = await page.locator('.work').count();
  const searchedText = await page.locator('.works').innerText();
  console.log(`  · 搜索「${firstTitle.trim().slice(0, 3)}」：${workCount} → ${searched} 件`);
  if (!searched) problems.push(`灵动作品：用第一张卡的标题去搜，一条都没匹配上（搜索没生效）`);
  if (searched > workCount) problems.push('灵动作品：搜索之后条数反而变多了？');
  if (!searchedText.includes(firstTitle.trim().slice(0, 3))) problems.push('灵动作品：搜索结果里没有包含搜索词的那张卡');
  await shot('14-works-search');
  await page.locator('#works-search').fill('');
  await page.waitForTimeout(300);
  if ((await page.locator('.work').count()) !== workCount) problems.push('灵动作品：清空搜索之后没有回到全部');
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
  await shot('17-my-courses');
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
      names: bar ? bar.querySelectorAll('.header-user-name').length : 0,
    };
  });
  console.log(`  · 登录态首页顶栏：「${signedBar.text}」徽标 ${signedBar.badges} 个 宽 ${signedBar.badgeWidth}px 头像 ${signedBar.avatars} 名字 ${signedBar.names} 角色标签 ${signedBar.roleTags}`);
  if (!signedBar.badges || signedBar.badgeWidth < 40) problems.push('首页（已登录）：右上角应当显示账号徽标（.header-user）—— 学生登录后回首页看不到账号就是用户报的那个 bug');
  if (signedBar.text.includes('机构 / 老师登录') || signedBar.text.includes('学生登录')) problems.push('首页（已登录）：不该再显示登录入口');
  // 徽标样式（用户口径 2026-09-18 晚）：「小小创作者」这类**角色标签要删掉**，
  // 参考图是「圆形头像 + 名字 + 小箭头」，没有药丸底框。
  if (signedBar.roleTags) problems.push(`首页徽标：不该再有角色标签（.role-tag，例如「小小创作者」），实际 ${signedBar.roleTags} 个`);
  if (!signedBar.avatars || !signedBar.names) problems.push('首页徽标：应当是「圆形头像 + 名字 + 箭头」的样式（缺 .header-user-avatar / .header-user-name）');
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
  await page.locator('.site-topbar nav a', { hasText: '灵动作品' }).first().click();
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
  const mutateHome = (patch) => {
    const current = withDb((db) => JSON.parse(db.prepare("SELECT published_content FROM website_contents WHERE content_key='HOME'").get().published_content));
    const next = { ...current, ...patch };
    withDb((db) => db.prepare("UPDATE website_contents SET draft_content=?, published_content=?, updated_at=? WHERE content_key='HOME'").run(JSON.stringify(next), JSON.stringify(next), new Date().toISOString()));
    return next;
  };

  mutateHome({ heroTitle: '' });
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

  mutateHome({ stats: [] });
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
  seedDb.close();
  if (web) web.kill('SIGTERM');
  server.kill('SIGTERM');
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
}
