/**
 * TOTP（RFC 6238）/ HOTP（RFC 4226）自实现，只依赖 node:crypto 的 HMAC-SHA1。
 * 不引入第三方库：验证器 App 用标准 otpauth:// 协议，密钥用 base32 明文录入。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AUTH_PEPPER } from '../config.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD_SECONDS = 30;
// ±1 个时间步：容忍验证器与服务器 30 秒内的时钟偏差
const DEFAULT_WINDOW = 1;
const RECOVERY_CODE_COUNT = 10;

export function base32Encode(buffer) {
  const bytes = Buffer.from(buffer);
  let output = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(value) {
  const input = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!input) return Buffer.alloc(0);
  const bytes = [];
  let bits = 0;
  let accumulator = 0;
  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 160 位密钥（20 字节 = 32 个 base32 字符），与 Google Authenticator 默认一致
export function generateTotpSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

export function hotp(secret, counter, digits = DEFAULT_DIGITS) {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secret, { timestamp = Date.now(), step = DEFAULT_PERIOD_SECONDS, digits = DEFAULT_DIGITS } = {}) {
  return hotp(secret, Math.floor(timestamp / 1000 / step), digits);
}

/**
 * 校验动态码。返回命中的时间步（用于防重放），不匹配返回 null。
 * minCounter 表示「大于该时间步的码才算有效」，避免同一个码在窗口内被重复使用。
 */
export function verifyTotp(secret, code, {
  timestamp = Date.now(),
  step = DEFAULT_PERIOD_SECONDS,
  digits = DEFAULT_DIGITS,
  window = DEFAULT_WINDOW,
  minCounter = null,
} = {}) {
  const supplied = String(code || '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(supplied)) return null;
  const current = Math.floor(timestamp / 1000 / step);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = current + offset;
    if (candidate < 0) continue;
    if (minCounter !== null && minCounter !== undefined && candidate <= Number(minCounter)) continue;
    const expected = hotp(secret, candidate, digits);
    if (expected.length === supplied.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
      return { counter: candidate };
    }
  }
  return null;
}

export function otpauthUri({ secret, account, issuer = 'AI魔法学院', digits = DEFAULT_DIGITS, period = DEFAULT_PERIOD_SECONDS }) {
  const label = `${issuer}:${account}`;
  const params = new URLSearchParams({ secret: base32Encode(base32Decode(secret)), issuer, algorithm: 'SHA1', digits: String(digits), period: String(period) });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(10)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function normalizeRecoveryCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// 恢复码是 50 位随机量 + 登录限速，sha256 + pepper 足够；只在库里存哈希
export function hashRecoveryCode(code) {
  return createHash('sha256').update(`${AUTH_PEPPER}:mfa-recovery:${normalizeRecoveryCode(code)}`).digest('hex');
}

export function recoveryCodeMatches(code, storedHash) {
  const actual = Buffer.from(hashRecoveryCode(code), 'hex');
  const expected = Buffer.from(String(storedHash || ''), 'hex');
  return actual.length === expected.length && actual.length > 0 && timingSafeEqual(actual, expected);
}

export const MFA_CONSTANTS = Object.freeze({
  digits: DEFAULT_DIGITS,
  period: DEFAULT_PERIOD_SECONDS,
  window: DEFAULT_WINDOW,
  recoveryCodeCount: RECOVERY_CODE_COUNT,
});
