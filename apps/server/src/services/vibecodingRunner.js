// VibeCoding 受限运行器：把学生代码放进隔离环境里跑，永远不让 API 进程直接执行学生代码。
//
// 生产后端用 systemd 瞬时单元：DynamicUser + 无网络 + 只读系统 + 内存/CPU/进程/时间上限。
// 但调用 systemd-run 需要权限（polkit 默认拒绝普通用户），所以：
//   - 能力探测通过 → systemd 后端；
//   - 非生产环境 → 受控子进程后端（仅用于本地开发与冒烟，不宣称隔离）；
//   - 生产探测失败 → 明确返回不可用，绝不假装成功。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DEPLOYMENT_MODE } from '../config.js';

const RUN_TIMEOUT_MS = Number(process.env.VIBECODING_RUN_TIMEOUT_MS || 10000);
const MAX_OUTPUT_BYTES = 64 * 1024;
const MEMORY_LIMIT_MB = 128;
const CPU_QUOTA_PERCENT = 50;
const MAX_TASKS = 64;
const NODE_BIN = String(process.env.VIBECODING_NODE_BIN || process.execPath);
const SYSTEMD_RUN = String(process.env.VIBECODING_SYSTEMD_RUN || '/usr/bin/systemd-run');

// 只有明确的开发模式才允许用「受控子进程」跑学生代码——它没有隔离，在生产等同把服务器交给学生。
// 生产环境必须显式开启 systemd 隔离后端（VIBECODING_SYSTEMD_RUNNER=1，且调用 systemd-run 的权限已配好），
// 否则一律报不可用。注意 DEPLOYMENT_MODE 会被 config.js 归一化成 development / internal-test / public，
// 生产的实际值是 'public'，不在白名单里。
const ALLOW_LOCAL_RUNNER = DEPLOYMENT_MODE === 'development' || process.env.VIBECODING_ALLOW_LOCAL_RUNNER === '1';
const SYSTEMD_RUNNER_ENABLED = process.env.VIBECODING_SYSTEMD_RUNNER === '1';

let capabilityCache = null;

function truncate(value) {
  const text = String(value || '');
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + '\n…（输出过长已截断）';
}

function writeWorkspace(files, entryFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecoding-run-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(content ?? ''), 'utf8');
  }
  if (!fs.existsSync(path.join(dir, entryFile))) throw Object.assign(new Error('入口文件不存在'), { code: 'VIBECODING_ENTRY_FILE_MISSING' });
  return dir;
}

function runCommand(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env: { PATH: '/usr/bin:/bin', HOME: cwd, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT_BYTES * 2) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT_BYTES * 2) stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error, stdout, stderr, durationMs: Date.now() - started, timedOut }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
  });
}

/** 探测当前主机能不能真正隔离运行代码。结果缓存，避免每次运行都探测。 */
export function sandboxCapability() {
  if (capabilityCache) return capabilityCache;
  if (ALLOW_LOCAL_RUNNER) {
    capabilityCache = { available: true, backend: 'local-subprocess', isolated: false, reason: '开发/测试模式使用受控子进程，不等同于隔离沙箱' };
    return capabilityCache;
  }
  if (SYSTEMD_RUNNER_ENABLED && fs.existsSync(SYSTEMD_RUN)) {
    capabilityCache = { available: true, backend: 'systemd-run', isolated: true, reason: '' };
    return capabilityCache;
  }
  capabilityCache = {
    available: false, backend: null, isolated: false,
    reason: '服务器尚未启用代码沙箱：需要先配置隔离运行环境（systemd 受限单元 + 调用权限）并设置 VIBECODING_SYSTEMD_RUNNER=1',
  };
  return capabilityCache;
}

// 探测结果只说明命令存在；真正的权限问题会在运行时以 EPERM/鉴权失败暴露，届时转成不可用。
function systemdArgs(unit, dir, entryFile) {
  return [
    '--pipe', '--wait', '--collect', `--unit=${unit}`,
    '-p', 'DynamicUser=yes', '-p', 'PrivateNetwork=yes', '-p', 'PrivateTmp=yes',
    '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=yes', `-p`, `ReadWritePaths=${dir}`,
    `-p`, `MemoryMax=${MEMORY_LIMIT_MB}M`, `-p`, `CPUQuota=${CPU_QUOTA_PERCENT}%`,
    `-p`, `TasksMax=${MAX_TASKS}`, `-p`, `RuntimeMaxSec=${Math.ceil(RUN_TIMEOUT_MS / 1000)}`,
    '-p', 'NoNewPrivileges=yes', '--working-directory', dir,
    NODE_BIN, path.join(dir, entryFile),
  ];
}

/**
 * 运行一段 JavaScript。返回 { status, exitCode, stdout, stderr, durationMs, errorCode }。
 * 只接受 javascript 语言；HTML/JS 项目请在浏览器沙箱里预览运行。
 */
export async function runJavaScript({ files, entryFile }) {
  const capability = sandboxCapability();
  if (!capability.available) {
    return { status: 'FAILED', exitCode: null, stdout: '', stderr: capability.reason, durationMs: 0, errorCode: 'VIBECODING_SANDBOX_UNAVAILABLE' };
  }
  const dir = writeWorkspace(files, entryFile);
  try {
    const result = capability.backend === 'systemd-run'
      ? await runCommand(SYSTEMD_RUN, systemdArgs(`vibecoding-${process.pid}-${Date.now().toString(36)}`, dir, entryFile), { cwd: dir, timeoutMs: RUN_TIMEOUT_MS + 2000 })
      : await runCommand(NODE_BIN, [path.join(dir, entryFile)], { cwd: dir, timeoutMs: RUN_TIMEOUT_MS });
    if (result.error) {
      // 权限不足等情况：明确报不可用，而不是把内部错误甩给学生
      const permission = /EPERM|EACCES|access denied|Authentication/i.test(String(result.error.message || ''));
      return {
        status: 'FAILED', exitCode: null, stdout: truncate(result.stdout), stderr: '',
        durationMs: result.durationMs, errorCode: permission ? 'VIBECODING_SANDBOX_UNAVAILABLE' : 'VIBECODING_RUN_FAILED',
      };
    }
    if (result.timedOut) {
      return { status: 'TIMEOUT', exitCode: null, stdout: truncate(result.stdout), stderr: truncate(result.stderr), durationMs: result.durationMs, errorCode: 'VIBECODING_RUN_TIMEOUT' };
    }
    const failed = Number(result.code) !== 0;
    return {
      status: failed ? 'FAILED' : 'SUCCEEDED', exitCode: Number(result.code ?? 0),
      stdout: truncate(result.stdout), stderr: truncate(result.stderr),
      durationMs: result.durationMs, errorCode: failed ? 'VIBECODING_RUN_NONZERO_EXIT' : null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
