import { audit, errors, id, json, nowIso, parseJson, q, requireRole, row, rows, transaction } from '../lib.js';

// Every read and write uses the same class scope, including explicitly supplied IDs.
function scopedClass(auth, classId, { student = false, active = false } = {}) {
  const cls = row('SELECT * FROM classes WHERE id=? AND org_id=?', [classId, auth.user.orgId]);
  if (!cls) throw errors.notFound('班级不存在', 'CLASS_NOT_FOUND');
  const member = row('SELECT role FROM class_members WHERE class_id=? AND user_id=? AND removed_at IS NULL', [classId, auth.user.id]);
  const allowed = student ? member?.role === 'STUDENT' : auth.user.role === 'ORG_ADMIN' ||
    (auth.user.role === 'TEACHER' && (cls.teacher_id === auth.user.id || member?.role === 'TEACHER'));
  if (!allowed) throw errors.forbidden('无权访问此班级', 'CLASS_PERMISSION_DENIED');
  if (active && cls.status !== 'ACTIVE') throw errors.conflict('班级已归档', 'CLASS_ARCHIVED');
  return cls;
}
function scopedTask(auth, taskId, student = false, write = false) {
  const task = row('SELECT * FROM learning_tasks WHERE id=? AND org_id=?', [taskId, auth.user.orgId]);
  if (!task || (student && task.status === 'DRAFT')) throw errors.notFound('任务不存在', 'TASK_NOT_FOUND');
  scopedClass(auth, task.class_id, { student, active: write });
  if (student && write && task.status !== 'PUBLISHED') throw errors.conflict('任务已关闭，不能再提交', 'TASK_CLOSED');
  return task;
}
function text(value, label, max, required = false) {
  if (value != null && typeof value !== 'string') throw errors.badRequest(`${label}格式无效`, 'INVALID_TASK');
  const result = String(value || '').trim();
  if ((required && !result) || result.length > max) throw errors.badRequest(`${label}${required ? '必填，且' : ''}不能超过 ${max} 字`, 'INVALID_TASK');
  return result;
}
function dueAt(value) {
  if (value == null || value === '') return null;
  // Require an explicit timezone; datetime-local is converted by the client on submit.
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw errors.badRequest('截止时间必须包含时区', 'INVALID_TASK_DUE_DATE');
  }
  return new Date(value).toISOString();
}
function assignedLesson(auth, classId, lessonId) {
  if (!lessonId) return null;
  const lesson = row(`SELECT lesson.id FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id
    JOIN class_curriculum_items curriculum ON curriculum.lesson_id=lesson.id AND curriculum.class_id=?
    WHERE lesson.id=? AND lesson.status='PUBLISHED' AND series.status='PUBLISHED' AND
    ((series.owner_type='ORG' AND series.org_id=?) OR (series.owner_type='PLATFORM' AND (series.visibility='ALL_ORGS' OR EXISTS
    (SELECT 1 FROM course_assignments assignment WHERE assignment.series_id=series.id AND assignment.org_id=? AND assignment.status='ACTIVE'))))`,
  [classId, lessonId, auth.user.orgId, auth.user.orgId]);
  if (!lesson) throw errors.badRequest('课时不在班级已授权课单内', 'LESSON_NOT_ASSIGNED');
  return lesson.id;
}
function normalizeTask(task) {
  return { id: task.id, classId: task.class_id, className: task.class_name, lessonId: task.lesson_id,
    lessonTitle: task.lesson_title, title: task.title, description: task.description, dueAt: task.due_at,
    status: task.status, createdBy: task.created_by, createdAt: task.created_at, updatedAt: task.updated_at };
}
function normalizeSubmission(s, snapshot = false) {
  return { id: s.id, round: s.round, projectId: s.project_id, note: s.student_note, status: s.status,
    score: s.score, feedback: s.feedback, submittedAt: s.submitted_at, reviewedAt: s.reviewed_at,
    reviewedBy: s.reviewed_by, viewedAt: s.viewed_at, ...(snapshot ? { snapshot: parseJson(s.project_snapshot, null) } : {}) };
}
function taskRoster(task, studentId = null) {
  const now = nowIso();
  const roster = rows(`SELECT student.id student_id,student.display_name,student.login,progress.id progress_id,
    progress.status progress_status,progress.started_at,progress.submitted_at,progress.completed_at,progress.teacher_feedback
    FROM class_members member JOIN users student ON student.id=member.user_id AND student.org_id=?
    LEFT JOIN learning_task_progress progress ON progress.task_id=? AND progress.student_id=student.id AND progress.org_id=student.org_id
    WHERE member.class_id=? AND member.role='STUDENT' AND member.removed_at IS NULL
    AND student.role='STUDENT' AND student.status='ACTIVE' AND student.deleted_at IS NULL ${studentId ? 'AND student.id=?' : ''}
    ORDER BY student.display_name,student.id`, [task.org_id, task.id, task.class_id, ...(studentId ? [studentId] : [])]);
  return roster.map((item) => {
    const latest = row('SELECT * FROM learning_task_submissions WHERE task_id=? AND student_id=? ORDER BY round DESC LIMIT 1', [task.id, item.student_id]);
    const status = item.progress_status || 'NOT_STARTED';
    const overdue = Boolean(task.due_at && task.due_at < now && !['SUBMITTED', 'COMPLETED'].includes(status));
    return { studentId: item.student_id, displayName: item.display_name, login: item.login, progressId: item.progress_id,
      progressStatus: status, overdue, lateSubmission: Boolean(task.due_at && item.submitted_at > task.due_at),
      startedAt: item.started_at, submittedAt: item.submitted_at, completedAt: item.completed_at,
      teacherFeedback: item.teacher_feedback || '', latestSubmission: latest ? normalizeSubmission(latest) : null };
  });
}
function summarize(items) {
  return { total: items.length, pending: items.filter(i => !['SUBMITTED', 'COMPLETED'].includes(i.progressStatus)).length,
    submitted: items.filter(i => i.progressStatus === 'SUBMITTED').length,
    completed: items.filter(i => i.progressStatus === 'COMPLETED').length, overdue: items.filter(i => i.overdue).length,
    unviewed: items.filter(i => i.progressStatus === 'SUBMITTED' && !i.latestSubmission?.viewedAt).length };
}
function tasksInScope(auth, student, classId) {
  if (classId) scopedClass(auth, classId, { student });
  let scope = ''; const params = [auth.user.orgId];
  if (classId) { scope += ' AND task.class_id=?'; params.push(classId); }
  if (student) {
    scope += ` AND task.status!='DRAFT' AND EXISTS (SELECT 1 FROM class_members member WHERE member.class_id=task.class_id AND member.user_id=? AND member.role='STUDENT' AND member.removed_at IS NULL)`;
    params.push(auth.user.id);
  } else if (auth.user.role === 'TEACHER') {
    scope += ` AND (class.teacher_id=? OR EXISTS (SELECT 1 FROM class_members member WHERE member.class_id=task.class_id AND member.user_id=? AND member.role='TEACHER' AND member.removed_at IS NULL))`;
    params.push(auth.user.id, auth.user.id);
  }
  return rows(`SELECT task.*,class.name class_name,lesson.title lesson_title FROM learning_tasks task
    JOIN classes class ON class.id=task.class_id AND class.org_id=task.org_id LEFT JOIN course_lessons lesson ON lesson.id=task.lesson_id
    WHERE task.org_id=?${scope} ORDER BY task.created_at DESC,task.id DESC`, params);
}

