/**
 * 抖音账号连接（十二期）。
 *
 * 背景：抖音对未登录访问返回 403，作品列表/详情都拿不到。原版是桌面端开可见窗口让用户扫码，
 * 我们是 Web 服务 —— 改为服务端有头浏览器（生产用 Xvfb 虚拟显示）截登录二维码给前端展示，
 * 用户手机抖音 App 扫码，服务端轮询到 sessionid 后加密保存，供「自己的账号 / 同行 / 文案大脑」共用。
 *
 * 刻意不做的事：不绕过任何验证码。抖音若在无头或异常环境下弹滑块，我们如实返回错误让用户重试，
 * 绝不自动拖拽拼图。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { aq, arow, nowIso, id as makeId } from '../lib.js';
import { douyinPython } from './junshiDouyin.js';

const DOUYIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'douyin');
const LOGIN_WORKER = path.join(DOUYIN_DIR, 'douyin_login_worker.py');
const BROWSER_WORKER = path.join(DOUYIN_DIR, 'douyin_browser_worker.py');
const VIDEO_WORKER = path.join(DOUYIN_DIR, 'douyin_video_worker.py');

const LOGIN_WINDOW_MS = 5 * 60 * 1000;

/**
 * Worker 进程的 HOME：生产服务单元带 ProtectSystem=strict，服务的 HOME(/srv/...) 是只读的，
 * 有头 Chromium 要写配置/缓存，写不了就直接 SIGTRAP 崩（2026-10-25 实测）。
 * 统一给一个可写的临时 HOME（systemd PrivateTmp 下 /tmp 私有且可写）。
 */
const WORKER_HOME = path.join(os.tmpdir(), 'junshi-douyin-home');
function workerEnv() {
  const env = { ...process.env, HOME: WORKER_HOME };
  env.XDG_CONFIG_HOME = path.join(WORKER_HOME, '.config');
  env.XDG_CACHE_HOME = path.join(WORKER_HOME, '.cache');
  try {
    fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
    fs.mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  } catch { /* 目录不可写时交给 worker 报错 */ }
  return env;
}
const secretKey = createHash('sha256').update(String(process.env.AUTH_PEPPER || 'p0-local-pepper')).digest();

function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') });
}
function decrypt(payload) {
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!parsed?.iv || !parsed?.tag || !parsed?.data) return '';
    const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(parsed.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

/** 进行中的登录会话（内存）。key = owner_key。 */
const logins = new Map();

export function douyinLoginEnabled() {
  return process.env.JUNSHI_DOUYIN_LOGIN !== '0';
}

function killSession(ownerKey) {
  const session = logins.get(ownerKey);
  if (!session) return;
  clearTimeout(session.timer);
  try { session.child.stdin.end(); } catch { /* ignore */ }
  try { session.child.kill(); } catch { /* ignore */ }
  logins.delete(ownerKey);
}

/** 起一次登录：spawn worker，等它吐出二维码帧。 */
export function startDouyinLogin(ownerKey) {
  if (!douyinLoginEnabled()) {
    throw Object.assign(new Error('这个部署没有开启抖音扫码登录（JUNSHI_DOUYIN_LOGIN=0）。'), { status: 503, code: 'DOUYIN_LOGIN_DISABLED' });
  }
  killSession(ownerKey);
  const sessionId = makeId('jdyl');
  // headless=False 是我们刻意选的（无头会被抖音弹滑块验证）；Linux 服务器没有显示服务，
  // 用 xvfb-run 提供一个临时虚拟显示。装了 xvfb 才能用扫码登录。
  const python = douyinPython();
  const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
  const child = useXvfb
    ? spawn('xvfb-run', ['-a', python, LOGIN_WORKER], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: workerEnv() })
    : spawn(python, [LOGIN_WORKER], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: workerEnv() });
  const session = { sessionId, child, status: 'starting', qr: '', cookie: '', userAgent: '', nickname: '', error: '', startedAt: Date.now(), timer: null };
  logins.set(ownerKey, session);

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.startsWith('{')) continue;
      let frame = null;
      try { frame = JSON.parse(line); } catch { continue; }
      if (!frame || !frame.status) continue;
      if (frame.status === 'qr') { session.qr = String(frame.qr || ''); session.status = 'waiting'; }
      else if (frame.status === 'waiting') { if (session.status === 'starting') session.status = 'waiting'; }
      else if (frame.status === 'connected') {
        session.status = 'connected';
        session.cookie = String(frame.cookie || '');
        session.userAgent = String(frame.userAgent || '');
        session.nickname = String(frame.nickname || '');
      } else if (frame.status === 'expired' || frame.status === 'error') {
        session.status = frame.status === 'expired' ? 'expired' : 'error';
        session.error = String(frame.error || '').slice(0, 120);
      }
    }
  });
  child.stderr.on('data', () => { /* 诊断细节不进日志：可能含 cookie */ });
  child.on('error', (error) => {
    session.status = 'error';
    session.error = useXvfb ? 'xvfb_missing' : 'worker_spawn_failed';
    session.spawnError = String(error?.message || error).slice(0, 120);
  });
  child.on('close', () => {
    if (session.status === 'waiting') session.status = 'expired';
  });
  session.timer = setTimeout(() => {
    if (session.status === 'starting' || session.status === 'waiting') {
      session.status = 'expired';
      session.error = 'login_timeout';
    }
    killSession(ownerKey);
  }, LOGIN_WINDOW_MS);
  session.timer.unref?.();
  return { sessionId, startedAt: session.startedAt };
}

