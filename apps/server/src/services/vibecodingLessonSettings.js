// VibeCoding 课时级设置：**发送次数上限**（拦人的）与**预设提示词**（给客户端点的）。
//
// ── 为什么单独一个文件、单独一套机制 ──────────────────────────────────────────
// 2026-09-19 用户口径：「发送次数是创建课包课程的时候，如果选择 vibecoding 课堂就可以选择
// 发送按钮可以按几次。」这是一条**新的、明确要拦人**的产品口径。
// ⚠️ 它与 `services/sessionCostCap.js`（「学生算力额度」）**不是一回事**，不要合并、也别去改那套：
//    · 那套的落点是**钱**（上游成本），2026-09-18 定的是「只观测、不拦人」，文件头明确写着
//      「要拦人的话那是另一个（不存在的）机制」—— **这就是那个机制**；
//    · 这一套的落点是**教学节奏**（别让学生拿发送键当刷新键用），按**次数**算，跟花多少钱无关。
//    两套各自有列、各自有守卫，互不引用对方的判定。
//
// ── 怎么数「按了几次发送」──────────────────────────────────────────────────
// ⚠️ **不能数网关被调了几次**：dsh 自己也会发模型请求（压缩历史、起标题、多轮工具调用），
//    按调用算会让"按 1 次发送"吃掉好几次额度。也不能信客户端报数（本地计数器随手可改）。
// 判据用**对话历史里 user 消息条数的单调最大值**：网关每次请求都带完整历史，而
//    · 学生按一次发送，历史里只会多一条 user 消息（随后同一轮的多次请求条数不再变）；
//    · dsh 的内部请求不改变这个条数；
//    · 历史被压缩会变短 → 取最大值（只增不减），不倒退；
//    · 学生编辑/重发导致条数不增时**不追加**（对学生有利的方向）。
//
// ── 口径与默认值 ─────────────────────────────────────────────────────────
//   · 配置位置：`course_lessons.classroom_config.vibeCoding.sendLimit`（**不新增表、不迁移数据**；
//     `normalizeClassroomConfig` 本来就是整个 `vibeCoding` 对象原样透传）。
//   · **不填 / 0 = 不设上限**（照旧不拦）—— 所以这条口径不会在没人配置时悄悄改变现状。
//   · 计数列：`session_students.vibecoding_sends`（每学生每场课堂，与 `completed_cost_fen` 同一层）。
//     老库补列默认 0 = 还没数到任何发送（不是"已用满"）。
//   · **留空 = 不记上限，但仍然记账**：上课时照数，老师端/平台端将来能看到"这个学生按了几次"。
import { q, row } from '../lib.js';

/** 读这节课配的发送次数上限。返回 `null` = 不设上限（不填 / 0 / 非法值都按不设上限处理）。 */
export function vibecodingSendLimit(lessonId) {
  if (!lessonId) return null;
  const config = row('SELECT classroom_config FROM course_lessons WHERE id=?', [lessonId])?.classroom_config;
  let parsed = null;
  try { parsed = config ? JSON.parse(config) : null; } catch { parsed = null; }
  const value = parsed?.vibeCoding?.sendLimit;
  if (value === undefined || value === null || value === '') return null;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.floor(limit);
}

/**
 * 读这节课的预设提示词（给客户端显示、点了自动填入对话框）。
 * 形状固定为 `[{ title, text }]`：`title` 是按钮上那句话，`text` 是点下去填进输入框的内容。
 * 非法/缺省一律返回空数组（客户端不显示这一块），不做任何猜测。
 */
export function vibecodingPresetPrompts(lessonId) {
  if (!lessonId) return [];
  const config = row('SELECT classroom_config FROM course_lessons WHERE id=?', [lessonId])?.classroom_config;
  let parsed = null;
  try { parsed = config ? JSON.parse(config) : null; } catch { parsed = null; }
  const list = parsed?.vibeCoding?.presetPrompts;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ title: String(item.title || '').trim(), text: String(item.text || '').trim() }))
    .filter((item) => item.title && item.text);
}

/**
 * 数对话历史里的 user 消息条数（= 学生的发送次数）。
 * ⚠️ 带 `tool_call_id` / `tool_calls` 的"user"消息不算 —— 那是工具回填，不是人按的发送。
 */
export function countUserMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((message) => {
    if (!message || message.role !== 'user') return false;
    if (message.tool_call_id || message.tool_calls) return false;
    return true;
  }).length;
}

/** 这个学生在**这场课堂**里已记下的发送次数（单调最大值）。 */
export function vibecodingSendUsage({ sessionId, studentId }) {
  if (!sessionId || !studentId) return 0;
  const value = row(
    "SELECT vibecoding_sends FROM session_students WHERE session_id=? AND student_id=? AND status <> 'REMOVED' ORDER BY added_at DESC LIMIT 1",
    [sessionId, studentId],
  )?.vibecoding_sends;
  const used = Number(value);
  return Number.isFinite(used) && used > 0 ? used : 0;
}

/**
 * 判定这一次请求放不放行，并把"学生的发送次数"往前推（只增不减）。
 *
 * ⚠️ 调用点必须在**打上游之前**（`routes/runtimeGateway.js`）——超限的这一次既不花钱、也不进用量账。
 * ⚠️ **判据必须用"观察到的单调最大值"（seen），不能只用本次请求历史里的条数**：学生压缩一次历史，
 *    历史里的 user 消息就变少了 —— 只看当前条数等于"压缩一下就刷新额度"（我第一版就是这么错的）。
 * ⚠️ 但**对外报的 `used` 封顶到上限**（`min(seen, limit)`）：这样老师端/客户端看到的是"用了几次／共几次"，
 *    不会因为学生超限后反复点而出现"这学生按了 37 次"这种脏数字，`used ≤ limit` 这个不变量也成立。
 * 返回 `{ limit, used, allowed, remaining, exceeded }`：`limit === null` 表示这节课没设上限。
 */
export function enforceVibecodingSendLimit({ sessionId, studentId, lessonId, messages }) {
  const limit = vibecodingSendLimit(lessonId);
  const observed = countUserMessages(messages);
  const seenBefore = vibecodingSendUsage({ sessionId, studentId });
  const seen = Math.max(seenBefore, observed);
  const exceeded = limit !== null && seen > limit;
  // 见到的最大值往前推就落库（含被拦下的那几次 —— 判据靠它，不落库就会漏放）
  if (seen > seenBefore && sessionId && studentId) {
    q(
      "UPDATE session_students SET vibecoding_sends=?, updated_at=? WHERE session_id=? AND student_id=? AND status <> 'REMOVED'",
      [seen, new Date().toISOString(), sessionId, studentId],
    );
  }
  const used = limit === null ? seen : Math.min(seen, limit);
  return {
    limit,
    used,
    allowed: !exceeded,
    remaining: limit === null ? null : Math.max(0, limit - used),
    exceeded,
  };
}
