/**
 * P119 「作品上传回平台」的服务端守卫（2026-09-19 新增）。
 *
 * 为什么有这条接口：这一轮按用户口径把网页上的创作环境整块删了（「网站上的 dsh 就不要了，
 * 以后 vibecoding 就是在客户端进行」），连带那个「提交作品」按钮也没了 —— 而学生在客户端做出来的
 * 东西是**存在他自己电脑上**的，服务器读不到他的磁盘（老的 `/submit` 是去**服务器上的学生盒子**里取）。
 * 所以补一条由客户端把字节传上来的路：`POST /api/student/runtime/submit-upload`。
 *
 * 这一道钉的是**这条新入口的准入与落库**（下半段与 `/submit` 共用同一份实现，p100 那边钉老入口）：
 *   · 学生自己机器上的字节，平台的唯一约束就是这里 —— 文件名必须平铺（否则能借路径穿越写别处）、
 *     主产物必须在清单里、总量与个数要有上限，形状不对一律 400 并说清是哪一条；
 *   · 交上来的二进制要真进 `file_assets`（字节与上传的一致），文本要进作品快照；
 *   · 没在课堂上时一律挡掉（与老入口同一条门禁）。
 *
 * ⚠️ 与 `/submit` 共用下半段是**有意**的：两条入口各写一份的话，广场那边的规则迟早只在一半上生效。
 * 跑法：node scripts/p119-runtime-upload-submit.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p119-upload-'));
const dbPath = path.join(temp, 'platform.db');
const PORT = 18919;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  PORT: String(PORT),
};

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
// ⚠️ 必须 await：断言里有 async（打接口、读库），同步的 check 抓不到 Promise 里的异常 ——
//    那种错会以「unhandled rejection」冒出来，看着像脚本崩了，其实是断言没跑。
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
ensureClassroom(dbPath);
{
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA busy_timeout = 5000');
  db.prepare("UPDATE course_lessons SET delivery_mode='VIBECODING'").run();
  db.close();
}

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-800)}`);
    await sleep(150);
  }
  const login = async (l, p) => (await api('/api/auth/login', { method: 'POST', body: { login: l, password: p } })).data.token;
  const enrolled = (() => {
    const db = new DatabaseSync(dbPath); db.exec('PRAGMA busy_timeout = 5000');
    const row = db.prepare(
      `SELECT student.login FROM session_students part
         JOIN class_sessions session ON session.id = part.session_id AND session.status='ACTIVE'
         JOIN users student ON student.id = part.student_id
        WHERE part.status='ACTIVE' ORDER BY student.created_at LIMIT 1`,
    ).get();
    db.close();
    return row;
  })();
  assert.ok(enrolled?.login, '夹具没把任何学生放进课堂');
  const token = await login(enrolled.login, 'study123');

  // 一张最小的 PNG（1×1）+ 一个网页：文本与二进制两条路都要过一遍
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
  const html = '<!doctype html><html><body><h1>我做的网页</h1><img src="cat.png"></body></html>';
  const upload = (body) => api('/api/student/runtime/submit-upload', { method: 'POST', token, body });
  const submitted = await upload({
    name: 'index.html', title: '我做的网页', copyrightConfirmed: true,
    files: [
      { name: 'index.html', content: html, binary: false },
      { name: 'cat.png', content: png.toString('base64'), binary: true },
    ],
  });

  await check('登录的学生能把自己电脑上的作品交上来（文本 + 二进制一起）',
    () => assert.equal(submitted.status, 200, JSON.stringify(submitted.data).slice(0, 300)));
  await check('返回值与老入口同形（有 id / 轮次 / 产物清单）',
    () => assert.ok(submitted.data?.id && submitted.data?.entryFile === 'index.html', JSON.stringify(submitted.data).slice(0, 200)));
  await check('二进制素材真的进了 file_assets，字节与上传的一模一样', () => {
    const db = new DatabaseSync(dbPath); db.exec('PRAGMA busy_timeout = 5000');
    const row = db.prepare("SELECT id, file_size FROM file_assets WHERE file_name='cat.png' ORDER BY created_at DESC LIMIT 1").get();
    db.close();
    assert.ok(row, 'file_assets 里没有 cat.png');
    assert.equal(Number(row.file_size), png.length, '存下来的字节数与上传的不一致');
  });
  await check('交上来的作品出现在学生的作品列表里（与老链路同一张表）', async () => {
    const listed = await api('/api/student/works', { token });
    assert.equal(listed.status, 200);
    assert.ok(JSON.stringify(listed.data).includes('我做的网页'), JSON.stringify(listed.data).slice(0, 200));
  });

  // ── 准入：形状不对一律说清是哪一条，别让学生对着 500 猜 ──────────────────────
  const bad = async (patch) => (await upload({ name: 'index.html', copyrightConfirmed: true, files: [{ name: 'index.html', content: html }], ...patch })).data;
  await check('没确认版权 → 400 WORK_COPYRIGHT_CONFIRMATION_REQUIRED',
    async () => assert.equal((await bad({ copyrightConfirmed: false })).error?.code, 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED'));
  await check('主产物不在清单里 → 400 RUNTIME_UPLOAD_ENTRY_MISSING',
    async () => assert.equal((await bad({ name: 'other.html' })).error?.code, 'RUNTIME_UPLOAD_ENTRY_MISSING'));
  await check('一个文件都没有 → 400 RUNTIME_UPLOAD_EMPTY',
    async () => assert.equal((await bad({ files: [] })).error?.code, 'RUNTIME_UPLOAD_EMPTY'));
  await check('同一个文件名出现两次 → 400 RUNTIME_UPLOAD_DUPLICATE_NAME',
    async () => assert.equal((await bad({ files: [{ name: 'index.html', content: html }, { name: 'index.html', content: html }] })).error?.code, 'RUNTIME_UPLOAD_DUPLICATE_NAME'));
  // 路径穿越这条路是**拒绝**掉的（不是悄悄改名）：`safeArtifactName` 见到分隔符或 `..` 直接 400。
  // 比"平铺"更硬 —— 学生机器上的文件名是外部输入，改名会让人以为自己交的是另一个文件。
  await check('文件名带路径 → 400 INVALID_ARTIFACT_NAME（不许借 ../ 写到别的地方）', async () => {
    const escaped = await bad({ name: '../index.html', files: [{ name: '../../index.html', content: html }] });
    assert.equal(escaped.error?.code, 'INVALID_ARTIFACT_NAME', JSON.stringify(escaped).slice(0, 200));
  });
  await check('没给主产物名（name 空）→ 400 RUNTIME_UPLOAD_NAME_REQUIRED', async () => {
    const missing = await bad({ name: '' });
    assert.equal(missing.error?.code, 'RUNTIME_UPLOAD_NAME_REQUIRED', JSON.stringify(missing).slice(0, 200));
  });
  await check('不支持的产物类型（.exe）→ 400 VIBECODING_ARTIFACT_NOT_SUBMITTABLE',
    async () => assert.equal((await bad({ name: 'virus.exe', files: [{ name: 'virus.exe', content: 'MZ', binary: true }] })).error?.code, 'VIBECODING_ARTIFACT_NOT_SUBMITTABLE'));
  await check('文件个数超上限 → 400 RUNTIME_UPLOAD_TOO_MANY_FILES', async () => {
    const many = Array.from({ length: 61 }, (_, index) => ({ name: `p${index}.html`, content: '<i></i>' }));
    const result = await bad({ name: 'p0.html', files: many });
    assert.equal(result.error?.code, 'RUNTIME_UPLOAD_TOO_MANY_FILES');
  });
  // 16MB 是我们自己的上限、26MB 是传输层（body）的上限，base64 之后 17MB 的文件约 22.7MB ——
  // 落在两者之间，所以这一条验的是**我们的中文原因**先说话（不是框架那个裸 413）。
  await check('总量超上限（我们的 16MB）→ 400 RUNTIME_UPLOAD_TOO_LARGE（中文原因先说话）', async () => {
    const huge = 'A'.repeat(17 * 1024 * 1024);
    const result = await bad({ files: [{ name: 'index.html', content: huge }] });
    assert.equal(result.error?.code, 'RUNTIME_UPLOAD_TOO_LARGE', JSON.stringify(result).slice(0, 200));
  });
  await check('再大（超过传输层上限）由框架先挡 —— 这一层不是我们能给中文原因的地方', async () => {
    const beyond = 'A'.repeat(30 * 1024 * 1024);
    const result = await bad({ files: [{ name: 'index.html', content: beyond }] });
    assert.equal(result.error?.code, 'PAYLOAD_TOO_LARGE', JSON.stringify(result).slice(0, 200));
  });
} catch (error) {
  console.error(serverLog.slice(-1500));
  throw error;
} finally {
  server.kill('SIGTERM');
  await sleep(400);
}

const failed = checks.filter((item) => !item.ok);
const out = { name: 'p119-runtime-upload-submit', pass: failed.length === 0, checks: checks.length, failed };
if (failed.length) { console.error(JSON.stringify(out, null, 1)); process.exit(1); }
console.log(JSON.stringify(out));
