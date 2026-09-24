import {
  errors,
  normalizeLesson,
  normalizeSeries,
  normalizeSession,
  normalizeUser,
  nowIso,
  row,
  rows,
  assignmentActiveSql,
  orgSeriesAccessSql,
  publishedLessonVisibilitySql, arows, arow, amap,
} from '../lib.js';
// 画布还能不能编辑（DRAFT / SUBMITTED 都算开着）—— 与前端同一份口径，见 packages/shared/src/canvasOutput.js
import { isCanvasEditableProjectStatus } from '../../../../packages/shared/src/canvasOutput.js';

function rawValue(user, snake, camel) {
  return user?.[snake] ?? user?.[camel] ?? null;
}

function studentIdentity(user) {
  const id = rawValue(user, 'id', 'id');
  const orgId = rawValue(user, 'org_id', 'orgId');
  if (!id || !orgId) throw errors.unauthorized('学生机构信息无效', 'ORG_SCOPE_REQUIRED');
  return { id, orgId };
}

// 机构可访问课包 = 平台授权（ACTIVE 且未过期）或机构自有；与平台端同一份定义。
function orgCourseAccessSql() {
  return orgSeriesAccessSql();
}

/**
 * 学生在**课堂名单**里的参与记录（2026-09-13 批次 C）。
 *
 * 班级退场之后，「这个学生被排进了哪些课」只剩这一个来源：`session_students`。
 * 六态：PENDING 待上课 / ACTIVE 上课中 / COMPLETED 已完课 / INCOMPLETE 未完课 / REMOVED 被移除；
 * **没有任何记录 = 「未加入任何课堂」**（第六种情形，学生端要能看出「等老师把我加进去」）。
 *
 * ⚠️ 这里刻意**不**按班级课单过滤 —— 课单概念已退场（用户确认：学生可见课时 = 有许可课包下的
 *    全部已发布课时），能不能进操作环境由课堂名单决定。
 */
export const SESSION_STUDENT_STATE_LABELS = {
  PENDING: '待上课', ACTIVE: '上课中', COMPLETED: '已完课', INCOMPLETE: '未完课', REMOVED: '被移除',
};

export async function getStudentLessonParticipations(user) {
  const { id: userId, orgId } = studentIdentity(user);
  return await arows(
    `SELECT part.*, session.title session_title, session.status session_status,
            session.delivery_mode session_delivery_mode, session.started_at session_started_at,
            session.ended_at session_ended_at, session.ended_reason session_ended_reason,
            session.ai_paused, session.student_cost_cap_fen,
            session.allow_text, session.allow_image, session.allow_music, session.allow_video,
            session.allow_podcast, session.allow_dubbing,
            teacher.display_name teacher_name
       FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id
       LEFT JOIN users teacher ON teacher.id = session.teacher_id
      WHERE part.student_id = ? AND part.org_id = ? AND session.org_id = part.org_id
      ORDER BY part.added_at DESC`,
    [userId, orgId],
  );
}

// 同一节课上可能有多条参与记录（上过、被移除、又排进新课堂）：给学生看「最该看的那条」。
const PARTICIPATION_RANK = { ACTIVE: 0, PENDING: 1, COMPLETED: 2, INCOMPLETE: 3, REMOVED: 4 };

/** 按课时取最佳参与记录（进行中 > 待上课 > 已完课 > 未完课 > 被移除）。 */
export function participationMapByLesson(participations) {
  const map = new Map();
  for (const part of participations) {
    const current = map.get(part.lesson_id);
    if (!current) { map.set(part.lesson_id, part); continue; }
    const next = PARTICIPATION_RANK[part.status] ?? 9;
    const best = PARTICIPATION_RANK[current.status] ?? 9;
    if (next < best || (next === best && String(part.added_at || '') > String(current.added_at || ''))) map.set(part.lesson_id, part);
  }
  return map;
}

/** 学生自己的课堂（含六态），给「我的课堂」用。 */
export async function getStudentClassrooms(user) {
  const { id: userId, orgId } = studentIdentity(user);
  return (await arows(
    `SELECT session.id, session.title, session.status, session.delivery_mode,
            session.lesson_id, session.series_id, session.started_at, session.ended_at, session.created_at,
            part.status part_status, part.completed_at, part.completed_cost_fen, part.removed_reason,
            lesson.title lesson_title, lesson.sort lesson_sort, series.title series_title,
            teacher.display_name teacher_name
       FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id
       LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
       LEFT JOIN course_series series ON series.id = session.series_id
       LEFT JOIN users teacher ON teacher.id = session.teacher_id
      WHERE part.student_id = ? AND part.org_id = ? AND session.org_id = part.org_id AND session.status <> 'DISSOLVED'
      ORDER BY COALESCE(session.started_at, session.created_at) DESC`,
    [userId, orgId],
  )).map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    deliveryMode: item.delivery_mode || 'CANVAS',
    lessonId: item.lesson_id,
    lessonTitle: item.lesson_title || null,
    lessonSort: item.lesson_sort === null || item.lesson_sort === undefined ? null : Number(item.lesson_sort),
    seriesId: item.series_id,
    seriesTitle: item.series_title || null,
    teacherName: item.teacher_name || null,
    startedAt: item.started_at || null,
    endedAt: item.ended_at || null,
    createdAt: item.created_at || null,
    // 我在这节课上的状态（六态）
    studentState: item.part_status,
    studentStateLabel: SESSION_STUDENT_STATE_LABELS[item.part_status] || item.part_status,
    completedAt: item.completed_at || null,
    completedCostFen: Number(item.completed_cost_fen || 0),
    removedReason: item.removed_reason || null,
  }));
}

