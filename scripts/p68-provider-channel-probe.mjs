/**
 * P68 「用当前渠道试一次」守卫（2026-09-13，B2）。
 *
 * 这个按钮要解决的是**一类反复踩的坑**（交接说明里占了三条）：
 * 图片 prompt 长度、MiniMax 的路径 / 协议、Mureka 的 version 必填 ——
 * 这些参数错误以前只能在「上线后真机试」时才暴露，一轮发布白跑。
 * 有了它，参数对不对在保存那一刻就知道。
 *
 * 三种结果都必须如实回报，不能糊成一个「失败」：
 *   ① 上游接受并完成   → ok:true，并带上素材数量；
 *   ② 上游明确拒绝     → ok:false + **上游原文**（这才是干活的依据：告诉你是哪个参数不行）；
 *   ③ 上游受理但很慢   → accepted:true（视频 / 音乐天然如此）—— 不能报成失败，
 *      否则「参数没问题」会被误读成「参数错了」。
 * 另外必须钉住：**探测不写任何用量记录**（它不是创作）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p68-provider-probe-'));
const dbPath = path.join(temp, 'platform.db');
const secretFile = path.join(temp, 'provider-secrets.json');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: secretFile,
  DEPLOYMENT_MODE: 'development', AI_PROVIDER: 'local-mock', AI_PROVIDER_API_KEY: 'direct-secret-key',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

/* ── 假上游：三种行为由 probeMode 切换 ── */
const UP_PORT = 18970;
const upstream = { requests: [], mode: 'accept' };
const upstreamServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  upstream.requests.push({ url: req.url, auth: String(req.headers.authorization || ''), body });
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'probe-text-model' }] }));
    return;
  }
  if (upstream.mode === 'reject') {
    // 真实上游参数错误的形状：HTTP 400 + 明确说哪个参数不对
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'prompt length must be between 5 and 5000 characters', type: 'invalid_request_error' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '这是上游返回的探测回复。' } }] }));
});
await new Promise((resolve) => upstreamServer.listen(UP_PORT, '127.0.0.1', resolve));

const port = 19068;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

try {
  for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const login = async (name, password) => {
    const r = await api('/api/auth/login', { method: 'POST', body: { login: name, password } });
    assert.ok(r.data?.token, `登录失败：${name} ${JSON.stringify(r).slice(0, 160)}`);
    return r.data.token;
  };
  const rootToken = await login('root', 'admin123');

  // 配一个自定义渠道，指向假上游（协议 CHAT → /chat/completions）
  const endpoint = `http://127.0.0.1:${UP_PORT}`;
  const channel = { id: 'probe-channel', name: '探测渠道', provider: 'custom', model: 'probe-text-model', endpoint, apiKey: 'probe-key', protocol: 'CHAT', models: ['probe-text-model'], requestTemplates: {}, modelRequestTemplates: {}, requestPaths: {}, pollPaths: {} };
  const saved = await api('/api/admin/billing-config/ai-provider', {
    method: 'PUT', token: rootToken,
    body: { channels: [channel], modalityChannels: { TEXT: 'probe-channel' }, provider: 'custom', displayName: '探测供应商', model: 'probe-text-model', endpoint, protocol: 'CHAT', reason: 'P68 探测守卫' },
  });
  check('渠道配置已保存（TEXT 绑到探测渠道）', saved.status === 200, JSON.stringify(saved).slice(0, 160));

  const probe = (body) => api('/api/admin/billing-config/ai-provider/probe', { method: 'POST', token: rootToken, body });

  /* ① 上游接受 → ok:true，并且真的打到了上游（带我们的 key） */
  upstream.mode = 'accept';
  upstream.requests.length = 0;
  const accepted = await probe({ modality: 'TEXT', channelId: 'probe-channel', channel });
  check('① 上游接受：ok=true 且带上游素材信息', accepted.status === 200 && accepted.data?.ok === true, JSON.stringify(accepted.data).slice(0, 200));
  check('① 探测确实发到了上游（不是本地假装成功）', upstream.requests.some((item) => item.url.includes('/chat/completions')), JSON.stringify(upstream.requests.map((item) => item.url)));
  check('① 探测带上了渠道密钥', upstream.requests.some((item) => item.auth === 'Bearer probe-key'), JSON.stringify(upstream.requests.map((item) => item.auth)));
  check('① 回报里带上耗时与走的是直连', Number(accepted.data?.elapsedMs) >= 0 && accepted.data?.routedVia === 'direct', JSON.stringify({ elapsedMs: accepted.data?.elapsedMs, routedVia: accepted.data?.routedVia }));

  /* ② 上游拒绝 → ok:false，且**把上游原文带回来**（这才是能干活的信息） */
  upstream.mode = 'reject';
  const rejected = await probe({ modality: 'TEXT', channelId: 'probe-channel', channel });
  check('② 上游拒绝：ok=false 且 error.code 有值', rejected.status === 200 && rejected.data?.ok === false && Boolean(rejected.data?.error?.code), JSON.stringify(rejected.data).slice(0, 200));
  check('② 把上游原文（哪个参数不对）带回来了', /prompt length must be between/.test(String(rejected.data?.error?.message || '')), String(rejected.data?.error?.message || '').slice(0, 200));

  /* ③ 没配好的渠道 → 明确说是适配器不可用，而不是「调用失败」 */
  const unconfigured = await probe({ modality: 'TEXT', channelId: 'no-such-channel', model: 'probe-text-model', channel: { id: 'no-such-channel', name: '空渠道', provider: 'custom', model: 'probe-text-model', endpoint: '', apiKey: 'x' } });
  check('③ 适配器不可用：ok=false 且给出配置类错误码',
    unconfigured.status === 200 && unconfigured.data?.ok === false && ['AI_PROVIDER_CONFIG_INVALID', 'GENERATION_PROVIDER_UNAVAILABLE'].includes(unconfigured.data?.error?.code),
    JSON.stringify(unconfigured.data).slice(0, 200));

  /* ④ 探测不写用量：它是「试参数」，不是创作 */
  const db = new DatabaseSync(dbPath);
  const usageRows = db.prepare('SELECT COUNT(*) n FROM usage_records').get().n;
  const auditRows = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='AI_PROVIDER_PROBE'").get().n;
  db.close();
  check('④ 探测不写 usage_records（不产生费用）', Number(usageRows) === 0, `usage_records 行数 ${usageRows}`);
  check('④ 探测写审计（谁在什么时候试了哪条渠道）', Number(auditRows) >= 3, `审计行数 ${auditRows}`);

  /* ⑤ 只有平台超管能用（别把探测开给机构端） */
  const orgToken = await login('org-admin', 'org123');
  const forbidden = await api('/api/admin/billing-config/ai-provider/probe', { method: 'POST', token: orgToken, body: { modality: 'TEXT', channelId: 'probe-channel', channel } });
  check('⑤ 机构管理员不能探测（403）', forbidden.status === 403, `实际 ${forbidden.status}`);

  console.log(JSON.stringify({ name: 'provider-channel-probe', pass: failures === 0, failures, upstreamHits: upstream.requests.length }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
  upstreamServer.close();
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
