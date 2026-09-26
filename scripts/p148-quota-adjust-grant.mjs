/**
 * P148 「平台调整了授权次数 → 机构发不出去课」守卫（2026-09-26 生产事故）。
 *
 * 现场（用户报障原文：「为什么这个机构账号授权这个学生会出这个报错」，报错原文
 * **「购买批次余额不足，无法确认收入」**）：
 *   · 平台后台给机构「调整授权次数」把某课包从 0 调到 6（`admin/organizations.js` 的 adjust 路径）；
 *   · 那条路径**按设计不动财务账**（源码注释原文：「不生成许可批次（财务账不受影响，用户未要求联动）」）——
 *     于是授权单上写着 6 次、许可批次一条都没有；
 *   · 机构端看得到「剩 6 次」，一点「授权给学员」→ `nextFifoUnit()` 找不到可分配的批次 →
 *     `LICENSE_PURCHASE_BALANCE_EXHAUSTED`「购买批次余额不足，无法确认收入」。
 *   两条口径在**把课发给学生**这一步撞上了；生产上三个授权单有这个缺口（0/6、5/10、1/51）。
 *
 * 修法（本守卫钉住）：在**真要发给学生**那一刻（`appendLicenseGrantRevenue`）先把缺口补成一笔
 * `LEGACY_OPENING_BALANCE` 批次（金额 NULL、payment_status=UNKNOWN，与切库时那三笔历史开通批次同形状）
 * —— 既不动财务口径（不产生任何收入金额），又让账实相符、机构能正常发课。
 * 幂等：批次覆盖够了就不再补；**作废过的采购仍然"解释"了那部分次数**，不许被补成开通批次
 * （否则「作废批次 → 再发授权」会绕过作废，p85 钉的正是这条）。
 *
 * 钉五件事：
 *   ① 源码口径：补批次发生在 FIFO 之前；
 *   ② 完全没有批次（0/6 那种）→ 授权**不再报错**，并补出一笔数量=缺口的开通批次；
 *   ③ 幂等：连发两次授权只补一笔；
 *   ④ 部分覆盖（10/5）→ 只补差额 5；
 *   ⑤ 批次被作废 → **仍然拒绝**（不许靠补开通批次绕过作废）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p148-quota-grant-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');

const { aq, arow, arows } = await import('../apps/server/src/lib.js');
const { appendLicenseGrantRevenue, ensureOpeningBalanceBatch, voidLicensePurchaseBatches, createLicensePurchaseBatch, normalizeLicensePurchaseInput } =
  await import('../apps/server/src/services/licenseLedger.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const ledgerSource = fs.readFileSync(new URL('../apps/server/src/services/licenseLedger.js', import.meta.url), 'utf8');

console.log('① 源码口径：补批次发生在 FIFO 分配之前');
check('① appendLicenseGrantRevenue 在 nextFifoUnit 之前调 ensureOpeningBalanceBatch',
  ledgerSource.indexOf('await ensureOpeningBalanceBatch({ assignmentId, orgId, seriesId, actorId })') < ledgerSource.indexOf('await nextFifoUnit(assignmentId)')
  && ledgerSource.includes('await ensureOpeningBalanceBatch({ assignmentId, orgId, seriesId, actorId })'));
check('① 覆盖量按**所有状态**的批次算（作废的也解释来源，才不会被补掉）', (() => {
  const at = ledgerSource.indexOf('export async function ensureOpeningBalanceBatch');
  const body = ledgerSource.slice(at, ledgerSource.indexOf('async function nextFifoUnit'));
  return /FROM license_purchase_batches WHERE assignment_id=?/.test(body) && !/status='ACTIVE'/.test(body);
})());

const now = new Date().toISOString();
await aq("INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES ('org148','P148','ACTIVE',?,?,0,?,?)", [now, new Date(Date.now() + 86400000).toISOString(), now, now]);
for (const [sid, title] of [['series148', 'P148 课包'], ['series148c', 'P148 课包 C'], ['series148d', 'P148 课包 D']]) { await aq("INSERT INTO course_series(id,title,status,owner_type,visibility,stock_total,created_at,updated_at) VALUES (?,?,'PUBLISHED','PLATFORM','PUBLIC',500,?,?)", [sid, title, now, now]); }
// 生产现场的形状：授权单上有 6 次、**一条批次都没有**（平台「调整授权次数」调出来的）
await aq("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_at,quota_total,quota_used) VALUES ('assign148','series148','org148','ACTIVE',?,6,0)", [now]);
await aq("INSERT INTO student_course_grants(id,org_id,student_id,series_id,source_assignment_id,granted_by,granted_at) VALUES ('grant148a','org148','student148a','series148','assign148','org-admin',?)", [now]);

console.log('② 缺批次时授权不再报错，并补出一笔平台开通批次');
let granted = null;
try {
  granted = await appendLicenseGrantRevenue({ assignmentId: 'assign148', orgId: 'org148', seriesId: 'series148', grantId: 'grant148a', actorId: 'org-admin' });
  check('② ⭐ 授权走通了（原来会抛 LICENSE_PURCHASE_BALANCE_EXHAUSTED）', Boolean(granted?.id), JSON.stringify(granted));
} catch (error) {
  check('② ⭐ 授权走通了（原来会抛 LICENSE_PURCHASE_BALANCE_EXHAUSTED）', false, `${error.code} ${error.message}`);
}
const batches = await arows("SELECT * FROM license_purchase_batches WHERE assignment_id='assign148' ORDER BY created_at");
check('② 补出的是一笔 LEGACY_OPENING_BALANCE（平台给的额度，不是采购收入）',
  batches.length === 1 && batches[0].purchase_type === 'LEGACY_OPENING_BALANCE' && Number(batches[0].quantity) === 6,
  JSON.stringify(batches.map((b) => ({ t: b.purchase_type, q: b.quantity }))));
check('② 金额与收款状态是"无金额"那套（不给财务账添收入）',
  batches[0].amount_minor == null && batches[0].payment_status === 'UNKNOWN', `amount=${batches[0].amount_minor} status=${batches[0].payment_status}`);
check('② 收入事件挂在这笔批次上（数量 1、金额 NULL）',
  Number((await arow("SELECT COUNT(*) n FROM license_revenue_events WHERE assignment_id='assign148' AND event_type='GRANT'"))?.n) === 1
  && (await arow("SELECT amount_minor FROM license_revenue_events WHERE assignment_id='assign148' AND event_type='GRANT'"))?.amount_minor == null);

console.log('③ 幂等：再发一个学生只消耗、不再补批次');
await aq("INSERT INTO student_course_grants(id,org_id,student_id,series_id,source_assignment_id,granted_by,granted_at) VALUES ('grant148b','org148','student148b','series148','assign148','org-admin',?)", [now]);
await appendLicenseGrantRevenue({ assignmentId: 'assign148', orgId: 'org148', seriesId: 'series148', grantId: 'grant148b', actorId: 'org-admin' });
check('③ 批次还是一条（没有补第二笔）', Number((await arow("SELECT COUNT(*) n FROM license_purchase_batches WHERE assignment_id='assign148'"))?.n) === 1);
check('③ 两笔收入都从同一笔批次里出（分配 2 个）',
  Number((await arow("SELECT COALESCE(SUM(a.quantity),0) n FROM license_revenue_allocations a JOIN license_revenue_events e ON e.id=a.revenue_event_id WHERE e.assignment_id='assign148'"))?.n) === 2);
check('③ 直接再调一次补批次是空操作（返回 null）', (await ensureOpeningBalanceBatch({ assignmentId: 'assign148', orgId: 'org148', seriesId: 'series148' })) === null);

console.log('④ 部分覆盖：只补差额');
await aq("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_at,quota_total,quota_used) VALUES ('assign148c','series148c','org148','ACTIVE',?,10,0)", [now]);
await createLicensePurchaseBatch({
  assignmentId: 'assign148c', orgId: 'org148', seriesId: 'series148c', actorId: 'root', purchasedAt: now,
  ...normalizeLicensePurchaseInput({ amountMinor: 50000, currency: 'CNY', paymentStatus: 'PAID', orderNo: 'P148-1', contractNo: 'C-148', idempotencyKey: 'p148-key-1' }, 5),
});
const topped = await ensureOpeningBalanceBatch({ assignmentId: 'assign148c', orgId: 'org148', seriesId: 'series148c' });
check('④ 已经买了 5 次、授权单写 10 → 只补 5（不是补 10）', Number(topped?.quantity) === 5, JSON.stringify(topped));
check('④ 采购那笔批次原样还在（钱的味道没变）',
  Number((await arow("SELECT quantity FROM license_purchase_batches WHERE assignment_id='assign148c' AND purchase_type='PURCHASE'"))?.quantity) === 5);

console.log('⑤ 作废过的采购不许被"补开通批次"绕过');
await aq("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_at,quota_total,quota_used) VALUES ('assign148d','series148d','org148','ACTIVE',?,3,0)", [now]);
await createLicensePurchaseBatch({
  assignmentId: 'assign148d', orgId: 'org148', seriesId: 'series148d', actorId: 'root', purchasedAt: now,
  ...normalizeLicensePurchaseInput({ amountMinor: 30000, currency: 'CNY', paymentStatus: 'PAID', orderNo: 'P148-2', contractNo: 'C-148', idempotencyKey: 'p148-key-2' }, 3),
});
await voidLicensePurchaseBatches('assign148d');
check('⑤ 作废后**不补**开通批次（次数是被作废的采购解释的，不该被当成平台额度）',
  (await ensureOpeningBalanceBatch({ assignmentId: 'assign148d', orgId: 'org148', seriesId: 'series148d' })) === null);
let refused = null;
try { await appendLicenseGrantRevenue({ assignmentId: 'assign148d', orgId: 'org148', seriesId: 'series148d', grantId: 'grant148d', actorId: 'org-admin' }); }
catch (error) { refused = error; }
check('⑤ ⭐ 作废后授权仍然被拒（不许绕过作废 —— 与 p85 同一条口径）',
  refused?.code === 'LICENSE_PURCHASE_BALANCE_EXHAUSTED', refused ? `${refused.code}` : '竟然过了');


// ── ⑥ 真接口端到端（2026-09-26 补）：平台「调整授权次数」调增 → 机构「授权给学员」必须能过 ──
// 这一段是**用户报障的原始路径**：只用服务级断言证明不了"平台那个入口和机构那个入口能接上"。
console.log('⑥ 真服务：平台调增 → 机构授权（用户报障的原始路径）');
const { spawn } = await import('node:child_process');
const httpPort = 19148;
const netEnv = { ...process.env, PLATFORM_DATA_DIR: dir, PLATFORM_DB_PATH: path.join(dir, 'platform.db'), DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock', PORT: String(httpPort) };
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: process.cwd(), env: netEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const call = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${httpPort}${pathname}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null; try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, payload };
};
try {
  for (let i = 0; i < 120; i += 1) { try { if ((await fetch(`http://127.0.0.1:${httpPort}/health`)).ok) break; } catch { /* 等起来 */ } await new Promise((r) => setTimeout(r, 100)); }
  // 造一家机构 + 一个已发布课包 + 一个学生，然后**只**走「调整授权次数」把次数调到 4（不建任何批次）
  // 种子（org-admin / root 这些账号在种子里）—— 前面几段都是自己插数据，这一段要用真账号登录
  for (const script of ['packages/database/src/db.js', 'packages/database/src/seed.js']) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...(script.includes('db.js') ? ['--init'] : [])], { cwd: process.cwd(), env: netEnv, stdio: 'ignore' });
      child.on('close', (code) => (code ? reject(new Error(script)) : resolve()));
    });
  }
  const orgId = 'org148http'; const seriesId = 'series148http'; const studentId = 'student148http';
  await aq("INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES (?,'P148 真服务','ACTIVE',?,?,0,?,?)", [orgId, now, new Date(Date.now() + 86400000).toISOString(), now, now]);
  await aq("INSERT INTO course_series(id,title,status,owner_type,visibility,stock_total,created_at,updated_at) VALUES (?,'P148 真服务课包','PUBLISHED','PLATFORM','PUBLIC',50,?,?)", [seriesId, now, now]);
  const orgAdminUser = await arow("SELECT id, org_id, password_hash FROM users WHERE login='org-admin'");
  await aq("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_at,quota_total,quota_used) VALUES ('assign148http',?,?,'ACTIVE',?,0,0)", [seriesId, orgAdminUser.org_id, now]);
  await aq("INSERT INTO users(id,org_id,login,display_name,role,password_hash,status,created_at,updated_at) VALUES (?,?,'p148student','P148 学员','STUDENT',?,'ACTIVE',?,?)", [studentId, orgAdminUser.org_id, orgAdminUser.password_hash, now, now]);
  const root = await call('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123', clientType: 'admin' } });
  const orgLogin = await call('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123', clientType: 'org' } });
  const rootToken = root.payload?.data?.token;
  const orgToken = orgLogin.payload?.data?.token;
  check('⑥ 两个身份都登录上了（平台超管 + 机构管理员）', Boolean(rootToken) && Boolean(orgToken));

  const adjusted = await call(`/api/admin/organizations/${orgAdminUser.org_id}/course-quotas/${seriesId}/adjust`, { method: 'POST', token: rootToken, body: { delta: 4, reason: 'P148 端到端：平台调增 4 次' } });
  check('⑥ 平台「调整授权次数」+4 成功', adjusted.status === 200, `HTTP ${adjusted.status} ${JSON.stringify(adjusted.payload).slice(0, 140)}`);
  // ⭐ 新增的行为：调增时**当场**就补了批次（不再等到机构发课）
  const batchesNow = await arows("SELECT * FROM license_purchase_batches WHERE assignment_id='assign148http'");
  check('⑥ ⭐ 调增的同时就补了一笔 0 金额平台开通批次（不用等发课）',
    batchesNow.length === 1 && batchesNow[0].purchase_type === 'LEGACY_OPENING_BALANCE' && Number(batchesNow[0].quantity) === 4 && batchesNow[0].amount_minor == null,
    JSON.stringify(batchesNow.map((b) => ({ t: b.purchase_type, q: b.quantity, a: b.amount_minor }))));
  check('⑥ 返回里带了这笔批次 id（后台/审计看得见）', Boolean(adjusted.payload?.data?.openingBatch), JSON.stringify(adjusted.payload?.data || {}).slice(0, 120));

  const granted = await call('/api/org/course-grants', { method: 'POST', token: orgToken, body: { seriesId, studentIds: [studentId] } });
  check('⑥ ⭐ 机构「授权给学员」成功（用户报障的那一步，原来 409「购买批次余额不足」）',
    granted.status === 200 && Number(granted.payload?.data?.granted) === 1, `HTTP ${granted.status} ${JSON.stringify(granted.payload).slice(0, 140)}`);
  check('⑥ 学员拿到了授权、次数扣了 1',
    Number((await arow("SELECT COUNT(*) n FROM student_course_grants WHERE series_id=? AND student_id=?", [seriesId, studentId]))?.n) === 1
    && Number((await arow("SELECT quota_used FROM course_assignments WHERE id='assign148http'"))?.quota_used) === 1);
  check('⑥ 批次还是那一笔（发课时不再重复补）',
    Number((await arow("SELECT COUNT(*) n FROM license_purchase_batches WHERE assignment_id='assign148http'"))?.n) === 1);
} finally {
  server.kill();
}

if (failures) { console.log(`\nP148 有 ${failures} 项未通过`); if (serverLog) console.log(serverLog.slice(-1200)); process.exitCode = 1; }
else console.log('P148 平台调整次数后能正常发课：缺口补成 0 金额的平台开通批次、幂等、部分覆盖只补差额、作废仍拦、真接口端到端 通过');
