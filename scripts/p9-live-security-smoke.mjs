#!/usr/bin/env node

/**
 * Read-only production edge smoke test.
 *
 * This intentionally checks the proxy, not the application internals. It never
 * logs cookies, authorization headers, response bodies, or environment values.
 */
import http from 'node:http';
import https from 'node:https';

// ⚠️ 2026-09-25：默认域名从 `iicili.cyou` 换成 `aicyld.com` —— 生产已搬到新域名，旧域名没有后端
//    （实测 502 / 连不上），继续指着它跑等于**必红**而且红得没有信息量。
//    要指别处：`SITE_URL=https://… node scripts/p9-live-security-smoke.mjs`。
const site = (process.env.SITE_URL || 'https://aicyld.com').replace(/\/$/, '');

// Keep the probe runnable on the repository's documented Node 16+ baseline;
// global fetch is only available by default in newer Node releases.
function request(url) {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const request = transport.get(parsed, { headers: { 'user-agent': 'ai-kids-security-smoke/1.0' } }, (response) => {
      const chunks = [];
      let size = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        // The probe never prints bodies; cap buffered data to avoid a bad edge
        // response consuming unbounded memory while still draining the socket.
        if (size < 1024 * 1024) {
          chunks.push(chunk);
          size += chunk.length;
        }
      });
      response.on('end', () => {
        const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value || '')]));
        resolve({ status: response.statusCode || 0, headers, body: chunks.join('') });
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error(`request timeout: ${url}`)));
    request.on('error', reject);
  });
}

const sensitivePaths = [
  '/server.js',
  '/package.json',
  '/pnpm-lock.yaml',
  '/pnpm-workspace.yaml',
  '/apps/',
  '/packages/',
  '/node_modules/',
  '/scripts/',
  '/deploy/',
  '/.env',
  '/.git/config',
  '/backup.sql',
];

const checks = [];
for (const path of sensitivePaths) {
  const response = await request(site + path);
  const passed = response.status === 404;
  checks.push({ path, status: response.status, pass: passed });
}

const health = await request(site + '/api/health');
let healthJson = null;
try {
  healthJson = JSON.parse(health.body);
} catch {
  // The summary below only reports status; no response body is printed.
}
const healthPass = health.status === 200 && healthJson?.ok === true;
checks.push({ path: '/api/health', status: health.status, pass: healthPass });

const response = await request(site + '/');
const securityHeaders = {
  hsts: Boolean(response.headers['strict-transport-security']),
  csp: Boolean(response.headers['content-security-policy']),
  nosniff: response.headers['x-content-type-options'] === 'nosniff',
  frameOptions: Boolean(response.headers['x-frame-options']),
  referrerPolicy: Boolean(response.headers['referrer-policy']),
};
const securityPass = Object.values(securityHeaders).every(Boolean);
checks.push({ path: '/', status: response.status, securityHeaders, pass: response.status === 200 && securityPass });

console.log(JSON.stringify({ site, checks, pass: checks.every((check) => check.pass) }, null, 2));
if (checks.some((check) => !check.pass)) process.exit(1);