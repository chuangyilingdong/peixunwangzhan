import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openAiCompatibleProvider, chatCompletionsEndpoint, modalityEndpoint } from '../apps/server/src/services/openaiCompatibleProvider.js';
import { normalizeProviderError, PROVIDER_ERROR_CODES } from '../apps/server/src/services/providerContract.js';

const requests = [];
let flakyPolls = 0;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
  if (req.method === 'GET' && req.url === '/v1/videos/video-1') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'video-1', status: 'completed', metadata: { url: 'https://media.example/video.mp4' } }));
    return;
  }
  // 「轮询抖两下才成功」：前两次查任务回 524（这家上游在境外中继上，实测真的会 520/524），
  // 第三次才给终态。**单次轮询失败不该把整条生成判死** —— 2026-09-21 两条真跑就是这么被判死的，
  // 而上游其实 `succeeded`、钱也扣了（见交接文档 §二.Q）。
  if (req.method === 'GET' && req.url === '/v1/videos/video-flaky') {
    flakyPolls += 1;
    if (flakyPolls <= 2) {
      res.writeHead(524, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'A timeout occurred' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'video-flaky', status: 'completed', metadata: { url: 'https://media.example/video-flaky.mp4' } }));
    return;
  }
  // 反向：**非瞬时**的轮询错误（内容安全 400）不许被重试吃成"慢成功" —— 那是结论，不是抖动。
  if (req.method === 'GET' && req.url === '/v1/videos/video-rejected') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'content policy violation' } }));
    return;
  }
  // 提交"不确定"：上游回 504 + `X-Task-Id`（文档：网关尝试提交但超时/5xx 时会带这个头 + Retry-After）。
  // 这时**必须接着查那条任务**，不许当失败、更不许重发（重发会双扣）。
  if (req.method === 'GET' && req.url === '/v1/videos/video-recovered') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'video-recovered', status: 'completed', metadata: { url: 'https://media.example/recovered.mp4' } }));
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
  if (req.url === '/v1/image/generations') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: 'https://media.example/image.png' }] }));
    return;
  }
  if (req.url === '/v1/music/generations') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: { b64_json: Buffer.from('music-bytes').toString('base64'), mime_type: 'audio/mpeg' } }));
    return;
  }
  if (req.url === '/v1/videos') {
    if (prompt === 'submit-uncertain') {
      // 提交结果不确定：504 + 公共任务号（正文仍是错误 envelope，任务号只在响应头里）。
      // ⚠️ 这个 writeHead 必须写在下面那个 202 之前（先写 202 再改 504 = ERR_HTTP_HEADERS_SENT）。
      res.writeHead(504, { 'content-type': 'application/json', 'x-task-id': 'video-recovered', 'retry-after': '1' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'timeout_error', message: 'upstream timeout', http_code: '504' } }));
      return;
    }
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify(prompt === 'flaky-poll' ? { id: 'video-flaky', status: 'processing' }
      : prompt === 'bad-poll' ? { id: 'video-rejected', status: 'processing' }
        : { id: 'video-1', status: 'processing' }));
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
assert.equal(modalityEndpoint(endpoint, 'IMAGE'), `${endpoint}/image/generations`);

