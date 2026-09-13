// 「课堂」的领域逻辑（2026-09-13，批次 B：班级退场、课堂成为主对象）。
//
// 四态：PENDING（待上课，已创建未开始）/ ACTIVE（上课中）/ ENDED（已结束）/ DISSOLVED（已解散）
// 学员六态：不在任何行 = 未加入任何课堂 … PENDING 待上课 / ACTIVE 上课中 /
//           COMPLETED 已完课 / INCOMPLETE 未完课 / REMOVED 被移除
//
// 完课判定 = 这个学生在这节课**消耗过算力**（成功调用且 cost_fen > 0）。
// 这里有三个规则是用户逐条定的，改动前请先看注释：
//   ① 已完课的学员**不能再被加到同一节课**（但可以上同课包的其他课时）；
//   ② 未结束的参与（待上课/上课中）也不允许被别的课堂同时占用；
//   ③ 被移除 = 解锁（可以再被其他课堂加）。
import { errors, id, nowIso, q, row, rows, transaction } from '../lib.js';
import { computePoolSummary } from './computePool.js';

/** 教师只能碰自己创建的课堂；机构管理员可以碰本机构所有课堂。 */
export function assertSessionManager(auth, session) {
  if (auth.user.role === 'ORG_ADMIN') return session;
  if (auth.user.role === 'TEACHER' && session.teacher_id === auth.user.id) return session;
  throw errors.forbidden('这不是你负责的课堂', 'SESSION_PERMISSION_DENIED');
}

/**
 * 教师数据范围的新落点（替代原来按「班级」的 teacherScope）：
 * 课堂列表/详情/学员/用量/作品都只圈「我创建的课堂」。
 */
export function sessionScope(alias, auth, params) {
  if (auth.user.role !== 'TEACHER') return '';
  params.push(auth.user.id);
  return ` AND ${alias}.teacher_id=?`;
}

/** 这个学生在这节课上花过多少钱（分）——完课判定的唯一依据。 */
export function lessonCostFenFor({ studentId, sessionId }) {
  return Number(row(
    `SELECT COALESCE(SUM(cost_fen), 0) fen FROM usage_records
      WHERE class_session_id=? AND user_id=? AND status='SUCCESS'`,
    [sessionId, studentId],
  )?.fen || 0);
}

/** 该学生在**这节课**上的参与行（含跨课堂占用；REMOVED 不算占用）。 */
export function activeParticipationFor({ studentId, lessonId, excludeSessionId = null }) {
  return row(
    `SELECT part.*, session.title session_title, session.status session_status, session.teacher_id session_teacher_id,
        teacher.display_name teacher_name, session.started_at, session.created_at
      FROM session_students part
      JOIN class_sessions session ON session.id = part.session_id
      LEFT JOIN users teacher ON teacher.id = session.teacher_id
      WHERE part.student_id=? AND part.lesson_id=? AND part.status IN ('PENDING','ACTIVE')
        ${excludeSessionId ? 'AND part.session_id <> ?' : ''}
      ORDER BY part.added_at DESC LIMIT 1`,
    excludeSessionId ? [studentId, lessonId, excludeSessionId] : [studentId, lessonId],
  ) || null;
}

/** 该学生在这节课上是否已经完课（完课行不会被移除，所以直接查）。 */
export function completedParticipationFor({ studentId, lessonId, excludeSessionId = null }) {
  return row(
    `SELECT part.*, session.title session_title, session.teacher_id session_teacher_id, teacher.display_name teacher_name
      FROM session_students part
      JOIN class_sessions session ON session.id = part.session_id
      LEFT JOIN users teacher ON teacher.id = session.teacher_id
      WHERE part.student_id=? AND part.lesson_id=? AND part.status='COMPLETED'
        ${excludeSessionId ? 'AND part.session_id <> ?' : ''}
      ORDER BY part.completed_at DESC LIMIT 1`,
    excludeSessionId ? [studentId, lessonId, excludeSessionId] : [studentId, lessonId],
  ) || null;
}

const SESSION_STATE_LABELS = { PENDING: '待上课', ACTIVE: '上课中', ENDED: '已结束', DISSOLVED: '已解散' };

/**
 * 老师要「添加学员」时的候选名单：可添加 / 不可添加（每条给原因，并带上占用它的课堂信息）。
 * 规则（用户口径）：
 *   · 必须有这个课包的有效学员许可；
 *   · 这节课上不能有别的课堂的未结束参与（待上课/上课中）→ 不可加，标明所属课堂/状态/老师；
 *   · 已经完课过这节课 → 不可加（可以上同课包其他课时）；
 *   · 被移除过 → 算可加（移除即解锁）。
 */
