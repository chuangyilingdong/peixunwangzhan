/**
 * 平台实时监控台（只读）。
 *
 * 数据口径（与「用量与成本」页保持一致，别在这里另造一套）：
 *   · 对外售价 = compute_attempts.sale_price_fen，且只计 status='SUCCESS'；
 *   · 平台成本 = compute_attempts.upstream_cost_fen；cost_source='UNKNOWN' 或空值算「未知」，
 *     单独计数，绝不按 0 计；**永远不要 SUM usage_records.cost_fen**（那一列有三种历史含义）。
 *   · 「正在跑」只能看 compute_attempts（RUNNING/SUBMITTED）和 generation_jobs（QUEUED/RUNNING）；
 *     usage_records 只在调用结束时才插入，不能拿来当实时状态。
 *
 * 权限：
 *   · 路径挂在 /api/admin/dashboard 下，继承 ADMIN_ANALYTICS；
 *   · 成本/余额字段在 handler 内再判 ADMIN_BILLING（root 视为有），没权限时**不返回**这些字段，
 *     而不是返回 0 —— 前端据此显示占位。
 *
 * 性能：
 *   · 所有查询都有时间下界 + LIMIT；快照 3 秒进程内缓存（key 里带权限位，避免串权）；
 *   · 余额单独一个接口（60 秒缓存），不放在 5 秒轮询的快照里，避免首次探测拖慢看板。
 */
import { arow, arows, aq, errors, id, isRootPlatformAdmin } from '../../lib.js';
import { getProviderApiKey } from '../../services/providerSecret.js';
import { getRunningHubBalance, getRunningHubQueue } from '../../services/runningHubAccount.js';
import { getWalletBalances } from '../../services/walletAccounts.js';
import { getWalletHistory } from '../../services/walletHistory.js';
import { getVibecodingActiveTasks } from '../../services/vibecodingActivity.js';
import { invalidateGenerationProviderInfo } from '../../services/generationPollCache.js';

const WINDOWS = Object.freeze({ '5m': 5, '15m': 15, '60m': 60 });
const MAX_SESSIONS = 50;
const MAX_ERRORS = 50;
const SNAPSHOT_TTL_MS = 3000;

const snapshotCache = new Map();

const num = (value) => Number(value || 0) || 0;
const pct = (part, total) => (total > 0 ? Math.round((part / total) * 1000) / 10 : null);

function canSeeBilling(ctx) {
  const auth = ctx.auth;
  if (!auth?.user) return false;
  if (isRootPlatformAdmin(auth)) return true;
  return Array.isArray(auth.user.permissions) && auth.user.permissions.includes('ADMIN_BILLING');
}

function sinceOf(minutes) {
  return new Date(Date.now() - Math.max(1, minutes) * 60_000).toISOString();
}

function normalizeWindow(value) {
  const key = String(value || '5m').trim();
  return Object.prototype.hasOwnProperty.call(WINDOWS, key) ? key : '5m';
}

function placeholders(list) {
  return list.map(() => '?').join(',');
}

// ── 错误流：四个来源合并 ────────────────────────────────────────────────────
// 为什么要四源：一次失败可能只有 attempt、没有 usage（还没走到应用侧），
// 也可能只有 usage（历史/拦截）、只有 job（画布任务中断）、只有 vibe（VibeCoding 对话）。
// 只查一张表一定会漏。合并后按 jobId/taskId 去重，优先保留 attempt（最具体）。

const SOURCE_PRIORITY = Object.freeze({ ATTEMPT: 3, USAGE: 2, JOB: 1, VIBE: 1 });

function severityOf({ source, status, errorCode, jobStatus }) {
  if (String(status).toUpperCase() === 'BLOCKED') return 'warning';
  // 主渠道失败、备用成功：任务最终有交付，降级成 warning，别当成事故
  if (source === 'ATTEMPT' && String(jobStatus || '').toUpperCase() === 'SUCCEEDED') return 'warning';
  if (/AUTH_FAILED|CONFIG_INVALID|GENERATION_INTERRUPTED/.test(String(errorCode || ''))) return 'critical';
  return 'error';
}

async function fetchErrorRows({ since, orgId = '', sessionId = '', userId = '', limit = MAX_ERRORS }) {
  const cap = Math.max(1, Math.min(200, Number(limit) || MAX_ERRORS));
  const filters = { orgId: String(orgId || '').trim(), sessionId: String(sessionId || '').trim(), userId: String(userId || '').trim() };
  const where = (alias, sessionExpression, userExpression = `${alias}.user_id`) => {
    const clauses = [];
    const params = [];
    if (filters.orgId) { clauses.push(`${alias}.org_id=?`); params.push(filters.orgId); }
    if (filters.sessionId) { clauses.push(`${sessionExpression}=?`); params.push(filters.sessionId); }
    if (filters.userId) { clauses.push(`${userExpression}=?`); params.push(filters.userId); }
    return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
  };

  const attemptWhere = where('a', 'a.class_session_id');
  const usageWhere = where('u', 'u.class_session_id');
  const jobWhere = where('j', 'p.class_session_id');
  const vibeWhere = where('c', 'c.class_session_id', 'c.student_id');

  const [attempts, usageRows, jobs, vibes] = await Promise.all([
    arows(`SELECT a.id, a.created_at at, a.status, a.error_code, a.error_message,
        a.org_id, o.name org_name, a.class_session_id, s.title session_title,
        a.user_id, u.display_name user_name, a.modality, a.model,
        a.generation_job_id job_id, a.task_id, a.attempt, j.status job_status
      FROM compute_attempts a
      LEFT JOIN organizations o ON o.id=a.org_id
      LEFT JOIN users u ON u.id=a.user_id
      LEFT JOIN class_sessions s ON s.id=a.class_session_id
      LEFT JOIN generation_jobs j ON j.id=a.generation_job_id
      WHERE a.created_at>=? AND a.status IN ('FAILED','BLOCKED')${attemptWhere.sql}
      ORDER BY a.created_at DESC LIMIT ?`, [since, ...attemptWhere.params, cap]),
    arows(`SELECT u.id, u.created_at at, u.status, u.fail_code error_code, NULL error_message,
        u.org_id, o.name org_name, u.class_session_id, s.title session_title,
        u.user_id, us.display_name user_name, u.modality, u.model,
        u.generation_job_id job_id, NULL task_id
      FROM usage_records u
      LEFT JOIN organizations o ON o.id=u.org_id
      LEFT JOIN users us ON us.id=u.user_id
      LEFT JOIN class_sessions s ON s.id=u.class_session_id
      WHERE u.created_at>=? AND u.status IN ('FAILED','BLOCKED')${usageWhere.sql}
      ORDER BY u.created_at DESC LIMIT ?`, [since, ...usageWhere.params, cap]),
    arows(`SELECT j.id, j.created_at at, j.status, j.error_code, j.error_message,
        j.org_id, o.name org_name, p.class_session_id, s.title session_title,
        j.user_id, u.display_name user_name, j.modality, j.model,
        j.id job_id, NULL task_id
      FROM generation_jobs j
      LEFT JOIN organizations o ON o.id=j.org_id
      LEFT JOIN users u ON u.id=j.user_id
      LEFT JOIN student_projects p ON p.id=j.project_id
      LEFT JOIN class_sessions s ON s.id=p.class_session_id
      WHERE j.created_at>=? AND j.status='FAILED'${jobWhere.sql}
      ORDER BY j.created_at DESC LIMIT ?`, [since, ...jobWhere.params, cap]),
    arows(`SELECT m.id, m.created_at at, m.status, m.error_code, NULL error_message,
        c.org_id, o.name org_name, c.class_session_id, s.title session_title,
        c.student_id user_id, u.display_name user_name, NULL modality, m.model,
        NULL job_id, NULL task_id
      FROM vibecoding_messages m
      JOIN vibecoding_conversations c ON c.id=m.conversation_id
      LEFT JOIN organizations o ON o.id=c.org_id
      LEFT JOIN users u ON u.id=c.student_id
      LEFT JOIN class_sessions s ON s.id=c.class_session_id
      WHERE m.created_at>=? AND m.status IN ('FAILED','BLOCKED')${vibeWhere.sql}
      ORDER BY m.created_at DESC LIMIT ?`, [since, ...vibeWhere.params, cap]),
  ]);

  const normalized = [
    ...attempts.map((row) => ({
      id: row.id, source: 'ATTEMPT', at: row.at, status: row.status,
      errorCode: String(row.error_code || ''), message: String(row.error_message || '').slice(0, 400),
      orgId: row.org_id || null, orgName: row.org_name || null,
      sessionId: row.class_session_id || null, sessionTitle: row.session_title || null,
      userId: row.user_id || null, userName: row.user_name || null,
      modality: row.modality || null, model: row.model || null,
      jobId: row.job_id || null, taskId: row.task_id || null,
      attempt: Number(row.attempt || 1), jobStatus: row.job_status || null,
    })),
    ...usageRows.map((row) => ({
      id: row.id, source: 'USAGE', at: row.at, status: row.status,
      errorCode: String(row.error_code || ''), message: String(row.error_message || '').slice(0, 400),
      orgId: row.org_id || null, orgName: row.org_name || null,
      sessionId: row.class_session_id || null, sessionTitle: row.session_title || null,
      userId: row.user_id || null, userName: row.user_name || null,
      modality: row.modality || null, model: row.model || null,
      jobId: row.job_id || null, taskId: null, attempt: 1, jobStatus: null,
    })),
    ...jobs.map((row) => ({
      id: row.id, source: 'JOB', at: row.at, status: row.status,
      errorCode: String(row.error_code || ''), message: String(row.error_message || '').slice(0, 400),
      orgId: row.org_id || null, orgName: row.org_name || null,
      sessionId: row.class_session_id || null, sessionTitle: row.session_title || null,
      userId: row.user_id || null, userName: row.user_name || null,
      modality: row.modality || null, model: row.model || null,
      jobId: row.job_id || row.id || null, taskId: null, attempt: 1, jobStatus: row.status,
    })),
    ...vibes.map((row) => ({
      id: row.id, source: 'VIBE', at: row.at, status: row.status,
      errorCode: String(row.error_code || ''), message: '',
      orgId: row.org_id || null, orgName: row.org_name || null,
      sessionId: row.class_session_id || null, sessionTitle: row.session_title || null,
      userId: row.user_id || null, userName: row.user_name || null,
      modality: row.modality || null, model: row.model || null,
      jobId: null, taskId: null, attempt: 1, jobStatus: null,
    })),
  ].sort((left, right) => String(right.at).localeCompare(String(left.at)));

  const merged = new Map();
  for (const item of normalized) {
    const key = item.jobId ? `job:${item.jobId}` : item.taskId ? `task:${item.taskId}` : `${item.source}:${item.id}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, { ...item, sources: [item.source] });
      continue;
    }
    const sources = [...new Set([...previous.sources, item.source])];
    if ((SOURCE_PRIORITY[item.source] || 0) > (SOURCE_PRIORITY[previous.source] || 0)) {
      merged.set(key, { ...item, sources });
    } else {
      previous.sources = sources;
    }
  }

  const items = [...merged.values()].map((item) => {
    const failover = item.source === 'ATTEMPT' && item.attempt > 1;
    const recovered = item.source === 'ATTEMPT' && String(item.jobStatus || '').toUpperCase() === 'SUCCEEDED';
    return {
      ...item,
      failover,
      recovered,
      severity: severityOf(item),
    };
  });

  const top = new Map();
  for (const item of items) {
    const code = item.errorCode || 'UNKNOWN';
    const current = top.get(code) || { errorCode: code, count: 0, severity: item.severity, lastAt: item.at };
    current.count += 1;
    if (String(item.at) > String(current.lastAt)) current.lastAt = item.at;
    if (item.severity === 'critical') current.severity = 'critical';
    top.set(code, current);
  }

  return {
    items: items.slice(0, cap),
    total: items.length,
    top: [...top.values()].sort((left, right) => right.count - left.count).slice(0, 8),
  };
}

// ── 快照 ────────────────────────────────────────────────────────────────────

/** xkwuai 的 quota 换算：quota_per_unit=500000 → 元，再 ×100 得「分」。 */
export function xkwuaiQuotaToFen(quota) {
  const value = Number(quota);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round((value / 500000) * 100 * 10000) / 10000;
}

/** 拉取 xkwuai 某一天的逐笔日志（new-api `/api/log/self`，分页，只读）。 */
async function fetchXkwuaiLogs(startSec, endSec) {
  const raw = getProviderApiKey('wallet-xkwuai');
  let config = null;
  try { config = JSON.parse(raw); } catch { config = null; }
  if (!config?.token) throw errors.badRequest('xkwuai 没有配置访问令牌', 'XKWUAI_NO_API_KEY');
  const headers = { authorization: `Bearer ${config.token}`, 'new-api-user': String(config.userId || '') };
  const items = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetch(`https://www.xkwuai.cn/api/log/self?p=${page}&page_size=100`, {
      headers, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw errors.badRequest(`xkwuai 账单接口 HTTP ${response.status}`, 'XKWUAI_LOG_HTTP');
    const payload = await response.json().catch(() => null);
    const list = Array.isArray(payload?.data?.items) ? payload.data.items : [];
    if (!list.length) break;
    let reachedOlder = false;
    for (const item of list) {
      const atMs = Number(item.created_at) * 1000;
      if (!Number.isFinite(atMs)) continue;
      if (atMs < startSec * 1000) { reachedOlder = true; continue; }
      if (atMs >= endSec * 1000) continue;
      items.push(item);
    }
    if (reachedOlder || list.length < 100) break;
  }
  return items;
}