try {
  const provider = openAiCompatibleProvider({ name: 'openai-compatible', model: 'test-model', endpoint, apiKey: 'secret-test-key', pollIntervalMs: 10 });
  const modalities = [
    ['TEXT', 'hello', 'text/plain; charset=utf-8', /真实接口返回的文本/],
    ['IMAGE', 'image', 'image/png', /^https:\/\/media\.example\/image\.png$/],
    ['MUSIC', 'music', 'audio/mpeg', /^data:audio\/mpeg;base64,/],
    ['VIDEO', 'video', 'video/mp4', /^https:\/\/media\.example\/video\.mp4$/],
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
  const imageRequest = requests.find((item) => item.url === '/v1/image/generations');
  // 图片请求体由渠道模板决定（默认 n=1 + size=比例 + metadata.resolution）
  assert.equal(imageRequest.body.n, 1);
  assert.ok('size' in imageRequest.body, '图片请求应带 size');
  assert.equal(requests.find((item) => item.url === '/v1/videos').method, 'POST');
  assert.equal(requests.find((item) => item.url === '/v1/videos/video-1').method, 'GET');

  await assert.rejects(() => provider.generate({ modality: 'TEXT', prompt: 'rate-limit' }), (error) => normalizeProviderError(error).code === PROVIDER_ERROR_CODES.RATE_LIMITED);
  await assert.rejects(() => provider.generate({ modality: 'TEXT', prompt: 'safety' }), (error) => normalizeProviderError(error).code === PROVIDER_ERROR_CODES.SAFETY_REJECTED);
  await assert.rejects(() => provider.generate({ modality: 'TEXT', prompt: 'invalid' }), (error) => error.code === PROVIDER_ERROR_CODES.RESPONSE_INVALID);
  const timeoutProvider = openAiCompatibleProvider({ name: 'custom', model: 'test-model', endpoint, apiKey: 'secret-test-key', timeoutMs: 1000 });
  await assert.rejects(() => timeoutProvider.generate({ modality: 'TEXT', prompt: 'timeout' }), (error) => error.code === PROVIDER_ERROR_CODES.TIMEOUT);

  // 轮询抖两下（524）也必须跑到终态：单次轮询失败是**瞬时**的，不是这条生成失败。
  // 反向自检在下面 —— 非瞬时错误（内容安全 / 格式错）仍然要立刻抛，不许被重试吃成"慢成功"。
  const flakyProvider = openAiCompatibleProvider({ name: 'custom', model: 'test-model', endpoint, apiKey: 'secret-test-key', pollIntervalMs: 10, timeoutMs: 5000 });
  const flaky = await flakyProvider.generate({ modality: 'VIDEO', prompt: 'flaky-poll', title: '抖动' });
  assert.equal(flaky.assets[0].assetUrl, 'https://media.example/video-flaky.mp4');
  assert.ok(flakyPolls >= 3, `轮询应该被重试到第 3 次才成功（实际 ${flakyPolls} 次）`);
  // 反向自检：内容安全（400）是**结论**不是抖动 —— 必须立刻抛，且第一次就抛。
  const rejectedBefore = requests.filter((row) => row.url === '/v1/videos/video-rejected').length;
  await assert.rejects(
    () => flakyProvider.generate({ modality: 'VIDEO', prompt: 'bad-poll', title: '被拒' }),
    (error) => normalizeProviderError(error).code === PROVIDER_ERROR_CODES.SAFETY_REJECTED,
  );
  assert.equal(requests.filter((row) => row.url === '/v1/videos/video-rejected').length - rejectedBefore, 1, '内容安全被拒只许查一次，不许重试');

  // 提交不确定（504 + X-Task-Id）：要**接着查那条任务**，不许判失败、更不许重发（重发=双扣）。
  // 上游文档原文：「错误响应可带 `X-Task-Id` 和 `Retry-After: 5`……保存该响应头的公共任务 ID 并查询」。
  const submitsBefore = requests.filter((row) => row.url === '/v1/videos' && row.method === 'POST').length;
  const recovered = await flakyProvider.generate({ modality: 'VIDEO', prompt: 'submit-uncertain', title: '不确定' });
  assert.equal(recovered.assets[0].assetUrl, 'https://media.example/recovered.mp4', '要用 X-Task-Id 查回产物');
  assert.equal(requests.filter((row) => row.url === '/v1/videos' && row.method === 'POST').length - submitsBefore, 1, '只许提交一次（不许重发）');
  assert.ok(requests.some((row) => row.url === '/v1/videos/video-recovered'), '要按 X-Task-Id 去查');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(JSON.stringify({ name: 'p6-a01-openai-compatible-adapter', pass: true, checks: 29 }));
