import {
  asPositiveInteger,
  audit,
  clearAuthCookie,
  errors,
  id,
  json,
  nonEmptyString,
  normalizeOrg,
  normalizePackage,
  normalizeProject,
  normalizeUser,
  normalizeWork,
  normalizeWorkReport,
  nowIso,
  parseJson,
  q,
  requireRole,
  row,
  rows,
  transaction,
  verifyPassword,
} from '../lib.js';
import { hashPassword } from '@platform/database';
import {
  buildStudentContext,
  buildStudentDashboard,
  getStudentActiveSessions,
  getStudentMemberships,
  resolveProjectUsageContext,
  resolveStudentLessonContext,
} from '../services/studentContext.js';

const EMPTY_CANVAS = Object.freeze({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw errors.badRequest('画布数据必须是可序列化的 JSON', 'INVALID_CANVAS_SNAPSHOT'); }
}

export function normalizeCanvasSnapshot(input, { fallback = EMPTY_CANVAS } = {}) {
  if (input === undefined || input === null) return cloneJson(fallback);
  if (Array.isArray(input) || typeof input !== 'object') throw errors.badRequest('画布快照必须是对象', 'INVALID_CANVAS_SNAPSHOT');
  if (input.nodes !== undefined && !Array.isArray(input.nodes)) throw errors.badRequest('画布 nodes 必须是数组', 'INVALID_CANVAS_SNAPSHOT');
  if (input.edges !== undefined && !Array.isArray(input.edges)) throw errors.badRequest('画布 edges 必须是数组', 'INVALID_CANVAS_SNAPSHOT');
  const viewport = input.viewport && typeof input.viewport === 'object' && !Array.isArray(input.viewport)
    ? input.viewport : EMPTY_CANVAS.viewport;
  const snapshot = cloneJson({
    ...input,
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
    viewport: {
      x: Number.isFinite(Number(viewport.x)) ? Number(viewport.x) : 0,
      y: Number.isFinite(Number(viewport.y)) ? Number(viewport.y) : 0,
      zoom: Number.isFinite(Number(viewport.zoom)) ? Number(viewport.zoom) : 1,
    },
  });
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) {
    throw errors.badRequest('画布快照不能超过 1MB', 'CANVAS_SNAPSHOT_TOO_LARGE');
  }
  return snapshot;
}

const PROJECT_DELETE_RESTORE_DAYS = 30;

function getOwnProject(ctx, projectId, { includeArchived = false, includeDeleted = false } = {}) {
  const project = row(
    `SELECT project.*, lesson.title AS lesson_title,
            series.id AS series_id, series.title AS series_title,
            class.name AS class_name,
            work.id AS work_id, work.status AS work_status, work.submitted_at AS work_submitted_at
     FROM student_projects project
     LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
     LEFT JOIN course_series series ON series.id = lesson.series_id
     LEFT JOIN classes class ON class.id = project.class_id
     LEFT JOIN works work ON work.project_id = project.id
     WHERE project.id = ? AND project.student_id = ? AND project.org_id = ?
       ${includeDeleted ? '' : 'AND project.deleted_at IS NULL'}
       ${includeArchived ? '' : "AND project.status != 'ARCHIVED'"}`,
    [projectId, ctx.auth.user.id, ctx.auth.user.orgId],
  );
  if (!project) throw errors.notFound('项目不存在', 'PROJECT_NOT_FOUND');
  return project;
}
function fetchProject(ctx, projectId, { includeDeleted = false } = {}) {
  return row(
    `SELECT project.*, lesson.title AS lesson_title,
            series.id AS series_id, series.title AS series_title,
            class.name AS class_name,
            work.id AS work_id, work.status AS work_status, work.submitted_at AS work_submitted_at
     FROM student_projects project
     LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
     LEFT JOIN course_series series ON series.id = lesson.series_id
     LEFT JOIN classes class ON class.id = project.class_id
     LEFT JOIN works work ON work.project_id = project.id
     WHERE project.id = ? AND project.student_id = ? AND project.org_id = ?
       ${includeDeleted ? '' : 'AND project.deleted_at IS NULL'}`,
    [projectId, ctx.auth.user.id, ctx.auth.user.orgId],
  );
}
function fetchWork(ctx, workId) {
  return row(
    `SELECT work.*, student.display_name AS student_name, class.name AS class_name,
            lesson.title AS lesson_title, reviewer.display_name AS reviewer_name
     FROM works work
     JOIN users student ON student.id = work.student_id AND student.org_id = work.org_id
     LEFT JOIN classes class ON class.id = work.class_id AND class.org_id = work.org_id
     LEFT JOIN course_lessons lesson ON lesson.id = work.course_lesson_id
     LEFT JOIN users reviewer ON reviewer.id = work.reviewed_by
     WHERE work.id = ? AND work.student_id = ? AND work.org_id = ?`,
    [workId, ctx.auth.user.id, ctx.auth.user.orgId],
  );
}

function getOwnWork(ctx, workId) {
  const work = row('SELECT * FROM works WHERE id=? AND student_id=? AND org_id=?', [workId, ctx.auth.user.id, ctx.auth.user.orgId]);
  if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
  return work;
}

function currentSubmissionRound(workId) {
  const latest = row('SELECT round FROM work_submissions WHERE work_id=? ORDER BY round DESC LIMIT 1', [workId]);
  return Number(latest?.round || 0);
}

function workSubmissionRows(workIds) {
  const ids = Array.isArray(workIds) ? workIds.filter(Boolean) : [workIds].filter(Boolean);
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const items = rows(
    `SELECT submission.id, submission.work_id, submission.round, submission.title, submission.description,
            submission.snapshot_version, submission.submitted_at, submission.review_status, submission.review_comment,
            submission.reviewed_at
     FROM work_submissions submission
     WHERE submission.work_id IN (${placeholders})
     ORDER BY submission.work_id, submission.round DESC`,
    ids,
  );
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.work_id)) grouped.set(item.work_id, []);
    grouped.get(item.work_id).push({
      id: item.id,
      workId: item.work_id,
      round: Number(item.round || 0),
      title: item.title,
      description: item.description,
      snapshotVersion: Number(item.snapshot_version || 0),
      submittedAt: item.submitted_at,
      reviewStatus: item.review_status || 'PENDING',
      reviewComment: item.review_comment || null,
      reviewedAt: item.reviewed_at || null,
    });
  }
  return grouped;
}

function annotationRowsForStudent(workId, studentId, orgId) {
  return rows(
    `SELECT annotation.*, author.display_name AS author_name, resolver.display_name AS resolver_name,
            read_record.read_at
     FROM work_annotations annotation
     JOIN users author ON author.id = annotation.author_id
     LEFT JOIN users resolver ON resolver.id = annotation.resolved_by
     LEFT JOIN work_feedback_reads read_record ON read_record.annotation_id = annotation.id
       AND read_record.student_id = ?
     WHERE annotation.work_id=? AND annotation.org_id=?
     ORDER BY annotation.created_at DESC`,
    [studentId, workId, orgId],
  ).map((annotation) => ({
    id: annotation.id,
    workId: annotation.work_id,
    nodeId: annotation.node_id || null,
    content: annotation.content,
    authorId: annotation.author_id,
    authorName: annotation.author_name || '教师',
    createdAt: annotation.created_at,
    resolvedAt: annotation.resolved_at || null,
    resolvedBy: annotation.resolved_by || null,
    resolverName: annotation.resolver_name || null,
    readAt: annotation.read_at || null,
  }));
}

function normalizeWorkPublishRequest(request) {
  if (!request) return null;
  return {
    id: request.id,
    workId: request.work_id,
    projectId: request.project_id,
    studentId: request.student_id,
    orgId: request.org_id,
    round: Number(request.round || 0),
    status: request.status,
    reason: request.reason || '',
    requestedAt: request.requested_at,
    resolvedAt: request.resolved_at || null,
    resolvedBy: request.resolved_by || null,
    resolution: request.resolution || null,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
  };
}

function decorateWork(work, ctx, { includeSubmissions = false } = {}) {
  if (!work) return work;
  const submissionsByWork = workSubmissionRows(work.id).get(work.id) || [];
  const submissionRound = submissionsByWork[0]?.round || 0;
  const annotations = annotationRowsForStudent(work.id, ctx.auth.user.id, ctx.auth.user.orgId);
  const unreadAnnotationCount = annotations.filter((item) => !item.readAt).length;
  const overallRead = Boolean(row(
    'SELECT id FROM work_feedback_reads WHERE work_id=? AND student_id=? AND annotation_id IS NULL AND submission_round=?',
    [work.id, ctx.auth.user.id, submissionRound],
  ));
  const hasOverallFeedback = Boolean(work.teacherComment);
  const overallUnreadCount = hasOverallFeedback && !overallRead ? 1 : 0;
  const publishRequests = rows('SELECT * FROM work_publish_requests WHERE work_id=? ORDER BY requested_at DESC', [work.id]).map(normalizeWorkPublishRequest);
  const pendingPublishRequest = publishRequests.find((item) => item.status === 'PENDING') || null;
  const latestPublishRequest = publishRequests[0] || null;
  const project = row('SELECT id,status,deleted_at FROM student_projects WHERE id=? AND student_id=? AND org_id=?', [work.projectId, ctx.auth.user.id, ctx.auth.user.orgId]);
  return {
    ...work,
    submissionRound,
    submissions: includeSubmissions ? submissionsByWork : undefined,
    unreadFeedbackCount: unreadAnnotationCount + overallUnreadCount,
    unreadAnnotationCount,
    overallUnreadCount,
    overallFeedbackRead: overallRead,
    publishRequests: includeSubmissions ? publishRequests : undefined,
    pendingPublishRequest,
    latestPublishRequest,
    actions: {
      canEditProject: work.status === 'REJECTED' && project?.status === 'DRAFT' && !project?.deleted_at,
      canSubmitProject: project?.status === 'DRAFT' && !project?.deleted_at,
      canRequestPublish: work.status === 'APPROVED' && !pendingPublishRequest,
      canWithdrawPublishRequest: Boolean(pendingPublishRequest),
    },
  };
}

