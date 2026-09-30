/**
 * P166 「ZCode 客户端契约」的平台侧验收（真请求打网关）—— 2026-09-28 客户端给的
 * 《平台接口契约-zcode.md》里的待办 ②③④⑥ 落到常驻网。
 *
 * 客户端原话：「这是客户端给你的，客户端这边在修改」；它的待办清单里这四条要平台侧给答案：
 *   ② 确认 `client-context.gateway.baseUrl` 是可直接用于 OpenAI Chat Completions 的地址；
 *   ③ 网关兼容 ZCode 的**标准 tool call** 与**流式 usage**；
 *   ④ 补齐**缓存 token 透传**（prompt_cache_hit/miss_tokens、prompt_tokens_details.cached_tokens）
 *      与**每轮耗时日志**（time_to_first_token_ms / total_upstream_ms / provider / model / channelId）；
 *   ⑥ 在平台侧验证 ZCode 的一轮文本请求与**至少两轮 tool call**。
 *
 * 做法：临时库 + 课堂夹具（照 p118）→ 一个**假上游**（说 OpenAI 方言、会回 tool_calls、
 * usage 里带缓存字段、并记录收到的请求体）→ 起真服务 → 学生登录 → client-context 拿运行时密钥
 * → **用 <baseUrl>/chat/completions 逐轮真打**。
 *
 * ⚠️ 三条容易踩的：
 *   ① 裸 base 是 404（只有 `/chat/completions` 那条有处理器）—— 所以断言里必须**拼上这一段**，
 *      契约里给的示例 `…/api/runtime-gateway` 在平台上是**不存在的路径**（实测 404）。
 *   ② 频次/课堂模式：运行时接口只认 VIBECODING 课堂（p118 的老坑），夹具要切过去。
 *   ③ 渠道要配 API key，否则 provider 装配直接判 invalid（p161 的老坑）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p166-zcode-contract-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');
const { setProviderApiKey } = await import('../apps/server/src/services/providerSecret.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});

/* ────────── 假上游：OpenAI 方言，会回 tool_calls，usage 带缓存字段 ────────── */
const seenBodies = [];
let upstreamPort = 0;
const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
    seenBodies.push({ url: req.url, method: req.method, body });
    const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;
    // 第二轮：历史里已经有 tool 结果 → 再回**另一个**工具调用（这样"两轮 tool call"才算真验到）
    const lastToolResult = [...(body.messages || [])].reverse().find((m) => m?.role === 'tool');
    const callId = lastToolResult ? 'call_round2' : 'call_round1';
    const fnName = lastToolResult ? 'write_file' : 'read_file';
    const args = lastToolResult ? '{"path":"a.txt","content":"hi"}' : '{"path":"a.txt"}';
    const usage = {
      prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
      // DeepSeek 系的缓存字段名（契约点名要透传的）
      prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 56,
    };
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      if (wantsTools) {
        sse(res, { id: 'chatcmpl-p166', object: 'chat.completion.chunk', created: 1, model: body.model || 'p166-model',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: fnName, arguments: '' } }] }, finish_reason: null }] });
        sse(res, { id: 'chatcmpl-p166', object: 'chat.completion.chunk', created: 1, model: body.model || 'p166-model',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
        sse(res, { id: 'chatcmpl-p166', object: 'chat.completion.chunk', created: 1, model: body.model || 'p166-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        sse(res, { id: 'chatcmpl-p166', object: 'chat.completion.chunk', created: 1, model: body.model || 'p166-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: '好' }, finish_reason: null }] });
        sse(res, { id: 'chatcmpl-p166', object: 'chat.completion.chunk', created: 1, model: body.model || 'p166-model',
          choices: [{ index: 0, delta: { content: '的，我看看。' }, finish_reason: null }] });
        sse(res, { id: 'chatcmpl-p166', object: 'chat.completion.chunk', created: 1, model: body.model || 'p166-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      // 结尾的用量分片（OpenAI 方言：choices 为空数组）
      sse(res, { id: 'chatcmpl-p166', object: 'chat.completion.chunk', created: 1, model: body.model || 'p166-model', choices: [], usage });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ id: 'chatcmpl-p166', object: 'chat.completion', created: 1, model: body.model || 'p166-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }], usage }));
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
upstreamPort = upstream.address().port;

/* ────────── 服务与夹具 ────────── */
const port = 18921;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  RUNTIME_GATEWAY_SECRET: 'p166-secret',
  DSH_RUNTIME_GATEWAY_URL: `http://127.0.0.1:${port}/api/gateway/v1`,
  PLATFORM_DATA_DIR_ALIAS: temp,
  PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
  PORT: String(port),
};
const api = (suffix, init = {}) => fetch(`http://127.0.0.1:${port}${suffix}`, init);
const gatewayPost = (key, body) => api('/api/gateway/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});
/** 读 SSE，返回 { content, toolCalls, finishReasons, usage, done } */
const readSse = async (response) => {
  const out = { content: '', toolCalls: [], finishReasons: [], usage: null, done: false, status: response.status };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') { out.done = true; continue; }
      let chunk = null;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk?.error) out.error = chunk.error;
      if (chunk?.usage) out.usage = chunk.usage;
      for (const choice of chunk?.choices || []) {
        const delta = choice?.delta || {};
        if (delta.content) out.content += delta.content;
        for (const call of delta.tool_calls || []) out.toolCalls.push(call);
        if (choice?.finish_reason) out.finishReasons.push(choice.finish_reason);
      }
    }
  }
  return out;
};

