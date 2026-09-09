// 通知/物料/官网内容/线索/站内信：student 域，从 communication.js 拆出。
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
import { WEBSITE_CONTENT_DEFAULTS, WEBSITE_CONTENT_KEYS, websiteContentDefault } from '../../services/websiteContentDefaults.js';
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
  websiteContentDefaultEntry,
  websiteContentKey,
  websiteContentRevisions,
  websiteContentValue,
  workerInterval,
  workerStarted,
} from './helpers.js';

function normalizeHelpFeedback(value, { includeUser = false } = {}) {
  if (!value) return null;
  const item = {
    id: value.id,
    userId: value.user_id,
    orgId: value.org_id || null,
    category: value.category,
    subject: value.subject,
    body: value.body,
    contact: value.contact || null,
    status: value.status,
    submittedAt: value.submitted_at,
    handledAt: value.handled_at || null,
    resolvedAt: value.handled_at || null,
    handledBy: value.handled_by || null,
    handlerName: value.handler_name || null,
    resolution: value.resolution || null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
  if (includeUser) {
    item.userName = value.user_name || null;
    item.userLogin = value.user_login || null;
  }
  return item;
}

function helpFeedbackRows(where, params) {
  return rows(
    `SELECT feedback.*, student.display_name AS user_name, student.login AS user_login, handler.display_name AS handler_name
     FROM help_feedback feedback
     JOIN users student ON student.id=feedback.user_id
     LEFT JOIN users handler ON handler.id=feedback.handled_by
     WHERE ${where}`,
    params,
  ).map((item) => normalizeHelpFeedback(item, { includeUser: true }));
}

function helpCenterPayload() {
  return {
    version: HELP_CENTER_VERSION,
    generatedAt: nowIso(),
    faq: HELP_FAQ,
    guides: [
      { title: '第一次进入课堂', steps: ['打开学习首页，查看本节课任务。', '按老师要求进入对应课时。', '创建或继续项目，保存画布后按老师要求提交。'] },
      { title: '提交作品并查看反馈', steps: ['在“我的作品”选择要提交的项目。', '确认版权和机构展示授权后提交。', '老师点评后查看整体反馈与节点批注，按建议修改重提。'] },
      { title: '保护个人隐私', steps: ['进入个人账号，检查昵称和预设头像。', '按需填写或清空监护人信息。', '设置作品墙匿名展示和精选授权。'] },
    ],
    compatibility: {
      web: ['Chrome / Edge 最新两个稳定版本', 'Safari 17+（macOS）', '课堂依赖稳定网络；建议机构机房提前检查'],
    },
    feedback: {
      categories: [...HELP_FEEDBACK_CATEGORIES],
      privacy: '反馈仅用于排查问题；请勿填写密码、身份证号、家庭住址等敏感信息。',
      maxSubjectLength: 120,
      maxBodyLength: 2000,
      maxContactLength: 100,
    },
  };
}
export async function handleStudentCommunication(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/student/')) return null;
  // /api/student/billing-config 由独立路由处理
  if (pathname.startsWith('/api/student/billing-config')) return null;
  const auth = requireRole(ctx, ['STUDENT']);
  const currentOrgId = orgId(auth);
  const part = pathname.slice('/api/student'.length);
  if (part === '/inbox' && method === 'GET') {
    dispatchDueNotifications();
    const items = notificationRecipientRows(currentOrgId, auth.user.id);
    return { items, unread: items.filter((item) => !item.readAt).length, total: items.length };
  }
  let match = part.match(/^\/inbox\/([^/]+)\/read$/);
  if (match && method === 'PUT') return markNotificationRead(ctx, currentOrgId, match[1], auth.user.id);
  if (part === '/inbox/read-all' && method === 'PUT') return markAllNotificationsRead(ctx, currentOrgId, auth.user.id);
  if (part === '/help' && method === 'GET') {
    const items = helpFeedbackRows('feedback.user_id=? AND feedback.org_id=?', [auth.user.id, currentOrgId]);
    return {
      ...helpCenterPayload(),
      myFeedback: {
        items,
        total: items.length,
        submitted: items.filter((item) => item.status === 'SUBMITTED').length,
        inProgress: items.filter((item) => item.status === 'IN_PROGRESS').length,
        resolved: items.filter((item) => item.status === 'RESOLVED' || item.status === 'CLOSED').length,
      },
    };
  }
  if (part === '/help/feedback' && method === 'POST') {
    const category = String(ctx.body?.category || '').toUpperCase();
    if (!HELP_FEEDBACK_CATEGORIES.has(category)) throw errors.badRequest('反馈分类无效', 'INVALID_FEEDBACK_CATEGORY');
    const subject = nonEmptyString(ctx.body?.subject, '问题标题', { max: 120 });
    const body = nonEmptyString(ctx.body?.body, '问题描述', { max: 2000 });
    let contact = null;
    if (ctx.body?.contact != null && String(ctx.body.contact).trim() !== '') contact = nonEmptyString(ctx.body.contact, '联系方式', { max: 100 });
    if (/password|密码|身份证|住址/i.test(subject + '\n' + body + '\n' + (contact || ''))) {
      throw errors.badRequest('反馈中请勿填写密码、身份证号或住址等敏感信息', 'FEEDBACK_SENSITIVE_CONTENT');
    }
    const now = nowIso();
    const feedbackId = id('helpfb');
    q(
      'INSERT INTO help_feedback(id,user_id,org_id,category,subject,body,contact,status,submitted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [feedbackId, auth.user.id, currentOrgId, category, subject, body, contact, 'SUBMITTED', now, now, now],
    );
    audit(ctx, 'HELP_FEEDBACK_CREATE', 'HELP_FEEDBACK', feedbackId, null, { category, subject });
    return {
      feedback: normalizeHelpFeedback(row('SELECT * FROM help_feedback WHERE id=?', [feedbackId])),
      privacy: '反馈已提交给当前机构处理；请勿在描述中包含密码、身份证号或住址。',
    };
  }
  match = part.match(/^\/help\/feedback\/([^/]+)$/);
  if (match && method === 'GET') {
    const feedback = helpFeedbackRows('feedback.id=? AND feedback.user_id=? AND feedback.org_id=?', [match[1], auth.user.id, currentOrgId])[0];
    if (!feedback) throw errors.notFound('反馈不存在', 'HELP_FEEDBACK_NOT_FOUND');
    return feedback;
  }
  return null;
}