async function readAlertThresholds() {
  const rows = await arows('SELECT alert_type, threshold FROM platform_alert_thresholds WHERE enabled=1');
  const pick = (type) => {
    const row = rows.find((item) => item.alert_type === type);
    return row ? num(row.threshold) : null;
  };
  return { balanceLow: pick('BALANCE_LOW'), consumptionSpike: pick('CONSUMPTION_SPIKE') };
}

/** 对账日：按北京时间切日（存储是 UTC ISO；中国无夏令时，直接 +08:00）。 */
function reconcileDayRange(value) {
  const text = String(value || '').trim();
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  // 用户口径：不要历史，从今天开始 —— 过去日期一律按今天返回（UI 也不给选）。
  const day = /^\d{4}-\d{2}-\d{2}$/.test(text) && text >= today ? text : today;
  const startMs = Date.parse(`${day}T00:00:00.000+08:00`);
  return { day, start: new Date(startMs).toISOString(), end: new Date(startMs + 24 * 3600_000).toISOString() };
}

/** 渠道 → 供应商（按 endpoint 认，认不出就用渠道名）。对账表按这个维度汇总。 */
function supplierResolver(policy) {
  const channels = Array.isArray(policy?.channels) ? policy.channels : [];
  return (channelId) => {
    const channel = channels.find((item) => item.id === channelId);
    const endpoint = String(channel?.endpoint || '').toLowerCase();
    if (endpoint.includes('xkwuai')) return { key: 'xkwuai', label: '星空无穷（xkwuai）' };
    if (endpoint.includes('runninghub.cn')) return { key: 'runninghub-cn', label: 'RunningHub 国内站' };
    if (endpoint.includes('runninghub.ai')) return { key: 'runninghub-global', label: 'RunningHub 全球站' };
    return { key: channelId || 'unknown', label: channel?.name || channelId || '未标记渠道' };
  };
}

