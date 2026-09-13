/**
 * P66 学生进课的「学员许可」门禁（2026-09-13，用户确认按梳理文档 4.3「叠加」口径）。
 *
 * 口径：学生要能上某节课，**两条都得满足** ——
 *   ① 这节课在 ta 的班级课单里（教什么，老逻辑）；② ta 持有该课包的**有效学员许可**（新门禁）。
 * 这条门禁是「机构必须有可用次数才能把课包给学生 → 学生才能学」的落点：
 * 没有许可就进不去（报 `COURSE_GRANT_REQUIRED`，与「不在课单里」区分开，免得学生去问错人）。
 *
 * 三种情况都要钉住：**没许可进不去 / 分给ta就能进 / 平台撤销后立刻又进不去**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p66-grant-gate-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('child close', () => {});
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(code)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

// 起点：把种子给 student-2 的那条许可**删掉**（模拟「机构还没分给他」）
const seeded = {};
{
  const db = new DatabaseSync(dbPath);
  const student = db.prepare("SELECT id, org_id FROM users WHERE login='student-2'").get();
  const grant = db.prepare('SELECT id, series_id FROM student_course_grants WHERE student_id=?').get(student.id);
  const lesson = db.prepare('SELECT id FROM course_lessons WHERE series_id=? ORDER BY sort LIMIT 1').get(grant.series_id);
  db.prepare('DELETE FROM student_course_grants WHERE id=?').run(grant.id);
  // ⚠️ 两条入口都要能测：种子课时默认只开画布，这里开成双入口并开放 text 能力
  //    （否则 VibeCoding 那条会被「当前课时不是 VibeCoding 课堂」正确拒掉，测不到许可门禁）
  db.prepare("UPDATE course_lessons SET delivery_modes='[\"CANVAS\",\"VIBECODING\"]' WHERE id=?").run(lesson.id);
  db.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
  Object.assign(seeded, { studentId: student.id, orgId: student.org_id, seriesId: grant.series_id, lessonId: lesson.id });
  db.close();
}

const port = 19010;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
const grantNow = () => {
  const db = new DatabaseSync(dbPath);
  const existing = db.prepare('SELECT id FROM student_course_grants WHERE student_id=? AND series_id=?').get(seeded.studentId, seeded.seriesId);
  if (existing) db.prepare('UPDATE student_course_grants SET revoked_at=NULL,revoked_by=NULL,revoke_reason=NULL WHERE id=?').run(existing.id);
  else db.prepare(`INSERT INTO student_course_grants(id,org_id,student_id,series_id,granted_at) VALUES (?,?,?,?,datetime('now'))`).run('p66_grant', seeded.orgId, seeded.studentId, seeded.seriesId);
  db.close();
};
const revokeNow = () => {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE student_course_grants SET revoked_at=datetime('now'),revoke_reason='P66 守卫：平台兜底撤销' WHERE student_id=? AND series_id=?").run(seeded.studentId, seeded.seriesId);
  db.close();
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(student, '学生登录失败');
  const createProject = () => api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: seeded.lessonId, title: 'P66 门禁' } });
  const createConversation = () => api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: seeded.lessonId, title: 'P66 门禁会话' } });

  /* ① 没有学员许可 → 进不去，而且原因说得准确 */
  const blockedProject = await createProject();
  check('① 没许可：画布入口被拒（COURSE_GRANT_REQUIRED）', blockedProject.error?.code === 'COURSE_GRANT_REQUIRED', JSON.stringify(blockedProject).slice(0, 220));
  check('① 提示指向「找老师分课包」，而不是误导成「不在课单里」', /请老师先把课包分给你/.test(String(blockedProject.error?.message || '')), String(blockedProject.error?.message));
  const blockedConversation = await createConversation();
  check('① 没许可：VibeCoding 入口同样被拒（同一道门禁）', blockedConversation.error?.code === 'COURSE_GRANT_REQUIRED', JSON.stringify(blockedConversation).slice(0, 220));
  check('① 学生仍然看得到课程列表（只是打不开）', (await api('/api/student/courses', { token: student })).status === 200);
  // B1（2026-09-13）：列表要**直接标出「未授权」**，不能让学生点进去才吃到门禁。
  const listBefore = await api('/api/student/courses', { token: student });
  const seriesBefore = (listBefore.data?.items || []).find((item) => item.id === seeded.seriesId);
  check('① 课程列表已把该课包标成未授权（items[].hasGrant === false）', seriesBefore?.hasGrant === false, JSON.stringify(seriesBefore || {}).slice(0, 240));
  const dashboardBefore = await api('/api/student/dashboard', { token: student });
  const courseBefore = (dashboardBefore.data?.classroomCourses || []).find((item) => item.id === seeded.seriesId);
  const lessonBefore = (courseBefore?.lessons || [])[0];
  check('① 课程中心的课时也不能显示成「已开课」（canStart=false + 原因指向分课包）',
    lessonBefore?.canStart === false && /分给你/.test(String(lessonBefore?.blockReason || '')),
    JSON.stringify(lessonBefore || {}).slice(0, 240));

  /* ② 机构把课包分给他 → 立刻能进 */
  grantNow();
  const okProject = await createProject();
  check('② 分给他之后：画布入口能进', okProject.status === 200, JSON.stringify(okProject).slice(0, 200));
  const okConversation = await createConversation();
  check('② 分给他之后：VibeCoding 入口能进', okConversation.status === 200, JSON.stringify(okConversation).slice(0, 200));
  const listAfter = await api('/api/student/courses', { token: student });
  const seriesAfter = (listAfter.data?.items || []).find((item) => item.id === seeded.seriesId);
  check('② 分给他之后：列表不再标「未授权」（hasGrant === true）', seriesAfter?.hasGrant === true, JSON.stringify(seriesAfter || {}).slice(0, 240));

  /* ③ 平台兜底撤销 → 立刻又进不去（不给缓存留缝） */
  revokeNow();
  const revokedProject = await createProject();
  check('③ 撤销后：立刻进不去（同一个错误码）', revokedProject.error?.code === 'COURSE_GRANT_REQUIRED', JSON.stringify(revokedProject).slice(0, 220));

  /* ④ 没在课单里的课时，仍然报「不在课单」（两种拒绝原因不能被混成一种） */
  const notInCurriculum = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: 'lesson_does_not_exist', title: 'P66 不存在' } });
  check('④ 课时压根不存在/不在课单 → 仍报 LESSON_NOT_ASSIGNED（不与未授权混为一谈）',
    ['LESSON_NOT_ASSIGNED', 'LESSON_REQUIRED'].includes(notInCurriculum.error?.code), JSON.stringify(notInCurriculum).slice(0, 220));

  console.log(JSON.stringify({ name: 'student-grant-gate', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
