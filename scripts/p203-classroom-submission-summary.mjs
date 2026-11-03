/**
 * P203 「结束课堂前的作品提交提醒」守卫（2026-11-02）。
 *
 * 用户口径：一堂课 5 个学生，老师点结束课堂时应该能看见「谁交了、谁没交、谁明显少于多数」，
 * 有缺交时弹窗确认；已经交过的不重复、不虚增。
 *
 * 这一道钉住：
 *   ① 汇总按**本场课堂**统计画布 works + 客户端 vibecoding_submissions（别的课不算）；
 *   ② 0 件 = 未提交（MISSING）；>0 但少于本节课众数 = 少于多数（BELOW_PEERS）；
 *   ③ 有提醒时 end 不带 confirmIncomplete → 409 SESSION_HAS_MISSING_SUBMISSIONS，课堂仍是 ACTIVE；
 *   ④ 老师确认（confirmIncomplete: true）→ 正常结束；
 *   ⑤ 全部已交 → 不带确认也能结束；
 *   ⑥ 同一作品重复提交（work_submissions round+1）不会让件数虚增。
 *
 * 跑法：node scripts/p203-classroom-submission-summary.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p203-submission-summary-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow, arows, hashPassword } = await import('../packages/database/src/store.js');

const PORT = 18989;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p203-guard-secret',
  PORT: String(PORT),
};

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);

const orgAdmin = await arow("SELECT id, org_id, login FROM users WHERE login='org-admin' LIMIT 1");
assert.ok(orgAdmin?.org_id, '种子数据里没有 org-admin');
const now = new Date().toISOString();

// 一个 5 人 ACTIVE 课堂：取本机构一节 ACTIVE 课堂，把另外 4 个学生加进名单。
const session = await arow("SELECT * FROM class_sessions WHERE org_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1", [orgAdmin.org_id]);
assert.ok(session, '夹具没有 ACTIVE 课堂');
let students = await arows("SELECT id, display_name, login FROM users WHERE org_id=? AND role='STUDENT' AND status='ACTIVE' ORDER BY created_at LIMIT 5", [orgAdmin.org_id]);
// 种子只有 2 个学生：补 3 个（只用于本守卫的名单/计数，不需要许可或登录）。
for (let index = students.length + 1; index <= 5; index += 1) {
  const studentId = `p203_student_${index}`;
  await aq(`INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at)
    VALUES (?,?,?,?, 'STUDENT', '[]', ?, 'ACTIVE', ?, ?)`,
  [studentId, orgAdmin.org_id, `p203-student-${index}`, `P203 学生 ${index}`, hashPassword('study123'), now, now]);
}
students = await arows("SELECT id, display_name, login FROM users WHERE org_id=? AND role='STUDENT' AND status='ACTIVE' ORDER BY created_at LIMIT 5", [orgAdmin.org_id]);
assert.ok(students.length >= 5, `种子学生不足 5 人（现在 ${students.length}）`);
for (const student of students) {
  const existing = await arow("SELECT id FROM session_students WHERE session_id=? AND student_id=? AND status<>'REMOVED'", [session.id, student.id]);
  if (!existing) {
    await aq(`INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at)
      VALUES (?,?,?,?,?,?, 'ACTIVE', NULL, ?, ?)`,
    [`p203_part_${student.id}`, session.id, student.id, session.org_id, session.lesson_id, session.series_id, now, now]);
  }
}

let seq = 0;
async function addCanvasWork(student, label) {
  seq += 1;
  const projectId = `p203_project_${seq}`;
  const workId = `p203_work_${seq}`;
  await aq(`INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,class_session_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at)
    VALUES (?,?,?,NULL,?,?,?, 'SUBMITTED', '{"nodes":[],"edges":[]}', 1, ?, ?, ?)`,
  [projectId, student.id, session.org_id, session.lesson_id, session.id, label, now, now, now]);
  await aq(`INSERT INTO works(id,project_id,student_id,org_id,class_id,class_session_id,course_lesson_id,title,description,canvas_snapshot,status,submitted_at,copyright_confirmed_at,copyright_confirmed_by)
    VALUES (?,?,?,?,NULL,?,?,?, '', '{"nodes":[],"edges":[]}', 'PENDING', ?, ?, ?)`,
  [workId, projectId, student.id, session.org_id, session.id, session.lesson_id, label, now, now, student.id]);
  return { projectId, workId };
}

// 分布：A 0 件（未提交）；B 1 件（少于多数）；C/D/E 各 2 件（多数）。
// C 的 2 件 = 画布 1 件 + 客户端 1 件；D/E 各 2 件画布。
const [studentA, studentB, studentC, studentD, studentE] = students;
await addCanvasWork(studentB, 'B 的 1 件');
const cWork = await addCanvasWork(studentC, 'C 的第 1 件');
await addCanvasWork(studentD, 'D 的第 1 件');
await addCanvasWork(studentD, 'D 的第 2 件');
await addCanvasWork(studentE, 'E 的第 1 件');
await addCanvasWork(studentE, 'E 的第 2 件');
// C 的工作区里还有一条客户端提交（画布 + VibeCoding 两种来源合并计数）
await aq(`INSERT INTO vibecoding_conversations(id,org_id,student_id,class_id,lesson_id,class_session_id,title,status,created_at,updated_at)
  VALUES (?,?,?,NULL,?,?, 'P203 客户端作品', 'DRAFT', ?, ?)`,
['p203_conv', session.org_id, studentC.id, session.lesson_id, session.id, now, now]);
await aq(`INSERT INTO vibecoding_submissions(id,conversation_id,student_id,org_id,class_id,lesson_id,title,description,files,transcript,round,status,submitted_at,created_at,updated_at,entry_file)
  VALUES (?,?,?,?,NULL,?,?, '', '{}', '[]', 1, 'PENDING', ?, ?, ?, 'index.html')`,
['p203_submission', 'p203_conv', studentC.id, session.org_id, session.lesson_id, 'P203 客户端作品', now, now, now]);
// C 的画布作品又提交了一轮：works 仍然只有一条，件数不该虚增。
await aq(`INSERT INTO work_submissions(id,work_id,project_id,student_id,org_id,round,title,description,canvas_snapshot,snapshot_version,submitted_at,created_at,updated_at)
  VALUES (?,?,?,?,?, 2, ?, '', '{"nodes":[],"edges":[]}', 2, ?, ?, ?)`,
['p203_round2', cWork.workId, cWork.projectId, studentC.id, session.org_id, 'C 的第 1 件', now, now, now]);
// 学生 A 有一个**没提交过**的画布项目（有产出、但没点提交）：老师确认结束时应该被自动提交。
const aProjectId = 'p203_a_project';
const aSnapshot = { nodes: [{ id: 'p203-a-node', data: { generatedText: 'P203 学生 A 的画布产出' } }], edges: [] };
await aq(`INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,class_session_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at)
  VALUES (?,?,?,NULL,?,?, 'A 未提交的画布作品', 'DRAFT', ?, 1, ?, ?, ?)`,
[aProjectId, studentA.id, session.org_id, session.lesson_id, session.id, JSON.stringify(aSnapshot), now, now, now]);

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-800)}`);
    await sleep(150);
  }
  const login = async (l, p) => (await api('/api/auth/login', { method: 'POST', body: { login: l, password: p } })).data.token;
  const token = await login('org-admin', 'org123');
  assert.ok(token, 'org-admin 登录失败');

  const summaryApi = () => api(`/api/org/sessions/${encodeURIComponent(session.id)}/submission-summary`, { token });
  const endApi = (body) => api(`/api/org/sessions/${encodeURIComponent(session.id)}/end`, { method: 'POST', token, body });

  const summary = await summaryApi();
  await check('汇总：5 个学生、7 件作品、多数 2 件（画布 + 客户端合并）', () => {
    assert.equal(summary.status, 200, JSON.stringify(summary.raw).slice(0, 300));
    assert.equal(summary.data.studentCount, 5);
    assert.equal(summary.data.totalWorks, 7);
    assert.equal(summary.data.majorityCount, 2);
    assert.equal(summary.data.missingCount, 1);
    assert.equal(summary.data.belowPeerCount, 1);
  });
  await check('明细：0 件 = 未提交，1 件 = 少于多数，2 件 = 正常（且重复提交不虚增）', () => {
    const byId = new Map(summary.data.items.map((item) => [item.studentId, item]));
    assert.equal(byId.get(studentA.id)?.workCount, 0);
    assert.equal(byId.get(studentA.id)?.warning, 'MISSING');
    assert.equal(byId.get(studentB.id)?.workCount, 1);
    assert.equal(byId.get(studentB.id)?.warning, 'BELOW_PEERS');
    assert.equal(byId.get(studentC.id)?.workCount, 2, 'C 是 2 件（画布 1 + 客户端 1；画布第 2 轮不重复计）');
    assert.equal(byId.get(studentC.id)?.warning, 'NONE');
    assert.equal(byId.get(studentD.id)?.warning, 'NONE');
    assert.equal(byId.get(studentE.id)?.warning, 'NONE');
    assert.equal(summary.data.items[0].warning, 'MISSING', '未提交的排最前');
  });

  const blocked = await endApi({ submissionCheck: true });
  await check('有缺交时直接结束 → 409 SESSION_HAS_MISSING_SUBMISSIONS，课堂仍是 ACTIVE', async () => {
    assert.equal(blocked.status, 409, JSON.stringify(blocked.raw).slice(0, 300));
    assert.equal(blocked.data?.error?.code, 'SESSION_HAS_MISSING_SUBMISSIONS');
    assert.equal(blocked.data?.error?.details?.summary?.missingCount, 1);
    const row = await arow('SELECT status FROM class_sessions WHERE id=?', [session.id]);
    assert.equal(row?.status, 'ACTIVE');
  });

  const confirmed = await endApi({ submissionCheck: true, confirmIncomplete: true });
  await check('老师看过明细后确认（confirmIncomplete: true）→ 正常结束', async () => {
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.raw).slice(0, 300));
    const row = await arow('SELECT status FROM class_sessions WHERE id=?', [session.id]);
    assert.equal(row?.status, 'ENDED');
  });

  await check('画布：老师确认结束时，缺交学生的画布作品自动提交（未确认版权）', async () => {
    const work = await arow('SELECT * FROM works WHERE project_id=?', [aProjectId]);
    assert.ok(work, 'A 的画布作品没有自动提交');
    assert.equal(Number(work.auto_submitted), 1, '应标记为系统自动提交');
    assert.equal(work.copyright_confirmed_at, null, '自动提交不能代替学生确认版权');
    const project = await arow('SELECT status,last_submitted_output_signature FROM student_projects WHERE id=?', [aProjectId]);
    assert.equal(project?.status, 'SUBMITTED');
    assert.ok(project?.last_submitted_output_signature, '提交后应写入产出指纹');
    assert.ok(Number(confirmed.data?.canvasAutoSubmit?.submitted || 0) >= 1, '结束响应应回自动提交数量');
  });

  // 第二场：名单里每个学生各 1 件 → 没有提醒，直接结束。
  const second = await arow("SELECT * FROM class_sessions WHERE org_id=? AND status='ACTIVE' AND id<>? ORDER BY created_at LIMIT 1", [orgAdmin.org_id, session.id]);
  assert.ok(second, '夹具没有第二场 ACTIVE 课堂');
  const secondParts = await arows("SELECT student_id FROM session_students WHERE session_id=? AND status<>'REMOVED'", [second.id]);
  assert.ok(secondParts.length, '第二场课堂没有学生');
  for (const [index, part] of secondParts.entries()) {
    const projectId = `p203_second_project_${index}`;
    const workId = `p203_second_work_${index}`;
    await aq(`INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,class_session_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at)
      VALUES (?,?,?,NULL,?,?, '第二场作品', 'SUBMITTED', '{"nodes":[],"edges":[]}', 1, ?, ?, ?)`,
    [projectId, part.student_id, second.org_id, second.lesson_id, second.id, now, now, now]);
    await aq(`INSERT INTO works(id,project_id,student_id,org_id,class_id,class_session_id,course_lesson_id,title,description,canvas_snapshot,status,submitted_at,copyright_confirmed_at,copyright_confirmed_by)
      VALUES (?,?,?,?,NULL,?,?,?, '', '{"nodes":[],"edges":[]}', 'PENDING', ?, ?, ?)`,
    [workId, projectId, part.student_id, second.org_id, second.id, second.lesson_id, '第二场作品', now, now, part.student_id]);
  }
  const secondSummary = await api(`/api/org/sessions/${encodeURIComponent(second.id)}/submission-summary`, { token });
  await check('全部已交：第二场汇总 warningCount=0', () => {
    assert.equal(secondSummary.status, 200, JSON.stringify(secondSummary.raw).slice(0, 300));
    assert.equal(secondSummary.data.studentCount, secondParts.length);
    assert.equal(secondSummary.data.totalWorks, secondParts.length);
    assert.equal(secondSummary.data.warningCount, 0);
  });
  const secondEnd = await api(`/api/org/sessions/${encodeURIComponent(second.id)}/end`, { method: 'POST', token, body: { submissionCheck: true } });
  await check('全部已交时直接结束 → 200，不需要 confirmIncomplete', async () => {
    assert.equal(secondEnd.status, 200, JSON.stringify(secondEnd.raw).slice(0, 300));
    const row = await arow('SELECT status FROM class_sessions WHERE id=?', [second.id]);
    assert.equal(row?.status, 'ENDED');
  });
} finally {
  server.kill('SIGTERM');
  await sleep(300);
}

const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.ok ? '' : `\n   ${item.message}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) process.exitCode = 1;
