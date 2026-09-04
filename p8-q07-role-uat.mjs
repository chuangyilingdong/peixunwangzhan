import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const defaultDb = path.resolve(repo, 'packages/data/platform.db');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-q07-'));
const tempData = path.join(tempRoot, 'data');
const tempDb = path.join(tempData, 'platform.db');
const evidence = path.join(tempRoot, 'evidence');
fs.mkdirSync(tempData, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });

const apps = [
  { key: 'admin', prefix: '/admin/', dist: path.join(repo, 'apps/admin/dist') },
  { key: 'org', prefix: '/org/', dist: path.join(repo, 'apps/org/dist') },
  { key: 'student', prefix: '/student/', dist: path.join(repo, 'apps/student/dist') },
  { key: 'website', prefix: '/', dist: path.join(repo, 'apps/website/dist') },
];

for (const app of apps) {
  const index = path.join(app.dist, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`缺少静态产物：${index}；请先执行 pnpm build`);
}
if (path.resolve(tempDb) === path.resolve(defaultDb)) throw new Error('安全检查失败：禁止使用默认业务数据库');

function writeLog(name, chunk) {
  fs.appendFileSync(path.join(evidence, name), chunk);
}
function appendMetadata(extra = {}) {
  const file = path.join(evidence, 'runtime.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = {
    ...current,
    ...extra,
    pid: process.pid,
    repo,
    tempRoot,
    database: tempDb,
    evidence,
    startedAt: current.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
async function reservePort(used = new Set()) {
  for (let i = 0; i < 20; i += 1) {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => resolve(address?.port || 0));
      });
    });
    if (port > 0 && !used.has(port)) {
      used.add(port);
      return port;
    }
  }
  throw new Error('未能申请到可用的本地空闲端口');
}
async function waitForHttp(url, predicate, label) {
  let lastError = '';
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (predicate(response, text)) return { response, text };
      lastError = `status=${response.status} body=${text.slice(0, 160)}`;
    } catch (error) {
      lastError = String(error);
    }
    await delay(100);
  }
  throw new Error(`${label} 未就绪：${lastError}`);
}
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return map[ext] || 'application/octet-stream';
}
function selectStaticFile(pathname) {
  const ordered = [...apps].sort((a, b) => b.prefix.length - a.prefix.length);
  const app = ordered.find((item) => pathname === item.prefix || pathname.startsWith(item.prefix));
  if (!app) return { app: apps[3], file: path.join(apps[3].dist, 'index.html'), spa: true };
  const root = path.resolve(app.dist);
  const relative = pathname === app.prefix ? 'index.html' : pathname.slice(app.prefix.length);
  let decoded = '';
  try { decoded = decodeURIComponent(relative); } catch { decoded = 'index.html'; }
  const candidate = path.resolve(root, decoded.replace(/^\/+/, ''));
  const contained = candidate === root || candidate.startsWith(root + path.sep);
  const exists = contained && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  return { app, file: exists ? candidate : path.join(root, 'index.html'), spa: !exists };
}
function proxyApi(req, res, apiPort) {
  const upstream = http.request({
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: apiPort,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });
  upstream.on('error', (error) => {
    writeLog('gateway.errors.log', `${new Date().toISOString()} ${req.method} ${req.url} ${String(error)}\n`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: { code: 'UAT_GATEWAY_UPSTREAM_ERROR', message: 'API 代理失败' } }));
  });
  req.pipe(upstream);
}

const usedPorts = new Set();
const apiPort = await reservePort(usedPorts);
const gatewayPort = await reservePort(usedPorts);
const env = {
  ...process.env,
  DEPLOYMENT_MODE: 'internal-test',
  PLATFORM_DATA_DIR: tempData,
  PLATFORM_DB_PATH: tempDb,
  PORT: String(apiPort),
  AUTH_PEPPER: 'p8-q07-temporary-only',
  AI_PROVIDER: 'local-mock',
};

