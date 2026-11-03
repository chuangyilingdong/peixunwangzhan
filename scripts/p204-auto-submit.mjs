/**
 * P204 「课堂结束自动补交」守卫（2026-11-03）。
 *
 * 用户口径：学生忘了提交，老师结束课堂后要尽量自动交上来；已经交过的不能重复/覆盖。
 * VibeCoding 的作品在学生电脑上，所以平台只提供**课后 10 分钟宽限**：
 * 客户端在结束前缓存课堂 id，发现结束后带 `sessionId + autoSubmit` 补交。
 *
 * 这一道钉住：
 *   ① 结束后 10 分钟内，autoSubmit 能交上新任务，并标记 auto_submitted=1、版权未确认；
 *   ② 学生**手动交过**的同任务，自动提交不覆盖（autoSubmitSkipped，round 不变）；
 *   ③ 超过宽限期 → 403 AUTO_SUBMIT_WINDOW_CLOSED；
 *   ④ 不在名单里的学生 → 403；
 *   ⑤ 老的「不带 autoSubmit」路径不受影响（课后仍然拒绝）。
 *
 * 跑法：node scripts/p204-auto-submit.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p204-auto-submit-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const PORT = 18990;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p204-guard-secret',
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
  const enrolled = await arow(`SELECT student.id, student.login, student.org_id FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id AND session.status='ACTIVE'
       JOIN users student ON student.id = part.student_id
      WHERE part.status='ACTIVE' ORDER BY student.created_at LIMIT 1`);
  assert.ok(enrolled?.login, '夹具没把任何学生放进课堂');
  const token = await login(enrolled.login, 'study123');
  const orgToken = await login('org-admin', 'org123');
  assert.ok(token && orgToken, '登录失败');

  const context = await api('/api/student/runtime/client-context', { token });
  const sessionId = context.data?.classroom?.id;
  assert.ok(sessionId, 'client-context 没有 classroom');
  const upload = (body) => api('/api/student/runtime/submit-upload', { method: 'POST', token, body });
  const html = '<!doctype html><html><body><h1>P204</h1></body></html>';

  const manual = await upload({
    name: 'index.html', taskId: 'manual-task', copyrightConfirmed: true,
    files: [{ name: 'index.html', content: html, binary: false }],
  });
  await check('课前：学生手动提交任务 manual-task → 200', () => {
    assert.equal(manual.status, 200, JSON.stringify(manual.data).slice(0, 300));
    assert.equal(manual.data?.autoSubmitted, false);
  });

  const ended = await api(`/api/org/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST', token: orgToken, body: {} });
  await check('老师结束课堂 → ENDED', async () => {
    assert.equal(ended.status, 200, JSON.stringify(ended.data).slice(0, 300));
    const row = await arow('SELECT status FROM class_sessions WHERE id=?', [sessionId]);
    assert.equal(row?.status, 'ENDED');
  });

  const auto = await upload({
    name: 'index.html', taskId: 'auto-task', sessionId, autoSubmit: true, copyrightConfirmed: false,
    files: [{ name: 'index.html', content: html, binary: false }],
  });
  await check('结束后 10 分钟内：新任务 autoSubmit → 200，标记为自动提交', () => {
    assert.equal(auto.status, 200, JSON.stringify(auto.data).slice(0, 300));
    assert.equal(auto.data?.autoSubmitted, true);
    assert.equal(auto.data?.works?.[0]?.autoSubmitted, true);
  });
  await check('自动提交落库：auto_submitted=1、版权未确认、round=1', async () => {
    const row = await arow("SELECT auto_submitted, copyright_confirmed_at, round FROM vibecoding_submissions WHERE client_task_id='auto-task'");
    assert.ok(row, '没有落库');
    assert.equal(Number(row.auto_submitted), 1);
    assert.equal(row.copyright_confirmed_at, null);
    assert.equal(Number(row.round), 1);
  });

  const skipped = await upload({
    name: 'index.html', taskId: 'manual-task', sessionId, autoSubmit: true, copyrightConfirmed: false,
    files: [{ name: 'index.html', content: html, binary: false }],
  });
  await check('手动交过的任务：自动提交不覆盖（autoSubmitSkipped，round 不变）', async () => {
    assert.equal(skipped.status, 200, JSON.stringify(skipped.data).slice(0, 300));
    assert.equal(skipped.data?.autoSubmitSkipped, true);
    assert.equal(skipped.data?.autoSubmitted, false);
    const row = await arow("SELECT auto_submitted, round, copyright_confirmed_at FROM vibecoding_submissions WHERE client_task_id='manual-task'");
    assert.equal(Number(row.auto_submitted), 0);
    assert.equal(Number(row.round), 1);
    assert.ok(row.copyright_confirmed_at, '手动提交的版权确认不能被抹掉');
  });

  // 造一个不在本场名单里的学生（复用种子里那个学生的密码散列，保证 study123 能登录）。
  const seedPassword = await arow('SELECT password_hash FROM users WHERE id=?', [enrolled.id]);
  assert.ok(seedPassword?.password_hash, '种子学生密码缺失');
  const outsiderLogin = 'p204-outsider';
  await aq(`INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at)
    VALUES (?,?,?,?, 'STUDENT', '[]', ?, 'ACTIVE', ?, ?)`,
  ['p204_outsider', enrolled.org_id, outsiderLogin, 'P204 外部学生', seedPassword.password_hash,
    new Date().toISOString(), new Date().toISOString()]);
  await check('不在名单里的学生：autoSubmit → 403', async () => {
    const otherToken = await login(outsiderLogin, 'study123');
    const forbidden = await api('/api/student/runtime/submit-upload', {
      method: 'POST', token: otherToken,
      body: {
        name: 'index.html', taskId: 'other-task', sessionId, autoSubmit: true, copyrightConfirmed: false,
        files: [{ name: 'index.html', content: html, binary: false }],
      },
    });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.data).slice(0, 300));
    assert.equal(forbidden.data?.error?.code, 'AUTO_SUBMIT_WINDOW_CLOSED');
  });

  await aq('UPDATE class_sessions SET ended_at=? WHERE id=?', [new Date(Date.now() - 20 * 60 * 1000).toISOString(), sessionId]);
  await check('超过 10 分钟宽限：autoSubmit → 403 AUTO_SUBMIT_WINDOW_CLOSED', async () => {
    const expired = await upload({
      name: 'index.html', taskId: 'late-task', sessionId, autoSubmit: true, copyrightConfirmed: false,
      files: [{ name: 'index.html', content: html, binary: false }],
    });
    assert.equal(expired.status, 403, JSON.stringify(expired.data).slice(0, 300));
    assert.equal(expired.data?.error?.code, 'AUTO_SUBMIT_WINDOW_CLOSED');
  });

  await check('老的「不带 autoSubmit」路径：课后仍然拒绝（行为不变）', async () => {
    const plain = await upload({
      name: 'index.html', taskId: 'plain-task', sessionId, copyrightConfirmed: true,
      files: [{ name: 'index.html', content: html, binary: false }],
    });
    assert.equal(plain.status, 403, JSON.stringify(plain.data).slice(0, 300));
    assert.equal(plain.data?.error?.code, 'RUNTIME_NO_ACTIVE_CLASSROOM');
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