/**
 * ⚠️ 2026-09-13 批次 C：原来这里是「班级成员」（`class_members JOIN classes`）。
 * 班级退场后学生不再有班级，**空数组**是如实的结果；要看「我上着哪些课」请用
 * `getStudentClassrooms`（课堂）或 dashboard 的 `classroomCourses`。
 * 保留这个函数只为不炸既有读取方（键还在，值不再有内容）。
 */
export function getStudentMemberships() {
  return [];
}

/** 学生**正在进行**的课堂（批次 C：从课堂名单取，不再经班级）。 */
export async function getStudentActiveSessions(user) {
  const { id: userId, orgId } = studentIdentity(user);
  const participations = await getStudentLessonParticipations(user);
  return participations
    .filter((part) => part.session_status === 'ACTIVE' && part.status === 'ACTIVE')
    .map((part) => ({
      id: part.session_id,
      title: part.session_title,
      classId: null,
      lessonId: part.lesson_id,
      lessonTitle: part.session_title || null,
      status: part.session_status,
      deliveryMode: part.session_delivery_mode || 'CANVAS',
      teacherName: part.teacher_name || null,
      startedAt: part.session_started_at,
      studentState: part.status,
    }));
}

/**
 * 本次调用里学生已获许可的课包（撤销的不算）。列表页要能直接标出「未授权」，
 * 所以单独查一次挂到结果上 —— 不去动列表 SQL 的 SELECT（历史上往列表 SELECT 里加列
 * 把接口改崩过两次，见交接说明第 59 条）。
 */
async function grantedSeriesIds(userId, orgId) {
  return new Set((await arows(
    `SELECT series_id FROM student_course_grants
      WHERE org_id = ? AND student_id = ? AND revoked_at IS NULL`,
    [orgId, userId],
  )).map((item) => item.series_id));
}

/**
 * 学生可见的「课包 → 已发布课时」清单（2026-09-13 批次 C：**课单概念退场**）。
 *
 * 用户确认的新口径：**学生可见课时 = 有许可课包下的全部已发布课时**。
 * 旧口径是「班级课单 ∩ 有效许可」，课单退场后那条 JOIN 整体去掉了 ——
 * 「能不能真的进操作环境」不再由这里决定，而由**课堂名单**决定（见 resolveStudentLessonContext）。
 *
 * ⚠️ 这里的范围是「本机构可访问的已发布课包」——**含还没有分给该学生的**，
 *    配上 `hasGrant` 让列表能标「未授权」（B1 口径：学生得知道自己该找老师要什么）。
 *
 * ⚠️ 「有哪些课时」用 publishedLessonVisibilitySql（快照口径），**不是**实时的 status='PUBLISHED' ——
 *    否则平台没「更新发布」就加进去的课时会提前出现在学生端。见 lib.js 里那个函数的注释。
 *    注意下面 resolveStudentLessonContext 的入口门禁**故意仍按实时状态**判：课堂一旦绑定了某节课，
 *    后来的发布把它盖成草稿，也不该把已经在上的学生踢出去。
 */
export async function getStudentCourses(user) {
  const { id: userId, orgId } = studentIdentity(user);
  const granted = await grantedSeriesIds(userId, orgId);
  const items = await arows(
    `SELECT
        series.*,
        lesson.id AS lesson_id, lesson.title AS lesson_title,
        lesson.summary AS lesson_summary, lesson.sort AS lesson_sort,
        lesson.status AS lesson_status, lesson.duration_minutes AS lesson_duration_minutes,
        lesson.prompt_pack_asset_id AS lesson_prompt_pack_asset_id,
        lesson.outcome_pack_asset_id AS lesson_outcome_pack_asset_id,
        lesson.lesson_content AS lesson_lesson_content,
        lesson.created_at AS lesson_created_at, lesson.updated_at AS lesson_updated_at
     FROM course_series series
     JOIN course_lessons lesson ON lesson.series_id = series.id AND ${publishedLessonVisibilitySql('lesson')}
     LEFT JOIN course_assignments assignment
       ON assignment.series_id = series.id AND assignment.org_id = ? AND ${assignmentActiveSql('assignment')}
     WHERE series.status = 'PUBLISHED'
       AND ${orgCourseAccessSql()}
     ORDER BY series.sort, series.title, lesson.sort`,
    [orgId, orgId],
  );

  const seriesById = new Map();
  for (const item of items.filter((item) => granted.has(item.id))) {
    let series = seriesById.get(item.id);
    if (!series) {
      series = await normalizeSeries(item, { orgId, asPublished: true });
      series.lessons = [];
      series.classIds = [];
      series.hasGrant = granted.has(item.id);
      seriesById.set(item.id, series);
    }
    let lesson = series.lessons.find((candidate) => candidate.id === item.lesson_id);
    if (!lesson) {
      lesson = await normalizeLesson({ ...await arow('SELECT * FROM course_lessons WHERE id=?', [item.lesson_id]), /* 学生读已发布快照 */
        id: item.lesson_id,
        series_id: item.id,
        title: item.lesson_title,
        summary: item.lesson_summary,
        sort: item.lesson_sort,
        status: item.lesson_status,
        duration_minutes: item.lesson_duration_minutes,
        prompt_pack_asset_id: item.lesson_prompt_pack_asset_id,
        outcome_pack_asset_id: item.lesson_outcome_pack_asset_id,
        lesson_content: item.lesson_lesson_content,
        created_at: item.lesson_created_at,
        updated_at: item.lesson_updated_at,
      }, { asPublished: true });
      // 课单退场后不再有「这节课属于哪些班级」这回事；两个键都留着但恒为空，
      // 免得既有读取方（学生端卡片）拿到 undefined。真正决定能不能进的是**课堂名单**。
      lesson.classIds = [];
      series.lessons.push(lesson);
    }
  }
  return [...seriesById.values()];
}

