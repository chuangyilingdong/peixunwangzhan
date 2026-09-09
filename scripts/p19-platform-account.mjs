/**
 * P19 平台账号自助改密 + 用户详情/改角色。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：当前密码校验 → 改密后全部会话失效 → 新密码可登录、旧密码不可 →
 * 受限权限的平台管理员也能自助改密（自助端点不挂业务域权限）→
 * 用户详情 → 角色调整（非法角色/提权到平台管理员/无机构均被拒）+ 会话失效 + 审计。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p19-platform-account-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const { DatabaseSync } = await import('node:sqlite');
const seedDb = new DatabaseSync(dbPath);
const org = seedDb.prepare('SELECT id FROM organizations LIMIT 1').get();
const student = seedDb.prepare("SELECT id, login FROM users WHERE login='student-2'").get();
const rootUser = seedDb.prepare("SELECT id FROM users WHERE login='root'").get();
const now = new Date().toISOString();
// 受限权限的平台管理员（只有内容域权限）+ 一个没有机构的用户
seedDb.prepare("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES ('admin_limited','limited','受限管理员','SUPER_ADMIN','[\"ADMIN_CONTENT\"]','placeholder','ACTIVE',?,?)").run(now, now);
seedDb.prepare("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES ('user_noorg','noorg','无机构用户','STUDENT','[]','placeholder','ACTIVE',?,?)").run(now, now);
seedDb.close();
// placeholder 密码哈希用平台自己的 hashPassword 写一次（避免手工拼格式）
const schemaUrl = pathToFileURL(path.join(root, 'packages/database/src/schema.js')).href;
await run(['-e', `
  const { DatabaseSync } = await import('node:sqlite');
  const { hashPassword } = await import(${JSON.stringify(schemaUrl)});
  const db = new DatabaseSync(${JSON.stringify(dbPath)});
  const hash = hashPassword('limited123');
  db.prepare("UPDATE users SET password_hash=? WHERE id='admin_limited'").run(hash);
  db.close();
`]);

const port = 18851;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });
server.stdout.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}
const login = (login, password) => api('/api/auth/login', { method: 'POST', body: { login, password } });

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  // 1) 自助改密：当前密码错误
  const rootLogin = await login('root', 'admin123');
  assert.equal(rootLogin.status, 200, `root 登录失败: ${JSON.stringify(rootLogin.data)}`);
  const rootToken = rootLogin.data.token;
  const wrongCurrent = await api('/api/admin/me/password', { method: 'PUT', token: rootToken, body: { currentPassword: 'wrong-password', newPassword: 'newpass123' } });
  assert.equal(wrongCurrent.status, 403, `当前密码错误应 403，实际 ${wrongCurrent.status}`);
  assert.equal(wrongCurrent.data?.error?.code, 'CURRENT_PASSWORD_INVALID', '错误码应为 CURRENT_PASSWORD_INVALID');
  const tooShort = await api('/api/admin/me/password', { method: 'PUT', token: rootToken, body: { currentPassword: 'admin123', newPassword: '123' } });
  assert.equal(tooShort.status, 400, '新密码过短应 400');
  const samePassword = await api('/api/admin/me/password', { method: 'PUT', token: rootToken, body: { currentPassword: 'admin123', newPassword: 'admin123' } });
  assert.equal(samePassword.status, 400, '新旧密码相同应 400');
  assert.equal(samePassword.data?.error?.code, 'PASSWORD_UNCHANGED', '错误码应为 PASSWORD_UNCHANGED');

  // 2) 改密成功 → 全部会话失效 → 新密码可登录、旧密码不可
  const changed = await api('/api/admin/me/password', { method: 'PUT', token: rootToken, body: { currentPassword: 'admin123', newPassword: 'newpass123' } });
  assert.equal(changed.status, 200, `改密失败: ${JSON.stringify(changed.data)}`);
  assert.equal(changed.data.reauthRequired, true, '改密后应要求重新登录');
  const staleSession = await api('/api/admin/platform-users', { token: rootToken });
  assert.equal(staleSession.status, 401, `改密后旧会话应失效，实际 ${staleSession.status}`);
  const oldPassword = await login('root', 'admin123');
  assert.equal(oldPassword.status, 401, '旧密码不应还能登录');
  const newPassword = await login('root', 'newpass123');
  assert.equal(newPassword.status, 200, '新密码应能登录');
  const freshRoot = newPassword.data.token;

  // 3) 受限权限的管理员也能自助改密（自助端点不挂业务域权限）
  const limitedLogin = await login('limited', 'limited123');
  assert.equal(limitedLogin.status, 200, `受限管理员登录失败: ${JSON.stringify(limitedLogin.data)}`);
  const limitedToken = limitedLogin.data.token;
  const limitedChange = await api('/api/admin/me/password', { method: 'PUT', token: limitedToken, body: { currentPassword: 'limited123', newPassword: 'limited456' } });
  assert.equal(limitedChange.status, 200, `受限管理员改密失败: ${JSON.stringify(limitedChange.data)}`);
  const limitedRelogin = await login('limited', 'limited456');
  assert.equal(limitedRelogin.status, 200, '受限管理员应能用新密码登录');

  // 4) 用户详情
  const detail = await api(`/api/admin/platform-users/${student.id}`, { token: freshRoot });
  assert.equal(detail.status, 200, `用户详情失败: ${JSON.stringify(detail.data)}`);
  assert.equal(detail.data.login, 'student-2', '详情应返回登录名');
  assert.equal(detail.data.role, 'STUDENT', '详情应返回角色');
  assert.equal(detail.data.organizationName, '示例创新学校', `详情应返回机构名，实际 ${detail.data.organizationName}`);
  const missing = await api('/api/admin/platform-users/user_not_exist', { token: freshRoot });
  assert.equal(missing.status, 404, '不存在的用户应 404');

  // 5) 角色调整的边界
  const badRole = await api(`/api/admin/platform-users/${student.id}/role`, { method: 'PUT', token: freshRoot, body: { role: 'SUPER_ADMIN' } });
  assert.equal(badRole.status, 400, '把用户改成平台管理员应被拒（400）');
  assert.equal(badRole.data?.error?.code, 'INVALID_USER_ROLE', '错误码应为 INVALID_USER_ROLE');
  const rootSelf = await api(`/api/admin/platform-users/${rootUser.id}/role`, { method: 'PUT', token: freshRoot, body: { role: 'TEACHER' } });
  assert.equal(rootSelf.status, 403, '平台管理员角色不可在此修改（403）');
  assert.equal(rootSelf.data?.error?.code, 'PLATFORM_ADMIN_ROLE_IMMUTABLE', '错误码应为 PLATFORM_ADMIN_ROLE_IMMUTABLE');
  const noOrg = await api('/api/admin/platform-users/user_noorg/role', { method: 'PUT', token: freshRoot, body: { role: 'TEACHER' } });
  assert.equal(noOrg.status, 400, '无机构用户不能改成机构内角色（400）');
  assert.equal(noOrg.data?.error?.code, 'USER_ORG_REQUIRED', '错误码应为 USER_ORG_REQUIRED');

  // 6) 正常调整角色 → 会话失效 + 审计
  const studentLogin = await login('student-2', 'study123');
  assert.equal(studentLogin.status, 200, '学生登录失败');
  const promoted = await api(`/api/admin/platform-users/${student.id}/role`, { method: 'PUT', token: freshRoot, body: { role: 'TEACHER' } });
  assert.equal(promoted.status, 200, `角色调整失败: ${JSON.stringify(promoted.data)}`);
  assert.equal(promoted.data.role, 'TEACHER', '角色应变为 TEACHER');
  const staleStudent = await api('/api/student/dashboard', { token: studentLogin.data.token });
  assert.equal(staleStudent.status, 401, `改角色后学生会话应失效，实际 ${staleStudent.status}`);

  const db = new DatabaseSync(dbPath);
  const audit = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action IN ('PLATFORM_USER_ROLE','PLATFORM_SELF_PASSWORD_UPDATE')").get();
  const role = db.prepare('SELECT role FROM users WHERE id=?').get(student.id);
  db.close();
  assert.equal(audit.n, 3, `应写 3 条审计（1 次角色 + 2 次改密），实际 ${audit.n}`);
  assert.equal(role.role, 'TEACHER', '数据库里角色应已更新');

  console.log(JSON.stringify({
    name: 'platform-account', pass: true,
    selfPassword: { rootChanged: true, staleSessionRejected: true, limitedAdminChanged: true },
    detail: { login: detail.data.login, org: detail.data.organizationName },
    role: { before: 'STUDENT', after: promoted.data.role, escalatedBlocked: true, sessionRevoked: true },
    audits: audit.n,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
