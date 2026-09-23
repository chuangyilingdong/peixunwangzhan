// 学生算力额度 —— **只观测，不拦人**（2026-09-18 用户口径，同日更正）。
//
// 用户原话：「**学生算力额度的设置目前都是不真拦，都是给我们内部看的。**」
// 所以这套东西的性质是**运营观测指标**，与平台端已有的「课堂成本预警」
// （`computePool.classroomBudgetStatus`，`enforced: false`）**同一性质** —— 数字好看得见，
// 但**不挡任何一次调用**。要控成本请用别的办法（渠道价目表、教师暂停课堂 AI）。
//
// 历史背景（别再铺第二层）：「学生的算力上限」在仓库里被实现过 **6 遍**
// （`class_sessions.student_call_cap` 次数 / 课包 CU 额度 `student_course_cu_quotas`+`_ledger` /
//  `platform_credit_quotas` / `org_ai_budgets` / `billing_packages.monthly_credits+bonus_credits` /
//  `per_student_budget_fen`）。2026-09-18 用户定了「只留一套按钱的」——**这一套**；
// 其余 5 套已删（见 docs/operations/平台AI与CU配置-重梳理-20260918.md 的 Phase 6）。
// 同日更正：留下的这一套也**不拦人**，只算数给人看。
//
// 口径：
//   · 概念 = **每名学生 × 每场课堂**的算力消耗观测值，依据**上游成本**
//     （`compute_attempts.upstream_cost_fen`）——不是对外售价（`sale_price_fen`，只进报表）、
//     更不是调用次数。
//   · `exceeded` = 已花的**已知成本** ≥ 观测上限：**只是一个标记**（给运营/老师看"这堂课花超了"），
//     `enforced` **恒为 false** —— 不再有任何代码路径会因为 `exceeded` 拦住学生调用。
//   · `cost_source='UNKNOWN'`（或没有金额）的调用**只计笔数、不按 0 计入金额** ——
//     按 0 计等于把「不知道花了多少」说成「没花钱」；`costIncomplete` 标出金额只是**下界**。
//   · **留空 = 不设观测上限**（`configured: false`）：照样记账、照样统计，只是没有"超没超"可比。
//
// 配置列：`class_sessions.student_cost_cap_fen`（分，NULL = 不设观测上限）。只**新增**列，老列一字不改。
//   为什么不复用 `class_sessions.platform_budget_fen`：那一列是「**整场课堂**的成本基准」，
//   它是按整场人头配的；拿它当「**每个学生**的观测上限」会让一场 20 人的课堂给每个学生
//   都显示整场额度 —— 单位不同、口径混用，正是这轮要消灭的病症。
//
// ⚠️ **学生端不下发**（2026-09-18 用户口径：额度是内部看的，学生既看不到也不会被它拦）：
//   学生可见负载（`/api/ai/center`、`routes/ai.js`）里**没有**这套字段，也**不进**"能力不可用理由"。
//   老师端（机构端课堂详情）与平台端（内部报表）保留这份数字。
import { row, rows, arow, arows } from '../lib.js';

const KNOWN_COST_SQL = "(cost_source <> 'UNKNOWN' AND upstream_cost_fen IS NOT NULL)";
const UNKNOWN_COST_SQL = "(cost_source = 'UNKNOWN' OR upstream_cost_fen IS NULL)";

/**
 * 这堂课配的「算力**观测**上限（分）」；**留空 = null = 不设观测上限**（老课堂都是 NULL）。
 * ⚠️ 它**只是分母**：没有任何地方会因为达到它而拒绝调用。
 */
export async function studentCostCapFen(sessionId) {
  if (!sessionId) return null;
  const value = (await arow('SELECT student_cost_cap_fen FROM class_sessions WHERE id=?', [sessionId]))?.student_cost_cap_fen;
  if (value === null || value === undefined || value === '') return null;
  const fen = Number(value);
  return Number.isFinite(fen) && fen >= 0 ? fen : null;
}

