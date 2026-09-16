/**
 * 工具调用标记（DSML）过滤 —— 2026-09-16。
 *
 * 背景（用户报的「跟 AI 对话乱码」）：学生创作环境里的 agent 走我们的 OpenAI 兼容网关，
 * 但网关**请求侧丢掉了 tools、响应侧只认 content**（见 routes/runtimeGateway.js 与
 * services/openaiCompatibleProvider.js 的注释）。模型拿不到结构化的工具通道，就把工具调用
 * 按 DeepSeek 系的原生习惯**当正文吐出来**：
 *
 *   <|DSML|_|calls> <|DSML|_|invoke name="run_code"> <|DSML|_|parameter name="code"> ...
 *   </|DSML|_|parameter> </|DSML|_|invoke> </|DSML|_|calls>
 *
 * 网关原样透传，学生界面上就出现这段标记。真正的修法是**打通 tools / tool_calls**，
 * 本模块只是**止血**：把这段标记从出站文本里摘掉，别让学生看见乱码。
 *
 * 三条硬约束（学生就是用这套环境写 HTML/JS 的，误伤等于把学生的代码吃了）：
 *   ① 只锚定 `DSML` 这个字面量，**绝不**写「去尖括号」「去任意标签」这类宽正则；
 *   ② 处理**跨 SSE 分片**的半截标记（遇到像标记开头的 '<' 就留一小段尾巴，见 TAIL）；
 *   ③ 有安全阀：一整块标记迟迟不收尾时不能无限吞下去（MAX_BLOCK_CHARS）。
 */

// 标记开头：'<' + 几个 |／｜／▁／_／空白 + DSML（大小写不敏感）。
// 真实的标记用 ASCII 竖线，但字体/复制粘贴里常出现全角『｜』或下划线『▁』，都认。
const MARKER_START = /<[|｜▁_\s]{0,8}DSML/i;
// 可能是「半截标记」的尾巴最多留这么多字符（正常标记远短于此）。
const TAIL = 24;
// 安全阀：一块标记累计丢这么多字符还不收尾，就认为收尾标记不会来了，恢复直通。
const MAX_BLOCK_CHARS = 20000;

/**
 * 建一个有状态的过滤器：逐片 push，最后 flush。
 * @param {{ onStrip?: (chars: number) => void }} options
 */
export function createDsmlStripper({ onStrip = null } = {}) {
  let buffer = '';
  let inBlock = false;
  let sawCallsOpener = false;
  let blockChars = 0;
  let swallowNewline = false;

  /** 能安全吐出去的位置：遇到可能是半截标记的 '<' 就停在它前面。 */
  function safeCut(text) {
    const lt = text.lastIndexOf('<');
    if (lt < 0) return text.length;                     // 没有 '<'，全发
    if (text.indexOf('>', lt) >= 0) return text.length;  // '<' 后有 '>'，是完整标签
    if (text.length - lt > TAIL) return text.length;     // 太长了，不可能是标记前缀
    return lt;                                          // 悬空的 '<'：留着等下一片
  }

  /** 收尾标记的结束位置（含标记本身），找不到返回 -1。 */
  function closingEnd(text) {
    // 见过 <...calls> 就等 </...calls>；只见过 <...invoke> 就退一步等 </...invoke>。
    const re = sawCallsOpener
      ? /<\/[|｜▁_\s]{0,8}DSML[^>]{0,40}calls[^>]{0,10}>/i
      : /<\/[|｜▁_\s]{0,8}DSML[^>]{0,40}(?:calls|invoke)[^>]{0,10}>/i;
    const m = re.exec(text);
    return m ? m.index + m[0].length : -1;
  }

  function push(chunk) {
    const piece = String(chunk ?? '');
    if (!piece) return '';
    buffer += piece;
    let out = '';
    let dropped = 0;

    for (;;) {
      if (!inBlock) {
        // 刚摘掉一块标记：把紧跟其后的那个换行也吃掉。跨分片时这个换行可能在**下一片**里，
        // 所以要留个标志等一等（否则逐字符喂就会多出一行空行）。
        if (swallowNewline && buffer) {
          const m = /^[ \t]*\r?\n/.exec(buffer);
          if (m) buffer = buffer.slice(m[0].length);
          swallowNewline = false;
        }
        const start = MARKER_START.exec(buffer);
        if (!start) {
          const cut = safeCut(buffer);
          out += buffer.slice(0, cut);
          buffer = buffer.slice(cut);
          break;
        }
        // 标记之前的正常正文照发（学生写的 HTML 就在这一段里）
        out += buffer.slice(0, start.index);
        const markerText = buffer.slice(start.index);
        const end = markerText.indexOf('>');
        if (end < 0) { buffer = markerText; break; }       // 标记还没收完，整体留着
        if (/calls/i.test(markerText.slice(0, end))) sawCallsOpener = true;
        buffer = markerText.slice(end + 1);
        inBlock = true;
        continue;
      }

      const end = closingEnd(buffer);
      if (end >= 0) {
        dropped += end;
        blockChars += end;
        // 顺带把收尾标记之后的第一个换行吃掉，免得留下一行空白
        buffer = buffer.slice(end).replace(/^[ \t]*\r?\n/, '');
        inBlock = false;
        sawCallsOpener = false;
        blockChars = 0;
        swallowNewline = true;
        continue;
      }
      if (buffer.length > TAIL) {
        const cut = buffer.length - TAIL;
        dropped += cut;
        blockChars += cut;
        buffer = buffer.slice(cut);
      }
      if (blockChars > MAX_BLOCK_CHARS) {
        // 安全阀：这块标记实在太长了（上游被截断），把还留着的吐出去，别再吞了
        out += buffer;
        buffer = '';
        inBlock = false;
        sawCallsOpener = false;
        blockChars = 0;
      }
      break;
    }

    if (dropped && typeof onStrip === 'function') onStrip(dropped);
    return out;
  }

  function flush() {
    const rest = buffer;
    buffer = '';
    // 整条流收尾时还在块里：标记没收完，丢弃（不能把半截标记当正文发给学生）。
    if (inBlock) return '';
    return rest;
  }

  return { push, flush };
}

/** 一次性清洗整段文本（非流式路径用）。 */
export function stripDsml(text) {
  const stripper = createDsmlStripper();
  const cleaned = stripper.push(text) + stripper.flush();
  return cleaned.trim();
}
