/**
 * P212 控制面缓存 · 鉴权上下文（2026-11-12）。
 *
 * 加了 5 秒（测试压成 300ms）的 users / organizations 行缓存之后，必须钉住三件事：
 *   ① **会话语义不变**：sessions 仍然每请求实时查 —— 登出立刻 401；
 *   ② **权限/机构状态变更立刻生效**：这些写入点会主动失效缓存（不依赖 TTL 兜底）；
 *   ③ **时间条件每次重算**：直接改库把 expires_at 改到过去，过 TTL 后必须 401 ACCOUNT_EXPIRED，
 *      证明命中缓存的行仍然会跑 assertUserAccountAvailable。
 *
 * 跑法：node scripts/p212-auth-context-cache.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p212-auth-cache-'));
const dbPath = path.join(temp, 'platform.db');
// 和 p6 一样硬设：脚本自己的库必须与服务子进程是同一份。
process.env.PLATFORM_DB_PATH = dbPath;
process.env.PLATFORM_DATA_DIR = temp;
// 测试把 TTL 压到 300ms：过期用例不用等 5 秒，显式失效的用例照旧验"立刻"。
process.env.AUTH_CACHE_TTL_MS = '300';

const { aq, arow } = await import('../packages/database/src/store.js');
const { createTtlCache } = await import('../apps/server/src/services/ttlCache.js');
const authCache = await import('../apps/server/src/services/authCache.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ───────────── 单元：TTL 缓存本身 ───────────── */
{
  const cache = createTtlCache({ name: 'p212', ttlMs: 40, max: 2 });
  cache.set('a', 1); cache.set('b', 2);
  check('set/get 命中', cache.get('a') === 1);
  cache.set('c', 3); // 读 a 提权后，b 是最旧的 → 被淘汰
  check('超上限淘汰最旧、保留刚访问的', cache.get('a') === 1 && cache.get('c') === 3 && cache.get('b') === undefined);
  await sleep(60);
  check('TTL 到期后 miss', cache.get('a') === undefined);

  const scoped = createTtlCache({ ttlMs: 1000, max: 10 });
  scoped.set('u1|x', 1); scoped.set('u1|y', 2); scoped.set('u2|x', 3);
  check('deleteWhere 只删匹配的 key', scoped.deleteWhere((key) => key.startsWith('u1|')) === 2 && scoped.get('u2|x') === 3);

  const off = createTtlCache({ ttlMs: 0, max: 10 });
  off.set('a', 1);
  check('ttl=0 整体禁用（get 恒 miss、不占容量）', off.get('a') === undefined && off.size === 0);

  authCache.resetAuthCache();
  authCache.cacheAuthUser({ id: 'u-copy', status: 'ACTIVE' });
  const copy = authCache.getCachedAuthUser('u-copy');
  copy.status = 'DISABLED';
  check('缓存返回拷贝：下游改 rawUser 不污染缓存', authCache.getCachedAuthUser('u-copy')?.status === 'ACTIVE');
  authCache.invalidateAuthUser('u-copy');
  check('invalidateAuthUser 立刻 miss', authCache.getCachedAuthUser('u-copy') === null);
  authCache.cacheAuthOrg({ id: 'o-copy', status: 'ACTIVE' });
  authCache.invalidateAuthOrg('o-copy');
  check('invalidateAuthOrg 立刻 miss', authCache.getCachedAuthOrg('o-copy') === null);
}

/* ───────────── 真服务：失效与断言 ───────────── */
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const student = await arow("SELECT id, org_id FROM users WHERE login='student-1'");
const teacher = await arow("SELECT id FROM users WHERE login='teacher-1'");
assert.ok(student?.org_id && teacher?.id, '种子账号缺失');

const port = 19120;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return {
    status: response.status,
    data: payload?.data ?? payload,
    code: payload?.error?.code || payload?.code || null,
    raw: payload,
  };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* wait */ }
    await sleep(100);
  }
  throw new Error(`P212 服务启动失败: ${serverLog}`);
}

async function login(loginName, password) {
  const result = await api('/api/auth/login', { method: 'POST', body: { login: loginName, password } });
  assert.equal(result.status, 200, `${loginName} 登录失败: ${JSON.stringify(result.raw).slice(0, 300)}`);
  return result.data.token;
}

