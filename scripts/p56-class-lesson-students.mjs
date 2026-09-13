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
import { classroomStudents } from './lib/classroomApi.mjs';

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

  const created = await api('/api/admin/course-series', { method: 'POST', token: admin, body: { title: 'P56 排课课包', description: '排课候选与完课门禁', coverImageUrl: 'https://example.com/guard-cover.png', visibility: 'ALL_ORGS', stockTotal: 10, lessons: [{ title: '第1课', status: 'PUBLISHED', capabilities: ['text'], deliveryModes: ['CANVAS'] }] } });
  const seriesId = created.data.id; const lessonId = created.data.lessons[0].id;
  await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
  await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgIds: [org.organization.id], validityDays: 365, quotaTotal: 10 } });

  // 批次 D（班级退场）：原来这里是「班级 + 课单 + 每节课的排课名单（class_lesson_students）」。
  // 那套已经下线，**排课名单的替代品就是课堂名单**（session_students），
  // 所以这个守卫整体搬到课堂口径上：可加/不可加、加不进给原因、加进去后进名单、完课不可再加。
  const classroom = await api('/api/org/sessions', { method: 'POST', token: org.token, body: { lessonId, title: 'P56 排课课堂' } });
  check('建课堂成功', classroom.status === 200 && Boolean(classroom.data?.id), JSON.stringify(classroom.data).slice(0, 140));
  const sessionId = classroom.data.id;

  // 还没授权任何人：都不可加，原因写明「没许可」
  let candidates = await api(`/api/org/sessions/${sessionId}/candidates`, { token: org.token });
  check('候选人接口可用（可加/不可加两栏）',
    candidates.status === 200 && Array.isArray(candidates.data?.selectable) && Array.isArray(candidates.data?.blocked),
    JSON.stringify(candidates.data).slice(0, 140));
  check('没许可的学员不可加，并给出原因', (candidates.data.blocked || []).every((item) => item.reason === 'NO_GRANT'), JSON.stringify(candidates.data.blocked).slice(0, 200));

  // 给第一个学员授权 → 他变成可加
  await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [first.id] } });
  candidates = await api(`/api/org/sessions/${sessionId}/candidates`, { token: org.token });
  check('有许可的学员变为可加', (candidates.data.selectable || []).some((item) => item.id === first.id), JSON.stringify(candidates.data.selectable).slice(0, 160));
  if (second) check('没许可的学员仍在不可加里', (candidates.data.blocked || []).some((item) => item.id === second.id), JSON.stringify(candidates.data.blocked).slice(0, 160));

  // 没许可的加不进去（服务端跳过并说明原因，不是静默成功）
  if (second) {
    const bad = await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: org.token, body: { studentIds: [second.id] } });
    check('把没许可的学员加进来会被跳过并给原因',
      bad.status === 200 && (bad.data?.added || []).length === 0 && (bad.data?.skipped || []).some((item) => item.studentId === second.id && item.reason === 'NO_GRANT'),
      JSON.stringify(bad.data).slice(0, 200));
  }

  // 有许可的加得进去 → 候选人里他进「已在这节课上」
  const ok = await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: org.token, body: { studentIds: [first.id] } });
  check('加学员进课堂成功', ok.status === 200 && (ok.data?.added || []).length === 1, JSON.stringify(ok.data).slice(0, 140));
  candidates = await api(`/api/org/sessions/${sessionId}/candidates`, { token: org.token });
  check('已在名单里的学员出现在 alreadyIn（不再出现在可加里）',
    (candidates.data.alreadyIn || []).some((item) => item.id === first.id) && !(candidates.data.selectable || []).some((item) => item.id === first.id),
    JSON.stringify(candidates.data.alreadyIn).slice(0, 160));

  // 前置：把课堂开起来，学员才能进课时
  const started = await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: org.token });
  check('老师能开始上课（前置条件）', started.status === 200, `${started.status} ${JSON.stringify(started.error || {}).slice(0, 120)}`);

  // 学员提交作品 + 课堂结束 → 结算。
  // ⚠️ 批次 B/C 的口径变化：**完课判定 = 这个学生在这节课消耗过算力**（成功调用且花钱 > 0），
  //    不再是「提交过作品就算上过」。所以只交作品的他结算成**未完课**，而未完课**可以**再被排进课堂。
  const studentToken = (await api('/api/auth/login', { method: 'POST', body: { login: first.login, password: 'study123' } })).data.token;
  const project = await api('/api/student/projects', { method: 'POST', token: studentToken, body: { courseLessonId: lessonId, title: 'P56 作品' } });
  if (project.status === 200) {
    const submitted = await api(`/api/student/projects/${project.data.id}/submit`, { method: 'POST', token: studentToken, body: { copyrightConfirmed: true } });
    check('学员能提交作品（前置条件）', submitted.status === 200, `${submitted.status}`);
    await api(`/api/org/sessions/${sessionId}/end`, { method: 'POST', token: org.token, body: {} });
    const settled = await classroomStudents(api, org.token, sessionId);
    const mine = settled.find((item) => item.studentId === first.id) || {};
    check('只交了作品、没花过算力 → 结算成「未完课」', mine.status === 'INCOMPLETE', JSON.stringify(mine).slice(0, 200));

    // 未完课可以再上：新课堂里他仍然是可加的
    const again = await api('/api/org/sessions', { method: 'POST', token: org.token, body: { lessonId, title: 'P56 未完课再来一次' } });
    const againCandidates = await api(`/api/org/sessions/${again.data.id}/candidates`, { token: org.token });
    check('未完课的学员可以再被排进课堂（新口径）',
      (againCandidates.data.selectable || []).some((item) => item.id === first.id), JSON.stringify(againCandidates.data.selectable).slice(0, 160));

    // 真·完课：这节课**消耗过算力** → 结束结算成「已完课」→ 不能再被排进别的课堂
    await api(`/api/org/sessions/${again.data.id}/students`, { method: 'POST', token: org.token, body: { studentIds: [first.id] } });
    await api(`/api/org/sessions/${again.data.id}/start`, { method: 'POST', token: org.token });
    {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.prepare("INSERT INTO usage_records(id,org_id,user_id,class_session_id,project_id,modality,model,credits_charged,status,cost_fen,created_at) VALUES (?,?,?,?,NULL,'TEXT','p56-model',0,'SUCCESS',100,?)")
        .run('usage_p56_completed', org.organization.id, first.id, again.data.id, new Date().toISOString());
      db.close();
    }
    await api(`/api/org/sessions/${again.data.id}/end`, { method: 'POST', token: org.token, body: {} });
    const settled2 = await classroomStudents(api, org.token, again.data.id);
    check('消耗过算力 → 结算成「已完课」', (settled2.find((item) => item.studentId === first.id) || {}).status === 'COMPLETED', JSON.stringify(settled2).slice(0, 200));

    const third = await api('/api/org/sessions', { method: 'POST', token: org.token, body: { lessonId, title: 'P56 第三个课堂' } });
    const thirdCandidates = await api(`/api/org/sessions/${third.data.id}/candidates`, { token: org.token });
    const row = (thirdCandidates.data.blocked || []).find((item) => item.id === first.id) || {};
    check('已完课的学员不可再加，并且说明了原因', String(row.reasonText || '').includes('完课'), JSON.stringify(row).slice(0, 200));
    const reject = await api(`/api/org/sessions/${third.data.id}/students`, { method: 'POST', token: org.token, body: { studentIds: [first.id] } });
    check('把已完课的学员再加一次会被跳过', (reject.data?.added || []).length === 0, JSON.stringify(reject.data).slice(0, 160));
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
