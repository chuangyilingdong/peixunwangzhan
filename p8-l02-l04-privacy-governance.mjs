import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-l02-l04-'));
const tempData = path.join(tempRoot, 'data');
const tempDb = path.join(tempData, 'platform.db');
fs.mkdirSync(tempData, { recursive: true });
const port = '18882';
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: tempData, PLATFORM_DB_PATH: tempDb, PORT: port, AUTH_PEPPER: 'p8-l02-l04-temporary-only', AI_PROVIDER: 'local-mock' };
let server; let pass = 0; let fail = 0;
function check(name, condition, details = '') { if (condition) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.error(`FAIL ${name}${details ? `: ${details}` : ''}`); } }
async function request(pathname, options = {}) { try { const r = await fetch(`http://127.0.0.1:${port}${pathname}`, options); const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = t; } return { status: r.status, body }; } catch (e) { return { status: 0, body: String(e) }; } }
async function call(method, pathname, body, token) { return request(`/api${pathname}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
const ok = (r) => r.status >= 200 && r.status < 300 && r.body?.success === true;
async function login(name, password, clientType) { const r = await call('POST', '/auth/login', { login: name, password, clientType }); check(`${name} login`, ok(r), JSON.stringify(r)); return r.body?.data?.token; }
async function health() { for (let i=0; i<50; i++) { const r=await request('/health'); if (r.status===200 && r.body?.data?.status==='ok') return true; await delay(100); } return false; }
try {
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  check('temporary SQLite initialized', fs.existsSync(tempDb) && tempDb.startsWith(tempRoot));
  check('default database not selected', path.resolve(tempDb) !== path.resolve(repo, 'packages/data/platform.db'));
  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env, stdio: 'ignore' });
  check('API health ready', await health());
  const orgToken = await login('org-admin', 'org123', 'org');
  const studentToken = await login('student-1', 'study123', 'student');
  const student2Token = await login('student-2', 'study123', 'student');
  const teacherToken = await login('teacher-1', 'teach123', 'org');

  const account = await call('GET', '/student/account', undefined, studentToken);
  check('student account exposes governance sections', ok(account) && account.body.data.legalConsents && account.body.data.requests && account.body.data.profileOptions);
  const badGuardian = await call('PUT', '/student/account/guardian', { currentPassword: 'study123', guardian: { name: '监护人', phone: '13800138000', relationship: 'PARENT', consent: false } }, studentToken);
  check('guardian consent is required', badGuardian.status === 400 && badGuardian.body?.error?.code === 'GUARDIAN_CONSENT_REQUIRED');
  const guardian = await call('PUT', '/student/account/guardian', { currentPassword: 'study123', guardian: { name: '测试监护人', phone: '13800138000', relationship: 'PARENT', consent: true } }, studentToken);
  check('guardian record can be saved with consent', ok(guardian) && guardian.body.data.user.guardian?.name === '测试监护人');
  const clearGuardian = await call('PUT', '/student/account/guardian', { currentPassword: 'study123', guardian: null }, studentToken);
  check('guardian record can be withdrawn', ok(clearGuardian) && clearGuardian.body.data.user.guardian === null);

  const badConsent = await call('POST', '/student/account/legal-consents', { currentPassword: 'study123', version: 'wrong', confirmed: true, types: ['TERMS', 'PRIVACY', 'MINORS'] }, studentToken);
  check('stale legal version rejected', badConsent.status === 400 && badConsent.body?.error?.code === 'LEGAL_VERSION_MISMATCH');
  const consent = await call('POST', '/student/account/legal-consents', { currentPassword: 'study123', version: '2026.09.03', confirmed: true, types: ['TERMS', 'PRIVACY', 'MINORS'] }, studentToken);
  check('current legal consent recorded', ok(consent) && ['TERMS','PRIVACY','MINORS'].every((t) => consent.body.data.legalConsents.current[t]?.version === '2026.09.03'));
  const privacy = await call('PUT', '/student/account/privacy', { currentPassword: 'study123', showcaseAnonymous: true, allowFeature: false }, studentToken);
  check('privacy choices can be changed', ok(privacy) && privacy.body.data.user.privacy?.showcaseAnonymous === true && privacy.body.data.user.privacy?.allowFeature === false);

  const exportRequest = await call('POST', '/student/account/requests', { currentPassword: 'study123', type: 'DATA_EXPORT', confirmed: true, reason: '测试数据访问请求' }, studentToken);
  const exportId = exportRequest.body?.data?.request?.id;
  check('data export request can be created', ok(exportRequest) && exportRequest.body.data.request.status === 'PENDING' && typeof exportId === 'string');
  const duplicateExport = await call('POST', '/student/account/requests', { currentPassword: 'study123', type: 'DATA_EXPORT', confirmed: true }, studentToken);
  check('duplicate pending export rejected', duplicateExport.status === 409 && duplicateExport.body?.error?.code === 'ACCOUNT_REQUEST_ALREADY_PENDING');
  const orgRequests = await call('GET', '/org/account-requests?status=PENDING', undefined, orgToken);
  check('org admin sees pending privacy requests', ok(orgRequests) && orgRequests.body.data.items.some((x) => x.id === exportId && x.type === 'DATA_EXPORT'));
  const exportApproval = await call('PUT', `/org/account-requests/${exportId}`, { status: 'APPROVED', resolution: '已完成测试数据导出审批' }, orgToken);
  check('org admin can approve data export', ok(exportApproval) && exportApproval.body.data.status === 'APPROVED' && exportApproval.body.data.exportPayload);
  const exportDetail = await call('GET', `/student/account/requests/${exportId}`, undefined, studentToken);
  check('student can inspect approved export', ok(exportDetail) && exportDetail.body.data.status === 'APPROVED' && exportDetail.body.data.exportPayload);

  const classes = await call('GET', '/org/classes', undefined, teacherToken);
  const classId = classes.body?.data?.items?.[0]?.id;
  const series = await call('GET', '/org/course-series', undefined, teacherToken);
  const lesson = series.body?.data?.items?.[0]?.lessons?.[0];
  const lessonId = lesson?.lessonId || lesson?.id;
  const started = await call('POST', `/org/classes/${classId}/sessions/start`, { lessonId, sessionCreditCap: 20, capabilities: { allowImage: true, allowMusic: true, allowVideo: true } }, teacherToken);
  check('governance test class session started', ok(started) && typeof started.body.data.id === 'string');
  const reportProject = await call('POST', '/student/projects', { courseLessonId: lessonId, title: 'P8-L04 举报流程测试作品', canvasSnapshot: { nodes: [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { text: '举报流程测试' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }, student2Token);
  const reportProjectId = reportProject.body?.data?.id;
  const reportSubmit = await call('POST', `/student/projects/${reportProjectId}/submit`, { description: 'P8-L04 举报流程测试', canvasSnapshot: reportProject.body?.data?.canvasSnapshot, copyrightConfirmed: true }, student2Token);
  const reportWorkId = reportSubmit.body?.data?.work?.id;
  await call('PUT', `/org/works/${reportWorkId}/review`, { status: 'APPROVED', teacherComment: '治理测试通过' }, teacherToken);
  const reportPublished = await call('PUT', `/org/works/${reportWorkId}/review`, { status: 'PUBLISHED', teacherComment: '治理测试发布' }, teacherToken);
  check('governance test work published', ok(reportPublished) && reportPublished.body.data.status === 'PUBLISHED');
  const showcase = await call('GET', '/student/showcase', undefined, student2Token);
  const work = showcase.body?.data?.items?.find((item) => item.id === reportWorkId);
  check('published work is available for reporting', ok(showcase) && typeof work?.id === 'string');
  if (work?.id) {
    const report = await call('POST', `/student/showcase/${work.id}/reports`, { category: 'PRIVACY', details: 'P8-L04 隔离测试举报' }, studentToken);
    const reportId = report.body?.data?.id;
    check('student can report published work', ok(report) && report.body.data.status === 'PENDING' && typeof reportId === 'string');
    const duplicateReport = await call('POST', `/student/showcase/${work.id}/reports`, { category: 'PRIVACY', details: '重复举报' }, studentToken);
    check('duplicate pending report rejected', duplicateReport.status === 409 && duplicateReport.body?.error?.code === 'WORK_REPORT_ALREADY_PENDING');
    const reports = await call('GET', '/org/work-reports?status=PENDING', undefined, orgToken);
    check('org admin sees pending report', ok(reports) && reports.body.data.items.some((x) => x.id === reportId));
    const handled = await call('PUT', `/org/work-reports/${reportId}`, { status: 'RESOLVED', actionTaken: 'UNPUBLISH', resolution: '已确认并下架处理' }, orgToken);
    check('org admin can resolve and unpublish report', ok(handled) && handled.body.data.status === 'RESOLVED' && handled.body.data.actionTaken === 'UNPUBLISH');
    const afterUnpublish = await call('GET', `/student/showcase/${work.id}`, undefined, student2Token);
    check('reported work is no longer publicly visible after unpublish', afterUnpublish.status === 404);
  }

  const deletionRequest = await call('POST', '/student/account/requests', { currentPassword: 'study123', type: 'DELETION', confirmed: true, reason: '测试注销流程' }, studentToken);
  const deletionId = deletionRequest.body?.data?.request?.id;
  check('account deletion request can be created', ok(deletionRequest) && deletionRequest.body.data.request.status === 'PENDING' && typeof deletionId === 'string');
  const deletionApproval = await call('PUT', `/org/account-requests/${deletionId}`, { status: 'APPROVED', resolution: '已完成测试注销审批' }, orgToken);
  check('org admin can approve account deletion', ok(deletionApproval) && deletionApproval.body.data.status === 'APPROVED');
  const oldSession = await call('GET', '/student/account', undefined, studentToken);
  check('deleted account session is rejected', oldSession.status === 401);
  const relogin = await call('POST', '/auth/login', { login: 'student-1', password: 'study123', clientType: 'student' });
  check('deleted account cannot log in again', relogin.status === 401);

  check('temporary DB remains isolated', tempDb.startsWith(tempRoot));
  console.log(JSON.stringify({ pass, fail, database: tempDb, port }, null, 2));
  if (fail) process.exitCode = 1;
} finally { if (server) { server.kill('SIGTERM'); await delay(100); } }



