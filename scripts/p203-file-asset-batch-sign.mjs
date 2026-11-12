/**
 * P203 画布素材「批量签名 + 直连 OSS」守卫（2026-11-11）。
 *
 * 背景：画布原来对每个素材各发一次 `/api/.../file-assets/<id>/download`：
 * Node 鉴权 → 302 → OSS；30 个学生 × 25 个素材就是 750 次 Node 请求，而且客户端
 * 还会把视频整份 fetch 成 blob。现在画布打开时一次 POST `/file-assets/sign`，
 * 服务端逐个鉴权后返回 OSS 稳定签名直链；本地行/待归档行不下发，客户端回退原地址。
 *
 * 这个守卫钉住：
 *   ① 学生能签自己的私有素材与公开素材；
 *   ② 别人的私有素材、本地行、非法 URL **不会**出现在结果里（按 fileId 逐个鉴权）；
 *   ③ 签出来的是 OSS 直链、带签名、inline（不带 response-content-disposition）；
 *   ④ 同一时间窗内两次请求返回**同一个**签名地址（浏览器能缓存）；
 *   ⑤ 备课画布走 `/api/org/file-assets/sign`，公开素材对机构端也能签；
 *   ⑥ 路由不会被 `/:id` 吞掉（返回 200 而不是 404）。
 *
 * 跑法：node scripts/p203-file-asset-batch-sign.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p203-batch-sign-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
process.env.FILE_UPLOAD_ROOT = path.join(temp, 'uploads');
process.env.DEPLOYMENT_MODE = 'local-mock';
process.env.AI_PROVIDER = 'local-mock';
process.env.FILE_STORAGE = 'oss';
process.env.OSS_BUCKET = 'p203-test-bucket';
process.env.OSS_REGION = 'cn-guangzhou';
process.env.OSS_ENDPOINT = 'oss-cn-guangzhou.aliyuncs.com';
process.env.OSS_ACCESS_KEY_ID = 'p203-test-ak';
process.env.OSS_ACCESS_KEY_SECRET = 'p203-test-sk';

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const { aq, arow } = await import('../packages/database/src/store.js');
const student = await arow("SELECT id, org_id FROM users WHERE login='student-1'");
const other = await arow("SELECT id, org_id FROM users WHERE login='student-2'");
assert.ok(student?.id && other?.id, '种子学生缺失');
const now = new Date().toISOString();
const mk = (id, ownerType, ownerUserId, visibility, storageKey, metadata) => ({
  id, ownerType, ownerUserId, visibility, storageKey, metadata,
});

const publicId = `file_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const ownId = `file_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const otherId = `file_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const localId = `file_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
for (const item of [
  mk(publicId, 'PLATFORM', null, 'PUBLIC_PLATFORM', `p203/${publicId}.png`, '{"storageBackend":"oss"}'),
  mk(ownId, 'USER', student.id, 'PRIVATE', `p203/${ownId}.mp4`, '{"storageBackend":"oss"}'),
  mk(otherId, 'USER', other.id, 'PRIVATE', `p203/${otherId}.mp4`, '{"storageBackend":"oss"}'),
  mk(localId, 'USER', student.id, 'PRIVATE', `p203/${localId}.png`, '{}'),
]) {
  await aq('INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [item.id, item.ownerType, item.ownerType === 'USER' ? student.org_id : null, item.ownerUserId, 'INTERNAL_PROXY', null, item.storageKey, `/api/student/file-assets/${item.id}/download`, null,
      `${item.id}.png`, item.id === ownId || item.id === otherId ? 'video/mp4' : 'image/png', 1024, null, 'MEDIA_ASSET', item.visibility, 'ACTIVE', 'NOT_REQUIRED', null,
      item.metadata, null, now, now]);
}

const port = 19203;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const base = `http://127.0.0.1:${port}`;
const login = async (loginName, password, clientType) => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: loginName, password, clientType }),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(body?.data?.token, `${loginName} 登录失败：${JSON.stringify(body).slice(0, 200)}`);
  return body.data.token;
};
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 等起来 */ } await new Promise((r) => setTimeout(r, 100)); }
  const studentToken = await login('student-1', 'study123', 'student');
  const orgToken = await login('org-admin', 'org123', 'org');
  const studentUrl = (id) => `/api/student/file-assets/${id}/download`;
  const orgUrl = (id) => `/api/org/file-assets/${id}/download`;

  const req = async (pathName, token, urls) => {
    const response = await fetch(`${base}${pathName}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ urls }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const urls = [studentUrl(publicId), studentUrl(ownId), studentUrl(otherId), studentUrl(localId), '/api/student/file-assets/nope/download', 'https://example.com/x.png'];
  const first = await req('/api/student/file-assets/sign', studentToken, urls);
  const signed = first.body?.data?.urls || {};
  check('① 学生批量签名接口返回 200（路由没被 /:id 吞掉）', first.status === 200, `HTTP ${first.status} ${JSON.stringify(first.body).slice(0, 160)}`);
  check('② 公开素材能签', Boolean(signed[studentUrl(publicId)]), Object.keys(signed).join(', '));
  check('② 自己的私有素材能签', Boolean(signed[studentUrl(ownId)]), Object.keys(signed).join(', '));
  check('② 别人的私有素材**不**下发', !signed[studentUrl(otherId)], Object.keys(signed).join(', '));
  check('② 本地行**不**下发（没有 OSS 直链，客户端回退原地址）', !signed[studentUrl(localId)], Object.keys(signed).join(', '));
  check('② 非法/不存在的 URL 不污染结果', !signed['https://example.com/x.png'] && !signed['/api/student/file-assets/nope/download']);

  const publicSigned = String(signed[studentUrl(publicId)] || '');
  const ownSigned = String(signed[studentUrl(ownId)] || '');
  check('③ 签出来的是 OSS 直链', /^https:\/\/p203-test-bucket\.oss-cn-guangzhou\.aliyuncs\.com\//.test(publicSigned), publicSigned.slice(0, 120));
  check('③ 带 OSSAccessKeyId / Signature', /OSSAccessKeyId=/.test(publicSigned) && /Signature=/.test(publicSigned), publicSigned.slice(0, 160));
  check('③ 是 inline 预览（不带 response-content-disposition）', !/response-content-disposition=/.test(ownSigned), ownSigned.slice(0, 160));

  await new Promise((r) => setTimeout(r, 1100));
  const second = await req('/api/student/file-assets/sign', studentToken, [studentUrl(publicId), studentUrl(ownId)]);
  const secondSigned = second.body?.data?.urls || {};
  check('④ 同一时间窗内两次签名地址完全一致（浏览器能缓存）',
    secondSigned[studentUrl(publicId)] === publicSigned && secondSigned[studentUrl(ownId)] === ownSigned,
    `${String(secondSigned[studentUrl(publicId)]).slice(0, 80)} vs ${publicSigned.slice(0, 80)}`);

  const org = await req('/api/org/file-assets/sign', orgToken, [orgUrl(publicId), orgUrl(ownId)]);
  const orgSigned = org.body?.data?.urls || {};
  check('⑤ 备课画布（org 端点）能签公开素材', Boolean(orgSigned[orgUrl(publicId)]), Object.keys(orgSigned).join(', '));
  check('⑤ 机构端不签学生的私有素材', !orgSigned[orgUrl(ownId)], Object.keys(orgSigned).join(','));

  // ⑥ 客户端接线：光有服务端接口、画布不调用等于没做。
  const sharedSource = fs.readFileSync(path.join(root, 'packages/shared/src/canvasWorkspace.jsx'), 'utf8');
  const canvasSource = fs.readFileSync(path.join(root, 'packages/canvas/src/index.jsx'), 'utf8');
  check('⑥ 画布客户端走批量签名（不是逐个 blob）',
    /file-assets\/sign/.test(sharedSource) && /signBatchRef/.test(sharedSource) && /collectFileAssetUrls/.test(sharedSource));
  check('⑥ 视频不预加载、图片懒加载（点播放前不整份下载）',
    /preload="none"/.test(canvasSource) && /loading="lazy"/.test(canvasSource));
} finally {
  server.kill();
}

if (failures) {
  console.error(JSON.stringify({ name: 'p203-file-asset-batch-sign', pass: false, failed: failures, serverLog: serverLog.slice(-600) }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p203-file-asset-batch-sign', pass: true, checks: 14 }));
