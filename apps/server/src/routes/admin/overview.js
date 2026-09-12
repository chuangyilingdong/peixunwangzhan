// 平台管理端「overview」域路由：从 adminOrg.js 拆出，行为不变。
import { clearGatewayRouteCache, createGatewayToken, gatewayUsageOverview, getComputeGatewayConfig, listGatewayChannels, listGatewayTokens, saveComputeGatewayConfig, testComputeGateway } from '../../services/computeGateway.js';
import { computePoolReconciliation, computePoolReport, getComputePricing, saveComputePricing } from '../../services/computePool.js';
import {
  audit, count, errors, id, json, normalizeClass, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  assignmentActiveSql, PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction, verifyPassword,
} from '../../lib.js';
import { hashPassword } from '@platform/database';
import { randomUUID } from 'node:crypto';
import { adjustCredits, normalizeEntry, reconcileCredits, refundOrReverseEntry, setFrozenCredits } from '../../services/creditLedger.js';
import { scheduleReminder } from '../communication.js';
import { assertKnownState, assertTransition } from '../../services/domainState.js';
import { getAiProviderPolicy } from '../billingConfig.js';
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
  assertTeachingClassManager,
  auditListQuery,
  auditQuery,
  auditRow,
  buildOrganizationDetail,
  buildStudentDataExport,
  bumpSeriesVersion,
  classDetail,
  classInOrg,
  classMemberships,
  classProgressRows,
  classSessionRows,
  contactPayload,
  createMember,
  csvDocument,
  csvFileName,
  curriculumItem,
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
  orgAccountRequestRow,
  orgAccountRequestRows,
  orgAdminRows,
  orgContractMeta,
  orgId,
  orgMemberRow,
  orgUser,
  orgWorkPublishRequestRow,
  orgWorkPublishRequestRows,
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
  teacherCanAccessClass,
  teacherScope,
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
    return { items: computePoolReport({ limit }), pricing: getComputePricing() };
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
    const usage = scoped('usage_records');
    const usageTotal = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where}`, usage.params);
    const usageSuccess = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='SUCCESS'`, usage.params);
    const usageFailed = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='FAILED'`, usage.params);
    const usageBlocked = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='BLOCKED'`, usage.params);
    const abnormalTasks = usageFailed + usageBlocked;
    const creditsSpent = singleNumber(`SELECT COALESCE(SUM(credits_charged),0) n FROM usage_records WHERE ${usage.where}`, usage.params);
    const aiTasks = singleNumber(`SELECT COUNT(*) n FROM generation_jobs WHERE ${scoped('generation_jobs').where}`, scoped('generation_jobs').params);
    const account = orgIds.length ? singleNumber(`SELECT COALESCE(SUM(credit_balance),0) n FROM org_billing_accounts WHERE org_id IN (${orgIds.map(() => '?').join(',')})`, orgIds) : 0;
    const frozenCredits = orgIds.length ? singleNumber(`SELECT COALESCE(SUM(frozen_credits),0) n FROM org_billing_accounts WHERE org_id IN (${orgIds.map(() => '?').join(',')})`, orgIds) : 0;
    const byOrg = rows(`SELECT organization.id,organization.name,COALESCE(SUM(usage.credits_charged),0) credits,COUNT(usage.id) calls
      FROM organizations organization LEFT JOIN usage_records usage ON usage.org_id=organization.id AND usage.created_at>=? AND usage.created_at<?
      ${orgFilter ? 'WHERE organization.id=?' : ''} GROUP BY organization.id ORDER BY credits DESC,organization.name ASC LIMIT 10`, orgFilter ? [since, until, orgFilter] : [since, until]).map((item) => ({ id: item.id, name: item.name, credits: Number(item.credits || 0), calls: Number(item.calls || 0) }));
    const byModality = rows(`SELECT modality,COUNT(*) calls,COALESCE(SUM(credits_charged),0) credits,COUNT(CASE WHEN status='SUCCESS' THEN 1 END) successCalls,COUNT(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 END) abnormalCalls
      FROM usage_records WHERE ${usage.where} GROUP BY modality ORDER BY credits DESC,modality ASC`, usage.params).map((item) => ({ modality: item.modality, calls: Number(item.calls || 0), credits: Number(item.credits || 0), successCalls: Number(item.success_calls ?? item.successCalls ?? 0), abnormalCalls: Number(item.abnormal_calls ?? item.abnormalCalls ?? 0) }));
    return {
      metrics: {
        organizations, activeOrganizations, admins, teachers, students,
        publishedCourses, activeAssignments, activeClasses: classes, classSessions, projects, works,
        aiTasks, abnormalTasks, usageCalls: usageTotal, successfulCalls: usageSuccess, failedCalls: usageFailed, blockedCalls: usageBlocked,
        creditsSpent, creditBalance: account, frozenCredits,
      },
      byOrg, byModality,
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
          activeClasses: 'ACTIVE 状态班级数，为存量口径。',
          classSessions: '查询时间内启动的课堂场次。',
          projects: '查询时间内创建的项目数。',
          works: '查询时间内提交的作品数。',
          aiTasks: '查询时间内创建的生成任务数。',
          abnormalTasks: '查询时间内 usage_records 中状态为 FAILED 或 BLOCKED 的调用次数。',
          creditsSpent: '查询时间内 usage_records.credits_charged 求和。',
          creditBalance: '机构账面积分余额，含冻结；为筛选范围当前存量。',
          frozenCredits: '机构冻结积分，为筛选范围当前存量。',
        },
        boundary: 'from/to 均为左闭右开 UTC ISO 时间；未传时默认最近 30 天；机构与用户统计不按时间过滤。',
      },
    };
  }
  if (part === '/billing/usage-overview' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { totalCredits: Number(row('SELECT COALESCE(SUM(credit_balance),0) n FROM org_billing_accounts').n || 0), usage: rows('SELECT modality,SUM(credits_charged) credits,COUNT(*) calls FROM usage_records GROUP BY modality'), topOrgs: rows('SELECT organization.id,organization.name,COALESCE(SUM(usage.credits_charged),0) credits FROM organizations organization LEFT JOIN usage_records usage ON usage.org_id=organization.id GROUP BY organization.id ORDER BY credits DESC LIMIT 10') };
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
    const sort = Object.hasOwn({ created: true, credits: true }, sortKey) ? sortKey : 'created';
    const orderBy = sort === 'credits' ? 'usage.credits_charged DESC,usage.created_at DESC,usage.id DESC' : 'usage.created_at DESC,usage.id DESC';
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
      credits: Number(item.credits_charged || 0),
      status: item.status, failCode: item.fail_code || null, createdAt: item.created_at,
    }));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  return null;
}
