// 学生算力上限 —— **全平台唯一保留的一套**（2026-09-18 用户口径）。
//
// 历史背景（必须记住，别再铺第二层）：「学生的算力上限」在仓库里被实现过 **6 遍**
// （`class_sessions.student_call_cap` 次数上限 / 课包 CU 额度 `student_course_cu_quotas`+`_ledger` /
//  `platform_credit_quotas` / `org_ai_budgets` / `billing_packages.monthly_credits+bonus_credits` /
//  `per_student_budget_fen`），其中**只有 `student_call_cap` 真的会拦人**，而它数的是**次数不是钱**。
// 用户 2026-09-18 定了：「只留一套**按钱**的，删其余 5 套」。
// 这套就是那一套；其余 5 套的删除见 docs/operations/平台AI与CU配置-重梳理-20260918.md 的 Phase 6。
//
// 口径（照抄用户原话的精神，改动前先读）：
//   · 概念 = **每个学生在每场课堂上的算力上限（分）**，依据**上游成本**
//     （`compute_attempts.upstream_cost_fen`），不是对外售价（那是 `sale_price_fen`，只进报表）、
//     更不是调用次数。
//   · 该学生在这堂课**已花的已知成本 ≥ 上限**时拦截（调用前的准入判断，不做预留）。
//   · `cost_source='UNKNOWN'`（或没有金额）的调用**只计笔数、不按 0 计入金额** ——
//     按 0 计等于把「不知道花了多少」说成「没花钱」；拦截文案里必须点明「还有 N 笔成本未知」。
//   · **留空 = 不限制**（不填就不管，只记账、只统计）。
//
// 配置列：`class_sessions.student_cost_cap_fen`（分，NULL = 不限制）。只**新增**列，老列一字不改。
//   为什么不复用 `class_sessions.platform_budget_fen`：那一列是「**整场课堂**的成本基准」，
//   只预警不拦人（见 computePool.classroomBudgetStatus），它是按整场人头配的基准；
//   把它同时当「**每个学生**的上限」= 一场 20 人的课堂会给每个学生都发放整场额度，
//   单位不同、口径混用 —— 正是这轮要消灭的病症（"看着配了、其实不生效"）。
//
// ⚠️ 这套**会真的拦住学生调用**（这是它与前面 5 套最大的区别）。所以：
//   默认/留空必须是不限制；只有显式配了上限的课堂才会拦。
//   配入口在机构端建课堂/改课堂的能力参数里（`capabilities.studentCostCapFen`，单位分）。
import { errors, row, rows } from '../lib.js';

/** 金额展示（分 → 元，两位小数）。文案要给学生看，所以带货币符号。 */
export function formatFenAsYuan(fen) {
  return `¥${(Number(fen || 0) / 100).toFixed(2)}`;
}

const KNOWN_COST_SQL = "(cost_source <> 'UNKNOWN' AND upstream_cost_fen IS NOT NULL)";
const UNKNOWN_COST_SQL = "(cost_source = 'UNKNOWN' OR upstream_cost_fen IS NULL)";

/** 这堂课配的「每学生算力上限（分）」；**留空 = null = 不限制**（老课堂都是 NULL，不会被误伤）。 */
export function studentCostCapFen(sessionId) {
  if (!sessionId) return null;
  const value = row('SELECT student_cost_cap_fen FROM class_sessions WHERE id=?', [sessionId])?.student_cost_cap_fen;
  if (value === null || value === undefined || value === '') return null;
  const fen = Number(value);
  return Number.isFinite(fen) && fen >= 0 ? fen : null;
}

/**
 * 一场课堂里**每个学生**的已花成本（同一张表的同一列，与平台用量报表、课堂预算预警同一套口径）。
 * 一次 group by 取全名单，避免老师端名单里 N 个学生打 N 次库。
 */
export function sessionCostUsageByStudent(sessionId) {
  const map = new Map();
  if (!sessionId) return map;
  for (const item of rows(`SELECT user_id,
      SUM(CASE WHEN ${KNOWN_COST_SQL} THEN upstream_cost_fen ELSE 0 END) knownFen,
      SUM(CASE WHEN ${UNKNOWN_COST_SQL} THEN 1 ELSE 0 END) unknownCalls
    FROM compute_attempts WHERE class_session_id=? GROUP BY user_id`, [sessionId])) {
    map.set(item.user_id, { usedFen: Number(item.knownFen || 0), unknownCalls: Number(item.unknownCalls || 0) });
  }
  return map;
}

