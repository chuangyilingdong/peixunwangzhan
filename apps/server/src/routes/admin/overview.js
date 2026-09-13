// 平台管理端「overview」域路由：从 adminOrg.js 拆出，行为不变。
import { clearGatewayRouteCache, createGatewayToken, gatewayUsageOverview, getComputeGatewayConfig, listGatewayChannels, listGatewayTokens, saveComputeGatewayConfig, testComputeGateway } from '../../services/computeGateway.js';
import { budgetedSeriesOverview, computePoolReconciliation, computePoolReport, getComputePricing, saveComputePricing } from '../../services/computePool.js';
import {
  audit, count, errors, id, json, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  assignmentActiveSql, PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction, verifyPassword,
} from '../../lib.js';
import { hashPassword } from '@platform/database';
import { randomUUID } from 'node:crypto';
import { scheduleReminder } from '../communication.js';
import { assertKnownState, assertTransition } from '../../services/domainState.js';
import { getAiProviderPolicy } from '../billingConfig.js';
import { analyticsOverview } from '../analytics.js';
import { effectiveCapabilities, normalizeAspectRatio } from '../../services/modelCapabilities.js';
import { disableMfa, enableMfa, mfaSummary, regenerateRecoveryCodes, startMfaSetup } from '../../services/mfa.js';
import { normalizeSubmission } from '../vibecoding.js';
import {
  ENROLLMENT_STATUSES,
  ORG_MEMBER_ROLES,
  ORG_TEACHER_PERMISSIONS,
  PAYMENT_STATUSES,
  accessibleLesson,
  accessibleSeries,
  annotationRows,
  appendEnrollmentEvent,
  assertAnnotationNode,
  assertEnrollmentSeat,
  assertNotLastOrgAdmin,
  assertSelfPassword,
  auditListQuery,
  auditQuery,
  auditRow,
  buildOrganizationDetail,
  buildStudentDataExport,
  bumpSeriesVersion,
  contactPayload,
  createMember,
  csvDocument,
  csvFileName,
  enrollmentDate,
  enrollmentRow,
  ensureOrgBilling,
  escapeCsv,
  expireDueEnrollments,
  hasAnyPlatformPermission,
  hasPermission,
  importItems,
  integer,
  lastSuperAdminGuard,
  normalizeCanvasTemplateSnapshot,
  normalizeClassroomConfig,
  normalizeDeliveryMode,
  normalizeEnrollment,
  normalizeWorkPublishRequest,
  occupiedStudentSeats,
  orgAdminRows,
  orgContractMeta,
  orgId,
  orgMemberRow,
  orgUser,
  organizationFilters,
  organizationRow,
  packageSnapshot,
  packageWithSeatUsage,
  platformAdminPermissions,
  platformIssuerName,
  platformUserFilters,
  platformUserRow,
  platformWorkFilters,
  previewImport,
  replaceLessonCanvasConfig,
  replaceLessonTeachingMaterials,
  reportResolution,
  setStudentEnrollmentAccess,
  softDeleteStudent,
  userLoginMeta,
  validateImportItem,
  validateMemberPermissions,
  validateMemberPhone,
  validateSeriesForPublishing,
  validateTeacher,
  workInReviewScope,
  workReportInReviewScope,
  workReportRows,
} from './helpers.js';

