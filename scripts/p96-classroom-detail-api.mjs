import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-detail-api-'));
const dbPath = path.join(temp, 'platform.db');
const env = { ...process.env, FILE_UPLOAD_ROOT: path.join(temp, 'uploads'), PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secret.json'), DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
async function run(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
}
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const db = new DatabaseSync(dbPath); db.exec('PRAGMA busy_timeout = 5000');
const student = db.prepare("SELECT * FROM users WHERE login='student-1'").get();
const lessons = db.prepare("SELECT * FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort").all();
const first = lessons[0];
const second = lessons.find((lesson) => lesson.id !== first.id && lesson.series_id === first.series_id);
assert.ok(second);
db.prepare("UPDATE course_lessons SET published_content=NULL,delivery_modes=?,delivery_mode='VIBECODING',platform_budget_fen=9876 WHERE id=?").run(JSON.stringify(['CANVAS', 'VIBECODING']), second.id);
const now = new Date().toISOString();
// Explicit grants are part of this test's positive-case setup, not shared seed behavior.
db.prepare('INSERT OR IGNORE INTO student_course_grants(id,org_id,student_id,series_id,granted_at) VALUES (?,?,?,?,?)').run('detail_grant', student.org_id, student.id, first.series_id, now);
db.prepare("UPDATE class_sessions SET status='ENDED' WHERE status IN ('PENDING','ACTIVE')").run();
db.prepare("UPDATE session_students SET status='INCOMPLETE' WHERE status IN ('PENDING','ACTIVE')").run();
const port = 19396;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', (chunk) => { logs += chunk; });
server.stderr.on('data', (chunk) => { logs += chunk; });
async function api(route, token, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  return { status: response.status, data: payload.data ?? payload, error: payload.error };
}
const check = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result)); return result.data; };
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const login = async (name, password) => check(await api('auth/login', null, 'POST', { login: name, password })).token;
  const teacher = await login('teacher-1', 'teach123');
  const other = await login('teacher-2', 'teach123');
  const admin = await login('org-admin', 'org123');
  const created = check(await api('org/sessions', teacher, 'POST', { lessonId: first.id, title: 'detail test' }));
  const route = `org/sessions/${created.id}`;
  const snapshot = () => db.prepare('SELECT * FROM class_sessions WHERE id=?').get(created.id);
  // 2026-09-18：学生算力上限收敛成唯一那套**按钱的** —— 断言的目标列从已退役的
  // `student_call_cap`（**次数**）换成 `student_cost_cap_fen`（**分**）。
  // 这是口径变更，不是测试漂移：老列已无读写方，钉它等于钉一个死字段。
  db.prepare('UPDATE class_sessions SET platform_budget_fen=4321,student_cost_cap_fen=700,ai_paused=1 WHERE id=?').run(created.id);
  const before = snapshot();
  check(await api(route, teacher, 'PUT', { title: 'renamed' }));
  const after = snapshot();
  for (const key of Object.keys(before).filter((key) => !['title', 'updated_at'].includes(key))) assert.equal(after[key], before[key], key);
  check(await api(route, other), 403);
  assert.equal(check(await api(route, admin)).canManage, false);
  check(await api(route, admin, 'PUT', { title: 'forbidden' }), 403);
  check(await api(`${route}/students`, teacher, 'POST', { studentIds: [student.id] }));
  assert.equal(db.prepare('SELECT status FROM session_students WHERE session_id=? AND student_id=?').get(created.id, student.id).status, 'PENDING');
  const denied = await api(route, teacher, 'PUT', { lessonId: second.id });
  check(denied, 409);
  assert.equal(denied.error.code, 'SESSION_SWAP_CONFIRM_REQUIRED');
  assert.equal(snapshot().lesson_id, first.id);
  check(await api(route, teacher, 'PUT', { lessonId: second.id, confirmClearStudents: true }));
  let part = db.prepare('SELECT * FROM session_students WHERE session_id=? AND student_id=?').get(created.id, student.id);
  assert.equal(part.status, 'REMOVED');
  assert.equal(part.lesson_id, first.id);
  assert.equal(snapshot().ai_paused, 0);
  // 换课 → 学生算力上限清空（口径：留空 = 不限制，绝不用老课的额度顶替新课堂）
  assert.equal(snapshot().student_cost_cap_fen, null);
  assert.equal(snapshot().platform_budget_fen, 9876);
  assert.equal(snapshot().delivery_mode, 'VIBECODING');
  check(await api(route, teacher, 'PUT', { deliveryMode: 'CANVAS' }));
  assert.equal(snapshot().delivery_mode, 'CANVAS');
  assert.equal(snapshot().platform_budget_fen, 9876);
  check(await api(`${route}/students`, teacher, 'POST', { studentIds: [student.id] }));
  part = db.prepare('SELECT * FROM session_students WHERE session_id=? AND student_id=?').get(created.id, student.id);
  assert.equal(part.lesson_id, second.id);
  assert.equal(part.status, 'PENDING');
  check(await api(route, teacher, 'PUT', { deliveryMode: 'INVALID' }), 400);
  check(await api(route, teacher, 'PUT', { deliveryMode: '' }), 400);
  check(await api(route, teacher, 'PUT', { deliveryMode: snapshot().delivery_mode }));
  for (const [suffix, status, model] of [['ok', 'SUCCESS', 'real-model'], ['fail', 'FAILED', 'real-model'], ['mock', 'SUCCESS', 'MOCK-model']]) {
    db.prepare('INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,created_at) VALUES (?,?,?,?,?,?,0,?,?)').run(`detail_${suffix}`, student.org_id, student.id, created.id, 'text', model, status, now);
  }
  db.prepare("INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,class_session_id,modality,status,sale_price_fen,sale_snapshot,created_at) VALUES ('detail_attempt','detail_call',1,?,?,?,'text','SUCCESS',100,'{}',?)").run(student.org_id, student.id, created.id, now);
  db.prepare("INSERT INTO student_projects(id,student_id,org_id,class_session_id,title,last_saved_at,created_at,updated_at) VALUES ('detail_project',?,?,?,'Canvas',?,?,?)").run(student.id, student.org_id, created.id, now, now, now);
  db.prepare("INSERT INTO works(id,project_id,student_id,org_id,class_session_id,title,canvas_snapshot,submitted_at) VALUES ('detail_work','detail_project',?,?,?,'Canvas','{}',?)").run(student.id, student.org_id, created.id, now);
  db.prepare("INSERT INTO vibecoding_conversations(id,org_id,student_id,class_session_id,title,created_at,updated_at) VALUES ('detail_conv',?,?,?,'Vibe',?,?)").run(student.org_id, student.id, created.id, now, now);
  db.prepare("INSERT INTO vibecoding_submissions(id,conversation_id,student_id,org_id,title,submitted_at,created_at,updated_at) VALUES ('detail_vibe','detail_conv',?,?,'Vibe',?,?,?)").run(student.id, student.org_id, now, now, now);
  db.prepare('UPDATE vibecoding_submissions SET files=? WHERE id=?').run(JSON.stringify({ 'index.html': '<h1>submitted snapshot</h1>' }), 'detail_vibe');
  db.prepare('UPDATE vibecoding_conversations SET files=? WHERE id=?').run(JSON.stringify({ 'index.html': '<h1>live must not leak</h1>' }), 'detail_conv');
  for (const source of ['CANVAS', 'VIBECODING']) {
    const workId = source === 'CANVAS' ? 'detail_work' : 'detail_vibe';
    const workRoute = `${route}/works/${source}/${workId}`;
    const result = check(await api(workRoute, teacher));
    assert.equal(result.source, source);
    if (source === 'VIBECODING') { assert.equal(result.files['index.html'], '<h1>submitted snapshot</h1>'); assert.equal(result.transcript, undefined); }
    else assert.deepEqual(result.canvasSnapshot, {});
    check(await api(workRoute, admin));
    check(await api(workRoute, other), 403);
    check(await api(workRoute, null), 401);
    check(await api(`${route}/works/${source}/missing`, teacher), 404);
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
  fs.mkdirSync(env.FILE_UPLOAD_ROOT, { recursive: true });
  fs.writeFileSync(path.join(env.FILE_UPLOAD_ROOT, 'detail.png'), png);
  db.prepare("INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_key,file_name,mime_type,visibility,status,created_at,updated_at) VALUES ('detail_image','USER',?,?,'INTERNAL_PROXY','detail.png','detail.png','image/png','PRIVATE','ACTIVE',?,?)").run(student.org_id, student.id, now, now);
  db.prepare('UPDATE vibecoding_submissions SET artifacts=? WHERE id=?').run(JSON.stringify([{ name: 'index.html', kind: 'html', embeddedImages: [{ fileId: 'detail_image' }] }]), 'detail_vibe');
  const imageRoute = `${route}/works/VIBECODING/detail_vibe/images/detail_image`;
  const imageResponse = await fetch(`http://127.0.0.1:${port}/api/${imageRoute}`, { headers: { authorization: `Bearer ${teacher}` } });
  assert.equal(imageResponse.status, 200);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  check(await api(imageRoute, other), 403);
  check(await api(imageRoute, null), 401);
  db.prepare("UPDATE file_assets SET owner_user_id=NULL WHERE id='detail_image'").run();
  check(await api(imageRoute, teacher), 404);
  db.prepare("UPDATE file_assets SET owner_user_id=? WHERE id='detail_image'").run(student.id);
  check(await api(`${route}/works/VIBECODING/detail_vibe/images/foreign`, teacher), 404);
  db.prepare('UPDATE works SET canvas_snapshot=? WHERE id=?').run(JSON.stringify({ nodes: [{ id: 'image', type: 'image', data: { assetUrl: '/api/student/file-assets/detail_image/download' } }] }), 'detail_work');
  const canvasContent = check(await api(`${route}/works/CANVAS/detail_work`, teacher));
  assert.ok(canvasContent.imageUrls.detail_image.includes('/works/CANVAS/'));
  const canvasImage = await fetch(`http://127.0.0.1:${port}${canvasContent.imageUrls.detail_image}`, { headers: { authorization: `Bearer ${admin}` } });
  assert.equal(canvasImage.status, 200);
  assert.deepEqual(Buffer.from(await canvasImage.arrayBuffer()), png);
  check(await api(`${route}/works/CANVAS/detail_work/images/foreign`, admin), 404);
  check(await api(`${route}/works/CANVAS/detail_work/images/detail_image`, other), 403);
  check(await api('public/vibecoding-works/detail_vibe', null), 404);
  const detail = check(await api(route, teacher));
  assert.equal(detail.runtime.ai.successCount, 1);
  assert.equal(detail.runtime.ai.failedCount, 1);
  assert.equal(detail.runtime.ai.salePriceFen, 100);
  assert.equal(detail.students[0].ai.successCount, 1);
  assert.equal(detail.students[0].lastActivityAt, now);
  assert.equal(detail.students[0].workCount, 2);
  assert.deepEqual(new Set(detail.works.map((work) => work.source)), new Set(['CANVAS', 'VIBECODING']));
  assert.ok(detail.works.every((work) => work.previewUrl === null));
  db.prepare("UPDATE class_sessions SET org_id='foreign-org' WHERE id=?").run(created.id);
  check(await api(route, admin), 404);
  check(await api(route, teacher), 404);
  check(await api(`${route}/works/CANVAS/detail_work`, admin), 404);
  check(await api(`${route}/works/VIBECODING/detail_vibe/images/detail_image`, admin), 404);
  db.prepare('UPDATE class_sessions SET org_id=? WHERE id=?').run(student.org_id, created.id);
  assert.equal(detail.canManage, true);
  assert.equal(detail.runtime.presence, 'unknown');
  assert.equal(detail.runtime.durationSeconds, null);
  assert.equal(detail.students[0].presence, 'unknown');
  assert.ok(Array.isArray(detail.works));
  assert.ok(detail.events.some((event) => event.action === 'SESSION_UPDATE'));
  assert.ok(!JSON.stringify(detail.events).includes('before_data'));
  check(await api(`${route}/start`, teacher, 'POST', {}));
  check(await api(route, teacher, 'PUT', { title: 'active edit' }), 409);
  check(await api(`${route}/end`, admin, 'POST', {}), 403);
  check(await api(`${route}/end`, teacher, 'POST', {}));
  assert.equal(check(await api(route, teacher)).canManage, false);
  const settled = db.prepare('SELECT * FROM session_students WHERE session_id=? AND student_id=?').get(created.id, student.id);
  assert.equal(settled.status, 'COMPLETED', 'real success before end completes the student');
  await run(['--input-type=module', '-e', `const {recordAiUsage}=await import('./apps/server/src/services/creditUsage.js'); recordAiUsage(${JSON.stringify({ orgId: student.org_id, userId: student.id, sessionId: created.id, modality: 'text', model: 'real-late', status: 'SUCCESS' })});`]);
  assert.deepEqual(db.prepare('SELECT * FROM session_students WHERE session_id=? AND student_id=?').get(created.id, student.id), settled);
  const lateSession = check(await api('org/sessions', teacher, 'POST', { lessonId: first.id }));
  const lateRoute = `org/sessions/${lateSession.id}`;
  check(await api(`${lateRoute}/students`, teacher, 'POST', { studentIds: [student.id] }));
  check(await api(`${lateRoute}/start`, teacher, 'POST', {}));
  check(await api(`${lateRoute}/end`, teacher, 'POST', {}));
  const frozen = db.prepare('SELECT * FROM session_students WHERE session_id=? AND student_id=?').get(lateSession.id, student.id);
  assert.equal(frozen.status, 'INCOMPLETE');
  await run(['--input-type=module', '-e', `const {recordAiUsage}=await import('./apps/server/src/services/creditUsage.js'); const {settleSessionStudents}=await import('./apps/server/src/services/classroomSessions.js'); recordAiUsage(${JSON.stringify({ orgId: student.org_id, userId: student.id, sessionId: lateSession.id, modality: 'text', model: 'real-late', status: 'SUCCESS' })}); settleSessionStudents({sessionId:${JSON.stringify(lateSession.id)}});`]);
  assert.deepEqual(db.prepare('SELECT * FROM session_students WHERE session_id=? AND student_id=?').get(lateSession.id, student.id), frozen);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_records WHERE class_session_id=? AND status='SUCCESS'").get(lateSession.id).n, 1, 'late success remains in ledger');
  assert.equal(check(await api(lateRoute, teacher)).students[0].status, 'INCOMPLETE');
  check(await api(route, teacher, 'PUT', { title: 'ended edit' }), 409);
  check(await api(`${route}/students`, teacher, 'POST', { studentIds: [student.id] }), 409);
  check(await api(`${route}/students/${student.id}`, teacher, 'DELETE'), 409);
  const dissolved = check(await api('org/sessions', teacher, 'POST', { lessonId: first.id }));
  check(await api(`org/sessions/${dissolved.id}/dissolve`, teacher, 'POST', {}));
  check(await api(`org/sessions/${dissolved.id}`, teacher, 'PUT', { title: 'dissolved edit' }), 409);
  check(await api(`${route}/candidates`, admin));
  check(await api(`${route}/candidates`, other), 403);
  const adminOwn = check(await api('org/sessions', admin, 'POST', { lessonId: first.id }));
  check(await api(`org/sessions/${adminOwn.id}`, admin, 'PUT', { title: 'admin own' }));
  check(await api(`org/sessions/${adminOwn.id}/dissolve`, admin, 'POST', {}));
  const events = db.prepare("SELECT action FROM audit_logs WHERE target_id=? AND target_type='CLASS_SESSION'").all(created.id).map((item) => item.action);
  for (const action of ['SESSION_CREATE','SESSION_UPDATE','SESSION_STUDENTS_ADD','SESSION_START','SESSION_END']) assert.ok(events.includes(action), action);
  console.log('PASS classroom detail isolated HTTP: title-only preservation, swap confirmation/history/rejoin, environment validation, terminal read-only, ownership isolation, runtime and audit');
} catch (error) {
  console.error(logs.slice(-2500));
  throw error;
} finally {
  const stopped = once(server, 'exit');
  server.kill();
  await stopped;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
