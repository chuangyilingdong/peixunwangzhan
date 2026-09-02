import { errors, id, nowIso, q, row, transaction } from '../lib.js';

const ADJUSTMENT_TYPES = new Set(['ORG_ADJUSTMENT_IN', 'ORG_ADJUSTMENT_OUT']);
const REVERSAL_TYPES = new Set(['REFUND', 'REVERSAL']);
const NON_LEDGER_TYPES = new Set(['FROZEN_HOLD', 'FROZEN_RELEASE']);

function requireOrgBilling(orgId) {
  q('INSERT OR IGNORE INTO org_billing_accounts(org_id) VALUES (?)', [orgId]);
  return row('SELECT * FROM org_billing_accounts WHERE org_id=?', [orgId]);
}

function positiveInteger(value, { min = 1, max = 100000000, label = '积分' } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || !Number.isFinite(n) || n < min || n > max) throw errors.badRequest(label + '必须是有效整数', 'INVALID_CREDITS');
  return n;
}

export function normalizeEntry(value) {
  if (!value) return null;
  return {
    id: value.id,
    orgId: value.org_id || null,
    direction: value.direction,
    type: value.type,
    credits: Number(value.credits || 0),
    balanceAfter: Number(value.balance_after || 0),
    modality: value.modality || null,
    model: value.model || null,
    userId: value.user_id || null,
    sessionId: value.class_session_id || null,
    projectId: value.project_id || null,
    workId: value.work_id || null,
    relatedOrderId: value.related_order_id || null,
    relatedSubmissionId: value.related_submission_id || null,
    reversalOf: value.reversal_of || null,
    status: value.status,
    reason: value.reason || null,
    actorId: value.actor_id || null,
    createdAt: value.created_at,
  };
}

