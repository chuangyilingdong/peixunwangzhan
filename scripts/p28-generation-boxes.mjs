/**
 * P28 生成框体「按框体配置」：每个框体单独选模型与参数（比例/清晰度/时长/音频），
 * 学生端按顺序逐个生成、每个框体只能生成一次。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：管理员保存逐框体配置（含预填提示词与预置素材）→ 校验非法取值当场 400 →
 * 学生项目按顺序下发框体 → 每框体取自己的参数生成（9:16 与 16:9、5 秒与 10 秒互不影响）→
 * 同一框体不能生成第二次 → 未知框体/缺框体被拒 → 无框体模态仍可自由生成。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p28-boxes-'));
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

const port = 18912;
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

const BOXES = [
  { id: 'box-image-vertical', title: '竖版主图', modality: 'IMAGE', model: '', aspectRatio: '9:16', resolution: '2k', prompt: '画一只会飞的小猫' },
  { id: 'box-image-wide', title: '横版插图', modality: 'IMAGE', model: '', aspectRatio: '16:9', resolution: '1k', prompt: '画一座云上的城堡' },
  { id: 'box-video-short', title: '开场短片', modality: 'VIDEO', model: '', aspectRatio: '16:9', resolution: '480p', durationSeconds: 5, audio: false },
  { id: 'box-video-long', title: '结尾短片', modality: 'VIDEO', model: '', aspectRatio: '9:16', resolution: '480p', durationSeconds: 10, audio: false, assetUrl: '/api/student/file-assets/asset-seed/download' },
];

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const rootToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  assert.ok(rootToken, 'root 登录失败');
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(student, '学生登录失败');

  const { DatabaseSync } = await import('node:sqlite');
  const seedDb = new DatabaseSync(dbPath);
  const lesson = seedDb.prepare('SELECT id FROM course_lessons ORDER BY sort LIMIT 1').get();
  seedDb.close();
  assert.ok(lesson?.id, '种子数据应至少有一个课时');

  // 1) 非法取值当场 400（逐框体校验，不再静默丢弃）
  const badBox = await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: { capabilities: ['image', 'video'], classroomConfig: { version: 2, generationBoxes: [{ id: 'box-bad', title: '坏框体', modality: 'IMAGE', aspectRatio: '16-9', resolution: '1k' }] } },
  });
  assert.equal(badBox.status, 400, `非法比例应被拒，实际 ${badBox.status}`);
  assert.equal(badBox.data?.error?.code, 'INVALID_GENERATION_CONFIG', '错误码应为 INVALID_GENERATION_CONFIG');
  assert.ok(String(badBox.data.error.message).includes('16-9'), '错误信息应指出具体框体与非法值');

  // 2) 合法配置保存成功，并按顺序原样存回
  const saved = await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: { capabilities: ['image', 'video'], classroomConfig: { version: 2, generationBoxes: BOXES } },
  });
  assert.equal(saved.status, 200, `合法框体配置应保存成功: ${JSON.stringify(saved.data)}`);
  const savedBoxes = saved.data.lessons.find((item) => item.id === lesson.id).classroomConfig.generationBoxes;
  assert.deepEqual(savedBoxes.map((box) => box.id), BOXES.map((box) => box.id), '框体顺序与 id 应原样保留');
  assert.deepEqual(savedBoxes.map((box) => box.aspectRatio), ['9:16', '16:9', '16:9', '9:16'], '每个框体保留自己的比例');
  assert.deepEqual(savedBoxes.map((box) => box.durationSeconds).filter((value) => value !== undefined), [5, 10], '两个视频框体各自保留时长');

  // 3) 学生项目按顺序下发框体（含预填提示词与预置素材）
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lesson.id, title: 'P28 逐框体配置' } });
  assert.equal(project.status, 200, `项目创建失败: ${JSON.stringify(project.data)}`);
  const boxes = project.data.generationBoxes || [];
  assert.deepEqual(boxes.map((box) => box.id), BOXES.map((box) => box.id), '学生端应按顺序拿到 4 个框体');
  assert.equal(boxes[0].prompt, '画一只会飞的小猫', '框体预填提示词应下发');
  assert.equal(boxes[3].assetUrl, BOXES[3].assetUrl, '框体预置素材应下发');
  assert.equal(boxes[2].durationSeconds, 5, '开场短片应为 5 秒');
  assert.equal(boxes[3].durationSeconds, 10, '结尾短片应为 10 秒');

  // 4) 每框体取自己的参数：两个图片框比例/清晰度互不影响，两个视频框时长互不影响
  const { generationOptionsFor } = await import('../apps/server/src/routes/aiGeneration.js');
  const context = { lesson: { generationBoxes: boxes } };
  const policy = { provider: 'local-mock', channels: [], modalityChannels: {} };
  const selection = { provider: 'local-mock', model: 'canvas-mock-v1', channelId: 'default' };
  const vertical = generationOptionsFor({ context, modality: 'IMAGE', policy, selection, box: boxes[0] });
  const wide = generationOptionsFor({ context, modality: 'IMAGE', policy, selection, box: boxes[1] });
  assert.equal(vertical.aspectRatio, '9:16', `素材1 应为 9:16，实际 ${vertical.aspectRatio}`);
  assert.equal(vertical.resolution, '2k', `素材1 应为 2k，实际 ${vertical.resolution}`);
  assert.equal(wide.aspectRatio, '16:9', `素材2 应为 16:9，实际 ${wide.aspectRatio}`);
  assert.equal(wide.resolution, '1k', `素材2 应为 1k，实际 ${wide.resolution}`);
  const shortClip = generationOptionsFor({ context, modality: 'VIDEO', policy, selection, box: boxes[2] });
  const longClip = generationOptionsFor({ context, modality: 'VIDEO', policy, selection, box: boxes[3] });
  assert.equal(shortClip.durationSeconds, 5, `先 5 秒，实际 ${shortClip.durationSeconds}`);
  assert.equal(longClip.durationSeconds, 10, `再 10 秒，实际 ${longClip.durationSeconds}`);

  // 5) 逐个框体生成：素材1 成功 → 素材1 再来被拒 → 素材2 仍可生成
  const first = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: 'box-image-vertical', modality: 'IMAGE', prompt: '画一只会飞的小猫' } });
  assert.equal(first.status, 200, `素材1 生成入队失败: ${JSON.stringify(first.data)}`);
  const firstJob = await waitForJob(student, first.data.job.id);
  assert.equal(firstJob.status, 'SUCCEEDED', `素材1 应生成成功，实际 ${firstJob.status}（${firstJob.errorCode || ''}）`);
  assert.equal(firstJob.boxId, 'box-image-vertical', '任务应记录来源框体');

  const again = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: 'box-image-vertical', modality: 'IMAGE', prompt: '再画一次' } });
  assert.equal(again.status, 403, `同一框体不能生成第二次，实际 ${again.status}`);
  assert.equal(again.data?.error?.code, 'GENERATION_BOX_USED', `错误码应为 GENERATION_BOX_USED，实际 ${again.data?.error?.code}`);

  const second = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: 'box-image-wide', modality: 'IMAGE', prompt: '画一座云上的城堡' } });
  assert.equal(second.status, 200, `素材2 应能独立生成: ${JSON.stringify(second.data)}`);
  const secondJob = await waitForJob(student, second.data.job.id);
  assert.equal(secondJob.status, 'SUCCEEDED', `素材2 应生成成功，实际 ${secondJob.status}`);

  // 6) 未知框体 / 本课配了框体却没带框体 id，都要在入队前被拒
  const unknown = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: 'box-not-exist', modality: 'IMAGE', prompt: '未知框体' } });
  assert.equal(unknown.status, 400, `未知框体应被拒，实际 ${unknown.status}`);
  assert.equal(unknown.data?.error?.code, 'GENERATION_BOX_NOT_FOUND', `错误码应为 GENERATION_BOX_NOT_FOUND，实际 ${unknown.data?.error?.code}`);
  const missing = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, modality: 'IMAGE', prompt: '没带框体' } });
  assert.equal(missing.status, 403, `缺框体 id 应被拒，实际 ${missing.status}`);
  assert.equal(missing.data?.error?.code, 'GENERATION_BOX_REQUIRED', `错误码应为 GENERATION_BOX_REQUIRED，实际 ${missing.data?.error?.code}`);

  // 7) 模态与框体类型不符：用图片框体生成视频要报错
  const mismatch = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: 'box-image-wide', modality: 'VIDEO', prompt: '类型不符' } });
  assert.equal(mismatch.status, 400, `框体类型不符应被拒，实际 ${mismatch.status}`);
  assert.equal(mismatch.data?.error?.code, 'GENERATION_BOX_MODALITY_MISMATCH', `错误码应为 GENERATION_BOX_MODALITY_MISMATCH，实际 ${mismatch.data?.error?.code}`);

  console.log(JSON.stringify({
    name: 'generation-boxes', pass: true,
    saved: savedBoxes.map((box) => ({ id: box.id, modality: box.modality, aspectRatio: box.aspectRatio, resolution: box.resolution, durationSeconds: box.durationSeconds })),
    perBoxOptions: {
      '素材1': { aspectRatio: vertical.aspectRatio, resolution: vertical.resolution },
      '素材2': { aspectRatio: wide.aspectRatio, resolution: wide.resolution },
      '开场短片': { durationSeconds: shortClip.durationSeconds },
      '结尾短片': { durationSeconds: longClip.durationSeconds },
    },
    guards: { reused: again.data?.error?.code, unknown: unknown.data?.error?.code, missing: missing.data?.error?.code, mismatch: mismatch.data?.error?.code },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
