import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-q03-'));
const tempData = path.join(tempRoot, 'data');
const tempDb = path.join(tempData, 'platform.db');
fs.mkdirSync(tempData, { recursive: true });
const port = '18879';
const env = {
  ...process.env,
  DEPLOYMENT_MODE: 'internal-test',
  PLATFORM_DATA_DIR: tempData,
  PLATFORM_DB_PATH: tempDb,
  PORT: port,
  AUTH_PEPPER: 'p8-q03-temporary-only',
  AI_PROVIDER: 'local-mock',
};
let server;
let pass = 0;
let fail = 0;
function check(name, condition, details = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL ${name}${details ? `: ${details}` : ''}`);
  }
}
async function request(pathname, options = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: String(error) };
  }
}
async function call(method, pathname, body, token) {
  return request(`/api${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function isSuccess(result) { return result.status >= 200 && result.status < 300 && result.body?.success === true; }
async function login(loginName, password, clientType) {
  const result = await call('POST', '/auth/login', { login: loginName, password, clientType });
  check(`${loginName} login`, isSuccess(result), JSON.stringify(result));
  check(`${loginName} token returned`, typeof result.body?.data?.token === 'string');
  return result.body?.data?.token;
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await request('/health');
    if (result.status === 200 && result.body?.data?.status === 'ok') return true;
    await delay(100);
  }
  return false;
}
try {
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  check('database initialized in temporary SQLite', fs.existsSync(tempDb) && tempDb.startsWith(tempRoot));
  check('default database was not selected', path.resolve(tempDb) !== path.resolve(repo, 'packages/data/platform.db'));

  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env, stdio: 'ignore' });
  check('API health ready', await waitForHealth());

  const unauthAdmin = await call('GET', '/admin/dashboard/overview');
  check('unauthenticated admin rejected', unauthAdmin.status === 401);
  const badLogin = await call('POST', '/auth/login', { login: 'student-1', password: 'wrong-password' });
  check('invalid password rejected', badLogin.status === 401);
  const missingRoute = await call('GET', '/does-not-exist');
  check('unknown API route returns 404', missingRoute.status === 404);

  const p3Env = { ...env, P3_API_BASE: "http://127.0.0.1:" + port + "/api" };
  execFileSync(process.execPath, ["p3-api-integration.mjs"], { cwd: repo, env: p3Env, stdio: "inherit" });
  check("existing P3 API integration regression included", true);

  const rootToken = await login('root', 'admin123', 'admin');
  const orgToken = await login('org-admin', 'org123', 'org');
  const teacherToken = await login('teacher-1', 'teach123', 'org');
  const studentToken = await login('student-1', 'study123', 'student');
  const student2Token = await login('student-2', 'study123', 'student');

  const adminOverview = await call('GET', '/admin/dashboard/overview', undefined, rootToken);
  check('super admin dashboard succeeds', isSuccess(adminOverview));
  const studentAdmin = await call('GET', '/admin/dashboard/overview', undefined, studentToken);
  check('student cannot access admin API', studentAdmin.status === 403);
  const teacherAdmin = await call('GET', '/admin/dashboard/overview', undefined, teacherToken);
  check('teacher cannot access admin API', teacherAdmin.status === 403);
  const orgAdminBilling = await call('GET', '/org/billing/reconciliation', undefined, orgToken);
  check('org admin billing succeeds', isSuccess(orgAdminBilling));
  const teacherBilling = await call('GET', '/org/billing/reconciliation', undefined, teacherToken);
  check('teacher cannot access reconciliation', teacherBilling.status === 403);
  const studentOrg = await call('GET', '/org/classes', undefined, studentToken);
  check('student cannot access org API', studentOrg.status === 403);
  const studentAccount = await call('GET', '/student/account', undefined, studentToken);
  check('student account succeeds', isSuccess(studentAccount));

  const legal = await call('GET', '/public/legal');
  check('public legal endpoint succeeds', isSuccess(legal));
  const marketplace = await call('GET', '/public/marketplace');
  check('public marketplace endpoint succeeds', isSuccess(marketplace) && Array.isArray(marketplace.body?.data?.items));
  const invalidLimit = await call('GET', '/public/marketplace?limit=9999');
  check('public marketplace invalid limit rejected', invalidLimit.status === 400);

  const classes = await call('GET', '/org/classes', undefined, teacherToken);
  check('teacher classes endpoint succeeds', isSuccess(classes) && classes.body.data.items.length > 0);
  const classId = classes.body?.data?.items?.[0]?.id;
  const courseSeries = await call('GET', '/org/course-series', undefined, teacherToken);
  check('teacher course series endpoint succeeds', isSuccess(courseSeries));
  const lesson = courseSeries.body?.data?.items?.[0]?.lessons?.[0];
  const lessonId = lesson?.lessonId || lesson?.id;
  check('seeded lesson available', typeof lessonId === 'string');
  const started = await call('POST', `/org/classes/${classId}/sessions/start`, {
    lessonId,
    sessionCreditCap: 20,
    capabilities: { allowImage: true, allowMusic: true, allowVideo: true },
  }, teacherToken);
  check('teacher can start class session', isSuccess(started));
  const sessionId = started.body?.data?.id;
  check('started session has id', typeof sessionId === 'string');
  const studentDashboard = await call('GET', '/student/dashboard', undefined, studentToken);
  check('student is enabled during active class', isSuccess(studentDashboard) && studentDashboard.body.data.canUseNow === true);

  const snapshot = {
    nodes: [{ id: 'n1', type: 'prompt', position: { x: 0, y: 0 }, data: { title: '提示词', text: '星光森林里的小狐狸' } }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const project = await call('POST', '/student/projects', { courseLessonId: lessonId, title: 'P8-Q03 集成作品', canvasSnapshot: snapshot }, studentToken);
  check('student can create project', isSuccess(project));
  const projectId = project.body?.data?.id;
  check('created project has id', typeof projectId === 'string');
  const emptyUpdate = await call('PUT', `/student/projects/${projectId}`, {}, studentToken);
  check('empty project update rejected', emptyUpdate.status === 400);
  const student2Project = await call('GET', `/student/projects/${projectId}`, undefined, student2Token);
  check('student cannot read another student project', student2Project.status === 404);
  const generation = await call('POST', '/ai/generations', { projectId, modality: 'IMAGE', title: '集成测试封面', prompt: '夜晚的星光森林里，小狐狸举着发光的种子。' }, studentToken);
  check('local mock generation endpoint succeeds', isSuccess(generation) && generation.body.data.job.status === 'SUCCEEDED');
  check('local mock result is explicitly preview data', generation.body?.data?.assets?.[0]?.previewUrl?.startsWith('data:image/svg+xml') === true);
  const generationList = await call('GET', `/ai/generations?projectId=${encodeURIComponent(projectId)}`, undefined, studentToken);
  check('generation history contains created job', isSuccess(generationList) && generationList.body.data.items.some((item) => item.id === generation.body.data.job.id));

  const updated = await call('PUT', `/student/projects/${projectId}`, { canvasSnapshot: { ...snapshot, nodes: [...snapshot.nodes, { id: 'n2', type: 'image', position: { x: 300, y: 0 }, data: { title: '画面' } }] }, label: '第二版' }, studentToken);
  check('student can save project version', isSuccess(updated) && updated.body.data.latestVersion >= 2);
  const submitted = await call('POST', `/student/projects/${projectId}/submit`, { description: 'P8-Q03 集成测试提交', canvasSnapshot: updated.body.data.canvasSnapshot, copyrightConfirmed: true }, studentToken);
  check('student can submit project', isSuccess(submitted) && submitted.body.data.work.status === 'PENDING');
  const workId = submitted.body?.data?.work?.id;
  const otherStudentWork = await call('GET', `/student/works/${workId}`, undefined, student2Token);
  check('student cannot read another student work', otherStudentWork.status === 404);
  const teacherWorks = await call('GET', '/org/works?includeSnapshot=true', undefined, teacherToken);
  check('teacher can list submitted works', isSuccess(teacherWorks) && teacherWorks.body.data.items.some((item) => item.id === workId));
  const invalidReview = await call('PUT', `/org/works/${workId}/review`, { status: 'INVALID_STATUS' }, teacherToken);
  check('invalid work status rejected', invalidReview.status === 400);
  const approved = await call('PUT', `/org/works/${workId}/review`, { status: 'APPROVED', teacherComment: '集成测试通过' }, teacherToken);
  check('teacher can approve work', isSuccess(approved) && approved.body.data.status === 'APPROVED');
  const published = await call('PUT', `/org/works/${workId}/review`, { status: 'PUBLISHED', teacherComment: '集成测试发布' }, teacherToken);
  check('teacher can publish approved work', isSuccess(published) && published.body.data.status === 'PUBLISHED');
  const ownWork = await call('GET', `/student/works/${workId}`, undefined, studentToken);
  check('student can read own published work', isSuccess(ownWork) && ownWork.body.data.status === 'PUBLISHED');
  const showcase = await call('GET', '/student/showcase', undefined, studentToken);
  check('published work appears in showcase', isSuccess(showcase) && showcase.body.data.items.some((item) => item.id === workId));

  const ended = await call('POST', `/org/classes/${classId}/sessions/${sessionId}/end`, { reason: 'P8_Q03_COMPLETE' }, teacherToken);
  check('teacher can end class session', isSuccess(ended) && ended.body.data.status === 'ENDED');
  const afterEnd = await call('GET', '/student/dashboard', undefined, studentToken);
  check('student is blocked after class ends', isSuccess(afterEnd) && afterEnd.body.data.canUseNow === false);

  check('temporary DB path remains isolated', tempDb.startsWith(tempRoot));
  console.log(JSON.stringify({ pass, fail, database: tempDb, port }, null, 2));
  if (fail > 0) process.exitCode = 1;
} finally {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await delay(200);
    if (!server.killed) server.kill('SIGKILL');
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await delay(100); }
  }
}



