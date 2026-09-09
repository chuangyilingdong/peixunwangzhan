// 通知/物料/官网内容/线索/站内信：admin 域，从 communication.js 拆出。
import {
  audit,
  errors,
  id,
  json,
  nonEmptyString,
  normalizeSeries,
  nowIso,
  parseJson,
  platformPermissionForPathname,
  q,
  requirePlatformPermission,
  requireRole,
  row,
  rows,
  transaction,
} from '../../lib.js';
import { hostname } from 'node:os';
import { assertTransition } from '../../services/domainState.js';
import { WEBSITE_CONTENT_KEYS } from '../../services/websiteContentKeys.js';
import {
  LEGAL_POLICY_VERSION,
  MATERIAL_CATEGORIES,
  NOTIFICATION_KINDS,
  NOTIFICATION_ROLES,
  NOTIFICATION_SCOPES,
  WORKER_ID,
  backoffSeconds,
  bool,
  claimDispatchJobs,
  dispatchDueNotifications,
  dispatchRecipientEvent,
  effectiveNotificationStatus,
  enqueueDispatchJob,
  integer,
  listDeadLetters,
  markAllNotificationsRead,
  markJobFailed,
  markJobSucceeded,
  markNotificationRead,
  markRecipientFailed,
  materialRows,
  materialStats,
  normalizeLead,
  normalizeMaterial,
  normalizeNotification,
  normalizeTemplate,
  normalizeWebsiteContent,
  notificationAdminRows,
  notificationRecipientRows,
  notificationRecipients,
  orgId,
  releaseWorkerJobs,
  reminderInterval,
  reminderStarted,
  requeueDeadLetters,
  retryRecipient,
  runWorkerTick,
  scheduleReminder,
  scheduledPublishAt,
  scheduler,
  selectAudienceUsers,
  shutdownCommunicationWorkers,
  startNotificationWorker,
  startReminderScheduler,
  summarizeQueue,
  templateRows,
  validateAudience,
  validateKind,
  validateMaterialBody,
  validateRoles,
  validateTemplateBody,
  websiteContentKey,
  websiteContentRevisions,
  websiteContentValue,
  workerInterval,
  workerStarted,
} from './helpers.js';

