/**
 * VibeCoding 进行中任务登记（2026-11-04）。
 *
 * 为什么需要：VibeCoding 的回复是 SSE 流式生成，**库里只有结束后的 assistant message**，
 * 没有「进行中」状态；监控台要显示「运行中任务」就必须在进程内记一笔。
 *
 * 口径：
 *   · 只在 streamAssistantReply 的生命周期内存在，finally 里必然删除（学生断线/中止也走 finally）；
 *   · 多实例部署时各实例只看到自己进程里的任务 —— 当前生产是单实例，够用；
 *   · 只读给监控用，不参与计费/配额。
 */
const tasks = new Map();

export function startVibecodingTask(id, info = {}) {
  tasks.set(String(id), {
    conversationId: info.conversationId || null,
    orgId: info.orgId || null,
    userId: info.userId || null,
    model: info.model || null,
    startedAt: Date.now(),
  });
}

export function finishVibecodingTask(id) {
  tasks.delete(String(id));
}

export function getVibecodingActiveTasks() {
  return [...tasks.entries()].map(([id, value]) => ({ id, ...value }));
}

/** 守卫用：清空（测试进程里避免串场）。 */
export function resetVibecodingTasks() {
  tasks.clear();
}
