// P4-A06 计费与模型配置后台
// 提供：模态开关/单价、积分限额、预警阈值、机构级覆盖、变更审计
import {
  audit,
  errors,
  nowIso,
  q,
  requireRole,
  row,
  rows,
  transaction,
} from '../lib.js';
import { randomUUID } from 'node:crypto';

const VALID_MODALITIES = new Set(['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING', 'CANVAS']);
const VALID_QUOTA_SCOPES = new Set(['GLOBAL', 'STUDENT', 'TEACHER']);
const VALID_PERIODS = new Set(['DAY', 'MONTH']);
const VALID_ALERT_TYPES = new Set(['BALANCE_LOW', 'CONSUMPTION_SPIKE', 'QUOTA_EXCEEDED']);
const CONFIG_TYPES = new Set(['MODALITY_SETTING', 'CREDIT_QUOTA', 'ALERT_THRESHOLD', 'ORG_OVERRIDE']);

function integer(value, label, { min = 0, max = 1000000, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw errors.badRequest(`${label} 必须是整数`, 'INVALID_INTEGER');
  if (n < min) throw errors.badRequest(`${label} 不能小于 ${min}`, 'INTEGER_TOO_SMALL');
  if (n > max) throw errors.badRequest(`${label} 不能超过 ${max}`, 'INTEGER_TOO_LARGE');
  return n;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function nonEmptyString(value, label, { max = 200 } = {}) {
  const s = String(value || '').trim();
  if (!s) throw errors.badRequest(`${label} 必填`, 'FIELD_REQUIRED');
  if (s.length > max) throw errors.badRequest(`${label} 长度不能超过 ${max}`, 'FIELD_TOO_LONG');
  return s;
}

function logChange(configType, recordId, fieldName, oldValue, newValue, actorId, reason) {
  q(
    'INSERT INTO platform_config_change_logs(id,config_type,record_id,field_name,old_value,new_value,changed_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [`ccl_${randomUUID().replace(/-/g, '').slice(0, 20)}`, configType, recordId, fieldName, String(oldValue ?? ''), String(newValue ?? ''), actorId, reason || '', nowIso()],
  );
}

function normalizeModality(value) {
  if (!value) return null;
  return {
    id: value.id,
    modality: value.modality,
    enabled: !!value.enabled,
    unitCost: Number(value.unit_cost),
    displayName: value.display_name,
    description: value.description || '',
    sortOrder: Number(value.sort_order),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function normalizeQuota(value) {
  if (!value) return null;
  return {
    id: value.id,
    scope: value.scope,
    period: value.period,
    dailyLimit: Number(value.daily_limit),
    monthlyLimit: Number(value.monthly_limit),
    note: value.note || '',
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function normalizeAlert(value) {
  if (!value) return null;
  return {
    id: value.id,
    alertType: value.alert_type,
    threshold: Number(value.threshold),
    notifyEmail: value.notify_email || '',
    enabled: !!value.enabled,
    note: value.note || '',
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function normalizeOrgOverride(value) {
  if (!value) return null;
  return {
    id: value.id,
    orgId: value.org_id,
    modality: value.modality,
    enabled: !!value.enabled,
    reason: value.reason || '',
    createdBy: value.created_by,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function normalizeChangeLog(value) {
  if (!value) return null;
  return {
    id: value.id,
    configType: value.config_type,
    recordId: value.record_id,
    fieldName: value.field_name,
    oldValue: value.old_value,
    newValue: value.new_value,
    changedBy: value.changed_by,
    reason: value.reason || '',
    createdAt: value.created_at,
  };
}

/**
 * 平台级模态开关与单价查询（公开给 org/student，用于按需读取）
 */
export function getModalitySettings() {
  return rows('SELECT * FROM platform_modality_settings ORDER BY sort_order ASC, modality ASC').map(normalizeModality);
}

export function getModalitySetting(modality) {
  const m = String(modality || '').toUpperCase();
  if (!VALID_MODALITIES.has(m)) return null;
  return normalizeModality(row('SELECT * FROM platform_modality_settings WHERE modality=?', [m]));
}

export function getQuotas() {
  return rows('SELECT * FROM platform_credit_quotas ORDER BY scope ASC').map(normalizeQuota);
}

export function getAlerts() {
  return rows('SELECT * FROM platform_alert_thresholds ORDER BY alert_type ASC').map(normalizeAlert);
}

export function getOrgOverrides(orgId) {
  if (!orgId) return [];
  return rows('SELECT * FROM org_capability_overrides WHERE org_id=? ORDER BY modality ASC', [orgId]).map(normalizeOrgOverride);
}

/**
 * 检查指定机构 / 模态是否启用。
 * 优先级：机构覆盖 > 平台开关。
 * 返回 { enabled, source: 'OVERRIDE' | 'PLATFORM' | 'UNKNOWN' }
 */
export function isModalityEnabled(orgId, modality) {
  const m = String(modality || '').toUpperCase();
  const override = orgId ? row('SELECT enabled, reason FROM org_capability_overrides WHERE org_id=? AND modality=?', [orgId, m]) : null;
  if (override) return { enabled: !!override.enabled, source: 'OVERRIDE', reason: override.reason || '' };
  const setting = getModalitySetting(m);
  if (!setting) return { enabled: false, source: 'UNKNOWN' };
  return { enabled: setting.enabled, source: 'PLATFORM' };
}

export async function handleAdminBillingConfig(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/admin/billing-config')) return null;
  // billing-config 独立路由，由本模块处理，adminOrg 通用路由不需要拦截
  const part = pathname.slice('/api/admin'.length);

  // 模态设置
  if (part === '/billing-config/modalities' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { items: getModalitySettings() };
  }
  const modMatch = part.match(/^\/billing-config\/modalities\/([^/]+)$/);
  if (modMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const modality = String(modMatch[1]).toUpperCase();
    if (!VALID_MODALITIES.has(modality)) throw errors.badRequest('modality 无效', 'INVALID_MODALITY');
    const existing = row('SELECT * FROM platform_modality_settings WHERE modality=?', [modality]);
    if (!existing) throw errors.notFound('模态不存在', 'MODALITY_NOT_FOUND');
    const body = ctx.body || {};
    const updates = [];
    const newEnabled = body.enabled === undefined ? (existing.enabled ? 1 : 0) : (bool(body.enabled) ? 1 : 0);
    const newUnitCost = body.unitCost === undefined ? Number(existing.unit_cost) : integer(body.unitCost, 'unitCost', { min: 0, max: 100 });
    const newDisplayName = body.displayName === undefined ? existing.display_name : nonEmptyString(body.displayName, 'displayName', { max: 100 });
    const newDescription = body.description === undefined ? existing.description : String(body.description || '').slice(0, 1000);
    const newSortOrder = body.sortOrder === undefined ? Number(existing.sort_order) : integer(body.sortOrder, 'sortOrder', { min: 0, max: 1000 });
    const reason = body.reason ? String(body.reason).trim().slice(0, 500) : '';
    const now = nowIso();
    if (newEnabled !== existing.enabled) { logChange('MODALITY_SETTING', existing.id, 'enabled', existing.enabled, newEnabled, auth.user.id, reason); updates.push(['enabled', newEnabled]); }
    if (newUnitCost !== Number(existing.unit_cost)) { logChange('MODALITY_SETTING', existing.id, 'unitCost', existing.unit_cost, newUnitCost, auth.user.id, reason); updates.push(['unit_cost', newUnitCost]); }
    if (newDisplayName !== existing.display_name) { logChange('MODALITY_SETTING', existing.id, 'displayName', existing.display_name, newDisplayName, auth.user.id, reason); updates.push(['display_name', newDisplayName]); }
    if (newDescription !== existing.description) { logChange('MODALITY_SETTING', existing.id, 'description', existing.description, newDescription, auth.user.id, reason); updates.push(['description', newDescription]); }
    if (newSortOrder !== Number(existing.sort_order)) { logChange('MODALITY_SETTING', existing.id, 'sortOrder', existing.sort_order, newSortOrder, auth.user.id, reason); updates.push(['sort_order', newSortOrder]); }
    if (!updates.length) return normalizeModality(existing);
    const setClauses = updates.map(([k]) => `${k}=?`).join(', ');
    const values = updates.map(([, v]) => v);
    q(`UPDATE platform_modality_settings SET ${setClauses}, updated_at=? WHERE id=?`, [...values, now, existing.id]);
    audit(ctx, 'BILLING_CONFIG_MODALITY_UPDATE', 'PLATFORM_MODALITY_SETTING', existing.id, { modality, before: existing, after: { enabled: newEnabled, unitCost: newUnitCost, displayName: newDisplayName } }, { reason });
    return normalizeModality(row('SELECT * FROM platform_modality_settings WHERE id=?', [existing.id]));
  }

  // 积分限额
  if (part === '/billing-config/quotas' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { items: getQuotas() };
  }
  const quotaMatch = part.match(/^\/billing-config\/quotas\/([^/]+)$/);
  if (quotaMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const scope = String(quotaMatch[1]).toUpperCase();
    if (!VALID_QUOTA_SCOPES.has(scope)) throw errors.badRequest('scope 无效', 'INVALID_QUOTA_SCOPE');
    const existing = row('SELECT * FROM platform_credit_quotas WHERE scope=?', [scope]);
    if (!existing) throw errors.notFound('限额不存在', 'QUOTA_NOT_FOUND');
    const body = ctx.body || {};
    const period = body.period === undefined ? existing.period : String(body.period).toUpperCase();
    if (!VALID_PERIODS.has(period)) throw errors.badRequest('period 无效', 'INVALID_PERIOD');
    const dailyLimit = body.dailyLimit === undefined ? Number(existing.daily_limit) : integer(body.dailyLimit, 'dailyLimit', { min: -1, max: 100000000 });
    const monthlyLimit = body.monthlyLimit === undefined ? Number(existing.monthly_limit) : integer(body.monthlyLimit, 'monthlyLimit', { min: -1, max: 100000000 });
    const note = body.note === undefined ? existing.note : String(body.note || '').slice(0, 500);
    const reason = body.reason ? String(body.reason).trim().slice(0, 500) : '';
    const updates = [];
    if (period !== existing.period) { logChange('CREDIT_QUOTA', existing.id, 'period', existing.period, period, auth.user.id, reason); updates.push(['period', period]); }
    if (dailyLimit !== Number(existing.daily_limit)) { logChange('CREDIT_QUOTA', existing.id, 'dailyLimit', existing.daily_limit, dailyLimit, auth.user.id, reason); updates.push(['daily_limit', dailyLimit]); }
    if (monthlyLimit !== Number(existing.monthly_limit)) { logChange('CREDIT_QUOTA', existing.id, 'monthlyLimit', existing.monthly_limit, monthlyLimit, auth.user.id, reason); updates.push(['monthly_limit', monthlyLimit]); }
    if (note !== existing.note) { logChange('CREDIT_QUOTA', existing.id, 'note', existing.note, note, auth.user.id, reason); updates.push(['note', note]); }
    if (!updates.length) return normalizeQuota(existing);
    const setClauses = updates.map(([k]) => `${k}=?`).join(', ');
    q(`UPDATE platform_credit_quotas SET ${setClauses}, updated_at=? WHERE id=?`, [...updates.map(([, v]) => v), nowIso(), existing.id]);
    audit(ctx, 'BILLING_CONFIG_QUOTA_UPDATE', 'PLATFORM_CREDIT_QUOTA', existing.id, { scope, before: existing, after: { period, dailyLimit, monthlyLimit, note } }, { reason });
    return normalizeQuota(row('SELECT * FROM platform_credit_quotas WHERE id=?', [existing.id]));
  }

  // 预警阈值
  if (part === '/billing-config/alerts' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { items: getAlerts() };
  }
  const alertMatch = part.match(/^\/billing-config\/alerts\/([^/]+)$/);
  if (alertMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const alertType = String(alertMatch[1]).toUpperCase();
    if (!VALID_ALERT_TYPES.has(alertType)) throw errors.badRequest('alertType 无效', 'INVALID_ALERT_TYPE');
    const existing = row('SELECT * FROM platform_alert_thresholds WHERE alert_type=?', [alertType]);
    if (!existing) throw errors.notFound('预警不存在', 'ALERT_NOT_FOUND');
    const body = ctx.body || {};
    const threshold = body.threshold === undefined ? Number(existing.threshold) : integer(body.threshold, 'threshold', { min: 0, max: 100000000 });
    const notifyEmail = body.notifyEmail === undefined ? existing.notify_email : String(body.notifyEmail || '').trim().slice(0, 200);
    if (notifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) throw errors.badRequest('notifyEmail 格式无效', 'INVALID_EMAIL');
    const enabled = body.enabled === undefined ? (existing.enabled ? 1 : 0) : (bool(body.enabled) ? 1 : 0);
    const note = body.note === undefined ? existing.note : String(body.note || '').slice(0, 500);
    const reason = body.reason ? String(body.reason).trim().slice(0, 500) : '';
    const updates = [];
    if (threshold !== Number(existing.threshold)) { logChange('ALERT_THRESHOLD', existing.id, 'threshold', existing.threshold, threshold, auth.user.id, reason); updates.push(['threshold', threshold]); }
    if (notifyEmail !== existing.notify_email) { logChange('ALERT_THRESHOLD', existing.id, 'notifyEmail', existing.notify_email, notifyEmail, auth.user.id, reason); updates.push(['notify_email', notifyEmail]); }
    if (enabled !== existing.enabled) { logChange('ALERT_THRESHOLD', existing.id, 'enabled', existing.enabled, enabled, auth.user.id, reason); updates.push(['enabled', enabled]); }
    if (note !== existing.note) { logChange('ALERT_THRESHOLD', existing.id, 'note', existing.note, note, auth.user.id, reason); updates.push(['note', note]); }
    if (!updates.length) return normalizeAlert(existing);
    const setClauses = updates.map(([k]) => `${k}=?`).join(', ');
    q(`UPDATE platform_alert_thresholds SET ${setClauses}, updated_at=? WHERE id=?`, [...updates.map(([, v]) => v), nowIso(), existing.id]);
    audit(ctx, 'BILLING_CONFIG_ALERT_UPDATE', 'PLATFORM_ALERT_THRESHOLD', existing.id, { alertType, before: existing, after: { threshold, notifyEmail, enabled, note } }, { reason });
    return normalizeAlert(row('SELECT * FROM platform_alert_thresholds WHERE id=?', [existing.id]));
  }

  // 机构级覆盖
  if (part === '/billing-config/org-overrides' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const orgId = String(ctx.search.get('orgId') || '').trim();
    const items = orgId
      ? rows('SELECT * FROM org_capability_overrides WHERE org_id=? ORDER BY org_id, modality', [orgId]).map(normalizeOrgOverride)
      : rows('SELECT * FROM org_capability_overrides ORDER BY org_id, modality').map(normalizeOrgOverride);
    return { items, total: items.length };
  }
  if (part === '/billing-config/org-overrides' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const body = ctx.body || {};
    const orgId = nonEmptyString(body.orgId, 'orgId', { max: 60 });
    if (!row('SELECT id FROM organizations WHERE id=?', [orgId])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    const modality = String(body.modality || '').toUpperCase();
    if (!VALID_MODALITIES.has(modality)) throw errors.badRequest('modality 无效', 'INVALID_MODALITY');
    const enabled = body.enabled === undefined ? 1 : (bool(body.enabled) ? 1 : 0);
    const reason = String(body.reason || '').trim().slice(0, 500);
    const existing = row('SELECT * FROM org_capability_overrides WHERE org_id=? AND modality=?', [orgId, modality]);
    const now = nowIso();
    if (existing) {
      q("UPDATE org_capability_overrides SET enabled=?, reason=?, updated_at=? WHERE id=?", [enabled, reason, now, existing.id]);
      logChange('ORG_OVERRIDE', existing.id, 'enabled', existing.enabled, enabled, auth.user.id, reason);
      logChange('ORG_OVERRIDE', existing.id, 'reason', existing.reason || '', reason, auth.user.id, reason);
      audit(ctx, 'BILLING_CONFIG_ORG_OVERRIDE_UPDATE', 'ORG_CAPABILITY_OVERRIDE', existing.id, { before: existing, after: { enabled, reason } }, { orgId });
      return normalizeOrgOverride(row('SELECT * FROM org_capability_overrides WHERE id=?', [existing.id]));
    }
    const id = `orgov_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    q('INSERT INTO org_capability_overrides(id,org_id,modality,enabled,reason,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, orgId, modality, enabled, reason, auth.user.id, now, now]);
    logChange('ORG_OVERRIDE', id, 'create', '', JSON.stringify({ orgId, modality, enabled }), auth.user.id, reason);
    audit(ctx, 'BILLING_CONFIG_ORG_OVERRIDE_CREATE', 'ORG_CAPABILITY_OVERRIDE', id, null, { orgId, modality, enabled, reason });
    return normalizeOrgOverride(row('SELECT * FROM org_capability_overrides WHERE id=?', [id]));
  }
  const ovrMatch = part.match(/^\/billing-config\/org-overrides\/([^/]+)$/);
  if (ovrMatch && method === 'DELETE') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const target = row('SELECT * FROM org_capability_overrides WHERE id=?', [ovrMatch[1]]);
    if (!target) throw errors.notFound('覆盖不存在', 'ORG_OVERRIDE_NOT_FOUND');
    q('DELETE FROM org_capability_overrides WHERE id=?', [target.id]);
    logChange('ORG_OVERRIDE', target.id, 'delete', JSON.stringify({ orgId: target.org_id, modality: target.modality, enabled: target.enabled }), '', auth.user.id, '');
    audit(ctx, 'BILLING_CONFIG_ORG_OVERRIDE_DELETE', 'ORG_CAPABILITY_OVERRIDE', target.id, normalizeOrgOverride(target), null);
    return { id: target.id, deleted: true };
  }

  // 变更审计
  if (part === '/billing-config/change-logs' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const configType = String(ctx.search.get('configType') || '').trim();
    const limit = integer(ctx.search.get('limit'), 'limit', { min: 1, max: 200, fallback: 50 });
    const offset = integer(ctx.search.get('offset'), 'offset', { min: 0, max: 10000, fallback: 0 });
    const conditions = []; const params = [];
    if (configType) { if (!CONFIG_TYPES.has(configType)) throw errors.badRequest('configType 无效', 'INVALID_CONFIG_TYPE'); conditions.push('config_type=?'); params.push(configType); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const items = rows(`SELECT * FROM platform_config_change_logs ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params).map(normalizeChangeLog);
    const total = Number(row(`SELECT COUNT(*) n FROM platform_config_change_logs ${where}`, params)?.n || 0);
    return { items, total, limit, offset };
  }

  return null;
}

export async function handleOrgBillingConfig(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/org/billing-config')) return null;
  const part = pathname.slice('/api/org'.length);
  const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER']);
  if (!auth.user.orgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');

  // 机构可读：模态、限额（platform 层级）、本机构覆盖
  if (part === '/billing-config/modalities' && method === 'GET') {
    return { items: getModalitySettings() };
  }
  if (part === '/billing-config/quotas' && method === 'GET') {
    return { items: getQuotas() };
  }
  if (part === '/billing-config/alerts' && method === 'GET') {
    return { items: getAlerts() };
  }
  if (part === '/billing-config/org-overrides' && method === 'GET') {
    return { items: getOrgOverrides(auth.user.orgId) };
  }
  if (part === '/billing-config/org-overrides' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可设置能力覆盖', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {};
    const modality = String(body.modality || '').toUpperCase();
    if (!VALID_MODALITIES.has(modality)) throw errors.badRequest('modality 无效', 'INVALID_MODALITY');
    const enabled = body.enabled === undefined ? 1 : (bool(body.enabled) ? 1 : 0);
    const reason = String(body.reason || '').trim().slice(0, 500);
    const existing = row('SELECT * FROM org_capability_overrides WHERE org_id=? AND modality=?', [auth.user.orgId, modality]);
    const now = nowIso();
    if (existing) {
      q("UPDATE org_capability_overrides SET enabled=?, reason=?, updated_at=? WHERE id=?", [enabled, reason, now, existing.id]);
      logChange('ORG_OVERRIDE', existing.id, 'enabled', existing.enabled, enabled, auth.user.id, reason);
      audit(ctx, 'BILLING_CONFIG_ORG_OVERRIDE_UPDATE', 'ORG_CAPABILITY_OVERRIDE', existing.id, { before: existing, after: { enabled, reason } }, { orgId: auth.user.orgId });
      return normalizeOrgOverride(row('SELECT * FROM org_capability_overrides WHERE id=?', [existing.id]));
    }
    const id = `orgov_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    q('INSERT INTO org_capability_overrides(id,org_id,modality,enabled,reason,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, auth.user.orgId, modality, enabled, reason, auth.user.id, now, now]);
    logChange('ORG_OVERRIDE', id, 'create', '', JSON.stringify({ orgId: auth.user.orgId, modality, enabled }), auth.user.id, reason);
    audit(ctx, 'BILLING_CONFIG_ORG_OVERRIDE_CREATE', 'ORG_CAPABILITY_OVERRIDE', id, null, { orgId: auth.user.orgId, modality, enabled, reason });
    return normalizeOrgOverride(row('SELECT * FROM org_capability_overrides WHERE id=?', [id]));
  }
  const ovrDelMatch = part.match(/^\/billing-config\/org-overrides\/([^/]+)$/);
  if (ovrDelMatch && method === 'DELETE') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可删除能力覆盖', 'ORG_ADMIN_REQUIRED');
    const target = row('SELECT * FROM org_capability_overrides WHERE id=? AND org_id=?', [ovrDelMatch[1], auth.user.orgId]);
    if (!target) throw errors.notFound('覆盖不存在', 'ORG_OVERRIDE_NOT_FOUND');
    q('DELETE FROM org_capability_overrides WHERE id=?', [target.id]);
    logChange('ORG_OVERRIDE', target.id, 'delete', JSON.stringify({ orgId: target.org_id, modality: target.modality, enabled: target.enabled }), '', auth.user.id, '');
    audit(ctx, 'BILLING_CONFIG_ORG_OVERRIDE_DELETE', 'ORG_CAPABILITY_OVERRIDE', target.id, normalizeOrgOverride(target), null, { orgId: auth.user.orgId });
    return { id: target.id, deleted: true };
  }
  return null;
}

export async function handleStudentBillingConfig(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/student/billing-config')) return null;
  const part = pathname.slice('/api/student'.length);
  const auth = requireRole(ctx, ['STUDENT']);
  if (!auth.user.orgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');

  if (part === '/billing-config/modalities' && method === 'GET') {
    return { items: getModalitySettings() };
  }
  if (part === '/billing-config/quotas' && method === 'GET') {
    return { items: getQuotas() };
  }
  if (part === '/billing-config/effective-capabilities' && method === 'GET') {
    // 暴露给学生：把"机构覆盖 + 平台默认"合并后的真实可用能力
    const modalities = getModalitySettings();
    const items = modalities.map((m) => {
      const e = isModalityEnabled(auth.user.orgId, m.modality);
      return { modality: m.modality, displayName: m.displayName, unitCost: m.unitCost, enabled: e.enabled, source: e.source, reason: e.reason || '' };
    });
    return { items, orgId: auth.user.orgId };
  }
  return null;
}