export async function handleOverview(ctx, part, method) {
  // ── 算力网关（new-api）：配置 / 测连 / 渠道 / 令牌分发 ──────────────────────
  if (part === '/compute-gateway' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { config: getComputeGatewayConfig() };
  }
  if (part === '/compute-gateway' && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const config = saveComputeGatewayConfig(ctx.body || {}, { password: ctx.body?.password });
    // 路由缓存里存着「哪个学生用哪张令牌」，改完配置立刻失效 ——
    // 否则 60 秒内还在用旧地址/旧令牌，表现就是「改了没生效」。
    clearGatewayRouteCache();
    audit(ctx, 'COMPUTE_GATEWAY_UPDATE', 'PLATFORM_SETTING', 'compute_gateway', null, { baseUrl: config.baseUrl, username: config.username, enabled: config.enabled, passwordChanged: Boolean(ctx.body?.password) });
    return { config };
  }
  if (part === '/compute-gateway/test' && method === 'POST') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return testComputeGateway();
  }
  if (part === '/compute-gateway/usage' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const days = integer(ctx.search.get('days'), '统计天数', { min: 1, max: 90, fallback: 7 });
    return gatewayUsageOverview({ days });
  }
  // 算力单价（每次调用预估单价，用于折算池子消耗）+ 池子（学生 × 课包）的用量报表
  if (part === '/compute-pricing' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { pricing: getComputePricing() };
  }
  if (part === '/compute-pricing' && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const pricing = saveComputePricing(ctx.body || {});
    audit(ctx, 'COMPUTE_PRICING_UPDATE', 'PLATFORM_SETTING', 'compute_pricing', null, { perCall: pricing.perCall, modelCount: Object.keys(pricing.models).length });
    return { pricing };
  }
  if (part === '/compute-pools' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 500, fallback: 100 });
    return { items: computePoolReport({ limit }), pricing: getComputePricing(), budgetedSeries: budgetedSeriesOverview({ limit: 50 }) };
  }
  // 对账：池子账（应用侧，四种模态、按单价折算）vs 网关账（精确，只含对话/图片）
  if (part === '/compute-pools/reconciliation' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const days = integer(ctx.search.get('days'), '统计天数', { min: 1, max: 90, fallback: 7 });
    return computePoolReconciliation({ days });
  }
  if (part === '/compute-gateway/channels' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { items: await listGatewayChannels() };
  }
  if (part === '/compute-gateway/tokens' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { items: await listGatewayTokens() };
  }
  if (part === '/compute-gateway/tokens' && method === 'POST') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const result = await createGatewayToken({
      name: ctx.body?.name,
      budgetFen: integer(ctx.body?.budgetFen, '额度（分）', { min: 0, max: 1000000000, fallback: 0 }),
      models: String(ctx.body?.models || '').trim(),
      unlimited: ctx.body?.unlimited === true,
    });
    // 刚发的令牌要能立刻被学生用上，别等 60 秒缓存过期。
    clearGatewayRouteCache();
    audit(ctx, 'COMPUTE_GATEWAY_TOKEN_CREATE', 'PLATFORM_SETTING', 'compute_gateway', null, { name: String(ctx.body?.name || ''), budgetFen: Number(ctx.body?.budgetFen || 0), unlimited: ctx.body?.unlimited === true });
    return result;
  }

  if (part === '/dashboard/overview' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const orgFilter = String(ctx.search.get('orgId') || '').trim();
    const fromProvided = ctx.search.has('from'); const from = fromProvided ? String(ctx.search.get('from') || '').trim() : '';
    const toProvided = ctx.search.has('to'); const to = toProvided ? String(ctx.search.get('to') || '').trim() : '';
    if (orgFilter && !row('SELECT id FROM organizations WHERE id=?', [orgFilter])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    const fromTime = from ? new Date(from) : null;
    const toTime = to ? new Date(to) : null;
    if (fromProvided && (!from || !fromTime || Number.isNaN(fromTime.getTime()) || fromTime.toISOString() !== from)) throw errors.badRequest('开始时间必须是有效 ISO 时间', 'INVALID_FROM');
    if (toProvided && (!to || !toTime || Number.isNaN(toTime.getTime()) || toTime.toISOString() !== to)) throw errors.badRequest('结束时间必须是有效 ISO 时间', 'INVALID_TO');
    if (fromTime && toTime && fromTime >= toTime) throw errors.badRequest('开始时间必须早于结束时间', 'INVALID_TIME_RANGE');
    const upperTime = toTime || new Date();
    const lowerTime = fromTime || new Date(upperTime.getTime() - 29 * 86400000);
    const since = lowerTime.toISOString();
    const until = upperTime.toISOString();
    const scoped = (table) => {
      const conditions = [`${table}.created_at>=?`, `${table}.created_at<?`];
      const params = [since, until];
      if (orgFilter) { conditions.push(`${table}.org_id=?`); params.push(orgFilter); }
      return { where: conditions.join(' AND '), params };
    };
    const singleNumber = (sql, params = []) => Number(row(sql, params)?.n || 0);
    const organizations = singleNumber("SELECT COUNT(*) n FROM organizations WHERE (?='' OR id=?)", [orgFilter, orgFilter]);
    const activeOrganizations = singleNumber("SELECT COUNT(*) n FROM organizations WHERE (?='' OR id=?) AND status IN ('TRIAL','ACTIVE')", [orgFilter, orgFilter]);
    const orgScope = orgFilter ? rows('SELECT id,name,status FROM organizations WHERE id=?', [orgFilter]) : rows('SELECT id,name,status FROM organizations');
    const orgIds = orgScope.map((item) => item.id);
    const usersScope = orgFilter ? "org_id=?" : "org_id IS NOT NULL";
    const usersParams = orgFilter ? [orgFilter] : [];
    const teachers = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='TEACHER' AND deleted_at IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>?)`, [...usersParams, nowIso()]);
    const students = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='STUDENT' AND deleted_at IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>?)`, [...usersParams, nowIso()]);
    const admins = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='ORG_ADMIN' AND deleted_at IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>?)`, [...usersParams, nowIso()]);
    const classes = singleNumber(`SELECT COUNT(*) n FROM classes WHERE (?='' OR org_id=?) AND status='ACTIVE'`, [orgFilter, orgFilter]);
    const publishedCourses = singleNumber(`SELECT COUNT(*) n FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED'`);
    const activeAssignments = singleNumber(`SELECT COUNT(*) n FROM course_assignments assignment WHERE ${assignmentActiveSql()} AND (?='' OR org_id=?)`, [orgFilter, orgFilter]);
    const marketplaceCourses = singleNumber(`SELECT COUNT(*) n FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED' AND marketplace_status='APPROVED'`);
    const classSessions = singleNumber(`SELECT COUNT(*) n FROM class_sessions session JOIN classes class ON class.id=session.class_id WHERE (LENGTH(?)=0 OR class.org_id=?) AND session.started_at>=? AND session.started_at<?`, [orgFilter, orgFilter, since, until]);
    const projects = singleNumber(`SELECT COUNT(*) n FROM student_projects WHERE (?='' OR org_id=?) AND created_at>=? AND created_at<?`, [orgFilter, orgFilter, since, until]);
    const works = singleNumber(`SELECT COUNT(*) n FROM works WHERE (?='' OR org_id=?) AND submitted_at>=? AND submitted_at<?`, [orgFilter, orgFilter, since, until]);
    // ── B4 统计指标细化：新增口径都写明来源，免得「这个数从哪来的」说不清 ──
    const newStudents = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='STUDENT' AND deleted_at IS NULL AND created_at>=? AND created_at<?`, [...usersParams, since, until]);
    const activeStudents = singleNumber("SELECT COUNT(DISTINCT student_id) n FROM student_projects WHERE (?='' OR org_id=?) AND created_at>=? AND created_at<?", [orgFilter, orgFilter, since, until]);
    const lessonCompletions = singleNumber(`SELECT COUNT(*) n FROM student_lesson_progress progress WHERE (?='' OR progress.org_id=?) AND progress.status='COMPLETED' AND progress.completed_at>=? AND progress.completed_at<?`, [orgFilter, orgFilter, since, until]);
    // B5 官网转化漏斗并进统计板块：**复用** analyticsOverview（与「转化分析」同一个实现，口径只此一处）
    // B5 官网转化漏斗并进统计板块：**复用** analyticsOverview（与「转化分析」同一个实现，口径只此一处）。
    // ⚠️ 它收的是 URLSearchParams（内部用 search.get）：传普通对象会当场 TypeError ——
    //    所以下面 catch 里必须打日志，静默降级成空漏斗正是交接说明里那类最难查的失败。
    const siteFunnel = (() => {
      try {
        const report = analyticsOverview(new URLSearchParams({ from: since, to: until }));
        return { totals: report.totals, funnel: report.funnel, byEvent: report.byEvent, retentionDays: report.retentionDays };
      } catch (error) {
        console.error('[DASHBOARD SITE FUNNEL] 官网漏斗读取失败，本次按空漏斗返回：', error?.message || error);
        return { totals: { events: 0, visitors: 0 }, funnel: [], byEvent: [], retentionDays: 0 };
      }
    })();
    const usage = scoped('usage_records');
    const usageTotal = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where}`, usage.params);
    const usageSuccess = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='SUCCESS'`, usage.params);
    const usageFailed = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='FAILED'`, usage.params);
    const usageBlocked = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='BLOCKED'`, usage.params);
    const abnormalTasks = usageFailed + usageBlocked;
    const aiTasks = singleNumber(`SELECT COUNT(*) n FROM generation_jobs WHERE ${scoped('generation_jobs').where}`, scoped('generation_jobs').params);
    // 2026-09-13（P4 删积分）：byOrg / byModality 从「积分」改成算力金额（分）——与算力层同一份账本。
    const byOrg = rows(`SELECT organization.id,organization.name,COALESCE(SUM(usage.cost_fen),0) fen,COUNT(usage.id) calls
      FROM organizations organization LEFT JOIN usage_records usage ON usage.org_id=organization.id AND usage.created_at>=? AND usage.created_at<?
      ${orgFilter ? 'WHERE organization.id=?' : ''} GROUP BY organization.id ORDER BY fen DESC,organization.name ASC LIMIT 10`, orgFilter ? [since, until, orgFilter] : [since, until]).map((item) => ({ id: item.id, name: item.name, costFen: Number(item.fen || 0), calls: Number(item.calls || 0) }));
    const byModality = rows(`SELECT modality,COUNT(*) calls,COALESCE(SUM(cost_fen),0) fen,COUNT(CASE WHEN status='SUCCESS' THEN 1 END) successCalls,COUNT(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 END) abnormalCalls
      FROM usage_records WHERE ${usage.where} GROUP BY modality ORDER BY fen DESC,modality ASC`, usage.params).map((item) => ({ modality: item.modality, calls: Number(item.calls || 0), costFen: Number(item.fen || 0), successCalls: Number(item.success_calls ?? item.successCalls ?? 0), abnormalCalls: Number(item.abnormal_calls ?? item.abnormalCalls ?? 0) }));
    // ── 统计：算力层（单位是「元」，来自应用侧算力池账本 —— 与「算力网关」页同一份数据）──
    // 为什么不再用 credits：积分已废弃（2026-09-13 P4），钱一律看算力池账本 cost_fen。
    // 这里直接给「花了多少钱、花在哪个模态上、哪个池子快满了」。
    const computeWhere = `record.created_at>=? AND record.created_at<? AND record.series_id IS NOT NULL${orgFilter ? ' AND record.org_id=?' : ''}`;
    const computeParams = orgFilter ? [since, until, orgFilter] : [since, until];
    const computeTotals = row(`SELECT COALESCE(SUM(record.cost_fen),0) fen, COUNT(*) calls,
        SUM(CASE WHEN record.status='SUCCESS' THEN 1 ELSE 0 END) successCalls
      FROM usage_records record WHERE ${computeWhere}`, computeParams);
    const computeByModality = rows(`SELECT record.modality, COALESCE(SUM(record.cost_fen),0) fen, COUNT(*) calls
      FROM usage_records record WHERE ${computeWhere} GROUP BY record.modality ORDER BY fen DESC`, computeParams);
    // 池子健康度是**存量口径**（不随筛选时间变化）：有消耗的池子里，多少接近上限、多少已用尽。
    // 复用算力网关页那份报表（computePoolReport），避免两处各算一套。
    const poolRows = computePoolReport({ limit: 500 });
    const pools = {
      counted: poolRows.length,
      unlimited: poolRows.filter((item) => item.unlimited).length,
      nearLimit: poolRows.filter((item) => item.usagePercent != null && item.usagePercent >= 80 && item.usagePercent < 100).length,
      exhausted: poolRows.filter((item) => item.usagePercent != null && item.usagePercent >= 100).length,
      usedYuan: Number(poolRows.reduce((total, item) => total + Number(item.usedYuan || 0), 0).toFixed(2)),
    };
    const computeTopStudents = poolRows.slice(0, 5).map((item) => ({ studentName: item.studentName, orgName: item.orgName, seriesTitle: item.seriesTitle, usedYuan: item.usedYuan, usagePercent: item.usagePercent, unlimited: item.unlimited }));

    // ── 统计：内容层（课包/课时的使用热度 + 作品发布情况）──
    const lessonHot = rows(`SELECT lesson.id, lesson.title, series.title AS series_title, COUNT(session.id) AS sessions
        FROM course_lessons lesson
        JOIN course_series series ON series.id = lesson.series_id
        LEFT JOIN class_sessions session ON session.lesson_id = lesson.id AND session.started_at>=? AND session.started_at<?
       WHERE series.owner_type='PLATFORM'
       GROUP BY lesson.id HAVING sessions > 0 ORDER BY sessions DESC, lesson.sort ASC LIMIT 5`, [since, until]).map((item) => ({ id: item.id, title: item.title, seriesTitle: item.series_title, sessions: Number(item.sessions || 0) }));
    // 作品发布：两条链路（画布 works / VibeCoding submissions）合并计数 —— 与用户看到的「一套状态话术」同口径
    const submittedWorks = singleNumber(`SELECT (SELECT COUNT(*) FROM works WHERE submitted_at>=? AND submitted_at<?) + (SELECT COUNT(*) FROM vibecoding_submissions WHERE submitted_at>=? AND submitted_at<?) n`, [since, until, since, until]);
    const content = {
      lessonHot,
      submittedWorks,
      // 在广场上 = 两条链路各自的 is_public（与 worksState 的判据一致）
      onPlaza: singleNumber("SELECT (SELECT COUNT(*) FROM works WHERE is_public=1) + (SELECT COUNT(*) FROM vibecoding_submissions WHERE is_public=1) n"),
      featured: singleNumber("SELECT (SELECT COUNT(*) FROM works WHERE featured_at IS NOT NULL) + (SELECT COUNT(*) FROM vibecoding_submissions WHERE featured_at IS NOT NULL) n"),
      // 2026-09-13（C2）：画布链路数**独立状态** UNPUBLISHED（以前数 teacher_comment，会把「未通过」也算成已下架）
      unpublished: singleNumber("SELECT (SELECT COUNT(*) FROM works WHERE status='UNPUBLISHED') + (SELECT COUNT(*) FROM vibecoding_submissions WHERE is_public=0 AND unpublish_reason IS NOT NULL AND unpublish_reason<>'') n"),
      lessonsPublished: singleNumber("SELECT COUNT(*) n FROM course_lessons WHERE status='PUBLISHED'"),
    };

    return {
      metrics: {
        organizations, activeOrganizations, admins, teachers, students,
        publishedCourses, activeAssignments, activeClasses: classes, classSessions, projects, works,
        aiTasks, abnormalTasks, usageCalls: usageTotal, successfulCalls: usageSuccess, failedCalls: usageFailed, blockedCalls: usageBlocked,
        newStudents, activeStudents, lessonCompletions,
      },
      site: siteFunnel,
      byOrg, byModality,
      compute: {
        totalYuan: Number((Number(computeTotals?.fen || 0) / 100).toFixed(2)),
        calls: Number(computeTotals?.calls || 0),
        successCalls: Number(computeTotals?.successCalls || 0),
        byModality: computeByModality.map((item) => ({ modality: item.modality, yuan: Number((Number(item.fen || 0) / 100).toFixed(2)), calls: Number(item.calls || 0) })),
        pools, topStudents: computeTopStudents,
      },
      content,
      filters: { orgId: orgFilter || null, from: since, to: until },
      meta: {
        generatedAt: nowIso(), timezone: 'UTC', dataSource: 'local SQLite', version: 'P4-A01',
        metricDefinitions: {
          organizations: '机构总数；orgId 筛选后为 1。',
          activeOrganizations: "状态为 TRIAL 或 ACTIVE 的机构，不含 FROZEN/DISABLED/EXPIRED。",
          admins: '未删除、未禁用且未过期的机构管理员数量。',
          teachers: '未删除、未禁用且未过期的机构教师数量。',
          students: '未删除、未禁用且未过期的机构学生数量。',
          publishedCourses: '平台已发布课程系列数；不受机构筛选影响。',
          activeAssignments: 'ACTIVE 状态课程授权数。',
          activeClasses: '历史班级数（存量）。班级已退场，此数不再变化，仅作历史对照 —— 要看课堂看 classSessions。',
          classSessions: '查询时间内启动的课堂场次。',
          projects: '查询时间内创建的项目数。',
          works: '查询时间内提交的作品数。',
          aiTasks: '查询时间内创建的生成任务数。',
          abnormalTasks: '查询时间内 usage_records 中状态为 FAILED 或 BLOCKED 的调用次数。',
          newStudents: '查询时间内新建的学生账号（deleted_at IS NULL，含已停用）。',
          activeStudents: '查询时间内创建过项目的学生数（按学生去重）。',
          lessonCompletions: '查询时间内被标记为已完成的课时进度数。',
          'site.funnel': '官网转化漏斗（第一方匿名埋点，仅在访客同意后记录）：访客 → 课程广场 → 课程详情 → 提交预约；与统计板块同一个实现。',
          'site.totals': '区间内匿名事件总量与去重访客数。',
          'byOrg': '按机构统计的算力消耗（分）与调用次数 Top 10。',
          'byModality': '按模态统计的算力消耗（分）与调用次数；含视频与音乐。',
          'compute.totalYuan': '查询时间内算力池账本的消耗合计（元）：对话/图片/视频/音乐四种模态之和；含视频与音乐。',
          'compute.pools': '算力池健康度，**存量口径**：有消耗的池子里多少接近上限(≥80%)、多少已用尽(≥100%)；不限预算的池子单列。',
          'content.lessonHot': '查询时间内开过的课堂场次最多的课时 Top 5。',
          'content.onPlaza': '当前在作品广场上的作品数（两条链路 is_public 之和）。',
        },
        boundary: 'from/to 均为左闭右开 UTC ISO 时间；未传时默认最近 30 天；机构与用户统计不按时间过滤。',
      },
    };
  }
  if (part === '/billing/usage-overview' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    // 2026-09-13（P4 删积分）：从「机构积分余额」换成「平台算力消耗（元）」。
    const totals = row('SELECT COALESCE(SUM(cost_fen),0) fen, COUNT(*) calls FROM usage_records');
    return {
      totalFen: Number(totals?.fen || 0), calls: Number(totals?.calls || 0),
      usage: rows('SELECT modality,SUM(cost_fen) costFen,COUNT(*) calls FROM usage_records GROUP BY modality ORDER BY costFen DESC'),
      topOrgs: rows('SELECT organization.id,organization.name,COALESCE(SUM(usage.cost_fen),0) costFen FROM organizations organization LEFT JOIN usage_records usage ON usage.org_id=organization.id GROUP BY organization.id ORDER BY costFen DESC LIMIT 10'),
    };
  }
  if (part === '/billing/usage-records' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '每页数量', { min: 1, max: 100, fallback: 20 });
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const orgFilter = ctx.search.get('orgId'); const modality = ctx.search.get('modality'); const status = ctx.search.get('status'); const search = String(ctx.search.get('search') || '').trim();
    const startDate = String(ctx.search.get('startDate') || '').trim(); const endDate = String(ctx.search.get('endDate') || '').trim();
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw errors.badRequest('开始日期格式无效', 'INVALID_START_DATE');
    if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw errors.badRequest('结束日期格式无效', 'INVALID_END_DATE');
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const conditions = ['usage.created_at>=?']; const params = [since];
    if (startDate) { conditions.push('usage.created_at>=?'); params.push(startDate + 'T00:00:00.000Z'); }
    if (endDate) { conditions.push('usage.created_at<=?'); params.push(endDate + 'T23:59:59.999Z'); }
    if (orgFilter) { conditions.push('usage.org_id=?'); params.push(orgFilter); }
    if (modality) { conditions.push('usage.modality=?'); params.push(modality); }
    if (['SUCCESS', 'FAILED', 'BLOCKED'].includes(status)) { conditions.push('usage.status=?'); params.push(status); }
    if (search) {
      conditions.push('(organization.name LIKE ? OR user.login LIKE ? OR user.display_name LIKE ? OR project.title LIKE ? OR work.title LIKE ?)');
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      params.push(keyword, keyword, keyword, keyword, keyword);
    }
    const sortKey = String(ctx.search.get('sort') || 'created').trim();
    const sort = Object.hasOwn({ created: true, costFen: true }, sortKey) ? sortKey : 'created';
    const orderBy = sort === 'costFen' ? 'usage.cost_fen DESC,usage.created_at DESC,usage.id DESC' : 'usage.created_at DESC,usage.id DESC';
    const where = conditions.join(' AND ');
    const countFromWhere = `FROM usage_records usage JOIN organizations organization ON organization.id=usage.org_id LEFT JOIN users user ON user.id=usage.user_id AND user.org_id=usage.org_id LEFT JOIN student_projects project ON project.id=usage.project_id LEFT JOIN works work ON work.id=usage.work_id ${where ? 'WHERE ' + where : ''}`;
    const total = Number(row(`SELECT COUNT(*) n ${countFromWhere}`, params)?.n || 0);
    const offset = (page - 1) * limit;
    const items = rows(
      `SELECT usage.*,organization.name organization_name,user.login user_login,user.display_name user_name,project.title project_title,work.title work_title,session.id session_id,session.lesson_id session_lesson_id,class.id class_id,class.name class_name FROM usage_records usage JOIN organizations organization ON organization.id=usage.org_id LEFT JOIN users user ON user.id=usage.user_id AND user.org_id=usage.org_id LEFT JOIN student_projects project ON project.id=usage.project_id LEFT JOIN works work ON work.id=usage.work_id LEFT JOIN class_sessions session ON session.id=usage.class_session_id LEFT JOIN classes class ON class.id=session.class_id ${where ? 'WHERE ' + where : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((item) => ({
      id: item.id, orgId: item.org_id, organizationName: item.organization_name || null,
      userId: item.user_id, userLogin: item.user_login || null, userName: item.user_name || null,
      classSessionId: item.class_session_id || null, classId: item.class_id || null, className: item.class_name || null,
      lessonId: item.session_lesson_id || item.lesson_id || null, projectId: item.project_id || null, projectTitle: item.project_title || null,
      workId: item.work_id || null, workTitle: item.work_title || null, modality: item.modality, model: item.model,
      costFen: Number(item.cost_fen || 0),
      // C3 前置：上游返回过就带上（多数多模态接口不返回，所以允许为 0）
      inputTokens: Number(item.input_tokens || 0), outputTokens: Number(item.output_tokens || 0),
      status: item.status, failCode: item.fail_code || null, createdAt: item.created_at,
    }));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }

  /**
   * 「机构 → 学生」消耗下钻（2026-09-13，用户要的「平台能看到所有机构和下面学生的消耗」）。
   *
   * 归属来自算力池账本 usage_records 的 org_id + user_id —— **不需要给学生发 API key**：
   * 学生不是拿 key 直连上游，而是经我们的后端调用，后端从登录会话就知道是谁在调。
   * 所以只要机构/学员存在，归属天然成立（新机构、新学员都不用做任何「分发」动作）。
   *
   * 返回两块：orgs（所有机构，含零消耗的，便于一眼看出「谁还没用过」）与
   * students（**选中机构**下每个学员的汇总）。days 用左闭右开口径，与其他用量口径一致。
   */
  const usageRange = (ctx) => {
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const until = new Date();
    const since = new Date(until.getTime() - days * 86400000);
    return { days, since: since.toISOString(), until: until.toISOString() };
  };
  if (part === '/billing/org-student-usage' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const { days, since, until } = usageRange(ctx);
    const orgId = String(ctx.search.get('orgId') || '').trim();
    if (orgId && !row('SELECT id FROM organizations WHERE id=?', [orgId])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    // 所有机构（含这段时间没有消耗的）：LEFT JOIN 用量，零消耗也列出来
    const orgs = rows(`SELECT organization.id, organization.name, organization.status,
        COALESCE(SUM(usage.cost_fen), 0) fen, COUNT(usage.id) calls, COUNT(DISTINCT usage.user_id) studentCount
      FROM organizations organization
      LEFT JOIN usage_records usage ON usage.org_id = organization.id AND usage.created_at>=? AND usage.created_at<?
      GROUP BY organization.id ORDER BY fen DESC, organization.name ASC`, [since, until])
      .map((item) => ({ id: item.id, name: item.name, status: item.status, costFen: Number(item.fen || 0), calls: Number(item.calls || 0), studentCount: Number(item.studentCount || 0) }));
    const students = orgId ? rows(`SELECT student.id, student.login, student.display_name,
        COALESCE(SUM(usage.cost_fen), 0) fen, COUNT(usage.id) calls,
        COUNT(DISTINCT usage.series_id) seriesCount, MAX(usage.created_at) lastAt
      FROM usage_records usage JOIN users student ON student.id = usage.user_id
      WHERE usage.org_id=? AND usage.created_at>=? AND usage.created_at<?
      GROUP BY student.id ORDER BY fen DESC, student.display_name ASC`, [orgId, since, until])
      .map((item) => ({ id: item.id, login: item.login, name: item.display_name || item.login, costFen: Number(item.fen || 0), calls: Number(item.calls || 0), seriesCount: Number(item.seriesCount || 0), lastAt: item.last_at || item.lastAt || null })) : [];
    const totals = { costFen: orgs.reduce((sum, item) => sum + item.costFen, 0), calls: orgs.reduce((sum, item) => sum + item.calls, 0), orgCount: orgs.length, activeOrgCount: orgs.filter((item) => item.calls > 0).length };
    return { days, since, until, orgId: orgId || null, orgs, students, totals };
  }
  if (part === '/billing/org-student-usage/export' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const { days, since, until } = usageRange(ctx);
    const orgId = String(ctx.search.get('orgId') || '').trim();
    if (orgId && !row('SELECT id FROM organizations WHERE id=?', [orgId])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    // 导出「机构 × 学员」两级的明细（选了机构就只导那家），列与页面一致
    const items = rows(`SELECT organization.name orgName, organization.id orgId, student.login studentLogin,
        student.display_name studentName, student.id studentId,
        COALESCE(SUM(usage.cost_fen), 0) fen, COUNT(usage.id) calls
      FROM usage_records usage
      JOIN organizations organization ON organization.id = usage.org_id
      JOIN users student ON student.id = usage.user_id
      WHERE usage.created_at>=? AND usage.created_at<?${orgId ? ' AND usage.org_id=?' : ''}
      GROUP BY organization.id, student.id
      ORDER BY fen DESC, organization.name ASC, student.display_name ASC`, orgId ? [since, until, orgId] : [since, until]);
    const content = csvDocument(
      ['机构', '机构ID', '学员', '学员账号', '学员ID', '调用次数', '消耗（元）'],
      items.map((item) => [item.orgName, item.orgId, item.studentName || item.studentLogin, item.studentLogin, item.studentId, Number(item.calls || 0), (Number(item.fen || 0) / 100).toFixed(2)]),
    );
    audit(ctx, 'PLATFORM_USAGE_EXPORT', 'ORG', orgId || null, null, { count: items.length, days, orgId: orgId || null });
    return { filename: csvFileName(orgId ? 'student-usage' : 'org-student-usage'), content, count: items.length };
  }
  return null;
}