export function insertCreditEntry({
  orgId, direction, type, credits, balanceAfter, modality = null, model = null, userId = null,
  sessionId = null, projectId = null, workId = null, relatedOrderId = null, relatedSubmissionId = null,
  status = 'EFFECTIVE', reversalOf = null, reason = null, actorId = null, createdAt = nowIso(),
}) {
  const entryId = id('credit');
  q(
    `INSERT INTO credit_entries(
      id,org_id,direction,type,credits,balance_after,modality,model,user_id,class_session_id,project_id,work_id,
      related_order_id,related_submission_id,status,reversal_of,reason,actor_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      entryId, orgId, direction, type, credits, balanceAfter, modality, model, userId, sessionId, projectId, workId,
      relatedOrderId, relatedSubmissionId, status, reversalOf, reason ? String(reason).trim().slice(0, 500) : null, actorId, createdAt,
    ],
  );
  return entryId;
}

function requireReason(reason, code, label) {
  const value = String(reason || '').trim();
  if (!value) throw errors.badRequest(label + '原因必填', code);
  if (value.length > 500) throw errors.badRequest(label + '原因不能超过 500 字', code + '_TOO_LONG');
  return value;
}

function adjustAccount({ orgId, signedCredits, income = false, spend = false }) {
  const result = q(
    `UPDATE org_billing_accounts
     SET credit_balance=credit_balance+?,total_credits_in=total_credits_in+?,total_credits_spent=total_credits_spent+?,updated_version=updated_version+1
     WHERE org_id=? AND credit_balance+? >= 0`,
    [signedCredits, income ? Math.abs(signedCredits) : 0, spend ? Math.abs(signedCredits) : 0, orgId, signedCredits],
  );
  if (!result.changes) throw errors.conflict('机构积分不足，禁止透支', 'INSUFFICIENT_CREDITS');
  return row('SELECT credit_balance,frozen_credits FROM org_billing_accounts WHERE org_id=?', [orgId]);
}

export function adjustCredits({ orgId, type, credits, reason, actorId }) {
  if (!ADJUSTMENT_TYPES.has(type)) throw errors.badRequest('人工账务类型无效', 'INVALID_CREDIT_ADJUSTMENT_TYPE');
  const amount = positiveInteger(credits);
  const normalizedReason = requireReason(reason, 'ADJUSTMENT_REASON_REQUIRED', '人工调整');
  return transaction(() => {
    requireOrgBilling(orgId);
    const direction = type === 'ORG_ADJUSTMENT_IN' ? 'IN' : 'OUT';
    const signed = direction === 'IN' ? amount : -amount;
    const account = adjustAccount({ orgId, signedCredits: signed, income: direction === 'IN', spend: direction === 'OUT' });
    const entryId = insertCreditEntry({
      orgId, direction, type, credits: amount, balanceAfter: Number(account.credit_balance), reason: normalizedReason, actorId,
    });
    return { entryId, balanceAfter: Number(account.credit_balance), entry: normalizeEntry(row('SELECT * FROM credit_entries WHERE id=?', [entryId])) };
  });
}

export function refundOrReverseEntry({ orgId, sourceEntryId, reason, actorId, mode }) {
  if (!REVERSAL_TYPES.has(mode)) throw errors.badRequest('账务冲销类型无效', 'INVALID_CREDIT_ACTION');
  const normalizedReason = requireReason(reason, mode === 'REFUND' ? 'REFUND_REASON_REQUIRED' : 'REVERSAL_REASON_REQUIRED', mode === 'REFUND' ? '退款' : '冲正');
  return transaction(() => {
    const source = row('SELECT * FROM credit_entries WHERE id=? AND org_id=?', [sourceEntryId, orgId]);
    if (!source) throw errors.notFound('源积分流水不存在', 'CREDIT_ENTRY_NOT_FOUND');
    if (source.status !== 'EFFECTIVE') throw errors.conflict('源流水已被处理，不能重复冲销', 'CREDIT_ENTRY_ALREADY_VOIDED');
    const duplicate = row('SELECT id FROM credit_entries WHERE reversal_of=?', [source.id]);
    if (duplicate) throw errors.conflict('源流水已有冲销记录', 'CREDIT_ENTRY_ALREADY_REVERSED');
    if (NON_LEDGER_TYPES.has(source.type)) throw errors.conflict('冻结留痕不参与账务冲销', 'CREDIT_ENTRY_NOT_REVERSIBLE');
    const sourceCredits = Number(source.credits || 0);
    if (!Number.isInteger(sourceCredits) || sourceCredits <= 0) throw errors.conflict('源流水金额无效，无法冲销', 'CREDIT_ENTRY_INVALID_AMOUNT');
    requireOrgBilling(orgId);
    const direction = source.direction === 'IN' ? 'OUT' : 'IN';
    const signed = direction === 'IN' ? sourceCredits : -sourceCredits;
    const account = adjustAccount({ orgId, signedCredits: signed, income: direction === 'IN', spend: direction === 'OUT' });
    q("UPDATE credit_entries SET status='VOIDED' WHERE id=? AND org_id=?", [source.id, orgId]);
    const entryId = insertCreditEntry({
      orgId, direction, type: mode === 'REFUND' ? (direction === 'IN' ? 'REFUND_IN' : 'REFUND_OUT') : 'REVERSAL',
      credits: sourceCredits, balanceAfter: Number(account.credit_balance), modality: source.modality, model: source.model,
      userId: source.user_id, sessionId: source.class_session_id, projectId: source.project_id, workId: source.work_id,
      relatedOrderId: source.related_order_id, relatedSubmissionId: source.related_submission_id,
      reversalOf: source.id, reason: normalizedReason, actorId,
    });
    return {
      entryId, sourceEntryId: source.id, balanceAfter: Number(account.credit_balance),
      entry: normalizeEntry(row('SELECT * FROM credit_entries WHERE id=?', [entryId])),
      sourceEntry: normalizeEntry(row('SELECT * FROM credit_entries WHERE id=?', [source.id])),
    };
  });
}

export function setFrozenCredits({ orgId, frozenCredits, reason, actorId }) {
  const target = positiveInteger(frozenCredits, { min: 0, max: 100000000, label: '冻结积分' });
  const normalizedReason = requireReason(reason, 'FROZEN_REASON_REQUIRED', '冻结');
  return transaction(() => {
    const account = requireOrgBilling(orgId);
    const currentFrozen = Number(account.frozen_credits || 0);
    if (target > Number(account.credit_balance || 0) + currentFrozen) throw errors.conflict('冻结积分不能超过机构总余额', 'FROZEN_CREDITS_EXCEEDED');
    const delta = target - currentFrozen;
    const result = q(
      'UPDATE org_billing_accounts SET frozen_credits=?,credit_balance=credit_balance-?,updated_version=updated_version+1 WHERE org_id=?',
      [target, delta, orgId],
    );
    if (!result.changes) throw errors.conflict('机构账务状态冲突，请刷新后重试', 'ORG_BILLING_CONFLICT');
    const updated = row('SELECT credit_balance,frozen_credits FROM org_billing_accounts WHERE org_id=?', [orgId]);
    let entryId = null;
    if (delta !== 0) {
      entryId = insertCreditEntry({
        orgId, direction: delta > 0 ? 'OUT' : 'IN', type: delta > 0 ? 'FROZEN_HOLD' : 'FROZEN_RELEASE',
        credits: Math.abs(delta), balanceAfter: Number(updated.credit_balance), reason: normalizedReason, actorId,
      });
    }
    return {
      entryId, frozenCredits: Number(updated.frozen_credits), balanceAfter: Number(updated.credit_balance),
      availableBalance: Number(updated.credit_balance),
      totalBalance: Number(updated.credit_balance) + Number(updated.frozen_credits),
      entry: entryId ? normalizeEntry(row('SELECT * FROM credit_entries WHERE id=?', [entryId])) : null,
    };
  });
}

// Atomic spend path shared by synchronous AI usage and generation settlement.
export function chargeCreditsInTransaction({ orgId, credits, type, modality = null, model = null, userId = null, sessionId = null, projectId = null, workId = null }) {
  const amount = positiveInteger(credits, { min: 0 });
  if (amount === 0) return { entryId: null, balanceAfter: Number(row('SELECT credit_balance FROM org_billing_accounts WHERE org_id=?', [orgId])?.credit_balance || 0), skipped: true };
  const result = q(
    `UPDATE org_billing_accounts
     SET credit_balance=credit_balance-?,total_credits_spent=total_credits_spent+?,updated_version=updated_version+1
     WHERE org_id=? AND credit_balance>=?`,
    [amount, amount, orgId, amount],
  );
  if (!result.changes) throw errors.forbidden('机构积分池不足', 'ORG_CREDIT_LIMIT');
  const account = row('SELECT credit_balance FROM org_billing_accounts WHERE org_id=?', [orgId]);
  const entryId = insertCreditEntry({
    orgId, direction: 'OUT', type: type || (modality ? 'AI_' + modality : 'AI_SPEND'), credits: amount,
    balanceAfter: Number(account.credit_balance), modality, model, userId, sessionId, projectId, workId,
  });
  return { entryId, balanceAfter: Number(account.credit_balance) };
}

export function chargeCredits(options) {
  return transaction(() => chargeCreditsInTransaction(options));
}

export function reserveCredits({ orgId, credits }) {
  const amount = positiveInteger(credits);
  return transaction(() => {
    const result = q(
      'UPDATE org_billing_accounts SET credit_balance=credit_balance-?,frozen_credits=frozen_credits+?,updated_version=updated_version+1 WHERE org_id=? AND credit_balance>=?',
      [amount, amount, orgId, amount],
    );
    if (!result.changes) throw errors.forbidden('机构积分池不足', 'ORG_CREDIT_LIMIT');
    const account = row('SELECT credit_balance,frozen_credits FROM org_billing_accounts WHERE org_id=?', [orgId]);
    return { availableBalance: Number(account.credit_balance), frozenCredits: Number(account.frozen_credits), totalBalance: Number(account.credit_balance) + Number(account.frozen_credits) };
  });
}

export function reconcileCredits(orgId) {
  const account = requireOrgBilling(orgId);
  const totals = row(
    `SELECT
      COALESCE(SUM(CASE WHEN direction='IN' AND status='EFFECTIVE' AND type NOT IN ('FROZEN_HOLD','FROZEN_RELEASE') AND reversal_of IS NULL THEN credits ELSE 0 END),0) credits_in,
      COALESCE(SUM(CASE WHEN direction='OUT' AND status='EFFECTIVE' AND type NOT IN ('FROZEN_HOLD','FROZEN_RELEASE') AND reversal_of IS NULL THEN credits ELSE 0 END),0) credits_out
    FROM credit_entries WHERE org_id=?`,
    [orgId],
  );
  const ledgerBalance = Number(totals.credits_in || 0) - Number(totals.credits_out || 0);
  const frozenCredits = Number(account.frozen_credits || 0);
  const availableBalance = Number(account.credit_balance || 0);
  const accountBalance = availableBalance + frozenCredits;
  const stats = row(
    `SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN type IN ('FROZEN_HOLD','FROZEN_RELEASE') THEN 1 ELSE 0 END),0) frozen_event_count,MAX(created_at) latest_at
     FROM credit_entries WHERE org_id=?`,
    [orgId],
  );
  return {
    accountBalance, frozenCredits, availableBalance, ledgerBalance,
    ledgerCreditsIn: Number(totals.credits_in || 0), ledgerCreditsOut: Number(totals.credits_out || 0),
    difference: accountBalance - ledgerBalance,
    balanced: accountBalance === ledgerBalance,
    entryCount: Number(stats.n || 0), frozenEventCount: Number(stats.frozen_event_count || 0), latestEntryAt: stats.latest_at || null,
    rule: '流水净额 = 可用余额 + 冻结积分；冻结留痕与已冲销流水的反向记录不计入收支净额。',
  };
}

export function hasSufficientCredits(orgId, credits) {
  const amount = positiveInteger(credits, { min: 0 });
  const account = row('SELECT credit_balance FROM org_billing_accounts WHERE org_id=?', [orgId]);
  return Number(account?.credit_balance || 0) >= amount;
}
