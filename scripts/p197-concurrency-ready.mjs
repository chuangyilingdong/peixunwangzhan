/**
 * P197 「100 路并发」的三道配套守卫（2026-11-01，C1/C2/C3）。
 *
 * 背景：B2 把归档从任务完成路径上摘掉之后，生成侧才敢从 8 路开到 100 路。
 * 但"开到 100"不是改一个数字就完事，另外三件缺一不可：
 *   ① 数据库得能扛住每轮的队列扫描（`(status, next_attempt_at, created_at)` 索引）；
 *   ② 100 条任务不能在同一秒向上游提交 100 个"新建任务"（提交令牌桶）；
 *   ③ 100 条任务不能按固定间隔一起轮询（要抖动，否则是 20 RPS 的方波）。
 *
 * 守卫跑法：node scripts/p197-concurrency-ready.mjs（纯逻辑 + 静态检查，不连库）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (error) { failures += 1; console.error(`  ✗ ${label} —— ${error.message}`); }
};
const read = (p) => fs.readFileSync(p, 'utf8');

/* ───────── ① 索引 ───────── */
await check('① schema 里有队列索引 (status, next_attempt_at, created_at)', () => {
  const schema = read('packages/database/src/schema.js');
  assert.match(schema, /idx_generation_jobs_queue ON generation_jobs\(status, next_attempt_at, created_at\)/);
});

/* ───────── ② 提交令牌桶：行为 ───────── */
// 环境变量必须在 import 之前设：模块在加载时就把参数读成常量。
process.env.AI_UPSTREAM_SUBMIT_QPS = '20';
process.env.AI_UPSTREAM_SUBMIT_BURST = '2';
const gate = await import('../apps/server/src/services/upstreamSubmitGate.js');

await check('② 突发额度是"立刻"可用的（前 burst 次几乎不等待）', async () => {
  gate.resetUpstreamSubmitGate();
  const startedAt = Date.now();
  await gate.acquireUpstreamSubmitToken();
  await gate.acquireUpstreamSubmitToken();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 80, `前两次就等了 ${elapsed}ms（突发额度没生效）`);
});

await check('② 超出突发后按 QPS 排队（20/s 再取 2 个约 100ms）', async () => {
  const startedAt = Date.now();
  await gate.acquireUpstreamSubmitToken();
  await gate.acquireUpstreamSubmitToken();
  const elapsed = Date.now() - startedAt;
  // 允许宽松区间：CI/机器负载会让计时偏大，但绝不能"不排队"
  assert.ok(elapsed >= 50, `只等了 ${elapsed}ms（限流没起作用）`);
  assert.ok(elapsed < 1000, `等了 ${elapsed}ms（限流速得太狠）`);
});

await check('② 桶不会溢出（空闲后再取仍然只有 burst 的量）', async () => {
  gate.resetUpstreamSubmitGate();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const before = gate.upstreamSubmitGateState().tokens;
  assert.ok(before <= 2 + 0.01, `空闲后令牌涨到 ${before}，超过突发上限 2`);
});

/* ───────── ② 提交令牌桶：接线 ───────── */
await check('② 生成链路的三处上游提交都过令牌桶（同步/异步/作词）', () => {
  const source = read('apps/server/src/routes/aiGeneration.js');
  assert.match(source, /import \{ acquireUpstreamSubmitToken \}/);
  const calls = (source.match(/await acquireUpstreamSubmitToken\(\)/g) || []).length;
  assert.ok(calls >= 3, `只有 ${calls} 处拿了令牌`);
});

/* ───────── ③ 轮询抖动 ───────── */
await check('③ 上游轮询带抖动（不是固定间隔一起打）', () => {
  const provider = read('apps/server/src/services/openaiCompatibleProvider.js');
  assert.match(provider, /function withPollJitter\(/);
  assert.match(provider, /setTimeout\(resolve, withPollJitter\(waitMs\)\)/);
  assert.ok(!/setTimeout\(resolve, waitMs\)/.test(provider), '还有地方按固定间隔睡（会和别人同步）');
});

/* ───────── C3：并发上限 ───────── */
await check('③ 并发上限已放到 500（原来写死 16，100 会被夹回去）', () => {
  const source = read('apps/server/src/routes/aiGeneration.js');
  assert.match(source, /Math\.min\(500, Number\(process\.env\.AI_GENERATION_CONCURRENCY\)/);
  assert.ok(!/Math\.min\(16, Number\(process\.env\.AI_GENERATION_CONCURRENCY\)/.test(source));
});

await check('③ .env.example 记录了提交限流与归档队列的参数', () => {
  const env = read('deploy/production/.env.example');
  for (const key of ['AI_UPSTREAM_SUBMIT_QPS', 'AI_UPSTREAM_SUBMIT_BURST', 'AI_ARCHIVE_CONCURRENCY', 'AI_ARCHIVE_DEADLINE_MS']) {
    assert.match(env, new RegExp(`^${key}=`, 'm'), `缺 ${key}`);
  }
});

assert.equal(failures, 0, `P197 有 ${failures} 条断言没过`);
console.log('PASS: 100 路并发的三道配套（索引 / 提交令牌桶 / 轮询抖动）');
