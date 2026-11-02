// 桌面客户端问题反馈：平台专属接收链路。
// 刻意不复用 help_feedback，避免机构管理员/老师读取到产品客户端反馈。
import { createHash } from 'node:crypto';
import {
  acount,
  aq,
  arow,
  arows,
  audit,
  errors,
  id,
  json,
  nonEmptyString,
  nowIso,
  parseJson,
  requireRole,
} from '../lib.js';
import {
  authorizeFileAccess,
  createUploadedFileAsset,
  prepareFileDownload,
} from './fileAssets.js';

const CLIENT_FEEDBACK_PREFIX = '/api/client-feedback';
const CLIENT_FEEDBACK_TYPES = new Set(['bug', 'usage', 'feature', 'performance']);
const CLIENT_FEEDBACK_SEVERITIES = new Set(['P1-高', 'P2-中', 'P3-低']);
const CLIENT_FEEDBACK_ATTACHMENT_KINDS = new Set(['log', 'image', 'other']);
function integer(value, label, { min = 0, max = 1_000_000, fallback = 0 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw errors.badRequest(`${label}无效`, 'VALIDATION_ERROR');
  }
  return parsed;
}

const CLIENT_FEEDBACK_STATUS_LABELS = {
  SUBMITTED: '已提交',
  IN_PROGRESS: '开发中',
  RESOLVED: '已解决',
  CLOSED: '已归档',
};

function feedbackIdFor(userId, idempotencyKey) {
  return `cfb_${createHash('sha256').update(`${userId}\0${idempotencyKey}`).digest('hex').slice(0, 20)}`;
}

function statusLabel(status) {
  return CLIENT_FEEDBACK_STATUS_LABELS[String(status || '').toUpperCase()] || '已提交';
}

function normalizeAttachment(row, { admin = false } = {}) {
  const downloadUrl = admin
    ? `/api/admin/file-assets/${encodeURIComponent(row.file_id)}/download`
    : `/api/client-feedback/${encodeURIComponent(row.feedback_id)}/attachments/${encodeURIComponent(row.id)}/download`;
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    size: Number(row.file_size || 0),
    content_type: row.mime_type || null,
    download_url: downloadUrl,
    preview_url: row.kind === 'image' ? downloadUrl : null,
    created_at: row.created_at,
  };
}

function normalizeMessage(row, index) {
  return {
    id: index + 1,
    message_id: row.id,
    author_user_id: row.sender_user_id || null,
    author_display_name: row.sender_type === 'PLATFORM' ? row.sender_name || '平台方' : row.sender_name || null,
    body: row.body,
    is_staff: row.sender_type === 'PLATFORM',
    created_at: row.created_at,
  };
}

function normalizeSummary(row) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    severity: row.severity || undefined,
    module: row.module || undefined,
    status: statusLabel(row.status),
    raw_status: row.status,
    reporter_display: row.user_name || row.user_login || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    org_id: row.org_id || null,
    org_name: row.org_name || null,
  };
}

export async function loadClientFeedbackRow(feedbackId, userId = null) {
  const where = userId ? 'feedback.id=? AND feedback.user_id=?' : 'feedback.id=?';
  const params = userId ? [feedbackId, userId] : [feedbackId];
  return await arow(
    `SELECT feedback.*, submitter.display_name AS user_name, submitter.login AS user_login,
            organization.name AS org_name, handler.display_name AS handler_name
       FROM client_feedback feedback
       JOIN users submitter ON submitter.id=feedback.user_id
       LEFT JOIN organizations organization ON organization.id=feedback.org_id
       LEFT JOIN users handler ON handler.id=feedback.handled_by
      WHERE ${where}`,
    params,
  );
}

export async function loadClientFeedbackDetail(row, { admin = false } = {}) {
  if (!row) return null;
  const attachments = await arows(
    'SELECT * FROM client_feedback_attachments WHERE feedback_id=? ORDER BY created_at ASC',
    [row.id],
  );
  const messages = await arows(
    `SELECT message.*, sender.display_name AS sender_name
       FROM client_feedback_messages message
       LEFT JOIN users sender ON sender.id=message.sender_user_id
      WHERE message.feedback_id=? ORDER BY message.created_at ASC`,
    [row.id],
  );
  const environment = parseJson(row.environment, {});
  const comments = messages.map(normalizeMessage);
  const events = [{
    id: 1,
    type: 'created',
    summary: '反馈已提交到灵动ai平台',
    created_at: row.created_at,
  }];
  if (row.status !== 'SUBMITTED') {
    events.push({
      id: 2,
      type: 'status_changed',
      summary: `状态更新为${statusLabel(row.status)}`,
      actor_display_name: row.handler_name || '平台方',
      created_at: row.updated_at,
    });
  }
  return {
    ...normalizeSummary(row),
    description: row.description,
    framework: environment?.agentFramework || undefined,
    reporter: {
      user_id: row.user_id,
      username: row.user_login || undefined,
      display_name: row.user_name || undefined,
    },
    device: environment,
    contact: row.contact || null,
    resolution: row.resolution || null,
    handled_at: row.handled_at || null,
    handled_by: row.handled_by || null,
    handler_name: row.handler_name || null,
    attachments: attachments.map((attachment) => normalizeAttachment(attachment, { admin })),
    comments,
    events,
    lark_record_id: null,
  };
}

