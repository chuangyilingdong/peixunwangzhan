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
import { errors, row } from '../lib.js';
import { issueRuntimeKey, assertRuntimeClassroomActive } from '../routes/runtimeGateway.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 90 * 1000;
const STOP_TIMEOUT_MS = 30 * 1000;
const NAME_PREFIX = 'dsh-s-';

function config() {
  return {
    enabled: String(process.env.DSH_RUNTIME_ENABLED || 'true') !== 'false',
    launchScript: String(process.env.DSH_RUNTIME_LAUNCH_SCRIPT || '/opt/dsh-host/run-student-container.sh').trim(),
    stopScript: String(process.env.DSH_RUNTIME_STOP_SCRIPT || '/opt/dsh-host/stop-student-container.sh').trim(),
    // 容器从宿主里访问平台网关的地址：同一台机器时走 docker 的 host-gateway 别名（脚本里已加 --add-host）
    gatewayUrl: String(process.env.DSH_RUNTIME_GATEWAY_URL || 'http://host.docker.internal:8789/api/gateway/v1').trim(),
    // 学生浏览器访问的入口前缀（生产是 https://iicili.cyou/dsh，由 nginx 按容器名转发）
    edgeBase: String(process.env.DSH_RUNTIME_EDGE_BASE || '').trim(),
    visionModel: String(process.env.DSH_RUNTIME_VISION_MODEL || 'platform-vision').trim(),
  };
}

/** 容器名：与宿主脚本同一套规则（净化 + 截断），两处必须一致，否则停不掉。 */
function containerNameFor(sessionId, studentId) {
  const sane = (value) => String(value || '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 48);
  return `${NAME_PREFIX}${sane(sessionId)}-${sane(studentId)}`;
}

function runScript(script, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('bash', [script, ...args], { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(String(stderr || error.message || '').trim().slice(0, 400) || '宿主脚本执行失败'), { code: 'RUNTIME_HOST_SCRIPT_FAILED' }));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function parseLaunchOutput(stdout) {
  const pick = (key) => (String(stdout).split('\n').find((line) => line.startsWith(`${key}=`)) || '').split('=').slice(1).join('=').trim();
  const containerName = pick('CONTAINER_NAME');
  const hostPort = Number(pick('HOST_PORT')) || 0;
  if (!containerName || !hostPort) throw Object.assign(new Error('宿主脚本没有回报容器名与端口'), { code: 'RUNTIME_HOST_SCRIPT_OUTPUT_INVALID' });
  return { containerName, hostPort };
}

/** 这台机器现在能不能开盒子（给管理端/学生端一个明确的「不可用」而不是转圈）。 */
export function studentRuntimeAvailability() {
  const cfg = config();
  if (!cfg.enabled) return { available: false, reason: '未启用（DSH_RUNTIME_ENABLED=false）' };
  if (!existsSync(cfg.launchScript)) return { available: false, reason: `宿主脚本不在：${cfg.launchScript}` };
  return { available: true, reason: '' };
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

  // ③ 起盒子
  const stdout = await runScript(cfg.launchScript, [
    '--session', sessionId,
    '--student', studentId,
    '--key', runtimeKey,
    '--gateway', cfg.gatewayUrl,
    '--ticket', ticket,
    '--vision-model', cfg.visionModel,
    '--name', containerNameFor(sessionId, studentId),
  ], LAUNCH_TIMEOUT_MS);
  const { containerName, hostPort } = parseLaunchOutput(stdout);

  // 入口地址：生产走 nginx 的 /dsh/<容器名>/（学生浏览器只认公网域名）；
  // 没配就是本机调试 —— 给学生用之前必须配上，否则地址只有宿主自己打得开。
  const edgeUrl = cfg.edgeBase
    ? `${cfg.edgeBase.replace(/\/$/, '')}/${encodeURIComponent(containerName)}/?t=${ticket}`
    : `http://127.0.0.1:${hostPort}/?t=${ticket}`;

  return {
    containerName, hostPort, edgeUrl,
    expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
    localOnly: !cfg.edgeBase,
  };
}

/**
 * 收盒子（课堂结束、学生被移出名单、或兜底回收时调）。
 * @param {{sessionId?: string, studentId?: string, containerName?: string}} input
 */
export async function stopStudentRuntime({ sessionId = '', studentId = '', containerName = '' } = {}) {
  const cfg = config();
  if (!existsSync(cfg.stopScript)) throw errors.conflict(`宿主脚本不在：${cfg.stopScript}`, 'RUNTIME_LAUNCH_UNAVAILABLE');
  if (!sessionId && !studentId && !containerName) throw errors.badRequest('停盒子要给出课堂、学生或容器名', 'VALIDATION_REQUIRED');
  const args = containerName ? ['--name', containerName] : sessionId ? ['--session', sessionId] : ['--student', studentId];
  const stdout = await runScript(cfg.stopScript, args, STOP_TIMEOUT_MS);
  return { output: stdout.trim().split('\n').slice(-5) };
}
