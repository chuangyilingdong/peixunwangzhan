#!/usr/bin/env node
/**
 * P189 机构端「学生学习结果与作品」：点「查看作品」必须是**弹窗**（2026-10-18）
 *
 * 用户报：作品管理列表里 **画布作品** 点「查看作品」没反应（VibeCoding 作品能点开）。
 * 真因**不是权限、也不是数据**：画布作品的预览是"在列表最底部就地渲染一个面板"
 * （`{selectedWork && <Panel title="作品内容 · …">}`，还排在「待处理举报」后面），
 * 点完不滚动、面板落在屏幕外 —— 看起来就是"没反应"；VibeCoding 作品走的是 `ClassroomWork` 弹窗，
 * 所以那几行是好的。这一轮改成**所有作品都走同一个预览弹窗**，并把画布包进有确定高度的容器
 * （`.cv-dialog__preview` 给 420px，否则「创作画布」那一档会塌成 0 高）。
 *
 * 本守卫钉四件事（真浏览器，静态断言抓不到"面板在屏幕外"这类问题）：
 *   ① 点画布作品的「查看作品」→ **出现 `<dialog>`**，里面有作品标题 /「作品内容」「创作画布」/ 学生名；
 *   ② 切「创作画布」→ 画布**有高度**（>300px）；
 *   ③ 「关闭预览」→ 弹窗关掉；
 *   ④ 源码口径：`openWork` 只走弹窗、页面里不再有那个内联「作品内容 · ${selectedWork…}」面板。
 *
 * 跑法（需要 node ≥ 20 与 Chrome/Chromium；本机 node 16 跑不了，服务器上跑）：
 *   node scripts/p189-org-works-preview.mjs
 *   CHROME_PATH=/usr/bin/chromium-browser node scripts/p189-org-works-preview.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p189-org-works-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = process.env.PLATFORM_DATA_DIR || temp;
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const API_PORT = 18789;
const WEB_PORT = 6177;
const env = { ...process.env, DEPLOYMENT_MODE: 'development', AI_PROVIDER: 'local-mock', AI_PROVIDER_API_KEY: '', PORT: String(API_PORT) };

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { out += x; });
  child.on('close', (code) => (code ? reject(new Error(out || `exit ${code}`)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ── 夹具：seed + 一间由 teacher-1 上的课堂，再挂一件**画布作品** ────────────────── */
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);
const teacher = await arow("SELECT * FROM users WHERE login='teacher-1'");
const session = await arow("SELECT * FROM class_sessions WHERE teacher_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1", [teacher.id]);
const part = await arow("SELECT * FROM session_students WHERE session_id=? AND status='ACTIVE' LIMIT 1", [session.id]);
const student = await arow('SELECT display_name FROM users WHERE id=?', [part.student_id]);
const now = new Date().toISOString();
const WORK_TITLE = 'P189 画布作品 · 电子宠物';
const snapshot = JSON.stringify({
  nodes: [{ id: 'n1', type: 'text', position: { x: 60, y: 60 }, data: { text: 'P189 画布节点' }, width: 220, height: 90 }],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});
