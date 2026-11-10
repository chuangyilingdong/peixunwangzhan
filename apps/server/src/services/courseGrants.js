// 课包许可的「次数账」。
//
// 口径（用户逐条确认过，别按自己的理解改）：
//   · 课包类型是**独立字段** `course_series.series_type`：`NORMAL`（默认）/ `EXPERIENCE`；
//     **不要**复用机构试用 `organizations.is_trial`、也不要靠标题或标签猜。
//   · **普通课包（2026-11-10 用户口径）：1 次授权 = 1 个课时次数** ——
//     学生上 1 节课扣 1 次，上 5 节就要有 5 次；同一课包可以重复分给同一学生、未用次数累积，
//     老师端只能添加「没上过这节课、且剩余次数 > 0」的学生。
//   · **体验课包（2026-09-24 用户口径）**：只包含 1 节课；同一个学生可以重复分配、未用次数累积；
//     同一节课可以反复上（这是体验包的意义）。
//   · 两种类型**共同的核销规则**：每场课堂正常结束、且该学生有有效 AI 产出时核销 1 次；
//     无产出不扣、`INCOMPLETE` 不扣、课堂解散（DISSOLVED）不扣。
//   · **普通课包不能重复上同一节课**（`COMPLETED` 后拦截）；体验课包故意放行。
//   · 体验课包行为在 2026-11-10 这次改造里**一个字没变**（p140 是回归基线）。
//
// 为什么普通包以前不是"按次数扣"：旧口径是「授权即消耗一次配额」（一个学生名额可以上完
// 48 节课），2026-11-10 用户明确改成"按课时次数"，所以现在两种类型都走这套次数账。

import { errors, id, nowIso, arow, arows, aq, isMysql } from '../lib.js';

export const SERIES_TYPES = Object.freeze(['NORMAL', 'EXPERIENCE']);
export const EXPERIENCE_SERIES_TYPE = 'EXPERIENCE';

/**
 * 「普通课」池子的存储键 = **最早创建的普通课系列**（生产里是 S1）。
 *
 * 2026-11-10 用户口径：S1/S2/S3 不是三个可分别授权的东西，而是同一个普通课的 48 节课；
 * 平台给机构的次数、机构给学生的次数，都是这 48 节共用的**一个池子**。
 * 实现上不新增表：把最早的那个普通课系列当作池子的 `series_id`，S2/S3 只保留
 * 0 次数的“可上课”授权（让课程中心/建课堂仍能访问），授权与核销都落在池子上。
 */
export async function normalPoolSeries() {
  return await arow(`SELECT id, title, series_type FROM course_series
    WHERE owner_type='PLATFORM' AND series_type='NORMAL'
    ORDER BY created_at, sort, id LIMIT 1`);
}

/** 这门课的授权/核销该落在哪个系列上：普通课 → 池子系列；体验课 → 自己。 */
export async function grantSeriesIdFor({ seriesId, seriesType }) {
  if (String(seriesType || '').toUpperCase() !== 'NORMAL') return seriesId;
  const pool = await normalPoolSeries();
  return pool?.id || seriesId;
}

/** 普通课当前已发布的课时总数（S1+S2+S3…，不含体验课）。 */
export async function normalLessonCount() {
  const row = await arow(`SELECT COUNT(*) n FROM course_lessons lesson
    JOIN course_series series ON series.id=lesson.series_id
    WHERE series.owner_type='PLATFORM' AND series.series_type='NORMAL'
      AND series.status='PUBLISHED' AND lesson.status='PUBLISHED'`);
  return Number(row?.n || 0);
}
// MySQL 下对许可行加行锁：核销 / 回收 / 平台撤销会并发改同一行，没有 FOR UPDATE 时
// 三个事务各自按旧快照算余额，可能出现「退多了 1 次」或「扣了但已退款」。SQLite 是全局写锁，不需要。
const FOR_UPDATE = isMysql ? ' FOR UPDATE' : '';

/** 课包类型（认不出来的值一律当普通课包 —— 老数据/脏数据不该被当成体验包）。 */
export function seriesTypeOf(series) {
  const value = String(series?.series_type ?? series?.seriesType ?? 'NORMAL').trim().toUpperCase();
  return SERIES_TYPES.includes(value) ? value : 'NORMAL';
}

export function isExperienceSeries(series) {
  return seriesTypeOf(series) === EXPERIENCE_SERIES_TYPE;
}

/** 创建/编辑课包时校验前端传来的类型（不接受任何别的写法）。 */
export function normalizeSeriesType(value, { fallback = 'NORMAL' } = {}) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return fallback;
  if (!SERIES_TYPES.includes(raw)) throw errors.badRequest('课包类型无效（只能是普通课包或体验课包）', 'INVALID_SERIES_TYPE');
  return raw;
}

/** 一条许可的次数账（`granted_units` 默认 1 / `consumed_units` 默认 0）。 */
export function grantUnitsOf(grant) {
  const granted = Number(grant?.granted_units ?? 1);
  const consumed = Number(grant?.consumed_units ?? 0);
  return {
    granted: Number.isFinite(granted) ? granted : 1,
    consumed: Number.isFinite(consumed) ? consumed : 0,
    remaining: Math.max(0, (Number.isFinite(granted) ? granted : 1) - (Number.isFinite(consumed) ? consumed : 0)),
  };
}

/** 这个学生在这个课包上的有效许可（撤销过就没有了）。 */
export async function activeGrantFor({ orgId, studentId, seriesId }) {
  return await arow(
    'SELECT * FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=? AND revoked_at IS NULL',
    [orgId, studentId, seriesId],
  ) || null;
}