/** 按 index 合并工具调用分片 —— OpenAI 流式就是这么拼的：**先给 id/name，后续分片才补 arguments**，
 *  所以判"这个调用长得对不对"必须看**合并后**的结果（只看第一个分片会以为 arguments 是空的）。 */
const mergeToolCalls = (deltas) => {
  const byIndex = new Map();
  for (const delta of deltas) {
    const index = Number(delta?.index ?? 0);
    const current = byIndex.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
    byIndex.set(index, {
      ...current,
      ...(delta.id ? { id: delta.id } : {}),
      ...(delta.type ? { type: delta.type } : {}),
      function: {
        name: delta.function?.name || current.function.name,
        arguments: `${current.function.arguments}${delta.function?.arguments || ''}`,
      },
    });
  }
  return [...byIndex.values()];
};

let server = null;
let serverLog = '';
try {
  await run(['packages/database/src/db.js', '--init']);
  const seeded = await run(['packages/database/src/seed.js']);
  await ensureClassroom(dbPath);
  // 运行时接口只认 VIBECODING 课堂（p118 的老坑）
  await aq("UPDATE class_sessions SET delivery_mode='VIBECODING'");
  await aq("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);
  // 把 TEXT 渠道指到假上游（+ 一把 key，否则 provider 装配判 invalid）
  setProviderApiKey('p166-key', 'p166-channel');
  await aq('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1', [JSON.stringify({
    provider: 'custom', displayName: 'P166 假上游', model: 'p166-model', endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
    channels: [{ id: 'p166-channel', name: 'P166 渠道', provider: 'custom', model: 'p166-model', models: ['p166-model'], endpoint: `http://127.0.0.1:${upstreamPort}/v1` }],
    modalityChannels: { TEXT: 'p166-channel' },
  })]);

  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await api('/api/health')).ok) break; } catch { /* 还没起 */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const login = await (await api('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'student-1', password: 'study123' }) })).json();
  const token = login?.data?.token;
  assert.ok(token, '学生登录没拿到 token（夹具没生效？）');
  const context = (await (await api('/api/student/runtime/client-context', { headers: { authorization: `Bearer ${token}` } })).json()).data;
  assert.ok(context?.classroom, `client-context 没给出课堂：${JSON.stringify(context).slice(0, 200)}`);
  const key = context.gateway.key;

  /* ── ② 契约里的形状与 baseUrl ─────────────────────────────────────── */
  console.log('\n② client-context 的形状与 gateway.baseUrl');
  check('② classroom 是契约里的三个字段（id / lessonId / title）',
    Boolean(context.classroom.id) && typeof context.classroom.lessonId === 'string' && typeof context.classroom.title === 'string',
    JSON.stringify(context.classroom));
  check('② gateway.baseUrl 指向 /api/gateway/v1（客户端在它后面拼 /chat/completions）',
    /\/api\/gateway\/v1$/.test(String(context.gateway.baseUrl || '')), String(context.gateway.baseUrl));
  check('② models 是契约里的 [{id, displayName}]', Array.isArray(context.models) && context.models.length > 0
    && context.models.every((item) => typeof item.id === 'string' && typeof item.displayName === 'string'),
    JSON.stringify(context.models).slice(0, 160));
  check('② sends 是契约里的 {limit, used, remaining}', Boolean(context.sends) && 'limit' in context.sends && 'used' in context.sends && 'remaining' in context.sends,
    JSON.stringify(context.sends));
  check('② 裸 base（不拼 /chat/completions）在平台上是 404 —— 契约里那个示例路径不存在',
    (await api('/api/gateway/v1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 404
    && (await api('/api/runtime-gateway', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 404);

  /* ── ⑥ + ③ 一轮文本（流式）+ usage 缓存字段 ───────────────────────── */
  console.log('\n③⑥ 一轮文本（流式）：内容分片 + usage 透传缓存字段');
  const streamOptions = { include_usage: true };
  const textRound = await readSse(await gatewayPost(key, {
    model: 'p166-model', stream: true, stream_options: streamOptions,
    messages: [{ role: 'user', content: '你好，看看这个文件' }],
  }));
  check('⑥ 一轮文本：收到了内容分片（choices[].delta.content）', textRound.content === '好的，我看看。', JSON.stringify(textRound.content));
  check('⑥ 一轮文本：以 [DONE] 收尾且 finish_reason=stop', textRound.done && textRound.finishReasons.includes('stop'), JSON.stringify(textRound.finishReasons));
  check('④ usage 透传了缓存字段（prompt_cache_hit_tokens / prompt_cache_miss_tokens）',
    textRound.usage?.prompt_cache_hit_tokens === 64 && textRound.usage?.prompt_cache_miss_tokens === 56, JSON.stringify(textRound.usage));
  check('④ usage 也给了 OpenAI 那套嵌套写法（prompt_tokens_details.cached_tokens）',
    textRound.usage?.prompt_tokens_details?.cached_tokens === 64, JSON.stringify(textRound.usage?.prompt_tokens_details));
  check('④ usage 的基本三项仍在（prompt_tokens / completion_tokens / total_tokens）',
    textRound.usage?.prompt_tokens === 120 && textRound.usage?.completion_tokens === 30 && textRound.usage?.total_tokens === 150, JSON.stringify(textRound.usage));
  const forwarded = seenBodies.filter((item) => item.url.includes('/chat/completions')).at(-1)?.body || {};
  check('③ 客户端带的 stream_options 被**原样转发**给上游', JSON.stringify(forwarded.stream_options) === JSON.stringify(streamOptions), JSON.stringify(forwarded.stream_options));

  /* ── ⑥ 两轮 tool call ───────────────────────────────────────────── */
  console.log('\n⑥ 两轮 tool call：delta.tool_calls 原样转发 + finish_reason=tool_calls');
  const tools = [{ type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const round1 = await readSse(await gatewayPost(key, {
    model: 'p166-model', stream: true, tools, tool_choice: 'auto',
    messages: [{ role: 'user', content: '读一下 a.txt' }],
  }));
  const call1 = mergeToolCalls(round1.toolCalls)[0] || {};
  check('⑥ 第 1 轮：收到工具调用分片（delta.tool_calls）', round1.toolCalls.length >= 2 && call1.function?.name === 'read_file',
    JSON.stringify(round1.toolCalls).slice(0, 200));
  check('⑥ 第 1 轮：流末 finish_reason=tool_calls（客户端靠它决定去执行工具）', round1.finishReasons.includes('tool_calls'), JSON.stringify(round1.finishReasons));
  check('⑥ 第 1 轮：**按分片合并后**工具调用带 id 与拼好的 arguments', Boolean(call1.id) && String(call1.function?.arguments || '').includes('a.txt'), JSON.stringify(call1));
  const round2 = await readSse(await gatewayPost(key, {
    model: 'p166-model', stream: true, tools, tool_choice: 'auto',
    messages: [
      { role: 'user', content: '读一下 a.txt' },
      { role: 'assistant', content: '', tool_calls: [{ id: call1.id || 'call_round1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: call1.id || 'call_round1', content: 'hi' },
    ],
  }));
  const call2 = mergeToolCalls(round2.toolCalls)[0] || {};
  check('⑥ 第 2 轮：**再**收到一次工具调用（两轮都对得上才算验收过）', round2.toolCalls.length >= 2 && call2.function?.name === 'write_file',
    JSON.stringify(round2.toolCalls).slice(0, 200));
  check('⑥ 第 2 轮：工具结果回填的消息被原样带给了上游（假上游看到了 role=tool）',
    (seenBodies.at(-1)?.body?.messages || []).some((message) => message?.role === 'tool'), JSON.stringify(seenBodies.at(-1)?.body?.messages || []).slice(0, 200));

  /* ── ④ 每轮耗时日志 ─────────────────────────────────────────────── */
  console.log('\n④ 每轮耗时与路由日志');
  const logLine = serverLog.split('\n').find((line) => line.includes('[runtimeGateway] provider=') && line.includes('p166-model'));
  check('④ 日志里有 provider / model / channel / time_to_first_token_ms / total_upstream_ms / status',
    Boolean(logLine) && /channel=p166-channel/.test(logLine) && /time_to_first_token_ms=\d+/.test(logLine)
    && /total_upstream_ms=\d+/.test(logLine) && /status=SUCCESS/.test(logLine) && /error_code=-/.test(logLine),
    logLine || '(没找到日志行)');

  /* ── ④ 代码默认值不再指向老域名 ─────────────────────────────────── */
  console.log('\n④ gatewayUrl 的代码默认值跟着本站域名推');
  // ⚠️ 判"源码里还有没有老域名"之前**先剥注释**：这个文件的注释里**正引用着**那句老默认值
  //    （"原来硬写着 https://iicili.cyou/…"），不剥就是假红 —— 今天已经栽过一次（p132/p162）。
  const runtimeSource = stripComments(fs.readFileSync(path.join(root, 'apps/server/src/services/studentRuntime.js'), 'utf8'));
  check('④ 源码里不再硬写老域名 iicili.cyou', !runtimeSource.includes('iicili.cyou'));
  check('④ 默认值是 `${PUBLIC_SITE_URL}/api/gateway/v1`', /\$\{PUBLIC_SITE_URL\.replace\([^)]*\)\}\/api\/gateway\/v1/.test(runtimeSource));
  /* ── ⑤ 历史上限：默认 80、可配、**截断时不再静默**（2026-09-29 契约第二版 待办 2）────── */
  console.log('\n⑤ 历史上限：可配 + 截断时给显式标记');
  const historyModule = await import('../apps/server/src/routes/runtimeGateway.js');
  check('⑤ 默认上限 **80** 条（原来是 40 条 ≈ 13 轮，客户端报"第 15 轮突然忘事、界面看不出原因"）',
    historyModule.maxHistoryMessages() === 80, String(historyModule.maxHistoryMessages()));
  const savedLimit = process.env.RUNTIME_GATEWAY_MAX_HISTORY;
  process.env.RUNTIME_GATEWAY_MAX_HISTORY = '20';
  check('⑤ 可配：RUNTIME_GATEWAY_MAX_HISTORY=20 生效', historyModule.maxHistoryMessages() === 20, String(historyModule.maxHistoryMessages()));
  process.env.RUNTIME_GATEWAY_MAX_HISTORY = 'abc';
  check('⑤ 配了非法值回默认（不是 NaN、不是 0 —— 那是"每次只带 0 条"的地狱）',
    historyModule.maxHistoryMessages() === 80, String(historyModule.maxHistoryMessages()));
  if (savedLimit === undefined) delete process.env.RUNTIME_GATEWAY_MAX_HISTORY; else process.env.RUNTIME_GATEWAY_MAX_HISTORY = savedLimit;

  // 造一段 agent 形状的长历史：user → assistant(tool_calls) → tool 来回 40 轮 = 120 条
  const longHistory = [];
  for (let i = 1; i <= 40; i += 1) {
    longHistory.push({ role: 'user', content: `第${i}轮：改一下 a.txt` });
    longHistory.push({ role: 'assistant', content: '', tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'write_file', arguments: '{}' } }] });
    longHistory.push({ role: 'tool', tool_call_id: `call_${i}`, content: `第${i}轮完成` });
  }
  const meta = historyModule.normalizeMessagesWithMeta({ messages: longHistory });
  check('⑤ 超限时算得出丢了多长（120 条 → 丢 40、留 80 + 1 条标记）',
    meta.dropped === 40 && meta.messages.length === 81, JSON.stringify({ dropped: meta.dropped, kept: meta.messages.length }));
  check('⑤ 切完的开头**不是孤儿 tool 消息**（上游会因为配对不上直接拒）',
    meta.messages[1]?.role !== 'tool', JSON.stringify(meta.messages[1]).slice(0, 120));

  const longResponse = await gatewayPost(key, { model: 'p166-model', stream: true, messages: longHistory });
  check('⑤ 真请求：响应头 x-platform-history-dropped 告诉客户端丢了多少（界面才能说清原因）',
    longResponse.headers.get('x-platform-history-dropped') === '40',
    JSON.stringify([...longResponse.headers].filter(([name]) => name.startsWith('x-platform-'))));
  check('⑤ 客户端 2026-09-30 口径：**不再发** x-platform-history-limit（他们不需要"上限"，只要"丢了多少"）',
    longResponse.headers.get('x-platform-history-limit') === null, String(longResponse.headers.get('x-platform-history-limit')));
  await readSse(longResponse);
  const forwardedLong = seenBodies.at(-1)?.body?.messages || [];
  check('⑤ 真请求：上游收到的**第一条**是那条 system 说明（模型因此知道"更早的不在我手上"）',
    forwardedLong[0]?.role === 'system' && String(forwardedLong[0]?.content).includes('已省略') && forwardedLong.length === 81,
    JSON.stringify(forwardedLong[0]).slice(0, 160));

  // ⚠️ 反向对照：短历史**不许**带标记、也不许带响应头 —— 否则就是"每轮都在说丢了东西"，标记会失去意义
  const shortResponse = await gatewayPost(key, { model: 'p166-model', stream: true, messages: [{ role: 'user', content: '你好' }] });
  check('⑤ 反向对照：短历史不带 x-platform-history-dropped 响应头',
    shortResponse.headers.get('x-platform-history-dropped') === null, String(shortResponse.headers.get('x-platform-history-dropped')));
  await readSse(shortResponse);
  const forwardedShort = seenBodies.at(-1)?.body?.messages || [];
  check('⑤ 反向对照：短历史里上游看不到那条 system 说明',
    !String(forwardedShort[0]?.content || '').includes('已省略'), JSON.stringify(forwardedShort[0]).slice(0, 120));
  /* ── ⑦ 缓存拆分：进账本 + 报表看得见（2026-09-29 客户端对账口径，用户口径「要做」）────── */
  console.log('\n⑦ 缓存 token 的账本与报表');
  // 假上游在 usage 里固定回 hit=64 / miss=56、prompt_tokens=120（见本文件上面的夹具）
  const lastUsage = await arow("SELECT cache_hit_tokens, cache_miss_tokens, input_tokens, output_tokens FROM usage_records WHERE user_id=(SELECT id FROM users WHERE login='student-1') ORDER BY created_at DESC LIMIT 1");
  check('⑦ 网关这一轮的用量落进账本，且带缓存拆分（hit=64 / miss=56）',
    Number(lastUsage?.cache_hit_tokens) === 64 && Number(lastUsage?.cache_miss_tokens) === 56, JSON.stringify(lastUsage));
  check('⑦ 缓存是 input 的**拆分**（hit + miss == input_tokens —— 对账时不能重复计）',
    Number(lastUsage?.cache_hit_tokens) + Number(lastUsage?.cache_miss_tokens) === Number(lastUsage?.input_tokens), JSON.stringify(lastUsage));
  const adminLogin = await (await api('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'root', password: 'admin123' }) })).json();
  const adminToken = adminLogin?.data?.token;
  check('⑦ 平台超管能登录（下面报表那一步要用）', Boolean(adminToken), JSON.stringify(adminLogin).slice(0, 160));
  if (adminToken) {
    const report = await (await api('/api/admin/billing/usage-records?limit=8', { headers: { authorization: `Bearer ${adminToken}` } })).json();
    const reportRow = (report?.data?.items || []).find((item) => Number(item.cacheHitTokens) === 64);
    check('⑦ 平台用量报表里能读到 cacheHitTokens / cacheMissTokens（对账要看得见，不然加列也白加）',
      Boolean(reportRow) && Number(reportRow.cacheMissTokens) === 56 && Number(reportRow.inputTokens) === 120,
      JSON.stringify((report?.data?.items || []).slice(0, 2)).slice(0, 300));
  }
  check('⑦ 每轮日志行带上 cache_hit / cache_miss（对账对不上时能从日志上看）',
    serverLog.split('\n').some((line) => line.includes('[runtimeGateway]') && /cache_hit=64/.test(line) && /cache_miss=56/.test(line)));
} catch (error) {
  failures += 1;
  console.error('P166 抛错：', error?.message || error);
  if (serverLog) console.error(serverLog.split('\n').slice(-12).join('\n'));
} finally {
  if (server) server.kill('SIGTERM');
  await new Promise((resolve) => { upstream.closeAllConnections?.(); upstream.close(resolve); });
}

console.log('');
if (failures) { console.log(`✗ p166 有 ${failures} 处不符合预期`); process.exitCode = 1; }
else console.log('✓ p166 ZCode 客户端契约（平台侧）：全部通过');
