/**
 * 作品二进制直传 OSS 的上传票据（2026-11-12）。
 *
 * 协议：客户端先调 prepare 拿「预签名 PUT URL + 票据」，把文件直接传到 OSS，
 * 再调 direct 提交文本与引用。服务端不再读取大 body。
 *
 * 票据是 HMAC 签名的 JSON（不落库）：绑定 userId / orgId / 每个文件的 key / size / md5，
 * 30 分钟过期；finalize 时验签 + 校验对象确实存在且大小一致。
 *
 * ⚠️ 签名密钥优先 `UPLOAD_TICKET_SECRET`，缺省回退 `RUNTIME_GATEWAY_SECRET`；
 *    两者都没有时 direct upload 视为未启用（prepare 返回 501）。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { errors } from '../lib.js';
import { withPrefix } from './objectStorage.js';

const TICKET_TTL_MS = 30 * 60 * 1000;

function ticketSecret() {
  return String(process.env.UPLOAD_TICKET_SECRET || process.env.RUNTIME_GATEWAY_SECRET || '').trim();
}

export function directUploadEnabled() {
  return Boolean(ticketSecret());
}

function sign(body) {
  return createHmac('sha256', ticketSecret()).update(body, 'utf8').digest('base64url');
}

/**
 * 生成票据。payload 至少包含 `{ userId, orgId, files }`；
 * files 里只放**二进制**文件（文本走 finalize body）。
 */
export function createUploadTicket(payload, { ttlMs = TICKET_TTL_MS } = {}) {
  if (!directUploadEnabled()) throw errors.serviceUnavailable('直传通道未配置', 'DIRECT_UPLOAD_UNAVAILABLE');
  const now = Date.now();
  const ticket = {
    v: 1,
    iat: now,
    exp: now + Math.max(1, Number(ttlMs) || TICKET_TTL_MS),
    uploadId: randomUUID(),
    ...payload,
  };
  const body = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url');
  return { token: `${body}.${sign(body)}`, payload: ticket, expiresAt: new Date(ticket.exp).toISOString() };
}

export function verifyUploadTicket(token) {
  if (!directUploadEnabled()) throw errors.serviceUnavailable('直传通道未配置', 'DIRECT_UPLOAD_UNAVAILABLE');
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) throw errors.badRequest('上传票据无效', 'UPLOAD_TICKET_INVALID');
  const expected = sign(body);
  const provided = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    throw errors.badRequest('上传票据签名不正确', 'UPLOAD_TICKET_INVALID');
  }
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw errors.badRequest('上传票据内容损坏', 'UPLOAD_TICKET_INVALID');
  }
  if (!payload || payload.v !== 1 || !Number.isFinite(payload.exp)) {
    throw errors.badRequest('上传票据内容损坏', 'UPLOAD_TICKET_INVALID');
  }
  if (payload.exp <= Date.now()) throw errors.badRequest('上传票据已过期', 'UPLOAD_TICKET_EXPIRED');
  if (!payload.userId || !payload.orgId || !Array.isArray(payload.files)) {
    throw errors.badRequest('上传票据内容不完整', 'UPLOAD_TICKET_INVALID');
  }
  return payload;
}

/** 对象 key（带 OSS_PREFIX 的完整键）：随机 uploadId 保证不可猜，扩展名只留安全字符。 */
export function directUploadKey({ orgId, userId, uploadId, index, name }) {
  const extension = extname(String(name || '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 16);
  const relative = `direct-upload/${orgId}/${userId}/${uploadId}/${index}${extension}`;
  return withPrefix(relative);
}