/**
 * 一场课堂里**每个学生**的已花成本（同一张表的同一列，与平台用量报表、课堂成本预警同一套口径）。
 * 一次 group by 取全名单，避免老师端名单里 N 个学生打 N 次库。
 */
export async function sessionCostUsageByStudent(sessionId) {
  const map = new Map();
  if (!sessionId) return map;
  for (const item of await arows(`SELECT user_id,
      SUM(CASE WHEN ${KNOWN_COST_SQL} THEN upstream_cost_fen ELSE 0 END) knownFen,
      SUM(CASE WHEN ${UNKNOWN_COST_SQL} THEN 1 ELSE 0 END) unknownCalls
    FROM compute_attempts WHERE class_session_id=? GROUP BY user_id`, [sessionId])) {
    map.set(item.user_id, { usedFen: Number(item.knownFen || 0), unknownCalls: Number(item.unknownCalls || 0) });
  }
  return map;
}

/**
 * 把「观测上限 + 已花」折成一份观测状态（老师端 / 平台端 / 候选名单共用同一份，不各算一套）。
 *
 * ⚠️ `enforced` **恒为 false**（2026-09-18 用户口径）：这是本轮的要害 ——
 *   `exceeded: true` 只代表"看板上这个数超了"，**不代表任何人被挡住**。
 *   写新代码时不要读 `exceeded` 去做准入判断；要拦人的话那是另一个（不存在的）机制。
 */
export function sessionCostCapState({ capFen = null, usedFen = 0, unknownCalls = 0 } = {}) {
  const configured = capFen !== null && capFen !== undefined;
  const used = Number(usedFen || 0);
  const unknown = Number(unknownCalls || 0);
  const exceeded = configured && used >= capFen;
  return {
    configured,
    state: !configured ? 'UNCONFIGURED' : exceeded ? 'EXCEEDED_OBSERVED' : 'WITHIN_CAP',
    capFen: configured ? capFen : null,
    usedFen: used,
    remainFen: configured ? Math.max(0, capFen - used) : null,
    // 未知笔数：只要有，金额就是**下界**（"至少花了这么多"），显示时要能看出不完整
    unknownCalls: unknown,
    costIncomplete: unknown > 0,
    usagePercent: configured ? (capFen > 0 ? Math.round((used / capFen) * 1000) / 10 : (exceeded ? 100 : 0)) : null,
    exceeded,
    // 恒 false：这套额度是**观测口径，不是闸门**（2026-09-18 用户口径）。
    enforced: false,
  };
}

/**
 * 观测状态：`studentId` 给了就是那个学生的，没给就是**整场课堂**（四个模态合计，老师端看总量）。
 * 无论有没有配上限都返回同一份形状 —— 「没配」= `configured:false`（只是没有分母）。
 *
 * ⚠️ 这是**纯读函数**：调用它不会改变任何请求的结果（它不再是 assert，不抛错、不拦人）。
 * ⚠️ 成本合计**复用 `sessionCostUsageByStudent`（唯一一份 SQL）** —— 老师端的课堂详情读的也是
 *    同一个函数，两边不会有"两套算法"（这也是为什么守卫的自检要砸这个合计：砸了它，
 *    老师端与学生侧的状态会一起错，而"观测口径的可信度全在这个数算得对"）。
 */
export async function sessionCostCapStatus({ sessionId, studentId = null }) {
  if (!sessionId) return sessionCostCapState({ capFen: null });
  const capFen = await studentCostCapFen(sessionId);
  const byStudent = await sessionCostUsageByStudent(sessionId);
  // ⚠️ 没有观测上限时也照样查已花金额：「不设上限」不等于「不记账」。
  const totals = studentId ? null : [...byStudent.values()].reduce(
    (sum, item) => ({ usedFen: sum.usedFen + item.usedFen, unknownCalls: sum.unknownCalls + item.unknownCalls }),
    { usedFen: 0, unknownCalls: 0 },
  );
  const usage = studentId ? byStudent.get(studentId) : totals;
  return sessionCostCapState({ capFen, usedFen: usage?.usedFen || 0, unknownCalls: usage?.unknownCalls || 0 });
}
