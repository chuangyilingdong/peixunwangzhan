import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p4-01-state-'));
const dataDir = path.join(root, 'data');
const dbPath = path.join(dataDir, 'platform.db');
fs.mkdirSync(dataDir, { recursive: true });
const port = '18891';
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: dataDir, PLATFORM_DB_PATH: dbPath, PORT: port, AUTH_PEPPER: 'p4-01-temporary-only', AI_PROVIDER: 'local-mock' };
let server; let db; let pass = 0; let fail = 0;
function check(name, condition, details = '') { if (condition) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.error(`FAIL ${name}${details ? `: ${details}` : ''}`); } }
async function request(pathname, options = {}) { try { const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options); const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: response.status, body }; } catch (error) { return { status: 0, body: String(error) }; } }
async function call(method, pathname, body, token) { return request(`/api${pathname}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
function ok(result) { return result.status >= 200 && result.status < 300 && result.body?.success === true; }
async function login(loginName, password) { const result = await call('POST', '/auth/login', { login: loginName, password }); check(`${loginName} login`, ok(result), JSON.stringify(result)); return result.body?.data?.token; }
async function waitHealth() { for (let i = 0; i < 60; i += 1) { if ((await request('/health')).status === 200) return true; await delay(100); } return false; }

try {
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  Object.assign(process.env, env);
  const schema = await import('./packages/database/src/schema.js');
  db = schema.db;
  const states = await import('./apps/server/src/services/domainState.js');
  check('known state recognized', states.isKnownState('user', 'active') && states.isKnownState('work', 'PUBLISHED'));
  check('legal transition recognized', states.canTransition('classSession', 'ACTIVE', 'ENDED'));
  check('illegal transition rejected by pure contract', !states.canTransition('classSession', 'ENDED', 'ACTIVE'));
  check('same state rejected by default', !states.canTransition('user', 'ACTIVE', 'ACTIVE'));
  check('same state opt-in supported', states.assertTransition({ auth: null }, 'user', 'ACTIVE', 'ACTIVE', { allowSameState: true }) === 'ACTIVE');
  check('unknown state rejected', (() => { try { states.assertKnownState('user', 'UNKNOWN'); return false; } catch (e) { return e.code === 'INVALID_USER_STATUS'; } })());

  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env, stdio: 'ignore' });
  check('temporary API ready', await waitHealth());
  const meta = await call('GET', '/meta/domain-states'); check('domain state metadata endpoint', ok(meta) && Array.isArray(meta.body?.data?.organization?.values) && meta.body.data.classSession.transitions.ACTIVE.includes('ENDED'), JSON.stringify(meta));
  const teacher = await login('teacher-1', 'teach123');
  const org = await login('org-admin', 'org123');
  const student = await login('student-1', 'study123');
  const rootToken = await login('root', 'admin123');
  const classes = await call('GET', '/org/classes', undefined, teacher);
  check('seed class available', ok(classes) && classes.body.data.items.length > 0, JSON.stringify(classes));
  const classId = classes.body.data.items[0].id;
  const courses = await call('GET', '/org/course-series', undefined, teacher);
  const lesson = courses.body.data.items[0].lessons[0];
  const lessonId = lesson.lessonId || lesson.id;
  const opened = await call('POST', `/org/classes/${classId}/sessions/start`, { lessonId, sessionCreditCap: 30, capabilities: { allowImage: true } }, teacher);
  check('session starts', ok(opened), JSON.stringify(opened));
  const sessionId = opened.body.data.id;
  const snapshot = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const projectResult = await call('POST', '/student/projects', { courseLessonId: lessonId, classId, title: 'P4-01 状态机项目', canvasSnapshot: snapshot }, student);
  check('project creates in draft', ok(projectResult) && projectResult.body.data.status === 'DRAFT', JSON.stringify(projectResult));
  const projectId = projectResult.body.data.id;
  const generated = await call('POST', '/ai/generations', { projectId, modality: 'IMAGE', title: '状态机素材', prompt: '状态机验收素材' }, student);
  check('generation job reaches succeeded', ok(generated) && generated.body.data.job.status === 'SUCCEEDED', JSON.stringify(generated));
  const submit = await call('POST', `/student/projects/${projectId}/submit`, { description: '状态机验收', canvasSnapshot: snapshot, copyrightConfirmed: true }, student);
  check('draft project submits', ok(submit) && submit.body.data.project.status === 'SUBMITTED', JSON.stringify(submit));
  const repeatSubmit = await call('POST', `/student/projects/${projectId}/submit`, { description: '重复提交', canvasSnapshot: snapshot, copyrightConfirmed: true }, student);
  check('submitted project rejects duplicate submit', repeatSubmit.status === 409 && repeatSubmit.body.error?.code === 'INVALID_PROJECT_TRANSITION', JSON.stringify(repeatSubmit));
  const ended = await call('POST', `/org/classes/${classId}/sessions/${sessionId}/end`, { reason: 'P4-01' }, teacher);
  check('active session ends', ok(ended) && ended.body.data.status === 'ENDED', JSON.stringify(ended));
  const repeatedEnd = await call('POST', `/org/classes/${classId}/sessions/${sessionId}/end`, { reason: 'duplicate' }, teacher);
  check('ended session rejects duplicate end', repeatedEnd.status === 409 && repeatedEnd.body.error?.code === 'INVALID_CLASS_SESSION_TRANSITION', JSON.stringify(repeatedEnd));
  const auditCount = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='DOMAIN_INVALID_TRANSITION' AND target_type='CLASS_SESSION' AND target_id=?").get(sessionId).n;
  check('invalid transition audited', Number(auditCount) >= 1);
  const workId = submit.body.data.work.id;
  const approved = await call('PUT', `/org/works/${workId}/review`, { status: 'APPROVED', teacherComment: '状态机验收通过' }, org);
  check('work approves', ok(approved) && approved.body.data.status === 'APPROVED', JSON.stringify(approved));
  const reviewed = await call('PUT', `/org/works/${workId}/review`, { status: 'PUBLISHED', teacherComment: '状态机验收发布' }, org);
  check('work publishes', ok(reviewed) && reviewed.body.data.status === 'PUBLISHED', JSON.stringify(reviewed));
  const unpublished = await call('PUT', `/admin/works/${workId}/unpublish`, { reason: '状态机验收下架' }, rootToken);
  check('published work unpublishes', ok(unpublished) && unpublished.body.data.status === 'REJECTED', JSON.stringify(unpublished));
  const repeatUnpublish = await call('PUT', `/admin/works/${workId}/unpublish`, { reason: '重复下架' }, rootToken);
  check('rejected work rejects duplicate unpublish', repeatUnpublish.status === 409 && repeatUnpublish.body.error?.code === 'INVALID_WORK_TRANSITION', JSON.stringify(repeatUnpublish));
  const classArchive = await call('DELETE', `/org/classes/${classId}`, undefined, org);
  check('class archives', ok(classArchive) && classArchive.body.data.ok === true, JSON.stringify(classArchive));
  const repeatArchive = await call('DELETE', `/org/classes/${classId}`, undefined, org);
  check('archived class rejects duplicate archive', repeatArchive.status === 409 && repeatArchive.body.error?.code === 'INVALID_CLASS_TRANSITION', JSON.stringify(repeatArchive));
  check('temporary database isolated', path.resolve(dbPath) !== path.resolve(repo, 'packages/data/platform.db') && dbPath.startsWith(root));
  console.log(JSON.stringify({ pass, fail, dbPath, port }, null, 2));
  if (fail) process.exitCode = 1;
} finally {
  if (server && !server.killed) { server.kill('SIGTERM'); await delay(200); if (!server.killed) server.kill('SIGKILL'); }
  db?.close();
  for (let i = 0; i < 5; i += 1) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await delay(100); } }
}
