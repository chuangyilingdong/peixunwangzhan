// 「给一个学生开一台创作环境」——平台侧拉起学生容器（2026-09-16）
//
// 背景：学生端的 VibeCoding 用 dsh 之后，每个学生要有一台**自己的**盒子
// （自己的文件系统、自己的进程、自己的内存上限）。平台要做的事就三件：
//   ① 门禁：课堂仍在进行 + 学生在名单里 —— 与「调模型」那条路**同一套**规矩；
//   ② 身份：签一把只属于这节课这个学生的运行时密钥，连同一张短时入口票据发下去；
//   ③ 起盒子：调宿主上的脚本（`deploy/dsh-student/host/run-student-container.sh`），
//      拿回容器名与宿主端口，拼出学生该访问的入口地址。
//
// 为什么把「怎么起」收在一个脚本里：宿主可以是平台自己这台机器，也可以是以后另买的一台。
// 平台这里只知道「调这个脚本、读它的输出」，换机器不用改平台代码。
//
// 硬约束：
//   · **容器本身是状态的唯一真相**（`docker ps` 里那个带标签的容器），不在库里另存一份会漂移的副本；
//   · 门禁不过就**不开盒子**（老师结束课堂后再也开不出来），与调模型那条路一致；
//   · 失败要**吵**：脚本没装、docker 不在、端口池满了，都明确报错，不能悄悄返回一个假入口。
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { errors, row } from '../lib.js';
import { issueRuntimeKey, assertRuntimeClassroomActive } from '../routes/runtimeGateway.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 90 * 1000;
const STOP_TIMEOUT_MS = 30 * 1000;
const COLLECT_TIMEOUT_MS = 60 * 1000;
// 取产物要把文件内容整份带回来（二进制走 base64 后还会涨三分之一），默认那 1MB 的 stdout 上限
// 根本不够。与宿主侧 collect-student.mjs 的 MAX_TOTAL_BYTES（48MB）配套：48MB 的 base64 约 64MB。
const COLLECT_MAX_BUFFER = 96 * 1024 * 1024;
const NAME_PREFIX = 'dsh-s-';

function config() {
  // 两种形态，输出同一套 KEY=VALUE，平台侧只看 DSH_RUNTIME_MODE 这一个开关：
  //   · user（默认，2026-09-16 用户口径「成本要紧」）：同机独立 Linux 用户，host-user/ 下的脚本；
  //   · container：一人一容器，host/ 下的脚本（机器扩容后仍可用）。
  const mode = String(process.env.DSH_RUNTIME_MODE || 'user').trim() === 'container' ? 'container' : 'user';
  return {
    mode,
    enabled: String(process.env.DSH_RUNTIME_ENABLED || 'true') !== 'false',
    launchScript: String(process.env.DSH_RUNTIME_LAUNCH_SCRIPT
      || (mode === 'container' ? '/opt/dsh-host/run-student-container.sh' : '/opt/dsh-host-user/run-student-user.sh')).trim(),
    stopScript: String(process.env.DSH_RUNTIME_STOP_SCRIPT
      || (mode === 'container' ? '/opt/dsh-host/stop-student-container.sh' : '/opt/dsh-host-user/stop-student-user.sh')).trim(),
    // 学生环境从宿主里访问我们网关的地址：用户版与平台同机，走公网域名（TLS 与容器版同一条路）。
    gatewayUrl: String(process.env.DSH_RUNTIME_GATEWAY_URL || 'https://iicili.cyou/api/gateway/v1').trim(),
    // 入口前缀：用户版是「域名:端口」（dsh 硬注入 <base href="/">，挂不了子路径 —— 实测过），
    // 所以脚本直接给完整 EDGE_URL，这里留空即表示「用脚本给的地址」。
    edgeBase: String(process.env.DSH_RUNTIME_EDGE_BASE || '').trim(),
    visionModel: String(process.env.DSH_RUNTIME_VISION_MODEL || 'platform-vision').trim(),
    // 取产物（学生点「提交作品」时用）：列清单与取回一份，都是同一个脚本的两个子命令。
    collectScript: String(process.env.DSH_RUNTIME_COLLECT_SCRIPT
      || (mode === 'container' ? '/opt/dsh-host/collect-student-container.sh' : '/opt/dsh-host-user/collect-student-user.sh')).trim(),
    // 怎么「动 root」这件事，两种通道（2026-09-16 第一次真部署才发现要分）：
    //   · broker（用户版默认）：连宿主上的**特权代理** socket —— 平台服务跑在
    //     systemd 加固下（单元里有 NoNewPrivileges=true），那个标志会让 **sudo 拒绝提权**，
    //     所以「平台 → sudo → 脚本」在生产上根本走不通；
    //   · script：直接跑脚本（容器版不需要 root；本地/守卫里也是这条，好测）。
    transport: (String(process.env.DSH_RUNTIME_TRANSPORT || (mode === 'container' ? 'script' : 'broker')).trim() === 'script' ? 'script' : 'broker'),
    brokerSocket: String(process.env.DSH_RUNTIME_BROKER_SOCKET || '/run/dsh-host-user/broker.sock').trim(),
  };
}

