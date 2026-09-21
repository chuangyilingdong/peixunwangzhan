import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'ai-kids-p10-'));
process.env.FILE_UPLOAD_ROOT = root;
process.env.FILE_UPLOAD_REQUIRE_SCANNER = 'false';
process.env.NODE_ENV = 'test';
const { parseMultipartFormData, persistSecureUpload } = await import('../apps/server/src/services/fileUploadSecurity.js');
const { q, nowIso } = await import('../apps/server/src/lib.js');
const { handleStudentFileAssets } = await import('../apps/server/src/routes/fileAssets.js');

function multipart({ filename, mime, buffer, fields = {} }) {
  const boundary = '----p10-test-boundary';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
  chunks.push(buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const cases = [
  ['PNG', 'safe.png', 'image/png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])],
  ['WebP', 'safe.webp', 'image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])],
  ['OGG', 'safe.ogg', 'audio/ogg', Buffer.from('OggS')],
];
for (const [label, filename, mime, fileBuffer] of cases) {
  const form = multipart({ filename, mime, buffer: fileBuffer });
  const parsed = parseMultipartFormData(form.body, form.contentType);
  const stored = await persistSecureUpload(parsed.file);
  assert.equal(stored.mimeType, mime, label);
  assert.equal(stored.security.status, 'BUILTIN_ONLY', label);
  assert.ok(stored.storagePath.startsWith(root + path.sep), label);
}

async function rejects(filename, mime, buffer, code) {
  await assert.rejects(() => persistSecureUpload({ fileName: filename, mimeType: mime, buffer }), (error) => error.code === code);
}
await rejects('bad.png', 'image/jpeg', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), 'MIME_EXTENSION_MISMATCH');
await rejects('../bad.png', 'image/png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), 'INVALID_FILE_NAME');
await rejects('bad.exe', 'application/octet-stream', Buffer.from('MZ'), 'FILE_EXTENSION_BLOCKED');
assert.throws(() => parseMultipartFormData(Buffer.from('x'), 'multipart/form-data'), (error) => error.code === 'INVALID_MULTIPART');


const downloadId = `p10-download-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const downloadKey = `2026/09/${downloadId}.bin`;
const downloadPath = path.join(root, ...downloadKey.split('/'));
await mkdir(path.dirname(downloadPath), { recursive: true });
await writeFile(downloadPath, Buffer.from('secure-download'));
q(`INSERT INTO file_assets(id,owner_type,storage_kind,storage_key,file_name,mime_type,file_size,category,visibility,status,review_status,metadata,created_at,updated_at)
   VALUES (?,'PLATFORM','INTERNAL_PROXY',?,'download.txt','text/plain',15,'GENERAL','PUBLIC_PLATFORM','ACTIVE','NOT_REQUIRED','{}',?,?)`, [downloadId, downloadKey, nowIso(), nowIso()]);
const response = await handleStudentFileAssets({
  pathname: `/api/student/file-assets/${downloadId}/download`, method: 'GET',
  search: new URLSearchParams(), req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
  auth: { user: { id: 'student', role: 'STUDENT', orgId: 'org_test' } },
});
assert.equal(response.__fileResponse, true);
const downloaded = Buffer.concat([...(await (async () => { const chunks = []; for await (const chunk of response.stream) chunks.push(chunk); return chunks; })())]);
assert.equal(downloaded.toString(), 'secure-download');
assert.equal(response.headers['x-content-type-options'], 'nosniff');

/* ── 单文件上限的硬顶 + 「读 body 之前」的内存闸（2026-09-21，上限提到 200MB 时一起加的）──────
   背景（实测）：`clamscan` 每次调用都要把病毒库读进内存，扫 150MB 文件峰值 RSS ≈990MB；
   生产机 1.6GB。所以上限抬到 200MB 之后，**必须**有一道在读 body 之前的内存闸，
   否则两份大请求叠在一起就是 OOM（这台机器上 OOM 挑走过学生环境）。 */
{
  const { maxUploadBytes, maxUploadCeilingBytes } = await import('../apps/server/src/services/fileUploadSecurity.js');
  const { acquireBodySlot, bodyGateLimits, bodyGateState } = await import('../apps/server/src/services/uploadBodyGate.js');

  // ① 硬顶：env 只能往下调，不能越过 200MB（抬硬顶要改代码 + 重新评估内存与扫描器）
  assert.equal(maxUploadCeilingBytes(), 200 * 1024 * 1024, '单文件硬顶应当是 200MB');
  const savedLimit = process.env.FILE_UPLOAD_MAX_BYTES;
  process.env.FILE_UPLOAD_MAX_BYTES = String(5 * 1024 * 1024 * 1024);
  assert.equal(maxUploadBytes(), 200 * 1024 * 1024, 'env 开到 5GB 也不能越过硬顶');
  process.env.FILE_UPLOAD_MAX_BYTES = String(64 * 1024 * 1024);
  assert.equal(maxUploadBytes(), 64 * 1024 * 1024, '往下调要生效');

  // ② 超限那句话里的数字来自配置（别写成写死的 25MB）
  process.env.FILE_UPLOAD_MAX_BYTES = String(2 * 1024 * 1024);
  await assert.rejects(
    () => persistSecureUpload({ fileName: 'too-big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(3 * 1024 * 1024) }),
    (error) => error.code === 'FILE_TOO_LARGE' && /不能超过 2 MB/.test(error.message),
  );
  if (savedLimit === undefined) delete process.env.FILE_UPLOAD_MAX_BYTES; else process.env.FILE_UPLOAD_MAX_BYTES = savedLimit;

  // ③ 内存闸：默认「2 份 / 合计 256MB」→ 一份 200MB 天然互斥；释放之后又能占；release 幂等
  const gateEnv = { FILE_UPLOAD_MAX_INFLIGHT: '2', FILE_UPLOAD_MAX_INFLIGHT_BYTES: String(256 * 1024 * 1024) };
  assert.deepEqual(bodyGateLimits(gateEnv), { maxBodies: 2, maxBytes: 256 * 1024 * 1024 });
  const tooMany = (message, code, details) => Object.assign(new Error(message), { code, details });
  const first = acquireBodySlot(200 * 1024 * 1024, { env: gateEnv, tooMany });
  assert.throws(() => acquireBodySlot(200 * 1024 * 1024, { env: gateEnv, tooMany }),
    (error) => error.code === 'UPLOAD_BUSY', '第二份 200MB 必须挡在读 body 之前');
  assert.throws(() => acquireBodySlot(80 * 1024 * 1024, { env: gateEnv, tooMany }),
    (error) => error.code === 'UPLOAD_BUSY', '合计超预算也要挡（200+80 > 256MB）');
  const second = acquireBodySlot(40 * 1024 * 1024, { env: gateEnv, tooMany });
  assert.throws(() => acquireBodySlot(1, { env: gateEnv, tooMany }),
    (error) => error.code === 'UPLOAD_BUSY', '份数占满也要挡');
  first(); first();   // release 必须幂等（finish 与 close 都会调）
  assert.equal(bodyGateState().count, 1, '重复 release 不能把别人的名额也放掉');
  second();
  assert.deepEqual(bodyGateState(), { count: 0, bytes: 0, busy: 3 }, '全部释放后必须归零（否则上传会永久 429）');
}

await rm(root, { recursive: true, force: true });
console.log('P10 security upload checks: 9 pass / 0 fail（另加上限硬顶与内存闸 3 组断言）');