function validateCreateInput(input) {
  const body = input && typeof input === 'object' ? input : {};
  const type = String(body.type || 'bug').trim().toLowerCase();
  if (!CLIENT_FEEDBACK_TYPES.has(type)) {
    throw errors.badRequest('反馈类型无效', 'INVALID_FEEDBACK_TYPE');
  }
  const severity = body.severity == null || String(body.severity).trim() === ''
    ? null
    : String(body.severity).trim();
  if (severity && !CLIENT_FEEDBACK_SEVERITIES.has(severity)) {
    throw errors.badRequest('反馈严重度无效', 'INVALID_FEEDBACK_SEVERITY');
  }
  const environment = body.environment && typeof body.environment === 'object' ? body.environment : {};
  const serializedEnvironment = json(environment);
  if (Buffer.byteLength(serializedEnvironment, 'utf8') > 64 * 1024) {
    throw errors.badRequest('客户端环境信息过大', 'FEEDBACK_ENVIRONMENT_TOO_LARGE');
  }
  return {
    idempotencyKey: nonEmptyString(body.idempotencyKey, '幂等键', { max: 200 }),
    title: nonEmptyString(body.title, '反馈标题', { max: 200 }),
    description: nonEmptyString(body.description, '反馈描述', { max: 20_000 }),
    type,
    severity,
    module: body.module == null || String(body.module).trim() === ''
      ? null
      : nonEmptyString(body.module, '反馈模块', { max: 120 }),
    contact: body.contact == null || String(body.contact).trim() === ''
      ? null
      : nonEmptyString(body.contact, '联系方式', { max: 200 }),
    environment: serializedEnvironment,
  };
}

