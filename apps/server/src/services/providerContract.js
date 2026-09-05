import { errors } from '../lib.js';
const MOCK_PROVIDERS = new Set(['', 'mock', 'local-mock']);
const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const GENERATION_PROVIDER_CATALOG = Object.freeze([
  Object.freeze({ id: 'local-mock', label: '本地模拟（当前生产默认）', kind: 'MOCK', adapterAvailable: true, externalContentAllowed: false, endpointRequired: true, modelRequired: true }),
  Object.freeze({ id: 'openai-compatible', label: 'OpenAI-compatible 通用接口（六类能力）', kind: 'GENERIC', adapterAvailable: true, externalContentAllowed: true, endpointRequired: true, modelRequired: true }),
  Object.freeze({ id: 'aliyun-bailian', label: '阿里云百炼', kind: 'GENERIC', adapterAvailable: false, externalContentAllowed: true, endpointRequired: true, modelRequired: true }),
  Object.freeze({ id: 'volcengine', label: '火山引擎', kind: 'GENERIC', adapterAvailable: false, externalContentAllowed: true, endpointRequired: true, modelRequired: true }),
  Object.freeze({ id: 'zhipu', label: '智谱', kind: 'GENERIC', adapterAvailable: false, externalContentAllowed: true, endpointRequired: true, modelRequired: true }),
  Object.freeze({ id: 'custom', label: '自定义供应商（OpenAI-compatible 六类能力）', kind: 'CUSTOM', adapterAvailable: true, externalContentAllowed: true, endpointRequired: true, modelRequired: true }),
]);
export const GENERATION_PROVIDER_IDS = new Set(GENERATION_PROVIDER_CATALOG.map((item) => item.id));
export function providerDefinition(id) { return GENERATION_PROVIDER_CATALOG.find((item) => item.id === id) || null; }

export const PROVIDER_ERROR_CODES = Object.freeze({
  CONFIG_INVALID: 'GENERATION_PROVIDER_CONFIG_INVALID',
  UNAVAILABLE: 'GENERATION_PROVIDER_UNAVAILABLE',
  TIMEOUT: 'GENERATION_PROVIDER_TIMEOUT',
  RATE_LIMITED: 'GENERATION_PROVIDER_RATE_LIMITED',
  UPSTREAM: 'GENERATION_PROVIDER_UPSTREAM_ERROR',
  SAFETY_REJECTED: 'GENERATION_PROVIDER_SAFETY_REJECTED',
  RESPONSE_INVALID: 'GENERATION_PROVIDER_RESPONSE_INVALID',
  MODALITY_UNSUPPORTED: 'GENERATION_PROVIDER_MODALITY_UNSUPPORTED',
});

export function isMockProvider(name) {
  return MOCK_PROVIDERS.has(String(name || '').trim().toLowerCase());
}

export function validateProviderRegistration({ provider, model = '', endpoint = '' } = {}) {
  const name = String(provider || '').trim().toLowerCase();
  const result = { valid: true, provider: isMockProvider(name) ? 'local-mock' : name, model: String(model || '').trim(), endpoint: String(endpoint || '').trim(), reasons: [] };
  if (!GENERATION_PROVIDER_IDS.has(result.provider)) result.reasons.push('provider is not in the approved catalog');
  if (result.provider === 'local-mock') { result.valid = true; return result; }
  if (!result.model) result.reasons.push('model is required');
  if (!result.endpoint) result.reasons.push('endpoint is required');
  else { try { const url = new URL(result.endpoint); if (!['http:', 'https:'].includes(url.protocol)) result.reasons.push('endpoint must use http or https'); } catch { result.reasons.push('endpoint must be a valid URL'); } }
  result.valid = result.reasons.length === 0;
  return result;
}

