/**
 * P69 教师「数据范围」守卫（2026-09-13 建，批次 D 改成**课堂口径**）。
 *
 * 背景：教师的数据范围在 orgAdmin.js 里曾经是**7 处零散内联补丁**（每处都写一遍「我带的班
 * OR 我是这个班的 TEACHER 成员」）。这种重复很危险：哪条新查询忘了补，教师就看到别人的数据
 * —— 而且是**静默的**，界面上不会报错、日志里也不会。
 *
 * 批次 B/C 把「班级」换成「课堂」之后，范围的落点也变了（用户口径：**教师只看自己创建的课堂**）：
 *   · 课堂列表/详情/学员/用量/作品 → `class_sessions.teacher_id`
 *   · 作品范围 → `works.class_session_id` 指向我创建的课堂
 *   · 用量范围 → `usage_records.class_session_id` 指向我创建的课堂
 *   这次改动是**安全相关**的，所以先把新口径钉成可执行期望，再动 SQL。
 *
 * 钉四件事：
 *   ① 教师只看得到**自己创建的课堂**（列表、总览计数、近期课堂都算过）；
 *   ② 教师在**别人课堂**上的作品/用量一条都看不到，且**接管别人的课堂会被拒**；
 *   ③ 教师看得到**本机构学生名册**（名册是机构级信息，不属于某个课堂 —— 这条别误伤）；
 *   ④ 机构管理员看得到**全机构**（范围只对 TEACHER 生效）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p69-teacher-scope-'));
const dbPath = path.join(temp, 'platform.db');
const env = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

// 造两个老师各一个课堂（同一节课上也行 —— 课堂是按「谁创建的」分范围，不是按班级）：
// teacher-1 建 A 课堂，teacher-2 建 B 课堂。两个课堂都要落一条学员 + 一条用量，
// 否则「看得见/看不见」测不出区别（空集合会让断言变成假绿）。
const seeded = {};
{
  const db = new DatabaseSync(dbPath);
  const orgId = db.prepare("SELECT org_id FROM users WHERE login='org-admin'").get().org_id;
  const t1 = db.prepare("SELECT id FROM users WHERE login='teacher-1'").get().id;
  const t2 = db.prepare("SELECT id FROM users WHERE login='teacher-2'").get().id;
  const s1 = db.prepare("SELECT id FROM users WHERE login='student-1'").get().id;
  const lesson = db.prepare("SELECT id FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1").get().id;
  const series = db.prepare('SELECT series_id FROM course_lessons WHERE id=?').get(lesson).series_id;
  const now = new Date().toISOString();
  const makeSession = (tag, teacherId) => {
    const sessionId = `csession_p69_${tag}`;
    db.prepare("INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,started_by,started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'ACTIVE','CANVAS',?,?,?,?)")
      .run(sessionId, `P69 ${tag} 课堂`, orgId, series, lesson, teacherId, teacherId, now, now, now);
    db.prepare("INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at) VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)")
      .run(`sstudent_p69_${tag}`, sessionId, s1, orgId, lesson, series, teacherId, now, now);
    return sessionId;
  };
  const a = makeSession('A', t1);   // teacher-1 自己建的
  const b = makeSession('B', t2);   // teacher-2 建的 —— teacher-1 **不该**看到
  // 两个课堂各记一条用量 + 一件作品（教师范围要能圈住这两个资源）
  for (const [tag, session] of [['A', a], ['B', b]]) {
    db.prepare("INSERT INTO usage_records(id,org_id,user_id,class_session_id,project_id,modality,model,credits_charged,status,cost_fen,created_at) VALUES (?,?,?,?,NULL,'TEXT','p69-model',0,'SUCCESS',100,?)").run(`usage_p69_${tag}`, orgId, s1, session, now);
  }
  Object.assign(seeded, { orgId, lessonId: lesson, seriesId: series, sessionA: a, sessionB: b, student1: s1, teacher1: t1, teacher2: t2 });
  db.close();
}

const port = 19069;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };
const idsOf = (items) => (items || []).map((item) => item.id);

try {
  for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const login = async (name, password) => {
    const r = await api('/api/auth/login', { method: 'POST', body: { login: name, password } });
    assert.ok(r.data?.token, `登录失败：${name} ${JSON.stringify(r).slice(0, 160)}`);
    return r.data.token;
  };
  const teacher = await login('teacher-1', 'teach123');
  const teacher2 = await login('teacher-2', 'teach123');
  const admin = await login('org-admin', 'org123');

  /* ① 课堂列表：教师只看得到自己创建的 */
  const sessionsAsTeacher = await api('/api/org/sessions?days=365', { token: teacher });
  check('① 教师看得到自己创建的课堂', idsOf(sessionsAsTeacher.data?.items).includes(seeded.sessionA), JSON.stringify(idsOf(sessionsAsTeacher.data?.items)));
  check('① 教师看不到别的老师创建的课堂', !idsOf(sessionsAsTeacher.data?.items).includes(seeded.sessionB), JSON.stringify(idsOf(sessionsAsTeacher.data?.items)));
  const sessionsAsTeacher2 = await api('/api/org/sessions?days=365', { token: teacher2 });
  check('① 另一位老师看到的正好相反（不是「谁都看不到」的假绿）',
    idsOf(sessionsAsTeacher2.data?.items).includes(seeded.sessionB) && !idsOf(sessionsAsTeacher2.data?.items).includes(seeded.sessionA),
    JSON.stringify(idsOf(sessionsAsTeacher2.data?.items)));

  /* ①b 详情/候选人/学员名单都不能穿透到别人的课堂 */
  const foreignDetail = await api(`/api/org/sessions/${seeded.sessionB}`, { token: teacher });
  check('①b 教师打不开别人课堂的详情（403/404）', [403, 404].includes(foreignDetail.status), `实际 ${foreignDetail.status}`);
  const ownDetail = await api(`/api/org/sessions/${seeded.sessionA}`, { token: teacher });
  check('①b 教师打不开自己的课堂就是坏了（防「一律拒绝」的假绿）', ownDetail.status === 200, `实际 ${ownDetail.status}`);
  const foreignCandidates = await api(`/api/org/sessions/${seeded.sessionB}/candidates`, { token: teacher });
  check('①b 教师读不到别人课堂的候选人', [403, 404].includes(foreignCandidates.status), `实际 ${foreignCandidates.status}`);
  const foreignStart = await api(`/api/org/sessions/${seeded.sessionB}/end`, { method: 'POST', token: teacher, body: {} });
  check('①b 教师不能结束别人的课堂', [403, 404].includes(foreignStart.status), `实际 ${foreignStart.status}`);

  /* ② 总览计数：教师视角被 scope 过，管理员看全部 */
  const overviewTeacher = await api('/api/org/overview', { token: teacher });
  const overviewAdmin = await api('/api/org/overview', { token: admin });
  const tOverview = overviewTeacher.data || {};
  const aOverview = overviewAdmin.data || {};
  check('② 总览可用且给了 scope 说明（教师/管理员两套视角）',
    overviewTeacher.status === 200 && overviewAdmin.status === 200 && tOverview.scope?.role === 'TEACHER' && aOverview.scope?.role === 'ORG_ADMIN',
    JSON.stringify({ teacher: tOverview.scope, admin: aOverview.scope }).slice(0, 200));
  // 种子数据里 teacher-1 本来就可能有课堂，所以期望值只能**相对**比 ——
  // 写死数字会变成「我的期望错了」而不是「代码错了」（交接说明第 63 条）。
  check('② 管理员的进行中课堂数 > 教师的（自己那个不算别人的）',
    Number(aOverview.activeSessions) === Number(tOverview.activeSessions) + 1,
    JSON.stringify({ adminSessions: aOverview.activeSessions, teacherSessions: tOverview.activeSessions }));
  // 用量 scope：两个课堂各一条用量，教师只该数到自己课堂那条
  check('② 近 7 日调用也被 scope（教师只数自己课堂那条）',
    Number(tOverview.usage7) === 1 && Number(aOverview.usage7) === 2,
    JSON.stringify({ teacherUsage7: tOverview.usage7, adminUsage7: aOverview.usage7 }));
  // 近期课堂：教师的列表里不能出现别人的课堂
  check('② 近期课堂不含别人的课堂',
    !idsOf(tOverview.recentSessions).includes(seeded.sessionB) && idsOf(tOverview.recentSessions).includes(seeded.sessionA),
    JSON.stringify(idsOf(tOverview.recentSessions)));

  /* ③ 教师不可访问机构学生名册，管理员保留名册能力。 */
  const roster = await api('/api/org/users?role=STUDENT', { token: teacher });
  check('③ 教师不能查看机构学生名册', roster.status === 403, JSON.stringify(roster));
  const adminRoster = await api('/api/org/users?role=STUDENT', { token: admin });
  check('③ 管理员可查看本机构学生名册', adminRoster.status === 200 && (adminRoster.data?.items || []).some((item) => item.id === seeded.student1), JSON.stringify(adminRoster).slice(0,160));

  /* ④ 作品范围：按 works.class_session_id 圈定（班级退场后的新落点） */
  const worksTeacher = await api('/api/org/works', { token: teacher });
  check('④ 作品接口可用（教师视角）', worksTeacher.status === 200, JSON.stringify(worksTeacher).slice(0, 160));
  // 教师自己的课堂里造一件作品：应当看得到；再给别人的课堂造一件：不该看到。
  {
    const db = new DatabaseSync(dbPath);
    const now = new Date().toISOString();
    // ⚠️ works.project_id 是 UNIQUE（一个项目一件作品），所以两件作品得挂在两个项目上。
    // ⚠️ works 表没有 created_at/updated_at（只有 submitted_at），canvas_snapshot 是 NOT NULL。
    for (const [tag, session] of [['A', seeded.sessionA], ['B', seeded.sessionB]]) {
      const projectId = `project_p69_${tag}`;
      db.prepare("INSERT INTO student_projects(id,student_id,org_id,course_lesson_id,class_session_id,title,status,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'DRAFT',?,?,?)")
        .run(projectId, seeded.student1, seeded.orgId, seeded.lessonId, session, `P69 项目 ${tag}`, now, now, now);
      db.prepare("INSERT INTO works(id,project_id,student_id,org_id,course_lesson_id,class_session_id,title,description,canvas_snapshot,status,submitted_at) VALUES (?,?,?,?,?,?,?,'','{}','PENDING',?)")
        .run(`work_p69_${tag}`, projectId, seeded.student1, seeded.orgId, seeded.lessonId, session, `P69 作品 ${tag}`, now);
    }
    db.close();
  }
  const worksAfter = await api('/api/org/works', { token: teacher });
  const teacherWorkIds = idsOf(worksAfter.data?.items);
  check('④ 教师看得到自己课堂里的作品', teacherWorkIds.includes('work_p69_A'), JSON.stringify(teacherWorkIds));
  check('④ 教师看不到别人课堂里的作品', !teacherWorkIds.includes('work_p69_B'), JSON.stringify(teacherWorkIds));
  const worksAdmin = await api('/api/org/works', { token: admin });
  check('④ 机构管理员两件都看得到（范围只对教师生效）',
    idsOf(worksAdmin.data?.items).includes('work_p69_A') && idsOf(worksAdmin.data?.items).includes('work_p69_B'),
    JSON.stringify(idsOf(worksAdmin.data?.items)));

  /* ⑤ 教师名单接口 + 旧班级接口：班级退场后 /classes 必须已经下线 */
  const legacyClasses = await api('/api/org/classes', { token: admin });
  check('⑤ 旧 /api/org/classes 已下线（404，不再返回班级列表）',
    legacyClasses.status === 404 && !Array.isArray(legacyClasses.data?.items),
    `${legacyClasses.status} ${JSON.stringify(legacyClasses.data).slice(0, 120)}`);
  const legacyCurriculum = await api(`/api/org/classes/${seeded.sessionA}/curriculum`, { token: admin });
  check('⑤ 旧课单接口也已下线（404）', legacyCurriculum.status === 404, `实际 ${legacyCurriculum.status}`);

  console.log(JSON.stringify({ name: 'teacher-data-scope', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