export function handleStudentTasks(ctx, part) {
  const auth = requireRole(ctx, ['STUDENT']); const { method, body = {} } = ctx;
  if (part === '/learning/tasks' && method === 'GET') {
    const items = tasksInScope(auth, true, '').map(task => ({ ...normalizeTask(task), ...taskRoster(task, auth.user.id)[0] }));
    return { items, summary: summarize(items) };
  }
  const match = part.match(/^\/learning\/tasks\/([^/]+)(?:\/(start|submit|submissions))?$/);
  if (!match) return null;
  const task = scopedTask(auth, decodeURIComponent(match[1]), true, method === 'POST');
  if (match[2] === 'submissions' && method === 'GET') {
    return { items: rows('SELECT * FROM learning_task_submissions WHERE task_id=? AND student_id=? ORDER BY round DESC', [task.id, auth.user.id]).map(s => normalizeSubmission(s, true)) };
  }
  if (['start', 'submit'].includes(match[2]) && method === 'POST') {
    return transaction(() => {
      const now = nowIso();
      const progress = row('SELECT * FROM learning_task_progress WHERE task_id=? AND student_id=?', [task.id, auth.user.id]);
      if (['SUBMITTED', 'COMPLETED'].includes(progress?.status)) throw errors.conflict('已提交或已完成的任务不能重新开始或重复提交', 'INVALID_TASK_TRANSITION');
      if (match[2] === 'submit' && progress?.status !== 'IN_PROGRESS') throw errors.conflict('请先开始任务', 'TASK_NOT_STARTED');
      if (match[2] === 'start') {
        if (!progress) q(`INSERT INTO learning_task_progress(id,task_id,student_id,org_id,status,started_at,created_at,updated_at) VALUES (?,?,?,?,'IN_PROGRESS',?,?,?)`, [id('task_progress'), task.id, auth.user.id, auth.user.orgId, now, now, now]);
        else q("UPDATE learning_task_progress SET status='IN_PROGRESS',started_at=COALESCE(started_at,?),updated_at=? WHERE id=?", [now, now, progress.id]);
      } else {
        const note = text(body.note, '提交说明', 2000);
        let project = null;
        if (body.projectId) {
          project = row('SELECT * FROM student_projects WHERE id=? AND student_id=? AND org_id=? AND class_id=? AND deleted_at IS NULL AND status!=\'ARCHIVED\'', [body.projectId, auth.user.id, auth.user.orgId, task.class_id]);
          if (!project || (task.lesson_id && project.course_lesson_id !== task.lesson_id)) throw errors.badRequest('只能关联自己在该班级、课时的项目', 'TASK_PROJECT_SCOPE');
        }
        if (!project && !note) throw errors.badRequest('请填写完成说明或选择项目', 'TASK_SUBMISSION_REQUIRED');
        const round = Number(row('SELECT COALESCE(MAX(round),0) n FROM learning_task_submissions WHERE task_id=? AND student_id=?', [task.id, auth.user.id]).n) + 1;
        q(`INSERT INTO learning_task_submissions(id,task_id,student_id,org_id,round,project_id,project_snapshot,student_note,status,submitted_at)
          VALUES (?,?,?,?,?,?,?,?,'SUBMITTED',?)`, [id('task_submission'), task.id, auth.user.id, auth.user.orgId, round, project?.id || null, project?.canvas_snapshot || null, note, now]);
        q("UPDATE learning_task_progress SET status='SUBMITTED',submitted_at=?,completed_at=NULL,updated_at=? WHERE id=?", [now, now, progress.id]);
      }
      audit(ctx, match[2] === 'start' ? 'LEARNING_TASK_START' : 'LEARNING_TASK_SUBMIT', 'LEARNING_TASK', task.id, null, { studentId: auth.user.id });
      return { id: task.id, ...taskRoster(task, auth.user.id)[0] };
    });
  }
  return null;
}

