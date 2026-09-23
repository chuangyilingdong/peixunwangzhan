// 用量与成本报表 —— 2026-09-18 起是「**两账**」：
//   ① 对外售价 —— compute_attempts.sale_price_fen（本次落库快照价，无快照回退当前 compute_pricing 配置并标注来源）。
//      **只观测、不扣学生、不计收入**，也不进入任何毛利公式。
//   ② 上游成本 —— compute_attempts.upstream_cost_fen，来源由 cost_source 标注
//      （COMPUTED 按合同单价折算 / REPORTED 上游报告 / ESTIMATED 配置估算 / MOCK 本地模拟）。
//      成本未知（cost_source='UNKNOWN' 或没有金额）**单列计数，绝不按 0 算**。
//   差额 = 对外售价 − 上游成本：两侧都算得出、且成本不未知时才给，任一未知一律返回 null
//   —— 与原「未核销时不计算差额、避免把未核销显示成正利润」一脉相承，这个谨慎保持不变。
//
// 2026-09-18 减法（用户口径）：供应商账单两条线（CSV 手工导入 + 供应商账单接口拉取）整体下线。
//   原先的第三本账「实际核销」来自供应商账单匹配与账单快照那 7 张表（账单行 / 匹配 / 导入 / 账户 / 快照 / 聚合），
//   表、服务、路由都已删除，本文件不再查这些表、也不再按币种 UNION 它们。
//   **对外字段名刻意保持不变**（settledAmountMinor / differenceMinor / settledCostMinor /
//   supplierRowsComplete / unreconciledMinor 等），避免前端与守卫跟着改；但语义已变，见各处注释。
import { errors, parseJson, row, rows, arows, arow } from '../lib.js';
import { getComputePricing } from './computePool.js';

const CURRENCY = /^[A-Z]{3}$/;
const text = (value) => String(value || '').trim();

// 对外售价（观测口径）只对照、不扣学生、不计收入；模态与 computePool 的四档保持一致。
const MODALITIES = ['TEXT', 'IMAGE', 'VIDEO', 'MUSIC'];

// 上游成本账的记账币种：compute_attempts.upstream_cost_fen 没有币种列（平台成本一律按人民币分记账），
// 所以第二本账统一归到 CNY 上 —— 选了别的币种的报表里这本账不参与（跨币种不可比），成本侧留 null 而不是 0。
const PLATFORM_COST_CURRENCY = 'CNY';

// 成本未知的判定：来源标了 UNKNOWN，或压根没有金额。未知 ≠ 0，永远单列计数。
const costUnknownOf = (source, fen) => source === 'UNKNOWN' || fen === null || fen === undefined;

// sale_price_fen 由 schema 迁移补齐；列未落地前回退为 NULL，服务不因缺列报错。
let salePriceColumn;
async function salePriceExpression() {
  if (salePriceColumn === undefined) {
    salePriceColumn = (await arows("PRAGMA table_info(compute_attempts)")).some((item) => item.name === 'sale_price_fen') ? 'attempt.sale_price_fen' : 'NULL';
  }
  return salePriceColumn;
}

/**
 * 一次调用的「对外售价」：优先取该次落库快照，无快照回退当前 compute_pricing 配置，并标注来源。
 * 未知（没有快照、模态与模型都没有配置价）返回 null，绝不按 0 处理。
 */
function resolveSalePrice(item, pricing) {
  if (item.salePriceFen !== undefined && item.salePriceFen !== null && Number.isFinite(Number(item.salePriceFen))) {
    return { minor: Number(item.salePriceFen), source: 'SNAPSHOT' };
  }
  const model = text(item.model);
  if (model && Object.prototype.hasOwnProperty.call(pricing.models, model)) return { minor: Number(pricing.models[model]), source: 'PRICING' };
  const modality = text(item.modality).toUpperCase();
  if (MODALITIES.includes(modality)) return { minor: Number(pricing.perCall[modality] ?? 0), source: 'PRICING' };
  return { minor: null, source: 'UNKNOWN' };
}

