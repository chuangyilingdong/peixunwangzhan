/**
 * P74 「课堂范围字段」的写入与回填守卫（2026-09-13 批次 D 收尾）。
 *
 * 为什么单独有这一条：这一轮栽了两次，**两次都不报错**，都是发布后拿真实数据才看出来的：
 *   ① `works.class_session_id` 加了列却**没有任何写入路径**。而教师的数据范围正是按它圈定的
 *      （`sessionOwnedByTeacherExists('work.class_session_id', …)`）→ **教师静默看不到作品**。
 *      机构管理员照常看得到，所以界面上没有任何异常。
 *   ② `works/student_projects` 的课堂回填**只有一级**（从项目抄），而老项目本身也没记课堂 →
 *      生产上回填结果还是 0/1，等于「迁移看起来跑了、其实没补上」。
 *
 * 所以这条守卫钉两件事：
 *   A. **写入路径完整**：新走的每一步都必须把「他在哪个课堂」记下来 ——
 *      建项目、提交作品、记一次用量（教师用量范围靠 usage_records.class_session_id）。
 *   B. **回填只按证据且幂等**：老数据能从「课堂名单记录」补上；没有证据的留空、不硬认领；
 *      重复跑不出错也不改变结果。
 * 附带走一条**正向证据**：教师确实看得到自己课堂里那件作品（回填生效才有）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p74-scope-columns-'));
const dbPath = path.join(temp, 'platform.db');
const env = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

const seeded = (() => {
  const db = new DatabaseSync(dbPath);
  const student = db.prepare("SELECT id, login, org_id FROM users WHERE login='student-2'").get();
  const lesson = db.prepare("SELECT id, series_id FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1").get();
  db.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
  const teacher = db.prepare("SELECT id FROM users WHERE role='TEACHER' AND org_id=? ORDER BY created_at LIMIT 1").get(student.org_id);
  db.close();
  return { student, lesson, teacher };
})();

const port = 19074;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
const login = async (name, password) => (await api('/api/auth/login', { method: 'POST', body: { login: name, password } })).data;

try {
  for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const org = await login('org-admin', 'org123');
  const student = await login(seeded.student.login, 'study123');
  const teacher = await login('teacher-1', 'teach123');
  assert.ok(org?.token && student?.token && teacher?.token, '登录失败');

  /* 搭场景：发许可 → 建课堂 → 排人 → 开始上课（全走真实接口） */
  await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId: seeded.lesson.series_id, studentIds: [seeded.student.id] } });
  const created = await api('/api/org/sessions', {
    method: 'POST', token: teacher.token,
    body: { lessonId: seeded.lesson.id, title: 'P74 范围字段课堂', teacherId: seeded.teacher.id },
  });
  assert.equal(created.status, 200, `建课堂失败: ${JSON.stringify(created.data).slice(0, 200)}`);
  const sessionId = created.data.id;
  await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: teacher.token, body: { studentIds: [seeded.student.id] } });
  assert.equal((await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: teacher.token })).status, 200, '开始上课失败');

  /* A. 写入路径完整 */
  const project = await api('/api/student/projects', {
    method: 'POST', token: student.token,
    body: { courseLessonId: seeded.lesson.id, title: 'P74 项目', canvasSnapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } },
  });
  assert.equal(project.status, 200, `建项目失败: ${JSON.stringify(project.data).slice(0, 200)}`);
  check('① 建项目时就记下「他进的哪个课堂」', project.data?.classSessionId === sessionId, String(project.data?.classSessionId));

  // ⚠️ 顺序要紧：提交后项目就锁定（PROJECT_NOT_EDITABLE），生成必须发生在提交之前。
  const generated = await api('/api/ai/generations', { method: 'POST', token: student.token, body: { projectId: project.data.id, prompt: 'P74 用量归属', modality: 'TEXT' } });
  check('② 生成调用成功（前置）', generated.status === 200 || generated.status === 202, `${generated.status} ${JSON.stringify(generated.error || {}).slice(0, 140)}`);
  {
    const db = new DatabaseSync(dbPath);
    const own = db.prepare('SELECT COUNT(*) n, MAX(class_session_id) sid FROM usage_records WHERE project_id=?').get(project.data.id);
    check('③ 用量记录的 class_session_id 也被写上了（教师用量范围靠它）',
      Number(own.n) > 0 && own.sid === sessionId, JSON.stringify({ rows: own.n, sessionId: own.sid }));
    db.close();
  }

  const submitted = await api(`/api/student/projects/${project.data.id}/submit`, { method: 'POST', token: student.token, body: { copyrightConfirmed: true } });
  check('④ 提交作品成功（前置）', submitted.status === 200, JSON.stringify(submitted.data).slice(0, 160));
  {
    const db = new DatabaseSync(dbPath);
    const work = db.prepare('SELECT id, class_session_id FROM works WHERE project_id=?').get(project.data.id);
    check('⑤ 作品的 class_session_id 被写上了（教师作品范围就靠它，漏了会静默看不到）',
      work?.class_session_id === sessionId, JSON.stringify(work));
    db.close();
  }

  /* A2. 正向证据：教师看得到自己课堂里的作品 */
  const teacherWorks = await api('/api/org/works', { token: teacher.token });
  const ids = (teacherWorks.data?.items || []).map((item) => item.id);
  {
    const db = new DatabaseSync(dbPath);
    const workId = db.prepare('SELECT id FROM works WHERE project_id=?').get(project.data.id)?.id;
    db.close();
    check('⑥ 教师看得到自己课堂里的作品（范围真的圈得住，不是「谁都看不到」）', ids.includes(workId), JSON.stringify(ids).slice(0, 160));
  }

  /* B. 回填：老数据只按证据补、幂等、无证据留空 */
  const legacy = 'legacy_lesson_p74';
  {
    const db = new DatabaseSync(dbPath);
    const now = '2026-01-01T00:00:00.000Z';
    // 老项目/老作品：没记课堂；但他在那节课上有一条课堂名单记录（＝证据）
    db.prepare("INSERT INTO student_projects(id,student_id,org_id,course_lesson_id,title,status,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,?,'SUBMITTED',?,?,?)")
      .run('p74_legacy_evidenced', seeded.student.id, seeded.student.org_id, seeded.lesson.id, '老项目·有证据', now, now, now);
    db.prepare("INSERT INTO works(id,project_id,student_id,org_id,course_lesson_id,title,description,canvas_snapshot,status,submitted_at) VALUES (?,?,?,?,?,?,'','{}','PENDING',?)")
      .run('w74_legacy_evidenced', 'p74_legacy_evidenced', seeded.student.id, seeded.student.org_id, seeded.lesson.id, '老作品·有证据', now);
    // 老项目/老作品：既没记课堂、也没有任何名单记录（＝没证据）
    db.prepare("INSERT INTO student_projects(id,student_id,org_id,course_lesson_id,title,status,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,?,'SUBMITTED',?,?,?)")
      .run('p74_legacy_orphan', seeded.student.id, seeded.student.org_id, legacy, '老项目·没证据', now, now, now);
    db.prepare("INSERT INTO works(id,project_id,student_id,org_id,course_lesson_id,title,description,canvas_snapshot,status,submitted_at) VALUES (?,?,?,?,?,?,'','{}','PENDING',?)")
      .run('w74_legacy_orphan', 'p74_legacy_orphan', seeded.student.id, seeded.student.org_id, legacy, '老作品·没证据', now);
    db.close();
  }
  // 「重启服务」＝重跑 schema（发布时就是这么跑回填的）。这里用同一个进程跑 db.js 即可。
  await run(['packages/database/src/db.js', '--init']);
  {
    const db = new DatabaseSync(dbPath);
    const evidenced = db.prepare('SELECT class_session_id FROM works WHERE id=?').get('w74_legacy_evidenced');
    const orphan = db.prepare('SELECT class_session_id FROM works WHERE id=?').get('w74_legacy_orphan');
    const project = db.prepare('SELECT class_session_id FROM student_projects WHERE id=?').get('p74_legacy_evidenced');
    check('⑦ 老作品按「课堂名单记录」这条证据补上了课堂', evidenced?.class_session_id === sessionId, String(evidenced?.class_session_id));
    check('⑧ 老项目也补上了同一个课堂', project?.class_session_id === sessionId, String(project?.class_session_id));
    check('⑨ 没有任何证据的老作品保持留空（不硬认领）', orphan?.class_session_id === null, String(orphan?.class_session_id));
    db.close();
  }
  await run(['packages/database/src/db.js', '--init']);
  {
    const db = new DatabaseSync(dbPath);
    check('⑩ 再跑一次结果不变（回填幂等）',
      db.prepare('SELECT class_session_id FROM works WHERE id=?').get('w74_legacy_evidenced').class_session_id === sessionId
      && db.prepare('SELECT class_session_id FROM works WHERE id=?').get('w74_legacy_orphan').class_session_id === null);
    db.close();
  }

  console.log(JSON.stringify({ name: 'session-scope-columns', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
