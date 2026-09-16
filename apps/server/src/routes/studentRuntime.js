// 学生端「我的创作环境」：开一台自己的盒子 / 看它还在不在 / 下课收掉（2026-09-16）
//
// 学生要的东西只有一句：「进我的创作环境」。所以这里不让学生传课堂 id ——
// **课堂由服务端按他的名单反查**（一个学生全局最多属于一个未终态课堂这条口径，
// 见 docs/README.md），免得客户端随便传一个别人的课堂 id 过来。
//
// 真正的动作在 services/studentRuntime.js（门禁 → 签密钥 → 调宿主脚本 → 给入口地址）。
import { errors, requireRole, row } from '../lib.js';
import { launchStudentRuntime, stopStudentRuntime, studentRuntimeAvailability } from '../services/studentRuntime.js';

/** 这个学生现在该进哪个课堂：名单里 ACTIVE 且课堂 ACTIVE，最近的第一个。 */
function resolveActiveClassroom(studentId) {
  return row(
    `SELECT s.id, s.lesson_id, s.title
       FROM class_sessions s
       JOIN session_students p ON p.session_id = s.id
      WHERE p.student_id = ? AND p.status = 'ACTIVE' AND s.status = 'ACTIVE'
      ORDER BY s.started_at DESC, s.created_at DESC
      LIMIT 1`,
    [studentId],
  );
}

export async function handleStudentRuntime(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/student/runtime')) return null;
  const auth = requireRole(ctx, ['STUDENT']);
  const part = pathname.slice('/api/student/runtime'.length);
  const orgId = auth.session?.org_id || auth.user.orgId;

  if (part === '/status' && method === 'GET') {
    const availability = studentRuntimeAvailability();
    const classroom = resolveActiveClassroom(auth.user.id);
    return {
      available: availability.available,
      reason: availability.reason,
      classroom: classroom ? { id: classroom.id, lessonId: classroom.lesson_id, title: classroom.title } : null,
    };
  }

  if (part === '/launch' && method === 'POST') {
    const classroom = resolveActiveClassroom(auth.user.id);
    if (!classroom) throw errors.forbidden('你现在没有正在上的课堂，没有创作环境可以开', 'RUNTIME_NO_ACTIVE_CLASSROOM');
    const launched = await launchStudentRuntime({
      sessionId: classroom.id,
      studentId: auth.user.id,
      orgId,
      lessonId: classroom.lesson_id || null,
    });
    return launched;
  }

  if (part === '/stop' && method === 'POST') {
    const classroom = resolveActiveClassroom(auth.user.id);
    if (!classroom) throw errors.forbidden('你现在没有正在上的课堂', 'RUNTIME_NO_ACTIVE_CLASSROOM');
    return stopStudentRuntime({ sessionId: classroom.id, studentId: auth.user.id });
  }

  return null;
}
