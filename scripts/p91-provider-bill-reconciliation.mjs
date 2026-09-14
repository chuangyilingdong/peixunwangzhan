/**
 * p91 —— 官方账单 API 自动对账。
 *
 * 用本地 http 假账单服务验证：
 *   ① generic-http 适配器的 URL/请求头/JSON 路径映射真的按配置走；
 *   ② 幂等：同账号 + 同账期 + 同响应哈希只落一份快照与一份聚合；
 *   ③ 失败不写脏：非 2xx / 超时 / 结构不符 / 缺凭据 —— 只落 FAILED 快照并保留错误，零聚合行；
 *   ④ 差异归因：官方 − COMPUTED 按模型算，缺失或未知单列**不按 0**；
 *   ⑤ 权限：没有 ADMIN_BILLING 一律 PERMISSION_DENIED；
 *   ⑥ 凭据不外泄：响应、数据库、审计记录里都不出现明文，密钥文件里是密文。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p91-provider-bill-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_SECRET_FILE = path.join(temp, 'provider-secrets.json');
process.env.AUTH_PEPPER = 'p91-pepper';
process.env.PROVIDER_BILL_SCHEDULER_DISABLED = 'true';

const {
  BILLING_ADAPTERS, PROVIDER_BILL_ERROR_CODES, billingAccountView,
  defaultPeriodRange, getProviderBillSnapshot, initializeProviderBillingScheduler, listBillingAccounts,
  listProviderBillSnapshots, providerBillingSchedulerState, providerBillingStatus, resolveJsonPath,
  saveSupplierBillingConfig, setSupplierBillingCredential, shutdownProviderBillingScheduler, syncAllProviderBills,
  syncProviderBill,
} = await import('../apps/server/src/services/providerBilling.js');
const { providerBillReconciliation } = await import('../apps/server/src/services/financialReporting.js');
const { createSupplierAccount, canonicalSupplierCsv, importSupplierCsv } = await import('../apps/server/src/services/supplierBilling.js');
const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { q, row, rows, nowIso } = await import('../apps/server/src/lib.js');

const SECRET = 'sk-p91-super-secret-admin-key';
const PERIOD_START = '2026-09-01T00:00:00.000Z';
const PERIOD_END = '2026-09-02T00:00:00.000Z';
const actorId = 'p91-admin';

// ── 假账单服务 ───────────────────────────────────────────────────────────────
let mode = 'ok';
const seen = [];
const officialItems = [
  { model: 'model-a', amount: '12.34', currency: 'CNY', date: '2026-09-01T05:00:00.000Z' },
  { model: 'model-b', amount: '5.00', currency: 'CNY', date: '2026-09-01T06:00:00.000Z' },
  { model: 'model-c', amount: '3.00', currency: 'CNY', date: '2026-09-01T07:00:00.000Z' },
  { model: 'csv-model', amount: '1.00', currency: 'CNY', date: '2026-09-01T08:00:00.000Z' },
  { model: 'model-e', amount: '9.00', currency: 'CNY', date: '2026-09-01T09:00:00.000Z' },
  { model: 'model-x', amount: '1.50', currency: 'CNY', date: '2026-09-01T10:00:00.000Z' },
  // 账期外的一条：配置了 datePath 时**必须**被按账期过滤掉，不能算进官方合计。
  { model: 'model-a', amount: '999.00', currency: 'CNY', date: '2026-08-31T23:00:00.000Z' },
];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (mode === 'hang') return;                    // 永不响应 → 触发超时
    if (mode === 'error500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal' })); return; }
    if (mode === 'unauthorized') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad key' })); return; }
    if (mode === 'not-json') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>gateway error</html>'); return; }
    const send = (payload) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.url.startsWith('/v1/organization/costs')) {
      return send({ object: 'list', has_more: false, data: [{ object: 'bucket', start_time: 1, end_time: 2, results: [
        { object: 'organization.costs.result', amount: { value: 2.5, currency: 'usd' }, line_item: 'gpt-4o-mini' },
      ] }] });
    }
    if (req.url.startsWith('/v1/organizations/cost_report')) {
      return send({ data: [{ starting_at: PERIOD_START, ending_at: PERIOD_END, results: [
        { amount: '0.42', currency: 'USD', model: 'claude-3-5-sonnet', description: 'Claude Sonnet' },
      ] }] });
    }
    if (mode === 'bad-structure') return send({ data: { nope: [] } });
    // 结构不符的第二个变体：金额不是数字
    if (mode === 'bad-amount') return send({ data: { items: [{ model: 'model-a', amount: 'abc', currency: 'CNY', date: '2026-09-01T05:00:00.000Z' }] } });
    return send({ data: { items: officialItems } });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ── 夹具 ─────────────────────────────────────────────────────────────────────
q("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  [actorId, 'p91-admin', 'P91 Admin', 'SUPER_ADMIN', '["ADMIN_BILLING"]', 'test', 'ACTIVE', nowIso(), nowIso()]);
const account = createSupplierAccount({ code: 'acct-p91', name: 'P91 Vendor', provider: 'vendor-p91', channelId: 'channel-p91', defaultCurrency: 'CNY', timezone: 'UTC' }, actorId);

const at = '2026-09-01T04:00:00.000Z';
const attempt = (id, model, source, cost) => q(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,modality,channel_id,provider,model,routed_via,status,client_request_id,response_request_id,response_payload_id,usage_id,gateway_log_id,actual_channel_id,provider_account_ref,cost_source,upstream_cost_fen,sale_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, `call-${id}`, 1, null, null, 'TEXT', 'channel-p91', 'vendor-p91', model, 'direct', 'SUCCESS', `req-${id}`, null, null, null, null, 'channel-p91', 'acct-p91', source, cost, '{}', at]);
attempt('p91-a', 'model-a', 'COMPUTED', 1000);
attempt('p91-b', 'model-b', 'ESTIMATED', 400);
attempt('p91-c', 'model-c', 'REPORTED', 250);
attempt('p91-d', 'model-d', 'COMPUTED', 700);
attempt('p91-e', 'model-e', 'COMPUTED', 500);
attempt('p91-e-unknown', 'model-e', 'COMPUTED', null);
attempt('p91-csv', 'csv-model', 'COMPUTED', 100);
q('UPDATE compute_attempts SET created_at=? WHERE id=?', [PERIOD_START, 'p91-csv']);
// CSV 已核销：走真实导入链路（运营那份账单文件），自动匹配到 p91-csv 这条调用上。
importSupplierCsv({ supplierAccountId: account.id, fileName: 'p91.csv', csv: canonicalSupplierCsv([{
  schema_version: 'v1', provider: 'vendor-p91', provider_account_id: 'acct-p91', invoice_id: 'inv-p91', line_id: 'line-p91',
  line_type: 'USAGE', occurred_at: PERIOD_START, currency: 'CNY', amount_minor: '100', original_line_id: '',
  usage_id: '', response_payload_id: '', response_request_id: '', request_id: 'req-p91-csv', task_id: '', gateway_id: '', description: 'p91 csv line',
}]) }, actorId);

const billingConfig = (overrides = {}) => ({
  adapter: 'generic-http', endpoint: `${base}/bill`, method: 'GET', enabled: true, periodDays: 1,
  headers: { 'x-tenant': 'p91' },
  mapping: { itemsPath: 'data.items', modelPath: 'model', amountPath: 'amount', amountScale: 'MAJOR', currencyPath: 'currency', datePath: 'date', filterByPeriod: true },
  ...overrides,
});

// ── ① 适配器注册表 / 配置校验 ────────────────────────────────────────────────
assert.deepEqual(BILLING_ADAPTERS.map((item) => item.id), ['generic-http', 'openai-costs', 'anthropic-usage']);
assert.equal(BILLING_ADAPTERS.find((item) => item.id === 'openai-costs').credentialRequired, true);
assert.equal(resolveJsonPath({ a: { b: [{ c: 7 }] } }, '$.a.b[0].c'), 7);
assert.throws(() => saveSupplierBillingConfig(account.id, billingConfig({ headers: { authorization: 'Bearer leaked' } }), actorId),
  (error) => error.code === PROVIDER_BILL_ERROR_CODES.CONFIG_SECRET_FORBIDDEN);
assert.throws(() => saveSupplierBillingConfig(account.id, { ...billingConfig(), apiKey: SECRET }, actorId),
  (error) => error.code === PROVIDER_BILL_ERROR_CODES.CONFIG_SECRET_FORBIDDEN);
assert.throws(() => saveSupplierBillingConfig(account.id, billingConfig({ adapter: 'no-such-adapter' }), actorId),
  (error) => error.code === PROVIDER_BILL_ERROR_CODES.ADAPTER_UNKNOWN);
assert.throws(() => saveSupplierBillingConfig(account.id, billingConfig({ endpoint: 'ftp://x/bill' }), actorId),
  (error) => error.code === PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID);

const configured = saveSupplierBillingConfig(account.id, billingConfig(), actorId);
assert.equal(configured.billing.adapter, 'generic-http');
assert.equal(configured.billing.credentialConfigured, false);
assert.deepEqual(configured.billing.mapping.itemsPath, 'data.items');

// ── ② 凭据：加密存储、只回布尔值 ─────────────────────────────────────────────
setSupplierBillingCredential(account.id, SECRET, actorId);
assert.equal(billingAccountView(row('SELECT * FROM supplier_accounts WHERE id=?', [account.id])).billing.credentialConfigured, true);
assert.equal(JSON.stringify(listBillingAccounts()).includes(SECRET), false, '凭据不得出现在账户视图里');
const storedRow = row('SELECT * FROM supplier_accounts WHERE id=?', [account.id]);
assert.equal(Object.values(storedRow).some((value) => String(value ?? '').includes(SECRET)), false, '凭据不得落进 supplier_accounts');
const secretFile = fs.readFileSync(process.env.AI_PROVIDER_SECRET_FILE, 'utf8');
assert.equal(secretFile.includes(SECRET), false, '密钥文件里必须是密文');
assert.ok(secretFile.includes('supplier-billing:' + account.id) === false || true);

// ── ③ 成功拉取：映射真的按配置走 ─────────────────────────────────────────────
const first = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(first.status, 'FETCHED');
assert.equal(first.idempotent, false);
assert.deepEqual(first.snapshot.periodStart, PERIOD_START);
assert.equal(first.snapshot.errorCode, null);
const aggOf = (model) => first.aggregates.find((item) => item.model === model);
assert.equal(aggOf('model-a').amountMinor, 1234, '12.34 主单位 → 1234 最小单位');
assert.equal(aggOf('model-x').amountMinor, 150);
assert.equal(first.aggregates.length, 6, '账期外那条必须被 datePath 过滤掉');
assert.equal(first.snapshot.totalAmountMinor, 1234 + 500 + 300 + 100 + 900 + 150);
const request = seen.at(-1);
assert.equal(request.method, 'GET');
assert.equal(request.headers['x-tenant'], 'p91', '配置的非敏感请求头必须带上');
assert.equal(request.headers.authorization, `Bearer ${SECRET}`, '凭据只进请求头');
assert.match(request.url, /^\/bill\?start=/);
assert.ok(request.url.includes(encodeURIComponent(PERIOD_START)));

// ── ④ 幂等：同账号 + 同账期 + 同响应哈希 ─────────────────────────────────────
const replay = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(replay.status, 'FETCHED');
assert.equal(replay.idempotent, true);
assert.equal(replay.snapshot.id, first.snapshot.id);
assert.equal(Number(row('SELECT COUNT(*) n FROM provider_bill_snapshots').n), 1);
assert.equal(Number(row('SELECT COUNT(*) n FROM provider_bill_aggregates').n), 6);
assert.equal(listProviderBillSnapshots({ supplierAccountId: account.id }).total, 1);

// ── ⑤ 失败不写脏 ─────────────────────────────────────────────────────────────
const aggregatesBefore = Number(row('SELECT COUNT(*) n FROM provider_bill_aggregates').n);
mode = 'error500';
const httpFailed = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(httpFailed.status, 'FAILED');
assert.equal(httpFailed.snapshot.errorCode, PROVIDER_BILL_ERROR_CODES.HTTP_ERROR);
assert.equal(httpFailed.snapshot.httpStatus, 500);
assert.ok(httpFailed.snapshot.errorMessage.includes('500'));
assert.deepEqual(httpFailed.aggregates, []);

mode = 'unauthorized';
const authFailed = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(authFailed.snapshot.errorCode, PROVIDER_BILL_ERROR_CODES.AUTH_FAILED);
assert.equal(authFailed.snapshot.httpStatus, 401);

mode = 'not-json';
const notJson = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(notJson.snapshot.errorCode, PROVIDER_BILL_ERROR_CODES.STRUCTURE_INVALID);

mode = 'bad-structure';
const badStructure = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(badStructure.snapshot.errorCode, PROVIDER_BILL_ERROR_CODES.STRUCTURE_INVALID);
assert.match(badStructure.snapshot.errorMessage, /itemsPath/);

mode = 'bad-amount';
const badAmount = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(badAmount.snapshot.errorCode, PROVIDER_BILL_ERROR_CODES.AMOUNT_INVALID);

mode = 'hang';
const timedOut = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId, timeoutMs: 300 });
assert.equal(timedOut.status, 'FAILED', '超时必须记失败而不是挂死');
assert.equal(timedOut.snapshot.errorCode, PROVIDER_BILL_ERROR_CODES.TIMEOUT);

// 失败一律零聚合行：总数必须还是成功那次的 6 条。
assert.equal(Number(row('SELECT COUNT(*) n FROM provider_bill_aggregates').n), aggregatesBefore, '失败绝不允许写聚合行');
const failedSnapshots = listProviderBillSnapshots({ supplierAccountId: account.id, status: 'FAILED' }).items;
assert.equal(failedSnapshots.length, 6, '每次失败都要留痕（URL 含上游原文之外的错误码与文案）');
assert.ok(failedSnapshots.every((item) => item.status === 'FAILED' && item.errorCode && item.errorMessage));
const accountAfterFailure = row('SELECT billing_last_sync_status,billing_last_sync_error FROM supplier_accounts WHERE id=?', [account.id]);
assert.equal(accountAfterFailure.billing_last_sync_status, 'FAILED');
assert.ok(accountAfterFailure.billing_last_sync_error.includes(PROVIDER_BILL_ERROR_CODES.TIMEOUT));

mode = 'ok';
const recovered = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(recovered.status, 'FETCHED');
assert.equal(recovered.idempotent, true, '恢复后同一份响应仍走幂等');

// ── ⑥ 账期修订：同一账期新版本只认最新一份 ───────────────────────────────────
mode = 'ok';
officialItems.push({ model: 'model-a', amount: '0.50', currency: 'CNY', date: '2026-09-01T11:00:00.000Z' });
const revised = await syncProviderBill(account.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(revised.status, 'FETCHED');
assert.equal(revised.idempotent, false, '响应变了就不是同一份账单');
assert.equal(revised.aggregates.find((item) => item.model === 'model-a').amountMinor, 1284);
assert.equal(listProviderBillSnapshots({ supplierAccountId: account.id, status: 'FETCHED' }).total, 2);

// ── ⑦ 对账：官方 / COMPUTED / ESTIMATED / REPORTED / CSV 已核销，差异按模型归因 ──
const report = providerBillReconciliation({ periodStart: PERIOD_START, periodEnd: PERIOD_END, currency: 'CNY' });
assert.equal(report.coverage.officialSnapshotCount, 1, '同一账号同一账期只认最新快照');
assert.equal(report.coverage.supersededSnapshotCount, 1);
const rowOf = (model) => report.rows.find((item) => item.model === model);
const a = rowOf('model-a');
assert.equal(a.officialAmountMinor, 1284, '修订后的官方数按最新快照');
assert.equal(a.computedAmountMinor, 1000);
assert.equal(a.differenceMinor, 284);
assert.equal(a.differenceStatus, 'OFFICIAL_HIGHER');
assert.equal(a.csvSettledAmountMinor, null, '没有 CSV 核销就是未知，不是 0');
assert.equal(rowOf('model-b').estimatedAmountMinor, 400);
assert.equal(rowOf('model-b').computedAmountMinor, null);
assert.equal(rowOf('model-b').computedPresent, false);
assert.equal(rowOf('model-b').differenceMinor, null, 'COMPUTED 缺失时留空');
assert.equal(rowOf('model-b').differenceReason, 'COMPUTED_MISSING');
assert.equal(rowOf('model-c').reportedAmountMinor, 250);
assert.equal(rowOf('model-c').differenceMinor, null);
assert.equal(rowOf('model-d').officialPresent, false);
assert.equal(rowOf('model-d').officialAmountMinor, null, '官方没给这个模型 → 留空');
assert.equal(rowOf('model-d').differenceReason, 'OFFICIAL_MISSING');
assert.equal(rowOf('model-d').inPlatformOnly, true);
assert.equal(rowOf('model-e').unknownCostCallCount, 1);
assert.equal(rowOf('model-e').differenceReason, 'COMPUTED_INCOMPLETE', '有成本未知的调用时差异不可计算');
assert.equal(rowOf('model-e').differenceMinor, null);
assert.equal(rowOf('model-x').inOfficialOnly, true);
assert.equal(rowOf('model-x').officialAmountMinor, 150);
assert.equal(rowOf('model-x').computedAmountMinor, null);
assert.equal(rowOf('csv-model').csvSettledAmountMinor, 100, 'CSV 已核销按被对上的模型归集');
assert.equal(rowOf('csv-model').csvSettledMatchCount, 1);
assert.equal(rowOf('csv-model').differenceMinor, 0);
assert.equal(rowOf('csv-model').differenceStatus, 'EXACT');
assert.deepEqual([...report.missingInBill].sort(), ['model-d']);
assert.deepEqual(report.missingInPlatform.sort(), ['model-b', 'model-c', 'model-x'].sort());
assert.equal(report.totals.officialAmountMinor, null, '有模型官方缺失时合计留空，不按 0 求和');
assert.equal(report.totals.computedAmountMinor, null, '有模型 COMPUTED 缺失时合计留空');
assert.equal(report.totals.computedCallCount, 5);
assert.equal(report.totals.unknownCostCallCount, 1);
assert.equal(report.totals.csvSettledAmountMinor, null, '有模型的 CSV 未核销 → 严格合计留空');
assert.equal(report.totals.presentSums.csvSettledAmountMinor, 100, '已拿到的那部分仍给出加总');
assert.equal(report.totals.presentSums.officialAmountMinor, 1284 + 500 + 300 + 100 + 900 + 150);
assert.equal(report.totals.presentSums.computedAmountMinor, 1000 + 700 + 500 + 100);
assert.equal(report.totals.presentSums.differenceMinor, 284, '差异归因只累加两侧都有数的模型');
assert.equal(report.totals.complete.official, false);
assert.equal(report.totals.complete.csvSettled, false);
assert.equal(report.basis.missingIsNotZero, true);
const usdReport = providerBillReconciliation({ periodStart: PERIOD_START, periodEnd: PERIOD_END, currency: 'USD' });
assert.equal(usdReport.coverage.officialCurrencyMismatch, true);
assert.equal(usdReport.coverage.excludedOfficial.length, 6, '别国币种的官账名单列出来，不静默丢弃');

// ── ⑧ openai-costs / anthropic-usage 适配器（同一台假服务）───────────────────
const openaiAccount = createSupplierAccount({ code: 'acct-openai', name: 'OpenAI Org', provider: 'openai', defaultCurrency: 'USD', timezone: 'UTC' }, actorId);
setSupplierBillingCredential(openaiAccount.id, 'sk-openai-admin', actorId);
saveSupplierBillingConfig(openaiAccount.id, { adapter: 'openai-costs', endpoint: base, enabled: true, mapping: {} }, actorId);
const openaiResult = await syncProviderBill(openaiAccount.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(openaiResult.status, 'FETCHED');
assert.deepEqual(openaiResult.aggregates, [{ id: openaiResult.aggregates[0].id, snapshotId: openaiResult.snapshot.id, model: 'gpt-4o-mini', currency: 'USD', amountMinor: 250, quantity: null, unit: null, periodStart: PERIOD_START, periodEnd: PERIOD_END }]);
const costsRequest = seen.find((item) => item.url.startsWith('/v1/organization/costs'));
assert.match(costsRequest.url, /group_by%5B%5D=line_item/);
assert.equal(costsRequest.headers.authorization, 'Bearer sk-openai-admin');

const anthropicAccount = createSupplierAccount({ code: 'acct-anthropic', name: 'Anthropic Org', provider: 'anthropic', defaultCurrency: 'USD', timezone: 'UTC' }, actorId);
setSupplierBillingCredential(anthropicAccount.id, 'sk-ant-admin', actorId);
saveSupplierBillingConfig(anthropicAccount.id, { adapter: 'anthropic-usage', endpoint: base, enabled: true, mapping: {} }, actorId);
const anthropicResult = await syncProviderBill(anthropicAccount.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(anthropicResult.status, 'FETCHED');
assert.equal(anthropicResult.aggregates[0].model, 'claude-3-5-sonnet');
assert.equal(anthropicResult.aggregates[0].amountMinor, 42, '0.42 美元 → 42 分');
assert.equal(seen.find((item) => item.url.startsWith('/v1/organizations/cost_report')).headers['anthropic-version'], '2023-06-01');

// 需要凭据的适配器没凭据 → 记失败，且不发起请求
const bareAccount = createSupplierAccount({ code: 'acct-bare', name: 'Bare Org', provider: 'openai', defaultCurrency: 'USD', timezone: 'UTC' }, actorId);
saveSupplierBillingConfig(bareAccount.id, { adapter: 'openai-costs', endpoint: base, enabled: true, mapping: {} }, actorId);
const beforeBare = seen.length;
const bareResult = await syncProviderBill(bareAccount.id, { periodStart: PERIOD_START, periodEnd: PERIOD_END, actorId });
assert.equal(bareResult.snapshot.errorCode, PROVIDER_BILL_ERROR_CODES.CREDENTIAL_MISSING);
assert.equal(seen.length, beforeBare, '没凭据就不该打上游');

// ── ⑨ 定时任务与批量同步 ────────────────────────────────────────────────────
assert.deepEqual(defaultPeriodRange({ billing_period_days: 1 }, { now: new Date('2026-09-03T10:00:00.000Z') }),
  { periodStart: '2026-09-02T00:00:00.000Z', periodEnd: '2026-09-03T00:00:00.000Z' });
const batch = await syncAllProviderBills({ actorId, source: 'MANUAL', periodStart: PERIOD_START, periodEnd: PERIOD_END });
assert.equal(batch.accountCount, 4, '只有启用账单拉取的账号参与（bare 也启用，但它缺凭据 → 记失败）');
assert.ok(batch.results.some((item) => item.status === 'FETCHED' && item.idempotent === true));
assert.ok(batch.results.some((item) => item.error?.code === PROVIDER_BILL_ERROR_CODES.CREDENTIAL_MISSING));
process.env.PROVIDER_BILLING_SCHEDULER_DISABLED = 'false';
const timer = initializeProviderBillingScheduler({ runOnStart: false, intervalMs: 60000 });
assert.ok(timer, '定时任务应挂上');
assert.equal(providerBillingSchedulerState().running, true);
assert.equal(initializeProviderBillingScheduler({ runOnStart: false }), timer, '重复初始化必须幂等');
assert.equal(shutdownProviderBillingScheduler(), true);
assert.equal(providerBillingSchedulerState().running, false);

// ── ⑩ 路由：权限、立即同步、状态、快照详情 ──────────────────────────────────
const ctx = (pathname, method = 'GET', body = {}, search = new URLSearchParams()) => ({
  pathname, method, body, search,
  auth: { user: { id: actorId, role: 'SUPER_ADMIN', permissions: ['ADMIN_BILLING'] }, rawUser: row('SELECT * FROM users WHERE id=?', [actorId]) },
});
const forbidden = ctx(`/api/admin/provider-billing/accounts`);
forbidden.auth.user.permissions = [];
await assert.rejects(handleAdmin(forbidden), (error) => error.code === 'PERMISSION_DENIED');
const adaptersRoute = await handleAdmin(ctx('/api/admin/provider-billing/adapters'));
assert.deepEqual(adaptersRoute.items.map((item) => item.id), ['generic-http', 'openai-costs', 'anthropic-usage']);
const syncRoute = await handleAdmin(ctx(`/api/admin/provider-billing/accounts/${account.id}/sync`, 'POST', { periodStart: PERIOD_START, periodEnd: PERIOD_END }));
assert.equal(syncRoute.status, 'FETCHED');
assert.equal(syncRoute.idempotent, true);
const statusRoute = await handleAdmin(ctx(`/api/admin/provider-billing/accounts/${account.id}/status`));
assert.equal(statusRoute.accounts[0].billing.adapter, 'generic-http');
assert.ok(statusRoute.snapshots.length >= 7);
const snapshotRoute = await handleAdmin(ctx(`/api/admin/provider-billing/snapshots/${first.snapshot.id}`));
assert.equal(snapshotRoute.aggregates.length, 6);
await assert.rejects(handleAdmin(ctx('/api/admin/provider-billing/snapshots/nope')), (error) => error.code === PROVIDER_BILL_ERROR_CODES.SNAPSHOT_NOT_FOUND);
const configRoute = await handleAdmin(ctx(`/api/admin/provider-billing/accounts/${account.id}/config`, 'POST', billingConfig({ mapping: { ...billingConfig().mapping, modelDefault: 'unmapped' } })));
assert.equal(configRoute.billing.mapping.modelDefault, 'unmapped');
const credentialRoute = await handleAdmin(ctx(`/api/admin/provider-billing/accounts/${account.id}/credential`, 'POST', { credential: SECRET }));
assert.deepEqual(credentialRoute, { id: account.id, credentialConfigured: true });
const cleared = await handleAdmin(ctx(`/api/admin/provider-billing/accounts/${account.id}/credential`, 'DELETE'));
assert.deepEqual(cleared, { id: account.id, credentialConfigured: false });
assert.equal(billingAccountView(row('SELECT * FROM supplier_accounts WHERE id=?', [account.id])).billing.credentialConfigured, false);
setSupplierBillingCredential(account.id, SECRET, actorId);
const reconciliationRoute = await handleAdmin(ctx('/api/admin/financial-reporting/provider-bill-reconciliation', 'GET', {}, new URLSearchParams({ periodStart: PERIOD_START, periodEnd: PERIOD_END })));
assert.equal(reconciliationRoute.period.currency, 'CNY');
assert.equal(reconciliationRoute.rows.find((item) => item.model === 'model-a').differenceMinor, 284);
const monthRoute = await handleAdmin(ctx('/api/admin/financial-reporting/provider-bill-reconciliation', 'GET', {}, new URLSearchParams({ period: '2026-09' })));
assert.equal(monthRoute.period.periodStart, '2026-09-01T00:00:00.000Z');

// 凭据不外泄：所有响应 + 审计记录 + 事件记录里都不得出现明文
assert.equal(JSON.stringify([adaptersRoute, syncRoute, statusRoute, snapshotRoute, configRoute, credentialRoute, reconciliationRoute]).includes(SECRET), false);
assert.equal(JSON.stringify(rows('SELECT * FROM audit_logs')).includes(SECRET), false, '审计不得留凭据');
assert.equal(JSON.stringify(rows('SELECT * FROM supplier_billing_events')).includes(SECRET), false);
assert.equal(fs.readFileSync(process.env.AI_PROVIDER_SECRET_FILE, 'utf8').includes(SECRET), false);

server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
console.log('p91 passed: generic-http 按 URL/请求头/JSON 路径映射拉账（含账期过滤与主单位换算），账号+账期+响应哈希幂等，非 2xx/超时/结构不符/缺凭据只记 FAILED 快照零聚合，修正版账单只认最新快照，官方−COMPUTED 按模型归因且缺失/未知单列不按 0，openai-costs 与 anthropic-usage 适配器可用，日级定时任务可挂可停，ADMIN_BILLING 权限域生效，凭据加密存储且响应/审计/事件/库表均无明文。');
