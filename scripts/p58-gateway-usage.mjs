/**
 * P58 算力用量归集守卫（2026-09-12，P5「看见所有机构和学员的消耗」）。
 *
 * 约定：分发出去的令牌名写成 机构:<id>/学生:<id>/课时:<id>（多段），
 * 于是读网关的用量日志、按名字逐段归集，就能还原「哪个机构/哪个学员/哪节课花了多少」——
 * **不需要改网关一行代码**（AGPL 风险也就绕开了）。
 * 没按约定命名的令牌单列「未归属」，绝不混进任何一个维度（否则报表会莫名其妙多出钱）。
 *
 * ⚠️ 这里还刻意让**假网关不认 `p` 参数**（每次都返回同一页）来复现上一轮踩到的静默失败：
 * 分页失效时同一页会被反复累加（实测 5 条日志算成 184 元而不是 9.2 元）且不报错。
 * 现在 pagedItems 按「本页首条记录的标识是否与上一页相同」提前停止，所以：
 * ① 归集金额必须还是 9.2 ② 读日志的请求次数必须是 2 次（发现重复就停，而不是拉满 20 页）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

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

// 归集口径的一部分直接断言被测函数。⚠️ 必须先设好库路径再动态导入 ——
// computeGateway 会连带加载 lib.js 并把库打开，静态 import 会碰到本地开发库。
Object.assign(process.env, { PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' });
const { aggregateUsage, lessonBudgetOverview } = await import('../apps/server/src/services/computeGateway.js');

// 平台预算按课堂快照归集；学生人数及历史每学生预算不参与计算。
const seededLessons = { budgeted: '', halfBudgeted: '', noBudget: '' };
{
  const db = new DatabaseSync(dbPath);
  [seededLessons.budgeted, seededLessons.halfBudgeted, seededLessons.noBudget] = db.prepare('SELECT id FROM course_lessons ORDER BY sort LIMIT 3').all().map(item => item.id);
  const student = db.prepare("SELECT id,org_id FROM users WHERE role='STUDENT' LIMIT 1").get();
  const teacher = db.prepare("SELECT id FROM users WHERE role='TEACHER' LIMIT 1").get();
  db.prepare('UPDATE course_lessons SET per_student_budget_fen=999999,platform_budget_fen=5000 WHERE id=?').run(seededLessons.budgeted);
  const session = db.prepare(`INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,platform_budget_fen,created_at,updated_at)
    SELECT ?,?, ?,series_id,id,?,'ACTIVE',?,datetime('now'),datetime('now') FROM course_lessons WHERE id=?`);
  session.run('p58_a', 'P58 已知成本', student.org_id, teacher.id, 100, seededLessons.budgeted);
  session.run('p58_b', 'P58 未知成本', student.org_id, teacher.id, 300, seededLessons.budgeted);
  session.run('p58_none', 'P58 未配置预算', student.org_id, teacher.id, null, seededLessons.noBudget);
  const attempt = db.prepare(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,modality,status,cost_source,upstream_cost_fen,sale_snapshot,class_session_id,lesson_id,created_at)
    VALUES (?,?,1,?,?,'TEXT','SUCCESS',?,?,'{}',?,?,datetime('now'))`);
  attempt.run('p58_known', 'p58_call_known', student.org_id, student.id, 'REPORTED', 200, 'p58_a', seededLessons.budgeted);
  attempt.run('p58_unknown', 'p58_call_unknown', student.org_id, student.id, 'UNKNOWN', null, 'p58_b', seededLessons.budgeted);
  db.close();
}

// 假网关：登录 + 用量日志。第一页刻意凑成**满页 100 条**（真实网关一页 100 条），
// 于是「不认 p 参数」时第二页会原样重复 —— 这才是能触发重复累加的真实形状。
const LOG_ROWS = [
  { id: 101, token_name: '机构:org_demo', quota: 2500000, model_name: 'gpt-x' },
  { id: 102, token_name: '学生:user_demo', quota: 500000, model_name: 'gpt-x' },
  { id: 103, token_name: `课时:${seededLessons.budgeted}`, quota: 1000000, model_name: 'gpt-x' },
  { id: 104, token_name: '学生:user_demo', quota: 500000, model_name: 'gpt-x' },
  { id: 105, token_name: '随手建的令牌', quota: 100000, model_name: 'gpt-x' },
  // 95 条填充（额度和名字都刻意做成不影响金额断言）：只为把这一页撑满
  ...Array.from({ length: 95 }, (_, i) => ({ id: 200 + i, token_name: '机构:org_filler', quota: 0, model_name: 'gpt-x' })),
];
let logRequests = 0;
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const json = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data })); };
  if (req.url.startsWith('/api/user/login')) return json({ access_token: 'mock-jwt', user: { id: 1 } });
  // 刻意**不认** p 参数：每次请求都返回同一页（模拟分页失效）
  if (req.url.startsWith('/api/log/')) { logRequests += 1; return json({ items: LOG_ROWS }); }
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
  check('能读网关用量并归集', usage.status === 200 && usage.data.calls === 100, JSON.stringify(usage.data).slice(0, 160));
  check('按机构归集（5 元）', usage.data.byOrg?.[0]?.key === 'org_demo' && usage.data.byOrg[0].yuan === 5, JSON.stringify(usage.data.byOrg));
  check('按学员归集（同一学员两次合计 2 元 / 2 次）', usage.data.byStudent?.[0]?.key === 'user_demo' && usage.data.byStudent[0].yuan === 2 && usage.data.byStudent[0].calls === 2, JSON.stringify(usage.data.byStudent));
  check('按课时归集（2 元）', usage.data.byLesson?.[0]?.key === seededLessons.budgeted && usage.data.byLesson[0].yuan === 2, JSON.stringify(usage.data.byLesson));
  check('没按约定命名的令牌单列「未归属」', usage.data.unattributed?.length === 1 && usage.data.unattributed[0].key === '随手建的令牌', JSON.stringify(usage.data.unattributed));
  check('合计元数 = 各维度之和（9.2）', usage.data.totalYuan === 9.2, String(usage.data.totalYuan));
  check('额度换算单位随配置返回（默认 500000 = 1 元）', usage.data.quotaPerUnit === 500000, String(usage.data.quotaPerUnit));
  check('网关不认分页时提前停止（只读了 2 次，不是拉满 20 页）', logRequests === 2, `logRequests=${logRequests}`);
  check('同一页没被重复累加（满页 100 条就是 100 次调用，不是 2000 次）', usage.data.calls === 100, String(usage.data.calls));

  // 多段令牌名（机构/学生/课时写在一张令牌上）也要能逐段归集
  const multi = aggregateUsage([
    { id: 1, token_name: '机构:orgA/学生:stuA/课时:lesA', quota: 1000000 },
    { id: 2, token_name: '机构:orgA/学生:stuA/课时:lesA', quota: 500000 },
  ], { quotaPerUnit: 500000 });
  check('多段令牌名：机构 / 学员 / 课时三个维度都归到（各 3 元）',
    multi.byOrg[0]?.key === 'orgA' && multi.byStudent[0]?.key === 'stuA' && multi.byLesson[0]?.key === 'lesA'
    && multi.byOrg[0].yuan === 3 && multi.byStudent[0].yuan === 3 && multi.byLesson[0].yuan === 3,
    JSON.stringify({ org: multi.byOrg, student: multi.byStudent, lesson: multi.byLesson }));
  check('多段令牌名不算「未归属」', multi.unattributed.length === 0, JSON.stringify(multi.unattributed));

  const comparison = lessonBudgetOverview({ byLesson: [{ key: seededLessons.budgeted, yuan: 9999 }] });
  const budgeted = comparison.find(item => item.lessonId === seededLessons.budgeted);
  const noBudget = comparison.find(item => item.lessonId === seededLessons.noBudget);
  check('课堂快照预算相加，不乘学生数、不取历史售价', budgeted?.budgetFen === 400 && budgeted?.sessionCount === 2, JSON.stringify(budgeted));
  check('已知成本依据 compute_attempts，不取传入网关汇总', budgeted?.knownCostFen === 200, JSON.stringify(budgeted));
  check('未知成本单列，合计保持未知而非零', budgeted?.unknownCalls === 1 && budgeted?.usedFen === null && budgeted?.unknownSessions === 1, JSON.stringify(budgeted));
  check('超预算仅预警，不执行学生限额', budgeted?.overBudgetSessions === 1 && budgeted?.enforced === false, JSON.stringify(budgeted));
  check('未配置预算课堂仍列出且不限制', noBudget?.budgetFen === null && noBudget?.enforced === false, JSON.stringify(noBudget));

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
