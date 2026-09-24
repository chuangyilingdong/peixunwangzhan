/**
 * P138 「请求体过大」之后这条连接不能再用（2026-09-24 新增）。
 *
 * 为什么有这条：服务端读 body 是**读到一半就回话**的（readJson/readBodyBuffer 一超限就抛；
 * 读 body 之前的内存闸 UPLOAD_BUSY 更狠，压根没读）。此时响应**如果还写着 keep-alive**，
 * 客户端就会把这条连接放回池子里复用 —— 而这条连接上还堵着几十 MB 没写完的字节，
 * 谁复用到它谁就挂住（实测 304 秒才报传输层错误，看着像"接口死了"）。
 *
 * 它长期以**偶发超时**的形式坑验收，所以以前一直没被认出来：
 *   p119 的第 22 条（17MB/30MB 那两条之后的 `/status`）被判「120s 超时失败」——
 *   断言其实**全过**，是那条被毒住的连接把整个脚本拖过了套件的超时线。
 *   （同一天同一份代码，12:30 跑是 8.8 秒，12:45 跑就 307 秒，全看池子里挑到哪条连接。）
 *
 * 这条钉子钉三件事：
 *   ① 超限拒绝**仍然说中文**（PAYLOAD_TOO_LARGE）—— 别为了关连接把原因吞了；
 *   ② 拒绝之后紧接着的请求必须**马上**回来（没关连接的话这里会挂几分钟 → 本脚本超时；
 *      注意这是**概率性**的：毒连接要被复用上才发作，所以这里连打三次，别只打一次）；
 *   ③ 反过来也要钉住：正常请求**仍然保持 keep-alive**（别把整站都改成关连接）。
 *
 * 跑法：node scripts/p138-oversized-body-keepalive.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p138-'));
const PORT = 18938;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: path.join(temp, 'platform.db'),
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  PORT: String(PORT),
};
const base = `http://127.0.0.1:${PORT}`;

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const checks = [];
// 必须 await：断言里有 async（打接口），同步的 check 抓不到 Promise 里的异常。
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

// 一个带**硬期限**的请求：挂在连接上的话，这里会如实报"没回来"，而不是把整个脚本吊死。
// ⚠️ 期限的定时器必须在 fetch 落定后清掉：留着它，进程会一直等到它触发才肯退出 ——
//    那正是"脚本跑完了却被判超时"的老坑（这个仓库里踩过好几次）。
const fetchWithin = async (url, options, limitMs) => {
  let timer;
  try {
    return await Promise.race([
      fetch(url, options).then(async (res) => ({ res, body: await res.text() })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`请求 ${limitMs}ms 没回来（连接被毒住的特征）`)), limitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  const upload = (content) => fetchWithin(`${base}/api/student/runtime/submit-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'index.html', copyrightConfirmed: true, files: [{ name: 'index.html', content }] }),
  }, 20_000);

  // ① 超限仍然说清是哪一条（中文原因），并且**当场告诉客户端这条连接别再用了**
  let oversized;
  await check('30MB 的包：400 PAYLOAD_TOO_LARGE + connection: close（读完之前就回话的连接不许复用）', async () => {
    const { res, body } = await upload('A'.repeat(30 * 1024 * 1024));
    assert.equal(res.status, 400, body.slice(0, 200));
    assert.equal(JSON.parse(body).error?.code, 'PAYLOAD_TOO_LARGE', body.slice(0, 200));
    assert.equal(res.headers.get('connection'), 'close', '超限拒绝时**必须**声明关连接，否则池子里会留下一条毒连接');
    oversized = res;
  });

  // ② ⭐ 关键那一条：紧接着连打三次普通请求，都必须秒回。
  //    为什么是三次：毒连接要被**复用上**才发作（池子里不止一条），一次打不出来。
  await check('超限之后：紧接着的 3 个请求都要秒回（毒连接会让其中之一挂几分钟）', async () => {
    assert.ok(oversized, '第①条没过，这里没有意义');
    for (let i = 1; i <= 3; i += 1) {
      const started = Date.now();
      const { res } = await fetchWithin(`${base}/health`, {}, 5_000);
      assert.equal(res.status, 200, `第 ${i} 个请求状态不对`);
      assert.ok(Date.now() - started < 5_000, `第 ${i} 个请求被拖住了`);
    }
  });

  // ③ 反向：正常请求仍然 keep-alive（别为了关连接把整站都改成一遍一连接）
  await check('正常的小请求：仍然是 keep-alive（没有被"一刀切关连接"）', async () => {
    const { res } = await fetchWithin(`${base}/health`, {}, 10_000);
    assert.equal(res.status, 200);
    assert.notEqual(res.headers.get('connection'), 'close', '正常请求不该关连接');
  });
} catch (error) {
  console.error(serverLog.slice(-1500));
  throw error;
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
}

const failed = checks.filter((item) => !item.ok);
const out = { name: 'p138-oversized-body-keepalive', pass: failed.length === 0, checks: checks.length, failed };
if (failed.length) { console.error(JSON.stringify(out, null, 1)); process.exit(1); }
console.log(JSON.stringify(out));