/**
 * P5-W05: 返回当前学生机构可访问的 PUBLISHED 课包 + 已发布课时清单，
 * 不受"是否已加入班级课单"限制。用于学员端"我的课程"列表与详情。
 * 支持 difficulty / ageMin / ageMax / tag / search 筛选。
 */
export async function getStudentAccessibleCourses(user, filters = {}) {
  const { id: userId, orgId } = studentIdentity(user);
  const granted = await grantedSeriesIds(userId, orgId);
  const params = [orgId, orgId];
  const wheres = [
    "series.status = 'PUBLISHED'",
    `(${orgCourseAccessSql()})`,
  ];
  if (filters.difficulty != null) {
    wheres.push('series.difficulty_level = ?');
    params.push(filters.difficulty);
  }
  if (filters.ageMin != null) {
    wheres.push('series.age_range_max IS NOT NULL AND series.age_range_max >= ?');
    params.push(filters.ageMin);
  }
  if (filters.ageMax != null) {
    wheres.push('series.age_range_min IS NOT NULL AND series.age_range_min <= ?');
    params.push(filters.ageMax);
  }
  if (filters.tag) {
    wheres.push('series.tags LIKE ?');
    params.push('%' + filters.tag + '%');
  }
  if (filters.search) {
    wheres.push('(series.title LIKE ? OR series.description LIKE ?)');
    const like = '%' + filters.search + '%';
    params.push(like, like);
  }
  const items = await arows(
    `SELECT series.* FROM course_series series
     LEFT JOIN course_assignments assignment
       ON assignment.series_id = series.id AND assignment.org_id = ? AND ${assignmentActiveSql('assignment')}
     WHERE ${wheres.join(' AND ')}
     ORDER BY series.sort, series.title`,
    params,
  );
  return await amap(items.filter((item) => granted.has(item.id)), async (item) => {
    const series = await normalizeSeries(item, { orgId, includeLessons: true, asPublished: true });
    series.hasGrant = granted.has(item.id);
    return series;
  });
}

/**
 * P5-W05: 学员端单课包详情。校验可访问性 + 返回完整课时清单（含 lessonContent）。
 */
export async function getStudentCourseDetail(user, seriesId) {
  const { orgId } = studentIdentity(user);
  const series = await arow(
    `SELECT series.* FROM course_series series
     LEFT JOIN course_assignments assignment
       ON assignment.series_id = series.id AND assignment.org_id = ? AND ${assignmentActiveSql('assignment')}
     WHERE series.id = ? AND series.status = 'PUBLISHED'
       AND ${orgCourseAccessSql()}`,
    [orgId, seriesId, orgId],
  );
  if (!series || !await studentHasGrant(studentIdentity(user).id, orgId, seriesId)) throw errors.notFound('课包不存在或不可访问', 'COURSE_SERIES_NOT_FOUND');
  const detail = await normalizeSeries(series, { orgId, includeLessons: true, asPublished: true });
  detail.lessons = (detail.lessons || []).filter((lesson) => lesson.status === 'PUBLISHED');
  return detail;
}

/**
 * Resolve a project lesson against the student's own class curriculum. For a
 * FOLLOW_CLASS student, the active session must be the class's current session
 * and must be for this exact lesson.
 */
/**
 * 学生进课的**唯一门禁**（2026-09-13 批次 B 重写：班级退场、课堂成为主对象）。
 *
 * 判定顺序（每一步失败都给**准确的原因**，免得学生找错人）：
 *   ① 课时/课包已发布                  → 否则 LESSON_NOT_ASSIGNED
 *   ② 机构对这个课包有生效授权          → 否则 COURSE_NOT_ASSIGNED
 *   ③ 学生持有有效学员许可              → 否则 COURSE_GRANT_REQUIRED（找老师/机构分清课包）
 *   ④ 这节课上有一条属于他的参与记录    → 否则 NOT_IN_CLASSROOM（还没被老师加进课堂）
 *   ⑤ 那条记录已「上课中」且课堂正在进行 → 否则 CLASS_SESSION_REQUIRED（等老师开始上课）
 *   ⑥ 课堂入口类型与他要走的入口一致    → 否则 VIBECODING_CLASSROOM_UNAVAILABLE 等
 *
 * ⚠️ 2026-09-13 用户决定：**取消「在家练习」免课堂通道** —— 有许可只代表「能看课包与课时信息」，
 *    真要进操作环境必须被老师加进某节课的课堂。
 */
