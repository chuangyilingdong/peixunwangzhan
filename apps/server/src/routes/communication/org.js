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

const HELP_CENTER_VERSION = 'P4-S07';
const HELP_FEEDBACK_CATEGORIES = new Set(['ACCOUNT', 'CANVAS', 'AI', 'COURSE', 'CLIENT', 'DATA', 'OTHER']);
const HELP_FAQ = [
  { category: 'ACCOUNT', question: '忘记密码或登录不上怎么办？', answer: '请联系你的老师或机构管理员重置密码。密码重置后，老师会把新账号信息交给你，首次登录可在个人账号中修改。' },
  { category: 'CANVAS', question: '作品还没做完可以保存吗？', answer: '可以。进入项目后保存画布，作品会保留在“我的项目”。已提交或已发布的作品需按老师反馈修改后重新提交。' },
  { category: 'AI', question: '为什么 AI 现在不能使用？', answer: '请先查看 AI / 魔法石中心。老师可能关闭了本节课的某类 AI 能力，或课堂积分、调用次数已达到上限。' },
  { category: 'COURSE', question: '如何知道这节课要做什么？', answer: '在学习首页查看“我的学习任务”，再按课时进入创作。课堂开始后，老师设置的课堂要求也会显示在首页。' },
  { category: 'CLIENT', question: '可以在家里的电脑使用吗？', answer: 'Web 端可使用现代浏览器访问；桌面安装包需由机构或平台配置真实下载地址后才提供下载。未配置时页面不会提供安装包。' },
  { category: 'DATA', question: '我的头像和监护人信息会被收集吗？', answer: '平台仅保存昵称、平台预设头像键、必要监护人联系信息和隐私开关，不收集住址、身份证号和社交账号。可在个人账号中查看或清空。' },
  { category: 'OTHER', question: '遇到页面错误或内容异常怎么办？', answer: '请在帮助与下载页提交问题反馈，选择对应分类并写清楚出现步骤。老师或机构管理员会跟进处理。' },
];
