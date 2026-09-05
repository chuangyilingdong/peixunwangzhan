import { AI_PROVIDER_TIMEOUT_MS } from '../config.js';
import { PROVIDER_ERROR_CODES } from './providerContract.js';

const MAX_TEXT_RESULT_CHARS = 50000;

function providerError(message, code, status = 0) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function chatCompletionsEndpoint(endpoint) {
  const value = String(endpoint || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(value)) return value;
  if (/\/v1$/i.test(value)) return `${value}/chat/completions`;
  return `${value}/v1/chat/completions`;
}

function textFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : String(part?.text || part?.content || '')))
    .join('')
    .trim();
}

function responseText(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  return textFromContent(choice?.message?.content ?? choice?.text ?? payload?.output_text);
}

function upstreamErrorCode(status, payload) {
  const detail = JSON.stringify(payload || '').slice(0, 2000);
  if (status === 400 && /safety|moderation|content.?policy|policy.?violation|拒绝|违规/i.test(detail)) {
    return PROVIDER_ERROR_CODES.SAFETY_REJECTED;
  }
  return null;
}

async function parseResponse(response) {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    if (response.ok) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID, response.status);
    return { error: { message: raw.slice(0, 500) } };
  }
}

export function openAiCompatibleProvider({ name, model, endpoint, apiKey, timeoutMs = AI_PROVIDER_TIMEOUT_MS } = {}) {
  const providerName = String(name || 'openai-compatible').trim();
  const providerModel = String(model || '').trim();
  const url = chatCompletionsEndpoint(endpoint);
  const timeout = Math.max(1000, Math.min(300000, Number(timeoutMs) || AI_PROVIDER_TIMEOUT_MS));

  return {
    name: providerName,
    model: providerModel,
    capabilities: ['TEXT'],
    async generate({ modality, prompt, title } = {}) {
      const normalizedModality = String(modality || 'TEXT').trim().toUpperCase();
      if (normalizedModality !== 'TEXT') {
        throw providerError('当前真实 AI 适配器暂不支持该素材类型。', PROVIDER_ERROR_CODES.MODALITY_UNSUPPORTED);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: providerModel,
            messages: [
              { role: 'system', content: '你是少儿编程学习平台的创作助手。请用适合儿童理解的方式回答，避免危险或不适龄内容。' },
              { role: 'user', content: String(prompt || '') },
            ],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw providerError('AI 服务响应超时', PROVIDER_ERROR_CODES.TIMEOUT);
        throw error;
      } finally {
        clearTimeout(timer);
      }

      const payload = await parseResponse(response);
      if (!response.ok) {
        const safetyCode = upstreamErrorCode(response.status, payload);
        throw providerError(
          safetyCode ? '内容未通过 AI 服务安全策略' : 'AI 供应商调用失败',
          safetyCode || 'GENERATION_PROVIDER_HTTP_ERROR',
          response.status,
        );
      }
      const text = responseText(payload);
      if (!text) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID, response.status);
      const boundedText = text.slice(0, MAX_TEXT_RESULT_CHARS);
      const label = String(title || 'AI 灵感提示词').trim().slice(0, 120) || 'AI 灵感提示词';
      return {
        assets: [{
          label,
          mimeType: 'text/plain; charset=utf-8',
          assetUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(boundedText)}`,
          metadata: { provider: providerName, model: providerModel, modality: 'TEXT', external: true, text: boundedText },
        }],
      };
    },
  };
}

export { chatCompletionsEndpoint, responseText };
