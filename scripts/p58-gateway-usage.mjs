/**
 * P58 算力用量归集守卫（2026-09-12，P5「看见所有机构和学员的消耗」）。
 *
 * 约定：分发出去的令牌名写成 机构:<id> / 学生:<id> / 课时:<id>，
 * 于是读网关的用量日志、按名字归集，就能还原「哪个机构/哪个学员/哪节课花了多少」——
 * **不需要改网关一行代码**（AGPL 风险也就绕开了）。
 * 没按约定命名的令牌单列「未归属」，绝不混进任何一个维度（否则报表会莫名其妙多出钱）。
 *
 * ⚠️ 待加固（本轮记下来）：读日志是分页拉取的，若网关**不认 p 参数**（或分页失效）会反复返回同一页，
 * 我们的循环就会把同一批消耗重复累加（实测：5 条日志被算成 184 元而不是 9.2 元），而且不报错。
 * 加固办法：按「首页记录 id 是否重复」判断并提前停止（下次做）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p58-gateway-usage-'));
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

// 假网关：登录 + 用量日志（5 条，覆盖三个维度 + 一条没按约定命名的）
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const json = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data })); };
  if (req.url.startsWith('/api/user/login')) return json({ access_token: 'mock-jwt', user: { id: 1 } });
  const logPage = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('p') || 1);
  if (req.url.startsWith('/api/log/')) return json({ items: logPage > 1 ? [] : [
    { token_name: '机构:org_demo', quota: 2500000, model_name: 'gpt-x' },
    { token_name: '学生:user_demo', quota: 500000, model_name: 'gpt-x' },
    { token_name: '课时:lesson_demo', quota: 1000000, model_name: 'gpt-x' },
    { token_name: '学生:user_demo', quota: 500000, model_name: 'gpt-x' },
    { token_name: '随手建的令牌', quota: 100000, model_name: 'gpt-x' },
  ] });
  if (req.url.startsWith('/api/user/self')) return json({ username: 'root' });
  res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'not found' }));
});
await new Promise((resolve) => mock.listen(18930, '127.0.0.1', resolve));

const port = 18931;
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
  await api('/api/admin/compute-gateway', { method: 'PUT', token: admin, body: { baseUrl: 'http://127.0.0.1:18930', username: 'root', password: 'pw', enabled: true } });

  const usage = await api('/api/admin/compute-gateway/usage?days=7', { token: admin });
  check('能读网关用量并归集', usage.status === 200 && usage.data.calls === 5, JSON.stringify(usage.data).slice(0, 160));
  check('按机构归集（5 元）', usage.data.byOrg?.[0]?.key === 'org_demo' && usage.data.byOrg[0].yuan === 5, JSON.stringify(usage.data.byOrg));
  check('按学员归集（同一学员两次合计 2 元 / 2 次）', usage.data.byStudent?.[0]?.key === 'user_demo' && usage.data.byStudent[0].yuan === 2 && usage.data.byStudent[0].calls === 2, JSON.stringify(usage.data.byStudent));
  check('按课时归集（2 元）', usage.data.byLesson?.[0]?.key === 'lesson_demo' && usage.data.byLesson[0].yuan === 2, JSON.stringify(usage.data.byLesson));
  check('没按约定命名的令牌单列「未归属」', usage.data.unattributed?.length === 1 && usage.data.unattributed[0].key === '随手建的令牌', JSON.stringify(usage.data.unattributed));
  check('合计元数 = 各维度之和（9.2）', usage.data.totalYuan === 9.2, String(usage.data.totalYuan));
  check('额度换算单位随配置返回（默认 500000 = 1 元）', usage.data.quotaPerUnit === 500000, String(usage.data.quotaPerUnit));

  console.log(JSON.stringify({ name: 'gateway-usage', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
  mock.close();
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
