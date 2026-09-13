/**
 * 守卫用的「课堂」HTTP 辅助（2026-09-13 批次 D）。
 *
 * 背景：守卫原来一律走「建班级 → 配课单 → 班级开课」那一套。班级退场、旧 `/api/org/classes/*`
 * 下线之后，搭场景统一改成**直接建课堂**。把这个搬家动作收在一处：
 *   · 10 个守卫的改写保持一致，不会各写一版；
 *   · 以后课堂口径再变，只需要改这里。
 *
 * 全部走真实接口（不直接插库）——插库会绕过门禁与状态机，守卫就不再是在验真实行为。
 * 端点是批次 B 就落好的：`POST /api/org/sessions`、`/sessions/:id/(start|end|dissolve)`、
 * `/sessions/:id/students`。
 */

async function post(api, token, pathname, body) {
  return api(pathname, { method: 'POST', token, body });
}

/** 建一个课堂（默认 CANVAS 入口）。返回课堂 id。 */
export async function createClassroom(api, token, { lessonId, title, deliveryMode = 'CANVAS', teacherId, studentIds = [] } = {}) {
  const created = await post(api, token, '/api/org/sessions', {
    lessonId,
    deliveryMode,
    ...(title ? { title } : {}),
    // 只有机构管理员能指定老师；教师传了会被服务端忽略（它挂在自己名下）
    ...(teacherId ? { teacherId } : {}),
  });
  const sessionId = created?.data?.id;
  if (!sessionId) throw new Error('建课堂失败：' + JSON.stringify(created).slice(0, 300));
  if (studentIds.length) await addClassroomStudents(api, token, sessionId, studentIds);
  return sessionId;
}

/** 加学员进课堂名单（自动跳过加不进去的，返回实际加进去的人数）。 */
export async function addClassroomStudents(api, token, sessionId, studentIds) {
  const result = await post(api, token, `/api/org/sessions/${encodeURIComponent(sessionId)}/students`, { studentIds });
  return result?.data?.added?.length || 0;
}

/** 开始上课（名单为空会被服务端拒）。 */
export async function startClassroom(api, token, sessionId) {
  return post(api, token, `/api/org/sessions/${encodeURIComponent(sessionId)}/start`);
}

/** 结束课堂（会按「这节课有没有消耗过算力」结算学员）。 */
export async function endClassroom(api, token, sessionId, reason) {
  return post(api, token, `/api/org/sessions/${encodeURIComponent(sessionId)}/end`, reason ? { reason } : {});
}

/** 解散课堂（待上课才能解散）。 */
export async function dissolveClassroom(api, token, sessionId, reason) {
  return post(api, token, `/api/org/sessions/${encodeURIComponent(sessionId)}/dissolve`, reason ? { reason } : {});
}

/** 课堂名单（含六态）。 */
export async function classroomStudents(api, token, sessionId) {
  const detail = await api(`/api/org/sessions/${encodeURIComponent(sessionId)}`, { token });
  return detail?.data?.students || [];
}

/**
 * 「开一间课堂并把它开起来」——守卫里最常见的两步。
 * 返回课堂 id，顺带把 detail 带回来（免得再查一次）。
 */
export async function openClassroom(api, token, options = {}) {
  const sessionId = await createClassroom(api, token, options);
  const started = await startClassroom(api, token, sessionId);
  if (started?.status !== 200) throw new Error('开始上课失败：' + JSON.stringify(started).slice(0, 300));
  return sessionId;
}
