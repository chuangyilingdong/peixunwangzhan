/**
 * P20 画布「文字框体」：课时配置 → 学生生成文字 → 框体数量与能力位约束。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：课时文字框体数量/模型下发到学生项目 → TEXT 生成成功并把文字写进素材 →
 * 框体数量用尽后拒绝 → 课时未开放「AI 文字」时拒绝（能力位仍然生效）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p20-text-slot-'));
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
const lessons = seedDb.prepare('SELECT id, title FROM course_lessons ORDER BY sort LIMIT 2').all();
assert.equal(lessons.length, 2, '种子数据应至少有两个课时');
const [textLesson, noCapLesson] = lessons;
const slotConfig = (model) => JSON.stringify({ version: 1, generationSlots: { text: { count: 1, model }, image: { count: 0 }, video: { count: 0 } } });
seedDb.prepare("UPDATE course_lessons SET delivery_mode='CANVAS', classroom_config=? WHERE id=?").run(slotConfig('mock-text-model'), textLesson.id);
seedDb.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id,capability,created_at) VALUES (?,'text',datetime('now'))").run(textLesson.id);
seedDb.prepare("UPDATE course_lessons SET delivery_mode='CANVAS', classroom_config=? WHERE id=?").run(slotConfig(''), noCapLesson.id);
seedDb.prepare('DELETE FROM course_lesson_capabilities WHERE lesson_id=?').run(noCapLesson.id);
// 只开生图、不开文字：验证能力位仍然拦住 TEXT 生成（空能力位会回落成 ['text']，不能作为反例）
seedDb.prepare("INSERT INTO course_lesson_capabilities(lesson_id,capability,created_at) VALUES (?,'image',datetime('now'))").run(noCapLesson.id);
seedDb.close();

const port = 18852;
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

async function waitForJob(token, jobId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const detail = await api(`/api/ai/generations/history/${jobId}`, { token });
    if (['SUCCEEDED', 'FAILED'].includes(detail.data?.status)) return detail.data;
    await sleep(500);
  }
  throw new Error('生成任务未在预期时间内结束');
}

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } });
  assert.equal(login.status, 200, `学生登录失败: ${JSON.stringify(login.data)}`);
  const student = login.data.token;

  // 1) 课时配置下发到学生项目
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: textLesson.id, title: 'P20 文字框体用例' } });
  assert.equal(project.status, 200, `项目创建失败: ${JSON.stringify(project.data)}`);
  assert.equal(project.data.generationSlots.text?.count, 1, `文字框体数量应为 1，实际 ${project.data.generationSlots.text?.count}`);
  assert.equal(project.data.generationSlots.text?.model, 'mock-text-model', '文字框体模型应下发');
  assert.ok(project.data.capabilities.includes('text'), '课时应开放 AI 文字能力');

  // 2) 生成文字成功，模型来自课时配置，文字写进素材
  const queued = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, modality: 'TEXT', prompt: '用一句话描写春天', title: '春天' } });
  assert.equal(queued.status, 200, `文字生成入队失败: ${JSON.stringify(queued.data)}`);
  const job = await waitForJob(student, queued.data.job.id);
  assert.equal(job.status, 'SUCCEEDED', `文字生成应成功，实际 ${job.status}（${job.errorCode || ''}）`);
  assert.equal(job.model, 'mock-text-model', `应使用课时指定的文字模型，实际 ${job.model}`);
  const text = String(job.assets?.[0]?.metadata?.text || '');
  assert.ok(text.length > 0, '生成的文字素材应带 metadata.text');
  assert.match(text, /本地模拟回复/, `文字内容应可读，实际 ${JSON.stringify(text.slice(0, 60))}`);
  assert.equal(job.creditsCharged, 1, '成功生成应扣 1 积分');

  // 3) 框体数量用尽后拒绝（入队前就拦，不跑上游、不扣费）
  const second = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, modality: 'TEXT', prompt: '再来一句' } });
  assert.equal(second.status, 403, `超出文字框体数量应被拒，实际 ${second.status}`);
  assert.equal(second.data?.error?.code, 'LESSON_GENERATION_SLOT_LIMIT', `错误码应为 LESSON_GENERATION_SLOT_LIMIT，实际 ${second.data?.error?.code}`);

  // 4) 课时没开放「AI 文字」时仍然拒绝
  const noCapProject = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: noCapLesson.id, title: 'P20 未开放文字' } });
  assert.equal(noCapProject.status, 200, `第二个项目创建失败: ${JSON.stringify(noCapProject.data)}`);
  assert.equal(noCapProject.data.generationSlots.text?.count, 1, '未开放能力也应能读到框体配置');
  const blocked = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: noCapProject.data.id, modality: 'TEXT', prompt: '不该成功' } });
  assert.equal(blocked.status, 403, `未开放 AI 文字时应被拒，实际 ${blocked.status}`);
  assert.equal(blocked.data?.error?.code, 'LESSON_CAPABILITY_DISABLED', `错误码应为 LESSON_CAPABILITY_DISABLED，实际 ${blocked.data?.error?.code}`);

  console.log(JSON.stringify({
    name: 'canvas-text-slot', pass: true,
    slot: { count: project.data.generationSlots.text.count, model: project.data.generationSlots.text.model },
    generated: { model: job.model, chars: text.length, creditsCharged: job.creditsCharged },
    guards: { slotLimit: second.data?.error?.code, capability: blocked.data?.error?.code },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