export async function resolveStudentLessonContext(user, courseLessonId, preferredSessionId = null) {
  const { id: userId, orgId } = studentIdentity(user);
  if (!courseLessonId) throw errors.badRequest('请选择课时', 'LESSON_REQUIRED');


  const lesson = await arow(
    `SELECT lesson.* FROM course_lessons lesson
      JOIN course_series series ON series.id = lesson.series_id AND series.status='PUBLISHED'
      WHERE lesson.id=? AND lesson.status='PUBLISHED'`,
    [courseLessonId],
  );
  if (!lesson) throw errors.notFound('课时不存在或未发布', 'LESSON_NOT_ASSIGNED');
  const series = await arow("SELECT * FROM course_series series WHERE series.id=? AND series.status='PUBLISHED'", [lesson.series_id]);
  const orgAccess = await arow(
    `SELECT series.id FROM course_series series
      LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql('assignment')}
      WHERE series.id=? AND ${orgSeriesAccessSql()}`,
    [orgId, lesson.series_id, orgId],
  );
  if (!series || !orgAccess) throw errors.forbidden('这个课包还没有授权给本机构', 'COURSE_NOT_ASSIGNED');
  if (!await studentHasGrant(userId, orgId, lesson.series_id)) {
    throw errors.forbidden('这个课包还没有分给你：请老师先把课包分给你，你才能上这节课。', 'COURSE_GRANT_REQUIRED');
  }

  // 这节课上属于他的参与记录（被移除的不算）；多条时优先取「上课中」那条
  const participation = await arow(
    `SELECT part.*, session.status session_status, session.delivery_mode session_delivery_mode,
        session.teacher_id, teacher.display_name teacher_name, session.ai_paused, session.student_cost_cap_fen,
        session.allow_text, session.allow_image, session.allow_music, session.allow_video,
        session.allow_podcast, session.allow_dubbing,
        session.started_by, session.started_at, session.ended_by, session.ended_at, session.ended_reason,
        session.title session_title, session.series_id session_series_id
      FROM session_students part
      JOIN class_sessions session ON session.id = part.session_id
      LEFT JOIN users teacher ON teacher.id = session.teacher_id
      WHERE part.student_id=? AND part.lesson_id=? AND part.org_id=? AND session.org_id=? AND part.status IN ('PENDING','ACTIVE')
        ${preferredSessionId ? 'AND session.id=?' : ''}
      ORDER BY CASE part.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, part.added_at DESC LIMIT 1`,
    [userId, courseLessonId, orgId, orgId, ...(preferredSessionId ? [preferredSessionId] : [])],
  );
  if (!participation) {
    throw errors.forbidden('老师还没有把这节课的课堂安排给你：请让老师把你加进课堂。', 'NOT_IN_CLASSROOM');
  }

  const normalizedLesson = await normalizeLesson({ ...lesson, lesson_id: lesson.id }, { asPublished: true });
  const activeSession = normalizeSession({
    id: participation.session_id,
    title: participation.session_title,
    series_id: participation.session_series_id,
    lesson_id: lesson.id,
    teacher_id: participation.teacher_id,
    teacher_name: participation.teacher_name,
    status: participation.session_status,
    delivery_mode: participation.session_delivery_mode,
    ai_paused: participation.ai_paused,
    // 2026-09-18：`student_call_cap` → `student_cost_cap_fen`（学生算力上限收敛成唯一那套按钱的）。
    student_cost_cap_fen: participation.student_cost_cap_fen,
    allow_text: participation.allow_text, allow_image: participation.allow_image,
    allow_music: participation.allow_music, allow_video: participation.allow_video,
    allow_podcast: participation.allow_podcast, allow_dubbing: participation.allow_dubbing,
    started_by: participation.started_by, started_at: participation.started_at,
    ended_by: participation.ended_by, ended_at: participation.ended_at, ended_reason: participation.ended_reason,
    lesson_title: normalizedLesson.title,
  });
  const sessionLive = participation.session_status === 'ACTIVE' && participation.status === 'ACTIVE';
  const sessionMode = participation.session_delivery_mode || null;
  const lessonMode = normalizedLesson?.deliveryMode || 'CANVAS';
  // 与 lessonAvailability 同一口径：入口按**课时已发布的类型**放行，不受课堂单值限制。
  const lessonModes = Array.isArray(normalizedLesson?.deliveryModes) && normalizedLesson.deliveryModes.length ? normalizedLesson.deliveryModes : [lessonMode];
  const canUseNow = sessionLive && lessonModes.includes('CANVAS');
  const canUseVibeCodingNow = sessionLive && lessonModes.includes('VIBECODING');
  const waiting = participation.status === 'PENDING' || participation.session_status === 'PENDING';
  const waitingReason = waiting
    ? '老师还没开始上课，等老师点「开始上课」就能进'
    : '这节课的课堂已经结束，请联系老师重新安排';
  const vibeWaitingReason = waiting
    ? '老师还没开始 VibeCoding 课堂，等老师点「开始上课」就能进'
    : '这节课的课堂已经结束，请联系老师重新安排';
  void sessionMode;

  return {
    // 班级退场：class 恒为 null，课堂信息在 session 上（保留 class 键是为了不炸既有读取方）
    class: null,
    rawClass: null,
    session: activeSession,
    participation: {
      id: participation.id,
      status: participation.status,
      addedAt: participation.added_at || null,
      completedAt: participation.completed_at || null,
      completedCostFen: Number(participation.completed_cost_fen || 0),
    },
    lesson: normalizedLesson,
    series: await normalizeSeries(series, { orgId, asPublished: true }),
    activeSession,
    canUseNow,
    canUseVibeCodingNow,
    blockCode: canUseNow ? null : (sessionMode === 'VIBECODING' ? 'VIBECODING_CLASSROOM_UNAVAILABLE' : 'CLASS_SESSION_REQUIRED'),
    blockReason: canUseNow ? null : (sessionMode === 'VIBECODING'
      ? '老师开启的是 VibeCoding 课堂，请从 VibeCoding 入口进入'
      : waitingReason),
    vibeCodingBlockCode: canUseVibeCodingNow ? null : (sessionMode === 'CANVAS' ? 'VIBECODING_CLASSROOM_UNAVAILABLE' : 'VIBECODING_CLASS_NOT_ACTIVE'),
    vibeCodingBlockReason: canUseVibeCodingNow ? null : (sessionMode === 'CANVAS'
      ? '老师开启的是画布课堂，本课时不走 VibeCoding'
      : vibeWaitingReason),
  };
}

/** 学生是否持有该课包的有效许可（门禁第③步）。 */
async function studentHasGrant(userId, orgId, seriesId) {
  if (!seriesId) return false;
  return Boolean(await arow(
    'SELECT id FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=? AND revoked_at IS NULL LIMIT 1',
    [orgId, userId, seriesId],
  ));
}

