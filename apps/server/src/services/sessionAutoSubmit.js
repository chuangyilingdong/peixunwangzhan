/**
 * 课堂结束时自动提交画布作品（2026-11-03，用户口径）。
 *
 * 画布每改一次都会自动保存到服务器（`PUT /student/projects/:id`，`autoSave: true`），
 * 所以老师点「结束课堂」时，平台手里有每个学生**最后一次自动保存的快照**。
 * 学生忘了点「提交作品」的，这里直接用它落一条作品，老师立刻能看到。
 *
 * 规则（与手动提交同一套判据，见 routes/student.js 的 /projects/:id/submit）：
 *   · 只看本场课堂、名单里未被移除的学生；
 *   · 没有新产出（相对 last_submitted_output_signature）→ 跳过，不重复提交；
 *   · 空画布 → 跳过；
 *   · 已评分/已归档的项目、已发布到广场的作品 → 跳过（手动流程也不允许）；
 *   · 自动提交的作品 `copyright_confirmed_at` 为空、`auto_submitted=1`：
 *     老师能看到、能点评，但**不能直接发布到作品广场**（学生之后可补确认版权）。
 *
 * ⚠️ 这是**尽力而为**：单个学生失败只记日志、不抛给老师；老师点结束课堂不能因为
 *    「某个学生的快照坏了」而失败。
 */
import { aq, arow, arows, atransaction, audit, id, json, nowIso } from '../lib.js';
import { canvasOutputSignature, newCanvasOutputKeys } from '../../../../packages/shared/src/canvasOutput.js';

const AUTO_DESCRIPTION = '课堂结束时由系统自动提交（学生未点确认版权）';
const AUTO_SNAPSHOT_LABEL = '课堂结束自动提交';
const PROJECT_STATUSES = new Set(['DRAFT', 'SUBMITTED']);
const RESUBMITTABLE_WORK_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'UNPUBLISHED']);

/**
 * @param {{session: object, ctx: object, actorId?: string|null}} input
 * @returns {Promise<{submitted:number, skipped:number, failed:number, studentIds:string[], workIds:string[]}>}
 */
export async function autoSubmitSessionCanvasWorks({ session, ctx, actorId = null }) {
  const result = { submitted: 0, skipped: 0, failed: 0, studentIds: [], workIds: [] };
  const roster = await arows(
    "SELECT student_id FROM session_students WHERE session_id=? AND status <> 'REMOVED'",
    [session.id],
  );
  const allowed = new Set(roster.map((item) => item.student_id));
  const projects = await arows(
    `SELECT * FROM student_projects
      WHERE org_id=? AND class_session_id=? AND deleted_at IS NULL
        AND status IN ('DRAFT','SUBMITTED')`,
    [session.org_id, session.id],
  );
  for (const project of projects) {
    if (!allowed.has(project.student_id)) { result.skipped += 1; continue; }
    try {
      const snapshot = JSON.parse(project.canvas_snapshot || '{}');
      const freshKeys = newCanvasOutputKeys(snapshot, project.last_submitted_output_signature);
      if (!freshKeys.length) { result.skipped += 1; continue; }
      const priorWork = await arow(
        'SELECT * FROM works WHERE project_id=? AND student_id=? AND org_id=?',
        [project.id, project.student_id, project.org_id],
      );
      if (priorWork && !RESUBMITTABLE_WORK_STATUSES.has(String(priorWork.status || '').toUpperCase())) {
        result.skipped += 1;
        continue;
      }
      const now = nowIso();
      const outputSignature = canvasOutputSignature(snapshot);
      const latestVersion = Number(project.latest_version || 1) + 1;
      const workId = priorWork?.id || id('work');
      let round = 1;
      await atransaction(async () => {
        const fresh = await arow(
          'SELECT * FROM student_projects WHERE id=? AND student_id=? AND org_id=? AND deleted_at IS NULL',
          [project.id, project.student_id, project.org_id],
        );
        if (!fresh || !PROJECT_STATUSES.has(String(fresh.status || '').toUpperCase())) {
          throw new Error('PROJECT_NOT_SUBMITTABLE');
        }
        const existingWork = await arow(
          'SELECT * FROM works WHERE project_id=? AND student_id=? AND org_id=?',
          [fresh.id, fresh.student_id, fresh.org_id],
        );
        if (existingWork && !RESUBMITTABLE_WORK_STATUSES.has(String(existingWork.status || '').toUpperCase())) {
          throw new Error('WORK_NOT_SUBMITTABLE');
        }
        await aq(
          `UPDATE student_projects
              SET status='SUBMITTED',latest_version=?,last_saved_at=?,updated_at=?,last_submitted_output_signature=?
            WHERE id=?`,
          [latestVersion, now, now, outputSignature, fresh.id],
        );
        await aq(
          `INSERT INTO project_snapshots(id,project_id,version,label,canvas_snapshot,actor_id,created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [id('snapshot'), fresh.id, latestVersion, AUTO_SNAPSHOT_LABEL, json(snapshot), fresh.student_id, now],
        );
        if (existingWork) {
          const latestSubmission = await arow(
            'SELECT round FROM work_submissions WHERE work_id=? ORDER BY round DESC LIMIT 1',
            [existingWork.id],
          );
          round = Number(latestSubmission?.round || 0) + 1;
          await aq(
            `UPDATE works SET title=?,description=?,canvas_snapshot=?,status='PENDING',
               teacher_comment=NULL,reviewed_by=NULL,reviewed_at=NULL,
               featured_at=NULL,featured_by=NULL,featured_reason=NULL,
               unpublish_reason=NULL,unpublished_at=NULL,submitted_at=?,
               auto_submitted=1,copyright_confirmed_at=NULL,copyright_confirmed_by=NULL,
               is_public=0,share_token=NULL
             WHERE id=?`,
            [fresh.title, AUTO_DESCRIPTION, json(snapshot), now, existingWork.id],
          );
        } else {
          await aq(
            `INSERT INTO works(
               id,project_id,student_id,org_id,class_id,class_session_id,course_lesson_id,title,description,canvas_snapshot,
               auto_submitted,status,copyright_confirmed_at,copyright_confirmed_by,submitted_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,1,'PENDING',NULL,NULL,?)`,
            [workId, fresh.id, fresh.student_id, fresh.org_id, fresh.class_id,
              fresh.class_session_id || session.id, fresh.course_lesson_id, fresh.title,
              AUTO_DESCRIPTION, json(snapshot), now],
          );
        }
        await aq(
          `INSERT INTO work_submissions(
             id,work_id,project_id,student_id,org_id,round,title,description,canvas_snapshot,snapshot_version,
             submitted_at,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id('submission'), workId, fresh.id, fresh.student_id, fresh.org_id, round,
            fresh.title, AUTO_DESCRIPTION, json(snapshot), latestVersion, now, now, now],
        );
        await aq(
          'UPDATE usage_records SET work_id=? WHERE project_id=? AND org_id=? AND user_id=?',
          [workId, fresh.id, fresh.org_id, fresh.student_id],
        );
      });
      await audit(ctx, 'PROJECT_AUTO_SUBMIT', 'WORK', workId, null,
        { projectId: project.id, studentId: project.student_id, round, actorId, autoSubmitted: true },
        { orgId: session.org_id });
      result.submitted += 1;
      result.studentIds.push(project.student_id);
      result.workIds.push(workId);
    } catch (error) {
      result.failed += 1;
      console.warn(`[auto-submit] session=${session.id} project=${project.id} 跳过/失败：${String(error?.message || error).slice(0, 200)}`);
    }
  }
  return result;
}
