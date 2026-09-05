import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p4-c01-'));
const dataDir = path.join(tempRoot, 'data');
const dbPath = path.join(dataDir, 'platform.db');
fs.mkdirSync(dataDir, { recursive: true });
const port = '18882';
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: dataDir, PLATFORM_DB_PATH: dbPath, PORT: port, AUTH_PEPPER: 'p4-c01-temporary-only', AI_PROVIDER: 'local-mock' };
let server; let setupDb; let serverLib; let now; let pass = 0; let fail = 0;
function check(name, condition, details = '') { if (condition) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.error(`FAIL ${name}${details ? `: ${details}` : ''}`); } }
async function request(pathname, options = {}) { try { const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options); const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: response.status, body }; } catch (error) { return { status: 0, body: String(error) }; } }
async function call(method, pathname, body, token) { return request(`/api${pathname}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
function ok(result) { return result.status >= 200 && result.status < 300 && result.body?.success === true; }
async function login(loginName, password, clientType = 'web') { const result = await call('POST', '/auth/login', { login: loginName, password, clientType }); check(`${loginName} login`, ok(result), JSON.stringify(result)); return result.body?.data?.token; }
async function waitForHealth() { for (let i = 0; i < 50; i += 1) { const result = await request('/health'); if (result.status === 200) return true; await delay(100); } return false; }
function insertUser({ id, orgId, login, displayName, role, permissions = [] }) {
  setupDb.prepare(`INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,student_usage_scope,monthly_credit_allowance,monthly_bonus_credits,magic_stones,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, orgId, login, displayName, role, JSON.stringify(permissions), serverLib.hashPassword('p4c01-pass'), 'ACTIVE', role === 'STUDENT' ? 'HOME_PRACTICE' : null, 100, 0, 0, now, now);
}
try {
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  Object.assign(process.env, { DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: dataDir, PLATFORM_DB_PATH: dbPath, AUTH_PEPPER: 'p4-c01-temporary-only', AI_PROVIDER: 'local-mock' });
  const schema = await import('./packages/database/src/schema.js');
  serverLib = await import('./apps/server/src/lib.js');
  setupDb = schema.db;
  now = new Date().toISOString();
  const org1 = setupDb.prepare('SELECT id FROM organizations ORDER BY created_at LIMIT 1').get().id;
  const class1 = setupDb.prepare("SELECT id FROM classes WHERE org_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1").get(org1).id;
  const lesson1 = setupDb.prepare("SELECT id FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1").get().id;
  const student1Id = setupDb.prepare("SELECT id FROM users WHERE login='student-1'").get().id;
  const org2 = 'org_p4_c01_isolated';
  setupDb.prepare(`INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,contact,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(org2, 'P4-C01 隔离机构', 'ACTIVE', now, new Date(Date.now() + 86400000 * 365).toISOString(), 0, 3, 0, '{}', now, now);
  insertUser({ id: 'user_p4_c01_teacher2', orgId: org1, login: 'p4-c01-teacher2', displayName: '未授权教师', role: 'TEACHER', permissions: ['MANAGE_CLASSES'] });
  insertUser({ id: 'user_p4_c01_teacher2org', orgId: org2, login: 'p4-c01-teacher2org', displayName: '机构二教师', role: 'TEACHER', permissions: [] });
  insertUser({ id: 'user_p4_c01_student2org', orgId: org2, login: 'p4-c01-student2org', displayName: '机构二学生', role: 'STUDENT' });
  const fileId = 'file_p4_c01_role_scope';
  const grantId = 'grant_p4_c01_role_scope';
  setupDb.prepare(`INSERT INTO file_assets(id,owner_type,storage_kind,storage_url,file_name,category,visibility,status,review_status,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(fileId, 'PLATFORM', 'EXTERNAL_URL', 'https://example.invalid/p4-c01.txt', 'P4-C01 机构一资料.txt', 'GENERAL', 'PRIVATE', 'ACTIVE', 'NOT_REQUIRED', '{}', now, now);
  setupDb.prepare(`INSERT INTO file_access_grants(id,file_id,grant_type,org_id,role,permission,created_at) VALUES (?,?,?,?,?,?,?)`).run(grantId, fileId, 'ROLE', org1, 'STUDENT', 'READ', now);
  check('fixtures use temporary SQLite and include two institutions', dbPath.startsWith(tempRoot) && org1 !== org2 && setupDb.prepare('SELECT COUNT(*) n FROM organizations').get().n >= 2);
  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env, stdio: 'ignore' });
  check('temporary API ready', await waitForHealth());

  const root = await login('root', 'admin123', 'admin');
  const student1 = await login('student-1', 'study123', 'student');
  const teacher1 = await login('teacher-1', 'teach123', 'org');
  const teacher2 = await login('p4-c01-teacher2', 'p4c01-pass', 'org');
  const teacher2org = await login('p4-c01-teacher2org', 'p4c01-pass', 'org');
  const student2org = await login('p4-c01-student2org', 'p4c01-pass', 'student');

  check('unauthenticated protected route returns 401', (await call('GET', '/org/classes')).status === 401);
  check('student cannot enter organization management route', (await call('GET', '/org/classes', undefined, student1)).status === 403);
  check('organization teacher cannot enter platform admin route', (await call('GET', '/admin/audit-logs', undefined, teacher1)).status === 403);
  const teacherDutyClass = await call('POST', '/org/classes', { name: '教师职责班级' }, teacher2org);
  check('organization teacher can create class without extra permission', teacherDutyClass.status === 200 && teacherDutyClass.body?.data?.teacherId === 'user_p4_c01_teacher2org');
  check('unassigned same-org teacher cannot read another teacher class', (await call('GET', `/org/classes/${class1}`, undefined, teacher2)).status === 404);
  check('cross-org teacher cannot read tenant one class', (await call('GET', `/org/classes/${class1}`, undefined, teacher2org)).status === 404);

  const ownClasses = await call('GET', '/org/classes', undefined, teacher1);
  check('assigned teacher sees own class', ok(ownClasses) && ownClasses.body.data.items.some((item) => item.id === class1));
  const crossSession = await call('GET', `/org/classes/${class1}/sessions`, undefined, teacher2org);
  check('cross-org teacher cannot read tenant one sessions', crossSession.status === 404);

  const ownFile = await call('GET', `/org/file-assets/${fileId}`, undefined, student1);
  check('same-org role grant permits file read', ok(ownFile) && ownFile.body.data.id === fileId);
  const crossFile = await call('GET', `/org/file-assets/${fileId}`, undefined, student2org);
  check('role grant cannot cross institution boundary', crossFile.status === 403 && crossFile.body?.error?.code === 'FILE_ACCESS_DENIED');
  const crossDownload = await call('GET', `/org/file-assets/${fileId}/download`, undefined, student2org);
  check('role grant cannot cross institution download boundary', crossDownload.status === 403);
  const missingOrgGrant = await call('POST', `/admin/file-assets/${fileId}/grants`, { grantType: 'ROLE', role: 'STUDENT', permission: 'READ' }, root);
  check('new role grant must declare institution scope', missingOrgGrant.status === 400 && missingOrgGrant.body?.error?.code === 'ORG_REQUIRED');
  const mismatchUserGrant = await call('POST', `/admin/file-assets/${fileId}/grants`, { grantType: 'USER', userId: student1Id, orgId: org2, permission: 'READ' }, root);
  check('user grant rejects institution mismatch', mismatchUserGrant.status === 400 && mismatchUserGrant.body?.error?.code === 'USER_ORG_MISMATCH');

  const opened = await call('POST', `/org/classes/${class1}/sessions/start`, { lessonId: lesson1, sessionCreditCap: 10, capabilities: { allowImage: true } }, teacher1);
  check('assigned teacher can open scoped class session', ok(opened), JSON.stringify(opened));
  const project = await call('POST', '/student/projects', { courseLessonId: lesson1, classId: class1, title: 'P4-C01 隔离项目', canvasSnapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }, student1);
  check('student creates own project', ok(project), JSON.stringify(project));
  const projectId = project.body?.data?.id;
  check('cross-org student cannot read own-id path for tenant one project', (await call('GET', `/student/projects/${projectId}`, undefined, student2org)).status === 404);
  const aiHistory = await call('GET', `/ai/generations?projectId=${encodeURIComponent(projectId)}`, undefined, student2org);
  check('cross-org student cannot query AI history for tenant one project', aiHistory.status === 400 || aiHistory.status === 404);
  check('platform admin remains explicitly allowed to audit both institutions', ok(await call('GET', '/admin/audit-logs', undefined, root)));
  check('database path remains outside repository default database', path.resolve(dbPath) !== path.resolve(repo, 'packages/data/platform.db'));
  console.log(JSON.stringify({ pass, fail, database: dbPath, org1, org2, port }, null, 2));
  if (fail > 0) process.exitCode = 1;
} finally {
  if (server && !server.killed) { server.kill('SIGTERM'); await delay(200); if (!server.killed) server.kill('SIGKILL'); }
  setupDb?.close();
  for (let i = 0; i < 5; i += 1) { try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await delay(100); } }
}

