import { errors, row, rows } from '../lib.js';

const CURRENCY = /^[A-Z]{3}$/;
const text = (value) => String(value || '').trim();

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
  const items = raw.map((item) => {
    const matches = rows(`SELECT match.id,match.target_type targetType,match.target_id targetId,match.allocated_amount_minor amountMinor,
        match.currency,match.method,line.reconciliation_status reconciliationStatus,line.supplier_line_id supplierLineId
      FROM supplier_billing_matches match JOIN supplier_billing_lines line ON line.id=match.line_id
      WHERE match.cancelled_at IS NULL AND line.reconciliation_status NOT IN ('CANCELLED','EXCLUDED')
        AND ((match.target_type='ATTEMPT' AND match.target_id=?) OR (match.target_type='USAGE' AND match.target_id=?))
      ORDER BY match.created_at,match.id`, [item.id, item.internal_usage_record_id || '']);
    const currencies = [...new Set(matches.map((match) => match.currency))];
    return {
      id: item.id, callId: item.call_id, attempt: Number(item.attempt), createdAt: item.created_at,
      orgId: item.org_id || null, organizationName: item.organization_name || null,
      userId: item.user_id || null, studentName: item.student_name || null,
      seriesId: item.linked_series_id || null, sessionId: item.linked_session_id || null, lessonId: item.linked_lesson_id || null,
      modality: item.modality, channelId: item.channel_id || null, actualChannelId: item.actual_channel_id || null,
      provider: item.provider || null, model: item.model || null, status: item.status,
      costSource: item.cost_source, estimatedOrReportedMinor: item.upstream_cost_fen == null ? null : Number(item.upstream_cost_fen),
      costUnknown: item.cost_source === 'UNKNOWN' || item.upstream_cost_fen == null,
      clientRequestId: item.client_request_id || null, responseRequestId: item.response_request_id || null,
      responsePayloadId: item.response_payload_id || null, taskId: item.task_id || null,
      providerUsageId: item.usage_id || null, internalUsageRecordId: item.internal_usage_record_id || null,
      usageId: item.internal_usage_record_id || null, gatewayLogId: item.gateway_log_id || null,
      evidenceMatch: item.gateway_log_id || item.response_request_id || item.response_payload_id || item.task_id ? 'MATCHED' : item.internal_usage_record_id ? 'PARTIAL' : 'UNMATCHED',
      settledAmountMinor: matches.length && currencies.length === 1 ? matches.reduce((sum, match) => sum + Number(match.amountMinor), 0) : null,
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
