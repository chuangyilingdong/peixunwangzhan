import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p6-learn-portal-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
};

const run = (args, env = baseEnv) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => { if (code) reject(new Error(err || out)); else resolve(out); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 18902;

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, raw: j };
}
async function waitForServer() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await sleep(100); }
  throw new Error('server up failed: ' + serverLog);
}
async function login(loginName, password) {
  const r = await api('/api/auth/login', { method: 'POST', body: { login: loginName, password } });
  if (r.status !== 200) throw new Error(`${loginName} login failed: ${JSON.stringify(r.raw)}`);
  return r.data;
}

// New expected mapping: STUDENT/TEACHER/ORG_ADMIN → /learn; SUPER_ADMIN/PLATFORM_ADMIN → /admin/
function expectedPath(role) {
  if (role === 'STUDENT' || role === 'TEACHER' || role === 'ORG_ADMIN') return '/learn';
  if (role === 'SUPER_ADMIN' || role === 'PLATFORM_ADMIN') return '/admin/';
  return '/learn';
}

const checks = [];
function check(name, fn) { try { fn(); checks.push({ name, pass: true }); } catch (e) { checks.push({ name, pass: false, error: e.message }); throw e; } }

try {
  await waitForServer();

  // 1. Schema: personal_credit_ledger + users.personal_credits/magic_stones columns exist
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  const cols = db.prepare(`SELECT name FROM pragma_table_info('users') WHERE name IN ('personal_credits','magic_stones')`).all().map(r => r.name);
  check('users columns migrated', () => assert.ok(cols.includes('personal_credits') && cols.includes('magic_stones'), 'missing cols: ' + cols.join(',')));
  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='personal_credit_ledger'`).get();
  check('personal_credit_ledger table created', () => assert.ok(tbl && tbl.name === 'personal_credit_ledger'));
  db.close();

  // 2. /api/me includes personalCredits
  const student = await login('student-1', 'study123');
  check('student login OK', () => assert.equal(student.user.role, 'STUDENT'));
  const meStudent = await api('/api/me', { token: student.token });
  check('me returns personalCredits for student', () => assert.equal(typeof meStudent.data.personalCredits, 'number', 'me should include personalCredits, got ' + JSON.stringify(meStudent.data).slice(0, 200)));
  check('me returns magicStones for student', () => assert.equal(typeof meStudent.data.magicStones, 'number'));

  const teacher = await login('teacher-1', 'teach123');
  const meTeacher = await api('/api/me', { token: teacher.token });
  check('me returns personalCredits for teacher', () => assert.equal(typeof meTeacher.data.personalCredits, 'number'));

  const orgAdmin = await login('org-admin', 'org123');
  const meOrg = await api('/api/me', { token: orgAdmin.token });
  check('me returns personalCredits for org-admin', () => assert.equal(typeof meOrg.data.personalCredits, 'number'));

  // 3. Role → /learn mapping matches new website behavior
  check('STUDENT → /learn', () => assert.equal(expectedPath(student.user.role), '/learn'));
  check('TEACHER → /learn', () => assert.equal(expectedPath(teacher.user.role), '/learn'));
  check('ORG_ADMIN → /learn', () => assert.equal(expectedPath(orgAdmin.user.role), '/learn'));

  // 4. LoginPage in apps/website uses /learn redirect
  const websiteSrc = fs.readFileSync(path.join(root, 'apps/website/src/main.jsx'), 'utf8');
  check('website main.jsx redirects STUDENT to /learn', () => assert.ok(websiteSrc.includes("navigate('/learn')"), 'LoginPage should call navigate("/learn")'));
  check('website has /learn route', () => assert.ok(websiteSrc.includes("path='/learn'"), 'Website should declare /learn route'));

  // 5. Header navigation has new items
  check('Header nav has 学习上课', () => assert.ok(websiteSrc.includes('学习上课')));
  check('Header nav has 作品广场', () => assert.ok(websiteSrc.includes('作品广场')));
  check('Header nav has 自由画布', () => assert.ok(websiteSrc.includes('自由画布')));
  check('Header nav has 自由对话', () => assert.ok(websiteSrc.includes('自由对话')));

  // 6. Shared package exports classroom components
  const sharedIndex = fs.readFileSync(path.join(root, 'packages/shared/src/index.js'), 'utf8');
  check('shared exports classroom.jsx', () => assert.ok(sharedIndex.includes('classroom.jsx')));
  check('shared exports canvasWorkspace.jsx', () => assert.ok(sharedIndex.includes('canvasWorkspace.jsx')));

  const classroomJsx = fs.readFileSync(path.join(root, 'packages/shared/src/classroom.jsx'), 'utf8');
  check('CanvasClassroom exported', () => assert.ok(classroomJsx.includes('export function CanvasClassroom')));
  check('LearnEntry exported', () => assert.ok(classroomJsx.includes('export function LearnEntry')));

  const cwJsx = fs.readFileSync(path.join(root, 'packages/shared/src/canvasWorkspace.jsx'), 'utf8');
  check('CanvasWorkspace exported', () => assert.ok(cwJsx.includes('export function CanvasWorkspace')));

  // 7. /org app has external "进入学习上课" nav item
  const orgSrc = fs.readFileSync(path.join(root, 'apps/org/src/main.jsx'), 'utf8');
  check('org app has 进入学习上课 entry', () => assert.ok(orgSrc.includes('进入学习上课'), 'org navigation should include learning entry'));

  // 8. AppShell supports external links
  const uiJsx = fs.readFileSync(path.join(root, 'packages/shared/src/ui.jsx'), 'utf8');
  check('AppShell handles item.external', () => assert.ok(uiJsx.includes('item.external'), 'AppShell should handle external nav items'));

  // 9. Personal credit ledger is writable + indexed
  const db2 = new DatabaseSync(dbPath);
  const userId = student.user.id;
  const orgId = 'test-org';
  db2.prepare(`INSERT INTO organizations (id, name, status, contract_start_at, contract_expires_at, created_at, updated_at) VALUES (?, 't', 'ACTIVE', datetime('now'), datetime('now', '+30 days'), datetime('now'), datetime('now'))`).run(orgId);
  db2.prepare(`INSERT INTO users (id, org_id, login, display_name, role, password_hash, status, created_at, updated_at, personal_credits, magic_stones) VALUES ('user-ledger', ?, 'ledger-test', 'Ledger Test', 'STUDENT', 'x', 'ACTIVE', datetime('now'), datetime('now'), 50, 0)`).run(orgId);
  db2.prepare(`INSERT INTO personal_credit_ledger (id, user_id, direction, type, credits, balance_after, source, reason, created_at) VALUES ('ledger-1', ?, 'IN', 'TOPUP', 50, 50, 'FREE_CANVAS', 'init', datetime('now'))`).run('user-ledger');
  const rows = db2.prepare('SELECT * FROM personal_credit_ledger WHERE user_id = ?').all('user-ledger');
  check('personal_credit_ledger insertable', () => assert.equal(rows.length, 1));
  check('personal_credit_ledger direction is IN', () => assert.equal(rows[0].direction, 'IN'));
  db2.close();

  console.log(JSON.stringify({ name: 'p6-learn-portal-e2e', pass: true, checks: checks.length, items: checks.map(c => c.name) }));
} catch (e) {
  console.error(JSON.stringify({ name: 'p6-learn-portal-e2e', pass: false, error: e.message, checks: checks.length }));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
}