async function buildReconcile({ day }) {
  const { start, end } = reconcileDayRange(day);
  const baselineRow = await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1');
  let baselinePolicy = {};
  try { baselinePolicy = JSON.parse(baselineRow?.ai_provider_policy || '{}') || {}; } catch { baselinePolicy = {}; }
  const costBaselineAt = baselinePolicy.costBaselineAt && !Number.isNaN(Date.parse(baselinePolicy.costBaselineAt))
    ? new Date(baselinePolicy.costBaselineAt).toISOString()
    : null;
  const accountingStartAt = baselinePolicy.accountingStartAt && !Number.isNaN(Date.parse(baselinePolicy.accountingStartAt))
    ? new Date(baselinePolicy.accountingStartAt).toISOString()
    : null;
  // 正式记账起点之后的账才算；之前的调用保留但不进对账。
  const effectiveStart = accountingStartAt && accountingStartAt > start ? accountingStartAt : start;
  const coverageSince = new Date(Math.max(
    Date.parse(costBaselineAt || start),
    Date.parse(effectiveStart),
  )).toISOString();
  const thresholds = await readAlertThresholds();
  const [policyRow, costRows, orgRows, sessionRows, studentRows, lessonRows] = await Promise.all([
    arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1'),
    arows(`SELECT channel_id, model, modality, COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='SUCCESS' AND cost_source='REPORTED' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) reported_fen,
        SUM(CASE WHEN status='SUCCESS' AND cost_source='REPORTED' THEN 1 ELSE 0 END) reported_calls,
        SUM(CASE WHEN status='SUCCESS' AND cost_source='COMPUTED' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) computed_fen,
        SUM(CASE WHEN status='SUCCESS' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) cost_fen,
        SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_calls,
        SUM(CASE WHEN status='SUCCESS' AND created_at>=? THEN 1 ELSE 0 END) success_since,
        SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) AND created_at>=? THEN 1 ELSE 0 END) unknown_calls_since
      FROM compute_attempts WHERE created_at>=? AND created_at<? GROUP BY channel_id, model, modality`, [coverageSince, coverageSince, effectiveStart, end]),
    arows(`SELECT a.org_id, COALESCE(o.name,a.org_id) name, COUNT(*) calls,
        SUM(CASE WHEN a.status='SUCCESS' AND a.upstream_cost_fen IS NOT NULL THEN a.upstream_cost_fen ELSE 0 END) cost_fen,
        SUM(CASE WHEN a.status='SUCCESS' AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_calls,
        SUM(CASE WHEN a.status='SUCCESS' AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL) AND a.created_at>=? THEN 1 ELSE 0 END) unknown_calls_since
      FROM compute_attempts a LEFT JOIN organizations o ON o.id=a.org_id
      WHERE a.created_at>=? AND a.created_at<? AND a.org_id IS NOT NULL GROUP BY a.org_id, o.name ORDER BY cost_fen DESC LIMIT 50`, [coverageSince, effectiveStart, end]),
    arows(`SELECT a.class_session_id, COALESCE(s.title,'未命名课堂') title, s.org_id, o.name org_name, COUNT(*) calls,
        SUM(CASE WHEN a.status='SUCCESS' AND a.upstream_cost_fen IS NOT NULL THEN a.upstream_cost_fen ELSE 0 END) cost_fen,
        SUM(CASE WHEN a.status='SUCCESS' AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_calls,
        SUM(CASE WHEN a.status='SUCCESS' AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL) AND a.created_at>=? THEN 1 ELSE 0 END) unknown_calls_since
      FROM compute_attempts a LEFT JOIN class_sessions s ON s.id=a.class_session_id LEFT JOIN organizations o ON o.id=s.org_id
      WHERE a.created_at>=? AND a.created_at<? AND a.class_session_id IS NOT NULL
      GROUP BY a.class_session_id, s.title, s.org_id, o.name ORDER BY cost_fen DESC LIMIT 50`, [coverageSince, effectiveStart, end]),
    arows(`SELECT a.user_id, COALESCE(u.display_name,a.user_id) name, u.org_id, o.name org_name, COUNT(*) calls,
        SUM(CASE WHEN a.status='SUCCESS' AND a.upstream_cost_fen IS NOT NULL THEN a.upstream_cost_fen ELSE 0 END) cost_fen,
        SUM(CASE WHEN a.status='SUCCESS' AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_calls,
        SUM(CASE WHEN a.status='SUCCESS' AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL) AND a.created_at>=? THEN 1 ELSE 0 END) unknown_calls_since
      FROM compute_attempts a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN organizations o ON o.id=u.org_id
      WHERE a.created_at>=? AND a.created_at<? AND a.user_id IS NOT NULL
      GROUP BY a.user_id, u.display_name, u.org_id, o.name ORDER BY cost_fen DESC LIMIT 50`, [coverageSince, effectiveStart, end]),
    arows(`SELECT a.lesson_id, COALESCE(l.title,'未命名课时') lesson_title, COALESCE(series.title,'') series_title, COUNT(*) calls,
        SUM(CASE WHEN a.status='SUCCESS' AND a.upstream_cost_fen IS NOT NULL THEN a.upstream_cost_fen ELSE 0 END) cost_fen,
        SUM(CASE WHEN a.status='SUCCESS' AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_calls,
        SUM(CASE WHEN a.status='SUCCESS' AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL) AND a.created_at>=? THEN 1 ELSE 0 END) unknown_calls_since
      FROM compute_attempts a
      LEFT JOIN course_lessons l ON l.id=a.lesson_id
      LEFT JOIN course_series series ON series.id=l.series_id
      WHERE a.created_at>=? AND a.created_at<? AND a.lesson_id IS NOT NULL
      GROUP BY a.lesson_id, l.title, l.series_id, series.title ORDER BY cost_fen DESC LIMIT 50`, [coverageSince, effectiveStart, end]),
  ]);

  let policy = {};
  try { policy = JSON.parse(policyRow?.ai_provider_policy || '{}') || {}; } catch { policy = {}; }
  const supplierOf = supplierResolver(policy);

  const totals = { calls: 0, success: 0, failed: 0, costFen: 0, reportedFen: 0, computedFen: 0, unknownCalls: 0 };
  const suppliers = new Map();
  const models = [];
  for (const row of costRows) {
    const supplier = supplierOf(row.channel_id);
    const item = {
      channelId: row.channel_id || null,
      model: row.model || '—',
      modality: row.modality || '',
      supplierKey: supplier.key,
      supplierLabel: supplier.label,
      calls: num(row.calls), success: num(row.success), failed: num(row.failed),
      costFen: num(row.cost_fen), reportedFen: num(row.reported_fen), computedFen: num(row.computed_fen),
      reportedCalls: num(row.reported_calls),
      unknownCalls: num(row.unknown_calls), successSince: num(row.success_since), unknownCallsSince: num(row.unknown_calls_since),
    };
    models.push(item);
    totals.calls += item.calls; totals.success += item.success; totals.failed += item.failed;
    totals.costFen += item.costFen; totals.reportedFen += item.reportedFen;
    totals.computedFen += item.computedFen; totals.unknownCalls += item.unknownCalls;
    const agg = suppliers.get(supplier.key) || { key: supplier.key, label: supplier.label, calls: 0, costFen: 0, reportedFen: 0, computedFen: 0, reportedCalls: 0, unknownCalls: 0 };
    agg.calls += item.calls; agg.costFen += item.costFen; agg.reportedFen += item.reportedFen;
    agg.computedFen += item.computedFen; agg.unknownCalls += item.unknownCalls; agg.reportedCalls += item.reportedCalls;
    agg.successSince = (agg.successSince || 0) + item.successSince;
    agg.unknownCallsSince = (agg.unknownCallsSince || 0) + item.unknownCallsSince;
    suppliers.set(supplier.key, agg);
  }
  const money = (fen) => Math.round(Number(fen || 0) * 10000) / 10000;
  totals.costFen = money(totals.costFen);
  totals.reportedFen = money(totals.reportedFen);
  totals.computedFen = money(totals.computedFen);
  totals.successSince = costRows.reduce((sum, row) => sum + num(row.success_since), 0);
  totals.unknownCallsSince = costRows.reduce((sum, row) => sum + num(row.unknown_calls_since), 0);
  totals.unknownRate = pct(totals.unknownCalls, totals.success);
  totals.unknownRateSince = pct(totals.unknownCallsSince, totals.successSince);
  totals.costCoverageRate = pct(totals.successSince - totals.unknownCallsSince, totals.successSince);
  totals.costBaselineAt = costBaselineAt;

  return {
    generatedAt: new Date().toISOString(),
    day,
    timezone: 'Asia/Shanghai',
    range: { start: effectiveStart, dayStart: start, end },
    thresholds,
    totals,
    bySupplier: [...suppliers.values()].map((item) => ({
      ...item,
      costFen: money(item.costFen), reportedFen: money(item.reportedFen), computedFen: money(item.computedFen),
      unknownRate: pct(item.unknownCalls, item.calls),
    })).sort((a, b) => b.costFen - a.costFen),
    byModel: models.map((item) => ({
      ...item, costFen: money(item.costFen), reportedFen: money(item.reportedFen), computedFen: money(item.computedFen),
    })).sort((a, b) => b.costFen - a.costFen).slice(0, 50),
    byOrg: orgRows.map((row) => ({ orgId: row.org_id, name: row.name, calls: num(row.calls), costFen: money(row.cost_fen), unknownCalls: num(row.unknown_calls), unknownCallsSince: num(row.unknown_calls_since) })),
    bySession: sessionRows.map((row) => ({ sessionId: row.class_session_id, title: row.title, orgName: row.org_name || '', calls: num(row.calls), costFen: money(row.cost_fen), unknownCalls: num(row.unknown_calls), unknownCallsSince: num(row.unknown_calls_since) })),
    byStudent: studentRows.map((row) => ({ userId: row.user_id, name: row.name, orgName: row.org_name || '', calls: num(row.calls), costFen: money(row.cost_fen), unknownCalls: num(row.unknown_calls), unknownCallsSince: num(row.unknown_calls_since) })),
    byLesson: lessonRows.map((row) => ({
      lessonId: row.lesson_id, lessonTitle: row.lesson_title, seriesTitle: row.series_title || '',
      calls: num(row.calls), costFen: money(row.cost_fen), unknownCalls: num(row.unknown_calls), unknownCallsSince: num(row.unknown_calls_since),
    })),
  };
}

