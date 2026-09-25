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
// ⚠️ 但"user 消息"里有两类**不是学生按的**，必须减掉（两个都在真客户端上踩过）：
//    · 工具回填（带 `tool_call_id` / `tool_calls`）；
//    · **dsh 注入的上下文块**：`agent-instructions` 把工作区指令当普通 user 消息投进历史，
//      整条裹在 `<system-reminder>…</system-reminder>` 里（基线一次 + 刷新若干次）。
//      不减掉它，按一次发送会被记成 3 次。见 isInjectedReminder。
//
// ── 2026-09-25：0.1.7 的注入块把这条口径打穿了（学生只按了 2 次、记成 8/8 被锁死）──────
// 现场：客户端 `client-context.sends = {limit:8, used:8}`，而 DSH 自己的会话投影是
//       `turns: 1 / 225 步` 与 `turns: 1 / 24 步` —— 真人只发了 2 次，历史里却多出 6 条
//       "像用户消息"的注入（每次发送约 3 条）。0.1.7 比 09-19 那版多注入好几类，
//       而原来的判据只认两种形态，认不出来的就被当成学生按的发送。
// 修法**两档一起上，缺一不可**：
//   ① 补判据：把 0.1.7 已知的注入形态都认出来（见下 INJECTED_PREFIXES / INJECTED_PATTERNS）；
//   ② **夹取**（治本，且对"还没见过的新注入形态"免疫）：真人**在同一个请求里**不可能按两次发送 ——
//      相邻两次请求之间，历史里的"学生消息"最多 +1。所以本次观察到多少，都只许把 seen 往前推 1。
//      这一条是**对学生的保护**：新插件新版本注入再多，也压不出这个上限。
//        · 反过来的风险（真出现一条请求带 2 条真人消息）现在不存在：客户端一次只发一条；
//          真发生了也是**少算**一次，方向对学生有利。
//   ③ 只在"这一轮真的是新发送"时才推进：工具轮里 dsh 也会打网关（一步一次），
//      那些请求的末尾是 tool/assistant 而不是学生的话 —— 这时**一点都不推**，
//      否则光靠夹取也会被"每步 +1"慢慢磨上去（用户看到的就是"任务还在跑就 8/8"）。
// 另外：没认出来的注入会打一行告警（内容前 80 字），下次再出新形态看日志就能补。
//
// ── 口径与默认值 ─────────────────────────────────────────────────────────
//   · 配置位置：`course_lessons.classroom_config.vibeCoding.sendLimit`（**不新增表、不迁移数据**；
//     `normalizeClassroomConfig` 本来就是整个 `vibeCoding` 对象原样透传）。
//   · **不填 / 0 = 不设上限**（照旧不拦）—— 所以这条口径不会在没人配置时悄悄改变现状。
//   · 计数列：`session_students.vibecoding_sends`（每学生每场课堂，与 `completed_cost_fen` 同一层）。
//     老库补列默认 0 = 还没数到任何发送（不是"已用满"）。
//   · **留空 = 不记上限，但仍然记账**：上课时照数，老师端/平台端将来能看到"这个学生按了几次"。
import { q, row, arow, aq } from '../lib.js';

