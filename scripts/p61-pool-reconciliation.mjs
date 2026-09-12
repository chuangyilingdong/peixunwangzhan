/**
 * P61 对账守卫（2026-09-12）：**池子账（应用侧）** vs **网关账（精确）**。
 *
 * 这是两本不同的账，差额必须能被解释，否则「对账」就成了两个都不信的数字：
 *   · 网关**看不见**视频/音乐（它们走我们自己的出口）→ 这部分天然对不上，单列一列，不算误差；
 *   · 对话/图片两边都有 → 池子是「每次调用单价 × 次数」的**预估**，网关是按 token 实算的**精确**，
 *     差额就是**单价折算误差**，改单价只需要看这一个数；
 *   · 网关没启用 / 这段时间没有对话图片调用 → 网关账为 0，这时**不给百分比**
 *     （给了会被读成「误差 100%」这种假故障），标成 `NO_GATEWAY_DATA`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p61-reconcile-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock',
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
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

/* 造数：
   · 学员 A 在课包 S 上：对话花 60 分（池子）+ 视频花 500 分（池子，网关看不见）；
   · 网关日志里这名学员有 2 条：一条课时段能归到课包 S（2500000 quota = 5 元 = 500 分），
     一条只有学员段、没课时段（故意用来验证「归不到课包」的那一列）；
   · 学员 B 在课包 S 上只有一条失败记录（失败不花钱 → 不进对账）。
   ⚠️ 用真实的 user/series/lesson id，因为令牌名要能被解析、课时要能映射到课包。 */
const seeded = (() => {
  const db = new DatabaseSync(dbPath);
  const lesson = db.prepare('SELECT id, series_id FROM course_lessons ORDER BY sort LIMIT 1').get();
  const students = db.prepare("SELECT id, org_id FROM users WHERE role='STUDENT' LIMIT 2").all();
  const [a, b] = students;
  const insert = db.prepare(`INSERT INTO usage_records(
      id,org_id,user_id,modality,model,credits_charged,status,fail_code,pricing_snapshot,cost_fen,series_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const now = new Date().toISOString();
  insert.run('r1', a.org_id, a.id, 'TEXT', 'm', 1, 'SUCCESS', null, '{}', 60, lesson.series_id, now);
  insert.run('r2', a.org_id, a.id, 'VIDEO', 'm', 1, 'SUCCESS', null, '{}', 500, lesson.series_id, now);
  insert.run('r3', b.org_id, b.id, 'TEXT', 'm', 0, 'FAILED', 'X', '{}', 0, lesson.series_id, now);
  db.close();
  return { seriesId: lesson.series_id, lessonId: lesson.id, studentA: a.id, studentB: b.id };
})();

/* 假网关：登录 + 用量日志（quota → 元 → 分 由 quotaPerUnit 决定，默认 500000 = 1 元） */
const GW_PORT = 18980;
const LOG_ROWS = [
  { id: 1, token_name: `机构:o/学生:${seeded.studentA}/课时:${seeded.lessonId}`, quota: 2500000, model_name: 'm' },
  { id: 2, token_name: `机构:o/学生:${seeded.studentA}`, quota: 500000, model_name: 'm' }, // 没课时段 → 归不到课包
];
const gatewayServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const json = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data })); };
  if (req.url.startsWith('/api/user/login')) return json({ access_token: 'mock-jwt', user: { id: 1 } });
  if (req.url.startsWith('/api/user/self')) return json({ username: 'root' });
  if (req.url.startsWith('/api/log/')) return json({ items: LOG_ROWS });
  if (req.url.startsWith('/api/token/')) return json({ items: [] });
  res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'not found' }));
});
await new Promise((resolve) => gatewayServer.listen(GW_PORT, '127.0.0.1', resolve));

const port = 18981;
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

  /* ① 网关没启用 → 网关账为空，**不给误差百分比**（否则会被读成假故障） */
  const beforeEnable = await api('/api/admin/compute-pools/reconciliation?days=7', { token: admin });
  check('① 网关没启用时：对账仍能跑通，但不给误差率', beforeEnable.status === 200 && beforeEnable.data.items.every((item) => item.diffPercent === null), JSON.stringify(beforeEnable.data.items).slice(0, 240));
  check('① 网关没启用时：所有行标成「网关无数据」', beforeEnable.data.items.every((item) => item.state === 'NO_GATEWAY_DATA') && beforeEnable.data.gatewayEnabled === false, JSON.stringify(beforeEnable.data.totals));

  /* ② 启用网关 → 两边并排 */
  await api('/api/admin/compute-gateway', { method: 'PUT', token: admin, body: { baseUrl: `http://127.0.0.1:${GW_PORT}`, username: 'root', password: 'pw', enabled: true } });
  const after = await api('/api/admin/compute-pools/reconciliation?days=7', { token: admin });
  const row = after.data.items.find((item) => item.userId === seeded.studentA && item.seriesId === seeded.seriesId);
  check('② 池子账：对话+图片 0.60 元（对话 60 分）', row?.poolTextImageYuan === 0.6, JSON.stringify(row));
  check('② 视频/音乐单列：5.00 元（视频 500 分，网关看不见）', row?.poolOtherYuan === 5, JSON.stringify({ other: row?.poolOtherYuan }));
  check('② 网关账：5.00 元（2500000 quota ÷ 500000）', row?.gatewayYuan === 5, JSON.stringify({ gateway: row?.gatewayYuan }));
  check('② 差额 = 池子(对话图片) − 网关 = 0.60 − 5.00 = −4.40 元', row?.diffYuan === -4.4, JSON.stringify({ diff: row?.diffYuan }));
  check('② 误差率给了（网关有数才给）：−88%', row?.diffPercent === -88, String(row?.diffPercent));
  check('② 状态是「可对账」', row?.state === 'COMPARABLE', String(row?.state));
  check('② 归不到课包的网关消耗单列（缺课时段那条 1.00 元）', after.data.totals.unmappedGatewayYuan === 1 && after.data.totals.unmappedGatewayCalls === 1, JSON.stringify(after.data.totals));
  check('② 合计行的池子总额 = 对话图片 + 视频音乐（0.60 + 5.00 = 5.60）', after.data.totals.poolTotalYuan === 5.6, JSON.stringify(after.data.totals));

  /* ③ 失败的调用不进对账（失败不花钱，cost_fen=0 且 status 不是 SUCCESS） */
  check('③ 只有失败记录的学员不出现在对账里（没花钱就不用对）', !after.data.items.some((item) => item.userId === seeded.studentB), JSON.stringify(after.data.items.map((item) => item.userId)));
  check('③ 启用网关后：有池子消耗的行都可对账（comparable=1，notComparable=0）',
    after.data.totals.comparable === 1 && after.data.totals.notComparable === 0, JSON.stringify(after.data.totals));
  check('③ 网关没启用时反过来：全部算「不可对账」（① 已验），启用后不再有不可对账的行',
    beforeEnable.data.totals.notComparable === beforeEnable.data.items.length && after.data.totals.notComparable === 0,
    JSON.stringify({ before: beforeEnable.data.totals, after: after.data.totals }));

  console.log(JSON.stringify({ name: 'pool-reconciliation', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
  gatewayServer.close();
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
