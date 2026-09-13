// Successful usage is independent of student charges. Historical cost_fen remains untouched.
import { id, json, nowIso, q, row } from '../lib.js';
import { settleSessionStudents } from './classroomSessions.js';

export function recordAiUsage({
  orgId, userId, projectId = null, sessionId = null, generationJobId = null,
  modality, model = 'local-p0', status, failCode = null, pricing = null,
  costFen = 0, seriesId = null, workId = null,
  // Provider-reported token usage remains available for audit.
  inputTokens = 0, outputTokens = 0,
}) {
  // Attribution is the original classroom's organization, never a browser-supplied key.
  const session = sessionId ? row('SELECT org_id,lesson_id FROM class_sessions WHERE id=?', [sessionId]) : null;
  orgId = session?.org_id || orgId;
  if (pricing?.compute?.callId) q('UPDATE compute_attempts SET org_id=?,class_session_id=COALESCE(class_session_id,?),lesson_id=COALESCE(lesson_id,?) WHERE call_id=?', [orgId, sessionId, session?.lesson_id || null, pricing.compute.callId]);
  q(
    `INSERT INTO usage_records(
       id,org_id,user_id,class_session_id,project_id,generation_job_id,work_id,modality,model,credits_charged,status,fail_code,pricing_snapshot,cost_fen,series_id,input_tokens,output_tokens,created_at,compute_call_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id('usage'), orgId, userId, sessionId, projectId, generationJobId, workId, modality, model, 0,
      status, failCode,
      json(pricing || { modality, status, failCode, generationJobId }),
      0, seriesId || null,
      Math.max(0, Math.round(Number(inputTokens) || 0)), Math.max(0, Math.round(Number(outputTokens) || 0)),
      nowIso(), pricing?.compute?.callId || null,
    ],
  );
  if (status === 'SUCCESS' && sessionId && row('SELECT status FROM class_sessions WHERE id=?',[sessionId])?.status === 'ENDED') settleSessionStudents({ sessionId, actorId: userId });
}
