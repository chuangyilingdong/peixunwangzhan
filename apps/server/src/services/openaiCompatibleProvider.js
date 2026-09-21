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
});
const DEFAULT_MIME_TYPES = Object.freeze({
  TEXT: 'text/plain; charset=utf-8',
  IMAGE: 'image/png',
  MUSIC: 'audio/mpeg',
  VIDEO: 'video/mp4',
});

import { musicRequestContext, renderRequestTemplate, requestTemplateFor } from './modelCapabilities.js';
import { isCnyCurrency } from './upstreamCost.js';
import { mirrorSelfHostedMedia } from './upstreamMediaMirror.js';

// 素材暂存接口：只有这家上游（境外中继）有，路径是它文档里的 `POST /v1/files/upload`。
// 换别家上游、或它哪天改了路径 → 在渠道/工厂参数里给 `mediaUploadPath` 覆盖；给空串＝关掉镜像。
// ⚠️ 后端**不认** new-api 那套网关（网关没有这个接口），所以走网关的分支不传 selfOrigins，
//    镜像自然不会启动（见 services/generationProvider.js）。
const MEDIA_UPLOAD_PATHS = Object.freeze({
  'api.seedance.nz': '/v1/files/upload',
});

function defaultMediaUploadPath(endpoint) {
  try { return MEDIA_UPLOAD_PATHS[new URL(normalizeEndpoint(endpoint)).hostname.toLowerCase()] || ''; } catch { return ''; }
}

function providerError(message, code, status = 0) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  error.safeToRetry = [401, 404, 429].includes(status);
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

// 有些上游不走 /v1 的固定路径（例如 MiniMax V2 是 /v2/video_generation），
// 允许渠道按模态配完整请求路径；配了就用它（相对路径拼到 host，完整 URL 直接用）。
function absoluteEndpoint(base, path) {
  const value = String(path || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return normalizeEndpoint(value);
  const normalizedBase = normalizeEndpoint(base);
  let origin = normalizedBase;
  try { origin = new URL(normalizedBase).origin; } catch { /* 不是完整 URL 就按原样拼 */ }
  return `${origin}${value.startsWith('/') ? value : `/${value}`}`;
}

function modalityEndpoint(endpoint, modality, modalityEndpoints = {}, requestPaths = {}) {
  const normalizedModality = String(modality || 'TEXT').trim().toUpperCase();
  const customPath = absoluteEndpoint(endpoint, requestPaths?.[normalizedModality] || requestPaths?.[normalizedModality.toLowerCase()]);
  if (customPath) return customPath;
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

/**
 * 上游返回的 token 用量（C3 前置：先把用量采集下来，计费口径**不变**）。
 * 各家字段名不一：OpenAI 新老两套都叫 prompt_tokens/completion_tokens，
 * 也有叫 input_tokens/output_tokens 的（Anthropic 风格、部分网关）。读不到就返回 null。
 */
// 上游实扣金额的信封不止一种，按协议逐个认（顺序只为稳定，不表示优先级）：
//   · usage.cost.{amount,currency} —— 网关风格：网关把实扣放进 usage.cost
//   · usage.{amount,currency}      —— Seedance 直连：/v1/videos、/v1/midjourney/tasks 的顶层 usage
//   · data.usage.{amount,currency} —— Seedance 通用图/视频/音频/3D 与音乐任务查询
//   · task.usage.{amount,currency} —— Seedance MiniMax-H3（/v2/query/video_generation）
// 认不出来一律 null（绝不猜、绝不按 0）。各上游都保证 amount 是「本次实际扣减」。
const COST_ENVELOPES = [
  (payload) => payload?.usage,
  (payload) => payload?.data?.usage,
  (payload) => payload?.task?.usage,
];

function amountNode(value) {
  if (!value || typeof value !== 'object') return null;
  const node = value.cost && typeof value.cost === 'object' ? value.cost : value;
  return typeof node.amount === 'number' ? node : null;
}

// Only an explicit amount + CNY currency is usable without guessing units or FX.
// ⚠️ 币种写法逐字比对是不行的：文档示例写 `CNY`，但**实测同一接口回的是 `¥`**
// （`data.usage = {amount: 0.040112, currency: "¥"}`）。所以走 isCnyCurrency 别名表：
// CNY / RMB / ¥ / CN¥ 都算人民币；USD / $ / JPY 一律不认（跨币种不并账，
// 硬收敛成 CNY 会把真实毛利算错），这类调用留在 COMPUTED / UNKNOWN 由账单侧单独核销。
export function reportedCost(payload) {
  for (const envelope of COST_ENVELOPES) {
    const cost = amountNode(envelope(payload));
    if (!cost || !isCnyCurrency(cost.currency) || !Number.isFinite(cost.amount) || cost.amount < 0) continue;
    // 上游金额是小数的元，精度可能到 1e-6（实测 ¥0.040112）：×100 后必须四舍五入成整数分，
    // 否则 20.40 这种会落成 2039.9999999999998，0.040112 会落成 4.0112。
    return {
      source: 'REPORTED', currency: 'CNY', amount: cost.amount, fen: Math.round(cost.amount * 100),
      // 上游原样回传的币种写法，作为证据留进 cost_rule_snapshot（见 reportedCostRuleSnapshot）。
      upstreamCurrency: String(cost.currency).trim(),
    };
  }
  return null;
}

function tokenUsage(payload) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = Number(usage[key]);
      if (Number.isFinite(value) && value >= 0) return Math.round(value);
    }
    return null;
  };
  const input = pick('prompt_tokens', 'input_tokens');
  const output = pick('completion_tokens', 'output_tokens');
  if (input === null && output === null) return null;
  return { inputTokens: input || 0, outputTokens: output || 0, totalTokens: pick('total_tokens') ?? (input || 0) + (output || 0) };
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
  for (const key of ['data', 'output', 'result', 'file', 'artifact', 'media', 'content', 'metadata', 'task', 'tasks', 'outputs']) {
    const found = mediaCandidate(node[key], modality, mimeType);
    if (found) return found;
  }
  return null;
}

