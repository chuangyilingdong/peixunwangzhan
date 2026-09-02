import {
  errors,
  normalizeClass,
  normalizeLesson,
  normalizeSeries,
  normalizeSession,
  normalizeUser,
  rows,
} from '../lib.js';

function rawValue(user, snake, camel) {
  return user?.[snake] ?? user?.[camel] ?? null;
}

function studentIdentity(user) {
  const id = rawValue(user, 'id', 'id');
  const orgId = rawValue(user, 'org_id', 'orgId');
  if (!id || !orgId) throw errors.unauthorized('学生机构信息无效', 'ORG_SCOPE_REQUIRED');
  return { id, orgId };
}

function orgCourseAccessSql() {
  return `(
    (series.owner_type = 'PLATFORM' AND (series.visibility = 'ALL_ORGS' OR assignment.id IS NOT NULL))
    OR (series.owner_type = 'ORG' AND series.org_id = ?)
  )`;
}

export function getStudentMemberships(user) {
  const { id: userId, orgId } = studentIdentity(user);
  return rows(
    `SELECT class.*, teacher.display_name AS teacher_name
     FROM class_members member
     JOIN classes class ON class.id = member.class_id
     LEFT JOIN users teacher ON teacher.id = class.teacher_id AND teacher.org_id = class.org_id
     WHERE member.user_id = ?
       AND member.removed_at IS NULL
       AND class.org_id = ?
       AND class.status = 'ACTIVE'
     ORDER BY class.created_at`,
    [userId, orgId],
  );
}

export function getStudentActiveSessions(user) {
  const { id: userId, orgId } = studentIdentity(user);
  return rows(
    `SELECT session.*, lesson.title AS lesson_title
     FROM class_sessions session
     JOIN classes class ON class.id = session.class_id
     JOIN class_members member ON member.class_id = class.id
     LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
     WHERE member.user_id = ?
       AND member.removed_at IS NULL
       AND class.org_id = ?
       AND class.current_session_id = session.id
       AND session.status = 'ACTIVE'
     ORDER BY session.started_at DESC`,
    [userId, orgId],
  );
}

/** The student only sees published lessons in their own organization's class curriculum. */
export function getStudentCourses(user) {
  const { id: userId, orgId } = studentIdentity(user);
  const items = rows(
    `SELECT DISTINCT
        series.*,
        lesson.id AS lesson_id, lesson.title AS lesson_title,
        lesson.summary AS lesson_summary, lesson.sort AS lesson_sort,
        lesson.status AS lesson_status, lesson.duration_minutes AS lesson_duration_minutes,
        lesson.prompt_pack_asset_id AS lesson_prompt_pack_asset_id,
        lesson.outcome_pack_asset_id AS lesson_outcome_pack_asset_id,
        lesson.created_at AS lesson_created_at, lesson.updated_at AS lesson_updated_at,
        curriculum.class_id AS curriculum_class_id, curriculum.sort AS curriculum_sort
     FROM class_members member
     JOIN classes class ON class.id = member.class_id
       AND class.status = 'ACTIVE' AND class.org_id = ?
     JOIN class_curriculum_items curriculum ON curriculum.class_id = class.id
     JOIN course_lessons lesson ON lesson.id = curriculum.lesson_id AND lesson.status = 'PUBLISHED'
     JOIN course_series series ON series.id = lesson.series_id AND series.status = 'PUBLISHED'
     LEFT JOIN course_assignments assignment
       ON assignment.series_id = series.id AND assignment.org_id = ? AND assignment.status = 'ACTIVE'
     WHERE member.user_id = ?
       AND member.removed_at IS NULL
       AND ${orgCourseAccessSql()}
     ORDER BY series.sort, series.title, lesson.sort, curriculum.sort`,
    [orgId, orgId, userId, orgId],
  );

  const seriesById = new Map();
  for (const item of items) {
    let series = seriesById.get(item.id);
    if (!series) {
      series = normalizeSeries(item, { orgId });
      series.lessons = [];
      series.classIds = [];
      seriesById.set(item.id, series);
    }
    if (!series.classIds.includes(item.curriculum_class_id)) series.classIds.push(item.curriculum_class_id);
    if (!series.lessons.some((lesson) => lesson.id === item.lesson_id)) {
      series.lessons.push(normalizeLesson({
        id: item.lesson_id,
        series_id: item.id,
        title: item.lesson_title,
        summary: item.lesson_summary,
        sort: item.lesson_sort,
        status: item.lesson_status,
        duration_minutes: item.lesson_duration_minutes,
        prompt_pack_asset_id: item.lesson_prompt_pack_asset_id,
        outcome_pack_asset_id: item.lesson_outcome_pack_asset_id,
        created_at: item.lesson_created_at,
        updated_at: item.lesson_updated_at,
      }));
    }
  }
  return [...seriesById.values()];
}