/**
 * 同 `activeGrantFor`，但在 MySQL 下加 `FOR UPDATE` 行锁。
 * **必须在事务里调用**；核销 / 回收 / 平台撤销都先锁这一行再算余额，避免并发下按旧快照退多/扣错。
 */
export async function lockActiveGrantFor({ orgId, studentId, seriesId }) {
  return await arow(
    `SELECT * FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=? AND revoked_at IS NULL${FOR_UPDATE}`,
    [orgId, studentId, seriesId],
  ) || null;
}

/** 按 grant id 锁行（回收 / 平台撤销用；调用方自己校验 org / 权限）。 */
export async function lockGrantById(grantId) {
  return await arow(`SELECT * FROM student_course_grants WHERE id=?${FOR_UPDATE}`, [grantId]) || null;
}

/**
 * 一次取全「这个课包下每个学生的剩余次数」—— 候选人列表/加学生都用它，
 * 免得在循环里逐个学生打一次库。
 * （原名 `experienceBalanceByStudent`；2026-11-10 起普通课包也按次数，故改成通用名。）
 */
export async function grantBalanceByStudent({ orgId, seriesId }) {
  const rows = await arows(
    'SELECT student_id, granted_units, consumed_units FROM student_course_grants WHERE org_id=? AND series_id=? AND revoked_at IS NULL',
    [orgId, seriesId],
  );
  const map = new Map();
  for (const row of rows) map.set(row.student_id, grantUnitsOf(row).remaining);
  return map;
}

/** 兼容别名（老调用点/老脚本还在用这个名字）。 */
export const experienceBalanceByStudent = grantBalanceByStudent;

/**
 * 核销 1 次课时（在调用方的**同一个事务**里跑，见 orgAdmin 的 `/sessions/:id/end`）。
 *
 * 幂等：`student_course_grant_consumptions` 上的唯一索引（grant_id, session_id, student_id）是唯一依据 ——
 * 重复结束课堂、重试、并发都只会扣一次。余额不足时**抛错让整个结束事务回滚**：
 * 宁可结束失败（老师看到明确原因后去补一次授权），也不能出现「课已经结束、次数没扣」的账实不一致。
 *
 * 撤销过的许可不算"余额不足"：平台/机构回收时已经按未消费余额退过次数了，这里直接跳过并如实回报
 * （否则老师会因为一条早被撤销的授权而永远结束不了课堂）。
 *
 * 普通课包与体验课包共用这一个函数；错误码按类型区分，方便前端给出不同的补救提示。
 */
export async function consumeGrantUnit({ orgId, studentId, seriesId, grantSeriesId = null, lessonId = null, sessionId, actorId = null, seriesType = 'NORMAL' }) {
  // 普通课的次数落在「普通课池子」那一行上（seriesId 只用来记录"这一节属于哪个系列"）。
  const grantSeries = grantSeriesId || seriesId;
  // 锁行再算余额：MySQL 下与回收/平台撤销串行化（SQLite 全局写锁本来就串行）
  const grant = await lockActiveGrantFor({ orgId, studentId, seriesId: grantSeries });
  if (!grant) return { consumed: false, reason: 'GRANT_REVOKED' };
  const existing = await arow(
    'SELECT id FROM student_course_grant_consumptions WHERE grant_id=? AND session_id=? AND student_id=?',
    [grant.id, sessionId, studentId],
  );
  if (existing) return { consumed: false, reason: 'ALREADY_CONSUMED' };
  const { remaining } = grantUnitsOf(grant);
  if (remaining <= 0) {
    const experience = String(seriesType || '').toUpperCase() === EXPERIENCE_SERIES_TYPE;
    throw errors.conflict(
      experience
        ? '这个学生的体验次数已经用完，课堂无法结束：请先到「学生许可」再分一次，或把学生移出课堂'
        : '这个学生的课时次数已经用完，课堂无法结束：请先到「学生许可」再分一次，或把学生移出课堂',
      experience ? 'EXPERIENCE_UNITS_EXHAUSTED' : 'COURSE_UNITS_EXHAUSTED',
    );
  }
  const now = nowIso();
  await aq(
    `INSERT INTO student_course_grant_consumptions(
       id,grant_id,org_id,student_id,series_id,lesson_id,session_id,units,consumed_at,created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id('grantconsume'), grant.id, orgId, studentId, seriesId, lessonId, sessionId, 1, now, now],
  );
  await aq('UPDATE student_course_grants SET consumed_units=consumed_units+1 WHERE id=?', [grant.id]);
  void actorId;
  return { consumed: true, reason: null, grantId: grant.id, remaining: remaining - 1 };
}

/** 兼容别名（老调用点/老脚本还在用这个名字）。 */
export const consumeExperienceUnit = consumeGrantUnit;

/** 某个学生在这个课包上已经核销过几次（平台端展示"已消费 N 次"用）。 */
export async function consumedUnitsFor({ orgId, seriesId, studentId = null }) {
  const row = studentId
    ? await arow('SELECT COALESCE(SUM(units),0) n FROM student_course_grant_consumptions WHERE org_id=? AND series_id=? AND student_id=?', [orgId, seriesId, studentId])
    : await arow('SELECT COALESCE(SUM(units),0) n FROM student_course_grant_consumptions WHERE org_id=? AND series_id=?', [orgId, seriesId]);
  return Number(row?.n || 0);
}
