/**
 * P17 VibeCoding 受限运行（沙箱）。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：正常输出 / 抛错退出 / 超时终止 / 输出截断 / 入口必须是 JS /
 * 能力探测接口，以及运行接口与课堂门禁一致。
 * 注意：本脚本在非生产模式下走受控子进程后端，只验证「限制生效 + 结果如实回报」，
 * 不宣称子进程等同隔离沙箱（隔离由生产 systemd 后端负责）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p17-vibecoding-run-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
  VIBECODING_RUN_TIMEOUT_MS: '4000',
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
const canvasLesson = seedDb.prepare('SELECT id FROM course_lessons ORDER BY sort LIMIT 1 OFFSET 1').get();
seedDb.prepare("UPDATE course_lessons SET delivery_mode='VIBECODING' WHERE id=?").run(lesson.id);
seedDb.prepare("UPDATE course_lessons SET delivery_mode='CANVAS' WHERE id=?").run(canvasLesson.id);
seedDb.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
seedDb.close();

const port = 18847;
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

  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } });
  assert.equal(login.status, 200, `学生登录失败: ${JSON.stringify(login.data)}`);
  const student = login.data.token;

  const capability = await api('/api/student/vibecoding/sandbox', { token: student });
  assert.equal(capability.status, 200, `能力探测失败: ${JSON.stringify(capability.data)}`);
  assert.equal(capability.data.available, true, '非生产环境应报告沙箱可用');
  assert.equal(capability.data.backend, 'local-subprocess', `后端应为 local-subprocess，实际 ${capability.data.backend}`);
  assert.equal(capability.data.isolated, false, '子进程后端不得声称隔离');

  const created = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: lesson.id } });
  assert.equal(created.status, 200, `新建会话失败: ${JSON.stringify(created.data)}`);
  const conversationId = created.data.id;

  async function saveAndRun(files, entryFile) {
    const saved = await api(`/api/student/vibecoding/conversations/${conversationId}`, { method: 'PUT', token: student, body: { files, entryFile } });
    assert.equal(saved.status, 200, `保存代码失败: ${JSON.stringify(saved.data)}`);
    return api(`/api/student/vibecoding/conversations/${conversationId}/runs`, { method: 'POST', token: student, body: {} });
  }

  // 1) 正常输出
  const ok = await saveAndRun({ 'main.js': "console.log('hello');\nconsole.log(2 + 3);\n" }, 'main.js');
  assert.equal(ok.status, 200, `正常运行失败: ${JSON.stringify(ok.data)}`);
  assert.equal(ok.data.run.status, 'SUCCEEDED', `应运行成功，实际 ${ok.data.run.status}`);
  assert.equal(ok.data.run.exitCode, 0, '退出码应为 0');
  assert.match(ok.data.run.stdout, /hello/, `应捕获 stdout，实际 ${JSON.stringify(ok.data.run.stdout)}`);
  assert.match(ok.data.run.stdout, /5/, '应捕获第二行输出');

  // 2) 抛错退出
  const failed = await saveAndRun({ 'main.js': "throw new Error('boom');\n" }, 'main.js');
  assert.equal(failed.data.run.status, 'FAILED', `抛错应为 FAILED，实际 ${failed.data.run.status}`);
  assert.equal(failed.data.run.exitCode, 1, '抛错退出码应为 1');
  assert.match(failed.data.run.stderr, /boom/, '应捕获错误输出');

  // 3) 超时终止
  const timeout = await saveAndRun({ 'main.js': 'while (true) {}\n' }, 'main.js');
  assert.equal(timeout.data.run.status, 'TIMEOUT', `死循环应超时，实际 ${timeout.data.run.status}`);
  assert.equal(timeout.data.run.errorCode, 'VIBECODING_RUN_TIMEOUT', '超时应带 VIBECODING_RUN_TIMEOUT');

  // 4) 输出截断
  const big = await saveAndRun({ 'main.js': "console.log('x'.repeat(200000));\n" }, 'main.js');
  assert.equal(big.data.run.status, 'SUCCEEDED', '大量输出仍应运行成功');
  assert.match(big.data.run.stdout, /输出过长已截断/, '超长输出应被截断并标注');
  assert.ok(big.data.run.stdout.length < 200000, '截断后长度应明显小于原始输出');

  // 5) 入口不是 JS
  const htmlEntry = await saveAndRun({ 'index.html': '<h1>hi</h1>', 'style.css': 'body{}' }, 'index.html');
  assert.equal(htmlEntry.status, 400, `HTML 入口应被拒，实际 ${htmlEntry.status}`);
  assert.equal(htmlEntry.data?.error?.code, 'VIBECODING_RUN_ENTRY_NOT_JAVASCRIPT', '错误码应为 VIBECODING_RUN_ENTRY_NOT_JAVASCRIPT');

  // 6) 运行记录可查
  const runs = await api(`/api/student/vibecoding/conversations/${conversationId}/runs?limit=10`, { token: student });
  assert.equal(runs.status, 200, `运行历史读取失败: ${JSON.stringify(runs.data)}`);
  assert.ok(runs.data.total >= 4, `运行历史应至少 4 条，实际 ${runs.data.total}`);

  // 7) 课堂门禁：画布课时不能建 VibeCoding 会话（自然也不能运行）
  const wrongLesson = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: canvasLesson.id } });
  assert.equal(wrongLesson.status, 403, '画布课时应被拒');
  assert.equal(wrongLesson.data?.error?.code, 'VIBECODING_CLASS_NOT_ACTIVE', '错误码应为 VIBECODING_CLASS_NOT_ACTIVE');

  console.log(JSON.stringify({
    name: 'vibecoding-sandbox', pass: true,
    backend: capability.data.backend, isolated: capability.data.isolated,
    succeeded: ok.data.run.stdout.trim().split('\n'),
    failedExitCode: failed.data.run.exitCode,
    timeout: timeout.data.run.status,
    truncated: /输出过长已截断/.test(big.data.run.stdout),
    runs: runs.data.total,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
