/**
 * P56 排课候选筛选守卫（2026-09-12，P2 第三件）。
 * 规则（用户口径）：老师排课时只能挑「有该课包许可」且「没上过这节课」的学员；
 * 「上过」= 提交过作品（画布作品或 VibeCoding 提交，跨班级跨课堂都算）。名单落 class_lesson_students。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p56-lesson-students-'));
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
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const port = 18912;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const org = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data;
  const students = (await api('/api/org/users?role=STUDENT', { token: org.token })).data.items || [];
  assert.ok(admin && org?.token && students.length, '登录或学员缺失');
  const [first, second] = students;

  const created = await api('/api/admin/course-series', { method: 'POST', token: admin, body: { title: 'P56 排课课包', visibility: 'ALL_ORGS', stockTotal: 10, lessons: [{ title: '第1课', status: 'PUBLISHED', capabilities: ['text'], deliveryModes: ['CANVAS'] }] } });
  const seriesId = created.data.id; const lessonId = created.data.lessons[0].id;
  await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
  await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgIds: [org.organization.id], validityDays: 365, quotaTotal: 10 } });

  const classes = await api('/api/org/classes', { token: org.token });
  const classRow = (classes.data.items || []).find((c) => Number(c.studentCount || 0) > 0) || (classes.data.items || [])[0];
  assert.ok(classRow, '机构下没有班级');

  // 还没授权任何人：候选都不可选，原因写清
  let candidates = await api(`/api/org/classes/${classRow.id}/lesson-candidates?lessonId=${lessonId}`, { token: org.token });
  check('候选接口可用', candidates.status === 200 && Array.isArray(candidates.data.items), JSON.stringify(candidates.data).slice(0, 140));
  check('没授权的学员不可选，并给出原因', candidates.data.items.every((item) => !item.selectable && item.reason === '尚未被授权该课包'), JSON.stringify(candidates.data.items).slice(0, 160));

  // 给第一个学员授权 → 他变成可选
  await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [first.id] } });
  candidates = await api(`/api/org/classes/${classRow.id}/lesson-candidates?lessonId=${lessonId}`, { token: org.token });
  const firstRow = candidates.data.items.find((item) => item.studentId === first.id) || {};
  check('有许可的学员变为可选', firstRow.selectable === true && firstRow.hasGrant === true, JSON.stringify(firstRow));
  if (second) {
    const secondRow = candidates.data.items.find((item) => item.studentId === second.id) || {};
    check('没许可的学员仍然不可选', secondRow.selectable === false, JSON.stringify(secondRow));
  }

  // 没许可的学员排不进去（服务端拒绝并说明原因）
  if (second) {
    const bad = await api(`/api/org/classes/${classRow.id}/lesson-students`, { method: 'PUT', token: org.token, body: { lessonId, studentIds: [second.id] } });
    check('把没许可的学员排进来被拒', bad.status === 400 && bad.error?.code === 'LESSON_STUDENT_NOT_SELECTABLE', `${bad.status} ${bad.error?.code}`);
  }

  // 排进来 → 名单可读
  const ok = await api(`/api/org/classes/${classRow.id}/lesson-students`, { method: 'PUT', token: org.token, body: { lessonId, studentIds: [first.id] } });
  check('排课名单保存成功', ok.status === 200 && ok.data.count === 1, JSON.stringify(ok.data).slice(0, 120));
  candidates = await api(`/api/org/classes/${classRow.id}/lesson-candidates?lessonId=${lessonId}`, { token: org.token });
  check('名单里的学员标为已选中', (candidates.data.items.find((item) => item.studentId === first.id) || {}).selected === true);

  // 前置：把这节课排进班级课单，学员才进得去（否则 LESSON_NOT_ASSIGNED）
  const curriculum = await api(`/api/org/classes/${classRow.id}/curriculum`, { token: org.token });
  const existingLessons = (curriculum.data.items || []).map((item) => item.lessonId || item.id).filter(Boolean);
  await api(`/api/org/classes/${classRow.id}/curriculum`, { method: "PUT", token: org.token, body: { lessonIds: [...new Set([...existingLessons, lessonId])] } });

  // 前置：老师开这节课的课堂（跟随课堂账号要靠课堂会话才能进课时）
  const started = await api(`/api/org/classes/${classRow.id}/sessions/start`, { method: "POST", token: org.token, body: { lessonId, deliveryMode: "CANVAS" } });
  check("老师能开启这节课的课堂（前置条件）", started.status === 200, `${started.status} ${JSON.stringify(started.error || {}).slice(0, 120)}`);

  // 学生提交作品后 → 变成「已经上过」，不能再排
  const project = await api('/api/student/projects', { method: 'POST', token: (await api('/api/auth/login', { method: 'POST', body: { login: first.login, password: 'study123' } })).data.token, body: { courseLessonId: lessonId, title: 'P56 作品' } });
  if (project.status === 200) {
    const submitted = await api(`/api/student/projects/${project.data.id}/submit`, { method: 'POST', token: (await api('/api/auth/login', { method: 'POST', body: { login: first.login, password: 'study123' } })).data.token, body: { copyrightConfirmed: true } });
    check('学员能提交作品（前置条件）', submitted.status === 200, `${submitted.status}`);
    const after = await api(`/api/org/classes/${classRow.id}/lesson-candidates?lessonId=${lessonId}`, { token: org.token });
    const row = after.data.items.find((item) => item.studentId === first.id) || {};
    check('已提交作品的学员不再可选，原因是「已经上过」', row.selectable === false && row.hasSubmitted === true && String(row.reason).includes('已经上过'), JSON.stringify(row));
    const reject = await api(`/api/org/classes/${classRow.id}/lesson-students`, { method: 'PUT', token: org.token, body: { lessonId, studentIds: [first.id] } });
    check('把已上过的学员再排一次被拒', reject.status === 400, `${reject.status}`);
  } else {
    check('学员能进入该课时（前置条件）', false, `${project.status} ${JSON.stringify(project.error).slice(0, 120)}`);
  }

  console.log(JSON.stringify({ name: 'class-lesson-students', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
