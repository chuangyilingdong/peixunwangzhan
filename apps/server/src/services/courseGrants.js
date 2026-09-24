// 课包许可的「次数账」（2026-09-24 用户口径：平台新增**体验课包**）。
//
// 口径（用户逐条确认过，别按自己的理解改）：
//   · 课包类型是**独立字段** `course_series.series_type`：`NORMAL`（默认）/ `EXPERIENCE`；
//     **不要**复用机构试用 `organizations.is_trial`、也不要靠标题或标签猜。
//   · 体验课包**只包含一节课**（普通课包不加任何新的节数限制）。
//   · 与普通课包**相同**的人次消耗/分配机制与课程编排逻辑。
//   · **同一个体验课包可以重复分给同一学生**，且**未使用的次数可以预先累积**。
//   · **每场课堂正常结束、且该学生有有效 AI 产出时，核销 1 次**：
//     无产出不扣、`INCOMPLETE` 不扣、课堂**解散（DISSOLVED）**不扣。
//   · **普通课包行为完全不变**：授权即扣、重复授权跳过、同课时完课拦截。
//
// 为什么普通包不做成"也按次数扣"：普通包现在的语义是「授权即消耗一次配额」，
// 完课与否不影响次数；这一块有一整套验收（p55/p86/p78）。体验包是**另一条**支路，
// 所以这里所有"按次数"的函数都只在 `series_type='EXPERIENCE'` 时被调用。

import { errors, id, nowIso, arow, arows, aq } from '../lib.js';

export const SERIES_TYPES = Object.freeze(['NORMAL', 'EXPERIENCE']);
export const EXPERIENCE_SERIES_TYPE = 'EXPERIENCE';

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

/** 一条许可的次数账（普通包也照读，`granted_units` 默认 1 / `consumed_units` 默认 0）。 */
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
 * 一次取全「这个课包下每个学生的剩余体验次数」—— 候选人列表/加学员都用它，
 * 免得在循环里逐个学生打一次库。
 */
export async function experienceBalanceByStudent({ orgId, seriesId }) {
  const rows = await arows(
    'SELECT student_id, granted_units, consumed_units FROM student_course_grants WHERE org_id=? AND series_id=? AND revoked_at IS NULL',
    [orgId, seriesId],
  );
  const map = new Map();
  for (const row of rows) map.set(row.student_id, grantUnitsOf(row).remaining);
  return map;
}

/**
 * 核销 1 次体验（在调用方的**同一个事务**里跑，见 orgAdmin 的 `/sessions/:id/end`）。
 *
 * 幂等：`student_course_grant_consumptions` 上的唯一索引（grant_id, session_id, student_id）是唯一依据 ——
 * 重复结束课堂、重试、并发都只会扣一次。余额不足时**抛错让整个结束事务回滚**：
 * 宁可结束失败（老师看到明确原因后去补一次授权），也不能出现「课已经结束、次数没扣」的账实不一致。
 *
 * 撤销过的许可不算"余额不足"：平台撤销时已经按未消费余额退过次数了，这里直接跳过并如实回报
 * （否则老师会因为一条早被撤销的授权而永远结束不了课堂）。
 */
export async function consumeExperienceUnit({ orgId, studentId, seriesId, lessonId = null, sessionId, actorId = null }) {
  const grant = await activeGrantFor({ orgId, studentId, seriesId });
  if (!grant) return { consumed: false, reason: 'GRANT_REVOKED' };
  const existing = await arow(
    'SELECT id FROM student_course_grant_consumptions WHERE grant_id=? AND session_id=? AND student_id=?',
    [grant.id, sessionId, studentId],
  );
  if (existing) return { consumed: false, reason: 'ALREADY_CONSUMED' };
  const { remaining } = grantUnitsOf(grant);
  if (remaining <= 0) {
    throw errors.conflict('这个学生的体验次数已经用完，课堂无法结束：请先到「学员许可」再分一次，或把学生移出课堂', 'EXPERIENCE_UNITS_EXHAUSTED');
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

/** 某个学生在这个课包上已经核销过几次（平台端展示"已消费 N 次"用）。 */
export async function consumedUnitsFor({ orgId, seriesId, studentId = null }) {
  const row = studentId
    ? await arow('SELECT COALESCE(SUM(units),0) n FROM student_course_grant_consumptions WHERE org_id=? AND series_id=? AND student_id=?', [orgId, seriesId, studentId])
    : await arow('SELECT COALESCE(SUM(units),0) n FROM student_course_grant_consumptions WHERE org_id=? AND series_id=?', [orgId, seriesId]);
  return Number(row?.n || 0);
}
