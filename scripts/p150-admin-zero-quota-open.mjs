/**
 * P150 平台端「初始授权次数 0」这条开通路径（2026-09-26 用户报「初始授权次数为 0 为什么不支持添加」）。
 *
 * 现场（图3）：平台端「机构课包与授权次数 → 添加课包」抽屉里，初始授权次数填 0，
 * 成交信息（0 元 / 订单号 / 合同号）也填了，**确认添加是灰的**，界面上一个字都不说为什么。
 * 代码里那个灰的判据是：`disabled = busy || !picked || !quotaValid || !purchaseValid`，
 * 而 `Number.isInteger(0) && 0 >= 0` 为**真**、成交三项填了也**真** ——
 * 所以灰的原因根本不是 0，而是**课包还没选中**（`picked` 为空）。两处要修：
 *   ① 「灰」要说清差什么（用户只能看到灰，就把原因归到了 0 上）；
 *   ② 成交与订单信息**只在次数 > 0 时才该必填** —— 服务端本来就是这么判的
 *      （`const purchase = delta > 0 ? normalizeLicensePurchaseInput(...) : null;`，
 *       0 次开通既不校验订单、也不写许可购买批次）。前端一律必填，等于逼 0 次开通的人现编订单号。
 *
 * 这条守卫钉四件事：
 *   ① 源码口径：前端「成交信息必填」必须带 `quotaValue > 0` 前置；页脚必须渲染"还差什么"。
 *   ② 真接口：SUPER_ADMIN 开通一个课包、`quotaTotal=0`、**不带任何成交信息** → 200，
 *      总授权次数就是 0，且**不产生许可购买批次**（没花钱就没有账）。
 *   ③ 同一机构 0 次时「授权给学员」必须被拒（COURSE_QUOTA_EXHAUSTED）—— 这就是
 *      「0 次 = 只开通给机构查阅、分不给学生上课」的语义，别让它悄悄变成"能发课"。
 *   ④ 对照组：次数 > 0 时仍然**必须**给成交信息（400），给了才建批次 ——
 *      证明②跳过的是"这次不需要"，不是把校验删了。
 * 跑法：node scripts/p150-admin-zero-quota-open.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p150-zero-quota-'));
const dbPath = path.join(temp, 'platform.db');
// 硬设（不是 ||=）：脚本自己的库优先；MySQL 模式下这个键被忽略
process.env.PLATFORM_DB_PATH = dbPath;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('① 源码口径（界面上的"灰"与"必填"）');
{
  const page = fs.readFileSync(path.join(root, 'apps/admin/src/pages/OrganizationQuota.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'apps/admin/src/admin.css'), 'utf8');
  check('① 成交与订单信息只在次数 > 0 时必填（0 次开通不用编订单号）',
    /const needsPurchase = quotaValue > 0;/.test(page) && /const purchaseValid = !needsPurchase \|\| purchaseFilled;/.test(page),
    'OrganizationQuota.jsx 里没有 needsPurchase / purchaseValid 的那组判据');
  check('① 0 次开通不带成交信息（不把编的订单号写进请求）',
    /\? \{/.test(page) && /amountMinor: Math\.round/.test(page) && /needsPurchase \? \{/.test(page));
  check('① 按钮灰的时候说清差什么（页脚有禁用原因）',
    /const blockReason = !picked \?/.test(page) && /className="drawer-foot-reason"/.test(page) && /\.drawer-foot-reason\s*\{/.test(css),
    'OrganizationQuota.jsx / admin.css 里没有禁用原因那一行');
}

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const { aq, arow, acount } = await import('../packages/database/src/store.js');
// 机构 + 一个"该机构没开通过的已发布平台课包"（0 次开通走的就是"开一个新课包"这条路）
const org = await arow("SELECT * FROM organizations WHERE name='示例创新学校'");
const student = await arow("SELECT id FROM users WHERE login='student-2'");
assert.ok(org && student, 'seed 里应有 示例创新学校 / student-2');
let series = await arow("SELECT * FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED' LIMIT 1");
if (!series) {
  await aq("UPDATE course_series SET status='PUBLISHED' WHERE owner_type='PLATFORM'");
  series = await arow("SELECT * FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED' LIMIT 1");
}
assert.ok(series, '需要一个已发布的平台课包');
await aq('DELETE FROM course_assignments WHERE series_id=? AND org_id=?', [series.id, org.id]);
// ③ 要的是"**第一次**把这个课包发给这个学生"那种 fresh 情况：seed 里 student-2 已经有这个课包的授权，
//    而「已授权过的学生」在服务端是**跳过**（不重复扣次数）→ 那条路根本不撞额度闸，测不出 0 次该被拒。
await aq('DELETE FROM student_course_grants WHERE series_id=? AND student_id=?', [series.id, student.id]);

const port = 19099;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, code: payload?.error?.code || null, message: payload?.error?.message || null };
};
const login = async (loginName, password) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  return (await response.json().catch(() => ({})))?.data?.token || null;
};
const batchesOf = (assignmentId) => acount('SELECT COUNT(*) n FROM license_purchase_batches WHERE assignment_id=?', [assignmentId]);

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }

  const rootToken = await login('root', 'admin123');
  const orgToken = await login('org-admin', 'org123');
  assert.ok(rootToken && orgToken, '登录失败（root / org-admin）');
  const assignPath = `/api/admin/course-series/${encodeURIComponent(series.id)}/assignments`;

  // ② 0 次开通：**不带任何成交信息**
  const zero = await api(assignPath, { method: 'POST', token: rootToken, body: { orgId: org.id, quotaTotal: 0, idempotencyKey: `p150-zero-${Date.now()}` } });
  check('② 0 次开通（不带成交信息）成功', zero.status === 200, `status=${zero.status} code=${zero.code} msg=${zero.message}`);
  check('② 总授权次数就是 0', Number(zero.data?.quotaTotal) === 0, JSON.stringify(zero.data?.quotaTotal));
  const assignment = await arow('SELECT * FROM course_assignments WHERE series_id=? AND org_id=?', [series.id, org.id]);
  check('② 授权单已建立且次数为 0', Boolean(assignment) && Number(assignment.quota_total) === 0, JSON.stringify(assignment?.quota_total ?? null));
  check('② 0 次不产生许可购买批次（没花钱就没有账）', (await batchesOf(assignment.id)) === 0, '批次数量不为 0');

  const visible = await api('/api/org/course-series?page=1', { token: orgToken });
  const visibleIds = (visible.data?.items || []).map((item) => item.id);
  check('② 机构端能看到这个课包（0 次 = 开通给机构查阅）', visibleIds.includes(series.id), `机构端看到 ${visibleIds.length} 个课包`);

  // ③ 0 次时"授权给学员"必须被拒 —— 否则 0 次就变成了"能上课"
  const grant = await api('/api/org/course-grants', { method: 'POST', token: orgToken, body: { seriesId: series.id, studentIds: [student.id] } });
  check('③ 0 次时机构「授权给学员」被拒（可用次数不足）',
    grant.status === 409 && grant.code === 'COURSE_QUOTA_EXHAUSTED', `status=${grant.status} code=${grant.code} msg=${grant.message}`);

  // ④ 对照组：次数 > 0 时成交信息仍然必填；给了才建批次
  const noInfo = await api(assignPath, { method: 'POST', token: rootToken, body: { orgId: org.id, quotaTotal: 5, idempotencyKey: `p150-noinfo-${Date.now()}` } });
  check('④ 次数 > 0 但不给成交信息 → 400（校验没被删掉）',
    noInfo.status === 400 && noInfo.code === 'INVALID_LICENSE_PURCHASE_AMOUNT', `status=${noInfo.status} code=${noInfo.code} msg=${noInfo.message}`);
  const withInfo = await api(assignPath, {
    method: 'POST', token: rootToken,
    body: {
      orgId: org.id, quotaTotal: 5, amountMinor: 0, currency: 'CNY', paymentStatus: 'PAID',
      orderNo: `P150-${Date.now()}`, contractNo: 'P150-CONTRACT', idempotencyKey: `p150-withinfo-${Date.now()}`,
    },
  });
  const after = await arow('SELECT * FROM course_assignments WHERE series_id=? AND org_id=?', [series.id, org.id]);
  check('④ 给了成交信息 → 成功记 5 次并建批次',
    withInfo.status === 200 && Number(after.quota_total) === 5 && (await batchesOf(after.id)) === 1,
    `status=${withInfo.status} total=${after?.quota_total} 批次=${await batchesOf(after?.id || '')}`);
} catch (error) {
  failures += 1;
  console.log(`  ✗ 运行中异常：${error.message}`);
  console.log(serverLog.split('\n').slice(-8).join('\n'));
} finally {
  server.kill('SIGKILL');
}

if (failures) {
  console.error(JSON.stringify({ name: 'p150-admin-zero-quota-open', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p150-admin-zero-quota-open', pass: true }));
