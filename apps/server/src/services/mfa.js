/**
 * 平台管理员二次验证（TOTP + 恢复码）的状态读写与校验。
 * 表 user_mfa_credentials：secret 为 base32 明文，恢复码只存 sha256(pepper) 哈希。
 */
import { errors, json, nowIso, parseJson, q, row } from '../lib.js';
import {
  MFA_CONSTANTS,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  recoveryCodeMatches,
  verifyTotp,
} from './totp.js';

export function mfaCredential(userId) {
  return row('SELECT * FROM user_mfa_credentials WHERE user_id=?', [userId]) || null;
}

export function mfaSummary(userId) {
  const record = mfaCredential(userId);
  if (!record) return { enabled: false, status: 'NONE', recoveryCodesRemaining: 0, enabledAt: null, setupPending: false };
  const codes = parseJson(record.recovery_codes, []);
  const enabled = record.status === 'ENABLED';
  return {
    enabled,
    status: record.status,
    recoveryCodesRemaining: enabled ? codes.filter((item) => !item?.usedAt).length : 0,
    enabledAt: record.enabled_at || null,
    setupPending: record.status === 'PENDING',
  };
}

export function mfaEnabledFor(userId) {
  const record = mfaCredential(userId);
  return !!record && record.status === 'ENABLED';
}

export function startMfaSetup(userId, { account, issuer }) {
  const record = mfaCredential(userId);
  if (record && record.status === 'ENABLED') throw errors.conflict('该账号已开启二次验证，请先关闭后再重新绑定', 'MFA_ALREADY_ENABLED');
  const secret = generateTotpSecret();
  const now = nowIso();
  q(
    `INSERT INTO user_mfa_credentials(user_id,secret,status,recovery_codes,last_totp_counter,enabled_at,created_at,updated_at)
     VALUES (?,?,'PENDING','[]',NULL,NULL,?,?)
     ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,status='PENDING',recovery_codes='[]',last_totp_counter=NULL,enabled_at=NULL,updated_at=excluded.updated_at`,
    [userId, secret, now, now],
  );
  return {
    secret,
    otpauthUri: otpauthUri({ secret, account, issuer }),
    digits: MFA_CONSTANTS.digits,
    period: MFA_CONSTANTS.period,
  };
}

export function enableMfa(userId, code) {
  const record = mfaCredential(userId);
  if (!record) throw errors.badRequest('请先生成绑定密钥', 'MFA_SETUP_REQUIRED');
  if (record.status === 'ENABLED') throw errors.conflict('该账号已开启二次验证', 'MFA_ALREADY_ENABLED');
  const matched = verifyTotp(record.secret, code, { minCounter: record.last_totp_counter });
  if (!matched) throw errors.badRequest('动态验证码不正确，请确认手机时间与验证器一致后重试', 'MFA_INVALID_CODE');
  const plainCodes = generateRecoveryCodes();
  const stored = plainCodes.map((item) => ({ hash: hashRecoveryCode(item), usedAt: null, createdAt: nowIso() }));
  q(
    "UPDATE user_mfa_credentials SET status='ENABLED',recovery_codes=?,last_totp_counter=?,enabled_at=?,updated_at=? WHERE user_id=?",
    [json(stored), matched.counter, nowIso(), nowIso(), userId],
  );
  return { recoveryCodes: plainCodes, ...mfaSummary(userId) };
}

export function regenerateRecoveryCodes(userId, code) {
  const record = mfaCredential(userId);
  if (!record || record.status !== 'ENABLED') throw errors.badRequest('该账号尚未开启二次验证', 'MFA_NOT_ENABLED');
  const result = verifyMfaChallenge(userId, code);
  if (!result.ok) throw errors.badRequest(result.reason === 'MISSING' ? '请输入动态验证码或恢复码' : '验证码不正确', 'MFA_INVALID_CODE');
  const plainCodes = generateRecoveryCodes();
  const stored = plainCodes.map((item) => ({ hash: hashRecoveryCode(item), usedAt: null, createdAt: nowIso() }));
  q('UPDATE user_mfa_credentials SET recovery_codes=?,updated_at=? WHERE user_id=?', [json(stored), nowIso(), userId]);
  return { recoveryCodes: plainCodes, ...mfaSummary(userId) };
}

export function disableMfa(userId, code) {
  const record = mfaCredential(userId);
  if (!record || record.status !== 'ENABLED') throw errors.badRequest('该账号尚未开启二次验证', 'MFA_NOT_ENABLED');
  const result = verifyMfaChallenge(userId, code);
  if (!result.ok) throw errors.badRequest(result.reason === 'MISSING' ? '请输入动态验证码或恢复码' : '验证码不正确', 'MFA_INVALID_CODE');
  q('DELETE FROM user_mfa_credentials WHERE user_id=?', [userId]);
  return mfaSummary(userId);
}

/**
 * 校验一次二次验证挑战：先按 6 位动态码校验（并记录时间步防重放），
 * 再尝试恢复码（一次性，命中后立即标记已用）。
 */
export function verifyMfaChallenge(userId, code) {
  const record = mfaCredential(userId);
  if (!record || record.status !== 'ENABLED') return { ok: false, reason: 'NOT_ENABLED' };
  const supplied = String(code || '').trim();
  if (!supplied) return { ok: false, reason: 'MISSING' };

  const matched = verifyTotp(record.secret, supplied, { minCounter: record.last_totp_counter });
  if (matched) {
    q('UPDATE user_mfa_credentials SET last_totp_counter=?,updated_at=? WHERE user_id=?', [matched.counter, nowIso(), userId]);
    return { ok: true, method: 'TOTP' };
  }

  const codes = parseJson(record.recovery_codes, []);
  for (let index = 0; index < codes.length; index += 1) {
    const item = codes[index];
    if (!item || item.usedAt || !recoveryCodeMatches(supplied, item.hash)) continue;
    codes[index] = { ...item, usedAt: nowIso() };
    q('UPDATE user_mfa_credentials SET recovery_codes=?,updated_at=? WHERE user_id=?', [json(codes), nowIso(), userId]);
    return { ok: true, method: 'RECOVERY_CODE', recoveryCodesRemaining: codes.filter((entry) => !entry?.usedAt).length };
  }
  return { ok: false, reason: 'INVALID' };
}