/** 容器名：与宿主脚本同一套规则（净化 + 截断），两处必须一致，否则停不掉。 */
function containerNameFor(sessionId, studentId) {
  const sane = (value) => String(value || '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 48);
  return `${NAME_PREFIX}${sane(sessionId)}-${sane(studentId)}`;
}

// 用户版的脚本要 root（建 Linux 用户、写 nginx 入口、起 systemd 单元），平台进程是普通账号，
// 所以走一条**窄的 sudoers 规则**：只允许它跑这两个脚本，不给整机权限。
// 容器版不需要（平台进程在 docker 组里即可），所以按模式决定。
function useSudo() {
  const cfg = config();
  return String(process.env.DSH_RUNTIME_SUDO || (cfg.mode === 'user' ? 'true' : 'false')) !== 'false';
}

function runScript(script, args, { timeout, maxBuffer = 1024 * 1024 } = {}) {
  const command = useSudo() ? 'sudo' : 'bash';
  const argv = useSudo() ? ['-n', script, ...args] : [script, ...args];
  return new Promise((resolve, reject) => {
    execFile(command, argv, { timeout, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        // sudo 没有权限时会给出很干的报错，这里补一句人能看懂的
        const detail = /sudo/i.test(String(error.message)) && /password|not allowed|no tty/i.test(String(stderr))
          ? `平台账号没有运行宿主脚本的权限（检查 sudoers 规则）；原文：${String(stderr).trim().slice(0, 200)}`
          : String(stderr || error.message || '').trim().slice(0, 400);
        reject(hostError(detail, 'RUNTIME_HOST_SCRIPT_FAILED'));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

/**
 * 宿主脚本约定的输出：**stdout 一行 JSON**，告警与错误走 stderr。
 * 解析不出来就报错（而不是返回一个空清单让界面显示「你没有作品」—— 那是在骗人）。
 */
function parseScriptJson(stdout, what) {
  const text = String(stdout || '').trim();
  const lastLine = text.split('\n').filter((line) => line.trim().startsWith('{')).pop();
  if (!lastLine) throw Object.assign(new Error(`宿主脚本没有输出 JSON（${what}）：${text.slice(0, 200)}`), { code: 'RUNTIME_HOST_SCRIPT_OUTPUT_INVALID' });
  try {
    return JSON.parse(lastLine);
  } catch {
    throw Object.assign(new Error(`宿主脚本输出的 JSON 解析失败（${what}）：${lastLine.slice(0, 200)}`), { code: 'RUNTIME_HOST_SCRIPT_OUTPUT_INVALID' });
  }
}

/**
 * 这个学生现在能提交哪些作品 —— 读他创作环境的工作区。
 *
 * 产物在哪是**实测出来的**，不是按文档推的（2026-09-16）：dsh 的 PPT 插件做完演示文稿会把
 * 成果发布到工作区里（以标题命名的目录，含 PPTD 工程与成品 .pptx），网页作品也落在工作区，
 * 所以「枚举工作区」对这两类都成立。会话日志里的 `deliverables/presented` 只记路径、不复制内容，
 * 还依赖模型记得调 present 工具，所以**不拿它当唯一真相**。
 */
export async function listStudentDeliverables({ sessionId, studentId, orgId, lessonId = null }) {
  const cfg = config();
  assertCollectable({ sessionId, studentId, orgId, lessonId });
  const stdout = await runHost('collect', { session: sessionId, student: studentId, mode: 'list' }, { timeout: COLLECT_TIMEOUT_MS });
  const parsed = parseScriptJson(stdout, '列产物');
  return {
    workspace: parsed.workspace || null,
    truncated: Boolean(parsed.truncated),
    deliverables: Array.isArray(parsed.deliverables) ? parsed.deliverables : [],
    // 超限/符号链接这类「看到了但不能给你」的东西也如实下发，界面才能说清为什么少了一份
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
  };
}

/**
 * 取回一份产物：它自己 + 它引用的本地素材。
 * @returns {Promise<{name: string, kind: string, files: Array<{name, encoding, content, bytes, binary, sha256}>, missing: string[], totalBytes: number}>}
 */
export async function collectStudentDeliverable({ sessionId, studentId, orgId, lessonId = null, name }) {
  const cfg = config();
  assertCollectable({ sessionId, studentId, orgId, lessonId });
  const wanted = String(name || '').trim();
  if (!wanted) throw errors.badRequest('要取哪一份产物得说出来', 'RUNTIME_DELIVERABLE_REQUIRED');
  const stdout = await runHost('collect', { session: sessionId, student: studentId, mode: 'export', name: wanted }, { timeout: COLLECT_TIMEOUT_MS });
  const collected = parseScriptJson(stdout, '取产物');
  if (!Array.isArray(collected.files) || !collected.files.length) {
    throw errors.conflict('这份产物取回来是空的', 'RUNTIME_DELIVERABLE_EMPTY');
  }
  return collected;
}

/** 列产物/取产物共用的前置：脚本在不在 + 门禁（与开盒子、调模型同一套）。 */
function assertCollectable({ sessionId, studentId, orgId, lessonId }) {
  // 「取产物这条通道在不在」单独判：script 模式下它看的是 collect 脚本（与开盒子看的不是同一个文件）
  const availability = hostChannel('collect');
  if (!availability.available) {
    throw errors.conflict(`这台机器还不能取学生的作品：${availability.reason}`, 'RUNTIME_LAUNCH_UNAVAILABLE');
  }
  const student = row('SELECT id,org_id FROM users WHERE id=?', [studentId]);
  if (!student || student.org_id !== orgId) throw errors.forbidden('学生不属于该机构', 'RUNTIME_STUDENT_INVALID');
  // 门禁：课堂 ACTIVE + 学生在名单里。下课之后连「取作品」都不给 —— 作品靠宿主侧的留存兜底
  // （收环境前会先留一份，见 stop-student-user.sh），不靠让学生继续访问已经收掉的环境。
  return assertRuntimeClassroomActive({ o: orgId, u: studentId, s: sessionId, l: lessonId });
}

function parseLaunchOutput(stdout) {
  const pick = (key) => (String(stdout).split('\n').find((line) => line.startsWith(`${key}=`)) || '').split('=').slice(1).join('=').trim();
  // 容器版回报 CONTAINER_NAME，用户版回报 RUNTIME_NAME —— 同一套输出，两个键都认。
  const containerName = pick('CONTAINER_NAME') || pick('RUNTIME_NAME');
  const hostPort = Number(pick('HOST_PORT')) || 0;
  if (!containerName || !hostPort) throw Object.assign(new Error('宿主脚本没有回报容器名与端口'), { code: 'RUNTIME_HOST_SCRIPT_OUTPUT_INVALID' });
  return { containerName, hostPort };
}

/**
 * 宿主脚本的调用计划：**一次操作 → 一个脚本 + 一串 argv**。
 * 两种通道（特权代理 / 直接跑脚本）共用这一份，免得两边参数写法漂移
 * （漂移的后果是「本地测通了、生产上参数不一样」）。
 */
function scriptPlanFor(op, params) {
  const cfg = config();
  const base = ['--session', params.session, '--student', params.student];
  if (op === 'launch') {
    return {
      script: cfg.launchScript,
      args: [...base, '--key', params.key, '--gateway', cfg.gatewayUrl, '--ticket', params.ticket,
        ...(cfg.visionModel ? ['--vision-model', cfg.visionModel] : []),
        ...(cfg.mode === 'container' ? ['--name', params.containerName] : [])],
    };
  }
  if (op === 'stop') {
    return {
      script: cfg.stopScript,
      args: cfg.mode === 'container'
        ? (params.containerName ? ['--name', params.containerName] : ['--session', params.session])
        : base,
    };
  }
  if (op === 'collect') {
    const tail = params.mode === 'export' ? ['--export', params.name] : [`--${params.mode}`];
    return { script: cfg.collectScript, args: [...base, ...tail] };
  }
  throw new Error(`不认识的宿主操作：${op}`);
}

/** 走特权代理：一行 JSON 请求，一行 JSON 应答（见 deploy/dsh-student/host-user/dsh-host-broker.mjs）。 */
function callBroker(payload, timeout) {
  const cfg = config();
  return new Promise((resolve, reject) => {
    const socket = connect(cfg.brokerSocket);
    let buffer = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; socket.destroy(); fn(value); } };
    socket.setEncoding('utf8');
    socket.setTimeout(timeout, () => finish(reject, Object.assign(new Error(`宿主代理超时（${timeout}ms）`), { code: 'RUNTIME_HOST_SCRIPT_FAILED' })));
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let parsed;
      try { parsed = JSON.parse(buffer.slice(0, newline)); }
      catch { finish(reject, Object.assign(new Error('宿主代理的应答不是 JSON'), { code: 'RUNTIME_HOST_SCRIPT_OUTPUT_INVALID' })); return; }
      finish(resolve, parsed || {});
    });
    socket.on('error', (error) => finish(reject, Object.assign(
      new Error(`连不上宿主代理（${cfg.brokerSocket}）：${error.message}；检查 dsh-host-broker 服务是否在跑`),
      { code: 'RUNTIME_HOST_SCRIPT_FAILED' },
    )));
    socket.on('close', () => finish(reject, Object.assign(new Error('宿主代理提前断开'), { code: 'RUNTIME_HOST_SCRIPT_FAILED' })));
  });
}

/**
 * 宿主脚本的报错 → **对外的明确答复**。
 * 为什么需要：脚本的失败原来会一路冒成 500「服务器内部错误」，可「这个学生还没有创作环境」
 * 根本不是服务端故障 —— 它是学生少做了一步（先点「进入创作环境」）。报成 500 既误导排查，
 * 也让学生看到一个「系统坏了」的界面。
 *
 * ⚠️ 2026-09-17 补上另一半（浏览器实检时抓到）：**其余失败原来也是 500**。
 * 宿主脚本失败的原因是「这台机器可用内存装不下新环境」「端口池占满了」这类
 * **学生看得懂、也说得清**的话（脚本自己打的就是给人看的中文），却被吞成一个
 * 「服务器内部错误」—— 学生不知道发生了什么，老师也只看到 500。
 * 现在：对外 503 + 脚本原话的尾巴；完整原文进服务器日志（诊断靠日志，不靠学生转述）。
 */
function hostError(message, fallbackCode) {
  const text = String(message || '').trim();
  if (/COLLECT_NO_USER|COLLECT_NO_WORKSPACE/.test(text)) {
    return errors.conflict('你的创作环境还没开起来（或已经被收回）。先点「进入创作环境」，再回来提交作品。', 'RUNTIME_NOT_LAUNCHED');
  }
  const code = fallbackCode || 'RUNTIME_HOST_SCRIPT_FAILED';
  if (!text) {
    console.error(`[studentRuntime] 宿主操作失败（${code}）：脚本没有给出原因`);
    return errors.serviceUnavailable('创作环境没开起来，请告诉老师（服务器上会有记录）。', code);
  }
  console.error(`[studentRuntime] 宿主操作失败（${code}）：${text}`);
  // 只带最后几行：脚本的报错本来就是「一句中文说明」，前面几行是过程日志
  const tail = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join('；').slice(0, 300);
  return errors.serviceUnavailable(`创作环境没开起来：${tail}`, code);
}

/**
 * 执行一次宿主操作，返回脚本的 stdout。
 * 失败一律抛错（**失败要吵**）—— 调用方不该拿到一个「看着像成功」的空结果。
 */
async function runHost(op, params, { timeout }) {
  const cfg = config();
  if (cfg.transport === 'broker') {
    const result = await callBroker({ op, ...params }, timeout);
    if (!result.ok) {
      const detail = [result.message, String(result.stderr || '').trim()].filter(Boolean).join('；').slice(0, 400);
      throw hostError(detail, result.code);
    }
    return String(result.stdout || '');
  }
  const plan = scriptPlanFor(op, params);
  return runScript(plan.script, plan.args, { timeout });
}

/**
 * 「动宿主的通道」现在在位吗？
 * @param {'launch'|'stop'|'collect'} which 只有 script 模式才需要区分（看哪个脚本），
 *   broker 模式三种操作共用同一个 socket。
 */
function hostChannel(which) {
  const cfg = config();
  if (!cfg.enabled) return { available: false, reason: '未启用（DSH_RUNTIME_ENABLED=false）' };
  if (cfg.transport === 'broker') {
    // 代理没起来（或 socket 权限不对）时**明确说不可用**，让学生界面退回原来的入口，
    // 而不是等他点了「进入创作环境」才失败。
    if (!existsSync(cfg.brokerSocket)) return { available: false, reason: `宿主代理 socket 不在：${cfg.brokerSocket}（dsh-host-broker 没跑？）` };
    return { available: true, reason: '' };
  }
  const script = which === 'collect' ? cfg.collectScript : which === 'stop' ? cfg.stopScript : cfg.launchScript;
  if (!existsSync(script)) return { available: false, reason: `宿主脚本不在：${script}` };
  return { available: true, reason: '' };
}

/**
 * 学生侧要访问的网关地址 —— **宿主那条路（开盒子）与桌面客户端必须用同一个**，
 * 所以只在这里读一次环境变量，两边都走这个函数（各读一份迟早会漂开）。
 * 桌面客户端拿到它之后写进 dsh 的 provider baseURL；不写的话模型调用就不经过我们的账本。
 */
export function runtimeGatewayUrl() {
  return config().gatewayUrl;
}

/** 这台机器现在能不能开盒子（给管理端/学生端一个明确的「不可用」而不是转圈）。 */
export function studentRuntimeAvailability() {
  return hostChannel('launch');
}

/**
 * 开一台学生盒子。
 * @param {{sessionId: string, studentId: string, orgId: string, lessonId?: string|null}} input
 * @returns {Promise<{containerName: string, hostPort: number, edgeUrl: string, expiresAt: string}>}
 */
export async function launchStudentRuntime({ sessionId, studentId, orgId, lessonId = null }) {
  const cfg = config();
  const availability = studentRuntimeAvailability();
  if (!availability.available) throw errors.conflict(`这台机器还不能开学生创作环境：${availability.reason}`, 'RUNTIME_LAUNCH_UNAVAILABLE');

  // ① 门禁：与调模型那条路同一套（课堂 ACTIVE + 学生在名单里）。这里是**开盒子**时的那道，
  //    调模型时还会再过一次 —— 中途被移出名单/课堂结束，盒子留着也用不了。
  const student = row('SELECT id,org_id FROM users WHERE id=?', [studentId]);
  if (!student || student.org_id !== orgId) throw errors.forbidden('学生不属于该机构', 'RUNTIME_STUDENT_INVALID');
  const classroom = assertRuntimeClassroomActive({ o: orgId, u: studentId, s: sessionId, l: lessonId });

  // ② 身份：一把只属于这节课这个学生的运行时密钥 + 一张短时入口票据（容器起来后就认这张）
  const runtimeKey = issueRuntimeKey({ orgId, userId: studentId, sessionId: classroom.id, lessonId: classroom.lesson_id || null, ttlMs: DEFAULT_TTL_MS });
  const ticket = randomBytes(24).toString('base64url');

  // ③ 起环境
  const stdout = await runHost('launch', {
    session: sessionId,
    student: studentId,
    key: runtimeKey,
    ticket,
    // 网关地址与读图模型由平台侧给（配置只留一处），脚本/代理不各自兜默认值
    gateway: cfg.gatewayUrl,
    visionModel: cfg.visionModel,
    containerName: cfg.mode === 'container' ? containerNameFor(sessionId, studentId) : '',
  }, { timeout: LAUNCH_TIMEOUT_MS });
  const { containerName, hostPort } = parseLaunchOutput(stdout);

  // 入口地址：宿主脚本给的 EDGE_URL 是**完整地址**（用户版是 https://域名:端口，容器版由 nginx 前缀转发），
  // 脚本已经把它打在 stdout 上，这里直接取；取不到才退回 edgeBase/本机调试地址。
  const edgeFromScript = (String(stdout).split('\n').find((line) => line.startsWith('EDGE_URL=')) || '').slice('EDGE_URL='.length).trim();
  const edgeUrl = edgeFromScript
    || (cfg.edgeBase
      ? `${cfg.edgeBase.replace(/\/$/, '')}/${encodeURIComponent(containerName)}/?t=${ticket}`
      : `http://127.0.0.1:${hostPort}/?t=${ticket}`);

  return {
    containerName, hostPort, edgeUrl,
    expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
    // 只有「既没配入口前缀、脚本也没给地址」时才算本机地址（那种地址给学生是打不开的）
    localOnly: !edgeFromScript && !cfg.edgeBase,
  };
}

/**
 * 收环境（课堂结束、学生被移出名单、或兜底回收时调）。
 * @param {{sessionId?: string, studentId?: string, containerName?: string}} input
 */
export async function stopStudentRuntime({ sessionId = '', studentId = '', containerName = '' } = {}) {
  const cfg = config();
  // 「这台机器能不能收」与开盒子同一套判断（代理/脚本哪条通道在位）
  const availability = hostChannel('stop');
  if (!availability.available) throw errors.conflict(`这台机器还不能收学生的环境：${availability.reason}`, 'RUNTIME_LAUNCH_UNAVAILABLE');
  if (!sessionId && !studentId && !containerName) throw errors.badRequest('收环境要给出课堂、学生或环境名', 'VALIDATION_REQUIRED');
  // 用户版按「课堂 + 学生」收：用户名由这两者推导，脚本自己算得回来（所以两个都必须给）。
  // 容器版可以按容器名收，也可以按课堂（脚本支持 --session）。
  if (cfg.mode !== 'container' && (!sessionId || !studentId)) {
    throw errors.badRequest('用户版收环境要同时给出课堂与学生（用户名由这两者推导）', 'VALIDATION_REQUIRED');
  }
  const stdout = await runHost('stop', {
    session: sessionId || '', student: studentId || '', containerName: containerName || '',
  }, { timeout: STOP_TIMEOUT_MS });
  return { output: stdout.trim().split('\n').slice(-5) };
}
