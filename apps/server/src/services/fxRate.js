/**
 * USD → CNY 汇率（2026-11-04 用户确认：RunningHub.ai 的展示和成本计算都按 **固定 6.71749**）。
 *
 * 为什么还留一个服务：
 *   · 展示（钱包）和计算（upstreamCost）共用同一个入口，以后要改回实时/换数字只改这里；
 *   · 保留 `getUsdCnyRate()` 的异步签名，调用方不用动。
 *
 * 口径：
 *   · 只给 RunningHub（美元计价）用；xkwuai 仍按用户口径 1:1，文本/国内站是人民币；
 *   · 固定汇率不存在"拿不到"的情况，成本一定能算出来；
 *   · 改价不追溯：历史 compute_attempts / usage_records 里已落库的 cost_fen 不重算。
 */
const FIXED_USD_CNY_RATE = 6.71749;
export const USD_CNY_RATE = FIXED_USD_CNY_RATE;

/** 固定汇率 6.71749；异步签名是为了以后能换回实时接口。 */
export async function getUsdCnyRate() {
  return {
    rate: FIXED_USD_CNY_RATE,
    source: 'fixed',
    fetchedAt: null,
    updatedAt: null,
    stale: false,
    cached: true,
  };
}

/** 兼容旧调用（固定汇率没有缓存）。 */
export function resetUsdCnyRateCache() {}
