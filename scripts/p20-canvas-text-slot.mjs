/**
 * P20 画布「文字框体」：课时按框体配置 → 学生生成文字 → 框体占用与能力位约束。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：课时文字框体（模型/预填提示词）下发到学生项目 → TEXT 生成成功并把文字写进素材、任务记录 boxId →
 * 同一个框体只能生成一次 → 课时未开放「AI 文字」时拒绝（能力位仍然生效）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

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
// 生成框体是素材表里 type=GENERATION_BOX 的素材（id 直接当 boxId 用）
const seedTextBox = (lessonId, model, boxId) => {
  seedDb.prepare("UPDATE course_lessons SET delivery_mode='CANVAS', classroom_config=? WHERE id=?").run(JSON.stringify({ version: 3 }), lessonId);
  seedDb.prepare("INSERT INTO course_lesson_material_groups(id,lesson_id,title,sort,created_at,updated_at) VALUES (?,?,?,1,datetime('now'),datetime('now'))").run(`mg-${lessonId}`, lessonId, '生成框体');
  seedDb.prepare("INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES (?,?,?,?,'GENERATION_BOX',NULL,?,1,datetime('now'),datetime('now'))")
    .run(boxId, `mg-${lessonId}`, '素材1', '', JSON.stringify({ box: { modality: 'TEXT', model }, content: '用一句话描写春天' }));
};
seedTextBox(textLesson.id, 'mock-text-model', 'box-text-1');
seedDb.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id,capability,created_at) VALUES (?,'text',datetime('now'))").run(textLesson.id);
seedTextBox(noCapLesson.id, '', 'box-text-2');
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
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
    await sleep(100);
  }

  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } });
  assert.equal(login.status, 200, `学生登录失败: ${JSON.stringify(login.data)}`);
  const student = login.data.token;

  // 1) 课时配置下发到学生项目
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: textLesson.id, title: 'P20 文字框体用例' } });
  assert.equal(project.status, 200, `项目创建失败: ${JSON.stringify(project.data)}`);
  assert.equal(project.data.generationBoxes?.length, 1, `文字框体应下发 1 个，实际 ${project.data.generationBoxes?.length}`);
  assert.equal(project.data.generationBoxes?.[0]?.model, 'mock-text-model', '文字框体模型应下发');
  assert.equal(project.data.generationBoxes?.[0]?.prompt, '用一句话描写春天', '框体预填提示词应下发');
  assert.ok(project.data.capabilities.includes('text'), '课时应开放 AI 文字能力');

  // 2) 生成文字成功，模型来自课时配置，文字写进素材
  const queued = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: 'box-text-1', modality: 'TEXT', prompt: '用一句话描写春天', title: '春天' } });
  assert.equal(queued.status, 200, `文字生成入队失败: ${JSON.stringify(queued.data)}`);
  const job = await waitForJob(student, queued.data.job.id);
  assert.equal(job.status, 'SUCCEEDED', `文字生成应成功，实际 ${job.status}（${job.errorCode || ''}）`);
  assert.equal(job.model, 'mock-text-model', `应使用课时指定的文字模型，实际 ${job.model}`);
  assert.equal(job.boxId, 'box-text-1', `任务应记录来源框体，实际 ${job.boxId}`);
  const text = String(job.assets?.[0]?.metadata?.text || '');
  assert.ok(text.length > 0, '生成的文字素材应带 metadata.text');
  assert.match(text, /本地模拟回复/, `文字内容应可读，实际 ${JSON.stringify(text.slice(0, 60))}`);
  // 2026-09-13（P4 删积分）：任务详情不再带积分字段；扣费看算力池账本（cost_fen）
  assert.equal(job.creditsCharged, undefined, '任务详情不该再有积分字段');
  const costDb = new DatabaseSync(dbPath);
  const costFen = Number(costDb.prepare("SELECT COALESCE(SUM(cost_fen),0) fen FROM usage_records WHERE modality='TEXT' AND status='SUCCESS'").get()?.fen || 0);
  costDb.close();
  assert.equal(costFen, 0, `平台承担成本，成功生成不得记录学生售价，实际 ${costFen}`);
  // C3 前置（2026-09-13）：上游给的 token 用量要落进账本（计费口径不变，但账本从此有据可查）
  const tokenDb = new DatabaseSync(dbPath);
  const tokens = tokenDb.prepare("SELECT input_tokens, output_tokens FROM usage_records WHERE modality='TEXT' AND status='SUCCESS' ORDER BY created_at DESC LIMIT 1").get();
  tokenDb.close();
  assert.ok(Number(tokens?.input_tokens) > 0 && Number(tokens?.output_tokens) > 0, `用量记录应带上游 token 数，实际 ${JSON.stringify(tokens)}`);

  // 3) 同一个框体只能生成一次（入队前就拦，不跑上游、不扣费）
  const second = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: 'box-text-1', modality: 'TEXT', prompt: '再来一句' } });
  assert.equal(second.status, 403, `重复生成同一个框体应被拒，实际 ${second.status}`);
  assert.equal(second.data?.error?.code, 'GENERATION_BOX_USED', `错误码应为 GENERATION_BOX_USED，实际 ${second.data?.error?.code}`);

  // 4) 课时没开放「AI 文字」时仍然拒绝
  const noCapProject = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: noCapLesson.id, title: 'P20 未开放文字' } });
  assert.equal(noCapProject.status, 200, `第二个项目创建失败: ${JSON.stringify(noCapProject.data)}`);
  assert.equal(noCapProject.data.generationBoxes?.length, 1, '未开放能力也应能读到框体配置');
  const blocked = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: noCapProject.data.id, boxId: 'box-text-2', modality: 'TEXT', prompt: '不该成功' } });
  assert.equal(blocked.status, 403, `未开放 AI 文字时应被拒，实际 ${blocked.status}`);
  assert.equal(blocked.data?.error?.code, 'LESSON_CAPABILITY_DISABLED', `错误码应为 LESSON_CAPABILITY_DISABLED，实际 ${blocked.data?.error?.code}`);

  console.log(JSON.stringify({
    name: 'canvas-text-slot', pass: true,
    box: { count: project.data.generationBoxes.length, model: project.data.generationBoxes[0].model },
    generated: { model: job.model, chars: text.length, costFen },
    guards: { boxUsed: second.data?.error?.code, capability: blocked.data?.error?.code },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