/**
 * Resolve a project lesson against the student's own class curriculum. For a
 * FOLLOW_CLASS student, the active session must be the class's current session
 * and must be for this exact lesson.
 */
export function resolveStudentLessonContext(user, courseLessonId, preferredClassId = null) {
  const { id: userId, orgId } = studentIdentity(user);
  if (!courseLessonId) throw errors.badRequest('请选择课时', 'LESSON_REQUIRED');

  const candidates = rows(
    `SELECT
        class.id AS class_id, class.org_id AS class_org_id, class.name AS class_name,
        class.teacher_id AS class_teacher_id, teacher.display_name AS class_teacher_name,
        class.usage_mode AS class_usage_mode, class.default_series_id AS class_default_series_id,
        class.status AS class_status, class.current_session_id AS class_current_session_id,
        class.created_at AS class_created_at, class.updated_at AS class_updated_at, class.archived_at AS class_archived_at,
        lesson.id AS lesson_id, lesson.series_id AS lesson_series_id, lesson.title AS lesson_title,
        lesson.summary AS lesson_summary, lesson.sort AS lesson_sort, lesson.status AS lesson_status,
        lesson.duration_minutes AS lesson_duration_minutes,
        lesson.prompt_pack_asset_id AS lesson_prompt_pack_asset_id,
        lesson.outcome_pack_asset_id AS lesson_outcome_pack_asset_id,
        lesson.created_at AS lesson_created_at, lesson.updated_at AS lesson_updated_at,
        series.id AS series_id, series.title AS series_title, series.description AS series_description,
        series.owner_type AS series_owner_type, series.org_id AS series_org_id,
        series.visibility AS series_visibility, series.version AS series_version,
        series.sort AS series_sort, series.status AS series_status,
        session.id AS active_session_id, session.class_id AS active_session_class_id,
        session.lesson_id AS active_session_lesson_id, session.status AS active_session_status,
        session.session_credit_cap AS active_session_credit_cap,
        session.consumed_credits_total AS active_session_consumed_credits_total,
        session.ai_paused AS active_session_ai_paused,
        session.student_call_cap AS active_session_student_call_cap,
        session.allow_text AS active_session_allow_text,
        session.allow_image AS active_session_allow_image,
        session.allow_music AS active_session_allow_music,
        session.allow_video AS active_session_allow_video,
        session.allow_podcast AS active_session_allow_podcast,
        session.allow_dubbing AS active_session_allow_dubbing,
        session.started_by AS active_session_started_by, session.started_at AS active_session_started_at,
        session.ended_by AS active_session_ended_by, session.ended_at AS active_session_ended_at,
        session.ended_reason AS active_session_ended_reason
     FROM class_members member
     JOIN classes class ON class.id = member.class_id
       AND class.status = 'ACTIVE' AND class.org_id = ?
     LEFT JOIN users teacher ON teacher.id = class.teacher_id AND teacher.org_id = class.org_id
     JOIN class_curriculum_items curriculum ON curriculum.class_id = class.id AND curriculum.lesson_id = ?
     JOIN course_lessons lesson ON lesson.id = curriculum.lesson_id AND lesson.status = 'PUBLISHED'
     JOIN course_series series ON series.id = lesson.series_id AND series.status = 'PUBLISHED'
     LEFT JOIN course_assignments assignment
       ON assignment.series_id = series.id AND assignment.org_id = ? AND assignment.status = 'ACTIVE'
     LEFT JOIN class_sessions session
       ON session.id = class.current_session_id
       AND session.class_id = class.id
       AND session.lesson_id = lesson.id
       AND session.status = 'ACTIVE'
     WHERE member.user_id = ?
       AND member.removed_at IS NULL
       AND ${orgCourseAccessSql()}
       ${preferredClassId ? 'AND class.id = ?' : ''}
     ORDER BY class.created_at`,
    preferredClassId
      ? [orgId, courseLessonId, orgId, userId, orgId, preferredClassId]
      : [orgId, courseLessonId, orgId, userId, orgId],
  );

  if (!candidates.length) throw errors.notFound('该课时不在你的班级课程表中', 'LESSON_NOT_ASSIGNED');
  const data = candidates[0];
  const rawClass = {
    id: data.class_id, org_id: data.class_org_id, name: data.class_name,
    teacher_id: data.class_teacher_id, teacher_name: data.class_teacher_name,
    usage_mode: data.class_usage_mode, default_series_id: data.class_default_series_id,
    status: data.class_status, current_session_id: data.class_current_session_id,
    created_at: data.class_created_at, updated_at: data.class_updated_at, archived_at: data.class_archived_at,
  };
  const lesson = normalizeLesson({
    id: data.lesson_id, series_id: data.lesson_series_id, title: data.lesson_title,
    summary: data.lesson_summary, sort: data.lesson_sort, status: data.lesson_status,
    duration_minutes: data.lesson_duration_minutes,
    prompt_pack_asset_id: data.lesson_prompt_pack_asset_id,
    outcome_pack_asset_id: data.lesson_outcome_pack_asset_id,
    created_at: data.lesson_created_at, updated_at: data.lesson_updated_at,
  });
  const activeSession = data.active_session_id ? normalizeSession({
    id: data.active_session_id, class_id: data.active_session_class_id,
    lesson_id: data.active_session_lesson_id, status: data.active_session_status,
    session_credit_cap: data.active_session_credit_cap,
    consumed_credits_total: data.active_session_consumed_credits_total,
    ai_paused: data.active_session_ai_paused,
    student_call_cap: data.active_session_student_call_cap,
    allow_text: data.active_session_allow_text,
    allow_image: data.active_session_allow_image, allow_music: data.active_session_allow_music,
    allow_video: data.active_session_allow_video, allow_podcast: data.active_session_allow_podcast,
    allow_dubbing: data.active_session_allow_dubbing, started_by: data.active_session_started_by,
    started_at: data.active_session_started_at, ended_by: data.active_session_ended_by,
    ended_at: data.active_session_ended_at, ended_reason: data.active_session_ended_reason,
    lesson_title: lesson.title,
  }) : null;
  const scope = rawValue(user, 'student_usage_scope', 'studentUsageScope');
  const canUseNow = scope === 'HOME_PRACTICE' || Boolean(activeSession);

  return {
    class: normalizeClass(rawClass), rawClass, lesson,
    series: normalizeSeries({
      id: data.series_id, title: data.series_title, description: data.series_description,
      owner_type: data.series_owner_type, org_id: data.series_org_id,
      visibility: data.series_visibility, version: data.series_version,
      sort: data.series_sort, status: data.series_status,
    }, { orgId }),
    activeSession, canUseNow,
    blockCode: canUseNow ? null : 'CLASS_SESSION_REQUIRED',
    blockReason: canUseNow ? null : '跟随课堂账号需要由教师先开启对应课时的课堂',
  };
}

export function resolveProjectUsageContext(user, project) {
  const { id: userId, orgId } = studentIdentity(user);
  if (!project || project.student_id !== userId || project.org_id !== orgId) {
    throw errors.notFound('项目不存在', 'PROJECT_NOT_FOUND');
  }
  if (project.status !== 'DRAFT') {
    throw errors.conflict('项目当前不可继续创作', 'PROJECT_NOT_EDITABLE');
  }
  return resolveStudentLessonContext(user, project.course_lesson_id, project.class_id);
}

export function buildStudentContext(user) {
  const classes = getStudentMemberships(user);
  const activeSessions = getStudentActiveSessions(user);
  const scope = rawValue(user, 'student_usage_scope', 'studentUsageScope');
  const canUseNow = scope === 'HOME_PRACTICE' || activeSessions.length > 0;
  return {
    user: normalizeUser(user, { includeAuthMeta: true }),
    classes: classes.map((item) => normalizeClass(item, { detail: true })),
    activeSessions: activeSessions.map(normalizeSession),
    courses: getStudentCourses(user),
    canUseNow,
    blockReason: canUseNow ? null : '跟随课堂账号需要教师先开启课堂后才能创作',
  };
}
