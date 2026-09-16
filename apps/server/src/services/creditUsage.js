// Successful usage is independent of student charges. Historical cost_fen remains untouched.
import { id, json, nowIso, q, row } from '../lib.js';

export function recordAiUsage({
  orgId, userId, projectId = null, sessionId = null, generationJobId = null,
  modality, model = 'local-p0', status, failCode = null, pricing = null,
  costFen = 0, seriesId = null, workId = null,
  // Provider-reported token usage remains available for audit.
  inputTokens = 0, outputTokens = 0,
  // 上游用量回执（P90）：调用方拿到 result.usage 就传进来，等价于 inputTokens/outputTokens；
  // 只是把「回执」这一件事收在一处，不改学生侧语义。
  // usageSnapshot 是**整份证据**（upstreamCost.collectUsageEvidence 的形状），只在调用方要补记时传。
  usage = null, usageSnapshot = null,
}) {
  // Attribution is the original classroom's organization, never a browser-supplied key.
  const session = sessionId ? row('SELECT org_id,lesson_id FROM class_sessions WHERE id=?', [sessionId]) : null;
  orgId = session?.org_id || orgId;
  const reportedInput = usage?.inputTokens ?? inputTokens;
  const reportedOutput = usage?.outputTokens ?? outputTokens;
  if (pricing?.compute?.callId) {
    // COALESCE：provider 侧在成功分支已经写过用量证据，这里只补空、不覆盖。
    q('UPDATE compute_attempts SET org_id=?,class_session_id=COALESCE(class_session_id,?),lesson_id=COALESCE(lesson_id,?),usage_snapshot=COALESCE(usage_snapshot,?) WHERE call_id=?',
      [orgId, sessionId, session?.lesson_id || null, usageSnapshot ? json(usageSnapshot) : null, pricing.compute.callId]);
  }
  const usageRecordId = id('usage');
  q(
    `INSERT INTO usage_records(
       id,org_id,user_id,class_session_id,project_id,generation_job_id,work_id,modality,model,credits_charged,status,fail_code,pricing_snapshot,cost_fen,series_id,input_tokens,output_tokens,created_at,compute_call_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      usageRecordId, orgId, userId, sessionId, projectId, generationJobId, workId, modality, model, 0,
      status, failCode,
      json(pricing || { modality, status, failCode, generationJobId }),
      0, seriesId || null,
      Math.max(0, Math.round(Number(reportedInput) || 0)), Math.max(0, Math.round(Number(reportedOutput) || 0)),
      nowIso(), pricing?.compute?.callId || null,
    ],
  );
  if (pricing?.compute?.callId) {
    q('UPDATE compute_attempts SET internal_usage_record_id=? WHERE call_id=?', [usageRecordId, pricing.compute.callId]);
  }
  // Late provider results remain in the ledger; ended classroom outcomes are frozen.
}
