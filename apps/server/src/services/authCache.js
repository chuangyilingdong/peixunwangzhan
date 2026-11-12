/**
 * 鉴权上下文缓存（2026-11-12）。
 *
 * 只缓存 `users` / `organizations` 两行；**sessions 不缓存** —— 登出、多设备撤销、
 * 改密/改角色踢下线、会话过期仍然每请求查库，语义不变（p19 / p37 钉的就是这个）。
 *
 * 失效：所有 `UPDATE users` / `UPDATE organizations` 的写入点在提交后调 invalidate*。
 * 漏掉的路径最多陈旧 AUTH_CACHE_TTL_MS（默认 5 秒）。
 *
 * 缓存层自己吞异常：resolveAuth 在 index.js 的 try 之外，不能因为缓存把请求打挂。
 */
import { createTtlCache } from './ttlCache.js';

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const ttlMs = nonNegativeInt(process.env.AUTH_CACHE_TTL_MS, 5000);
const max = nonNegativeInt(process.env.AUTH_CACHE_MAX, 2000);

const userCache = createTtlCache({ name: 'auth-user', ttlMs, max });
const orgCache = createTtlCache({ name: 'auth-org', ttlMs, max });

// 返回/存入都是拷贝：业务 handler 直接拿 rawUser 用，不能让它们改到缓存里那一行。
export function getCachedAuthUser(id) {
  try {
    const hit = userCache.get(String(id || ''));
    return hit ? { ...hit } : null;
  } catch {
    return null;
  }
}

export function cacheAuthUser(row) {
  try {
    if (row?.id) userCache.set(String(row.id), { ...row });
  } catch { /* 缓存失败只当未命中 */ }
}

export function invalidateAuthUser(id) {
  try {
    userCache.delete(String(id || ''));
  } catch { /* ignore */ }
}

export function invalidateAuthUsers(ids) {
  for (const id of ids || []) invalidateAuthUser(id);
}

export function getCachedAuthOrg(id) {
  try {
    const hit = orgCache.get(String(id || ''));
    return hit ? { ...hit } : null;
  } catch {
    return null;
  }
}

export function cacheAuthOrg(row) {
  try {
    if (row?.id) orgCache.set(String(row.id), { ...row });
  } catch { /* ignore */ }
}

export function invalidateAuthOrg(id) {
  try {
    orgCache.delete(String(id || ''));
  } catch { /* ignore */ }
}

export function authCacheStats() {
  return { user: userCache.stats(), org: orgCache.stats() };
}

/** 测试/排障用：清空并复位计数（不清 env，TTL 在模块加载时已定）。 */
export function resetAuthCache() {
  userCache.clear();
  orgCache.clear();
}
