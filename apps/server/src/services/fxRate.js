/**
 * USD → CNY 实时汇率（2026-11-04 用户口径：RunningHub.ai 按实时汇率展示和计算）。
 *
 * 来源：open.er-api.com（免 Key，每日更新；生产实测可访问）。
 * 口径：
 *   · 缓存 1 小时 —— 汇率一天才变一次，5 秒轮询的监控页不能每次打外网；
 *   · 拿不到时回落到 7.2 并标 `stale:true`，绝不静默用 0（成本会被算成 0）；
 *   · 只给 RunningHub（美元计价）用；xkwuai 仍按用户口径 1:1，文本/国内站是人民币。
 */
const SOURCE_URL = 'https://open.er-api.com/v6/latest/USD';
const CACHE_TTL_MS = 60 * 60_000;
const TIMEOUT_MS = 8000;
const FALLBACK_RATE = 7.2;

let cache = null; // { at, value }
let inflight = null;

function validRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : null;
}

/** 拿美元兑人民币汇率；`refresh=true` 强制刷新。永不抛错。 */
export async function getUsdCnyRate({ refresh = false } = {}) {
  const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
  if (!refresh && fresh) return { ...cache.value, cached: true };
  if (!inflight) {
    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(SOURCE_URL, { headers: { Accept: 'application/json' }, signal: controller.signal });
        const payload = await response.json().catch(() => null);
        const rate = validRate(payload?.rates?.CNY);
        if (!response.ok || !rate) throw new Error(`汇率接口异常（HTTP ${response.status}）`);
        const updatedAt = Number(payload?.time_last_update_unix) > 0
          ? new Date(Number(payload.time_last_update_unix) * 1000).toISOString()
          : null;
        const value = { rate, source: 'open.er-api.com', fetchedAt: new Date().toISOString(), updatedAt, stale: false };
        cache = { at: Date.now(), value };
        return value;
      } catch (error) {
        // 失败也缓存 5 分钟：否则汇率接口挂掉时，每一笔生成/每次钱包轮询都要等 8 秒超时。
        const retryInMs = 5 * 60_000;
        const staleValue = cache
          ? { ...cache.value, stale: true, error: String(error?.message || error).slice(0, 120) }
          : {
            rate: FALLBACK_RATE,
            source: 'fallback',
            fetchedAt: new Date().toISOString(),
            updatedAt: null,
            stale: true,
            error: String(error?.message || error).slice(0, 120),
          };
        cache = { at: Date.now() - (CACHE_TTL_MS - retryInMs), value: staleValue };
        return staleValue;
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();
  }
  return { ...(await inflight), cached: false };
}

/** 守卫用：清缓存。 */
export function resetUsdCnyRateCache() {
  cache = null;
  inflight = null;
}
