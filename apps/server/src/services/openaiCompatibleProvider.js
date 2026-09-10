import { AI_PROVIDER_TIMEOUT_MS } from '../config.js';
import { PROVIDER_ERROR_CODES } from './providerContract.js';

const MAX_TEXT_RESULT_CHARS = 50000;
const MAX_ASSET_URL_CHARS = 20000000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MODALITY_PATHS = Object.freeze({
  TEXT: '/chat/completions',
  IMAGE: '/image/generations',
  MUSIC: '/music/generations',
  VIDEO: '/videos',
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

import { renderRequestTemplate, requestTemplateFor } from './modelCapabilities.js';

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
  if (/\/v1\/(?:chat\/completions|images\/generations|music\/generations|videos?(?:\/generations)?|podcasts?\/generations|audio\/(?:speech|dubbing))$/i.test(value)) {
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
  const urlKeys = ['asset_url', 'assetUrl', 'url', 'image_url', 'audio_url', 'video_url', 'download_url', 'output_url', 'result_url', 'file_url'];
  for (const key of urlKeys) {
    if (looksLikeUrl(node[key])) return { assetUrl: node[key], mimeType };
  }
  const base64Keys = ['b64_json', 'base64', 'base64_data', 'data_base64'];
  for (const key of base64Keys) {
    const assetUrl = base64DataUrl(node[key], mimeType);
    if (assetUrl) return { assetUrl, mimeType };
  }
  for (const key of ['data', 'output', 'result', 'file', 'artifact', 'media', 'content', 'metadata']) {
    const found = mediaCandidate(node[key], modality, mimeType);
    if (found) return found;
  }
  return null;
}

function pendingPayload(payload) {
  const status = String(payload?.data?.status || payload?.status || payload?.state || '').trim().toLowerCase();
  return Boolean((payload?.id || payload?.task_id || payload?.data?.task_id) && ['queued', 'pending', 'processing', 'running', 'in_progress', 'in-progress', 'not_start', 'submitted'].includes(status));
}

function failedPayload(payload) {
  const status = String(payload?.data?.status || payload?.status || payload?.state || '').trim().toLowerCase();
  return ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status);
}

function providerFailureMessage(payload) {
  return String(
    payload?.data?.fail_reason
      || payload?.data?.error?.message
      || payload?.error?.message
      || payload?.error
      || 'AI 供应商生成失败',
  ).slice(0, 500);
}

function pollUrlFromPayload(payload, requestUrl) {
  const explicit = payload?.poll_url || payload?.pollUrl || payload?.status_url || payload?.statusUrl || payload?.url;
  if (typeof explicit === 'string' && /^https?:\/\//i.test(explicit)) return explicit;
  const taskId = payload?.id || payload?.task_id || payload?.data?.task_id;
  if (!taskId) return '';
  return `${normalizeEndpoint(requestUrl)}/${encodeURIComponent(String(taskId))}`;
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

// 请求体由渠道模板生成：模板里的 {{aspectRatio}} / {{resolution}} / {{durationSeconds}} / {{audio}}
// 会被课时配置的取值替换，不再由代码写死。
function requestBody({ modality, model, prompt, title, voice = 'alloy', options = {}, requestTemplates = {}, messages = null, stream = false }) {
  const normalizedModality = String(modality || 'TEXT').trim().toUpperCase();
  // 按「这次真的带了哪些画面」选模板：只有首帧用 VIDEO_I2V，首帧+尾帧用 VIDEO_I2V_FRAMES。
  const firstFrameUrl = String(options.firstFrameUrl || '').trim();
  const lastFrameUrl = String(options.lastFrameUrl || '').trim();
  const template = requestTemplateFor({ requestTemplates }, normalizedModality, { requiresFirstFrame: Boolean(firstFrameUrl), withLastFrame: Boolean(lastFrameUrl) });
  if (template) {
    const rendered = renderRequestTemplate(template, {
      model,
      prompt: String(prompt || ''),
      title: String(title || ''),
      voice,
      aspectRatio: String(options.aspectRatio || '').trim(),
      resolution: String(options.resolution || '').trim(),
      durationSeconds: Number(options.durationSeconds) || 5,
      audio: options.audio === true,
      firstFrameUrl,
      lastFrameUrl,
      n: 1,
      messages: Array.isArray(messages) ? messages : undefined,
    });
    // 多轮对话：模板里没有显式写 {{messages}} 时，用完整历史替换模板自带的单轮 messages，
    // 这样管理员为 TEXT 配置的 system 提示词仍然生效。
    if (Array.isArray(messages) && messages.length && !JSON.stringify(template).includes('{{messages}}')) {
      if (Array.isArray(rendered?.messages)) rendered.messages = messages;
    }
    if (stream) rendered.stream = true;
    return rendered;
  }
  // 没有模板的模态（音乐/播客）保持改造前的请求体形状。
  return { model, prompt: String(prompt || ''), seconds: '5', metadata: { resolution: '480p' } };
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

// 上游的原始错误说明（例如「prompt length must be between 5 and 5000 characters」）比我们的
// 通用文案有用得多，透出去用户才知道该怎么改。
function upstreamMessage(payload) {
  const candidate = payload?.message
    || payload?.error?.message
    || payload?.data?.message
    || (typeof payload?.error === 'string' ? payload.error : '')
    || payload?.msg;
  return String(candidate || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function providerHttpError(response, payload) {
  const detail = JSON.stringify(payload || '').slice(0, 2000);
  const safety = response.status === 400 && /safety|moderation|content.?policy|policy.?violation|拒绝|违规/i.test(detail);
  const upstream = upstreamMessage(payload);
  const suffix = upstream ? `（上游：${upstream}）` : '';
  if (response.status === 401 || response.status === 403) {
    return providerError(`AI渠道认证失败（HTTP ${response.status}）。请在管理后台重新填写并保存该渠道 API Key。${suffix}`, PROVIDER_ERROR_CODES.AUTH_FAILED, response.status);
  }
  return providerError(safety ? '内容未通过 AI 服务安全策略' : `AI 供应商调用失败${suffix}`, safety ? PROVIDER_ERROR_CODES.SAFETY_REJECTED : 'GENERATION_PROVIDER_HTTP_ERROR', response.status);
}

function textAsset({ text, title, providerName, model }) {
  const boundedText = String(text || '').slice(0, MAX_TEXT_RESULT_CHARS);
  return {
    label: String(title || 'AI 灵感提示词').trim().slice(0, 120) || 'AI 灵感提示词',
    mimeType: 'text/plain; charset=utf-8',
    assetUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(boundedText)}`,
    metadata: { provider: providerName, model, modality: 'TEXT', external: true, text: boundedText },
  };
}

function assetFromResponse({ payload, binary, contentType, modality, title, providerName, model }) {
  const normalizedModality = String(modality || '').trim().toUpperCase();
  if (normalizedModality === 'TEXT') {
    const text = responseText(payload);
    if (!text) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
    return textAsset({ text, title, providerName, model });
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
  if (failedPayload(payload)) {
    throw providerError(providerFailureMessage(payload), PROVIDER_ERROR_CODES.UPSTREAM);
  }
  return assetFromResponse({ payload, modality, title, providerName, model });
}

export function openAiCompatibleProvider({ name, model, endpoint, apiKey, timeoutMs = AI_PROVIDER_TIMEOUT_MS, modalityEndpoints = {}, voice = 'alloy', pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, requestTemplates = {} } = {}) {
  const providerName = String(name || 'openai-compatible').trim();
  const providerModel = String(model || '').trim();
  const timeout = Math.max(1000, Math.min(300000, Number(timeoutMs) || AI_PROVIDER_TIMEOUT_MS));
  const pollInterval = Math.max(250, Math.min(10000, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS));

  return {
    name: providerName,
    model: providerModel,
    capabilities: ['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING'],
    async generate({ modality, prompt, title, options } = {}) {
      const normalizedModality = String(modality || 'TEXT').trim().toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_MODALITY_PATHS, normalizedModality)) {
        throw providerError('当前真实 AI 适配器暂不支持该素材类型。', PROVIDER_ERROR_CODES.MODALITY_UNSUPPORTED);
      }
      const url = modalityEndpoint(endpoint, normalizedModality, modalityEndpoints);
      const response = await fetchWithTimeout(url, {
        body: requestBody({ modality: normalizedModality, model: providerModel, prompt, title, voice, options, requestTemplates }),
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
    // 多轮对话流式生成：上游返回 text/event-stream 时逐块回调；上游不支持流式则退化为整段返回。
    // signal：调用方中断（学生点「停止」或连接断开）时中止上游请求；onReasoning：推理型模型
    // 的思考增量（reasoning_content），用于给学生显示「正在思考」的进度。
    async generateStream({ messages, prompt = '', title, options, onDelta, onReasoning, signal } = {}) {
      const url = modalityEndpoint(endpoint, 'TEXT', modalityEndpoints);
      const body = requestBody({ modality: 'TEXT', model: providerModel, prompt, title, voice, options, requestTemplates, messages, stream: true });
      const controller = new AbortController();
      let callerAborted = false;
      const abortFromCaller = () => { callerAborted = true; controller.abort(); };
      if (signal) {
        if (signal.aborted) abortFromCaller();
        else signal.addEventListener('abort', abortFromCaller, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();
      try {
        let response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { accept: 'text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          if (error?.name === 'AbortError') {
            if (callerAborted) throw providerError('已停止生成', PROVIDER_ERROR_CODES.ABORTED);
            throw providerError('AI 服务响应超时', PROVIDER_ERROR_CODES.TIMEOUT);
          }
          throw error;
        }
        const contentType = String(response.headers.get('content-type') || '');
        if (!response.ok) {
          const parsed = await parseResponse(response, 'TEXT').catch(() => ({}));
          throw providerHttpError(response, parsed);
        }
        if (!/text\/event-stream/i.test(contentType) || !response.body) {
          const parsed = await parseResponse(response, 'TEXT');
          const text = responseText(parsed);
          if (!text) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
          if (typeof onDelta === 'function') onDelta(text, text);
          return { assets: [textAsset({ text, title, providerName, model: providerModel })], streamed: false };
        }
        let full = '';
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
            if (!data || data === '[DONE]') continue;
            let chunk;
            try { chunk = JSON.parse(data); } catch { continue; }
            const choice = chunk?.choices?.[0];
            const reasoning = choice?.delta?.reasoning_content ?? '';
            if (reasoning && typeof onReasoning === 'function') onReasoning(reasoning);
            const delta = choice?.delta?.content ?? choice?.message?.content ?? chunk?.output_text ?? '';
            if (!delta) continue;
            full += delta;
            if (typeof onDelta === 'function') onDelta(delta, full);
          }
        }
        if (!full.trim()) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
        return { assets: [textAsset({ text: full, title, providerName, model: providerModel })], streamed: true };
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

export { chatCompletionsEndpoint, modalityEndpoint, responseText };
