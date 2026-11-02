/**
 * P202 「作品按任务提交」的服务端守卫（2026-11-02 新增）。
 *
 * 背景：桌面客户端的一个工作区可以并行 N 个任务（ZCode session），每个任务各自产出一件作品。
 * 平台原来的判重键只有 `(conversation_id, entry_file)`：
 *   · 两个任务都产出 `index.html` → 后交的覆盖前一个；
 *   · 学生想「任务 A 交一件、任务 B 再交一件」做不到。
 *
 * 这一道钉的是升级后的口径：
 *   ① **不同任务 + 同名入口 = 各自成条**（两件作品，两个 id）；
 *   ② **同一任务 + 同一入口 = 覆盖**（同一个 id，round+1），符合「覆盖没问题」；
 *   ③ **老客户端不传 taskId = 空串**，判重键退化成 `(conversation_id, entry_file)`，行为与改动前完全一致；
 *   ④ 接口回显（`works[]`）与 `/api/student/works` 都带 `taskId`，客户端才能判断「这个任务交过没有」；
 *   ⑤ 任务标识超长要明确报错，不能静默截断（截断会让两个任务撞键）。
 *
 * 跑法：node scripts/p202-client-task-submit.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p202-task-submit-'));
const dbPath = path.join(temp, 'platform.db');
// 与 p119 同一条纪律：脚本自己的库优先（套件会给每个脚本一份临时库，服务子进程必须读同一份）。
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow, arows, isMysql } = await import('../packages/database/src/store.js');

const PORT = 18987;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p202-guard-secret',
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

const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);
await aq("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);
await aq("UPDATE class_sessions SET delivery_mode='VIBECODING'");

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-800)}`);
    await sleep(150);
  }

  const login = async (l, p) => (await api('/api/auth/login', { method: 'POST', body: { login: l, password: p } })).data.token;
  const enrolled = await arow(`SELECT student.login FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id AND session.status='ACTIVE'
       JOIN users student ON student.id = part.student_id
      WHERE part.status='ACTIVE' ORDER BY student.created_at LIMIT 1`);
  assert.ok(enrolled?.login, '夹具没把任何学生放进课堂');
  const token = await login(enrolled.login, 'study123');

  const upload = (body) => api('/api/student/runtime/submit-upload', { method: 'POST', token, body });
  const submit = (taskId, content, { name = 'index.html', title = '任务作品' } = {}) => upload({
    name,
    title,
    copyrightConfirmed: true,
    files: [{ name, content, binary: false }],
    ...(taskId === undefined ? {} : { taskId }),
  });

  const a1 = await submit('task-a', '<h1>A1</h1>');
  await check('第一步：任务 A 交 index.html → 200，回显 taskId',
    () => {
      assert.equal(a1.status, 200, JSON.stringify(a1.data).slice(0, 300));
      assert.equal(a1.data?.taskId, 'task-a', JSON.stringify(a1.data).slice(0, 200));
      assert.equal(a1.data?.works?.[0]?.taskId, 'task-a', 'works[] 也要带 taskId');
    });

  const a2 = await submit('task-a', '<h1>A2</h1>');
  await check('同一任务 + 同一入口再交 → 覆盖（同一个 id，round+1），不会多一件',
    () => {
      assert.equal(a2.status, 200, JSON.stringify(a2.data).slice(0, 300));
      assert.equal(a2.data?.id, a1.data?.id, '同一任务同一产物应当是覆盖，不该生成新 id');
      assert.equal(a2.data?.round, 2, `round 应为 2（实际 ${a2.data?.round}）`);
    });

  const b1 = await submit('task-b', '<h1>B1</h1>');
  await check('⭐ 不同任务 + 同名入口 → 各自成条（两个 id）',
    () => {
      assert.equal(b1.status, 200, JSON.stringify(b1.data).slice(0, 300));
      assert.notEqual(b1.data?.id, a1.data?.id, '不同任务交同名 index.html 不该覆盖任务 A');
      assert.equal(b1.data?.taskId, 'task-b');
      assert.equal(b1.data?.round, 1);
    });

  const a3 = await submit('  task-a  ', '<h1>A3</h1>');
  await check('任务标识两端空白会被裁剪（同一个任务，不该因空格变成新任务）',
    () => {
      assert.equal(a3.status, 200, JSON.stringify(a3.data).slice(0, 300));
      assert.equal(a3.data?.id, a1.data?.id, '裁剪后应命中 task-a');
      assert.equal(a3.data?.round, 3);
    });

  const old1 = await submit(undefined, '<h1>OLD1</h1>');
  const old2 = await submit(undefined, '<h1>OLD2</h1>');
  await check('老客户端（不传 taskId）→ 空串任务，行为与改动前一致：同名入口覆盖',
    () => {
      assert.equal(old1.status, 200, JSON.stringify(old1.data).slice(0, 300));
      assert.equal(old1.data?.taskId, '', '不传 taskId 时回显空串');
      assert.equal(old2.data?.id, old1.data?.id, '老客户端同名入口仍应是覆盖');
      assert.equal(old2.data?.round, 2);
    });

  const aOther = await submit('task-a', '<h1>OTHER</h1>', { name: 'other.html', title: '任务 A 的第二份产物' });
  await check('同一任务 + 不同入口 → 各自成条（任务内多产物仍然支持）',
    () => {
      assert.equal(aOther.status, 200, JSON.stringify(aOther.data).slice(0, 300));
      assert.notEqual(aOther.data?.id, a1.data?.id);
      assert.equal(aOther.data?.taskId, 'task-a');
      assert.equal(aOther.data?.entryFile, 'other.html');
    });

  await check('任务标识超长 → 400 VIBECODING_TASK_ID_TOO_LONG（不静默截断）', async () => {
    const result = await submit('x'.repeat(201), '<h1>too long</h1>');
    assert.equal(result.status, 400, JSON.stringify(result.data).slice(0, 200));
    assert.equal(result.data?.error?.code, 'VIBECODING_TASK_ID_TOO_LONG');
  });

  await check('学生作品列表：不同任务各自一条，且都带 taskId', async () => {
    const listed = await api('/api/student/works', { token });
    assert.equal(listed.status, 200, JSON.stringify(listed.data).slice(0, 200));
    const items = (listed.data?.items || []).filter((item) => item.source === 'VIBECODING');
    // index.html：task-a / task-b / 空串 各一条；other.html：task-a 一条 → 共 4 条
    assert.equal(items.length, 4, `应有 4 条 VibeCoding 作品（实际 ${items.length}）：${JSON.stringify(items.map((i) => [i.taskId, i.entryFile]))}`);
    const ids = new Set(items.map((item) => item.id));
    assert.equal(ids.size, 4, '4 条作品必须是 4 个不同的 id');
    const taskA = items.filter((item) => item.taskId === 'task-a');
    assert.equal(taskA.length, 2, '任务 A 应有两件（index.html + other.html）');
    assert.ok(items.some((item) => item.taskId === 'task-b'), '任务 B 应当独立成条');
    assert.ok(items.some((item) => item.taskId === ''), '老客户端那条应当在（taskId 空串）');
  });

  await check('库里的判重键确实是 (对话, 任务, 产物)：4 行、各自唯一', async () => {
    const rows = await arows(`SELECT conversation_id, client_task_id, entry_file, COUNT(*) n
         FROM vibecoding_submissions GROUP BY conversation_id, client_task_id, entry_file`);
    assert.equal(rows.length, 4, `库里应有 4 组唯一键（实际 ${rows.length}）`);
    assert.ok(rows.every((row) => Number(row.n) === 1), '每组键只能有一行');
  });

  await check('唯一索引已换成三列的（老两列索引必须让位）', async () => {
    const names = isMysql
      ? (await arows("SELECT DISTINCT index_name name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'vibecoding_submissions'")).map((item) => item.name)
      : (await arows("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vibecoding_submissions'")).map((item) => item.name);
    assert.ok(names.includes('idx_vibe_submission_conversation_task_entry'), `缺少新索引：${names.join(',')}`);
    assert.ok(!names.includes('idx_vibe_submission_conversation_entry'), `老的两列索引还在：${names.join(',')}`);
  });
} finally {
  server.kill('SIGTERM');
  await sleep(300);
}

const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.ok ? '' : `\n   ${item.message}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) process.exitCode = 1;
