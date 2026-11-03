/**
 * P202：运行网关的思考控制必须真正进入上游请求体。
 *
 * 覆盖两件事：
 * - 运行网关只放行四个思考字段，并记录 requested/forwarded；
 * - openAiCompatibleProvider 在模板渲染后把这些字段写入上游请求，流式与非流式一致。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { openAiCompatibleProvider } from '../apps/server/src/services/openaiCompatibleProvider.js';
import { runtimeReasoningControls, runtimeReasoningLabel } from '../apps/server/src/routes/runtimeGateway.js';

const normalized = runtimeReasoningControls({
  reasoning_effort: ' low ',
  reasoning: { effort: 'low' },
  thinking: { type: 'enabled' },
  output_config: { effort: 'low' },
  ignored_client_field: 'must-not-pass',
});
assert.deepEqual(normalized, {
  reasoningEffort: 'low',
  reasoning: { effort: 'low' },
  thinking: { type: 'enabled' },
  outputConfig: { effort: 'low' },
});
assert.equal(runtimeReasoningLabel(normalized), 'low');
assert.throws(
  () => runtimeReasoningControls({ reasoning: 'not-an-object' }),
  (error) => error?.code === 'RUNTIME_REASONING_INVALID' && error?.status === 400,
);

const bodies = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  bodies.push(body);
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ id: 'p202-stream', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'p202-stream', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    id: 'p202-json',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, reasoning_tokens: 2 },
  }));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const { port } = server.address();
  const provider = openAiCompatibleProvider({
    name: 'p202-openai-compatible',
    model: 'deepseek-flash',
    endpoint: `http://127.0.0.1:${port}`,
    apiKey: 'p202-key',
    timeoutMs: 5000,
  });
  const options = {
    reasoningEffort: 'low',
    reasoning: { effort: 'low' },
    thinking: { type: 'enabled' },
    outputConfig: { effort: 'low' },
  };

  const generated = await provider.generate({ modality: 'TEXT', messages: [{ role: 'user', content: 'hello' }], options });
  const streamed = await provider.generateStream({ messages: [{ role: 'user', content: 'hello' }], options, onDelta: () => {} });

  assert.equal(generated.usage?.reasoningTokens, 2);
  assert.equal(streamed.usage?.reasoningTokens, 3);

  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.reasoning_effort, 'low');
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.ignored_client_field, undefined);
  }
  console.log(JSON.stringify({ name: 'runtime-gateway-reasoning-body', pass: true, requests: bodies.length }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}