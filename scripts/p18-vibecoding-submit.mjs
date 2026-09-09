/**
 * P18 VibeCoding 提交与老师点评闭环。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：学生提交 → 提交后会话锁定 → 重复提交被拒 → 老师按班级范围看到提交 →
 * 驳回必须写原因 → 驳回后可继续创作并二次提交 → 通过后状态落库 → 非本班老师看不到。
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
server.stdout.on('data', (x) => { serverLog += x; });

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
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  const teacher = (await api('/api/auth/login', { method: 'POST', body: { login: 'teacher-1', password: 'teach123' } })).data.token;
  const otherTeacher = (await api('/api/auth/login', { method: 'POST', body: { login: 'teacher-2', password: 'teach123' } })).data.token;
  assert.ok(student && teacher && otherTeacher, '登录失败');

  const created = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: lesson.id, title: 'P18 提交用例' } });
  assert.equal(created.status, 200, `新建会话失败: ${JSON.stringify(created.data)}`);
  const conversationId = created.data.id;
  await api(`/api/student/vibecoding/conversations/${conversationId}`, { method: 'PUT', token: student, body: { files: { 'index.html': '<h1>作品</h1>', 'main.js': "console.log('ok');\n" }, entryFile: 'index.html' } });

  // 先聊一句，让 transcript 有内容
  const stream = await fetch(`http://127.0.0.1:${port}/api/student/vibecoding/conversations/${conversationId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${student}` }, body: JSON.stringify({ content: '帮我做一个标题' }),
  });
  assert.equal(stream.status, 200, '对话失败');
  await stream.text();

  // 提交
  const submitted = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: { description: '第一个网页作品' } });
  assert.equal(submitted.status, 200, `提交失败: ${JSON.stringify(submitted.data)}`);
  assert.equal(submitted.data.status, 'PENDING', '提交后应为待点评');
  assert.equal(submitted.data.round, 1, '首次提交轮次应为 1');
  assert.equal(submitted.data.entryFile, 'index.html', '应记录入口文件');
  assert.ok(submitted.data.transcript.length >= 2, `应保存创作对话，实际 ${submitted.data.transcript.length} 条`);

  // 提交后锁定
  const afterSubmit = await api(`/api/student/vibecoding/conversations/${conversationId}/messages`, { method: 'POST', token: student, body: { content: '还能聊吗' } });
  assert.equal(afterSubmit.status, 409, `提交后应锁定会话，实际 ${afterSubmit.status}`);
  assert.equal(afterSubmit.data?.error?.code, 'VIBECODING_CONVERSATION_LOCKED', '锁定错误码应为 VIBECODING_CONVERSATION_LOCKED');
  const duplicate = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: {} });
  assert.equal(duplicate.status, 409, '待点评期间重复提交应被拒');
  assert.equal(duplicate.data?.error?.code, 'VIBECODING_ALREADY_SUBMITTED', '重复提交错误码应为 VIBECODING_ALREADY_SUBMITTED');

  // 老师视角
  const teacherList = await api('/api/org/vibecoding/submissions?status=PENDING', { token: teacher });
  assert.equal(teacherList.status, 200, `老师列表失败: ${JSON.stringify(teacherList.data)}`);
  assert.equal(teacherList.data.items.length, 1, `本班老师应看到 1 条，实际 ${teacherList.data.items.length}`);
  const submissionId = teacherList.data.items[0].id;
  assert.equal(teacherList.data.items[0].studentName, '小红', '应带学生姓名');

  const otherList = await api('/api/org/vibecoding/submissions', { token: otherTeacher });
  assert.equal(otherList.status, 200, '其他老师列表失败');
  assert.equal(otherList.data.items.length, 0, `非本班老师不应看到提交，实际 ${otherList.data.items.length}`);
  const otherDetail = await api(`/api/org/vibecoding/submissions/${submissionId}`, { token: otherTeacher });
  assert.equal(otherDetail.status, 403, '非本班老师不应看到详情');

  const detail = await api(`/api/org/vibecoding/submissions/${submissionId}`, { token: teacher });
  assert.equal(detail.status, 200, `详情失败: ${JSON.stringify(detail.data)}`);
  assert.ok(detail.data.files['index.html'], '详情应带代码文件');
  assert.ok(detail.data.transcript.length >= 2, '详情应带创作对话');

  // 驳回必须写原因
  const noReason = await api(`/api/org/vibecoding/submissions/${submissionId}`, { method: 'PUT', token: teacher, body: { status: 'REJECTED' } });
  assert.equal(noReason.status, 400, '驳回未写原因应被拒');
  assert.equal(noReason.data?.error?.code, 'VIBECODING_REVIEW_COMMENT_REQUIRED', '错误码应为 VIBECODING_REVIEW_COMMENT_REQUIRED');

  // 驳回 → 学生可继续创作并二次提交
  const rejected = await api(`/api/org/vibecoding/submissions/${submissionId}`, { method: 'PUT', token: teacher, body: { status: 'REJECTED', comment: '标题太小了，改大一点' } });
  assert.equal(rejected.status, 200, `驳回失败: ${JSON.stringify(rejected.data)}`);
  assert.equal(rejected.data.status, 'REJECTED', '状态应为 REJECTED');
  const reopened = await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student });
  assert.equal(reopened.data.status, 'DRAFT', '驳回后会话应回到草稿状态');
  assert.equal(reopened.data.submission.status, 'REJECTED', '学生应能看到驳回意见');
  assert.match(reopened.data.submission.teacherComment, /标题/, '驳回意见应可见');

  const resubmit = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: {} });
  assert.equal(resubmit.status, 200, `二次提交失败: ${JSON.stringify(resubmit.data)}`);
  assert.equal(resubmit.data.round, 2, `二次提交轮次应为 2，实际 ${resubmit.data.round}`);

  // 通过
  const approved = await api(`/api/org/vibecoding/submissions/${submissionId}`, { method: 'PUT', token: teacher, body: { status: 'APPROVED', comment: '做得好' } });
  assert.equal(approved.status, 200, `通过失败: ${JSON.stringify(approved.data)}`);
  assert.equal(approved.data.status, 'APPROVED', '状态应为 APPROVED');
  const finalState = await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student });
  assert.equal(finalState.data.status, 'SUBMITTED', '通过后会话应保持已提交');

  const audit = new DatabaseSync(dbPath);
  const reviewLog = audit.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='VIBECODING_REVIEW'").get();
  const submitLog = audit.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='VIBECODING_SUBMIT'").get();
  audit.close();
  assert.equal(reviewLog.n, 2, `点评应写 2 条审计，实际 ${reviewLog.n}`);
  assert.equal(submitLog.n, 2, `提交应写 2 条审计，实际 ${submitLog.n}`);

  console.log(JSON.stringify({
    name: 'vibecoding-submit-review', pass: true,
    rounds: resubmit.data.round, finalStatus: finalState.data.status,
    teacherVisible: teacherList.data.items.length, otherTeacherVisible: otherList.data.items.length,
    audit: { reviews: reviewLog.n, submits: submitLog.n },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