async function createFeedback(ctx, auth) {
  const input = validateCreateInput(ctx.body);
  const feedbackId = feedbackIdFor(auth.user.id, input.idempotencyKey);
  const now = nowIso();
  try {
    await aq(
      `INSERT INTO client_feedback(
         id,user_id,org_id,idempotency_key,title,description,type,severity,module,contact,
         environment,device_mid,status,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        feedbackId,
        auth.user.id,
        auth.user.orgId || null,
        input.idempotencyKey,
        input.title,
        input.description,
        input.type,
        input.severity,
        input.module,
        input.contact,
        input.environment,
        String(ctx.req.headers['x-device-mid'] || '').trim() || null,
        'SUBMITTED',
        now,
        now,
      ],
    );
    await audit(ctx, 'CLIENT_FEEDBACK_CREATE', 'CLIENT_FEEDBACK', feedbackId, null, {
      type: input.type,
      severity: input.severity,
      module: input.module,
    });
  } catch (error) {
    // 同一个 operationId 的重试直接返回已建工单；不把数据库主键冲突暴露给客户端。
    const existing = await arow('SELECT * FROM client_feedback WHERE id=?', [feedbackId]);
    if (!existing) throw error;
  }
  return await loadClientFeedbackDetail(await loadClientFeedbackRow(feedbackId, auth.user.id));
}

async function listMyFeedback(ctx, auth) {
  const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 50 });
  const items = await arows(
    `SELECT feedback.*, submitter.display_name AS user_name, submitter.login AS user_login,
            organization.name AS org_name
       FROM client_feedback feedback
       JOIN users submitter ON submitter.id=feedback.user_id
       LEFT JOIN organizations organization ON organization.id=feedback.org_id
      WHERE feedback.user_id=?
      ORDER BY feedback.created_at DESC LIMIT ${limit}`,
    [auth.user.id],
  );
  return { items: items.map(normalizeSummary), total: items.length };
}

async function getMyFeedback(ctx, auth, feedbackId) {
  const row = await loadClientFeedbackRow(feedbackId, auth.user.id);
  if (!row) throw errors.notFound('反馈不存在', 'CLIENT_FEEDBACK_NOT_FOUND');
  return await loadClientFeedbackDetail(row);
}

async function addMyMessage(ctx, auth, feedbackId) {
  const row = await loadClientFeedbackRow(feedbackId, auth.user.id);
  if (!row) throw errors.notFound('反馈不存在', 'CLIENT_FEEDBACK_NOT_FOUND');
  const body = nonEmptyString(ctx.body?.body, '补充说明', { max: 4_000 });
  const messageId = id('cfbmsg');
  const now = nowIso();
  await aq(
    'INSERT INTO client_feedback_messages(id,feedback_id,sender_type,sender_user_id,body,created_at) VALUES (?,?,?,?,?,?)',
    [messageId, feedbackId, 'USER', auth.user.id, body, now],
  );
  await aq('UPDATE client_feedback SET updated_at=? WHERE id=?', [now, feedbackId]);
  return {
    id: 1,
    message_id: messageId,
    author_user_id: auth.user.id,
    author_display_name: auth.user.displayName || null,
    body,
    is_staff: false,
    created_at: now,
  };
}

async function uploadMyAttachment(ctx, auth, feedbackId) {
  const row = await loadClientFeedbackRow(feedbackId, auth.user.id);
  if (!row) throw errors.notFound('反馈不存在', 'CLIENT_FEEDBACK_NOT_FOUND');
  const kind = String(ctx.search.get('kind') || 'other').trim().toLowerCase();
  if (!CLIENT_FEEDBACK_ATTACHMENT_KINDS.has(kind)) {
    throw errors.badRequest('附件类型无效', 'INVALID_FEEDBACK_ATTACHMENT_KIND');
  }
  const uploaded = await createUploadedFileAsset(ctx, {
    auth,
    ownerType: 'USER',
    ownerOrgId: auth.user.orgId || null,
    scope: 'student',
    defaultVisibility: 'PRIVATE',
  });
  const attachmentId = id('cfbatt');
  const now = nowIso();
  try {
    await aq(
      `INSERT INTO client_feedback_attachments(
         id,feedback_id,file_id,kind,filename,mime_type,file_size,created_at
       ) VALUES (?,?,?,?,?,?,?,?)`,
      [
        attachmentId,
        feedbackId,
        uploaded.id,
        kind,
        uploaded.fileName,
        uploaded.mimeType || null,
        Number(uploaded.bytes || 0),
        now,
      ],
    );
    await aq('UPDATE client_feedback SET updated_at=? WHERE id=?', [now, feedbackId]);
  } catch (error) {
    // 文件行已落盘但业务关联失败时禁用文件，避免变成无主可读资产。
    await aq("UPDATE file_assets SET status='DISABLED', updated_at=? WHERE id=?", [now, uploaded.id]).catch(() => {});
    throw error;
  }
  return normalizeAttachment(await arow('SELECT * FROM client_feedback_attachments WHERE id=?', [attachmentId]));
}

async function downloadMyAttachment(ctx, auth, feedbackId, attachmentId) {
  const attachment = await arow(
    `SELECT attachment.*
       FROM client_feedback_attachments attachment
       JOIN client_feedback feedback ON feedback.id=attachment.feedback_id
      WHERE attachment.id=? AND attachment.feedback_id=? AND feedback.user_id=?`,
    [attachmentId, feedbackId, auth.user.id],
  );
  if (!attachment) throw errors.notFound('附件不存在', 'CLIENT_FEEDBACK_ATTACHMENT_NOT_FOUND');
  return await prepareFileDownload(ctx, await authorizeFileAccess(ctx, attachment.file_id, 'DOWNLOAD'));
}

export async function handleClientFeedback(ctx) {
  const { pathname, method } = ctx;
  if (pathname !== CLIENT_FEEDBACK_PREFIX && !pathname.startsWith(`${CLIENT_FEEDBACK_PREFIX}/`)) {
    return null;
  }
  const auth = requireRole(ctx, ['STUDENT', 'TEACHER', 'ORG_ADMIN', 'SUPER_ADMIN']);
  const part = pathname.slice(CLIENT_FEEDBACK_PREFIX.length) || '/';
  if (part === '/' && method === 'POST') return await createFeedback(ctx, auth);
  if (part === '/' && method === 'GET') return await listMyFeedback(ctx, auth);

  let match = part.match(/^\/([^/]+)$/);
  if (match && method === 'GET') return await getMyFeedback(ctx, auth, match[1]);

  match = part.match(/^\/([^/]+)\/messages$/);
  if (match && method === 'POST') return await addMyMessage(ctx, auth, match[1]);

  match = part.match(/^\/([^/]+)\/attachments$/);
  if (match && method === 'POST') return await uploadMyAttachment(ctx, auth, match[1]);

  match = part.match(/^\/([^/]+)\/attachments\/([^/]+)\/download$/);
  if (match && method === 'GET') return await downloadMyAttachment(ctx, auth, match[1], match[2]);

  return null;
}


