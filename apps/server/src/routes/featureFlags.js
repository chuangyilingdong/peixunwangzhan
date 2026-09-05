import { createHash } from 'node:crypto';
import { audit, errors, json, nowIso, parseJson, q, requireAuth, requirePlatformPermission, row, rows } from '../lib.js';

const KEY_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_LIST = 500;

function normalizeList(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw errors.badRequest(`${field} 必须是数组`, 'INVALID_FEATURE_FLAG_TARGETS');
  const items = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  if (items.length > MAX_LIST) throw errors.badRequest(`${field} 不能超过 ${MAX_LIST} 项`, 'INVALID_FEATURE_FLAG_TARGETS');
  if (items.some((item) => item.length > 120)) throw errors.badRequest(`${field} 包含过长标识`, 'INVALID_FEATURE_FLAG_TARGETS');
  return items;
}

function normalizeFlag(value) {
  return {
    key: value.flag_key,
    name: value.name,
    description: value.description || '',
    enabled: value.enabled === undefined ? true : Boolean(value.enabled),
    defaultEnabled: Boolean(value.default_enabled),
    rolloutPercent: Number(value.rollout_percent || 0),
    enabledOrgIds: parseJson(value.enabled_org_ids, []),
    enabledUserIds: parseJson(value.enabled_user_ids, []),
    createdBy: value.created_by || null,
    updatedBy: value.updated_by || null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function deterministicPercent(flagKey, subject) {
  const hex = createHash('sha256').update(`${flagKey}:${subject}`).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) % 100;
}

export function evaluateFeatureFlag(flag, auth) {
  if (!flag || flag.enabled === 0) return false;
  const userId = auth?.user?.id || '';
  const orgId = auth?.user?.orgId || '';
  const userIds = parseJson(flag.enabled_user_ids, []);
  const orgIds = parseJson(flag.enabled_org_ids, []);
  if (userId && userIds.includes(userId)) return true;
  if (orgId && orgIds.includes(orgId)) return true;
  if (flag.default_enabled) return true;
  if (!flag.rollout_percent) return false;
  const subject = userId || orgId || 'anonymous';
  return deterministicPercent(flag.flag_key, subject) < Number(flag.rollout_percent);
}

function publicFlags(auth) {
  return Object.fromEntries(rows('SELECT * FROM feature_flags ORDER BY flag_key ASC').map((flag) => [flag.flag_key, evaluateFeatureFlag(flag, auth)]));
}

export function handleFeatureFlags(ctx) {
  if (ctx.pathname === '/api/feature-flags' && ctx.method === 'GET') {
    const auth = requireAuth(ctx);
    return { flags: publicFlags(auth), evaluatedFor: { userId: auth.user.id, orgId: auth.user.orgId || null } };
  }
  if (!ctx.pathname.startsWith('/api/admin/feature-flags')) return null;
  const auth = requirePlatformPermission(ctx, 'ADMIN_FEATURE_FLAGS');
  const part = ctx.pathname.slice('/api/admin/feature-flags'.length) || '/';
  if (part === '/' && ctx.method === 'GET') {
    const items = rows('SELECT * FROM feature_flags ORDER BY updated_at DESC, flag_key ASC').map(normalizeFlag);
    return { items, total: items.length };
  }
  if (part === '/' && ctx.method === 'POST') {
    const body = ctx.body || {};
    const key = String(body.key || '').trim();
    const name = String(body.name || '').trim();
    if (!KEY_RE.test(key) || key.length > 80) throw errors.badRequest('Feature Flag key 格式无效', 'INVALID_FEATURE_FLAG_KEY');
    if (!name || name.length > 120) throw errors.badRequest('Feature Flag 名称不能为空且不超过 120 个字符', 'INVALID_FEATURE_FLAG_NAME');
    const description = String(body.description || '').trim().slice(0, 500);
    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    const defaultEnabled = Boolean(body.defaultEnabled);
    const rolloutPercent = Number(body.rolloutPercent ?? 0);
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) throw errors.badRequest('灰度比例必须是 0 到 100 的整数', 'INVALID_ROLLOUT_PERCENT');
    const orgIds = normalizeList(body.enabledOrgIds ?? [], '机构白名单');
    const userIds = normalizeList(body.enabledUserIds ?? [], '用户白名单');
    if (row('SELECT flag_key FROM feature_flags WHERE flag_key=?', [key])) throw errors.conflict('Feature Flag key 已存在', 'FEATURE_FLAG_EXISTS');
    const now = nowIso();
    q('INSERT INTO feature_flags(flag_key,name,description,enabled,default_enabled,rollout_percent,enabled_org_ids,enabled_user_ids,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [key, name, description, enabled ? 1 : 0, defaultEnabled ? 1 : 0, rolloutPercent, json(orgIds), json(userIds), auth.user.id, auth.user.id, now, now]);
    const created = row('SELECT * FROM feature_flags WHERE flag_key=?', [key]);
    audit(ctx, 'FEATURE_FLAG_CREATE', 'FEATURE_FLAG', key, null, normalizeFlag(created));
    return normalizeFlag(created);
  }
  const match = part.match(/^\/([^/]+)$/);
  if (!match) return null;
  const key = decodeURIComponent(match[1]);
  const existing = row('SELECT * FROM feature_flags WHERE flag_key=?', [key]);
  if (!existing) throw errors.notFound('Feature Flag 不存在', 'FEATURE_FLAG_NOT_FOUND');
  if (ctx.method === 'PATCH') {
    const body = ctx.body || {};
    const name = body.name === undefined ? existing.name : String(body.name || '').trim();
    const description = body.description === undefined ? existing.description : String(body.description || '').trim().slice(0, 500);
    if (!name || name.length > 120) throw errors.badRequest('Feature Flag 名称不能为空且不超过 120 个字符', 'INVALID_FEATURE_FLAG_NAME');
    const enabled = body.enabled === undefined ? Boolean(existing.enabled) : Boolean(body.enabled);
    const defaultEnabled = body.defaultEnabled === undefined ? Boolean(existing.default_enabled) : Boolean(body.defaultEnabled);
    const rolloutPercent = body.rolloutPercent === undefined ? Number(existing.rollout_percent) : Number(body.rolloutPercent);
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) throw errors.badRequest('灰度比例必须是 0 到 100 的整数', 'INVALID_ROLLOUT_PERCENT');
    const orgIds = normalizeList(body.enabledOrgIds === undefined ? parseJson(existing.enabled_org_ids, []) : body.enabledOrgIds, '机构白名单');
    const userIds = normalizeList(body.enabledUserIds === undefined ? parseJson(existing.enabled_user_ids, []) : body.enabledUserIds, '用户白名单');
    const now = nowIso();
    q('UPDATE feature_flags SET name=?,description=?,enabled=?,default_enabled=?,rollout_percent=?,enabled_org_ids=?,enabled_user_ids=?,updated_by=?,updated_at=? WHERE flag_key=?', [name, description, enabled ? 1 : 0, defaultEnabled ? 1 : 0, rolloutPercent, json(orgIds), json(userIds), auth.user.id, now, key]);
    const updated = row('SELECT * FROM feature_flags WHERE flag_key=?', [key]);
    audit(ctx, 'FEATURE_FLAG_UPDATE', 'FEATURE_FLAG', key, normalizeFlag(existing), normalizeFlag(updated));
    return normalizeFlag(updated);
  }
  if (ctx.method === 'DELETE') {
    q('DELETE FROM feature_flags WHERE flag_key=?', [key]);
    audit(ctx, 'FEATURE_FLAG_DELETE', 'FEATURE_FLAG', key, normalizeFlag(existing), null);
    return { key, deleted: true };
  }
  return null;
}
