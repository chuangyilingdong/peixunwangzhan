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
import { mirrorSelfHostedMedia } from './upstreamMediaMirror.js';
import { USD_CNY_RATE } from './fxRate.js';

const RUNNINGHUB_FAMILIES = Object.freeze({
  // 图片按「生成方式」是**两条独立 API**（各有自己的调用地址与计费）：
  //   文生图 2133100000000800383 / 2046514150500524034
  //   图生图 2133100000000800382 / 2046514150500524035
  // 所以 family 也按方式拆开，后台一条渠道只对应一条 API，价目表才分得清成本。
  'rhart-image-g-2.5-t2i': {
    IMAGE_TEXT: '/rhart-image-g-2.5/sunburst/text-to-image',
  },
  'rhart-image-g-2.5-i2i': {
    IMAGE_IMAGE: '/rhart-image-g-2.5/flare/image-to-image',
  },
  'rhart-image-g-2-official-t2i': {
    IMAGE_TEXT: '/rhart-image-g-2-official/text-to-image',
  },
  'rhart-image-g-2-official-i2i': {
    IMAGE_IMAGE: '/rhart-image-g-2-official/image-to-image',
  },
  // 2026-11-04 用户指定：文生图备用换成 gpt-image-2.5 Flare（api-detail 2133100000000800377）
  'rhart-image-g-2.5-official-token-t2i': {
    IMAGE_TEXT: '/rhart-image-g-2.5-official-token/flare/text-to-image',
  },
  // 2026-11-04 用户指定：视频主换成 seedance 2.0 Mini 多模态（CN 站 api-detail 2133000000000504043）
  'rhart-video/sparkvideo-2.0-mini': {
    VIDEO: '/rhart-video/sparkvideo-2.0-mini/multimodal-video',
  },
  // 旧的双路径 family：只给老配置/回滚快照兜底，**不在后台「读取模型」里展示**（见 LEGACY_FAMILIES）。
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
  // 2026-11-04 用户指定：视频备用换成 CN 站「万相3.0-参考生视频」（api-detail 2133100000000700019）。
  // 480P 5 秒实测 ¥1.05（21 分/秒）、约 103 秒；必填 aspectRatio（不是 ratio），音频字段叫 audio。
  'alibaba/wan-3.0': {
    VIDEO: '/alibaba/wan-3.0/reference-to-video',
  },
  'minimax/music-2.6': {
    MUSIC: '/minimax/music-2.6',
  },
});
const LEGACY_FAMILIES = new Set(['rhart-image-g-2.5', 'rhart-image-g-2-official']);

const MODALITY_LABELS = Object.freeze({ IMAGE: '图片', VIDEO: '视频', MUSIC: '音乐' });

// family 支持哪些模态 —— 直接由路径表的键推出来（IMAGE_TEXT / IMAGE_IMAGE 都算 IMAGE），
// 不要再单独维护第二张表，否则加 family 时两边会漂。
function familyModalities(paths) {
  const set = new Set();
  for (const key of Object.keys(paths || {})) set.add(key.startsWith('IMAGE') ? 'IMAGE' : key);
  return [...set];
}

/** 渠道卡里的 family → 它的主模态；不认识的 family 返回 ''（调用方自行回落）。 */
export function runningHubFamilyModality(family) {
  return familyModalities(RUNNINGHUB_FAMILIES[String(family || '').trim()])[0] || '';
}

function familyLabel(paths) {
  const keys = Object.keys(paths || {});
  // 单模态图片 family 直接标出生成方式：后台勾选时不会把「文生图」和「图生图」看混。
  if (keys.length === 1 && keys[0] === 'IMAGE_TEXT') return '图片·文生图';
  if (keys.length === 1 && keys[0] === 'IMAGE_IMAGE') return '图片·图生图';
  return familyModalities(paths).map((item) => MODALITY_LABELS[item] || item).join('/');
}

