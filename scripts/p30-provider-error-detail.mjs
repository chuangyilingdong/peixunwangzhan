/**
 * P30 上游错误原因要透出来：只说「AI 供应商调用失败」，用户根本不知道该怎么改。
 * 例：真机碰到过上游返回 400 `prompt length must be between 5 and 5000 characters`
 * （学生只写了 4 个字），却被我们的通用文案盖掉了。
 */
import assert from 'node:assert/strict';

const { normalizeProviderError } = await import('../apps/server/src/services/providerContract.js');
const { openAiCompatibleProvider } = await import('../apps/server/src/services/openaiCompatibleProvider.js');

const failure = (message, extras = {}) => Object.assign(new Error(message), extras);

try {
  // 1) 适配器给的「上游原话」要保留
  const upstream = normalizeProviderError(failure('AI 供应商调用失败（上游：prompt length must be between 5 and 5000 characters）', { code: 'GENERATION_PROVIDER_HTTP_ERROR', status: 400 }));
  assert.ok(upstream.message.includes('prompt length must be between 5 and 5000 characters'), `应保留上游原因，实际：${upstream.message}`);
  assert.ok(upstream.message.startsWith('AI 供应商调用失败'), `应保留通用前缀，实际：${upstream.message}`);

  // 2) 5xx / 上游不可用同样带上原因
  const unavailable = normalizeProviderError(failure('AI 服务暂时不可用（上游：rate limit exceeded for this key）', { code: 'GENERATION_PROVIDER_HTTP_ERROR', status: 503 }));
  assert.ok(unavailable.message.includes('rate limit exceeded'), `应保留上游原因，实际：${unavailable.message}`);

  // 3) 我们自己拼的通用文案不要重复套一层
  const plain = normalizeProviderError(failure('AI 供应商调用失败', { code: 'GENERATION_PROVIDER_HTTP_ERROR', status: 400 }));
  assert.equal(plain.message, 'AI 供应商调用失败', `通用文案不应重复，实际：${plain.message}`);
  const plain503 = normalizeProviderError(failure('AI 服务暂时不可用', { code: 'GENERATION_PROVIDER_HTTP_ERROR', status: 502 }));
  assert.equal(plain503.message, 'AI 服务暂时不可用', `通用文案不应重复，实际：${plain503.message}`);

  // 4) 安全策略拦截仍然只给统一文案（不把上游的敏感判定原文抛给学生）
  const safety = normalizeProviderError(failure('内容未通过 AI 服务安全策略', { code: 'GENERATION_SAFETY_REJECTED', status: 400 }));
  assert.ok(String(safety.code).includes('SAFETY'), `安全策略应单独归类，实际 ${safety.code}`);
  assert.equal(safety.message, '内容未通过 AI 服务安全策略', `安全策略应给统一文案，实际 ${safety.message}`);

  // 5) 走一遍真实适配器的 HTTP 错误分支：上游 message 要出现在抛出的错误里
  const provider = openAiCompatibleProvider({
    name: 'stub', model: 'stub-model', endpoint: 'https://stub.invalid/v1', apiKey: 'k', requestTemplates: {},
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'invalid_parameter', message: 'prompt length must be between 5 and 5000 characters' }), { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    await provider.generate({ modality: 'IMAGE', prompt: '一只小猫', title: 't', options: {} });
    throw new Error('上游 400 时应当抛错');
  } catch (error) {
    if (error?.message === '上游 400 时应当抛错') throw error;
    assert.equal(error.status, 400, `应带 HTTP 状态，实际 ${error.status}`);
    assert.ok(String(error.message).includes('prompt length must be between 5 and 5000 characters'), `适配器应把上游原文带出来，实际：${error.message}`);
    const normalized = normalizeProviderError(error);
    assert.ok(normalized.message.includes('prompt length must be between 5 and 5000 characters'), `落库文案应保留上游原因，实际：${normalized.message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(JSON.stringify({
    name: 'provider-error-detail', pass: true,
    samples: { upstream: upstream.message, unavailable: unavailable.message, plain: plain.message },
  }, null, 2));
} catch (error) {
  console.error(error);
  throw error;
}
