/**
 * 上游**提交**侧的令牌桶（2026-11-01，C2）。
 *
 * 解决什么：平台内是 100 路并发（`AI_GENERATION_CONCURRENCY`），但这 100 条会在同一秒
 * 一起 `provider.generate()` —— 对上游就是 100 次提交请求打在同一条时间线上。
 * 「不限并发」不等于「不限 QPS」，多数供应商对**新建任务**有独立限流，撞上就是整批 429。
 *
 * 为什么只限"提交"、不限"整条生成"：一条 H3 要跑 8-9 分钟，绝大部分时间是在等上游出结果，
 * 那是轮询（低 QPS）。真正需要削峰的是**创建任务**那个瞬间。所以桶放在 `provider.generate()`
 * 之前，拿到令牌就进去等结果；不拿到就排队 —— 排队只有几秒，相比 8 分钟的生成可以忽略。
 *
 * 参数（都可按渠道实际配额调）：
 *   AI_UPSTREAM_SUBMIT_QPS    每秒放行几个提交，默认 10
 *   AI_UPSTREAM_SUBMIT_BURST  允许的瞬时突发，默认 10（等于一整秒的量）
 *
 * ⚠️ 这是**进程级**的。改成多进程（D 阶段）后要换成跨进程的桶（Redis/DB），否则总量 = 进程数 × QPS。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function positive(raw, fallback, max) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

export const SUBMIT_QPS = positive(process.env.AI_UPSTREAM_SUBMIT_QPS, 10, 1000);
export const SUBMIT_BURST = Math.max(1, Math.floor(positive(process.env.AI_UPSTREAM_SUBMIT_BURST, 10, 1000)));

let tokens = SUBMIT_BURST;
let lastRefillAt = Date.now();
let waiting = 0;

/** 按经过的时间补令牌（惰性：不需要定时器）。 */
function refill(now) {
  const elapsed = Math.max(0, now - lastRefillAt);
  if (elapsed <= 0) return;
  tokens = Math.min(SUBMIT_BURST, tokens + (elapsed / 1000) * SUBMIT_QPS);
  lastRefillAt = now;
}

/**
 * 取一个提交令牌（拿不到就等）。**没有上限等待**：上游配额是我们自己的，
 * 与其 429 掉学生，不如让它在队列里多排几秒。
 */
export async function acquireUpstreamSubmitToken() {
  waiting += 1;
  try {
    for (;;) {
      const now = Date.now();
      refill(now);
      if (tokens >= 1) { tokens -= 1; return { waitedMs: 0 }; }
      // 还差多少令牌 → 还要等多少毫秒；单次最多睡 200ms，避免长时间挂住后对时间不敏感
      const deficit = 1 - tokens;
      const waitMs = Math.max(5, Math.min(200, Math.ceil((deficit / SUBMIT_QPS) * 1000)));
      await sleep(waitMs);
    }
  } finally {
    waiting -= 1;
  }
}

/** 诊断（守卫与运维看）：当前桶里还有多少、几个在排队。 */
export function upstreamSubmitGateState() {
  refill(Date.now());
  return { qps: SUBMIT_QPS, burst: SUBMIT_BURST, tokens: Number(tokens.toFixed(3)), waiting };
}

/** 守卫用：把桶恢复成满的（测试之间互不影响）。 */
export function resetUpstreamSubmitGate() {
  tokens = SUBMIT_BURST;
  lastRefillAt = Date.now();
  waiting = 0;
}