/** 把「上限 + 已花」折成一份状态（学生端 / 老师端 / 候选名单共用同一份，不各算一套）。 */
export function sessionCostCapState({ capFen = null, usedFen = 0, unknownCalls = 0 } = {}) {
  const configured = capFen !== null && capFen !== undefined;
  const used = Number(usedFen || 0);
  const unknown = Number(unknownCalls || 0);
  const exceeded = configured && used >= capFen;
  return {
    configured,
    state: !configured ? 'UNCONFIGURED' : exceeded ? 'EXHAUSTED' : 'WITHIN_CAP',
    capFen: configured ? capFen : null,
    usedFen: used,
    remainFen: configured ? Math.max(0, capFen - used) : null,
    // 未知笔数：只要有，金额就是**下界**（"至少花了这么多"），文案必须说清
    unknownCalls: unknown,
    costIncomplete: unknown > 0,
    usagePercent: configured ? (capFen > 0 ? Math.round((used / capFen) * 1000) / 10 : (exceeded ? 100 : 0)) : null,
    exceeded,
  };
}

/**
 * 额度状态：`studentId` 给了就是那个学生的，没给就是**整场课堂**（四个模态合计，老师端看总量）。
 * 无论有没有配上限都返回同一份形状 —— 「没配」= `configured:false`（前端据此显示"不限"）。
 */
export function sessionCostCapStatus({ sessionId, studentId = null }) {
  if (!sessionId) return sessionCostCapState({ capFen: null });
  const capFen = studentCostCapFen(sessionId);
  const conditions = ['class_session_id=?'];
  const params = [sessionId];
  if (studentId) { conditions.push('user_id=?'); params.push(studentId); }
  // ⚠️ 没有上限时也照样查已花金额：「不限制」不等于「不记账」，老师端仍要看得出消耗。
  const cost = row(`SELECT SUM(CASE WHEN ${KNOWN_COST_SQL} THEN upstream_cost_fen ELSE 0 END) knownFen,
      SUM(CASE WHEN ${UNKNOWN_COST_SQL} THEN 1 ELSE 0 END) unknownCalls
    FROM compute_attempts WHERE ${conditions.join(' AND ')}`, params);
  return sessionCostCapState({ capFen, usedFen: cost?.knownFen || 0, unknownCalls: cost?.unknownCalls || 0 });
}

/**
 * 学生看得懂的拦截文案（不是 `COURSE_CU_EXHAUSTED` 这种机器码）。
 * 要点：① 还剩多少 / 上限多少，让学生知道自己花到哪了；
 *       ② 有成本未知的调用就点名笔数 —— 否则学生以为「我一分钱没花怎么就被拦了」。
 */
export function sessionCostCapMessage(status) {
  const head = `你在本课堂的 AI 算力额度已经用完了：本堂课每人上限 ${formatFenAsYuan(status.capFen)}，你已用掉 ${formatFenAsYuan(status.usedFen)}`;
  const unknown = status.unknownCalls
    ? `。另外还有 ${status.unknownCalls} 笔调用的成本未知（可能不止这些），老师能看到明细`
    : '（成本按上游实际扣费统计）';
  return `${head}${unknown}。请找老师看是否需要调高本课堂的额度，或等下一节课再继续。`;
}

/**
 * 调用前的准入刹车：**故意放在"调用前"而不是"结算后"**。
 * 结算时（settleSuccessfulJob）当前这次调用的成本已经落库了，那时再拦会把一次
 * **已经产出素材、已经花掉上游钱**的调用判成失败 —— 学生白花钱还拿不到东西。
 * 所以：上限是准入控制（花超了就进不来），不是事后审计（事后审计在报表里）。
 */
export function assertSessionCostCap({ sessionId, studentId, orgId = null }) {
  if (!sessionId || !studentId) return null;
  const status = sessionCostCapStatus({ sessionId, studentId });
  if (!status.exceeded) return status;
  if (orgId) {
    // 只统计本机构这一堂课的账。绝不做跨机构回填：查不到就是查不到（教学平台不猜账）。
    const owned = row('SELECT id FROM class_sessions WHERE id=? AND org_id=?', [sessionId, orgId]);
    if (!owned) return status;
  }
  throw errors.forbidden(sessionCostCapMessage(status), 'SESSION_STUDENT_COST_CAP_EXHAUSTED');
}
