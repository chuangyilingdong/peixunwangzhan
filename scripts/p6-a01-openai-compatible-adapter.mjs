import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openAiCompatibleProvider, chatCompletionsEndpoint } from '../apps/server/src/services/openaiCompatibleProvider.js';
import { normalizeProviderError, PROVIDER_ERROR_CODES } from '../apps/server/src/services/providerContract.js';

const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
  const prompt = body.messages?.find((item) => item.role === 'user')?.content || '';
  if (prompt === 'rate-limit') {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    return;
  }
  if (prompt === 'safety') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'content policy violation' } }));
    return;
  }
  if (prompt === 'invalid') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [] }));
    return;
  }
  if (prompt === 'timeout') {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '迟到的响应' } }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '真实接口返回的文本' }] } }] }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const endpoint = `http://127.0.0.1:${port}/v1`;
assert.equal(chatCompletionsEndpoint(endpoint), `${endpoint}/chat/completions`);

try {
  const provider = openAiCompatibleProvider({ name: 'openai-compatible', model: 'test-model', endpoint, apiKey: 'secret-test-key' });
  const result = await provider.generate({ modality: 'TEXT', prompt: 'hello', title: '测试结果' });
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].mimeType, 'text/plain; charset=utf-8');
  assert.match(decodeURIComponent(result.assets[0].assetUrl.split(',').slice(1).join(',')), /真实接口返回的文本/);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer secret-test-key');
  assert.equal(requests[0].body.model, 'test-model');
  assert.equal(requests[0].body.messages.at(-1).content, 'hello');

  await assert.rejects(() => provider.generate({ modality: 'IMAGE', prompt: 'image' }), (error) => error.code === PROVIDER_ERROR_CODES.MODALITY_UNSUPPORTED);
  await assert.rejects(() => provider.generate({ modality: 'TEXT', prompt: 'rate-limit' }), (error) => normalizeProviderError(error).code === PROVIDER_ERROR_CODES.RATE_LIMITED);
  await assert.rejects(() => provider.generate({ modality: 'TEXT', prompt: 'safety' }), (error) => normalizeProviderError(error).code === PROVIDER_ERROR_CODES.SAFETY_REJECTED);
  await assert.rejects(() => provider.generate({ modality: 'TEXT', prompt: 'invalid' }), (error) => error.code === PROVIDER_ERROR_CODES.RESPONSE_INVALID);
  const timeoutProvider = openAiCompatibleProvider({ name: 'custom', model: 'test-model', endpoint, apiKey: 'secret-test-key', timeoutMs: 1000 });
  await assert.rejects(() => timeoutProvider.generate({ modality: 'TEXT', prompt: 'timeout' }), (error) => error.code === PROVIDER_ERROR_CODES.TIMEOUT);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(JSON.stringify({ name: 'p6-a01-openai-compatible-adapter', pass: true, checks: 12 }));
