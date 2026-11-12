/**
 * 100 并发压测工具（2026-11-12）。
 *
 * 零依赖、Node 24 原生 fetch。三种场景：
 *   · poll   —— 模拟学生在课堂里轮询 Dashboard / 课程 / 作品 / 画布任务；
 *   · upload —— 模拟下课同时提交作品（multipart：meta + HTML + 指定大小二进制）；
 *   · mixed  —— 按 UPLOAD_RATIO 混合。
 *
 * 用法（先准备一个学生 token；upload 场景需要该学生有一节进行中的 VIBECODING 课堂）：
 *   BASE_URL=https://aicyld.com LOADTEST_TOKEN=... VUS=100 DURATION_SEC=60 SCENARIO=poll \
 *     node scripts/loadtest-100.mjs
 *
 * 可选：
 *   LOADTEST_PROJECT_ID=...   画布任务轮询（/api/ai/generations?projectId=…）
 *   UPLOAD_MB=20              上传场景的二进制大小
 *   UPLOAD_RATIO=0.2          mixed 场景上传占比
 *   THINK_MS=2000              poll 场景两次请求间隔
 *   METRICS_URL=http://127.0.0.1:8789/__metrics   服务端指标（只在服务器本机可取）
 *   TAG=...                   结果文件名后缀
 *
 * ⚠️ upload 场景会真实写作品/资产；用测试学生，并在压测后清理。
 * ⚠️ 生产跑之前确认没有真实课堂；100×20MB 会占满入口带宽。
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:8789').replace(/\/+$/, '');
const TOKEN = String(process.env.LOADTEST_TOKEN || '').trim();
const PROJECT_ID = String(process.env.LOADTEST_PROJECT_ID || '').trim();
const VUS = Math.max(1, Number(process.env.VUS || 100) || 100);
const DURATION_SEC = Math.max(1, Number(process.env.DURATION_SEC || 60) || 60);
const SCENARIO = String(process.env.SCENARIO || 'poll').toLowerCase();
const THINK_MS = Math.max(0, Number(process.env.THINK_MS || 2000) || 0);
const UPLOAD_MB = Math.max(1, Number(process.env.UPLOAD_MB || 20) || 20);
const UPLOAD_RATIO = Math.min(1, Math.max(0, Number(process.env.UPLOAD_RATIO || 0.2) || 0));
const METRICS_URL = String(process.env.METRICS_URL || `${BASE_URL}/__metrics`);
const TAG = String(process.env.TAG || new Date().toISOString().replace(/[:.]/g, '-')).slice(0, 80);

if (!TOKEN) {
  console.error('缺少 LOADTEST_TOKEN（学生 token）。');
  process.exit(2);
}
if (!['poll', 'upload', 'mixed'].includes(SCENARIO)) {
  console.error(`SCENARIO 只能是 poll / upload / mixed，收到：${SCENARIO}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');
const UPLOAD_BINARY = Buffer.concat([PNG_HEADER, Buffer.alloc(UPLOAD_MB * 1024 * 1024 - PNG_HEADER.length, 0x22)]);
const UPLOAD_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Loadtest</title></head><body><h1>loadtest</h1></body></html>';
const UPLOAD_BLOB = new Blob([UPLOAD_BINARY], { type: 'image/png' });

const pollEndpoints = [
  { key: 'dashboard', url: `${BASE_URL}/api/student/dashboard`, weight: 3 },
  { key: 'courses', url: `${BASE_URL}/api/student/courses`, weight: 2 },
  { key: 'works', url: `${BASE_URL}/api/student/works?page=1&limit=20`, weight: 1 },
  ...(PROJECT_ID
    ? [{ key: 'generations', url: `${BASE_URL}/api/ai/generations?projectId=${encodeURIComponent(PROJECT_ID)}`, weight: 2 }]
    : []),
];
const weightedPoll = pollEndpoints.flatMap((item) => Array.from({ length: item.weight }, () => item));

const results = new Map();
function recordRequest(key, status, durationMs) {
  let item = results.get(key);
  if (!item) {
    item = { count: 0, errors: 0, statuses: new Map(), durations: [] };
    results.set(key, item);
  }
  item.count += 1;
  item.durations.push(Math.max(0, durationMs));
  item.statuses.set(status, (item.statuses.get(status) || 0) + 1);
  if (status < 200 || status >= 400) item.errors += 1;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function scrapeMetrics() {
  try {
    const response = await fetch(METRICS_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function uploadForm(vu) {
  const form = new FormData();
  form.append('meta', JSON.stringify({
    name: 'index.html',
    title: `Loadtest VU ${vu}`,
    copyrightConfirmed: true,
    taskId: `loadtest-${vu}`,
    files: [
      { name: 'index.html', binary: false },
      { name: 'assets/loadtest.png', binary: true },
    ],
  }));
  form.append('file:0', new Blob([UPLOAD_HTML], { type: 'text/html' }), 'index.html');
  form.append('file:1', UPLOAD_BLOB, 'assets/loadtest.png');
  return form;
}

async function runPoll(vu) {
  const endpoint = weightedPoll[vu % weightedPoll.length];
  const response = await fetch(endpoint.url, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  await response.arrayBuffer().catch(() => {});
  return { key: endpoint.key, status: response.status };
}

async function runUpload(vu) {
  const response = await fetch(`${BASE_URL}/api/student/runtime/submit-upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: uploadForm(vu),
    signal: AbortSignal.timeout(180000),
  });
  await response.arrayBuffer().catch(() => {});
  return { key: 'submit-upload', status: response.status };
}

async function worker(vu, deadline) {
  while (Date.now() < deadline) {
    const startedAt = performance.now();
    const isUpload = SCENARIO === 'upload' || (SCENARIO === 'mixed' && Math.random() < UPLOAD_RATIO);
    let outcome;
    try {
      outcome = isUpload ? await runUpload(vu) : await runPoll(vu);
    } catch (error) {
      outcome = { key: isUpload ? 'submit-upload' : 'poll', status: 0, error: String(error?.message || error) };
    }
    recordRequest(outcome.key, outcome.status, performance.now() - startedAt);
    if (!isUpload) await sleep(THINK_MS + Math.floor(Math.random() * 300));
  }
}

const startedAt = Date.now();
const deadline = startedAt + DURATION_SEC * 1000;
const metricsBefore = await scrapeMetrics();
await Promise.all(Array.from({ length: VUS }, (_item, index) => worker(index, deadline)));
const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
const metricsAfter = await scrapeMetrics();

const rows = [...results.entries()].map(([key, item]) => {
  const sorted = [...item.durations].sort((left, right) => left - right);
  return {
    key,
    count: item.count,
    errors: item.errors,
    errorRate: item.count ? Number((item.errors / item.count * 100).toFixed(2)) : 0,
    p50Ms: Math.round(percentile(sorted, 50)),
    p95Ms: Math.round(percentile(sorted, 95)),
    p99Ms: Math.round(percentile(sorted, 99)),
    maxMs: Math.round(sorted[sorted.length - 1] || 0),
    statuses: Object.fromEntries([...item.statuses.entries()].sort((left, right) => left[0] - right[0])),
  };
}).sort((left, right) => right.count - left.count);

const totalRequests = rows.reduce((sum, row) => sum + row.count, 0);
const totalErrors = rows.reduce((sum, row) => sum + row.errors, 0);
const summary = {
  at: new Date().toISOString(),
  baseUrl: BASE_URL,
  scenario: SCENARIO,
  vus: VUS,
  durationSec: Number(elapsedSec.toFixed(1)),
  totalRequests,
  rps: Number((totalRequests / elapsedSec).toFixed(2)),
  errorRate: totalRequests ? Number((totalErrors / totalRequests * 100).toFixed(2)) : 0,
  uploadMb: SCENARIO === 'poll' ? 0 : UPLOAD_MB,
  rows,
  metricsBefore,
  metricsAfter,
};

console.log(`\n=== loadtest ${SCENARIO} · ${VUS} VU · ${summary.durationSec}s ===`);
console.log(`requests=${totalRequests} rps=${summary.rps} errors=${totalErrors} (${summary.errorRate}%)`);
for (const row of rows) {
  console.log(`${row.key.padEnd(16)} n=${String(row.count).padEnd(6)} err=${String(row.errors).padEnd(5)} p50=${row.p50Ms}ms p95=${row.p95Ms}ms p99=${row.p99Ms}ms max=${row.maxMs}ms status=${JSON.stringify(row.statuses)}`);
}
if (metricsBefore && metricsAfter) {
  const dbBefore = metricsBefore.db || {};
  const dbAfter = metricsAfter.db || {};
  const netBefore = metricsBefore.net || {};
  const netAfter = metricsAfter.net || {};
  console.log(`metrics: rss ${metricsBefore.process?.rssMB}→${metricsAfter.process?.rssMB}MB · `
    + `db waitMax ${dbAfter.waitMsMax}ms waitAvg ${dbAfter.waitMsAvg}ms active ${dbAfter.active}/${dbAfter.connectionLimit} · `
    + `queries +${Number(dbAfter.queries || 0) - Number(dbBefore.queries || 0)} · `
    + `sse ${metricsAfter.sse?.active ?? '-'} · archive pending ${metricsAfter.archive?.pending ?? '-'} · `
    + `net rx ${netAfter.rxMBps}MB/s tx ${netAfter.txMBps}MB/s`);
} else {
  console.log(`metrics: 未取到（${METRICS_URL} 只在服务器本机可访问）`);
}

const outputDir = path.resolve('.tmp');
fs.mkdirSync(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `loadtest-${TAG}.json`);
fs.writeFileSync(outputFile, JSON.stringify(summary, null, 2));
console.log(`result: ${outputFile}`);

// 超过一半失败视为压测本身不可信（token/课堂/地址错了），返回非 0。
if (totalRequests && totalErrors / totalRequests > 0.5) process.exitCode = 1;
