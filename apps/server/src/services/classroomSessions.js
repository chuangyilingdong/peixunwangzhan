// 「课堂」的领域逻辑（2026-09-13，批次 B：班级退场、课堂成为主对象）。
//
// 四态：PENDING（待上课，已创建未开始）/ ACTIVE（上课中）/ ENDED（已结束）/ DISSOLVED（已解散）
// 学员六态：不在任何行 = 未加入任何课堂 … PENDING 待上课 / ACTIVE 上课中 /
//           COMPLETED 已完课 / INCOMPLETE 未完课 / REMOVED 被移除
//
// 完课判定 = 这个学生在这节课**消耗过算力**（真实成功调用，不依赖费用是否已知或大于零）。
// 这里有三个规则是用户逐条定的，改动前请先看注释：
//   ① 已完课的学员**不能再被加到同一节课**（但可以上同课包的其他课时）；
//   ② 未结束的参与（待上课/上课中）也不允许被别的课堂同时占用；
//   ③ 被移除 = 解锁（可以再被其他课堂加）。
import { errors, id, nowIso, q, row, rows, transaction, arow, arows, aq, atransaction, amap } from '../lib.js';
import { salePriceFenFor } from './computePool.js';
import { sessionCostUsageByStudent, sessionCostCapState, studentCostCapFen } from './sessionCostCap.js';

/**
 * 谁可以**管理**这个课堂（开始 / 结束 / 解散 / 改名单 / 改名称）？
 *
 * ⭐ 2026-09-20 用户口径：「机构端应该拥有老师端的所有权限」 —— 原来是"仅课堂负责人本人"，
 * 于是机构管理员打开别的老师建的课堂时**连「结束课堂」都点不了**（详情里所有权限都是 false），
 * 机构没法给老师收尾。现在：**负责人本人**，或者**本机构的机构管理员**。
 *
 * ⚠️ 机构管理员那一支必须同时比 `org_id`：不然 A 机构的机构管理员就能改 B 机构的课堂（越权）。
 * ⚠️ 这个判定**只有这一处**：写路径（assertSessionManager）、详情里的权限投影、
 *    解散前的逐条校验都调它 —— 三处各写一遍迟早会打架（本项目已经栽过好几次）。
 */
export function canManageSession(auth, session) {
  if (!auth?.user || !session) return false;
  if (!['ORG_ADMIN', 'TEACHER'].includes(auth.user.role)) return false;
  if (session.teacher_id && session.teacher_id === auth.user.id) return true;
  if (auth.user.role !== 'ORG_ADMIN') return false;
  // ⚠️ 两边都写两种拼法：auth 上的用户对象是**规范化后**的（`orgId`），而 session 是**原始行**（`org_id`）。
  //    第一版我只写了 `auth.user.org_id` → 恒为 undefined → 机构管理员照样管不了（p96 当场抓到）。
  const callerOrgId = auth.user.orgId || auth.user.org_id || null;
  const sessionOrgId = session.org_id || session.orgId || null;
  return Boolean(callerOrgId) && sessionOrgId === callerOrgId;
}

