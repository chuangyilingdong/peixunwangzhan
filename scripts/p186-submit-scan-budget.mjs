/**
 * P186 提交链路「扫描」口径（2026-10-05，客户端报「21.7MB 作品要等几十秒」）。
 *
 * 现场（客户端给的证据）：生产把 `FILE_UPLOAD_SCANNER` 指到 `/usr/local/bin/clamscan-limited`
 * （= 非驻留的 `clamscan`），**每个二进制文件各起一次**、每次重新加载 108MB 病毒库，
 * 冷启动实测 16–40 秒 —— 3 个文件、21.7MB 的作品，光扫描就要几十秒，按钮一直"处理中"。
 *
 * 这一轮改了四件事，本守卫逐条钉：
 *   ① `FILE_UPLOAD_SCANNER=off|none|disabled|skip` → **不扫**（内部教学平台，运营方明确口径）：
 *      连扫描器都不起（用一条**不存在的命令**配 off，能成功入库就证明没 spawn）；
 *   ② **一次提交只起一次扫描器**：3 个二进制文件 → 假扫描器只被调用 1 次（原来 3 次）；
 *   ③ 扫描结果按内容 **SHA256 复用**：同一批内容再交一次 → 调用次数不增加；
 *   ④ 检出/超时语义**不变**：假扫描器见到标记字节就 exit 1 → 400 MALICIOUS_FILE_BLOCKED，
 *      且那份文件**一个字节都没落库**；
 *   ⑤ 分阶段耗时：`submit-upload` 回 `timings`（fileCount/contentBytes/scanMs/storageMs/dbMs/totalMs/scanStatus），
 *      并往服务端日志打一行 `[submit-upload] …`，便于继续定位。
 *
 * 跑法：node scripts/p186-submit-scan-budget.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p186-scan-'));
const dbPath = path.join(temp, 'platform.db');
const uploadRoot = path.join(temp, 'uploads');
process.env.PLATFORM_DB_PATH = dbPath;
fs.mkdirSync(uploadRoot, { recursive: true });
const { aq, arow, acount } = await import('../packages/database/src/store.js');

const PORT = 18986;
const COUNT_FILE = path.join(temp, 'scan-calls.log');
// 假扫描器：记一次调用、看一眼内容，含标记字节就 exit 1（模拟"检出恶意"）。
const fakeScannerPath = path.join(temp, 'fake-scanner.mjs');
fs.writeFileSync(fakeScannerPath, [
  "import fs from 'node:fs';",
  'const targets = process.argv.slice(2);',
  `fs.appendFileSync(${JSON.stringify(COUNT_FILE)}, targets.join(',') + '\\n');`,
  "const marker = Buffer.from('EICAR-TEST-MARKER', 'utf8');",
  'for (const target of targets) {',
  '  const bytes = fs.readFileSync(target);',
  '  if (bytes.includes(marker)) process.exit(1);',
  '}',
  'process.exit(0);',
].join('\n'));

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  FILE_UPLOAD_ROOT: uploadRoot,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p186-guard-secret',
  PORT: String(PORT),
  // 扫描「开着」，但换成假扫描器（node + 脚本），这样调用次数看得见
  FILE_UPLOAD_SCANNER: process.execPath,
  FILE_UPLOAD_SCANNER_ARGS: fakeScannerPath,
  FILE_UPLOAD_SCANNER_TIMEOUT_MS: '20000',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const scanCalls = () => (fs.existsSync(COUNT_FILE) ? fs.readFileSync(COUNT_FILE, 'utf8').trim().split('\n').filter(Boolean) : []);

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);
await aq("UPDATE class_sessions SET delivery_mode='VIBECODING'");
await aq("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);

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
  check('① 夹具：学生可登录（VibeCoding 课堂已就绪）', Boolean(token));

  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
  const MP4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.from('0000000066726565', 'hex'), Buffer.from('000000006d646174', 'hex'), Buffer.alloc(64, 0x11)]);
  const WAV = Buffer.concat([Buffer.from('524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000', 'hex'), Buffer.alloc(8, 0x22)]);
  const ENTRY = '<!doctype html><html><head><meta charset="utf-8"><title>P186</title></head><body><h1>P186</h1></body></html>';
  const submitBody = (files) => ({
    name: 'index.html', title: 'P186 扫描预算', copyrightConfirmed: true,
    files: [{ name: 'index.html', content: ENTRY, binary: false }, ...files],
  });

  /* ───────── ② 三个二进制文件 → 扫描器只起一次 ───────── */
  const submitted = await api('/api/student/runtime/submit-upload', {
    method: 'POST', token,
    body: submitBody([
      { name: 'assets/mecha.png', content: PNG.toString('base64'), binary: true },
      { name: 'assets/transform.mp4', content: MP4.toString('base64'), binary: true },
      { name: 'assets/theme.wav', content: WAV.toString('base64'), binary: true },
    ]),
  });
  const calls = scanCalls();
  check('② ⭐ 一次提交只起**一次**扫描器（3 个二进制文件、原来会起 3 次）',
    submitted.status === 200 && calls.length === 1 && calls[0].split(',').length === 3,
    JSON.stringify({ status: submitted.status, calls: calls.length, targets: calls[0] }));
  const storedAssets = Number(await acount("SELECT COUNT(1) n FROM file_assets WHERE file_name IN ('mecha.png','transform.mp4','theme.wav')"));
  check('② 提交成功且素材入库（扫描没白跑）', submitted.status === 200 && storedAssets === 3,
    JSON.stringify({ status: submitted.status, storedAssets, files: (await arow('SELECT GROUP_CONCAT(file_name) names FROM file_assets')).names }));

  /* ───────── ⑤ 分阶段耗时 ───────── */
  const timings = submitted.data?.timings || null;
  check('⑤ ⭐ 提交响应带分阶段耗时（fileCount/contentBytes/scanMs/storageMs/dbMs/totalMs/scanStatus）',
    timings && typeof timings.scanMs === 'number' && typeof timings.storageMs === 'number' && typeof timings.dbMs === 'number'
      && typeof timings.totalMs === 'number' && timings.fileCount === 3 && timings.contentBytes > 0 && timings.scanStatus === 'PASSED',
    JSON.stringify(timings).slice(0, 220));
  check('⑤ 服务端日志也打一行 `[submit-upload] …`（线上定位用）',
    /\[submit-upload\] files=3 .*scanMs=\d+ storageMs=\d+ dbMs=\d+ totalMs=\d+/.test(serverLog),
    serverLog.split('\n').filter((line) => line.includes('[submit-upload]')).slice(-2).join(' / ').slice(0, 220));

  /* ───────── ③ 同内容 → SHA256 复用，不再起扫描器 ───────── */
  const again = await api('/api/student/runtime/submit-upload', {
    method: 'POST', token,
    body: submitBody([
      { name: 'assets/mecha.png', content: PNG.toString('base64'), binary: true },
      { name: 'assets/transform.mp4', content: MP4.toString('base64'), binary: true },
      { name: 'assets/theme.wav', content: WAV.toString('base64'), binary: true },
    ]),
  });
  check('③ ⭐ 同一批内容再交一次：扫描器调用次数**不增加**（SHA256 命中缓存）',
    again.status === 200 && scanCalls().length === 1 && Number(again.data?.timings?.scanCached || 0) === 3,
    JSON.stringify({ status: again.status, calls: scanCalls().length, timings: again.data?.timings }));

  /* ───────── ④ 检出语义不变：恶意件仍然拦下、且不落库 ───────── */
  const malicious = Buffer.concat([PNG, Buffer.from('EICAR-TEST-MARKER', 'utf8')]);
  const blocked = await api('/api/student/runtime/submit-upload', {
    method: 'POST', token,
    body: submitBody([{ name: 'assets/evil.png', content: malicious.toString('base64'), binary: true }]),
  });
  check('④ ⭐ 检出恶意文件 → 400 MALICIOUS_FILE_BLOCKED（扫描器 exit 1 的语义没变）',
    blocked.status === 400 && blocked.data?.error?.code === 'MALICIOUS_FILE_BLOCKED',
    JSON.stringify(blocked.raw).slice(0, 200));
  check('④ 被拦下的那份**没有落库**（拦得干净）',
    Number(await acount("SELECT COUNT(1) n FROM file_assets WHERE file_name='evil.png'")) === 0);

  /* ───────── ① 关闭模式：连扫描器都不起 ───────── */
  // 用一条**不存在的命令**配 off：真去 spawn 必然 ENOENT → 上传会失败；能成功就证明根本没起进程。
  {
    const { persistSecureUpload } = await import('../apps/server/src/services/fileUploadSecurity.js');
    const saved = process.env.FILE_UPLOAD_SCANNER;
    const savedRequire = process.env.FILE_UPLOAD_REQUIRE_SCANNER;
    process.env.FILE_UPLOAD_ROOT = uploadRoot;
    process.env.FILE_UPLOAD_SCANNER = 'off';
    process.env.FILE_UPLOAD_REQUIRE_SCANNER = 'true';   // 就算生产口径要求扫描，显式 off 也要能过
    const before = scanCalls().length;
    let offResult = null;
    let offError = null;
    try {
      offResult = await persistSecureUpload({ fileName: 'quiet.png', mimeType: 'image/png', buffer: PNG });
    } catch (error) {
      offError = error;
    }
    check('① ⭐ `FILE_UPLOAD_SCANNER=off` → 不扫也能入库（连扫描器都不起：配的是不存在的命令）',
      Boolean(offResult) && offResult.security?.status === 'SCANNER_DISABLED' && scanCalls().length === before,
      offError ? String(offError.message || offError) : JSON.stringify(offResult?.security));
    check('① 关闭状态在 security 上如实体现（`SCANNER_DISABLED`，不是假装扫过）',
      offResult?.security?.scanner === 'disabled' && offResult?.security?.status === 'SCANNER_DISABLED',
      JSON.stringify(offResult?.security));
    process.env.FILE_UPLOAD_SCANNER = saved;
    if (savedRequire === undefined) delete process.env.FILE_UPLOAD_REQUIRE_SCANNER;
    else process.env.FILE_UPLOAD_REQUIRE_SCANNER = savedRequire;
  }

  /* ───────── ⑥ 源码口径：整单一次、别再退回"每个文件一次" ───────── */
  {
    const runtime = fs.readFileSync(path.join(root, 'apps/server/src/routes/studentRuntime.js'), 'utf8');
    const upload = fs.readFileSync(path.join(root, 'apps/server/src/services/fileUploadSecurity.js'), 'utf8');
    check('⑥ 提交链路在**循环外**只调一次 `scanUploadBuffers(`（整单一次）',
      /const batchScan = await scanUploadBuffers\(binaries\.map/.test(runtime)
      && /scan: batchScan/.test(runtime));
    check('⑥ 扫描器关闭是**显式**开关（off/none/disabled/skip），不是"忘了配"',
      /SCANNER_OFF_VALUES = new Set\(\['off', 'none', 'disabled', 'skip'\]\)/.test(upload));
    check('⑥ 结果按 SHA256 缓存（只缓存 PASSED）', /scanPassedCache/.test(upload) && /scanCacheSet\(item\.hash\)/.test(upload));
  }
} catch (error) {
  failures += 1;
  console.error('P186 抛错：', error?.message || error);
  console.error(serverLog.split('\n').slice(-12).join('\n'));
} finally {
  server.kill('SIGTERM');
}

console.log(failures === 0 ? '\n✓ p186 提交扫描预算（关闭模式 / 整单一次 / SHA256 复用 / 检出语义 / 耗时日志）：全部通过' : `\n✗ p186 有 ${failures} 处不符合预期`);
assert.equal(failures, 0, `P186 有 ${failures} 条断言没过`);
