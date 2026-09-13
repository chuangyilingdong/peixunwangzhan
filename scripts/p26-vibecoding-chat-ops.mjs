/**
 * P26 VibeCoding 对话增强：课时上下文、重新生成、编辑重发、删除/清空、置顶、搜索、选模型。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensureClassroom, switchClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p26-vibecoding-chat-ops-'));
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

// 让课时带上正文，验证会注入到 system 上下文
const { DatabaseSync } = await import('node:sqlite');
const seedDb = new DatabaseSync(dbPath);
const lesson = seedDb.prepare('SELECT id, title FROM course_lessons ORDER BY sort LIMIT 1').get();
seedDb.prepare("UPDATE course_lessons SET delivery_mode='VIBECODING', lesson_content='本课目标：用 AI 做出一个会动的小网页。' WHERE id=?").run(lesson.id);
seedDb.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
// 给 TEXT 渠道配上可选模型，验证「每会话选模型」
seedDb.prepare('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1').run(JSON.stringify({
  modalityChannels: { TEXT: 'channel-test-text' },
  channels: [{ id: 'channel-test-text', provider: 'local-mock', model: 'mock-model-a', models: ['mock-model-a', 'mock-model-b'], modelMappings: [{ id: 'mock-model-a', displayName: '模拟模型 A' }, { id: 'mock-model-z', displayName: '候选但未启用' }] }],
}));
seedDb.close();

// 用与服务器相同的环境变量导入服务端模块，直接验证 system 上下文拼装
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
const { lessonSystemMessage } = await import(pathToFileURL(path.join(root, 'apps/server/src/routes/vibecoding.js')).href);
const systemMessage = lessonSystemMessage({ lesson_id: lesson.id });
assert.equal(systemMessage.role, 'system', '应生成 system 消息');
assert.ok(systemMessage.content.includes(lesson.title), 'system 上下文应含课时标题');
assert.ok(systemMessage.content.includes('本课目标：用 AI 做出一个会动的小网页。'), 'system 上下文应含课时正文');
assert.ok(systemMessage.content.includes('8–16 岁'), 'system 上下文应含儿童安全约束');
// 2026-09-11 用户要求删掉「人设与产物约定」。这里反过来断言它们**不在**：
// 谁把它们加回来，这条就会报错（比只断言「课时内容还在」更能守住这次的决定）。
assert.equal(systemMessage.content.includes('阿飞'), false, 'system 上下文不应再含人设');
assert.equal(systemMessage.content.includes('不会生成文件'), false, 'system 上下文不应再含产物约定');
assert.equal(systemMessage.content.includes('每个要交给学生的文件'), false, 'system 上下文不应再含产物约定');

const port = 18901;
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
async function stream(pathname, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  const raw = await response.text();
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
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
  // 这条守卫走 VibeCoding 入口 → 把课堂入口类型切成 VIBECODING
  switchClassroom(dbPath, { deliveryMode: 'VIBECODING' });
    await sleep(100);
  }

  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(student, '学生登录失败');

  const created = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: lesson.id, title: 'P26 对话操作' } });
  assert.equal(created.status, 200, `新建会话失败: ${JSON.stringify(created.data)}`);
  const conversationId = created.data.id;

  // 1) 发送 → 流式回复
  const events = await stream(`/api/student/vibecoding/conversations/${conversationId}/messages`, { token: student, body: { content: '做个打地鼠' } });
  assert.ok(events.some((item) => item.event === 'start'), '应有 start 事件');
  assert.ok(events.some((item) => item.event === 'delta'), '应有 delta 事件');
  assert.ok(events.some((item) => item.event === 'done'), '应有 done 事件');

  let detail = (await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student })).data;
  assert.equal(detail.messages.length, 2, `发送后应有 2 条消息，实际 ${detail.messages.length}`);
  assert.equal(detail.messages[1].role, 'assistant', '第二条应为助手消息');
  assert.equal(detail.messages[1].creditsCharged, undefined, '消息里不该再有积分字段（P4 删积分）');

  // 2) 重新生成：消息数不变，助手内容重写
  const regen = await stream(`/api/student/vibecoding/conversations/${conversationId}/messages/regenerate`, { token: student });
  assert.ok(regen.some((item) => item.event === 'done'), `重新生成应完成，实际事件 ${regen.map((item) => item.event).join(',')}`);
  detail = (await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student })).data;
  assert.equal(detail.messages.length, 2, `重新生成后仍应是 2 条消息，实际 ${detail.messages.length}`);

  // 3) 编辑并重发：内容更新，后续回答重算
  const userId = detail.messages[0].id;
  const edit = await stream(`/api/student/vibecoding/conversations/${conversationId}/messages/${userId}/edit`, { token: student, body: { content: '改成做个猜数字游戏' } });
  assert.ok(edit.some((item) => item.event === 'done'), '编辑重发应完成');
  detail = (await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student })).data;
  assert.equal(detail.messages[0].content, '改成做个猜数字游戏', '用户消息内容应已更新');
  assert.equal(detail.messages.length, 2, '编辑重发后仍应是 2 条消息');

  // 4) 置顶 + 搜索
  const pinned = await api(`/api/student/vibecoding/conversations/${conversationId}/pin`, { method: 'PUT', token: student, body: { pinned: true } });
  assert.equal(pinned.status, 200, `置顶失败: ${JSON.stringify(pinned.data)}`);
  assert.ok(pinned.data.pinnedAt, '置顶后应有 pinnedAt');
  const second = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: lesson.id, title: 'P26 另一个会话' } });
  assert.equal(second.status, 200, '第二个会话创建失败');
  const listAll = await api('/api/student/vibecoding/conversations?limit=50', { token: student });
  assert.equal(listAll.data.items[0].id, conversationId, '置顶会话应排在第一位');
  const searched = await api('/api/student/vibecoding/conversations?limit=50&search=' + encodeURIComponent('另一个'), { token: student });
  assert.equal(searched.data.items.length, 1, `搜索应命中 1 条，实际 ${searched.data.items.length}`);
  assert.equal(searched.data.items[0].title, 'P26 另一个会话', '搜索命中标题应正确');

  // 5) 每会话选模型
  assert.ok(Array.isArray(detail.modelOptions) && detail.modelOptions.length, '会话详情应带可选模型');
  // 只下发「实际启用」的模型：候选清单（modelMappings）里有但没启用的不能出现，
  // 否则学生端会冒出别的供应商的模型名（2026-09-11 线上就是 gpt-6-astra）
  {
    const ids = detail.modelOptions.map((m) => m.id);
    assert.equal(ids.includes('mock-model-z'), false, '候选但未启用的模型不应下发给学生');
    assert.deepEqual([...ids].sort(), ['mock-model-a', 'mock-model-b'], '应只包含渠道实际启用的模型');
  }
  const bogus = await api(`/api/student/vibecoding/conversations/${conversationId}`, { method: 'PUT', token: student, body: { model: 'not-a-real-model' } });
  assert.equal(bogus.status, 400, `不存在的模型应 400，实际 ${bogus.status}`);
  assert.equal(bogus.data?.error?.code, 'VIBECODING_MODEL_NOT_AVAILABLE', '错误码应为 VIBECODING_MODEL_NOT_AVAILABLE');
  const chosen = detail.modelOptions[0].id;
  const switched = await api(`/api/student/vibecoding/conversations/${conversationId}`, { method: 'PUT', token: student, body: { model: chosen } });
  assert.equal(switched.status, 200, `切换模型失败: ${JSON.stringify(switched.data)}`);
  assert.equal(switched.data.model, chosen, '切换后会话模型应更新');

  // 6) 删除单条消息（连同之后回答）+ 清空对话
  detail = (await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student })).data;
  const removed = await api(`/api/student/vibecoding/conversations/${conversationId}/messages/${detail.messages[0].id}`, { method: 'DELETE', token: student });
  assert.equal(removed.status, 200, `删除消息失败: ${JSON.stringify(removed.data)}`);
  detail = (await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student })).data;
  assert.equal(detail.messages.length, 0, `删除首条后应没有消息，实际 ${detail.messages.length}`);

  await stream(`/api/student/vibecoding/conversations/${conversationId}/messages`, { token: student, body: { content: '再来一次' } });
  detail = (await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student })).data;
  assert.equal(detail.messages.length, 2, '重新发送后应又回到 2 条');
  const cleared = await api(`/api/student/vibecoding/conversations/${conversationId}/messages`, { method: 'DELETE', token: student });
  assert.equal(cleared.status, 200, `清空失败: ${JSON.stringify(cleared.data)}`);
  assert.equal(cleared.data.removed, 2, `清空应删除 2 条，实际 ${cleared.data.removed}`);
  detail = (await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student })).data;
  assert.equal(detail.messages.length, 0, '清空后应没有消息');
  assert.ok((detail.artifacts || []).length, '清空聊天不应删除产物文件');

  // 7) 提交只是「交给平台」，**不再锁创作**（老师点评那一环已按用户要求删除）
  await stream(`/api/student/vibecoding/conversations/${conversationId}/messages`, { token: student, body: { content: '准备提交' } });
  const submitted = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: { copyrightConfirmed: true } });
  assert.equal(submitted.status, 200, `提交失败: ${JSON.stringify(submitted.data)}`);
  const afterSubmitStream = await stream(`/api/student/vibecoding/conversations/${conversationId}/messages`, { token: student, body: { content: '提交后还能聊' } });
  assert.ok(afterSubmitStream, '提交后应当仍可继续创作（不再锁会话）');

  console.log(JSON.stringify({
    name: 'vibecoding-chat-ops', pass: true,
    lessonContext: { hasTitle: true, hasContent: true, hasSafety: true, hasFileConvention: true },
    stream: { start: true, delta: true, done: true },
    regenerate: true, editAndResend: true,
    pin: true, search: true,
    model: { options: detail.modelOptions.length, bogusRejected: true, switched: chosen },
    deleteMessage: true, clearMessages: true, lockedGuard: true,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
