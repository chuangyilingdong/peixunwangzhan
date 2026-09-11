// VibeCoding 流式回复的事件消费。
//
// 服务端事件序列：start → status* → delta* → artifact* → done / aborted / error
// 这里只负责把 SSE 帧解析成回调调用，不碰 React 状态——便于单测，也让工作区组件
// 只关心「收到什么就更新什么」。
//
// 注意 `artifact` 是**流式期间**就会来的：模型每写闭合一个文件围栏就推一条，
// 所以产物卡片是一个个出现的，而不是等整轮结束才一起冒出来。

/** 解析一段 SSE 原始文本，返回 [{ event, data }] */
export function parseSseChunk(raw) {
  return String(raw || '')
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event:')) || 'event: message';
      const dataLine = lines.find((line) => line.startsWith('data:')) || 'data:{}';
      let data = {};
      try { data = JSON.parse(dataLine.slice(5).trim() || '{}'); } catch { data = {}; }
      return { event: eventLine.slice(6).trim(), data };
    });
}

/**
 * 消费一个 SSE 响应体，逐事件回调。
 * @param response  fetch Response（body 为 ReadableStream）
 * @param handlers  { onStart, onStatus, onDelta, onArtifact, onDone, onAborted, onError }
 */
export async function consumeVibeCodingStream(response, handlers = {}) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw new Error('流式响应不可读');
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 以空行分帧；最后一段可能不完整，留在 buffer 里等下一块
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const { event, data } of parseSseChunk(blocks.join('\n\n'))) {
      switch (event) {
        case 'start': handlers.onStart?.(data); break;
        case 'status': handlers.onStatus?.(data); break;
        case 'delta': full += data.delta || ''; handlers.onDelta?.(data, full); break;
        case 'artifact': handlers.onArtifact?.(data); break;
        case 'done': handlers.onDone?.(data, full); break;
        case 'aborted': handlers.onAborted?.(data, full); break;
        case 'error': handlers.onError?.(data, full); break;
        default: break;
      }
    }
  }
  return full;
}