export function validateProviderConfig({ provider, model, endpoint = '', apiKey = '', requireApiKey = true } = {}) {
  const name = String(provider || '').trim().toLowerCase();
  const result = { valid: true, provider: isMockProvider(name) ? 'local-mock' : name, model: String(model || '').trim(), endpoint: String(endpoint || '').trim(), reasons: [] };
  if (!name || isMockProvider(name)) return result;
  if (!PROVIDER_NAME.test(name)) result.reasons.push('provider name is invalid');
  if (!result.model) result.reasons.push('model is required');
  if (!result.endpoint) result.reasons.push('endpoint is required');
  else { try { const url = new URL(result.endpoint); if (!['http:', 'https:'].includes(url.protocol)) result.reasons.push('endpoint must use http or https'); } catch { result.reasons.push('endpoint must be a valid URL'); } }
  if (requireApiKey && !String(apiKey || '').trim()) result.reasons.push('server-side API key is required');
  result.valid = result.reasons.length === 0;
  return result;
}

export function normalizeProviderError(error, { status } = {}) {
  const code = String(error?.code || '').toUpperCase();
  const httpStatus = Number(status || error?.status || error?.response?.status || 0);
  if (code.includes('SAFETY') || code.includes('CONTENT') || httpStatus === 400 && /safety|moderation|policy/i.test(String(error?.message || ''))) return { code: PROVIDER_ERROR_CODES.SAFETY_REJECTED, retryable: false, message: '内容未通过 AI 服务安全策略' };
  if (code === 'ABORT_ERR' || code === 'ETIMEDOUT' || error?.name === 'AbortError' || /timeout/i.test(String(error?.message || ''))) return { code: PROVIDER_ERROR_CODES.TIMEOUT, retryable: true, message: 'AI 服务响应超时' };
  if (httpStatus === 429 || code.includes('RATE')) return { code: PROVIDER_ERROR_CODES.RATE_LIMITED, retryable: true, message: 'AI 服务请求频率受限' };
  if (httpStatus >= 500 || code.includes('UPSTREAM')) return { code: PROVIDER_ERROR_CODES.UPSTREAM, retryable: true, message: 'AI 服务暂时不可用' };
  if (code === PROVIDER_ERROR_CODES.CONFIG_INVALID) return { code, retryable: false, message: 'AI 供应商配置不完整' };
  if (code === PROVIDER_ERROR_CODES.RESPONSE_INVALID) return { code, retryable: false, message: 'AI 供应商响应格式无效' };
  if (code === PROVIDER_ERROR_CODES.MODALITY_UNSUPPORTED) return { code, retryable: false, message: '当前真实 AI 适配器暂不支持该素材类型' };
  return { code: PROVIDER_ERROR_CODES.UPSTREAM, retryable: false, message: 'AI 供应商调用失败' };
}

export function assertExternalAiAllowed({ mode, allowStudentExternalContent = false } = {}) {
  if (mode !== 'mock' && !allowStudentExternalContent) {
    throw errors.forbidden('学生项目生成内容不允许发送到外部 AI 服务。', 'STUDENT_EXTERNAL_AI_BLOCKED');
  }
}

export function assertProviderCapability(provider, modality) {
  const capabilities = Array.isArray(provider?.capabilities) ? provider.capabilities : [];
  if (!capabilities.includes(String(modality || '').toUpperCase())) {
    throw errors.badRequest('当前真实 AI 适配器暂不支持该素材类型。', PROVIDER_ERROR_CODES.MODALITY_UNSUPPORTED);
  }
}

export function unavailableProvider({ name, model, config } = {}) {
  return {
    name, model,
    capabilities: [],
    async generate() {
      const error = new Error(config?.reasons?.length ? '当前 AI 供应商配置不完整。' : '当前 AI 供应商适配器尚未安装。');
      error.code = config?.reasons?.length ? PROVIDER_ERROR_CODES.CONFIG_INVALID : PROVIDER_ERROR_CODES.UNAVAILABLE;
      throw error;
    },
  };
}
