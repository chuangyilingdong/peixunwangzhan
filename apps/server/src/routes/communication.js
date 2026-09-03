import {
  audit,
  errors,
  id,
  json,
  nonEmptyString,
  normalizeSeries,
  nowIso,
  parseJson,
  q,
  requireRole,
  row,
  rows,
  transaction,
} from '../lib.js';
import { hostname } from 'node:os';

const NOTIFICATION_ROLES = new Set(['ORG_ADMIN', 'TEACHER', 'STUDENT']);
const NOTIFICATION_KINDS = new Set(['NOTICE', 'ANNOUNCEMENT', 'REMINDER']);
const NOTIFICATION_SCOPES = new Set(['ALL_ORGS', 'ORG_IDS']);
const MATERIAL_CATEGORIES = new Set(['GENERAL', 'COURSE', 'POSTER', 'ACTIVITY', 'PARTNERSHIP']);

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
 * 向指定用户投递一条通知提醒（内部实现：立即创建 PUBLISHED 通知，写 recipients → DELIVERED）。
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
    q("UPDATE notification_dispatch_jobs SET status='DEAD_LETTER',locked_by=NULL,locked_at=NULL,last_error_code=?,last_error_message=?,updated_at=? WHERE id=?", [errorCode || 'MAX_RETRIES', errorMessage || '已达到最大重试次数', now, jobId]);
    return { failed: true, jobId: job.id, status: 'DEAD_LETTER' };
  }
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
 * 释放当前 worker 持有的 IN_PROGRESS 任务（进程退出时调用）。
 */
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
  // 进程退出时释放持有的任务
  process.on('exit', () => releaseWorkerJobs(WORKER_ID));
  process.on('SIGHUP', () => releaseWorkerJobs(WORKER_ID));
  process.on('SIGTERM', () => releaseWorkerJobs(WORKER_ID));
  process.on('SIGINT', () => releaseWorkerJobs(WORKER_ID));
}

// 顶层副作用：模块加载即启动 worker
startNotificationWorker();

// P4-O09 自动提醒扫赻器：低余额 + 合同到期（每 5 分钟）
import { scanLowBalanceOrgs, scanContractExpiryOrgs } from '../services/reminderScheduler.js';

let reminderInterval = null;
let reminderStarted = false;

