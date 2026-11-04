/**
 * 监控台 · 供应商钱包采样与趋势（2026-11-04）。
 *
 * 为什么要有这一层：
 *   · 原来监控页的「余额趋势」只有**本次打开页面后**的内存点，刷新就没了，看不出 24h / 7d 的变化；
 *   · 这里每 5 分钟把三家余额落一行（失败也落，ok=0），页面只读历史。
 *
 * 口径：
 *   · 只用于展示，不参与计费/对账；
 *   · cny 用 walletAccounts.js 已算好的口径（RH 全球 ×7.2、RH 国内原币、xkwuai 1:1）；
 *   · 8 天后自动清理；采样失败不抛到启动路径（缺表/上游抖动都只 warn）。
 */
import { randomUUID } from 'node:crypto';
import { aq, arows } from '../lib.js';
import { getWalletBalances } from './walletAccounts.js';

const SAMPLE_INTERVAL_MS = 5 * 60_000;
const RETENTION_DAYS = 8;
const MAX_HOURS = 7 * 24;

let timer = null;
let firstTimer = null;
let lastPruneAt = 0;

/** 采一次样并落库。返回写入行数。 */
export async function recordWalletSamples() {
  const wallets = await getWalletBalances({ refresh: true });
  const at = new Date().toISOString();
  const rows = (wallets.sources || []).map((item) => ({
    id: `ws_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    sourceId: String(item.id || '').slice(0, 32),
    amount: item.amount === null || item.amount === undefined ? null : Number(item.amount),
    currency: item.currency ? String(item.currency).slice(0, 16) : null,
    cny: item.cny === null || item.cny === undefined ? null : Number(item.cny),
    ok: item.ok ? 1 : 0,
    fetchedAt: String(wallets.fetchedAt || at).slice(0, 32),
    createdAt: at,
  }));
  for (const row of rows) {
    await aq(`INSERT INTO monitor_wallet_samples(id,source_id,amount,currency,cny,ok,fetched_at,created_at)
              VALUES (?,?,?,?,?,?,?,?)`,
    [row.id, row.sourceId, row.amount, row.currency, row.cny, row.ok, row.fetchedAt, row.createdAt]);
  }
  if (Date.now() - lastPruneAt > 60 * 60_000) {
    lastPruneAt = Date.now();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5).toISOString();
    await aq('DELETE FROM monitor_wallet_samples WHERE created_at < ?', [cutoff]);
  }
  return { inserted: rows.length };
}

/** 进程启动时调一次；测试不调（否则定时器会拖住进程）。 */
export function initWalletSampler() {
  if (timer) return timer;
  const run = () => {
    recordWalletSamples().catch((error) => console.warn('[钱包采样] 失败：' + (error?.message || error)));
  };
  const first = setTimeout(run, 15_000);
  first.unref?.();
  firstTimer = first;
  timer = setInterval(run, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

/** 停掉定时器（只给测试/优雅退出用）。 */
export function stopWalletSampler() {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  timer = null;
  firstTimer = null;
}

/** 按时间桶聚合（5/15/60 分钟），返回每家一条 + 合计一条。 */
export async function getWalletHistory({ hours = 24 } = {}) {
  const safeHours = Math.min(MAX_HOURS, Math.max(1, Number(hours) || 24));
  const since = new Date(Date.now() - safeHours * 3600_000).toISOString();
  const rows = await arows(`SELECT source_id, cny, ok, created_at
      FROM monitor_wallet_samples
      WHERE created_at >= ?
      ORDER BY created_at ASC`, [since]);
  const bucketMinutes = safeHours <= 6 ? 5 : safeHours <= 24 ? 15 : 60;
  const bucketMs = bucketMinutes * 60_000;
  const bucketOf = (iso) => Math.floor(Date.parse(iso) / bucketMs) * bucketMs;

  const bySource = new Map(); // source -> Map(bucket -> { sum, count, okCount })
  const totals = new Map();    // bucket -> { sum, okCount, sources:Set }
  for (const row of rows) {
    const bucket = bucketOf(String(row.created_at));
    if (!Number.isFinite(bucket)) continue;
    const sourceId = String(row.source_id || '');
    if (!bySource.has(sourceId)) bySource.set(sourceId, new Map());
    const sourceBuckets = bySource.get(sourceId);
    const current = sourceBuckets.get(bucket) || { sum: 0, count: 0, okCount: 0 };
    current.count += 1;
    if (Number(row.ok) === 1 && row.cny !== null && row.cny !== undefined) {
      current.sum += Number(row.cny);
      current.okCount += 1;
    }
    sourceBuckets.set(bucket, current);

    const total = totals.get(bucket) || { sum: 0, okCount: 0, sources: new Set() };
    if (Number(row.ok) === 1 && row.cny !== null && row.cny !== undefined) {
      total.sum += Number(row.cny);
      total.okCount += 1;
      total.sources.add(sourceId);
    }
    totals.set(bucket, total);
  }

  const pointsOf = (buckets, valueOf) => [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([bucket, value]) => ({ at: new Date(bucket).toISOString(), ...valueOf(value) }));

  const sources = [...bySource.entries()].map(([id, buckets]) => ({
    id,
    points: pointsOf(buckets, (value) => ({
      cny: value.okCount ? Math.round((value.sum / value.okCount) * 100) / 100 : null,
      samples: value.count,
      ok: value.okCount > 0,
    })),
  }));

  return {
    hours: safeHours,
    bucketMinutes,
    since,
    until: new Date().toISOString(),
    total: pointsOf(totals, (value) => ({
      cny: value.okCount ? Math.round(value.sum * 100) / 100 : null,
      sources: value.sources.size,
    })),
    sources,
  };
}
