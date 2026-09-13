// AI 使用记录的统一底层操作（ai.js 同步路径与 aiGeneration.js/vibecoding.js 异步路径共用）
// ⚠️ 2026-09-13（P4 删积分）：原 debitUserAiCredits()（扣 users 的周期额度 / ai_credits_used /
// magic_stones）已删除 —— 这三处刹车都不再存在，额度改由**算力池**按「学生 × 课包」管。
import { id, json, nowIso, q } from '../lib.js';

// 写入 usage_records；model/status/failCode/pricing 由调用方传入以保留各自语义。
// costFen / seriesId 是**算力池的账本**（学生 × 课包，四种模态共用一个池子）：
// 成功按单价折算记一笔，失败记 0（不花学生的钱）；池子已用 = SUM(cost_fen) WHERE user_id + series_id。
// credits_charged 是历史积分列：列还在（NOT NULL），但**新行恒为 0** —— 积分体系已废弃。
export function recordAiUsage({
  orgId, userId, projectId = null, sessionId = null, generationJobId = null,
  modality, model = 'local-p0', status, failCode = null, pricing = null,
  costFen = 0, seriesId = null, workId = null,
}) {
  q(
    `INSERT INTO usage_records(
       id,org_id,user_id,class_session_id,project_id,generation_job_id,work_id,modality,model,credits_charged,status,fail_code,pricing_snapshot,cost_fen,series_id,created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('usage'), orgId, userId, sessionId, projectId, generationJobId, workId, modality, model, 0,
      status, failCode,
      json(pricing || { modality, status, failCode, generationJobId }),
      Math.max(0, Math.round(Number(costFen) || 0)), seriesId || null,
      nowIso(),
    ],
  );
}
