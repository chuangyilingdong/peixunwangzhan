/**
 * 异步生成队列的**调度规则**（纯函数，不碰 DB / 网络 / 环境变量，可直接单测）。
 *
 * 为什么单独拆出来（2026-11-01）：
 *   8 路并发本身没解决"模态不分家"。8 条 H3 视频各占一个槽 8-9 分钟，就能把 8 个槽全占满 ——
 *   生产实测 2026-10-30：三条图片任务 08:47 / 09:04 / 09:05 建好，09:48 / 09:49 才开始，
 *   **等了 43-61 分钟**，而它们自己只跑 50 秒。学生看到的是"图一直不出来"。
 *
 * 规则（三条，缺一条都会退回原来的问题）：
 *   ① **轻模态优先挑**：队列里排着 1000 条视频时，后进来的一张图片可能排在队尾。
 *      如果按先进先出取，它要等前面全部取完才被扫到 —— 这正是那次 61 分钟的机制。
 *   ② **视频有独立上限**：`并发 − 预留`。剩下的槽永远留给轻模态，视频再多也占不满。
 *   ③ **视频之间仍先进先出**：不插队，避免长任务被后来者反复挤压（饿死）。
 *
 * 轻模态自己**不设上限**：图片/文本几十秒就结束，就算临时占满全部槽，也只堵 50 秒。
 * 给它们设上限反而会在"1000 人同时点图片"时人为变慢。
 *
 * ⚠️ 预留值必须落在 `0 ≤ 预留 ≤ 并发 − 1`，否则视频永远排不上（`heavyLimit` 至少要留 1）。
 */

/** 重模态：一条任务会长时间占用槽位。只有视频属于这一类。 */
export const HEAVY_ASYNC_MODALITIES = new Set(['VIDEO']);

export function isHeavyAsyncModality(modality) {
  return HEAVY_ASYNC_MODALITIES.has(String(modality || '').trim().toUpperCase());
}

/**
 * 解析"给轻模态预留几路"。空值 / 非法值走默认 2，并夹到 `0 … 并发−1`。
 * 单独抽出来是因为**环境变量是字符串**：`AI_GENERATION_RESERVED_LIGHT=''` 时 `Number('')` 是 0，
 * 不特判就会把预留静默变成 0 —— 那等于这个修复没上线。
 */
export function resolveReservedLight(rawValue, concurrency) {
  const raw = String(rawValue ?? '').trim();
  const parsed = raw ? Number(raw) : NaN;
  const wanted = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 2;
  const maxAllowed = Math.max(0, Math.floor(Number(concurrency) || 0) - 1);
  return Math.max(0, Math.min(wanted, maxAllowed));
}

/** 视频当前还能开几条。 */
export function heavySlotLimit(concurrency, reservedLight) {
  return Math.max(1, Math.floor(Number(concurrency) || 0) - Math.floor(Number(reservedLight) || 0));
}

/**
 * 找一条现在就能开的任务，返回它在队列里的下标；没有可开的返回 -1。
 *
 * 返回下标（而不是任务本身）是因为调用方要 `splice` 掉它 —— 让"挑选"和"出队"是同一个动作，
 * 不会出现两个并发路径各挑到同一条。
 *
 * @param {Array<{modality?: string}>} queue
 * @param {{active:number, activeHeavy:number, concurrency:number, reservedLight:number}} state
 * @returns {number} 下标，或 -1
 */
export function pickNextStartableIndex(queue, state) {
  if (!Array.isArray(queue) || queue.length === 0) return -1;
  const concurrency = Math.max(1, Math.floor(Number(state?.concurrency) || 0));
  const active = Math.max(0, Math.floor(Number(state?.active) || 0));
  if (active >= concurrency) return -1;
  const activeHeavy = Math.max(0, Math.floor(Number(state?.activeHeavy) || 0));
  const reservedLight = Math.max(0, Math.floor(Number(state?.reservedLight) || 0));
  const heavyLimit = heavySlotLimit(concurrency, reservedLight);

  let firstHeavy = -1;
  for (let i = 0; i < queue.length; i += 1) {
    // ① 轻模态优先：一旦遇到就立刻返回，哪怕前面排着视频
    if (!isHeavyAsyncModality(queue[i]?.modality)) return i;
    // ③ 视频保持先进先出：只记第一条"现在能开"的
    if (firstHeavy < 0 && activeHeavy < heavyLimit) firstHeavy = i;
  }
  // ② 没有轻模态可跑时才轮到视频；视频槽已满就一条都不开，把预留让出来
  return firstHeavy;
}
