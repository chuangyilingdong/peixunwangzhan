/**
 * P176 画布课堂**真浏览器**守卫（2026-10-02，补 §55.4 那条欠账）。
 *
 * 背景（§五十五）：**P0 学生进画布课堂整页白屏**（`Cannot read properties of null
 * (reading 'canvasSnapshot')`）是**用户点出来的**，当时 179 条守卫一条都没红 ——
 * 静态网只能挡"写法"，挡不住"首帧就崩"。§55.4 写了方案，这一条就是照它落的：
 *   起夹具（seed + 画布课堂）→ 学生登录 → **真 Chrome** 打开 `/learn/canvas`（课程中心）
 *   与 `/learn/canvas/:projectId`（画布工作区）→ 断言外壳真的渲染 + **零 uncaught**。
 * 这样"首帧崩 / 白屏"这一类（React #300、提前 return 里的空引用、hook 数量变化…）
 * **无论如何都跑不掉** —— 和 p111（机构端）、p115（官网）、p175（多语言）同一套手法。
 *
 * 跑法：node scripts/p176-canvas-classroom-browser.mjs   （要 Chrome；约 40–70 秒）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p176-canvas-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;

const PORT = 18976;
const WEB_PORT = 6179;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p176-secret',
  PORT: String(PORT),
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const api = async (name, init = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/${name}`, {
    method: init.method || 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  let data = null; try { data = await response.json(); } catch { /* 空响应体 */ }
  // ⚠️ 应用接口返回的是**包装体** `{ success, data: {...} }`（p13/p100 的助手都先解包再交出去）——
  //    不解包的话 `data.token` 是 undefined，下面拿它当 Bearer 就是 401（第一版就栽在这）。
  return { status: response.status, data: data && typeof data === 'object' && 'data' in data ? data.data : data };
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (x) => { serverLog += x; }); server.stderr.on('data', (x) => { serverLog += x; });
let web = null; let webLog = '';
try {
  await run(['packages/database/src/db.js', '--init']);
  await run(['packages/database/src/seed.js']);
  // 服务器是**先于** init/seed 起的（与 p175 同序）——SQLite 每次查询现开文件，初始化晚没关系，
  // 但必须等它真的在监听再发第一个请求，否则 fetch 直接 ECONNREFUSED。
  let apiUp = false;
  for (let i = 0; i < 120; i += 1) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { apiUp = true; break; } } catch { /* 等 */ } await sleep(150); }
  assert.ok(apiUp, `后端没起来：${serverLog.slice(-600)}`);

  // 夹具：让 seed 出来的每个学生 × 每节已发布课时都有一间 ACTIVE 课堂并进名单；
  // 再把课堂**切到画布**（requireSupports:false —— 连 VibeCoding 课时也切成画布课堂，
  // 这里只验"打开画布课堂"这一件事，不管能力闸）。
  const { ensureClassroom, switchClassroom } = await import('./lib/classroomFixture.mjs');
  await ensureClassroom(dbPath);
  const switched = await switchClassroom(dbPath, { deliveryMode: 'CANVAS', requireSupports: false });
  assert.ok(Array.isArray(switched), '夹具 switchClassroom 应返回数组');

  const login = await api('auth/login', { method: 'POST', body: { login: 'student-1', password: 'study123' } });
  assert.equal(login.status, 200, `student-1 登录失败：${JSON.stringify(login.data).slice(0, 200)}`);
  const token = login.data.token;

  // 找一节（非 VibeCoding 的）已发布课时，幂等建出/取回该课堂的创作 → 得到 projectId
  const { arows } = await import('../packages/database/src/store.js');
  const lesson = (await arows(
    `SELECT l.id, l.title FROM course_lessons l
      JOIN student_course_grants g ON g.series_id = l.series_id AND g.revoked_at IS NULL
      JOIN users u ON u.id = g.student_id AND u.login = 'student-1'
     WHERE l.status = 'PUBLISHED' AND l.delivery_mode != 'VIBECODING' LIMIT 1`, [])).at(0);
  assert.ok(lesson, 'seed + 夹具之后应当至少有一节可进的非 VibeCoding 课时');
  const created = await api('student/projects', {
    method: 'POST', token,
    body: { courseLessonId: lesson.id, title: `${lesson.title || '今日课堂'} · 我的创作`, canvasSnapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } },
  });
  assert.equal(created.status, 200, `创建画布项目失败：${JSON.stringify(created.data).slice(0, 240)}`);
  const projectId = created.data.id;
  assert.ok(projectId, '应返回项目 id');

  await run(['node_modules/vite/bin/vite.js', 'build', 'apps/website', '--config', 'apps/website/vite.config.mjs']);
  web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', 'apps/website', '--config', 'apps/website/vite.config.mjs', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: root, env: { ...baseEnv, VITE_DEV_API_TARGET: `http://127.0.0.1:${PORT}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stdout.on('data', (x) => { webLog += x; }); web.stderr.on('data', (x) => { webLog += x; });
  const base = `http://localhost:${WEB_PORT}`;
  let up = false;
  for (let i = 0; i < 100; i += 1) { try { const res = await fetch(base); if (res.ok) { up = true; break; } } catch { /* 等 */ } await sleep(200); }
  assert.ok(up, `vite preview 没起来：${webLog.slice(-600)}`);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // ⚠️ 未经处理的异常才算数（这就是"白屏 P0"的形态）；普通 console.error 不算 —— 夹具环境里
  //    资源 404 之类的噪音不可控，而且它们不构成"页面画不出来"。
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));

  // 学生会话直接写进 localStorage 的学生桶（与 p111 同一套：这里要验的是课堂页本身，不重考登录页）
  await page.addInitScript(([session]) => {
    window.localStorage.setItem('ai-kids-platform.session.v1.student', JSON.stringify(session));
  }, [{ token, expiresAt: login.data.expiresAt, user: login.data.user, organization: login.data.organization || null }]);

  // ── ① 画布课程中心（/learn/canvas → CanvasClassroom）────────────────────────
  await page.goto(`${base}/learn/canvas`, { waitUntil: 'domcontentloaded' });
  // 等它从 Loading 走出来（后台没有东西可等时也别吊死：给足时间后照样断言）
  await page.waitForSelector('.classroom-center', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const hub = await page.evaluate(() => ({
    center: Boolean(document.querySelector('.classroom-center')),
    packages: document.querySelectorAll('.course-package-card').length,
    fallback: document.body.innerText.includes('这一页没能画出来'),
    loginRedirect: Boolean(document.querySelector('form')),
  }));
  check('① 画布课程中心渲染出外壳（.classroom-center）', hub.center, JSON.stringify(hub));
  check('① 课程中心不是错误兜底页，也没被踢回登录', !hub.fallback && !hub.loginRedirect, JSON.stringify(hub));
  check('① 课程中心有课程包可选（seed + 夹具之后至少 1 个）', hub.packages >= 1, `packages=${hub.packages}`);

  // ── ② 画布工作区（/learn/canvas/:projectId → CanvasWorkspace）───────────────
  //    §五十五 那个 P0 就崩在这一步（首帧读 null.canvasSnapshot）—— 这条就是它的网。
  await page.goto(`${base}/learn/canvas/${encodeURIComponent(projectId)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cv-viewport', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const workspace = await page.evaluate(() => ({
    viewport: Boolean(document.querySelector('.cv-viewport')),
    editorCanvas: Boolean(document.querySelector('.cv-viewport canvas, .cv-viewport .canvas-editor, .cv-viewport [class*="canvas"]')),
    fallback: document.body.innerText.includes('这一页没能画出来'),
    loginRedirect: Boolean(document.querySelector('form')),
    textHead: document.body.innerText.replace(/\n+/g, ' | ').slice(0, 200),
  }));
  check('② 画布工作区渲染出外壳（.cv-viewport）', workspace.viewport, JSON.stringify(workspace.textHead));
  check('② 工作区不是错误兜底页，也没被踢回登录', !workspace.fallback && !workspace.loginRedirect, JSON.stringify(workspace.textHead));

  // ── ③ 两条路都**零 uncaught** ────────────────────────────────────────────────
  check('③ 全程零 uncaught 异常（§55.4 的口径）', pageErrors.length === 0, pageErrors.slice(0, 3).join(' ; ').slice(0, 300));

  await page.screenshot({ path: path.join(temp, 'p176-canvas-workspace.png'), fullPage: false }).catch(() => {});
  if (process.env.SUITE_KEEP_LOGS) console.log(`  · 截图与日志目录：${temp}`);
  await browser.close();
} catch (error) {
  failures += 1;
  console.error('P176 抛错：', error?.message || error);
  console.error(serverLog.split('\n').slice(-12).join('\n'));
} finally {
  server.kill('SIGTERM');
  if (web) web.kill('SIGTERM');
}

if (failures) { console.error(JSON.stringify({ name: 'p176-canvas-classroom-browser', pass: false, failed: failures }, null, 1)); process.exit(1); }
console.log('PASS: 画布课堂真浏览器（课程中心 + 工作区外壳渲染、零 uncaught）');
