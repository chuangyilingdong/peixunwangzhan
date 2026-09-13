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
const NOTIFICATION_ROLES = new Set(['ORG_ADMIN', 'TEACHER', 'STUDENT']);
const NOTIFICATION_KINDS = new Set(['NOTICE', 'ANNOUNCEMENT', 'REMINDER']);
const NOTIFICATION_SCOPES = new Set(['ALL_ORGS', 'ORG_IDS']);
const MATERIAL_CATEGORIES = new Set(['GENERAL', 'COURSE', 'POSTER', 'ACTIVITY', 'PARTNERSHIP']);
const LEGAL_POLICY_VERSION = '2026.09.03';

function integer(value, label, { min = 0, max = 1000000, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw errors.badRequest(`${label} 必须是整数`, 'INVALID_INTEGER');
  if (n < min) throw errors.badRequest(`${label} 不能小于 ${min}`, 'INTEGER_TOO_SMALL');
  if (n > max) throw errors.badRequest(`${label} 不能超过 ${max}`, 'INTEGER_TOO_LARGE');
  return n;
}

function orgId(auth) {
  if (!auth.user.orgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');
  return auth.user.orgId;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function effectiveNotificationStatus(value) {
  if (value.status === 'DRAFT' && value.publish_at) return 'SCHEDULED';
  return value.status;
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
    status: effectiveNotificationStatus(value),
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

function normalizeTemplate(value) {
  if (!value) return null;
  return {
    id: value.id,
    name: value.name,
    title: value.title,
    body: value.body,
    kind: value.kind,
    targetUrl: value.target_url || null,
    audience: parseJson(value.audience, {}),
    status: value.status,
    createdBy: value.created_by,
    createdByName: value.created_by_name || null,
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

function normalizeLead(value) {
  if (!value) return null;
  return {
    id: value.id,
    orgName: value.org_name,
    contactName: value.contact_name,
    contactPhone: value.contact_phone,
    intent: value.intent || '',
    notes: value.notes || '',
    status: value.status,
    adminNotes: value.admin_notes || '',
    assignedTo: value.assigned_to || null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    legalConsentVersion: value.legal_consent_version || null,
    legalConsentedAt: value.legal_consented_at || null,
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

function validateKind(value, fallback = 'NOTICE') {
  const kind = String(value || fallback).toUpperCase();
  if (!NOTIFICATION_KINDS.has(kind)) throw errors.badRequest('通知类型无效', 'INVALID_NOTIFICATION_KIND');
  return kind;
}

function scheduledPublishAt(value, fallback = null) {
  const raw = value ?? fallback;
  if (!raw) throw errors.badRequest('定时发布需要设置发布时间', 'NOTIFICATION_PUBLISH_AT_REQUIRED');
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw errors.badRequest('通知发布时间格式无效', 'INVALID_NOTIFICATION_PUBLISH_AT');
  if (date.getTime() <= Date.now()) throw errors.badRequest('定时发布时间必须晚于当前时间', 'NOTIFICATION_PUBLISH_AT_NOT_FUTURE');
  return date.toISOString();
}

function notificationRecipients(notificationId, scopeType, notificationOrgId, audience, eventKey) {
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
  const targetIds = targets.map((target) => target.id);
  if (targetIds.length) {
    q(`DELETE FROM notification_recipients WHERE notification_id=? AND user_id NOT IN (${targetIds.map(() => '?').join(',')})`, [notificationId, ...targetIds]);
  } else {
    q('DELETE FROM notification_recipients WHERE notification_id=?', [notificationId]);
  }
  const now = nowIso();
  targets.forEach((target) => {
    q('INSERT OR IGNORE INTO notification_recipients(id,notification_id,user_id,event_key,delivery_status,delivered_at,created_at) VALUES (?,?,?,?,?,?,?)', [id('nrec'), notificationId, target.id, eventKey || null, 'DELIVERED', now, now]);
  });
  return targets.length;
}

// 事件去重：在事件抑制窗口内已存在同 event_key + user 的成功或待发投递则跳过；返回 { suppressed, delivered, failed }
function dispatchRecipientEvent({ userId, notificationId, eventKey, maxRetries }) {
  if (eventKey) {
    const prior = row("SELECT id, delivery_status, ignored FROM notification_recipients WHERE event_key=? AND user_id=? AND ignored=0 ORDER BY created_at DESC LIMIT 1", [eventKey, userId]);
    if (prior && (prior.delivery_status === 'DELIVERED' || prior.delivery_status === 'PENDING')) {
      return { suppressed: true, reason: 'event_dedup' };
    }
  }
  const now = nowIso();
  q('INSERT OR REPLACE INTO notification_recipients(id,notification_id,user_id,event_key,delivery_status,delivered_at,retry_count,max_retries,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [id('nrec'), notificationId, userId, eventKey || null, 'DELIVERED', now, 0, maxRetries || 3, now]);
  return { suppressed: false, delivered: true };
}

// ---------- 自动提醒模块 ----------
/**
 * 向指定用户投递一条站内信（内部实现：立即创建 PUBLISHED 通知，写 recipients → DELIVERED）。
 * 这里的 DELIVERED 只表示「已进入应用内收件箱」，没有邮件/短信/微信外发通道。
 * eventKey 用于去重，同一 userId + eventKey 在 24h 内不重复投递。
 * @param {object} opts
 * @param {string} opts.title        - 通知标题
 * @param {string} opts.body         - 通知正文
 * @param {string} [opts.kind='REMINDER'] - NOTICE | ANNOUNCEMENT | REMINDER
 * @param {string} opts.targetUserId  - 接收人 user id
 * @param {string|null} [opts.targetOrgId]  - 所属机构 id（自动推断）
 * @param {string|null} [opts.eventKey]     - 去重 key（如 'WORK_REVIEW_COMPLETED:workId'）
 * @param {string|null} [opts.targetUrl]    - 点击跳转 URL
 * @returns {{ notificationId: string|null, recipientId: string|null, suppressed: boolean, reason?: string }}
 */
export function scheduleReminder({ title, body, kind = 'REMINDER', targetUserId, targetOrgId = null, eventKey = null, targetUrl = null }) {
  // 1. 验证用户存在
  const user = row('SELECT id, org_id, status FROM users WHERE id=? AND deleted_at IS NULL', [targetUserId]);
  if (!user || user.status !== 'ACTIVE') return { notificationId: null, recipientId: null, suppressed: false, reason: 'USER_NOT_FOUND_OR_DISABLED' };
  const orgId = targetOrgId || user.org_id;
  // 2. 去重检查（24h 内同类事件不重复投递）
  if (eventKey) {
    const prior = row(
      "SELECT id FROM notification_recipients WHERE event_key=? AND user_id=? AND delivery_status='DELIVERED' AND created_at>=? ORDER BY created_at DESC LIMIT 1",
      [eventKey, targetUserId, new Date(Date.now() - 24 * 3600 * 1000).toISOString()],
    );
    if (prior) return { notificationId: null, recipientId: prior.id, suppressed: true, reason: 'event_dedup' };
  }
  // 3. 创建通知（scope 自动推断）
  const now = nowIso();
  const notificationId = id('noti');
  const scopeType = orgId ? 'ORG' : 'PLATFORM';
  q(
    "INSERT INTO notifications(id,scope_type,org_id,sender_id,title,body,kind,target_url,audience,status,publish_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [notificationId, scopeType, orgId || null, targetUserId, String(title).slice(0, 200), String(body).slice(0, 1000), kind, targetUrl || null, '{}', 'PUBLISHED', now, now, now],
  );
  // 4. 复用 dispatchRecipientEvent 写 recipients，再查 recipientId
  dispatchRecipientEvent({ userId: targetUserId, notificationId, eventKey, maxRetries: 3 });
  const recipient = row('SELECT id FROM notification_recipients WHERE notification_id=? AND user_id=?', [notificationId, targetUserId]);
  return { notificationId, recipientId: recipient?.id || null, suppressed: false };
}

function markRecipientFailed(recipientId, code, reason) {
  const now = nowIso();
  q('UPDATE notification_recipients SET delivery_status=\'FAILED\', failure_code=?, failure_reason=?, delivered_at=NULL WHERE id=?', [code || 'UNKNOWN', reason || code || '投递失败', recipientId]);
  // 自动入队：同一接收人已有活跃 job 时跳过
  const recipient = row('SELECT * FROM notification_recipients WHERE id=?', [recipientId]);
  if (recipient) {
    enqueueDispatchJob({
      recipientId,
      notificationId: recipient.notification_id,
      userId: recipient.user_id,
      eventKey: recipient.event_key,
      maxAttempts: 3,
    });
  }
}

export function retryRecipient(recipientId) {
  const now = nowIso();
  const row1 = row('SELECT retry_count, max_retries, notification_id, user_id, event_key FROM notification_recipients WHERE id=?', [recipientId]);
  if (!row1) return { retried: false, reason: 'NOT_FOUND' };
  if (row1.retry_count >= row1.max_retries) return { retried: false, reason: 'MAX_RETRIES_EXCEEDED' };
  q('UPDATE notification_recipients SET delivery_status=\'DELIVERED\', failure_code=NULL, failure_reason=NULL, delivered_at=?, retry_count=retry_count+1 WHERE id=?', [now, recipientId]);
  // 自动入队：让 worker 真正执行重试投递
  enqueueDispatchJob({
    recipientId,
    notificationId: row1.notification_id,
    userId: row1.user_id,
    eventKey: row1.event_key,
    maxAttempts: 3,
  });
  return { retried: true };
}

// ---------- 投递队列模块（notification_dispatch_jobs） ----------
const WORKER_ID = `${process.pid}-${hostname().slice(0, 16)}`;

/**
 * 将失败接收人入队（幂等 UPSERT），同一 recipient_id 在 PENDING/IN_PROGRESS 时不重复入队。
 * 在 markRecipientFailed 内部事务中调用，或手动重试时调用。
 */
export function enqueueDispatchJob({ recipientId, notificationId, userId, eventKey, maxAttempts = 3 }) {
  const now = nowIso();
  const existing = row("SELECT id, status FROM notification_dispatch_jobs WHERE recipient_id=? AND status IN ('PENDING','IN_PROGRESS')", [recipientId]);
  if (existing) return { enqueued: false, reason: 'ALREADY_ACTIVE', jobId: existing.id };
  const jobId = id('ndj');
  q(
    "INSERT INTO notification_dispatch_jobs(id,recipient_id,notification_id,user_id,event_key,attempt,max_attempts,status,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?,?,?,?)",
    [jobId, recipientId, notificationId, userId, eventKey || null, maxAttempts, 'PENDING', now, now, now],
  );
  return { enqueued: true, jobId };
}

/**
 * 计算指数退避下次执行时间（秒），带随机抖动。
 * 策略：min(60s × 2^attempt + jitter(±15%), 30min)
 */
function backoffSeconds(attempt) {
  const base = Math.min(60 * Math.pow(2, attempt), 1800);
  const jitter = base * 0.15 * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(base + jitter));
}

/**
 * Worker 拉取待执行任务（原子 SELECT + UPDATE 返回）。
 * @param {string} workerId - 当前 worker 标识
 * @param {number} limit - 每次最多拉取任务数
 * @returns {Array} claimed jobs
 */
function claimDispatchJobs(workerId, limit = 10) {
  const now = nowIso();
  // 原子：在同一事务内查找并锁定，避免多 worker 重复拉取
  const candidates = rows(
    "SELECT * FROM notification_dispatch_jobs WHERE status='PENDING' AND next_run_at<=? ORDER BY next_run_at ASC LIMIT ?",
    [now, limit],
  );
  if (!candidates.length) return [];
  const ids = candidates.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  q(
    `UPDATE notification_dispatch_jobs SET status='IN_PROGRESS',locked_by=?,locked_at=?,updated_at=? WHERE id IN (${placeholders}) AND status='PENDING'`,
    [workerId, now, now, ...ids],
  );
  // 返回真正被锁定的行（并发时可能部分失败）
  return rows("SELECT * FROM notification_dispatch_jobs WHERE locked_by=? AND locked_at=? AND status='IN_PROGRESS'", [workerId, now]);
}

/**
 * 投递任务成功：标记 job 为 SUCCEEDED，清除 recipient 的 FAILED 状态。
 */
function markJobSucceeded(jobId, workerId) {
  const now = nowIso();
  const job = row('SELECT * FROM notification_dispatch_jobs WHERE id=? AND locked_by=? AND status=?', [jobId, workerId, 'IN_PROGRESS']);
  if (!job) return { succeeded: false, reason: 'NOT_FOUND_OR_NOT_LOCKED' };
  q("UPDATE notification_dispatch_jobs SET status='SUCCEEDED',locked_by=NULL,locked_at=NULL,updated_at=? WHERE id=?", [now, jobId]);
  q("UPDATE notification_recipients SET delivery_status='DELIVERED',failure_code=NULL,failure_reason=NULL,delivered_at=?,retry_count=? WHERE id=?", [now, job.attempt + 1, job.recipient_id]);
  return { succeeded: true, jobId: job.id };
}

/**
 * 投递任务失败：按指数退避重排或进入死信。
 */
function markJobFailed(jobId, workerId, errorCode, errorMessage) {
  const now = nowIso();
  const job = row('SELECT * FROM notification_dispatch_jobs WHERE id=? AND locked_by=? AND status=?', [jobId, workerId, 'IN_PROGRESS']);
  if (!job) return { failed: false, reason: 'NOT_FOUND_OR_NOT_LOCKED' };
  const nextAttempt = job.attempt + 1;
  const nextRunAt = new Date(Date.now() + backoffSeconds(nextAttempt) * 1000).toISOString();
  if (nextAttempt >= job.max_attempts) {
    assertTransition(null, 'notificationDispatchJob', job.status, 'DEAD_LETTER', { targetType: 'NOTIFICATION_DISPATCH_JOB', targetId: jobId, before: job, details: { errorCode } });
    q("UPDATE notification_dispatch_jobs SET status='DEAD_LETTER',locked_by=NULL,locked_at=NULL,last_error_code=?,last_error_message=?,updated_at=? WHERE id=?", [errorCode || 'MAX_RETRIES', errorMessage || '已达到最大重试次数', now, jobId]);
    return { failed: true, jobId: job.id, status: 'DEAD_LETTER' };
  }
  assertTransition(null, 'notificationDispatchJob', job.status, 'PENDING', { targetType: 'NOTIFICATION_DISPATCH_JOB', targetId: jobId, before: job, details: { errorCode } });
  q("UPDATE notification_dispatch_jobs SET status='PENDING',attempt=?,locked_by=NULL,locked_at=NULL,last_error_code=?,last_error_message=?,next_run_at=?,updated_at=? WHERE id=?", [nextAttempt, errorCode || 'UNKNOWN', errorMessage || '投递失败', nextRunAt, now, jobId]);
  return { failed: true, jobId: job.id, status: 'PENDING', nextRunAt, attempt: nextAttempt };
}

/**
 * 单次 worker 扫描：拉取任务 → 评估是否可投递 → 成功或失败。
 * 在当前实现中，「投递」本质上是清除 FAILED 状态；若无法投递（如用户已删除），标记失败。
 */
function runWorkerTick(workerId) {
  const claimed = claimDispatchJobs(workerId, 10);
  if (!claimed.length) return { processed: 0 };
  let succeeded = 0; let failed = 0;
  for (const job of claimed) {
    // 检查关联 recipient 是否仍然存在且未被忽略
    const recipient = row('SELECT * FROM notification_recipients WHERE id=?', [job.recipient_id]);
    if (!recipient || recipient.ignored) {
      // 接收人已不存在或被忽略：直接成功（无需投递）
      markJobSucceeded(job.id, workerId);
      succeeded += 1;
      continue;
    }
    if (recipient.delivery_status !== 'FAILED') {
      // 状态不是 FAILED，说明已被其他路径处理（如手动重试成功），标记成功
      markJobSucceeded(job.id, workerId);
      succeeded += 1;
      continue;
    }
    // 尝试重新投递：更新为 DELIVERED
    const now = nowIso();
    const upd = q("UPDATE notification_recipients SET delivery_status='DELIVERED',failure_code=NULL,failure_reason=NULL,delivered_at=?,retry_count=? WHERE id=? AND delivery_status='FAILED'", [now, job.attempt + 1, job.recipient_id]);
    if (upd.changes) {
      markJobSucceeded(job.id, workerId);
      succeeded += 1;
    } else {
      markJobFailed(job.id, workerId, 'REDELIVERY_FAILED', '无法更新接收人状态');
      failed += 1;
    }
  }
  return { processed: claimed.length, succeeded, failed };
}

/**
 * 释放通知 worker 持有的任务并停止调度器，供服务入口优雅退出时调用。
 */
export function shutdownCommunicationWorkers() {
  if (workerInterval) { clearInterval(workerInterval); workerInterval = null; }
  if (reminderInterval) { clearInterval(reminderInterval); reminderInterval = null; }
  releaseWorkerJobs(WORKER_ID);
}

export function releaseWorkerJobs(workerId) {
  const now = nowIso();
  q("UPDATE notification_dispatch_jobs SET status='PENDING',locked_by=NULL,locked_at=NULL,updated_at=? WHERE locked_by=? AND status='IN_PROGRESS'", [now, workerId]);
}

/**
 * 汇总队列状态（供 summary 端点使用）。
 */
export function summarizeQueue() {
  const pending = Number(row("SELECT COUNT(*) n FROM notification_dispatch_jobs WHERE status='PENDING'")?.n || 0);
  const inProgress = Number(row("SELECT COUNT(*) n FROM notification_dispatch_jobs WHERE status='IN_PROGRESS'")?.n || 0);
  const failed = Number(row("SELECT COUNT(*) n FROM notification_dispatch_jobs WHERE status='FAILED'")?.n || 0);
  const deadLetter = Number(row("SELECT COUNT(*) n FROM notification_dispatch_jobs WHERE status='DEAD_LETTER'")?.n || 0);
  const succeeded = Number(row("SELECT COUNT(*) n FROM notification_dispatch_jobs WHERE status='SUCCEEDED'")?.n || 0);
  const total = pending + inProgress + failed + deadLetter + succeeded;
  const byStatus = rows("SELECT status, COUNT(*) n FROM notification_dispatch_jobs GROUP BY status").map((item) => ({ status: item.status, count: Number(item.n) }));
  return { total, pending, inProgress, failed, deadLetter, succeeded, byStatus };
}

/**
 * 列出死信（供 dead-letters 端点使用）。
 */
function listDeadLetters({ limit = 50, offset = 0 }) {
  const items = rows("SELECT j.*, n.title, n.body, u.display_name user_name, u.login user_login FROM notification_dispatch_jobs j LEFT JOIN notifications n ON n.id=j.notification_id LEFT JOIN users u ON u.id=j.user_id WHERE j.status='DEAD_LETTER' ORDER BY j.updated_at DESC LIMIT ? OFFSET ?", [limit, offset]);
  const total = Number(row("SELECT COUNT(*) n FROM notification_dispatch_jobs WHERE status='DEAD_LETTER'")?.n || 0);
  return {
    items: items.map((item) => ({
      id: item.id,
      recipientId: item.recipient_id,
      notificationId: item.notification_id,
      userId: item.user_id,
      eventKey: item.event_key,
      attempt: item.attempt,
      maxAttempts: item.max_attempts,
      lastErrorCode: item.last_error_code,
      lastErrorMessage: item.last_error_message,
      nextRunAt: item.next_run_at,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      title: item.title,
      body: item.body,
      userName: item.user_name,
      userLogin: item.user_login,
    })),
    total,
    limit,
    offset,
  };
}

/**
 * 恢复死信（批量重新入队，供 requeue 端点使用）。
 */
export function requeueDeadLetters(jobIds, reason) {
  const now = nowIso();
  const nextRunAt = now; // 立即可执行
  let requeued = 0; let skipped = 0;
  for (const jid of jobIds) {
    const job = row("SELECT * FROM notification_dispatch_jobs WHERE id=? AND status='DEAD_LETTER'", [jid]);
    if (!job) { skipped += 1; continue; }
    // 重置 attempt 和 max_attempts，让其重新走完整重试流程
    q("UPDATE notification_dispatch_jobs SET status='PENDING',attempt=0,last_error_code=NULL,last_error_message=NULL,next_run_at=?,updated_at=? WHERE id=?", [nextRunAt, now, jid]);
    requeued += 1;
  }
  return { requeued, skipped };
}

// 启动独立 worker 调度器（每 5 秒扫描一次）
let workerInterval = null;
let workerStarted = false;

export function startNotificationWorker() {
  if (workerStarted) return;
  workerStarted = true;
  workerInterval = setInterval(() => {
    try { runWorkerTick(WORKER_ID); }
    catch (error) { console.error('[NOTIFICATION WORKER ERROR]', error); }
  }, 5000);
  workerInterval.unref();
  // 进程退出时释放持有的任务；服务入口收到终止信号后统一关闭 HTTP server 并退出。
  process.on('exit', () => releaseWorkerJobs(WORKER_ID));
}

// 顶层副作用：模块加载即启动 worker
startNotificationWorker();

// P4-O09 自动提醒扫描器：合同到期（每 5 分钟）
// 2026-09-13（P4 删积分）：低余额预警随积分体系一起去掉了。
import { scanContractExpiryOrgs } from '../../services/reminderScheduler.js';

let reminderInterval = null;
let reminderStarted = false;

export function startReminderScheduler() {
  if (reminderStarted) return;
  reminderStarted = true;
  reminderInterval = setInterval(() => {
    try {
      const exp = scanContractExpiryOrgs();
      if (exp.length) {
        console.log(`[REMINDER SCAN] contract_expiry=${exp.length}`);
      }
    } catch (error) { console.error('[REMINDER SCAN ERROR]', error); }
  }, 5 * 60 * 1000);
  reminderInterval.unref();
}

startReminderScheduler();

function selectAudienceUsers(audience, orgId) {
  const params = [...audience.roles];
  let where = `u.status='ACTIVE' AND u.deleted_at IS NULL AND u.role IN (${audience.roles.map(() => '?').join(',')})`;
  if (orgId) { where += ' AND u.org_id=?'; params.push(orgId); }
  else if (audience.scope === 'ORG_IDS') { where += ` AND u.org_id IN (${audience.orgIds.map(() => '?').join(',')})`; params.push(...audience.orgIds); }
  else { where += ' AND u.org_id IS NOT NULL'; }
  return rows(`SELECT u.id FROM users u WHERE ${where}`, params);
}

export function dispatchDueNotifications() {
  const now = nowIso();
  const due = rows("SELECT * FROM notifications WHERE status='DRAFT' AND publish_at IS NOT NULL AND publish_at<=? ORDER BY publish_at ASC LIMIT 100", [now]);
  if (!due.length) return 0;
  let published = 0;
  transaction(() => {
    due.forEach((notification) => {
      assertTransition(null, 'notification', notification.status, 'PUBLISHED', { targetType: 'NOTIFICATION', targetId: notification.id, before: notification, details: { action: 'SCHEDULED_PUBLISH' } });
      const result = q("UPDATE notifications SET status='PUBLISHED',updated_at=? WHERE id=? AND status='DRAFT' AND publish_at IS NOT NULL AND publish_at<=?", [now, notification.id, now]);
      if (!result.changes) return;
      const audience = parseJson(notification.audience, {});
      const recipientCount = notificationRecipients(notification.id, notification.scope_type, notification.org_id, audience);
      const sender = row('SELECT role,org_id FROM users WHERE id=?', [notification.sender_id]);
      q(`INSERT INTO audit_logs(id,org_id,actor_id,actor_role,action,target_type,target_id,request_method,request_path,before_data,after_data,ip,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id('audit'), sender?.org_id || null, notification.sender_id, sender?.role || null, 'NOTIFICATION_SCHEDULED_PUBLISH', 'NOTIFICATION', notification.id, 'SYSTEM', '/internal/notification-scheduler', json({ status: 'SCHEDULED' }), json({ status: 'PUBLISHED', recipientCount }), null, now]);
      published += 1;
    });
  });
  return published;
}

const scheduler = setInterval(() => {
  try { dispatchDueNotifications(); }
  catch (error) { console.error('[NOTIFICATION SCHEDULER ERROR]', error); }
}, 15000);
scheduler.unref();

function notificationAdminRows({ search = '', status = '', page = 1, limit = 20, sort = 'created' } = {}) {
  const conditions = ["n.scope_type='PLATFORM'"]; const params = [];
  if (search) { conditions.push('(n.title LIKE ? OR n.body LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status && ['DRAFT', 'PUBLISHED', 'SCHEDULED', 'RECALLED'].includes(status)) {
    if (status === 'SCHEDULED') conditions.push("n.status='DRAFT' AND n.publish_at IS NOT NULL");
    else { conditions.push('n.status=?'); params.push(status); }
  }
  const orderBy = {
    created: 'n.created_at DESC',
    updated: 'n.updated_at DESC',
    publish: 'COALESCE(n.publish_at,n.created_at) DESC',
    title: 'n.title COLLATE NOCASE ASC',
    pinned: 'n.pinned DESC, COALESCE(n.publish_at,n.created_at) DESC',
  }[sort] || 'n.created_at DESC';
  const where = conditions.join(' AND ');
  const total = Number(row(`SELECT COUNT(*) n FROM notifications n WHERE ${where}`, params)?.n || 0);
  const offset = (page - 1) * limit;
  const items = rows(`
    SELECT n.*, sender.display_name sender_name,
      (SELECT COUNT(*) FROM notification_recipients recipient WHERE recipient.notification_id=n.id) recipient_count,
      (SELECT COUNT(*) FROM notification_recipients recipient WHERE recipient.notification_id=n.id AND recipient.read_at IS NULL AND recipient.delivery_status='DELIVERED') unread_count,
      (SELECT COUNT(*) FROM notification_recipients recipient WHERE recipient.notification_id=n.id AND recipient.delivery_status='FAILED') delivery_failed_count
    FROM notifications n
    LEFT JOIN users sender ON sender.id=n.sender_id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]).map(normalizeNotification);
  return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
}

function notificationRecipientRows(currentOrgId, userId) {
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

function markNotificationRead(ctx, currentOrgId, notificationId, userId) {
  const result = q("UPDATE notification_recipients SET read_at=COALESCE(read_at,?) WHERE notification_id=? AND user_id=? AND delivery_status='DELIVERED' AND EXISTS (SELECT 1 FROM notifications n WHERE n.id=notification_recipients.notification_id AND n.status='PUBLISHED' AND (n.scope_type='PLATFORM' OR n.org_id=?))", [nowIso(), notificationId, userId, currentOrgId]);
  if (!result.changes) throw errors.notFound('通知不存在或不属于当前账号', 'NOTIFICATION_NOT_FOUND');
  audit(ctx, 'NOTIFICATION_READ', 'NOTIFICATION', notificationId);
  return { read: true };
}

function markAllNotificationsRead(ctx, currentOrgId, userId) {
  const result = q("UPDATE notification_recipients SET read_at=COALESCE(read_at,?) WHERE user_id=? AND read_at IS NULL AND delivery_status='DELIVERED' AND EXISTS (SELECT 1 FROM notifications n WHERE n.id=notification_recipients.notification_id AND n.status='PUBLISHED' AND (n.scope_type='PLATFORM' OR n.org_id=?))", [nowIso(), userId, currentOrgId]);
  audit(ctx, 'NOTIFICATIONS_READ_ALL', 'USER', userId, null, { count: result.changes });
  return { read: result.changes };
}

function templateRows() {
  return rows(`SELECT template.*, creator.display_name created_by_name FROM notification_templates template LEFT JOIN users creator ON creator.id=template.created_by ORDER BY template.status='ACTIVE' DESC, template.updated_at DESC LIMIT 200`).map(normalizeTemplate);
}

function validateTemplateBody(body, existing = null) {
  const name = body.name === undefined && existing ? existing.name : nonEmptyString(body.name, '模板名称', { max: 80 });
  const title = body.title === undefined && existing ? existing.title : nonEmptyString(body.title, '模板标题', { max: 160 });
  const content = body.body === undefined && existing ? existing.body : nonEmptyString(body.body, '模板内容', { max: 10000 });
  const kind = body.kind === undefined && existing ? existing.kind : validateKind(body.kind);
  const targetUrl = body.targetUrl === undefined && existing ? existing.target_url : (body.targetUrl ? String(body.targetUrl).trim().slice(0, 500) : null);
  const audience = body.audience === undefined && existing ? parseJson(existing.audience, {}) : validateAudience(body);
  return { name, title, body: content, kind, targetUrl, audience };
}

function materialRows({ currentOrgId = null, admin = false, search = '', status = '', category = '', visibility = '', page = 1, limit = 20, sort = 'created' } = {}) {
  const conditions = []; const params = [];
  if (admin) conditions.push('1=1');
  else { conditions.push("material.status='ACTIVE'"); conditions.push("(material.visibility='ALL_ORGS' OR EXISTS (SELECT 1 FROM promo_material_assignments assignment WHERE assignment.material_id=material.id AND assignment.org_id=?))"); params.push(currentOrgId); }
  if (search) { conditions.push('(material.title LIKE ? OR material.description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status && ['ACTIVE', 'DISABLED'].includes(status)) { conditions.push('material.status=?'); params.push(status); }
  if (category && ['GENERAL', 'COURSE', 'POSTER', 'ACTIVITY', 'PARTNERSHIP'].includes(category)) { conditions.push('material.category=?'); params.push(category); }
  if (visibility && ['ALL_ORGS', 'ASSIGNED_ORGS'].includes(visibility)) { conditions.push('material.visibility=?'); params.push(visibility); }
  const orderBy = {
    created: 'material.created_at DESC',
    updated: 'material.updated_at DESC',
    title: 'material.title COLLATE NOCASE ASC',
    events: 'event_count DESC, material.created_at DESC',
  }[sort] || 'material.created_at DESC';
  const where = conditions.join(' AND ');
  const base = `
    FROM promo_materials material
    LEFT JOIN users creator ON creator.id=material.created_by
  `;
  const total = Number(row(`SELECT COUNT(*) n ${base} WHERE ${where}`, params)?.n || 0);
  const offset = (page - 1) * limit;
  const items = rows(`SELECT material.*, creator.display_name created_by_name,
      (SELECT GROUP_CONCAT(assignment.org_id) FROM promo_material_assignments assignment WHERE assignment.material_id=material.id) assigned_org_ids,
      (SELECT COUNT(*) FROM promo_material_assignments assignment WHERE assignment.material_id=material.id) assigned_org_count,
      (SELECT COUNT(*) FROM promo_material_events event WHERE event.material_id=material.id) event_count
    ${base} WHERE ${where}
    ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset]).map(normalizeMaterial);
  return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
}

function materialStats(materialId) {
  const materialValue = row(`SELECT material.*, creator.display_name created_by_name,
    (SELECT GROUP_CONCAT(assignment.org_id) FROM promo_material_assignments assignment WHERE assignment.material_id=material.id) assigned_org_ids,
    (SELECT COUNT(*) FROM promo_material_assignments assignment WHERE assignment.material_id=material.id) assigned_org_count,
    (SELECT COUNT(*) FROM promo_material_events event WHERE event.material_id=material.id) event_count
    FROM promo_materials material LEFT JOIN users creator ON creator.id=material.created_by WHERE material.id=?`, [materialId]);
  if (!materialValue) throw errors.notFound('宣传物料不存在', 'MATERIAL_NOT_FOUND');
  const material = normalizeMaterial(materialValue);
  const counts = row(`SELECT COUNT(*) total_events,
    SUM(CASE WHEN event_type='VIEW' THEN 1 ELSE 0 END) view_count,
    SUM(CASE WHEN event_type='USE' THEN 1 ELSE 0 END) use_count,
    SUM(CASE WHEN event_type='DOWNLOAD' THEN 1 ELSE 0 END) download_count,
    COUNT(DISTINCT org_id) organization_count,
    COUNT(DISTINCT user_id) user_count
    FROM promo_material_events WHERE material_id=?`, [materialId]);
  const organizations = rows(`SELECT event.org_id, organization.name organization_name, COUNT(*) event_count,
    SUM(CASE WHEN event.event_type='VIEW' THEN 1 ELSE 0 END) view_count,
    SUM(CASE WHEN event.event_type='USE' THEN 1 ELSE 0 END) use_count,
    SUM(CASE WHEN event.event_type='DOWNLOAD' THEN 1 ELSE 0 END) download_count,
    MAX(event.created_at) last_event_at
    FROM promo_material_events event JOIN organizations organization ON organization.id=event.org_id
    WHERE event.material_id=? GROUP BY event.org_id,organization.name ORDER BY event_count DESC,last_event_at DESC`, [materialId]).map((item) => ({
      orgId: item.org_id,
      organizationName: item.organization_name,
      eventCount: Number(item.event_count || 0),
      viewCount: Number(item.view_count || 0),
      useCount: Number(item.use_count || 0),
      downloadCount: Number(item.download_count || 0),
      lastEventAt: item.last_event_at,
    }));
  const recentEvents = rows(`SELECT event.id,event.event_type,event.created_at,event.org_id,organization.name organization_name,event.user_id,user.display_name user_name,user.role user_role
    FROM promo_material_events event JOIN organizations organization ON organization.id=event.org_id JOIN users user ON user.id=event.user_id
    WHERE event.material_id=? ORDER BY event.created_at DESC LIMIT 50`, [materialId]).map((item) => ({
      id: item.id,
      eventType: item.event_type,
      createdAt: item.created_at,
      orgId: item.org_id,
      organizationName: item.organization_name,
      userId: item.user_id,
      userName: item.user_name,
      userRole: item.user_role,
    }));
  return {
    material,
    summary: {
      totalEvents: Number(counts.total_events || 0),
      viewCount: Number(counts.view_count || 0),
      useCount: Number(counts.use_count || 0),
      downloadCount: Number(counts.download_count || 0),
      organizationCount: Number(counts.organization_count || 0),
      userCount: Number(counts.user_count || 0),
    },
    organizations,
    recentEvents,
  };
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


function websiteContentKey(value) {
  const key = String(value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(key) || !WEBSITE_CONTENT_KEYS.has(key)) throw errors.badRequest('官网内容 key 无效', 'INVALID_WEBSITE_CONTENT_KEY');
  return key;
}
function websiteContentValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw errors.badRequest('官网内容必须是 JSON 对象', 'INVALID_WEBSITE_CONTENT');
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw errors.badRequest('官网内容无法序列化', 'INVALID_WEBSITE_CONTENT'); }
  if (Buffer.byteLength(encoded, 'utf8') > 200 * 1024) throw errors.badRequest('官网内容不能超过 200KB', 'WEBSITE_CONTENT_TOO_LARGE');
  return { value, encoded };
}
function normalizeWebsiteContent(item, includeDraft = false) {
  if (!item) return null;
  return {
    key: item.content_key,
    content: parseJson(includeDraft ? item.draft_content : item.published_content, {}),
    version: Number(includeDraft ? item.draft_version : item.published_version || 0),
    status: item.published_content ? 'PUBLISHED' : 'DRAFT',
    draftVersion: Number(item.draft_version || 0),
    publishedVersion: item.published_version == null ? null : Number(item.published_version),
    updatedBy: item.updated_by || null,
    publishedBy: item.published_by || null,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    publishedAt: item.published_at || null,
  };
}
function websiteContentRevisions(contentKey) {
  return rows('SELECT * FROM website_content_revisions WHERE content_key=? ORDER BY version DESC', [contentKey]).map((item) => ({
    id: item.id, key: item.content_key, version: Number(item.version), content: parseJson(item.content, {}), action: item.action,
    changedBy: item.changed_by || null, reason: item.reason || '', createdAt: item.created_at,
  }));
}

const HELP_CENTER_VERSION = 'P4-S07';
const HELP_FEEDBACK_CATEGORIES = new Set(['ACCOUNT', 'CANVAS', 'AI', 'COURSE', 'CLIENT', 'DATA', 'OTHER']);
const HELP_FAQ = [
  { category: 'ACCOUNT', question: '忘记密码或登录不上怎么办？', answer: '请联系你的老师或机构管理员重置密码。密码重置后，老师会把新账号信息交给你，首次登录可在个人账号中修改。' },
  { category: 'CANVAS', question: '作品还没做完可以保存吗？', answer: '可以。进入项目后保存画布，作品会保留在“我的项目”。已提交或已发布的作品需按老师反馈修改后重新提交。' },
  { category: 'AI', question: '为什么 AI 现在不能使用？', answer: '请先查看 AI / 灵动值中心。老师可能关闭了本节课的某类 AI 能力，或课堂算力额度、调用次数已达到上限。' },
  { category: 'COURSE', question: '如何知道这节课要做什么？', answer: '在学习首页查看“我的学习任务”，再按课时进入创作。课堂开始后，老师设置的课堂要求也会显示在首页。' },
  { category: 'CLIENT', question: '可以在家里的电脑使用吗？', answer: 'Web 端可使用现代浏览器访问；桌面安装包需由机构或平台配置真实下载地址后才提供下载。未配置时页面不会提供安装包。' },
  { category: 'DATA', question: '我的头像和监护人信息会被收集吗？', answer: '平台仅保存昵称、平台预设头像键、必要监护人联系信息和隐私开关，不收集住址、身份证号和社交账号。可在个人账号中查看或清空。' },
  { category: 'OTHER', question: '遇到页面错误或内容异常怎么办？', answer: '请在帮助与下载页提交问题反馈，选择对应分类并写清楚出现步骤。老师或机构管理员会跟进处理。' },
];

// 问题反馈：学生端（自己提交的）与机构端（本机构所有的）共用同一套读取与字段归一。
// 之前这两个函数只在 student.js 内部定义，机构端直接调用 → ReferenceError，接口 500。
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

export {
  LEGAL_POLICY_VERSION,
  MATERIAL_CATEGORIES,
  NOTIFICATION_KINDS,
  NOTIFICATION_ROLES,
  NOTIFICATION_SCOPES,
  WORKER_ID,
  backoffSeconds,
  bool,
  claimDispatchJobs,
  dispatchRecipientEvent,
  effectiveNotificationStatus,
  integer,
  listDeadLetters,
  markAllNotificationsRead,
  markJobFailed,
  markJobSucceeded,
  markNotificationRead,
  markRecipientFailed,
  HELP_CENTER_VERSION,
  HELP_FAQ,
  HELP_FEEDBACK_CATEGORIES,
  helpFeedbackRows,
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
  reminderInterval,
  reminderStarted,
  runWorkerTick,
  scheduledPublishAt,
  scheduler,
  selectAudienceUsers,
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
};
