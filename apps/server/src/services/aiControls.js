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
 * ⚠️ 2026-09-18（用户口径：学生算力额度**只观测、不真拦**）：本函数里原来的
 * 「本课堂 AI 调用**次数**上限」拦截（`class_sessions.student_call_cap` → `SESSION_STUDENT_CALL_CAP`）
 * 已**退役删除**。按钱的观测额度（`class_sessions.student_cost_cap_fen` →
 * `services/sessionCostCap.js`）也**不是闸门**：它的 `enforced` 恒为 false，
 * **不在任何准入链路上**（`assertGenerationPreflight` / `routes/ai.js` 都不再调用它）。
 * 所以「额度」这件事在本文件与整个生成链路上都不存在拦截；这里只管课堂能力与暂停开关。
 * `class_sessions.student_call_cap` 这一列**不删**（老库有数据），只在 schema 里标注已退役。
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
  // 额度不在这里（见上面的说明）：学生算力额度**只观测、不真拦**，不在任何准入链路上。
}

export const SESSION_CAPABILITY_BY_MODALITY_EXPORT = SESSION_CAPABILITY_BY_MODALITY;
