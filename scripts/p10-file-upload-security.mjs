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

await rm(root, { recursive: true, force: true });
console.log('P10 security upload checks: 9 pass / 0 fail');

