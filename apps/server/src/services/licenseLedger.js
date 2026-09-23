import { contractExpiryForOrg, errors, id, nowIso, q, row, rows, transaction, arow, aq, arows, atransaction } from '../lib.js';

export const LICENSE_PAYMENT_STATUSES = new Set(['UNPAID', 'PARTIAL', 'PAID', 'REFUNDED']);

function requiredText(value, label, { max = 200 } = {}) {
  const text = String(value || '').trim();
  if (!text) throw errors.badRequest(`${label}不能为空`, 'LICENSE_PURCHASE_FIELDS_REQUIRED');
  if (text.length > max) throw errors.badRequest(`${label}不能超过${max}个字符`, 'VALIDATION_ERROR');
  return text;
}

function purchaseSnapshot(batch) {
  return {
    id: batch.id,
    assignmentId: batch.assignment_id,
    orgId: batch.org_id,
    seriesId: batch.series_id,
    purchaseType: batch.purchase_type,
    quantity: Number(batch.quantity),
    amountMinor: batch.amount_minor == null ? null : Number(batch.amount_minor),
    currency: batch.currency || null,
    paymentStatus: batch.payment_status,
    status: batch.status,
    orderNo: batch.order_no || null,
    contractNo: batch.contract_no || null,
    idempotencyKey: batch.idempotency_key,
    purchasedBy: batch.purchased_by || null,
    purchasedAt: batch.purchased_at,
    createdAt: batch.created_at,
  };
}

