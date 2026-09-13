// 平台管理端「courses」域路由：从 adminOrg.js 拆出，行为不变。
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
import { normalizePerStudentBudgetFen } from './helpers.js';
import { effectiveCapabilities, normalizeAspectRatio } from '../../services/modelCapabilities.js';
import { disableMfa, enableMfa, mfaSummary, regenerateRecoveryCodes, startMfaSetup } from '../../services/mfa.js';
import { normalizeSubmission } from '../vibecoding.js';
import {
  capturePublishedContent,
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
  orgAccountRequestRow,
  orgAccountRequestRows,
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

export async function handleCourses(ctx, part, method) {
  let match = null; // 课包授权路由沿用原来的 match 变量
  if (part === '/course-series' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const search = String(ctx.search.get('search') || '').trim();
    const statusFilter = String(ctx.search.get('status') || '').trim();
    const visibilityFilter = String(ctx.search.get('visibility') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const sortKey = String(ctx.search.get('sort') || 'manual').trim();
    const sort = Object.hasOwn({ manual: true, created: true, updated: true, title: true }, sortKey) ? sortKey : 'manual';
    const sortSql = {
      manual: 'series.sort ASC, series.title COLLATE NOCASE ASC, series.id DESC',
      created: 'series.created_at DESC, series.id DESC',
      updated: 'series.updated_at DESC, series.id DESC',
      title: 'series.title COLLATE NOCASE ASC, series.id DESC',
    }[sort];
    const conditions = []; const params = [];
    if (search) {
      conditions.push('(series.title LIKE ? OR series.id LIKE ?)');
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      params.push(keyword, keyword);
    }
    if (['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(statusFilter)) { conditions.push('series.status=?'); params.push(statusFilter); }
    if (['ALL_ORGS', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibilityFilter)) { conditions.push('series.visibility=?'); params.push(visibilityFilter); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = Number(row('SELECT COUNT(*) n FROM course_series series' + where, params)?.n || 0);
    const items = rows('SELECT series.* FROM course_series series' + where + ' ORDER BY ' + sortSql + ' LIMIT ? OFFSET ?', [...params, limit, (page - 1) * limit]).map((item) => normalizeSeries(item));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  if (part === '/course-series' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const body = ctx.body || {}; const title = String(body.title || '').trim();
    if (!title) throw errors.badRequest('课包标题不能为空', 'COURSE_TITLE_REQUIRED');
    if (title.length > 200) throw errors.badRequest('课包标题不能超过200个字符', 'VALIDATION_ERROR');
    const visibility = body.visibility || 'ALL_ORGS'; const status = body.status || 'DRAFT';
     const priceFen = integer(body.priceFen, '课程包价格（分）', { min: 0, max: 1000000000, fallback: 0 });
     const estimatedCreditsPerPerson = integer(body.estimatedCreditsPerPerson, '预估积分/人', { min: 0, max: 1000000000, fallback: 0 });
     // 课包库存（可授权出去的次数池）；机构授权单上的额度从这里出
     const stockTotal = integer(body.stockTotal, '课包库存（次）', { min: 0, max: 100000000, fallback: 0 });
     // 算力池：**每个学生在这个课包上的总预算**（分）。留空 = 不限制、只记账。
     const perStudentBudgetFen = normalizePerStudentBudgetFen(body.perStudentBudgetFen);
     const gradeRange = String(body.gradeRange || '').trim().slice(0, 100);
     const coverImageUrl = body.coverImageUrl ? String(body.coverImageUrl).trim().slice(0, 2000) : null;
     // 封面可以是外链 HTTPS，也可以是平台自己上传后返回的 /api/... 相对地址。
     if (coverImageUrl && !/^(https:\/\/|\/api\/)/.test(coverImageUrl)) throw errors.badRequest('封面地址必须是 HTTPS 链接或平台上传地址', 'INVALID_COVER_URL');
     const coverAssetId = body.coverAssetId ? String(body.coverAssetId).trim() : null;
     if (coverAssetId && !coverAssetId.startsWith('file_')) throw errors.badRequest('封面资源 ID 格式无效', 'INVALID_COVER_ASSET_ID');
    if (!['ALL_ORGS', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibility)) throw errors.badRequest('课包可见范围无效', 'INVALID_VISIBILITY');
    if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) throw errors.badRequest('课包状态无效', 'INVALID_COURSE_STATUS');
    const lessons = body.lessons === undefined ? [] : body.lessons;
    if (!Array.isArray(lessons) || lessons.length > 200) throw errors.badRequest('课时列表无效', 'INVALID_LESSONS');
    // P5-W05: 课程资料核验字段校验
    const difficultyLevel = body.difficultyLevel;
    if (difficultyLevel !== undefined && difficultyLevel !== null) {
      const dl = Number(difficultyLevel);
      if (!Number.isInteger(dl) || dl < 1 || dl > 5) throw errors.badRequest('难度等级必须是 1-5 的整数', 'INVALID_DIFFICULTY');
    }
    const ageRangeMin = body.ageRangeMin !== undefined ? integer(body.ageRangeMin, '适学年龄下限', { min: 3, max: 99 }) : null;
    const ageRangeMax = body.ageRangeMax !== undefined ? integer(body.ageRangeMax, '适学年龄上限', { min: 3, max: 99 }) : null;
    if (ageRangeMin !== null && ageRangeMax !== null && ageRangeMin > ageRangeMax) throw errors.badRequest('年龄下限不能大于年龄上限', 'INVALID_AGE_RANGE');
    let tags = [];
    if (Array.isArray(body.tags)) {
      tags = body.tags.map((t) => String(t || '').trim()).filter((t) => t.length > 0 && t.length <= 50).slice(0, 20);
    } else if (typeof body.tags === 'string' && body.tags.trim()) {
      tags = body.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 50).slice(0, 20);
    }
    if (row("SELECT id FROM course_series WHERE title=? AND owner_type='PLATFORM'", [title])) throw errors.conflict('同名平台课包已存在', 'COURSE_SERIES_EXISTS');
    const seriesId = id('series');
    const now = nowIso();
    const seriesDeliveryMode = normalizeDeliveryMode(body.deliveryMode);
    const createdLessonIds = [];
    transaction(() => {
      q('INSERT INTO course_series(id,title,description,cover_image_url,cover_asset_id,price_fen,estimated_credits_per_person,grade_range,owner_type,org_id,visibility,version,sort,status,difficulty_level,age_range_min,age_range_max,tags,delivery_mode,stock_total,per_student_budget_fen,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [seriesId, title, String(body.description || '').slice(0, 10000), coverImageUrl, coverAssetId, priceFen, estimatedCreditsPerPerson, gradeRange, 'PLATFORM', null, visibility, String(body.version || '1.0').slice(0, 100), integer(body.sort, '课包排序', { min: 0, max: 100000, fallback: 0 }), status, difficultyLevel != null ? Number(difficultyLevel) : null, ageRangeMin, ageRangeMax, JSON.stringify(tags), seriesDeliveryMode, stockTotal, perStudentBudgetFen, now, now]);
      lessons.forEach((lesson, index) => {
        const lessonTitle = String(lesson?.title || '').trim();
        if (!lessonTitle) throw errors.badRequest(`第${index + 1}课标题不能为空`, 'LESSON_TITLE_REQUIRED');
        if (lessonTitle.length > 200) throw errors.badRequest(`第${index + 1}课标题不能超过200个字符`, 'VALIDATION_ERROR');
        const lessonStatus = status === 'ARCHIVED' ? 'ARCHIVED' : (lesson.status || 'DRAFT');
        if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(lessonStatus)) throw errors.badRequest(`第${index + 1}课状态无效`, 'INVALID_LESSON_STATUS');
         const lessonId = id('lesson');
         // ⚠️ 老列 delivery_mode 要跟 delivery_modes 的**第一种**保持一致（设计口径：既有读取方不受影响）。
         //    以前只取 lesson.deliveryMode，而向导不发这个字段 → 双入口课时里老列恒为 CANVAS。
         const lessonModes = Array.isArray(lesson.deliveryModes) && lesson.deliveryModes.length ? lesson.deliveryModes : null;
         const deliveryMode = normalizeDeliveryMode((lessonModes && lessonModes[0]) || lesson.deliveryMode || seriesDeliveryMode); const classroomConfig = normalizeClassroomConfig(lesson.classroomConfig);
         q('INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,delivery_mode,classroom_config,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [lessonId, seriesId, lessonTitle, String(lesson.summary || '').slice(0, 10000), index + 1, lessonStatus, integer(lesson.durationMinutes, '课时时长', { min: 1, max: 1440, fallback: 45 }), String(lesson.lessonContent || '').slice(0, 50000), deliveryMode, json(classroomConfig), now, now]);
         createdLessonIds.push({ id: lessonId, materialGroups: lesson.materialGroups, capabilities: lesson.capabilities, deliveryMode, deliveryModes: lesson.deliveryModes, perStudentBudgetFen: lesson.perStudentBudgetFen, classroomConfig, canvasTemplateSnapshot: lesson.canvasTemplateSnapshot, teachingGroups: lesson.teachingGroups });
      });
    });
     createdLessonIds.forEach((lesson) => {
       replaceLessonCanvasConfig(lesson.id, lesson.materialGroups || [], lesson.capabilities || ['text'], lesson.deliveryMode, lesson.classroomConfig, lesson.canvasTemplateSnapshot, { deliveryModes: lesson.deliveryModes, perStudentBudgetFen: lesson.perStudentBudgetFen });
       if (lesson.teachingGroups !== undefined) replaceLessonTeachingMaterials(lesson.id, lesson.teachingGroups);
     });
    // 初始版本也记一条：版本历史从「初始版本」开始，之后重复用过的版本号一律拒绝
    q('INSERT INTO course_series_versions(id,series_id,version,note,status,created_by,created_at,published_at) VALUES (?,?,?,?,?,?,?,?)',
      [id('seriesver'), seriesId, String(body.version || '1.0').slice(0, 100), '初始版本', 'PUBLISHED', null, now, status === 'PUBLISHED' ? now : null]);
    audit(ctx, 'COURSE_SERIES_CREATE', 'COURSE_SERIES', seriesId, null, { title, lessonCount: lessons.length });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [seriesId]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
  }
  // 更新发布：版本号由人填（不再自动 +0.1），同时记一条版本历史。
  // 读模型仍是「当前内容」，所以发布后已授权机构与官网自然一起更新。
  const seriesVersionMatch = part.match(/^\/course-series\/([^/]+)\/versions$/);
  if (seriesVersionMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesVersionMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const version = nonEmptyString(ctx.body?.version, '版本号', { max: 100 });
    const note = String(ctx.body?.note || '').trim().slice(0, 500);
    if (version === series.version) throw errors.badRequest('版本号与当前版本相同，请填写新的版本号', 'VERSION_UNCHANGED');
    if (row('SELECT id FROM course_series_versions WHERE series_id=? AND version=?', [series.id, version])) throw errors.conflict('该版本号已经用过，请换一个', 'VERSION_EXISTS');
    const now = nowIso();
    const versionId = id('seriesver');
    transaction(() => {
      q('INSERT INTO course_series_versions(id,series_id,version,note,status,created_by,created_at,published_at) VALUES (?,?,?,?,?,?,?,?)',
        [versionId, series.id, version, note, 'PUBLISHED', auth.user.id, now, now]);
      // updated_at 与版本记录取同一时间：这样「有未发布改动」的判定立刻归零
      q('UPDATE course_series SET version=?,updated_at=? WHERE id=?', [version, now, series.id]);
      audit(ctx, 'COURSE_SERIES_VERSION_PUBLISH', 'COURSE_SERIES', series.id, { version: series.version }, { version, note });
    });
    // 草稿隔离的落点：把当前内容定格成「已发布内容」，机构端/学生端/官网从这一刻起读到的就是它
    // （放在事务外：capturePublishedContent 自己会开一个事务，嵌套会抛错）
    const captured = capturePublishedContent(series.id, now);
    return { id: versionId, version, note, publishedAt: now, capturedLessons: captured.lessons };
  }

  let seriesDetailMatch = part.match(/^\/course-series\/([^/]+)\/detail$/);
  if (seriesDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesDetailMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const assignedOrgs = rows('SELECT assignment.id, assignment.org_id, assignment.assigned_at, assignment.expires_at, assignment.quota_total, assignment.quota_used, organization.name org_name FROM course_assignments assignment JOIN organizations organization ON organization.id=assignment.org_id WHERE assignment.series_id=? AND assignment.status=\'ACTIVE\' ORDER BY assignment.assigned_at DESC', [series.id]).map((item) => ({ id: item.id, orgId: item.org_id, orgName: item.org_name, assignedAt: item.assigned_at, expiresAt: item.expires_at || null, expired: Boolean(item.expires_at) && new Date(item.expires_at).getTime() <= Date.now(), quotaTotal: Number(item.quota_total || 0), quotaUsed: Number(item.quota_used || 0) }));
    const usage = {
      // 批次 D（班级退场）：原来这里是 classesUsingSeries（「以该课包为默认课程的班级数」）与
      // curriculumItems（班级课单引用数）—— 两张都是历史表，数出来只是历史值，读的人会以为班级还在用。
      // 换成两类**真实在跑**的东西：这个课包开过多少课堂、其中几节正在进行。
      sessionsForSeries: count('SELECT COUNT(*) AS n FROM class_sessions session JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE lesson.series_id=?', [series.id]),
      activeSessionsForSeries: count("SELECT COUNT(*) AS n FROM class_sessions session JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE lesson.series_id=? AND session.status='ACTIVE'", [series.id]),
      studentWorks: count('SELECT COUNT(*) AS n FROM works work JOIN course_lessons lesson ON lesson.id=work.course_lesson_id WHERE lesson.series_id=?', [series.id]),
    };
    const versions = rows('SELECT * FROM course_series_versions WHERE series_id=? ORDER BY created_at DESC LIMIT 20', [series.id])
      .map((item) => ({ id: item.id, version: item.version, note: item.note || '', status: item.status, createdBy: item.created_by, createdAt: item.created_at, publishedAt: item.published_at }));
    // 「有未发布的改动」= 课包或课时最后修改时间晚于最近一次版本记录
    const lastVersionAt = versions[0]?.createdAt || null;
    const lastLessonAt = row('SELECT MAX(updated_at) AS t FROM course_lessons WHERE series_id=?', [series.id])?.t || null;
    const lastChangeAt = [series.updated_at, lastLessonAt].filter(Boolean).sort().pop() || series.updated_at;
    const hasUnpublishedChanges = lastVersionAt ? String(lastChangeAt) > String(lastVersionAt) : Boolean(versions.length === 0);
    return { series: normalizeSeries(series, { includeLessons: true, includeAllLessons: true, includeTeaching: true }), assignedOrgs, usage, versions, hasUnpublishedChanges, lastChangeAt, lastVersionAt };
  }

  let seriesEditMatch = part.match(/^\/course-series\/([^/]+)$/);
  if (seriesEditMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesEditMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const body = ctx.body || {};
    if (body.status !== undefined) throw errors.badRequest('课包状态必须通过状态动作接口修改', 'COURSE_STATUS_ACTION_REQUIRED');
    const title = body.title === undefined ? series.title : nonEmptyString(body.title, '课包标题', { max: 200 });
    if (title !== series.title && row("SELECT id FROM course_series WHERE title=? AND owner_type='PLATFORM'", [title])) throw errors.conflict('同名平台课包已存在', 'COURSE_SERIES_EXISTS');
    const description = body.description === undefined ? series.description : String(body.description).slice(0, 10000);
    const coverImageUrl = body.coverImageUrl === undefined ? series.cover_image_url : (body.coverImageUrl ? String(body.coverImageUrl).slice(0, 2000) : null);
    if (coverImageUrl && !/^(https:\/\/|\/api\/)/.test(coverImageUrl)) throw errors.badRequest('封面地址必须是 HTTPS 链接或平台上传地址', 'INVALID_COVER_URL');
    const coverAssetId = body.coverAssetId === undefined ? series.cover_asset_id : (body.coverAssetId ? String(body.coverAssetId).trim() : null);
    if (coverAssetId && !coverAssetId.startsWith('file_')) throw errors.badRequest('封面资源 ID 格式无效', 'INVALID_COVER_ASSET_ID');
     const priceFen = body.priceFen === undefined ? Number(series.price_fen || 0) : integer(body.priceFen, '课程包价格（分）', { min: 0, max: 1000000000 });
     const estimatedCreditsPerPerson = body.estimatedCreditsPerPerson === undefined ? Number(series.estimated_credits_per_person || 0) : integer(body.estimatedCreditsPerPerson, '预估积分/人', { min: 0, max: 1000000000 });
     const gradeRange = body.gradeRange === undefined ? (series.grade_range || '') : String(body.gradeRange || '').trim().slice(0, 100);
     const stockTotal = body.stockTotal === undefined ? Number(series.stock_total || 0) : integer(body.stockTotal, '课包库存（次）', { min: 0, max: 100000000 });
     // 算力池：每学生在这个课包上的总预算（分）；显式传 null 表示「清空 = 不限制」
     const seriesPerStudentBudgetFen = body.perStudentBudgetFen === undefined
       ? (series.per_student_budget_fen === null || series.per_student_budget_fen === undefined ? null : Number(series.per_student_budget_fen))
       : normalizePerStudentBudgetFen(body.perStudentBudgetFen);
    const visibility = body.visibility === undefined ? series.visibility : body.visibility;
    if (!['ALL_ORGS', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibility)) throw errors.badRequest('课包可见范围无效', 'INVALID_VISIBILITY');
    const sort = body.sort === undefined ? series.sort : integer(body.sort, '课包排序', { min: 0, max: 100000 });
    // P5-W05: 课程资料核验字段
    const difficultyLevel = body.difficultyLevel;
    if (difficultyLevel !== undefined && difficultyLevel !== null) {
      const dl = Number(difficultyLevel);
      if (!Number.isInteger(dl) || dl < 1 || dl > 5) throw errors.badRequest('难度等级必须是 1-5 的整数', 'INVALID_DIFFICULTY');
    }
    // 未提交的字段回落到库里现值，避免 undefined 直接绑定到 SQLite 参数。
    const ageRangeMin = body.ageRangeMin === null ? null : (body.ageRangeMin !== undefined ? integer(body.ageRangeMin, '适学年龄下限', { min: 3, max: 99 }) : (series.age_range_min ?? null));
    const ageRangeMax = body.ageRangeMax === null ? null : (body.ageRangeMax !== undefined ? integer(body.ageRangeMax, '适学年龄上限', { min: 3, max: 99 }) : (series.age_range_max ?? null));
    if (ageRangeMin !== null && ageRangeMax !== null && ageRangeMin > ageRangeMax) throw errors.badRequest('年龄下限不能大于年龄上限', 'INVALID_AGE_RANGE');
    let tags;
    if (body.tags !== undefined) {
      if (Array.isArray(body.tags)) {
        tags = body.tags.map((t) => String(t || '').trim()).filter((t) => t.length > 0 && t.length <= 50).slice(0, 20);
      } else if (typeof body.tags === 'string') {
        tags = body.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 50).slice(0, 20);
      } else {
        tags = undefined;
      }
    }
    const before = normalizeSeries(series);
    const deliveryMode = body.deliveryMode === undefined ? undefined : normalizeDeliveryMode(body.deliveryMode);
     q('UPDATE course_series SET title=?,description=?,cover_image_url=?,cover_asset_id=?,price_fen=?,estimated_credits_per_person=?,grade_range=?,stock_total=?,per_student_budget_fen=?,visibility=?,sort=?,difficulty_level=?,age_range_min=?,age_range_max=?,tags=?,delivery_mode=?,updated_at=? WHERE id=?', [title, description, coverImageUrl, coverAssetId, priceFen, estimatedCreditsPerPerson, gradeRange, stockTotal, seriesPerStudentBudgetFen, visibility, sort, difficultyLevel != null ? Number(difficultyLevel) : (difficultyLevel === null ? null : series.difficulty_level), ageRangeMin, ageRangeMax, tags != null ? JSON.stringify(tags) : series.tags, deliveryMode ?? series.delivery_mode, nowIso(), series.id]);
    const after = normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]));
    audit(ctx, 'COURSE_SERIES_UPDATE', 'COURSE_SERIES', series.id, { difficultyLevel: before.difficultyLevel, ageRangeMin: before.ageRangeMin, ageRangeMax: before.ageRangeMax, tags: before.tags }, { difficultyLevel: difficultyLevel != null ? Number(difficultyLevel) : null, ageRangeMin, ageRangeMax, tags });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
  }

  // 删除平台课包：仅当没有任何班级/课单/课堂/作品引用时才允许，否则引导改用「下架」。
  if (seriesEditMatch && method === 'DELETE') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesEditMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const refs = {
      classes: count('SELECT COUNT(*) AS n FROM classes WHERE default_series_id=?', [series.id]),
      curriculumItems: count('SELECT COUNT(*) AS n FROM class_curriculum_items WHERE source_series_id=?', [series.id]),
      sessions: count('SELECT COUNT(*) AS n FROM class_sessions session JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE lesson.series_id=?', [series.id]),
      works: count('SELECT COUNT(*) AS n FROM works work JOIN course_lessons lesson ON lesson.id=work.course_lesson_id WHERE lesson.series_id=?', [series.id]),
    };
    const blocked = refs.classes || refs.curriculumItems || refs.sessions || refs.works;
    if (blocked) {
      throw errors.badRequest(`该课包已被引用（班级 ${refs.classes} 处、课单 ${refs.curriculumItems} 处、课堂 ${refs.sessions} 场、作品 ${refs.works} 件），不能删除；请改用「下架」`, 'COURSE_SERIES_IN_USE');
    }
    const before = normalizeSeries(series, { includeLessons: true, includeAllLessons: true, includeTeaching: true });
    transaction(() => {
      q('DELETE FROM course_assignments WHERE series_id=?', [series.id]);
      q('DELETE FROM course_series WHERE id=?', [series.id]);
    });
    audit(ctx, 'COURSE_SERIES_DELETE', 'COURSE_SERIES', series.id, before, { deleted: true }, {});
    return { deleted: true, id: series.id };
  }

  let seriesStatusMatch = part.match(/^\/course-series\/([^/]+)\/status$/);
  if (seriesStatusMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesStatusMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const action = String(ctx.body?.action || '').trim();
    const transitions = {
      publish: { to: 'PUBLISHED', from: ['DRAFT', 'ARCHIVED'], auditAction: 'COURSE_SERIES_PUBLISH', requireLessons: true },
      archive: { to: 'ARCHIVED', from: ['DRAFT', 'PUBLISHED'], auditAction: 'COURSE_SERIES_ARCHIVE' },
    };
    const transition = transitions[action];
    if (!transition) throw errors.badRequest('无效的课包状态操作', 'INVALID_COURSE_STATUS_ACTION');
    assertTransition(ctx, 'courseSeries', series.status, transition.to, {
      targetType: 'COURSE_SERIES', targetId: series.id, before: normalizeSeries(series),
      allowedFrom: transition.from, code: 'INVALID_COURSE_STATUS_TRANSITION',
      message: '当前状态 ' + series.status + ' 不允许执行 ' + action, details: { action },
    });
    if (transition.requireLessons) validateSeriesForPublishing(series.id);
    const before = normalizeSeries(series);
    q('UPDATE course_series SET status=?,updated_at=? WHERE id=?', [transition.to, nowIso(), series.id]);
    if (transition.to === 'PUBLISHED') capturePublishedContent(series.id);
    const after = normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]));
    audit(ctx, transition.auditAction, 'COURSE_SERIES', series.id, { status: before.status }, { action, status: after.status });
    return after;
  }

  let seriesLessonsMatch = part.match(/^\/course-series\/([^/]+)\/lessons$/);
  if (seriesLessonsMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesLessonsMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const lessons = ctx.body?.lessons;
    if (!Array.isArray(lessons) || lessons.length === 0 || lessons.length > 100) throw errors.badRequest('请提交 1-100 个课时', 'INVALID_LESSONS');
    const maxSort = Number(row('SELECT MAX(sort) m FROM course_lessons WHERE series_id=?', [series.id])?.m || 0);
    const now = nowIso(); const replaceQueue = [];
    transaction(() => {
      lessons.forEach((lesson, index) => {
        const lessonTitle = String(lesson?.title || '').trim();
        if (!lessonTitle || lessonTitle.length > 200) throw errors.badRequest('第' + (index + 1) + '课标题不能为空且不超过200字', 'LESSON_TITLE_REQUIRED');
        const lessonStatus = lesson.status || 'DRAFT';
        if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(lessonStatus)) throw errors.badRequest('第' + (index + 1) + '课状态无效', 'INVALID_LESSON_STATUS');
        const lessonId = id('lesson');
        const lessonModes2 = Array.isArray(lesson.deliveryModes) && lesson.deliveryModes.length ? lesson.deliveryModes : null;
        const deliveryMode = normalizeDeliveryMode((lessonModes2 && lessonModes2[0]) || lesson.deliveryMode || series.delivery_mode);
        const classroomConfig = normalizeClassroomConfig(lesson.classroomConfig);
        q('INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,delivery_mode,classroom_config,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [lessonId, series.id, lessonTitle, String(lesson.summary || '').slice(0, 10000), maxSort + index + 1, lessonStatus, integer(lesson.durationMinutes, '课时时长', { min: 1, max: 1440, fallback: 45 }), String(lesson.lessonContent || '').slice(0, 50000), deliveryMode, json(classroomConfig), now, now]);
        replaceQueue.push({ id: lessonId, lesson, deliveryMode, classroomConfig });
      });
      q('UPDATE course_series SET updated_at=? WHERE id=?', [now, series.id]);
    });
    replaceQueue.forEach((item) => replaceLessonCanvasConfig(item.id, item.lesson.materialGroups || [], item.lesson.capabilities || ['text'], item.deliveryMode, item.classroomConfig, item.lesson.canvasTemplateSnapshot, { deliveryModes: item.lesson.deliveryModes, perStudentBudgetFen: item.lesson.perStudentBudgetFen }));
    audit(ctx, 'COURSE_LESSON_CREATE', 'COURSE_SERIES', series.id, null, { count: lessons.length, titles: lessons.map((lesson) => String(lesson?.title || '').trim()) });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
  }

  let seriesReorderMatch = part.match(/^\/course-series\/([^/]+)\/lessons\/reorder$/);
  if (seriesReorderMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesReorderMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const lessonIds = Array.isArray(ctx.body?.lessonIds) ? ctx.body.lessonIds.map((value) => String(value || '').trim()).filter(Boolean) : null;
    if (!lessonIds || lessonIds.length === 0) throw errors.badRequest('请提交课时排序', 'INVALID_LESSON_IDS');
    const existing = rows('SELECT id FROM course_lessons WHERE series_id=?', [series.id]).map((item) => item.id);
    const requested = [...new Set(lessonIds)];
    if (requested.length !== lessonIds.length) throw errors.badRequest('课时标识重复', 'INVALID_LESSON_IDS');
    if (requested.length !== existing.length || requested.some((lessonId) => !existing.includes(lessonId))) throw errors.badRequest('课时列表必须与课包现有课时完全一致', 'LESSON_SET_MISMATCH');
    const now = nowIso();
    const maxSort = Number(row('SELECT MAX(sort) m FROM course_lessons WHERE series_id=?', [series.id])?.m || 0);
    transaction(() => {
      requested.forEach((lessonId, index) => {
        q('UPDATE course_lessons SET sort=?,updated_at=? WHERE id=?', [maxSort + index + 1, now, lessonId]);
      });
      requested.forEach((lessonId, index) => {
        q('UPDATE course_lessons SET sort=?,updated_at=? WHERE id=?', [index + 1, now, lessonId]);
      });
      q('UPDATE course_series SET updated_at=? WHERE id=?', [now, series.id]);
    });
    audit(ctx, 'COURSE_LESSON_REORDER', 'COURSE_SERIES', series.id, null, { lessonIds: requested });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
  }

  let seriesRevokeMatch = part.match(/^\/course-series\/([^/]+)\/assignments\/revoke$/);
  if (seriesRevokeMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesRevokeMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const orgId = String(ctx.body?.orgId || '').trim();
    if (!orgId) throw errors.badRequest('请选择要撤销授权的机构', 'INVALID_ORG_IDS');
    const assignment = row("SELECT * FROM course_assignments WHERE series_id=? AND org_id=? AND status='ACTIVE'", [series.id, orgId]);
    if (!assignment) throw errors.notFound('该机构没有此课包的有效授权', 'ASSIGNMENT_NOT_FOUND');
    assertTransition(ctx, 'courseAssignment', assignment.status, 'REVOKED', { targetType: 'COURSE_ASSIGNMENT', targetId: assignment.id, before: { status: assignment.status, orgId }, code: 'INVALID_ASSIGNMENT_TRANSITION', message: '该课程授权当前状态不能撤销' });
    q("UPDATE course_assignments SET status='REVOKED' WHERE id=?", [assignment.id]);
    audit(ctx, 'COURSE_SERIES_ASSIGN_REVOKE', 'COURSE_SERIES', series.id, { orgId }, { orgId, status: 'REVOKED' });
    return { revoked: true, orgId };
  }

  let lessonEditMatch = part.match(/^\/course-lessons\/([^/]+)$/);
  if (lessonEditMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const lesson = row('SELECT lesson.*, series.owner_type owner_type FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id WHERE lesson.id=?', [lessonEditMatch[1]]);
    if (!lesson || lesson.owner_type !== 'PLATFORM') throw errors.notFound('平台课时不存在', 'LESSON_NOT_FOUND');
    const body = ctx.body || {};
    const title = body.title === undefined ? lesson.title : nonEmptyString(body.title, '课时标题', { max: 200 });
    const summary = body.summary === undefined ? lesson.summary : String(body.summary).slice(0, 10000);
    const durationMinutes = body.durationMinutes === undefined ? lesson.duration_minutes : integer(body.durationMinutes, '课时时长', { min: 1, max: 1440 });
    const status = body.status === undefined ? lesson.status : String(body.status).toUpperCase();
    if (body.status !== undefined) assertTransition(ctx, 'courseLesson', lesson.status, status, {
      targetType: 'COURSE_LESSON', targetId: lesson.id, before: { status: lesson.status, title: lesson.title },
      code: 'INVALID_LESSON_STATUS_TRANSITION', message: '当前课时状态不允许转换', details: { requestedStatus: status },
      allowSameState: true,
    });
    const lessonContent = body.lessonContent === undefined ? lesson.lesson_content : String(body.lessonContent).slice(0, 50000);
     // 传了 deliveryModes（多选数组）时，老列跟着它的第一种走；只传 deliveryMode 的老调用方照旧
     const patchModes = Array.isArray(body.deliveryModes) && body.deliveryModes.length ? body.deliveryModes : null;
     const deliveryMode = patchModes ? normalizeDeliveryMode(patchModes[0])
       : (body.deliveryMode === undefined ? (lesson.delivery_mode || 'CANVAS') : normalizeDeliveryMode(body.deliveryMode));
     const classroomConfig = body.classroomConfig === undefined ? parseJson(lesson.classroom_config, {}) : normalizeClassroomConfig(body.classroomConfig);
    q('UPDATE course_lessons SET title=?,summary=?,duration_minutes=?,status=?,lesson_content=?,delivery_mode=?,classroom_config=?,updated_at=? WHERE id=?', [title, summary, durationMinutes, status, lessonContent, deliveryMode, json(classroomConfig), nowIso(), lesson.id]);
    if (body.materialGroups !== undefined || body.capabilities !== undefined || body.deliveryMode !== undefined || body.deliveryModes !== undefined || body.perStudentBudgetFen !== undefined || body.classroomConfig !== undefined || body.canvasTemplateSnapshot !== undefined) {
      const currentCanvas = lessonCanvasConfig(lesson.id);
      replaceLessonCanvasConfig(lesson.id, body.materialGroups ?? currentCanvas.materialGroups, body.capabilities ?? currentCanvas.capabilities, deliveryMode, classroomConfig, body.canvasTemplateSnapshot ?? parseJson(lesson.canvas_template_snapshot, {}), { deliveryModes: body.deliveryModes, perStudentBudgetFen: body.perStudentBudgetFen });
    }
    if (body.teachingGroups !== undefined) replaceLessonTeachingMaterials(lesson.id, body.teachingGroups);
    q('UPDATE course_series SET updated_at=? WHERE id=?', [nowIso(), lesson.series_id]);
    audit(ctx, 'COURSE_LESSON_UPDATE', 'COURSE_LESSON', lesson.id, { title: lesson.title, status: lesson.status, durationMinutes: lesson.duration_minutes }, { title, status, durationMinutes, lessonContentChanged: body.lessonContent !== undefined && body.lessonContent !== lesson.lesson_content }, {});
    if (body.lessonContent !== undefined && body.lessonContent !== lesson.lesson_content) {
      audit(ctx, 'COURSE_LESSON_CONTENT_UPDATE', 'COURSE_LESSON', lesson.id, { lessonContent: lesson.lesson_content }, { lessonContent });
    }
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [lesson.series_id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
  }

  if (lessonEditMatch && method === 'DELETE') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const lesson = row('SELECT lesson.*, series.owner_type owner_type, series.version series_version FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id WHERE lesson.id=?', [lessonEditMatch[1]]);
    if (!lesson || lesson.owner_type !== 'PLATFORM') throw errors.notFound('平台课时不存在', 'LESSON_NOT_FOUND');
    const curriculumRefs = count('SELECT COUNT(*) AS n FROM class_curriculum_items WHERE lesson_id=?', [lesson.id]);
    const sessionRefs = count('SELECT COUNT(*) AS n FROM class_sessions WHERE lesson_id=?', [lesson.id]);
    if (curriculumRefs > 0 || sessionRefs > 0) throw errors.badRequest('该课时已被班级课单或课堂引用（课单 ' + curriculumRefs + ' 处、课堂 ' + sessionRefs + ' 处），请改为归档', 'LESSON_IN_USE');
    const now = nowIso();
    transaction(() => {
      q('DELETE FROM course_lessons WHERE id=?', [lesson.id]);
      const remaining = rows('SELECT id FROM course_lessons WHERE series_id=? ORDER BY sort, created_at', [lesson.series_id]);
      remaining.forEach((item, index) => {
        q('UPDATE course_lessons SET sort=?,updated_at=? WHERE id=?', [index + 1, now, item.id]);
      });
      q('UPDATE course_series SET updated_at=? WHERE id=?', [now, lesson.series_id]);
    });
    audit(ctx, 'COURSE_LESSON_DELETE', 'COURSE_LESSON', lesson.id, { title: lesson.title }, { deleted: true, resequenced: true }, {});
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [lesson.series_id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
  }
  match = part.match(/^\/course-series\/([^/]+)\/assignments$/);
  if (match && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [match[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const requestedOrgIds = Array.isArray(ctx.body?.orgIds) ? ctx.body.orgIds : null;
    if (!requestedOrgIds || requestedOrgIds.length === 0 || requestedOrgIds.length > 500) throw errors.badRequest('请选择有效的机构', 'INVALID_ORG_IDS');
    const assignmentOrgIds = [...new Set(requestedOrgIds.map((value) => String(value || '').trim()).filter(Boolean))];
    if (assignmentOrgIds.length !== requestedOrgIds.length) throw errors.badRequest('机构标识无效或重复', 'INVALID_ORG_IDS');
    const placeholders = assignmentOrgIds.map(() => '?').join(','); const existingOrgs = rows(`SELECT id FROM organizations WHERE id IN (${placeholders})`, assignmentOrgIds);
    if (existingOrgs.length !== assignmentOrgIds.length) throw errors.badRequest('存在不存在的机构', 'ORG_NOT_FOUND');
    const now = nowIso();
    // 有效期挂在「课包 → 机构」的授权上：平台课包本身不设有效期。
    const validityDays = integer(ctx.body?.validityDays, '授权有效期（天）', { min: 1, max: 3650, fallback: 365 });
    // 授权次数（许可轴）：0 = 不限次数（老行为）；> 0 时受课包库存约束
    const quotaTotal = integer(ctx.body?.quotaTotal, '授权次数', { min: 0, max: 100000000, fallback: 0 });
    if (quotaTotal > 0) {
      const stockTotal = Number(series.stock_total || 0);
      const grantedTotal = Number(row("SELECT COALESCE(SUM(quota_total),0) n FROM course_assignments WHERE series_id=? AND status='ACTIVE'", [series.id])?.n || 0);
      if (stockTotal > 0 && grantedTotal + quotaTotal > stockTotal) {
        throw errors.conflict(`课包库存不足：库存 ${stockTotal} 次，已授权 ${grantedTotal} 次，本次申请 ${quotaTotal} 次`, 'COURSE_QUOTA_EXCEEDS_STOCK');
      }
    }
    const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString();
    transaction(() => {
      assignmentOrgIds.forEach((assignmentOrgId) => {
        // 必须把 status 一起查出来：续期（对已有授权的机构再次授权）要按 REVOKED → ACTIVE 走状态机，
        // 只查 id 的话 existing.status 是 undefined，状态机会直接抛「status 无效」（p40 用例盯住这一点）。
        const existing = row('SELECT id, status FROM course_assignments WHERE series_id=? AND org_id=?', [series.id, assignmentOrgId]);
        if (existing) {
          assertTransition(ctx, 'courseAssignment', existing.status, 'ACTIVE', { targetType: 'COURSE_ASSIGNMENT', targetId: existing.id, before: { status: existing.status, orgId: assignmentOrgId }, allowSameState: true, code: 'INVALID_ASSIGNMENT_TRANSITION', message: '该课程授权当前状态不能启用' });
          q("UPDATE course_assignments SET status='ACTIVE',assigned_by=?,assigned_at=?,expires_at=?,quota_total=? WHERE id=?", [auth.user.id, now, expiresAt, quotaTotal > 0 ? quotaTotal : Number(existing.quota_total || 0), existing.id]);
        }
        else q("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at,expires_at,quota_total,quota_used) VALUES (?,?,?,?,?,?,?,?,0)", [id('assign'), series.id, assignmentOrgId, 'ACTIVE', auth.user.id, now, expiresAt, quotaTotal]);
      });
    });
    audit(ctx, 'COURSE_SERIES_ASSIGN', 'COURSE_SERIES', series.id, null, { orgIds: assignmentOrgIds, validityDays, expiresAt, quotaTotal });
    return { assignedCount: assignmentOrgIds.length, validityDays, expiresAt, quotaTotal };
  }

  // 平台兜底撤销：机构侧不可撤销（次数已消耗不可逆），出问题时由平台处理并写审计。
  // 次数退回规则：该学生还没提交过该课包任何一节课的作品 → 退回 1 次；已经上过 → 不退。
  const grantRevokeMatch = part.match(/^\/course-grants\/([^/]+)\/revoke$/);
  if (grantRevokeMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const grant = row('SELECT * FROM student_course_grants WHERE id=?', [grantRevokeMatch[1]]);
    if (!grant) throw errors.notFound('授权记录不存在', 'COURSE_GRANT_NOT_FOUND');
    if (grant.revoked_at) throw errors.conflict('这次授权已经撤销过了', 'COURSE_GRANT_ALREADY_REVOKED');
    const reason = nonEmptyString(ctx.body?.reason, '撤销原因', { max: 500 });
    const submitted = Number(row(
      `SELECT
         (SELECT COUNT(*) FROM works work JOIN course_lessons lesson ON lesson.id=work.course_lesson_id
           WHERE lesson.series_id=? AND work.student_id=?) +
         (SELECT COUNT(*) FROM vibecoding_submissions submission JOIN course_lessons lesson ON lesson.id=submission.lesson_id
           WHERE lesson.series_id=? AND submission.student_id=?) AS n`,
      [grant.series_id, grant.student_id, grant.series_id, grant.student_id],
    )?.n || 0);
    const now = nowIso();
    transaction(() => {
      q('UPDATE student_course_grants SET revoked_at=?,revoked_by=?,revoke_reason=? WHERE id=?', [now, auth.user.id, reason, grant.id]);
      if (!submitted && grant.source_assignment_id) {
        q('UPDATE course_assignments SET quota_used=MAX(quota_used-1,0) WHERE id=?', [grant.source_assignment_id]);
      }
    });
    audit(ctx, 'COURSE_GRANT_REVOKE', 'STUDENT_COURSE_GRANT', grant.id, { revokedAt: null }, { revokedAt: now, reason, quotaRefunded: !submitted }, { orgId: grant.org_id });
    return { id: grant.id, revokedAt: now, quotaRefunded: !submitted, submittedLessonCount: submitted };
  }

  // P5-M01: Marketplace management endpoints
  if (part === '/course-marketplace' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const statusFilter = String(ctx.search.get('marketplaceStatus') || ctx.search.get('status') || '').trim().toUpperCase();
    const search = String(ctx.search.get('search') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    // 课程广场按审核状态优先级排序；返回 sort 元数据保持十类列表协议一致。
    const sort = 'status';
    const offset = (page - 1) * limit;
    const wheres = ["series.status='PUBLISHED'"];
    const params = [];
    if (['PENDING', 'APPROVED', 'REJECTED', 'NONE'].includes(statusFilter)) { wheres.push('series.marketplace_status=?'); params.push(statusFilter); }
    if (search) { wheres.push('series.title LIKE ?'); params.push('%' + search.replace(/[%_]/g, (c) => '[' + c + ']') + '%'); }
    const where = wheres.join(' AND ');
    const total = Number(row('SELECT COUNT(*) n FROM course_series series WHERE ' + where, params)?.n || 0);
    const items = rows(
      `SELECT series.* FROM course_series series WHERE ${where}
       ORDER BY CASE series.marketplace_status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'REJECTED' THEN 2 ELSE 3 END, series.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((item) => {
      const normalized = normalizeSeries(item, { parseTags: true });
      return {
        id: normalized.id,
        title: normalized.title,
        difficultyLevel: normalized.difficultyLevel,
        ageRangeMin: normalized.ageRangeMin,
        ageRangeMax: normalized.ageRangeMax,
        tags: normalized.tags,
        status: normalized.status,
        marketplaceStatus: normalized.marketplaceStatus,
        marketplaceRewardCredits: normalized.marketplaceRewardCredits,
        visibility: normalized.visibility,
        createdAt: normalized.createdAt,
      };
    });
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }

  const marketplaceDetailMatch = part.match(/^\/course-marketplace\/([^/]+)$/);
  if (marketplaceDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=?", [marketplaceDetailMatch[1]]);
    if (!series) throw errors.notFound('课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const detail = normalizeSeries(series, { includeLessons: true, includeAllLessons: true, parseTags: true, includeTeaching: true });
    return {
      ...detail,
      marketplaceStatus: detail.marketplaceStatus,
      marketplaceRewardCredits: detail.marketplaceRewardCredits,
      lessonTitles: (detail.lessons || []).map((l) => ({ id: l.id, title: l.title, sort: l.sort })),
    };
  }

  if (marketplaceDetailMatch && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=?", [marketplaceDetailMatch[1]]);
    if (!series) throw errors.notFound('课包不存在', 'COURSE_SERIES_NOT_FOUND');
    if (series.status !== 'PUBLISHED') throw errors.badRequest('仅已发布课包可变更应用市场状态', 'COURSE_NOT_PUBLISHED');
    const body = ctx.body || {};
    const newStatus = body.marketplaceStatus === undefined ? series.marketplace_status : body.marketplaceStatus;
    if (!['PENDING', 'APPROVED', 'REJECTED', 'NONE'].includes(newStatus)) throw errors.badRequest('应用市场状态无效', 'INVALID_MARKETPLACE_STATUS');
    const newCredits = body.marketplaceRewardCredits === undefined ? Number(series.marketplace_reward_credits || 0) : integer(body.marketplaceRewardCredits, '积分激励', { min: 0, max: 999999 });
    const before = normalizeSeries(series, { parseTags: true });
    q('UPDATE course_series SET marketplace_status=?,marketplace_reward_credits=?,updated_at=? WHERE id=?', [newStatus, newCredits, nowIso(), series.id]);
    const after = normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { parseTags: true });
    audit(ctx, 'COURSE_SERIES_MARKETPLACE_UPDATE', 'COURSE_SERIES', series.id, { marketplaceStatus: before.marketplaceStatus, marketplaceRewardCredits: before.marketplaceRewardCredits }, { marketplaceStatus: after.marketplaceStatus, marketplaceRewardCredits: after.marketplaceRewardCredits });
    return after;
  }

  const marketplaceRewardsMatch = part.match(/^\/course-marketplace\/([^/]+)\/rewards$/);
  if (marketplaceRewardsMatch && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=?", [marketplaceRewardsMatch[1]]);
    if (!series) throw errors.notFound('课包不存在', 'COURSE_SERIES_NOT_FOUND');
    if (series.status !== 'PUBLISHED') throw errors.badRequest('仅已发布课包可调整积分激励', 'COURSE_NOT_PUBLISHED');
    const body = ctx.body || {};
    const newCredits = integer(body.marketplaceRewardCredits, '积分激励', { min: 0, max: 999999 });
    const before = normalizeSeries(series, { parseTags: true });
    q('UPDATE course_series SET marketplace_reward_credits=?,updated_at=? WHERE id=?', [newCredits, nowIso(), series.id]);
    const after = normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { parseTags: true });
    audit(ctx, 'COURSE_SERIES_MARKETPLACE_REWARD_UPDATE', 'COURSE_SERIES', series.id, { marketplaceRewardCredits: before.marketplaceRewardCredits }, { marketplaceRewardCredits: after.marketplaceRewardCredits });
    return after;
  }

  return null;
}