function rangeOf(filters = {}) {
  const days = Number(filters.days || 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw errors.badRequest('days 必须是 1 到 365 的整数', 'VALIDATION_ERROR');
  const until = filters.to ? new Date(filters.to) : new Date();
  const since = filters.from ? new Date(filters.from) : new Date(until.getTime() - days * 86400000);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) throw errors.badRequest('财务报表时间范围无效', 'INVALID_TIME_RANGE');
  const currency = text(filters.currency).toUpperCase();
  if (currency && !CURRENCY.test(currency)) throw errors.badRequest('币种必须是三位大写代码', 'INVALID_CURRENCY');
  return { since: since.toISOString(), until: until.toISOString(), currency };
}

function add(conditions, params, value, sql) {
  if (value) { conditions.push(sql); params.push(value); }
}

function pageNumber(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw errors.badRequest('分页参数无效', 'VALIDATION_ERROR');
  return parsed;
}

export async function financialReportOptions() {
  // 币种下拉：购买批次 / 许可收入事件两个账本，外加**上游成本账**的币种（第二本账也要能选出来看）。
  const licenseCurrencies = await arows("SELECT currency id,currency name FROM (SELECT currency FROM license_purchase_batches WHERE currency IS NOT NULL UNION SELECT currency FROM license_revenue_events WHERE currency IS NOT NULL) ORDER BY currency");
  const hasUpstreamCost = (await arows('SELECT 1 ok FROM compute_attempts WHERE upstream_cost_fen IS NOT NULL LIMIT 1')).length > 0;
  const currencies = hasUpstreamCost && !licenseCurrencies.some((item) => item.id === PLATFORM_COST_CURRENCY)
    ? [...licenseCurrencies, { id: PLATFORM_COST_CURRENCY, name: PLATFORM_COST_CURRENCY }].sort((a, b) => String(a.id).localeCompare(String(b.id)))
    : licenseCurrencies;
  return {
    organizations: await arows('SELECT id,name FROM organizations ORDER BY name,id'),
    students: await arows("SELECT id,display_name name,login,org_id orgId FROM users WHERE role='STUDENT' AND deleted_at IS NULL ORDER BY display_name,login"),
    series: await arows('SELECT id,title name FROM course_series ORDER BY title,id'),
    sessions: await arows('SELECT id,COALESCE(title,id) name,org_id orgId,series_id seriesId,lesson_id lessonId FROM class_sessions ORDER BY created_at DESC,id DESC'),
    lessons: await arows('SELECT id,title name,series_id seriesId FROM course_lessons ORDER BY title,id'),
    models: await arows("SELECT DISTINCT model id,model name FROM compute_attempts WHERE model IS NOT NULL AND model<>'' ORDER BY model"),
    channels: await arows("SELECT DISTINCT COALESCE(actual_channel_id,channel_id) id,COALESCE(actual_channel_id,channel_id) name FROM compute_attempts WHERE COALESCE(actual_channel_id,channel_id) IS NOT NULL ORDER BY name"),
    currencies,
  };
}

const CALL_FROM = `FROM compute_attempts attempt
  LEFT JOIN organizations organization ON organization.id=attempt.org_id
  LEFT JOIN users student ON student.id=attempt.user_id
  LEFT JOIN usage_records usage ON usage.id=attempt.internal_usage_record_id
  LEFT JOIN class_sessions session ON session.id=COALESCE(attempt.class_session_id,usage.class_session_id)`;

function callScope(filters, range) {
  const conditions = ['attempt.created_at>=?', 'attempt.created_at<?'];
  const params = [range.since, range.until];
  add(conditions, params, text(filters.orgId), 'attempt.org_id=?');
  add(conditions, params, text(filters.studentId), 'attempt.user_id=?');
  add(conditions, params, text(filters.seriesId), 'COALESCE(usage.series_id,session.series_id)=?');
  add(conditions, params, text(filters.sessionId), 'COALESCE(attempt.class_session_id,usage.class_session_id)=?');
  add(conditions, params, text(filters.lessonId), 'COALESCE(attempt.lesson_id,session.lesson_id)=?');
  add(conditions, params, text(filters.model), 'attempt.model=?');
  add(conditions, params, text(filters.channelId), 'COALESCE(attempt.actual_channel_id,attempt.channel_id)=?');
  add(conditions, params, text(filters.status), 'attempt.status=?');
  add(conditions, params, text(filters.evidenceMatch), `(CASE WHEN attempt.gateway_log_id IS NOT NULL OR attempt.response_request_id IS NOT NULL OR attempt.response_payload_id IS NOT NULL OR attempt.task_id IS NOT NULL THEN 'MATCHED' WHEN attempt.internal_usage_record_id IS NOT NULL THEN 'PARTIAL' ELSE 'UNMATCHED' END)=?`);
  return { conditions, params };
}

