/**
 * RunningHub 异步任务适配器（2026-11-04）
 *
 * RunningHub 不是 OpenAI 兼容接口，它是「提交任务 → 拿 taskId → 轮询 query → 取 results[].url」：
 *   · 提交：POST {base}/{modelPath}，Authorization: Bearer <key>，body 按模型拼
 *   · 查询：POST {base}/query，body { taskId }
 *   · 状态：CREATE / QUEUED / RUNNING → 继续等；SUCCESS → results；FAILED / CANCEL → 失败
 *
 * 为什么不复用 openaiCompatibleProvider：
 *   · 它只认 snake_case `task_id`，RunningHub 是驼峰 `taskId`；
 *   · 它的结果取 `url` / `data` / `output`，RunningHub 在 `results[]` 里；
 *   · 它的轮询是 GET，RunningHub 要 POST `/query` + `{taskId}`；
 *   · 图片文生图 / 图生图是两条不同路径，一个模态只能配一个静态路径。
 * 所以这里单独做一层，避免把通用适配器改出别的渠道的回归。
 *
 * 模型 family：渠道卡里的 `model` 用 family key（见 RUNNINGHUB_FAMILIES）。
 * 课时框体里旧的模型 ID（例如 zhenzhen-…）不参与选路：渠道 family 才是唯一真相；
 * 这样把主渠道切到 RunningHub 时，老课时不用改也能跑。
 */
import { AI_PROVIDER_MAX_WAIT_MS, AI_PROVIDER_POLL_INTERVAL_MS, AI_PROVIDER_TIMEOUT_MS, PUBLIC_SITE_URL } from '../config.js';
import { PROVIDER_ERROR_CODES } from './providerContract.js';

const RUNNINGHUB_FAMILIES = Object.freeze({
  'rhart-image-g-2.5': {
    IMAGE_TEXT: '/rhart-image-g-2.5/sunburst/text-to-image',
    IMAGE_IMAGE: '/rhart-image-g-2.5/flare/image-to-image',
  },
  'rhart-image-g-2-official': {
    IMAGE_TEXT: '/rhart-image-g-2-official/text-to-image',
    IMAGE_IMAGE: '/rhart-image-g-2-official/image-to-image',
  },
  'bytedance/seedance-2.0-global-fast': {
    VIDEO: '/bytedance/seedance-2.0-global-fast/multimodal-video',
  },
  'minimax/hailuo-h3': {
    VIDEO: '/minimax/hailuo-h3/multimodal-to-video',
  },
  'minimax/music-2.6': {
    MUSIC: '/minimax/music-2.6',
  },
});

const DEFAULT_POLL_MS = 5000;
const MAX_IMAGE_REFS = 9;
const MAX_VIDEO_REFS = 3;
const MAX_AUDIO_REFS = 3;

function providerError(message, code, status = 0, safeToRetry = false) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  error.safeToRetry = safeToRetry;
  return error;
}

function normalizeBase(endpoint) {
  const value = String(endpoint || '').trim().replace(/\/+$/, '');
  // 允许运营把「调用地址」填成完整提交地址或 API 详情地址；统一收口到 /openapi/v2。
  const matched = value.match(/^(https?:\/\/[^/]+\/openapi\/v2)/i);
  return matched ? matched[1] : value;
}

function resolveFamily(family, modality) {
  const key = String(family || '').trim();
  if (RUNNINGHUB_FAMILIES[key]) return key;
  const upper = String(modality || '').toUpperCase();
  if (upper === 'IMAGE') return key.includes('g-2-official') ? 'rhart-image-g-2-official' : 'rhart-image-g-2.5';
  if (upper === 'VIDEO') return key.includes('hailuo') ? 'minimax/hailuo-h3' : 'bytedance/seedance-2.0-global-fast';
  if (upper === 'MUSIC') return 'minimax/music-2.6';
  return key;
}

function resolvePath(family, modality, withImages) {
  const paths = RUNNINGHUB_FAMILIES[family];
  if (!paths) return '';
  const upper = String(modality || '').toUpperCase();
  if (upper === 'IMAGE') return withImages ? (paths.IMAGE_IMAGE || paths.IMAGE_TEXT) : paths.IMAGE_TEXT;
  return paths[upper] || '';
}

function publicMediaUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^data:/i.test(value)) {
    throw providerError(
      '参考素材是内联 data:，RunningHub 需要公网可访问的 URL；请让学生重新上传素材后再试',
      PROVIDER_ERROR_CODES.CONFIG_INVALID,
    );
  }
  if (value.startsWith('/')) return `${String(PUBLIC_SITE_URL || '').replace(/\/+$/, '')}${value}`;
  if (!/^https?:\/\//i.test(value)) {
    throw providerError(`参考素材地址不是公网 URL：${value.slice(0, 80)}`, PROVIDER_ERROR_CODES.CONFIG_INVALID);
  }
  return value;
}

