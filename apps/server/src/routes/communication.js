import {
  audit,
  errors,
  id,
  json,
  nonEmptyString,
  nowIso,
  parseJson,
  q,
  requireRole,
  row,
  rows,
  transaction,
} from '../lib.js';

const NOTIFICATION_ROLES = new Set(['ORG_ADMIN', 'TEACHER', 'STUDENT']);
const NOTIFICATION_KINDS = new Set(['NOTICE', 'ANNOUNCEMENT', 'REMINDER']);
const NOTIFICATION_SCOPES = new Set(['ALL_ORGS', 'ORG_IDS']);
const MATERIAL_CATEGORIES = new Set(['GENERAL', 'COURSE', 'POSTER', 'ACTIVITY', 'PARTNERSHIP']);

function orgId(auth) {
  if (!auth.user.orgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');
  return auth.user.orgId;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function normalizeNotification(value) {
  if (!value) return null;
  const audience = parseJson(value.audience, {});
  return {
    id: value.id,
    scopeType: value.scope_type,
    orgId: value.org_id || null,
    senderId: value.sender_id,
    senderName: value.sender_name || null,
    title: value.title,
    body: value.body,
    kind: value.kind,
    targetUrl: value.target_url || null,
    audience,
    status: value.status,
    publishAt: value.publish_at || null,
    pinned: Boolean(value.pinned),
    recipientCount: Number(value.recipient_count || 0),
    unreadCount: Number(value.unread_count || 0),
    deliveryFailedCount: Number(value.delivery_failed_count || 0),
    readAt: value.read_at || null,
    deliveryStatus: value.delivery_status || null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function normalizeMaterial(value) {
  if (!value) return null;
  return {
    id: value.id,
    title: value.title,
    description: value.description || '',
    category: value.category,
    mimeType: value.mime_type || null,
    resourceUrl: value.resource_url || null,
    coverUrl: value.cover_url || null,
    resourceConfigured: Boolean(value.resource_url),
    visibility: value.visibility,
    status: value.status,
    assignedOrgIds: String(value.assigned_org_ids || '').split(',').map((item) => item.trim()).filter(Boolean),
    assignedOrgCount: Number(value.assigned_org_count || 0),
    eventCount: Number(value.event_count || 0),
    createdBy: value.created_by,
    createdByName: value.created_by_name || null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function validateRoles(value, { defaultRoles = ['ORG_ADMIN', 'TEACHER', 'STUDENT'] } = {}) {
  const roles = value === undefined ? defaultRoles : value;
  if (!Array.isArray(roles) || !roles.length || roles.some((item) => typeof item !== 'string' || !NOTIFICATION_ROLES.has(item))) {
    throw errors.badRequest('通知接收角色无效', 'INVALID_NOTIFICATION_ROLES');
  }
  return [...new Set(roles)];
}

function validateAudience(body) {
  const audience = body?.audience || {};
  const scope = String(audience.scope || 'ALL_ORGS').toUpperCase();
  if (!NOTIFICATION_SCOPES.has(scope)) throw errors.badRequest('通知机构范围无效', 'INVALID_NOTIFICATION_SCOPE');
  const roles = validateRoles(audience.roles);
  const orgIds = Array.isArray(audience.orgIds) ? [...new Set(audience.orgIds.map((item) => String(item).trim()).filter(Boolean))] : [];
  if (scope === 'ORG_IDS' && !orgIds.length) throw errors.badRequest('指定机构通知至少需要一个机构', 'NOTIFICATION_ORGS_REQUIRED');
  if (scope === 'ORG_IDS') {
    const placeholders = orgIds.map(() => '?').join(',');
    const existing = rows(`SELECT id FROM organizations WHERE id IN (${placeholders})`, orgIds).map((item) => item.id);
    if (existing.length !== orgIds.length) throw errors.badRequest('通知目标机构不存在', 'INVALID_NOTIFICATION_ORG');
  }
  return { scope, roles, orgIds };
}

function notificationRecipients(notificationId, scopeType, notificationOrgId, audience) {
  const params = [...audience.roles];
  let where = `u.status='ACTIVE' AND u.deleted_at IS NULL AND u.role IN (${audience.roles.map(() => '?').join(',')})`;
  if (scopeType === 'ORG') {
    where += ' AND u.org_id=?';
    params.push(notificationOrgId);
  } else if (audience.scope === 'ORG_IDS') {
    where += ` AND u.org_id IN (${audience.orgIds.map(() => '?').join(',')})`;
    params.push(...audience.orgIds);
  } else {
    where += ' AND u.org_id IS NOT NULL';
  }
  const targets = rows(`SELECT u.id FROM users u WHERE ${where}`, params);
  const now = nowIso();
  targets.forEach((target) => {
    q('INSERT OR IGNORE INTO notification_recipients(id,notification_id,user_id,delivery_status,delivered_at,created_at) VALUES (?,?,?,?,?,?)', [id('nrec'), notificationId, target.id, 'DELIVERED', now, now]);
  });
  return targets.length;
}

function notificationAdminRows() {
  return rows(`
    SELECT n.*, sender.display_name sender_name,
      (SELECT COUNT(*) FROM notification_recipients recipient WHERE recipient.notification_id=n.id) recipient_count,
      (SELECT COUNT(*) FROM notification_recipients recipient WHERE recipient.notification_id=n.id AND recipient.read_at IS NULL AND recipient.delivery_status='DELIVERED') unread_count,
      (SELECT COUNT(*) FROM notification_recipients recipient WHERE recipient.notification_id=n.id AND recipient.delivery_status='FAILED') delivery_failed_count
    FROM notifications n
    LEFT JOIN users sender ON sender.id=n.sender_id
    WHERE n.scope_type='PLATFORM'
    ORDER BY n.pinned DESC, COALESCE(n.publish_at,n.created_at) DESC
    LIMIT 200
  `).map(normalizeNotification);
}

function notificationOrgRows(currentOrgId, userId) {
  return rows(`
    SELECT n.*, sender.display_name sender_name, recipient.read_at, recipient.delivery_status
    FROM notification_recipients recipient
    JOIN notifications n ON n.id=recipient.notification_id
    LEFT JOIN users sender ON sender.id=n.sender_id
    WHERE recipient.user_id=? AND recipient.delivery_status='DELIVERED'
      AND n.status='PUBLISHED' AND (n.publish_at IS NULL OR n.publish_at<=?)
      AND ((n.scope_type='ORG' AND n.org_id=?) OR n.scope_type='PLATFORM')
    ORDER BY n.pinned DESC, COALESCE(n.publish_at,n.created_at) DESC
    LIMIT 200
  `, [userId, nowIso(), currentOrgId]).map(normalizeNotification);
}

function materialRows({ currentOrgId = null, admin = false } = {}) {
  const base = `
    SELECT material.*, creator.display_name created_by_name,
      (SELECT GROUP_CONCAT(assignment.org_id) FROM promo_material_assignments assignment WHERE assignment.material_id=material.id) assigned_org_ids,
      (SELECT COUNT(*) FROM promo_material_assignments assignment WHERE assignment.material_id=material.id) assigned_org_count,
      (SELECT COUNT(*) FROM promo_material_events event WHERE event.material_id=material.id) event_count
    FROM promo_materials material
    LEFT JOIN users creator ON creator.id=material.created_by
  `;
  if (admin) return rows(base + ' ORDER BY material.created_at DESC LIMIT 200').map(normalizeMaterial);
  return rows(base + `
    WHERE material.status='ACTIVE' AND (material.visibility='ALL_ORGS' OR EXISTS (SELECT 1 FROM promo_material_assignments assignment WHERE assignment.material_id=material.id AND assignment.org_id=?))
    ORDER BY material.created_at DESC LIMIT 200
  `, [currentOrgId]).map(normalizeMaterial);
}

function validateMaterialBody(body, existing = null) {
  const title = body.title === undefined && existing ? existing.title : nonEmptyString(body.title, '物料名称', { max: 120 });
  const description = body.description === undefined && existing ? existing.description : String(body.description || '').trim().slice(0, 2000);
  const category = body.category === undefined && existing ? existing.category : String(body.category || 'GENERAL').toUpperCase();
  if (!MATERIAL_CATEGORIES.has(category)) throw errors.badRequest('物料分类无效', 'INVALID_MATERIAL_CATEGORY');
  const visibility = body.visibility === undefined && existing ? existing.visibility : String(body.visibility || 'ALL_ORGS').toUpperCase();
  if (!['ALL_ORGS', 'ASSIGNED_ORGS'].includes(visibility)) throw errors.badRequest('物料可见范围无效', 'INVALID_MATERIAL_VISIBILITY');
  const mimeType = body.mimeType === undefined && existing ? existing.mime_type : (body.mimeType ? String(body.mimeType).trim().slice(0, 120) : null);
  const resourceUrl = body.resourceUrl === undefined && existing ? existing.resource_url : (body.resourceUrl ? String(body.resourceUrl).trim().slice(0, 2000) : null);
  const coverUrl = body.coverUrl === undefined && existing ? existing.cover_url : (body.coverUrl ? String(body.coverUrl).trim().slice(0, 2000) : null);
  const orgIds = body.orgIds === undefined && existing ? rows('SELECT org_id FROM promo_material_assignments WHERE material_id=?', [existing.id]).map((item) => item.org_id) : (Array.isArray(body.orgIds) ? [...new Set(body.orgIds.map((item) => String(item).trim()).filter(Boolean))] : []);
  if (visibility === 'ASSIGNED_ORGS' && !orgIds.length) throw errors.badRequest('指定机构物料至少需要一个机构', 'MATERIAL_ORGS_REQUIRED');
  if (orgIds.length) {
    const placeholders = orgIds.map(() => '?').join(',');
    if (rows(`SELECT id FROM organizations WHERE id IN (${placeholders})`, orgIds).length !== orgIds.length) throw errors.badRequest('物料目标机构不存在', 'INVALID_MATERIAL_ORG');
  }
  return { title, description, category, visibility, mimeType, resourceUrl, coverUrl, orgIds };
}

export async function handleAdminCommunication(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/admin/')) return null;
  const part = pathname.slice('/api/admin'.length);
  if (part === '/inbox' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const items = notificationAdminRows();
    return { items, unread: items.reduce((sum, item) => sum + item.unreadCount, 0), total: items.length };
  }
  if (part === '/inbox' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const title = nonEmptyString(ctx.body?.title, '通知标题', { max: 160 });
    const body = nonEmptyString(ctx.body?.body, '通知内容', { max: 10000 });
    const kind = String(ctx.body?.kind || 'NOTICE').toUpperCase();
    if (!NOTIFICATION_KINDS.has(kind)) throw errors.badRequest('通知类型无效', 'INVALID_NOTIFICATION_KIND');
    const audience = validateAudience(ctx.body);
    const status = String(ctx.body?.status || 'DRAFT').toUpperCase();
    if (!['DRAFT', 'PUBLISHED'].includes(status)) throw errors.badRequest('新通知状态无效', 'INVALID_NOTIFICATION_STATUS');
    const notificationId = id('notice'); const now = nowIso();
    transaction(() => {
      q('INSERT INTO notifications(id,scope_type,org_id,sender_id,title,body,kind,target_url,audience,status,publish_at,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [notificationId, 'PLATFORM', null, auth.user.id, title, body, kind, ctx.body?.targetUrl ? String(ctx.body.targetUrl).trim().slice(0, 500) : null, json(audience), status, status === 'PUBLISHED' ? (ctx.body?.publishAt || now) : null, bool(ctx.body?.pinned) ? 1 : 0, now, now]);
      if (status === 'PUBLISHED') notificationRecipients(notificationId, 'PLATFORM', null, audience);
    });
    audit(ctx, 'PLATFORM_NOTIFICATION_CREATE', 'NOTIFICATION', notificationId, null, { status, audience });
    return normalizeNotification(row('SELECT * FROM notifications WHERE id=?', [notificationId]));
  }
  let match = part.match(/^\/inbox\/([^/]+)$/);
  if (match && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const target = row("SELECT * FROM notifications WHERE id=? AND scope_type='PLATFORM'", [match[1]]);
    if (!target) throw errors.notFound('通知不存在', 'NOTIFICATION_NOT_FOUND');
    const nextStatus = ctx.body?.status === undefined ? target.status : String(ctx.body.status).toUpperCase();
    if (!['DRAFT', 'PUBLISHED', 'RECALLED'].includes(nextStatus)) throw errors.badRequest('通知状态无效', 'INVALID_NOTIFICATION_STATUS');
    const title = ctx.body?.title === undefined ? target.title : nonEmptyString(ctx.body.title, '通知标题', { max: 160 });
    const body = ctx.body?.body === undefined ? target.body : nonEmptyString(ctx.body.body, '通知内容', { max: 10000 });
    const audience = ctx.body?.audience === undefined ? parseJson(target.audience, {}) : validateAudience(ctx.body);
    const now = nowIso();
    transaction(() => {
      q('UPDATE notifications SET title=?,body=?,audience=?,status=?,publish_at=?,pinned=?,updated_at=? WHERE id=?', [title, body, json(audience), nextStatus, nextStatus === 'PUBLISHED' ? (target.publish_at || now) : target.publish_at, ctx.body?.pinned === undefined ? target.pinned : (bool(ctx.body.pinned) ? 1 : 0), now, target.id]);
      if (nextStatus === 'PUBLISHED') notificationRecipients(target.id, 'PLATFORM', null, audience);
    });
    audit(ctx, 'PLATFORM_NOTIFICATION_UPDATE', 'NOTIFICATION', target.id, { status: target.status }, { status: nextStatus });
    return normalizeNotification(row('SELECT * FROM notifications WHERE id=?', [target.id]));
  }
  if (part === '/materials' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const items = materialRows({ admin: true });
    return { items, total: items.length };
  }
  if (part === '/materials' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const material = validateMaterialBody(ctx.body || {}); const materialId = id('material'); const now = nowIso();
    transaction(() => {
      q('INSERT INTO promo_materials(id,title,description,category,mime_type,resource_url,cover_url,visibility,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [materialId, material.title, material.description, material.category, material.mimeType, material.resourceUrl, material.coverUrl, material.visibility, 'ACTIVE', auth.user.id, now, now]);
      material.orgIds.forEach((targetOrgId) => q('INSERT INTO promo_material_assignments(id,material_id,org_id,created_at) VALUES (?,?,?,?)', [id('matassign'), materialId, targetOrgId, now]));
    });
    audit(ctx, 'PROMO_MATERIAL_CREATE', 'PROMO_MATERIAL', materialId, null, { visibility: material.visibility, orgIds: material.orgIds, resourceConfigured: Boolean(material.resourceUrl) });
    return normalizeMaterial(row('SELECT * FROM promo_materials WHERE id=?', [materialId]));
  }
  match = part.match(/^\/materials\/([^/]+)$/);
  if (match && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const target = row('SELECT * FROM promo_materials WHERE id=?', [match[1]]);
    if (!target) throw errors.notFound('宣传物料不存在', 'MATERIAL_NOT_FOUND');
    const material = validateMaterialBody(ctx.body || {}, target);
    const status = ctx.body?.status === undefined ? target.status : String(ctx.body.status).toUpperCase();
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('物料状态无效', 'INVALID_MATERIAL_STATUS');
    const now = nowIso();
    transaction(() => {
      q('UPDATE promo_materials SET title=?,description=?,category=?,mime_type=?,resource_url=?,cover_url=?,visibility=?,status=?,updated_at=? WHERE id=?', [material.title, material.description, material.category, material.mimeType, material.resourceUrl, material.coverUrl, material.visibility, status, now, target.id]);
      q('DELETE FROM promo_material_assignments WHERE material_id=?', [target.id]);
      material.orgIds.forEach((targetOrgId) => q('INSERT INTO promo_material_assignments(id,material_id,org_id,created_at) VALUES (?,?,?,?)', [id('matassign'), target.id, targetOrgId, now]));
    });
    audit(ctx, 'PROMO_MATERIAL_UPDATE', 'PROMO_MATERIAL', target.id, { status: target.status }, { status, visibility: material.visibility });
    return normalizeMaterial(row('SELECT * FROM promo_materials WHERE id=?', [target.id]));
  }
  return null;
}

export async function handleOrgCommunication(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/org/')) return null;
  const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER']);
  const currentOrgId = orgId(auth);
  const part = pathname.slice('/api/org'.length);
  if (part === '/inbox' && method === 'GET') {
    const items = notificationOrgRows(currentOrgId, auth.user.id);
    return { items, unread: items.filter((item) => !item.readAt).length, total: items.length };
  }
  if (part === '/inbox' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可发送机构通知', 'ORG_ADMIN_REQUIRED');
    const title = nonEmptyString(ctx.body?.title, '通知标题', { max: 160 });
    const body = nonEmptyString(ctx.body?.body, '通知内容', { max: 10000 });
    const roles = validateRoles(ctx.body?.roles, { defaultRoles: ['TEACHER', 'STUDENT'] });
    const noticeId = id('notice'); const now = nowIso(); const audience = { scope: 'ORG_IDS', orgIds: [currentOrgId], roles };
    transaction(() => {
      q('INSERT INTO notifications(id,scope_type,org_id,sender_id,title,body,kind,target_url,audience,status,publish_at,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [noticeId, 'ORG', currentOrgId, auth.user.id, title, body, 'NOTICE', ctx.body?.targetUrl ? String(ctx.body.targetUrl).trim().slice(0, 500) : null, json(audience), 'PUBLISHED', now, bool(ctx.body?.pinned) ? 1 : 0, now, now]);
      notificationRecipients(noticeId, 'ORG', currentOrgId, audience);
    });
    audit(ctx, 'ORG_NOTIFICATION_CREATE', 'NOTIFICATION', noticeId, null, { roles });
    return normalizeNotification(row('SELECT * FROM notifications WHERE id=?', [noticeId]));
  }
  let match = part.match(/^\/inbox\/([^/]+)\/read$/);
  if (match && method === 'PUT') {
    const result = q("UPDATE notification_recipients SET read_at=COALESCE(read_at,?) WHERE notification_id=? AND user_id=? AND EXISTS (SELECT 1 FROM notifications n WHERE n.id=notification_recipients.notification_id AND n.status='PUBLISHED' AND (n.scope_type='PLATFORM' OR n.org_id=?))", [nowIso(), match[1], auth.user.id, currentOrgId]);
    if (!result.changes) throw errors.notFound('通知不存在或不属于当前账号', 'NOTIFICATION_NOT_FOUND');
    audit(ctx, 'NOTIFICATION_READ', 'NOTIFICATION', match[1]);
    return { read: true };
  }
  if (part === '/inbox/read-all' && method === 'PUT') {
    const result = q("UPDATE notification_recipients SET read_at=COALESCE(read_at,?) WHERE user_id=? AND read_at IS NULL AND EXISTS (SELECT 1 FROM notifications n WHERE n.id=notification_recipients.notification_id AND n.status='PUBLISHED' AND (n.scope_type='PLATFORM' OR n.org_id=?))", [nowIso(), auth.user.id, currentOrgId]);
    audit(ctx, 'NOTIFICATIONS_READ_ALL', 'USER', auth.user.id, null, { count: result.changes });
    return { read: result.changes };
  }
  if (part === '/materials' && method === 'GET') {
    const items = materialRows({ currentOrgId });
    return { items, total: items.length };
  }
  match = part.match(/^\/materials\/([^/]+)\/events$/);
  if (match && method === 'POST') {
    const material = row(`SELECT material.* FROM promo_materials material WHERE material.id=? AND material.status='ACTIVE' AND (material.visibility='ALL_ORGS' OR EXISTS (SELECT 1 FROM promo_material_assignments assignment WHERE assignment.material_id=material.id AND assignment.org_id=?))`, [match[1], currentOrgId]);
    if (!material) throw errors.notFound('宣传物料不存在或当前机构不可见', 'MATERIAL_NOT_FOUND');
    const eventType = String(ctx.body?.eventType || 'VIEW').toUpperCase();
    if (!['VIEW', 'USE', 'DOWNLOAD'].includes(eventType)) throw errors.badRequest('物料事件类型无效', 'INVALID_MATERIAL_EVENT');
    if (eventType === 'DOWNLOAD' && !material.resource_url) throw errors.conflict('该物料尚未配置真实资源地址，暂不能下载', 'MATERIAL_RESOURCE_NOT_CONFIGURED');
    const eventId = id('matevent');
    q('INSERT INTO promo_material_events(id,material_id,org_id,user_id,event_type,created_at) VALUES (?,?,?,?,?,?)', [eventId, material.id, currentOrgId, auth.user.id, eventType, nowIso()]);
    audit(ctx, 'PROMO_MATERIAL_' + eventType, 'PROMO_MATERIAL', material.id);
    return { eventId, eventType, resourceUrl: material.resource_url || null, resourceConfigured: Boolean(material.resource_url) };
  }
  return null;
}