/**
 * 「读取模型」用的本地清单（2026-11-04）。
 *
 * RunningHub **没有模型列表接口**：`GET /openapi/v2/models` 对任何 Key 都回
 * `200 {"code":301,"msg":"PARAMS_INVALID"}`，所以后台以前永远显示「已读取 0 个模型」。
 * 它的可用模型就是适配器这张 family 表 —— 后台该勾的就是能真正跑的那些 key。
 * 传了 modality 就只列该模态的 family（图片渠道里不会冒出视频 family）。
 */
export function runningHubModelCatalog(modality = '') {
  const wanted = String(modality || '').trim().toUpperCase();
  return Object.entries(RUNNINGHUB_FAMILIES)
    .filter(([id]) => !LEGACY_FAMILIES.has(id))
    .map(([id, paths]) => {
      const modalities = familyModalities(paths);
      return {
        id,
        displayName: `${id}（${familyLabel(paths)}）`,
        ownedBy: 'runninghub',
        contextWindow: null,
        capabilities: null,
        modalities,
      };
    })
    .filter((item) => !wanted || item.modalities.includes(wanted));
}

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
  // 图片不再「有图就用图生图、没有就回落文生图」：文生图/图生图是两条独立 API、两条渠道，
  // 走错渠道必须报错，而不是悄悄换一条路径出去（否则价格和日志都会记到另一条 API 上）。
  if (upper === 'IMAGE') return withImages ? (paths.IMAGE_IMAGE || '') : (paths.IMAGE_TEXT || '');
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

/**
 * rhart-image-g-2-official（gpt-image-2 官方）除了 prompt 还**强制**要 `quality`，
 * 取值只能是 low / medium / high（传 auto 会被 1007 拒掉）——真机验证确认。
 * 不给的话备用渠道每次都会 `没有返回 taskId`（上游其实回了 1007）。
 *
 * 默认 **low**（2026-11-04 用户定档）。1k 实测：low $0.009/52s、medium $0.054/50s、
 * high $0.198/146s；用户确认的合同价 $0.009（文生）/ $0.027（图生）就是 low 档。
 * 单次调用可用 `options.quality` 覆盖（学生端没有这个选项，留给后台按渠道配）。
 */
const OFFICIAL_IMAGE_QUALITY = 'low';

function buildImageBody({ prompt, options, imageUrls, family, imageQuality = OFFICIAL_IMAGE_QUALITY }) {
  const body = { prompt: String(prompt || '') };
  if (options.aspectRatio) body.aspectRatio = String(options.aspectRatio);
  if (options.resolution) body.resolution = String(options.resolution);
  if (String(family || '').startsWith('rhart-image-g-2-official')) body.quality = String(options.quality || imageQuality || OFFICIAL_IMAGE_QUALITY);
  if (imageUrls.length) body.imageUrls = imageUrls;
  return body;
}

function buildVideoBody({ prompt, options, family, refs }) {
  const body = { prompt: String(prompt || '') };
  const isWan = String(family || '').startsWith('alibaba/wan-3.0');
  if (options.durationSeconds) body.duration = Number(options.durationSeconds);
  if (options.resolution) body.resolution = isWan ? String(options.resolution).toUpperCase() : String(options.resolution);
  const ratio = String(options.aspectRatio || '');
  if (isWan) {
    // 万相3.0 必填 aspectRatio；请求里没有就用 16:9（S1 的视频框都是 16:9）。
    body.aspectRatio = !ratio || ratio === 'auto' ? '16:9' : ratio;
    if (typeof options.audio === 'boolean') body.audio = options.audio;
  } else if (ratio) {
    body.ratio = ratio === 'auto' ? 'adaptive' : ratio;
  }
  if (refs.imageUrls.length) body.imageUrls = refs.imageUrls;
  if (refs.videoUrls.length) body.videoUrls = refs.videoUrls;
  if (refs.audioUrls.length) body.audioUrls = refs.audioUrls;
  // generateAudio 是 seedance 那条的参数；hailuo 那条不认，传了可能被拒。
  if (family.startsWith('bytedance/') && options.audio === true) body.generateAudio = true;
  return body;
}