try {
  await waitForServer();
  const rootToken = await login('root', 'admin123');
  const studentToken = await login('student-1', 'study123');
  const teacherToken = await login('teacher-1', 'teach123');
  const orgAdminToken = await login('org-admin', 'org123');

  // 预热学生/教师的用户缓存
  check('学生 /api/me 预热成功', (await api('/api/me', { token: studentToken })).status === 200);

  // ① 机构停用 → 学生下一次请求立刻 401（机构行有显式失效）
  const disabled = await api(`/api/admin/organizations/${student.org_id}/status`, {
    method: 'POST', token: rootToken, body: { action: 'disable', reason: 'P212 验证机构缓存失效' },
  });
  check('超管停用机构 200', disabled.status === 200, JSON.stringify(disabled.raw).slice(0, 300));
  const blocked = await api('/api/me', { token: studentToken });
  check('机构停用后学生立刻 401 ORG_DISABLED（不等 TTL）',
    blocked.status === 401 && blocked.code === 'ORG_DISABLED', `${blocked.status} ${blocked.code}`);

  // ② 恢复机构 → 学生立刻恢复
  const recovered = await api(`/api/admin/organizations/${student.org_id}/status`, {
    method: 'POST', token: rootToken, body: { action: 'recover' },
  });
  check('超管恢复机构 200', recovered.status === 200, JSON.stringify(recovered.raw).slice(0, 300));
  check('机构恢复后学生立刻 200', (await api('/api/me', { token: studentToken })).status === 200);

  // ③ 教师权限变更 → /api/me 里立刻看到（用户行有显式失效）
  const beforePermissions = (await api('/api/me', { token: teacherToken })).data?.permissions || [];
  check('教师初始无权限', Array.isArray(beforePermissions) && beforePermissions.length === 0, JSON.stringify(beforePermissions));
  const granted = await api(`/api/org/users/${teacher.id}/permissions`, {
    method: 'PUT', token: orgAdminToken, body: { permissions: ['MANAGE_CLASSES'] },
  });
  check('机构管理员授予教师权限 200', granted.status === 200, JSON.stringify(granted.raw).slice(0, 300));
  const afterPermissions = (await api('/api/me', { token: teacherToken })).data?.permissions || [];
  check('授权后教师下一次请求立刻看到 MANAGE_CLASSES（不等 TTL）',
    afterPermissions.includes('MANAGE_CLASSES'), JSON.stringify(afterPermissions));

  // ④ 直接改库改 expires_at（绕过所有写入点）→ 过 TTL 后必须被账号可用性断言拦住
  await aq('UPDATE users SET expires_at=? WHERE id=?', [new Date(Date.now() - 60_000).toISOString(), student.id]);
  await sleep(400);
  const expired = await api('/api/me', { token: studentToken });
  check('缓存行仍然跑 assertUserAccountAvailable：expires_at 过期后 401 ACCOUNT_EXPIRED',
    expired.status === 401 && expired.code === 'ACCOUNT_EXPIRED', `${expired.status} ${expired.code}`);
  await aq('UPDATE users SET expires_at=NULL WHERE id=?', [student.id]);
  await sleep(400);
  check('恢复 expires_at 后学生重新 200', (await api('/api/me', { token: studentToken })).status === 200);

  // ⑤ 登出立刻 401：sessions 不缓存
  const loggedOut = await api('/api/auth/logout', { method: 'POST', token: studentToken });
  check('登出 200', loggedOut.status === 200, JSON.stringify(loggedOut.raw).slice(0, 200));
  const afterLogout = await api('/api/me', { token: studentToken });
  check('登出后立即 401（会话每请求实时查）',
    afterLogout.status === 401 && ['SESSION_SUPERSEDED', 'SESSION_INVALID'].includes(afterLogout.code),
    `${afterLogout.status} ${afterLogout.code}`);
} finally {
  server.kill('SIGTERM');
}

if (failures) {
  console.error(`P212 FAILED: ${failures} 项`);
  process.exit(1);
}
console.log('P212 passed: 鉴权上下文缓存（TTL/淘汰/显式失效/账号断言/会话实时）');