async function buildSnapshot({ windowKey, orgId, billingVisible }) {
  const buildStartedAt = Date.now();
  const minutes = WINDOWS[windowKey];
  // 正式记账起点：比窗口起点更晚时，整个快照只统计起点之后的调用（从 0 开始）。
  const baselineRow = await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1');
  let baselinePolicy = {};
  try { baselinePolicy = JSON.parse(baselineRow?.ai_provider_policy || '{}') || {}; } catch { baselinePolicy = {}; }
  const costBaselineAt = baselinePolicy.costBaselineAt && !Number.isNaN(Date.parse(baselinePolicy.costBaselineAt))
    ? new Date(baselinePolicy.costBaselineAt).toISOString()
    : null;
  const accountingStartAt = baselinePolicy.accountingStartAt && !Number.isNaN(Date.parse(baselinePolicy.accountingStartAt))
    ? new Date(baselinePolicy.accountingStartAt).toISOString()
    : null;
  const windowSince = sinceOf(minutes);
  const since = accountingStartAt && accountingStartAt > windowSince ? accountingStartAt : windowSince;
  const seriesSince = since;
  const orgFilter = String(orgId || '').trim();

  const stuckBefore = sinceOf(15);
  const stuckSince = sinceOf(6 * 60);
  // 「运行中」只认最近 2 小时：库里有一批 9/10 月遗留的 RUNNING/SUBMITTED，
  // 不设下界会把它们永远算成"正在跑"（2026-11-04 实测 16 条，最新也是几小时前）。
  const activeSince = sinceOf(2 * 60);

  // 成本覆盖基线：配价完成后才算「应该知道成本」的调用；更早的历史无价调用不参与未知告警。
  const coverageSince = costBaselineAt && costBaselineAt > since ? costBaselineAt : since;
  const thresholds = await readAlertThresholds();

  const [live, usageWindow, attemptsWindow, seriesRows, orgRows, orgStats, sessionRows, stuckAttemptRows, stuckJobRows, costRows, policyRow, queueStatus, channelRows, durationRows, lastSuccessRows, failoverRows, studentCostRows, blockedRows, failoverReasonRows] = await Promise.all([
    arow(`SELECT
        (SELECT COUNT(*) FROM compute_attempts WHERE status IN ('RUNNING','SUBMITTED') AND created_at>=?) running_attempts,
        (SELECT COUNT(*) FROM generation_jobs WHERE status='QUEUED' AND created_at>=?) queued_jobs,
        (SELECT COUNT(*) FROM generation_jobs WHERE status='RUNNING' AND created_at>=?) running_jobs`, [activeSince, activeSince, activeSince]),
    arow(`SELECT COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='BLOCKED' THEN 1 ELSE 0 END) blocked
      FROM usage_records WHERE created_at>=?`, [since]),
    arow(`SELECT COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='FAILED' AND (COALESCE(error_message,'') LIKE '%内容安全%' OR COALESCE(error_message,'') LIKE '%Content security%') THEN 1 ELSE 0 END) content_safety_failed,
        SUM(CASE WHEN status='SUCCESS' THEN COALESCE(sale_price_fen,0) ELSE 0 END) sale_fen,
        SUM(CASE WHEN status='SUCCESS' AND cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) known_cost_fen,
        SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_cost_calls,
        SUM(CASE WHEN status='SUCCESS' AND created_at>=? THEN 1 ELSE 0 END) success_since,
        SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) AND created_at>=? THEN 1 ELSE 0 END) unknown_cost_calls_since
      FROM compute_attempts WHERE created_at>=?`, [coverageSince, coverageSince, since]),
    arows(`SELECT substr(created_at,1,16) minute,
        COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='SUCCESS' AND cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) cost_fen
      FROM compute_attempts WHERE created_at>=? GROUP BY substr(created_at,1,16) ORDER BY minute`, [seriesSince]),
    arows(`SELECT o.id, o.name, o.status,
        (SELECT COUNT(*) FROM users u WHERE u.org_id=o.id AND u.role='TEACHER' AND u.deleted_at IS NULL) teachers,
        (SELECT COUNT(*) FROM users u WHERE u.org_id=o.id AND u.role='STUDENT' AND u.deleted_at IS NULL) students,
        (SELECT COUNT(*) FROM class_sessions s WHERE s.org_id=o.id AND s.status='ACTIVE') active_sessions
      FROM organizations o WHERE (?='' OR o.id=?) ORDER BY o.name`, [orgFilter, orgFilter]),
    arows(`SELECT org_id, COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='SUCCESS' THEN COALESCE(sale_price_fen,0) ELSE 0 END) sale_fen,
        SUM(CASE WHEN status='SUCCESS' AND cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) known_cost_fen
      FROM compute_attempts WHERE created_at>=? AND org_id IS NOT NULL GROUP BY org_id`, [since]),
    arows(`SELECT s.id, s.org_id, s.title, s.teacher_id, s.lesson_id, s.series_id, s.started_at,
        o.name org_name, u.display_name teacher_name, l.title lesson_title,
        (SELECT COUNT(*) FROM session_students ss WHERE ss.session_id=s.id AND ss.status<>'REMOVED') roster,
        (SELECT COUNT(*) FROM session_students ss WHERE ss.session_id=s.id AND ss.status='ACTIVE') active_students,
        (SELECT MAX(t.at) FROM (
           SELECT MAX(a.created_at) AS at FROM compute_attempts a WHERE a.class_session_id=s.id
           UNION ALL SELECT MAX(u2.created_at) FROM usage_records u2 WHERE u2.class_session_id=s.id
           UNION ALL SELECT MAX(m.created_at) FROM vibecoding_messages m
             JOIN vibecoding_conversations c ON c.id=m.conversation_id WHERE c.class_session_id=s.id
         ) t) last_activity
      FROM class_sessions s
      LEFT JOIN organizations o ON o.id=s.org_id
      LEFT JOIN users u ON u.id=s.teacher_id
      LEFT JOIN course_lessons l ON l.id=s.lesson_id
      WHERE s.status='ACTIVE' AND (?='' OR s.org_id=?)
      ORDER BY s.started_at DESC LIMIT ?`, [orgFilter, orgFilter, MAX_SESSIONS]),
    // 卡住任务：只看最近 6 小时内、已超过 15 分钟还没收尾的 —— 历史遗留的脏 attempt 不算。
    arows(`SELECT a.id, a.modality, a.model, a.channel_id, a.status, a.created_at
        FROM compute_attempts a LEFT JOIN generation_jobs j ON j.id=a.generation_job_id
        WHERE a.status IN ('RUNNING','SUBMITTED') AND a.created_at>=? AND a.created_at<?
          AND (a.generation_job_id IS NULL OR j.status IN ('QUEUED','RUNNING'))
        ORDER BY a.created_at ASC LIMIT 20`, [stuckSince, stuckBefore]),
    arows(`SELECT id, modality, model, status, created_at FROM generation_jobs
        WHERE status IN ('QUEUED','RUNNING') AND created_at>=? AND created_at<?
        ORDER BY created_at ASC LIMIT 20`, [stuckSince, stuckBefore]),
    arows(`SELECT channel_id, model, modality, COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status='SUCCESS' AND cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) known_cost_fen,
        SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_calls
      FROM compute_attempts WHERE created_at>=?
      GROUP BY channel_id, model, modality ORDER BY known_cost_fen DESC LIMIT 8`, [since]),
    arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1'),
    // RunningHub 账户级队列（15 秒缓存）；没配 RH 渠道时返回 ok:false，不影响快照。
    getRunningHubQueue(),
    // 渠道健康：窗口内调用/失败分类；耗时另查一次算 P50/P95。
    arows(`SELECT channel_id, COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='FAILED' AND COALESCE(error_code,'') LIKE '%AUTH%' THEN 1 ELSE 0 END) auth_failed,
        SUM(CASE WHEN status='FAILED' AND COALESCE(error_code,'') LIKE '%TIMEOUT%' THEN 1 ELSE 0 END) timeout_failed,
        SUM(CASE WHEN status='FAILED' AND COALESCE(error_code,'') LIKE '%RATE_LIMIT%' THEN 1 ELSE 0 END) rate_failed,
        SUM(CASE WHEN status='FAILED' AND COALESCE(error_code,'') LIKE '%HTTP_ERROR%' THEN 1 ELSE 0 END) http_failed,
        SUM(CASE WHEN status='FAILED' AND COALESCE(error_code,'') NOT LIKE '%AUTH%'
                  AND COALESCE(error_code,'') NOT LIKE '%TIMEOUT%'
                  AND COALESCE(error_code,'') NOT LIKE '%RATE_LIMIT%'
                  AND COALESCE(error_code,'') NOT LIKE '%HTTP_ERROR%' THEN 1 ELSE 0 END) other_failed
      FROM compute_attempts WHERE created_at>=? GROUP BY channel_id`, [since]),
    arows(`SELECT channel_id, created_at, completed_at FROM compute_attempts
        WHERE created_at>=? AND completed_at IS NOT NULL AND status IN ('SUCCESS','FAILED') LIMIT 5000`, [since]),
    arows(`SELECT channel_id, MAX(created_at) last_success FROM compute_attempts
        WHERE status='SUCCESS' AND created_at>=? GROUP BY channel_id`, [sinceOf(7 * 24 * 60)]),
    arows(`SELECT channel_id, COUNT(*) attempts, SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success
        FROM compute_attempts WHERE attempt>1 AND created_at>=? GROUP BY channel_id`, [since]),
    arows(`SELECT a.user_id, MAX(u.display_name) name, COUNT(*) calls,
        SUM(CASE WHEN a.status='SUCCESS' AND a.cost_source<>'UNKNOWN' AND a.upstream_cost_fen IS NOT NULL THEN a.upstream_cost_fen ELSE 0 END) known_cost_fen,
        SUM(CASE WHEN a.status='SUCCESS' AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_calls
      FROM compute_attempts a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.created_at>=? AND a.user_id IS NOT NULL
      GROUP BY a.user_id ORDER BY known_cost_fen DESC LIMIT 8`, [since]),
    // 拦截原因（usage_records.status='BLOCKED'）：额度/并发/课堂暂停/内容审核等。
    arows(`SELECT COALESCE(fail_code,'UNKNOWN') code, COUNT(*) n
        FROM usage_records WHERE created_at>=? AND status='BLOCKED'
        GROUP BY fail_code ORDER BY n DESC LIMIT 8`, [since]),
    // 主备切换原因：cur 是备用 attempt，prev 是同一 call 的上一条失败（error_code）。
    arows(`SELECT cur.channel_id to_channel, prev.channel_id from_channel, COALESCE(prev.error_code,'UNKNOWN') error_code, COUNT(*) n
      FROM compute_attempts cur
      JOIN compute_attempts prev ON prev.call_id=cur.call_id AND prev.attempt=cur.attempt-1
      WHERE cur.created_at>=? AND cur.attempt>1
      GROUP BY cur.channel_id, prev.channel_id, prev.error_code ORDER BY n DESC LIMIT 20`, [since]),
  ]);

  const nowMs = Date.now();
  const ACTIVE_WINDOW_MS = 90 * 60_000;
  const recentEnough = (iso) => {
    const time = Date.parse(iso);
    return Number.isFinite(time) && nowMs - time <= ACTIVE_WINDOW_MS;
  };
  // 「活跃课堂」= 开课中且 90 分钟内有活动（AI 调用 / 用量 / VibeCoding），或刚开课 90 分钟内。
  // 只按 status='ACTIVE' 会把 9/29、10/24 那些没点「结束」的课堂永远算成活跃。
  const activeSessionRows = sessionRows.filter((row) => recentEnough(row.started_at) || recentEnough(row.last_activity));
  const staleSessionCount = sessionRows.length - activeSessionRows.length;
  const activeByOrg = new Map();
  for (const row of activeSessionRows) {
    const key = row.org_id || '';
    activeByOrg.set(key, (activeByOrg.get(key) || 0) + 1);
  }
  const sessionIds = activeSessionRows.map((row) => row.id);
  const sessionStats = sessionIds.length ? await arows(`SELECT class_session_id, COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='SUCCESS' THEN COALESCE(sale_price_fen,0) ELSE 0 END) sale_fen,
        SUM(CASE WHEN status='SUCCESS' AND cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) known_cost_fen,
        SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_cost_calls
      FROM compute_attempts WHERE created_at>=? AND class_session_id IN (${placeholders(sessionIds)}) GROUP BY class_session_id`, [since, ...sessionIds]) : [];

  const statsBySession = new Map(sessionStats.map((row) => [row.class_session_id, row]));
  const statsByOrg = new Map(orgStats.map((row) => [row.org_id, row]));

  const sessions = activeSessionRows.map((row) => {
    const stats = statsBySession.get(row.id) || {};
    return {
      id: row.id, orgId: row.org_id, orgName: row.org_name,
      title: row.title || row.lesson_title || '未命名课堂',
      lessonTitle: row.lesson_title || null,
      teacherId: row.teacher_id || null, teacherName: row.teacher_name || null,
      startedAt: row.started_at || null,
      roster: num(row.roster), activeStudents: num(row.active_students),
      calls: num(stats.calls), success: num(stats.success), failed: num(stats.failed),
      ...(billingVisible ? {
        saleFen: num(stats.sale_fen), knownCostFen: num(stats.known_cost_fen),
        unknownCostCalls: num(stats.unknown_cost_calls),
      } : {}),
    };
  });

  const orgs = orgRows.map((row) => {
    const stats = statsByOrg.get(row.id) || {};
    return {
      id: row.id, name: row.name, status: row.status,
      teachers: num(row.teachers), students: num(row.students),
      activeSessions: activeByOrg.get(row.id) || 0,
      calls: num(stats.calls), success: num(stats.success), failed: num(stats.failed),
      ...(billingVisible ? {
        saleFen: num(stats.sale_fen), knownCostFen: num(stats.known_cost_fen),
      } : {}),
    };
  });

  // 序列按所选窗口补齐分钟桶（没有调用的分钟补 0，图表才不会跳）
  const byMinute = new Map(seriesRows.map((row) => [String(row.minute), row]));
  const series = [];
  for (let index = minutes - 1; index >= 0; index -= 1) {
    const minute = new Date(Date.now() - index * 60_000).toISOString().slice(0, 16);
    const row = byMinute.get(minute) || {};
    series.push({
      minute,
      calls: num(row.calls), success: num(row.success), failed: num(row.failed),
      ...(billingVisible ? { costFen: num(row.cost_fen) } : {}),
    });
  }

  const attempts = attemptsWindow || {};
  const usage = usageWindow || {};
  const contentSafetyFailed = num(attempts.content_safety_failed);
  const providerFailed = Math.max(0, num(attempts.failed) - contentSafetyFailed);
  const errorsResult = await fetchErrorRows({ since, orgId: orgFilter, limit: MAX_ERRORS });

  // 渠道显示名：从策略里取，取不到就只给 id（不再跨模块 import，避免把整条账单路由拖进监控）。
  const channelNames = new Map();
  try {
    const policy = JSON.parse(policyRow?.ai_provider_policy || '{}');
    for (const channel of policy.channels || []) channelNames.set(channel.id, channel.name || channel.id);
  } catch { /* 策略坏了不影响监控 */ }
  const ageMinutes = (iso) => {
    const time = Date.parse(iso);
    return Number.isFinite(time) ? Math.max(0, Math.round((Date.now() - time) / 60000)) : null;
  };
  // VibeCoding 的进行中任务只在进程内（SSE），库里没有 RUNNING 状态。
  const vibeTasks = getVibecodingActiveTasks();
  const stuck = [
    ...stuckAttemptRows.map((row) => ({
      kind: 'ATTEMPT', id: row.id, modality: row.modality || null, model: row.model || null,
      channelId: row.channel_id || null, channelName: channelNames.get(row.channel_id) || null,
      status: row.status, createdAt: row.created_at, ageMinutes: ageMinutes(row.created_at),
    })),
    ...stuckJobRows.map((row) => ({
      kind: 'JOB', id: row.id, modality: row.modality || null, model: row.model || null,
      channelId: null, channelName: null, status: row.status, createdAt: row.created_at, ageMinutes: ageMinutes(row.created_at),
    })),
    ...vibeTasks.filter((task) => nowMs - task.startedAt > 15 * 60_000).map((task) => ({
      kind: 'VIBE', id: task.id, modality: 'TEXT', model: task.model || null,
      channelId: null, channelName: null, status: 'RUNNING',
      createdAt: new Date(task.startedAt).toISOString(),
      ageMinutes: Math.round((nowMs - task.startedAt) / 60000),
    })),
  ].sort((left, right) => (right.ageMinutes || 0) - (left.ageMinutes || 0)).slice(0, 20);

  const costTop = billingVisible ? costRows.map((row) => ({
    channelId: row.channel_id || null,
    channelName: channelNames.get(row.channel_id) || null,
    model: row.model || null,
    modality: row.modality || null,
    calls: num(row.calls), success: num(row.success),
    knownCostFen: num(row.known_cost_fen), unknownCalls: num(row.unknown_calls),
  })) : undefined;

  const lastSuccessByChannel = new Map(lastSuccessRows.map((row) => [row.channel_id, row.last_success]));
  const failoverByChannel = new Map(failoverRows.map((row) => [row.channel_id, row]));
  const durationsByChannel = new Map();
  for (const row of durationRows) {
    const start = Date.parse(row.created_at);
    const end = Date.parse(row.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const key = row.channel_id || '';
    if (!durationsByChannel.has(key)) durationsByChannel.set(key, []);
    durationsByChannel.get(key).push(end - start);
  }
  const percentile = (list, p) => {
    if (!list.length) return null;
    const sorted = [...list].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  };
  const channels = channelRows.map((row) => {
    const durations = durationsByChannel.get(row.channel_id || '') || [];
    const success = num(row.success);
    const failed = num(row.failed);
    const failoverRow = failoverByChannel.get(row.channel_id) || {};
    return {
      channelId: row.channel_id || null,
      channelName: channelNames.get(row.channel_id) || row.channel_id || '未标记渠道',
      calls: num(row.calls), success, failed,
      errorRate: pct(failed, success + failed),
      authFailed: num(row.auth_failed), timeout: num(row.timeout_failed),
      rateLimited: num(row.rate_failed),
      httpError: num(row.http_failed), otherError: num(row.other_failed),
      p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95),
      lastSuccessAt: lastSuccessByChannel.get(row.channel_id) || null,
      failovers: num(failoverRow.attempts), failoverSuccess: num(failoverRow.success),
    };
  }).sort((left, right) => right.calls - left.calls);

  const failover = {
    count: failoverRows.reduce((sum, row) => sum + num(row.attempts), 0),
    success: failoverRows.reduce((sum, row) => sum + num(row.success), 0),
    byChannel: failoverRows.map((row) => ({
      channelId: row.channel_id || null,
      channelName: channelNames.get(row.channel_id) || row.channel_id || '未标记渠道',
      attempts: num(row.attempts), success: num(row.success),
    })).sort((left, right) => right.attempts - left.attempts).slice(0, 5),
  };

  const studentCostTop = billingVisible ? studentCostRows.map((row) => ({
    userId: row.user_id || null,
    name: row.name || row.user_id || '—',
    calls: num(row.calls),
    knownCostFen: num(row.known_cost_fen),
    unknownCalls: num(row.unknown_calls),
  })) : undefined;

  return {
    generatedAt: new Date().toISOString(),
    buildMs: Date.now() - buildStartedAt,
    window: windowKey,
    thresholds,
    since,
    until: new Date().toISOString(),
    timezone: 'UTC',
    live: {
      activeSessions: activeSessionRows.length,
      activeStudents: activeSessionRows.reduce((sum, row) => sum + num(row.active_students), 0),
      staleActiveSessions: staleSessionCount,
      runningAttempts: num(live?.running_attempts),
      queuedJobs: num(live?.queued_jobs),
      runningJobs: num(live?.running_jobs),
      vibecodingRunning: vibeTasks.length,
      stuckAttempts: stuckAttemptRows.length,
      stuckJobs: stuckJobRows.length,
    },
    usage: {
      calls: num(attempts.calls),
      success: num(attempts.success),
      failed: num(attempts.failed),
      blocked: num(usage.blocked),
      errorRate: pct(num(attempts.failed), num(attempts.success) + num(attempts.failed)),
      providerFailed,
      contentSafetyFailed,
      providerErrorRate: pct(providerFailed, num(attempts.success) + providerFailed),
      ...(billingVisible ? {
        saleFen: num(attempts.sale_fen),
        knownCostFen: num(attempts.known_cost_fen),
        unknownCostCalls: num(attempts.unknown_cost_calls),
        unknownCostRate: pct(num(attempts.unknown_cost_calls), num(attempts.success)),
        costBaselineAt,
        successSince: num(attempts.success_since),
        unknownCostCallsSince: num(attempts.unknown_cost_calls_since),
        unknownCostRateSince: pct(num(attempts.unknown_cost_calls_since), num(attempts.success_since)),
        costCoverageRate: pct(num(attempts.success_since) - num(attempts.unknown_cost_calls_since), num(attempts.success_since)),
      } : {}),
    },
    series,
    orgs,
    sessions,
    errors: errorsResult.items,
    errorTop: errorsResult.top,
    stuck,
    queue: queueStatus,
    blockedReasons: blockedRows.map((row) => ({ code: row.code || 'UNKNOWN', count: num(row.n) })),
    channels,
    failover,
    failoverReasons: (failoverReasonRows || []).map((row) => ({
      fromChannelId: row.from_channel || null,
      fromChannelName: channelNames.get(row.from_channel) || row.from_channel || '—',
      toChannelId: row.to_channel || null,
      toChannelName: channelNames.get(row.to_channel) || row.to_channel || '—',
      errorCode: row.error_code || 'UNKNOWN',
      count: num(row.n),
    })),
    ...(billingVisible ? { costTop, studentCostTop } : {}),
    billingVisible,
  };
}

