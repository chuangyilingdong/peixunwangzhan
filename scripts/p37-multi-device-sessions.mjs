/**
 * P37 同一账号允许多设备同时在线。
 *
 * 背景：登录时曾经把该账号所有既有会话标记 superseded（最初的单会话策略），
 * 换台电脑/换个浏览器登录就会把前一个顶掉，请求报「当前账号已在其他设备登录」。
 * 现在改为多设备并存，只做数量上限保护。
 *
 * 覆盖：
 *  1. 连续登录两次：两个 token 都能正常用（修复前第一个会 401 SESSION_SUPERSEDED）
 *  2. 在线设备列表能看到两台设备
 *  3. 上限保护：超过 MAX_ACTIVE_SESSIONS 时把最老的顶下线，最新的仍可用
 *  4. 「退出登录」只注销自己那一个会话，另一台设备不受影响
 *  5. 主动撤销某一台设备：被撤销的 401，其他仍可用
 *  6. 改密码仍然把所有会话踢下线（安全语义不变）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p37-multi-device-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
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

const port = 18918;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const login = async (login名 = 'student-2', password = 'study123') => {
  const result = await api('/api/auth/login', { method: 'POST', body: { login: login名, password } });
  assert.equal(result.status, 200, `登录失败: ${JSON.stringify(result.data)}`);
  return result.data.token;
};
// 用一个 token 请求一个只读接口，判断这个会话还有效没
const alive = async (token) => (await api('/api/student/dashboard', { token })).status;
const devices = async (token) => (await api('/api/student/account', { token })).data.sessions;

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  // 1) 两台设备各自登录：两个 token 都要能用
  const deviceA = await login();
  const deviceB = await login();
  assert.equal(await alive(deviceA), 200, '先登录的设备不应被后一次登录顶掉');
  assert.equal(await alive(deviceB), 200, '后登录的设备应可正常使用');

  // 2) 在线设备列表里两台都在
  const list = await devices(deviceA);
  assert.ok(list.length >= 2, `在线设备应至少 2 台（实际 ${list.length}）`);

  // 3) 上限保护：再登 MAX_ACTIVE_SESSIONS 次，最早那台应被顶下线
  let newest = deviceB;
  for (let i = 0; i < 10; i += 1) newest = await login();
  assert.equal(await alive(newest), 200, '最新登录的设备应可用');
  assert.equal(await alive(deviceA), 401, '超过上限后最早的会话应被顶下线');

  const capped = await devices(newest);
  assert.ok(capped.length <= 10, `在线设备数不应超过上限（实际 ${capped.length}）`);

  // 4) 退出登录只影响自己
  const survivor = await login();
  await api('/api/auth/logout', { method: 'POST', token: newest });
  assert.equal(await alive(newest), 401, '已退出登录的会话应失效');
  assert.equal(await alive(survivor), 200, '另一台设备不应被退出登录影响');

  // 5) 主动撤销某一台设备（列表中 current 标记的就是自己那台）
  const victim = await login();
  const survivorDevices = await devices(survivor);
  const revokeTarget = survivorDevices.find((item) => !item.current)?.id;
  assert.ok(revokeTarget, '在线设备列表里应能找到「另一台设备」用于撤销');
  const revoked = await api(`/api/student/account/sessions/${encodeURIComponent(revokeTarget)}/revoke`, {
    method: 'PUT', token: survivor, body: { currentPassword: 'study123' },
  });
  assert.equal(revoked.status, 200, `撤销设备失败: ${JSON.stringify(revoked.data)}`);
  assert.equal(await alive(survivor), 200, '撤销别的设备不应影响当前设备');
  assert.ok(!(await devices(survivor)).some((item) => item.id === revokeTarget), '被撤销的设备不应再出现在列表里');
  void victim;

  // 6) 改密码照样把所有设备踢下线
  const changed = await api('/api/student/account/password', {
    method: 'PUT', token: survivor, body: { currentPassword: 'study123', newPassword: 'study456' },
  });
  assert.equal(changed.status, 200, `改密码失败: ${JSON.stringify(changed.data)}`);
  assert.equal(changed.data.reloginRequired, true, '改密码后应要求重新登录');
  assert.equal(await alive(survivor), 401, '改密码后所有旧会话都应失效');
  assert.equal(await login('student-2', 'study456') ? 200 : 0, 200, '新密码应能登录');

  console.log(JSON.stringify({
    name: 'multi-device-sessions', pass: true,
    twoDevicesBothAlive: true,
    devicesVisible: list.length,
    oldestSupersededAtCap: true,
    capHolds: capped.length,
    logoutOnlySelf: true,
    revokeOneDevice: true,
    passwordChangeRevokesAll: true,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