function collectReferences(options = {}) {
  const references = Array.isArray(options.referenceAssets) ? options.referenceAssets : [];
  const byType = (type) => references
    .filter((item) => String(item?.type || '').toUpperCase() === type)
    .map((item) => publicMediaUrl(item.url))
    .filter(Boolean);
  const imageUrls = byType('IMAGE');
  const videoUrls = byType('VIDEO');
  const audioUrls = byType('AUDIO');
  // 图生视频 / 首尾帧：平台把帧放在 firstFrameUrl / lastFrameUrl（不在 referenceAssets 里）。
  for (const url of [options.firstFrameUrl, options.lastFrameUrl]) {
    const resolved = url ? publicMediaUrl(url) : '';
    if (resolved && !imageUrls.includes(resolved)) imageUrls.push(resolved);
  }
  return {
    imageUrls: imageUrls.slice(0, MAX_IMAGE_REFS),
    videoUrls: videoUrls.slice(0, MAX_VIDEO_REFS),
    audioUrls: audioUrls.slice(0, MAX_AUDIO_REFS),
  };
}

function buildImageBody({ prompt, options, imageUrls }) {
  const body = { prompt: String(prompt || '') };
  if (options.aspectRatio) body.aspectRatio = String(options.aspectRatio);
  if (options.resolution) body.resolution = String(options.resolution);
  if (imageUrls.length) body.imageUrls = imageUrls;
  return body;
}

function buildVideoBody({ prompt, options, family, refs }) {
  const body = { prompt: String(prompt || '') };
  if (options.durationSeconds) body.duration = Number(options.durationSeconds);
  if (options.resolution) body.resolution = String(options.resolution);
  const ratio = String(options.aspectRatio || '');
  if (ratio) body.ratio = ratio === 'auto' ? 'adaptive' : ratio;
  if (refs.imageUrls.length) body.imageUrls = refs.imageUrls;
  if (refs.videoUrls.length) body.videoUrls = refs.videoUrls;
  if (refs.audioUrls.length) body.audioUrls = refs.audioUrls;
  // generateAudio 是 seedance 那条的参数；hailuo 那条不认，传了可能被拒。
  if (family.startsWith('bytedance/') && options.audio === true) body.generateAudio = true;
  return body;
}

function buildMusicBody({ prompt, options }) {
  const mode = String(options.mode || '').toUpperCase();
  const lyrics = mode === 'LYRICS' ? String(prompt || '') : String(options.lyrics || '');
  const style = mode === 'LYRICS'
    ? String(options.defaultStyle || '流行音乐').trim()
    : String(prompt || '').trim();
  return {
    prompt: style || '流行音乐',
    lyrics,
    format: 'mp3',
    sampleRate: 44100,
    bitrate: 256000,
  };
}

function mimeForOutput(outputType, modality, url = '') {
  const ext = String(outputType || '').toLowerCase().replace(/^\./, '')
    || String(url).split('?')[0].split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  };
  if (map[ext]) return { mimeType: map[ext], ext };
  const fallback = String(modality || '').toUpperCase() === 'VIDEO' ? 'video/mp4'
    : String(modality || '').toUpperCase() === 'MUSIC' ? 'audio/mpeg' : 'image/jpeg';
  return { mimeType: fallback, ext: ext || '' };
}

async function fetchJson(url, { method = 'POST', body, apiKey, timeoutMs = AI_PROVIDER_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(300000, Number(timeoutMs) || AI_PROVIDER_TIMEOUT_MS)));
  timer.unref?.();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw providerError('RunningHub 响应超时', PROVIDER_ERROR_CODES.TIMEOUT);
    throw providerError(`RunningHub 连接失败：${String(error?.message || error).slice(0, 200)}`, PROVIDER_ERROR_CODES.UNAVAILABLE);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => '');
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { response, payload };
}