/**
 * MiniMax Music 2.6 的歌词规则（2026-11-04 真机验证，花了 3 个 FAILED 任务才确认）：
 *   · 有人声：`lyrics` 必填；空歌词会以 `FAILED / 模型响应异常` 结束（提交时是正常 QUEUED，很容易被当成偶发故障）。
 *   · 纯音乐：必须 `isInstrumental: true`，且**不能带 `lyrics` 字段**（空串也不行）。
 * 平台侧：歌词模式用学生输入当词；描述模式的词由平台 LLM 代写，写不出来会先报错，
 * 所以空歌词只剩「学生没写词」这一种 —— 这时出纯音乐，比甩一个上游故障合理。
 */
function buildMusicBody({ prompt, options }) {
  const mode = String(options.mode || '').toUpperCase();
  const lyrics = (mode === 'LYRICS' ? String(prompt || '') : String(options.lyrics || '')).trim();
  const style = mode === 'LYRICS'
    ? String(options.defaultStyle || '流行音乐').trim()
    : String(prompt || '').trim();
  const body = {
    prompt: style || '流行音乐',
    format: 'mp3',
    sampleRate: 44100,
    bitrate: 256000,
  };
  if (lyrics) {
    body.lyrics = lyrics;
    body.isInstrumental = false;
    body.lyricsOptimizer = false;
  } else {
    body.isInstrumental = true;
  }
  return body;
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

/**
 * 站点币种：runninghub.ai 的 `thirdPartyConsumeMoney` 是美元；
 * runninghub.cn 的同一字段是**人民币**（2026-11-04 实测：CN 视频 usage=1.5，钱包余额 197.90→196.40）。
 * 价格字段（upstreamUnitPrices）也按这个币种解释：.ai 存美分，.cn 存人民币分。
 */
export function runningHubSiteCurrency(endpoint) {
  try {
    const host = new URL(String(endpoint || '').trim()).hostname.toLowerCase();
    return host.endsWith('runninghub.cn') ? 'CNY' : 'USD';
  } catch { return 'USD'; }
}

/**
 * 上游实扣（RunningHub query 的 usage）：
 *   `thirdPartyConsumeMoney` 的币种随站点（.ai=USD / .cn=CNY），`billingSeconds` 是实际计费秒数。
 * .ai 按固定 6.71749 折人民币；.cn 本来就是人民币。取不到就返回 null 走 COMPUTED 兜底。
 */
export function reportedCostFromUsage(payload, currency = 'USD') {
  const usage = payload?.usage && typeof payload.usage === 'object' ? payload.usage : null;
  if (!usage) return null;
  const amount = Number(usage.thirdPartyConsumeMoney);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const billingSeconds = Number(usage.billingSeconds) || null;
  if (String(currency || 'USD').toUpperCase() === 'CNY') {
    return {
      source: 'REPORTED',
      currency: 'CNY',
      amount: Math.round(amount * 100) / 100,
      fen: Math.round(amount * 100),
      upstreamCurrency: 'CNY',
      upstreamAmount: amount,
      billingSeconds,
    };
  }
  const cny = amount * USD_CNY_RATE;
  return {
    source: 'REPORTED',
    currency: 'CNY',
    amount: Math.round(cny * 100) / 100,
    fen: Math.round(cny * 100),
    upstreamCurrency: 'USD',
    upstreamAmount: amount,
    usdCnyRate: USD_CNY_RATE,
    billingSeconds,
  };
}

function extractAsset(payload, { modality, title, family, name, taskId, currency = 'USD' }) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const item = results.find((entry) => entry && (entry.url || entry.outputUrl || entry.output_url));
  const url = item ? String(item.url || item.outputUrl || item.output_url) : '';
  if (!url) {
    throw providerError('RunningHub 任务成功，但没有返回结果 URL', PROVIDER_ERROR_CODES.RESPONSE_INVALID);
  }
  const { mimeType, ext } = mimeForOutput(item?.outputType, modality, url);
  const reportedCost = reportedCostFromUsage(payload, currency);
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
        ...(reportedCost ? { reportedCost } : {}),
      },
    }],
    usage: null,
  };
}

