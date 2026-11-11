// 联调专用假上游：只在本机回环监听，给平台「测试模型通道」用。
//
// 用途：验证课堂文本流式超时（客户端 idle timeout / 平台 20 分钟超时 / 客户端断线）。
// 不接真实模型、不产生费用；每个请求按 body.model 选择场景：
//   test-stream-quick       2 秒后发第一段内容，然后 [DONE]（通路冒烟）
//   test-stream-11m         11 分钟后发第一段内容，然后 [DONE]
//   test-stream-11m-nodone  11 分钟后发第一段内容 + finish_reason，但**不发 [DONE]**，随后结束响应
//   test-stream-never       只发 : ping，永远不发内容/不结束（用于 20 分钟平台超时 + 客户端关闭）
//
// 启动：
//   FAKE_SSE_PORT=18999 FAKE_SSE_LOG=/srv/ai-kids-platform/test-runtime/fake-sse.jsonl \
//     node scripts/fake-sse-upstream.mjs
//
// 只绑定 127.0.0.1，不对外网开放。日志一行一个 JSON：
//   { id, model, startedAt, firstPingAt, firstContentAt, endedAt, endReason, pings, bytes, clientRequestId }
import http from 'node:http';
import fs from 'node:fs';

const PORT = Math.max(1, Number(process.env.FAKE_SSE_PORT || 18999));
const HOST = String(process.env.FAKE_SSE_HOST || '127.0.0.1');
const LOG_PATH = String(process.env.FAKE_SSE_LOG || '').trim();
const PING_MS = Math.max(1000, Number(process.env.FAKE_SSE_PING_MS || 15000));
const CONTENT_DELAY_MS = Math.max(0, Number(process.env.FAKE_SSE_CONTENT_DELAY_MS || 0));

function log(entry) {
  if (!LOG_PATH) return;
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n'); } catch { /* 日志写不进去不拦测试 */ }
}

function writeSse(res, data) {
  if (res.writableEnded || res.destroyed) return false;
  try { res.write(`data: ${data}\n\n`); return true; } catch { return false; }
}

function writePing(res) {
  if (res.writableEnded || res.destroyed) return false;
  try { res.write(': ping\n\n'); return true; } catch { return false; }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'fake-sse-upstream', port: PORT }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 联调用，不严格 */ }
    const model = String(body.model || '').trim();
    const id = `fake_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const clientRequestId = String(req.headers['x-client-request-id'] || '').trim() || null;
    const startedAt = new Date().toISOString();
    const state = { id, model, clientRequestId, startedAt, firstPingAt: null, firstContentAt: null, endedAt: null, endReason: null, pings: 0, bytes: 0 };

    const finish = (reason) => {
      if (state.endedAt) return;
      state.endedAt = new Date().toISOString();
      state.endReason = reason;
      log(state);
    };

    // 立即 200 + SSE，先发一个 ping（nginx/客户端都能马上看到流已建立）
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (writePing(res)) { state.pings += 1; state.firstPingAt = new Date().toISOString(); }
    const pingTimer = setInterval(() => {
      if (writePing(res)) { state.pings += 1; } else { clearInterval(pingTimer); }
    }, PING_MS);
    pingTimer.unref?.();

    const contentTimer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      state.firstContentAt = new Date().toISOString();
      const text = `联调测试内容（模型 ${model || '未指定'}，${new Date().toISOString()}）`;
      writeSse(res, JSON.stringify({ choices: [{ delta: { content: text } }] }));
      writeSse(res, JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      if (model === 'test-stream-11m-nodone') {
        // 不发 [DONE]，直接结束响应；平台/客户端应把 EOF 当作本轮结束。
        clearInterval(pingTimer);
        res.end();
        finish('content_end_without_done');
        return;
      }
      if (model !== 'test-stream-never') {
        writeSse(res, '[DONE]');
        clearInterval(pingTimer);
        res.end();
        finish('done');
      }
    }, model === 'test-stream-quick'
      ? Math.min(CONTENT_DELAY_MS || 2000, 5000)
      : (CONTENT_DELAY_MS || 11 * 60 * 1000));
    contentTimer.unref?.();

    res.on('close', () => {
      clearInterval(pingTimer);
      clearTimeout(contentTimer);
      // 客户端/平台主动断开（包括 20 分钟平台超时）
      if (!state.endedAt) finish('client_closed');
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[fake-sse] listening http://${HOST}:${PORT} ping=${PING_MS}ms contentDelay=${CONTENT_DELAY_MS || 'scenario'}ms log=${LOG_PATH || '(off)'}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref?.(); });
}
