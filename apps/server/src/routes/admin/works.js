// 平台管理端「works」域路由：从 adminOrg.js 拆出，行为不变。
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

export async function handleWorks(ctx, part, method) {
  if (part === '/works' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const sortKey = String(ctx.search.get('sort') || 'featured').trim();
    const sort = Object.hasOwn({ featured: true, submitted: true, title: true }, sortKey) ? sortKey : 'featured';
    const sortSql = { featured: 'work.featured_at DESC, work.submitted_at DESC, work.id DESC', submitted: 'work.submitted_at DESC, work.id DESC', title: 'work.title COLLATE NOCASE ASC, work.id DESC' }[sort];
    const { where, params, publicationStateSql } = platformWorkFilters(ctx);
    const total = Number(row('SELECT COUNT(*) n FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN organizations organization ON organization.id=work.org_id' + where, params)?.n || 0);
    const items = rows(
      `SELECT work.*,student.login student_login,series.title package_name,session.title session_title,${publicationStateSql} publication_state,student.display_name student_name,organization.name organization_name,class.name class_name,lesson.title lesson_title,reviewer.display_name reviewer_name,COALESCE((SELECT COUNT(1) FROM work_reports report WHERE report.work_id=work.id AND report.status='PENDING'),0) pending_report_count FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN organizations organization ON organization.id=work.org_id LEFT JOIN classes class ON class.id=work.class_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by LEFT JOIN course_series series ON series.id=lesson.series_id LEFT JOIN class_sessions session ON session.id=work.class_session_id${where} ORDER BY ${sortSql} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    ).map((work) => ({ ...normalizeWork(work), studentLogin: work.student_login, packageName: work.package_name, sessionTitle: work.session_title, publicationState: work.publication_state, organizationName: work.organization_name || null, pendingReportCount: Number(work.pending_report_count || 0) }));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  if (part === '/works/export' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const { where, params } = platformWorkFilters(ctx);
    const items = rows(
      `SELECT work.*,student.display_name student_name,organization.name organization_name,class.name class_name,lesson.title lesson_title
       FROM works work JOIN users student ON student.id=work.student_id
       LEFT JOIN organizations organization ON organization.id=work.org_id
       LEFT JOIN classes class ON class.id=work.class_id
       LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id${where}
       ORDER BY work.submitted_at DESC, work.id DESC LIMIT 5000`,
      params,
    );
    const content = csvDocument(
      ['作品标题', '学员', '机构', '班级', '课时', '状态', '已上作品广场', '精选', '提交时间'],
      items.map((work) => [work.title, work.student_name || '', work.organization_name || '', work.class_name || '', work.lesson_title || '', work.status, Number(work.is_public || 0) === 1 ? '是' : '否', work.featured_at ? '是' : '否', work.submitted_at]),
    );
    audit(ctx, 'PLATFORM_WORK_EXPORT', 'WORK', null, null, { count: items.length, filters: { status: ctx.search.get('status') || null, orgId: ctx.search.get('orgId') || null, search: ctx.search.get('search') || null } });
    return { filename: csvFileName('works'), content, count: items.length };
  }
  let platformWorkMatch = part.match(/^\/works\/([^/]+)\/unpublish$/);
  if (platformWorkMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const work = row('SELECT * FROM works WHERE id=?', [platformWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
    // C2（2026-09-13）：下架写 UNPUBLISHED + unpublish_reason（**不再复用 REJECTED 与 teacher_comment**），
    // 「被驳回」与「被下架」在库里从此是两个值、两列原因，账面上也能分开统计。
    assertTransition(ctx, 'work', work.status, 'UNPUBLISHED', { targetType: 'WORK', targetId: work.id, before: normalizeWork(work), allowedFrom: ['PUBLISHED'], code: 'INVALID_WORK_TRANSITION', message: '仅已发布作品可以下架', details: { action: 'unpublish' } });
    const reason = String(ctx.body?.reason || '').trim();
    if (!reason) throw errors.badRequest('请填写下架原因', 'WORK_UNPUBLISH_REASON_REQUIRED');
    if (reason.length > 2000) throw errors.badRequest('下架原因不能超过 2000 个字符', 'WORK_UNPUBLISH_REASON_TOO_LONG');
    q('UPDATE works SET status=?,unpublish_reason=?,unpublished_at=?,is_public=0,reviewed_by=?,reviewed_at=?,featured_at=NULL,featured_by=NULL,featured_reason=NULL WHERE id=?', ['UNPUBLISHED', reason, nowIso(), auth.user.id, nowIso(), work.id]);
    audit(ctx, 'PLATFORM_WORK_UNPUBLISH', 'WORK', work.id, normalizeWork(work), { status: 'UNPUBLISHED', reason }, { orgId: work.org_id });
    const updated = row('SELECT work.*,student.display_name student_name,organization.name organization_name,class.name class_name,lesson.title lesson_title,reviewer.display_name reviewer_name FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN organizations organization ON organization.id=work.org_id LEFT JOIN classes class ON class.id=work.class_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by WHERE work.id=?', [work.id]);
    return { ...normalizeWork(updated), organizationName: updated.organization_name || null };
  }
  platformWorkMatch = part.match(/^\/works\/([^/]+)\/feature$/);
  if (platformWorkMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const work = row('SELECT work.*, student.privacy_allow_feature AS student_allow_feature FROM works work JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id WHERE work.id=?', [platformWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
    if (!Object.hasOwn(ctx.body || {}, 'featured') || typeof ctx.body.featured !== 'boolean') throw errors.badRequest('请选择是否设为精选', 'WORK_FEATURED_REQUIRED');
    const featured = ctx.body.featured;
    if (featured && work.status !== 'PUBLISHED') throw errors.conflict('仅已发布作品可以设为精选', 'WORK_NOT_PUBLISHED');
    if (featured && !work.student_allow_feature) throw errors.forbidden('该学生已关闭精选展示授权', 'STUDENT_FEATURE_OPT_OUT');
    const reason = featured ? String(ctx.body?.reason || '').trim().slice(0, 500) : null;
    q('UPDATE works SET featured_at=?,featured_by=?,featured_reason=? WHERE id=?', [featured ? nowIso() : null, featured ? auth.user.id : null, reason || null, work.id]);
    audit(ctx, featured ? 'PLATFORM_WORK_FEATURE' : 'PLATFORM_WORK_UNFEATURE', 'WORK', work.id, normalizeWork(work), { featured, reason: reason || null }, { orgId: work.org_id });
    return normalizeWork(row('SELECT * FROM works WHERE id=?', [work.id]));
  }
  // 平台决定哪些作品进入「学生作品广场」：发布需要机构审核通过 + 学生已确认展示授权。
  platformWorkMatch = part.match(/^\/works\/([^/]+)\/plaza$/);
  if (platformWorkMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const work = row('SELECT * FROM works WHERE id=?', [platformWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
    if (!Object.hasOwn(ctx.body || {}, 'published') || typeof ctx.body.published !== 'boolean') throw errors.badRequest('请选择是否发布到作品广场', 'WORK_PLAZA_FLAG_REQUIRED');
    const published = ctx.body.published;
    const now = nowIso();
    if (published) {
      if (!['PENDING', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED'].includes(work.status)) throw errors.conflict('仅学生已提交的作品可以发布到作品广场（被驳回的作品需学生重新提交）', 'WORK_NOT_SUBMITTED');
      if (!work.copyright_confirmed_at) throw errors.conflict('学生尚未确认作品版权与展示授权，不能发布到作品广场', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
      let shareToken = work.share_token;
      if (!shareToken) {
        shareToken = 'wst_' + randomUUID().replace(/-/g, '').slice(0, 24);
        while (row('SELECT id FROM works WHERE share_token=?', [shareToken])) shareToken = 'wst_' + randomUUID().replace(/-/g, '').slice(0, 24);
      }
      transaction(() => {
        if (work.status !== 'PUBLISHED') {
          assertTransition(ctx, 'work', work.status, 'PUBLISHED', { targetType: 'WORK', targetId: work.id, before: normalizeWork(work), code: 'INVALID_WORK_TRANSITION', message: '当前状态不能发布到作品广场' });
        }
        // 重新上架要清掉上一次的下架原因，否则学生会看到一条早就过期的说明（与 VibeCoding 链路同口径）
        q("UPDATE works SET status='PUBLISHED',is_public=1,share_token=?,reviewed_by=?,reviewed_at=?,unpublish_reason=NULL,unpublished_at=NULL WHERE id=?", [shareToken, auth.user.id, now, work.id]);
      });
    } else {
      q('UPDATE works SET is_public=0,share_token=NULL WHERE id=?', [work.id]);
    }
    audit(ctx, published ? 'PLATFORM_WORK_PLAZA_PUBLISH' : 'PLATFORM_WORK_PLAZA_UNPUBLISH', 'WORK', work.id, { status: work.status, plazaPublished: Boolean(work.is_public) }, { status: published ? 'PUBLISHED' : work.status, plazaPublished: published }, { orgId: work.org_id });
    return normalizeWork(row('SELECT * FROM works WHERE id=?', [work.id]));
  }
  if (part === '/work-reports' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const status = ctx.search.get('status'); const orgFilter = ctx.search.get('orgId');
    const conditions = ['1=1']; const params = [];
    if (['PENDING', 'RESOLVED', 'DISMISSED'].includes(status)) { conditions.push('report.status=?'); params.push(status); }
    if (orgFilter) { conditions.push('report.org_id=?'); params.push(orgFilter); }
    const items = workReportRows(conditions.join(' AND '), params);
    return { items, total: items.length, pending: items.filter((item) => item.status === 'PENDING').length };
  }
  let platformReportMatch = part.match(/^\/work-reports\/([^/]+)$/);
  if (platformReportMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const report = row('SELECT * FROM work_reports WHERE id=?', [platformReportMatch[1]]);
    if (!report) throw errors.notFound('举报记录不存在', 'WORK_REPORT_NOT_FOUND');
    if (report.status !== 'PENDING') throw errors.conflict('举报已处理，不能重复处理', 'WORK_REPORT_ALREADY_HANDLED');
    const status = ctx.body?.status;
    if (!['RESOLVED', 'DISMISSED'].includes(status)) throw errors.badRequest('举报处理状态无效', 'INVALID_WORK_REPORT_STATUS');
    const actionTaken = ctx.body?.actionTaken || 'NONE';
    if (!['NONE', 'UNPUBLISH'].includes(actionTaken)) throw errors.badRequest('举报处理动作无效', 'INVALID_WORK_REPORT_ACTION');
    const resolution = reportResolution(ctx.body); const work = row('SELECT * FROM works WHERE id=? AND org_id=?', [report.work_id, report.org_id]);
    if (!work) throw errors.notFound('关联作品不存在', 'WORK_NOT_FOUND');
    if (actionTaken === 'UNPUBLISH' && work.status !== 'PUBLISHED') throw errors.conflict('仅已发布作品可因举报下架', 'WORK_NOT_PUBLISHED');
    const now = nowIso();
    transaction(() => {
      if (actionTaken === 'UNPUBLISH') q('UPDATE works SET status=?,unpublish_reason=?,unpublished_at=?,is_public=0,reviewed_by=?,reviewed_at=?,featured_at=NULL,featured_by=NULL,featured_reason=NULL WHERE id=?', ['UNPUBLISHED', resolution, now, auth.user.id, now, work.id]);
      q('UPDATE work_reports SET status=?,handled_by=?,handled_at=?,resolution=?,action_taken=? WHERE id=?', [status, auth.user.id, now, resolution, actionTaken, report.id]);
    });
    audit(ctx, 'PLATFORM_WORK_REPORT_HANDLE', 'WORK_REPORT', report.id, normalizeWorkReport(report), { status, actionTaken, resolution }, { orgId: report.org_id });
    if (actionTaken === 'UNPUBLISH') audit(ctx, 'PLATFORM_WORK_UNPUBLISH_REPORT', 'WORK', work.id, normalizeWork(work), { status: 'UNPUBLISHED', reportId: report.id }, { orgId: work.org_id });
    return workReportRows('report.id=?', [report.id])[0];
  }
  let workDetailMatch = part.match(/^\/works\/([^/]+)\/detail$/);
  if (workDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const workId = workDetailMatch[1];
    const workRow = row(
      `SELECT work.*,
              student.id AS student_id, student.login AS student_login, student.display_name AS student_name,
              student.privacy_allow_feature AS student_allow_feature,
              student.privacy_showcase_anonymous AS student_showcase_anonymous,
              reviewer.display_name AS reviewer_name,
              organization.id AS org_id, organization.name AS organization_name,
              class.id AS class_id, class.name AS class_name,
              lesson.id AS course_lesson_id, lesson.title AS course_lesson_title
       FROM works work
       JOIN users student ON student.id=work.student_id
       LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by
       LEFT JOIN organizations organization ON organization.id=work.org_id
       LEFT JOIN classes class ON class.id=work.class_id
       LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id
       WHERE work.id=?`,
      [workId],
    );
    if (!workRow) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');

    const submissions = rows(
      `SELECT s.*
       FROM work_submissions s
       WHERE s.work_id=? ORDER BY s.round DESC LIMIT 10`,
      [workId],
    ).map((s) => ({
      id: s.id, round: s.round, title: s.title, description: s.description || '',
      reviewStatus: s.review_status || null, reviewComment: s.review_comment || null,
      reviewerName: null, reviewedAt: s.reviewed_at || null,
      submittedAt: s.submitted_at,
    }));

    const annotations = rows(
      `SELECT a.*, author.display_name AS author_name
       FROM work_annotations a
       JOIN users author ON author.id=a.author_id
       WHERE a.work_id=? ORDER BY a.created_at DESC LIMIT 5`,
      [workId],
    ).map((a) => ({
      id: a.id, nodeId: a.node_id || null, content: a.content,
      authorName: a.author_name, createdAt: a.created_at,
      resolvedAt: a.resolved_at || null, resolvedBy: a.resolved_by || null,
    }));

    const reports = rows(
      `SELECT report.*, reporter.display_name AS reporter_name, handler.display_name AS handler_name
       FROM work_reports report
       JOIN users reporter ON reporter.id=report.reporter_id
       LEFT JOIN users handler ON handler.id=report.handled_by
       WHERE report.work_id=? ORDER BY report.created_at DESC`,
      [workId],
    ).map((r) => ({
      id: r.id, category: r.category, details: r.details || '',
      status: r.status, resolution: r.resolution || null, actionTaken: r.action_taken || 'NONE',
      reporterName: r.reporter_name, handlerName: r.handler_name || null,
      handledAt: r.handled_at || null, createdAt: r.created_at,
    }));

    const latestPublishRequest = row(
      `SELECT pr.*, handler.display_name AS handler_name
       FROM work_publish_requests pr
       LEFT JOIN users handler ON handler.id=pr.resolved_by
       WHERE pr.work_id=? ORDER BY pr.requested_at DESC LIMIT 1`,
      [workId],
    );

    return {
      ...normalizeWork(workRow, { includeSnapshot: true }),
      studentLogin: workRow.student_login,
      studentAllowFeature: Boolean(workRow.student_allow_feature),
      studentShowcaseAnonymous: Boolean(workRow.student_showcase_anonymous),
      organizationName: workRow.organization_name || null,
      courseLessonTitle: workRow.course_lesson_title || null,
      pendingReportCount: reports.filter((r) => r.status === 'PENDING').length,
      submissions,
      annotations,
      annotationCount: Number(
        row('SELECT COUNT(*) AS n FROM work_annotations WHERE work_id=?', [workId])?.n || 0,
      ),
      reports,
      latestPublishRequest: latestPublishRequest ? normalizeWorkPublishRequest(latestPublishRequest) : null,
    };
  }

  // ── VibeCoding 作品（学生提交后，平台决定是否发布到作品广场；没有老师点评这一环了）──
  if (part === '/vibecoding-works' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const { where, params, publicationStateSql } = platformWorkFilters(ctx, 'vibecoding');
    const sort = ctx.search.get('sort') === 'title' ? 'title' : 'submitted';
    const sortSql = sort === 'title' ? 'submission.title COLLATE NOCASE ASC, submission.id DESC' : 'submission.submitted_at DESC, submission.id DESC';
    const joins = ` FROM vibecoding_submissions submission
      LEFT JOIN users student ON student.id=submission.student_id
      LEFT JOIN organizations organization ON organization.id=submission.org_id
      LEFT JOIN classes class ON class.id=submission.class_id
      LEFT JOIN course_lessons lesson ON lesson.id=submission.lesson_id
      LEFT JOIN course_series series ON series.id=lesson.series_id
      LEFT JOIN vibecoding_conversations conversation ON conversation.id=submission.conversation_id
      LEFT JOIN class_sessions session ON session.id=conversation.class_session_id`;
    const total = Number(row('SELECT COUNT(*) n' + joins + where, params)?.n || 0);
    const items = rows(
      `SELECT submission.*, series.title package_name, session.title session_title, ${publicationStateSql} publication_state, student.display_name student_name, student.login student_login, organization.name organization_name, class.name class_name, lesson.title lesson_title` + joins + where +
      ` ORDER BY ${sortSql} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    ).map((item) => ({ ...normalizeSubmission(item), studentLogin: item.student_login, packageName: item.package_name, sessionTitle: item.session_title, publicationState: item.publication_state, organizationName: item.organization_name || null }));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  const vibeWorkPlazaMatch = part.match(/^\/vibecoding-works\/([^/]+)\/plaza$/);
  if (vibeWorkPlazaMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const submission = row('SELECT * FROM vibecoding_submissions WHERE id=?', [vibeWorkPlazaMatch[1]]);
    if (!submission) throw errors.notFound('VibeCoding 作品不存在', 'VIBECODING_SUBMISSION_NOT_FOUND');
    if (!Object.hasOwn(ctx.body || {}, 'published') || typeof ctx.body.published !== 'boolean') throw errors.badRequest('请选择是否发布到作品广场', 'WORK_PLAZA_FLAG_REQUIRED');
    const now = nowIso();
    if (ctx.body.published) {
      if (!submission.copyright_confirmed_at) throw errors.conflict('学生尚未确认作品版权与展示授权，不能发布到作品广场', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
      let shareToken = submission.share_token;
      if (!shareToken) {
        shareToken = 'vbt_' + randomUUID().replace(/-/g, '').slice(0, 24);
        while (row('SELECT id FROM vibecoding_submissions WHERE share_token=?', [shareToken])) shareToken = 'vbt_' + randomUUID().replace(/-/g, '').slice(0, 24);
      }
      // 重新发布时清掉上一次的下架原因（否则学生会看到一条早就过期的说明）
      q('UPDATE vibecoding_submissions SET is_public=1,share_token=?,published_at=?,published_by=?,unpublish_reason=NULL,updated_at=? WHERE id=?', [shareToken, now, auth.user.id, now, submission.id]);
      audit(ctx, 'PLATFORM_VIBECODING_WORK_PUBLISH', 'VIBECODING_SUBMISSION', submission.id, { isPublic: Number(submission.is_public || 0) === 1 }, { isPublic: true, shareToken }, { orgId: submission.org_id });
    } else {
      // 下架必须写原因，且**学生能看到**（与画布链路同口径：作品被撤下来要给学生一个说法）
      const reason = String(ctx.body?.reason || '').trim();
      if (!reason) throw errors.badRequest('请填写下架原因（学生会看到）', 'WORK_UNPUBLISH_REASON_REQUIRED');
      if (reason.length > 2000) throw errors.badRequest('下架原因不能超过 2000 个字符', 'WORK_UNPUBLISH_REASON_TOO_LONG');
      q('UPDATE vibecoding_submissions SET is_public=0,published_at=NULL,published_by=NULL,unpublish_reason=?,updated_at=? WHERE id=?', [reason, now, submission.id]);
      audit(ctx, 'PLATFORM_VIBECODING_WORK_UNPUBLISH', 'VIBECODING_SUBMISSION', submission.id, { isPublic: true }, { isPublic: false, reason }, { orgId: submission.org_id });
    }
    const updated = row(
      `SELECT submission.*, student.display_name student_name, student.login student_login, organization.name organization_name, class.name class_name, lesson.title lesson_title
       FROM vibecoding_submissions submission
       LEFT JOIN users student ON student.id=submission.student_id
       LEFT JOIN organizations organization ON organization.id=submission.org_id
       LEFT JOIN classes class ON class.id=submission.class_id
       LEFT JOIN course_lessons lesson ON lesson.id=submission.lesson_id
       WHERE submission.id=?`,
      [submission.id],
    );
    return { ...normalizeSubmission(updated), organizationName: updated.organization_name || null };
  }
  return null;
}
