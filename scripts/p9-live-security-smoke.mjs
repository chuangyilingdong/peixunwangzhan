#!/usr/bin/env node

/**
 * Read-only production edge smoke test.
 *
 * This intentionally checks the proxy, not the application internals. It never
 * logs cookies, authorization headers, response bodies, or environment values.
 */
const site = (process.env.SITE_URL || 'https://iicili.cyou').replace(/\/$/, '');
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
  const response = await fetch(site + path, { redirect: 'manual' });
  const passed = response.status === 404;
  checks.push({ path, status: response.status, pass: passed });
}

const health = await fetch(site + '/api/health', { redirect: 'manual' });
let healthJson = null;
try {
  healthJson = await health.json();
} catch {
  // The summary below only reports status; no response body is printed.
}
const healthPass = health.status === 200 && healthJson?.ok === true;
checks.push({ path: '/api/health', status: health.status, pass: healthPass });

const response = await fetch(site + '/', { redirect: 'manual' });
const securityHeaders = {
  hsts: Boolean(response.headers.get('strict-transport-security')),
  csp: Boolean(response.headers.get('content-security-policy')),
  nosniff: response.headers.get('x-content-type-options') === 'nosniff',
  frameOptions: Boolean(response.headers.get('x-frame-options')),
  referrerPolicy: Boolean(response.headers.get('referrer-policy')),
};
const securityPass = Object.values(securityHeaders).every(Boolean);
checks.push({ path: '/', status: response.status, securityHeaders, pass: response.status === 200 && securityPass });

console.log(JSON.stringify({ site, checks, pass: checks.every((check) => check.pass) }, null, 2));
if (checks.some((check) => !check.pass)) process.exit(1);