function assertDraft(project) {
  if (project.status !== 'DRAFT') throw errors.conflict('已提交或已评分项目不能继续编辑', 'PROJECT_NOT_EDITABLE');
}

function assertProjectUsable(ctx, project) {
  assertDraft(project);
  const usageContext = resolveProjectUsageContext(ctx.auth.rawUser, project);
  if (!usageContext.canUseNow) throw errors.forbidden(usageContext.blockReason, usageContext.blockCode);
  return usageContext;
}


const USAGE_MODALITIES = new Set(['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING']);
const USAGE_STATUSES = new Set(['SUCCESS', 'FAILED', 'BLOCKED']);
const WORK_STATUS_RANK = { PUBLISHED: 4, APPROVED: 3, REJECTED: 2, PENDING: 1 };

function studentCourseOverview(ctx) {
  const context = buildStudentContext(ctx.auth.rawUser);
  const projects = rows(`SELECT id, course_lesson_id, class_id, title, status, updated_at FROM student_projects WHERE student_id = ? AND org_id = ? AND status != 'ARCHIVED'`, [ctx.auth.user.id, ctx.auth.user.orgId]);
  const works = rows('SELECT id, project_id, course_lesson_id, class_id, title, status, submitted_at FROM works WHERE student_id = ? AND org_id = ?', [ctx.auth.user.id, ctx.auth.user.orgId]);
  const classById = new Map(context.classes.map((item) => [item.id, item]));
  const activeLessonIds = new Set(context.activeSessions.map((item) => item.lessonId).filter(Boolean));
  const projectGroups = new Map();
  const workGroups = new Map();
  for (const project of projects) {
    if (!project.course_lesson_id) continue;
    const group = projectGroups.get(project.course_lesson_id) || [];
    group.push(project);
    projectGroups.set(project.course_lesson_id, group);
  }
  for (const work of works) {
    if (!work.course_lesson_id) continue;
    const group = workGroups.get(work.course_lesson_id) || [];
    group.push(work);
    workGroups.set(work.course_lesson_id, group);
  }
  const items = context.courses.map((course) => {
    const lessons = (course.lessons || []).map((lesson) => {
      const lessonProjects = projectGroups.get(lesson.id) || [];
      const lessonWorks = workGroups.get(lesson.id) || [];
      const bestWork = lessonWorks.reduce((best, item) => WORK_STATUS_RANK[item.status] > (WORK_STATUS_RANK[best?.status] || 0) ? item : best, null);
      return {
        ...lesson,
        projectCount: lessonProjects.length,
        workCount: lessonWorks.length,
        workStatus: bestWork?.status || null,
        activeNow: activeLessonIds.has(lesson.id),
        lastActivityAt: [...lessonProjects.map((item) => item.updated_at), ...lessonWorks.map((item) => item.submitted_at)].filter(Boolean).sort().at(-1) || null,
      };
    });
    const submittedLessonCount = lessons.filter((item) => item.workCount > 0).length;
    return {
      ...course,
      classes: [...new Set(course.classIds || [])].map((classId) => classById.get(classId)).filter(Boolean).map((item) => ({ id: item.id, name: item.name, teacherName: item.teacherName, usageMode: item.usageMode, status: item.status })),
      lessons,
      progress: {
        lessonCount: lessons.length,
        startedLessonCount: lessons.filter((item) => item.projectCount > 0).length,
        submittedLessonCount,
        publishedLessonCount: lessons.filter((item) => item.workStatus === 'PUBLISHED').length,
        submittedPercent: lessons.length ? Math.round((submittedLessonCount / lessons.length) * 100) : 0,
      },
    };
  });
  const allLessons = items.flatMap((course) => course.lessons);
  return {
    items,
    summary: {
      courseCount: items.length,
      classCount: context.classes.length,
      activeLessonCount: allLessons.filter((item) => item.activeNow).length,
      assignedLessonCount: allLessons.length,
      startedLessonCount: allLessons.filter((item) => item.projectCount > 0).length,
      submittedLessonCount: allLessons.filter((item) => item.workCount > 0).length,
      publishedLessonCount: allLessons.filter((item) => item.workStatus === 'PUBLISHED').length,
    },
  };
}

function studentUsageOverview(ctx) {
  const days = asPositiveInteger(ctx.search.get('days'), '统计天数', { min: 1, max: 365, fallback: 30 });
  const modalityInput = ctx.search.get('modality');
  const modality = modalityInput ? String(modalityInput).trim().toUpperCase() : null;
  if (modality && !USAGE_MODALITIES.has(modality)) throw errors.badRequest('不支持的素材类型', 'UNSUPPORTED_MODALITY');
  const status = ctx.search.get('status');
  if (status && !USAGE_STATUSES.has(status)) throw errors.badRequest('无效的用量状态', 'INVALID_USAGE_STATUS');
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const filters = ['usage.user_id = ?', 'usage.org_id = ?', 'usage.created_at >= ?'];
  const params = [ctx.auth.user.id, ctx.auth.user.orgId, since];
  if (modality) { filters.push('usage.modality = ?'); params.push(modality); }
  if (status) { filters.push('usage.status = ?'); params.push(status); }
  const records = rows('SELECT usage.*, project.title AS project_title, project.course_lesson_id AS project_lesson_id, lesson.title AS lesson_title, class.name AS class_name FROM usage_records usage LEFT JOIN student_projects project ON project.id = usage.project_id AND project.student_id = usage.user_id AND project.org_id = usage.org_id LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id LEFT JOIN class_sessions session ON session.id = usage.class_session_id LEFT JOIN classes class ON class.id = session.class_id WHERE ' + filters.join(' AND ') + ' ORDER BY usage.created_at DESC LIMIT 200', params);
  const byModality = new Map();
  for (const record of records) {
    const summary = byModality.get(record.modality) || { modality: record.modality, totalCredits: 0, recordCount: 0 };
    summary.totalCredits += Number(record.credits_charged || 0);
    summary.recordCount += 1;
    byModality.set(record.modality, summary);
  }
  const rawUser = ctx.auth.rawUser;
  const allowance = Number(rawUser.monthly_credit_allowance || 0) + Number(rawUser.monthly_bonus_credits || 0) + Number(rawUser.month_period_boost_credits || 0);
  const used = Number(rawUser.used_credits_this_period || 0);
  const pkg = rawUser.billing_package_id ? row('SELECT * FROM billing_packages WHERE id = ? AND org_id = ?', [rawUser.billing_package_id, ctx.auth.user.orgId]) : null;
  return {
    user: normalizeUser(rawUser),
    package: normalizePackage(pkg),
    period: { allowance, used, remaining: Math.max(0, allowance - used), bonus: Number(rawUser.monthly_bonus_credits || 0), boost: Number(rawUser.month_period_boost_credits || 0), start: rawUser.period_start_at || null, reset: rawUser.period_reset_at || null, expired: Boolean(rawUser.period_reset_at && rawUser.period_reset_at <= nowIso()) },
    usageScope: rawUser.student_usage_scope || null,
    magicStones: Number(rawUser.magic_stones || 0),
    activeSessions: getStudentActiveSessions(rawUser).map((item) => ({ id: item.id, classId: item.class_id, lessonId: item.lesson_id, lessonTitle: item.lesson_title, status: item.status, startedAt: item.started_at })),
    usage: {
      days, since,
      totalCredits: records.reduce((total, item) => total + Number(item.credits_charged || 0), 0),
      recordCount: records.length,
      successCount: records.filter((item) => item.status === 'SUCCESS').length,
      failedCount: records.filter((item) => item.status === 'FAILED').length,
      blockedCount: records.filter((item) => item.status === 'BLOCKED').length,
      byModality: [...byModality.values()].sort((a, b) => b.totalCredits - a.totalCredits),
      items: records.map((record) => ({ id: record.id, projectId: record.project_id || null, projectTitle: record.project_title || null, courseLessonId: record.project_lesson_id || null, courseLessonTitle: record.lesson_title || null, classSessionId: record.class_session_id || null, className: record.class_name || null, modality: record.modality, model: record.model, credits: Number(record.credits_charged || 0), status: record.status, failCode: record.fail_code || null, createdAt: record.created_at })),
    },
  };
}