function httpError(response, payload) {
  const status = Number(response?.status || 0);
  const upstream = String(payload?.errorMessage || payload?.message || payload?.error?.message || payload?.error || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const suffix = upstream ? `：${upstream}` : '';
  if (status === 401 || status === 403) {
    return providerError(`RunningHub 认证失败（HTTP ${status}）—— 检查 API Key 是否为 Enterprise-Shared 类型${suffix}`, PROVIDER_ERROR_CODES.AUTH_FAILED, status, true);
  }
  if (status === 429) {
    return providerError(`RunningHub 请求频率受限（HTTP 429）${suffix}`, PROVIDER_ERROR_CODES.RATE_LIMITED, status, true);
  }
  if (status >= 500) {
    return providerError(`RunningHub 暂时不可用（HTTP ${status}）${suffix}`, PROVIDER_ERROR_CODES.UNAVAILABLE, status);
  }
  return providerError(`RunningHub 调用失败（HTTP ${status}）${suffix}`, PROVIDER_ERROR_CODES.UPSTREAM, status, true);
}

function extractAsset(payload, { modality, title, family, name, taskId }) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const item = results.find((entry) => entry && (entry.url || entry.outputUrl || entry.output_url));
  const url = item ? String(item.url || item.outputUrl || item.output_url) : '';
  if (!url) {
    throw providerError('RunningHub 任务成功，但没有返回结果 URL', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
  }
  const { mimeType, ext } = mimeForOutput(item?.outputType, modality, url);
  return {
    assets: [{
      label: String(title || `RunningHub ${modality || '素材'}`).slice(0, 120),
      mimeType,
      assetUrl: url,
      previewUrl: /^image\//i.test(mimeType) ? url : null,
      metadata: {
        provider: name || 'runninghub',
        model: family,
        modality: String(modality || '').toUpperCase(),
        external: true,
        taskId,
        outputType: ext || null,
      },
    }],
    usage: null,
  };
}

async function pollTask({ base, taskId, apiKey, modality, title, family, name, maxWaitMs, pollIntervalMs }) {
  const startedAt = Date.now();
  let waitMs = Math.max(1000, Number(pollIntervalMs) || DEFAULT_POLL_MS);
  let transientFailures = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    let result;
    try {
      result = await fetchJson(`${base}/query`, { body: { taskId }, apiKey, timeoutMs: 30000 });
    } catch (error) {
      // 查询失败是「看不见」不是「任务失败」：退避后继续，直到 maxWait。
      transientFailures += 1;
      waitMs = Math.min(waitMs * 2, 30000);
      if (Date.now() - startedAt >= maxWaitMs) {
        throw providerError(`RunningHub 任务 ${taskId} 查询超时（任务可能还在上游运行）`, PROVIDER_ERROR_CODES.TIMEOUT);
      }
      continue;
    }
    const { response, payload } = result;
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && Date.now() - startedAt < maxWaitMs) {
        transientFailures += 1;
        waitMs = Math.min(waitMs * 2, 30000);
        continue;
      }
      throw httpError(response, payload);
    }
    const status = String(payload?.status || '').toUpperCase();
    if (status === 'SUCCESS') return extractAsset(payload, { modality, title, family, name, taskId });
    if (['FAILED', 'CANCEL', 'CANCELLED'].includes(status)) {
      const reason = String(payload?.errorMessage || payload?.message || payload?.errorCode || 'RunningHub 任务失败').slice(0, 400);
      throw providerError(reason, PROVIDER_ERROR_CODES.UPSTREAM);
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      throw providerError(`RunningHub 任务 ${taskId} 超时（任务可能还在上游运行）`, PROVIDER_ERROR_CODES.TIMEOUT);
    }
    waitMs = Math.max(1000, Number(pollIntervalMs) || DEFAULT_POLL_MS);
    transientFailures = 0;
  }
}

export function runningHubProvider({
  name = 'runninghub',
  model = '',
  family = '',
  endpoint = '',
  apiKey = '',
  timeoutMs = AI_PROVIDER_TIMEOUT_MS,
  maxWaitMs = AI_PROVIDER_MAX_WAIT_MS,
  pollIntervalMs = Math.max(DEFAULT_POLL_MS, Number(AI_PROVIDER_POLL_INTERVAL_MS) || 0),
} = {}) {
  const base = normalizeBase(endpoint);
  const providerFamily = String(family || model || '').trim();
  return {
    name,
    model: String(model || providerFamily),
    capabilities: ['IMAGE', 'VIDEO', 'MUSIC'],
    async generate({ modality, prompt, title, options = {}, onSubmitted } = {}) {
      const key = String(modality || '').toUpperCase();
      if (!['IMAGE', 'VIDEO', 'MUSIC'].includes(key)) {
        throw providerError(`RunningHub 不支持 ${key} 这类生成`, PROVIDER_ERROR_CODES.MODALITY_UNSUPPORTED);
      }
      if (!base) throw providerError('RunningHub 调用地址未配置', PROVIDER_ERROR_CODES.CONFIG_INVALID);
      if (!apiKey) throw providerError('RunningHub API Key 未配置', PROVIDER_ERROR_CODES.AUTH_FAILED);
      const resolvedFamily = resolveFamily(providerFamily, key);
      const refs = collectReferences(options);
      const path = resolvePath(resolvedFamily, key, refs.imageUrls.length > 0);
      if (!path) throw providerError(`RunningHub 没有配置 ${key} 的模型路径（family=${resolvedFamily}）`, PROVIDER_ERROR_CODES.CONFIG_INVALID);
      const body = key === 'IMAGE'
        ? buildImageBody({ prompt, options, imageUrls: refs.imageUrls })
        : key === 'VIDEO'
          ? buildVideoBody({ prompt, options, family: resolvedFamily, refs })
          : buildMusicBody({ prompt, options });

      const submitted = await fetchJson(`${base}${path}`, { body, apiKey, timeoutMs });
      if (!submitted.response.ok) throw httpError(submitted.response, submitted.payload);
      const taskId = String(
        submitted.payload?.taskId
        || submitted.payload?.task_id
        || submitted.payload?.data?.taskId
        || submitted.payload?.data?.task_id
        || submitted.payload?.id
        || '',
      ).trim();
      if (!taskId) throw providerError('RunningHub 没有返回 taskId', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
      await onSubmitted?.(taskId);
      return pollTask({
        base, taskId, apiKey, modality: key, title,
        family: resolvedFamily, name, maxWaitMs, pollIntervalMs,
      });
    },
  };
}

export { RUNNINGHUB_FAMILIES };