export async function handleAdminCommunication(ctx) {
  const { pathname, method } = ctx;
  const websiteDraft = pathname.match(/^\/api\/admin\/website-content\/([A-Za-z0-9_]+)$/);
  const websiteAction = pathname.match(/^\/api\/admin\/website-content\/([A-Za-z0-9_]+)\/(publish|rollback)$/);
  if (pathname === '/api/admin/website-content' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { items: rows('SELECT * FROM website_contents ORDER BY content_key').map((item) => normalizeWebsiteContent(item, true)) };
  }
  if (websiteDraft && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const key = websiteContentKey(websiteDraft[1]);
    const item = row('SELECT * FROM website_contents WHERE content_key=?', [key]);
    if (!item) throw errors.notFound('官网内容不存在', 'WEBSITE_CONTENT_NOT_FOUND');
    return { ...normalizeWebsiteContent(item, true), publishedContent: parseJson(item.published_content, null), revisions: websiteContentRevisions(key) };
  }
  if (websiteDraft && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const key = websiteContentKey(websiteDraft[1]);
    const parsed = websiteContentValue(ctx.body?.content ?? ctx.body);
    const now = nowIso();
    const existing = row('SELECT * FROM website_contents WHERE content_key=?', [key]);
    const nextVersion = Number(existing?.draft_version || 0) + 1;
    if (existing) q('UPDATE website_contents SET draft_content=?,draft_version=?,updated_by=?,updated_at=? WHERE content_key=?', [parsed.encoded, nextVersion, auth.user.id, now, key]);
    else q('INSERT INTO website_contents(content_key,draft_content,published_content,draft_version,published_version,updated_by,published_by,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [key, parsed.encoded, null, 1, null, auth.user.id, null, now, now, null]);
    audit(ctx, 'WEBSITE_CONTENT_DRAFT_UPDATE', 'WEBSITE_CONTENT', key, existing ? normalizeWebsiteContent(existing, true) : null, { key, version: nextVersion });
    return normalizeWebsiteContent(row('SELECT * FROM website_contents WHERE content_key=?', [key]), true);
  }
  if (websiteAction && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const key = websiteContentKey(websiteAction[1]);
    const action = websiteAction[2].toUpperCase();
    const item = row('SELECT * FROM website_contents WHERE content_key=?', [key]);
    if (!item) throw errors.notFound('官网内容不存在', 'WEBSITE_CONTENT_NOT_FOUND');
    const reason = String(ctx.body?.reason || '').trim().slice(0, 500);
    if (action === 'PUBLISH') {
      const nextVersion = Number(row('SELECT MAX(version) AS v FROM website_content_revisions WHERE content_key=?', [key])?.v || 0) + 1;
      const now = nowIso();
      transaction(() => {
        q('UPDATE website_contents SET published_content=?,published_version=?,published_by=?,published_at=?,updated_at=? WHERE content_key=?', [item.draft_content, nextVersion, auth.user.id, now, now, key]);
        q('INSERT INTO website_content_revisions(id,content_key,version,content,action,changed_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?)', [id('wrev'), key, nextVersion, item.draft_content, 'PUBLISH', auth.user.id, reason, now]);
      });
      audit(ctx, 'WEBSITE_CONTENT_PUBLISH', 'WEBSITE_CONTENT', key, normalizeWebsiteContent(item), { key, version: nextVersion, reason });
      return normalizeWebsiteContent(row('SELECT * FROM website_contents WHERE content_key=?', [key]), true);
    }
    const targetVersion = Number(ctx.body?.version);
    if (!Number.isInteger(targetVersion) || targetVersion < 1) throw errors.badRequest('回滚版本必须是正整数', 'INVALID_WEBSITE_CONTENT_VERSION');
    const revision = row('SELECT * FROM website_content_revisions WHERE content_key=? AND version=?', [key, targetVersion]);
    if (!revision) throw errors.notFound('历史版本不存在', 'WEBSITE_CONTENT_REVISION_NOT_FOUND');
    const nextVersion = Number(row('SELECT MAX(version) AS v FROM website_content_revisions WHERE content_key=?', [key])?.v || 0) + 1;
    const now = nowIso();
    transaction(() => {
      q('UPDATE website_contents SET draft_content=?,draft_version=?,published_content=?,published_version=?,updated_by=?,published_by=?,published_at=?,updated_at=? WHERE content_key=?', [revision.content, nextVersion, revision.content, nextVersion, auth.user.id, auth.user.id, now, now, key]);
      q('INSERT INTO website_content_revisions(id,content_key,version,content,action,changed_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?)', [id('wrev'), key, nextVersion, revision.content, 'ROLLBACK', auth.user.id, reason || `rollback to ${targetVersion}`, now]);
    });
    audit(ctx, 'WEBSITE_CONTENT_ROLLBACK', 'WEBSITE_CONTENT', key, normalizeWebsiteContent(item), { key, version: nextVersion, rollbackTo: targetVersion, reason });
    return normalizeWebsiteContent(row('SELECT * FROM website_contents WHERE content_key=?', [key]), true);
  }

  if (!pathname.startsWith('/api/admin/')) return null;
  requirePlatformPermission(ctx, platformPermissionForPathname(pathname));
  const part = pathname.slice('/api/admin'.length);
  if (part === '/inbox' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    dispatchDueNotifications();
    const search = String(ctx.search.get('search') || '').trim();
    const status = String(ctx.search.get('status') || '').trim().toUpperCase();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const requestedSort = String(ctx.search.get('sort') || 'created');
    const sort = ['created', 'updated', 'publish', 'title', 'pinned'].includes(requestedSort) ? requestedSort : 'created';
    const result = notificationAdminRows({ search, status, page, limit, sort });
    return { ...result, unread: result.items.reduce((sum, item) => sum + item.unreadCount, 0) };
  }
  if (part === '/inbox' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const title = nonEmptyString(ctx.body?.title, '通知标题', { max: 160 });
    const body = nonEmptyString(ctx.body?.body, '通知内容', { max: 10000 });
    const kind = validateKind(ctx.body?.kind);
    const audience = validateAudience(ctx.body);
    const requestedStatus = String(ctx.body?.status || 'DRAFT').toUpperCase();
    if (!['DRAFT', 'PUBLISHED', 'SCHEDULED'].includes(requestedStatus)) throw errors.badRequest('新通知状态无效', 'INVALID_NOTIFICATION_STATUS');
    const notificationId = id('notice'); const now = nowIso();
    const publishAt = requestedStatus === 'SCHEDULED' ? scheduledPublishAt(ctx.body?.publishAt) : (requestedStatus === 'PUBLISHED' ? now : null);
    const storedStatus = requestedStatus === 'SCHEDULED' ? 'DRAFT' : requestedStatus;
    transaction(() => {
      q('INSERT INTO notifications(id,scope_type,org_id,sender_id,title,body,kind,target_url,audience,status,publish_at,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [notificationId, 'PLATFORM', null, auth.user.id, title, body, kind, ctx.body?.targetUrl ? String(ctx.body.targetUrl).trim().slice(0, 500) : null, json(audience), storedStatus, publishAt, bool(ctx.body?.pinned) ? 1 : 0, now, now]);
      if (storedStatus === 'PUBLISHED') notificationRecipients(notificationId, 'PLATFORM', null, audience);
    });
    audit(ctx, 'PLATFORM_NOTIFICATION_CREATE', 'NOTIFICATION', notificationId, null, { status: requestedStatus, audience, publishAt });
    return normalizeNotification(row('SELECT * FROM notifications WHERE id=?', [notificationId]));
  }
  if (part === '/notification-templates' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const items = templateRows();
    return { items, total: items.length };
  }
  if (part === '/notification-templates' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const template = validateTemplateBody(ctx.body || {}); const templateId = id('ntpl'); const now = nowIso();
    q('INSERT INTO notification_templates(id,name,title,body,kind,target_url,audience,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [templateId, template.name, template.title, template.body, template.kind, template.targetUrl, json(template.audience), 'ACTIVE', auth.user.id, now, now]);
    audit(ctx, 'NOTIFICATION_TEMPLATE_CREATE', 'NOTIFICATION_TEMPLATE', templateId, null, { name: template.name });
    return normalizeTemplate(row('SELECT * FROM notification_templates WHERE id=?', [templateId]));
  }
  let match = part.match(/^\/notification-templates\/([^/]+)$/);
  if (match && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const target = row('SELECT * FROM notification_templates WHERE id=?', [match[1]]);
    if (!target) throw errors.notFound('通知模板不存在', 'NOTIFICATION_TEMPLATE_NOT_FOUND');
    const template = validateTemplateBody(ctx.body || {}, target);
    const status = ctx.body?.status === undefined ? target.status : String(ctx.body.status).toUpperCase();
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('通知模板状态无效', 'INVALID_NOTIFICATION_TEMPLATE_STATUS');
    assertTransition(ctx, 'notificationTemplate', target.status, status, { targetType: 'NOTIFICATION_TEMPLATE', targetId: target.id, before: target, allowSameState: true });
    q('UPDATE notification_templates SET name=?,title=?,body=?,kind=?,target_url=?,audience=?,status=?,updated_at=? WHERE id=?', [template.name, template.title, template.body, template.kind, template.targetUrl, json(template.audience), status, nowIso(), target.id]);
    audit(ctx, 'NOTIFICATION_TEMPLATE_UPDATE', 'NOTIFICATION_TEMPLATE', target.id, { status: target.status }, { status, name: template.name });
    return normalizeTemplate(row('SELECT * FROM notification_templates WHERE id=?', [target.id]));
  }
  match = part.match(/^\/inbox\/([^/]+)$/);
  if (match && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const target = row("SELECT * FROM notifications WHERE id=? AND scope_type='PLATFORM'", [match[1]]);
    if (!target) throw errors.notFound('通知不存在', 'NOTIFICATION_NOT_FOUND');
    const currentStatus = effectiveNotificationStatus(target);
    const nextStatus = ctx.body?.status === undefined ? currentStatus : String(ctx.body.status).toUpperCase();
    if (!['DRAFT', 'PUBLISHED', 'SCHEDULED', 'RECALLED'].includes(nextStatus)) throw errors.badRequest('通知状态无效', 'INVALID_NOTIFICATION_STATUS');
    const title = ctx.body?.title === undefined ? target.title : nonEmptyString(ctx.body.title, '通知标题', { max: 160 });
    const body = ctx.body?.body === undefined ? target.body : nonEmptyString(ctx.body.body, '通知内容', { max: 10000 });
    const audience = ctx.body?.audience === undefined ? parseJson(target.audience, {}) : validateAudience(ctx.body);
    const kind = ctx.body?.kind === undefined ? target.kind : validateKind(ctx.body.kind);
    const targetUrl = ctx.body?.targetUrl === undefined ? target.target_url : (ctx.body.targetUrl ? String(ctx.body.targetUrl).trim().slice(0, 500) : null);
    const now = nowIso();
    const publishAt = nextStatus === 'SCHEDULED' ? scheduledPublishAt(ctx.body?.publishAt, currentStatus === 'SCHEDULED' ? target.publish_at : null) : (nextStatus === 'PUBLISHED' ? now : null);
    const storedStatus = nextStatus === 'SCHEDULED' ? 'DRAFT' : nextStatus;
    assertTransition(ctx, 'notification', target.status, storedStatus, { targetType: 'NOTIFICATION', targetId: target.id, before: target, allowSameState: true });
    transaction(() => {
      q('UPDATE notifications SET title=?,body=?,kind=?,target_url=?,audience=?,status=?,publish_at=?,pinned=?,updated_at=? WHERE id=?', [title, body, kind, targetUrl, json(audience), storedStatus, publishAt, ctx.body?.pinned === undefined ? target.pinned : (bool(ctx.body.pinned) ? 1 : 0), now, target.id]);
      if (storedStatus === 'PUBLISHED') notificationRecipients(target.id, 'PLATFORM', null, audience);
    });
    audit(ctx, 'PLATFORM_NOTIFICATION_UPDATE', 'NOTIFICATION', target.id, { status: currentStatus }, { status: nextStatus, publishAt });
    return normalizeNotification(row('SELECT * FROM notifications WHERE id=?', [target.id]));
  }
  if (part === '/materials' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const search = String(ctx.search.get('search') || '').trim();
    const status = String(ctx.search.get('status') || '').trim().toUpperCase();
    const category = String(ctx.search.get('category') || '').trim().toUpperCase();
    const visibility = String(ctx.search.get('visibility') || '').trim().toUpperCase();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const requestedSort = String(ctx.search.get('sort') || 'created');
    const sort = ['created', 'updated', 'title', 'events'].includes(requestedSort) ? requestedSort : 'created';
    return materialRows({ admin: true, search, status, category, visibility, page, limit, sort });
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
  match = part.match(/^\/materials\/([^/]+)\/stats$/);
  if (match && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return materialStats(match[1]);
  }
  match = part.match(/^\/materials\/([^/]+)$/);
  if (match && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const target = row('SELECT * FROM promo_materials WHERE id=?', [match[1]]);
    if (!target) throw errors.notFound('宣传物料不存在', 'MATERIAL_NOT_FOUND');
    const material = validateMaterialBody(ctx.body || {}, target);
    const status = ctx.body?.status === undefined ? target.status : String(ctx.body.status).toUpperCase();
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('物料状态无效', 'INVALID_MATERIAL_STATUS');
    assertTransition(ctx, 'material', target.status, status, { targetType: 'PROMO_MATERIAL', targetId: target.id, before: target, allowSameState: true });
    const now = nowIso();
    transaction(() => {
      q('UPDATE promo_materials SET title=?,description=?,category=?,mime_type=?,resource_url=?,cover_url=?,visibility=?,status=?,updated_at=? WHERE id=?', [material.title, material.description, material.category, material.mimeType, material.resourceUrl, material.coverUrl, material.visibility, status, now, target.id]);
      q('DELETE FROM promo_material_assignments WHERE material_id=?', [target.id]);
      material.orgIds.forEach((targetOrgId) => q('INSERT INTO promo_material_assignments(id,material_id,org_id,created_at) VALUES (?,?,?,?)', [id('matassign'), target.id, targetOrgId, now]));
    });
    audit(ctx, 'PROMO_MATERIAL_UPDATE', 'PROMO_MATERIAL', target.id, { status: target.status }, { status, visibility: material.visibility });
    return normalizeMaterial(row('SELECT * FROM promo_materials WHERE id=?', [target.id]));
  }
  // P5-W02: 商机管理（leads）
  if (part === '/leads' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const status = ctx.search.get('status');
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const where = ['1=1']; const params = [];
    if (status && ['NEW','CONTACTED','DEMO_SCHEDULED','CONVERTED','CLOSED'].includes(status)) {
      where.push('status=?'); params.push(status);
    }
    const items = rows(`SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, [...params, limit]).map((row) => normalizeLead(row));
    return { items, total: items.length };
  }
  // P5-W02: 商机详情 + 状态更新
  let leadMatch = part.match(/^\/leads\/([^/]+)$/);
  if (leadMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const lead = row('SELECT * FROM leads WHERE id=?', [leadMatch[1]]);
    if (!lead) throw errors.notFound('商机不存在', 'LEAD_NOT_FOUND');
    return normalizeLead(lead);
  }
  if (leadMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const lead = row('SELECT * FROM leads WHERE id=?', [leadMatch[1]]);
    if (!lead) throw errors.notFound('商机不存在', 'LEAD_NOT_FOUND');
    const body = ctx.body || {};
    const VALID_TRANSITIONS = {
      NEW: ['CONTACTED', 'CLOSED'],
      CONTACTED: ['DEMO_SCHEDULED', 'CLOSED'],
      DEMO_SCHEDULED: ['CONVERTED', 'CONTACTED', 'CLOSED'],
      CONVERTED: ['CLOSED'],
      CLOSED: ['CONTACTED'],
    };
    const newStatus = body.status ? String(body.status).toUpperCase() : lead.status;
    if (!['NEW','CONTACTED','DEMO_SCHEDULED','CONVERTED','CLOSED'].includes(newStatus)) {
      throw errors.badRequest('状态无效', 'INVALID_LEAD_STATUS');
    }
    if (newStatus !== lead.status) {
      const allowed = VALID_TRANSITIONS[lead.status] || [];
      if (!allowed.includes(newStatus)) {
        throw errors.badRequest(`不能从 ${lead.status} 直接流转到 ${newStatus}`, 'INVALID_LEAD_STATUS_TRANSITION');
      }
    }
    const adminNotes = body.adminNotes !== undefined ? String(body.adminNotes || '').slice(0, 2000) : lead.admin_notes;
    const assignedTo = body.assignedTo !== undefined ? String(body.assignedTo || '').trim() || null : lead.assigned_to;
    const now = nowIso();
    q('UPDATE leads SET status=?,admin_notes=?,assigned_to=?,updated_at=? WHERE id=?',
      [newStatus, adminNotes, assignedTo, now, lead.id]);
    audit(ctx, 'LEAD_UPDATE', 'LEAD', lead.id, { status: lead.status }, { status: newStatus, adminNotes, assignedTo }, { orgId: null });
    return normalizeLead(row('SELECT * FROM leads WHERE id=?', [lead.id]));
  }
  if (part === '/notification-events' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const body = ctx.body || {};
    const eventKey = String(body.eventKey || '').trim();
    const eventType = String(body.eventType || '').trim();
    const title = nonEmptyString(body.title, '事件标题', { max: 160 });
    const content = nonEmptyString(body.body, '事件内容', { max: 10000 });
    if (!eventKey) throw errors.badRequest('eventKey 必填', 'EVENT_KEY_REQUIRED');
    if (!/^[a-zA-Z0-9_.:-]{4,128}$/.test(eventKey)) throw errors.badRequest('eventKey 必须符合 ^[a-zA-Z0-9_.:-]{4,128}$', 'INVALID_EVENT_KEY');
    if (!eventType) throw errors.badRequest('eventType 必填', 'EVENT_TYPE_REQUIRED');
    if (row('SELECT id FROM notification_events WHERE event_key=?', [eventKey])) throw errors.conflict('事件已被记录，重复投递将自动抑制', 'EVENT_KEY_DUPLICATE');
    const audience = validateAudience(body);
    const orgScope = body.orgId ? (row('SELECT id FROM organizations WHERE id=?', [body.orgId]) ? body.orgId : null) : null;
    if (body.orgId && !orgScope) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    const eventId = id('nevt');
    const now = nowIso();
    const targetUrl = body.targetUrl ? String(body.targetUrl).trim().slice(0, 500) : null;
    let suppressed = 0; let delivered = 0;
    transaction(() => {
      q('INSERT INTO notification_events(id,event_key,event_type,title,body,org_id,audience,target_url,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [eventId, eventKey, eventType, title, content, orgScope, json(audience), targetUrl, 'PENDING', auth.user.id, now, now]);
      const targets = selectAudienceUsers(audience, orgScope);
      if (targets.length === 0) {
        q('UPDATE notification_events SET status=\'DELIVERED\', updated_at=? WHERE id=?', [now, eventId]);
        return;
      }
      const notificationId = id('noti');
      q('INSERT INTO notifications(id,scope_type,org_id,sender_id,title,body,kind,target_url,audience,status,publish_at,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [notificationId, orgScope ? 'ORG' : 'PLATFORM', orgScope, auth.user.id, title, content, 'NOTICE', targetUrl, json(audience), 'PUBLISHED', null, 0, now, now]);
      targets.forEach((target) => {
        const result = dispatchRecipientEvent({ userId: target.id, notificationId, eventKey, maxRetries: 3 });
        if (result.suppressed) suppressed += 1; else delivered += 1;
      });
      q('UPDATE notification_events SET status=\'DELIVERED\', updated_at=? WHERE id=?', [now, eventId]);
    });
    audit(ctx, 'NOTIFICATION_EVENT_DISPATCH', 'NOTIFICATION_EVENT', eventId, null, { eventKey, eventType, delivered, suppressed });
    return { id: eventId, eventKey, eventType, status: 'DELIVERED', audience, totalTargets: suppressed + delivered, delivered, suppressed };
  }
  if (part === '/notification-events/summary' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const total = row('SELECT COUNT(*) n FROM notification_events')?.n || 0;
    const byStatus = rows('SELECT status, COUNT(*) n FROM notification_events GROUP BY status').map((item) => ({ status: item.status, count: Number(item.n) }));
    const totalRecipients = row('SELECT COUNT(*) n FROM notification_recipients')?.n || 0;
    const failed = row("SELECT COUNT(*) n FROM notification_recipients WHERE delivery_status='FAILED' AND ignored=0")?.n || 0;
    const suppressed = row('SELECT COUNT(*) n FROM notification_recipients WHERE ignored=1')?.n || 0;
    return { total, byStatus, totalRecipients, failed, suppressed, retriedToday: 0 };
  }
  if (part === '/notification-events' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const eventKey = String(ctx.search.get('eventKey') || '').trim();
    const status = String(ctx.search.get('status') || '').trim();
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const conditions = []; const params = [];
    if (eventKey) { conditions.push('event_key=?'); params.push(eventKey); }
    if (status) { conditions.push('status=?'); params.push(status); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const items = rows(`SELECT * FROM notification_events ${where} ORDER BY created_at DESC LIMIT ${limit}`, params).map((event) => ({ id: event.id, eventKey: event.event_key, eventType: event.event_type, title: event.title, body: event.body, orgId: event.org_id || null, targetUrl: event.target_url, status: event.status, suppressReason: event.suppress_reason, createdAt: event.created_at, updatedAt: event.updated_at }));
    return { items, total: items.length, limit };
  }
  const failRetry = part.match(/^\/notification-failures\/retry$/);
  const failIgnore = part.match(/^\/notification-failures\/ignore$/);
  if ((failRetry || failIgnore) && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const body = ctx.body || {};
    const ids = Array.isArray(body.recipientIds) ? body.recipientIds.map((v) => String(v || '').trim()).filter(Boolean) : null;
    if (!ids || !ids.length || ids.length > 500) throw errors.badRequest('recipientIds 必填且不超过 500 个', 'INVALID_RECIPIENT_IDS');
    let retried = 0; let ignored = 0; let skipped = 0;
    transaction(() => {
      for (const idVal of ids) {
        if (failRetry) {
          const result = retryRecipient(idVal);
          if (result.retried) retried += 1; else skipped += 1;
        } else {
          const result = q("UPDATE notification_recipients SET ignored=1 WHERE id=? AND delivery_status='FAILED' AND ignored=0", [idVal]);
          if (result.changes) ignored += 1; else skipped += 1;
        }
      }
    });
    if (failRetry && retried) audit(ctx, 'NOTIFICATION_FAILURE_RETRY', 'NOTIFICATION_RECIPIENT', ids.join(','), null, { count: retried });
    if (failIgnore && ignored) audit(ctx, 'NOTIFICATION_FAILURE_IGNORE', 'NOTIFICATION_RECIPIENT', ids.join(','), null, { count: ignored, reason: body.reason || 'MANUAL_IGNORE' });
    return failRetry ? { retried, skipped } : { ignored, skipped };
  }
  if (part === '/notification-failures' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const conditions = ["r.delivery_status='FAILED'", 'r.ignored=0']; const params = [];
    const orgId = String(ctx.search.get('orgId') || '').trim();
    const eventType = String(ctx.search.get('eventType') || '').trim();
    if (orgId) { conditions.push('u.org_id=?'); params.push(orgId); }
    if (eventType) { conditions.push('n.kind=?'); params.push(eventType); }
    const where = 'WHERE ' + conditions.join(' AND ');
    const items = rows(`SELECT r.id, r.notification_id, r.user_id, r.event_key, r.failure_code, r.failure_reason, r.retry_count, r.max_retries, r.created_at, n.title, n.body, n.kind, n.target_url, u.display_name user_name, u.login user_login, u.org_id, org.name org_name FROM notification_recipients r JOIN notifications n ON n.id=r.notification_id JOIN users u ON u.id=r.user_id LEFT JOIN organizations org ON org.id=u.org_id ${where} ORDER BY r.created_at DESC LIMIT ${limit}`, params).map((item) => ({ id: item.id, notificationId: item.notification_id, userId: item.user_id, eventKey: item.event_key, failureCode: item.failure_code, failureReason: item.failure_reason, retryCount: item.retry_count, maxRetries: item.max_retries, createdAt: item.created_at, title: item.title, body: item.body, kind: item.kind, targetUrl: item.target_url, userName: item.user_name, userLogin: item.user_login, orgId: item.org_id, orgName: item.org_name }));
    const total = row(`SELECT COUNT(*) n FROM notification_recipients r JOIN users u ON u.id=r.user_id ${where}`, params)?.n || 0;
    return { items, total, limit };
  }
  // ---- 投递队列管理端点 ----
  if (part === '/notification-queue/summary' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const summary = summarizeQueue();
    summary.workerId = WORKER_ID;
    return summary;
  }
  if (part === '/notification-queue/dead-letters' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const offset = integer(ctx.search.get('offset'), '偏移', { min: 0, max: 100000, fallback: 0 });
    return listDeadLetters({ limit, offset });
  }
  const dlRequeue = part.match(/^\/notification-queue\/dead-letters\/requeue$/);
  if (dlRequeue && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const body = ctx.body || {};
    const ids = Array.isArray(body.jobIds) ? body.jobIds.map((v) => String(v || '').trim()).filter(Boolean) : null;
    if (!ids || !ids.length || ids.length > 500) throw errors.badRequest('jobIds 必填且不超过 500 个', 'INVALID_JOB_IDS');
    const result = requeueDeadLetters(ids, body.reason);
    if (result.requeued) audit(ctx, 'NOTIFICATION_DISPATCH_JOB_REQUEUE', 'NOTIFICATION_DISPATCH_JOB', ids.join(','), null, { count: result.requeued });
    return result;
  }
  if (part === '/notification-queue/tick' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const result = runWorkerTick(WORKER_ID);
    audit(ctx, 'NOTIFICATION_DISPATCH_WORKER_TICK', 'NOTIFICATION_DISPATCH_JOB', null, null, { processed: result.processed, succeeded: result.succeeded, failed: result.failed });
    return { ...result, workerId: WORKER_ID };
  }
  return null;
}
