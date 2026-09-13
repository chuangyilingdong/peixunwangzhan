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

  /* ② 有许可还不够：**必须被老师加进这节课的课堂**（2026-09-13 批次 B 取消免课堂通道）
     → 三层门禁：机构授权 → 学员许可 → 课堂名单；这里验后两层 */
  grantNow();
  const blockedNoClassroom = await createProject();
  check('② 分了课包但没进课堂：仍然进不去（NOT_IN_CLASSROOM）',
    blockedNoClassroom.error?.code === 'NOT_IN_CLASSROOM', JSON.stringify(blockedNoClassroom).slice(0, 220));
  check('② 提示指向「让老师把你加进课堂」，而不是笼统的失败',
    /加进课堂/.test(String(blockedNoClassroom.error?.message || '')), String(blockedNoClassroom.error?.message));
  const listAfter = await api('/api/student/courses', { token: student });
  const seriesAfter = (listAfter.data?.items || []).find((item) => item.id === seeded.seriesId);
  check('② 分了课包之后：列表不再标「未授权」（hasGrant === true）', seriesAfter?.hasGrant === true, JSON.stringify(seriesAfter || {}).slice(0, 240));

  /* ②b 老师建课堂 → 加他进去 → 但还没点「开始上课」：仍进不去（待上课） */
  const teacher = (await api('/api/auth/login', { method: 'POST', body: { login: 'teacher-1', password: 'teach123' } })).data.token;
  assert.ok(teacher, '老师登录失败');
  const created = await api('/api/org/sessions', { method: 'POST', token: teacher, body: { lessonId: seeded.lessonId, title: 'P66 门禁课堂' } });
  check('②b 老师能创建课堂（待上课）', created.status === 200 && created.data?.status === 'PENDING', JSON.stringify(created).slice(0, 240));
  const sessionId = created.data?.id;
  const added = await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: teacher, body: { studentIds: [seeded.studentId] } });
  check('②b 能把学员加进课堂', added.status === 200 && (added.data?.added || []).length === 1, JSON.stringify(added).slice(0, 240));
  const beforeStart = await createProject();
  check('②b 待上课（老师没开始）：仍然进不去（CLASS_SESSION_REQUIRED）',
    beforeStart.error?.code === 'CLASS_SESSION_REQUIRED', JSON.stringify(beforeStart).slice(0, 220));

  /* ②c 名单为空时不能开始上课 —— 用另一个课堂验（这个已经有学员） */
  const emptySession = await api('/api/org/sessions', { method: 'POST', token: teacher, body: { lessonId: seeded.lessonId, title: 'P66 空课堂' } });
  const emptyStart = await api(`/api/org/sessions/${emptySession.data.id}/start`, { method: 'POST', token: teacher });
  check('②c 名单为空时「开始上课」被拒（按钮置灰也是这条口径）',
    emptyStart.status === 400 && emptyStart.error?.code === 'SESSION_STUDENTS_REQUIRED', JSON.stringify(emptyStart).slice(0, 200));

  /* ②d 开始上课 → 终于能进 */
  const started = await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: teacher });
  check('②d 老师开始上课（待上课 → 上课中）', started.status === 200 && started.data?.status === 'ACTIVE', JSON.stringify(started).slice(0, 200));
  const okProject = await createProject();
  check('②d 上课中：画布入口能进', okProject.status === 200, JSON.stringify(okProject).slice(0, 200));
  // 同一节课上「未结束的参与」不能同时被两个课堂占用（用户规则 3.4/3.5）：
  // 此刻他正在画布课堂里，试着把他加到另一个课堂 → 必须被拒，并说清占用的课堂
  const otherSession = await api('/api/org/sessions', { method: 'POST', token: teacher, body: { lessonId: seeded.lessonId, title: 'P66 同期另一个课堂' } });
  const conflictAdd = await api(`/api/org/sessions/${otherSession.data.id}/students`, { method: 'POST', token: teacher, body: { studentIds: [seeded.studentId] } });
  check('②d 同一节课不能被两个课堂同时占用（IN_OTHER_SESSION）',
    (conflictAdd.data?.skipped || [])[0]?.reason === 'IN_OTHER_SESSION', JSON.stringify(conflictAdd).slice(0, 240));
  const candidates = await api(`/api/org/sessions/${otherSession.data.id}/candidates`, { token: teacher });
  const blockedRow = (candidates.data?.blocked || []).find((item) => item.id === seeded.studentId);
  check('②d 候选人列表把「不可加」的原因与占用课堂都列出来（含课堂名/状态/老师）',
    blockedRow?.reason === 'IN_OTHER_SESSION' && blockedRow?.session?.status === 'ACTIVE' && Boolean(blockedRow?.session?.teacherName),
    JSON.stringify(blockedRow || {}).slice(0, 260));
  // 解散这个多余的课堂（待上课 → 已解散），顺带验「解散」这条路径
  const dissolved = await api(`/api/org/sessions/${otherSession.data.id}/dissolve`, { method: 'POST', token: teacher, body: { reason: 'P66 测试解散' } });
  check('②d 待上课的课堂可以解散（PENDING → DISSOLVED）', dissolved.status === 200 && dissolved.data?.status === 'DISSOLVED', JSON.stringify(dissolved).slice(0, 200));

  /* ③ 老师结束课堂 → 学员立刻进不去，且状态结算成「未完课」（这次没消耗过算力） */
  const ended = await api(`/api/org/sessions/${sessionId}/end`, { method: 'POST', token: teacher, body: {} });
  check('③ 老师结束课堂（上课中 → 已结束）', ended.status === 200 && ended.data?.status === 'ENDED', JSON.stringify(ended).slice(0, 200));
  const afterEnd = await createProject();
  check('③ 课堂结束后：立刻进不去', ['CLASS_SESSION_REQUIRED', 'NOT_IN_CLASSROOM'].includes(afterEnd.error?.code), JSON.stringify(afterEnd).slice(0, 220));
  const detail = await api(`/api/org/sessions/${sessionId}`, { token: teacher });
  const mine = (detail.data?.students || []).find((item) => item.studentId === seeded.studentId);
  check('③ 结束后学员状态结算为「未完课」（没消耗过算力）', mine?.status === 'INCOMPLETE', JSON.stringify(mine || {}).slice(0, 240));
  check('③ 课堂详情带「查看课件」地址（前端新标签打开用）', String(detail.data?.coursewareUrl || '').includes('/org/courses/'), String(detail.data?.coursewareUrl));

  /* ③b 他是「未完课」（这次没消耗算力）→ 可以再上一次这节课：换个 VIBECODING 课堂走完整条链 */
  const vibeSession = await api('/api/org/sessions', { method: 'POST', token: teacher, body: { lessonId: seeded.lessonId, title: 'P66 VibeCoding 课堂', deliveryMode: 'VIBECODING' } });
  check('③b 未完课的学员可以被下一个课堂加进去（VibeCoding 课堂）', (await api(`/api/org/sessions/${vibeSession.data.id}/students`, { method: 'POST', token: teacher, body: { studentIds: [seeded.studentId] } })).data?.added?.length === 1);
  const vibeStart = await api(`/api/org/sessions/${vibeSession.data.id}/start`, { method: 'POST', token: teacher });
  check('③b VibeCoding 课堂开始上课', vibeStart.status === 200, JSON.stringify(vibeStart).slice(0, 160));
  const okConversation = await createConversation();
  check('③b 上课中：VibeCoding 入口能进', okConversation.status === 200, JSON.stringify(okConversation).slice(0, 200));
  check('③b 入口类型要对上：VibeCoding 课堂里画布入口进不去',
    (await createProject()).error?.code === 'VIBECODING_CLASSROOM_UNAVAILABLE');
  await api(`/api/org/sessions/${vibeSession.data.id}/end`, { method: 'POST', token: teacher, body: {} });

  /* ④ 平台兜底撤销 → 立刻又进不去（不给缓存留缝） */
  revokeNow();
  const revokedProject = await createProject();
  check('④ 撤销后：立刻进不去（COURSE_GRANT_REQUIRED）', revokedProject.error?.code === 'COURSE_GRANT_REQUIRED', JSON.stringify(revokedProject).slice(0, 220));

  /* ⑤ 课时压根不存在 → 报「课时不存在/未发布」，不与前面几种混为一谈 */
  const notInCurriculum = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: 'lesson_does_not_exist', title: 'P66 不存在' } });
  check('⑤ 课时不存在 → LESSON_NOT_ASSIGNED（拒绝原因不混）',
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
