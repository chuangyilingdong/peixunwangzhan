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

const { q, aq } = await import('../apps/server/src/lib.js');
const { financialCallSummary, financialReconciliationReport, listFinancialCalls } = await import('../apps/server/src/services/financialReporting.js');
// 2026-09-18：供应商账单两条线整体下线（用户口径），相关断言随之下线 —— 这是口径变更，不是测试漂移。
const { saveComputePricing } = await import('../apps/server/src/services/computePool.js');
const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');

const now = new Date().toISOString();
const later = new Date(Date.now() + 86400000).toISOString();
for (const [id, name] of [['org-p88-known', 'P88 Known'], ['org-p88-unknown', 'P88 Unknown'], ['org-p88-partial', 'P88 Partial'], ['org-p88-disputed', 'P88 Disputed'], ['org-p88-usd', 'P88 USD'], ['org-p88-double', 'P88 Double Guard']]) {
  await aq('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, name, 'ACTIVE', now, later, 0, now, now]);
}
const purchase = async (id, orgId, seriesId, amount, currency, payment) => await aq(`INSERT INTO license_purchase_batches(id,assignment_id,org_id,series_id,purchase_type,quantity,amount_minor,currency,payment_status,status,idempotency_key,purchased_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, `assignment-${id}`, orgId, seriesId, 'PURCHASE', 1, amount, currency, payment, 'ACTIVE', `key-${id}`, now, now]);
await purchase('paid-cny', 'org-p88-known', 'series-cny', 1000, 'CNY', 'PAID');
await purchase('unpaid-cny', 'org-p88-known', 'series-cny', 700, 'CNY', 'UNPAID');
await purchase('paid-usd', 'org-p88-known', 'series-usd', 500, 'USD', 'PAID');
await purchase('paid-unknown', 'org-p88-unknown', 'series-cny', 400, 'CNY', 'PAID');
const revenue = async (id, orgId, seriesId, amount, currency) => await aq(`INSERT INTO license_revenue_events(id,assignment_id,org_id,series_id,grant_id,event_type,quantity,amount_minor,currency,idempotency_key,occurred_at,created_at) VALUES (?,?,?,?,?,'GRANT',1,?,?,?,?,?)`, [id, `assignment-${id}`, orgId, seriesId, `grant-${id}`, amount, currency, `event-${id}`, now, now]);
await revenue('revenue-cny', 'org-p88-known', 'series-cny', 800, 'CNY');
await revenue('revenue-usd', 'org-p88-known', 'series-usd', 450, 'USD');
await revenue('revenue-unknown', 'org-p88-unknown', 'series-cny', null, 'CNY');
const attempt = async (id, requestId, amount, orgId = 'org-p88-known', internalUsageRecordId = null, { costSource = 'REPORTED', salePriceFen = null, modality = 'TEXT' } = {}) => await aq(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,modality,channel_id,provider,model,routed_via,status,client_request_id,response_request_id,actual_channel_id,provider_account_ref,cost_source,upstream_cost_fen,sale_price_fen,sale_snapshot,created_at,internal_usage_record_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, `call-${id}`, 1, orgId, modality, 'p88-channel', 'p88-provider', 'p88-model', 'direct', 'SUCCESS', requestId, requestId, 'p88-channel', 'p88-account', costSource, amount, salePriceFen, '{}', now, internalUsageRecordId]);
await attempt('attempt-active', 'request-active', 300);
await attempt('attempt-cancelled', 'request-cancelled', 200);
// 2026-09-18：供应商账单两条线整体下线（用户口径），相关断言随之下线 —— 这是口径变更，不是测试漂移。
// 原先这里用供应商账单服务造「账单行」，再做自动/人工匹配与取消匹配，
// 这些夹具与随之而来的 CSV 已核销金额断言一并删除；上游逐笔实扣金额改用 compute_attempts 的夹具表达。

for (const [id, orgId, currency, revenueAmount] of [
  ['partial', 'org-p88-partial', 'CNY', 600],
  ['disputed', 'org-p88-disputed', 'CNY', 700],
  ['usd', 'org-p88-usd', 'USD', 900],
  ['double', 'org-p88-double', 'CNY', 500],
]) {
  await purchase(`edge-paid-${id}`, orgId, `series-${id}`, revenueAmount + 100, currency, 'PAID');
  await revenue(`edge-revenue-${id}`, orgId, `series-${id}`, revenueAmount, currency);
}
await attempt('attempt-partial', 'request-partial', 200, 'org-p88-partial');
await attempt('attempt-disputed', 'request-disputed', 250, 'org-p88-disputed');
await attempt('attempt-usd', 'request-usd', 300, 'org-p88-usd');
await aq("INSERT INTO usage_records(id,org_id,user_id,modality,model,credits_charged,status,pricing_snapshot,cost_fen,series_id,compute_call_id,created_at) VALUES ('usage-double-linked','org-p88-double','student-double','TEXT','p88-model',0,'SUCCESS','{}',0,'series-double','call-attempt-double',?)", [now]);
await aq("INSERT INTO usage_records(id,org_id,user_id,modality,model,credits_charged,status,pricing_snapshot,cost_fen,series_id,compute_call_id,created_at) VALUES ('usage-double-extra','org-p88-double','student-double','TEXT','p88-model',0,'SUCCESS','{}',0,'series-double','call-attempt-double',?)", [now]);
await attempt('attempt-double', 'request-double', 100, 'org-p88-double', 'usage-double-linked');
// 2026-09-18：供应商账单两条线整体下线（用户口径），相关断言随之下线 —— 这是口径变更，不是测试漂移。
// 原先这里导入第二份「供应商账单」并做部分匹配（150 分）+ 标记争议，用来验证「部分核销 / 争议行让真实毛利未知」；
// 随 CSV 已核销口径一起删除。

const known = await financialReconciliationReport({ days: 1, orgId: 'org-p88-known', currency: 'CNY' });
assert.equal(known.summary.cashReceivedMinor, 1000, 'only PAID purchases are cash received');
assert.equal(known.summary.recognizedRevenueMinor, 800);
// 2026-09-18：settledCostMinor / grossProfitMinor / unreconciledMinor 与「USD 名义毛利、同一 call_id 不重复核销」
// 这几条都建立在供应商账单匹配之上，随供应商账单下线一并删除（用户口径）。
const unknown = await financialReconciliationReport({ days: 1, orgId: 'org-p88-unknown', currency: 'CNY' });
assert.equal(unknown.rows[0].recognizedRevenueMinor, null, 'unknown revenue must stay unknown');
assert.equal(unknown.summary.recognizedRevenueMinor, null, 'unknown revenue must not become zero');
assert.equal(unknown.summary.grossProfitMinor, null);
const multiCurrency = await financialReconciliationReport({ days: 1, orgId: 'org-p88-known' });
assert.deepEqual(new Set(multiCurrency.currencies), new Set(['CNY', 'USD']));
assert.equal(multiCurrency.summary.currency, null);
assert.equal(multiCurrency.summary.grossProfitMinor, null, 'multi-currency summary must not calculate margin');

// —— 调用账三档金额（对外售价 / 上游估算或报告 / 实际核销）与模态渠道汇总一致性 ——
await saveComputePricing({ perCall: { TEXT: 7 } });
await aq('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', ['org-p88-ledger', 'P88 Ledger', 'ACTIVE', now, later, 0, now, now]);
await attempt('ledger-snapshot', 'request-ledger-snapshot', 200, 'org-p88-ledger', null, { salePriceFen: 500 });
await attempt('ledger-fallback', 'request-ledger-fallback', 40, 'org-p88-ledger', null, { costSource: 'ESTIMATED' });
await attempt('ledger-deficit', 'request-ledger-deficit', 60, 'org-p88-ledger', null, { costSource: 'ESTIMATED' });
await attempt('ledger-unknownsale', 'request-ledger-unknownsale', null, 'org-p88-ledger', null, { costSource: 'UNKNOWN', modality: 'EMBEDDING' });
// 只读透出用量证据与价目层级来源：原样写库，服务不改口径、不重算。
await aq("UPDATE compute_attempts SET usage_snapshot=?,cost_rule_snapshot=? WHERE id='ledger-snapshot'", [
  JSON.stringify({ modality: 'TEXT', evidence: 'UPSTREAM_USAGE', inputTokens: 800, outputTokens: 333, images: null, seconds: null, resolution: null, audio: null }),
  JSON.stringify({ basis: 'CONTRACT_UNIT_PRICE', provider: 'p88-provider', channelId: 'p88-channel', model: 'p88-model', estimatedCostFen: null, source: 'COMPUTED', priceLevel: 'MODEL', unitPrice: { perImageFen: 200 }, usage: { images: 2 }, computedFen: 400, capturedAt: now }),
]);
// 2026-09-18：供应商账单两条线整体下线（用户口径），相关断言随之下线 —— 这是口径变更，不是测试漂移。
// 原先这里导入一份「供应商账单」把 ledger-snapshot（200 分）与 ledger-deficit（50 分）核销掉，
// 用来验证「实际核销金额 / 差额 = 对外售价 − 实际核销」；随 CSV 已核销口径一起删除。
const ledgerCalls = (await listFinancialCalls({ days: 1, orgId: 'org-p88-ledger', limit: 100 })).items;
const byId = (id) => ledgerCalls.find((item) => item.id === id);
const snapshotCall = byId('ledger-snapshot');
assert.equal(snapshotCall.salePriceFen, 500, '对外售价优先取本次落库快照');
assert.equal(snapshotCall.salePriceSource, 'SNAPSHOT');
assert.equal(snapshotCall.estimatedOrReportedMinor, 200, '上游估算或报告金额照旧返回');
const fallbackCall = byId('ledger-fallback');
assert.equal(fallbackCall.salePriceFen, 7, '无快照时回退当前 compute_pricing 配置');
assert.equal(fallbackCall.salePriceSource, 'PRICING', '回退必须标注来源');
// 2026-09-18 口径变更（两账，不是测试漂移）：差额 = 对外售价 − **上游成本**，两侧都算得出就给 ——
// 这里上游成本 ESTIMATED(40 分) 是**已知**成本，所以差额 = 7 − 40 = −33，亏损必须显出来（不再是 null）。
// 字段名沿用：settledAmountMinor 现在就是上游成本、settledCurrency 现在是上游成本账的币种。
assert.equal(fallbackCall.settledAmountMinor, 40, 'settledAmountMinor 字段名沿用，语义 = 上游成本');
assert.equal(fallbackCall.settledCurrency, 'CNY', 'settledCurrency 字段名沿用，语义 = 上游成本账币种');
assert.equal(fallbackCall.differenceMinor, -33, '已知上游成本时必须给出差额（可为负）');
assert.deepEqual(fallbackCall.matches, [], '供应商账单匹配已下线，matches 恒为空数组（形状不变）');
const unknownSaleCall = byId('ledger-unknownsale');
assert.equal(unknownSaleCall.salePriceFen, null, '未配置价的模态不按 0 处理');
assert.equal(unknownSaleCall.salePriceSource, 'UNKNOWN');
assert.equal(unknownSaleCall.differenceMinor, null, '对外售价未知时差额留空');
// 2026-09-18 口径变更（两账）：对外价**已知**、上游成本**未知**时，差额同样必须留空 ——
// 未知既不能当 0 参与差额，更不能把「成本未知」显示成正利润。这是原「未核销不算差额」规则的等价延续。
await attempt('ledger-unknowncost', 'request-unknowncost', null, 'org-p88-usd', null, { costSource: 'UNKNOWN', salePriceFen: 500 });
const unknownCostCall = (await listFinancialCalls({ days: 1, orgId: 'org-p88-usd', limit: 100 })).items.find((item) => item.id === 'ledger-unknowncost');
assert.equal(unknownCostCall.salePriceFen, 500, '该用例的对外价是已知快照价');
assert.equal(unknownCostCall.costUnknown, true);
assert.equal(unknownCostCall.settledAmountMinor, null, '成本未知不得当成 0');
assert.equal(unknownCostCall.differenceMinor, null, '成本未知时差额留空（不得显示成正利润）');
// 用量证据与价目层级只读透出：有快照照原样返回，无快照为 null（字段必须存在）。
assert.equal(snapshotCall.usageSnapshot.inputTokens, 800, 'usage_snapshot 必须原样透出');
assert.equal(snapshotCall.costRuleSnapshot.priceLevel, 'MODEL', '价目层级沿用上游字段名 priceLevel');
assert.equal(snapshotCall.costRuleSnapshot.source, 'COMPUTED', '来源沿用上游字段名 source');
assert.ok('usageSnapshot' in fallbackCall && fallbackCall.usageSnapshot === null, '无用量证据时 usageSnapshot 必须存在且为 null');
assert.ok('costRuleSnapshot' in fallbackCall && fallbackCall.costRuleSnapshot === null, '无价目快照时 costRuleSnapshot 必须存在且为 null');

const callSummary = await financialCallSummary({ days: 1, orgId: 'org-p88-ledger' });
assert.equal(callSummary.totals.calls, 4);
const modelGroup = callSummary.groups.model.find((group) => group.key === 'p88-model');
assert.equal(modelGroup.externalAmountMinor, 514, '对外金额只累加已知对外价，未知单列');
assert.equal(modelGroup.saleUnknownCount, 1);
assert.equal(modelGroup.knownUpstreamCostMinor, 300, '已知上游成本不含未知');
assert.equal(modelGroup.upstreamUnknownCount, 1);
// 2026-09-18：settledAmountMinor / unsettledCount 是「CSV 已核销」口径的产物，随供应商账单下线删除；
// 下面「未核销时差额必须留空」与各维度加总一致性两条是口径规则，保留。
assert.equal(modelGroup.differenceMinor, null, '存在未核销或未知对外价时汇总差额留空');
const modalityGroups = callSummary.groups.modality;
assert.equal(modalityGroups.find((group) => group.key === 'EMBEDDING').saleUnknownCount, 1, '未知对外价按模态单列');
for (const dimension of ['modality', 'channel', 'model', 'org', 'student']) {
  const sum = (field) => callSummary.groups[dimension].reduce((total, group) => total + group[field], 0);
  assert.equal(sum('calls'), callSummary.totals.calls, `${dimension} 汇总调用次数必须与总数一致`);
  assert.equal(sum('externalAmountMinor'), callSummary.totals.externalAmountMinor, `${dimension} 汇总对外金额加总必须一致`);
  assert.equal(sum('settledAmountMinor'), callSummary.totals.settledAmountMinor, `${dimension} 汇总实际核销加总必须一致`);
  assert.equal(sum('unsettledCount'), callSummary.totals.unsettledCount, `${dimension} 未核销笔数加总必须一致`);
}

// —— P90 合同单价两层契约：界面写出的形状必须被后端原样接受（拍平＝静默丢弃）——
const { computeContractCost, contractCostRuleSnapshot, normalizeModelUnitPrices, resolveUnitPrice, validateModelUnitPrices } = await import('../apps/server/src/services/upstreamCost.js');
const uiUpstreamPrices = { IMAGE: { perImageFen: 50, byResolution: { '1K': 40 } } };
const uiModelUnitPrices = { 'p88-model': { IMAGE: { perImageFen: 30, byResolution: { '1K': 25 } }, TEXT: { inputFenPer1MTokens: 250, outputFenPer1MTokens: 750 } } };
assert.deepEqual(validateModelUnitPrices(uiModelUnitPrices), [], '界面写出的模型级覆盖必须能通过后端校验');
assert.deepEqual(normalizeModelUnitPrices(uiModelUnitPrices), uiModelUnitPrices, '模型级覆盖必须按 {模型:{素材类型:{…}}} 原样保留');
assert.deepEqual(normalizeModelUnitPrices({ 'p88-model': { perImageFen: 30 } }), null, '拍平的模型级覆盖会被丢弃 —— 界面绝不能这么写');
assert.deepEqual(normalizeModelUnitPrices({ 'p88-model': { NOT_A_MODALITY: { perImageFen: 30 } } }), null, '未知素材类型同样被丢弃');
const modelWins = resolveUnitPrice({ unitPrices: uiUpstreamPrices, modelUnitPrices: uiModelUnitPrices, model: 'p88-model', modality: 'IMAGE' });
assert.equal(modelWins.price.perImageFen, 30, '模型级覆盖优先于素材类型价');
assert.equal(modelWins.price.byResolution['1K'], 25);
assert.equal(modelWins.modelPrice.perImageFen, 30, '两层各自的原始价都要带出来（快照要按层留证）');
const modelCost = computeContractCost({ modality: 'IMAGE', model: 'p88-model', unitPrices: uiUpstreamPrices, modelUnitPrices: uiModelUnitPrices, usage: { images: 2, resolution: '1K' } });
assert.equal(modelCost.fen, 50, '模型级档位价折算：2 张 × 25 分');
assert.equal(modelCost.level, 'MODEL');
const modalityCost = computeContractCost({ modality: 'IMAGE', model: 'p88-model', unitPrices: uiUpstreamPrices, modelUnitPrices: null, usage: { images: 2, resolution: '1K' } });
assert.equal(modalityCost.fen, 80, '素材类型价折算：2 张 × 40 分档位价');
assert.equal(contractCostRuleSnapshot({ provider: 'custom', channelId: 'c', model: 'p88-model', computed: modelCost }).priceLevel, 'MODEL', '快照必须标出命中的层级（界面按它显示 模型级覆盖 / 素材类型价）');
assert.equal(contractCostRuleSnapshot({ provider: 'custom', channelId: 'c', model: 'p88-model', computed: modalityCost }).priceLevel, 'MODALITY');
assert.equal(computeContractCost({ modality: 'IMAGE', model: 'p88-model', unitPrices: null, modelUnitPrices: null, usage: { images: 2, resolution: '1K' } }), null, '两层都没配 → null（UNKNOWN），绝不按 0');
assert.equal(resolveUnitPrice({ unitPrices: uiUpstreamPrices, modelUnitPrices: { 'other-model': { IMAGE: { perImageFen: 10 } } }, model: 'p88-model', modality: 'IMAGE' }).price.perImageFen, 50, '别的模型的覆盖不能套到本模型上');
assert.equal(resolveUnitPrice({ unitPrices: null, modelUnitPrices: uiModelUnitPrices, model: 'p88-model', modality: 'TEXT' }).price.inputFenPer1MTokens, 250, '模型级覆盖在没有素材类型价时也生效');
assert.equal(resolveUnitPrice({ unitPrices: uiUpstreamPrices, modelUnitPrices: null, model: 'p88-model', modality: 'TEXT' }), null, '两层都没有这个素材类型 → null（UNKNOWN），不按 0');

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
// 2026-09-18：供应商账单两条线整体下线（用户口径），相关断言随之下线 —— 这是口径变更，不是测试漂移。
// 原先这里断言「CSV 导入预览 / 人工匹配候选 / 取消匹配理由弹窗」那一套界面（imports/preview、lines/:id/candidates、
// cancel-match dialog），随 CSV 手工导入下线一并删除。
assert.match(financialSource, /financial-reporting\/call-summary/, '调用账必须接入三档金额汇总接口');
assert.match(financialSource, /对外售价与上游成本对照汇总/, '调用账必须有汇总区块');
assert.match(financialSource, /对外售价不扣学生|不扣学生、不计收入/, '界面必须写明对外售价不扣学生不计收入');
// 2026-09-18 口径变更（两账，不是测试漂移）：第二本账的数据源换成 compute_attempts.upstream_cost_fen 之后，
// 那本账就叫**上游成本**，「未结算」这套已经不存在的动作词统一改成「成本未知」；
// 差额为空的原因只有两种（成本未知 / 对外价未知），文案如实写。
// 断言意图不变：成本未知或对外价未知时差额不得显示成正利润。
assert.match(financialSource, /成本未知 \/ 未知/, '成本未知时差额不得显示为正利润');
// —— P90 界面接入：上游成本列（来源 + 用量证据）与合同单价两层编辑器 ——
// 2026-09-18 口径变更：原「上游计费（来源 / 用量证据）」与「已结算」两列现在是同一个数
// （后端 settledAmountMinor 恒等于 knownUpstreamCostMinor），已合并成一列「上游成本（来源 / 用量证据）」。
assert.match(financialSource, /上游成本（来源 \/ 用量证据）/, '调用账必须把「估算或报告」列换成「上游成本」列');
assert.doesNotMatch(financialSource, /估算或报告（上游成本）/, '旧的「估算或报告」列必须被替换');
assert.doesNotMatch(financialSource, /<th>已结算<\/th>/, '「已结算」列与上游成本同值，必须合并掉、不许并排显示两个一样的数');
for (const label of ['COMPUTED 按合同价折算', 'REPORTED 上游报告', 'ESTIMATED 配置估算', 'UNKNOWN 未知', 'MOCK 本地模拟']) {
  assert.ok(financialSource.includes(label), `上游成本来源必须标注 ${label}`);
}
assert.match(financialSource, /usageEvidenceText\(item\.usageSnapshot\)/, '调用账必须展示用量证据');
assert.match(financialSource, /tokens 输入/, '用量证据必须展示 tokens');
assert.match(financialSource, /\$\{usage\.images\} 张/, '用量证据必须展示张数');
assert.match(financialSource, /\$\{usage\.seconds\} 秒/, '用量证据必须展示秒数');
assert.match(financialSource, /分辨率 \$\{usage\.resolution\}/, '用量证据必须展示分辨率');
assert.match(financialSource, /不等于供应商最终账单/, '必须写明合同价折算≠供应商最终账单');
assert.match(financialSource, /价目层级/, '两层价目（模型级 / 素材类型）必须按 priceLevel 标注');
// 2026-09-18：供应商账单两条线整体下线（用户口径），相关断言随之下线 —— 这是口径变更，不是测试漂移。
// 原先这里断言「官方账单自动对账区块」：账单接口的适配器/端点/凭据/立即同步四个接口、
// 官方账单对账结果接口、同步状态与快照列表，以及官方账单对账表各列（含 CSV 已核销）。整套已下线。
assert.match(financialSource, /缺失单列、不按 0|不按 0 参与计算|绝不按 0 计/, '必须写明缺失 / 未知不按 0');
const billingPanelSource = fs.readFileSync(path.join(root, 'apps/admin/src/components/BillingPanels.jsx'), 'utf8');
// 2026-09-18：合同单价编辑器从「渠道卡里默认展开的一大块」搬进了「② 价目表」（一行 = 渠道 × 模型），
// 断言随界面的新落点改写 —— 这是口径变更/界面重排，不是测试漂移。断言的意图一条没少：
// 成本价与对外价并排、分模态计价单位、两层契约写回键名、模型级留空回落、优先级、错误回显、按渠道分组。
assert.match(billingPanelSource, /成本价（与上游合同价 · 用于自动折算实际计费）/, '价目表必须有成本价一列（与上游的合同价）');
for (const field of ['inputFenPer1MTokens', 'outputFenPer1MTokens', 'perImageFen', 'perSecondFen', 'audioExtraPerSecondFen', 'perCallFen', 'byResolution']) {
  assert.ok(billingPanelSource.includes(field), `合同单价的字段名必须与后端 upstreamCost 一致：${field}`);
}
assert.match(billingPanelSource, /upstreamUnitPrices/, '素材类型价写回 channel.upstreamUnitPrices');
assert.match(billingPanelSource, /modelUnitPrices/, '模型级覆盖写回 channel.modelUnitPrices');
assert.match(billingPanelSource, /模型级覆盖（留空 = 用素材类型价）/, '必须说明模型级留空 = 回落素材类型价');
assert.match(billingPanelSource, /模型级覆盖 &gt; 素材类型价/, '必须写明优先级 模型 > 素材类型');
assert.match(billingPanelSource, /不等于供应商开出的最终账单/, '必须写明合同价折算≠供应商最终账单');
assert.match(billingPanelSource, /保存失败：\{saveError\}/, '后端拒绝非法合同单价时必须展示错误');
assert.match(billingPanelSource, /priceGroups\.map\(\(group\) => priceRows\(group\)\)/, '合同单价编辑器必须按渠道分组渲染（现在并进价目表）');
// 2026-09-18：对外价（原 PricingPanel）与成本价并排进同一张表，断言随之改到 BillingPanels.jsx。口径一条没变：
// 对外价不扣学生、不是上游成本、走 admin/compute-pricing、模态基础价与模型级覆盖都要能改。
assert.match(billingPanelSource, /不扣学生/, '价目表必须写明对外价不扣学生');
assert.match(billingPanelSource, /不是上游成本/, '价目表必须写明对外价不是上游成本');
assert.match(billingPanelSource, /api\.put\('admin\/compute-pricing'/, '价目表必须 PUT 对外价配置');
assert.match(billingPanelSource, /perCall/, '价目表必须能改模态基础价');
assert.match(billingPanelSource, /models\[model\]/, '价目表必须能改模型级对外价覆盖');
assert.match(billingPanelSource, /channels\.map/, '价目表必须按渠道分组');
assert.match(modelSource, /<FinancialReconciliation api=\{api\} view="calls"/, '调用账是默认视图');
assert.match(modelSource, /<FinancialReconciliation api=\{api\} view="margin"/, '两账与毛利');
// 2026-09-18：供应商账单两条线整体下线（用户口径），相关断言随之下线 —— 这是口径变更，不是测试漂移。
// （原断言：advancedView 下挂着「供应商账单 / 匹配与核销」两个子视图。）
assert.match(modelSource, /<OrgStudentUsagePanel api=\{api\}/, '「机构与学员」入口必须接出来（按机构看每个学员的消耗）');
assert.match(modelSource, /<ComputeBudgetPanel api=\{api\}/, '平台成本预警挂在两账与毛利下');
assert.match(adminSource, /handleFinancialReporting/);

const ssrRoot = path.join(root, '.tmp');
fs.mkdirSync(ssrRoot, { recursive: true });
const ssrTemp = fs.mkdtempSync(path.join(ssrRoot, 'p88-ssr-'));
const entry = path.join(ssrTemp, 'entry.jsx');
fs.writeFileSync(entry, `
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ModelCompute } from ${JSON.stringify(path.join(root, 'apps/admin/src/pages/ModelCompute.jsx').split(path.sep).join('/'))};
import { minorText } from ${JSON.stringify(path.join(root, 'apps/admin/src/components/FinancialReconciliation.jsx').split(path.sep).join('/'))};
// 金额显示口径（2026-09-15）：逐笔成本可以是**小数分**（文本一次约 0.2~0.4 分）。
// 一律 toFixed(2) 会把 0.37 分显示成 0.00，看起来像没记账 —— 所以小数分必须按 4 位显示。
if (minorText(4) !== '0.04') throw new Error('整数分应按 2 位显示：' + minorText(4));
if (minorText(100) !== '1.00') throw new Error('整数分应按 2 位显示：' + minorText(100));
if (minorText(0.3678) !== '0.0037') throw new Error('小数分必须按 4 位显示（否则看着像 0）：' + minorText(0.3678));
if (minorText(4.3678) !== '0.0437') throw new Error('整数分+小数分混合也按 4 位：' + minorText(4.3678));
if (minorText(null) !== '未知') throw new Error('未知不能显示成 0：' + minorText(null));
const api = { get: () => new Promise(() => {}), post: () => Promise.resolve({}) };
// 2026-09-15 重排：顶层是「调用账 / 机构与学员 / 两账与毛利」。
// 2026-09-18：「高级」一级页签随供应商账单两条线一起删掉（它下面只有那两屏），断言里的 advanced 一并去掉；
//            同一天「三账」改称「两账」（第二本账就是上游成本，没有第三本）—— 口径变更，不是测试漂移。
const render = (entry) => renderToStaticMarkup(<MemoryRouter initialEntries={[entry]}><Routes><Route path="/compute/usage" element={<ModelCompute api={api} />} /></Routes></MemoryRouter>);
for (const [view, tabs] of [['calls', ['调用账', '机构与学员', '两账与毛利']], ['orgs', []], ['margin', []]]) {
  const html = render('/compute/usage?view=' + view);
  for (const tab of tabs) if (!html.includes(tab)) throw new Error(view + ' missing tab ' + tab);
}
// 「上游成本」（合并后的列）必须在加载态就已经渲染出来，不能等数据。
for (const text of ['正在读取调用账', '上游成本']) if (!render('/compute/usage?view=calls').includes(text)) throw new Error('calls did not render ' + text);
for (const text of ["正在读取机构消耗"]) if (!render('/compute/usage?view=orgs').includes(text)) throw new Error('orgs did not render ' + text);
for (const text of ['正在计算两账对照', '每场课堂平台预警']) if (!render('/compute/usage?view=margin').includes(text)) throw new Error('margin did not render ' + text);
// 2026-09-18：供应商账单两条线整体下线（用户口径），相关断言随之下线 —— 这是口径变更，不是测试漂移。
// 原先这里还 SSR 了「高级 → 供应商账单 / 匹配与核销」两个子视图（bills / matching），
// 并用夹具真渲染「官方账单对账表」（缺失 / 未知必须留空，不得显示成 0）。整块随两条线一起删除。
console.log('P88 three-view SSR passed');
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
// 2026-09-18：覆盖范围随供应商账单两条线收窄（供应商成本核销 / CSV 候选与导入 / 官方账单区块已下线）；
// 同一天「三账」→「两账」（对外售价 / 上游成本），日志描述一并改口径。
console.log('P88 passed: real two-ledger summary, unknown/multi-currency rules, PAID revenue basis, three-view SSR, billing permission, and admin routing.');
