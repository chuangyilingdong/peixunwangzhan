import { errors, count } from '../lib.js';

const SESSION_CAPABILITY_BY_MODALITY = {
  TEXT: 'allowText',
  IMAGE: 'allowImage',
  MUSIC: 'allowMusic',
  VIDEO: 'allowVideo',
  PODCAST: 'allowPodcast',
  DUBBING: 'allowDubbing',
};

/**
 * Enforce controls that belong to the currently active classroom session.
 * Home-practice projects intentionally have no class-session controls.
 * The check is repeated inside the billing transaction by callers so a teacher
 * changing a session while a generation is in flight cannot bypass the policy.
 */
export function assertSessionAiControls({ modality, session, orgId, userId, credits = 0 }) {
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
  if (session.sessionCreditCap !== null && session.sessionCreditCap !== undefined
    && Number(session.consumedCreditsTotal || 0) + Number(credits || 0) > Number(session.sessionCreditCap)) {
    throw errors.forbidden('课堂用量已达上限', 'SESSION_CREDIT_CAP');
  }
}

export const SESSION_CAPABILITY_BY_MODALITY_EXPORT = SESSION_CAPABILITY_BY_MODALITY;
