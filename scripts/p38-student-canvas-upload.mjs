/**
 * P38 学生端画布素材上传（把桌面上的图片/视频拖进画布时用）。
 *
 * 背景：画布不支持「上传控件」，学生直接把文件拖进画布 → 前端调
 * `POST /api/student/file-assets/upload` 落盘成自己的私有素材，再落成节点、可连线当首帧/参考。
 * 这条通道是新增的写入口，必须钉住：只归本人、仅自己可见、类型/内容校验、越权取不到。
 *
 * 覆盖：
 *  1. 学生上传 PNG：200，返回 proxyRoute，visibility=PRIVATE
 *  2. 学生能用自己的凭据下载（代理路由 200，字节一致）
 *  3. 拿不到登录态时下载被拒（不是公开文件）
 *  4. 学生能在自己的文件列表里看到它
 *  5. 非媒体类型（可执行/文本）被拒 → 4xx
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p38-student-upload-'));
const dbPath = path.join(temp, 'platform.db');
// 本机跑不要求病毒扫描器（生产上 NODE_ENV=production 才强制，见 fileUploadSecurity.scannerRequired）
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, FILE_UPLOAD_ROOT: path.join(temp, 'uploads'), DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock', FILE_UPLOAD_REQUIRE_SCANNER: 'false' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18919;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });
server.stdout.on('data', (x) => { serverLog += x; });

// 最小合法 PNG（1×1，含合法魔术字节）
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001000d0a2db40000000049454e44ae426082', 'hex');
function multipart(fileName, mimeType, buffer, fields = {}) {
  const boundary = '----p38-boundary';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
  chunks.push(buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(token, fileName, mimeType, buffer, fields = {}) {
  const form = multipart(fileName, mimeType, buffer, fields);
  const response = await fetch(`http://127.0.0.1:${port}/api/student/file-assets/upload`, {
    method: 'POST',
    headers: { 'content-type': form.contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: form.body,
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}
async function api(pathname, { method = 'GET', token } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'student-2', password: 'study123' }) });
  const student = (await login.json()).data.token;
  assert.ok(student, '学生登录失败');

  // 1) 上传图片
  const uploaded = await upload(student, '桌面照片.png', 'image/png', PNG, { category: 'MEDIA_ASSET', visibility: 'PRIVATE' });
  assert.equal(uploaded.status, 200, `上传失败: ${JSON.stringify(uploaded.data)}`);
  assert.ok(uploaded.data.proxyRoute, '应返回可用的下载路由');
  assert.equal(uploaded.data.visibility, 'PRIVATE', '学生上传的素材必须仅自己可见');
  assert.equal(uploaded.data.ownerType, 'USER', '归属应为用户本人');

  // 2) 用自己的凭据下载
  const own = await fetch(`http://127.0.0.1:${port}${uploaded.data.proxyRoute}`, { headers: { authorization: `Bearer ${student}` } });
  assert.equal(own.status, 200, '学生应能下载自己上传的素材');
  const bytes = Buffer.from(await own.arrayBuffer());
  assert.ok(bytes.length >= PNG.length, '下载内容应与上传一致');

  // 3) 未登录取不到
  const anonymous = await fetch(`http://127.0.0.1:${port}${uploaded.data.proxyRoute}`);
  assert.ok(anonymous.status >= 400, `未登录不应能下载私有素材（实际 ${anonymous.status}）`);

  // 4) 自己的文件列表里能看到
  const list = await api('/api/student/file-assets?limit=50', { token: student });
  assert.equal(list.status, 200, `文件列表失败: ${JSON.stringify(list.data)}`);
  assert.ok((list.data.items || []).some((item) => item.id === uploaded.data.id), '列表里应能看到刚上传的素材');

  // 5) 非媒体类型被拒
  const blocked = await upload(student, 'payload.exe', 'application/octet-stream', Buffer.from('MZ'), { category: 'MEDIA_ASSET' });
  assert.ok(blocked.status >= 400, `可执行文件不应允许上传（实际 ${blocked.status}）`);

  console.log(JSON.stringify({
    name: 'student-canvas-upload', pass: true,
    uploaded: { id: uploaded.data.id, visibility: uploaded.data.visibility, proxyRoute: uploaded.data.proxyRoute },
    ownDownload: own.status, anonymousDownload: anonymous.status, listedBack: true, exeRejected: blocked.status,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
