import { AI_PROVIDER_TIMEOUT_MS } from '../config.js';
import { PROVIDER_ERROR_CODES } from './providerContract.js';

const MAX_TEXT_RESULT_CHARS = 50000;
const MAX_ASSET_URL_CHARS = 20000000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MODALITY_PATHS = Object.freeze({
  TEXT: '/chat/completions',
  IMAGE: '/images/generations',
  MUSIC: '/music/generations',
  VIDEO: '/videos/generations',
  PODCAST: '/podcasts/generations',
  DUBBING: '/audio/speech',
});
const DEFAULT_MIME_TYPES = Object.freeze({
  TEXT: 'text/plain; charset=utf-8',
  IMAGE: 'image/png',
  MUSIC: 'audio/mpeg',
  VIDEO: 'video/mp4',
  PODCAST: 'audio/mpeg',
  DUBBING: 'audio/mpeg',
});

function providerError(message, code, status = 0) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function chatCompletionsEndpoint(endpoint) {
  const value = normalizeEndpoint(endpoint);
  if (/\/chat\/completions$/i.test(value)) return value;
  if (/\/v1$/i.test(value)) return `${value}/chat/completions`;
  return `${value}/v1/chat/completions`;
}

function modalityEndpoint(endpoint, modality, modalityEndpoints = {}) {
  const normalizedModality = String(modality || 'TEXT').trim().toUpperCase();
  const configured = modalityEndpoints?.[normalizedModality] || modalityEndpoints?.[normalizedModality.toLowerCase()];
  if (configured) return normalizeEndpoint(configured);
  if (normalizedModality === 'TEXT') return chatCompletionsEndpoint(endpoint);
  const value = normalizeEndpoint(endpoint);
  const path = DEFAULT_MODALITY_PATHS[normalizedModality];
  if (!path) return value;
  if (/\/v1\/(?:chat\/completions|images\/generations|music\/generations|videos?\/generations|podcasts?\/generations|audio\/(?:speech|dubbing))$/i.test(value)) {
    return value.replace(/\/v1\/.*$/i, `/v1${path}`);
  }
  if (/\/v1$/i.test(value)) return `${value}${path}`;
  return `${value}/v1${path}`;
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

function defaultMimeType(modality) {
  return DEFAULT_MIME_TYPES[String(modality || '').trim().toUpperCase()] || 'application/octet-stream';
}

function isDataUrl(value) {
  return typeof value === 'string' && /^data:[^,]+,/.test(value);
}

function looksLikeUrl(value) {
  return typeof value === 'string' && (/^https?:\/\//i.test(value) || isDataUrl(value));
}

function base64DataUrl(value, mimeType) {
  if (isDataUrl(value)) return value;
  const base64 = String(value || '').trim();
  if (!base64 || !/^[a-z0-9+/=\r\n]+$/i.test(base64)) return '';
  return `data:${mimeType};base64,${base64.replace(/\s+/g, '')}`;
}

function mediaCandidate(node, modality, inheritedMime = '') {
  if (node == null) return null;
  const mimeType = String(node?.mime_type || node?.mimeType || node?.content_type || inheritedMime || defaultMimeType(modality));
  if (typeof node === 'string') {
    if (looksLikeUrl(node)) return { assetUrl: node, mimeType };
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = mediaCandidate(item, modality, mimeType);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const urlKeys = ['asset_url', 'assetUrl', 'url', 'image_url', 'audio_url', 'video_url', 'download_url', 'output_url', 'file_url'];
  for (const key of urlKeys) {
    if (looksLikeUrl(node[key])) return { assetUrl: node[key], mimeType };
  }
  const base64Keys = ['b64_json', 'base64', 'base64_data', 'data_base64'];
  for (const key of base64Keys) {
    const assetUrl = base64DataUrl(node[key], mimeType);
    if (assetUrl) return { assetUrl, mimeType };
  }
  for (const key of ['data', 'output', 'result', 'file', 'artifact', 'media', 'content']) {
    const found = mediaCandidate(node[key], modality, mimeType);
    if (found) return found;
  }
  return null;
}

function pendingPayload(payload) {
  const status = String(payload?.status || payload?.state || payload?.data?.status || '').toLowerCase();
  return Boolean(payload?.id && ['queued', 'pending', 'processing', 'running', 'in_progress', 'in-progress'].includes(status));
}

function pollUrlFromPayload(payload, requestUrl) {
  const explicit = payload?.poll_url || payload?.pollUrl || payload?.status_url || payload?.statusUrl || payload?.url;
  if (typeof explicit === 'string' && /^https?:\/\//i.test(explicit)) return explicit;
  if (!payload?.id) return '';
  return `${normalizeEndpoint(requestUrl)}/${encodeURIComponent(String(payload.id))}`;
}

function responseContentType(response, modality) {
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim();
  return type || defaultMimeType(modality).split(';')[0];
}

function isBinaryContentType(contentType) {
  return /^(image|audio|video)\//i.test(contentType) || /application\/(?:octet-stream|mp4|mpeg|wav|png|jpeg)/i.test(contentType);
}

async function parseResponse(response, modality) {
  const contentType = responseContentType(response, modality);
  if (isBinaryContentType(contentType)) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) return { contentType, binary: null };
    return { contentType, binary: bytes };
  }
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    if (response.ok) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID, response.status);
    return { error: { message: raw.slice(0, 500) } };
  }
}