// ── 课堂下钻 ────────────────────────────────────────────────────────────────

async function buildClassroom(sessionId) {
  const session = await arow(`SELECT s.*, o.name org_name, u.display_name teacher_name, l.title lesson_title
    FROM class_sessions s
    LEFT JOIN organizations o ON o.id=s.org_id
    LEFT JOIN users u ON u.id=s.teacher_id
    LEFT JOIN course_lessons l ON l.id=s.lesson_id
    WHERE s.id=?`, [sessionId]);
  if (!session) throw errors.notFound('课堂不存在', 'CLASS_SESSION_NOT_FOUND');

  const [roster, stats, recentErrors] = await Promise.all([
    arows(`SELECT ss.student_id, ss.status roster_status, u.display_name, u.login
      FROM session_students ss LEFT JOIN users u ON u.id=ss.student_id
      WHERE ss.session_id=? AND ss.status<>'REMOVED' ORDER BY u.display_name, u.login`, [sessionId]),
    arows(`SELECT user_id, COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='SUCCESS' THEN COALESCE(sale_price_fen,0) ELSE 0 END) sale_fen,
        SUM(CASE WHEN status='SUCCESS' AND cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) known_cost_fen,
        SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_cost_calls,
        MAX(created_at) last_at
      FROM compute_attempts WHERE class_session_id=? GROUP BY user_id`, [sessionId]),
    fetchErrorRows({ since: sinceOf(24 * 60), sessionId, limit: 30 }),
  ]);

  const statsByUser = new Map(stats.map((row) => [row.user_id, row]));
  const students = roster.map((row) => {
    const stat = statsByUser.get(row.student_id) || {};
    return {
      userId: row.student_id,
      name: row.display_name || row.login || row.student_id,
      login: row.login || null,
      rosterStatus: row.roster_status,
      calls: num(stat.calls), success: num(stat.success), failed: num(stat.failed),
      saleFen: num(stat.sale_fen),
      knownCostFen: num(stat.known_cost_fen),
      unknownCostCalls: num(stat.unknown_cost_calls),
      lastAt: stat.last_at || null,
    };
  });

  const totals = students.reduce((sum, item) => ({
    calls: sum.calls + item.calls, success: sum.success + item.success, failed: sum.failed + item.failed,
    saleFen: sum.saleFen + item.saleFen, knownCostFen: sum.knownCostFen + item.knownCostFen,
    unknownCostCalls: sum.unknownCostCalls + item.unknownCostCalls,
  }), { calls: 0, success: 0, failed: 0, saleFen: 0, knownCostFen: 0, unknownCostCalls: 0 });

  return {
    generatedAt: new Date().toISOString(),
    session: {
      id: session.id, title: session.title, orgId: session.org_id, orgName: session.org_name,
      teacherName: session.teacher_name, lessonTitle: session.lesson_title,
      status: session.status, startedAt: session.started_at || null,
    },
    students,
    totals,
    errors: recentErrors.items,
    errorTop: recentErrors.top,
  };
}