// 异步任务判定：只要有任务 id 且不是终态就算「还在跑」。
// 注意 MiniMax V2 的提交响应只有 {task_id}，不带 status，所以不能只认状态白名单。
// MiniMax V2 把状态与结果都包在 task 里（{ task: { status, content: { url } } }），
// 这里统一往下取一层。
function taskNode(payload) {
  return payload?.task && typeof payload.task === 'object' ? payload.task : null;
}
function payloadStatus(payload) {
  return String(taskNode(payload)?.status || payload?.data?.status || payload?.status || payload?.state || '').trim().toLowerCase();
}
function payloadTaskId(payload) {
  const inner = taskNode(payload);
  return payload?.id || payload?.task_id || payload?.data?.task_id || inner?.id || inner?.task_id || '';
}
function pendingPayload(payload) {
  const status = payloadStatus(payload);
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'succeeded', 'success', 'completed', 'done', 'finished'].includes(status)) return false;
  return Boolean(payloadTaskId(payload));
}

function failedPayload(payload) {
  return ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(payloadStatus(payload));
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

function pollUrlFromPayload(payload, requestUrl, pollPath = '') {
  const explicit = payload?.poll_url || payload?.pollUrl || payload?.status_url || payload?.statusUrl || payload?.url;
  if (typeof explicit === 'string' && /^https?:\/\//i.test(explicit)) return explicit;
  const taskId = payloadTaskId(payload);
  if (!taskId) return '';
  // 渠道配了查询路径模板（如 /v2/query/video_generation/{id}）就按它拼。
  if (pollPath) return absoluteEndpoint(requestUrl, pollPath).replace(/\{(?:id|task_id)\}/g, encodeURIComponent(String(taskId)));
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
    const parsed = bytes.length ? { contentType, binary: bytes } : { contentType, binary: null };
    response.__reportEvidence?.(parsed);
    return parsed;
  }
  const raw = await response.text();
  if (!raw) { response.__reportEvidence?.({}); return {}; }
  try {
    const parsed = JSON.parse(raw);
    response.__reportEvidence?.(parsed);
    return parsed;
  } catch {
    if (response.ok) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID, response.status);
    return { error: { message: raw.slice(0, 500) } };
  }
}