await aq(`INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at,class_session_id)
  VALUES(?,?,?,?,?,?, 'SUBMITTED', ?,1,?,?,?,?)`,
['project_p189', part.student_id, teacher.org_id, null, session.lesson_id, WORK_TITLE, snapshot, now, now, now, session.id]);
await aq(`INSERT INTO works(id,project_id,student_id,org_id,class_id,course_lesson_id,title,description,canvas_snapshot,status,submitted_at,class_session_id)
  VALUES(?,?,?,?,?,?,?,?,?,'PENDING',?,?)`,
['work_p189', 'project_p189', part.student_id, teacher.org_id, null, session.lesson_id, WORK_TITLE, 'P189 夹具说明', snapshot, now, session.id]);

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
let web = null;
const api = async (pathname, init = {}) => {
  const response = await fetch(`http://127.0.0.1:${API_PORT}${pathname}`, {
    method: init.method || 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, data: body.data ?? body };
};
let browser = null;
try {
  for (let i = 0; i < 120; i += 1) { try { if ((await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok) break; } catch { /* 等 */ } await sleep(100); }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'teacher-1', password: 'teach123' } });
  const token = login.data?.token;
  if (!token) throw new Error(`teacher login failed: ${JSON.stringify(login).slice(0, 200)}`);

  // ⚠️ preview 之前必须构建：否则 serve 的是旧 dist，守卫会对着旧产物绿（p111/p115 同一口径）。
  await run(['node_modules/vite/bin/vite.js', 'build', 'apps/org', '--config', 'apps/org/vite.config.mjs']);
  // ⚠️ org 的 vite 配置把 preview 端口写死成 6175（p111 也在用）—— 这里显式指定端口，
  //    免得并行跑套件时两条守卫抢同一个端口。
  web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', 'apps/org', '--config', 'apps/org/vite.config.mjs', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: root, env: { ...env, VITE_DEV_API_TARGET: `http://127.0.0.1:${API_PORT}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let webLog = '';
  web.stdout.on('data', (x) => { webLog += x; });
  web.stderr.on('data', (x) => { webLog += x; });
  const base = `http://localhost:${WEB_PORT}/org`;
  let webUp = false;
  for (let i = 0; i < 120; i += 1) { try { if ((await fetch(`${base}/`)).ok) { webUp = true; break; } } catch { /* 等 */ } await sleep(250); }
  if (!webUp) throw new Error(`vite preview 没起来（${base}）：\n${webLog.slice(-1200)}`);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  await page.addInitScript(([stored]) => {
    window.localStorage.setItem('ai-kids-platform.session.v1.org', JSON.stringify(stored));
  }, [{ token, expiresAt: login.data.expiresAt, user: login.data.user, organization: login.data.organization }]);

  await page.goto(`${base}/works`, { waitUntil: 'domcontentloaded' });
  await page.getByText(WORK_TITLE, { exact: false }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);

  // 点这一行的「查看作品」
  const row = page.locator('tr', { hasText: WORK_TITLE }).first();
  await row.getByRole('button', { name: '查看作品' }).click();

  const dialog = page.locator('dialog[open]');
  const opened = await dialog.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  check('① 点画布作品的「查看作品」→ 弹出对话框（不再是把面板渲染到页面底部）', opened);
  if (opened) {
    const firstText = await dialog.innerText().catch(() => '');
    check('① 弹窗里有作品标题', firstText.includes(WORK_TITLE), firstText.slice(0, 160));
    // 详情是异步取的（先显示「正在读取私有作品…」）—— 等两档页签出现再断言/点击。
    const tab = dialog.getByRole('button', { name: '创作画布' });
    const tabReady = await tab.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    // 有媒体时给「作品内容 / 创作画布」两档；没有媒体（本夹具）就直接给画布 —— 两种都算加载完成。
    const canvasReady = await dialog.locator('.learning-canvas').waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    check('① 作品详情加载完成（有媒体→两档页签；无媒体→直接画布）', tabReady || canvasReady);
    const text = await dialog.innerText().catch(() => '');
    check('① 弹窗里有学生名（机构端读面）', text.includes(String(student?.display_name || '')), text.slice(0, 160));

    if (tabReady) await tab.click();
    await page.waitForTimeout(600);
    const canvasHeight = await page.evaluate(() => {
      const node = document.querySelector('dialog[open] .learning-canvas');
      return node ? Math.round(node.getBoundingClientRect().height) : 0;
    });
    check('② 「创作画布」有高度（>300px；没有 .cv-dialog__preview 时会塌成 0）', canvasHeight > 300, `${canvasHeight}px`);

    await dialog.getByRole('button', { name: '关闭预览' }).click().catch(() => {});
    await page.waitForTimeout(300);
    const closed = await page.locator('dialog[open]').count();
    check('③ 「关闭预览」把弹窗关掉了', closed === 0, `还剩 ${closed} 个打开的 dialog`);
  }

  // ④ 源码口径：不再把画布作品的预览渲染成页面里的内联面板
  const orgMain = fs.readFileSync(path.join(root, 'apps/org/src/main.jsx'), 'utf8');
  check('④ 源码：openWork 只走弹窗、页面里没有内联的「作品内容 · …」面板',
    /function openWork\(work\)\s*\{\s*setPreviewWork\(work\);/.test(orgMain)
    && !/作品内容 · \$\{selectedWork/.test(orgMain));
} catch (error) {
  failures += 1;
  console.error('P189 抛错：', error?.message || error);
  console.error(serverLog.split('\n').slice(-10).join('\n'));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  if (web) web.kill('SIGTERM');
}

console.log(JSON.stringify({ name: 'org-works-preview', pass: failures === 0, failures }, null, 2));
process.exit(failures ? 1 : 0);
