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
 *
 * ─────────────────── 2026-09-24：改成**驱动无关**（RDS 阶段 2 的最后一块）───────────────────
 * 原来这里拿一个 SQLite 句柄（`new DatabaseSync`）直接写库，MySQL 驱动下那些写会落到一个
 * **没人看的 SQLite 文件**上，而应用读的是 MySQL → 守卫表现成"数据不存在"（p78 读到的
 * student 是 undefined）。现在全部走**数据层**（`aq/arow/arows`）：与应用同一个库、同一个驱动。
 *
 * 两条不能踩的：
 *   ① **数据层必须懒加载**（每个函数里 `await import(...)`，不能是模块级 import）：
 *      这些守卫是**静态 import** 这个夹具的，模块级 import 会被提升到最前面 →
 *      数据层会在 `PLATFORM_DB_PATH` / `MYSQL_*` 还没设好时加载 → 走到仓库里的
 *      `data/platform.db` 上去（那是事故）。放在函数里，调用时 env 早就设好了。
 *   ② `dbPath` 参数保留但**不再使用**（签名兼容）：真正用哪个库由调用方的 env 决定，
 *      转换工具会给每个脚本补上 `process.env.PLATFORM_DB_PATH ||= <它自己的临时库>`。
 */
const store = () => import('../../packages/database/src/store.js');

/** 每个有许可的学生 × 该课包的每节已发布课时 → 一个 ACTIVE 课堂 + 他在名单里。幂等。 */
export async function ensureClassroom(dbPath) {
  const { aq, arow, arows, isMysql } = await store();
  const created = [];
  // 守卫环境可能还没建库/建表（有的守卫是自己在进程内造库）—— 那种情况直接什么都不做。
  // ⚠️ 这条探测是**方言相关**的：SQLite 看 sqlite_master，MySQL 看 information_schema
  //    （MySQL 侧的表结构由迁移脚本建，不在应用里跑 DDL）。
  const probeSql = isMysql
    ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name='student_course_grants'"
    : "SELECT name FROM sqlite_master WHERE type='table' AND name='student_course_grants'";
  const ready = await arow(probeSql, []);
  if (!ready) return created;

  const grants = await arows(
    `SELECT grant.student_id, grant.org_id, grant.series_id
       FROM student_course_grants grant
       JOIN users student ON student.id = grant.student_id AND student.deleted_at IS NULL
      WHERE grant.revoked_at IS NULL`,
    [],
  );
  if (!grants.length) return created;
  const now = new Date().toISOString();
  for (const grant of grants) {
    const lessons = await arows(
      "SELECT id, title, delivery_mode FROM course_lessons WHERE series_id=? AND status='PUBLISHED'",
      [grant.series_id],
    );
    if (!lessons.length) continue;
    const teacherId = (await teacherOf(grant.org_id)) || grant.student_id;
    const classmates = grants.filter((item) => item.series_id === grant.series_id).map((item) => item.student_id);
    for (const lesson of lessons) {
      let session = await arow("SELECT id FROM class_sessions WHERE lesson_id=? AND status='ACTIVE' LIMIT 1", [lesson.id]);
      if (!session) {
        const sessionId = 'csession_fixture_' + Math.random().toString(36).slice(2, 10);
        const caps = await sessionCapabilityFlags(lesson.id);
        await aq(
          "INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode," +
          "allow_text,allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,started_by,started_at,created_at,updated_at) " +
          "VALUES (?,?,?,?,?,?, 'ACTIVE', ?, ?,?,?,?,?,?, ?, ?, ?, ?)",
          [sessionId, (lesson.title || '课时') + ' · 守卫夹具课堂', grant.org_id, grant.series_id, lesson.id,
            teacherId, lesson.delivery_mode || 'CANVAS',
            caps.text, caps.image, caps.music, caps.video, caps.podcast, caps.dubbing,
            teacherId, now, now, now],
        );
        session = { id: sessionId };
        created.push(sessionId);
      }
      for (const studentId of classmates) {
        await aq(
          "INSERT OR IGNORE INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at) " +
          "VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)",
          ['sstudent_fixture_' + session.id + '_' + studentId, session.id, studentId, grant.org_id, lesson.id, grant.series_id, teacherId, now, now],
        );
      }
    }
  }
  return created;
}

/**
 * 把学生在这节课上的课堂**换一种入口类型**。
 * 为什么需要：一个课堂只有一种入口（既定设计），而守卫经常要先后验画布与 VibeCoding 两条链；
 * 而「一个学生在一节课上只能属于一个未结束的课堂」又要求先把上一个结束掉。
 * 做法：先结束他当前那个 ACTIVE 课堂（学员结算成未完课 → 不挡重新加入），再按新模式建一个。
 * 该课包下**每节已发布课时**都切一遍（守卫常会遍历候选课时）。
 */
