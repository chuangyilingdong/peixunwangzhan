/**
 * 上游素材镜像：请求体里凡是指向**我们自己站点**的素材，先传到上游的素材暂存接口，
 * 换成上游自己返回的 URL 再发。
 *
 * 为什么必须这么做（2026-09-21 实测，别重复走这三条弯路）：
 *   上游（api.seedance.nz，境外）**抓不到 iicili.cyou 上的图**：
 *     · 用户那两条视频任务（15:21）上游**压根没到我们的 nginx** —— access.log 里一条都没有；
 *     · 唯一到了的一条（15:35，python-httpx、腾讯云香港 IP）**只读了 105703 / 538855 字节**就断了。
 *   而上游读不到首帧/参考图时**不报错**：它当文生视频跑，出来的画面与参考毫无关系
 *   （用户原话「完全不一样的内容」）—— 全程静默，翻日志都看不出图没到。
 *   受控实验（同一张图先传到上游、再当首帧）→ **视频第一帧就是那张画**，
 *   所以请求体的形状本来就是对的，坏的只有"上游读不到图"这一环。
 *
 * 上游文档也把这条路写在推荐流程里：「可以先使用本站已有的 POST /v1/files/upload 获取临时 URL，
 * 再填入 image_url.url」，上传**不收费**（限流：每令牌每分钟 10 次、每天 200 次）。
 * ⚠️ 返回的 URL 只活 24 小时 → 这里按「源 URL」缓存 20 小时：
 *    同一张素材不会反复上传，也顺手躲开那个 10 次/分的限流。
 *
 * ⚠️ 失败时**必须报错**，不许退回原 URL 静默继续：静默的结果是"生成出一段跟参考无关的作品"，
 *    比报错糟得多（与「模板带不了参考就当场拒绝」同一条口径）。
 */
import { AI_PROVIDER_TIMEOUT_MS } from '../config.js';
import { PROVIDER_ERROR_CODES } from './providerContract.js';
import { fitMediaToRatio, parseRatio } from './mediaFit.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { uploadRoot } from './fileUploadSecurity.js';
import { row, arow } from '../lib.js';

// 上游给的 URL 活 24h，留 4h 余量；到点重新上传。
export const MIRROR_CACHE_TTL_MS = 20 * 60 * 60 * 1000;
const MIRROR_CACHE_MAX = 300;
const MIRROR_TIMEOUT_MS = Math.max(5000, Math.min(120000, Number(AI_PROVIDER_TIMEOUT_MS) || 120000));

const cache = new Map(); // 源 URL → { url, at }
const inflight = new Map(); // 源 URL → 正在进行中的上传（同一张图被多处引用时只传一次）

/** 守卫用：清缓存 / 看缓存条数。 */
export function resetUpstreamMediaMirrorCache() { cache.clear(); inflight.clear(); }
export function upstreamMediaMirrorCacheSize() { return cache.size; }

/** 这个 URL 是不是「我们自己站点上的素材」。只有 http(s) 公网地址才谈得上镜像（data: / mock: 不动）。 */
export function isSelfHostedMediaUrl(url, selfOrigins = []) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return false;
  let origin = '';
  try { origin = new URL(value).origin; } catch { return false; }
  return (Array.isArray(selfOrigins) ? selfOrigins : []).some((item) => {
    try { return new URL(String(item || '').trim()).origin === origin; } catch { return false; }
  });
}

// 上游对**生成任务里的素材**有大小上限（文档：图片 ≤30MB、音频/视频 ≤50MB；它的暂存接口本身 ≤50MB）。
// 我们自己的单文件上限是 200MB（2026-09-21 用户口径），所以「学生传了个大文件当参考」完全可能 ——
// 与其传到一半被上游拒、不如**读 body 之前**就按 content-length 拦下来，给一句能行动的提示。
const MAX_UPLOAD_BYTES = Object.freeze({ image: 30 * 1024 * 1024, audio: 50 * 1024 * 1024, video: 50 * 1024 * 1024 });
function maxBytesFor(contentType) {
  const family = String(contentType || '').split('/')[0].toLowerCase();
  return MAX_UPLOAD_BYTES[family] || MAX_UPLOAD_BYTES.video;
}
/** 上游素材上限：图片 30MB / 音视频 50MB（超了在读 body 之前就拦，别白传一趟）。 */
function assertWithinUpstreamLimit(declared, contentType) {
  if (!(declared > 0)) return;
  const cap = maxBytesFor(contentType);
  if (declared > cap) {
    throw mirrorFailure(`这张素材 ${describeSize(declared)}，超过上游 ${describeSize(cap)} 的上限（${contentType || '未知类型'}）—— 请换一张小一点的素材`);
  }
}

function describeSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
}

/**
 * 我们自己的文件资产 URL → 磁盘内容（读不到就返回 null，交给 HTTP 那条路试）。
 * 只在"文件确实在库里且 storage_kind=INTERNAL_PROXY"时才读盘。
 */