export async function listFinancialCalls(filters = {}) {
  const range = rangeOf(filters);
  const page = pageNumber(filters.page, 1, 100000);
  const limit = pageNumber(filters.limit, 20, 100);
  const scope = callScope(filters, range);
  const where = scope.conditions.join(' AND ');
  const total = Number((await arow(`SELECT COUNT(DISTINCT attempt.id) n ${CALL_FROM} WHERE ${where}`, scope.params))?.n || 0);
  const raw = await arows(`SELECT attempt.*,organization.name organization_name,student.display_name student_name,
      usage.id linked_usage_id,COALESCE(usage.series_id,session.series_id) linked_series_id,
      COALESCE(attempt.class_session_id,usage.class_session_id) linked_session_id,COALESCE(attempt.lesson_id,session.lesson_id) linked_lesson_id
    ${CALL_FROM} WHERE ${where} GROUP BY attempt.id ORDER BY attempt.created_at DESC,attempt.id DESC LIMIT ? OFFSET ?`, [...scope.params, limit, (page - 1) * limit]);
  const pricing = await getComputePricing();
  const items = raw.map((item) => {
    const sale = resolveSalePrice({ salePriceFen: item.sale_price_fen, model: item.model, modality: item.modality }, pricing);
    const costUnknown = costUnknownOf(item.cost_source, item.upstream_cost_fen);
    // 上游成本（第二本账）：compute_attempts.upstream_cost_fen，来源见 cost_source。未知 → null，不按 0。
    const upstreamCostMinor = costUnknown ? null : Number(item.upstream_cost_fen);
    // 差额 = 对外售价 − 上游成本；任一侧未知（含成本未知）就不计算 —— 保持「未知不得显示成正利润」的谨慎。
    const differenceMinor = sale.minor == null || upstreamCostMinor == null ? null : sale.minor - upstreamCostMinor;
    return {
      id: item.id, callId: item.call_id, attempt: Number(item.attempt), createdAt: item.created_at,
      orgId: item.org_id || null, organizationName: item.organization_name || null,
      userId: item.user_id || null, studentName: item.student_name || null,
      seriesId: item.linked_series_id || null, sessionId: item.linked_session_id || null, lessonId: item.linked_lesson_id || null,
      modality: item.modality, channelId: item.channel_id || null, actualChannelId: item.actual_channel_id || null,
      provider: item.provider || null, model: item.model || null, status: item.status,
      costSource: item.cost_source, estimatedOrReportedMinor: upstreamCostMinor,
      costUnknown,
      // 上游用量证据（P90）：usage_snapshot 里存的是 upstreamCost.collectUsageEvidence 的原始形状
      // （tokens / 张数 / 秒数 / 分辨率 / 含音频），**只读透出**给调用账展示，服务不改口径、不算钱。
      usageSnapshot: parseJson(item.usage_snapshot, null),
      // 价目层级来源（P90）：cost_rule_snapshot 里 priceLevel(MODEL|MODALITY) 与 source(COMPUTED…)
      // 沿用 upstreamCost.contractCostRuleSnapshot 的原字段名，**只读透出**、不重算金额；无快照为 null。
      costRuleSnapshot: parseJson(item.cost_rule_snapshot, null),
      salePriceFen: sale.minor, salePriceSource: sale.source, salePriceIsSnapshot: sale.source === 'SNAPSHOT',
      clientRequestId: item.client_request_id || null, responseRequestId: item.response_request_id || null,
      responsePayloadId: item.response_payload_id || null, taskId: item.task_id || null,
      providerUsageId: item.usage_id || null, internalUsageRecordId: item.internal_usage_record_id || null,
      usageId: item.internal_usage_record_id || null, gatewayLogId: item.gateway_log_id || null,
      evidenceMatch: item.gateway_log_id || item.response_request_id || item.response_payload_id || item.task_id ? 'MATCHED' : item.internal_usage_record_id ? 'PARTIAL' : 'UNMATCHED',
      // ⚠️ 字段名沿用（前端读它），但语义已变：settledAmountMinor 现在 = **上游成本**（未知为 null），
      //    settledCurrency 现在 = 上游成本账的币种（固定 PLATFORM_COST_CURRENCY），未知时为 null。
      settledAmountMinor: upstreamCostMinor,
      differenceMinor,
      settledCurrency: upstreamCostMinor == null ? null : PLATFORM_COST_CURRENCY,
      // matches 沿用空数组：供应商账单匹配已整体下线，没有任何「核销明细」可返回了；留着只为不改变响应形状。
      matches: [],
    };
  });
  return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), filters: range };
}

