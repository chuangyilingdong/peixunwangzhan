/**
 * P16 VibeCoding 对话运行时（会话 + SSE 流式回复 + 计费）。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：VibeCoding 课时才可进入（画布课时被拒）→ 新建会话带默认代码文件 →
 * SSE 逐块返回 delta 并以 done 收尾 → 消息与扣费落库 → 重命名 → 列表分页。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-vibecoding-'));
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

// 准备两种课时：一个 VibeCoding，一个画布（用于验证互斥）
const { DatabaseSync } = await import('node:sqlite');
const seedDb = new DatabaseSync(dbPath);
const lessons = seedDb.prepare('SELECT id, title FROM course_lessons ORDER BY sort LIMIT 2').all();
assert.equal(lessons.length >= 2, true, '种子数据应至少有两个课时');
const vibeLessonId = lessons[0].id;
const canvasLessonId = lessons[1].id;
seedDb.prepare("UPDATE course_lessons SET delivery_mode='VIBECODING' WHERE id=?").run(vibeLessonId);
seedDb.prepare("UPDATE course_lessons SET delivery_mode='CANVAS' WHERE id=?").run(canvasLessonId);
seedDb.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(vibeLessonId);
seedDb.close();

const port = 18846;
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

function parseSse(raw) {
  return raw.split('\n\n').filter((block) => block.trim()).map((block) => {
    const lines = block.split('\n');
    const event = (lines.find((line) => line.startsWith('event:')) || 'event: message').slice(6).trim();
    const dataLine = lines.find((line) => line.startsWith('data:')) || 'data:{}';
    return { event, data: JSON.parse(dataLine.slice(5).trim() || '{}') };
  });
}

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } });
  assert.equal(login.status, 200, `学生登录失败: ${JSON.stringify(login.data)}`);
  const student = login.data.token;

  // 画布课时被拒
  const wrongLesson = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: canvasLessonId } });
  assert.equal(wrongLesson.status, 403, `画布课时应被拒: ${JSON.stringify(wrongLesson.data)}`);
  assert.equal(wrongLesson.data?.error?.code, 'VIBECODING_CLASS_NOT_ACTIVE', `错误码应为 VIBECODING_CLASS_NOT_ACTIVE，实际 ${wrongLesson.data?.error?.code}`);

  // 新建会话：带默认文件
  const created = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: vibeLessonId } });
  assert.equal(created.status, 200, `新建会话失败: ${JSON.stringify(created.data)}`);
  const conversationId = created.data.id;
  assert.equal(created.data.entryFile, 'index.html', '默认入口文件应为 index.html');
  assert.deepEqual(Object.keys(created.data.files).sort(), ['index.html', 'script.js', 'style.css'], '默认应带三个文件');

  // SSE 流式回复
  const streamResponse = await fetch(`http://127.0.0.1:${port}/api/student/vibecoding/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${student}` },
    body: JSON.stringify({ content: '帮我写一个会变色的按钮' }),
  });
  assert.equal(streamResponse.status, 200, `流式接口应 200，实际 ${streamResponse.status}`);
  assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/, '流式接口应返回 text/event-stream');
  const events = parseSse(await streamResponse.text());
  const deltas = events.filter((item) => item.event === 'delta');
  const done = events.find((item) => item.event === 'done');
  assert.ok(events.some((item) => item.event === 'start'), '应先发 start 事件');
  assert.ok(deltas.length >= 2, `应收到多个 delta 分片，实际 ${deltas.length}`);
  assert.ok(done, `应收到 done 事件，实际事件：${events.map((item) => item.event).join(',')}`);
  assert.equal(done.data.creditsCharged, 1, '成功回复应扣 1 积分');
  assert.ok(done.data.message?.content?.length > 0, 'done 事件应带助手消息内容');
  assert.ok(String(done.data.message.content).includes('本地模拟回复'), '本地 mock 回复内容应可读');

  // 消息落库 + 扣费
  const detail = await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student });
  assert.equal(detail.status, 200, `读取会话失败: ${JSON.stringify(detail.data)}`);
  assert.equal(detail.data.messages.length, 2, `应有 user + assistant 两条消息，实际 ${detail.data.messages.length}`);
  assert.equal(detail.data.messages[0].role, 'user', '第一条应为用户消息');
  assert.equal(detail.data.messages[1].role, 'assistant', '第二条应为助手消息');
  assert.equal(detail.data.messages[1].creditsCharged, 1, '助手消息应记录扣费');
  assert.equal(detail.data.title, '帮我写一个会变色的按钮', '首条消息应自动成为会话标题');

  const usage = new DatabaseSync(dbPath);
  const usageRow = usage.prepare("SELECT COUNT(*) n FROM usage_records WHERE modality='TEXT' AND status='SUCCESS'").get();
  const entryRow = usage.prepare("SELECT COUNT(*) n FROM credit_entries WHERE type='AI_VIBECODING_CHAT'").get();
  const assistantRow = usage.prepare("SELECT COUNT(*) n FROM vibecoding_messages WHERE conversation_id=? AND role='assistant'").get(conversationId);
  usage.close();
  assert.equal(usageRow.n, 1, `应写入 1 条 TEXT 用量记录，实际 ${usageRow.n}`);
  assert.equal(entryRow.n, 1, `应写入 1 条 AI_VIBECODING_CHAT 流水，实际 ${entryRow.n}`);
  assert.equal(assistantRow.n, 1, '助手消息应落库');

  // 重命名 + 列表
  const renamed = await api(`/api/student/vibecoding/conversations/${conversationId}`, { method: 'PUT', token: student, body: { title: '变色按钮练习' } });
  assert.equal(renamed.status, 200, `重命名失败: ${JSON.stringify(renamed.data)}`);
  assert.equal(renamed.data.title, '变色按钮练习', '重命名应生效');
  const list = await api('/api/student/vibecoding/conversations?limit=10', { token: student });
  assert.equal(list.data.total, 1, `会话列表应为 1 条，实际 ${list.data.total}`);

  // 保存代码文件
  const saved = await api(`/api/student/vibecoding/conversations/${conversationId}`, {
    method: 'PUT', token: student,
    body: { files: { 'index.html': '<h1>hi</h1>', 'app.js': 'console.log(1)' }, entryFile: 'index.html' },
  });
  assert.equal(saved.status, 200, `保存文件失败: ${JSON.stringify(saved.data)}`);
  assert.deepEqual(Object.keys(saved.data.files).sort(), ['app.js', 'index.html'], '保存后应只剩两个文件');

  console.log(JSON.stringify({
    name: 'vibecoding-chat', pass: true,
    conversationId, deltas: deltas.length, creditsCharged: done.data.creditsCharged,
    messages: detail.data.messages.length, usageRecords: usageRow.n, ledgerEntries: entryRow.n,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
