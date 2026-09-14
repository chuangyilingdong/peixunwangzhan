import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p88-financial-reconciliation-'));
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';

const { q } = await import('../apps/server/src/lib.js');
const { financialCallSummary, financialReconciliationReport, listFinancialCalls } = await import('../apps/server/src/services/financialReporting.js');
const { canonicalSupplierCsv, cancelSupplierMatch, createSupplierAccount, importSupplierCsv, listSupplierLines, manuallyMatchSupplierLine, setSupplierLineState } = await import('../apps/server/src/services/supplierBilling.js');
const { saveComputePricing } = await import('../apps/server/src/services/computePool.js');
const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');

const now = new Date().toISOString();
const later = new Date(Date.now() + 86400000).toISOString();
for (const [id, name] of [['org-p88-known', 'P88 Known'], ['org-p88-unknown', 'P88 Unknown'], ['org-p88-partial', 'P88 Partial'], ['org-p88-disputed', 'P88 Disputed'], ['org-p88-usd', 'P88 USD'], ['org-p88-double', 'P88 Double Guard']]) {
  q('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, name, 'ACTIVE', now, later, 0, now, now]);
}
const purchase = (id, orgId, seriesId, amount, currency, payment) => q(`INSERT INTO license_purchase_batches(id,assignment_id,org_id,series_id,purchase_type,quantity,amount_minor,currency,payment_status,status,idempotency_key,purchased_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, `assignment-${id}`, orgId, seriesId, 'PURCHASE', 1, amount, currency, payment, 'ACTIVE', `key-${id}`, now, now]);
purchase('paid-cny', 'org-p88-known', 'series-cny', 1000, 'CNY', 'PAID');
purchase('unpaid-cny', 'org-p88-known', 'series-cny', 700, 'CNY', 'UNPAID');
purchase('paid-usd', 'org-p88-known', 'series-usd', 500, 'USD', 'PAID');
purchase('paid-unknown', 'org-p88-unknown', 'series-cny', 400, 'CNY', 'PAID');
const revenue = (id, orgId, seriesId, amount, currency) => q(`INSERT INTO license_revenue_events(id,assignment_id,org_id,series_id,grant_id,event_type,quantity,amount_minor,currency,idempotency_key,occurred_at,created_at) VALUES (?,?,?,?,?,'GRANT',1,?,?,?,?,?)`, [id, `assignment-${id}`, orgId, seriesId, `grant-${id}`, amount, currency, `event-${id}`, now, now]);
revenue('revenue-cny', 'org-p88-known', 'series-cny', 800, 'CNY');
revenue('revenue-usd', 'org-p88-known', 'series-usd', 450, 'USD');
revenue('revenue-unknown', 'org-p88-unknown', 'series-cny', null, 'CNY');
const attempt = (id, requestId, amount, orgId = 'org-p88-known', internalUsageRecordId = null, { costSource = 'REPORTED', salePriceFen = null, modality = 'TEXT' } = {}) => q(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,modality,channel_id,provider,model,routed_via,status,client_request_id,response_request_id,actual_channel_id,provider_account_ref,cost_source,upstream_cost_fen,sale_price_fen,sale_snapshot,created_at,internal_usage_record_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, `call-${id}`, 1, orgId, modality, 'p88-channel', 'p88-provider', 'p88-model', 'direct', 'SUCCESS', requestId, requestId, 'p88-channel', 'p88-account', costSource, amount, salePriceFen, '{}', now, internalUsageRecordId]);
attempt('attempt-active', 'request-active', 300);
attempt('attempt-cancelled', 'request-cancelled', 200);
const account = createSupplierAccount({ code: 'p88-account', name: 'P88 Supplier', provider: 'p88-provider', channelId: 'p88-channel', defaultCurrency: 'CNY', timezone: 'UTC' });
const supplierLine = (lineId, requestId, amount, currency = 'CNY') => ({ schema_version: 'v1', provider: 'p88-provider', provider_account_id: 'p88-account', invoice_id: 'p88-invoice', line_id: lineId, line_type: 'USAGE', occurred_at: now, currency, amount_minor: String(amount), original_line_id: '', usage_id: '', response_payload_id: '', response_request_id: '', request_id: requestId, task_id: '', gateway_id: '', description: '' });
importSupplierCsv({ supplierAccountId: account.id, fileName: 'p88.csv', csv: canonicalSupplierCsv([supplierLine('active-line', 'request-active', 300), supplierLine('cancelled-line', 'request-cancelled', 200)]) });
const cancelled = listSupplierLines({ supplierAccountId: account.id }).items.find((line) => line.lineId === 'cancelled-line');
cancelSupplierMatch(cancelled.matches[0].id, { reason: 'P88 cancelled evidence' });

for (const [id, orgId, currency, revenueAmount] of [
  ['partial', 'org-p88-partial', 'CNY', 600],
  ['disputed', 'org-p88-disputed', 'CNY', 700],
  ['usd', 'org-p88-usd', 'USD', 900],
  ['double', 'org-p88-double', 'CNY', 500],
]) {
  purchase(`edge-paid-${id}`, orgId, `series-${id}`, revenueAmount + 100, currency, 'PAID');
  revenue(`edge-revenue-${id}`, orgId, `series-${id}`, revenueAmount, currency);
}
attempt('attempt-partial', 'request-partial', 200, 'org-p88-partial');
attempt('attempt-disputed', 'request-disputed', 250, 'org-p88-disputed');
attempt('attempt-usd', 'request-usd', 300, 'org-p88-usd');
q("INSERT INTO usage_records(id,org_id,user_id,modality,model,credits_charged,status,pricing_snapshot,cost_fen,series_id,compute_call_id,created_at) VALUES ('usage-double-linked','org-p88-double','student-double','TEXT','p88-model',0,'SUCCESS','{}',0,'series-double','call-attempt-double',?)", [now]);
q("INSERT INTO usage_records(id,org_id,user_id,modality,model,credits_charged,status,pricing_snapshot,cost_fen,series_id,compute_call_id,created_at) VALUES ('usage-double-extra','org-p88-double','student-double','TEXT','p88-model',0,'SUCCESS','{}',0,'series-double','call-attempt-double',?)", [now]);
attempt('attempt-double', 'request-double', 100, 'org-p88-double', 'usage-double-linked');
importSupplierCsv({ supplierAccountId: account.id, fileName: 'p88-edge.csv', csv: canonicalSupplierCsv([
  supplierLine('partial-line', 'request-partial', 300),
  supplierLine('disputed-line', 'request-disputed', 250),
  supplierLine('usd-line', 'request-usd', 300, 'USD'),
  supplierLine('double-line', 'request-double', 100),
]) });
const edgeLines = listSupplierLines({ supplierAccountId: account.id }).items;
const partialLine = edgeLines.find((line) => line.lineId === 'partial-line');
manuallyMatchSupplierLine(partialLine.id, [{ targetType: 'ATTEMPT', targetId: 'attempt-partial', amountMinor: 150 }], { reason: 'P88 partial allocation' });
const disputedLine = edgeLines.find((line) => line.lineId === 'disputed-line');
setSupplierLineState(disputedLine.id, 'dispute', { reason: 'P88 disputed evidence' });

const known = financialReconciliationReport({ days: 1, orgId: 'org-p88-known', currency: 'CNY' });
assert.equal(known.summary.cashReceivedMinor, 1000, 'only PAID purchases are cash received');
assert.equal(known.summary.recognizedRevenueMinor, 800);
assert.equal(known.summary.settledCostMinor, 300, 'only active supplier matches are settled cost');
assert.equal(known.summary.grossProfitMinor, 500);
const partialReport = financialReconciliationReport({ days: 1, orgId: 'org-p88-partial', currency: 'CNY' });
assert.equal(partialReport.summary.settledCostMinor, 150, 'partial allocation remains visible as settled amount');
assert.equal(partialReport.summary.grossProfitMinor, null, 'partial supplier row makes real margin unknown');
assert.equal(partialReport.summary.unreconciledMinor, 150, 'partial remainder is pending exposure');
const disputedReport = financialReconciliationReport({ days: 1, orgId: 'org-p88-disputed', currency: 'CNY' });
assert.equal(disputedReport.summary.grossProfitMinor, null, 'disputed supplier row makes real margin unknown');
const usdReport = financialReconciliationReport({ days: 1, orgId: 'org-p88-usd', currency: 'USD' });
assert.equal(usdReport.summary.grossProfitMinor, 600, 'known same-currency USD supports nominal margin');
const doubleReport = financialReconciliationReport({ days: 1, orgId: 'org-p88-double', currency: 'CNY' });
assert.equal(doubleReport.summary.settledCostMinor, 100, 'multiple usage rows sharing call_id must not duplicate one match');
assert.equal(doubleReport.summary.grossProfitMinor, 400);
const unknown = financialReconciliationReport({ days: 1, orgId: 'org-p88-unknown', currency: 'CNY' });
assert.equal(unknown.rows[0].recognizedRevenueMinor, null, 'unknown revenue must stay unknown');
assert.equal(unknown.summary.recognizedRevenueMinor, null, 'unknown revenue must not become zero');
assert.equal(unknown.summary.grossProfitMinor, null);
const multiCurrency = financialReconciliationReport({ days: 1, orgId: 'org-p88-known' });
assert.deepEqual(new Set(multiCurrency.currencies), new Set(['CNY', 'USD']));
assert.equal(multiCurrency.summary.currency, null);
assert.equal(multiCurrency.summary.grossProfitMinor, null, 'multi-currency summary must not calculate margin');

// —— 调用账三档金额（对外售价 / 上游估算或报告 / 实际核销）与模态渠道汇总一致性 ——
saveComputePricing({ perCall: { TEXT: 7 } });
q('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', ['org-p88-ledger', 'P88 Ledger', 'ACTIVE', now, later, 0, now, now]);
attempt('ledger-snapshot', 'request-ledger-snapshot', 200, 'org-p88-ledger', null, { salePriceFen: 500 });
attempt('ledger-fallback', 'request-ledger-fallback', 40, 'org-p88-ledger', null, { costSource: 'ESTIMATED' });
attempt('ledger-deficit', 'request-ledger-deficit', 60, 'org-p88-ledger', null, { costSource: 'ESTIMATED' });
attempt('ledger-unknownsale', 'request-ledger-unknownsale', null, 'org-p88-ledger', null, { costSource: 'UNKNOWN', modality: 'EMBEDDING' });
importSupplierCsv({ supplierAccountId: account.id, fileName: 'p88-ledger.csv', csv: canonicalSupplierCsv([
  supplierLine('ledger-snapshot-line', 'request-ledger-snapshot', 200),
  supplierLine('ledger-deficit-line', 'request-ledger-deficit', 50),
]) });
const ledgerCalls = listFinancialCalls({ days: 1, orgId: 'org-p88-ledger', limit: 100 }).items;
const byId = (id) => ledgerCalls.find((item) => item.id === id);
const snapshotCall = byId('ledger-snapshot');
assert.equal(snapshotCall.salePriceFen, 500, '对外售价优先取本次落库快照');
assert.equal(snapshotCall.salePriceSource, 'SNAPSHOT');
assert.equal(snapshotCall.estimatedOrReportedMinor, 200, '上游估算或报告金额照旧返回');
assert.equal(snapshotCall.settledAmountMinor, 200, '实际核销来自有效供应商标记');
assert.equal(snapshotCall.differenceMinor, 300, '差额 = 对外售价 − 实际核销');
const fallbackCall = byId('ledger-fallback');
assert.equal(fallbackCall.salePriceFen, 7, '无快照时回退当前 compute_pricing 配置');
assert.equal(fallbackCall.salePriceSource, 'PRICING', '回退必须标注来源');
assert.equal(fallbackCall.settledAmountMinor, null);
assert.equal(fallbackCall.differenceMinor, null, '未核销不得显示差额为正利润');
assert.equal(byId('ledger-deficit').differenceMinor, -43, '已核销的负差额照实显示');
const unknownSaleCall = byId('ledger-unknownsale');
assert.equal(unknownSaleCall.salePriceFen, null, '未配置价的模态不按 0 处理');
assert.equal(unknownSaleCall.salePriceSource, 'UNKNOWN');
assert.equal(unknownSaleCall.differenceMinor, null, '对外售价未知时差额留空');

const callSummary = financialCallSummary({ days: 1, orgId: 'org-p88-ledger' });
assert.equal(callSummary.totals.calls, 4);
const modelGroup = callSummary.groups.model.find((group) => group.key === 'p88-model');
assert.equal(modelGroup.externalAmountMinor, 514, '对外金额只累加已知对外价，未知单列');
assert.equal(modelGroup.saleUnknownCount, 1);
assert.equal(modelGroup.knownUpstreamCostMinor, 300, '已知上游成本不含未知');
assert.equal(modelGroup.upstreamUnknownCount, 1);
assert.equal(modelGroup.settledAmountMinor, 250);
assert.equal(modelGroup.unsettledCount, 2);
assert.equal(modelGroup.differenceMinor, null, '存在未核销或未知对外价时汇总差额留空');
const modalityGroups = callSummary.groups.modality;
assert.equal(modalityGroups.find((group) => group.key === 'EMBEDDING').saleUnknownCount, 1, '未知对外价按模态单列');
assert.equal(modalityGroups.find((group) => group.key === 'TEXT').settledAmountMinor, 250);
for (const dimension of ['modality', 'channel', 'model', 'org', 'student']) {
  const sum = (field) => callSummary.groups[dimension].reduce((total, group) => total + group[field], 0);
  assert.equal(sum('calls'), callSummary.totals.calls, `${dimension} 汇总调用次数必须与总数一致`);
  assert.equal(sum('externalAmountMinor'), callSummary.totals.externalAmountMinor, `${dimension} 汇总对外金额加总必须一致`);
  assert.equal(sum('settledAmountMinor'), callSummary.totals.settledAmountMinor, `${dimension} 汇总实际核销加总必须一致`);
  assert.equal(sum('unsettledCount'), callSummary.totals.unsettledCount, `${dimension} 未核销笔数加总必须一致`);
}

const billingAuth = { user: { id: 'billing-admin', login: 'billing-admin', role: 'SUPER_ADMIN', permissions: ['ADMIN_BILLING'] }, rawUser: { permissions: '["ADMIN_BILLING"]' } };
const ctx = (auth) => ({ pathname: '/api/admin/financial-reporting/summary', method: 'GET', search: new URLSearchParams('days=1&currency=CNY'), body: {}, auth, req: { socket: { remoteAddress: '127.0.0.1' } } });
assert.equal((await handleAdmin(ctx(billingAuth))).summary.cashReceivedMinor, 3500);
assert.ok((await handleAdmin({ ...ctx(billingAuth), pathname: '/api/admin/financial-reporting/call-summary' })).totals.calls > 0, 'call-summary route must aggregate three-tier amounts');
await assert.rejects(() => handleAdmin(ctx({ ...billingAuth, user: { ...billingAuth.user, permissions: ['ADMIN_CONTENT'] } })), (error) => error.code === 'PERMISSION_DENIED');
await assert.rejects(() => handleAdmin(ctx({ ...billingAuth, user: { ...billingAuth.user, role: 'ORG_ADMIN' } })), (error) => error.code === 'FORBIDDEN' || error.status === 403);

const financialSource = fs.readFileSync(path.join(root, 'apps/admin/src/components/FinancialReconciliation.jsx'), 'utf8');
const modelSource = fs.readFileSync(path.join(root, 'apps/admin/src/pages/ModelCompute.jsx'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'apps/server/src/routes/adminOrg.js'), 'utf8');
assert.doesNotMatch(financialSource, /window\.prompt|\bprompt\s*\(/);
assert.match(financialSource, /<dialog[\s\S]*<form onSubmit=\{submit\}>[\s\S]*<textarea[^>]*required/);
assert.match(financialSource, /const title = action\.kind === 'cancel-match' \? '取消匹配'/, 'dialog heading must be non-empty');
assert.match(financialSource, /catch \(failure\) \{ setError\([\s\S]*setBusy\(false\); \}/, 'API failure must retain dialog state and reason');
assert.match(financialSource, /setActionDialog\(\{ kind: 'cancel-match', line, match \}\)/);
assert.match(financialSource, /imports\/preview[\s\S]*严格校验并预览[\s\S]*确认导入/);
assert.match(financialSource, /lines\/\$\{line\.id\}\/candidates[\s\S]*type="checkbox"[\s\S]*确认人工匹配/);
assert.match(financialSource, /financial-reporting\/call-summary/, '调用账必须接入三档金额汇总接口');
assert.match(financialSource, /对外售价与上游成本对照汇总/, '调用账必须有汇总区块');
assert.match(financialSource, /对外售价不扣学生|不扣学生、不计收入/, '界面必须写明对外售价不扣学生不计收入');
assert.match(financialSource, /未核销 \/ 未知/, '未核销时差额不得显示为正利润');
assert.match(modelSource, /<FinancialReconciliation api=\{api\} view=\{view\}/);
assert.match(adminSource, /handleFinancialReporting/);

const ssrRoot = path.join(root, '.tmp');
fs.mkdirSync(ssrRoot, { recursive: true });
const ssrTemp = fs.mkdtempSync(path.join(ssrRoot, 'p88-ssr-'));
const entry = path.join(ssrTemp, 'entry.jsx');
fs.writeFileSync(entry, `
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ModelCompute } from ${JSON.stringify(path.join(root, 'apps/admin/src/pages/ModelCompute.jsx').split(path.sep).join('/'))};
const api = { get: () => new Promise(() => {}), post: () => Promise.resolve({}) };
for (const view of ['calls','bills','matching','margin']) {
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/compute/usage?view='+view]}><Routes><Route path="/compute/usage" element={<ModelCompute api={api} />} /></Routes></MemoryRouter>);
  for (const tab of ['调用账','供应商账单','匹配与核销','三账与毛利']) if (!html.includes(tab)) throw new Error(view+' missing tab '+tab);
  const expected = { calls: '正在读取调用账', bills: '导入供应商账单', matching: '正在读取核销记录', margin: '正在计算三账对照' }[view];
  if (!html.includes(expected)) throw new Error(view+' did not render '+expected);
}
console.log('P88 four-view SSR passed');
`);
const outDir = path.join(ssrTemp, 'out');
await build({ root, configFile: path.join(root, 'apps/admin/vite.config.mjs'), logLevel: 'error', ssr: { noExternal: true }, build: { ssr: entry, outDir, emptyOutDir: true, minify: false } });
const bundle = fs.readdirSync(outDir).find((name) => /\.(?:m?js)$/.test(name));
assert.ok(bundle, 'P88 SSR bundle missing');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(outDir, bundle)], { cwd: root, stdio: 'inherit' });
  child.on('close', (code) => code ? reject(new Error(`P88 SSR exited ${code}`)) : resolve());
});
fs.rmSync(ssrTemp, { recursive: true, force: true });
console.log('P88 passed: real three-ledger summary, unknown/multi-currency rules, PAID revenue basis, active supplier cost, four-view SSR, CSV/candidate interactions, native reason dialog, billing permission, and admin routing.');
