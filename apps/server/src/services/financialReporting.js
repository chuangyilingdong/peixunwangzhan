import { errors, parseJson, row, rows } from '../lib.js';
import { getComputePricing } from './computePool.js';

const CURRENCY = /^[A-Z]{3}$/;
const text = (value) => String(value || '').trim();

// 对外售价（观测口径）只对照、不扣学生、不计收入；模态与 computePool 的四档保持一致。
const MODALITIES = ['TEXT', 'IMAGE', 'VIDEO', 'MUSIC'];

// sale_price_fen 由 schema 迁移补齐；列未落地前回退为 NULL，服务不因缺列报错。
let salePriceColumn;
function salePriceExpression() {
  if (salePriceColumn === undefined) {
    salePriceColumn = rows("PRAGMA table_info(compute_attempts)").some((item) => item.name === 'sale_price_fen') ? 'attempt.sale_price_fen' : 'NULL';
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

export function financialReportOptions() {
  return {
    organizations: rows('SELECT id,name FROM organizations ORDER BY name,id'),
    students: rows("SELECT id,display_name name,login,org_id orgId FROM users WHERE role='STUDENT' AND deleted_at IS NULL ORDER BY display_name,login"),
    series: rows('SELECT id,title name FROM course_series ORDER BY title,id'),
    sessions: rows('SELECT id,COALESCE(title,id) name,org_id orgId,series_id seriesId,lesson_id lessonId FROM class_sessions ORDER BY created_at DESC,id DESC'),
    lessons: rows('SELECT id,title name,series_id seriesId FROM course_lessons ORDER BY title,id'),
    models: rows("SELECT DISTINCT model id,model name FROM compute_attempts WHERE model IS NOT NULL AND model<>'' ORDER BY model"),
    channels: rows("SELECT DISTINCT COALESCE(actual_channel_id,channel_id) id,COALESCE(actual_channel_id,channel_id) name FROM compute_attempts WHERE COALESCE(actual_channel_id,channel_id) IS NOT NULL ORDER BY name"),
    currencies: rows("SELECT currency id,currency name FROM (SELECT currency FROM license_purchase_batches WHERE currency IS NOT NULL UNION SELECT currency FROM license_revenue_events WHERE currency IS NOT NULL UNION SELECT currency FROM supplier_billing_lines) ORDER BY currency"),
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

export function listFinancialCalls(filters = {}) {
  const range = rangeOf(filters);
  const page = pageNumber(filters.page, 1, 100000);
  const limit = pageNumber(filters.limit, 20, 100);
  const scope = callScope(filters, range);
  const where = scope.conditions.join(' AND ');
  const total = Number(row(`SELECT COUNT(DISTINCT attempt.id) n ${CALL_FROM} WHERE ${where}`, scope.params)?.n || 0);
  const raw = rows(`SELECT attempt.*,organization.name organization_name,student.display_name student_name,
      usage.id linked_usage_id,COALESCE(usage.series_id,session.series_id) linked_series_id,
      COALESCE(attempt.class_session_id,usage.class_session_id) linked_session_id,COALESCE(attempt.lesson_id,session.lesson_id) linked_lesson_id
    ${CALL_FROM} WHERE ${where} GROUP BY attempt.id ORDER BY attempt.created_at DESC,attempt.id DESC LIMIT ? OFFSET ?`, [...scope.params, limit, (page - 1) * limit]);
  const pricing = getComputePricing();
  const items = raw.map((item) => {
    const matches = rows(`SELECT match.id,match.target_type targetType,match.target_id targetId,match.allocated_amount_minor amountMinor,
        match.currency,match.method,line.reconciliation_status reconciliationStatus,line.supplier_line_id supplierLineId
      FROM supplier_billing_matches match JOIN supplier_billing_lines line ON line.id=match.line_id
      WHERE match.cancelled_at IS NULL AND line.reconciliation_status NOT IN ('CANCELLED','EXCLUDED')
        AND ((match.target_type='ATTEMPT' AND match.target_id=?) OR (match.target_type='USAGE' AND match.target_id=?))
      ORDER BY match.created_at,match.id`, [item.id, item.internal_usage_record_id || '']);
    const currencies = [...new Set(matches.map((match) => match.currency))];
    const settledAmountMinor = matches.length && currencies.length === 1 ? matches.reduce((sum, match) => sum + Number(match.amountMinor), 0) : null;
    const sale = resolveSalePrice({ salePriceFen: item.sale_price_fen, model: item.model, modality: item.modality }, pricing);
    // 差额 = 对外售价 − 实际核销；未核销（含多币种无法合并）时不计算，避免把未核销显示成正利润。
    const differenceMinor = sale.minor == null || settledAmountMinor == null ? null : sale.minor - settledAmountMinor;
    return {
      id: item.id, callId: item.call_id, attempt: Number(item.attempt), createdAt: item.created_at,
      orgId: item.org_id || null, organizationName: item.organization_name || null,
      userId: item.user_id || null, studentName: item.student_name || null,
      seriesId: item.linked_series_id || null, sessionId: item.linked_session_id || null, lessonId: item.linked_lesson_id || null,
      modality: item.modality, channelId: item.channel_id || null, actualChannelId: item.actual_channel_id || null,
      provider: item.provider || null, model: item.model || null, status: item.status,
      costSource: item.cost_source, estimatedOrReportedMinor: item.upstream_cost_fen == null ? null : Number(item.upstream_cost_fen),
      costUnknown: item.cost_source === 'UNKNOWN' || item.upstream_cost_fen == null,
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
      settledAmountMinor, differenceMinor,
      settledCurrency: currencies.length === 1 ? currencies[0] : null, matches,
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

export function financialReconciliationReport(filters = {}) {
  const range = rangeOf(filters);
  const orgId = text(filters.orgId); const studentId = text(filters.studentId); const seriesId = text(filters.seriesId);
  const purchaseWhere = ["batch.status='ACTIVE'", "batch.purchase_type='PURCHASE'", 'batch.purchased_at>=?', 'batch.purchased_at<?'];
  const purchaseParams = [range.since, range.until];
  add(purchaseWhere, purchaseParams, orgId, 'batch.org_id=?'); add(purchaseWhere, purchaseParams, seriesId, 'batch.series_id=?'); add(purchaseWhere, purchaseParams, range.currency, 'batch.currency=?');
  const purchases = rows(`SELECT batch.org_id orgId,organization.name organizationName,batch.currency,
      SUM(CASE WHEN batch.payment_status='PAID' THEN batch.amount_minor ELSE 0 END) amountMinor,
      SUM(CASE WHEN batch.payment_status='PAID' THEN 1 ELSE 0 END) paidPurchaseCount,
      SUM(CASE WHEN batch.payment_status IN ('PARTIAL','UNPAID') THEN 1 ELSE 0 END) pendingPaymentCount
    FROM license_purchase_batches batch LEFT JOIN organizations organization ON organization.id=batch.org_id
    WHERE ${purchaseWhere.join(' AND ')} GROUP BY batch.org_id,batch.currency`, purchaseParams);

  const revenueWhere = ['event.occurred_at>=?', 'event.occurred_at<?']; const revenueParams = [range.since, range.until];
  add(revenueWhere, revenueParams, orgId, 'event.org_id=?'); add(revenueWhere, revenueParams, seriesId, 'event.series_id=?'); add(revenueWhere, revenueParams, studentId, 'grant.student_id=?'); add(revenueWhere, revenueParams, range.currency, 'event.currency=?');
  const revenues = rows(`SELECT event.org_id orgId,organization.name organizationName,event.currency,
      CASE WHEN SUM(CASE WHEN event.amount_minor IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(event.amount_minor) END amountMinor,
      SUM(event.quantity) recognizedQuantity,SUM(CASE WHEN event.amount_minor IS NULL THEN 1 ELSE 0 END) unknownRevenueEvents
    FROM license_revenue_events event LEFT JOIN organizations organization ON organization.id=event.org_id
    LEFT JOIN student_course_grants grant ON grant.id=event.grant_id
    WHERE ${revenueWhere.join(' AND ')} GROUP BY event.org_id,event.currency`, revenueParams);

  const costWhere = ['line.occurred_at>=?', 'line.occurred_at<?']; const costParams = [range.since, range.until];
  add(costWhere, costParams, orgId, 'dimension.orgId=?'); add(costWhere, costParams, studentId, 'dimension.userId=?'); add(costWhere, costParams, seriesId, 'dimension.seriesId=?'); add(costWhere, costParams, range.currency, 'line.currency=?');
  const dimensionsCte = `WITH active_match AS (
      SELECT match.id,match.line_id,match.target_type,match.target_id,match.allocated_amount_minor
      FROM supplier_billing_matches match WHERE match.cancelled_at IS NULL
    ), dimension AS (
      SELECT active_match.id matchId,active_match.line_id lineId,active_match.allocated_amount_minor amountMinor,
        attempt.org_id orgId,attempt.user_id userId,COALESCE(usage.series_id,session.series_id) seriesId
      FROM active_match JOIN compute_attempts attempt ON active_match.target_type='ATTEMPT' AND attempt.id=active_match.target_id
      LEFT JOIN usage_records usage ON usage.id=attempt.internal_usage_record_id
      LEFT JOIN class_sessions session ON session.id=COALESCE(attempt.class_session_id,usage.class_session_id)
      UNION ALL
      SELECT active_match.id,active_match.line_id,active_match.allocated_amount_minor,
        usage.org_id,usage.user_id,COALESCE(usage.series_id,session.series_id)
      FROM active_match JOIN usage_records usage ON active_match.target_type='USAGE' AND usage.id=active_match.target_id
      LEFT JOIN class_sessions session ON session.id=usage.class_session_id
    )`;
  const costs = rows(`${dimensionsCte}
    SELECT dimension.orgId,organization.name organizationName,line.currency,SUM(dimension.amountMinor) amountMinor,
      COUNT(dimension.matchId) settledMatchCount,
      SUM(CASE WHEN line.reconciliation_status<>'MATCHED' THEN 1 ELSE 0 END) unresolvedSupplierLineCount
    FROM dimension JOIN supplier_billing_lines line ON line.id=dimension.lineId
    LEFT JOIN organizations organization ON organization.id=dimension.orgId
    WHERE line.reconciliation_status NOT IN ('CANCELLED','EXCLUDED') AND ${costWhere.join(' AND ')}
    GROUP BY dimension.orgId,line.currency`, costParams);

  const exposureWhere = ["line.reconciliation_status IN ('UNMATCHED','PARTIAL','AMBIGUOUS','DISPUTED')", 'line.occurred_at>=?', 'line.occurred_at<?'];
  const exposureParams = [range.since, range.until]; add(exposureWhere, exposureParams, range.currency, 'line.currency=?');
  const globalExposure = orgId || studentId || seriesId ? [] : rows(`SELECT line.currency,
      SUM(line.amount_minor-COALESCE(matched.amountMinor,0)) amountMinor,COUNT(*) lineCount
    FROM supplier_billing_lines line
    LEFT JOIN (SELECT line_id,SUM(allocated_amount_minor) amountMinor FROM supplier_billing_matches WHERE cancelled_at IS NULL GROUP BY line_id) matched ON matched.line_id=line.id
    WHERE ${exposureWhere.join(' AND ')} AND NOT EXISTS (
      SELECT 1 FROM supplier_billing_matches active WHERE active.line_id=line.id AND active.cancelled_at IS NULL
    ) GROUP BY line.currency`, exposureParams).map((item) => ({ currency: item.currency, amountMinor: Number(item.amountMinor || 0), lineCount: Number(item.lineCount || 0) }));
  const attributedExposureWhere = [...exposureWhere]; const attributedExposureParams = [...exposureParams];
  add(attributedExposureWhere, attributedExposureParams, orgId, 'line_dimension.orgId=?'); add(attributedExposureWhere, attributedExposureParams, studentId, 'line_dimension.userId=?'); add(attributedExposureWhere, attributedExposureParams, seriesId, 'line_dimension.seriesId=?');
  const unreconciled = rows(`${dimensionsCte}, line_dimension AS (
      SELECT lineId,orgId,userId,seriesId FROM dimension GROUP BY lineId,orgId,userId,seriesId
    )
    SELECT line_dimension.orgId,organization.name organizationName,line.currency,
      SUM(line.amount_minor-COALESCE(matched.amountMinor,0)) amountMinor,COUNT(DISTINCT line.id) lineCount
    FROM line_dimension JOIN supplier_billing_lines line ON line.id=line_dimension.lineId
    LEFT JOIN organizations organization ON organization.id=line_dimension.orgId
    LEFT JOIN (SELECT line_id,SUM(allocated_amount_minor) amountMinor FROM supplier_billing_matches WHERE cancelled_at IS NULL GROUP BY line_id) matched ON matched.line_id=line.id
    WHERE ${attributedExposureWhere.join(' AND ')} GROUP BY line_dimension.orgId,line.currency`, attributedExposureParams)
    .map((item) => ({ orgId: item.orgId || null, organizationName: item.organizationName || null, currency: item.currency, amountMinor: Number(item.amountMinor || 0), lineCount: Number(item.lineCount || 0) }));

  const grouped = new Map();
  merge(grouped, purchases, 'cashReceivedMinor', ['paidPurchaseCount', 'pendingPaymentCount']);
  merge(grouped, revenues, 'recognizedRevenueMinor', ['recognizedQuantity', 'unknownRevenueEvents']);
  merge(grouped, costs, 'settledCostMinor', ['settledMatchCount', 'unresolvedSupplierLineCount']);
  const exposureByGroup = new Map(unreconciled.map((item) => [groupKey(item.orgId, item.currency), item]));
  const reportRows = [...grouped.values()].map((item) => {
    const cashReceivedMinor = item.cashReceivedMinor ?? null;
    const recognizedRevenueMinor = item.unknownRevenueEvents || item.recognizedRevenueMinor == null ? null : item.recognizedRevenueMinor;
    const settledCostMinor = item.settledCostMinor ?? null;
    const exposure = exposureByGroup.get(groupKey(item.orgId, item.currency));
    const pendingExposureMinor = exposure?.amountMinor ?? 0;
    const supplierRowsComplete = !item.unresolvedSupplierLineCount && !exposure?.lineCount;
    return {
      ...item, cashReceivedMinor, recognizedRevenueMinor, settledCostMinor, pendingExposureMinor,
      pendingExposureLineCount: exposure?.lineCount || 0, supplierRowsComplete,
      grossProfitMinor: recognizedRevenueMinor != null && settledCostMinor != null && supplierRowsComplete
        ? recognizedRevenueMinor - settledCostMinor : null,
    };
  }).sort((a, b) => String(a.organizationName).localeCompare(String(b.organizationName), 'zh-CN'));
  const currencies = [...new Set([...reportRows.map((item) => item.currency), ...unreconciled.map((item) => item.currency), ...globalExposure.map((item) => item.currency)].filter(Boolean))];
  const comparableCurrency = range.currency || (currencies.length === 1 ? currencies[0] : null);
  const comparable = comparableCurrency ? reportRows.filter((item) => item.currency === comparableCurrency) : [];
  const knownRevenue = comparable.length > 0 && comparable.every((item) => item.recognizedRevenueMinor != null);
  const knownCost = comparable.length > 0 && comparable.every((item) => item.settledCostMinor != null);
  const supplierRowsComplete = comparable.length > 0 && comparable.every((item) => item.supplierRowsComplete)
    && (orgId || studentId || seriesId || !globalExposure.some((item) => item.currency === comparableCurrency && item.lineCount > 0));
  return {
    rows: reportRows, unreconciled, globalExposure, currencies, comparableCurrency,
    summary: {
      currency: comparableCurrency,
      cashReceivedMinor: comparableCurrency && comparable.some((item) => item.cashReceivedMinor != null) ? comparable.reduce((sum, item) => sum + (item.cashReceivedMinor || 0), 0) : null,
      recognizedRevenueMinor: knownRevenue ? comparable.reduce((sum, item) => sum + item.recognizedRevenueMinor, 0) : null,
      settledCostMinor: knownCost ? comparable.reduce((sum, item) => sum + item.settledCostMinor, 0) : null,
      unreconciledMinor: comparableCurrency ? unreconciled.filter((item) => item.currency === comparableCurrency).reduce((sum, item) => sum + item.amountMinor, 0) + globalExposure.filter((item) => item.currency === comparableCurrency).reduce((sum, item) => sum + item.amountMinor, 0) : null,
      grossProfitMinor: knownRevenue && knownCost && supplierRowsComplete ? comparable.reduce((sum, item) => sum + item.grossProfitMinor, 0) : null,
    },
    filters: { ...range, orgId: orgId || null, seriesId: seriesId || null },
    basis: { cash: 'PAID_LICENSE_PURCHASES', revenue: 'IMMUTABLE_LICENSE_EVENTS', cost: 'ACTIVE_SUPPLIER_MATCHES', estimatesExcluded: true },
  };
}

// ── 官方账单 API 对账（按账期 × 模型）────────────────────────────────────────
// 官方账单（provider_bill_aggregates，来自供应商账单接口）与平台自己的四档金额并排放：
//   · COMPUTED / ESTIMATED / REPORTED —— compute_attempts.cost_source 的三档平台口径；
//   · CSV 已核销 —— supplier_billing_matches 里 ACTIVE 的分摊金额（运营导入的账单已经对上账的部分）。
// 差异 = 官方 − COMPUTED，按模型归因。**缺失的一侧留 null，绝不按 0 参与计算**：
// 「上游没给这个模型」和「上游给了 0」是两件完全不同的事，报表必须能分辨。
const PLATFORM_COST_CURRENCY = 'CNY';
const PERIOD_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function periodRange(filters = {}) {
  const currency = text(filters.currency).toUpperCase() || PLATFORM_COST_CURRENCY;
  if (!CURRENCY.test(currency)) throw errors.badRequest('币种必须是三位大写代码', 'INVALID_CURRENCY');
  const period = text(filters.period);
  let start = text(filters.periodStart) || text(filters.from);
  let end = text(filters.periodEnd) || text(filters.to);
  if (period) {
    if (!PERIOD_MONTH.test(period)) throw errors.badRequest('period 必须是 YYYY-MM 格式', 'INVALID_PERIOD');
    const year = Number(period.slice(0, 4)); const month = Number(period.slice(5, 7));
    start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    end = new Date(Date.UTC(year, month, 1)).toISOString();
  }
  const since = new Date(start); const until = new Date(end);
  if (!start || !end || Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
    throw errors.badRequest('账期无效（需要 period=YYYY-MM 或 periodStart/periodEnd）', 'INVALID_TIME_RANGE');
  }
  return { periodStart: since.toISOString(), periodEnd: until.toISOString(), currency };
}

export function providerBillReconciliation(filters = {}) {
  const range = periodRange(filters);
  const accountId = text(filters.supplierAccountId);

  // 同一账号 + 同一账期可能被拉过多次（供应商改了数、或换了适配器）：只认**最近一次**成功的快照，
  // 否则同一份账期会被重复计入官方合计。被顶掉的那几份单列出来，方便运营知道「数是新的」。
  const snapshotConditions = ["snapshot.status='FETCHED'", 'snapshot.period_start>=?', 'snapshot.period_end<=?'];
  const snapshotParams = [range.periodStart, range.periodEnd];
  add(snapshotConditions, snapshotParams, accountId, 'snapshot.supplier_account_id=?');
  const fetched = rows(`SELECT snapshot.*,account.code account_code,account.name account_name FROM provider_bill_snapshots snapshot
    LEFT JOIN supplier_accounts account ON account.id=snapshot.supplier_account_id
    WHERE ${snapshotConditions.join(' AND ')} ORDER BY snapshot.fetched_at DESC,snapshot.id DESC`, snapshotParams);
  const latestByPeriod = new Map();
  let supersededCount = 0;
  for (const snapshot of fetched) {
    const key = `${snapshot.supplier_account_id}\u0000${snapshot.period_start}\u0000${snapshot.period_end}`;
    if (latestByPeriod.has(key)) { supersededCount += 1; continue; }
    latestByPeriod.set(key, snapshot);
  }
  const snapshots = [...latestByPeriod.values()];
  const snapshotIds = snapshots.map((item) => item.id);

  const officialRows = snapshotIds.length
    ? rows(`SELECT model,currency,SUM(amount_minor) amountMinor,SUM(COALESCE(quantity,0)) quantity,COUNT(*) rowCount
        FROM provider_bill_aggregates WHERE snapshot_id IN (${snapshotIds.map(() => '?').join(',')}) GROUP BY model,currency`, snapshotIds)
    : [];
  const officialCurrencies = [...new Set(officialRows.map((item) => item.currency))].sort();
  const officialInCurrency = officialRows.filter((item) => item.currency === range.currency);
  const excludedOfficial = officialRows.filter((item) => item.currency !== range.currency)
    .map((item) => ({ model: item.model || null, currency: item.currency, amountMinor: Number(item.amountMinor || 0) }));
  const officialCurrencyMismatch = officialRows.length > 0 && officialInCurrency.length === 0;

  // 平台口径：按模型 × cost_source 汇总（金额未知的行只计数，不进任何一档金额）。
  const platformRows = rows(`SELECT COALESCE(model,'') model,cost_source source,upstream_cost_fen costFen,COUNT(*) n
    FROM compute_attempts WHERE created_at>=? AND created_at<? GROUP BY COALESCE(model,''),cost_source,upstream_cost_fen`, [range.periodStart, range.periodEnd]);

  // CSV 已核销：运营导入的账单里已经对到内部调用上的**有效分摊**，按被对上的模型归集。
  const csvRows = rows(`SELECT COALESCE(attempt.model,usage.model,'') model,SUM(match.allocated_amount_minor) amountMinor,COUNT(*) matchCount
    FROM supplier_billing_matches match
    JOIN supplier_billing_lines line ON line.id=match.line_id
    LEFT JOIN compute_attempts attempt ON match.target_type='ATTEMPT' AND attempt.id=match.target_id
    LEFT JOIN usage_records usage ON match.target_type='USAGE' AND usage.id=match.target_id
    WHERE match.cancelled_at IS NULL AND line.reconciliation_status NOT IN ('CANCELLED','EXCLUDED')
      AND line.occurred_at>=? AND line.occurred_at<? AND match.currency=?
    GROUP BY COALESCE(attempt.model,usage.model,'')`, [range.periodStart, range.periodEnd, range.currency]);

  const modelKeys = new Set([
    ...officialInCurrency.map((item) => item.model || ''),
    ...platformRows.map((item) => item.model || ''),
    ...csvRows.map((item) => item.model || ''),
  ]);
  const label = (model) => (model ? model : '未标注模型');
  const rowsOut = [...modelKeys].sort((a, b) => String(a).localeCompare(String(b))).map((model) => {
    const official = officialInCurrency.filter((item) => (item.model || '') === model);
    const platform = platformRows.filter((item) => (item.model || '') === model);
    const csv = csvRows.find((item) => (item.model || '') === model);
    const sumSource = (source) => platform.filter((item) => item.source === source && item.costFen !== null && item.costFen !== undefined);
    const countSource = (source) => platform.filter((item) => item.source === source).reduce((sum, item) => sum + Number(item.n || 0), 0);
    const amountOf = (source) => (sumSource(source).length ? sumSource(source).reduce((sum, item) => sum + Number(item.costFen || 0), 0) : null);
    const unknownCostCallCount = platform.filter((item) => item.costFen === null || item.costFen === undefined).reduce((sum, item) => sum + Number(item.n || 0), 0);
    const officialPresent = official.length > 0;
    const officialAmountMinor = officialPresent ? official.reduce((sum, item) => sum + Number(item.amountMinor || 0), 0) : null;
    const computedAmountMinor = amountOf('COMPUTED');
    const computedPresent = computedAmountMinor !== null;
    // 差异只在「官方给了数」且「平台这一侧数得全」时才算：任一缺失就留 null，不拿 0 顶。
    const differenceMinor = officialPresent && computedPresent && unknownCostCallCount === 0 ? officialAmountMinor - computedAmountMinor : null;
    const differenceReason = !officialPresent ? 'OFFICIAL_MISSING' : !computedPresent ? 'COMPUTED_MISSING' : unknownCostCallCount > 0 ? 'COMPUTED_INCOMPLETE' : null;
    return {
      model: model || null, modelLabel: label(model),
      officialAmountMinor, officialPresent, officialRowCount: official.reduce((sum, item) => sum + Number(item.rowCount || 0), 0),
      officialQuantity: officialPresent ? official.reduce((sum, item) => sum + Number(item.quantity || 0), 0) : null,
      computedAmountMinor, computedPresent, computedCallCount: countSource('COMPUTED'),
      estimatedAmountMinor: amountOf('ESTIMATED'), estimatedCallCount: countSource('ESTIMATED'),
      reportedAmountMinor: amountOf('REPORTED'), reportedCallCount: countSource('REPORTED'),
      csvSettledAmountMinor: csv ? Number(csv.amountMinor || 0) : null, csvSettledMatchCount: csv ? Number(csv.matchCount || 0) : 0,
      unknownCostCallCount,
      differenceMinor, differenceReason,
      differenceStatus: differenceMinor === null ? null : differenceMinor === 0 ? 'EXACT' : differenceMinor > 0 ? 'OFFICIAL_HIGHER' : 'OFFICIAL_LOWER',
      inOfficialOnly: officialPresent && platform.length === 0, inPlatformOnly: !officialPresent && platform.length > 0,
    };
  });

  const sumOrNull = (list, key) => (list.length && list.every((item) => item[key] !== null) ? list.reduce((sum, item) => sum + item[key], 0) : null);
  // 有的模型官方没给数、或没有 COMPUTED 调用 —— 合计就留空（不按 0 求和）。
  // 但界面仍然想显示「已拿到的那部分的加总」，所以额外给一份 presentSums，并标明哪些列不完整：
  // 看的人一眼能分清「合计为空」是「真的没有」还是「缺了一部分」。
  const presentSum = (key) => rowsOut.filter((item) => item[key] !== null).reduce((sum, item) => sum + item[key], 0);
  const complete = (key) => rowsOut.length > 0 && rowsOut.every((item) => item[key] !== null);
  const totals = {
    modelCount: rowsOut.length,
    officialAmountMinor: sumOrNull(rowsOut, 'officialAmountMinor'),
    computedAmountMinor: sumOrNull(rowsOut, 'computedAmountMinor'),
    estimatedAmountMinor: sumOrNull(rowsOut, 'estimatedAmountMinor'),
    reportedAmountMinor: sumOrNull(rowsOut, 'reportedAmountMinor'),
    csvSettledAmountMinor: sumOrNull(rowsOut, 'csvSettledAmountMinor'),
    differenceMinor: sumOrNull(rowsOut, 'differenceMinor'),
    presentSums: {
      officialAmountMinor: presentSum('officialAmountMinor'),
      computedAmountMinor: presentSum('computedAmountMinor'),
      estimatedAmountMinor: presentSum('estimatedAmountMinor'),
      reportedAmountMinor: presentSum('reportedAmountMinor'),
      csvSettledAmountMinor: presentSum('csvSettledAmountMinor'),
      differenceMinor: presentSum('differenceMinor'),
    },
    complete: {
      official: complete('officialAmountMinor'),
      computed: complete('computedAmountMinor'),
      estimated: complete('estimatedAmountMinor'),
      reported: complete('reportedAmountMinor'),
      csvSettled: complete('csvSettledAmountMinor'),
      difference: complete('differenceMinor'),
    },
    computedCallCount: rowsOut.reduce((sum, item) => sum + item.computedCallCount, 0),
    estimatedCallCount: rowsOut.reduce((sum, item) => sum + item.estimatedCallCount, 0),
    reportedCallCount: rowsOut.reduce((sum, item) => sum + item.reportedCallCount, 0),
    csvSettledMatchCount: rowsOut.reduce((sum, item) => sum + item.csvSettledMatchCount, 0),
    unknownCostCallCount: rowsOut.reduce((sum, item) => sum + item.unknownCostCallCount, 0),
  };
  return {
    period: { ...range, platformCurrency: PLATFORM_COST_CURRENCY },
    rows: rowsOut,
    totals,
    coverage: {
      officialSnapshotCount: snapshots.length, supersededSnapshotCount: supersededCount,
      officialCurrencies, officialCurrencyMismatch, excludedOfficial,
      supplierAccountIds: [...new Set(snapshots.map((item) => item.supplier_account_id))],
    },
    snapshots: snapshots.map((item) => ({
      id: item.id, supplierAccountId: item.supplier_account_id, supplierAccountCode: item.account_code || null, supplierAccountName: item.account_name || null,
      adapter: item.adapter, source: item.source, periodStart: item.period_start, periodEnd: item.period_end,
      currency: item.currency || null, itemCount: Number(item.item_count || 0), totalAmountMinor: item.total_amount_minor === null || item.total_amount_minor === undefined ? null : Number(item.total_amount_minor),
      fetchedAt: item.fetched_at, fetchedBy: item.fetched_by || null,
    })),
    missingInBill: rowsOut.filter((item) => !item.officialPresent).map((item) => item.model),
    missingInPlatform: rowsOut.filter((item) => !item.computedPresent).map((item) => item.model),
    basis: {
      official: 'PROVIDER_BILL_AGGREGATES_LATEST_SNAPSHOT_PER_PERIOD',
      computed: 'COMPUTE_ATTEMPTS_COST_SOURCE_COMPUTED',
      estimated: 'COMPUTE_ATTEMPTS_COST_SOURCE_ESTIMATED',
      reported: 'COMPUTE_ATTEMPTS_COST_SOURCE_REPORTED',
      csvSettled: 'ACTIVE_SUPPLIER_MATCHES',
      difference: 'OFFICIAL_MINUS_COMPUTED_PER_MODEL',
      missingIsNotZero: true,
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
    settledAmountMinor: 0, settledCallCount: 0, unsettledCount: 0, mixedCurrencyCount: 0,
    currencies: new Set(),
  };
}

function addCall(bucket, call) {
  bucket.calls += 1;
  if (call.salePriceFen == null) bucket.saleUnknownCount += 1; else bucket.externalAmountMinor += call.salePriceFen;
  if (call.costUnknown) bucket.upstreamUnknownCount += 1; else bucket.knownUpstreamCostMinor += call.upstreamCostFen;
  if (call.matchCount === 0) bucket.unsettledCount += 1;
  else if (call.settledCurrencies.length === 1) { bucket.settledAmountMinor += call.settledFen; bucket.settledCallCount += 1; bucket.currencies.add(call.settledCurrencies[0]); }
  else { bucket.mixedCurrencyCount += 1; for (const currency of call.settledCurrencies) bucket.currencies.add(currency); }
}

function finalizeBucket(bucket) {
  const currencies = [...bucket.currencies];
  const singleCurrency = currencies.length === 1 ? currencies[0] : null;
  const settledAmountMinor = bucket.mixedCurrencyCount > 0 ? null : bucket.settledAmountMinor;
  // 差额 = 对外金额 − 实际核销；存在未知对外价、未核销或跨币种时留空，未知一律不并入差额、不按 0 处理。
  const differenceMinor = bucket.saleUnknownCount === 0 && bucket.unsettledCount === 0 && bucket.mixedCurrencyCount === 0
    ? bucket.externalAmountMinor - (settledAmountMinor || 0) : null;
  return { ...bucket, currencies, currency: singleCurrency, settledAmountMinor, differenceMinor };
}

/**
 * 调用账汇总：按模态 / 渠道 / 模型（以及机构 / 学员）对照三档金额与核销情况。
 * 未知对外价或未知上游成本单列计数，绝不并入差额、绝不按 0 处理。
 */
export function financialCallSummary(filters = {}) {
  const range = rangeOf(filters);
  const scope = callScope(filters, range);
  const where = scope.conditions.join(' AND ');
  const saleColumn = salePriceExpression();
  const raw = rows(`SELECT attempt.id,attempt.modality,COALESCE(attempt.actual_channel_id,attempt.channel_id) channelId,
      attempt.model,attempt.org_id orgId,organization.name organizationName,attempt.user_id userId,student.display_name studentName,
      ${saleColumn} salePriceFen,attempt.cost_source costSource,attempt.upstream_cost_fen upstreamCostFen,
      (SELECT SUM(match.allocated_amount_minor) FROM supplier_billing_matches match
        JOIN supplier_billing_lines line ON line.id=match.line_id
        WHERE match.cancelled_at IS NULL AND line.reconciliation_status NOT IN ('CANCELLED','EXCLUDED')
          AND ((match.target_type='ATTEMPT' AND match.target_id=attempt.id) OR (match.target_type='USAGE' AND match.target_id=attempt.internal_usage_record_id))) settledFen,
      (SELECT COUNT(*) FROM supplier_billing_matches match
        JOIN supplier_billing_lines line ON line.id=match.line_id
        WHERE match.cancelled_at IS NULL AND line.reconciliation_status NOT IN ('CANCELLED','EXCLUDED')
          AND ((match.target_type='ATTEMPT' AND match.target_id=attempt.id) OR (match.target_type='USAGE' AND match.target_id=attempt.internal_usage_record_id))) matchCount,
      (SELECT GROUP_CONCAT(DISTINCT match.currency) FROM supplier_billing_matches match
        JOIN supplier_billing_lines line ON line.id=match.line_id
        WHERE match.cancelled_at IS NULL AND line.reconciliation_status NOT IN ('CANCELLED','EXCLUDED')
          AND ((match.target_type='ATTEMPT' AND match.target_id=attempt.id) OR (match.target_type='USAGE' AND match.target_id=attempt.internal_usage_record_id))) settledCurrencies
    ${CALL_FROM} WHERE ${where}`, scope.params);
  const pricing = getComputePricing();
  const calls = raw.map((item) => {
    const sale = resolveSalePrice({ salePriceFen: item.salePriceFen, model: item.model, modality: item.modality }, pricing);
    const matchCount = Number(item.matchCount || 0);
    return {
      modality: item.modality || null, channelId: item.channelId || null, model: item.model || null,
      orgId: item.orgId || null, organizationName: item.organizationName || null, userId: item.userId || null, studentName: item.studentName || null,
      salePriceFen: sale.minor, costUnknown: item.costSource === 'UNKNOWN' || item.upstreamCostFen == null,
      upstreamCostFen: Number(item.upstreamCostFen || 0), matchCount,
      settledFen: matchCount ? Number(item.settledFen || 0) : 0,
      settledCurrencies: matchCount ? String(item.settledCurrencies || '').split(',').map((value) => value.trim()).filter(Boolean) : [],
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
