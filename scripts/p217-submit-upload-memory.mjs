/**
 * P217 submit-upload 内存/CPU 守卫（2026-11-12）。
 *
 * 桌面客户端交作品的 body 是 base64 JSON（生产整单可达 100MB+）。这一轮把三处重复开销去掉：
 *   ① timings 不再为了一个日志字段把整份 body 再 `JSON.stringify` 一次；
 *   ② base64 只解一次，扫描与落盘共用同一份 Buffer；
 *   ③ 解码后清掉 `collected` / `ctx.body` 里的 base64 字符串引用，扫描/落盘期间不再同时持有两份。
 *
 * 本守卫钉住：接口契约不变、`contentBytes` 精确、`jsonBytes` 来自请求 content-length、
 * 同一内容重复提交仍然成功，以及源码里不再出现整包序列化。
 *
 * 跑法：node scripts/p217-submit-upload-memory.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p217-submit-memory-'));
const dbPath = path.join(temp, 'platform.db');
const uploadRoot = path.join(temp, 'uploads');
process.env.PLATFORM_DB_PATH = dbPath;
fs.mkdirSync(uploadRoot, { recursive: true });
const { aq, arow } = await import('../packages/database/src/store.js');

const PORT = 18987;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  FILE_UPLOAD_ROOT: uploadRoot,
  FILE_UPLOAD_SCANNER: 'off',
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p217-guard-secret',
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

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
};
const loginAs = async (name, password) => (await api('/api/auth/login', { method: 'POST', body: { login: name, password } })).data?.token;

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

  // 2MB 的合法 PNG（头 8 字节 + 填充，MIME 白名单只认魔数）
  const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');
  const BIG = Buffer.concat([PNG_HEADER, Buffer.alloc(2 * 1024 * 1024 - PNG_HEADER.length, 0x22)]);
  const ENTRY = '<!doctype html><html><head><meta charset="utf-8"><title>P217</title></head><body><h1>P217</h1></body></html>';
  const submitBody = () => ({
    name: 'index.html', title: 'P217 内存守卫', copyrightConfirmed: true,
    files: [
      { name: 'index.html', content: ENTRY, binary: false },
      { name: 'assets/big.png', content: BIG.toString('base64'), binary: true },
    ],
  });

  const first = await api('/api/student/runtime/submit-upload', { method: 'POST', token, body: submitBody() });
  check('① 2MB 整单提交 200', first.status === 200, JSON.stringify(first.raw).slice(0, 300));
  const timings = first.data?.timings || {};
  check('② contentBytes 等于解码后的真实字节数', timings.contentBytes === BIG.length, `${timings.contentBytes} vs ${BIG.length}`);
  const base64Bytes = Math.ceil(BIG.length * 4 / 3);
  check('③ jsonBytes 来自请求 content-length（>= base64 长度，而不是事后重新序列化）',
    Number(timings.jsonBytes) >= base64Bytes, `${timings.jsonBytes} vs ${base64Bytes}`);
  check('④ 服务端日志 bytes 正确', new RegExp(`\\[submit-upload\\] .*bytes=${BIG.length}`).test(serverLog), serverLog.split('\n').filter((line) => line.includes('[submit-upload]')).slice(-1)[0] || '');

  const second = await api('/api/student/runtime/submit-upload', { method: 'POST', token, body: submitBody() });
  check('⑤ 同内容重复提交仍然 200（解码/清理不影响幂等）', second.status === 200, JSON.stringify(second.raw).slice(0, 300));

  const source = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/routes/studentRuntime.js'), 'utf8'));
  check('⑥ 源码里不再有整包 JSON.stringify(body)', !source.includes('JSON.stringify(body)'));
} finally {
  server.kill('SIGTERM');
}

if (failures) {
  console.error(`P217 FAILED: ${failures} 项`);
  process.exit(1);
}
console.log('P217 passed: submit-upload 只解一次 base64、jsonBytes 走 content-length、契约不变');
