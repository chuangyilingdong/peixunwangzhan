/**
 * P57 算力网关（new-api）接入守卫（2026-09-12，P5 第一屏）。
 *
 * 我们**不改** new-api 的代码（AGPL：改了要开源那部分），只通过它的管理接口读写：
 * 配置网关地址与管理员账号 → 测连 → 读渠道 → 分发令牌（额度按「分」换算成 quota）。
 * 令牌名约定成 机构:<id> / 学生:<id> / 课时:<id>，用量日志按令牌名就能还原归集维度。
 *
 * 这里用一个「假 new-api」起在本地，验证我们这边的请求形状与错误处理（不需要 Docker）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p57-compute-gateway-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

/* ── 假 new-api：只实现我们用到的那几个管理接口 ── */
const seen = [];
const tokens = [];
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  seen.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', body });
  const json = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data })); };
  if (req.url.startsWith('/api/user/login')) return json({ access_token: 'mock-jwt-token', user: { id: 1, username: 'root' } });
  if (req.url.startsWith('/api/user/self')) return json({ id: 1, username: 'root', display_name: 'Root User' });
  if (req.url.startsWith('/api/channel/')) return json({ items: [{ id: 1, name: '主渠道', type: 1, base_url: 'https://upstream.example', models: 'gpt-x', status: 1, group: 'default' }] });
  if (req.url.startsWith('/api/token/') && req.method === 'GET') return json({ items: tokens });
  if (req.url.startsWith('/api/token/') && req.method === 'POST') {
    tokens.push({ id: tokens.length + 1, name: body?.name, status: 1, remain_quota: body?.remain_quota, used_quota: 0, unlimited_quota: body?.unlimited_quota === true, model_limits: body?.model_limits || '' });
    return json({});
  }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'not found' }));
});
await new Promise((resolve) => mock.listen(18920, '127.0.0.1', resolve));

const port = 18921;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  assert.ok(admin, '管理员登录失败');

  // ① 没配置时给出明确错误，而不是静默失败
  const before = await api('/api/admin/compute-gateway/test', { method: 'POST', token: admin });
  check('① 未启用/未配置时测连被明确拒绝', before.status === 403 && before.error?.code === 'COMPUTE_GATEWAY_DISABLED', `${before.status} ${before.error?.code}`);

  // ② 配置网关（地址 + 管理员账号 + 密码）
  const saved = await api('/api/admin/compute-gateway', { method: 'PUT', token: admin, body: { baseUrl: 'http://127.0.0.1:18920/', username: 'root', password: 'poc-password', enabled: true } });
  check('② 能保存网关配置（地址去掉尾斜杠）', saved.status === 200 && saved.data.config.baseUrl === 'http://127.0.0.1:18920' && saved.data.config.enabled === true, JSON.stringify(saved.data).slice(0, 160));
  check('② 密码不回显，只回显「已配置」', saved.data.config.passwordConfigured === true && saved.data.config.password === undefined, JSON.stringify(saved.data.config));
  const rereaded = await api('/api/admin/compute-gateway', { token: admin });
  check('② 读回的配置里没有密码字段', !('password' in (rereaded.data.config || {})) && rereaded.data.config.passwordConfigured === true);

  // ③ 测连：走网关登录 + 自己的身份接口
  const tested = await api('/api/admin/compute-gateway/test', { method: 'POST', token: admin });
  check('③ 测连成功并回显网关账号', tested.status === 200 && tested.data.gatewayUser === 'root', JSON.stringify(tested.data).slice(0, 140));
  const loginCall = seen.find((item) => item.url.startsWith('/api/user/login'));
  check('③ 用的是「用户名 + 密码」登录拿 JWT', Boolean(loginCall) && JSON.parse(JSON.stringify(loginCall.body)).username === 'root');
  const adminCall = seen.find((item) => item.url.startsWith('/api/user/self'));
  check('③ 后续管理调用带 Bearer JWT', String(adminCall?.auth || '').startsWith('Bearer mock-jwt-token'), String(adminCall?.auth || '').slice(0, 40));

  // ④ 读渠道（我们只读，不改它的代码）
  const channels = await api('/api/admin/compute-gateway/channels', { token: admin });
  check('④ 能读到网关上的渠道', channels.status === 200 && channels.data.items.length === 1 && channels.data.items[0].name === '主渠道', JSON.stringify(channels.data).slice(0, 160));

  // ⑤ 分发令牌：额度「分」换算成 quota（5 元 = 500 分 → 500/100 × 500000 = 2500000）
  const created = await api('/api/admin/compute-gateway/tokens', { method: 'POST', token: admin, body: { name: '机构:org_demo', budgetFen: 500, models: 'gpt-x' } });
  check('⑤ 能给机构分发令牌', created.status === 200 && created.data.token?.name === '机构:org_demo', JSON.stringify(created.data).slice(0, 160));
  const createCall = seen.filter((item) => item.url.startsWith('/api/token/') && item.method === 'POST').pop();
  check('⑤ 额度按「分」正确换算（500 分 → 2500000 quota）', Number(createCall?.body?.remain_quota) === 2500000, String(createCall?.body?.remain_quota));
  check('⑤ 令牌带上可用模型限制', String(createCall?.body?.model_limits) === 'gpt-x', String(createCall?.body?.model_limits));
  const list = await api('/api/admin/compute-gateway/tokens', { token: admin });
  check('⑤ 令牌列表能读回', list.status === 200 && list.data.items.some((item) => item.name === '机构:org_demo'), JSON.stringify(list.data).slice(0, 160));

  console.log(JSON.stringify({ name: 'compute-gateway', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
  mock.close();
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
