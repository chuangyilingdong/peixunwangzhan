import { errors } from '../lib.js';

const SESSION_CAPABILITY_BY_MODALITY = {
  TEXT: 'allowText',
  IMAGE: 'allowImage',
  MUSIC: 'allowMusic',
  VIDEO: 'allowVideo',
};

/**
 * Enforce controls that belong to the currently active classroom session.
 * Home-practice projects intentionally have no class-session controls.
 * The check is repeated inside the billing transaction by callers so a teacher
 * changing a session while a generation is in flight cannot bypass the policy.
 *
 * ⚠️ 2026-09-13（P4 删积分）：这里原来的「课堂积分上限」（session_credit_cap）已删除。
 * 换成**算力池**（学生 × 课包，四种模态共用一个上限，见 services/computePool.js）——
 * 那个闸门看得见四种模态，而这张课堂卡只在老的同步路径上累加，异步生成根本不动它，
 * 等于形同虚设（交接说明第 71 条：闸门要能看见它管的所有东西）。
 *
 * ⚠️ 2026-09-18（用户口径：学生算力上限 6 套收敛成 1 套**按钱的**）：本函数里原来的
 * 「本课堂 AI 调用**次数**上限」拦截（`class_sessions.student_call_cap` → `SESSION_STUDENT_CALL_CAP`）
 * 已**退役删除** —— 它数的是次数不是钱，学生打一句十个字和生成一段视频算一样多，
 * 跟成本毫无关系。现在按钱的那一套在 `services/sessionCostCap.js`：
 * 学生在这堂课的已知**上游成本**（`compute_attempts.upstream_cost_fen`）达到
 * `class_sessions.student_cost_cap_fen` 就拦，错误码 `SESSION_STUDENT_COST_CAP_EXHAUSTED`。
 * 它的拦截点**紧挨着本函数的调用点**（`assertGenerationPreflight` / `routes/ai.js` 的调用前事务），
 * 但**刻意不在消费本函数的结算路径上再拦**（结算时这次调用的成本已落库，那时拦会把
 * 一次已产出素材、已花钱的调用判成失败）。`class_sessions.student_call_cap` 这一列**不删**
 * （老库有数据），只在 schema 里标注已退役。
 */
export function assertSessionAiControls({ modality, session, orgId, userId }) {
  void orgId;
  void userId;
  if (!session) return;
  if (session.aiPaused) throw errors.forbidden('教师已暂时暂停本课堂的 AI 使用', 'SESSION_AI_PAUSED');
  const capability = SESSION_CAPABILITY_BY_MODALITY[modality];
  if (capability && session.capabilities && !session.capabilities[capability]) {
    throw errors.forbidden('当前课堂未开放该 AI 能力', 'SESSION_CAPABILITY_DISABLED');
  }
  // 额度不在这里（见上面的说明）：钱的闸门在 sessionCostCap.assertSessionCostCap，紧挨着调用点。
}

export const SESSION_CAPABILITY_BY_MODALITY_EXPORT = SESSION_CAPABILITY_BY_MODALITY;