// 请求体由渠道模板生成：模板里的 {{aspectRatio}} / {{resolution}} / {{durationSeconds}} / {{audio}}
// 会被课时配置的取值替换，不再由代码写死。
function requestBody({ modality, model, prompt, title, voice = 'alloy', options = {}, referenceAssets = [], requestTemplates = {}, modelRequestTemplates = {}, messages = null, stream = false, tools = null, toolChoice = null }) {
  const normalizedModality = String(modality || 'TEXT').trim().toUpperCase();
  // 按「这次真的带了哪些画面」选模板：只有首帧用 VIDEO_I2V，首帧+尾帧用 VIDEO_I2V_FRAMES，
  // **只带参考素材（全能参考）用 VIDEO_OMNI** —— 那条模板才带 `{{referenceItems}}`，
  // 选错模板参考会在渲染时被整个丢掉（2026-09-21 修的「连了参考、出来完全不一样」）。
  const firstFrameUrl = String(options.firstFrameUrl || '').trim();
  const lastFrameUrl = String(options.lastFrameUrl || '').trim();
  const musicContext = musicRequestContext({ prompt, mode: options.mode, lyrics: options.lyrics, defaultStyle: options.defaultStyle });
  const template = requestTemplateFor({ requestTemplates, modelRequestTemplates }, normalizedModality, { model, requiresFirstFrame: Boolean(firstFrameUrl), withLastFrame: Boolean(lastFrameUrl), withReferences: Array.isArray(referenceAssets) && referenceAssets.length > 0 });
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
      // 音乐：歌词模式用学生的输入当歌词；描述模式用平台代写的词，学生的输入当曲风。
      lyrics: musicContext.lyrics,
      style: musicContext.style,
      // 全能参考（连过来的图片/视频/音频）：模板里的 {{referenceItems}} 靠它展开。
      // ⚠️ 这一项以前**没有传**，于是模板写不写 {{referenceItems}} 都会渲染成空数组 ——
      // 学生连了参考图、模板里也有占位符，请求体里却一张图都没有（2026-09-11 实测复现并修掉）。
      referenceAssets: Array.isArray(referenceAssets) ? referenceAssets : [],
      n: 1,
      messages: Array.isArray(messages) ? messages : undefined,
    });
    // 多轮对话：模板里没有显式写 {{messages}} 时，用完整历史替换模板自带的单轮 messages，
    // 这样管理员为 TEXT 配置的 system 提示词仍然生效。
    if (Array.isArray(messages) && messages.length && !JSON.stringify(template).includes('{{messages}}')) {
      if (Array.isArray(rendered?.messages)) rendered.messages = messages;
    }
    if (stream) rendered.stream = true;
    // 工具调用（2026-09-16 打通）：渠道模板的合法占位符里**没有** tools，不能靠模板渲染，
    // 只能在渲染**之后**挂上去。不挂的后果不是「少个功能」，而是模型把工具调用写进正文
    // （DSML 标记），学生看到的是「AI 说一句就停」。
    if (Array.isArray(tools) && tools.length) {
      rendered.tools = tools;
      if (toolChoice) rendered.tool_choice = toolChoice;
    }
    return rendered;
  }
  // 没有模板的模态（音乐/播客）保持改造前的请求体形状。
  return { model, prompt: String(prompt || ''), seconds: '5', metadata: { resolution: '480p' } };
}

function evidenceId(value) {
  if (value === undefined || value === null || typeof value === 'object') return '';
  const text = String(value).trim();
  return text && !/[\r\n\0]/.test(text) ? text.slice(0, 255) : '';
}