function groupKey(orgId, currency) { return `${orgId || ''}\u0000${currency || ''}`; }
function merge(map, source, amountField, extras = []) {
  for (const item of source) {
    const key = groupKey(item.orgId, item.currency);
    const current = map.get(key) || { orgId: item.orgId || null, organizationName: item.organizationName || '未归属机构', currency: item.currency || null };
    current[amountField] = item.amountMinor == null ? null : Number(item.amountMinor);
    for (const field of extras) current[field] = Number(item[field] || 0);
    map.set(key, current);
  }
}

/**
 * 两账对照（原「三账与毛利」）：机构购买实收 / 许可确认收入（这两本账口径不变）与**上游成本**并排。
 * 上游成本来自 compute_attempts.upstream_cost_fen，按机构归集；成本未知的调用只计数、不进金额，毛利一律留空。
 */
export async function financialReconciliationReport(filters = {}) {
  const range = rangeOf(filters);
  const orgId = text(filters.orgId); const studentId = text(filters.studentId); const seriesId = text(filters.seriesId);
  const purchaseWhere = ["batch.status='ACTIVE'", "batch.purchase_type='PURCHASE'", 'batch.purchased_at>=?', 'batch.purchased_at<?'];
  const purchaseParams = [range.since, range.until];
  add(purchaseWhere, purchaseParams, orgId, 'batch.org_id=?'); add(purchaseWhere, purchaseParams, seriesId, 'batch.series_id=?'); add(purchaseWhere, purchaseParams, range.currency, 'batch.currency=?');
  const purchases = await arows(`SELECT batch.org_id orgId,organization.name organizationName,batch.currency,
      SUM(CASE WHEN batch.payment_status='PAID' THEN batch.amount_minor ELSE 0 END) amountMinor,
      SUM(CASE WHEN batch.payment_status='PAID' THEN 1 ELSE 0 END) paidPurchaseCount,
      SUM(CASE WHEN batch.payment_status IN ('PARTIAL','UNPAID') THEN 1 ELSE 0 END) pendingPaymentCount
    FROM license_purchase_batches batch LEFT JOIN organizations organization ON organization.id=batch.org_id
    WHERE ${purchaseWhere.join(' AND ')} GROUP BY batch.org_id,batch.currency`, purchaseParams);

  const revenueWhere = ['event.occurred_at>=?', 'event.occurred_at<?']; const revenueParams = [range.since, range.until];
  add(revenueWhere, revenueParams, orgId, 'event.org_id=?'); add(revenueWhere, revenueParams, seriesId, 'event.series_id=?'); add(revenueWhere, revenueParams, studentId, 'grant.student_id=?'); add(revenueWhere, revenueParams, range.currency, 'event.currency=?');
  const revenues = await arows(`SELECT event.org_id orgId,organization.name organizationName,event.currency,
      CASE WHEN SUM(CASE WHEN event.amount_minor IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(event.amount_minor) END amountMinor,
      SUM(event.quantity) recognizedQuantity,SUM(CASE WHEN event.amount_minor IS NULL THEN 1 ELSE 0 END) unknownRevenueEvents
    FROM license_revenue_events event LEFT JOIN organizations organization ON organization.id=event.org_id
    LEFT JOIN student_course_grants grant ON grant.id=event.grant_id
    WHERE ${revenueWhere.join(' AND ')} GROUP BY event.org_id,event.currency`, revenueParams);

  // 上游成本账（第二本账）：compute_attempts.upstream_cost_fen，按机构归集到 PLATFORM_COST_CURRENCY。
  // 成本未知的调用只计数（unresolvedSupplierLineCount，字段名沿用），金额一律不并入 —— 未知绝不按 0：
  //   · 一组里**一笔已知成本都没有**（全是未知）→ 金额给 NULL（不是 0：0 会读成「成本为零」）；
  //   · 一组里有已知也有未知 → 给**已知部分的合计**，同时 unresolvedSupplierLineCount 标出未知笔数，
  //     毛利一律留空（见下方 supplierRowsComplete 闸门），与「部分核销不让毛利显得完整」同源。
  // 选了非 CNY 的币种时这本账不参与：上游成本是按人民币分记账的，跨币种不可比，成本侧留 null。
  const costEnabled = !range.currency || range.currency === PLATFORM_COST_CURRENCY;
  const costWhere = ['attempt.created_at>=?', 'attempt.created_at<?']; const costParams = [range.since, range.until];
  add(costWhere, costParams, orgId, 'attempt.org_id=?'); add(costWhere, costParams, studentId, 'attempt.user_id=?'); add(costWhere, costParams, seriesId, 'COALESCE(usage.series_id,session.series_id)=?');
  const costs = !costEnabled ? [] : (await arows(`SELECT attempt.org_id orgId,organization.name organizationName,
      CASE WHEN SUM(CASE WHEN attempt.cost_source='UNKNOWN' OR attempt.upstream_cost_fen IS NULL THEN 0 ELSE 1 END)=0
        THEN NULL
        ELSE SUM(CASE WHEN attempt.cost_source='UNKNOWN' OR attempt.upstream_cost_fen IS NULL THEN 0 ELSE attempt.upstream_cost_fen END) END amountMinor,
      COUNT(CASE WHEN attempt.cost_source<>'UNKNOWN' AND attempt.upstream_cost_fen IS NOT NULL THEN 1 END) settledMatchCount,
      SUM(CASE WHEN attempt.cost_source='UNKNOWN' OR attempt.upstream_cost_fen IS NULL THEN 1 ELSE 0 END) unresolvedSupplierLineCount
    ${CALL_FROM} WHERE ${costWhere.join(' AND ')} GROUP BY attempt.org_id`, costParams))
    .map((item) => ({ ...item, currency: PLATFORM_COST_CURRENCY }));

  const grouped = new Map();
  merge(grouped, purchases, 'cashReceivedMinor', ['paidPurchaseCount', 'pendingPaymentCount']);
  merge(grouped, revenues, 'recognizedRevenueMinor', ['recognizedQuantity', 'unknownRevenueEvents']);
  merge(grouped, costs, 'settledCostMinor', ['settledMatchCount', 'unresolvedSupplierLineCount']);
  const reportRows = [...grouped.values()].map((item) => {
    const cashReceivedMinor = item.cashReceivedMinor ?? null;
    const recognizedRevenueMinor = item.unknownRevenueEvents || item.recognizedRevenueMinor == null ? null : item.recognizedRevenueMinor;
    const settledCostMinor = item.settledCostMinor ?? null;
    // 成本未知的调用笔数（字段名沿用 unresolvedSupplierLineCount：供应商账单行已下线，这里现在指「成本未知的调用」）。
    const costUnknownCallCount = Number(item.unresolvedSupplierLineCount || 0);
    // 成本侧完整 = 这一组**确实有**算得出的成本，且没有一笔成本未知。
    // 注意「一笔成本数据都没有」（记录里压根没有 compute_attempts）不算完整 —— 那是「未知」，不是「没有缺口」。
    const supplierRowsComplete = settledCostMinor != null && costUnknownCallCount === 0;
    return {
      ...item, cashReceivedMinor, recognizedRevenueMinor, settledCostMinor, costUnknownCallCount,
      // 未决敞口：供应商账单线已下线，「未核销敞口」这个口径不存在了。这里改成「无法计价的成本缺口」：
      // 成本侧完整 → 0（确实没有缺口）；否则 → null（缺口金额不可知，绝不给 0 充数），笔数见下列计数。
      pendingExposureMinor: supplierRowsComplete ? 0 : null,
      pendingExposureLineCount: costUnknownCallCount,
      supplierRowsComplete,
      grossProfitMinor: recognizedRevenueMinor != null && settledCostMinor != null && supplierRowsComplete
        ? recognizedRevenueMinor - settledCostMinor : null,
    };
  }).sort((a, b) => String(a.organizationName).localeCompare(String(b.organizationName), 'zh-CN'));
  const currencies = [...new Set(reportRows.map((item) => item.currency).filter(Boolean))];
  const comparableCurrency = range.currency || (currencies.length === 1 ? currencies[0] : null);
  const comparable = comparableCurrency ? reportRows.filter((item) => item.currency === comparableCurrency) : [];
  const knownRevenue = comparable.length > 0 && comparable.every((item) => item.recognizedRevenueMinor != null);
  const knownCost = comparable.length > 0 && comparable.every((item) => item.settledCostMinor != null);
  const supplierRowsComplete = comparable.length > 0 && comparable.every((item) => item.supplierRowsComplete);
  return {
    rows: reportRows, currencies, comparableCurrency,
    summary: {
      currency: comparableCurrency,
      cashReceivedMinor: comparableCurrency && comparable.some((item) => item.cashReceivedMinor != null) ? comparable.reduce((sum, item) => sum + (item.cashReceivedMinor || 0), 0) : null,
      recognizedRevenueMinor: knownRevenue ? comparable.reduce((sum, item) => sum + item.recognizedRevenueMinor, 0) : null,
      // 上游成本合计：只加**算得出的**部分；同币种的组里有一组成本未知就整列留空（knownCost）。
      settledCostMinor: knownCost ? comparable.reduce((sum, item) => sum + item.settledCostMinor, 0) : null,
      // 「未结算 / 未核销」口径随供应商账单线下线：这里改成「成本未知」——
      // 成本未知的**金额不可知**，所以恒为 null（有成本未知）或 0（确实没有未知），绝不按 0 掩盖未知。
      unreconciledMinor: comparable.length === 0 ? null : supplierRowsComplete ? 0 : null,
      costUnknownCallCount: comparable.reduce((sum, item) => sum + (item.costUnknownCallCount || 0), 0),
      grossProfitMinor: knownRevenue && knownCost && supplierRowsComplete ? comparable.reduce((sum, item) => sum + item.grossProfitMinor, 0) : null,
    },
    filters: { ...range, orgId: orgId || null, seriesId: seriesId || null },
    basis: {
      cash: 'PAID_LICENSE_PURCHASES',
      revenue: 'IMMUTABLE_LICENSE_EVENTS',
      // 第二本账：compute_attempts.upstream_cost_fen（来源见 cost_source）。
      cost: 'COMPUTE_ATTEMPTS_UPSTREAM_COST_FEN',
      costCurrency: PLATFORM_COST_CURRENCY,
      // 上游成本本身就可能是 ESTIMATED / REPORTED（估值或上游回执）—— 不再声称「估算成本不进入本报表」。
      estimatesExcluded: false,
    },
  };
}

