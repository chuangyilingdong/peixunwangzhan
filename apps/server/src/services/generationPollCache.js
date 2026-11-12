/**
 * 生成轮询汇总缓存（2026-11-12）。
 *
 * 画布列表每 5 秒轮询一次，原来每次都要重算 succeeded / failed / costFen 三条聚合，
 * 还要同步读 + 解密 provider 密钥文件。这里缓存 30 秒：
 *   · summary 按 `userId|orgId` 缓存；`total` / `items` 保持实时（新任务立刻可见）。
 *   · providerInfo 单独缓存，配置变更时由管理端主动清（billingConfig / overview）。
 *
 * 失效：任务创建、成功、失败、取消、对账改状态都要清对应学生的 summary，
 * 否则「刚生成完但统计还是旧的」会持续到 TTL 到期。启动收尸/对账这种不知道
 * userId 的批量路径直接清全量（发生频率低）。
 */
import { createTtlCache, singleFlight } from './ttlCache.js';

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const ttlMs = nonNegativeInt(process.env.GENERATION_POLL_CACHE_TTL_MS, 30000);

const summaryCache = createTtlCache({ name: 'generation-summary', ttlMs, max: 5000 });
const providerCache = createTtlCache({ name: 'generation-provider', ttlMs, max: 8 });
const summaryInflight = new Map();
const providerInflight = new Map();

function summaryKey(userId, orgId) {
  return `${String(userId || '')}|${String(orgId || '')}`;
}

/**
 * 取 succeeded / failed / costFen 三个全量聚合。loader 只在未命中时调用一次，
 * 并发未命中由 single-flight 合并。这三个值不受列表过滤条件影响 —— 与改造前口径一致。
 */
export async function generationSummaryFor(userId, orgId, loader) {
  const key = summaryKey(userId, orgId);
  const hit = summaryCache.get(key);
  if (hit !== undefined) return hit;
  return singleFlight(summaryInflight, key, async () => {
    const fresh = summaryCache.get(key);
    if (fresh !== undefined) return fresh;
    const value = await loader();
    if (value !== undefined) summaryCache.set(key, value);
    return value;
  });
}

export async function generationProviderInfoFor(loader) {
  const hit = providerCache.get('current');
  if (hit !== undefined) return hit;
  return singleFlight(providerInflight, 'current', async () => {
    const fresh = providerCache.get('current');
    if (fresh !== undefined) return fresh;
    const value = await loader();
    if (value !== undefined) providerCache.set('current', value);
    return value;
  });
}

/** 清一个学生的汇总（任务状态变化时调用）。 */
export function invalidateGenerationSummaryFor(userId) {
  const prefix = `${String(userId || '')}|`;
  try {
    summaryCache.deleteWhere((key) => key.startsWith(prefix));
  } catch { /* ignore */ }
}

/** 不知道 userId 的批量路径（启动收尸、对账、attempt 状态回填）。 */
export function invalidateGenerationSummaries() {
  try {
    summaryCache.clear();
  } catch { /* ignore */ }
}

/** provider 渠道/密钥配置变化后调用（否则列表里的 configured/模型信息最多旧 30 秒）。 */
export function invalidateGenerationProviderInfo() {
  try {
    providerCache.clear();
  } catch { /* ignore */ }
}

export function generationPollCacheStats() {
  return { summary: summaryCache.stats(), provider: providerCache.stats() };
}

/** 测试用：清空两个缓存。 */
export function resetGenerationPollCache() {
  summaryCache.clear();
  providerCache.clear();
}