function responseEvidence(response, payload) {
  const header = (...names) => names.map((name) => evidenceId(response?.headers?.get(name))).find(Boolean) || '';
  return {
    responseRequestId: header('x-request-id', 'request-id'),
    responsePayloadId: evidenceId(payload?.id),
    usageId: evidenceId(payload?.usage?.id),
    gatewayLogId: header('x-oneapi-request-id', 'x-one-api-request-id', 'x-gateway-log-id'),
    actualChannelId: header('x-oneapi-channel-id', 'x-one-api-channel-id', 'x-channel-id'),
  };
}

function reportEvidence(callback, response, payload) {
  if (typeof callback !== 'function') return;
  const evidence = responseEvidence(response, payload);
  if (Object.values(evidence).some(Boolean)) callback(evidence);
}

async function fetchWithTimeout(url, { method = 'POST', body, apiKey, timeout, modality, clientRequestId, onEvidence } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json, image/*, audio/*, video/*',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(clientRequestId ? { 'x-client-request-id': clientRequestId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    response.__reportEvidence = (payload) => reportEvidence(onEvidence, response, payload);
    return response;
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

function textAsset({ text, title, providerName, model, tokens = null, cost = null }) {
  const boundedText = String(text || '').slice(0, MAX_TEXT_RESULT_CHARS);
  return {
    label: String(title || 'AI 灵感提示词').trim().slice(0, 120) || 'AI 灵感提示词',
    mimeType: 'text/plain; charset=utf-8',
    assetUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(boundedText)}`,
    metadata: { provider: providerName, model, modality: 'TEXT', external: true, text: boundedText, reportedCost: cost, ...(tokens ? { tokens } : {}) },
  };
}

function assetFromResponse({ payload, binary, contentType, modality, title, providerName, model }) {
  const normalizedModality = String(modality || '').trim().toUpperCase();
  if (normalizedModality === 'TEXT') {
    const text = responseText(payload);
    if (!text) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
    return textAsset({ text, title, providerName, model, tokens: tokenUsage(payload), cost: reportedCost(payload) });
  }
  const mimeType = String(contentType || defaultMimeType(normalizedModality)).split(';')[0] || defaultMimeType(normalizedModality);
  let candidate = binary?.length ? { assetUrl: `data:${mimeType};base64,${binary.toString('base64')}`, mimeType } : mediaCandidate(payload, normalizedModality, mimeType);
  if (!candidate?.assetUrl || candidate.assetUrl.length > MAX_ASSET_URL_CHARS) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
  const labelDefaults = { IMAGE: 'AI 画面素材', MUSIC: 'AI 音乐素材', VIDEO: 'AI 故事短片' };
  return {
    label: String(title || labelDefaults[normalizedModality] || 'AI 素材').trim().slice(0, 120) || 'AI 素材',
    mimeType: candidate.mimeType || mimeType,
    assetUrl: candidate.assetUrl,
    previewUrl: /^image\//i.test(candidate.mimeType || mimeType) ? candidate.assetUrl : null,
    metadata: { provider: providerName, model, modality: normalizedModality, external: true, reportedCost: reportedCost(payload) },
  };
}

async function pollForAsset({ initialPayload, requestUrl, modality, apiKey, timeout, pollIntervalMs, title, providerName, model, pollPath = '', clientRequestId, onEvidence }) {
  let payload = initialPayload;
  const deadline = Date.now() + timeout;
  while (pendingPayload(payload) && !mediaCandidate(payload, modality)) {
    const pollUrl = pollUrlFromPayload(payload, requestUrl, pollPath);
    if (!pollUrl) break;
    const wait = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (wait <= 0) throw providerError('AI 服务响应超时', PROVIDER_ERROR_CODES.TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetchWithTimeout(pollUrl, { method: 'GET', apiKey, timeout: Math.max(1000, Math.min(30000, deadline - Date.now())), modality, clientRequestId, onEvidence });
    const next = await parseResponse(response, modality);
    if (!response.ok) throw providerHttpError(response, next);
    payload = next;
  }
  if (failedPayload(payload)) {
    throw providerError(providerFailureMessage(payload), PROVIDER_ERROR_CODES.UPSTREAM);
  }
  return assetFromResponse({ payload, modality, title, providerName, model });
}

export function openAiCompatibleProvider({ name, model, endpoint, apiKey, timeoutMs = AI_PROVIDER_TIMEOUT_MS, modalityEndpoints = {}, voice = 'alloy', pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, requestTemplates = {}, modelRequestTemplates = {}, requestPaths = {}, pollPaths = {}, mediaUploadPath = defaultMediaUploadPath(endpoint), selfOrigins = [] } = {}) {
  const providerName = String(name || 'openai-compatible').trim();
  const providerModel = String(model || '').trim();
  const timeout = Math.max(1000, Math.min(300000, Number(timeoutMs) || AI_PROVIDER_TIMEOUT_MS));
  const pollInterval = Math.max(250, Math.min(10000, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS));
  // 素材镜像地址：`/v1/files/upload` 这类路径按上游 origin 拼绝对地址。
  const mediaUploadUrl = mediaUploadPath ? absoluteEndpoint(endpoint, mediaUploadPath) : '';
  const selfMediaOrigins = Array.isArray(selfOrigins) ? selfOrigins.filter(Boolean) : [];

  return {
    name: providerName,
    model: providerModel,
    capabilities: ['TEXT', 'IMAGE', 'MUSIC', 'VIDEO'],
    // ⚠️ `options = {}` 这个默认值不能省：下面要读 `options.referenceAssets`，
    // 而**不是每个调用方都传 options**（作词那一步就没传）→ 少了它就是
    // 「TypeError: Cannot read properties of undefined (reading 'referenceAssets')」，
    // 表现为「平台作词失败」→ 描述模式生音乐整条链路直接崩（2026-09-11 引入、09-12 守卫照出来）。
    async generate({ modality, prompt, title, options = {}, messages, onSubmitted, clientRequestId, onEvidence } = {}) {
      const normalizedModality = String(modality || 'TEXT').trim().toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_MODALITY_PATHS, normalizedModality)) {
        throw providerError('当前真实 AI 适配器暂不支持该素材类型。', PROVIDER_ERROR_CODES.MODALITY_UNSUPPORTED);
      }
      const url = modalityEndpoint(endpoint, normalizedModality, modalityEndpoints, requestPaths);
      // 上游在境外、抓不到我们域名上的素材 → 首帧/尾帧/参考图先传到上游，
      // 用上游自己的 URL 发（不然上游静默当文生跑，出来的画面与参考毫无关系）。
      const effectiveOptions = await mirrorSelfHostedMedia(options, {
        selfOrigins: selfMediaOrigins, uploadUrl: mediaUploadUrl, apiKey, timeoutMs: timeout,
      });
      const response = await fetchWithTimeout(url, {
        body: requestBody({ modality: normalizedModality, model: providerModel, prompt, title, voice, options: effectiveOptions, referenceAssets: effectiveOptions.referenceAssets, requestTemplates, modelRequestTemplates, messages }),
        apiKey,
        timeout,
        modality: normalizedModality,
        clientRequestId,
        onEvidence,
      });
      const parsed = await parseResponse(response, normalizedModality);
      if (!response.ok) throw providerHttpError(response, parsed);
      if (normalizedModality !== 'TEXT' && !parsed?.binary && pendingPayload(parsed)) {
        onSubmitted?.(payloadTaskId(parsed));
        return { assets: [await pollForAsset({ initialPayload: parsed, requestUrl: url, modality: normalizedModality, apiKey, timeout, pollIntervalMs: pollInterval, title, providerName, model: providerModel, pollPath: pollPaths[normalizedModality] || '', clientRequestId, onEvidence })] };
      }
      // 用量回执（P90）：文本把上游的 token 用量提到顶层 usage，调用方不用再翻产物 metadata。
      // 非文本上游没有 token 回执，usage 为 null（图片/视频按张数、秒数在调用侧按请求参数记）。
      const asset = assetFromResponse({ payload: parsed, binary: parsed?.binary, contentType: parsed?.contentType, modality: normalizedModality, title, providerName, model: providerModel });
      return { assets: [asset], usage: asset?.metadata?.tokens || null };
    },
    // 多轮对话流式生成：上游返回 text/event-stream 时逐块回调；上游不支持流式则退化为整段返回。
    // signal：调用方中断（学生点「停止」或连接断开）时中止上游请求；onReasoning：推理型模型
    // 的思考增量（reasoning_content），用于给学生显示「正在思考」的进度。
    async generateStream({ messages, prompt = '', title, options, onDelta, onReasoning, onToolCalls, signal, clientRequestId, onEvidence, tools = null, toolChoice = null } = {}) {
      const url = modalityEndpoint(endpoint, 'TEXT', modalityEndpoints, requestPaths);
      const body = requestBody({ modality: 'TEXT', model: providerModel, prompt, title, voice, options, requestTemplates, modelRequestTemplates, messages, stream: true, tools, toolChoice });
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
            headers: { accept: 'text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...(clientRequestId ? { 'x-client-request-id': clientRequestId } : {}) },
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
        reportEvidence(onEvidence, response, null);
        if (!response.ok) {
          const parsed = await parseResponse(response, 'TEXT').catch(() => ({}));
          reportEvidence(onEvidence, response, parsed);
          throw providerHttpError(response, parsed);
        }
        if (!/text\/event-stream/i.test(contentType) || !response.body) {
          const parsed = await parseResponse(response, 'TEXT');
          reportEvidence(onEvidence, response, parsed);
          const text = responseText(parsed);
          if (!text) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
          if (typeof onDelta === 'function') onDelta(text, text);
          return { assets: [textAsset({ text, title, providerName, model: providerModel, tokens: tokenUsage(parsed), cost: reportedCost(parsed) })], usage: tokenUsage(parsed), streamed: false };
        }
        let full = '';
        let usage = null;
        let cost = null;
        // 有没有看到工具调用分片。只有工具调用、没有正文的响应是**合法**的，
        // 不能因为 full 是空的就判「响应格式无效」（老代码会在这里把 agent 的一步打断）。
        let sawToolCalls = false;
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
            usage = tokenUsage(chunk) || usage;
            cost = reportedCost(chunk) || cost;
            reportEvidence(onEvidence, response, chunk);
            const choice = chunk?.choices?.[0];
            const reasoning = choice?.delta?.reasoning_content ?? '';
            if (reasoning && typeof onReasoning === 'function') onReasoning(reasoning);
            // 工具调用（2026-09-16 打通）：**必须单独取** —— 带 tool_calls 的分片通常没有 content，
            // 而老代码下一行就是 `if (!delta) continue`，等于把工具调用整段丢掉，
            // 模型于是只能把调用写进正文（学生看到「AI 说一句就停」）。
            const toolCallDelta = choice?.delta?.tool_calls;
            if (Array.isArray(toolCallDelta) && toolCallDelta.length) {
              sawToolCalls = true;
              if (typeof onToolCalls === 'function') onToolCalls(toolCallDelta, choice?.finish_reason || null);
            }
            const delta = choice?.delta?.content ?? choice?.message?.content ?? chunk?.output_text ?? '';
            if (!delta) continue;
            full += delta;
            if (typeof onDelta === 'function') onDelta(delta, full);
          }
        }
        if (!full.trim() && !sawToolCalls) throw providerError('AI 供应商响应格式无效', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
        return { assets: [textAsset({ text: full, title, providerName, model: providerModel, tokens: usage, cost })], usage, streamed: true };
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

export { chatCompletionsEndpoint, modalityEndpoint, responseText };
