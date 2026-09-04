import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-q04-'));
const tempData = path.join(tempRoot, 'data');
const tempDb = path.join(tempData, 'platform.db');
const apiPort = '18880';
const webPort = 18881;
const webDist = path.join(repo, 'apps', 'website', 'dist');
fs.mkdirSync(tempData, { recursive: true });
const env = {
  ...process.env,
  DEPLOYMENT_MODE: 'internal-test',
  PLATFORM_DATA_DIR: tempData,
  PLATFORM_DB_PATH: tempDb,
  PORT: apiPort,
  AUTH_PEPPER: 'p8-q04-temporary-only',
  AI_PROVIDER: 'local-mock',
};
let apiServer;
let webServer;
let pass = 0;
let fail = 0;
let preserveEvidence = false;
const evidence = path.join(tempRoot, 'evidence');
fs.mkdirSync(evidence, { recursive: true });

function check(name, condition, details = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL ${name}${details ? `: ${details}` : ''}`);
  }
}
function isSuccess(result) { return result.status >= 200 && result.status < 300 && result.body?.success === true; }
function parseJson(text) { try { return JSON.parse(text); } catch { return text; } }
function setCookieFrom(response, jar) {
  const setCookie = response.headers.get('set-cookie') || '';
  const match = setCookie.match(/(?:^|,\s*)platform_token=([^;]+)/);
  if (match) jar.platform_token = match[1];
  return setCookie;
}
async function rawRequest(base, pathname, options = {}, jar = null) {
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  if (jar?.platform_token) headers.cookie = `platform_token=${jar.platform_token}`;
  try {
    const response = await fetch(`${base}${pathname}`, { ...options, headers });
    const text = await response.text();
    if (jar) setCookieFrom(response, jar);
    return { status: response.status, body: parseJson(text), headers: response.headers, text };
  } catch (error) {
    return { status: 0, body: String(error), headers: new Headers(), text: String(error) };
  }
}
async function api(pathname, options = {}, jar = null) {
  const body = options.body;
  return rawRequest(`http://127.0.0.1:${apiPort}/api`, pathname, {
    ...options,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, jar);
}
async function login(loginName, password, clientType, jar) {
  const result = await api('/auth/login', { method: 'POST', body: { login: loginName, password, clientType } }, jar);
  check(`${loginName} 浏览器登录`, isSuccess(result), JSON.stringify(result.body));
  check(`${loginName} 获得 HttpOnly 会话 Cookie`, /HttpOnly/i.test(result.headers.get('set-cookie') || ''));
  return result;
}
async function waitFor(base, pathname, predicate) {
  for (let i = 0; i < 60; i += 1) {
    const result = await rawRequest(base, pathname);
    if (predicate(result)) return result;
    await delay(100);
  }
  return null;
}
function startStaticServer() {
  webServer = http.createServer((req, res) => {
    const requested = decodeURIComponent((req.url || '/').split('?')[0]);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const candidate = path.resolve(webDist, relative);
    const fallback = path.join(webDist, 'index.html');
    const file = candidate.startsWith(path.resolve(webDist) + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : fallback;
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-internal-test': 'true' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => webServer.listen(webPort, '127.0.0.1', resolve));
}
try {
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  check('初始化临时 SQLite 数据库', fs.existsSync(tempDb) && tempDb.startsWith(tempRoot));
  check('未选用默认业务数据库', path.resolve(tempDb) !== path.resolve(repo, 'packages/data/platform.db'));

  apiServer = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const apiOut = fs.createWriteStream(path.join(evidence, 'api.stdout.log'));
  const apiErr = fs.createWriteStream(path.join(evidence, 'api.stderr.log'));
  apiServer.stdout.pipe(apiOut); apiServer.stderr.pipe(apiErr);
  const health = await waitFor(`http://127.0.0.1:${apiPort}`, '/health', (r) => r.status === 200 && r.body?.data?.status === 'ok');
  check('API 健康检查通过', Boolean(health));

  execFileSync(process.execPath, ['p3-api-integration.mjs'], { cwd: repo, env: { ...env, P3_API_BASE: `http://127.0.0.1:${apiPort}/api` }, stdio: 'inherit' });
  check('纳入既有 P3 主链路回归', true);

  const publicJar = {};
  const legal = await api('/public/legal', {}, publicJar);
  check('官网访客可读取法律文档元数据', isSuccess(legal) && legal.body.data.status === 'DRAFT_PENDING_LEGAL_CONFIRMATION' && legal.body.data.documents?.length === 3);

  const rootJar = {};
  await login('root', 'admin123', 'admin', rootJar);
  const adminMarketplace = await api('/admin/course-marketplace', {}, rootJar);
  const marketplaceCandidate = adminMarketplace.body?.data?.items?.find((item) => item.status === 'PUBLISHED' && item.marketplaceStatus !== 'APPROVED') || adminMarketplace.body?.data?.items?.find((item) => item.status === 'PUBLISHED');
  if (marketplaceCandidate && marketplaceCandidate.marketplaceStatus !== 'APPROVED') {
    const promote = await api(`/admin/course-marketplace/${marketplaceCandidate.id}`, { method: 'PUT', body: { marketplaceStatus: 'APPROVED', marketplaceRewardCredits: 5 } }, rootJar);
    check('平台超管配置课程上架', isSuccess(promote) && promote.body.data.marketplaceStatus === 'APPROVED');
  } else {
    check('平台超管读取已上架课程', Boolean(marketplaceCandidate));
  }
  const marketplace = await api('/public/marketplace?limit=12', {}, publicJar);
  check('官网访客可浏览课程广场', isSuccess(marketplace) && Array.isArray(marketplace.body.data.items));
  const courseId = marketplace.body?.data?.items?.[0]?.id;
  check('课程广场返回可进入详情的课程', typeof courseId === 'string');
  if (courseId) {
    const detail = await api(`/public/marketplace/${courseId}`, {}, publicJar);
    check('官网访客可打开课程详情', isSuccess(detail) && detail.body.data.id === courseId && Array.isArray(detail.body.data.lessons));
  }
  const invalidPublic = await api('/public/marketplace?limit=9999');
  check('官网访客非法分页参数被拦截', invalidPublic.status === 400);

  const pnpmCli = process.platform === 'win32' ? 'C:\\Users\\Administrator\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\pnpm\\bin\\pnpm.mjs' : 'pnpm';
  const buildEnv = { ...process.env, VITE_DEPLOYMENT_MODE: 'internal-test', VITE_PUBLIC_SITE_URL: 'https://iicili.cyou' };
  if (process.platform === 'win32') buildEnv.PATH = `${path.dirname(process.execPath)};${buildEnv.PATH || ''}`;
  execFileSync(process.platform === 'win32' ? process.execPath : pnpmCli, process.platform === 'win32' ? [pnpmCli, 'build'] : ['build'], { cwd: repo, env: buildEnv, stdio: 'inherit' });
  check('四端前端构建通过', fs.existsSync(path.join(repo, 'apps', 'website', 'dist', 'index.html')));
  await startStaticServer();
  const pages = ['/', '/marketplace', '/marketplace/course-missing', '/courses', '/demo', '/terms', '/privacy', '/minors'];
  for (const page of pages) {
    const pageResult = await rawRequest(`http://127.0.0.1:${webPort}`, page);
    check(`浏览器导航 ${page} 返回 HTML`, pageResult.status === 200 && /<div id="root"><\/div>/.test(pageResult.text));
  }
  const index = await rawRequest(`http://127.0.0.1:${webPort}`, '/');
  check('官网构建产物包含 noindex', /name="robots" content="noindex, nofollow, noarchive"/.test(index.text));
  const assets = [...index.text.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  check('官网入口引用 JS/CSS 构建资产', assets.length >= 2);
  for (const asset of assets) {
    const assetResult = await rawRequest(`http://127.0.0.1:${webPort}`, asset);
    check(`浏览器加载资产 ${asset.split('/').pop()}`, assetResult.status === 200 && assetResult.text.length > 100);
  }

  const orgJar = {};
  await login('org-admin', 'org123', 'org', orgJar);
  const orgMe = await api('/me', {}, orgJar);
  check('机构管理员 Cookie 会话可读取当前用户', isSuccess(orgMe) && orgMe.body.data.role === 'ORG_ADMIN');
  const orgClasses = await api('/org/classes', {}, orgJar);
  check('机构管理员可进入班级工作台', isSuccess(orgClasses) && orgClasses.body.data.items.length > 0);
  const orgBilling = await api('/org/billing/reconciliation', {}, orgJar);
  check('机构管理员可查看积分 / 计费对账', isSuccess(orgBilling));
  const orgForbidden = await api('/admin/dashboard/overview', {}, orgJar);
  check('机构管理员不能进入平台超管页面', orgForbidden.status === 403);

  const teacherJar = {};
  await login('teacher-1', 'teach123', 'org', teacherJar);
  const teacherClasses = await api('/org/classes', {}, teacherJar);
  const classId = teacherClasses.body?.data?.items?.[0]?.id;
  const courseSeries = await api('/org/course-series', {}, teacherJar);
  const lessonId = courseSeries.body?.data?.items?.[0]?.lessons?.[0]?.lessonId || courseSeries.body?.data?.items?.[0]?.lessons?.[0]?.id;
  check('教师浏览到可授课班级和课时', isSuccess(teacherClasses) && typeof classId === 'string' && isSuccess(courseSeries) && typeof lessonId === 'string');
  const started = await api(`/org/classes/${classId}/sessions/start`, { method: 'POST', body: { lessonId, sessionCreditCap: 20, capabilities: { allowImage: true, allowMusic: true, allowVideo: true } } }, teacherJar);
  const sessionId = started.body?.data?.id;
  check('教师开启课堂', isSuccess(started) && typeof sessionId === 'string');

  const studentJar = {};
  await login('student-1', 'study123', 'student', studentJar);
  const studentMe = await api('/me', {}, studentJar);
  check('学生 Cookie 会话可进入学习端', isSuccess(studentMe) && studentMe.body.data.role === 'STUDENT');
  const studentDashboard = await api('/student/dashboard', {}, studentJar);
  check('学生在课堂期间可使用平台', isSuccess(studentDashboard) && studentDashboard.body.data.canUseNow === true);
  const snapshot = { nodes: [{ id: 'n1', type: 'prompt', position: { x: 0, y: 0 }, data: { title: '提示词', text: '星光森林里的小狐狸' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const project = await api('/student/projects', { method: 'POST', body: { courseLessonId: lessonId, title: 'P8-Q04 端到端作品', canvasSnapshot: snapshot } }, studentJar);
  const projectId = project.body?.data?.id;
  check('学生创建项目', isSuccess(project) && typeof projectId === 'string');
  const generated = await api('/ai/generations', { method: 'POST', body: { projectId, modality: 'IMAGE', title: '端到端预览', prompt: '一片有星光的小森林' } }, studentJar);
  check('学生触发 AI 预览能力', isSuccess(generated) && generated.body.data.job.status === 'SUCCEEDED' && generated.body.data.assets[0].previewUrl.startsWith('data:image/svg+xml'));
  const saved = await api(`/student/projects/${projectId}`, { method: 'PUT', body: { canvasSnapshot: { ...snapshot, nodes: [...snapshot.nodes, { id: 'n2', type: 'image', position: { x: 300, y: 0 }, data: { title: '画面' } }] }, label: '端到端第二版' } }, studentJar);
  check('学生保存项目版本', isSuccess(saved) && saved.body.data.latestVersion >= 2);
  const submitted = await api(`/student/projects/${projectId}/submit`, { method: 'POST', body: { description: 'P8-Q04 端到端提交', canvasSnapshot: saved.body.data.canvasSnapshot, copyrightConfirmed: true } }, studentJar);
  const workId = submitted.body?.data?.work?.id;
  check('学生提交作品进入审核队列', isSuccess(submitted) && submitted.body.data.work.status === 'PENDING' && typeof workId === 'string');

  const otherJar = {};
  await login('student-2', 'study123', 'student', otherJar);
  const crossProject = await api(`/student/projects/${projectId}`, {}, otherJar);
  const crossWork = await api(`/student/works/${workId}`, {}, otherJar);
  check('另一名学生不能读取项目和作品', crossProject.status === 404 && crossWork.status === 404);

  const teacherWorks = await api('/org/works?includeSnapshot=true', {}, teacherJar);
  check('教师工作台看到待审核作品', isSuccess(teacherWorks) && teacherWorks.body.data.items.some((item) => item.id === workId));
  const approved = await api(`/org/works/${workId}/review`, { method: 'PUT', body: { status: 'APPROVED', teacherComment: 'E2E 审核通过' } }, teacherJar);
  const published = await api(`/org/works/${workId}/review`, { method: 'PUT', body: { status: 'PUBLISHED', teacherComment: 'E2E 发布' } }, teacherJar);
  check('教师审核并发布作品', isSuccess(approved) && isSuccess(published) && published.body.data.status === 'PUBLISHED');
  const ownWork = await api(`/student/works/${workId}`, {}, studentJar);
  const showcase = await api('/student/showcase', {}, studentJar);
  check('学生可查看已发布作品并在作品墙出现', isSuccess(ownWork) && ownWork.body.data.status === 'PUBLISHED' && isSuccess(showcase) && showcase.body.data.items.some((item) => item.id === workId));

  const studentForbidden = await api('/org/billing/reconciliation', {}, studentJar);
  check('学生不能读取机构计费接口', studentForbidden.status === 403);
  const ended = await api(`/org/classes/${classId}/sessions/${sessionId}/end`, { method: 'POST', body: { reason: 'P8_Q04_COMPLETE' } }, teacherJar);
  check('教师结束课堂', isSuccess(ended) && ended.body.data.status === 'ENDED');
  const afterEnd = await api('/student/dashboard', {}, studentJar);
  check('课堂结束后学生能力被拦截', isSuccess(afterEnd) && afterEnd.body.data.canUseNow === false);
  const logout = await api('/auth/logout', { method: 'POST' }, studentJar);
  const afterLogout = await api('/me', {}, studentJar);
  check('学生注销后旧 Cookie 立即失效', isSuccess(logout) && afterLogout.status === 401);

  check('E2E 证据目录位于临时目录', evidence.startsWith(tempRoot));
  console.log(JSON.stringify({ pass, fail, database: tempDb, evidence, apiPort, webPort }, null, 2));
  if (fail > 0) process.exitCode = 1;
} catch (error) {
  preserveEvidence = true;
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  if (webServer) await new Promise((resolve) => webServer.close(resolve));
  if (apiServer && !apiServer.killed) {
    apiServer.kill('SIGTERM');
    await delay(200);
    if (!apiServer.killed) apiServer.kill('SIGKILL');
  }
  if (!preserveEvidence && fail === 0) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await delay(100); }
    }
  } else {
    console.error(`E2E failure evidence preserved at ${evidence}`);
  }
}