export function handleTeachingTasks(ctx, part) {
  const auth = requireRole(ctx, ['TEACHER', 'ORG_ADMIN']); const { method, body = {} } = ctx;
  if (part === '/teaching/tasks' && method === 'GET') {
    const items = tasksInScope(auth, false, ctx.search.get('classId') || '').map(task => ({ ...normalizeTask(task), summary: summarize(taskRoster(task)) }));
    return { items };
  }
  if (part === '/teaching/summary' && method === 'GET') {
    const tasks = tasksInScope(auth, false, ''); const totals = { tasks: tasks.length, published: 0, submitted: 0, overdue: 0, unviewed: 0, completed: 0 };
    for (const task of tasks) {
      if (task.status !== 'PUBLISHED') continue;
      totals.published++; const summary = summarize(taskRoster(task));
      for (const key of ['submitted', 'overdue', 'unviewed', 'completed']) totals[key] += summary[key];
    }
    return totals;
  }
  if (part === '/teaching/tasks' && method === 'POST') {
    const cls = scopedClass(auth, text(body.classId, '班级', 100, true), { active: true });
    const title = text(body.title, '标题', 120, true); const description = text(body.description, '说明', 5000);
    const lessonId = assignedLesson(auth, cls.id, body.lessonId || null); const due = dueAt(body.dueAt);
    const status = body.status || 'PUBLISHED'; if (!['DRAFT','PUBLISHED'].includes(status)) throw errors.badRequest('任务状态无效', 'INVALID_TASK');
    const now = nowIso(); const taskId = id('task');
    transaction(() => {
      q('INSERT INTO learning_tasks(id,org_id,class_id,lesson_id,title,description,due_at,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [taskId, auth.user.orgId, cls.id, lessonId, title, description, due, status, auth.user.id, now, now]);
      audit(ctx, 'LEARNING_TASK_CREATE', 'LEARNING_TASK', taskId, null, { classId: cls.id, title, status, dueAt: due });
    });
    return normalizeTask(row('SELECT * FROM learning_tasks WHERE id=?', [taskId]));
  }
  const match = part.match(/^\/teaching\/tasks\/([^/]+)(?:\/(submissions|review|viewed))?$/);
  if (match) {
    const task = scopedTask(auth, decodeURIComponent(match[1]), false, method === 'PATCH');
    if (!match[2] && method === 'PATCH') {
      const next = { title: body.title === undefined ? task.title : text(body.title, '标题', 120, true), description: body.description === undefined ? task.description : text(body.description, '说明', 5000), due: body.dueAt === undefined ? task.due_at : dueAt(body.dueAt), status: body.status || task.status };
      if (!['DRAFT','PUBLISHED','CLOSED'].includes(next.status) || (next.status === 'DRAFT' && task.status !== 'DRAFT')) throw errors.badRequest('已发布的任务不能退回草稿', 'INVALID_TASK_TRANSITION');
      transaction(() => {
        q('UPDATE learning_tasks SET title=?,description=?,due_at=?,status=?,updated_at=? WHERE id=?', [next.title, next.description, next.due, next.status, nowIso(), task.id]);
        audit(ctx, 'LEARNING_TASK_UPDATE', 'LEARNING_TASK', task.id, task, next);
      });
      return normalizeTask(row('SELECT * FROM learning_tasks WHERE id=?', [task.id]));
    }
    if (match[2] === 'submissions' && method === 'GET') {
      const items = taskRoster(task); const status = ctx.search.get('status') || ''; const overdue = ctx.search.get('overdue') === 'true';
      const studentId = ctx.search.get('studentId');
      const history = studentId && items.some(i => i.studentId === studentId) ? rows('SELECT * FROM learning_task_submissions WHERE task_id=? AND student_id=? ORDER BY round DESC', [task.id, studentId]).map(s => normalizeSubmission(s, true)) : [];
      return { task: normalizeTask(task), summary: summarize(items), items: items.filter(i => (!status || i.progressStatus === status) && (!overdue || i.overdue)), history };
    }
    if (['review','viewed'].includes(match[2]) && method === 'POST') {
      const ids = body.submissionIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(v => typeof v !== 'string') || new Set(ids).size !== ids.length) throw errors.badRequest('请选择 1—100 条不同的提交', 'INVALID_SUBMISSION_IDS');
      const reviewing = match[2] === 'review'; const decision = body.decision;
      const feedback = reviewing ? text(body.feedback, '反馈', 2000, decision === 'REJECTED') : '';
      const score = body.score === undefined || body.score === null || body.score === '' ? null : Number(body.score);
      if (reviewing && (!['APPROVED','REJECTED'].includes(decision) || (score !== null && (!Number.isInteger(score) || score < 0 || score > 100)))) throw errors.badRequest('请选择通过或驳回，分数须为 0—100 整数', 'INVALID_TASK_REVIEW');
      return transaction(() => {
        // Prevalidate the whole batch before making changes, preventing partial or cross-class review.
        const submissions = ids.map(submissionId => {
          const submission = row('SELECT * FROM learning_task_submissions WHERE id=? AND task_id=? AND org_id=?', [submissionId, task.id, auth.user.orgId]);
          if (!submission) throw errors.notFound('提交记录不存在', 'TASK_SUBMISSION_NOT_FOUND');
          const latest = row('SELECT id FROM learning_task_submissions WHERE task_id=? AND student_id=? ORDER BY round DESC LIMIT 1', [task.id, submission.student_id]);
          if (reviewing && (submission.status !== 'SUBMITTED' || latest?.id !== submission.id)) throw errors.conflict('提交已被处理，请刷新后重试', 'TASK_REVIEW_CONFLICT');
          return submission;
        });
        const now = nowIso();
        for (const submission of submissions) {
          q('UPDATE learning_task_submissions SET viewed_at=COALESCE(viewed_at,?),viewed_by=COALESCE(viewed_by,?) WHERE id=?', [now, auth.user.id, submission.id]);
          if (reviewing) {
            q('UPDATE learning_task_submissions SET status=?,score=?,feedback=?,reviewed_by=?,reviewed_at=? WHERE id=?', [decision, score, feedback, auth.user.id, now, submission.id]);
            q('UPDATE learning_task_progress SET status=?,teacher_feedback=?,completed_at=?,updated_at=? WHERE task_id=? AND student_id=? AND org_id=?', [decision === 'APPROVED' ? 'COMPLETED' : 'IN_PROGRESS', feedback, decision === 'APPROVED' ? now : null, now, task.id, submission.student_id, auth.user.orgId]);
          }
          audit(ctx, reviewing ? 'LEARNING_TASK_REVIEW' : 'LEARNING_TASK_VIEWED', 'TASK_SUBMISSION', submission.id, { status: submission.status }, reviewing ? { status: decision, score, feedback } : { viewed: true });
        }
        return { count: submissions.length };
      });
    }
  }
  const progressMatch = part.match(/^\/teaching\/classes\/([^/]+)\/progress$/);
  if (progressMatch && method === 'GET') {
    const cls = scopedClass(auth, decodeURIComponent(progressMatch[1]));
    const items = rows(`SELECT student.id,student.display_name,student.login,COUNT(DISTINCT curriculum.lesson_id) assigned_count,
      COUNT(DISTINCT CASE WHEN progress.status='COMPLETED' THEN progress.lesson_id END) completed_count,MAX(progress.last_accessed_at) last_accessed_at
      FROM class_members member JOIN users student ON student.id=member.user_id AND student.org_id=? AND student.role='STUDENT'
      LEFT JOIN class_curriculum_items curriculum ON curriculum.class_id=member.class_id
      LEFT JOIN student_lesson_progress progress ON progress.student_id=student.id AND progress.org_id=student.org_id AND progress.lesson_id=curriculum.lesson_id
      WHERE member.class_id=? AND member.role='STUDENT' AND member.removed_at IS NULL AND student.status='ACTIVE' AND student.deleted_at IS NULL
      GROUP BY student.id ORDER BY student.display_name`, [auth.user.orgId, cls.id]);
    return { class: { id: cls.id, name: cls.name }, items: items.map(i => ({ studentId: i.id, displayName: i.display_name, login: i.login, assignedCount: Number(i.assigned_count), completedCount: Number(i.completed_count), completionRate: i.assigned_count ? Math.round(i.completed_count * 100 / i.assigned_count) : 0, lastAccessedAt: i.last_accessed_at })) };
  }
  return null;
}