const GROUP_DIMENSIONS = [
  { key: 'modality', label: '模态', of: (call) => call.modality || null, fallback: '未知模态' },
  { key: 'channel', label: '渠道', of: (call) => call.channelId || null, fallback: '未知渠道' },
  { key: 'model', label: '模型', of: (call) => call.model || null, fallback: '未知模型' },
  { key: 'org', label: '机构', of: (call) => call.orgId || null, fallback: '未归属机构' },
  { key: 'student', label: '学员', of: (call) => call.userId || null, fallback: '未归属学员' },
];

function emptyBucket(key, label) {
  return {
    key, label, calls: 0, externalAmountMinor: 0, saleUnknownCount: 0,
    knownUpstreamCostMinor: 0, upstreamUnknownCount: 0,
    // 字段名沿用（前端读它）：settledAmountMinor 现在 = 上游成本（只累加算得出的部分）、
    // unsettledCount 现在 = 成本未知的笔数、settledCallCount = 算得出成本的笔数。
    settledAmountMinor: 0, settledCallCount: 0, unsettledCount: 0,
  };
}

function addCall(bucket, call) {
  bucket.calls += 1;
  if (call.salePriceFen == null) bucket.saleUnknownCount += 1; else bucket.externalAmountMinor += call.salePriceFen;
  if (call.costUnknown) {
    // 成本未知：只计数，绝不并入任何金额（未知不等于 0）。
    bucket.upstreamUnknownCount += 1;
    bucket.unsettledCount += 1;
    return;
  }
  bucket.knownUpstreamCostMinor += call.upstreamCostFen;
  bucket.settledAmountMinor += call.upstreamCostFen;
  bucket.settledCallCount += 1;
}

