import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { errors } from '../lib.js';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/webp', ['.webp']],
  ['image/gif', ['.gif']],
  ['audio/mpeg', ['.mp3']],
  ['audio/wav', ['.wav']],
  ['audio/x-wav', ['.wav']],
  ['audio/ogg', ['.ogg']],
  ['video/mp4', ['.mp4']],
  ['video/webm', ['.webm']],
  ['application/pdf', ['.pdf']],
  ['text/plain', ['.txt']],
  ['text/csv', ['.csv']],
  ['application/zip', ['.zip']],
]);
const BLOCKED_EXTENSIONS = new Set(['.ade', '.apk', '.app', '.bat', '.cmd', '.com', '.cpl', '.dll', '.dmg', '.exe', '.hta', '.jar', '.js', '.jse', '.msi', '.msp', '.php', '.ps1', '.scr', '.sh', '.svg', '.vbs', '.vbe', '.wsf', '.xll', '.xlsm', '.docm']);

export function maxUploadBytes() {
  const configured = Number(process.env.FILE_UPLOAD_MAX_BYTES || DEFAULT_MAX_BYTES);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 100 * 1024 * 1024) : DEFAULT_MAX_BYTES;
}

export function uploadRoot() {
  return path.resolve(process.env.FILE_UPLOAD_ROOT || path.join(process.cwd(), 'var', 'uploads'));
}

function cleanFileName(value) {
  const original = String(value || '').trim();
  const normalized = original.normalize('NFKC');
  // 拒绝而不是删除 NUL/控制字符，避免攻击者借助清理后的名称绕过审计。
  if (!original || original.length > 255 || normalized.length > 255 || /[\0\u0001-\u001f\u007f]/.test(original)
    || normalized.includes('\\') || normalized.includes('/') || normalized === '.' || normalized === '..'
    || normalized.includes('..') || /^[A-Za-z]:/.test(normalized)) {
    throw errors.badRequest('文件名无效', 'INVALID_FILE_NAME');
  }
  const lower = normalized.toLowerCase();
  const ext = path.posix.extname(lower);
  if (!ext || BLOCKED_EXTENSIONS.has(ext)) throw errors.badRequest('文件扩展名不被允许', 'FILE_EXTENSION_BLOCKED');
  return { original, normalized, extension: ext };
}

function startsWith(buffer, bytes, offset = 0) {
  return buffer.length >= offset + bytes.length && bytes.every((value, index) => buffer[offset + index] === value);
}

