import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openAiCompatibleProvider, chatCompletionsEndpoint, modalityEndpoint } from '../apps/server/src/services/openaiCompatibleProvider.js';
import { normalizeProviderError, PROVIDER_ERROR_CODES } from '../apps/server/src/services/providerContract.js';

const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
  if (req.method === 'GET' && req.url === '/v1/videos/generations/video-1') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'video-1', status: 'succeeded', output: { url: 'https://media.example/video.mp4' } }));
    return;
  }
  const prompt = body.messages?.find((item) => item.role === 'user')?.content || body.prompt || body.input || '';
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
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '真实接口返回的文本' }] } }] }));
    return;
  }
  if (req.url === '/v1/images/generations') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: 'https://media.example/image.png' }] }));
    return;
  }
  if (req.url === '/v1/music/generations') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: { b64_json: Buffer.from('music-bytes').toString('base64'), mime_type: 'audio/mpeg' } }));
    return;
  }
  if (req.url === '/v1/videos/generations') {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'video-1', status: 'processing' }));
    return;
  }
  if (req.url === '/v1/podcasts/generations') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ asset_url: 'https://media.example/podcast.mp3', mime_type: 'audio/mpeg' }] }));
    return;
  }
  if (req.url === '/v1/audio/speech') {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(Buffer.from('dubbing-bytes'));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const endpoint = `http://127.0.0.1:${port}/v1`;
assert.equal(chatCompletionsEndpoint(endpoint), `${endpoint}/chat/completions`);
assert.equal(modalityEndpoint(endpoint, 'IMAGE'), `${endpoint}/images/generations`);

try {
  const provider = openAiCompatibleProvider({ name: 'openai-compatible', model: 'test-model', endpoint, apiKey: 'secret-test-key', pollIntervalMs: 10 });
  const modalities = [
    ['TEXT', 'hello', 'text/plain; charset=utf-8', /真实接口返回的文本/],
    ['IMAGE', 'image', 'image/png', /^https:\/\/media\.example\/image\.png$/],
    ['MUSIC', 'music', 'audio/mpeg', /^data:audio\/mpeg;base64,/],
    ['VIDEO', 'video', 'video/mp4', /^https:\/\/media\.example\/video\.mp4$/],
    ['PODCAST', 'podcast', 'audio/mpeg', /^https:\/\/media\.example\/podcast\.mp3$/],
    ['DUBBING', 'dubbing', 'audio/mpeg', /^data:audio\/mpeg;base64,/],
  ];
  for (const [modality, prompt, mimeType, urlPattern] of modalities) {
    const result = await provider.generate({ modality, prompt, title: `${modality} 测试` });
    assert.equal(result.assets.length, 1);
    assert.equal(result.assets[0].mimeType, mimeType);
    const comparableUrl = modality === 'TEXT' ? decodeURIComponent(result.assets[0].assetUrl) : result.assets[0].assetUrl;
    assert.match(comparableUrl, urlPattern);
  }
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer secret-test-key');
  assert.equal(requests[0].body.model, 'test-model');
  assert.equal(requests[0].body.messages.at(-1).content, 'hello');
  const imageRequest = requests.find((item) => item.url === '/v1/images/generations');
  assert.equal(imageRequest.body.response_format, 'url');
  const dubbingRequest = requests.find((item) => item.url === '/v1/audio/speech');
  assert.equal(dubbingRequest.body.response_format, 'mp3');
  assert.equal(requests.find((item) => item.url === '/v1/videos/generations').method, 'POST');
  assert.equal(requests.find((item) => item.url === '/v1/videos/generations/video-1').method, 'GET');

  await assert.rejects(() => provider.generate({ modality: 'TEXT', prompt: 'rate-limit' }), (error) => normalizeProviderError(error).code === PROVIDER_ERROR_CODES.RATE_LIMITED);
  await assert.rejects(() => provider.generate({ modality: 'TEXT', prompt: 'safety' }), (error) => normalizeProviderError(error).code === PROVIDER_ERROR_CODES.SAFETY_REJECTED);
  await assert.rejects(() => provider.generate({ modality: 'TEXT', prompt: 'invalid' }), (error) => error.code === PROVIDER_ERROR_CODES.RESPONSE_INVALID);
  const timeoutProvider = openAiCompatibleProvider({ name: 'custom', model: 'test-model', endpoint, apiKey: 'secret-test-key', timeoutMs: 1000 });
  await assert.rejects(() => timeoutProvider.generate({ modality: 'TEXT', prompt: 'timeout' }), (error) => error.code === PROVIDER_ERROR_CODES.TIMEOUT);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(JSON.stringify({ name: 'p6-a01-openai-compatible-adapter', pass: true, checks: 23 }));
