/**
 * P18 VibeCoding 提交：把作品交给平台（**没有老师点评这一环**）。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 2026-09-11 用户要求彻底取消老师点评，这个脚本从「点评闭环」改成**删除的守卫**：
 *   · 提交仍然可用（轮次、入口文件、创作对话快照都要对）
 *   · 提交后**不再锁创作**，而且可以反复提交（round+1）
 *   · 未确认版权必须被拒
 *   · 机构端的点评接口**必须不存在**（列表/详情/点评三个都不能再应答）——
 *     这是「功能真的删掉了」的那道闸：哪天有人把路由加回来，这里会红
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p18-vibecoding-submit-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const { DatabaseSync } = await import('node:sqlite');
const seedDb = new DatabaseSync(dbPath);
const lesson = seedDb.prepare('SELECT id FROM course_lessons ORDER BY sort LIMIT 1').get();
seedDb.prepare("UPDATE course_lessons SET delivery_mode='VIBECODING' WHERE id=?").run(lesson.id);
seedDb.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
seedDb.close();

const port = 18848;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}

try {
  const deadline = Date.now() + 20000;
  for (;;) {
    try { const res = await fetch(`http://127.0.0.1:${port}/health`); if (res.ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error('后端没起来');
    await sleep(150);
  }

  const login = async (l, p) => (await api('/api/auth/login', { method: 'POST', body: { login: l, password: p } })).data.token;
  const student = await login('student-2', 'study123');
  const teacher = await login('teacher-1', 'teach123');

  const created = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: lesson.id, title: 'P18 提交' } });
  assert.equal(created.status, 200, `建会话失败: ${JSON.stringify(created.data)}`);
  const conversationId = created.data.id;

  const stream = await fetch(`http://127.0.0.1:${port}/api/student/vibecoding/conversations/${conversationId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${student}` },
    body: JSON.stringify({ content: '写一个会变色的按钮' }),
  });
  await stream.text();
  await sleep(200);

  // 未确认版权必须被拒
  const noConfirm = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: {} });
  assert.equal(noConfirm.status, 400, '未确认版权应当被拒');
  assert.equal(noConfirm.data?.error?.code, 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED', '错误码应为版权确认');

  const submitted = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: { copyrightConfirmed: true } });
  assert.equal(submitted.status, 200, `提交失败: ${JSON.stringify(submitted.data)}`);
  assert.equal(submitted.data.round, 1, '首次提交轮次应为 1');
  assert.equal(submitted.data.entryFile, 'index.html', '应记录入口文件');
  assert.ok(submitted.data.transcript.length >= 2, `应保存创作对话，实际 ${submitted.data.transcript.length} 条`);
  assert.equal(submitted.data.teacherComment, undefined, '提交对象不该再有点评字段');

  // 提交后**不再锁创作**（这正是这次改动的核心）
  const afterSubmit = await fetch(`http://127.0.0.1:${port}/api/student/vibecoding/conversations/${conversationId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${student}` },
    body: JSON.stringify({ content: '提交完还能聊吗' }),
  });
  assert.equal(afterSubmit.status, 200, `提交后应当仍可继续创作，实际 ${afterSubmit.status}`);
  await afterSubmit.text();
  await sleep(200);

  // 可以反复提交（交给平台这件事没有「已处理」状态）
  const resubmit = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: { copyrightConfirmed: true } });
  assert.equal(resubmit.status, 200, `再次提交应当可以，实际 ${resubmit.status}`);
  assert.equal(resubmit.data.round, 2, `再次提交轮次应为 2，实际 ${resubmit.data.round}`);

  /* ── 机构端的点评接口必须已经不存在 ── */
  const submissionId = submitted.data.id;
  const gone = [
    ['/api/org/vibecoding/submissions?status=PENDING', 'GET', undefined, '点评列表'],
    [`/api/org/vibecoding/submissions/${submissionId}`, 'GET', undefined, '点评详情'],
    [`/api/org/vibecoding/submissions/${submissionId}`, 'PUT', { status: 'APPROVED', comment: 'x' }, '点评提交'],
  ];
  for (const [pathname, method, body, label] of gone) {
    const response = await api(pathname, { method, token: teacher, body });
    assert.equal(response.status, 404, `${label}接口应当已删除，实际 ${response.status}`);
  }

  /* ── 审计里不该再有点评事件 ── */
  const audit = new DatabaseSync(dbPath);
  const reviewLog = audit.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='VIBECODING_REVIEW'").get();
  const submitLog = audit.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='VIBECODING_SUBMIT'").get();
  audit.close();
  assert.equal(reviewLog.n, 0, `不该再有点评审计，实际 ${reviewLog.n}`);
  assert.equal(submitLog.n, 2, `提交应写 2 条审计，实际 ${submitLog.n}`);

  console.log(JSON.stringify({
    name: 'vibecoding-submit-handoff', pass: true,
    rounds: resubmit.data.round,
    lockedAfterSubmit: false,
    reviewEndpoints: 'all 404（点评已删除）',
    audit: { reviews: reviewLog.n, submits: submitLog.n },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill();
}
