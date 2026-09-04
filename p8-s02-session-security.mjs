import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-s02-'));
const dataDir = path.join(tempRoot, 'data');
const dbPath = path.join(dataDir, 'platform.db');
fs.mkdirSync(dataDir, { recursive: true });
const port = '18880';
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: dataDir, PLATFORM_DB_PATH: dbPath, PORT: port, AUTH_PEPPER: 'p8-s02-temporary-only', AI_PROVIDER: 'local-mock' };
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
    return { status: response.status, body, cookie: response.headers.get('set-cookie') || '' };
  } catch (error) { return { status: 0, body: String(error), cookie: '' }; }
}
async function call(method, pathname, body, token) {
  return request(`/api${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function ok(result) { return result.status >= 200 && result.status < 300 && result.body?.success === true; }
async function login(password = 'study123') {
  return call('POST', '/auth/login', { login: 'student-1', password, clientType: 'student' });
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

  const first = await login();
  check('first login succeeds', ok(first));
  const tokenA = first.body?.data?.token;
  check('login cookie is HttpOnly', /HttpOnly/i.test(first.cookie));
  check('internal-test login cookie is Secure', /Secure/i.test(first.cookie));
  check('login cookie uses SameSite=Lax', /SameSite=Lax/i.test(first.cookie));
  check('token is not exposed in cookie only', typeof tokenA === 'string' && tokenA.length > 20);
  const meA = await call('GET', '/me', undefined, tokenA);
  check('first session can read identity', ok(meA) && meA.body.data.session.clientType === 'student');
  check('identity response excludes password hash', !Object.prototype.hasOwnProperty.call(meA.body?.data || {}, 'passwordHash'));

  const second = await login();
  check('second login succeeds', ok(second));
  const tokenB = second.body?.data?.token;
  const oldMe = await call('GET', '/me', undefined, tokenA);
  check('older session is superseded after new login', oldMe.status === 401 && oldMe.body?.error?.code === 'SESSION_SUPERSEDED');
  const currentMe = await call('GET', '/me', undefined, tokenB);
  check('new session remains valid', ok(currentMe));

  const shortPassword = await call('PUT', '/student/account/password', { currentPassword: 'study123', newPassword: '12345' }, tokenB);
  check('short password rejected', shortPassword.status === 400 && shortPassword.body?.error?.code === 'PASSWORD_TOO_SHORT');
  const wrongCurrent = await call('PUT', '/student/account/password', { currentPassword: 'wrong-password', newPassword: 'study456' }, tokenB);
  check('wrong current password rejected', wrongCurrent.status === 400 && wrongCurrent.body?.error?.code === 'CURRENT_PASSWORD_INVALID');
  const changed = await call('PUT', '/student/account/password', { currentPassword: 'study123', newPassword: 'study456' }, tokenB);
  check('password change succeeds with current password', ok(changed) && changed.body.data.reloginRequired === true);
  check('password change revokes active sessions', Number(changed.body?.data?.sessionsRevoked) >= 1);
  check('password change clears Secure cookie', /Max-Age=0/i.test(changed.cookie) && /Secure/i.test(changed.cookie));
  const afterChange = await call('GET', '/me', undefined, tokenB);
  check('password change immediately invalidates old token', afterChange.status === 401);
  const oldPasswordLogin = await login('study123');
  check('old password no longer works', oldPasswordLogin.status === 401);
  const newPasswordLogin = await login('study456');
  check('new password works', ok(newPasswordLogin));
  const tokenC = newPasswordLogin.body?.data?.token;

  const logout = await call('POST', '/auth/logout', undefined, tokenC);
  check('logout succeeds', ok(logout) && logout.body.data.loggedOut === true);
  check('logout clears Secure cookie', /Max-Age=0/i.test(logout.cookie) && /Secure/i.test(logout.cookie));
  const afterLogout = await call('GET', '/me', undefined, tokenC);
  check('logout immediately invalidates token', afterLogout.status === 401);

  const relogin = await login('study456');
  check('relogin after logout succeeds', ok(relogin));
  const tokenD = relogin.body?.data?.token;
  const meD = await call('GET', '/me', undefined, tokenD);
  const sessionId = meD.body?.data?.session?.id;
  check('current session id is returned', typeof sessionId === 'string');
  const revoke = await call('PUT', `/student/account/sessions/${sessionId}/revoke`, { currentPassword: 'study456' }, tokenD);
  check('current session can be revoked with password', ok(revoke) && revoke.body.data.reloginRequired === true);
  const afterRevoke = await call('GET', '/me', undefined, tokenD);
  check('revoked session is immediately invalid', afterRevoke.status === 401);
  check('test database is isolated', dbPath.startsWith(tempRoot) && path.resolve(dbPath) !== path.resolve(repo, 'packages/data/platform.db'));
  console.log(JSON.stringify({ pass, fail, database: dbPath, port }, null, 2));
  if (fail > 0) process.exitCode = 1;
} finally {
  if (server && !server.killed) { server.kill('SIGTERM'); await delay(200); if (!server.killed) server.kill('SIGKILL'); }
  for (let i = 0; i < 5; i += 1) { try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; } catch { await delay(100); } }
}