export async function switchClassroom(dbPath, { deliveryMode = 'VIBECODING', requireSupports = true } = {}) {
  const { aq, arow, arows } = await store();
  const switched = [];
  // ⚠️ 要覆盖**所有**有许可的课包：只取第一个的话，守卫遍历到的其它课包课时仍然进不去
  const grants = await arows(
    `SELECT grant.student_id, grant.org_id, grant.series_id
       FROM student_course_grants grant
       JOIN users student ON student.id = grant.student_id AND student.deleted_at IS NULL
      WHERE grant.revoked_at IS NULL`,
    [],
  );
  if (!grants.length) return switched;
  const now = new Date().toISOString();
  for (const grant of grants) {
    // ⚠️ 只切**支持 VibeCoding** 的课时（默认）：把只开画布的课时也切成 VibeCoding 课堂，
    // 会让「画布课时走 VibeCoding 应被拒」这类断言失效（p16 就是这么被我搞红的）。
    // 需要切**回**画布（守卫要先后走两条链、或走的是画布链路）时传 `requireSupports:false`。
    const lessons = (await arows(
      "SELECT id, title, delivery_mode, delivery_modes FROM course_lessons WHERE series_id=? AND status='PUBLISHED'",
      [grant.series_id],
    )).filter((lesson) => {
      if (!requireSupports) return true;
      const modes = Array.isArray(lesson.delivery_modes)
        ? lesson.delivery_modes
        : (() => { try { return JSON.parse(lesson.delivery_modes || '[]'); } catch { return []; } })();
      return lesson.delivery_mode === 'VIBECODING' || modes.includes('VIBECODING');
    });
    const teacherId = (await teacherOf(grant.org_id)) || grant.student_id;
    for (const lesson of lessons) {
      const current = await arow(
        "SELECT session.id FROM session_students part JOIN class_sessions session ON session.id = part.session_id " +
        "WHERE part.student_id=? AND part.lesson_id=? AND part.status IN ('PENDING','ACTIVE')",
        [grant.student_id, lesson.id],
      );
      if (current?.id) {
        await aq("UPDATE class_sessions SET status='ENDED', ended_at=?, ended_reason='FIXTURE_SWITCH', updated_at=? WHERE id=?", [now, now, current.id]);
        await aq("UPDATE session_students SET status='INCOMPLETE', completed_at=?, updated_at=? WHERE session_id=? AND status IN ('PENDING','ACTIVE')", [now, now, current.id]);
      }
      const sessionId = 'csession_fixture_switch_' + Math.random().toString(36).slice(2, 8);
      const caps = await sessionCapabilityFlags(lesson.id);
      await aq(
        "INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode," +
        "allow_text,allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,started_by,started_at,created_at,updated_at) " +
        "VALUES (?,?,?,?,?,?, 'ACTIVE', ?, ?,?,?,?,?,?, ?, ?, ?, ?)",
        [sessionId, (lesson.title || '课时') + ' · ' + deliveryMode + ' 夹具课堂', grant.org_id, grant.series_id,
          lesson.id, teacherId, deliveryMode,
          caps.text, caps.image, caps.music, caps.video, caps.podcast, caps.dubbing,
          teacherId, now, now, now],
      );
      await aq(
        "INSERT OR IGNORE INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at) " +
        "VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)",
        ['sstudent_fixture_' + sessionId, sessionId, grant.student_id, grant.org_id, lesson.id, grant.series_id, teacherId, now, now],
      );
      switched.push(sessionId);
    }
  }
  return switched;
}

/** 该机构最早的一位老师（找不到就退回学生自己，早先就这么兜的）。 */
async function teacherOf(orgId) {
  const { arow } = await store();
  const row = await arow(
    "SELECT id FROM users WHERE org_id=? AND role='TEACHER' AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
    [orgId],
  );
  return row?.id || null;
}

/**
 * 课堂的 AI 能力开关（class_sessions.allow_*）。
 * 课时**声明过**的能力就在课堂上打开 —— 真实开课流程就是这么算的（orgAdmin 里的 `capabilityDefault`
 * 按 `course_lesson_capabilities` 取值）。没声明的沿用列默认值（text/image/music=1、video/…=0）。
 *
 * ⚠️ 刻意**不**严格照抄 `capabilityDefault`（它「没声明就是 0」）：种子里那些课时根本没有
 *    `course_lesson_capabilities` 行，照抄会把它们的 TEXT/IMAGE 全关掉，连带把一批只验生成链路的守卫
 *    搞红 —— 而那并不是它们要验的东西。（p11 是反例：它插了 'video'，所以这里必须真的打开 allow_video，
 *    否则 `assertCapability` 直接报 SESSION_CAPABILITY_DISABLED。）
 */
const DEFAULT_SESSION_CAPABILITY = { text: 1, image: 1, music: 1, video: 0, podcast: 0, dubbing: 0 };
async function sessionCapabilityFlags(lessonId) {
  const { arows } = await store();
  let declared = new Set();
  try {
    declared = new Set((await arows('SELECT capability FROM course_lesson_capabilities WHERE lesson_id=?', [lessonId])).map((row) => row.capability));
  } catch { /* 老库/自造库可能没有这张表 —— 那就按默认值来 */ }
  const flags = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SESSION_CAPABILITY)) flags[key] = declared.has(key) ? 1 : fallback;
  return flags;
}

/**
 * ⚠️ **2026-09-24 退役**（RDS 阶段 2 的夹具改造完成）。
 *
 * 改造前它返回一个 SQLite 句柄（`new DatabaseSync`），守卫拿它直接写库；改造后所有夹具写库
 * 都走**数据层**（同一个库、驱动无关），没有任何地方还需要句柄。
 *
 * 这个壳**保留但会抛错**：老脚本里若还有 `import { openDb }` 就不至于 import 失败
 * （ESM 里 import 一个不存在的导出是加载期直接炸），而真被调用时会**当场报错** ——
 * 那是"还有调用点没改完"的信号，绝不能让一个坏句柄静默溜过去。
 */
export function openDb() {
  throw new Error('openDb 已退役：夹具改用数据层的 aq / arow / arows（见 scripts/lib/classroomFixture.mjs 文件头）');
}
