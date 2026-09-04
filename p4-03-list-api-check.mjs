import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const dbPath = path.join(root, `.tmp-p4-03-list-${Date.now()}.db`);
const port = 8893;
process.env.PLATFORM_DB_PATH = dbPath;
const { initDatabase } = await import('./packages/database/src/schema.js');
const { seedDatabase } = await import('./packages/database/src/seed.js');
initDatabase();
seedDatabase();
const child = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), DEPLOYMENT_MODE: 'internal-test', API_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (b) => { output += b.toString(); });
child.stderr.on('data', (b) => { output += b.toString(); });
const base = `http://127.0.0.1:${port}/api`;
async function waitForServer() { for (let i = 0; i < 40; i++) { try { const r = await fetch(base + '/meta/domain-states'); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error(`server did not start: ${output}`); }
async function call(method, route, token) { const response = await fetch(base + route, { method, headers: token ? { authorization: `Bearer ${token}` } : undefined }); const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: response.status, data }; }
let passed = 0;
function ok(name, condition, value) { if (!condition) throw new Error(`FAIL ${name}: ${JSON.stringify(value)}`); passed++; console.log(`PASS ${name}`); }
try {
  await waitForServer();
  const login = await call('POST', '/auth/login');
  const loginResponse = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'root', password: 'admin123' }) });
  const loginData = await loginResponse.json();
  const token = loginData.data.token;
  ok('root login', loginResponse.status === 200 && loginData.success === true, loginData);
  const users = await call('GET', '/admin/platform-users?page=1&limit=2', token);
  ok('users pagination metadata', users.status === 200 && users.data.success && users.data.data.page === 1 && users.data.data.limit === 2 && Number.isInteger(users.data.data.totalPages), users);
  const usersInvalid = await call('GET', '/admin/platform-users?page=0&limit=2', token);
  ok('users invalid page rejected', usersInvalid.status === 400, usersInvalid);
  const works = await call('GET', '/admin/works?page=1&limit=2&sort=title', token);
  ok('works pagination and whitelist sort', works.status === 200 && works.data.data.page === 1 && works.data.data.limit === 2 && works.data.data.sort === 'title', works);
  const worksFallback = await call('GET', '/admin/works?page=1&limit=2&sort=not-a-column', token);
  ok('works unknown sort safely falls back', worksFallback.status === 200 && worksFallback.data.data.sort === 'featured', worksFallback);
  const audit = await call('GET', '/admin/audit-logs?page=1&limit=2', token);
  ok('audit pagination metadata', audit.status === 200 && audit.data.data.page === 1 && audit.data.data.limit === 2 && audit.data.data.totalPages >= 1, audit);
  const marketplace = await call('GET', '/admin/course-marketplace?marketplaceStatus=NONE&page=1&limit=2', token);
  ok('marketplace status alias and pagination', marketplace.status === 200 && marketplace.data.data.page === 1 && marketplace.data.data.limit === 2 && 'totalPages' in marketplace.data.data, marketplace);
  const unauthenticated = await call('GET', '/admin/platform-users?page=1&limit=2');
  ok('unauthenticated denied', unauthenticated.status === 401, unauthenticated);
  console.log(`ALL PASS ${passed}`);
} finally {
  child.kill();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(dbPath + suffix, { force: true }); } catch {} }
}