async function pollTask({ base, taskId, apiKey, modality, title, family, name, maxWaitMs, pollIntervalMs, currency = 'USD' }) {
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
    if (status === 'SUCCESS') return extractAsset(payload, { modality, title, family, name, taskId, currency });
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
  imageQuality = OFFICIAL_IMAGE_QUALITY,
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
      // 自站素材（学生上传 / 归档产物）上游抓不到：/api/student/... 要登录，/api/public/... 只服务公开文件。
      // 先传到 RunningHub 的素材暂存接口，换成它自己的 download_url 再发（上传免费，镜像有缓存）。
      const selfOrigins = [PUBLIC_SITE_URL].map((item) => String(item || '').trim()).filter(Boolean);
      const mirroredOptions = await mirrorSelfHostedMedia(options, {
        selfOrigins,
        uploadUrl: `${base}/media/upload/binary`,
        apiKey,
        pickUploadedUrl: (payload) => payload?.data?.download_url || payload?.download_url || payload?.url,
      });
      const refs = collectReferences(mirroredOptions);
      const path = resolvePath(resolvedFamily, key, refs.imageUrls.length > 0);
      if (!path) {
        const hint = key !== 'IMAGE' ? ''
          : refs.imageUrls.length
            ? `这条渠道只支持文生图（family=${resolvedFamily}），请求却带了参考图 —— 检查「图片·图生图」路由`
            : `这条渠道只支持图生图（family=${resolvedFamily}），请求没有参考图 —— 检查「图片·文生图」路由`;
        throw providerError(hint || `RunningHub 没有配置 ${key} 的模型路径（family=${resolvedFamily}）`, PROVIDER_ERROR_CODES.CONFIG_INVALID);
      }
      const body = key === 'IMAGE'
        ? buildImageBody({ prompt, options: mirroredOptions, imageUrls: refs.imageUrls, family: resolvedFamily, imageQuality })
        : key === 'VIDEO'
          ? buildVideoBody({ prompt, options: mirroredOptions, family: resolvedFamily, refs })
          : buildMusicBody({ prompt: prompt, options: mirroredOptions });

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
        currency: runningHubSiteCurrency(base),
      });
    },
    /**
     * 按任务号查回结果（对账用，2026-11-04 晚补）。
     *
     * 为什么必须有：服务重启/TIMEOUT 时任务已被判 FAILED，但上游往往已经出片并按已受理计费；
     * 平台的对账（`reconcileStrandedGenerations`）只认适配器的 `queryTask`，
     * 没有它就只能跳过 —— 学生看不到图、钱照花。返回形状与其它适配器一致：
     * `{ state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED', asset?, message? }`。
     */
    async queryTask({ taskId, modality = 'IMAGE', title = '' } = {}) {
      const task = String(taskId || '').trim();
      if (!task) throw providerError('queryTask 缺少 taskId', PROVIDER_ERROR_CODES.CONFIG_INVALID);
      if (!base) throw providerError('RunningHub 调用地址未配置', PROVIDER_ERROR_CODES.CONFIG_INVALID);
      if (!apiKey) throw providerError('RunningHub API Key 未配置', PROVIDER_ERROR_CODES.AUTH_FAILED);
      const key = String(modality || '').toUpperCase();
      const { response, payload } = await fetchJson(`${base}/query`, { body: { taskId: task }, apiKey, timeoutMs: 30000 });
      if (!response.ok) throw httpError(response, payload);
      const status = String(payload?.status || '').toUpperCase();
      if (status === 'SUCCESS') {
        const extracted = extractAsset(payload, {
          modality: key, title, family: resolveFamily(providerFamily, key), name, taskId: task,
          currency: runningHubSiteCurrency(base),
        });
        return { state: 'SUCCEEDED', asset: extracted.assets[0] };
      }
      if (['FAILED', 'CANCEL', 'CANCELLED'].includes(status)) {
        return {
          state: status === 'FAILED' ? 'FAILED' : 'CANCELED',
          message: String(payload?.errorMessage || payload?.message || '').slice(0, 300),
        };
      }
      return { state: 'PENDING', status };
    },
  };
}

export { RUNNINGHUB_FAMILIES };
