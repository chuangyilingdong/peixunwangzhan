import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-s01-'));
const dataDir = path.join(tempRoot, 'data');
const dbPath = path.join(dataDir, 'platform.db');
const port = '18882';
fs.mkdirSync(dataDir, { recursive: true });
const env = {
  ...process.env,
  DEPLOYMENT_MODE: 'internal-test',
  PLATFORM_DATA_DIR: dataDir,
  PLATFORM_DB_PATH: dbPath,
  PORT: port,
  AUTH_PEPPER: 'p8-s01-temporary-only',
  AI_PROVIDER: 'local-mock',
  PUBLIC_SITE_URL: 'https://internal.example.test',
  ADMIN_APP_ORIGIN: 'https://internal.example.test/admin',
  STUDENT_APP_ORIGIN: 'https://internal.example.test/student',
  ORG_APP_ORIGIN: 'https://internal.example.test/org',
  CORS_ALLOWED_ORIGINS: 'https://internal.example.test,https://internal.example.test/admin,https://internal.example.test/student,https://internal.example.test/org',
};
let server;
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
    return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
  } catch (error) { return { status: 0, body: String(error), headers: {} }; }
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
  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: repo, env, stdio: 'ignore' });
  check('temporary API ready', await waitForHealth());

  const allowed = await request('/health', { headers: { origin: 'https://internal.example.test' } });
  check('allowed origin is reflected exactly', allowed.headers['access-control-allow-origin'] === 'https://internal.example.test');
  check('allowed origin enables credentials', allowed.headers['access-control-allow-credentials'] === 'true');
  check('API sends nosniff header', allowed.headers['x-content-type-options'] === 'nosniff');
  check('API sends frame protection header', allowed.headers['x-frame-options'] === 'DENY');
  check('API sends referrer policy', allowed.headers['referrer-policy'] === 'strict-origin-when-cross-origin');
  check('API sends restrictive permissions policy', allowed.headers['permissions-policy'] === 'camera=(), microphone=(), geolocation=()');
  check('internal API remains non-indexable', allowed.headers['x-robots-tag'] === 'noindex, nofollow, noarchive');

  const denied = await request('/health', { headers: { origin: 'https://evil.example.test' } });
  check('untrusted origin is not reflected', !Object.hasOwn(denied.headers, 'access-control-allow-origin'));
  check('untrusted origin is not granted credentials', !Object.hasOwn(denied.headers, 'access-control-allow-credentials'));
  const deniedPreflight = await request('/api/auth/login', { method: 'OPTIONS', headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'POST' } });
  check('untrusted preflight is not granted CORS origin', !Object.hasOwn(deniedPreflight.headers, 'access-control-allow-origin'));

  const unknown = await request('/api/no-such-route');
  check('unknown route returns structured 404', unknown.status === 404 && unknown.body?.error?.code === 'ROUTE_NOT_FOUND');
  check('unknown route does not leak stack or filesystem', !/stack|node_modules|apps[\\/]/i.test(JSON.stringify(unknown.body)));

  const rateLogin = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'p8-s01-nonexistent', password: 'wrong-password', clientType: 'web' }) };
  for (let i = 0; i < 10; i += 1) {
    const attempt = await request('/api/auth/login', rateLogin);
    check(`failed login attempt ${i + 1} is rejected without account leak`, attempt.status === 401 && attempt.body?.error?.code === 'INVALID_CREDENTIALS');
  }
  const limited = await request('/api/auth/login', rateLogin);
  check('login rate limit returns 429', limited.status === 429 && limited.body?.error?.code === 'RATE_LIMITED');
  check('rate limit response is generic', limited.body?.error?.message === '请求过于频繁，请稍后再试');

  const oversized = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'p8-s01-large-body', password: 'x'.repeat(2 * 1024 * 1024) }),
  });
  check('oversized JSON body is rejected', oversized.status === 400 && oversized.body?.error?.code === 'PAYLOAD_TOO_LARGE');

  const nginx = fs.readFileSync(path.join(repo, 'deploy/internal-test/nginx.conf.example'), 'utf8');
  check('Nginx disables version disclosure', nginx.includes('server_tokens off;'));
  check('Nginx caps request body size', nginx.includes('client_max_body_size 2m;'));
  check('Nginx includes CSP baseline', nginx.includes('Content-Security-Policy'));
  check('Nginx includes clickjacking protection', nginx.includes('X-Frame-Options "DENY"'));
  check('CORS allowlist is explicit in env template', fs.readFileSync(path.join(repo, 'deploy/internal-test/.env.example'), 'utf8').includes('CORS_ALLOWED_ORIGINS='));
  check('security test database is temporary', dbPath.startsWith(tempRoot) && path.resolve(dbPath) !== path.resolve(repo, 'packages/data/platform.db'));
  console.log(JSON.stringify({ pass, fail, database: dbPath, port }, null, 2));
  if (fail > 0) process.exitCode = 1;
} finally {
  if (server && !server.killed) { server.kill('SIGTERM'); await delay(200); if (!server.killed) server.kill('SIGKILL'); }
  for (let i = 0; i < 5; i += 1) { try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await delay(100); } }
}