const WORK_PROGRESS_RANK = { PUBLISHED: 4, APPROVED: 3, REJECTED: 2, PENDING: 1 };

async function studentLessonProgressMap(user) {
  const { id: userId, orgId } = studentIdentity(user);
  const projects = await arows(
    `SELECT id, class_id, class_session_id, course_lesson_id, title, status, latest_version, last_saved_at, updated_at
     FROM student_projects
     WHERE student_id = ? AND org_id = ? AND status != 'ARCHIVED' AND deleted_at IS NULL`,
    [userId, orgId],
  );
  const works = await arows(
    `SELECT work.id, work.project_id, work.course_lesson_id, work.title, work.status,
            work.teacher_comment, work.reviewed_at, work.submitted_at,
            (SELECT MAX(submission.round) FROM work_submissions submission WHERE submission.work_id=work.id) AS submission_round,
            (SELECT COUNT(1)
               FROM work_annotations annotation
              WHERE annotation.work_id=work.id
                AND NOT EXISTS (
                  SELECT 1 FROM work_feedback_reads annotation_read
                  WHERE annotation_read.annotation_id=annotation.id
                    AND annotation_read.student_id=work.student_id
                )) AS unread_annotation_count,
            CASE
              -- 2026-09-13（C2）：teacher_comment（审核意见）与 unpublish_reason（下架原因）都算「有话说」
              WHEN (work.teacher_comment IS NULL OR work.teacher_comment='') AND (work.unpublish_reason IS NULL OR work.unpublish_reason='') THEN 0
              WHEN EXISTS (
                SELECT 1 FROM work_feedback_reads overall_read
                WHERE overall_read.work_id=work.id
                  AND overall_read.student_id=work.student_id
                  AND overall_read.annotation_id IS NULL
                  AND overall_read.submission_round=COALESCE((SELECT MAX(submission.round) FROM work_submissions submission WHERE submission.work_id=work.id),0)
              ) THEN 0
              ELSE 1
            END AS overall_unread_count
     FROM works work WHERE work.student_id = ? AND work.org_id = ?`,
    [userId, orgId],
  );
  const progress = new Map();
  const ensure = (lessonId) => {
    if (!progress.has(lessonId)) {
      progress.set(lessonId, {
        lessonId,
        projectCount: 0,
        draftProjects: [],
        // 这一节课**本场课堂的项目**（草稿与已提交都记）：学生点「进入课堂 / 查看作品」要回到**同一个**项目，
        // 不能因为"已经提交过"就给他开一个新空画布（用户 2026-09-21：「点进入课堂还能进入到新画布，
        // 这个肯定是bug」）。draftProjects 仍然只管草稿（「继续创作」用它判）。
        sessionProjects: [],
        workCount: 0,
        works: [],
        bestWorkStatus: null,
        feedbackCount: 0,
        unreadFeedbackCount: 0,
        unreadAnnotationCount: 0,
        overallUnreadCount: 0,
        lastActivityAt: null,
      });
    }
    return progress.get(lessonId);
  };

  for (const project of projects) {
    if (!project.course_lesson_id) continue;
    const item = ensure(project.course_lesson_id);
    item.projectCount += 1;
    const projectEntry = {
      id: project.id,
      title: project.title,
      classId: project.class_id,
      sessionId: project.class_session_id,
      status: project.status,
      latestVersion: Number(project.latest_version || 0),
      lastSavedAt: project.last_saved_at,
      updatedAt: project.updated_at,
    };
    // 草稿 → 「继续创作」用它判；本场课堂的项目（**草稿与已提交都记**）→ 「查看作品」用它判。
    // 只记草稿就解释了那个 bug：提交之后本场课堂找不着项目 → 客户端显示「进入课堂」→ 服务端新开一个空画布。
    if (project.status === 'DRAFT') item.draftProjects.push(projectEntry);
    if (project.class_session_id) item.sessionProjects.push(projectEntry);
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
    const unreadAnnotations = Number(work.unread_annotation_count || 0);
    const overallUnread = Number(work.overall_unread_count || 0);
    if (work.reviewed_at && work.teacher_comment) item.feedbackCount += 1;
    if (work.status === 'REJECTED') item.feedbackCount += 1;
    item.unreadFeedbackCount += unreadAnnotations + overallUnread;
    if (unreadAnnotations > 0) item.unreadAnnotationCount = (item.unreadAnnotationCount || 0) + unreadAnnotations;
    if (overallUnread > 0) item.overallUnreadCount = (item.overallUnreadCount || 0) + overallUnread;
    if (work.submitted_at && work.submitted_at > item.lastActivityAt) item.lastActivityAt = work.submitted_at;
  }
  for (const item of progress.values()) {
    item.draftProjects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    item.sessionProjects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  return progress;
}

/** 每个课时的草稿按「最近改动」倒序 —— 「关闭再进入」要复用**同一份**创作，取最近那份才符合直觉。 */
function sortDraftsByRecency(progressByLesson) {
  for (const entry of progressByLesson.values()) {
    entry.draftProjects = [...entry.draftProjects].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  return progressByLesson;
}

async function studentLatestNotifications(user, limit = 5) {
  const { id: userId, orgId } = studentIdentity(user);
  return (await arows(
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
  )).map((item) => ({
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

/**
 * 「这节课现在对这名学生是什么状态」—— 学生端**唯一**的可用性算法（2026-09-13 批次 C）。
 *
 * 为什么必须只有一处：dashboard 里有**两份**课时清单（`courses` 给学习任务、`classroomCourses`
 * 给课程中心），它们原来各写一遍判断，改一处漏一处就会出现「卡片上写着能进、点进去被拒」。
 *
 * 判定顺序**必须与门禁 resolveStudentLessonContext 一致**（许可 → 课堂名单 → 课堂进行中 → 入口类型），
 * 否则报的原因会指向错误的人（学生拿「没分课包」去问老师，而真实原因是没排进课堂）。
 *
 * 四种情形 + 六态：
 *   ① 没有效许可                → 未分配（找老师/机构分课包）
 *   ② 没有效课堂名单记录/被移除   → 未加入任何课堂（等老师把你加进课堂）
 *   ③ 记录是 PENDING / 课堂没开始 → 已加入未开始（等老师点开始上课）
 *   ④ 记录 ACTIVE 且课堂 ACTIVE  → 已加入已开始（按课堂入口类型放行）
 *   ⑤ COMPLETED                 → 已完课（这节课上完了）
 *   ⑥ INCOMPLETE                → 未完课（没消耗过算力，可以重新排进课堂再上）
 */
export function lessonAvailability({ lesson, hasGrant, participation }) {
  const lessonMode = lesson.deliveryMode || 'CANVAS';
  // 上课类型只认**课时已发布的类型**，不再由课堂（class_sessions.delivery_mode）的单值限制：
  // 平台在课时上可以同时开画布 + VibeCoding，两种入口就都该放行（老师不再选课堂模式，
  // 课堂那个单值只作历史兼容）。2026-09-16 用户口径。
  const lessonModes = Array.isArray(lesson.deliveryModes) && lesson.deliveryModes.length ? lesson.deliveryModes : [lessonMode];
  const offersCanvas = lessonModes.includes('CANVAS');
  const offersVibe = lessonModes.includes('VIBECODING');
  const partStatus = participation?.status || null;
  const sessionStatus = participation?.session_status || null;
  const sessionMode = participation?.session_delivery_mode || null;
  const inRoster = Boolean(partStatus) && partStatus !== 'REMOVED';
  const sessionLive = inRoster && partStatus === 'ACTIVE' && sessionStatus === 'ACTIVE';
  const canStart = Boolean(hasGrant) && sessionLive && offersCanvas;
  const canStartVibeCoding = Boolean(hasGrant) && sessionLive && offersVibe;

  // 原因：先许可、再课堂名单、再课堂是否开始、最后入口类型 —— 与门禁同序
  const reason = !hasGrant
    ? '老师还没有把这个课包分给你，请联系老师'
    : partStatus === 'REMOVED'
      ? '老师已经把你移出了这个课堂：等老师重新把你加进课堂'
      : !inRoster
        ? '老师还没有把这节课的课堂安排给你：请让老师把你加进课堂'
        : partStatus === 'COMPLETED'
          ? '这节课你已经完课了：可以上这个课包的其他课时'
          : partStatus === 'INCOMPLETE'
            ? '这节课没上完（没消耗过算力）：等老师把你重新排进课堂就能再上'
            : sessionStatus === 'PENDING' || partStatus === 'PENDING'
              ? '老师还没开始上课，等老师点「开始上课」就能进'
              : sessionMode === 'VIBECODING' && !offersCanvas
                ? '老师开启的是 VibeCoding 课堂，请从 VibeCoding 入口进入'
                : '这节课的课堂已经结束，请联系老师重新安排';
  const vibeReason = !hasGrant
    ? '老师还没有把这个课包分给你，请联系老师'
    : partStatus === 'REMOVED'
      ? '老师已经把你移出了这个课堂：等老师重新把你加进课堂'
      : !inRoster
        ? '老师还没有把这节课的课堂安排给你：请让老师把你加进课堂'
        : partStatus === 'COMPLETED'
          ? '这节课你已经完课了：可以上这个课包的其他课时'
          : partStatus === 'INCOMPLETE'
            ? '这节课没上完（没消耗过算力）：等老师把你重新排进课堂就能再上'
            : sessionStatus === 'PENDING' || partStatus === 'PENDING'
              ? '老师还没开始 VibeCoding 课堂，等老师点「开始上课」就能进'
              : sessionMode === 'CANVAS' && !offersVibe
                ? '老师开启的是画布课堂，本课时不走 VibeCoding'
                : '这节课的课堂已经结束，请联系老师重新安排';

  return {
    lessonMode,
    sessionMode: sessionMode || null,
    participationStatus: partStatus,
    participationLabel: partStatus ? (SESSION_STUDENT_STATE_LABELS[partStatus] || partStatus) : '未加入课堂',
    // 「现在能上」= 有许可 + 在名单里 + 课堂进行中；入口类型决定走哪条路
    activeNow: sessionLive,
    inRoster,
    canStart,
    canStartVibeCoding,
    completedAt: participation?.completed_at || null,
    completedCostFen: Number(participation?.completed_cost_fen || 0),
    teacherName: participation?.teacher_name || null,
    sessionTitle: participation?.session_title || null,
    blockReason: canStart ? null : reason,
    vibeCodingBlockReason: canStartVibeCoding ? null : vibeReason,
    session: participation && sessionLive ? {
      id: participation.session_id,
      classId: null,
      teacherName: participation.teacher_name || null,
      startedAt: participation.session_started_at || null,
      deliveryMode: sessionMode,
      capabilities: {
        allowText: participation.allow_text === undefined ? true : Boolean(participation.allow_text),
        allowImage: Boolean(participation.allow_image),
        allowMusic: Boolean(participation.allow_music),
        allowVideo: Boolean(participation.allow_video),
        allowPodcast: Boolean(participation.allow_podcast),
        allowDubbing: Boolean(participation.allow_dubbing),
      },
    } : null,
  };
}

/**
 * 「这个学生的每一节课是什么状态」——按课程上下文一次算清，给 dashboard、我的课程、
 * 课包详情共用。**不要再在别处重写一遍判断**：写歪了就会出现「列表写着未开课、
 * 顶部计数却说有一节在上课」这种自相矛盾的页面。
 *
 * @param user    学生用户
 * @param context 可选，已经算好的 `buildStudentContext(user)`，传进来就不重复查库
 */
export async function lessonStateMap(user, context = null) {
  const resolved = context || await buildStudentContext(user);
  const participationByLesson = participationMapByLesson(await getStudentLessonParticipations(user));
  const map = new Map();
  for (const course of resolved.courses || []) {
    const hasGrant = Boolean(course.hasGrant);
    for (const lesson of course.lessons || []) {
      if (map.has(lesson.id)) continue;
      map.set(lesson.id, lessonAvailability({ lesson, hasGrant, participation: participationByLesson.get(lesson.id) }));
    }
  }
  return map;
}

export async function buildStudentDashboard(user) {
  const context = await buildStudentContext(user);
  const { id: userId, orgId } = studentIdentity(user);
  const progressByLesson = sortDraftsByRecency(await studentLessonProgressMap(user));
  // 批次 C：这节课对学生「是什么状态」全部由**课堂名单**决定（班级退场，没有 class 这一层了）
  const participationByLesson = participationMapByLesson(await getStudentLessonParticipations(user));
  // 「今天」只由**正在进行的课堂**决定（2026-09-11 删掉课堂任务后不再有「今天到期的任务」这个来源；
  // learning_tasks 表保留历史数据，代码不再读写）。
  const allLessonTasks = [];
  const courses = context.courses.map((course) => {
    const courseHasGrant = Boolean(course.hasGrant);
    const lessons = (course.lessons || []).map((lesson) => {
      const progress = progressByLesson.get(lesson.id) || {
        projectCount: 0, draftProjects: [], workCount: 0, works: [], bestWorkStatus: null,
        feedbackCount: 0, unreadFeedbackCount: 0, unreadAnnotationCount: 0, overallUnreadCount: 0, lastActivityAt: null,
      };
      const state = lessonAvailability({ lesson, hasGrant: courseHasGrant, participation: participationByLesson.get(lesson.id) });
      const isToday = state.activeNow;
      const { canStart, canStartVibeCoding } = state;
      const task = {
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        lessonSummary: lesson.summary || '',
        courseId: course.id,
        courseTitle: course.title,
        // 班级退场：classId/className 恒为 null，只有「负责老师」还有意义
        classId: null,
        className: null,
        teacherName: state.teacherName,
        status: progress.bestWorkStatus || (progress.projectCount > 0 ? 'IN_PROGRESS' : 'NOT_STARTED'),
        today: isToday,
        activeNow: state.activeNow,
        canStart,
        canStartVibeCoding,
        deliveryMode: state.sessionMode || state.lessonMode,
        participationStatus: state.participationStatus,
        participationLabel: state.participationLabel,
        completedAt: state.completedAt,
        completedCostFen: state.completedCostFen,
        sessionTitle: state.sessionTitle,
        blockReason: state.blockReason,
        vibeCodingBlockReason: state.vibeCodingBlockReason,
        session: state.session,
        progress: {
          projectCount: progress.projectCount,
          draftCount: progress.draftProjects.length,
          workCount: progress.workCount,
          workStatus: progress.bestWorkStatus,
          unreadFeedbackCount: progress.unreadFeedbackCount,
          lastActivityAt: progress.lastActivityAt,
        },
        continueProject: progress.draftProjects.find((project) => project.sessionId === state.session?.id) || null,
        // 本场课堂的项目（草稿**或已提交**）：客户端据此把按钮写成「继续创作 / 查看作品」，
        // 而不是"提交完就找不到项目、只好显示进入课堂"（那会新开一个空画布）。
        sessionProject: (progress.sessionProjects || []).find((project) => project.sessionId === state.session?.id) || null,
        latestWork: [...progress.works].sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0] || null,
      };
      allLessonTasks.push(task);
      return {
        ...lesson,
        courseTitle: course.title,
        classId: null,
        className: null,
        participationStatus: state.participationStatus,
        participationLabel: state.participationLabel,
        today: task.today,
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

  // 课程中心那份清单（学生端「课程中心」渲染的就是它）。范围＝本机构可访问的已发布课包，
  // 所以在「我的课程」里能看到自己还没被分配的课包（标「未授权」，学生知道该找老师要什么）。
  const classroomCourses = (await getStudentAccessibleCourses(user)).map((course) => {
    const courseHasGrant = Boolean(course.hasGrant);
    const lessons = (course.lessons || []).map((lesson) => {
      const progress = progressByLesson.get(lesson.id) || {
        projectCount: 0,
        draftProjects: [],
        workCount: 0,
        works: [],
        bestWorkStatus: null,
        unreadFeedbackCount: 0,
        lastActivityAt: null,
      };
      const state = lessonAvailability({ lesson, hasGrant: courseHasGrant, participation: participationByLesson.get(lesson.id) });
      // 「关闭再进入复用同一份创作」：progressByLesson 就是按课时分的，draftProjects 已按最近改动倒序，
      // 所以取第一篇即「这节课最近在做的那个草稿」—— 绝不因为 classId 对不上而新开一个项目。
      const continueProject = progress.draftProjects.find((project) => project.sessionId === state.session?.id) || null;
      // 本场课堂的项目（草稿**或已提交**）：已提交时客户端要显示「查看作品」并打开**同一个**项目，
      // 不能再新开一个空画布（用户 2026-09-21 报的就是它）。
      const sessionProject = (progress.sessionProjects || []).find((project) => project.sessionId === state.session?.id) || null;
      return {
        ...lesson,
        classId: null,
        className: null,
        teacherName: state.teacherName,
        assigned: state.inRoster,
        activeNow: state.activeNow,
        canStart: state.canStart,
        canStartVibeCoding: state.canStartVibeCoding,
        hasGrant: courseHasGrant,
        deliveryMode: state.sessionMode || state.lessonMode,
        // 六态 + 完课/未完课要落到学生侧（用户口径）：这些字段就是「四种情形」在界面上的落点
        participationStatus: state.participationStatus,
        participationLabel: state.participationLabel,
        sessionTitle: state.sessionTitle,
        completedAt: state.completedAt,
        completedCostFen: state.completedCostFen,
        blockReason: state.blockReason,
        vibeCodingBlockReason: state.vibeCodingBlockReason,
        session: state.session,
        status: progress.bestWorkStatus || (progress.projectCount > 0 ? 'IN_PROGRESS' : 'NOT_STARTED'),
        projectCount: progress.projectCount,
        draftCount: progress.draftProjects.length,
        workCount: progress.workCount,
        workStatus: progress.bestWorkStatus,
        lastActivityAt: progress.lastActivityAt,
        continueProject,
        sessionProject,
      };
    });
    return {
      ...course,
      classroomAvailable: lessons.some((lesson) => lesson.canStart),
      canStart: lessons.some((lesson) => lesson.canStart),
      lessons,
    };
  });

  const unfinishedTasks = allLessonTasks.filter((item) => item.status !== 'PUBLISHED' && item.status !== 'APPROVED');
  const pendingFeedbackTasks = allLessonTasks.filter((item) => item.progress.unreadFeedbackCount > 0);
  const taskPriority = { REJECTED: 0, IN_PROGRESS: 1, NOT_STARTED: 2, PENDING: 3 };
  const learningTasks = [...unfinishedTasks]
    .filter((item) => item.today)
    .sort((a, b) => (taskPriority[a.status] ?? 9) - (taskPriority[b.status] ?? 9)
      || String(b.progress.lastActivityAt || '').localeCompare(String(a.progress.lastActivityAt || '')))
    .slice(0, 8);
  const continueProjects = (await arows(
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
  )).map((project) => ({
    id: project.id,
    title: project.title,
    lessonId: project.course_lesson_id,
    lessonTitle: project.lesson_title || null,
    courseTitle: project.course_title || null,
    classId: project.class_id,
        sessionId: project.class_session_id,
    status: project.status,
    latestVersion: Number(project.latest_version || 0),
    lastSavedAt: project.last_saved_at,
    updatedAt: project.updated_at,
    editableNow: context.canUseNow,
    blockReason: context.canUseNow ? null : context.blockReason,
  }));
  const notifications = await studentLatestNotifications(user);

  return {
    ...context,
    courses,
    classroomCourses,
    summary: {
      // 班级退场：classCount 恒为 0（键留着不炸既有读取方）；课堂口径看 classroomCount
      classCount: 0,
      classroomCount: (context.classrooms || []).length,
      courseCount: courses.length,
      classroomCourseCount: classroomCourses.length,
      classroomLessonCount: classroomCourses.reduce((total, course) => total + course.lessons.length, 0),
      classroomAvailableLessonCount: classroomCourses.reduce((total, course) => total + course.lessons.filter((lesson) => lesson.canStart).length, 0),
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

export async function resolveProjectUsageContext(user, project) {
  const { id: userId, orgId } = studentIdentity(user);
  if (!project || project.student_id !== userId || project.org_id !== orgId) {
    throw errors.notFound('项目不存在', 'PROJECT_NOT_FOUND');
  }
  // ⚠️ 2026-09-24 画布「增量提交」口径：提交之后画布**不锁**（学生要能接着做完剩下的任务），
  // 所以 SUBMITTED 也放行；真正决定"还能不能用"的是下面 resolveStudentLessonContext 的 canUseNow
  // （课堂一结束就是 false）。评分后 / 归档后一律仍然拒绝。
  if (!isCanvasEditableProjectStatus(project.status)) {
    throw errors.conflict('项目当前不可继续创作', 'PROJECT_NOT_EDITABLE');
  }
  if (!project.class_session_id) throw errors.forbidden('项目没有有效课堂归属，请从当前课堂进入', 'PROJECT_SESSION_REQUIRED');
  return await resolveStudentLessonContext(user, project.course_lesson_id, project.class_session_id);
}

/**
 * 学生这块的「上下文」（班级退场后的口径，2026-09-13 批次 C）：
 *   · `classes` 恒为空数组 —— 学生不再属于任何班级（键留着不炸既有读取方）。
 *   · `classrooms` 是新的那道菜：他名下的课堂 + 六态。
 *   · `activeSessions` 是**正在进行**的课堂（从课堂名单取，不再经班级）。
 *   · `canUseNow` 只看「有没有正在进行的课堂」—— **不再有「在家练习免课堂」这条通道**
 *     （用户 2026-09-13 决定取消：有许可只代表能看课包与课时信息）。
 */
export async function buildStudentContext(user) {
  const activeSessions = await getStudentActiveSessions(user);
  const classrooms = await getStudentClassrooms(user);
  const canUseNow = activeSessions.length > 0;
  return {
    user: normalizeUser(user, { includeAuthMeta: true }),
    classes: [],
    classrooms,
    activeSessions: activeSessions.map(normalizeSession),
    courses: await getStudentCourses(user),
    canUseNow,
    blockReason: canUseNow ? null : '跟随课堂账号需要教师先开启课堂后才能创作',
  };
}
