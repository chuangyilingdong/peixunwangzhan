/**
 * P219 submit-upload multipart 入口守卫（2026-11-12）。
 *
 * 钉住平台侧的兼容入口：
 *   ① multipart（meta + file:<i> + cover）能提交成功，timings.contentBytes 精确；
 *   ② 缺 meta → 400 RUNTIME_UPLOAD_META_REQUIRED；
 *   ③ 同一内容重复提交仍然 200；
 *   ④ 老 JSON 路径不受影响（由 p217 继续覆盖）；
 *   ⑤ 静态：submit-upload 的 multipart 限额/内存闸用的是业务档 + 大 JSON 闸。
 *
 * 跑法：node scripts/p219-submit-upload-multipart.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p219-submit-multipart-'));
const dbPath = path.join(temp, 'platform.db');
const uploadRoot = path.join(temp, 'uploads');
process.env.PLATFORM_DB_PATH = dbPath;
fs.mkdirSync(uploadRoot, { recursive: true });
const { aq, arow } = await import('../packages/database/src/store.js');

const PORT = 18988;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  FILE_UPLOAD_ROOT: uploadRoot,
  FILE_UPLOAD_SCANNER: 'off',
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p219-guard-secret',
  PORT: String(PORT),
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
await ensureClassroom(dbPath);
await aq("UPDATE class_sessions SET delivery_mode='VIBECODING'");
await aq("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const loginAs = async (name, password) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: name, password }),
  });
  const payload = await response.json().catch(() => ({}));
  return payload?.data?.token;
};
const upload = async (token, form) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/student/runtime/submit-upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-600)}`);
    await sleep(150);
  }
  const student = await arow(`SELECT student.login FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id AND session.status='ACTIVE'
       JOIN users student ON student.id = part.student_id
      WHERE part.status='ACTIVE' ORDER BY student.created_at LIMIT 1`);
  const token = await loginAs(student.login, 'study123');
  check('夹具：学生可登录（VibeCoding 课堂已就绪）', Boolean(token));

  const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');
  const BIG = Buffer.concat([PNG_HEADER, Buffer.alloc(2 * 1024 * 1024 - PNG_HEADER.length, 0x22)]);
  const COVER = Buffer.concat([PNG_HEADER, Buffer.alloc(4096 - PNG_HEADER.length, 0x33)]);
  const ENTRY = '<!doctype html><html><head><meta charset="utf-8"><title>P219</title></head><body><h1>小气泡 · 中文正文</h1></body></html>';

  const buildForm = ({ withMeta = true, withCover = true } = {}) => {
    const form = new FormData();
    if (withMeta) {
      form.append('meta', JSON.stringify({
        name: 'index.html', title: 'P219 multipart', copyrightConfirmed: true,
        files: [
          { name: 'index.html', binary: false },
          { name: 'assets/big.png', binary: true },
        ],
        ...(withCover ? { cover: true } : {}),
      }));
    }
    form.append('file:0', new Blob([ENTRY], { type: 'text/html' }), 'index.html');
    form.append('file:1', new Blob([BIG], { type: 'image/png' }), 'assets/big.png');
    if (withMeta && withCover) form.append('cover', new Blob([COVER], { type: 'image/png' }), 'cover.png');
    return form;
  };

  const first = await upload(token, buildForm());
  check('① multipart 提交 200', first.status === 200, JSON.stringify(first.raw).slice(0, 300));
  const timings = first.data?.timings || {};
  check('② contentBytes = 二进制 part 的真实字节（大图 + 封面）',
    timings.contentBytes === BIG.length + COVER.length, `${timings.contentBytes} vs ${BIG.length + COVER.length}`);
  check('③ 返回 works 回显', Array.isArray(first.data?.works) && first.data.works.length === 1);
  // 2026-11-12 生产实测踩过：multipart 的文本 part 只塞 buffer 不转字符串 → 作品正文落库成空串。
  const storedSubmission = await arow('SELECT files FROM vibecoding_submissions ORDER BY submitted_at DESC LIMIT 1');
  const storedFiles = storedSubmission ? JSON.parse(storedSubmission.files || '{}') : {};
  check('⑧ multipart 文本正文完整落库（UTF-8，不是空串）', storedFiles['index.html'] === ENTRY, JSON.stringify(storedFiles['index.html'] || '').slice(0, 120));

  const noMeta = await upload(token, buildForm({ withMeta: false }));
  check('④ 缺 meta → 400 RUNTIME_UPLOAD_META_REQUIRED',
    noMeta.status === 400 && (noMeta.raw?.error?.code || noMeta.raw?.code) === 'RUNTIME_UPLOAD_META_REQUIRED',
    JSON.stringify(noMeta.raw).slice(0, 200));

  const again = await upload(token, buildForm());
  check('⑤ 同内容重复提交仍然 200', again.status === 200, JSON.stringify(again.raw).slice(0, 300));

  const index = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/index.js'), 'utf8'));
  const uploadSecurity = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/services/fileUploadSecurity.js'), 'utf8'));
  const runtime = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/routes/studentRuntime.js'), 'utf8'));
  check('⑥ submit-upload multipart 用业务档限额 + 大 JSON 内存闸',
    /runtimeUploadMaxBytes \+ 8 \* 1024 \* 1024/.test(index) && /isSubmitUpload[\s\S]*?acquireJsonBodySlot/.test(index));
  check('⑦ 多文件解析器与 multipart 收集器都在位',
    uploadSecurity.includes('export function parseMultipartParts')
    && runtime.includes('function collectMultipartArtifacts')
    && runtime.includes('RUNTIME_UPLOAD_META_REQUIRED'));
} finally {
  server.kill('SIGTERM');
}

if (failures) {
  console.error(`P219 FAILED: ${failures} 项`);
  process.exit(1);
}
console.log('P219 passed: submit-upload multipart 入口（meta + file:<i> + cover）与老 JSON 路径并存');
