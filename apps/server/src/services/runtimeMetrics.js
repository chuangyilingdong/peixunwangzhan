/**
 * 运行时容量指标（2026-11-12）。
 *
 * 目的：给 100 并发压测一个可对照的服务端视角 —— 每路由 P95、DB 池排队、SSE 活跃数、
 * 归档队列深度、进程 RSS/load、网卡 rx/tx 速率。
 *
 * ⚠️ 只通过 `GET /__metrics` 暴露，且 index.js 只接受 loopback（127.0.0.1 / ::1）。
 *    nginx 只代理 /api/，这个路径不会出现在公网。
 * ⚠️ 全部是进程内 ring buffer / 计数器，不引第三方依赖；多实例时每个进程各算一份。
 */
import fs from 'node:fs';
import os from 'node:os';

const HTTP_ROUTE_LIMIT = 200;
const HTTP_SAMPLE_LIMIT = 500;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const httpRoutes = new Map();
let httpTotal = 0;
let httpErrors = 0;

let sseActive = 0;
let sseOpenedTotal = 0;

const ID_SEGMENT = /^(?:[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]{6,}|[0-9a-f]{8}-[0-9a-f-]{20,}|\d{4,})$/i;

/** 把长 id / uuid / 纯数字段归一化成 :id，避免指标基数爆炸。 */
export function routeKey(method, pathname) {
  const segments = String(pathname || '/').split('/').filter(Boolean);
  const normalized = segments.slice(0, 4).map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment));
  const suffix = segments.length > 4 ? '/*' : '';
  return `${String(method || 'GET').toUpperCase()} /${normalized.join('/')}${suffix}`;
}

export function recordHttp(route, status, durationMs) {
  if (String(route || '').includes('/__metrics')) return;
  const key = String(route || 'UNKNOWN');
  let entry = httpRoutes.get(key);
  if (!entry) {
    if (httpRoutes.size >= HTTP_ROUTE_LIMIT) httpRoutes.delete(httpRoutes.keys().next().value);
    entry = { count: 0, errors: 0, totalMs: 0, maxMs: 0, durations: [] };
    httpRoutes.set(key, entry);
  }
  const ms = Math.max(0, Math.round(Number(durationMs) || 0));
  entry.count += 1;
  entry.totalMs += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
  if (Number(status) >= 400) entry.errors += 1;
  entry.durations.push(ms);
  if (entry.durations.length > HTTP_SAMPLE_LIMIT) entry.durations.shift();
  httpTotal += 1;
  if (Number(status) >= 400) httpErrors += 1;
}

export function sseOpen() { sseActive += 1; sseOpenedTotal += 1; }
export function sseClose() { sseActive = Math.max(0, sseActive - 1); }

export function isLoopbackRequest(req) {
  // 双保险：即使以后 nginx 加了 catch-all 代理，带 x-forwarded-for 的请求也不放行。
  if (req?.headers?.['x-forwarded-for']) return false;
  return LOOPBACK_ADDRESSES.has(String(req?.socket?.remoteAddress || ''));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function routeSnapshot() {
  return [...httpRoutes.entries()]
    .map(([route, entry]) => {
      const sorted = [...entry.durations].sort((left, right) => left - right);
      return {
        route,
        count: entry.count,
        errors: entry.errors,
        avgMs: entry.count ? Math.round(entry.totalMs / entry.count) : 0,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        maxMs: entry.maxMs,
      };
    })
    .sort((left, right) => right.count - left.count);
}

function readNetTotals() {
  try {
    const text = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of text.split('\n').slice(2)) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const name = line.slice(0, separator).trim();
      if (!name || name === 'lo') continue;
      const fields = line.slice(separator + 1).trim().split(/\s+/).map(Number);
      rx += fields[0] || 0;
      tx += fields[8] || 0;
    }
    return { rx, tx, at: Date.now() };
  } catch {
    return { rx: 0, tx: 0, at: Date.now() };
  }
}

let lastNet = readNetTotals();

function netSnapshot() {
  const current = readNetTotals();
  const elapsedSec = Math.max(0.001, (current.at - lastNet.at) / 1000);
  const rxBytesPerSec = Math.max(0, current.rx - lastNet.rx) / elapsedSec;
  const txBytesPerSec = Math.max(0, current.tx - lastNet.tx) / elapsedSec;
  lastNet = current;
  return {
    rxMBps: Number((rxBytesPerSec / 1048576).toFixed(2)),
    txMBps: Number((txBytesPerSec / 1048576).toFixed(2)),
    rxTotalMB: Math.round(current.rx / 1048576),
    txTotalMB: Math.round(current.tx / 1048576),
  };
}

let storePromise = null;
function loadStore() {
  storePromise ||= import('../../../../packages/database/src/store.js');
  return storePromise;
}

/**
 * 一份完整快照。归档队列每次抓取查一次 DB（1-2 条索引查询），只在 /__metrics 调用时发生。
 */
export async function metricsSnapshot() {
  const memory = process.memoryUsage();
  const store = await loadStore().catch(() => null);
  const dbPoolStats = store?.dbPoolStats || null;
  let archive = null;
  if (store?.acount && store?.arow) {
    try {
      const pending = Number(await store.acount(
        "SELECT COUNT(*) n FROM file_assets WHERE archive_state='PENDING' AND storage_key IS NULL AND status='ACTIVE'",
      ) || 0);
      const oldest = await store.arow(
        "SELECT created_at FROM file_assets WHERE archive_state='PENDING' AND storage_key IS NULL AND status='ACTIVE' ORDER BY created_at ASC LIMIT 1",
      );
      archive = { pending, oldestCreatedAt: oldest?.created_at || null };
    } catch {
      archive = { pending: null, oldestCreatedAt: null };
    }
  }
  return {
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    process: {
      rssMB: Math.round(memory.rss / 1048576),
      heapUsedMB: Math.round(memory.heapUsed / 1048576),
      load1: Number(os.loadavg()[0].toFixed(2)),
      cpuCount: os.cpus().length,
    },
    http: {
      total: httpTotal,
      errors: httpErrors,
      routes: routeSnapshot(),
    },
    db: dbPoolStats
      ? {
        queries: dbPoolStats.queries,
        slowQueries: dbPoolStats.slowQueries,
        waitMsMax: dbPoolStats.waitMsMax,
        waitMsAvg: dbPoolStats.queries ? Number((dbPoolStats.waitMsTotal / dbPoolStats.queries).toFixed(1)) : 0,
        active: dbPoolStats.active,
        waiting: dbPoolStats.waiting,
        connectionLimit: dbPoolStats.connectionLimit,
      }
      : null,
    sse: { active: sseActive, openedTotal: sseOpenedTotal },
    archive,
    net: netSnapshot(),
  };
}

/** 测试用：清空 HTTP/SSE 计数（不清 DB/网络累计）。 */
export function resetRuntimeMetrics() {
  httpRoutes.clear();
  httpTotal = 0;
  httpErrors = 0;
  sseActive = 0;
  sseOpenedTotal = 0;
  lastNet = readNetTotals();
}
