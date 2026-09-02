import {
  errors,
  normalizeClass,
  normalizeLesson,
  normalizeSeries,
  normalizeSession,
  normalizeUser,
  nowIso,
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


const WORK_PROGRESS_RANK = { PUBLISHED: 4, APPROVED: 3, REJECTED: 2, PENDING: 1 };

function studentLessonProgressMap(user) {
  const { id: userId, orgId } = studentIdentity(user);
  const projects = rows(
    `SELECT id, class_id, course_lesson_id, title, status, latest_version, last_saved_at, updated_at
     FROM student_projects
     WHERE student_id = ? AND org_id = ? AND status != 'ARCHIVED'`,
    [userId, orgId],
  );
  const works = rows(
    `SELECT project_id, course_lesson_id, title, status, teacher_comment, reviewed_at, submitted_at
     FROM works WHERE student_id = ? AND org_id = ?`,
    [userId, orgId],
  );
  const progress = new Map();
  const ensure = (lessonId) => {
    if (!progress.has(lessonId)) {
      progress.set(lessonId, {
        lessonId,
        projectCount: 0,
        draftProjects: [],
        workCount: 0,
        works: [],
        bestWorkStatus: null,
        feedbackCount: 0,
        unreadFeedbackCount: 0,
        lastActivityAt: null,
      });
    }
    return progress.get(lessonId);
  };

  for (const project of projects) {
    if (!project.course_lesson_id) continue;
    const item = ensure(project.course_lesson_id);
    item.projectCount += 1;
    if (project.status === 'DRAFT') {
      item.draftProjects.push({
        id: project.id,
        title: project.title,
        status: project.status,
        latestVersion: Number(project.latest_version || 0),
        lastSavedAt: project.last_saved_at,
        updatedAt: project.updated_at,
      });
    }
    const updated = project.updated_at;
    if (updated && updated > item.lastActivityAt) item.lastActivityAt = updated;
  }
  for (const work of works) {
    if (!work.course_lesson_id) continue;
    const item = ensure(work.course_lesson_id);
    item.workCount += 1;
    item.works.push({
      id: work.id,
      projectId: work.project_id,
      title: work.title,
      status: work.status,
      teacherComment: work.teacher_comment || null,
      submittedAt: work.submitted_at,
      reviewedAt: work.reviewed_at || null,
    });
    if ((WORK_PROGRESS_RANK[work.status] || 0) > (WORK_PROGRESS_RANK[item.bestWorkStatus] || 0)) {
      item.bestWorkStatus = work.status;
    }
    if (work.reviewed_at && work.teacher_comment) {
      item.feedbackCount += 1;
      item.unreadFeedbackCount += 1;
    }
    if (work.submitted_at && work.submitted_at > item.lastActivityAt) item.lastActivityAt = work.submitted_at;
  }
  for (const item of progress.values()) {
    item.draftProjects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  return progress;
}

function studentLatestNotifications(user, limit = 5) {
  const { id: userId, orgId } = studentIdentity(user);
  return rows(
    `SELECT notification.id, notification.scope_type, notification.kind, notification.title, notification.body,
            notification.target_url, notification.pinned,
            COALESCE(notification.publish_at, notification.created_at) AS effective_at,
            sender.display_name AS sender_name,
            recipient.read_at
     FROM notification_recipients recipient
     JOIN notifications notification ON notification.id = recipient.notification_id
     LEFT JOIN users sender ON sender.id = notification.sender_id
     WHERE recipient.user_id = ?
       AND recipient.delivery_status = 'DELIVERED'
       AND notification.status = 'PUBLISHED'
       AND (notification.publish_at IS NULL OR notification.publish_at <= ?)
       AND ((notification.scope_type = 'ORG' AND notification.org_id = ?) OR notification.scope_type = 'PLATFORM')
     ORDER BY notification.pinned DESC, effective_at DESC
     LIMIT ?`,
    [userId, nowIso(), orgId, limit],
  ).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    targetUrl: item.target_url || null,
    pinned: Boolean(item.pinned),
    senderName: item.sender_name || (item.scope_type === 'PLATFORM' ? '平台' : '机构'),
    publishedAt: item.effective_at,
    read: Boolean(item.read_at),
  }));
}