export function sessionCandidates(session) {
  const students = rows(
    `SELECT student.id, student.login, student.display_name, student.status
      FROM users student
      WHERE student.org_id=? AND student.role='STUDENT' AND student.deleted_at IS NULL
      ORDER BY student.display_name, student.login`,
    [session.org_id],
  );
  const granted = new Set(rows(
    'SELECT student_id FROM student_course_grants WHERE org_id=? AND series_id=? AND revoked_at IS NULL',
    [session.org_id, session.series_id],
  ).map((item) => item.student_id));
  const selectable = [];
  const blocked = [];
  const alreadyIn = [];
  for (const student of students) {
    // 算力池摘要挂在**每一条**候选上（可加 / 不可加 / 已在这节课上）——
    // 老师挑人时要能看出「谁快用完了」，而这个人可能正好因为别的原因暂时不可加。
    // 口径与学生端同一个 computePoolSummary（不是另算一个数）。
    const base = {
      id: student.id, login: student.login, name: student.display_name || student.login, accountStatus: student.status,
      ...candidatePool(student.id, session.series_id, session.series_title),
    };
    const own = row(
      'SELECT status FROM session_students WHERE session_id=? AND student_id=? AND status<>\'REMOVED\'',
      [session.id, student.id],
    );
    if (own) { alreadyIn.push({ ...base, studentState: own.status }); continue; }
    if (!granted.has(student.id)) { blocked.push({ ...base, reason: 'NO_GRANT', reasonText: '没有这个课包的许可（到「学员许可」分给 ta）' }); continue; }
    const occupied = activeParticipationFor({ studentId: student.id, lessonId: session.lesson_id });
    if (occupied) {
      blocked.push({
        ...base, reason: 'IN_OTHER_SESSION',
        reasonText: `已在另一个课堂里（${occupied.session_title || '未命名课堂'} · ${SESSION_STATE_LABELS[occupied.session_status] || occupied.session_status} · ${occupied.teacher_name || '未知老师'}）`,
        session: { id: occupied.session_id, title: occupied.session_title || null, status: occupied.session_status, teacherName: occupied.teacher_name || null },
      });
      continue;
    }
    const completed = completedParticipationFor({ studentId: student.id, lessonId: session.lesson_id });
    if (completed) {
      blocked.push({
        ...base, reason: 'COMPLETED',
        reasonText: `这节课已经完课了（${completed.session_title || '课堂'}${completed.completed_at ? ` · ${String(completed.completed_at).slice(0, 10)}` : ''}）——可以上这个课包的其他课时`,
        session: { id: completed.session_id, title: completed.session_title || null, status: 'COMPLETED', teacherName: completed.teacher_name || null },
      });
      continue;
    }
    selectable.push(base);
  }
  return { selectable, blocked, alreadyIn };
}

/** 候选人的算力池摘要（老师端口径）。没有课包/没填预算 → unlimited。 */
function candidatePool(studentId, seriesId, seriesTitle) {
  if (!seriesId) return { poolUnlimited: true, poolCapYuan: null, poolRemainYuan: null, poolPercent: null };
  const pool = computePoolSummary({ userId: studentId, seriesId, seriesTitle });
  return {
    poolUnlimited: pool.unlimited,
    poolCapYuan: pool.capYuan,
    poolRemainYuan: pool.remainYuan,
    poolPercent: pool.usagePercent,
  };
}

/**
 * 结束课堂时结算学员状态：这节课花过算力 → 已完课，否则 → 未完课。
 * 幂等：只结算还在 PENDING/ACTIVE 的行；已结算的行不动（重复点「结束」不会重算）。
 */
export function settleSessionStudents({ sessionId, actorId }) {
  const parts = rows("SELECT * FROM session_students WHERE session_id=? AND status IN ('PENDING','ACTIVE')", [sessionId]);
  const now = nowIso();
  const summary = { completed: 0, incomplete: 0 };
  for (const part of parts) {
    const costFen = lessonCostFenFor({ studentId: part.student_id, sessionId });
    const status = costFen > 0 ? 'COMPLETED' : 'INCOMPLETE';
    q('UPDATE session_students SET status=?, completed_at=?, completed_cost_fen=?, updated_at=? WHERE id=?',
      [status, now, costFen, now, part.id]);
    if (status === 'COMPLETED') summary.completed += 1; else summary.incomplete += 1;
  }
  void actorId;
  return summary;
}

