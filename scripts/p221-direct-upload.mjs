/**
 * P221 直传 OSS 协议守卫（2026-11-12）。
 *
 * 钉住：
 *   ① 上传票据 HMAC 签/验、篡改拒绝、过期拒绝；
 *   ② 对象 key 带 org/user/uploadId，预签名 PUT URL 形状正确（含签名参数）；
 *   ③ 本地存储（未配 OSS）时 prepare 返回 501 DIRECT_UPLOAD_UNAVAILABLE，客户端可回退；
 *   ④ 源码接线：prepare/direct 两个入口、direct body 限额、落盘支持 fileAssetId。
 *
 * 跑法：node scripts/p221-direct-upload.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p221-direct-upload-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
process.env.PLATFORM_DATA_DIR = temp;
process.env.RUNTIME_GATEWAY_SECRET = 'p221-ticket-secret';
process.env.FILE_STORAGE = 'oss';
process.env.OSS_BUCKET = 'p221-bucket';
process.env.OSS_ENDPOINT = 'oss.p221.test';
process.env.OSS_ACCESS_KEY_ID = 'p221-access-key';
process.env.OSS_ACCESS_KEY_SECRET = 'p221-access-secret';
process.env.OSS_PREFIX = 'p221';

const { createUploadTicket, directUploadKey, verifyUploadTicket } = await import('../apps/server/src/services/directUpload.js');
const { presignedPutUrl } = await import('../apps/server/src/services/objectStorage.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const expectCode = async (fn, code, label) => {
  try { await fn(); check(label, false, `没有抛错（期望 ${code}）`); }
  catch (error) { check(label, error?.code === code, `实际 ${error?.code || error?.message}`); }
};

/* ── ① 票据 ── */
const ticket = createUploadTicket({
  userId: 'user_p221', orgId: 'org_p221',
  files: [{ name: 'assets/big.png', binary: true, key: 'p221/direct-upload/x', size: 10, mimeType: 'image/png', md5: 'a'.repeat(32) }],
});
const verified = verifyUploadTicket(ticket.token);
check('① 合法票据可验证且字段完整',
  verified.userId === 'user_p221' && verified.orgId === 'org_p221' && verified.files.length === 1);
check('① 票据带过期时间', Boolean(verified.exp) && verified.exp > Date.now());
await expectCode(() => verifyUploadTicket(`${ticket.token.slice(0, -2)}xx`), 'UPLOAD_TICKET_INVALID', '① 篡改签名被拒');
const shortLived = createUploadTicket({ userId: 'u', orgId: 'o', files: [] }, { ttlMs: 1 });
await sleep(10);
await expectCode(() => verifyUploadTicket(shortLived.token), 'UPLOAD_TICKET_EXPIRED', '① 过期票据被拒');

/* ── ② key / URL ── */
const key = directUploadKey({ orgId: 'org_p221', userId: 'user_p221', uploadId: 'upload-1', index: 2, name: 'assets/HERO.PNG' });
check('② key 带 org/user/uploadId 与安全扩展名',
  key.includes('p221/direct-upload/org_p221/user_p221/upload-1/2.png'), key);
const putUrl = presignedPutUrl(key, { expires: 900, contentType: 'image/png' });
check('② 预签名 PUT URL 指向 OSS 且带签名参数',
  putUrl.startsWith('https://p221-bucket.oss.p221.test/') && putUrl.includes('OSSAccessKeyId=') && putUrl.includes('Signature=') && putUrl.includes('Expires='),
  putUrl.slice(0, 180));

/* ── ③ 本地存储时 prepare 返回 501 ── */
const PORT = 18991;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  FILE_STORAGE: 'local',
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
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-400)}`);
    await sleep(120);
  }
  const login = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'student-1', password: 'study123' }),
  });
  const token = (await login.json())?.data?.token;
  const prepare = await fetch(`http://127.0.0.1:${PORT}/api/student/runtime/submit-upload/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'index.html', files: [{ name: 'index.html', binary: false, size: 10 }] }),
  });
  const payload = await prepare.json().catch(() => ({}));
  const code = payload?.error?.code || payload?.code || null;
  check('③ 本地存储 prepare 返回 501 + DIRECT_UPLOAD_UNAVAILABLE',
    prepare.status === 501 && code === 'DIRECT_UPLOAD_UNAVAILABLE', `${prepare.status} ${code}`);
} finally {
  server.kill('SIGTERM');
}

/* ── ④ 静态接线 ── */
const runtime = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/routes/studentRuntime.js'), 'utf8'));
const index = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/index.js'), 'utf8'));
check('④ prepare / direct 两个入口都在', runtime.includes("'/submit-upload/prepare'") && runtime.includes("'/submit-upload/direct'"));
check('④ 落盘支持 fileAssetId（直传对象不再解码）', runtime.includes('file.fileAssetId') && runtime.includes('bufferByFile'));
check('④ direct 的 JSON body 限额走 RUNTIME_UPLOAD_BODY_LIMIT',
  index.includes("'/api/student/runtime/submit-upload/direct'") && index.includes('RUNTIME_UPLOAD_BODY_LIMIT'));

if (failures) {
  console.error(`P221 FAILED: ${failures} 项`);
  process.exit(1);
}
console.log('P221 passed: 直传票据/key/预签名 URL 形状、本地 501 回退与源码接线');