const STUDENT_AVATAR_KEYS = Object.freeze(['star', 'rocket', 'cat', 'fox', 'robot', 'panda', 'owl', 'whale']);
const GUARDIAN_RELATIONSHIPS = Object.freeze(['PARENT', 'GRANDPARENT', 'OTHER_GUARDIAN']);
const ACCOUNT_REQUEST_TYPES = Object.freeze(['DELETION', 'DATA_EXPORT']);

function assertCurrentPassword(ctx, value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw errors.badRequest('请输入当前密码', 'CURRENT_PASSWORD_REQUIRED');
  }
  const currentPassword = nonEmptyString(value, '当前密码', { max: 500 });
  if (!verifyPassword(currentPassword, ctx.auth.rawUser.password_hash)) {
    throw errors.badRequest('当前密码不正确', 'CURRENT_PASSWORD_INVALID');
  }
  return currentPassword;
}

function normalizeStudentAvatarKey(value) {
  if (value === undefined || value === null || value === '') return null;
  const avatarKey = String(value);
  if (!STUDENT_AVATAR_KEYS.includes(avatarKey)) throw errors.badRequest('请选择平台提供的头像', 'INVALID_AVATAR_KEY');
  return avatarKey;
}

function normalizeStudentGuardian(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw errors.badRequest('监护人信息无效', 'INVALID_GUARDIAN');
  const hasAny = ['name', 'phone', 'relationship', 'consent'].some((key) => Object.hasOwn(value, key));
  if (!hasAny) throw errors.badRequest('请完整填写监护人信息', 'GUARDIAN_INCOMPLETE');
  const name = nonEmptyString(value.name, '监护人姓名', { max: 60 });
  const phone = String(value.phone ?? '').trim();
  if (!/^[0-9+\-\s]{6,20}$/.test(phone)) throw errors.badRequest('监护人手机号格式无效', 'INVALID_GUARDIAN_PHONE');
  const relationship = String(value.relationship || '');
  if (!GUARDIAN_RELATIONSHIPS.includes(relationship)) throw errors.badRequest('请选择监护人与学生的关系', 'INVALID_GUARDIAN_RELATIONSHIP');
  if (value.consent !== true) throw errors.badRequest('需要监护人确认知晓并同意提供联系信息', 'GUARDIAN_CONSENT_REQUIRED');
  return { name, phone, relationship };
}

function accountRequestRow(item) {
  return {
    id: item.id,
    userId: item.user_id,
    orgId: item.org_id,
    type: item.type,
    reason: item.reason || null,
    status: item.status,
    requestedAt: item.requested_at,
    resolvedAt: item.resolved_at || null,
    resolvedBy: item.resolved_by || null,
    resolution: item.resolution || null,
    exportPayload: item.export_payload ? parseJson(item.export_payload, null) : null,
  };
}

function studentAccountRequests(userId, orgId) {
  const items = rows(
    'SELECT * FROM account_requests WHERE user_id = ? AND org_id = ? ORDER BY requested_at DESC LIMIT 100',
    [userId, orgId],
  ).map(accountRequestRow);
  return {
    items,
    pendingRequests: {
      deletion: items.some((item) => item.type === 'DELETION' && item.status === 'PENDING'),
      dataExport: items.some((item) => item.type === 'DATA_EXPORT' && item.status === 'PENDING'),
    },
  };
}

function studentAccountOverview(ctx) {
  const rawUser = row('SELECT * FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL', [ctx.auth.user.id, ctx.auth.user.orgId]);
  if (!rawUser) throw errors.notFound('学生账号不存在', 'STUDENT_NOT_FOUND');
  const sessions = rows('SELECT * FROM sessions WHERE user_id = ? AND org_id = ? AND superseded_at IS NULL AND expires_at > ? ORDER BY created_at DESC', [ctx.auth.user.id, ctx.auth.user.orgId, nowIso()]);
  const accountRequests = studentAccountRequests(ctx.auth.user.id, ctx.auth.user.orgId);
  return {
    user: normalizeUser(rawUser),
    organization: normalizeOrg(ctx.auth.org),
    classes: getStudentMemberships(rawUser).map((item) => ({ id: item.id, name: item.name, teacherName: item.teacher_name || null, usageMode: item.usage_mode, status: item.status, createdAt: item.created_at })),
    activeSessions: getStudentActiveSessions(rawUser).map((item) => ({ id: item.id, classId: item.class_id, lessonId: item.lesson_id, lessonTitle: item.lesson_title, status: item.status, startedAt: item.started_at })),
    sessions: sessions.map((item) => ({ id: item.id, clientType: item.client_type, createdAt: item.created_at, expiresAt: item.expires_at, current: item.id === ctx.auth.session.id })),
    currentSessionId: ctx.auth.session.id,
    profileOptions: {
      avatarKeys: [...STUDENT_AVATAR_KEYS],
      guardianRelationships: [...GUARDIAN_RELATIONSHIPS],
      dataMinimization: '平台只收集学习所需资料；不收集住址、身份证号和社交账号。监护人信息仅用于必要时联系，可随时清空。',
    },
    ...accountRequests,
    requests: accountRequests,
  };
}

function refreshStudentAccount(ctx, userId, orgId) {
  const rawUser = row('SELECT * FROM users WHERE id = ? AND org_id = ?', [userId, orgId]);
  return studentAccountOverview({ ...ctx, auth: { ...ctx.auth, rawUser } });
}

