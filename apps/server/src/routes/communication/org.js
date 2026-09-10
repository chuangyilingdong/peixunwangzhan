// 通知/物料/官网内容/线索/站内信：org 域，从 communication.js 拆出。
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
  HELP_CENTER_VERSION,
  HELP_FAQ,
  HELP_FEEDBACK_CATEGORIES,
  backoffSeconds,
  bool,
  claimDispatchJobs,
  dispatchDueNotifications,
  dispatchRecipientEvent,
  effectiveNotificationStatus,
  enqueueDispatchJob,
  helpFeedbackRows,
  integer,
  listDeadLetters,
  markAllNotificationsRead,
  markJobFailed,
  markJobSucceeded,
  markNotificationRead,
  markRecipientFailed,
  materialRows,
  materialStats,
  normalizeHelpFeedback,
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

export async function handleOrgCommunication(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/org/')) return null;
  // /api/org/file-assets 与 /api/org/billing-config 由独立路由处理（含 STUDENT 角色）
  if (pathname.startsWith('/api/org/file-assets')) return null;
  if (pathname.startsWith('/api/org/billing-config')) return null;
  const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER']);
  const currentOrgId = orgId(auth);
  const part = pathname.slice('/api/org'.length);
  if (part === '/inbox' && method === 'GET') {
    dispatchDueNotifications();
    const items = notificationRecipientRows(currentOrgId, auth.user.id);
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
  if (match && method === 'PUT') return markNotificationRead(ctx, currentOrgId, match[1], auth.user.id);
  if (part === '/inbox/read-all' && method === 'PUT') return markAllNotificationsRead(ctx, currentOrgId, auth.user.id);
  if (part === '/materials' && method === 'GET') {
    const result = materialRows({ currentOrgId });
    return { items: result.items, total: result.total };
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
  if (part === '/help-feedback' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可以处理问题反馈', 'HELP_FEEDBACK_PERMISSION_DENIED');
    const status = ctx.search.get('status');
    const category = String(ctx.search.get('category') || '').toUpperCase();
    let where = 'feedback.org_id=?'; const params = [currentOrgId];
    if (['SUBMITTED','IN_PROGRESS','RESOLVED','CLOSED'].includes(status)) { where += ' AND feedback.status=?'; params.push(status); }
    if (HELP_FEEDBACK_CATEGORIES.has(category)) { where += ' AND feedback.category=?'; params.push(category); }
    const items = helpFeedbackRows(where + " ORDER BY CASE feedback.status WHEN 'SUBMITTED' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END, feedback.submitted_at DESC LIMIT 200", params);
    return {
      items,
      total: items.length,
      submitted: items.filter((item) => item.status === 'SUBMITTED').length,
      inProgress: items.filter((item) => item.status === 'IN_PROGRESS').length,
      resolved: items.filter((item) => item.status === 'RESOLVED' || item.status === 'CLOSED').length,
    };
  }
  let helpFeedbackMatch = part.match(/^\/help-feedback\/([^/]+)$/);
  if (helpFeedbackMatch && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可以处理问题反馈', 'HELP_FEEDBACK_PERMISSION_DENIED');
    const feedback = helpFeedbackRows('feedback.id=? AND feedback.org_id=?', [helpFeedbackMatch[1], currentOrgId])[0];
    if (!feedback) throw errors.notFound('反馈不存在', 'HELP_FEEDBACK_NOT_FOUND');
    return feedback;
  }
  if (helpFeedbackMatch && method === 'PUT') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可以处理问题反馈', 'HELP_FEEDBACK_PERMISSION_DENIED');
    const feedbackRow = row('SELECT * FROM help_feedback WHERE id=? AND org_id=?', [helpFeedbackMatch[1], currentOrgId]);
    if (!feedbackRow) throw errors.notFound('反馈不存在', 'HELP_FEEDBACK_NOT_FOUND');
    const status = String(ctx.body?.status || '').toUpperCase();
    if (!['IN_PROGRESS','RESOLVED','CLOSED'].includes(status)) throw errors.badRequest('反馈处理状态无效', 'INVALID_HELP_FEEDBACK_STATUS');
    const resolution = nonEmptyString(ctx.body?.resolution, '处理结果', { max: 2000 });
    const now = nowIso();
    q('UPDATE help_feedback SET status=?,handled_by=?,handled_at=?,resolution=?,updated_at=? WHERE id=? AND org_id=?', [status, auth.user.id, now, resolution, now, feedbackRow.id, currentOrgId]);
    audit(ctx, 'ORG_HELP_FEEDBACK_UPDATE', 'HELP_FEEDBACK', feedbackRow.id, normalizeHelpFeedback(feedbackRow), { status, resolution }, { orgId: currentOrgId });
    return helpFeedbackRows('feedback.id=? AND feedback.org_id=?', [feedbackRow.id, currentOrgId])[0];
  }
  return null;
}

