/**
 * 守卫用的「课堂夹具」（2026-09-13 批次 B）。
 *
 * 背景：门禁从「班级课单 + 老师开课」换成「**学员许可 + 课堂名单**」之后，凡是让学生直接
 * 去创作/生成的守卫，都必须先让这个学生**进到某个进行中的课堂名单里**，否则一律被
 * `NOT_IN_CLASSROOM` 拦住（那正是新口径要的行为，不是 bug）。
 *
 * 覆盖：**每个持有有效许可的学生 × 他那个课包的每一节已发布课时**，各确保一个 ACTIVE 课堂
 * 并把他加进名单（入口类型跟随课时的 delivery_mode）。守卫不用关心「我用的哪个学生、哪节课」。
 *
 * ⚠️ 它**不造许可**：没有许可就什么都不做 —— 在夹具里顺手发许可等于篡改被验的前提
 *    （那会让「没许可就进不去」这条用例永远测得通）。
 */
import { DatabaseSync } from 'node:sqlite';

const teacherOf = (db, orgId) => db.prepare(
  "SELECT id FROM users WHERE org_id=? AND role='TEACHER' AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
).get(orgId)?.id || null;

/** 每个有许可的学生 × 该课包的每节已发布课时 → 一个 ACTIVE 课堂 + 他在名单里。幂等。 */
export function ensureClassroom(dbPath) {
  const db = new DatabaseSync(dbPath);
  const created = [];
  try {
    // 守卫环境可能还没建库/建表（有的守卫是自己在进程内造库）—— 那种情况直接什么都不做
    const ready = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='student_course_grants'").get();
    if (!ready) return created;
    const grants = db.prepare(
      `SELECT grant.student_id, grant.org_id, grant.series_id
         FROM student_course_grants grant
         JOIN users student ON student.id = grant.student_id AND student.deleted_at IS NULL
        WHERE grant.revoked_at IS NULL`,
    ).all();
    if (!grants.length) return created;
    const now = new Date().toISOString();
    for (const grant of grants) {
      const lessons = db.prepare(
        "SELECT id, title, delivery_mode FROM course_lessons WHERE series_id=? AND status='PUBLISHED'",
      ).all(grant.series_id);
      if (!lessons.length) continue;
      const teacherId = teacherOf(db, grant.org_id) || grant.student_id;
      const classmates = grants.filter((item) => item.series_id === grant.series_id).map((item) => item.student_id);
      for (const lesson of lessons) {
        let session = db.prepare("SELECT id FROM class_sessions WHERE lesson_id=? AND status='ACTIVE' LIMIT 1").get(lesson.id);
        if (!session) {
          const sessionId = 'csession_fixture_' + Math.random().toString(36).slice(2, 10);
          db.prepare(
            "INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,started_by,started_at,created_at,updated_at) " +
            "VALUES (?,?,?,?,?,?, 'ACTIVE', ?, ?, ?, ?, ?)",
          ).run(sessionId, (lesson.title || '课时') + ' · 守卫夹具课堂', grant.org_id, grant.series_id, lesson.id,
            teacherId, lesson.delivery_mode || 'CANVAS', teacherId, now, now, now);
          session = { id: sessionId };
          created.push(sessionId);
        }
        for (const studentId of classmates) {
          db.prepare(
            "INSERT OR IGNORE INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at) " +
            "VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)",
          ).run('sstudent_fixture_' + session.id + '_' + studentId, session.id, studentId, grant.org_id, lesson.id, grant.series_id, teacherId, now, now);
        }
      }
    }
    return created;
  } finally {
    db.close();
  }
}

/**
 * 把学生在这节课上的课堂**换一种入口类型**。
 * 为什么需要：一个课堂只有一种入口（既定设计），而守卫经常要先后验画布与 VibeCoding 两条链；
 * 而「一个学生在一节课上只能属于一个未结束的课堂」又要求先把上一个结束掉。
 * 做法：先结束他当前那个 ACTIVE 课堂（学员结算成未完课 → 不挡重新加入），再按新模式建一个。
 * 该课包下**每节已发布课时**都切一遍（守卫常会遍历候选课时）。
 */
export function switchClassroom(dbPath, { deliveryMode = 'VIBECODING' } = {}) {
  const db = new DatabaseSync(dbPath);
  const switched = [];
  try {
    // ⚠️ 要覆盖**所有**有许可的课包：只取第一个的话，守卫遍历到的其它课包课时仍然进不去
    const grants = db.prepare(
      `SELECT grant.student_id, grant.org_id, grant.series_id
         FROM student_course_grants grant
         JOIN users student ON student.id = grant.student_id AND student.deleted_at IS NULL
        WHERE grant.revoked_at IS NULL`,
    ).all();
    if (!grants.length) return switched;
    const now = new Date().toISOString();
    for (const grant of grants) {
      // ⚠️ 只切**支持 VibeCoding** 的课时：把只开画布的课时也切成 VibeCoding 课堂，
      // 会让「画布课时走 VibeCoding 应被拒」这类断言失效（p16 就是这么被我搞红的）。
      const lessons = db.prepare(
        "SELECT id, title, delivery_mode, delivery_modes FROM course_lessons WHERE series_id=? AND status='PUBLISHED'",
      ).all(grant.series_id).filter((lesson) => {
        const modes = Array.isArray(lesson.delivery_modes)
          ? lesson.delivery_modes
          : (() => { try { return JSON.parse(lesson.delivery_modes || '[]'); } catch { return []; } })();
        return lesson.delivery_mode === 'VIBECODING' || modes.includes('VIBECODING');
      });
      const teacherId = teacherOf(db, grant.org_id) || grant.student_id;
      for (const lesson of lessons) {
        const current = db.prepare(
          "SELECT session.id FROM session_students part JOIN class_sessions session ON session.id = part.session_id " +
          "WHERE part.student_id=? AND part.lesson_id=? AND part.status IN ('PENDING','ACTIVE')",
        ).get(grant.student_id, lesson.id);
        if (current?.id) {
          db.prepare("UPDATE class_sessions SET status='ENDED', ended_at=?, ended_reason='FIXTURE_SWITCH', updated_at=? WHERE id=?").run(now, now, current.id);
          db.prepare("UPDATE session_students SET status='INCOMPLETE', completed_at=?, updated_at=? WHERE session_id=? AND status IN ('PENDING','ACTIVE')").run(now, now, current.id);
        }
        const sessionId = 'csession_fixture_switch_' + Math.random().toString(36).slice(2, 8);
        db.prepare(
          "INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,started_by,started_at,created_at,updated_at) " +
          "VALUES (?,?,?,?,?,?, 'ACTIVE', ?, ?, ?, ?, ?)",
        ).run(sessionId, (lesson.title || '课时') + ' · ' + deliveryMode + ' 夹具课堂', grant.org_id, grant.series_id,
          lesson.id, teacherId, deliveryMode, teacherId, now, now, now);
        db.prepare(
          "INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at) " +
          "VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)",
        ).run('sstudent_fixture_' + sessionId, sessionId, grant.student_id, grant.org_id, lesson.id, grant.series_id, teacherId, now, now);
        switched.push(sessionId);
      }
    }
    return switched;
  } finally {
    db.close();
  }
}