async function readOwnFileFromDisk(source) {
  const match = String(source || '').match(/\/api\/(?:public|student|admin|org)\/file-assets\/([^/]+)\/download(?:$|[?#])/);
  if (!match) return null;
  try {
    const file = await arow('SELECT storage_kind,storage_key,mime_type FROM file_assets WHERE id=?', [match[1]]);
    if (!file || file.storage_kind !== 'INTERNAL_PROXY') return null;
    const key = String(file.storage_key || '').replaceAll('\\', '/');
    if (!key || key.startsWith('/') || /^[A-Za-z]:/.test(key) || key.split('/').includes('..')) return null;
    const root = uploadRoot();
    const absolute = path.resolve(root, key);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
    return { bytes: readFileSync(absolute), contentType: String(file.mime_type || '').split(';')[0].trim() || 'application/octet-stream' };
  } catch { return null; }
}

function mirrorFailure(detail) {
  const error = new Error(`素材上传到上游失败：${detail}`);
  error.code = PROVIDER_ERROR_CODES.UPSTREAM;
  error.safeToRetry = true;
  return error;
}

// 上游按**文件名后缀**认素材类型（实测：filename=asset → 400「unsupported file type;
// allowed: jpg/jpeg/png/webp, mp3/wav/flac, mp4/avi/mov/mkv」）。我们的下载路径是 /download、
// 没有后缀，所以按响应的 content-type 补一个后缀；认不出来就退回源 URL 的后缀。
const EXTENSION_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi', 'video/x-matroska': 'mkv',
});
function mediaFileName(contentType, sourceUrl) {
  const ext = EXTENSION_BY_MIME[String(contentType || '').toLowerCase().split(';')[0].trim()]
    || (String(sourceUrl).match(/\.([a-z0-9]{2,4})(?:\?|#|$)/i)?.[1] || '').toLowerCase()
    || 'jpg';
  return `asset.${ext}`;
}

/** 把一张素材传到上游，返回上游自己的 URL（带缓存）。 */
export async function mirrorMediaUrl(url, { uploadUrl, apiKey = '', timeoutMs = MIRROR_TIMEOUT_MS, fetchImpl = null, fitRatioValue = '' } = {}) {
  const source = String(url || '').trim();
  const doFetch = fetchImpl || globalThis.fetch;
  if (!source || !uploadUrl || typeof doFetch !== 'function') return source;
  // 缓存键要带上"要不要裁"：同一张图在两种情形下得到的上游 URL 不同（裁过的 / 没裁的），
  // 混用会让学生拿到比例不对的那一份。
  const cacheKey = fitRatioValue ? `${source}#fit=${fitRatioValue}` : source;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < MIRROR_CACHE_TTL_MS) return cached.url;
  // 同一张图被多处引用（首帧 + 参考）时**并行**过来：等同一份上传，别传两遍
  // （上游限流是每令牌每分钟 10 次，一次生成里重复传同一张很浪费）。
  const pending = inflight.get(cacheKey);
  if (pending) return pending;
  const task = uploadMirrored(source, { uploadUrl, apiKey, timeoutMs, fetchImpl: doFetch, fitRatioValue });
  inflight.set(cacheKey, task);
  try { return await task; } finally { inflight.delete(cacheKey); }
}

async function uploadMirrored(source, { uploadUrl, apiKey, timeoutMs, fetchImpl: doFetch, fitRatioValue = '' }) {
  // ① 取源文件（我们自己的站点，取的是同机房的一次回环请求）
  let bytes;
  let contentType = '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  // ① 取源素材。两条路：
  //    a) 我们自己站点上的文件资产 → **直接从磁盘读**。为什么不能走 HTTP：私有素材（学生自己上传的）
  //       在 /api/public/... 上是 **403**（那条路由只服务公开文件），而 /api/student/... 要会话；
  //       顺带省掉一次"自己请求自己"的回环。
  //    b) 别处（上游自己的存储、外部图床、或 a 读不到时）→ HTTP 取回来。
  const disk = await readOwnFileFromDisk(source);
  if (disk) {
    contentType = disk.contentType;
    assertWithinUpstreamLimit(disk.bytes.length, contentType);
    bytes = new Uint8Array(disk.bytes);
  } else {
    try {
      const response = await doFetch(source, { signal: controller.signal });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
      contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim();
      // 大小闸：在**读 body 之前**按 content-length 判（上游上限只有 30/50MB，我们单文件上限是 200MB）
      assertWithinUpstreamLimit(Number(response.headers?.get?.('content-length') || 0), contentType);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      // 已经是给用户看的那句（大小超限）就别再套一层「读取素材失败」
      if (/^素材上传到上游失败/.test(String(error?.message || ''))) throw error;
      throw mirrorFailure(`读取素材失败（${String(error?.message || error).slice(0, 120)}）`);
    } finally { clearTimeout(timer); }
  }
  if (!bytes?.length) throw mirrorFailure('素材是空的');

  // ①b 需要时把画面裁成目标比例（关键帧 + 固定比例）：上游会**执行**固定比例，
  //     给它一张比例不符的图，它就把图硬拉成那个比例（用户 2026-09-21 报的「扁的画面」）。
  //     裁在自己这边、发一张已经合比例的图，它就没什么可拉的了。失败一律回退成原图（不卡生成）。
  if (fitRatioValue) {
    const fitted = await fitMediaToRatio(Buffer.from(bytes), fitRatioValue, { source });
    if (fitted.changed) {
      bytes = new Uint8Array(fitted.bytes);
      contentType = fitted.contentType;
    }
  }

  // ② 传给上游
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), mediaFileName(contentType, source));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let payload = {};
    let status = 0;
    try {
      const response = await doFetch(uploadUrl, {
        method: 'POST',
        headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: form,
        signal: controller.signal,
      });
      status = Number(response?.status || 0);
      payload = await response.json().catch(() => ({}));
      if (!response?.ok) throw new Error(`HTTP ${status}${upstreamDetail(payload)}`);
    } finally { clearTimeout(timer); }
    const mirrored = String(payload?.url || '').trim();
    if (!/^https?:\/\//i.test(mirrored)) throw new Error(`响应里没有素材 URL（HTTP ${status}）`);
    cache.set(source, { url: mirrored, at: Date.now() });
    while (cache.size > MIRROR_CACHE_MAX) cache.delete(cache.keys().next().value);
    return mirrored;
  } catch (error) {
    throw mirrorFailure(String(error?.message || error).slice(0, 120));
  }
}

// 上游的原文（例如「unsupported file type; allowed: …」）比一句 HTTP 400 有用得多，带上它
// 才排得动（2026-09-21 实测就是靠这句话发现上游按**文件名后缀**认类型）。
function upstreamDetail(payload) {
  const text = String(payload?.detail || payload?.message || payload?.error?.message || payload?.error || '').replace(/\s+/g, ' ').trim();
  return text ? `（上游：${text.slice(0, 160)}）` : '';
}

/**
 * 把生成选项里的素材"准备好再交给上游"，返回一份**新的** options。
 *  · 指向我们自己域名的素材 → 先传到上游的素材暂存接口，换成上游自己的 URL（对方读不到我们的域名）
 *  · 首帧/尾帧 + 固定比例 → 顺手**裁成那个比例**再发（上游会把比例不符的首帧硬拉变扁）
 *  · 参考素材只镜像、**不裁**（参考是"启发素材"，裁它等于改内容；而且它的比例不决定输出比例）
 * 没配上传地址、或没有任何要处理的素材时原样返回（不改形状）。
 */
export async function mirrorSelfHostedMedia(options, { selfOrigins = [], uploadUrl = '', apiKey = '', timeoutMs = MIRROR_TIMEOUT_MS, fetchImpl = null, frameFitRatio = '' } = {}) {
  const source = options && typeof options === 'object' ? options : {};
  if (!uploadUrl || !Array.isArray(selfOrigins) || !selfOrigins.length) return source;
  const ratio = parseRatio(frameFitRatio) ? frameFitRatio : '';
  // 首帧/尾帧：要裁（ratio 有值）时**不管素材在哪家**都得先取回来（上游托管的那张也一样会被拉扁）
  const prepareFrame = (value, fitRatioValue) => {
    if (!value) return Promise.resolve(value);
    if (!fitRatioValue && !isSelfHostedMediaUrl(value, selfOrigins)) return Promise.resolve(value);
    return mirrorMediaUrl(value, { uploadUrl, apiKey, timeoutMs, fetchImpl, fitRatioValue });
  };
  const mirror = (value) => (isSelfHostedMediaUrl(value, selfOrigins)
    ? mirrorMediaUrl(value, { uploadUrl, apiKey, timeoutMs, fetchImpl })
    : Promise.resolve(value));
  const next = { ...source };
  const tasks = [];
  if (source.firstFrameUrl) tasks.push(prepareFrame(source.firstFrameUrl, ratio).then((url) => { next.firstFrameUrl = url; }));
  if (source.lastFrameUrl) tasks.push(prepareFrame(source.lastFrameUrl, ratio).then((url) => { next.lastFrameUrl = url; }));
  if (Array.isArray(source.referenceAssets) && source.referenceAssets.length) {
    next.referenceAssets = [...source.referenceAssets];
    source.referenceAssets.forEach((asset, index) => {
      if (!asset || typeof asset !== 'object' || !asset.url) return;
      tasks.push(mirror(asset.url).then((url) => { next.referenceAssets[index] = { ...asset, url }; }));
    });
  }
  if (!tasks.length) return source;
  await Promise.all(tasks);
  return next;
}
