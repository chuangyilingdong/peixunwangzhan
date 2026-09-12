/**
 * P54 草稿隔离守卫（2026-09-12）：不点「更新发布」，机构端/学生端看不到改动。
 *
 * 机制：平台端编辑的是**实时数据**；「更新发布」（以及首次发布课包）时把内容定格进
 * `published_content` 快照；机构端 / 学生端 / 官网按快照读。老数据没有快照 → 回退实时数据。
 * 盯住三件事：① 改完没发布 → 机构端与学生端读到的还是旧内容；② 更新发布后立刻读到新内容；
 * ③ 平台端自己始终读实时数据（否则编辑界面会「改不动」）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p54-draft-'));
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
const port = 18901;
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
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', org123: 'x', password: 'org123' } })).data;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data;
  assert.ok(admin && orgAdmin?.token && student?.token, '登录失败');

  const created = await api('/api/admin/course-series', {
    method: 'POST', token: admin,
    body: { title: 'P54 草稿隔离课包', description: '第一版简介', visibility: 'ALL_ORGS', priceFen: 9900, lessons: [{ title: '第1课 原始标题', status: 'PUBLISHED', capabilities: ['text'], deliveryModes: ['CANVAS'], lessonContent: '原始正文' }] },
  });
  assert.equal(created.status, 200, `建课包失败: ${JSON.stringify(created.data).slice(0, 160)}`);
  const seriesId = created.data.id;
  const lessonId = created.data.lessons[0].id;

  // 首次发布 + 授权 + 排进班级（学生能读到）
  await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
  await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgIds: [orgAdmin.organization.id], validityDays: 365 } });
  const classes = await api('/api/org/classes', { token: orgAdmin.token });
  const classRow = (classes.data.items || []).find((c) => Number(c.studentCount || 0) > 0) || (classes.data.items || [])[0];
  const curriculum = await api(`/api/org/classes/${classRow.id}/curriculum`, { token: orgAdmin.token });
  const existing = (curriculum.data.items || []).map((i) => i.lessonId || i.id).filter(Boolean);
  await api(`/api/org/classes/${classRow.id}/curriculum`, { method: 'PUT', token: orgAdmin.token, body: { lessonIds: [...new Set([...existing, lessonId])] } });

  const orgRead = async () => JSON.stringify((await api(`/api/org/course-series/${seriesId}`, { token: orgAdmin.token })).data);
  const studentRead = async () => JSON.stringify((await api(`/api/student/projects`, { method: 'POST', token: student.token, body: { courseLessonId: lessonId, title: 'P54' } })).data);

  check('发布后机构端读到原始内容', (await orgRead()).includes('第1课 原始标题'));
  check('发布后学生端也读得到（能进课时）', (await studentRead()).length > 10);

  // ① 改课时但**不发布** → 机构端/学生端仍读旧内容
  await sleep(1100);
  const edited = await api(`/api/admin/course-lessons/${lessonId}`, { method: 'PUT', token: admin, body: { title: '第1课 改过的标题', lessonContent: '改过的正文' } });
  assert.equal(edited.status, 200, `改课时失败: ${JSON.stringify(edited.data).slice(0, 160)}`);
  const adminRead = JSON.stringify((await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin })).data);
  check('平台端自己读到的是实时内容（编辑界面要能看到自己刚改的）', adminRead.includes('第1课 改过的标题'), adminRead.slice(0, 120));
  check('① 改完没发布：机构端仍读到旧标题', (await orgRead()).includes('第1课 原始标题'), (await orgRead()).slice(0, 160));
  const studentBefore = await studentRead();
  check('① 改完没发布：学生端仍读到旧标题', studentBefore.includes('第1课 原始标题') || !studentBefore.includes('第1课 改过的标题'), studentBefore.slice(0, 160));

  // ② 更新发布 → 机构端/学生端立刻读到新内容
  const published = await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.1', note: '改了第 1 课标题与正文' } });
  check('更新发布成功', published.status === 200, JSON.stringify(published.data).slice(0, 120));
  check('② 更新发布后：机构端读到新标题', (await orgRead()).includes('第1课 改过的标题'), (await orgRead()).slice(0, 160));
  const afterText = JSON.stringify((await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin })).data);
  check('更新发布后不再提示「有未发布的改动」', afterText.includes('"hasUnpublishedChanges":false'), afterText.slice(0, 100));

  // ③ 课包资料层（标题/价格）同样隔离
  await api(`/api/admin/course-series/${seriesId}`, { method: 'PUT', token: admin, body: { title: 'P54 草稿隔离课包（改过）', description: '第二版简介', priceFen: 29900 } });
  const orgAfterSeriesEdit = await orgRead();
  check('③ 课包资料改了但没发布：机构端仍读到旧标题', orgAfterSeriesEdit.includes('P54 草稿隔离课包"'), orgAfterSeriesEdit.slice(0, 120));
  check('③ 课包资料改了但没发布：机构端仍读到旧价格', !orgAfterSeriesEdit.includes('"priceFen":29900'), orgAfterSeriesEdit.slice(0, 200));
  await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.2', note: '改了课包资料' } });
  const orgAfterSeriesPublish = await orgRead();
  check('③ 更新发布后：机构端读到新课包标题与价格', orgAfterSeriesPublish.includes('改过') && orgAfterSeriesPublish.includes('29900'), orgAfterSeriesPublish.slice(0, 160));

  console.log(JSON.stringify({ name: 'draft-isolation', pass: failures === 0, seriesId, failures }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
