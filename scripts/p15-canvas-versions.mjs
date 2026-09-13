/**
 * P15 画布版本管理闭环。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 背景：画布版本管理的 6 个前端函数（预览/恢复/重命名/导出/对比/导入）此前没有任何入口，
 * 服务端版本接口也没有冒烟覆盖。本脚本覆盖服务端这一环：
 * 每次保存生成新版本 → 列表分页与排序 → 按版本取快照 → 重命名 → 恢复到新版本。
 * （导出/导入是纯前端文件读写，不在本脚本范围。）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-canvas-versions-'));
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
const node = (id, text) => ({ id, type: 'note', position: { x: 40, y: 40 }, data: { title: text, text } });
const canvas = (...nodes) => ({ nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } });

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18845;
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
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
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

  const courses = await api('/api/student/courses', { token: student });
  const courseItems = courses.data?.items || courses.data?.courses || [];
  const lessonId = courseItems?.[0]?.currentLessonId || courseItems?.[0]?.lessons?.[0]?.id || courseItems?.[0]?.lesson?.id || courseItems?.[0]?.id;
  assert.ok(lessonId, `未获取到课时 ID: ${JSON.stringify(courses.data)}`);

  const created = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title: 'P15 版本管理', canvasSnapshot: canvas(node('n1', '初始节点')) } });
  assert.equal(created.status, 200, `项目创建失败: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;

  // 保存两次，各生成一个新版本（v2 / v3）
  const saved2 = await api(`/api/student/projects/${projectId}`, { method: 'PUT', token: student, body: { canvasSnapshot: canvas(node('n1', '初始节点'), node('n2', '新增节点')), label: '第二次保存' } });
  assert.equal(saved2.status, 200, `第二次保存失败: ${JSON.stringify(saved2.data)}`);
  assert.equal(saved2.data.latestVersion, 2, `保存后版本应为 2，实际 ${saved2.data.latestVersion}`);
  const saved3 = await api(`/api/student/projects/${projectId}`, { method: 'PUT', token: student, body: { canvasSnapshot: canvas(node('n1', '初始节点'), node('n2', '新增节点'), node('n3', '第三个节点')) } });
  assert.equal(saved3.status, 200, `第三次保存失败: ${JSON.stringify(saved3.data)}`);
  assert.equal(saved3.data.latestVersion, 3, `保存后版本应为 3，实际 ${saved3.data.latestVersion}`);

  // 列表：分页元数据 + 版本倒序 + 自定义标签
  const list = await api(`/api/student/projects/${projectId}/snapshots?limit=2&page=1`, { token: student });
  assert.equal(list.status, 200, `版本列表读取失败: ${JSON.stringify(list.data)}`);
  assert.equal(list.data.total, 3, `版本总数应为 3，实际 ${list.data.total}`);
  assert.equal(list.data.totalPages, 2, `limit=2 时 totalPages 应为 2，实际 ${list.data.totalPages}`);
  assert.equal(list.data.items.length, 2, '第 1 页应返回 2 条');
  assert.equal(list.data.items[0].version, 3, '版本列表应按版本倒序');
  assert.equal(list.data.items[1].label, '第二次保存', '自定义标签应保存');

  // 按版本取快照：内容与操作者
  const v1 = await api(`/api/student/projects/${projectId}/snapshots/1`, { token: student });
  assert.equal(v1.status, 200, `读取版本 1 失败: ${JSON.stringify(v1.data)}`);
  assert.equal(v1.data.canvasSnapshot.nodes.length, 1, '版本 1 应只有 1 个节点');
  assert.equal(v1.data.actorName, '小红', `版本应带操作者姓名，实际 ${v1.data.actorName}`);

  // 重命名
  const renamed = await api(`/api/student/projects/${projectId}/snapshots/1`, { method: 'PUT', token: student, body: { label: '重命名后的初始版本' } });
  assert.equal(renamed.status, 200, `重命名失败: ${JSON.stringify(renamed.data)}`);
  assert.equal(renamed.data.label, '重命名后的初始版本', '重命名应生效');

  // 恢复：把 v1 的内容保存为新版本
  const restored = await api(`/api/student/projects/${projectId}`, { method: 'PUT', token: student, body: { canvasSnapshot: v1.data.canvasSnapshot, label: '恢复版本 1' } });
  assert.equal(restored.status, 200, `恢复失败: ${JSON.stringify(restored.data)}`);
  assert.equal(restored.data.latestVersion, 4, `恢复后应生成版本 4，实际 ${restored.data.latestVersion}`);
  assert.equal(restored.data.canvasSnapshot.nodes.length, 1, '恢复后当前画布应为版本 1 的内容');

  const after = await api(`/api/student/projects/${projectId}/snapshots?limit=200`, { token: student });
  assert.equal(after.data.total, 4, `恢复后版本总数应为 4，实际 ${after.data.total}`);
  const restoredSnapshot = after.data.items.find((item) => item.version === 4);
  assert.equal(restoredSnapshot.label, '恢复版本 1', '恢复版本应保留标签');
  const restoredDetail = await api(`/api/student/projects/${projectId}/snapshots/4`, { token: student });
  assert.equal(restoredDetail.data.canvasSnapshot.nodes.length, 1, '恢复出的版本内容应与版本 1 一致');

  console.log(JSON.stringify({
    name: 'canvas-version-loop',
    pass: true,
    versions: after.data.total,
    labels: after.data.items.map((item) => `v${item.version}:${item.label || ''}`),
    actorName: v1.data.actorName,
    pagination: { total: list.data.total, totalPages: list.data.totalPages },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
