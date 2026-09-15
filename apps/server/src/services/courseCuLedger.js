import { errors, id, nowIso, q, row, transaction } from '../lib.js';

function quotaLimit(lessonId, seriesId) {
  const lesson = row('SELECT cu_limit FROM course_lessons WHERE id=?', [lessonId]);
  const series = row('SELECT cu_limit FROM course_series WHERE id=?', [seriesId]);
  const value = lesson?.cu_limit ?? series?.cu_limit;
  return value == null ? null : Math.max(0, Number(value) || 0);
}
export function getCourseCuStatus({ orgId, studentId, seriesId, lessonId }) {
  const quota = row('SELECT * FROM student_course_cu_quotas WHERE org_id=? AND student_id=? AND series_id=? AND lesson_id=?', [orgId, studentId, seriesId, lessonId]);
  if (!quota) return { unlimited: true, limitCu: null, reservedCu: 0, settledCu: 0, availableCu: null };
  return { unlimited: false, quotaId: quota.id, limitCu: quota.limit_cu, reservedCu: quota.reserved_cu, settledCu: quota.settled_cu, availableCu: Math.max(0, quota.limit_cu - quota.reserved_cu - quota.settled_cu) };
}
export function reserveCourseCu({ orgId, studentId, seriesId, lessonId, sessionId=null, generationJobId=null, units=1, idempotencyKey }) {
  if (!idempotencyKey) throw errors.badRequest('AI任务缺少幂等键', 'CU_IDEMPOTENCY_REQUIRED');
  return transaction(() => {
    const prior = row('SELECT * FROM student_course_cu_ledger WHERE idempotency_key=?', [idempotencyKey]);
    if (prior) return prior;
    const limit = quotaLimit(lessonId, seriesId);
    if (limit == null) return { id: null, state: 'UNLIMITED', reserved_cu: 0 };
    let quota = row('SELECT * FROM student_course_cu_quotas WHERE org_id=? AND student_id=? AND series_id=? AND lesson_id=?', [orgId, studentId, seriesId, lessonId]);
    const now = nowIso();
    if (!quota) { const quotaId=id('scquota'); q('INSERT INTO student_course_cu_quotas(id,org_id,student_id,series_id,lesson_id,limit_cu,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',[quotaId,orgId,studentId,seriesId,lessonId,limit,now,now]); quota=row('SELECT * FROM student_course_cu_quotas WHERE id=?',[quotaId]); }
    const amount=Math.max(1,Math.round(Number(units)||1));
    if (quota.limit_cu - quota.reserved_cu - quota.settled_cu < amount) throw errors.forbidden('本课程算力 CU 已用尽','COURSE_CU_EXHAUSTED');
    const ledgerId=id('cpledger');
    q('UPDATE student_course_cu_quotas SET reserved_cu=reserved_cu+?,updated_at=? WHERE id=?',[amount,now,quota.id]);
    q('INSERT INTO student_course_cu_ledger(id,quota_id,org_id,student_id,series_id,lesson_id,session_id,generation_job_id,idempotency_key,state,reserved_cu,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[ledgerId,quota.id,orgId,studentId,seriesId,lessonId,sessionId,generationJobId,idempotencyKey,'RESERVED',amount,now,now]);
    return row('SELECT * FROM student_course_cu_ledger WHERE id=?',[ledgerId]);
  });
}
export function settleCourseCu({ id: ledgerId }) { if (!ledgerId) return null; return transaction(()=>{ const l=row('SELECT * FROM student_course_cu_ledger WHERE id=?',[ledgerId]); if(!l||l.state!=='RESERVED') return l; const now=nowIso(); q('UPDATE student_course_cu_quotas SET reserved_cu=reserved_cu-?,settled_cu=settled_cu+?,updated_at=? WHERE id=?',[l.reserved_cu,l.reserved_cu,now,l.quota_id]); q("UPDATE student_course_cu_ledger SET state='SETTLED',settled_cu=reserved_cu,updated_at=? WHERE id=?",[now,ledgerId]); return row('SELECT * FROM student_course_cu_ledger WHERE id=?',[ledgerId]); }); }
export function releaseCourseCu({ id: ledgerId, reason='FAILED', inTransaction=false }) { if(!ledgerId) return null; const release=()=>{ const l=row('SELECT * FROM student_course_cu_ledger WHERE id=?',[ledgerId]); if(!l||l.state!=='RESERVED') return l; const now=nowIso(); q('UPDATE student_course_cu_quotas SET reserved_cu=reserved_cu-?,updated_at=? WHERE id=?',[l.reserved_cu,now,l.quota_id]); q("UPDATE student_course_cu_ledger SET state='RELEASED',reason=?,updated_at=? WHERE id=?",[reason,now,ledgerId]); return row('SELECT * FROM student_course_cu_ledger WHERE id=?',[ledgerId]); }; return inTransaction ? release() : transaction(release); }