execFileSync(process.execPath, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
execFileSync(process.execPath, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
if (!fs.existsSync(tempDb) || !path.resolve(tempDb).startsWith(path.resolve(tempRoot))) throw new Error('临时 SQLite 初始化失败');
if (path.resolve(tempDb) === path.resolve(defaultDb)) throw new Error('安全检查失败：实际使用了默认业务数据库');

const apiServer = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: repo,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
apiServer.stdout.on('data', (chunk) => writeLog('api.stdout.log', chunk));
apiServer.stderr.on('data', (chunk) => writeLog('api.stderr.log', chunk));
apiServer.once('exit', (code, signal) => {
  writeLog('api.lifecycle.log', `${new Date().toISOString()} exit code=${code} signal=${signal}\n`);
});

const gateway = http.createServer((req, res) => {
  const started = Date.now();
  const requested = (req.url || '/').split('?')[0];
  if (requested === '/api' || requested.startsWith('/api/')) {
    proxyApi(req, res, apiPort);
    return;
  }
  const { app, file, spa } = selectStaticFile(requested);
  res.writeHead(200, {
    'content-type': contentType(file),
    'cache-control': spa || file.endsWith('.html') ? 'no-store' : 'public, max-age=300',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'x-internal-test': 'true',
    'x-uat-app': app.key,
  });
  fs.createReadStream(file).pipe(res);
  res.once('finish', () => {
    writeLog('gateway.access.log', `${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms app=${app.key}${spa ? ' spa=true' : ''}\n`);
  });
});
gateway.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));

await new Promise((resolve, reject) => {
  gateway.once('error', reject);
  gateway.listen(gatewayPort, '127.0.0.1', resolve);
});
appendMetadata({ apiPort, gatewayPort, apiBaseUrl: `http://127.0.0.1:${apiPort}/api`, apps: apps.map(({ key, prefix }) => ({ key, prefix })) });

await waitForHttp(`http://127.0.0.1:${apiPort}/health`, (response, text) => response.status === 200 && JSON.parse(text).data?.status === 'ok', '隔离 API');
const publicLegal = await waitForHttp(`http://127.0.0.1:${gatewayPort}/api/public/legal`, (response, text) => response.status === 200 && JSON.parse(text).success === true, '网关 API 代理');
const gatewayChecks = [];
for (const app of apps) {
  const pathname = app.prefix === '/' ? '/' : app.prefix;
  const result = await waitForHttp(`http://127.0.0.1:${gatewayPort}${pathname}`, (response, text) => response.status === 200 && text.includes('<div id="root"'), `静态入口 ${app.key}`);
  gatewayChecks.push({ key: app.key, pathname, title: /<title>([^<]+)<\/title>/.exec(result.text)?.[1] || '' });
}
appendMetadata({ readyAt: new Date().toISOString(), gatewayChecks, status: 'READY' });

const baseUrl = `http://127.0.0.1:${gatewayPort}`;
console.log('P8-Q07 角色 UAT 隔离环境已启动');
console.log(`临时数据库：${tempDb}`);
console.log(`证据目录：${evidence}`);
console.log(`本地入口：${baseUrl}/admin/ | ${baseUrl}/org/ | ${baseUrl}/student/ | ${baseUrl}/`);
console.log(`API 代理：${baseUrl}/api`);
console.log('按 Ctrl+C 停止；证据文件保留在临时目录，不触碰默认业务数据库。');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  appendMetadata({ stoppedAt: new Date().toISOString(), status: 'STOPPED' });
  apiServer.kill();
  await new Promise((resolve) => {
    gateway.close(() => resolve());
    setTimeout(resolve, 1500).unref();
  });
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
apiServer.once('exit', () => { if (!stopping) process.kill(process.pid, 'SIGTERM'); });
setInterval(() => appendMetadata({ heartbeatAt: new Date().toISOString() }), 30000).unref();
