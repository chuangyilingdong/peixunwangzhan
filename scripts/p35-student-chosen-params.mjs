/**
 * P35 学生自选生成参数：平台不填的参数，交给学生在画布课堂里选。
 *
 * 覆盖：
 *  1. 平台留空的框体：项目接口下发空参数 + paramOptions（该模型的可选值），学生端据此渲染下拉
 *  2. 学生选的值被采纳，并落库 generation_jobs.request_options
 *     （异步 worker 会按框体重新解析一次参数，不落库学生的选择会被重算掉）
 *  3. 学生选的值超出模型能力白名单 → 当场 400，不静默换成别的
 *  4. 平台定过参数的框体：学生传什么都不采信（不落 request_options，也不会因学生传非法值被拒）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p35-student-params-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
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

const port = 18916;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const rootToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(rootToken && student, '登录失败');

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const lesson = db.prepare('SELECT id FROM course_lessons ORDER BY sort LIMIT 1').get();
  db.close();

  // 素材1：生图框体，平台留空（比例/清晰度都不选）；素材2：生图框体，平台把比例定成 4:3
  const saved = await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: {
      capabilities: ['text', 'image'],
      classroomConfig: { version: 3 },
      materialGroups: [{
        title: '素材1',
        materials: [
          { title: '学生自选', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'IMAGE', model: '' }, content: '一只小猫' } },
          { title: '平台指定', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'IMAGE', model: '', aspectRatio: '4:3', resolution: '1k' }, content: '一只小狗' } },
        ],
      }],
    },
  });
  assert.equal(saved.status, 200, `课时保存失败: ${JSON.stringify(saved.data)}`);
  const boxes = saved.data.lessons.find((item) => item.id === lesson.id).generationBoxes;
  const openBox = boxes.find((box) => box.title === '学生自选');
  const lockedBox = boxes.find((box) => box.title === '平台指定');
  assert.equal(openBox.aspectRatio, '', '平台留空的比例应保持为空（表示学生自选）');
  assert.equal(openBox.resolution, '', '平台留空的清晰度应保持为空');
  assert.ok(Array.isArray(openBox.paramOptions?.aspectRatios) && openBox.paramOptions.aspectRatios.length, '应下发模型可选比例');
  assert.equal(lockedBox.aspectRatio, '4:3', '平台指定的比例应原样保留');
  assert.equal(lockedBox.resolution, '1k', '平台指定的清晰度应原样保留');

  const project = (await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lesson.id, title: 'P35 学生自选参数' } })).data;
  const openFromProject = project.generationBoxes.find((box) => box.id === openBox.id);
  assert.equal(openFromProject.aspectRatio, '', '项目接口也应下发空参数');
  assert.ok(openFromProject.paramOptions?.aspectRatios?.length, '项目接口应下发 paramOptions');

  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  const jobOptions = (jobId) => db2.prepare('SELECT request_options FROM generation_jobs WHERE id=?').get(jobId)?.request_options || null;

  // 2) 学生选的参数被采纳并落库
  const chosen = openBox.paramOptions.aspectRatios[openBox.paramOptions.aspectRatios.length - 1];
  const chosenQuality = openBox.paramOptions.resolutions[openBox.paramOptions.resolutions.length - 1];
  const queued = await api('/api/ai/generations/async', {
    method: 'POST', token: student,
    body: { projectId: project.id, boxId: openBox.id, modality: 'IMAGE', prompt: '一只小猫', aspectRatio: chosen, resolution: chosenQuality },
  });
  assert.equal(queued.status, 200, `生成入队失败: ${JSON.stringify(queued.data)}`);
  const stored = JSON.parse(jobOptions(queued.data.job.id) || '{}');
  assert.equal(stored.aspectRatio, chosen, `学生选的比例应落库（实际 ${JSON.stringify(stored)}）`);
  assert.equal(stored.resolution, chosenQuality, '学生选的清晰度应落库');

  // 3) 超出模型能力白名单 → 当场 400
  const illegal = await api('/api/ai/generations/async', {
    method: 'POST', token: student,
    body: { projectId: project.id, boxId: openBox.id, modality: 'IMAGE', prompt: '一只小猫', aspectRatio: chosen, resolution: '99k' },
  });
  assert.equal(illegal.status, 400, `非法清晰度应被拒（实际 ${illegal.status}）`);
  assert.equal(illegal.data?.error?.code, 'GENERATION_PARAM_INVALID', `拒绝原因应为参数非法（实际 ${JSON.stringify(illegal.data)}）`);

  // 4) 平台定过的框体：学生传的值一律不采信
  const lockedQueued = await api('/api/ai/generations/async', {
    method: 'POST', token: student,
    body: { projectId: project.id, boxId: lockedBox.id, modality: 'IMAGE', prompt: '一只小狗', aspectRatio: '9:16', resolution: '99k' },
  });
  assert.equal(lockedQueued.status, 200, `平台定过参数时学生传非法值也不该被拒: ${JSON.stringify(lockedQueued.data)}`);
  assert.equal(jobOptions(lockedQueued.data.job.id), null, '平台定过参数时不应记录学生的选择');
  db2.close();

  console.log(JSON.stringify({
    name: 'student-chosen-params', pass: true,
    openBox: { aspectRatio: openBox.aspectRatio, resolution: openBox.resolution, options: openBox.paramOptions },
    studentChoicePersisted: stored,
    illegalRejected: illegal.data?.error?.code,
    lockedBoxIgnoresStudent: true,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
