/**
 * P22 平台管理员二次验证（TOTP + 恢复码）。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：生成绑定密钥 → 错误动态码被拒 → 正确动态码开启（发 10 枚恢复码）→
 * 登录缺码 MFA_REQUIRED → 错误码 / 重放同一动态码被拒 → 动态码登录成功 →
 * 恢复码登录成功且只能用一次 → 平台管理员列表 mfaEnabled →
 * 重新生成恢复码后旧码作废 → 关闭二次验证（密码 + 恢复码）→ 之后可免二次验证登录 →
 * 审计落库 + 机构管理员访问平台 MFA 端点 403。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-platform-mfa-'));
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

// 直接用服务端的 TOTP 实现算码（totp.js 只依赖 node:crypto + config.js，不碰数据库）
const { totpCode } = await import(pathToFileURL(path.join(root, 'apps/server/src/services/totp.js')).href);

const port = 18861;
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
const login = (login, password, mfaCode) => api('/api/auth/login', { method: 'POST', body: { login, password, ...(mfaCode ? { mfaCode } : {}) } });

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  // 1) 初始状态：未开启
  const rootLogin = await login('root', 'admin123');
  assert.equal(rootLogin.status, 200, `root 登录失败: ${JSON.stringify(rootLogin.data)}`);
  const rootToken = rootLogin.data.token;
  const initial = await api('/api/admin/me/mfa', { token: rootToken });
  assert.equal(initial.status, 200, `读取二次验证状态失败: ${JSON.stringify(initial.data)}`);
  assert.equal(initial.data.enabled, false, '初始应未开启二次验证');
  assert.equal(initial.data.setupPending, false, '初始不应有待验证的绑定');

  // 2) 机构管理员访问平台 MFA 端点应 403
  const orgLogin = await login('org-admin', 'org123');
  assert.equal(orgLogin.status, 200, `机构管理员登录失败: ${JSON.stringify(orgLogin.data)}`);
  const orgMfa = await api('/api/admin/me/mfa', { token: orgLogin.data.token });
  assert.equal(orgMfa.status, 403, `机构管理员不应能访问平台 MFA 端点，实际 ${orgMfa.status}`);

  // 3) 生成绑定密钥
  const setup = await api('/api/admin/me/mfa/setup', { method: 'POST', token: rootToken, body: {} });
  assert.equal(setup.status, 200, `生成绑定密钥失败: ${JSON.stringify(setup.data)}`);
  assert.match(setup.data.secret, /^[A-Z2-7]{32}$/, '密钥应为 32 位 base32');
  assert.ok(String(setup.data.otpauthUri).startsWith('otpauth://totp/'), `otpauth 链接格式不对: ${setup.data.otpauthUri}`);
  assert.ok(String(setup.data.otpauthUri).includes(`secret=${setup.data.secret}`), 'otpauth 链接应带密钥');
  assert.ok(String(setup.data.otpauthUri).includes('issuer='), 'otpauth 链接应带 issuer');
  const pending = await api('/api/admin/me/mfa', { token: rootToken });
  assert.equal(pending.data.setupPending, true, '生成密钥后应处于待验证状态');
  assert.equal(pending.data.enabled, false, '未验证前不应算已开启');

  // 4) 错误动态码不能开启
  const badEnable = await api('/api/admin/me/mfa/enable', { method: 'POST', token: rootToken, body: { code: '000000' } });
  assert.equal(badEnable.status, 400, `错误动态码应 400，实际 ${badEnable.status}`);
  assert.equal(badEnable.data?.error?.code, 'MFA_INVALID_CODE', '错误码应为 MFA_INVALID_CODE');

  // 5) 正确动态码开启，返回 10 枚恢复码
  const base = Date.now();
  const enabled = await api('/api/admin/me/mfa/enable', { method: 'POST', token: rootToken, body: { code: totpCode(setup.data.secret, { timestamp: base }) } });
  assert.equal(enabled.status, 200, `开启二次验证失败: ${JSON.stringify(enabled.data)}`);
  assert.equal(enabled.data.enabled, true, '开启后状态应为 enabled');
  assert.equal(enabled.data.recoveryCodes.length, 10, '应发 10 枚恢复码');
  assert.ok(enabled.data.recoveryCodes.every((item) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(item)), '恢复码格式应为 XXXXX-XXXXX');
  const firstCodes = [...enabled.data.recoveryCodes];

  // 6) 登录：缺验证码 → MFA_REQUIRED（密码正确但流程未完成）
  const noCode = await login('root', 'admin123');
  assert.equal(noCode.status, 401, `缺验证码应 401，实际 ${noCode.status}`);
  assert.equal(noCode.data?.error?.code, 'MFA_REQUIRED', '错误码应为 MFA_REQUIRED');

  // 7) 登录：错误验证码 → MFA_INVALID_CODE
  const wrongCode = await login('root', 'admin123', '000000');
  assert.equal(wrongCode.status, 401, `错误验证码应 401，实际 ${wrongCode.status}`);
  assert.equal(wrongCode.data?.error?.code, 'MFA_INVALID_CODE', '错误码应为 MFA_INVALID_CODE');

  // 8) 登录：正确动态码 → 成功，且同一枚码不能重放
  const loginCode = totpCode(setup.data.secret, { timestamp: base + 30000 });
  const totpLogin = await login('root', 'admin123', loginCode);
  assert.equal(totpLogin.status, 200, `动态码登录失败: ${JSON.stringify(totpLogin.data)}`);
  assert.equal(totpLogin.data.mfa, 'TOTP', '登录响应应标记 mfa=TOTP');
  const replay = await login('root', 'admin123', loginCode);
  assert.equal(replay.status, 401, `重放同一动态码应被拒，实际 ${replay.status}`);
  assert.equal(replay.data?.error?.code, 'MFA_INVALID_CODE', '重放错误码应为 MFA_INVALID_CODE');

  // 9) 恢复码登录成功，且一枚只能用一次
  const recoveryLogin = await login('root', 'admin123', firstCodes[0]);
  assert.equal(recoveryLogin.status, 200, `恢复码登录失败: ${JSON.stringify(recoveryLogin.data)}`);
  assert.equal(recoveryLogin.data.mfa, 'RECOVERY_CODE', '登录响应应标记 mfa=RECOVERY_CODE');
  const recoveryReuse = await login('root', 'admin123', firstCodes[0]);
  assert.equal(recoveryReuse.status, 401, `同一枚恢复码复用应被拒，实际 ${recoveryReuse.status}`);
  const afterRecovery = await api('/api/admin/me/mfa', { token: recoveryLogin.data.token });
  assert.equal(afterRecovery.data.recoveryCodesRemaining, 9, `用掉 1 枚后应剩 9 枚，实际 ${afterRecovery.data.recoveryCodesRemaining}`);

  // 10) 平台管理员列表带出二次验证状态
  const admins = await api('/api/admin/platform-admins', { token: recoveryLogin.data.token });
  assert.equal(admins.status, 200, `管理员列表失败: ${JSON.stringify(admins.data)}`);
  const rootRow = (admins.data.items || []).find((item) => item.login === 'root');
  assert.ok(rootRow, '管理员列表应包含 root');
  assert.equal(rootRow.mfaEnabled, true, '列表应显示 root 已开启二次验证');

  // 11) 重新生成恢复码：密码错误被拒；成功后旧恢复码作废
  const badRegenerate = await api('/api/admin/me/mfa/recovery-codes', { method: 'POST', token: recoveryLogin.data.token, body: { password: 'wrong-password', code: firstCodes[1] } });
  assert.equal(badRegenerate.status, 403, `密码错误应 403，实际 ${badRegenerate.status}`);
  assert.equal(badRegenerate.data?.error?.code, 'CURRENT_PASSWORD_INVALID', '错误码应为 CURRENT_PASSWORD_INVALID');
  const regenerated = await api('/api/admin/me/mfa/recovery-codes', { method: 'POST', token: recoveryLogin.data.token, body: { password: 'admin123', code: firstCodes[1] } });
  assert.equal(regenerated.status, 200, `重新生成恢复码失败: ${JSON.stringify(regenerated.data)}`);
  assert.equal(regenerated.data.recoveryCodes.length, 10, '重新生成应发 10 枚新恢复码');
  const oldCode = await login('root', 'admin123', firstCodes[2]);
  assert.equal(oldCode.status, 401, `旧恢复码应已作废，实际 ${oldCode.status}`);
  assert.equal(oldCode.data?.error?.code, 'MFA_INVALID_CODE', '旧恢复码错误码应为 MFA_INVALID_CODE');

  // 12) 关闭二次验证：需要密码 + 一枚有效恢复码
  const badDisable = await api('/api/admin/me/mfa/disable', { method: 'POST', token: recoveryLogin.data.token, body: { password: 'admin123', code: 'ZZZZZ-ZZZZZ' } });
  assert.equal(badDisable.status, 400, `无效恢复码应 400，实际 ${badDisable.status}`);
  assert.equal(badDisable.data?.error?.code, 'MFA_INVALID_CODE', '关闭失败错误码应为 MFA_INVALID_CODE');
  const disabled = await api('/api/admin/me/mfa/disable', { method: 'POST', token: recoveryLogin.data.token, body: { password: 'admin123', code: regenerated.data.recoveryCodes[0] } });
  assert.equal(disabled.status, 200, `关闭二次验证失败: ${JSON.stringify(disabled.data)}`);
  assert.equal(disabled.data.enabled, false, '关闭后应回到未开启');
  const afterDisable = await login('root', 'admin123');
  assert.equal(afterDisable.status, 200, '关闭后应能免二次验证登录');
  assert.equal(afterDisable.data.mfa, null, '未开启时登录响应 mfa 应为 null');

  // 13) 审计落库
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const audits = db.prepare("SELECT action, COUNT(*) n FROM audit_logs WHERE action LIKE 'PLATFORM_MFA%' GROUP BY action").all();
  const mfaLogin = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='AUTH_LOGIN' AND after_data LIKE '%RECOVERY_CODE%'").get();
  const credentials = db.prepare('SELECT COUNT(*) n FROM user_mfa_credentials').get();
  db.close();
  const auditMap = Object.fromEntries(audits.map((item) => [item.action, Number(item.n)]));
  assert.equal(auditMap.PLATFORM_MFA_SETUP, 1, `应有 1 条 PLATFORM_MFA_SETUP，实际 ${auditMap.PLATFORM_MFA_SETUP}`);
  assert.equal(auditMap.PLATFORM_MFA_ENABLE, 1, `应有 1 条 PLATFORM_MFA_ENABLE，实际 ${auditMap.PLATFORM_MFA_ENABLE}`);
  assert.equal(auditMap.PLATFORM_MFA_RECOVERY_REGENERATE, 1, `应有 1 条 PLATFORM_MFA_RECOVERY_REGENERATE，实际 ${auditMap.PLATFORM_MFA_RECOVERY_REGENERATE}`);
  assert.equal(auditMap.PLATFORM_MFA_DISABLE, 1, `应有 1 条 PLATFORM_MFA_DISABLE，实际 ${auditMap.PLATFORM_MFA_DISABLE}`);
  assert.equal(Number(mfaLogin.n), 1, '应有 1 条用恢复码登录的审计');
  assert.equal(Number(credentials.n), 0, '关闭后绑定记录应已删除');

  console.log(JSON.stringify({
    name: 'platform-mfa', pass: true,
    setup: { secretFormat: 'base32/32', otpauth: true, wrongCodeRejected: true },
    login: { requiredWithoutCode: true, wrongCodeRejected: true, totpAccepted: true, totpReplayRejected: true, recoveryAccepted: true, recoveryReuseRejected: true },
    recoveryCodes: { issued: 10, remainingAfterUse: 9, regenerated: 10, oldCodesInvalidated: true },
    disable: { passwordRequired: true, codeRequired: true, loginWithoutCodeAfterDisable: true },
    audits: auditMap,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
