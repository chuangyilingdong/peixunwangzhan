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
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');
const { closeDb } = await import("../packages/database/src/store.js");

const env = { ...process.env, FILE_UPLOAD_ROOT: path.join(temp, 'uploads'), PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp, PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secret.json'), DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
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
 
const student = await arow("SELECT * FROM users WHERE login='student-1'");
const lessons = await arows("SELECT * FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort");
const first = lessons[0];
const second = lessons.find((lesson) => lesson.id !== first.id && lesson.series_id === first.series_id);
assert.ok(second);
await aq("UPDATE course_lessons SET published_content=NULL,delivery_modes=?,delivery_mode='VIBECODING',platform_budget_fen=9876 WHERE id=?", [JSON.stringify(['CANVAS', 'VIBECODING']), second.id]);
const now = new Date().toISOString();
// Explicit grants are part of this test's positive-case setup, not shared seed behavior.
await aq('INSERT OR IGNORE INTO student_course_grants(id,org_id,student_id,series_id,granted_at) VALUES (?,?,?,?,?)', ['detail_grant', student.org_id, student.id, first.series_id, now]);
await aq("UPDATE class_sessions SET status='ENDED' WHERE status IN ('PENDING','ACTIVE')");
await aq("UPDATE session_students SET status='INCOMPLETE' WHERE status IN ('PENDING','ACTIVE')");
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
  const snapshot = async () => await arow('SELECT * FROM class_sessions WHERE id=?', [created.id]);
  // 2026-09-18：学生算力上限收敛成唯一那套**按钱的** —— 断言的目标列从已退役的
  // `student_call_cap`（**次数**）换成 `student_cost_cap_fen`（**分**）。
  // 这是口径变更，不是测试漂移：老列已无读写方，钉它等于钉一个死字段。
  await aq('UPDATE class_sessions SET platform_budget_fen=4321,student_cost_cap_fen=700,ai_paused=1 WHERE id=?', [created.id]);
  const before = await snapshot();
  check(await api(route, teacher, 'PUT', { title: 'renamed' }));
  const after = await snapshot();
  for (const key of Object.keys(before).filter((key) => !['title', 'updated_at'].includes(key))) assert.equal(after[key], before[key], key);
  check(await api(route, other), 403);
  // ⭐ 口径变更（2026-09-20 用户口径）：「机构端应该拥有老师端的所有权限」——
  //    原来是"仅课堂负责人本人"（机构管理员对别的老师建的课堂只读，连「结束课堂」都点不了，
  //    机构没法给老师收尾）。现在：负责人本人，或**本机构的机构管理员**。这两条断言跟着翻。
  assert.equal(check(await api(route, admin)).canManage, true, '机构管理员应当可以管理本机构老师的课堂');
  check(await api(route, admin, 'PUT', { title: 'renamed-by-org-admin' }));
  assert.equal((await snapshot()).title, 'renamed-by-org-admin');
  check(await api(route, admin, 'PUT', { title: 'renamed' }));
  // 解散前的逐条校验里那条 OWNER_MATCH 也要跟着放行（它是同一个判定的第三个落点）
  const dissolvePrecheck = check(await api(`${route}/precheck?action=dissolve`, admin));
  const ownerCheck = (dissolvePrecheck.checks || []).find((item) => item.key === 'OWNER_MATCH');
  assert.ok(ownerCheck, '解散预检里应当有 OWNER_MATCH 这条');
  assert.equal(ownerCheck.passed, true, `机构管理员看别的老师的课堂，OWNER_MATCH 应当是 passed（实际 ${JSON.stringify(ownerCheck)}）`);
  check(await api(`${route}/students`, teacher, 'POST', { studentIds: [student.id] }));
  assert.equal((await arow('SELECT status FROM session_students WHERE session_id=? AND student_id=?', [created.id, student.id])).status, 'PENDING');
  const denied = await api(route, teacher, 'PUT', { lessonId: second.id });
  check(denied, 409);
  assert.equal(denied.error.code, 'SESSION_SWAP_CONFIRM_REQUIRED');
  assert.equal((await snapshot()).lesson_id, first.id);
  check(await api(route, teacher, 'PUT', { lessonId: second.id, confirmClearStudents: true }));
  let part = await arow('SELECT * FROM session_students WHERE session_id=? AND student_id=?', [created.id, student.id]);
  assert.equal(part.status, 'REMOVED');
  assert.equal(part.lesson_id, first.id);
  assert.equal((await snapshot()).ai_paused, 0);
  // 换课 → 学生算力上限清空（口径：留空 = 不限制，绝不用老课的额度顶替新课堂）
  assert.equal((await snapshot()).student_cost_cap_fen, null);
  assert.equal((await snapshot()).platform_budget_fen, 9876);
  assert.equal((await snapshot()).delivery_mode, 'VIBECODING');
  check(await api(route, teacher, 'PUT', { deliveryMode: 'CANVAS' }));
  assert.equal((await snapshot()).delivery_mode, 'CANVAS');
  assert.equal((await snapshot()).platform_budget_fen, 9876);
  check(await api(`${route}/students`, teacher, 'POST', { studentIds: [student.id] }));
  part = await arow('SELECT * FROM session_students WHERE session_id=? AND student_id=?', [created.id, student.id]);
  assert.equal(part.lesson_id, second.id);
  assert.equal(part.status, 'PENDING');
  check(await api(route, teacher, 'PUT', { deliveryMode: 'INVALID' }), 400);
  check(await api(route, teacher, 'PUT', { deliveryMode: '' }), 400);
  check(await api(route, teacher, 'PUT', { deliveryMode: (await snapshot()).delivery_mode }));
  for (const [suffix, status, model] of [['ok', 'SUCCESS', 'real-model'], ['fail', 'FAILED', 'real-model'], ['mock', 'SUCCESS', 'MOCK-model']]) {
    await aq('INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,created_at) VALUES (?,?,?,?,?,?,0,?,?)', [`detail_${suffix}`, student.org_id, student.id, created.id, 'text', model, status, now]);
  }
  await aq("INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,class_session_id,modality,status,sale_price_fen,sale_snapshot,created_at) VALUES ('detail_attempt','detail_call',1,?,?,?,'text','SUCCESS',100,'{}',?)", [student.org_id, student.id, created.id, now]);
  await aq("INSERT INTO student_projects(id,student_id,org_id,class_session_id,title,last_saved_at,created_at,updated_at) VALUES ('detail_project',?,?,?,'Canvas',?,?,?)", [student.id, student.org_id, created.id, now, now, now]);
  await aq("INSERT INTO works(id,project_id,student_id,org_id,class_session_id,title,canvas_snapshot,submitted_at) VALUES ('detail_work','detail_project',?,?,?,'Canvas','{}',?)", [student.id, student.org_id, created.id, now]);
  await aq("INSERT INTO vibecoding_conversations(id,org_id,student_id,class_session_id,title,created_at,updated_at) VALUES ('detail_conv',?,?,?,'Vibe',?,?)", [student.org_id, student.id, created.id, now, now]);
  await aq("INSERT INTO vibecoding_submissions(id,conversation_id,student_id,org_id,title,submitted_at,created_at,updated_at) VALUES ('detail_vibe','detail_conv',?,?,'Vibe',?,?,?)", [student.id, student.org_id, now, now, now]);
  await aq('UPDATE vibecoding_submissions SET files=? WHERE id=?', [JSON.stringify({ 'index.html': '<h1>submitted snapshot</h1>' }), 'detail_vibe']);
  await aq('UPDATE vibecoding_conversations SET files=? WHERE id=?', [JSON.stringify({ 'index.html': '<h1>live must not leak</h1>' }), 'detail_conv']);
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
  await aq("INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_key,file_name,mime_type,visibility,status,created_at,updated_at) VALUES ('detail_image','USER',?,?,'INTERNAL_PROXY','detail.png','detail.png','image/png','PRIVATE','ACTIVE',?,?)", [student.org_id, student.id, now, now]);
  await aq('UPDATE vibecoding_submissions SET artifacts=? WHERE id=?', [JSON.stringify([{ name: 'index.html', kind: 'html', embeddedImages: [{ fileId: 'detail_image' }] }]), 'detail_vibe']);
  const imageRoute = `${route}/works/VIBECODING/detail_vibe/images/detail_image`;
  const imageResponse = await fetch(`http://127.0.0.1:${port}/api/${imageRoute}`, { headers: { authorization: `Bearer ${teacher}` } });
  assert.equal(imageResponse.status, 200);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  check(await api(imageRoute, other), 403);
  check(await api(imageRoute, null), 401);
  await aq("UPDATE file_assets SET owner_user_id=NULL WHERE id='detail_image'");
  check(await api(imageRoute, teacher), 404);
  await aq("UPDATE file_assets SET owner_user_id=? WHERE id='detail_image'", [student.id]);
  check(await api(`${route}/works/VIBECODING/detail_vibe/images/foreign`, teacher), 404);
  await aq('UPDATE works SET canvas_snapshot=? WHERE id=?', [JSON.stringify({ nodes: [{ id: 'image', type: 'image', data: { assetUrl: '/api/student/file-assets/detail_image/download' } }] }), 'detail_work']);
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
  await aq("UPDATE class_sessions SET org_id='foreign-org' WHERE id=?", [created.id]);
  check(await api(route, admin), 404);
  check(await api(route, teacher), 404);
  check(await api(`${route}/works/CANVAS/detail_work`, admin), 404);
  check(await api(`${route}/works/VIBECODING/detail_vibe/images/detail_image`, admin), 404);
  await aq('UPDATE class_sessions SET org_id=? WHERE id=?', [student.org_id, created.id]);
  assert.equal(detail.canManage, true);
  assert.equal(detail.runtime.presence, 'unknown');
  assert.equal(detail.runtime.durationSeconds, null);
  assert.equal(detail.students[0].presence, 'unknown');
  assert.ok(Array.isArray(detail.works));
  assert.ok(detail.events.some((event) => event.action === 'SESSION_UPDATE'));
  assert.ok(!JSON.stringify(detail.events).includes('before_data'));
  check(await api(`${route}/start`, teacher, 'POST', {}));
  check(await api(route, teacher, 'PUT', { title: 'active edit' }), 409);
  // ⭐ 用户报的原场景（2026-09-20）：「老师端可以结束课堂，但是机构端没办法对机构下面老师创建的课堂结束」。
  //    这里原来钉的是 **403**（机构管理员对别的老师的课堂只读）—— 那是旧口径。
  //    现在：机构管理员对本机构的任何课堂都有管理权，所以**由机构管理员来结束**，并断言状态真的落了。
  assert.equal(check(await api(route, admin)).canManage, true, '机构管理员应当能管理本机构老师创建的课堂');
  check(await api(`${route}/end`, admin, 'POST', {}));
  assert.equal((await arow('SELECT status FROM class_sessions WHERE id=?', [created.id])).status, 'ENDED', '机构管理员结束老师创建的课堂应当生效');
  assert.equal(check(await api(route, teacher)).canManage, false);
  const settled = await arow('SELECT * FROM session_students WHERE session_id=? AND student_id=?', [created.id, student.id]);
  assert.equal(settled.status, 'COMPLETED', 'real success before end completes the student');
  await run(['--input-type=module', '-e', `const {recordAiUsage}=await import('./apps/server/src/services/creditUsage.js'); recordAiUsage(${JSON.stringify({ orgId: student.org_id, userId: student.id, sessionId: created.id, modality: 'text', model: 'real-late', status: 'SUCCESS' })});`]);
  assert.deepEqual(await arow('SELECT * FROM session_students WHERE session_id=? AND student_id=?', [created.id, student.id]), settled);
  const lateSession = check(await api('org/sessions', teacher, 'POST', { lessonId: first.id }));
  const lateRoute = `org/sessions/${lateSession.id}`;
  check(await api(`${lateRoute}/students`, teacher, 'POST', { studentIds: [student.id] }));
  check(await api(`${lateRoute}/start`, teacher, 'POST', {}));
  check(await api(`${lateRoute}/end`, teacher, 'POST', {}));
  const frozen = await arow('SELECT * FROM session_students WHERE session_id=? AND student_id=?', [lateSession.id, student.id]);
  assert.equal(frozen.status, 'INCOMPLETE');
  await run(['--input-type=module', '-e', `const {recordAiUsage}=await import('./apps/server/src/services/creditUsage.js'); const {settleSessionStudents}=await import('./apps/server/src/services/classroomSessions.js'); recordAiUsage(${JSON.stringify({ orgId: student.org_id, userId: student.id, sessionId: lateSession.id, modality: 'text', model: 'real-late', status: 'SUCCESS' })}); settleSessionStudents({sessionId:${JSON.stringify(lateSession.id)}});`]);
  assert.deepEqual(await arow('SELECT * FROM session_students WHERE session_id=? AND student_id=?', [lateSession.id, student.id]), frozen);
  assert.equal((await arow("SELECT COUNT(*) n FROM usage_records WHERE class_session_id=? AND status='SUCCESS'", [lateSession.id])).n, 1, 'late success remains in ledger');
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
  const events = (await arows("SELECT action FROM audit_logs WHERE target_id=? AND target_type='CLASS_SESSION'", [created.id])).map((item) => item.action);
  for (const action of ['SESSION_CREATE','SESSION_UPDATE','SESSION_STUDENTS_ADD','SESSION_START','SESSION_END']) assert.ok(events.includes(action), action);
  console.log('PASS classroom detail isolated HTTP: title-only preservation, swap confirmation/history/rejoin, environment validation, terminal read-only, ownership isolation, runtime and audit');
} catch (error) {
  console.error(logs.slice(-2500));
  throw error;
} finally {
  const stopped = once(server, 'exit');
  server.kill();
  await stopped;
  
  // 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
// 数据层还握着这个临时库 —— Windows 上打开的文件删不掉，先关掉再删
await closeDb();
fs.rmSync(temp, { recursive: true, force: true });
}