/** 轮询登录状态；连上后落库并结束会话。 */
export async function pollDouyinLogin(ownerKey, sessionId) {
  const session = logins.get(ownerKey);
  if (!session || (sessionId && session.sessionId !== sessionId)) {
    return { status: 'idle' };
  }
  const base = { status: session.status, qr: session.qr, error: session.error, nickname: session.nickname };
  if (session.status !== 'connected') return base;
  if (!session.cookie) {
    return { ...base, status: 'error', error: 'empty_cookie' };
  }
  const at = nowIso();
  const encrypted = encrypt(session.cookie);
  const existing = await arow('SELECT owner_key FROM junshi_workbench_douyin_sessions WHERE owner_key=?', [ownerKey]).catch(() => null);
  if (existing) {
    await aq('UPDATE junshi_workbench_douyin_sessions SET cookie_enc=?, user_agent=?, nickname=?, status=?, error=?, connected_at=?, updated_at=? WHERE owner_key=?',
      [encrypted, session.userAgent.slice(0, 500), session.nickname.slice(0, 200), 'connected', '', at, at, ownerKey]);
  } else {
    await aq('INSERT INTO junshi_workbench_douyin_sessions (owner_key,cookie_enc,user_agent,nickname,status,error,connected_at,last_used_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [ownerKey, encrypted, session.userAgent.slice(0, 500), session.nickname.slice(0, 200), 'connected', '', at, null, at]);
  }
  killSession(ownerKey);
  return { ...base, status: 'connected', saved: true };
}

export function cancelDouyinLogin(ownerKey) {
  killSession(ownerKey);
}

/** 连接状态（给前端/任务提示用）。 */
export async function douyinConnection(ownerKey) {
  const row = await arow('SELECT owner_key, nickname, status, error, connected_at, last_used_at FROM junshi_workbench_douyin_sessions WHERE owner_key=?', [ownerKey]).catch(() => null);
  if (!row) return { connected: false, enabled: douyinLoginEnabled() };
  return {
    connected: row.status === 'connected',
    enabled: douyinLoginEnabled(),
    nickname: row.nickname || '',
    status: row.status,
    error: row.error || '',
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
  };
}

/** 取解密后的登录态（采集用）。 */
export async function douyinSession(ownerKey) {
  const row = await arow('SELECT cookie_enc, user_agent, nickname, status FROM junshi_workbench_douyin_sessions WHERE owner_key=?', [ownerKey]).catch(() => null);
  if (!row || row.status !== 'connected') return null;
  const cookie = decrypt(row.cookie_enc);
  if (!cookie) return null;
  return { cookie, userAgent: row.user_agent || '', nickname: row.nickname || '' };
}

export async function markDouyinSessionUsed(ownerKey) {
  await aq('UPDATE junshi_workbench_douyin_sessions SET last_used_at=?, updated_at=? WHERE owner_key=?', [nowIso(), nowIso(), ownerKey]).catch(() => {});
}

/** 登录态失效（采集时被要求登录/验证）：标记 expired，让前端引导重连。 */
export async function markDouyinSessionExpired(ownerKey, reason) {
  await aq("UPDATE junshi_workbench_douyin_sessions SET status='expired', error=?, updated_at=? WHERE owner_key=?", [String(reason || '').slice(0, 200), nowIso(), ownerKey]).catch(() => {});
}

export async function disconnectDouyin(ownerKey) {
  killSession(ownerKey);
  await aq('DELETE FROM junshi_workbench_douyin_sessions WHERE owner_key=?', [ownerKey]).catch(() => {});
}

/**
 * 浏览器旁路读取主页作品（原版 douyin_browser_worker 同款思路）：
 * 让真实浏览器加载主页、自己生成签名，我们旁路收集 `/aweme/v1/web/aweme/post` 响应。
 * 只在已连接抖音时可用；未连接直接返回 null 交给上层报「请先连接」。
 */
export async function fetchProfileViaBrowser(ownerKey, secUserId, { knownIds = [], timeoutMs = 150000 } = {}) {
  // 不强制要求已连接：真实浏览器以游客身份也能读到公开主页的作品列表（2026-10-25 实测 21 条），
  // 登录态只是让读取更稳、能看更多历史。未连接就传空 cookie。
  const session = await douyinSession(ownerKey);
  return await new Promise((resolve) => {
    const child = spawn(douyinPython(), [BROWSER_WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: workerEnv() });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ worksStatus: 'unavailable', error: 'browser_timeout' }), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf-8'); });
    child.on('error', () => finish({ worksStatus: 'unavailable', error: 'browser_spawn_failed' }));
    child.on('close', () => {
      const marker = out.lastIndexOf('DYRESULT:');
      if (marker < 0) {
        finish({ worksStatus: 'unavailable', error: err ? 'browser_read_failed' : 'browser_no_result' });
        return;
      }
      const line = out.slice(marker + 'DYRESULT:'.length).split(/\r?\n/, 1)[0];
      try { finish(JSON.parse(line)); } catch { finish({ worksStatus: 'unavailable', error: 'browser_invalid_result' }); }
    });
    child.stdin.write(JSON.stringify({
      target: { kind: 'user', id: String(secUserId) },
      cookie: session?.cookie || '',
      user_agent: session?.userAgent || '',
      known_ids: (knownIds || []).slice(0, 400),
    }));
    child.stdin.end();
  });
}

