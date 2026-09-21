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

function mirrorFailure(detail) {
  const error = new Error(`素材上传到上游失败：${detail}`);
  error.code = PROVIDER_ERROR_CODES.UPSTREAM;
  error.safeToRetry = true;
  return error;
}

/** 把一张素材传到上游，返回上游自己的 URL（带缓存）。 */
export async function mirrorMediaUrl(url, { uploadUrl, apiKey = '', timeoutMs = MIRROR_TIMEOUT_MS, fetchImpl = null } = {}) {
  const source = String(url || '').trim();
  const doFetch = fetchImpl || globalThis.fetch;
  if (!source || !uploadUrl || typeof doFetch !== 'function') return source;
  const cached = cache.get(source);
  if (cached && Date.now() - cached.at < MIRROR_CACHE_TTL_MS) return cached.url;
  // 同一张图被多处引用（首帧 + 参考）时**并行**过来：等同一份上传，别传两遍
  // （上游限流是每令牌每分钟 10 次，一次生成里重复传同一张很浪费）。
  const pending = inflight.get(source);
  if (pending) return pending;
  const task = uploadMirrored(source, { uploadUrl, apiKey, timeoutMs, fetchImpl: doFetch });
  inflight.set(source, task);
  try { return await task; } finally { inflight.delete(source); }
}

async function uploadMirrored(source, { uploadUrl, apiKey, timeoutMs, fetchImpl: doFetch }) {
  // ① 取源文件（我们自己的站点，取的是同机房的一次回环请求）
  let bytes;
  let contentType = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await doFetch(source, { signal: controller.signal });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
      contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim();
      bytes = new Uint8Array(await response.arrayBuffer());
    } finally { clearTimeout(timer); }
  } catch (error) {
    throw mirrorFailure(`读取素材失败（${String(error?.message || error).slice(0, 120)}）`);
  }
  if (!bytes?.length) throw mirrorFailure('素材是空的');

  // ② 传给上游
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), 'asset');
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
      if (!response?.ok) throw new Error(`HTTP ${status}`);
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

/**
 * 把生成选项里「指向我们自己站点」的素材逐个镜像掉，返回一份**新的** options。
 * 覆盖：首帧 / 尾帧 / 参考素材（图片、视频、音频一视同仁）。
 * 没配上传地址、或没有任何需要镜像的素材时原样返回（不改形状）。
 */
export async function mirrorSelfHostedMedia(options, { selfOrigins = [], uploadUrl = '', apiKey = '', timeoutMs = MIRROR_TIMEOUT_MS, fetchImpl = null } = {}) {
  const source = options && typeof options === 'object' ? options : {};
  if (!uploadUrl || !Array.isArray(selfOrigins) || !selfOrigins.length) return source;
  const mirror = (value) => (isSelfHostedMediaUrl(value, selfOrigins)
    ? mirrorMediaUrl(value, { uploadUrl, apiKey, timeoutMs, fetchImpl })
    : Promise.resolve(value));
  const next = { ...source };
  const tasks = [];
  if (source.firstFrameUrl) tasks.push(mirror(source.firstFrameUrl).then((url) => { next.firstFrameUrl = url; }));
  if (source.lastFrameUrl) tasks.push(mirror(source.lastFrameUrl).then((url) => { next.lastFrameUrl = url; }));
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
