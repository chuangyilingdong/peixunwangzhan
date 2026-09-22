/**
 * P128 画布**自动保存**这条路由真的可达（2026-09-22 用户报的「保存失败：接口不存在」）。
 *
 * 根因不是前端：`apps/server/src/routes/student.js` 那个大函数里 `match` 是**复用**的一个变量。
 * 第二十七轮 §二.S 在 GET 之后、PUT 之前插进了 `session-state` 那条，把它覆盖成
 * `/projects/([^/]+)/session-state` —— 于是 `PUT /api/student/projects/<id>` 走到
 * `if (match && method === 'PUT')` 时 `match` 已经是 null（那个地址里没有 `/session-state`），
 * 整个分支被跳过、落到最外层变成 `ROUTE_NOT_FOUND`，前端看到的就一句「接口不存在」。
 *
 * 后果比提示看起来重得多：**学生的画布改动一条都写不回服务器**（自动保存是唯一那条写路径），
 * 而界面上只是顶栏角落里一行小字。这类"路由不可达"必须**打真 HTTP**才验得出来 ——
 * 直接调处理函数、或只看前端源码，都是绿的。
 *
 * ⚠️ 所以这个守卫**起真服务、发真请求**（p78 那套起法），不搞源码断言。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p128-autosave-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

// 给种子里那个学生一份课包许可（没有许可进不了画布）
const seeded = {};
{
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  const student = db.prepare("SELECT id, org_id FROM users WHERE login='student-2'").get();
  const grant = db.prepare('SELECT series_id FROM student_course_grants WHERE student_id=?').get(student.id);
  const lesson = db.prepare('SELECT id FROM course_lessons WHERE series_id=? ORDER BY sort LIMIT 1').get(grant.series_id);
  // 画布只在**课正在上**的时候可用（口径：进操作环境看的是"有没有许可 + 有没有排进这节课的课堂"），
  // 而种子里没有课堂 —— 这里把课时开放成画布课，后面由机构管理员真开一间。
  db.prepare("UPDATE course_lessons SET status='PUBLISHED', delivery_modes='[\"CANVAS\"]' WHERE id=?").run(lesson.id);
  Object.assign(seeded, { studentId: student.id, orgId: student.org_id, seriesId: grant.series_id, lessonId: lesson.id });
  db.close();
}

const port = 19082;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null };
}

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data?.token;
  assert.ok(student, '学生登录失败');

  // 真开一间课堂（否则「老师还没有把这节课的课堂安排给你」——那条门禁本身是对的）
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data?.token;
  assert.ok(orgAdmin, '机构管理员登录失败');
  const session = await api('/api/org/sessions', { method: 'POST', token: orgAdmin, body: { lessonId: seeded.lessonId, deliveryMode: 'CANVAS', title: 'P128 课堂' } });
  const sessionId = session.data?.id;
  check('① 开课堂成功', Boolean(sessionId), JSON.stringify(session).slice(0, 220));
  await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: orgAdmin, body: { studentIds: [seeded.studentId] } });
  const started = await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: orgAdmin });
  check('① 开始上课', started.status === 200, JSON.stringify(started).slice(0, 160));

  const created = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: seeded.lessonId, title: 'P128 自动保存', sessionId } });
  const projectId = created.data?.id;
  check('① 建项目成功（后面才有得存）', Boolean(projectId), JSON.stringify(created).slice(0, 220));
  if (!projectId) throw new Error('建项目失败，后面验不了');

  // ② 自动保存那条：PUT /api/student/projects/<id>，带 autoSave
  const snapshot = { nodes: [{ id: 'p128-node', type: 'text', position: { x: 10, y: 20 }, data: { text: 'P128 自动保存的内容' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const saved = await api(`/api/student/projects/${projectId}`, { method: 'PUT', token: student, body: { canvasSnapshot: snapshot, autoSave: true } });
  check('② 自动保存这条路走通了（PUT 带 autoSave）—— 断了就是「保存失败：接口不存在」',
    saved.status === 200, `HTTP ${saved.status}：${JSON.stringify(saved.error).slice(0, 160)}`);

  // ③ 存进去的东西真的落库了（别只回 200 却没写）
  const reloaded = await api(`/api/student/projects/${projectId}`, { token: student });
  const persisted = JSON.stringify(reloaded.data?.canvasSnapshot || {});
  check('③ 画布内容真的写进去了（重新取回来能看到那个节点）', persisted.includes('P128 自动保存的内容'), persisted.slice(0, 200));

  // ④ 改名那条也在同一个 `match` 上（顺手钉住，免得下次再被覆盖）
  const renamed = await api(`/api/student/projects/${projectId}`, { method: 'PUT', token: student, body: { title: 'P128 改过名' } });
  check('④ 同一路由上的改名也通（同一个 match 覆盖它一次就够两个一起坏）', renamed.status === 200 && renamed.data?.title === 'P128 改过名', JSON.stringify(renamed).slice(0, 160));

  // ⑤ 【反向】真不存在的接口仍然要 404 —— 证明不是把整条路由都吞了
  const bogus = await api(`/api/student/projects/${projectId}/definitely-not-a-route`, { method: 'PUT', token: student, body: { title: 'x' } });
  check('⑤ 【反向】不存在的子路径仍然是「接口不存在」（不是把路由放宽了）',
    bogus.error?.code === 'ROUTE_NOT_FOUND', JSON.stringify(bogus).slice(0, 160));

  // ⑥ 相邻那两条（session-state / GET）没被这次改动碰坏
  const state = await api(`/api/student/projects/${projectId}/session-state`, { token: student });
  check('⑥ 紧挨着的 session-state 仍然正常（改的是它前面的 match，不是它）', state.status === 200 && typeof state.data?.active === 'boolean', JSON.stringify(state).slice(0, 160));
} finally {
  server.kill('SIGTERM');
}

console.log('');
if (failures) { console.log(`✗ p128 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p128 画布自动保存路由：全部通过');