function sniffMime(buffer) {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (startsWith(buffer, [0x49, 0x44, 0x33]) || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (startsWith(buffer, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (buffer.length && buffer.toString('utf8', 0, Math.min(buffer.length, 512)).includes('<svg')) return 'image/svg+xml';
  return null;
}

function validateMimeAndExtension(fileName, declaredMime, buffer) {
  const { extension } = cleanFileName(fileName);
  const mimeType = String(declaredMime || '').toLowerCase().split(';', 1)[0].trim();
  if (!MIME_EXTENSIONS.has(mimeType)) throw errors.badRequest('MIME 类型不被允许', 'MIME_TYPE_BLOCKED');
  if (!MIME_EXTENSIONS.get(mimeType).includes(extension)) throw errors.badRequest('MIME 类型与扩展名不匹配', 'MIME_EXTENSION_MISMATCH');
  const detectedMime = sniffMime(buffer);
  if (detectedMime === 'image/svg+xml' || detectedMime === 'application/x-msdownload') throw errors.badRequest('检测到高风险文件内容', 'MALICIOUS_FILE_BLOCKED');
  if (detectedMime && detectedMime !== mimeType && !(detectedMime === 'audio/wav' && mimeType === 'audio/x-wav')) throw errors.badRequest('文件内容与 MIME 类型不匹配', 'FILE_SIGNATURE_MISMATCH');
  if (['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'application/zip'].includes(mimeType) && !detectedMime) throw errors.badRequest('无法验证文件内容', 'FILE_SIGNATURE_UNKNOWN');
  return { mimeType, detectedMime, extension };
}

function parseDisposition(value) {
  const name = value.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1];
  const fileName = value.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
  return { name, fileName };
}

export function parseMultipartFormData(body, contentType) {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary || boundary.length > 200 || /[\0-\x20\x7f]/.test(boundary)) throw errors.badRequest('multipart boundary 无效', 'INVALID_MULTIPART');
  const marker = Buffer.from(`--${boundary}`);
  const result = { fields: {}, file: null };
  let cursor = 0; let parts = 0;
  while (cursor < body.length) {
    const start = body.indexOf(marker, cursor);
    if (start < 0) break;
    const after = start + marker.length;
    if (body[after] === 0x2d && body[after + 1] === 0x2d) break;
    if (body[after] !== 0x0d || body[after + 1] !== 0x0a) throw errors.badRequest('multipart 分段格式错误', 'INVALID_MULTIPART');
    const headerStart = after + 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) throw errors.badRequest('multipart 分段格式错误', 'INVALID_MULTIPART');
    const bodyStart = headerEnd + 4;
    const next = body.indexOf(marker, bodyStart);
    if (next < 0) throw errors.badRequest('multipart 结束边界缺失', 'INVALID_MULTIPART');
    const partBodyEnd = next - 2;
    const headers = body.subarray(headerStart, headerEnd).toString('latin1');
    const disposition = headers.match(/^content-disposition:\s*([^\r\n]+)/im)?.[1];
    const { name, fileName } = parseDisposition(disposition || '');
    if (!name) throw errors.badRequest('multipart 字段名缺失', 'INVALID_MULTIPART');
    const value = body.subarray(bodyStart, Math.max(bodyStart, partBodyEnd));
    parts += 1;
    if (parts > 20) throw errors.badRequest('multipart 字段过多', 'TOO_MANY_UPLOAD_PARTS');
    if (fileName !== undefined) {
      if (result.file) throw errors.badRequest('一次只能上传一个文件', 'TOO_MANY_FILES');
      const partMime = headers.match(/^content-type:\s*([^\r\n]+)/im)?.[1]?.trim() || '';
      result.file = { fieldName: name, fileName, mimeType: partMime, buffer: value };
    } else {
      result.fields[name] = value.toString('utf8').trim();
    }
    cursor = next;
  }
  if (!result.file || !result.file.buffer.length) throw errors.badRequest('必须选择文件', 'FILE_REQUIRED');
  return result;
}

function scannerRequired() {
  const configured = String(process.env.FILE_UPLOAD_REQUIRE_SCANNER || '').trim().toLowerCase();
  if (configured === 'true' || configured === '1' || configured === 'yes') return true;
  if (configured === 'false' || configured === '0' || configured === 'no') return false;
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function scannerCommand() {
  return String(process.env.FILE_UPLOAD_SCANNER || '').trim();
}

async function scanWithConfiguredScanner(buffer) {
  const command = scannerCommand();
  if (!command) {
    if (scannerRequired()) throw errors.serviceUnavailable('文件安全扫描器未配置，生产环境拒绝上传', 'FILE_SCANNER_UNAVAILABLE');
    return { scanner: 'not-configured', status: 'BUILTIN_ONLY' };
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, ['--no-summary', '-'], { windowsHide: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(errors.serviceUnavailable('文件安全扫描超时，上传已拒绝', 'FILE_SCANNER_TIMEOUT'));
    }, 30_000);
    const fail = (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    child.on('error', () => fail(errors.serviceUnavailable('文件安全扫描器不可用', 'FILE_SCANNER_UNAVAILABLE')));
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) return resolve({ scanner: command, status: 'PASSED' });
      if (code === 1) return reject(errors.badRequest('检测到恶意文件', 'MALICIOUS_FILE_BLOCKED'));
      reject(errors.serviceUnavailable('文件安全扫描失败，上传已拒绝', 'FILE_SCANNER_FAILED', { exitCode: code }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

export async function persistSecureUpload({ fileName, mimeType, buffer }) {
  if (!Buffer.isBuffer(buffer)) throw errors.badRequest('文件内容无效', 'INVALID_FILE_CONTENT');
  if (buffer.length < 1) throw errors.badRequest('不能上传空文件', 'EMPTY_FILE');
  if (buffer.length > maxUploadBytes()) throw errors.badRequest(`文件大小不能超过 ${Math.floor(maxUploadBytes() / 1024 / 1024)} MB`, 'FILE_TOO_LARGE');
  const validated = validateMimeAndExtension(fileName, mimeType, buffer);
  const scan = await scanWithConfiguredScanner(buffer);
  const root = uploadRoot();
  const now = new Date();
  const relative = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), `${randomUUID()}${validated.extension}`);
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) throw errors.badRequest('存储路径无效', 'INVALID_STORAGE_PATH');
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o750 });
  try {
    await writeFile(absolute, buffer, { flag: 'wx', mode: 0o640 });
  } catch (error) {
    await rm(absolute, { force: true }).catch(() => {});
    throw errors.badRequest('文件存储失败', 'FILE_STORAGE_FAILED');
  }
  return {
    storageKey: relative.replaceAll(path.sep, '/'),
    storagePath: absolute,
    fileName: cleanFileName(fileName).normalized,
    mimeType: validated.mimeType,
    fileSize: buffer.length,
    checksum: createHash('sha256').update(buffer).digest('hex'),
    security: { signature: validated.detectedMime || 'textual', scanner: scan.scanner, status: scan.status },
  };
}