function requestBody({ modality, model, prompt, title, voice = 'alloy' }) {
  const normalizedModality = String(modality || 'TEXT').trim().toUpperCase();
  if (normalizedModality === 'TEXT') {
    return {
      model,
      messages: [
        { role: 'system', content: '你是少儿编程学习平台的创作助手。请用适合儿童理解的方式回答，避免危险或不适龄内容。' },
        { role: 'user', content: String(prompt || '') },
      ],
    };
  }
  if (normalizedModality === 'IMAGE') return { model, prompt: String(prompt || ''), n: 1, response_format: 'url' };
  if (normalizedModality === 'DUBBING') return { model, input: String(prompt || ''), voice, response_format: 'mp3' };
  return { model, prompt: String(prompt || ''), title: String(title || '').slice(0, 120), modality: normalizedModality, response_format: 'url' };
}

async function fetchWithTimeout(url, { method = 'POST', body, apiKey, timeout, modality } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  try {
    return await fetch(url, {
      method,
      headers: {
        accept: 'application/json, image/*, audio/*, video/*',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw providerError('AI 服务响应超时', PROVIDER_ERROR_CODES.TIMEOUT);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function providerHttpError(response, payload) {
  const detail = JSON.stringify(payload || '').slice(0, 2000);
  const safety = response.status === 400 && /safety|moderation|content.?policy|policy.?violation|拒绝|违规/i.test(detail);
  return providerError(safety ? '内容未通过 AI 服务安全策略' : 'AI 供应商调用失败', safety ? PROVIDER_ERROR_CODES.SAFETY_REJECTED : 'GENERATION_PROVIDER_HTTP_ERROR', response.status);
}

function assetFromResponse({ payload, binary, contentType, modality, title, providerName, model }) {
  const normalizedModality = String(modality || '').trim().toUpperCase();
  if (normalizedModality === 'TEXT') {
    const text = responseText(payload);
    if (!text) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
    const boundedText = text.slice(0, MAX_TEXT_RESULT_CHARS);
    return {
      label: String(title || 'AI 灵感提示词').trim().slice(0, 120) || 'AI 灵感提示词',
      mimeType: 'text/plain; charset=utf-8',
      assetUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(boundedText)}`,
      metadata: { provider: providerName, model, modality: normalizedModality, external: true, text: boundedText },
    };
  }
  const mimeType = String(contentType || defaultMimeType(normalizedModality)).split(';')[0] || defaultMimeType(normalizedModality);
  let candidate = binary?.length ? { assetUrl: `data:${mimeType};base64,${binary.toString('base64')}`, mimeType } : mediaCandidate(payload, normalizedModality, mimeType);
  if (!candidate?.assetUrl || candidate.assetUrl.length > MAX_ASSET_URL_CHARS) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
  const labelDefaults = { IMAGE: 'AI 画面素材', MUSIC: 'AI 音乐素材', VIDEO: 'AI 故事短片', PODCAST: 'AI 播客素材', DUBBING: 'AI 配音素材' };
  return {
    label: String(title || labelDefaults[normalizedModality] || 'AI 素材').trim().slice(0, 120) || 'AI 素材',
    mimeType: candidate.mimeType || mimeType,
    assetUrl: candidate.assetUrl,
    previewUrl: /^image\//i.test(candidate.mimeType || mimeType) ? candidate.assetUrl : null,
    metadata: { provider: providerName, model, modality: normalizedModality, external: true },
  };
}

async function pollForAsset({ initialPayload, requestUrl, modality, apiKey, timeout, pollIntervalMs, title, providerName, model }) {
  let payload = initialPayload;
  const deadline = Date.now() + timeout;
  while (pendingPayload(payload)) {
    const pollUrl = pollUrlFromPayload(payload, requestUrl);
    if (!pollUrl) break;
    const wait = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (wait <= 0) throw providerError('AI 服务响应超时', PROVIDER_ERROR_CODES.TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetchWithTimeout(pollUrl, { method: 'GET', apiKey, timeout: Math.max(1000, Math.min(30000, deadline - Date.now())), modality });
    const next = await parseResponse(response, modality);
    if (!response.ok) throw providerHttpError(response, next);
    payload = next;
  }
  return assetFromResponse({ payload, modality, title, providerName, model });
}

export function openAiCompatibleProvider({ name, model, endpoint, apiKey, timeoutMs = AI_PROVIDER_TIMEOUT_MS, modalityEndpoints = {}, voice = 'alloy', pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const providerName = String(name || 'openai-compatible').trim();
  const providerModel = String(model || '').trim();
  const timeout = Math.max(1000, Math.min(300000, Number(timeoutMs) || AI_PROVIDER_TIMEOUT_MS));
  const pollInterval = Math.max(250, Math.min(10000, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS));

  return {
    name: providerName,
    model: providerModel,
    capabilities: ['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING'],
    async generate({ modality, prompt, title } = {}) {
      const normalizedModality = String(modality || 'TEXT').trim().toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_MODALITY_PATHS, normalizedModality)) {
        throw providerError('当前真实 AI 适配器暂不支持该素材类型。', PROVIDER_ERROR_CODES.MODALITY_UNSUPPORTED);
      }
      const url = modalityEndpoint(endpoint, normalizedModality, modalityEndpoints);
      const response = await fetchWithTimeout(url, {
        body: requestBody({ modality: normalizedModality, model: providerModel, prompt, title, voice }),
        apiKey,
        timeout,
        modality: normalizedModality,
      });
      const parsed = await parseResponse(response, normalizedModality);
      if (!response.ok) throw providerHttpError(response, parsed);
      if (normalizedModality !== 'TEXT' && !parsed?.binary && pendingPayload(parsed)) {
        return { assets: [await pollForAsset({ initialPayload: parsed, requestUrl: url, modality: normalizedModality, apiKey, timeout, pollIntervalMs: pollInterval, title, providerName, model: providerModel })] };
      }
      return { assets: [assetFromResponse({ payload: parsed, binary: parsed?.binary, contentType: parsed?.contentType, modality: normalizedModality, title, providerName, model: providerModel })] };
    },
  };
}

export { chatCompletionsEndpoint, modalityEndpoint, responseText };
