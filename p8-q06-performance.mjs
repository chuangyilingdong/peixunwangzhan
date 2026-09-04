import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-q06-'));
const tempData = path.join(tempRoot, 'data');
const tempDb = path.join(tempData, 'platform.db');
const evidence = path.join(tempRoot, 'evidence');
const apiPort = '18882';
const webPort = 18883;
const webDist = path.join(repo, 'apps', 'website', 'dist');
fs.mkdirSync(tempData, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: tempData, PLATFORM_DB_PATH: tempDb, PORT: apiPort, AUTH_PEPPER: 'p8-q06-temporary-only', AI_PROVIDER: 'local-mock' };
let apiServer; let webServer; let preserveEvidence = false; let pass = 0; let fail = 0;
function check(name, condition, details = '') { if (condition) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.error(`FAIL ${name}${details ? `: ${details}` : ''}`); } }
function parseJson(text) { try { return JSON.parse(text); } catch { return text; } }
function success(r) { return r.status >= 200 && r.status < 300 && r.body?.success === true; }
function setCookie(r, jar) { const raw = r.headers.get('set-cookie') || ''; const token = raw.match(/(?:^|,\s*)platform_token=([^;]+)/)?.[1]; if (token) jar.platform_token = token; return raw; }
async function request(base, pathname, options = {}, jar = null) {
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  if (jar?.platform_token) headers.cookie = `platform_token=${jar.platform_token}`;
  const started = performance.now();
  try {
    const response = await fetch(`${base}${pathname}`, { ...options, headers });
    const text = await response.text();
    if (jar) setCookie(response, jar);
    return { status: response.status, body: parseJson(text), headers: response.headers, text, ms: performance.now() - started };
  } catch (error) { return { status: 0, body: String(error), headers: new Headers(), text: String(error), ms: performance.now() - started }; }
}
async function api(pathname, options = {}, jar = null) {
  const body = options.body;
  return request(`http://127.0.0.1:${apiPort}/api`, pathname, { ...options, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, jar);
}
async function waitHealth() { for (let i = 0; i < 60; i += 1) { const r = await request(`http://127.0.0.1:${apiPort}`, '/health'); if (r.status === 200) return r; await delay(100); } return null; }
function startStatic() { webServer = http.createServer((req, res) => { const url = decodeURIComponent((req.url || '/').split('?')[0]); const root = path.resolve(webDist); const candidate = path.resolve(root, url === '/' ? 'index.html' : url.replace(/^\/+/, '')); const file = candidate.startsWith(root + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(root, 'index.html'); res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-internal-test': 'true' }); fs.createReadStream(file).pipe(res); }); return new Promise((resolve) => webServer.listen(webPort, '127.0.0.1', resolve)); }
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0; }
async function benchmark(label, count, concurrency, fn) {
  const results = []; let cursor = 0;
  async function worker() { while (true) { const i = cursor++; if (i >= count) return; const r = await fn(i); results.push(r); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  const times = results.map((r) => r.ms); const successful = results.filter((r) => r.ok).length; const p50 = percentile(times, 0.5); const p95 = percentile(times, 0.95); const max = Math.max(...times, 0);
  console.log(`METRIC ${label} count=${count} concurrency=${concurrency} success=${successful} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`);
  return { results, successful, p50, p95, max };
}
try {
  execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  check('性能测试使用临时 SQLite', fs.existsSync(tempDb) && tempDb.startsWith(tempRoot));
  apiServer = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  apiServer.stdout.pipe(fs.createWriteStream(path.join(evidence, 'api.stdout.log'))); apiServer.stderr.pipe(fs.createWriteStream(path.join(evidence, 'api.stderr.log')));
  check('API 健康检查通过', Boolean(await waitHealth()));

  const pnpmCli = process.platform === 'win32' ? 'C:\\Users\\Administrator\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\pnpm\\bin\\pnpm.mjs' : 'pnpm';
  const buildEnv = { ...process.env, VITE_DEPLOYMENT_MODE: 'internal-test', VITE_PUBLIC_SITE_URL: 'https://iicili.cyou' };
  if (process.platform === 'win32') buildEnv.PATH = `${path.dirname(process.execPath)};${buildEnv.PATH || ''}`;
  execFileSync(process.platform === 'win32' ? process.execPath : pnpmCli, process.platform === 'win32' ? [pnpmCli, 'build'] : ['build'], { cwd: repo, env: buildEnv, stdio: 'inherit' });
  await startStatic();
  const home = await request(`http://127.0.0.1:${webPort}`, '/');
  check('官网首页可加载', home.status === 200 && home.text.includes('<div id="root"></div>'));
  check('内测首页返回 noindex', home.headers.get('x-robots-tag')?.includes('noindex') === true);
  const apiHome = await benchmark('health', 30, 10, async () => { const r = await request(`http://127.0.0.1:${apiPort}`, '/health'); return { ok: r.status === 200, ms: r.ms }; });
  check('健康接口 30 请求无错误且 p95 < 500ms', apiHome.successful === 30 && apiHome.p95 < 500);
  const publicBurst = await benchmark('public-marketplace', 30, 10, async () => { const r = await api('/public/marketplace?limit=20'); return { ok: success(r), ms: r.ms }; });
  check('公开课程接口并发 30 请求全成功且 p95 < 500ms', publicBurst.successful === 30 && publicBurst.p95 < 500);

  const teacher = {}; const teacherLogin = await api('/auth/login', { method: 'POST', body: { login: 'teacher-1', password: 'teach123', clientType: 'org' } }, teacher);
  const classes = await api('/org/classes', {}, teacher); const classId = classes.body?.data?.items?.[0]?.id;
  const series = await api('/org/course-series', {}, teacher); const lessonId = series.body?.data?.items?.[0]?.lessons?.[0]?.lessonId || series.body?.data?.items?.[0]?.lessons?.[0]?.id;
  const started = await api(`/org/classes/${classId}/sessions/start`, { method: 'POST', body: { lessonId, sessionCreditCap: 20, capabilities: { allowImage: true, allowMusic: true, allowVideo: true } } }, teacher);
  const student = {}; const studentLogin = await api('/auth/login', { method: 'POST', body: { login: 'student-1', password: 'study123', clientType: 'student' } }, student);
  const project = await api('/student/projects', { method: 'POST', body: { courseLessonId: lessonId, title: 'P8-Q06 性能测试项目', canvasSnapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } } }, student);
  const projectId = project.body?.data?.id;
  check('容量场景准备完成', success(teacherLogin) && success(started) && success(studentLogin) && success(project) && typeof projectId === 'string');
  const classroom = await benchmark('student-dashboard-classroom', 20, 10, async () => { const r = await api('/student/dashboard', {}, student); return { ok: success(r) && r.body.data.canUseNow === true, ms: r.ms }; });
  check('模拟并发课堂 20 次学生读取全成功且 p95 < 500ms', classroom.successful === 20 && classroom.p95 < 500);
  const aiBurst = await benchmark('ai-local-mock', 3, 3, async (i) => { const r = await api('/ai/generations', { method: 'POST', body: { projectId, modality: 'IMAGE', title: `性能预览 ${i}`, prompt: '性能测试用的星光森林预览' } }, student); return { ok: success(r) && r.body.data.job.status === 'SUCCEEDED', ms: r.ms }; });
  check('AI 任务并发 3 次全成功且 p95 < 1000ms', aiBurst.successful === 3 && aiBurst.p95 < 1000);

  const org = {}; await api('/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123', clientType: 'org' } }, org);
  const fileBurst = await benchmark('file-metadata-write', 3, 3, async (i) => { const r = await api('/org/file-assets', { method: 'POST', body: { storageKind: 'PENDING', fileName: `性能测试-${i}.txt`, category: 'GENERAL', visibility: 'ORG', fileSize: 128, mimeType: 'text/plain' } }, org); return { ok: success(r) && r.body.data.storageKind === 'PENDING', ms: r.ms }; });
  check('文件元数据写入并发 3 次全成功且 p95 < 1000ms', fileBurst.successful === 3 && fileBurst.p95 < 1000);
  check('未宣称真实文件上传能力', fileBurst.results.every((r) => r.ok));
  const oversized = await api('/public/marketplace?limit=101');
  check('超出分页容量上限被拦截', oversized.status === 400);
  const ended = await api(`/org/classes/${classId}/sessions/${started.body?.data?.id}/end`, { method: 'POST', body: { reason: 'P8_Q06_COMPLETE' } }, teacher);
  check('容量测试结束后释放课堂', success(ended));
  console.log(JSON.stringify({ pass, fail, targets: { apiP95Ms: 500, aiP95Ms: 1000, concurrentClassroomReads: 20, aiBurst: 3, fileMetadataWrites: 3 }, database: tempDb, evidence }, null, 2));
  if (fail > 0) process.exitCode = 1;
} catch (error) { preserveEvidence = true; console.error(error?.stack || error); process.exitCode = 1; }
finally {
  if (webServer) await new Promise((resolve) => webServer.close(resolve));
  if (apiServer && !apiServer.killed) { apiServer.kill('SIGTERM'); await delay(200); if (!apiServer.killed) apiServer.kill('SIGKILL'); }
  if (!preserveEvidence && fail === 0) { for (let i = 0; i < 8; i += 1) { try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await delay(100); } } }
  else console.error(`性能测试证据保留于 ${evidence}`);
}