export function normalizeLicensePurchaseInput(value, quantity) {
  const amountMinor = Number(value?.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw errors.badRequest('请输入有效的实际成交总额（最小货币单位）', 'INVALID_LICENSE_PURCHASE_AMOUNT');
  }
  const currency = requiredText(value?.currency, '币种', { max: 3 }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw errors.badRequest('币种必须为三位字母代码', 'INVALID_LICENSE_PURCHASE_CURRENCY');
  const paymentStatus = requiredText(value?.paymentStatus, '收款状态', { max: 30 }).toUpperCase();
  if (!LICENSE_PAYMENT_STATUSES.has(paymentStatus)) throw errors.badRequest('收款状态无效', 'INVALID_LICENSE_PAYMENT_STATUS');
  if (paymentStatus !== 'PAID') throw errors.conflict('只有已收款购买才能增加授权次数', 'LICENSE_PURCHASE_NOT_PAID');
  return {
    quantity,
    amountMinor,
    currency,
    paymentStatus,
    orderNo: requiredText(value?.orderNo, '订单号'),
    contractNo: requiredText(value?.contractNo, '合同号'),
    idempotencyKey: requiredText(value?.idempotencyKey, '幂等键', { max: 200 }),
  };
}

export async function appendLicensePurchase({ seriesId, orgId, additionalQuota, actorId, ...input }) {
  const quantity = Number(additionalQuota);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000000) throw errors.badRequest('追加次数无效', 'VALIDATION_ERROR');
  const purchase = normalizeLicensePurchaseInput(input, quantity);
  return await atransaction(async () => {
    const series = await arow("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [String(seriesId || '')]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    if (series.status !== 'PUBLISHED') throw errors.conflict('仅已发布课包可购买授权', 'COURSE_NOT_PUBLISHED');
    if (!await arow('SELECT id FROM organizations WHERE id=?', [String(orgId || '')])) throw errors.notFound('机构不存在', 'ORG_NOT_FOUND');
    const existing = await arow('SELECT * FROM course_assignments WHERE series_id=? AND org_id=?', [series.id, orgId]);
    const assignmentId = existing?.id || id('assign');
    const now = nowIso();
    const batch = await createLicensePurchaseBatch({ assignmentId, orgId, seriesId: series.id, actorId, purchasedAt: now, ...purchase });
    if (!batch.replayed) {
      const reserved = Number((await arow("SELECT COALESCE(SUM(CASE WHEN status='ACTIVE' THEN quota_total ELSE quota_used END),0) n FROM course_assignments WHERE series_id=?", [series.id]))?.n || 0);
      if (reserved + quantity > Number(series.stock_total || 0)) throw errors.conflict('课包可分配库存不足', 'COURSE_QUOTA_EXCEEDS_STOCK');
      if (existing) {
        const baseQuota = Number(existing.status === 'ACTIVE' ? existing.quota_total : existing.quota_used);
        await aq("UPDATE course_assignments SET status='ACTIVE',assigned_by=?,assigned_at=?,quota_total=? WHERE id=?", [actorId, now, baseQuota + quantity, existing.id]);
      } else {
        const expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();
        await aq("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at,expires_at,quota_total,quota_used) VALUES (?,?,?,?,?,?,?,?,0)", [assignmentId, series.id, orgId, 'ACTIVE', actorId, now, expiresAt, quantity]);
      }
    }
    const assignment = await arow('SELECT * FROM course_assignments WHERE id=?', [assignmentId]);
    return { batch, replayed: Boolean(batch.replayed), assignment: { id: assignment.id, orgId: assignment.org_id, seriesId: assignment.series_id, status: assignment.status, quotaTotal: Number(assignment.quota_total), quotaUsed: Number(assignment.quota_used), remaining: Math.max(0, Number(assignment.quota_total) - Number(assignment.quota_used)), expiresAt: assignment.expires_at || null } };
  });
}

export async function createLicensePurchaseBatch({ assignmentId, orgId, seriesId, actorId, purchasedAt, ...purchase }) {
  if (purchase.paymentStatus !== 'PAID') {
    throw errors.conflict('只有已收款购买才能增加授权次数', 'LICENSE_PURCHASE_NOT_PAID');
  }
  const existing = await arow('SELECT * FROM license_purchase_batches WHERE idempotency_key=?', [purchase.idempotencyKey]);
  if (existing) {
    const same = existing.assignment_id === assignmentId
      && existing.org_id === orgId
      && existing.series_id === seriesId
      && Number(existing.quantity) === purchase.quantity
      && Number(existing.amount_minor) === purchase.amountMinor
      && existing.currency === purchase.currency
      && existing.payment_status === purchase.paymentStatus
      && existing.order_no === purchase.orderNo
      && existing.contract_no === purchase.contractNo;
    if (!same) throw errors.conflict('幂等键已用于另一笔购买', 'LICENSE_PURCHASE_IDEMPOTENCY_CONFLICT');
    return { ...purchaseSnapshot(existing), replayed: true };
  }
  const now = purchasedAt || nowIso();
  const batchId = id('licensepurchase');
  await aq(`INSERT INTO license_purchase_batches(
      id,assignment_id,org_id,series_id,purchase_type,quantity,amount_minor,currency,payment_status,status,
      order_no,contract_no,idempotency_key,purchased_by,purchased_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?,?,?)`, [
    batchId, assignmentId, orgId, seriesId, 'PURCHASE', purchase.quantity, purchase.amountMinor,
    purchase.currency, purchase.paymentStatus, purchase.orderNo, purchase.contractNo, purchase.idempotencyKey,
    actorId || null, now, now,
  ]);
  return purchaseSnapshot(await arow('SELECT * FROM license_purchase_batches WHERE id=?', [batchId]));
}

async function nextFifoUnit(assignmentId) {
  const batches = await arows(`SELECT batch.*,
      COALESCE(SUM(allocation.quantity),0) allocated_quantity,
      SUM(allocation.amount_minor) recognized_amount_minor
    FROM license_purchase_batches batch
    LEFT JOIN license_revenue_allocations allocation ON allocation.purchase_batch_id=batch.id
    WHERE batch.assignment_id=? AND batch.status='ACTIVE'
      AND (batch.payment_status='PAID' OR batch.purchase_type='LEGACY_OPENING_BALANCE')
    GROUP BY batch.id
    HAVING COALESCE(SUM(allocation.quantity),0) < batch.quantity
    ORDER BY batch.purchased_at, batch.created_at, batch.id
    LIMIT 1`, [assignmentId]);
  const batch = batches[0];
  if (!batch) throw errors.conflict('购买批次余额不足，无法确认收入', 'LICENSE_PURCHASE_BALANCE_EXHAUSTED');
  const allocated = Number(batch.allocated_quantity || 0);
  let amountMinor = null;
  if (batch.amount_minor != null) {
    const base = Math.floor(Number(batch.amount_minor) / Number(batch.quantity));
    amountMinor = allocated === Number(batch.quantity) - 1
      ? Number(batch.amount_minor) - Number(batch.recognized_amount_minor || 0)
      : base;
  }
  return { batch, amountMinor };
}

export async function appendLicenseGrantRevenue({ assignmentId, orgId, seriesId, grantId, actorId, occurredAt, idempotencyKey }) {
  const key = idempotencyKey || `license-grant:${grantId}:${occurredAt}`;
  const existing = await arow("SELECT * FROM license_revenue_events WHERE idempotency_key=? AND event_type='GRANT'", [key]);
  if (existing) return existing;
  const { batch, amountMinor } = await nextFifoUnit(assignmentId);
  const now = occurredAt || nowIso();
  const eventId = id('licenserevenue');
  await aq(`INSERT INTO license_revenue_events(
      id,assignment_id,org_id,series_id,grant_id,event_type,quantity,amount_minor,currency,reversal_of_event_id,
      idempotency_key,actor_id,occurred_at,created_at)
    VALUES (?,?,?,?,?,'GRANT',1,?,?,NULL,?,?,?,?)`, [
    eventId, assignmentId, orgId, seriesId, grantId, amountMinor, batch.currency,
    key, actorId || null, now, now,
  ]);
  await aq(`INSERT INTO license_revenue_allocations(
      id,revenue_event_id,purchase_batch_id,quantity,amount_minor,currency,created_at)
    VALUES (?,?,?,1,?,?,?)`, [id('licenseallocation'), eventId, batch.id, amountMinor, batch.currency, now]);
  return await arow('SELECT * FROM license_revenue_events WHERE id=?', [eventId]);
}

export async function appendLicenseReversal({ grantId, actorId, occurredAt, idempotencyKey }) {
  if (idempotencyKey) {
    const existing = await arow("SELECT * FROM license_revenue_events WHERE idempotency_key=? AND event_type='REVERSAL'", [idempotencyKey]);
    if (existing) {
      if (existing.grant_id !== grantId) throw errors.conflict('幂等键已用于另一笔许可冲销', 'LICENSE_REVERSAL_IDEMPOTENCY_CONFLICT');
      return existing;
    }
  }
  const grantEvent = await arow(`SELECT event.* FROM license_revenue_events event
    LEFT JOIN license_revenue_events reversal ON reversal.reversal_of_event_id=event.id
    WHERE event.grant_id=? AND event.event_type='GRANT' AND reversal.id IS NULL
    ORDER BY event.occurred_at DESC, event.created_at DESC, event.id DESC LIMIT 1`, [grantId]);
  if (!grantEvent) throw errors.conflict('找不到可冲销的许可收入事件', 'LICENSE_GRANT_REVENUE_NOT_FOUND');
  const key = idempotencyKey || `license-reversal:${grantEvent.id}`;
  const allocation = await arow('SELECT * FROM license_revenue_allocations WHERE revenue_event_id=?', [grantEvent.id]);
  if (!allocation) throw errors.conflict('许可收入缺少购买批次分摊', 'LICENSE_REVENUE_ALLOCATION_NOT_FOUND');
  const now = occurredAt || nowIso();
  const eventId = id('licenserevenue');
  const amountMinor = grantEvent.amount_minor == null ? null : -Number(grantEvent.amount_minor);
  await aq(`INSERT INTO license_revenue_events(
      id,assignment_id,org_id,series_id,grant_id,event_type,quantity,amount_minor,currency,reversal_of_event_id,
      idempotency_key,actor_id,occurred_at,created_at)
    VALUES (?,?,?,?,?,'REVERSAL',-1,?,?,?,?,?,?,?)`, [
    eventId, grantEvent.assignment_id, grantEvent.org_id, grantEvent.series_id, grantId, amountMinor,
    grantEvent.currency, grantEvent.id, key, actorId || null, now, now,
  ]);
  await aq(`INSERT INTO license_revenue_allocations(
      id,revenue_event_id,purchase_batch_id,quantity,amount_minor,currency,created_at)
    VALUES (?,?,?,-1,?,?,?)`, [
    id('licenseallocation'), eventId, allocation.purchase_batch_id,
    allocation.amount_minor == null ? null : -Number(allocation.amount_minor), allocation.currency, now,
  ]);
  return await arow('SELECT * FROM license_revenue_events WHERE id=?', [eventId]);
}

export async function voidLicensePurchaseBatches(assignmentId) {
  await aq("UPDATE license_purchase_batches SET status='VOIDED' WHERE assignment_id=? AND status='ACTIVE'", [assignmentId]);
}

export async function licensePurchaseHistory(assignmentId) {
  return (await arows(`SELECT batch.*, COALESCE(SUM(allocation.quantity),0) recognized_quantity,
      SUM(allocation.amount_minor) recognized_amount_minor
    FROM license_purchase_batches batch
    LEFT JOIN license_revenue_allocations allocation ON allocation.purchase_batch_id=batch.id
    WHERE batch.assignment_id=?
    GROUP BY batch.id
    ORDER BY batch.purchased_at DESC, batch.created_at DESC, batch.id DESC`, [assignmentId])).map((batch) => ({
    ...purchaseSnapshot(batch),
    recognizedQuantity: Number(batch.recognized_quantity || 0),
    remainingQuantity: Math.max(0, Number(batch.quantity) - Number(batch.recognized_quantity || 0)),
    recognizedAmountMinor: batch.recognized_amount_minor == null ? null : Number(batch.recognized_amount_minor),
  }));
}
