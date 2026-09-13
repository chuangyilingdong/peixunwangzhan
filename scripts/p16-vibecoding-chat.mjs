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
  assert.equal(created.data.files, undefined, '会话不再下发 files（代码已改成产物模型）');
  assert.deepEqual((created.data.artifacts || []).map((a) => a.name).sort(), ['index.html', 'script.js', 'style.css'], '起始应带三个产物');
  assert.equal((created.data.artifacts || []).find((a) => a.name === 'index.html')?.kind, 'html', '产物应推断出类型');

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
  // 2026-09-13（P4 删积分）：响应里不该再有积分字段，扣费改看算力池账本 cost_fen
  assert.equal(done.data.creditsCharged, undefined, '响应里不该再有 creditsCharged（积分已废弃）');
  assert.ok(done.data.message?.content?.length > 0, 'done 事件应带助手消息内容');
  assert.ok(String(done.data.message.content).includes('本地模拟回复'), '本地 mock 回复内容应可读');

  // 消息落库 + 扣费
  const detail = await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student });
  assert.equal(detail.status, 200, `读取会话失败: ${JSON.stringify(detail.data)}`);
  assert.equal(detail.data.messages.length, 2, `应有 user + assistant 两条消息，实际 ${detail.data.messages.length}`);
  assert.equal(detail.data.messages[0].role, 'user', '第一条应为用户消息');
  assert.equal(detail.data.messages[1].role, 'assistant', '第二条应为助手消息');
  assert.equal(detail.data.messages[1].creditsCharged, undefined, '消息里不该再有积分字段');
  assert.equal(detail.data.title, '帮我写一个会变色的按钮', '首条消息应自动成为会话标题');

  const usage = new DatabaseSync(dbPath);
  const usageRow = usage.prepare("SELECT COUNT(*) n FROM usage_records WHERE modality='TEXT' AND status='SUCCESS'").get();
  const costRow = usage.prepare("SELECT COALESCE(SUM(cost_fen),0) fen FROM usage_records WHERE modality='TEXT' AND status='SUCCESS'").get();
  const assistantRow = usage.prepare("SELECT COUNT(*) n FROM vibecoding_messages WHERE conversation_id=? AND role='assistant'").get(conversationId);
  usage.close();
  assert.equal(usageRow.n, 1, `应写入 1 条 TEXT 用量记录，实际 ${usageRow.n}`);
  assert.ok(Number(costRow.fen) > 0, `成功回复应在算力池账本记一笔（cost_fen > 0），实际 ${costRow.fen}`);
  assert.equal(assistantRow.n, 1, '助手消息应落库');

  // 重命名 + 列表
  const renamed = await api(`/api/student/vibecoding/conversations/${conversationId}`, { method: 'PUT', token: student, body: { title: '变色按钮练习' } });
  assert.equal(renamed.status, 200, `重命名失败: ${JSON.stringify(renamed.data)}`);
  assert.equal(renamed.data.title, '变色按钮练习', '重命名应生效');
  const list = await api('/api/student/vibecoding/conversations?limit=10', { token: student });
  assert.equal(list.data.total, 1, `会话列表应为 1 条，实际 ${list.data.total}`);

  // 手改代码被明确拒绝：代码只有一个来源——AI 产出
  const editFiles = await api(`/api/student/vibecoding/conversations/${conversationId}`, {
    method: 'PUT', token: student, body: { files: { 'index.html': '<h1>hi</h1>' } },
  });
  assert.equal(editFiles.status, 400, `手改代码应被拒，实际 ${editFiles.status}`);
  assert.equal(editFiles.data?.error?.code, 'VIBECODING_FILES_NOT_EDITABLE', '错误码应为 VIBECODING_FILES_NOT_EDITABLE');

  // AI 产出的产物：mock 会用带文件名的围栏写出 index.html 与 script.js
  const artifactEvents = events.filter((item) => item.event === 'artifact');
  assert.ok(artifactEvents.length >= 2, `应收到 artifact 事件，实际 ${artifactEvents.length}，事件序列：${events.map((e) => e.event).join(',')}`);
  assert.ok(Array.isArray(done.data.artifacts) && done.data.artifacts.length === 3, 'done 应带权威产物清单');
  const indexArtifact = done.data.artifacts.find((a) => a.name === 'index.html');
  assert.equal(indexArtifact.kind, 'html', 'index.html 应是 html 产物');
  assert.ok(Number(indexArtifact.revision) >= 2, '同名文件重写应升修订号而不是新建产物');
  assert.ok(String(indexArtifact.content).includes('本地模拟页面'), '产物内容应是这一轮 AI 写的版本');
  const one = await api(`/api/student/vibecoding/conversations/${conversationId}/artifacts/${indexArtifact.id}`, { token: student });
  assert.equal(one.status, 200, '单个产物接口应 200');
  assert.ok(String(one.data?.content || '').includes('本地模拟页面'), '单个产物接口应返回完整正文');


  // 迁移来的产物（message_id 为空）也必须挂到最后一条助手消息上
  {
    const driver = new DatabaseSync(dbPath);
    driver.prepare('UPDATE vibecoding_artifacts SET message_id=NULL WHERE conversation_id=?').run(conversationId);
    driver.close();
    const reread = await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student });
    assert.equal(reread.status, 200, '重新读取会话失败');
    const orphans = reread.data.artifacts.filter((a) => !a.messageId);
    assert.equal(orphans.length, 0, `message_id 为空的产物应被挂到消息上，仍有 ${orphans.length} 条`);
    const lastAssistant = [...reread.data.messages].reverse().find((m) => m.role === 'assistant');
    assert.equal(reread.data.artifacts.every((a) => a.messageId === lastAssistant.id), true, '产物应挂在最后一条助手消息上');
  }
  console.log(JSON.stringify({
    name: 'vibecoding-chat', pass: true,
    conversationId, deltas: deltas.length, costFen: Number(costRow.fen),
    messages: detail.data.messages.length, artifacts: detail.data.artifacts.length, usageRecords: usageRow.n, costFen: Number(costRow.fen),
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
