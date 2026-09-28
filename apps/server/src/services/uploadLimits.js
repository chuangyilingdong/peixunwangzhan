import { errors, rows, arows } from '../lib.js';
const active = new Map();
function positive(name, fallback, max = Number.MAX_SAFE_INTEGER) { const n = Number(process.env[name] || fallback); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback; }
/**
 * 限额配置。
 *
 * ⚠️ 2026-09-28 用户口径：**「上传失败：个人上传频率达到上限。这个限制取消。」**
 *    原话就是这两句，说的是 `FILE_UPLOAD_USER_PER_HOUR`（默认 20 次/小时）—— 运营在课时编排里
 *    一节课连传十来个教学素材（PPT/教案）就撞上了。**频率那道已经整体删掉**（个人 + 机构两条都删：
 *    它们是同一类闸，留着机构那条只是把同一个工作流推后 10 倍撞上）。
 *    `FILE_UPLOAD_USER_PER_HOUR` / `FILE_UPLOAD_ORG_PER_HOUR` 这两个 env **现在完全不起作用**
 *    （别再靠调大它来"修"某个上传报错 —— 那道闸已经不存在了；守卫 p165 钉着这件事）。
 *
 * ⚠️ 下面**两类仍然保留**，它们不是频次闸、用户也没让取消：
 *    · `maxConcurrent` —— **同时在传**的数量（不是总量）。界面是一次传一个，正常使用撞不到；
 *      它的作用是别让一个客户端同时占一堆上传连接。
 *    · `userBytes` / `orgBytes` —— **容量**配额（个人 500MB / 机构 5GB，都是累计占用）。
 *      ⚠️ 这两个值偏小（一份课件就几十 MB），要是哪天报「个人文件容量配额已用尽」，
 *      调 `FILE_UPLOAD_USER_QUOTA_BYTES` / `FILE_UPLOAD_ORG_QUOTA_BYTES` 或找用户确认新口径。
 */
function limits() { return { maxConcurrent: positive('FILE_UPLOAD_MAX_CONCURRENT', 3, 100), userBytes: positive('FILE_UPLOAD_USER_QUOTA_BYTES', 500 * 1024 * 1024, 100 * 1024 * 1024 * 1024), orgBytes: positive('FILE_UPLOAD_ORG_QUOTA_BYTES', 5 * 1024 * 1024 * 1024, 1024 * 1024 * 1024 * 1024) }; }
function key(scope, value) { return `${scope}:${value || 'anonymous'}`; }
async function currentBytes(scope, value) { const clause = scope === 'org' ? 'owner_org_id=?' : 'owner_user_id=?'; return Number((await arows(`SELECT COALESCE(SUM(file_size),0) AS bytes FROM file_assets WHERE ${clause} AND storage_kind='INTERNAL_PROXY' AND status != 'REMOVED'`, [value])).at(0)?.bytes || 0); }
export async function reserveUpload({ userId, orgId, bytes }) {
  const cfg = limits();
  const userKey = key('user', userId); const orgKey = key('org', orgId);
  if ((active.get(userKey) || 0) >= cfg.maxConcurrent || (active.get(orgKey) || 0) >= cfg.maxConcurrent) throw errors.tooMany('上传并发数已达到上限，请稍后再试', 'UPLOAD_CONCURRENCY_LIMIT', { retryAfterSeconds: 10 });
  const size = Number(bytes || 0);
  const userBytes = await currentBytes('user', userId);
  const orgBytes = await currentBytes('org', orgId);
  if (userBytes + size > cfg.userBytes) throw errors.conflict('个人文件容量配额已用尽', 'UPLOAD_USER_QUOTA_EXCEEDED', { usedBytes: userBytes, quotaBytes: cfg.userBytes });
  if (orgBytes + size > cfg.orgBytes) throw errors.conflict('机构文件容量配额已用尽', 'UPLOAD_ORG_QUOTA_EXCEEDED', { usedBytes: orgBytes, quotaBytes: cfg.orgBytes });
  active.set(userKey, (active.get(userKey) || 0) + 1);
  active.set(orgKey, (active.get(orgKey) || 0) + 1);
  let released = false;
  return () => { if (released) return; released = true; for (const k of [userKey, orgKey]) { const n = (active.get(k) || 1) - 1; if (n > 0) active.set(k, n); else active.delete(k); } };
}
export function uploadLimitConfig() { return limits(); }
