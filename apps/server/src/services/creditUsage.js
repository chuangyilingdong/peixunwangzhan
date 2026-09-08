// AI 使用扣减与记录的统一底层操作（ai.js 同步路径与 aiGeneration.js 异步路径共用）
// 注意：这里只抽取语句级完全一致的逻辑；各路径对配额/课堂上限的校验差异保持在各路由中。
import { id, json, nowIso, q } from '../lib.js';

// 扣减用户周期额度 + AI 已用 + 魔法石（幂等性由调用方的事务保证）
export function debitUserAiCredits({ userId, orgId, credits }) {
  q(
    `UPDATE users
     SET used_credits_this_period=used_credits_this_period+?,
         ai_credits_used=ai_credits_used+?,
         magic_stones=MAX(0, magic_stones-?),
         updated_at=?
     WHERE id=? AND org_id=?`,
    [credits, credits, credits, nowIso(), userId, orgId],
  );
}

// 写入 usage_records；model/credits/status/failCode/pricing 由调用方传入以保留各自语义
export function recordAiUsage({
  orgId, userId, projectId = null, sessionId = null, generationJobId = null,
  modality, model = 'local-p0', credits, status, failCode = null, pricing = null,
}) {
  q(
    `INSERT INTO usage_records(
       id,org_id,user_id,class_session_id,project_id,generation_job_id,modality,model,credits_charged,status,fail_code,pricing_snapshot,created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('usage'), orgId, userId, sessionId, projectId, generationJobId, modality, model, credits,
      status, failCode,
      json(pricing || { modality, credits, status, failCode, generationJobId }),
      nowIso(),
    ],
  );
}