function finalizeBucket(bucket) {
  // 差额 = 对外售价 − 上游成本：本组只要有一笔对外价未知或成本未知就留空
  // （与「未核销不算差额、避免把未知显示成正利润」一脉相承）；未知绝不按 0 参与计算。
  const differenceMinor = bucket.saleUnknownCount === 0 && bucket.upstreamUnknownCount === 0
    ? bucket.externalAmountMinor - bucket.knownUpstreamCostMinor : null;
  // currency 沿用（前端拿它显示币种）：两本账里只有上游成本有币种口径（人民币分）。
  return { ...bucket, currency: PLATFORM_COST_CURRENCY, differenceMinor };
}

/**
 * 调用账汇总：按模态 / 渠道 / 模型（以及机构 / 学员）对照**两账**金额 ——
 * 对外售价（externalAmountMinor，未知单列 saleUnknownCount）与上游成本（knownUpstreamCostMinor，未知单列 upstreamUnknownCount）。
 * 未知一律单列计数，绝不并入差额、绝不按 0 处理。
 */
export async function financialCallSummary(filters = {}) {
  const range = rangeOf(filters);
  const scope = callScope(filters, range);
  const where = scope.conditions.join(' AND ');
  const saleColumn = await salePriceExpression();
  const raw = await arows(`SELECT attempt.id,attempt.modality,COALESCE(attempt.actual_channel_id,attempt.channel_id) channelId,
      attempt.model,attempt.org_id orgId,organization.name organizationName,attempt.user_id userId,student.display_name studentName,
      ${saleColumn} salePriceFen,attempt.cost_source costSource,attempt.upstream_cost_fen upstreamCostFen
    ${CALL_FROM} WHERE ${where}`, scope.params);
  const pricing = await getComputePricing();
  const calls = raw.map((item) => {
    const sale = resolveSalePrice({ salePriceFen: item.salePriceFen, model: item.model, modality: item.modality }, pricing);
    const costUnknown = costUnknownOf(item.costSource, item.upstreamCostFen);
    return {
      modality: item.modality || null, channelId: item.channelId || null, model: item.model || null,
      orgId: item.orgId || null, organizationName: item.organizationName || null, userId: item.userId || null, studentName: item.studentName || null,
      salePriceFen: sale.minor, costUnknown,
      upstreamCostFen: costUnknown ? null : Number(item.upstreamCostFen),
    };
  });
  const groups = {};
  for (const dimension of GROUP_DIMENSIONS) {
    const buckets = new Map();
    for (const call of calls) {
      const value = dimension.of(call);
      const key = value || `\u0000${dimension.key}`;
      const bucket = buckets.get(key) || emptyBucket(value, value ? (dimension.key === 'org' ? call.organizationName || value : dimension.key === 'student' ? call.studentName || value : value) : dimension.fallback);
      addCall(bucket, call);
      buckets.set(key, bucket);
    }
    groups[dimension.key] = [...buckets.values()].map(finalizeBucket).sort((a, b) => b.calls - a.calls || String(a.label).localeCompare(String(b.label), 'zh-CN'));
  }
  const totalBucket = emptyBucket(null, '全部调用');
  for (const call of calls) addCall(totalBucket, call);
  return { groups, totals: finalizeBucket(totalBucket), callCount: calls.length, filters: range };
}
