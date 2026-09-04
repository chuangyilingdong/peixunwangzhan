import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-s03-'));
const dataDir = path.join(tempRoot, 'data');
const dbPath = path.join(dataDir, 'platform.db');
fs.mkdirSync(dataDir, { recursive: true });
const port = '18881';
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: dataDir, PLATFORM_DB_PATH: dbPath, PORT: port, AUTH_PEPPER: 'p8-s03-temporary-only', AI_PROVIDER: 'local-mock' };
let server;
let setupDb;
let pass = 0;
let fail = 0;
function check(name, condition, details = '') {
  if (condition) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.error(`FAIL ${name}${details ? `: ${details}` : ''}`); }
}
async function request(pathname, options = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  } catch (error) { return { status: 0, body: String(error) }; }
}
async function call(method, pathname, body, token) {
  return request(`/api${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function ok(result) { return result.status >= 200 && result.status < 300 && result.body?.success === true; }
async function login(loginName, password, clientType = 'web') {
  const result = await call('POST', '/auth/login', { login: loginName, password, clientType });
  check(`${loginName} login`, ok(result), JSON.stringify(result));
  return result.body?.data?.token;
}
async function waitForHealth() {
  for (let i = 0; i < 50; i += 1) {
    const result = await request('/health');
    if (result.status === 200) return true;
    await delay(100);
  }
  return false;
}
try {
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  process.env.PLATFORM_DATA_DIR = dataDir;
  process.env.AUTH_PEPPER = 'p8-s03-temporary-only';
  process.env.PLATFORM_DB_PATH = dbPath;
  const schema = await import('./packages/database/src/schema.js');
  const serverLib = await import('./apps/server/src/lib.js');
  setupDb = schema.db;
  const now = new Date().toISOString();
  const org1 = setupDb.prepare("SELECT id FROM organizations ORDER BY id LIMIT 1").get().id;
  const org2 = 'org_p8_s03_isolated';
  setupDb.prepare(`INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,contact,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(org2, 'P8-S03 隔离机构', 'ACTIVE', now, new Date(Date.now() + 86400000 * 365).toISOString(), 0, 3, 0, '{}', now, now);
  const org2Teacher = 'user_p8_s03_teacher';
  const org2Student = 'user_p8_s03_student';
  setupDb.prepare(`INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,student_usage_scope,monthly_credit_allowance,monthly_bonus_credits,magic_stones,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(org2Teacher, org2, 'p8-s03-teacher', '隔离机构教师', 'TEACHER', '["MANAGE_CLASSES"]', serverLib.hashPassword('isolated123'), 'ACTIVE', 'HOME_PRACTICE', 100, 0, 0, now, now);
  setupDb.prepare(`INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,student_usage_scope,monthly_credit_allowance,monthly_bonus_credits,magic_stones,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(org2Student, org2, 'p8-s03-student', '隔离机构学生', 'STUDENT', '[]', serverLib.hashPassword('isolated123'), 'ACTIVE', 'HOME_PRACTICE', 100, 0, 0, now, now);
  check('second tenant fixture created in temporary DB', setupDb.prepare('SELECT COUNT(*) AS n FROM organizations WHERE id=?').get(org2).n === 1);
  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env, stdio: 'ignore' });
  check('temporary API ready', await waitForHealth());

  const teacherToken = await login('teacher-1', 'teach123', 'org');
  const org2TeacherToken = await login('p8-s03-teacher', 'isolated123', 'org');
  const studentToken = await login('student-1', 'study123', 'student');
  const org2StudentToken = await login('p8-s03-student', 'isolated123', 'student');
  const org1Classes = await call('GET', '/org/classes', undefined, teacherToken);
  check('tenant one sees its own classes', ok(org1Classes) && org1Classes.body.data.items.length > 0);
  const org2Classes = await call('GET', '/org/classes', undefined, org2TeacherToken);
  check('tenant two sees only its own empty class list', ok(org2Classes) && org2Classes.body.data.items.length === 0);
  const classId = org1Classes.body.data.items[0].id;
  const series = await call('GET', '/org/course-series', undefined, teacherToken);
  const lessonId = series.body.data.items[0].lessons[0].lessonId || series.body.data.items[0].lessons[0].id;
  const started = await call('POST', `/org/classes/${classId}/sessions/start`, { lessonId, sessionCreditCap: 10, capabilities: { allowImage: true } }, teacherToken);
  check('tenant one starts its own session', ok(started));
  const sessionId = started.body?.data?.id;
  const crossEnd = await call('POST', `/org/classes/${classId}/sessions/${sessionId}/end`, { reason: 'CROSS_TENANT' }, org2TeacherToken);
  check('tenant two cannot mutate tenant one session', crossEnd.status === 404);
  const project = await call('POST', '/student/projects', { courseLessonId: lessonId, title: '机构一隔离作品', canvasSnapshot: { nodes: [{ id: 'n1', type: 'prompt', position: { x: 0, y: 0 }, data: {} }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }, studentToken);
  check('tenant one student creates project', ok(project));
  const projectId = project.body?.data?.id;
  const crossProject = await call('GET', `/student/projects/${projectId}`, undefined, org2StudentToken);
  check('tenant two student cannot read tenant one project', crossProject.status === 404);
  const crossWork = await call('GET', `/student/works/nonexistent-tenant-one-work`, undefined, org2StudentToken);
  check('tenant two student cannot read unknown work', crossWork.status === 404);
  const org2Showcase = await call('GET', '/student/showcase', undefined, org2StudentToken);
  check('tenant two showcase excludes tenant one data', ok(org2Showcase) && org2Showcase.body.data.items.every((item) => item.orgId === undefined || item.orgId === org2));
  const org2Account = await call('GET', '/student/account', undefined, org2StudentToken);
  check('tenant two student sees own account only', ok(org2Account) && org2Account.body.data.user.orgId === org2);
  const tenantOneAccountFromOrg2 = await call('GET', `/student/account/${studentToken}`, undefined, org2StudentToken);
  check('tenant two cannot use another token as account path', tenantOneAccountFromOrg2.status === 404);
  const rootToken = await login('root', 'admin123', 'admin');
  const adminUsers = await call('GET', '/admin/platform-users', undefined, rootToken);
  check('platform admin can audit both tenants by design', ok(adminUsers) && adminUsers.body.data.items.some((item) => item.orgId === org2));
  const ended = await call('POST', `/org/classes/${classId}/sessions/${sessionId}/end`, { reason: 'P8_S03_COMPLETE' }, teacherToken);
  check('tenant one can end its own session', ok(ended));
  check('database path is temporary and isolated', dbPath.startsWith(tempRoot) && path.resolve(dbPath) !== path.resolve(repo, 'packages/data/platform.db'));
  console.log(JSON.stringify({ pass, fail, database: dbPath, tenantOne: org1, tenantTwo: org2, port }, null, 2));
  if (fail > 0) process.exitCode = 1;
} finally {
  if (server && !server.killed) { server.kill('SIGTERM'); await delay(200); if (!server.killed) server.kill('SIGKILL'); }
  setupDb?.close();
  for (let i = 0; i < 5; i += 1) { try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await delay(100); } }
}

