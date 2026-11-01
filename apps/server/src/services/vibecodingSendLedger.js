/**
 * VibeCoding 发送次数**幂等台账**（2026-11-01，客户端契约见
 * 《给平台-课堂发送计数与全局提示词-20261101.md》）。
 *
 * 为什么换判据：原来只能从对话历史里猜"这条 user 消息是不是学生按的那一下" ——
 *   dsh 会把压缩摘要、运行时上下文、技能指令、工具图片回填都当**普通 user 消息**投进历史，
 *   每出一个新形态就要补一条识别规则（INJECTED_PREFIXES 已经补了十几条）。2026-11-01 现场：
 *   学生本地只按了 2 次，平台记到 9 次、封顶成 7，课堂在 12:10 就被 429 锁死。
 *
 * 现在客户端给每次真实发送派生出的**所有**模型请求带同一个 `x-zcode-send-id`（turnId）：
 *   · 同一个用户发送产生的工具轮 / 压缩 / 起标题 / 子代理 / SSE 重试 / 断线重连，全复用它；
 *   · 只有用户下一次点击发送才会产生新值；
 *   · 没有 turnId 的后台请求不会伪造这个头。
 * 所以"这个值有多少个不同的"就是发送次数 —— 不需要再猜内容。
 *
 * ⚠️ **幂等必须靠数据库主键，不能先查后写**：同一条请求可能并发到 8 路（SSE 重连 + 工具轮），
 *    "SELECT 有没有 → 没有就 INSERT" 在并发下必然重复计数。这里用 `INSERT OR IGNORE` +
 *    复合主键 (session_id, student_id, send_id)，只有真正插入成功的那一次算新发送。
 *    `aq()` 在 MySQL 驱动下会把 `INSERT OR IGNORE` 翻成 `INSERT IGNORE`，并回 `changes`
 *    （见 packages/database/src/mysql.js）。
 *
 * ⚠️ 与旧路径的隔离：没有 sendId 的请求（老客户端）仍然走 `vibecodingLessonSettings.js` 的启发式；
 *    但只要这场课堂已有台账行，旧路径就不再计数（见 enforceVibecodingSendLimit）。
 *    两条路各写各的会让同一次发送被记两遍。
 */
import { aq, arow } from '../lib.js';

/** 客户端契约：sendId 是 turnId，128 足够；截断而不是拒绝 —— 格式变了也不该让整次生成 400。 */
const MAX_SEND_ID_LENGTH = 128;

export function normalizeSendId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.slice(0, MAX_SEND_ID_LENGTH);
}

/**
 * 记一次发送（幂等）。
 * @returns {Promise<{inserted: boolean, sendId: string}>} inserted=true 表示这是**第一次**见到这个 sendId
 */
export async function recordSendId({ sessionId, studentId, sendId }) {
  const normalized = normalizeSendId(sendId);
  if (!sessionId || !studentId || !normalized) return { inserted: false, sendId: '' };
  const result = await aq(
    'INSERT OR IGNORE INTO session_vibecoding_sends(session_id, student_id, send_id, first_seen_at) VALUES (?,?,?,?)',
    [sessionId, studentId, normalized, new Date().toISOString()],
  );
  return { inserted: Number(result?.changes || 0) > 0, sendId: normalized };
}

/** 这场课堂这个学生**真实发送过几次**（= 台账行数）。表是事实源。 */
export async function countSendIds({ sessionId, studentId }) {
  if (!sessionId || !studentId) return 0;
  const value = (await arow(
    'SELECT COUNT(*) AS n FROM session_vibecoding_sends WHERE session_id=? AND student_id=?',
    [sessionId, studentId],
  ))?.n;
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}
