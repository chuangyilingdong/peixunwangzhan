/**
 * P69 教师「数据范围」守卫（2026-09-13，B3）。
 *
 * 背景：教师的数据范围在 orgAdmin.js 里是**7 处零散内联补丁**（每处都写一遍
 * 「我带的班 OR 我是这个班的 TEACHER 成员」）。这种重复很危险：哪条新查询忘了补，
 * 教师就看到别的班的数据 —— 而且是**静默的**，界面上不会报错、日志里也不会。
 *
 * 这个脚本先把「范围」这件事钉成一组可执行的期望（characterization test），
 * 之后不管是收敛成一处 scope 函数、还是新增查询，都能立刻看出有没有越界。
 *
 * 钉三件事：
 *   ① 教师只看得到**自己带的班**（总览计数、班级列表、课堂场次都算过）；
 *   ② 教师看得到**本机构学生名册**（名册是机构级信息，不属于某个班 —— 这条别误伤）；
 *   ③ 机构管理员看得到**全部班级**（教师范围只对 TEACHER 生效）。
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

// 造两个班：teacher-1 带 A 班，teacher-2 带 B 班。两个班都要有「正在进行的课堂」，
// 否则总览里的 activeSessions/场次恒为 0，测不出范围有没有生效。
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
  const makeClass = (name, teacherId) => {
    const classId = `class_p69_${name}`;
    db.prepare("INSERT INTO classes(id,org_id,name,status,teacher_id,created_at,updated_at) VALUES (?,?,?,'ACTIVE',?,?,?)").run(classId, orgId, `P69 ${name}`, teacherId, now, now);
    db.prepare('INSERT INTO class_curriculum_items(id,class_id,lesson_id,sort,source_series_id,added_at) VALUES (?,?,?,?,?,?)').run(`cci_p69_${name}`, classId, lesson, 1, series, now);
    const sessionId = `csession_p69_${name}`;
    db.prepare("INSERT INTO class_sessions(id,class_id,lesson_id,status,session_kind,delivery_mode,started_by,started_at) VALUES (?,?,?,'ACTIVE','REGULAR','CANVAS',?,?)").run(sessionId, classId, lesson, teacherId, now);
    db.prepare('UPDATE classes SET current_session_id=? WHERE id=?').run(sessionId, classId);
    return { classId, sessionId };
  };
  const a = makeClass('A', t1);   // teacher-1 自己带
  const b = makeClass('B', t2);   // teacher-2 带 —— teacher-1 **不该**看到
  // teacher-1 也作为成员加入 B 班不算数：这里刻意不加，用来验证「不是我的班就看不到」
  db.prepare('INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES (?,?,?,?,?)').run('cm_p69_a', a.classId, s1, 'STUDENT', now);
  // 两个班各记一条用量：教师的「近 7 日调用」只该数到自己班那条
  for (const [tag, session] of [['A', a.sessionId], ['B', b.sessionId]]) {
    db.prepare("INSERT INTO usage_records(id,org_id,user_id,class_session_id,project_id,modality,model,credits_charged,status,cost_fen,created_at) VALUES (?,?,?,?,NULL,'TEXT','p69-model',0,'SUCCESS',100,?)").run(`usage_p69_${tag}`, orgId, s1, session, now);
  }
  Object.assign(seeded, { orgId, lessonId: lesson, seriesId: series, classA: a.classId, classB: b.classId, sessionA: a.sessionId, sessionB: b.sessionId, student1: s1 });
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

  /* ① 班级列表：教师只看得到自己带的 */
  const classesAsTeacher = await api('/api/org/classes', { token: teacher });
  const teacherClassIds = idsOf(classesAsTeacher.data?.items);
  check('① 教师看得到自己带的班', teacherClassIds.includes(seeded.classA), JSON.stringify(teacherClassIds));
  check('① 教师看不到别的老师的班', !teacherClassIds.includes(seeded.classB), JSON.stringify(teacherClassIds));
  const classesAsTeacher2 = await api('/api/org/classes', { token: teacher2 });
  check('① 另一位老师看到的正好相反（不是「谁都看不到」的假绿）',
    idsOf(classesAsTeacher2.data?.items).includes(seeded.classB) && !idsOf(classesAsTeacher2.data?.items).includes(seeded.classA),
    JSON.stringify(idsOf(classesAsTeacher2.data?.items)));

  /* ② 总览计数：教师视角的班数/场次被 scope 过，管理员看全部 */
  const overviewTeacher = await api('/api/org/overview', { token: teacher });
  const overviewAdmin = await api('/api/org/overview', { token: admin });
  const tOverview = overviewTeacher.data || {};
  const aOverview = overviewAdmin.data || {};
  check('② 总览可用且给了 scope 说明（教师/管理员两套视角）',
    overviewTeacher.status === 200 && overviewAdmin.status === 200 && tOverview.scope?.role === 'TEACHER' && aOverview.scope?.role === 'ORG_ADMIN',
    JSON.stringify({ teacher: tOverview.scope, admin: aOverview.scope }).slice(0, 200));
  // 注意：种子数据里 teacher-1 本来就带了一个班，所以期望值只能**相对**比 ——
  // 写死「教师 = 1 个班」会变成「我的期望错了」而不是「代码错了」（交接说明第 63 条）。
  check('② 管理员的班数 = 教师的班数 + 1（正好多出 teacher-2 带的那个）',
    Number(aOverview.activeClasses) === Number(tOverview.activeClasses) + 1,
    JSON.stringify({ adminClasses: aOverview.activeClasses, teacherClasses: tOverview.activeClasses }));
  check('② 进行中的课堂场次同样被 scope（管理员比教师多 1 个）',
    Number(aOverview.activeSessions) === Number(tOverview.activeSessions) + 1,
    JSON.stringify({ adminSessions: aOverview.activeSessions, teacherSessions: tOverview.activeSessions }));
  // 用量 scope：给两个班各造一条用量记录，教师的「近 7 日调用」只该数到自己班那条
  check('② 近 7 日调用也被 scope（教师只数自己班那条课堂用量）',
    Number(tOverview.usage7) === 1 && Number(aOverview.usage7) === 2,
    JSON.stringify({ teacherUsage7: tOverview.usage7, adminUsage7: aOverview.usage7 }));

  /* ③ 名册是机构级信息：别把教师范围误伤到「看不到学生」 */
  const roster = await api('/api/org/users?role=STUDENT', { token: teacher });
  check('③ 教师仍能看本机构学生名册（名册不属于某个班）',
    roster.status === 200 && (roster.data?.items || []).some((item) => item.id === seeded.student1),
    JSON.stringify(idsOf(roster.data?.items)).slice(0, 160));

  /* ④ 课堂记录：教师不能读到别的班那节课的详情 */
  const foreignDetail = await api(`/api/org/classes/${seeded.classB}`, { token: teacher });
  check('④ 教师打不开别的老师的班（403/404）', [403, 404].includes(foreignDetail.status), `实际 ${foreignDetail.status}`);
  const ownDetail = await api(`/api/org/classes/${seeded.classA}`, { token: teacher });
  check('④ 教师打不开自己的班就是坏了（防止 ④ 变成「一律拒绝」的假绿）', ownDetail.status === 200, `实际 ${ownDetail.status}`);

  /* ⑤ 成员列表：教师在别的班的成员里不该看到自己的权限被放大 */
  const foreignMembers = await api(`/api/org/classes/${seeded.classB}/members`, { token: teacher });
  check('⑤ 教师读不到别的班的成员列表', [403, 404].includes(foreignMembers.status), `实际 ${foreignMembers.status}`);

  console.log(JSON.stringify({ name: 'teacher-data-scope', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