/** 写操作：负责人本人，或本机构的机构管理员（见 canManageSession）。 */
export function assertSessionManager(auth, session) {
  if (canManageSession(auth, session)) return session;
  throw errors.forbidden('这不是你负责的课堂（机构管理员只能管理本机构的课堂）', 'SESSION_PERMISSION_DENIED');
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

/**
 * 这个学生在这节课上的**对外售价合计（分）** —— 用于机构端「这节课消耗」列与课堂结算。
 *
 * 2026-09-15 改口径：原来读 `usage_records.cost_fen`，那一列现行代码恒写 0
 * （平台承担算力成本、不扣学生），所以这一列在机构端**永远显示 ¥0.00**。
 * 现在改为对外售价口径（见 computePool.salePriceFenFor 的完整说明）：
 * 机构/学员看到的是「按公告价算的消耗」，平台自己的进货成本与毛利只在「用量与成本」看。
 */
export async function lessonCostFenFor({ studentId, sessionId }) {
  return await salePriceFenFor({ sessionId, studentId });
}

/** 学生全局非终态占用：不区分课包或课程；REMOVED 不算占用。 */
export async function activeParticipationFor({ studentId, lessonId = null, excludeSessionId = null }) {
  const lessonClause = lessonId ? ' AND part.lesson_id=?' : '';
  const params = lessonId ? [studentId, lessonId] : [studentId];
  if (excludeSessionId) { params.push(excludeSessionId); }
  return await arow(
    `SELECT part.*, session.title session_title, session.status session_status, session.teacher_id session_teacher_id,
        session.lesson_id occupied_lesson_id, session.series_id occupied_series_id,
        lesson.title occupied_lesson_title, teacher.display_name teacher_name, session.started_at, session.created_at
      FROM session_students part
      JOIN class_sessions session ON session.id = part.session_id
      LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
      LEFT JOIN users teacher ON teacher.id = session.teacher_id
      WHERE part.student_id=?${lessonClause} AND part.status IN ('PENDING','ACTIVE') AND session.status IN ('PENDING','ACTIVE')
        ${excludeSessionId ? 'AND part.session_id <> ?' : ''}
      ORDER BY part.added_at DESC LIMIT 1`, params,
  ) || null;
}

/** 该学生在这节课上是否已经完课（完课行不会被移除，所以直接查）。 */
export async function completedParticipationFor({ studentId, lessonId, excludeSessionId = null }) {
  return await arow(
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
export async function sessionCandidates(session) {
  const students = await arows(
    `SELECT student.id, student.login, student.display_name, student.status, student.expires_at
      FROM users student
      WHERE student.org_id=? AND student.role='STUDENT' AND student.deleted_at IS NULL
      ORDER BY student.display_name, student.login`,
    [session.org_id],
  );
  const granted = new Set((await arows(
    'SELECT student_id FROM student_course_grants WHERE org_id=? AND series_id=? AND revoked_at IS NULL',
    [session.org_id, session.series_id],
  )).map((item) => item.student_id));
  const selectable = [];
  const blocked = [];
  const alreadyIn = [];
  for (const student of students) {
    // 额度摘要挂在**每一条**候选上（可加 / 不可加 / 已在这节课上）——
    // 老师挑人时要能看出「这场课堂给每个学生多少算力、他在这堂课上已经花了多少」，
    // 而这个人可能正好因为别的原因暂时不可加。
    // 2026-09-18（用户口径）：口径从「按课包的池子」换成**唯一那套按钱的**
    // （每学生 × 本场课堂的上游成本上限，见 services/sessionCostCap.js）——
    // 原来的池子那套恒 `unlimited`，「不限」是一句永远为真的废话。
    const base = {
      id: student.id, login: student.login, name: student.display_name || student.login, accountStatus: student.status,
      ...await candidateCostCap(session, student.id),
    };
    const own = await arow(
      'SELECT status FROM session_students WHERE session_id=? AND student_id=? AND status<>\'REMOVED\'',
      [session.id, student.id],
    );
    if (own) { alreadyIn.push({ ...base, studentState: own.status }); continue; }
    if (student.status !== 'ACTIVE') { blocked.push({ ...base, reason: 'STUDENT_DISABLED', reasonText: '学员账号已停用' }); continue; }
    if (student.expires_at && Date.parse(student.expires_at) <= Date.now()) { blocked.push({ ...base, reason: 'STUDENT_EXPIRED', reasonText: '学员账号已到期' }); continue; }
    if (!granted.has(student.id)) { blocked.push({ ...base, reason: 'NO_GRANT', reasonText: '没有这个课包的许可（到「学员许可」分给 ta）' }); continue; }
    const occupied = await activeParticipationFor({ studentId: student.id });
    if (occupied) {
      blocked.push({
        ...base, reason: 'IN_OTHER_SESSION',
        reasonText: `已在另一个课堂里（${occupied.session_title || '未命名课堂'} · ${occupied.occupied_lesson_title || '未知课程'} · ${SESSION_STATE_LABELS[occupied.session_status] || occupied.session_status} · ${occupied.teacher_name || '未知老师'}）`,
        session: { id: occupied.session_id, title: occupied.session_title || null, status: occupied.session_status, teacherName: occupied.teacher_name || null },
      });
      continue;
    }
    const completed = await completedParticipationFor({ studentId: student.id, lessonId: session.lesson_id });
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

/**
 * 候选人的算力**观测**摘要（老师端口径）—— 读唯一那套（**只观测、不真拦**，
 * 2026-09-18 用户口径）：本场课堂每学生的观测上限（`class_sessions.student_cost_cap_fen`，
 * 留空 = 不设观测上限）+ ta 在这堂课已花的上游成本。
 *
 * 键名（`poolUnlimited` / `poolCapYuan` / `poolUsedYuan` / `poolRemainYuan` / `poolPercent`）
 * **保持不变**：机构端「添加学生」页整列在渲染它们，而且这些键的语义本来就是
 * 「这个学生在这里花了多少」—— 变的是**数据源**（从恒 unlimited 的死池子换成新口径）
 * 和**性质**（观测数字，不是闸门）。
 * ⚠️ 键名里的 `Yuan` 是历史命名，**值一律是「分」**（与全仓 `formatYuan(fen)` 的入参口径一致）。
 */
async function candidateCostCap(session, studentId) {
  const capFen = session?.id ? await studentCostCapFen(session.id) : null;
  const usage = session?.id ? (await sessionCostUsageByStudent(session.id)).get(studentId) : null;
  const status = sessionCostCapState({ capFen, usedFen: usage?.usedFen || 0, unknownCalls: usage?.unknownCalls || 0 });
  return {
    poolUnlimited: !status.configured,
    poolCapYuan: status.capFen,
    // 「已用」是这名学生**在这场课堂**上已确认的上游成本（他还没进课堂时恒为 0，这是如实值）。
    poolUsedYuan: status.usedFen,
    poolRemainYuan: status.remainFen,
    poolPercent: status.usagePercent,
    poolUnknownCalls: status.unknownCalls,
    // 明写「不拦人」：老师看到"超了"时不该以为学生被系统挡住了。
    poolEnforced: false,
  };
}

/**
 * 结束课堂时结算学员状态：这节课花过算力 → 已完课，否则 → 未完课。
 * 幂等：只结算还在 PENDING/ACTIVE 的行；已结算的行不动（重复点「结束」不会重算）。
 */
export async function settleSessionStudents({ sessionId, actorId }) {
  const session = await arow('SELECT status FROM class_sessions WHERE id=?', [sessionId]);
  if (!session || session.status !== 'ACTIVE') return { completed: 0, incomplete: 0 };
  const parts = await arows("SELECT * FROM session_students WHERE session_id=? AND status IN ('PENDING','ACTIVE')", [sessionId]);
  const now = nowIso();
  const summary = { completed: 0, incomplete: 0 };
  for (const part of parts) {
    const costFen = await lessonCostFenFor({ studentId: part.student_id, sessionId });
    const used = await arow("SELECT id FROM usage_records WHERE class_session_id=? AND user_id=? AND org_id=? AND status='SUCCESS' AND UPPER(model) NOT LIKE '%MOCK%' AND UPPER(COALESCE(json_extract(pricing_snapshot, '$.provider'), '')) NOT LIKE '%MOCK%' AND UPPER(COALESCE(json_extract(pricing_snapshot, '$.mode'), '')) NOT LIKE '%MOCK%' LIMIT 1", [sessionId, part.student_id, part.org_id]);
    if (part.status === 'INCOMPLETE' && !used) continue;
    const status = used ? 'COMPLETED' : 'INCOMPLETE';
    await aq('UPDATE session_students SET status=?, completed_at=?, completed_cost_fen=?, updated_at=? WHERE id=?',
      [status, now, costFen, now, part.id]);
    if (status === 'COMPLETED') summary.completed += 1; else summary.incomplete += 1;
  }
  void actorId;
  return summary;
}

/** 加学员（事务内）：把学生加进课堂名单；已结束/已解散的课堂不能加。 */
export async function addSessionStudents({ session, studentIds, actorId }) {
  if (!['PENDING', 'ACTIVE'].includes(session.status)) throw errors.conflict('课堂已结束或已解散，不能再加学员', 'SESSION_NOT_OPEN');
  const now = nowIso();
  const added = [];
  const skipped = [];
  await atransaction(async () => {
    for (const studentId of studentIds) {
      const student = await arow("SELECT * FROM users WHERE id=? AND org_id=? AND role='STUDENT' AND deleted_at IS NULL", [studentId, session.org_id]);
      if (!student) { skipped.push({ studentId, reason: 'STUDENT_NOT_FOUND' }); continue; }
      if (student.status !== 'ACTIVE') { skipped.push({ studentId, reason: 'STUDENT_DISABLED' }); continue; }
      if (student.expires_at && Date.parse(student.expires_at) <= Date.now()) { skipped.push({ studentId, reason: 'STUDENT_EXPIRED' }); continue; }
      const own = await arow("SELECT * FROM session_students WHERE session_id=? AND student_id=? AND status<>'REMOVED'", [session.id, studentId]);
      if (own) { skipped.push({ studentId, reason: 'ALREADY_IN' }); continue; }
      const granted = await arow('SELECT id FROM student_course_grants WHERE org_id=? AND series_id=? AND student_id=? AND revoked_at IS NULL', [session.org_id, session.series_id, studentId]);
      if (!granted) { skipped.push({ studentId, reason: 'NO_GRANT' }); continue; }
      const occupied = await activeParticipationFor({ studentId, excludeSessionId: session.id });
      if (occupied) { skipped.push({ studentId, reason: 'IN_OTHER_SESSION' }); continue; }
      const completed = await completedParticipationFor({ studentId, lessonId: session.lesson_id, excludeSessionId: session.id });
      if (completed) { skipped.push({ studentId, reason: 'COMPLETED' }); continue; }
      // 被移除过的话：复用那行并复活（保留历史痕迹：清掉移除信息、重新标记 added_at）
      const removed = await arow("SELECT * FROM session_students WHERE session_id=? AND student_id=? AND status='REMOVED'", [session.id, studentId]);
      const status = session.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING';
      if (removed) {
        await aq('UPDATE session_students SET status=?, lesson_id=?, series_id=?, added_by=?, added_at=?, removed_by=NULL, removed_at=NULL, removed_reason=NULL, updated_at=? WHERE id=?',
          [status, session.lesson_id, session.series_id, actorId, now, now, removed.id]);
      } else {
        await aq(`INSERT INTO session_students(id, session_id, student_id, org_id, lesson_id, series_id, status, added_by, added_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id('sstudent'), session.id, studentId, session.org_id, session.lesson_id, session.series_id, status, actorId, now, now]);
      }
      added.push(studentId);
    }
  });
  return { added, skipped };
}

/** 移除学员：只在开始上课前允许（用户口径「移除＝解锁」）。 */
export async function removeSessionStudent({ session, studentId, actorId, reason = null }) {
  if (session.status !== 'PENDING') throw errors.conflict('只能在开始上课前移除学员', 'SESSION_ALREADY_STARTED');
  const now = nowIso();
  const part = await arow("SELECT * FROM session_students WHERE session_id=? AND student_id=? AND status<>'REMOVED'", [session.id, studentId]);
  if (!part) throw errors.notFound('这名学员不在课堂名单里', 'SESSION_STUDENT_NOT_FOUND');
  await aq("UPDATE session_students SET status='REMOVED', removed_by=?, removed_at=?, removed_reason=?, updated_at=? WHERE id=?",
    [actorId, now, reason, now, part.id]);
  return { studentId, removedAt: now };
}

/** 课堂列表上的学员统计（避免前端 N+1）。 */
export async function sessionStudentCounts(sessionIds) {
  if (!sessionIds.length) return new Map();
  const placeholders = sessionIds.map(() => '?').join(',');
  return new Map((await arows(
    `SELECT session_id, status, COUNT(*) n FROM session_students
      WHERE session_id IN (${placeholders}) AND status<>'REMOVED' GROUP BY session_id, status`,
    sessionIds,
  )).map((item) => [`${item.session_id}:${item.status}`, Number(item.n || 0)]));
}

export async function sessionRuntimeDetail(session, auth, students) {
  const asOf = nowIso();
  const latest = (values) => values.filter(Boolean).sort().at(-1) || null;
  const usage = await arows(`SELECT user_id, status, created_at FROM usage_records
    WHERE org_id=? AND class_session_id=? AND UPPER(model) NOT LIKE '%MOCK%'
    AND UPPER(COALESCE(json_extract(pricing_snapshot, '$.provider'), '')) NOT LIKE '%MOCK%'
    AND UPPER(COALESCE(json_extract(pricing_snapshot, '$.mode'), '')) NOT LIKE '%MOCK%'`, [session.org_id, session.id]);
  // 学生算力**观测**值（唯一那套，只观测不拦人）：每个学生在这堂课的上游成本 + 观测上限 + 差额。
  // 一次 group by 取全名单（不是每个学生打一次库），与老师端/平台端读的是同一份实现。
  const costCapFen = await studentCostCapFen(session.id);
  const costUsage = await sessionCostUsageByStudent(session.id);
  const costCapFor = (studentId) => sessionCostCapState({
    capFen: costCapFen,
    usedFen: costUsage.get(studentId)?.usedFen || 0,
    unknownCalls: costUsage.get(studentId)?.unknownCalls || 0,
  });
  const aiFor = async (studentId = null) => {
    const records = studentId ? usage.filter((item) => item.user_id === studentId) : usage;
    // costCap = 老师端要看的「这堂课花了多少 / 有没有超观测上限」（`enforced` 恒 false）。
    const costCap = studentId ? costCapFor(studentId) : sessionCostCapState({
      capFen: costCapFen,
      usedFen: [...costUsage.values()].reduce((total, item) => total + item.usedFen, 0),
      unknownCalls: [...costUsage.values()].reduce((total, item) => total + item.unknownCalls, 0),
    });
    return { successCount: records.filter((item) => item.status === 'SUCCESS').length,
      failedCount: records.filter((item) => item.status === 'FAILED').length,
      lastUsedAt: latest(records.map((item) => item.created_at)),
      costCap,
      salePriceFen: await salePriceFenFor({ orgId: session.org_id, sessionId: session.id, ...(studentId ? { studentId } : {}) }) };
  };
  const works = (await arows(`SELECT work.id,work.student_id,student.display_name student_name,work.title,work.status,
      work.submitted_at,work.project_id FROM works work JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id
      WHERE work.org_id=? AND work.class_session_id=?`, [session.org_id, session.id])).map((work) => ({
    id: work.id, source: 'CANVAS', studentId: work.student_id, studentName: work.student_name,
    title: work.title, status: work.status, createdAt: null, updatedAt: null, submittedAt: work.submitted_at,
    projectId: work.project_id, conversationId: null, entryFile: null, previewUrl: null,
  }));
  works.push(...(await arows(`SELECT submission.*,student.display_name student_name FROM vibecoding_submissions submission
    JOIN vibecoding_conversations conversation ON conversation.id=submission.conversation_id AND conversation.org_id=submission.org_id AND conversation.student_id=submission.student_id
    JOIN users student ON student.id=submission.student_id AND student.org_id=submission.org_id
    WHERE submission.org_id=? AND conversation.class_session_id=?`, [session.org_id, session.id])).map((work) => ({
    id: work.id, source: 'VIBECODING', studentId: work.student_id, studentName: work.student_name,
    title: work.title, status: work.status, createdAt: work.created_at, updatedAt: work.updated_at,
    submittedAt: work.submitted_at, projectId: null, conversationId: work.conversation_id,
    entryFile: work.entry_file, previewUrl: null,
  })));
  for (const work of works) work.detailUrl = `/api/org/sessions/${encodeURIComponent(session.id)}/works/${work.source}/${encodeURIComponent(work.id)}`;
  works.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  const labels = { SESSION_CREATE: '创建课堂', SESSION_UPDATE: '编辑课堂', SESSION_START: '开始上课', SESSION_END: '结束课堂', SESSION_DISSOLVE: '解散课堂', SESSION_STUDENTS_ADD: '添加学员', SESSION_STUDENT_REMOVE: '移除学员' };
  const events = (await arows(`SELECT audit.id,audit.action,audit.actor_id,actor.display_name actor_name,audit.created_at
    FROM audit_logs audit LEFT JOIN users actor ON actor.id=audit.actor_id
    WHERE audit.org_id=? AND audit.target_type='CLASS_SESSION' AND audit.target_id=? ORDER BY audit.created_at DESC LIMIT 200`, [session.org_id, session.id]))
    .filter((event) => labels[event.action]).map((event) => ({ id: event.id, action: event.action, actorId: event.actor_id,
      actorName: event.actor_name || null, createdAt: event.created_at, summary: labels[event.action] }));
  const activity = await arows(`SELECT student_id,updated_at activity_at FROM student_projects WHERE org_id=? AND class_session_id=? AND deleted_at IS NULL
    UNION ALL SELECT student_id,COALESCE(last_message_at,updated_at) activity_at FROM vibecoding_conversations WHERE org_id=? AND class_session_id=?`, [session.org_id, session.id, session.org_id, session.id]);
  const enrichedStudents = await amap(students, async (part) => {
    const ai = await aiFor(part.student_id);
    const ownWorks = works.filter((work) => work.studentId === part.student_id);
    return { ...normalizeSessionStudent(part), ai, presence: 'unknown', workCount: ownWorks.length,
      lastActivityAt: latest([ai.lastUsedAt, ...ownWorks.map((work) => work.submittedAt), ...activity.filter((item) => item.student_id === part.student_id).map((item) => item.activity_at)]) };
  });
  // 权限投影与写路径同一口径（见 canManageSession）：负责人本人，或本机构的机构管理员
  const canManage = canManageSession(auth, session) && ['PENDING', 'ACTIVE'].includes(session.status);
  const pending = canManage && session.status === 'PENDING';
  const until = session.status === 'ACTIVE' ? asOf : session.ended_at;
  const duration = session.started_at && until ? Math.max(0, Math.floor((Date.parse(until) - Date.parse(session.started_at)) / 1000)) : null;
  const sessionAi = await aiFor();
  return { canManage, permissions: { canManage, canEdit: pending, canStart: pending, canEnd: canManage && session.status === 'ACTIVE', canDissolve: pending, canAddStudents: canManage, canRemoveStudents: pending },
    runtime: { asOf, startedAt: session.started_at || null, endedAt: session.ended_at || null,
      durationSeconds: Number.isFinite(duration) ? duration : null,
      lastActivityAt: latest([...usage.map((item) => item.created_at), ...activity.map((item) => item.activity_at), ...works.map((item) => item.submittedAt), ...events.map((item) => item.createdAt)]),
      // costCap：本课堂的「每学生算力观测上限 + 整场已花」（配置列 class_sessions.student_cost_cap_fen，
      // 留空 = configured:false = 不设观测上限）。**只观测、不拦人**（enforced 恒 false），
      // 老师端由此显示「这堂课花了多少 / 有没有超观测上限」，学生端拿不到这个字段。
      presence: 'unknown', presenceSource: 'NO_HEARTBEAT', costCap: sessionAi.costCap, ai: sessionAi }, students: enrichedStudents, works, events };
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
