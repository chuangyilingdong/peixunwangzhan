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
  AUTH_FAILED: 'GENERATION_PROVIDER_AUTH_FAILED',
  UNAVAILABLE: 'GENERATION_PROVIDER_UNAVAILABLE',
  TIMEOUT: 'GENERATION_PROVIDER_TIMEOUT',
  RATE_LIMITED: 'GENERATION_PROVIDER_RATE_LIMITED',
  UPSTREAM: 'GENERATION_PROVIDER_UPSTREAM_ERROR',
  SAFETY_REJECTED: 'GENERATION_PROVIDER_SAFETY_REJECTED',
  RESPONSE_INVALID: 'GENERATION_PROVIDER_RESPONSE_INVALID',
  MODALITY_UNSUPPORTED: 'GENERATION_PROVIDER_MODALITY_UNSUPPORTED',
  ABORTED: 'GENERATION_PROVIDER_ABORTED',
  // 算力网关说「额度用尽」：这不是故障，是本学生在这节课的钱花完了，重试没有任何意义。
  QUOTA_EXHAUSTED: 'COMPUTE_QUOTA_EXHAUSTED',
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

// 保留上游/适配器给的具体原因：只说「AI 供应商调用失败」用户无从下手。
// 我们自己的通用文案不再重复套一层。
function providerDetail(error) {
  const raw = String(error?.message || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (/AI 供应商调用失败（上游：/.test(raw)) return raw.slice(0, 240);
  if (/^AI (供应商|服务)[^（]{0,20}$/.test(raw)) return '';
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

// 网络层失败的判据（2026-09-18 晚加）。
// undici 把真正的原因包在 `error.cause` 里，外层只是一句 `TypeError: fetch failed`；
// 所以只看 message 不够，要连 cause.code/message 一起拼起来判。
// ⚠️ 判据要**窄**：上游返回的错误、我们自己的超时/业务拦截都有自己的 code 或 HTTP 状态，
//    会先被上面那些分支接住，不该落到这里。
const NETWORK_FAILURE = /fetch failed|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|UND_ERR_|socket hang up|other side closed/i;
function isNetworkFailure(error) {
  return NETWORK_FAILURE.test(`${error?.message || ''} ${error?.cause?.code || ''} ${error?.cause?.message || ''}`);
}

export function normalizeProviderError(error, { status } = {}) {
  const code = String(error?.code || '').toUpperCase();
  const httpStatus = Number(status || error?.status || error?.response?.status || 0);
  const detail = providerDetail(error);
  // 适配器可能已经拼过同样的前缀（例如「AI 供应商调用失败（上游：…）」），别套第二层。
  const withDetail = (message) => {
    if (!detail) return message;
    if (detail.startsWith(message)) return detail;
    return `${message}（${detail}）`;
  };
  // 额度用尽必须排在「认证失败」前面判：网关（new-api）额度耗尽也是 402/403，
  // 但那不是 key 填错了，提示学生「让老师充算力」比提示管理员「重填 key」有用得多。
  // ⚠️ 这一条**不带上游原文**（withDetail）：原文是「请在管理后台重新填写并保存该渠道 API Key」，
  //    拼上去正好把最误导人的那句话又还给了学生（守卫 p59 ⑥ 专门钉这一条）。
  // ⚠️ 2026-09-18 文案修正：这里说的是**上游账号自己**的额度/余额用尽（网关或供应商返回 402/403），
  //    **不是**我们平台给学生设的额度 —— 平台侧的算力额度/上限一律**只观测、不拦人**
  //    （用户口径：「学生算力额度的设置都是不真拦，都是给我们内部看的」）。
  //    原来那句「本节课的算力额度已用尽，请联系老师为本节课增加额度」会让学生以为是我们的闸门到了，
  //    其实是上游账户没钱了 —— 学生帮不上忙，该找的是平台运营。
  if (code === PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED || httpStatus === 402
    || (httpStatus === 403 && /quota|额度|余额|balance|insufficient|用尽/i.test(String(error?.message || '')))) {
    return { code: PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED, retryable: false, message: 'AI 服务暂时不可用（上游账户额度或余额不足，平台会处理）。请稍后再试，或先做不需要 AI 的部分。' };
  }
  if (code === PROVIDER_ERROR_CODES.AUTH_FAILED || httpStatus === 401 || httpStatus === 403) return { code: PROVIDER_ERROR_CODES.AUTH_FAILED, retryable: false, message: withDetail(`AI渠道认证失败（HTTP ${httpStatus || 401}）。请在管理后台重新填写并保存该渠道 API Key。`) };
  if (code.includes('SAFETY') || code.includes('CONTENT') || httpStatus === 400 && /safety|moderation|policy/i.test(String(error?.message || ''))) return { code: PROVIDER_ERROR_CODES.SAFETY_REJECTED, retryable: false, message: '内容未通过 AI 服务安全策略' };
  if (code === 'ABORT_ERR' || code === 'ETIMEDOUT' || code === 'GENERATION_TIMEOUT' || code === PROVIDER_ERROR_CODES.TIMEOUT || error?.name === 'AbortError' || /timeout|超时/i.test(String(error?.message || ''))) return { code: PROVIDER_ERROR_CODES.TIMEOUT, retryable: true, message: 'AI 服务响应超时' };
  // 网络层失败（连接被拒/重置、TLS 握手失败、DNS 抖动…）。
  // ⚠️ 用户口径 2026-09-18 晚：「失败的文案调整下：服务器繁忙，请重试一下。因为我多按几次按钮，就可以生了。」
  //    这类失败**发生在上游受理之前**（生产实测：平均 **0.8 秒**、**没有 task_id**、没有输出生成，
  //    而上游受理的那种平均要 50 秒且都有 task_id）—— 所以重试是安全的，文案就直说"再点一次"，
  //    别把 undici 那句 `fetch failed` 甩给学生看（他看不懂，也不知道该怎么办）。
  //    ⚠️ 必须排在 TIMEOUT **之后**：我们自己的超时有明确的 code / AbortError，会先被上面那条接住。
  if (isNetworkFailure(error)) return { code: PROVIDER_ERROR_CODES.UPSTREAM, retryable: true, message: '服务器繁忙，请重试一下。' };
  if (httpStatus === 429 || code.includes('RATE')) return { code: PROVIDER_ERROR_CODES.RATE_LIMITED, retryable: true, message: withDetail('AI 服务请求频率受限') };
  if (httpStatus >= 500 || code.includes('UPSTREAM')) return { code: PROVIDER_ERROR_CODES.UPSTREAM, retryable: true, message: withDetail('AI 服务暂时不可用') };
  if (code === PROVIDER_ERROR_CODES.CONFIG_INVALID) return { code, retryable: false, message: 'AI 供应商配置不完整' };
  if (code === PROVIDER_ERROR_CODES.RESPONSE_INVALID) return { code, retryable: false, message: 'AI 供应商响应格式无效' };
  if (code === PROVIDER_ERROR_CODES.MODALITY_UNSUPPORTED) return { code, retryable: false, message: '当前真实 AI 适配器暂不支持该素材类型' };
  return { code: PROVIDER_ERROR_CODES.UPSTREAM, retryable: false, message: withDetail('AI 供应商调用失败') };
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
