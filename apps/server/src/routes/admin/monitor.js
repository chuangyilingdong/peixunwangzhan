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
import { arow, arows, errors, isRootPlatformAdmin } from '../../lib.js';
import { classroomBudgetStatus } from '../../services/computePool.js';
import { getRunningHubBalance } from '../../services/runningHubAccount.js';

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

async function buildSnapshot({ windowKey, orgId, billingVisible }) {
  const minutes = WINDOWS[windowKey];
  const since = sinceOf(minutes);
  const seriesSince = sinceOf(60);
  const orgFilter = String(orgId || '').trim();

  const [live, usageWindow, attemptsWindow, seriesRows, orgRows, orgStats, sessionRows] = await Promise.all([
    arow(`SELECT
        (SELECT COUNT(*) FROM class_sessions WHERE status='ACTIVE') active_sessions,
        (SELECT COUNT(*) FROM session_students WHERE status='ACTIVE') active_students,
        (SELECT COUNT(*) FROM compute_attempts WHERE status IN ('RUNNING','SUBMITTED')) running_attempts,
        (SELECT COUNT(*) FROM generation_jobs WHERE status='QUEUED') queued_jobs,
        (SELECT COUNT(*) FROM generation_jobs WHERE status='RUNNING') running_jobs`),
    arow(`SELECT COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='BLOCKED' THEN 1 ELSE 0 END) blocked
      FROM usage_records WHERE created_at>=?`, [since]),
    arow(`SELECT COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='SUCCESS' THEN COALESCE(sale_price_fen,0) ELSE 0 END) sale_fen,
        SUM(CASE WHEN status='SUCCESS' AND cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) known_cost_fen,
        SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_cost_calls
      FROM compute_attempts WHERE created_at>=?`, [since]),
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
    arows(`SELECT s.id, s.org_id, s.title, s.teacher_id, s.lesson_id, s.series_id, s.started_at, s.platform_budget_fen,
        o.name org_name, u.display_name teacher_name, l.title lesson_title,
        (SELECT COUNT(*) FROM session_students ss WHERE ss.session_id=s.id AND ss.status<>'REMOVED') roster,
        (SELECT COUNT(*) FROM session_students ss WHERE ss.session_id=s.id AND ss.status='ACTIVE') active_students
      FROM class_sessions s
      LEFT JOIN organizations o ON o.id=s.org_id
      LEFT JOIN users u ON u.id=s.teacher_id
      LEFT JOIN course_lessons l ON l.id=s.lesson_id
      WHERE s.status='ACTIVE' AND (?='' OR s.org_id=?)
      ORDER BY s.started_at DESC LIMIT ?`, [orgFilter, orgFilter, MAX_SESSIONS]),
  ]);

  const sessionIds = sessionRows.map((row) => row.id);
  const [sessionStats, sessionAllTime] = sessionIds.length ? await Promise.all([
    arows(`SELECT class_session_id, COUNT(*) calls,
        SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) success,
        SUM(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='SUCCESS' THEN COALESCE(sale_price_fen,0) ELSE 0 END) sale_fen,
        SUM(CASE WHEN status='SUCCESS' AND cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) known_cost_fen,
        SUM(CASE WHEN status='SUCCESS' AND (cost_source='UNKNOWN' OR upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_cost_calls
      FROM compute_attempts WHERE created_at>=? AND class_session_id IN (${placeholders(sessionIds)}) GROUP BY class_session_id`, [since, ...sessionIds]),
    arows(`SELECT class_session_id,
        SUM(CASE WHEN cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) known_all,
        SUM(CASE WHEN cost_source='UNKNOWN' OR upstream_cost_fen IS NULL THEN 1 ELSE 0 END) unknown_all
      FROM compute_attempts WHERE class_session_id IN (${placeholders(sessionIds)}) GROUP BY class_session_id`, sessionIds),
  ]) : [[], []];

  const statsBySession = new Map(sessionStats.map((row) => [row.class_session_id, row]));
  const allTimeBySession = new Map(sessionAllTime.map((row) => [row.class_session_id, row]));
  const statsByOrg = new Map(orgStats.map((row) => [row.org_id, row]));

  const sessions = sessionRows.map((row) => {
    const stats = statsBySession.get(row.id) || {};
    const allTime = allTimeBySession.get(row.id) || {};
    const budgetFen = row.platform_budget_fen === null || row.platform_budget_fen === undefined ? null : Number(row.platform_budget_fen);
    const knownAll = num(allTime.known_all);
    const unknownAll = num(allTime.unknown_all);
    const budgetState = budgetFen === null || !Number.isFinite(budgetFen)
      ? (unknownAll ? 'UNKNOWN' : 'UNCONFIGURED')
      : knownAll > budgetFen ? 'OVER_BUDGET' : (unknownAll ? 'UNKNOWN' : 'WITHIN_BUDGET');
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
      budget: {
        state: budgetState,
        budgetFen: Number.isFinite(budgetFen) ? budgetFen : null,
        ...(billingVisible ? { knownCostFen: knownAll, unknownCalls: unknownAll } : {}),
      },
    };
  });

  const orgs = orgRows.map((row) => {
    const stats = statsByOrg.get(row.id) || {};
    return {
      id: row.id, name: row.name, status: row.status,
      teachers: num(row.teachers), students: num(row.students),
      activeSessions: num(row.active_sessions),
      calls: num(stats.calls), success: num(stats.success), failed: num(stats.failed),
      ...(billingVisible ? {
        saleFen: num(stats.sale_fen), knownCostFen: num(stats.known_cost_fen),
      } : {}),
    };
  });

  // 序列补齐 60 个分钟桶（上游没有调用的分钟补 0，图表才不会跳）
  const byMinute = new Map(seriesRows.map((row) => [String(row.minute), row]));
  const series = [];
  for (let index = 59; index >= 0; index -= 1) {
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
  const errorsResult = await fetchErrorRows({ since, orgId: orgFilter, limit: MAX_ERRORS });

  return {
    generatedAt: new Date().toISOString(),
    window: windowKey,
    since,
    until: new Date().toISOString(),
    timezone: 'UTC',
    live: {
      activeSessions: num(live?.active_sessions),
      activeStudents: num(live?.active_students),
      runningAttempts: num(live?.running_attempts),
      queuedJobs: num(live?.queued_jobs),
      runningJobs: num(live?.running_jobs),
    },
    usage: {
      calls: num(attempts.calls),
      success: num(attempts.success),
      failed: num(attempts.failed),
      blocked: num(usage.blocked),
      errorRate: pct(num(attempts.failed), num(attempts.success) + num(attempts.failed)),
      ...(billingVisible ? {
        saleFen: num(attempts.sale_fen),
        knownCostFen: num(attempts.known_cost_fen),
        unknownCostCalls: num(attempts.unknown_cost_calls),
      } : {}),
    },
    series,
    orgs,
    sessions,
    errors: errorsResult.items,
    errorTop: errorsResult.top,
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

  const [roster, stats, recentErrors, budget] = await Promise.all([
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
    classroomBudgetStatus(sessionId),
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
    budget,
    errors: recentErrors.items,
    errorTop: recentErrors.top,
  };
}

// ── 路由 ────────────────────────────────────────────────────────────────────

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

  if (suffix === '/balance' && method === 'GET') {
    if (!billingVisible) throw errors.forbidden('余额属于 AI 能力与价格权限范围', 'PERMISSION_DENIED', { permission: 'ADMIN_BILLING' });
    return await getRunningHubBalance({ refresh: ctx.search.get('refresh') === '1' });
  }

  return null;
}