/** 加学员（事务内）：把学生加进课堂名单；已结束/已解散的课堂不能加。 */
export function addSessionStudents({ session, studentIds, actorId }) {
  if (!['PENDING', 'ACTIVE'].includes(session.status)) throw errors.conflict('课堂已结束或已解散，不能再加学员', 'SESSION_NOT_OPEN');
  const now = nowIso();
  const added = [];
  const skipped = [];
  transaction(() => {
    for (const studentId of studentIds) {
      const student = row("SELECT * FROM users WHERE id=? AND org_id=? AND role='STUDENT' AND deleted_at IS NULL", [studentId, session.org_id]);
      if (!student) { skipped.push({ studentId, reason: 'STUDENT_NOT_FOUND' }); continue; }
      const own = row("SELECT * FROM session_students WHERE session_id=? AND student_id=? AND status<>'REMOVED'", [session.id, studentId]);
      if (own) { skipped.push({ studentId, reason: 'ALREADY_IN' }); continue; }
      const granted = row('SELECT id FROM student_course_grants WHERE org_id=? AND series_id=? AND student_id=? AND revoked_at IS NULL', [session.org_id, session.series_id, studentId]);
      if (!granted) { skipped.push({ studentId, reason: 'NO_GRANT' }); continue; }
      const occupied = activeParticipationFor({ studentId, lessonId: session.lesson_id, excludeSessionId: session.id });
      if (occupied) { skipped.push({ studentId, reason: 'IN_OTHER_SESSION' }); continue; }
      const completed = completedParticipationFor({ studentId, lessonId: session.lesson_id, excludeSessionId: session.id });
      if (completed) { skipped.push({ studentId, reason: 'COMPLETED' }); continue; }
      // 被移除过的话：复用那行并复活（保留历史痕迹：清掉移除信息、重新标记 added_at）
      const removed = row("SELECT * FROM session_students WHERE session_id=? AND student_id=? AND status='REMOVED'", [session.id, studentId]);
      const status = session.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING';
      if (removed) {
        q('UPDATE session_students SET status=?, added_by=?, added_at=?, removed_by=NULL, removed_at=NULL, removed_reason=NULL, updated_at=? WHERE id=?',
          [status, actorId, now, now, removed.id]);
      } else {
        q(`INSERT INTO session_students(id, session_id, student_id, org_id, lesson_id, series_id, status, added_by, added_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id('sstudent'), session.id, studentId, session.org_id, session.lesson_id, session.series_id, status, actorId, now, now]);
      }
      added.push(studentId);
    }
  });
  return { added, skipped };
}

/** 移除学员：只在开始上课前允许（用户口径「移除＝解锁」）。 */
export function removeSessionStudent({ session, studentId, actorId, reason = null }) {
  if (session.status !== 'PENDING') throw errors.conflict('只能在开始上课前移除学员', 'SESSION_ALREADY_STARTED');
  const now = nowIso();
  const part = row("SELECT * FROM session_students WHERE session_id=? AND student_id=? AND status<>'REMOVED'", [session.id, studentId]);
  if (!part) throw errors.notFound('这名学员不在课堂名单里', 'SESSION_STUDENT_NOT_FOUND');
  q("UPDATE session_students SET status='REMOVED', removed_by=?, removed_at=?, removed_reason=?, updated_at=? WHERE id=?",
    [actorId, now, reason, now, part.id]);
  return { studentId, removedAt: now };
}

/** 课堂列表上的学员统计（避免前端 N+1）。 */
export function sessionStudentCounts(sessionIds) {
  if (!sessionIds.length) return new Map();
  const placeholders = sessionIds.map(() => '?').join(',');
  return new Map(rows(
    `SELECT session_id, status, COUNT(*) n FROM session_students
      WHERE session_id IN (${placeholders}) AND status<>'REMOVED' GROUP BY session_id, status`,
    sessionIds,
  ).map((item) => [`${item.session_id}:${item.status}`, Number(item.n || 0)]));
}

export function normalizeSessionStudent(part) {
  const LABELS = { PENDING: '待上课', ACTIVE: '上课中', COMPLETED: '已完课', INCOMPLETE: '未完课', REMOVED: '被移除' };
  return {
    id: part.id,
    sessionId: part.session_id,
    studentId: part.student_id,
    studentName: part.student_name || null,
    studentLogin: part.student_login || null,
    status: part.status,
    statusLabel: LABELS[part.status] || part.status,
    addedAt: part.added_at || null,
    addedByName: part.added_by_name || null,
    removedAt: part.removed_at || null,
    removedReason: part.removed_reason || null,
    completedAt: part.completed_at || null,
    completedCostFen: Number(part.completed_cost_fen || 0),
  };
}
