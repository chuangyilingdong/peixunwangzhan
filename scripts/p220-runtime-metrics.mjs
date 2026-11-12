/**
 * P220 运行时指标 + 压测工具守卫（2026-11-12）。
 *
 * 钉住：
 *   ① `/__metrics` 只在 loopback 可用，返回 process/http/db/net/archive/sse；
 *   ② `loadtest-100.mjs` 能真实跑起来并输出 p95（5 VU × 3s 的轮询）；
 *   ③ 源码里有 loopback 限制，避免指标被公网读到。
 *
 * 跑法：node scripts/p220-runtime-metrics.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p220-metrics-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
process.env.PLATFORM_DATA_DIR = temp;

const { arow } = await import('../packages/database/src/store.js');
const PORT = 18990;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  PORT: String(PORT),
};

const run = (args, env = baseEnv) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-500)}`);
    await sleep(150);
  }

  const token = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-1', password: 'study123' } })).data?.token;
  check('夹具：学生可登录', Boolean(token));

  const metrics = await api('/__metrics');
  check('① /__metrics 200 且含 process/http/db/net/archive/sse',
    metrics.status === 200
    && Boolean(metrics.raw.process) && Boolean(metrics.raw.http) && Boolean(metrics.raw.db)
    && Boolean(metrics.raw.net) && Boolean(metrics.raw.archive) && Boolean(metrics.raw.sse),
    JSON.stringify(metrics.raw).slice(0, 240));

  const loadtest = await run(['scripts/loadtest-100.mjs'], {
    ...baseEnv,
    BASE_URL: `http://127.0.0.1:${PORT}`,
    LOADTEST_TOKEN: token,
    VUS: '5',
    DURATION_SEC: '3',
    SCENARIO: 'poll',
    THINK_MS: '100',
    METRICS_URL: `http://127.0.0.1:${PORT}/__metrics`,
    TAG: 'p220',
  });
  check('② 5 VU × 3s 压测跑通并输出 p95',
    /\bp95=\d+ms/.test(loadtest) && loadtest.includes('requests='),
    loadtest.split('\n').slice(-8).join(' / ').slice(0, 300));

  const index = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/index.js'), 'utf8'));
  const metricsSource = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/services/runtimeMetrics.js'), 'utf8'));
  check('③ /__metrics 有 loopback 限制', index.includes('isLoopbackRequest(req)') && metricsSource.includes('LOOPBACK_ADDRESSES'));
} finally {
  server.kill('SIGTERM');
}

if (failures) {
  console.error(`P220 FAILED: ${failures} 项`);
  process.exit(1);
}
console.log('P220 passed: /__metrics 可用且仅 loopback，loadtest-100 能跑通并输出 p95');
