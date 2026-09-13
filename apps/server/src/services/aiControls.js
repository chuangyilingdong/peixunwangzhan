import { errors, count } from '../lib.js';

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
 */
export function assertSessionAiControls({ modality, session, orgId, userId }) {
  if (!session) return;
  if (session.aiPaused) throw errors.forbidden('教师已暂时暂停本课堂的 AI 使用', 'SESSION_AI_PAUSED');
  const capability = SESSION_CAPABILITY_BY_MODALITY[modality];
  if (capability && session.capabilities && !session.capabilities[capability]) {
    throw errors.forbidden('当前课堂未开放该 AI 能力', 'SESSION_CAPABILITY_DISABLED');
  }
  if (session.studentCallCap !== null && session.studentCallCap !== undefined) {
    const usedCalls = count(
      "SELECT COUNT(*) n FROM usage_records WHERE org_id=? AND class_session_id=? AND user_id=? AND status IN ('SUCCESS','FAILED')",
      [orgId, session.id, userId],
    );
    if (usedCalls >= Number(session.studentCallCap)) {
      throw errors.forbidden('你在本课堂的 AI 调用次数已达上限', 'SESSION_STUDENT_CALL_CAP');
    }
  }
}

export const SESSION_CAPABILITY_BY_MODALITY_EXPORT = SESSION_CAPABILITY_BY_MODALITY;