// ── 路由 ────────────────────────────────────────────────────────────────────

// ── 当前模型（监控台手动切换）──────────────────────────────────────────────
// 行 = 学生实际用到的能力；候选 = 策略里能服务这个能力的渠道（按模型名推断模态）。
// 切换只改路由（modalityChannels / imageModeChannels）与渠道默认模型，不删不改渠道本身。
const MODEL_ROWS = Object.freeze([
  { key: 'TEXT', label: '文本', modality: 'TEXT' },
  { key: 'IMAGE_T2I', label: '文生图', modality: 'IMAGE' },
  { key: 'IMAGE_I2I', label: '图生图', modality: 'IMAGE' },
  { key: 'VIDEO', label: '视频', modality: 'VIDEO' },
  { key: 'MUSIC', label: '音乐', modality: 'MUSIC' },
]);

// 官方图 quality 档位（2026-11-04 实测，1k，runninghub gpt-image-2 官方）：
// 单价是上游实扣折成分，耗时是提交到出图的端到端时间。i2i 的中/高没有实测（null = 不展示）。
const IMAGE_QUALITY_OPTIONS = Object.freeze([
  { value: 'low', label: 'low（合同价）', t2iFen: 6, i2iFen: 18, t2iSeconds: 52, i2iSeconds: 27 },
  { value: 'medium', label: 'medium', t2iFen: 36, i2iFen: 36, t2iSeconds: 50, i2iSeconds: null },
  { value: 'high', label: 'high', t2iFen: 133, i2iFen: 133, t2iSeconds: 146, i2iSeconds: null },
]);

function normalizeImageQuality(value) {
  const key = String(value || '').toLowerCase();
  return ['low', 'medium', 'high'].includes(key) ? key : 'low';
}

function inferChannelModality(channel) {
  const model = String(channel?.model || '').toLowerCase();
  if (/music|mureka|song/.test(model)) return 'MUSIC';
  if (/seedance|hailuo|video|wan-3\.0|alibaba/.test(model)) return 'VIDEO';
  if (/image|rhart|zhenzhen|flux|sdxl|dall/.test(model)) return 'IMAGE';
  return 'TEXT';
}

function candidateChannels(policy, row) {
  const channels = Array.isArray(policy?.channels) ? policy.channels : [];
  return channels.filter((channel) => {
    if (inferChannelModality(channel) !== row.modality) return false;
    if (row.key === 'IMAGE_I2I') return /-i2i/i.test(String(channel.model || ''));
    if (row.key === 'IMAGE_T2I') return !/-i2i/i.test(String(channel.model || ''));
    return true;
  }).flatMap((channel) => {
    // 候选 = 渠道真正勾选的模型（channel.models ∪ 默认模型）。
    // ⚠️ 不要把 modelMappings 也铺进来：那是「读取模型」拿到的上游全量清单（几十个），
    // 运营只勾了 1 个，下拉却会列出几十行，看起来像「没保存成功」。切换的是渠道，不是上游目录。
    const models = [
      ...(Array.isArray(channel.models) ? channel.models : []),
      channel.model,
    ].filter(Boolean);
    return [...new Set(models)].map((model) => ({
      channelId: channel.id,
      channelName: channel.name || channel.id,
      model,
    }));
  });
}

function currentChannelId(policy, row) {
  const modality = policy?.modalityChannels || {};
  const imageModes = policy?.imageModeChannels || {};
  if (row.key === 'IMAGE_T2I') return imageModes.TEXT || modality.IMAGE || '';
  if (row.key === 'IMAGE_I2I') return imageModes.IMAGE_REFERENCE || modality.IMAGE || '';
  return modality[row.modality] || '';
}

async function buildModelRows(policy) {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const healthRows = await arows(`SELECT channel_id, COUNT(*) calls,
      SUM(CASE WHEN status='FAILED' AND NOT(COALESCE(error_message,'') LIKE '%内容安全%' OR COALESCE(error_message,'') LIKE '%Content security%') THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN status='FAILED' AND (COALESCE(error_message,'') LIKE '%内容安全%' OR COALESCE(error_message,'') LIKE '%Content security%') THEN 1 ELSE 0 END) content_safety_failed
    FROM compute_attempts WHERE created_at>=? GROUP BY channel_id`, [since]);
  const health = new Map(healthRows.map((row) => [row.channel_id, {
    calls: num(row.calls),
    failed: num(row.failed),
    contentSafetyFailed: num(row.content_safety_failed),
  }]));
  const channels = new Map((policy.channels || []).map((channel) => [channel.id, channel]));
  return MODEL_ROWS.map((row) => {
    const currentId = currentChannelId(policy, row);
    const current = channels.get(currentId) || null;
    const options = candidateChannels(policy, row);
    const currentHealth = health.get(currentId) || { calls: 0, failed: 0 };
    const errorRate = pct(currentHealth.failed, currentHealth.calls);
    const recommendation = errorRate !== null && errorRate >= 50 && currentHealth.calls >= 3
      ? options.find((option) => {
        if (option.channelId === currentId) return false;
        const item = health.get(option.channelId) || { calls: 0, failed: 0 };
        return item.calls === 0 || (pct(item.failed, item.calls) ?? 0) < 20;
      }) || null
      : null;
    return {
      key: row.key,
      label: row.label,
      modality: row.modality,
      channelId: currentId || null,
      channelName: current?.name || currentId || '未配置',
      model: current?.model || null,
      calls: currentHealth.calls,
      failed: currentHealth.failed,
      contentSafetyFailed: currentHealth.contentSafetyFailed || 0,
      errorRate,
      options,
      recommendation,
    };
  });
}

