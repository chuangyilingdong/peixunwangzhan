/**
 * P33 画布不丢：自动保存 + 刷新后恢复生成状态。
 *
 * 覆盖：
 *  1. PUT autoSave=true 只写画布，**不递增版本号、不产生版本记录**（避免刷新/连续改动灌满版本历史）
 *  2. 不带 autoSave 的保存仍然生成版本（版本管理保持可用）
 *  3. 学生项目接口下发 generationBoxes（前端据此恢复「哪些框体已有任务」）与画布快照，
 *     服务端任务列表带 boxId + assets，前端刷新后能把「生成中/已完成」接回来
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-canvas-persist-'));
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

const port = 18915;
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
async function waitForJob(token, jobId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const detail = await api(`/api/ai/generations/history/${jobId}`, { token });
    if (['SUCCEEDED', 'FAILED'].includes(detail.data?.status)) return detail.data;
    await sleep(500);
  }
  throw new Error('生成任务未在预期时间内结束');
}

const node = (id, extra = {}) => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { title: id, ...extra } });

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

  // 课时里放一个生图框体
  const saved = await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: {
      capabilities: ['text', 'image'], classroomConfig: { version: 3 },
      materialGroups: [{ title: '素材1', materials: [{ title: '主图', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'IMAGE', model: '', aspectRatio: '9:16', resolution: '1k' }, content: '一只小猫' } }] }],
    },
  });
  assert.equal(saved.status, 200, `课时保存失败: ${JSON.stringify(saved.data)}`);
  const box = saved.data.lessons.find((item) => item.id === lesson.id).generationBoxes[0];

  const project = (await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lesson.id, title: 'P33 画布不丢' } })).data;
  const startVersion = Number(project.latestVersion || 1);

  // 1) 自动保存：写画布 + 不涨版本号 + 不产生版本记录
  const before = (await api(`/api/student/projects/${project.id}/snapshots?limit=200`, { token: student })).data.items.length;
  const auto = await api(`/api/student/projects/${project.id}`, {
    method: 'PUT', token: student,
    body: { canvasSnapshot: { nodes: [node('box-' + box.id, { boxId: box.id })], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, autoSave: true },
  });
  assert.equal(auto.status, 200, `自动保存失败: ${JSON.stringify(auto.data)}`);
  assert.equal(Number(auto.data.latestVersion), startVersion, `自动保存不应递增版本号（${startVersion} → ${auto.data.latestVersion}）`);
  assert.equal(auto.data.canvasSnapshot.nodes.length, 1, '自动保存后画布里应有节点');
  const after = (await api(`/api/student/projects/${project.id}/snapshots?limit=200`, { token: student })).data.items.length;
  assert.equal(after, before, `自动保存不应产生版本记录（${before} → ${after}）`);

  // 2) 手动保存仍然生成版本
  const manual = await api(`/api/student/projects/${project.id}`, {
    method: 'PUT', token: student,
    body: { canvasSnapshot: { nodes: [node('box-' + box.id, { boxId: box.id }), node('extra')], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, label: '画布编辑' },
  });
  assert.equal(manual.status, 200, '手动保存失败');
  assert.equal(Number(manual.data.latestVersion), startVersion + 1, `手动保存应递增版本号（实际 ${manual.data.latestVersion}）`);
  const versions = (await api(`/api/student/projects/${project.id}/snapshots?limit=200`, { token: student })).data.items;
  assert.equal(versions.length, before + 1, `手动保存应新增一条版本记录（实际 ${versions.length}）`);

  // 3) 刷新后恢复生成状态所需的字段都在：
  //    项目下发 generationBoxes（框体定义）+ canvasSnapshot（学生已经加过的节点）
  const reloaded = (await api(`/api/student/projects/${project.id}`, { token: student })).data;
  assert.ok(Array.isArray(reloaded.generationBoxes) && reloaded.generationBoxes.length === 1, '项目应下发 generationBoxes');
  assert.ok((reloaded.canvasSnapshot?.nodes || []).some((n) => n.data?.boxId === box.id), '画布快照里应保留框体节点');

  // 生成一次并等结束，任务列表要能按 boxId 找到它（前端据此把「生成中/已完成」接回来）
  const queued = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.id, boxId: box.id, modality: 'IMAGE', prompt: '一只小猫' } });
  assert.equal(queued.status, 200, `生成入队失败: ${JSON.stringify(queued.data)}`);
  const jobId = queued.data.job.id;

  const running = (await api(`/api/ai/generations/history/${jobId}`, { token: student })).data;
  assert.equal(running.boxId, box.id, '任务详情应带 boxId');

  const done = await waitForJob(student, jobId);
  assert.equal(done.status, 'SUCCEEDED', `生成应成功，实际 ${done.status}`);
  const history = (await api(`/api/ai/generations?projectId=${encodeURIComponent(project.id)}`, { token: student })).data;
  const matched = (history.items || []).find((item) => item.boxId === box.id);
  assert.ok(matched, '生成历史里应能按 boxId 找到任务');
  assert.equal(matched.status, 'SUCCEEDED', '历史里的任务状态应为 SUCCEEDED');
  assert.ok(matched.assets?.length, '历史里的任务应带 assets（刷新后把结果挂回画布要用）');

  console.log(JSON.stringify({
    name: 'canvas-persistence', pass: true,
    autoSave: { versionUnchanged: Number(auto.data.latestVersion) === startVersion, noNewSnapshotRow: after === before },
    manualSave: { versionBumped: Number(manual.data.latestVersion) === startVersion + 1, newSnapshotRow: versions.length === before + 1 },
    restore: { boxes: reloaded.generationBoxes.length, canvasNodes: reloaded.canvasSnapshot.nodes.length, jobStatus: matched.status, hasAsset: Boolean(matched.assets?.length) },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