export function startReminderScheduler() {
  if (reminderStarted) return;
  reminderStarted = true;
  reminderInterval = setInterval(() => {
    try {
      const low = scanLowBalanceOrgs();
      const exp = scanContractExpiryOrgs();
      if (low.length || exp.length) {
        console.log(`[REMINDER SCAN] low=${low.length} contract_expiry=${exp.length}`);
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


export function handlePublicCommunication(ctx) {
  const { pathname, method } = ctx;
  if (pathname === '/api/public/downloads' && method === 'GET') {
    const releases = latestDownloadReleases();
    return {
      generatedAt: nowIso(),
      status: releases.length ? 'PARTIAL' : 'NOT_CONFIGURED',
      statement: releases.length ? '以下仅展示平台已配置的真实客户端版本。' : '平台尚未配置真实客户端安装包，不提供虚假下载链接。',
      items: releases,
      byPlatform: Object.fromEntries(releases.map((item) => [item.platform, item])),
      webCompatibility: ['Chrome / Edge 最新两个稳定版本', 'Safari 17+（macOS）', '课堂依赖稳定网络；建议机构机房提前检查'],
    };
  }

  // P5-W02: 演示预约（公开 POST，无需认证）
  if (pathname === '/api/public/contact' && method === 'POST') {
    const body = ctx.body || {};
    const orgName = nonEmptyString(body.orgName, '机构/学校名称', { max: 200 });
    const contactName = nonEmptyString(body.contactName, '联系人', { max: 100 });
    const contactPhone = nonEmptyString(body.contactPhone, '联系电话', { max: 20 });
    if (!/^1[3-9]\d{9}$/.test(contactPhone)) {
      throw errors.badRequest('手机号格式无效', 'INVALID_PHONE_FORMAT');
    }
    const intent = body.intent ? String(body.intent).trim().slice(0, 200) : '';
    const notes = body.notes ? String(body.notes).trim().slice(0, 2000) : '';
    const leadId = id('lead');
    const now = nowIso();
    q("INSERT INTO leads(id,org_name,contact_name,contact_phone,intent,notes,status,admin_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [leadId, orgName, contactName, contactPhone, intent, notes, 'NEW', '', now, now]);
    audit(ctx, 'LEAD_CREATE', 'LEAD', leadId, null, { orgName, intent }, { orgId: null });
    return { id: leadId, status: 'NEW', createdAt: now };
  }

  // P5-W04: 公开作品列表
  if (pathname === '/api/public/works' && method === 'GET') {
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 60, fallback: 20 });
    const items = rows(`
      SELECT work.id, work.title, work.description, work.canvas_snapshot,
             work.featured_at, work.submitted_at,
             user.display_name AS student_name,
             user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM works work
      JOIN users user ON user.id=work.student_id
      LEFT JOIN organizations organization ON organization.id=work.org_id
      WHERE work.is_public=1 AND work.status='PUBLISHED' AND work.share_token IS NOT NULL
        AND work.copyright_confirmed_at IS NOT NULL
      ORDER BY work.featured_at DESC NULLS LAST, work.submitted_at DESC
      LIMIT ?
    `, [limit]).map((row) => publicWorkRow(row));
    return { items, total: items.length };
  }

  // P5-W04: 公开作品详情
  const publicWorkMatch = pathname.match(/^\/api\/public\/works\/([\w-]+)$/);
  if (publicWorkMatch && method === 'GET') {
    const work = row(`
      SELECT work.id, work.title, work.description, work.canvas_snapshot,
             work.featured_at, work.submitted_at, work.share_token,
             user.display_name AS student_name,
             user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM works work
      JOIN users user ON user.id=work.student_id
      LEFT JOIN organizations organization ON organization.id=work.org_id
      WHERE work.share_token=? AND work.is_public=1
    `, [publicWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在或已取消公开', 'PUBLIC_WORK_NOT_FOUND');
    return publicWorkRow(work);
  }

  // P5-W05: 公开课包列表（无需登录，只返回 PUBLISHED 且可见范围合规的课包）
  if (pathname === '/api/public/course-series' && method === 'GET') {
    const params = [];
    const wheres = ["series.status = 'PUBLISHED'", "series.visibility IN ('ALL_ORGS', 'ASSIGNED_ORGS')"];
    if (ctx.search.get('difficulty') != null) {
      wheres.push('series.difficulty_level = ?');
      params.push(Number(ctx.search.get('difficulty')));
    }
    if (ctx.search.get('ageMin') != null) {
      wheres.push('series.age_range_max IS NOT NULL AND series.age_range_max >= ?');
      params.push(Number(ctx.search.get('ageMin')));
    }
    if (ctx.search.get('ageMax') != null) {
      wheres.push('series.age_range_min IS NOT NULL AND series.age_range_min <= ?');
      params.push(Number(ctx.search.get('ageMax')));
    }
    if (ctx.search.get('tag')) {
      wheres.push('series.tags LIKE ?');
      params.push('%' + String(ctx.search.get('tag')) + '%');
    }
    const items = rows(
      `SELECT series.* FROM course_series series WHERE ${wheres.join(' AND ')} ORDER BY series.sort, series.title`,
      params,
    ).map((item) => normalizeSeries(item, { parseTags: true }));
    return { items, total: items.length };
  }

  // P5-W05: 公开课包详情
  const publicCourseDetailMatch = pathname.match(/^\/api\/public\/course-series\/([\w-]+)$/);
  if (publicCourseDetailMatch && method === 'GET') {
    const series = row(
      "SELECT * FROM course_series WHERE id=? AND status='PUBLISHED' AND visibility IN ('ALL_ORGS', 'ASSIGNED_ORGS')",
      [publicCourseDetailMatch[1]],
    );
    if (!series) throw errors.notFound('课包不存在或不可公开访问', 'COURSE_SERIES_NOT_FOUND');
    const detail = normalizeSeries(series, { includeLessons: true, parseTags: true });
    detail.lessons = (detail.lessons || []).filter((l) => l.status === 'PUBLISHED');
    // lessonContent 截断到 2000 字
    detail.lessons = detail.lessons.map((l) => ({
      ...l,
      lessonContent: l.lessonContent ? String(l.lessonContent).slice(0, 2000) : '',
    }));
    return detail;
  }

  return null;
}

function publicWorkRow(row) {
  const canvas = parseJson(row.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
  // 脱敏作者信息
  let studentName = '小创作者';
  if (!row.student_anon && row.student_name) {
    const trimmed = String(row.student_name).trim();
    if (trimmed) studentName = trimmed.charAt(0) + '同学';
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    canvasSnapshot: canvas,
    featured: Boolean(row.featured_at),
    submittedAt: row.submitted_at,
    publicUrl: row.share_token ? `/works/${row.share_token}` : null,
    orgName: row.org_name || null,
    studentName,
  };
}

export async function handleAdminCommunication(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/admin/')) return null;
  const part = pathname.slice('/api/admin'.length);
  if (part === '/inbox' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    dispatchDueNotifications();
    const items = notificationAdminRows();
    return { items, unread: items.reduce((sum, item) => sum + item.unreadCount, 0), total: items.length };
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
    transaction(() => {
      q('UPDATE notifications SET title=?,body=?,kind=?,target_url=?,audience=?,status=?,publish_at=?,pinned=?,updated_at=? WHERE id=?', [title, body, kind, targetUrl, json(audience), storedStatus, publishAt, ctx.body?.pinned === undefined ? target.pinned : (bool(ctx.body.pinned) ? 1 : 0), now, target.id]);
      if (storedStatus === 'PUBLISHED') notificationRecipients(target.id, 'PLATFORM', null, audience);
    });
    audit(ctx, 'PLATFORM_NOTIFICATION_UPDATE', 'NOTIFICATION', target.id, { status: currentStatus }, { status: nextStatus, publishAt });
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
    const now = nowIso();
    transaction(() => {
      q('UPDATE promo_materials SET title=?,description=?,category=?,mime_type=?,resource_url=?,cover_url=?,visibility=?,status=?,updated_at=? WHERE id=?', [material.title, material.description, material.category, material.mimeType, material.resourceUrl, material.coverUrl, material.visibility, status, now, target.id]);
      q('DELETE FROM promo_material_assignments WHERE material_id=?', [target.id]);
      material.orgIds.forEach((targetOrgId) => q('INSERT INTO promo_material_assignments(id,material_id,org_id,created_at) VALUES (?,?,?,?)', [id('matassign'), target.id, targetOrgId, now]));
    });
    audit(ctx, 'PROMO_MATERIAL_UPDATE', 'PROMO_MATERIAL', target.id, { status: target.status }, { status, visibility: material.visibility });
    return normalizeMaterial(row('SELECT * FROM promo_materials WHERE id=?', [target.id]));
  }
  if (part === '/client-releases' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const items = rows('SELECT * FROM client_download_releases ORDER BY platform, channel, published_at DESC, created_at DESC').map(normalizeDownloadRelease);
    return { items, total: items.length };
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
  if (part === '/client-releases' && method === 'POST') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const platform = String(ctx.body?.platform || '').toUpperCase();
    if (!['MACOS_APPLE','WINDOWS_X64'].includes(platform)) throw errors.badRequest('下载平台无效', 'INVALID_DOWNLOAD_PLATFORM');
    const channel = String(ctx.body?.channel || 'STABLE').toUpperCase();
    if (!['STABLE','BETA','INTERNAL'].includes(channel)) throw errors.badRequest('下载通道无效', 'INVALID_DOWNLOAD_CHANNEL');
    const version = nonEmptyString(ctx.body?.version, '版本号', { max: 60 });
    if (!/^[0-9]+(\.[0-9]+){0,3}(-[A-Za-z0-9]+(\.[A-Za-z0-9]+)*)?(\+[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(version)) throw errors.badRequest('版本号格式无效', 'INVALID_DOWNLOAD_VERSION');
    const downloadUrl = nonEmptyString(ctx.body?.downloadUrl, '下载地址', { max: 1000 });
    if (!/^https:\/\//i.test(downloadUrl)) throw errors.badRequest('下载地址必须为 HTTPS', 'DOWNLOAD_URL_NOT_HTTPS');
    const releaseNotes = nonEmptyString(ctx.body?.releaseNotes, '版本说明', { max: 4000 });
    const publishNow = bool(ctx.body?.publishNow, false);
    const duplicate = row('SELECT id FROM client_download_releases WHERE platform=? AND version=? AND channel=?', [platform, version, channel]);
    if (duplicate) throw errors.conflict('该平台、版本和通道的客户端已存在', 'CLIENT_RELEASE_ALREADY_EXISTS');
    const now = nowIso();
    const releaseId = id('clientrelease');
    q(
      'INSERT INTO client_download_releases(id,platform,version,channel,download_url,file_size,sha256,release_notes,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [releaseId, platform, version, channel, downloadUrl, null, null, releaseNotes, publishNow ? now : null, now, now],
    );
    audit(ctx, 'PLATFORM_CLIENT_RELEASE_CREATE', 'CLIENT_DOWNLOAD_RELEASE', releaseId, null, { platform, version, channel, published: publishNow });
    return normalizeDownloadRelease(row('SELECT * FROM client_download_releases WHERE id=?', [releaseId]));
  }
  let releaseMatch = part.match(/^\/client-releases\/([^/]+)(?:\/(publish|unpublish))?$/);
  if (releaseMatch && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const release = row('SELECT * FROM client_download_releases WHERE id=?', [releaseMatch[1]]);
    if (!release) throw errors.notFound('客户端版本不存在', 'CLIENT_RELEASE_NOT_FOUND');
    const action = String(releaseMatch[2] || ctx.body?.action || '').toUpperCase();
    if (action !== 'PUBLISH' && action !== 'UNPUBLISH') throw errors.badRequest('客户端发布操作无效', 'INVALID_CLIENT_RELEASE_ACTION');
    const now = nowIso();
    q('UPDATE client_download_releases SET published_at=?,updated_at=? WHERE id=?', [action === 'PUBLISH' ? now : null, now, release.id]);
    audit(ctx, action === 'PUBLISH' ? 'PLATFORM_CLIENT_RELEASE_PUBLISH' : 'PLATFORM_CLIENT_RELEASE_UNPUBLISH', 'CLIENT_DOWNLOAD_RELEASE', release.id, normalizeDownloadRelease(release), { published: action === 'PUBLISH' }, { orgId: null });
    return normalizeDownloadRelease(row('SELECT * FROM client_download_releases WHERE id=?', [release.id]));
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

function normalizeDownloadRelease(value) {
  if (!value) return null;
  return {
    id: value.id,
    platform: value.platform,
    version: value.version,
    channel: value.channel,
    downloadUrl: value.download_url,
    fileSize: value.file_size == null ? null : Number(value.file_size),
    sha256: value.sha256 || null,
    releaseNotes: value.release_notes || '',
    publishedAt: value.published_at || null,
    available: Boolean(value.published_at && value.download_url),
  };
}

function latestDownloadReleases(platform = null) {
  const params = [];
  let where = "published_at IS NOT NULL AND download_url <> ''";
  if (platform) {
    if (!['MACOS_APPLE', 'WINDOWS_X64'].includes(platform)) throw errors.badRequest('下载平台无效', 'INVALID_DOWNLOAD_PLATFORM');
    where += ' AND platform=?';
    params.push(platform);
  }
  const result = rows(
    `SELECT release.* FROM client_download_releases release
     JOIN (
       SELECT platform, channel, MAX(published_at) AS latest_published_at
       FROM client_download_releases
       WHERE published_at IS NOT NULL AND download_url <> ''
       GROUP BY platform, channel
     ) latest ON latest.platform=release.platform AND latest.channel=release.channel AND latest.latest_published_at=release.published_at
     WHERE ${where}
     ORDER BY platform, channel`,
    params,
  ).map(normalizeDownloadRelease);
  if (platform) return result[0] || null;
  return result;
}

function helpCenterPayload() {
  const releases = latestDownloadReleases();
  const byPlatform = Object.fromEntries(releases.map((item) => [item.platform, item]));
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
      client: ['桌面端配置由机构或平台管理员分发', '未配置真实安装包时不提供下载', '如遇安装失败请联系老师反馈'],
    },
    downloads: {
      status: releases.length ? 'PARTIAL' : 'NOT_CONFIGURED',
      statement: releases.length ? '以下仅展示平台已配置的真实客户端版本。' : '平台尚未配置真实客户端安装包，不提供虚假下载链接。',
      items: releases,
      byPlatform,
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