/**
 * 单个作品走浏览器旁路（作品页自己发的 detail 响应）。
 * 游客也能用 —— 签名接口对我们出口 403，但真实浏览器页面正常。
 */
export async function fetchVideoViaBrowser(ownerKey, awemeId, { timeoutMs = 90000 } = {}) {
  const session = await douyinSession(ownerKey);
  return await new Promise((resolve) => {
    const child = spawn(douyinPython(), [VIDEO_WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: workerEnv() });
    let out = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ status: 'unavailable', error: 'browser_timeout' }), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf-8'); });
    child.stderr.on('data', () => { /* 诊断细节不进日志 */ });
    child.on('error', () => finish({ status: 'unavailable', error: 'browser_spawn_failed' }));
    child.on('close', () => {
      const marker = out.lastIndexOf('DYRESULT:');
      if (marker < 0) { finish({ status: 'unavailable', error: 'browser_no_result' }); return; }
      const line = out.slice(marker + 'DYRESULT:'.length).split(/\r?\n/, 1)[0];
      try { finish(JSON.parse(line)); } catch { finish({ status: 'unavailable', error: 'browser_invalid_result' }); }
    });
    child.stdin.write(JSON.stringify({
      target: { kind: 'video', id: String(awemeId) },
      cookie: session?.cookie || '',
      user_agent: session?.userAgent || '',
    }));
    child.stdin.end();
  });
}

export { encrypt as encryptDouyinCookie, decrypt as decryptDouyinCookie };