export async function handleStudent(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/student')) return null;
  const auth = requireRole(ctx, ['STUDENT']);
  const part = pathname.slice('/api/student'.length);

  if (part === '/dashboard' && method === 'GET') return buildStudentDashboard(auth.rawUser);
  if (part === '/courses' && method === 'GET') return studentCourseOverview(ctx);
  if (part === '/credits' && method === 'GET') return studentUsageOverview(ctx);
  if (part === '/account' && method === 'GET') return studentAccountOverview(ctx);

  if (part === '/account/profile' && method === 'PUT') {
    assertCurrentPassword(ctx, ctx.body?.currentPassword);
    const displayName = nonEmptyString(ctx.body?.displayName, '显示名称', { max: 60 });
    const avatarKey = normalizeStudentAvatarKey(ctx.body?.avatarKey);
    const before = { displayName: auth.user.displayName, avatarKey: auth.rawUser.avatar_key || null };
    q('UPDATE users SET display_name = ?, avatar_key = ?, updated_at = ? WHERE id = ? AND org_id = ?', [displayName, avatarKey, nowIso(), auth.user.id, auth.user.orgId]);
    audit(ctx, 'STUDENT_PROFILE_UPDATE', 'USER', auth.user.id, before, { displayName, avatarKey });
    return { ...refreshStudentAccount(ctx, auth.user.id, auth.user.orgId), updated: true };
  }

  if (part === '/account/guardian' && method === 'PUT') {
    assertCurrentPassword(ctx, ctx.body?.currentPassword);
    const guardian = normalizeStudentGuardian(ctx.body?.guardian);
    const before = {
      name: auth.rawUser.guardian_name || null,
      phone: auth.rawUser.guardian_phone || null,
      relationship: auth.rawUser.guardian_relationship || null,
      consentedAt: auth.rawUser.guardian_consented_at || null,
    };
    const now = nowIso();
    q(
      'UPDATE users SET guardian_name = ?, guardian_phone = ?, guardian_relationship = ?, guardian_consented_at = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      guardian ? [guardian.name, guardian.phone, guardian.relationship, now, now, auth.user.id, auth.user.orgId] : [null, null, null, null, now, auth.user.id, auth.user.orgId],
    );
    audit(ctx, 'STUDENT_GUARDIAN_UPDATE', 'USER', auth.user.id, before, guardian ? { ...guardian, consentedAt: now } : null);
    return { ...refreshStudentAccount(ctx, auth.user.id, auth.user.orgId), updated: true };
  }

  if (part === '/account/privacy' && method === 'PUT') {
    assertCurrentPassword(ctx, ctx.body?.currentPassword);
    if (!Object.hasOwn(ctx.body || {}, 'showcaseAnonymous') || typeof ctx.body.showcaseAnonymous !== 'boolean') throw errors.badRequest('作品墙匿名设置必须是布尔值', 'INVALID_PRIVACY_SETTING');
    if (!Object.hasOwn(ctx.body || {}, 'allowFeature') || typeof ctx.body.allowFeature !== 'boolean') throw errors.badRequest('精选授权设置必须是布尔值', 'INVALID_PRIVACY_SETTING');
    const before = { showcaseAnonymous: Boolean(auth.rawUser.privacy_showcase_anonymous), allowFeature: Boolean(auth.rawUser.privacy_allow_feature) };
    q('UPDATE users SET privacy_showcase_anonymous = ?, privacy_allow_feature = ?, updated_at = ? WHERE id = ? AND org_id = ?', [ctx.body.showcaseAnonymous ? 1 : 0, ctx.body.allowFeature ? 1 : 0, nowIso(), auth.user.id, auth.user.orgId]);
    audit(ctx, 'STUDENT_PRIVACY_UPDATE', 'USER', auth.user.id, before, { showcaseAnonymous: ctx.body.showcaseAnonymous, allowFeature: ctx.body.allowFeature });
    return { ...refreshStudentAccount(ctx, auth.user.id, auth.user.orgId), updated: true };
  }

  if (part === '/account/requests' && method === 'POST') {
    assertCurrentPassword(ctx, ctx.body?.currentPassword);
    const type = String(ctx.body?.type || '');
    if (!ACCOUNT_REQUEST_TYPES.includes(type)) throw errors.badRequest('账号申请类型无效', 'INVALID_ACCOUNT_REQUEST_TYPE');
    if (ctx.body?.confirmed !== true) throw errors.badRequest('请先确认知晓申请影响', 'ACCOUNT_REQUEST_CONFIRM_REQUIRED');
    const reason = String(ctx.body?.reason || '').trim();
    if (reason.length > 1000) throw errors.badRequest('申请原因不能超过 1000 个字符', 'ACCOUNT_REQUEST_REASON_TOO_LONG');
    const duplicate = row('SELECT id FROM account_requests WHERE user_id = ? AND org_id = ? AND type = ? AND status = ?', [auth.user.id, auth.user.orgId, type, 'PENDING']);
    if (duplicate) throw errors.conflict('你已提交过同类型的待处理申请', 'ACCOUNT_REQUEST_ALREADY_PENDING');
    const requestId = id('account_request');
    q('INSERT INTO account_requests(id,user_id,org_id,type,reason,status,requested_at) VALUES (?,?,?,?,?,?,?)', [requestId, auth.user.id, auth.user.orgId, type, reason || null, 'PENDING', nowIso()]);
    audit(ctx, 'STUDENT_ACCOUNT_REQUEST_CREATE', 'ACCOUNT_REQUEST', requestId, null, { type, reason: reason || null });
    return { ...refreshStudentAccount(ctx, auth.user.id, auth.user.orgId), request: accountRequestRow(row('SELECT * FROM account_requests WHERE id = ?', [requestId])) };
  }

  let accountRequestMatch = part.match(/^\/account\/requests\/([^/]+)$/);
  if (accountRequestMatch && method === 'GET') {
    const request = row('SELECT * FROM account_requests WHERE id = ? AND user_id = ? AND org_id = ?', [accountRequestMatch[1], auth.user.id, auth.user.orgId]);
    if (!request) throw errors.notFound('账号申请不存在', 'ACCOUNT_REQUEST_NOT_FOUND');
    return accountRequestRow(request);
  }

  accountRequestMatch = part.match(/^\/account\/requests\/([^/]+)\/cancel$/);
  if (accountRequestMatch && method === 'PUT') {
    assertCurrentPassword(ctx, ctx.body?.currentPassword);
    const request = row('SELECT * FROM account_requests WHERE id = ? AND user_id = ? AND org_id = ?', [accountRequestMatch[1], auth.user.id, auth.user.orgId]);
    if (!request) throw errors.notFound('账号申请不存在', 'ACCOUNT_REQUEST_NOT_FOUND');
    if (request.status !== 'PENDING') throw errors.conflict('申请已处理，不能撤销', 'ACCOUNT_REQUEST_ALREADY_HANDLED');
    q("UPDATE account_requests SET status = 'CANCELLED', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'PENDING'", [nowIso(), auth.user.id, request.id]);
    audit(ctx, 'STUDENT_ACCOUNT_REQUEST_CANCEL', 'ACCOUNT_REQUEST', request.id, accountRequestRow(request), { status: 'CANCELLED' });
    return { ...refreshStudentAccount(ctx, auth.user.id, auth.user.orgId), cancelled: true };
  }

  if (part === '/account/password' && method === 'PUT') {
    const currentPassword = nonEmptyString(ctx.body?.currentPassword, '当前密码', { max: 500 });
    const newPassword = validStudentPassword(ctx.body?.newPassword);
    if (!verifyPassword(currentPassword, auth.rawUser.password_hash)) throw errors.badRequest('当前密码不正确', 'CURRENT_PASSWORD_INVALID');
    if (verifyPassword(newPassword, auth.rawUser.password_hash)) throw errors.badRequest('新密码不能与当前密码相同', 'PASSWORD_UNCHANGED');
    const now = nowIso();
    let sessionsRevoked = 0;
    transaction(() => {
      q('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND org_id = ?', [hashPassword(newPassword), now, auth.user.id, auth.user.orgId]);
      sessionsRevoked = q('UPDATE sessions SET superseded_at = ? WHERE user_id = ? AND org_id = ? AND superseded_at IS NULL', [now, auth.user.id, auth.user.orgId]).changes;
    });
    audit(ctx, 'STUDENT_PASSWORD_CHANGE', 'USER', auth.user.id, null, { sessionsRevoked });
    ctx.setCookie = clearAuthCookie();
    return { passwordChanged: true, sessionsRevoked, reloginRequired: true };
  }

  const sessionMatch = part.match(/^\/account\/sessions\/([^/]+)\/revoke$/);
  if (sessionMatch && method === 'PUT') {
    assertCurrentPassword(ctx, ctx.body?.currentPassword);
    const session = row('SELECT * FROM sessions WHERE id = ? AND user_id = ? AND org_id = ?', [sessionMatch[1], auth.user.id, auth.user.orgId]);
    if (!session) throw errors.notFound('登录会话不存在', 'SESSION_NOT_FOUND');
    if (session.superseded_at || session.expires_at <= nowIso()) throw errors.conflict('登录会话已失效', 'SESSION_ALREADY_INVALID');
    q('UPDATE sessions SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL', [nowIso(), session.id]);
    audit(ctx, 'STUDENT_SESSION_REVOKE', 'SESSION', session.id);
    const current = session.id === ctx.auth.session.id;
    if (current) ctx.setCookie = clearAuthCookie();
    return { revoked: true, id: session.id, reloginRequired: current };
  }

  if (part === '/projects' && method === 'GET') {
    const view = ctx.search.get('view') || 'ACTIVE';
    if (!['ACTIVE', 'ARCHIVED', 'DELETED'].includes(view)) throw errors.badRequest('无效的项目视图', 'INVALID_PROJECT_VIEW');
    const status = ctx.search.get('status');
    if (status && !['DRAFT', 'SUBMITTED', 'GRADED', 'ARCHIVED'].includes(status)) throw errors.badRequest('无效的项目状态', 'INVALID_PROJECT_STATUS');
    if (view !== 'ACTIVE' && status === 'ARCHIVED') throw errors.badRequest('归档视图无需重复按归档状态筛选', 'INVALID_PROJECT_FILTER');

    const params = [auth.user.id, auth.user.orgId];
    let where = 'project.student_id = ? AND project.org_id = ?';
    if (view === 'DELETED') {
      where += " AND project.status = 'ARCHIVED' AND project.deleted_at IS NOT NULL";
    } else if (view === 'ARCHIVED') {
      where += " AND project.status = 'ARCHIVED' AND project.deleted_at IS NULL";
    } else {
      where += " AND project.status != 'ARCHIVED' AND project.deleted_at IS NULL";
    }
    if (view === 'ACTIVE' && status) {
      where += ' AND project.status = ?';
      params.push(status);
    }

    const keyword = String(ctx.search.get('search') || '').trim().slice(0, 100);
    if (keyword) {
      where += " AND (project.title LIKE ? ESCAPE '\\' OR lesson.title LIKE ? ESCAPE '\\' OR series.title LIKE ? ESCAPE '\\')";
      const escaped = '%' + keyword.replace(/[\\%_]/g, (char) => '\\' + char) + '%';
      params.push(escaped, escaped, escaped);
    }
    const seriesId = ctx.search.get('seriesId');
    if (seriesId) { where += ' AND series.id = ?'; params.push(seriesId); }
    const classId = ctx.search.get('classId');
    if (classId) { where += ' AND project.class_id = ?'; params.push(classId); }
    const lessonId = ctx.search.get('lessonId');
    if (lessonId) { where += ' AND project.course_lesson_id = ?'; params.push(lessonId); }

    const items = rows(
      `SELECT project.*, lesson.title AS lesson_title,
              series.id AS series_id, series.title AS series_title,
              class.name AS class_name,
              work.id AS work_id, work.status AS work_status, work.submitted_at AS work_submitted_at
       FROM student_projects project
       LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
       LEFT JOIN course_series series ON series.id = lesson.series_id
       LEFT JOIN classes class ON class.id = project.class_id
       LEFT JOIN works work ON work.project_id = project.id
       WHERE ${where}
       ORDER BY project.updated_at DESC LIMIT 200`,
      params,
    ).map((project) => normalizeProject(project));
    return { items, view };
  }
  if (part === '/projects' && method === 'POST') {
    const courseLessonId = nonEmptyString(ctx.body?.courseLessonId, '课时', { max: 100 });
    const lessonContext = resolveStudentLessonContext(auth.rawUser, courseLessonId, ctx.body?.classId || null);
    if (!lessonContext.canUseNow) throw errors.forbidden(lessonContext.blockReason, lessonContext.blockCode);
    const now = nowIso();
    const projectId = id('project');
    const title = ctx.body?.title === undefined || String(ctx.body.title).trim() === ''
      ? `${lessonContext.lesson.title}作品`
      : nonEmptyString(ctx.body.title, '项目名称', { max: 100 });
    const snapshot = normalizeCanvasSnapshot(ctx.body?.canvasSnapshot);
    transaction(() => {
      q(
        `INSERT INTO student_projects(
          id,student_id,org_id,class_id,course_lesson_id,title,status,canvas_snapshot,
          latest_version,last_saved_at,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [projectId, auth.user.id, auth.user.orgId, lessonContext.class.id, lessonContext.lesson.id, title, 'DRAFT', json(snapshot), 1, now, now, now],
      );
      q(
        `INSERT INTO project_snapshots(id,project_id,version,label,canvas_snapshot,actor_id,created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [id('snapshot'), projectId, 1, '初始版本', json(snapshot), auth.user.id, now],
      );
    });
    audit(ctx, 'PROJECT_CREATE', 'STUDENT_PROJECT', projectId, null, { classId: lessonContext.class.id, courseLessonId, title });
    return normalizeProject(fetchProject(ctx, projectId), { includeSnapshot: true });
  }

  let match = part.match(/^\/projects\/([^/]+)$/);
  if (match && method === 'GET') return normalizeProject(getOwnProject(ctx, match[1]), { includeSnapshot: true });

  if (match && method === 'PUT') {
    const project = getOwnProject(ctx, match[1]);
    assertProjectUsable(ctx, project);
    const body = ctx.body || {};
    if (body.title === undefined && body.canvasSnapshot === undefined && body.label === undefined) {
      throw errors.badRequest('请提交需要保存的项目内容', 'NO_PROJECT_CHANGES');
    }
    const now = nowIso();
    const title = body.title === undefined ? project.title : nonEmptyString(body.title, '项目名称', { max: 100 });
    const snapshot = body.canvasSnapshot === undefined ? null : normalizeCanvasSnapshot(body.canvasSnapshot);
    let nextVersion = Number(project.latest_version || 1);
    transaction(() => {
      const fresh = getOwnProject(ctx, project.id);
      assertProjectUsable(ctx, fresh);
      if (snapshot) {
        nextVersion = Number(fresh.latest_version || 1) + 1;
        q(
          `UPDATE student_projects SET title=?,canvas_snapshot=?,latest_version=?,last_saved_at=?,updated_at=?
           WHERE id=? AND student_id=? AND org_id=? AND status='DRAFT'`,
          [title, json(snapshot), nextVersion, now, now, fresh.id, auth.user.id, auth.user.orgId],
        );
        q(
          `INSERT INTO project_snapshots(id,project_id,version,label,canvas_snapshot,actor_id,created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [id('snapshot'), fresh.id, nextVersion, body.label ? String(body.label).slice(0, 100) : `版本 ${nextVersion}`, json(snapshot), auth.user.id, now],
        );
      } else {
        q(
          "UPDATE student_projects SET title=?,updated_at=? WHERE id=? AND student_id=? AND org_id=? AND status='DRAFT'",
          [title, now, fresh.id, auth.user.id, auth.user.orgId],
        );
      }
    });
    audit(ctx, 'PROJECT_SAVE', 'STUDENT_PROJECT', project.id, { latestVersion: project.latest_version }, { title, latestVersion: nextVersion, hasCanvasSnapshot: Boolean(snapshot) });
    return normalizeProject(fetchProject(ctx, project.id), { includeSnapshot: true });
  }

  if (match && method === 'PATCH') {
    const project = getOwnProject(ctx, match[1]);
    const title = nonEmptyString(ctx.body?.title, '项目名称', { max: 100 });
    if (project.status !== 'DRAFT') throw errors.conflict('已提交或已评分项目不能重命名', 'PROJECT_NOT_RENAMABLE');
    const now = nowIso();
    q(
      "UPDATE student_projects SET title=?,updated_at=? WHERE id=? AND student_id=? AND org_id=? AND status='DRAFT' AND deleted_at IS NULL",
      [title, now, project.id, auth.user.id, auth.user.orgId],
    );
    audit(ctx, 'PROJECT_RENAME', 'STUDENT_PROJECT', project.id, { title: project.title }, { title });
    return normalizeProject(fetchProject(ctx, project.id), { includeSnapshot: true });
  }

  if (match && method === 'POST') {
    if (!ctx.body || ctx.body.action !== 'copy') throw errors.badRequest('不支持的项目操作', 'UNSUPPORTED_PROJECT_ACTION');
    const project = getOwnProject(ctx, match[1]);
    if (project.work_status === 'PUBLISHED') throw errors.conflict('已发布作品不能复制为可编辑草稿', 'PUBLISHED_WORK_NOT_COPYABLE');
    if (!project.canvas_snapshot) throw errors.conflict('项目画布内容缺失，不能复制', 'PROJECT_SNAPSHOT_REQUIRED');
    const usageContext = resolveProjectUsageContext(auth.rawUser, project);
    if (!usageContext.canUseNow) throw errors.forbidden(usageContext.blockReason, usageContext.blockCode);
    const now = nowIso();
    const projectId = id('project');
    const title = `${String(project.title).slice(0, 96)} 副本`;
    transaction(() => {
      q(
        `INSERT INTO student_projects(
          id,student_id,org_id,class_id,course_lesson_id,title,status,canvas_snapshot,
          latest_version,last_saved_at,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [projectId, auth.user.id, auth.user.orgId, project.class_id, project.course_lesson_id, title, 'DRAFT', project.canvas_snapshot, 1, now, now, now],
      );
      q(
        `INSERT INTO project_snapshots(id,project_id,version,label,canvas_snapshot,actor_id,created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [id('snapshot'), projectId, 1, `复制自《${project.title}》`, project.canvas_snapshot, auth.user.id, now],
      );
    });
    audit(ctx, 'PROJECT_COPY', 'STUDENT_PROJECT', projectId, null, { sourceProjectId: project.id, sourceVersion: Number(project.latest_version || 0), title });
    return normalizeProject(fetchProject(ctx, projectId), { includeSnapshot: true });
  }

  if (match && method === 'DELETE') {
    const view = ctx.search.get('view');
    const includeArchived = view === 'ARCHIVED' || view === 'DELETED';
    const project = getOwnProject(ctx, match[1], { includeArchived });
    const action = ctx.search.get('mode') || 'ARCHIVE';
    if (!['ARCHIVE', 'DELETE'].includes(action)) throw errors.badRequest('无效的删除模式', 'INVALID_PROJECT_DELETE_MODE');
    if (action === 'DELETE') {
      if (project.status !== 'DRAFT' && !(project.status === 'ARCHIVED' && !project.deleted_at)) {
        throw errors.conflict('已提交或已评分项目不能删除', 'PROJECT_NOT_DELETABLE');
      }
    } else if (project.status !== 'DRAFT') {
      throw errors.conflict('已提交或已评分项目不能删除', 'PROJECT_NOT_DELETABLE');
    }
    const now = nowIso();

    if (action === 'DELETE') {
      const restoreDeadline = new Date(new Date(now).getTime() + PROJECT_DELETE_RESTORE_DAYS * 86400_000).toISOString();
      q(
        "UPDATE student_projects SET status='ARCHIVED',archived_at=COALESCE(archived_at,?),deleted_at=?,updated_at=? WHERE id=? AND student_id=? AND org_id=? AND status='DRAFT' AND deleted_at IS NULL",
        [now, now, now, project.id, auth.user.id, auth.user.orgId],
      );
      audit(ctx, 'PROJECT_SOFT_DELETE', 'STUDENT_PROJECT', project.id, { title: project.title }, { restoreDeadline });
      return { deleted: true, id: project.id, restoreDays: PROJECT_DELETE_RESTORE_DAYS, restoreDeadline };
    }
    q(
      "UPDATE student_projects SET status='ARCHIVED',archived_at=?,updated_at=? WHERE id=? AND student_id=? AND org_id=? AND status='DRAFT' AND deleted_at IS NULL",
      [now, now, project.id, auth.user.id, auth.user.orgId],
    );
    audit(ctx, 'PROJECT_ARCHIVE', 'STUDENT_PROJECT', project.id);
    return { archived: true, id: project.id };
  }
  match = part.match(/^\/projects\/([^/]+)\/snapshots$/);
  if (match && method === 'GET') {
    const project = getOwnProject(ctx, match[1]);
    const items = rows(
      `SELECT snapshot.id, snapshot.project_id, snapshot.version, snapshot.label,
              snapshot.actor_id, snapshot.created_at, actor.display_name AS actor_name
       FROM project_snapshots snapshot
       LEFT JOIN users actor ON actor.id = snapshot.actor_id
       WHERE snapshot.project_id = ?
       ORDER BY snapshot.version DESC`,
      [project.id],
    );
    return {
      items: items.map((snapshot) => ({
        id: snapshot.id,
        projectId: snapshot.project_id,
        version: Number(snapshot.version),
        label: snapshot.label || null,
        actorId: snapshot.actor_id,
        actorName: snapshot.actor_name || null,
        createdAt: snapshot.created_at,
      })),
    };
  }

  match = part.match(/^\/projects\/([^/]+)\/snapshots\/(\d+)$/);
  if (match && method === 'PUT') {
    const project = getOwnProject(ctx, match[1]);
    assertDraft(project);
    const version = Number(match[2]);
    const label = nonEmptyString(ctx.body?.label, '版本名称', { max: 100 });
    const snapshot = row('SELECT * FROM project_snapshots WHERE project_id = ? AND version = ?', [project.id, version]);
    if (!snapshot) throw errors.notFound('项目版本不存在', 'PROJECT_SNAPSHOT_NOT_FOUND');
    q('UPDATE project_snapshots SET label = ? WHERE project_id = ? AND version = ?', [label, project.id, version]);
    audit(ctx, 'PROJECT_SNAPSHOT_LABEL', 'PROJECT_SNAPSHOT', snapshot.id, { label: snapshot.label || null }, { label, version });
    return {
      id: snapshot.id,
      projectId: snapshot.project_id,
      version,
      label,
      actorId: snapshot.actor_id,
      createdAt: snapshot.created_at,
    };
  }

  if (match && method === 'GET') {
    const project = getOwnProject(ctx, match[1]);
    const snapshot = row('SELECT * FROM project_snapshots WHERE project_id = ? AND version = ?', [project.id, Number(match[2])]);
    if (!snapshot) throw errors.notFound('项目版本不存在', 'PROJECT_SNAPSHOT_NOT_FOUND');
    return {
      id: snapshot.id, projectId: snapshot.project_id, version: Number(snapshot.version), label: snapshot.label || null,
      canvasSnapshot: JSON.parse(snapshot.canvas_snapshot), actorId: snapshot.actor_id, createdAt: snapshot.created_at,
    };
  }

  match = part.match(/^\/projects\/([^/]+)\/archive$/);
  if (match && method === 'POST') {
    const project = getOwnProject(ctx, match[1]);
    if (project.status !== 'DRAFT') throw errors.conflict('已提交或已评分项目不能归档', 'PROJECT_NOT_ARCHIVABLE');
    const now = nowIso();
    q(
      "UPDATE student_projects SET status='ARCHIVED',archived_at=?,updated_at=? WHERE id=? AND student_id=? AND org_id=? AND status='DRAFT' AND deleted_at IS NULL",
      [now, now, project.id, auth.user.id, auth.user.orgId],
    );
    audit(ctx, 'PROJECT_ARCHIVE', 'STUDENT_PROJECT', project.id, { status: project.status }, { status: 'ARCHIVED' });
    return { archived: true, id: project.id };
  }

  match = part.match(/^\/projects\/([^/]+)\/restore$/);
  if (match && method === 'POST') {
    const project = getOwnProject(ctx, match[1], { includeArchived: true, includeDeleted: true });
    if (project.status !== 'ARCHIVED') throw errors.conflict('只有归档或已删除草稿可以恢复', 'PROJECT_NOT_RESTORABLE');
    const now = nowIso();
    if (project.deleted_at) {
      const deadline = new Date(new Date(project.deleted_at).getTime() + PROJECT_DELETE_RESTORE_DAYS * 86400_000);
      if (deadline.getTime() <= Date.now()) throw errors.conflict('项目已超过 30 天恢复期，不能恢复', 'PROJECT_RESTORE_EXPIRED');
      q(
        "UPDATE student_projects SET deleted_at=NULL,status='DRAFT',updated_at=? WHERE id=? AND student_id=? AND org_id=? AND status='ARCHIVED'",
        [now, project.id, auth.user.id, auth.user.orgId],
      );
      audit(ctx, 'PROJECT_RESTORE', 'STUDENT_PROJECT', project.id, { deletedAt: project.deleted_at }, { status: 'DRAFT' });
      return normalizeProject(fetchProject(ctx, project.id, { includeDeleted: true }), { includeSnapshot: true });
    }
    q(
      "UPDATE student_projects SET status='DRAFT',archived_at=NULL,updated_at=? WHERE id=? AND student_id=? AND org_id=? AND status='ARCHIVED' AND deleted_at IS NULL",
      [now, project.id, auth.user.id, auth.user.orgId],
    );
    audit(ctx, 'PROJECT_RESTORE', 'STUDENT_PROJECT', project.id, { status: 'ARCHIVED' }, { status: 'DRAFT' });
    return normalizeProject(fetchProject(ctx, project.id, { includeDeleted: true }), { includeSnapshot: true });
  }
  match = part.match(/^\/projects\/([^/]+)\/submit$/);
  if (match && method === 'POST') {
    const project = getOwnProject(ctx, match[1]);
    if (project.status !== 'DRAFT') {
      throw errors.conflict('项目已提交，不能重复提交', 'ALREADY_SUBMITTED');
    }
    assertProjectUsable(ctx, project);
    if (ctx.body?.copyrightConfirmed !== true) {
      throw errors.badRequest('提交前请确认作品版权与机构内展示授权', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    }
    const now = nowIso();
    const description = String(ctx.body?.description || '').trim().slice(0, 1000);
    let canvasSnapshot = JSON.parse(project.canvas_snapshot);
    let latestVersion = Number(project.latest_version || 1);
    const requestedSnapshot = ctx.body?.canvasSnapshot === undefined ? null : normalizeCanvasSnapshot(ctx.body.canvasSnapshot);
    let workId = id('work');
    let round = 1;
    let resubmission = false;
    transaction(() => {
      const fresh = getOwnProject(ctx, project.id);
      if (fresh.status !== 'DRAFT') throw errors.conflict('项目已提交，不能重复提交', 'ALREADY_SUBMITTED');
      assertProjectUsable(ctx, fresh);
      const existingWork = row('SELECT * FROM works WHERE project_id=? AND student_id=? AND org_id=?', [fresh.id, auth.user.id, auth.user.orgId]);
      if (requestedSnapshot) {
        canvasSnapshot = requestedSnapshot;
        latestVersion = Number(fresh.latest_version || 1) + 1;
        q(
          `UPDATE student_projects SET status='SUBMITTED',canvas_snapshot=?,latest_version=?,last_saved_at=?,updated_at=?
           WHERE id=? AND student_id=? AND org_id=? AND status='DRAFT'`,
          [json(canvasSnapshot), latestVersion, now, now, fresh.id, auth.user.id, auth.user.orgId],
        );
        q(
          `INSERT INTO project_snapshots(id,project_id,version,label,canvas_snapshot,actor_id,created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [id('snapshot'), fresh.id, latestVersion, '提交版本', json(canvasSnapshot), auth.user.id, now],
        );
      } else {
        q(
          "UPDATE student_projects SET status='SUBMITTED',updated_at=? WHERE id=? AND student_id=? AND org_id=? AND status='DRAFT'",
          [now, fresh.id, auth.user.id, auth.user.orgId],
        );
      }
      if (existingWork) {
        resubmission = true;
        const latestSubmission = row('SELECT round FROM work_submissions WHERE work_id=? ORDER BY round DESC LIMIT 1', [existingWork.id]);
        round = Number(latestSubmission?.round || 0) + 1;
        q(
          `UPDATE works SET title=?,description=?,canvas_snapshot=?,status='PENDING',teacher_comment=NULL,reviewed_by=NULL,reviewed_at=NULL,
             featured_at=NULL,featured_by=NULL,featured_reason=NULL,submitted_at=?
           WHERE id=? AND project_id=? AND student_id=? AND org_id=?`,
          [fresh.title, description, json(canvasSnapshot), now, existingWork.id, fresh.id, auth.user.id, auth.user.orgId],
        );
        workId = existingWork.id;
      } else {
        q(
          `INSERT INTO works(
            id,project_id,student_id,org_id,class_id,course_lesson_id,title,description,canvas_snapshot,status,copyright_confirmed_at,copyright_confirmed_by,submitted_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [workId, fresh.id, auth.user.id, fresh.org_id, fresh.class_id, fresh.course_lesson_id, fresh.title, description, json(canvasSnapshot), 'PENDING', now, auth.user.id, now],
        );
      }
      q(
        `INSERT INTO work_submissions(
          id,work_id,project_id,student_id,org_id,round,title,description,canvas_snapshot,snapshot_version,submitted_at,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id('submission'), workId, fresh.id, auth.user.id, fresh.org_id, round, fresh.title, description, json(canvasSnapshot), latestVersion, now, now, now],
      );
    });
    audit(ctx, 'PROJECT_SUBMIT', 'WORK', workId, { projectId: project.id, round, resubmission }, { description, round, resubmission });
    return {
      project: normalizeProject(fetchProject(ctx, project.id), { includeSnapshot: true }),
      work: decorateWork(normalizeWork(fetchWork(ctx, workId), { includeSnapshot: true }), ctx, { includeSubmissions: true }),
    };
  }

  match = part.match(/^\/works\/([^/]+)\/submissions$/);
  if (match && method === 'GET') {
    const work = getOwnWork(ctx, match[1]);
    return { items: workSubmissionRows(work.id).get(work.id) || [], submissionRound: currentSubmissionRound(work.id) };
  }

  match = part.match(/^\/works\/([^/]+)\/annotations$/);
  if (match && method === 'GET') {
    const work = getOwnWork(ctx, match[1]);
    const items = annotationRowsForStudent(work.id, ctx.auth.user.id, ctx.auth.user.orgId);
    return {
      items,
      unreadCount: items.filter((item) => !item.readAt).length,
      submissionRound: currentSubmissionRound(work.id),
    };
  }

  match = part.match(/^\/works\/([^/]+)\/feedback-read$/);
  if (match && method === 'POST') {
    const work = getOwnWork(ctx, match[1]);
    const bodyIds = Array.isArray(ctx.body?.annotationIds) ? ctx.body.annotationIds : null;
    let annotationIds = bodyIds ? [...new Set(bodyIds.map((value) => String(value || '').trim()).filter(Boolean))] : null;
    // 空数组与缺省字段语义一致，都表示读取整体点评；学生端“标记已读”使用空数组。
    if (annotationIds && annotationIds.length === 0) annotationIds = null;
    if (annotationIds && annotationIds.length > 100) throw errors.badRequest('单次最多标记 100 条点评已读', 'ANNOTATION_READ_BATCH_TOO_LARGE');
    const round = currentSubmissionRound(work.id);
    const now = nowIso();
    transaction(() => {
      if (!annotationIds) {
        q(
          `INSERT INTO work_feedback_reads(id,work_id,student_id,annotation_id,submission_round,read_at)
           SELECT ?,?,?,?,?,? FROM works
           WHERE id=? AND student_id=? AND org_id=?
             AND teacher_comment IS NOT NULL AND teacher_comment != ''
             AND NOT EXISTS (
               SELECT 1 FROM work_feedback_reads existing
               WHERE existing.work_id=? AND existing.student_id=? AND existing.annotation_id IS NULL
                 AND existing.submission_round=?
             )`,
          [id('read'), work.id, ctx.auth.user.id, null, round, now, work.id, ctx.auth.user.id, ctx.auth.user.orgId, work.id, ctx.auth.user.id, round],
        );
      } else {
        for (const annotationId of annotationIds) {
          const annotation = row('SELECT id FROM work_annotations WHERE id=? AND work_id=? AND org_id=?', [annotationId, work.id, ctx.auth.user.orgId]);
          if (!annotation) throw errors.notFound('画布点评不存在', 'ANNOTATION_NOT_FOUND');
          const existingRead = row(
            'SELECT id FROM work_feedback_reads WHERE annotation_id=? AND student_id=?',
            [annotationId, ctx.auth.user.id],
          );
          if (existingRead) {
            q('UPDATE work_feedback_reads SET read_at=?,updated_at=read_at WHERE id=?', [now, existingRead.id]);
          } else {
            q(
              `INSERT INTO work_feedback_reads(id,work_id,student_id,annotation_id,submission_round,read_at)
               VALUES (?,?,?,?,?,?)`,
              [id('read'), work.id, ctx.auth.user.id, annotationId, round, now],
            );
          }
        }
      }
    });
    audit(ctx, 'WORK_FEEDBACK_READ', 'WORK', work.id, null, { annotationIds: annotationIds || [], submissionRound: round });
    const items = annotationRowsForStudent(work.id, ctx.auth.user.id, ctx.auth.user.orgId);
    const overallRead = Boolean(row(
      'SELECT id FROM work_feedback_reads WHERE work_id=? AND student_id=? AND annotation_id IS NULL AND submission_round=?',
      [work.id, ctx.auth.user.id, round],
    ));
    const unreadCount = items.filter((item) => !item.readAt).length + (work.teacher_comment && !overallRead ? 1 : 0);
    return { ok: true, unreadCount, submissionRound: round, overallRead };
  }

  match = part.match(/^\/works\/([^/]+)\/publish-request\/withdraw$/);
  if (match && method === 'POST') {
    const work = getOwnWork(ctx, match[1]);
    const requestRow = row("SELECT * FROM work_publish_requests WHERE work_id=? AND student_id=? AND org_id=? AND status='PENDING' ORDER BY requested_at DESC LIMIT 1", [work.id, ctx.auth.user.id, work.org_id]);
    if (!requestRow) throw errors.notFound('没有可撤回的发布申请', 'WORK_PUBLISH_REQUEST_NOT_FOUND');
    const now = nowIso();
    q(
      "UPDATE work_publish_requests SET status='WITHDRAWN',resolved_at=?,resolved_by=?,resolution='学生撤回',updated_at=? WHERE id=? AND status='PENDING'",
      [now, ctx.auth.user.id, now, requestRow.id],
    );
    audit(ctx, 'WORK_PUBLISH_REQUEST_WITHDRAW', 'WORK_PUBLISH_REQUEST', requestRow.id, normalizeWorkPublishRequest(requestRow), null);
    return normalizeWorkPublishRequest(row('SELECT * FROM work_publish_requests WHERE id=?', [requestRow.id]));
  }

  match = part.match(/^\/works\/([^/]+)\/publish-request$/);
  if (match && method === 'POST') {
    const work = getOwnWork(ctx, match[1]);
    if (work.status !== 'APPROVED') {
      throw errors.conflict('作品通过审核后才能申请发布', 'WORK_NOT_APPROVED_FOR_PUBLISH_REQUEST');
    }
    if (!work.copyright_confirmed_at) throw errors.conflict('请先确认作品版权与机构内展示授权', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    const pending = row("SELECT id FROM work_publish_requests WHERE work_id=? AND status='PENDING'", [work.id]);
    if (pending) throw errors.conflict('该作品已有待处理的发布申请', 'WORK_PUBLISH_REQUEST_ALREADY_PENDING');
    const reason = String(ctx.body?.reason || '').trim();
    if (reason.length > 1000) throw errors.badRequest('申请说明不能超过 1000 个字符', 'WORK_PUBLISH_REQUEST_REASON_TOO_LONG');
    const round = currentSubmissionRound(work.id);
    const requestId = id('publish_request');
    const now = nowIso();
    q(
      `INSERT INTO work_publish_requests(
        id,work_id,project_id,student_id,org_id,round,status,reason,requested_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [requestId, work.id, work.project_id, ctx.auth.user.id, work.org_id, round, 'PENDING', reason, now, now, now],
    );
    audit(ctx, 'WORK_PUBLISH_REQUEST_CREATE', 'WORK_PUBLISH_REQUEST', requestId, null, { workId: work.id, round, reason });
    return normalizeWorkPublishRequest(row('SELECT * FROM work_publish_requests WHERE id=?', [requestId]));
  }
  match = part.match(/^\/works\/([^/]+)\/annotations$/);
  if (match && method === 'GET') {
    const work = row('SELECT id FROM works WHERE id=? AND student_id=? AND org_id=?', [match[1], auth.user.id, auth.user.orgId]);
    if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
    const items = rows(
      `SELECT annotation.*, author.display_name AS author_name, resolver.display_name AS resolver_name
       FROM work_annotations annotation
       JOIN users author ON author.id=annotation.author_id
       LEFT JOIN users resolver ON resolver.id=annotation.resolved_by
       WHERE annotation.work_id=? AND annotation.org_id=?
       ORDER BY annotation.created_at DESC`,
      [work.id, auth.user.orgId],
    ).map((annotation) => ({
      id: annotation.id, workId: annotation.work_id, nodeId: annotation.node_id || null, content: annotation.content,
      authorId: annotation.author_id, authorName: annotation.author_name || '教师', createdAt: annotation.created_at,
      resolvedAt: annotation.resolved_at || null, resolvedBy: annotation.resolved_by || null, resolverName: annotation.resolver_name || null,
    }));
    return { items };
  }

  match = part.match(/^\/works\/([^/]+)$/);
  if (match && method === 'GET') {
    const work = row(
      `SELECT work.*, class.name AS class_name, lesson.title AS lesson_title, reviewer.display_name AS reviewer_name
       FROM works work
       LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
       LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id
       LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by
       WHERE work.id=? AND work.student_id=? AND work.org_id=?`,
      [match[1], auth.user.id, auth.user.orgId],
    );
    if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
    return decorateWork(normalizeWork(work, { includeSnapshot: true }), ctx, { includeSubmissions: true });
  }

  if (part === '/showcase' && method === 'GET') {
    const search = String(ctx.search.get('search') || '').trim().slice(0, 100);
    const featuredOnly = ctx.search.get('featured') === 'true';
    const classId = String(ctx.search.get('classId') || '').trim();
    const lessonId = String(ctx.search.get('lessonId') || '').trim();
    const page = asPositiveInteger(ctx.search.get('page'), '页码', { min: 1, max: 1000, fallback: 1 });
    const pageSize = asPositiveInteger(ctx.search.get('pageSize'), '每页数量', { min: 1, max: 24, fallback: 9 });
    const conditions = ["work.org_id=?", "work.status='PUBLISHED'"]; const params = [auth.user.orgId];
    if (featuredOnly) conditions.push('work.featured_at IS NOT NULL');
    if (classId) conditions.push('work.class_id=?'), params.push(classId);
    if (lessonId) conditions.push('work.course_lesson_id=?'), params.push(lessonId);
    if (search) {
      const keyword = '%' + search.replace(new RegExp(`[%\\_]`, 'g'), (char) => '\\' + char) + '%';
      conditions.push("work.title LIKE ? ESCAPE '\\' OR work.description LIKE ? ESCAPE '\\' OR lesson.title LIKE ? ESCAPE '\\'"); params.push(keyword, keyword, keyword);
    }
    const publicName = (value, anonymous) => {
      const name = String(value || '').trim();
      if (anonymous) return '小创作者';
      return name ? name.slice(0, 1) + '同学' : '小创作者';
    };
    const where = conditions.join(' AND ');
    const total = Number(row(`SELECT COUNT(1) AS total FROM works work LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id WHERE ${where}`, params).total || 0);
    const filterOptions = rows(
      `SELECT class.id AS class_id, class.name AS class_name, lesson.id AS lesson_id, lesson.title AS lesson_title, lesson.sort AS lesson_sort, COUNT(work.id) AS work_count
       FROM works work
       JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id
       LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
       LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id
       WHERE work.org_id=? AND work.status='PUBLISHED'
       GROUP BY class.id, lesson.id
       ORDER BY class.name, lesson.sort, lesson.title`,
      [auth.user.orgId],
    );
    const classes = filterOptions
      .filter((item) => item.class_id)
      .reduce((accumulator, item) => {
        if (!accumulator.some((existing) => existing.id === item.class_id)) accumulator.push({ id: item.class_id, name: item.class_name, workCount: Number(item.work_count || 0) });
        return accumulator;
      }, [])
      .map((item) => ({ ...item, workCount: filterOptions.filter((option) => option.class_id === item.id).reduce((sum, option) => sum + Number(option.work_count || 0), 0) }));
    const lessons = filterOptions
      .filter((item) => item.lesson_id && (!classId || item.class_id === classId))
      .reduce((accumulator, item) => {
        const existing = accumulator.find((existingItem) => existingItem.id === item.lesson_id);
        if (existing) existing.workCount += Number(item.work_count || 0);
        else accumulator.push({ id: item.lesson_id, title: item.lesson_title, workCount: Number(item.work_count || 0) });
        return accumulator;
      }, []);
    const items = rows(
      `SELECT work.*, student.display_name AS student_name, student.privacy_showcase_anonymous AS student_anonymous, class.name AS class_name, lesson.title AS lesson_title
       FROM works work
       JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id
       LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
       LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id
       WHERE ${where}
       ORDER BY CASE WHEN work.featured_at IS NULL THEN 1 ELSE 0 END, work.featured_at DESC, work.reviewed_at DESC, work.submitted_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    ).map((work) => {
      const normalized = normalizeWork(work, { includeSnapshot: false });
      return {
        ...normalized,
        studentName: publicName(work.student_name, !!work.student_anonymous),
        studentId: undefined,
        projectId: undefined,
        teacherComment: undefined,
        reviewedBy: undefined,
        reviewerName: undefined,
        featuredBy: undefined,
      };
    });
    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      filters: { classes, lessons, featuredOnly },
      sharing: {
        scope: 'ORGANIZATION',
        allowPublicShare: false,
        allowComments: false,
        allowLikes: false,
        title: '仅机构内可见',
        description: '作品只在当前机构的登录学生之间展示；不生成站外公开链接，也不显示学生完整姓名。',
      },
    };
  }

  match = part.match(/^\/showcase\/([^/]+)\/reports$/);
  if (match && method === 'POST') {
    const work = row("SELECT * FROM works WHERE id=? AND org_id=? AND status='PUBLISHED'", [match[1], auth.user.orgId]);
    if (!work) throw errors.notFound('已发布作品不存在', 'SHOWCASE_WORK_NOT_FOUND');
    if (work.student_id === auth.user.id) throw errors.forbidden('不能举报自己的作品', 'CANNOT_REPORT_OWN_WORK');
    const category = String(ctx.body?.category || '');
    if (!['INAPPROPRIATE', 'COPYRIGHT', 'PRIVACY', 'OTHER'].includes(category)) throw errors.badRequest('举报类型无效', 'INVALID_WORK_REPORT_CATEGORY');
    const details = String(ctx.body?.details || '').trim();
    if (details.length > 1000) throw errors.badRequest('举报说明不能超过 1000 个字符', 'WORK_REPORT_DETAILS_TOO_LONG');
    const duplicate = row("SELECT id FROM work_reports WHERE work_id=? AND reporter_id=? AND status='PENDING'", [work.id, auth.user.id]);
    if (duplicate) throw errors.conflict('你已提交过该作品的待处理举报', 'WORK_REPORT_ALREADY_PENDING');
    const reportId = id('work_report'); const now = nowIso();
    q('INSERT INTO work_reports(id,work_id,org_id,reporter_id,category,details,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [reportId, work.id, work.org_id, auth.user.id, category, details, 'PENDING', now]);
    audit(ctx, 'WORK_REPORT_CREATE', 'WORK_REPORT', reportId, null, { workId: work.id, category }, { orgId: work.org_id });
    return normalizeWorkReport(row('SELECT * FROM work_reports WHERE id=?', [reportId]));
  }

  match = part.match(/^\/showcase\/([^/]+)$/);
  if (match && method === 'GET') {
    const work = row(
      `SELECT work.*, student.display_name AS student_name, student.privacy_showcase_anonymous AS student_anonymous, class.name AS class_name, lesson.title AS lesson_title
       FROM works work
       JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id
       LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
       LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id
       WHERE work.id=? AND work.org_id=? AND work.status='PUBLISHED'`,
      [match[1], auth.user.orgId],
    );
    if (!work) throw errors.notFound('已发布作品不存在', 'SHOWCASE_WORK_NOT_FOUND');
    const normalized = normalizeWork(work, { includeSnapshot: true });
    return {
      ...normalized,
      studentName: work.student_anonymous ? '小创作者' : (String(work.student_name || '').trim().slice(0, 1) + '同学' || '小创作者'),
      studentId: undefined,
      projectId: undefined,
      teacherComment: undefined,
      reviewedBy: undefined,
      reviewerName: undefined,
      featuredBy: undefined,
      canReport: work.student_id !== auth.user.id,
      sharing: {
        scope: 'ORGANIZATION',
        allowPublicShare: false,
        allowComments: false,
        allowLikes: false,
        title: '仅机构内可见',
        description: '作品只在当前机构的登录学生之间展示；不生成站外公开链接，也不显示学生完整姓名。',
      },
    };
  }

  if (part === '/works' && method === 'GET') {
    const rawItems = rows(
      `SELECT work.*, class.name AS class_name, lesson.title AS lesson_title, reviewer.display_name AS reviewer_name
       FROM works work
       LEFT JOIN classes class ON class.id = work.class_id AND class.org_id = work.org_id
       LEFT JOIN course_lessons lesson ON lesson.id = work.course_lesson_id
       LEFT JOIN users reviewer ON reviewer.id = work.reviewed_by
       WHERE work.student_id = ? AND work.org_id = ?
       ORDER BY work.submitted_at DESC LIMIT 200`,
      [auth.user.id, auth.user.orgId],
    );
    const submissionsByWork = workSubmissionRows(rawItems.map((work) => work.id));
    const items = rawItems.map((work) => {
      const normalized = normalizeWork(work, { includeSnapshot: ctx.search.get('includeSnapshot') === 'true' });
      const submissions = submissionsByWork.get(work.id) || [];
      const submissionRound = submissions[0]?.round || 0;
      const annotations = annotationRowsForStudent(work.id, ctx.auth.user.id, ctx.auth.user.orgId);
      const unreadAnnotationCount = annotations.filter((item) => !item.readAt).length;
      const overallRead = Boolean(row(
        'SELECT id FROM work_feedback_reads WHERE work_id=? AND student_id=? AND annotation_id IS NULL AND submission_round=?',
        [work.id, ctx.auth.user.id, submissionRound],
      ));
      const overallUnreadCount = work.teacher_comment && !overallRead ? 1 : 0;
      const publishRequests = rows('SELECT * FROM work_publish_requests WHERE work_id=? ORDER BY requested_at DESC', [work.id]).map(normalizeWorkPublishRequest);
      const pendingPublishRequest = publishRequests.find((item) => item.status === 'PENDING') || null;
      const project = row('SELECT id,status,deleted_at FROM student_projects WHERE id=? AND student_id=? AND org_id=?', [work.project_id, ctx.auth.user.id, ctx.auth.user.orgId]);
      return {
        ...normalized,
        submissionRound,
        submissions,
        unreadFeedbackCount: unreadAnnotationCount + overallUnreadCount,
        unreadAnnotationCount,
        overallUnreadCount,
        overallFeedbackRead: overallRead,
        publishRequests,
        pendingPublishRequest,
        latestPublishRequest: publishRequests[0] || null,
        actions: {
          canEditProject: work.status === 'REJECTED' && project?.status === 'DRAFT' && !project?.deleted_at,
          canSubmitProject: project?.status === 'DRAFT' && !project?.deleted_at,
          canRequestPublish: work.status === 'APPROVED' && !pendingPublishRequest,
          canWithdrawPublishRequest: Boolean(pendingPublishRequest),
        },
      };
    });
    return { items };
  }

  return null;
}