/** 读这节课配的发送次数上限。返回 `null` = 不设上限（不填 / 0 / 非法值都按不设上限处理）。 */
export async function vibecodingSendLimit(lessonId) {
  if (!lessonId) return null;
  const config = (await arow('SELECT classroom_config FROM course_lessons WHERE id=?', [lessonId]))?.classroom_config;
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
export async function vibecodingPresetPrompts(lessonId) {
  if (!lessonId) return [];
  const config = (await arow('SELECT classroom_config FROM course_lessons WHERE id=?', [lessonId]))?.classroom_config;
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
 * dsh 注入块的**定型前缀**（每条都对着一类真注入）。
 *
 * 与 `<system-reminder>` 那类不同：它们**不带任何包裹**，只有一句定型文案打头，正文是上下文。
 * 前缀一律取**整句**（而不是半句），免得把学生恰好在英文里写出的半句排除掉 ——
 * 排除错了是**少算**，方向对学生有利，但也别太随意。
 *
 * 形态来源：客户端仓 dsh 源码（0.1.7 档）+ 2026-09-25 现场那份 `8/8` 的报文比对；
 * 各条的注入点写在注释里，出现新的注入块时照这个形状往下加，并把前 80 字告警一起看。
 */
const INJECTED_PREFIXES = [
  // @deepseek-ai/dsh-system-prompt 的运行时上下文快照：每轮请求都带（快照会更新），
  // 实测不排除的话一次发送会被多记 1 次。
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  // 同一套的**清零态**：上下文被清空时换成这句（另一句、另一个前缀，0.1.7 才有）。
  'Current runtime context: none. Earlier runtime-context snapshots no longer apply.',
  // dsh-time-context：`Time sampled while preparing turn N, step M: …`（desktop 运行时里装了它）
  'Time sampled while preparing turn ',
  // compaction：自动检查点（preamble 文本打头，正文裹在 <compacted-summary> 里，会**留在历史里**）
  'This is an automatically generated checkpoint condensing an earlier span',
  // compaction：压缩请求本身（body = 完整历史 + 这一条指令，所以它让条数整体 +1）
  'You are now acting as a compaction engine for this AI coding assistant.',
  // dsh-repeat-tool-reminder：重复调用同一个工具时的提醒
  'You are repeating the exact same tool call with identical arguments.',
  'Repeated tool call detected:',
  // 会话修复：被中断的工具结果补一条 user 消息
  'The tool call was interrupted after it was recorded',
  // session-title-llm 的起标题请求。⚠️ 平台 09-19 那版**有意不排**它（"独立请求、最多 +1"），
  // 但有了 09-25 的夹取之后"+1"会变成永久虚高，所以现在要排掉。
  'Generate the session title from this JSON array of human messages:',
];

/** 形状类注入（前缀不固定，但有鲜明的机器特征）。 */
const INJECTED_PATTERNS = [
  // 学生用客户端的模型选择器切一下模型，dsh 就往历史里插一条变更通知
  /^\[model changed: assistant turns above this point were generated by /,
];

/**
 * 这条 user 消息是不是 **dsh 自己注入的上下文块**（不是学生按的那一下发送）。
 *
 * 为什么要专门认它们：dsh 把上下文当**普通 user 消息**投进历史，而网关只拿得到
 * `{role, content}`（实测：body 里没有 source/name 之类可判的字段），所以只能认内容。
 * 不认的话，学生**按一次发送**会被记成 3 次（2026-09-19 真客户端实测：学生那条 +
 * 运行时上下文快照 + skills 指令块）。两个来源：
 *   · `agent-instructions`（工作区指令：基线 + 刷新）—— 整条裹在 `<system-reminder>…</system-reminder>`；
 *   · `system-prompt`（运行时上下文快照）—— 以上面那句英文打头。
 * 判据是"整条被方括号裹住"：dsh 会把正文里的收尾标记转义成 `<\/system-reminder>`，所以真·注入的
 * 消息里只有末尾一个未转义的收尾，学生自己打的字不会整条长成这个形状。
 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  return '';
}

function isInjectedReminder(message) {
  const trimmed = messageText(message).trim();
  if (!trimmed) return false;
  if (INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  if (INJECTED_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>');
}

/** 这条"user"消息看起来**就是学生自己按的那一下**（不是工具回填、也不是注入块）。 */
function isHumanUserMessage(message) {
  if (!message || message.role !== 'user') return false;
  if (message.tool_call_id || message.tool_calls) return false;
  if (isInjectedReminder(message)) return false;
  // 正文为空的（只剩图片块之类）不算一次发送 —— dsh 的工具图片回填就是这种形状
  return messageText(message).trim().length > 0;
}

/**
 * 这一次请求是不是"学生刚按了发送的那一下"。
 * 判据：**末尾那条**是像学生发的 user 消息。dsh 的工具轮请求末尾是 tool/assistant
 * （或它自己的注入块），那些请求不该推进计数 —— 否则一步 +1，一条消息能磨光整节课的额度。
 */
function looksLikeFreshSend(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  return isHumanUserMessage(messages[messages.length - 1]);
}

/**
 * 数对话历史里的 user 消息条数（= 学生的发送次数）。
 * ⚠️ 带 `tool_call_id` / `tool_calls` 的"user"消息不算 —— 那是工具回填，不是人按的发送。
 * ⚠️ dsh 注入的 `<system-reminder>` 块也不算（见 isInjectedReminder）。
 */
export function countUserMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter(isHumanUserMessage).length;
}

/** 诊断用：把这次请求里"像学生发的"那些消息的头 80 字摘出来（找新注入形态用）。 */
export function previewUserMessages(messages, { limit = 6 } = {}) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message?.role === 'user' && !message.tool_call_id && !message.tool_calls)
    .slice(0, limit)
    .map((message) => {
      const text = messageText(message).replace(/\s+/g, ' ').trim();
      return `${isInjectedReminder(message) ? '[注入]' : '[算数]'} ${text.slice(0, 80)}(${text.length})`;
    });
}

/** 这个学生在**这场课堂**里已记下的发送次数（单调最大值）。 */
export async function vibecodingSendUsage({ sessionId, studentId }) {
  if (!sessionId || !studentId) return 0;
  const value = (await arow(
    "SELECT vibecoding_sends FROM session_students WHERE session_id=? AND student_id=? AND status <> 'REMOVED' ORDER BY added_at DESC LIMIT 1",
    [sessionId, studentId],
  ))?.vibecoding_sends;
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
export async function enforceVibecodingSendLimit({ sessionId, studentId, lessonId, messages }) {
  const limit = await vibecodingSendLimit(lessonId);
  const observed = countUserMessages(messages);
  const seenBefore = await vibecodingSendUsage({ sessionId, studentId });
  // ① 不是"新的一次发送"（工具轮 / dsh 自己的请求）→ 一点都不推
  // ② 是的话，最多 +1（真人一个请求里只可能发一条）—— 注入块再多也压不出这个上限
  const bounded = looksLikeFreshSend(messages) ? Math.min(observed, seenBefore + 1) : seenBefore;
  const seen = Math.max(seenBefore, bounded);
  const exceeded = limit !== null && seen > limit;
  // 夹掉了东西 = 有一条"像用户消息"的东西没被认出来（多半是 dsh 新版注入的新形态）。
  // 打一行就够定位：把它的前 80 字记下来，照着往 INJECTED_PREFIXES 里补。
  if (observed > bounded) {
    console.warn(`[发送计数] 本次观察到 ${observed} 条像学生发的消息，只认 +1（夹掉 ${observed - bounded} 条）`
      + ` · session=${sessionId || '-'} student=${studentId || '-'} · ${previewUserMessages(messages).join(' | ')}`);
  } else if (String(process.env.VIBECODING_SEND_LIMIT_DEBUG || '') === '1') {
    console.log(`[发送计数] 观察 ${observed} / 已记 ${seenBefore} / 本次 ${looksLikeFreshSend(messages) ? '算一次' : '不推'}`
      + ` · ${previewUserMessages(messages).join(' | ')}`);
  }
  // 见到的最大值往前推就落库（含被拦下的那几次 —— 判据靠它，不落库就会漏放）
  if (seen > seenBefore && sessionId && studentId) {
    await aq(
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