export function buildStudentDashboard(user) {
  const context = buildStudentContext(user);
  const { id: userId, orgId } = studentIdentity(user);
  const progressByLesson = studentLessonProgressMap(user);
  const classById = new Map(context.classes.map((item) => [item.id, item]));
  const activeSessionByLesson = new Map(context.activeSessions.filter((item) => item.lessonId).map((item) => [item.lessonId, item]));
  const allLessonTasks = [];
  const courses = context.courses.map((course) => {
    const assignedClasses = (course.classIds || []).map((classId) => classById.get(classId)).filter(Boolean);
    const primaryClass = assignedClasses[0] || null;
    const lessons = (course.lessons || []).map((lesson) => {
      const progress = progressByLesson.get(lesson.id) || {
        projectCount: 0, draftProjects: [], workCount: 0, works: [], bestWorkStatus: null,
        feedbackCount: 0, unreadFeedbackCount: 0, lastActivityAt: null,
      };
      const session = activeSessionByLesson.get(lesson.id) || null;
      const task = {
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        lessonSummary: lesson.summary || '',
        courseId: course.id,
        courseTitle: course.title,
        classId: primaryClass?.id || null,
        className: primaryClass?.name || null,
        teacherName: primaryClass?.teacherName || null,
        status: progress.bestWorkStatus || (progress.projectCount > 0 ? 'IN_PROGRESS' : 'NOT_STARTED'),
        activeNow: Boolean(session),
        canStart: context.canUseNow,
        blockReason: context.canUseNow ? null : context.blockReason,
        session: session ? {
          id: session.id,
          classId: session.classId,
          startedAt: session.startedAt,
          capabilities: session.capabilities,
        } : null,
        progress: {
          projectCount: progress.projectCount,
          draftCount: progress.draftProjects.length,
          workCount: progress.workCount,
          workStatus: progress.bestWorkStatus,
          unreadFeedbackCount: progress.unreadFeedbackCount,
          lastActivityAt: progress.lastActivityAt,
        },
        continueProject: progress.draftProjects[0] || null,
        latestWork: [...progress.works].sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0] || null,
      };
      allLessonTasks.push(task);
      return {
        ...lesson,
        courseTitle: course.title,
        classId: task.classId,
        className: task.className,
        activeNow: task.activeNow,
        status: task.status,
        projectCount: progress.projectCount,
        draftCount: progress.draftProjects.length,
        workCount: progress.workCount,
        workStatus: progress.bestWorkStatus,
        lastActivityAt: progress.lastActivityAt,
      };
    });
    return {
      ...course,
      lessons,
      progress: {
        lessonCount: lessons.length,
        startedLessonCount: lessons.filter((item) => item.projectCount > 0).length,
        submittedLessonCount: lessons.filter((item) => item.workCount > 0).length,
        publishedLessonCount: lessons.filter((item) => item.workStatus === 'PUBLISHED').length,
        submittedPercent: lessons.length ? Math.round((lessons.filter((item) => item.workCount > 0).length / lessons.length) * 100) : 0,
      },
    };
  });

  const unfinishedTasks = allLessonTasks.filter((item) => item.status !== 'PUBLISHED' && item.status !== 'APPROVED');
  const pendingFeedbackTasks = allLessonTasks.filter((item) => item.progress.unreadFeedbackCount > 0 || item.status === 'REJECTED');
  const taskPriority = { REJECTED: 0, IN_PROGRESS: 1, NOT_STARTED: 2, PENDING: 3 };
  const learningTasks = [...unfinishedTasks]
    .sort((a, b) => (taskPriority[a.status] ?? 9) - (taskPriority[b.status] ?? 9)
      || String(b.progress.lastActivityAt || '').localeCompare(String(a.progress.lastActivityAt || '')))
    .slice(0, 8);
  const continueProjects = rows(
    `SELECT project.id, project.title, project.course_lesson_id, project.class_id, project.status,
            project.latest_version, project.last_saved_at, project.updated_at,
            lesson.title AS lesson_title, series.title AS course_title
     FROM student_projects project
     LEFT JOIN course_lessons lesson ON lesson.id = project.course_lesson_id
     LEFT JOIN course_series series ON series.id = lesson.series_id
     WHERE project.student_id = ? AND project.org_id = ? AND project.status = 'DRAFT'
     ORDER BY project.updated_at DESC
     LIMIT 5`,
    [userId, orgId],
  ).map((project) => ({
    id: project.id,
    title: project.title,
    lessonId: project.course_lesson_id,
    lessonTitle: project.lesson_title || null,
    courseTitle: project.course_title || null,
    classId: project.class_id,
    status: project.status,
    latestVersion: Number(project.latest_version || 0),
    lastSavedAt: project.last_saved_at,
    updatedAt: project.updated_at,
    editableNow: context.canUseNow,
    blockReason: context.canUseNow ? null : context.blockReason,
  }));
  const notifications = studentLatestNotifications(user);

  return {
    ...context,
    courses,
    summary: {
      classCount: context.classes.length,
      courseCount: courses.length,
      assignedLessonCount: allLessonTasks.length,
      activeLessonCount: allLessonTasks.filter((item) => item.activeNow).length,
      startedLessonCount: allLessonTasks.filter((item) => item.progress.projectCount > 0).length,
      submittedLessonCount: allLessonTasks.filter((item) => item.progress.workCount > 0).length,
      publishedLessonCount: allLessonTasks.filter((item) => item.progress.workStatus === 'PUBLISHED').length,
      pendingTaskCount: unfinishedTasks.length,
      pendingFeedbackCount: pendingFeedbackTasks.length,
      draftProjectCount: continueProjects.length,
      unreadNoticeCount: notifications.filter((item) => !item.read).length,
    },
    activeTasks: allLessonTasks.filter((item) => item.activeNow).slice(0, 8),
    learningTasks,
    pendingFeedbackTasks: pendingFeedbackTasks.slice(0, 8),
    continueProjects,
    notifications,
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