export async function handleMonitor(ctx, part, method) {
  if (!part.startsWith('/dashboard/monitor')) return null;
  const suffix = part.slice('/dashboard/monitor'.length) || '/';
  const billingVisible = canSeeBilling(ctx);

  if (suffix === '/snapshot' && method === 'GET') {
    const windowKey = normalizeWindow(ctx.search.get('window'));
    const orgId = String(ctx.search.get('orgId') || '').trim();
    const cacheKey = `${windowKey}|${orgId}|${billingVisible ? 1 : 0}`;
    const cached = snapshotCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;
    const value = await buildSnapshot({ windowKey, orgId, billingVisible });
    snapshotCache.set(cacheKey, { at: Date.now(), value });
    while (snapshotCache.size > 100) snapshotCache.delete(snapshotCache.keys().next().value);
    return value;
  }

  const classroomMatch = suffix.match(/^\/classroom\/([^/]+)$/);
  if (classroomMatch && method === 'GET') {
    return await buildClassroom(String(classroomMatch[1]));
  }

  if (suffix === '/errors' && method === 'GET') {
    const rawSince = String(ctx.search.get('since') || '').trim();
    const since = rawSince && !Number.isNaN(new Date(rawSince).getTime()) ? new Date(rawSince).toISOString() : sinceOf(15);
    const limit = Math.max(1, Math.min(200, Number(ctx.search.get('limit')) || MAX_ERRORS));
    const result = await fetchErrorRows({
      since,
      orgId: String(ctx.search.get('orgId') || '').trim(),
      sessionId: String(ctx.search.get('sessionId') || '').trim(),
      userId: String(ctx.search.get('userId') || '').trim(),
      limit,
    });
    return { generatedAt: new Date().toISOString(), since, ...result };
  }

  if (suffix === '/export' && method === 'GET') {
    if (!billingVisible) throw errors.forbidden('导出成本需要 AI 能力与价格权限', 'PERMISSION_DENIED', { permission: 'ADMIN_BILLING' });
    const hours = Math.min(168, Math.max(1, Number(ctx.search.get('hours')) || 24));
    const orgFilter = String(ctx.search.get('orgId') || '').trim();
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const rows = await arows(`SELECT a.created_at, a.org_id, o.name org_name, a.class_session_id, s.title session_title,
        a.user_id, u.display_name user_name, a.modality, a.channel_id, a.model, a.status, a.cost_source,
        a.upstream_cost_fen, COALESCE(a.error_code,'') error_code, a.task_id
      FROM compute_attempts a
      LEFT JOIN organizations o ON o.id=a.org_id
      LEFT JOIN users u ON u.id=a.user_id
      LEFT JOIN class_sessions s ON s.id=a.class_session_id
      WHERE a.created_at>=?${orgFilter ? ' AND a.org_id=?' : ''}
      ORDER BY a.created_at DESC LIMIT 20000`, orgFilter ? [since, orgFilter] : [since]);
    return {
      generatedAt: new Date().toISOString(),
      hours,
      orgId: orgFilter || null,
      rows: rows.map((row) => ({
        createdAt: row.created_at, orgId: row.org_id || null, orgName: row.org_name || null,
        sessionId: row.class_session_id || null, sessionTitle: row.session_title || null,
        userId: row.user_id || null, userName: row.user_name || null,
        modality: row.modality || null, channelId: row.channel_id || null, model: row.model || null,
        status: row.status || null, costSource: row.cost_source || null,
        costFen: row.upstream_cost_fen === null || row.upstream_cost_fen === undefined ? null : Number(row.upstream_cost_fen),
        errorCode: row.error_code || null, taskId: row.task_id || null,
      })),
    };
  }

  if (suffix === '/alerts/history' && method === 'GET') {
    if (!billingVisible) throw errors.forbidden('告警历史需要 AI 能力与价格权限', 'PERMISSION_DENIED', { permission: 'ADMIN_BILLING' });
    const hours = Math.min(168, Math.max(1, Number(ctx.search.get('hours')) || 24));
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const thresholds = await readAlertThresholds();
    const baselineRow = await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1');
    let baselinePolicy = {};
    try { baselinePolicy = JSON.parse(baselineRow?.ai_provider_policy || '{}') || {}; } catch { baselinePolicy = {}; }
    const costBaselineAt = baselinePolicy.costBaselineAt && !Number.isNaN(Date.parse(baselinePolicy.costBaselineAt))
      ? new Date(baselinePolicy.costBaselineAt).toISOString()
      : null;
    const coverageSince = costBaselineAt && costBaselineAt > since ? costBaselineAt : since;
    const [rows, walletRows] = await Promise.all([
      arows(`SELECT substr(created_at,1,16) minute, COUNT(*) calls,
          SUM(CASE WHEN status='FAILED' AND NOT(COALESCE(error_message,'') LIKE '%内容安全%' OR COALESCE(error_message,'') LIKE '%Content security%') THEN 1 ELSE 0 END) failed,
          SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) AND created_at>=? THEN 1 ELSE 0 END) unknown_calls
        FROM compute_attempts WHERE created_at>=? GROUP BY minute ORDER BY minute`, [coverageSince, since]),
      arows(`SELECT created_at, SUM(CASE WHEN ok=1 THEN cny ELSE 0 END) total, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) okn
        FROM monitor_wallet_samples WHERE created_at>=? GROUP BY created_at ORDER BY created_at`, [since]),
    ]);
    const buckets = new Map();
    for (const row of rows) {
      const key = `${String(row.minute).slice(0, 15)}0`;   // 10 分钟桶：YYYY-MM-DDTHH:M0
      const bucket = buckets.get(key) || { key, calls: 0, failed: 0, unknown: 0 };
      bucket.calls += num(row.calls);
      bucket.failed += num(row.failed);
      bucket.unknown += num(row.unknown_calls);
      buckets.set(key, bucket);
    }
    const atOf = (key) => new Date(`${key.slice(0, 16)}:00Z`).toISOString();
    const events = [];
    for (const bucket of buckets.values()) {
      const rate = pct(bucket.failed, bucket.calls);
      if (bucket.failed >= 3 && rate !== null && rate >= 5) {
        events.push({ at: atOf(bucket.key), type: 'ERROR_RATE', level: rate >= 20 ? 'danger' : 'warning', text: `渠道错误率 ${rate}%（${bucket.failed}/${bucket.calls}）` });
      }
      if (bucket.unknown >= 3) {
        events.push({ at: atOf(bucket.key), type: 'UNKNOWN_COST', level: 'warning', text: `未知成本 ${bucket.unknown} 笔（10 分钟）` });
      }
    }
    if (thresholds.balanceLow !== null) {
      for (const row of walletRows) {
        if (num(row.okn) > 0 && num(row.total) < thresholds.balanceLow) {
          events.push({ at: row.created_at, type: 'BALANCE_LOW', level: 'danger', text: `总余额 ¥${num(row.total).toFixed(2)} 低于 ¥${thresholds.balanceLow}` });
        }
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      hours,
      thresholds,
      events: events.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100),
    };
  }

  if (suffix === '/reconcile' && method === 'GET') {
    if (!billingVisible) throw errors.forbidden('对账需要 AI 能力与价格权限', 'PERMISSION_DENIED', { permission: 'ADMIN_BILLING' });
    const { day } = reconcileDayRange(ctx.search.get('day'));
    return await buildReconcile({ day });
  }

  if (suffix === '/reconcile/xkwuai' && method === 'GET') {
    if (!billingVisible) throw errors.forbidden('对账需要 AI 能力与价格权限', 'PERMISSION_DENIED', { permission: 'ADMIN_BILLING' });
    const { day, start, end } = reconcileDayRange(ctx.search.get('day'));
    const policyRow = await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1');
    let policy = {};
    try { policy = JSON.parse(policyRow?.ai_provider_policy || '{}') || {}; } catch { policy = {}; }
    const accountingStartAt = policy.accountingStartAt && !Number.isNaN(Date.parse(policy.accountingStartAt))
      ? new Date(policy.accountingStartAt).toISOString()
      : null;
    const effectiveStart = accountingStartAt && accountingStartAt > start ? accountingStartAt : start;
    const items = await fetchXkwuaiLogs(Math.floor(Date.parse(effectiveStart) / 1000), Math.floor(Date.parse(end) / 1000));
    const actualFen = Math.round(items.reduce((sum, item) => sum + (xkwuaiQuotaToFen(item.quota) || 0), 0) * 10000) / 10000;
    const byModel = new Map();
    for (const item of items) {
      const model = String(item.model_name || '—');
      const entry = byModel.get(model) || { model, logs: 0, actualFen: 0 };
      entry.logs += 1;
      entry.actualFen += xkwuaiQuotaToFen(item.quota) || 0;
      byModel.set(model, entry);
    }
    const xkwuaiChannels = (policy.channels || [])
      .filter((channel) => String(channel.endpoint || '').toLowerCase().includes('xkwuai'));
    const channelIds = xkwuaiChannels.map((channel) => channel.id);
    // 渠道 Key 是 API 令牌（sk-…），不是账号的访问令牌；它和钱包是同一个账号（2026-11-04 实测：
    // 用渠道 Key 发一条最小请求，钱包账号日志 28→29）。所以这里不能用 /api/user/self 判账号。
    // 日志只覆盖当前账号“看得见”的记录：换 Key/账号之前的历史调用不在其中，比较时以日志首条为起点。
    const firstLogAt = items.length
      ? new Date(Math.min(...items.map((item) => Number(item.created_at) * 1000))).toISOString()
      : null;
    // 账户级实付：xkwuai 钱包在当天首尾采样的差额（覆盖该账号所有调用，日志可能被上游清理）。
    const walletRows = await arows(`SELECT created_at, cny FROM monitor_wallet_samples
      WHERE source_id='xkwuai' AND ok=1 AND cny IS NOT NULL AND created_at>=? AND created_at<?
      ORDER BY created_at`, [effectiveStart, end]);
    const firstWallet = walletRows[0] || null;
    const lastWallet = walletRows[walletRows.length - 1] || null;
    const walletDeltaFen = firstWallet && lastWallet && walletRows.length >= 2
      ? Math.round((Number(firstWallet.cny) - Number(lastWallet.cny)) * 100 * 10000) / 10000
      : null;
    let ourFen = 0; let ourCalls = 0;
    let ourFenSinceLog = 0; let ourCallsSinceLog = 0;
    if (channelIds.length) {
      const row = await arow(`SELECT COUNT(*) calls,
          SUM(CASE WHEN status='SUCCESS' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) fen
        FROM compute_attempts WHERE created_at>=? AND created_at<? AND channel_id IN (${placeholders(channelIds)})`,
        [effectiveStart, end, ...channelIds]);
      ourCalls = num(row?.calls);
      ourFen = Math.round(num(row?.fen) * 10000) / 10000;
      const sinceLog = firstLogAt && firstLogAt > start ? firstLogAt : start;
      const sinceRow = await arow(`SELECT COUNT(*) calls,
          SUM(CASE WHEN status='SUCCESS' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) fen
        FROM compute_attempts WHERE created_at>=? AND created_at<? AND channel_id IN (${placeholders(channelIds)})`,
        [sinceLog, end, ...channelIds]);
      ourCallsSinceLog = num(sinceRow?.calls);
      ourFenSinceLog = Math.round(num(sinceRow?.fen) * 10000) / 10000;
    }
    return {
      generatedAt: new Date().toISOString(),
      day,
      actualFen,
      ourFen,
      diffFen: Math.round((ourFenSinceLog - actualFen) * 10000) / 10000,
      logCount: items.length,
      ourCalls,
      logFirstAt: firstLogAt,
      ourFenSinceLog,
      ourCallsSinceLog,
      walletDeltaFen,
      walletSamples: walletRows.length,
      walletFirst: firstWallet ? Number(firstWallet.cny) : null,
      walletLast: lastWallet ? Number(lastWallet.cny) : null,
      byModel: [...byModel.values()]
        .map((item) => ({ ...item, actualFen: Math.round(item.actualFen * 10000) / 10000 }))
        .sort((left, right) => right.actualFen - left.actualFen)
        .slice(0, 20),
    };
  }

  if (suffix === '/models' && method === 'GET') {
    const row = await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1');
    let policy = {};
    try { policy = JSON.parse(row?.ai_provider_policy || '{}') || {}; } catch { policy = {}; }
    return {
      generatedAt: new Date().toISOString(),
      rows: await buildModelRows(policy),
      imageQuality: normalizeImageQuality(policy.imageQuality),
      imageQualityOptions: IMAGE_QUALITY_OPTIONS,
    };
  }

  if (suffix === '/models/image-quality' && method === 'POST') {
    if (!billingVisible) throw errors.forbidden('调整图片质量需要 AI 能力与价格权限', 'PERMISSION_DENIED', { permission: 'ADMIN_BILLING' });
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const quality = String(body.quality || '').toLowerCase();
    if (!['low', 'medium', 'high'].includes(quality)) {
      throw errors.badRequest('图片质量只能是 low / medium / high', 'MONITOR_IMAGE_QUALITY_INVALID');
    }
    const stored = await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1');
    const before = stored?.ai_provider_policy || '{}';
    let policy = null;
    try { policy = JSON.parse(before); } catch { policy = null; }
    if (!policy || typeof policy !== 'object') throw errors.badRequest('渠道策略不是合法 JSON，拒绝写入', 'MONITOR_MODEL_POLICY_INVALID');
    const previous = normalizeImageQuality(policy.imageQuality);
    policy.imageQuality = quality;
    const after = JSON.stringify(policy);
    const now = new Date().toISOString();
    await aq('UPDATE platform_settings SET ai_provider_policy=?, updated_at=? WHERE id=1', [after, now]);
    invalidateGenerationProviderInfo();
    await aq(`INSERT INTO platform_config_change_logs(id,config_type,record_id,field_name,old_value,new_value,changed_by,reason,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, [
      id('ccl'), 'AI_PROVIDER_POLICY', '1', 'imageQuality', previous, quality,
      ctx.auth?.user?.id || 'monitor',
      `监控台调整官方图质量：${previous} → ${quality}`, now,
    ]);
    return { ok: true, imageQuality: quality, previous };
  }

  if (suffix === '/models/switch' && method === 'POST') {
    if (!billingVisible) throw errors.forbidden('切换模型需要 AI 能力与价格权限', 'PERMISSION_DENIED', { permission: 'ADMIN_BILLING' });
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const key = String(body.key || '').toUpperCase();
    const row = MODEL_ROWS.find((item) => item.key === key);
    if (!row) throw errors.badRequest('未知的能力', 'MONITOR_MODEL_KEY_INVALID');
    const stored = await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1');
    const before = stored?.ai_provider_policy || '{}';
    let policy = null;
    try { policy = JSON.parse(before); } catch { policy = null; }
    if (!policy || typeof policy !== 'object') throw errors.badRequest('渠道策略不是合法 JSON，拒绝写入', 'MONITOR_MODEL_POLICY_INVALID');
    const channelId = String(body.channelId || '').trim();
    const channel = (Array.isArray(policy.channels) ? policy.channels : []).find((item) => item.id === channelId);
    if (!channel) throw errors.badRequest('渠道不存在', 'MONITOR_MODEL_CHANNEL_INVALID');
    const options = candidateChannels(policy, row);
    if (!options.some((option) => option.channelId === channelId)) {
      throw errors.badRequest('这个渠道不能服务该能力', 'MONITOR_MODEL_CHANNEL_INVALID');
    }
    const model = String(body.model || channel.model || '').trim();
    const channelModels = [...(channel.models || []), channel.model].filter(Boolean);
    if (model && !channelModels.includes(model)) throw errors.badRequest('模型不属于该渠道', 'MONITOR_MODEL_INVALID');
    const oldChannelId = currentChannelId(policy, row);
    if (model && channel.model !== model) channel.model = model;
    policy.modalityChannels = { ...(policy.modalityChannels || {}) };
    if (row.key === 'IMAGE_T2I') {
      policy.modalityChannels.IMAGE = channelId;
      policy.imageModeChannels = { ...(policy.imageModeChannels || {}), TEXT: channelId };
    } else if (row.key === 'IMAGE_I2I') {
      policy.imageModeChannels = { ...(policy.imageModeChannels || {}), IMAGE_REFERENCE: channelId };
    } else {
      policy.modalityChannels[row.modality] = channelId;
    }
    const after = JSON.stringify(policy);
    const now = new Date().toISOString();
    await aq('UPDATE platform_settings SET ai_provider_policy=?, updated_at=? WHERE id=1', [after, now]);
    invalidateGenerationProviderInfo();
    await aq(`INSERT INTO platform_config_change_logs(id,config_type,record_id,field_name,old_value,new_value,changed_by,reason,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, [
      id('ccl'), 'AI_PROVIDER_POLICY', '1', 'aiProviderPolicy', before, after,
      ctx.auth?.user?.id || 'monitor',
      `监控台切换模型：${row.label} ${oldChannelId || '未配置'} → ${channelId} · ${model}`, now,
    ]);
    return { ok: true, key: row.key, channelId, channelName: channel.name || channelId, model };
  }

  if (suffix === '/balance/history' && method === 'GET') {
    if (!billingVisible) throw errors.forbidden('余额属于 AI 能力与价格权限范围', 'PERMISSION_DENIED', { permission: 'ADMIN_BILLING' });
    return await getWalletHistory({ hours: ctx.search.get('hours') });
  }

  if (suffix === '/balance' && method === 'GET') {
    if (!billingVisible) throw errors.forbidden('余额属于 AI 能力与价格权限范围', 'PERMISSION_DENIED', { permission: 'ADMIN_BILLING' });
    const refresh = ctx.search.get('refresh') === '1';
    const runningHub = await getRunningHubBalance({ refresh });
    // 原有字段保持不变（前端 KPI / 守卫都依赖 accounts）；新增 wallets 汇总三家供应商。
    return { ...runningHub, wallets: await getWalletBalances({ refresh, runningHub }) };
  }

  return null;
}
