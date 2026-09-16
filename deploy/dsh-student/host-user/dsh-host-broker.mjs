// 宿主特权代理：把「动 root 的三件事」收到一个**白名单 socket 服务**里（2026-09-16）
//
// 为什么需要它（这是第一次真部署才暴露的问题）：平台服务跑在 systemd 加固下，
// 单元文件里有 `NoNewPrivileges=true` —— 这个标志会让 **sudo 直接拒绝提权**
// （原文：The "no new privileges" flag is set, which prevents sudo from running as root）。
// 所以「平台进程 → sudo → 宿主脚本」这条路在生产上是走不通的，不管 sudoers 怎么写。
//
// 三条路里选了第三条：
//   ① 关掉 NoNewPrivileges：能跑通，但把整个 API 服务的提权防线拆了 —— 不划算；
//   ② 让 setuid 一个 shell 脚本：比 sudo 更糟，绝不能做；
//   ③ **特权代理**（本文件）：一个 root 常驻的 socket 服务，按**白名单**执行那几个宿主脚本。
// 好处：加固全保留；不再依赖 setuid/sudo（权限面比原来那条窄 sudoers 更小）；
// 协议是显式的（有参数校验），不是「把 argv 原样转给 shell」。
//
// 安全边界（写清楚，改它的人要知道自己在改什么）：
//   · socket 权限 0660、属组只有平台账号 → 能连上它的就平台那一个身份；
//   · **不接受的请求**：未知 op、以 `-` 开头的参数值（否则会被脚本当成选项，比如 `--help`）、
//     超长的值、带 NUL/换行的值、产物名里的 `..`；
//   · **脚本路径写死在本文件里**，不从请求里来 —— 所以这个代理只能跑那三个既定脚本，
//     不是一个「以 root 执行任意命令」的后门；
//   · 永不把运行时密钥写进日志（那是能花平台算力钱的凭据）。
import { chmodSync, chownSync, existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';

const HOST_DIR = process.env.DSH_HOST_DIR || '/opt/dsh-host-user';
const SOCKET_PATH = process.env.DSH_BROKER_SOCKET || '/run/dsh-host-user/broker.sock';
const SOCKET_GROUP = process.env.DSH_BROKER_GROUP || 'ai-kids-prod';
const LAUNCH_TIMEOUT_MS = 90 * 1000;
const STOP_TIMEOUT_MS = 30 * 1000;
const COLLECT_TIMEOUT_MS = 60 * 1000;
const MAX_BUFFER = 96 * 1024 * 1024;
// 一次请求的总字节上限：取产物那条最大（base64 之后还会涨），给足但不能无限
const MAX_REQUEST_BYTES = 1 * 1024 * 1024;

// 出错时给日志一点上下文（**绝不包含运行时密钥**）
const CONTEXT = [];

/** 平台账号那一组的 GID：socket 的属组必须是它，否则平台连不上。 */
function groupId() {
  if (process.env.DSH_BROKER_GID) return Number(process.env.DSH_BROKER_GID);
  try { return Number(execFileSync('id', ['-g', SOCKET_GROUP], { encoding: 'utf8' }).trim()); }
  catch { return 0; }
}

const SCRIPTS = {
  launch: path.join(HOST_DIR, 'run-student-user.sh'),
  stop: path.join(HOST_DIR, 'stop-student-user.sh'),
  collect: path.join(HOST_DIR, 'collect-student-user.sh'),
};

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const NAME_PATTERN = /^[^\\/\0]{1,200}$/;

function fail(message, code = 'BROKER_BAD_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 参数值绝不能以 `-` 开头：目标脚本是 while-case 解析，`--ticket --help` 这种会被当成选项。 */
function safeValue(value, label, max = 500) {
  const text = String(value ?? '');
  if (!text) throw fail(`${label} 不能为空`);
  if (text.length > max) throw fail(`${label} 太长`);
  if (text.startsWith('-')) throw fail(`${label} 不能以 - 开头`);
  if (/[\0\n\r]/.test(text)) throw fail(`${label} 含非法字符`);
  return text;
}

function buildArgs(request) {
  const session = String(request.session ?? '');
  const student = String(request.student ?? '');
  if (!ID_PATTERN.test(session)) throw fail('session 不合法');
  if (!ID_PATTERN.test(student)) throw fail('student 不合法');
  CONTEXT.push(`op=${request.op}`, `student=${student}`);

  if (request.op === 'launch') {
    return {
      script: SCRIPTS.launch,
      timeout: LAUNCH_TIMEOUT_MS,
      args: [
        '--session', session, '--student', student,
        '--key', safeValue(request.key, 'key', 4000),
        '--gateway', safeValue(request.gateway, 'gateway', 400),
        '--ticket', safeValue(request.ticket, 'ticket', 400),
        ...(request.visionModel ? ['--vision-model', safeValue(request.visionModel, 'visionModel', 120)] : []),
      ],
    };
  }
  if (request.op === 'stop') {
    return { script: SCRIPTS.stop, timeout: STOP_TIMEOUT_MS, args: ['--session', session, '--student', student] };
  }
  if (request.op === 'collect') {
    const mode = String(request.mode || '');
    const base = ['--session', session, '--student', student];
    if (mode === 'list') return { script: SCRIPTS.collect, timeout: COLLECT_TIMEOUT_MS, args: [...base, '--list'] };
    if (mode === 'preserve') return { script: SCRIPTS.collect, timeout: COLLECT_TIMEOUT_MS, args: [...base, '--preserve'] };
    if (mode === 'export') {
      const name = String(request.name ?? '');
      if (name.includes('..') || !NAME_PATTERN.test(name)) throw fail('name 不合法（必须是工作区内的相对路径）');
      CONTEXT.push(`name=${name}`);
      return { script: SCRIPTS.collect, timeout: COLLECT_TIMEOUT_MS, args: [...base, '--export', name] };
    }
    throw fail(`collect 不认识的 mode：${mode}`);
  }
  throw fail(`不认识的 op：${request.op}`);
}

function handle(request) {
  return new Promise((resolve) => {
    let plan;
    try { plan = buildArgs(request); } catch (error) {
      resolve({ ok: false, code: error.code || 'BROKER_BAD_REQUEST', message: error.message, stderr: '' });
      return;
    }
    if (!existsSync(plan.script)) {
      resolve({ ok: false, code: 'BROKER_SCRIPT_MISSING', message: `宿主脚本不在：${plan.script}`, stderr: '' });
      return;
    }
    execFile(plan.script, plan.args, { timeout: plan.timeout, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      const out = String(stdout || '');
      const err = String(stderr || '');
      if (error) {
        // 日志只记 op/身份与脚本自己的报错，**不记密钥**
        console.error(`[broker] ${CONTEXT.join(' ')} 失败：${(err || error.message).trim().slice(0, 500)}`);
        resolve({ ok: false, code: 'BROKER_SCRIPT_FAILED', message: (err || error.message || '').trim().slice(0, 400), stdout: out, stderr: err });
        return;
      }
      resolve({ ok: true, code: 0, stdout: out, stderr: err });
    });
  });
}

const server = createServer((socket) => {
  let buffer = '';
  let done = false;
  socket.setEncoding('utf8');
  socket.on('data', async (chunk) => {
    if (done) return;
    buffer += chunk;
    if (buffer.length > MAX_REQUEST_BYTES) { done = true; socket.end(JSON.stringify({ ok: false, code: 'BROKER_TOO_LARGE', message: '请求太大' }) + '\n'); return; }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    done = true;
    const line = buffer.slice(0, newline);
    CONTEXT.length = 0;
    let request;
    try { request = JSON.parse(line); } catch { socket.end(JSON.stringify({ ok: false, code: 'BROKER_BAD_JSON', message: '请求不是 JSON' }) + '\n'); return; }
    const result = await handle(request || {});
    socket.end(JSON.stringify(result) + '\n');
  });
  socket.on('error', () => { /* 客户端断开：什么都不做，别把代理带下去 */ });
});

// 先删掉上次留下的 socket（进程被杀时不会自动清），再绑定、再收紧权限
try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch { /* 交给下面的 listen 报错 */ }
server.listen(SOCKET_PATH, () => {
  const gid = groupId();
  chmodSync(SOCKET_PATH, 0o660);
  // 属组改成平台账号那一组：能连上它的就只有那个身份（root 自己当然也能）
  try { chownSync(SOCKET_PATH, 0, gid); } catch (error) { console.error(`[broker] socket 改属组失败：${error.message}`); }
  console.log(`[broker] 就绪：${SOCKET_PATH}（0660，属组 ${SOCKET_GROUP} gid=${gid}）`);
});
server.on('error', (error) => {
  console.error(`[broker] 起不来：${error.message}`);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch { /* 无所谓 */ }
    process.exit(0);
  });
}
