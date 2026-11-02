// 平台管理端：客户端问题反馈收件箱。
// 只查询 client_feedback，刻意不读取机构 help_feedback。
import { acount, aq, arow, arows, audit, errors, id, nonEmptyString, nowIso } from '../../lib.js';
import {
  loadClientFeedbackDetail,
  loadClientFeedbackRow,
} from '../clientFeedback.js';

const STATUSES = new Set(['SUBMITTED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
const TYPES = new Set(['bug', 'usage', 'feature', 'performance']);
function integer(value, label, { min = 0, max = 1_000_000, fallback = 0 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw errors.badRequest(`${label}无效`, 'VALIDATION_ERROR');
  }
  return parsed;
}

const TRANSITIONS = {
  SUBMITTED: new Set(['IN_PROGRESS', 'RESOLVED', 'CLOSED']),
  IN_PROGRESS: new Set(['RESOLVED', 'CLOSED']),
  RESOLVED: new Set(['CLOSED']),
  CLOSED: new Set(),
};

function buildFilters(ctx) {
  const conditions = [];
  const params = [];
  const status = String(ctx.search.get('status') || '').trim().toUpperCase();
  const type = String(ctx.search.get('type') || '').trim().toLowerCase();
  const search = String(ctx.search.get('search') || '').trim();
  if (STATUSES.has(status)) {
    conditions.push('feedback.status=?');
    params.push(status);
  }
  if (TYPES.has(type)) {
    conditions.push('feedback.type=?');
    params.push(type);
  }
  if (search) {
    conditions.push("(feedback.title LIKE ? OR feedback.description LIKE ? OR submitter.login LIKE ? OR submitter.display_name LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

async function listFeedback(ctx) {
  const page = integer(ctx.search.get('page'), '页码', { min: 1, fallback: 1 });
  const limit = integer(ctx.search.get('limit'), '每页数量', { min: 1, max: 100, fallback: 20 });
  const offset = (page - 1) * limit;
  const { where, params } = buildFilters(ctx);
  const total = await acount(
    `SELECT COUNT(*) AS n
       FROM client_feedback feedback
       JOIN users submitter ON submitter.id=feedback.user_id
       ${where}`,
    params,
  );
  const rows = await arows(
    `SELECT feedback.*, submitter.display_name AS user_name, submitter.login AS user_login,
            organization.name AS org_name
       FROM client_feedback feedback
       JOIN users submitter ON submitter.id=feedback.user_id
       LEFT JOIN organizations organization ON organization.id=feedback.org_id
       ${where}
      ORDER BY CASE feedback.status WHEN 'SUBMITTED' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
               feedback.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const summary = await arows(
    `SELECT feedback.status, COUNT(*) AS n FROM client_feedback feedback GROUP BY feedback.status`,
  );
  const counts = { submitted: 0, inProgress: 0, resolved: 0, closed: 0 };
  for (const item of summary) {
    if (item.status === 'SUBMITTED') counts.submitted = Number(item.n || 0);
    if (item.status === 'IN_PROGRESS') counts.inProgress = Number(item.n || 0);
    if (item.status === 'RESOLVED') counts.resolved = Number(item.n || 0);
    if (item.status === 'CLOSED') counts.closed = Number(item.n || 0);
  }
  const attachmentCounts = await arows(
    `SELECT feedback_id, COUNT(*) AS n FROM client_feedback_attachments GROUP BY feedback_id`,
  );
  const countByFeedback = new Map(attachmentCounts.map((item) => [item.feedback_id, Number(item.n || 0)]));
  return {
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      severity: row.severity || null,
      module: row.module || null,
      status: row.status,
      userId: row.user_id,
      userName: row.user_name || null,
      userLogin: row.user_login || null,
      orgId: row.org_id || null,
      orgName: row.org_name || null,
      deviceMid: row.device_mid || null,
      attachmentCount: countByFeedback.get(row.id) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    counts,
  };
}

async function getFeedback(feedbackId) {
  const row = await loadClientFeedbackRow(feedbackId);
  if (!row) throw errors.notFound('反馈不存在', 'CLIENT_FEEDBACK_NOT_FOUND');
  return await loadClientFeedbackDetail(row, { admin: true });
}

async function updateFeedback(ctx, feedbackId, auth) {
  const row = await loadClientFeedbackRow(feedbackId);
  if (!row) throw errors.notFound('反馈不存在', 'CLIENT_FEEDBACK_NOT_FOUND');
  const status = String(ctx.body?.status || '').trim().toUpperCase();
  if (!STATUSES.has(status)) throw errors.badRequest('反馈状态无效', 'INVALID_CLIENT_FEEDBACK_STATUS');
  if (status !== row.status && !TRANSITIONS[row.status]?.has(status)) {
    throw errors.badRequest(`反馈状态不能从 ${row.status} 变为 ${status}`, 'INVALID_CLIENT_FEEDBACK_TRANSITION');
  }
  const resolution = ctx.body?.resolution == null || String(ctx.body.resolution).trim() === ''
    ? null
    : nonEmptyString(ctx.body.resolution, '处理结果', { max: 4_000 });
  if ((status === 'RESOLVED' || status === 'CLOSED') && !resolution) {
    throw errors.badRequest('标记已解决或已关闭时必须填写处理结果', 'CLIENT_FEEDBACK_RESOLUTION_REQUIRED');
  }
  const now = nowIso();
  await aq(
    'UPDATE client_feedback SET status=?,resolution=?,handled_by=?,handled_at=?,updated_at=? WHERE id=?',
    [status, resolution, status === 'SUBMITTED' ? null : auth.id, status === 'SUBMITTED' ? null : now, now, feedbackId],
  );
  await audit(ctx, 'CLIENT_FEEDBACK_UPDATE', 'CLIENT_FEEDBACK', feedbackId, row, { status, resolution });
  return await getFeedback(feedbackId);
}

async function addPlatformMessage(ctx, feedbackId, auth) {
  const row = await loadClientFeedbackRow(feedbackId);
  if (!row) throw errors.notFound('反馈不存在', 'CLIENT_FEEDBACK_NOT_FOUND');
  const body = nonEmptyString(ctx.body?.body, '回复内容', { max: 4_000 });
  const messageId = id('cfbmsg');
  const now = nowIso();
  await aq(
    'INSERT INTO client_feedback_messages(id,feedback_id,sender_type,sender_user_id,body,created_at) VALUES (?,?,?,?,?,?)',
    [messageId, feedbackId, 'PLATFORM', auth.id, body, now],
  );
  await aq('UPDATE client_feedback SET updated_at=? WHERE id=?', [now, feedbackId]);
  await audit(ctx, 'CLIENT_FEEDBACK_REPLY', 'CLIENT_FEEDBACK', feedbackId, null, { messageId });
  return {
    id: messageId,
    message_id: messageId,
    body,
    is_staff: true,
    author_display_name: auth.displayName || '平台方',
    created_at: now,
  };
}

export async function handleAdminClientFeedback(ctx, part, method) {
  if (part === '/client-feedback' && method === 'GET') return await listFeedback(ctx);
  let match = part.match(/^\/client-feedback\/([^/]+)$/);
  if (match && method === 'GET') return await getFeedback(match[1]);
  if (match && method === 'PUT') return await updateFeedback(ctx, match[1], ctx.auth.user);
  match = part.match(/^\/client-feedback\/([^/]+)\/messages$/);
  if (match && method === 'POST') return await addPlatformMessage(ctx, match[1], ctx.auth.user);
  return null;
}



