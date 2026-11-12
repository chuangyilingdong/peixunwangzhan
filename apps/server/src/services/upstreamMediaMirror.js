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
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { uploadRoot } from './fileUploadSecurity.js';
import { materializeObject, rowStorageBackend } from './fileStorage.js';
import { row, arow } from '../lib.js';

// 上游给的 URL 活 24h，留 4h 余量；到点重新上传。
export const MIRROR_CACHE_TTL_MS = 20 * 60 * 60 * 1000;
const MIRROR_CACHE_MAX = 300;
const MIRROR_TIMEOUT_MS = Math.max(5000, Math.min(120000, Number(AI_PROVIDER_TIMEOUT_MS) || 120000));

const cache = new Map(); // 源 URL → { url, at }
const inflight = new Map(); // 源 URL → 正在进行中的上传（同一张图被多处引用时只传一次）

/**
 * 镜像上传的**字节闸**（2026-11-11）。
 *
 * 为什么必须有：一份参考素材最大 30MB（图）/ 50MB（音视频），而生成队列现在能开到 100 路。
 * 原来 `readFileSync` + `new Uint8Array()` + `Blob` 会把同一份素材复制 2~3 次 ——
 * 100 路同时镜像参考视频时是 **5GB 级内存**，机器只有 8GB，OOM 是必然的。
 *
 * 闸按**字节**算，不按请求数：10 个 1MB 和 10 个 50MB 对内存的压力完全不同。
 * 单份超过上限时允许它独占（否则永远拿不到名额），但同一时刻只有它一份。
 */
const MIRROR_MAX_INFLIGHT = Math.max(1, Math.min(32, Number(process.env.MIRROR_MAX_INFLIGHT) || 8));
const MIRROR_MAX_INFLIGHT_BYTES = Math.max(64 * 1024 * 1024, Number(process.env.MIRROR_MAX_INFLIGHT_BYTES) || 256 * 1024 * 1024);
const MIRROR_GATE_WAIT_MS = Math.max(0, Number(process.env.MIRROR_GATE_WAIT_MS) || 60000);
const mirrorGate = { active: 0, bytes: 0 };

async function acquireMirrorSlot(bytes) {
  const size = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  const startedAt = Date.now();
  const fits = () => mirrorGate.active + 1 <= MIRROR_MAX_INFLIGHT
    && (mirrorGate.active === 0 || mirrorGate.bytes + size <= MIRROR_MAX_INFLIGHT_BYTES);
  while (!fits()) {
    if (Date.now() - startedAt >= MIRROR_GATE_WAIT_MS) {
      throw mirrorFailure(`素材上传排队超时（当前并发 ${mirrorGate.active} 份 / ${Math.round(mirrorGate.bytes / 1024 / 1024)}MB）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  mirrorGate.active += 1;
  mirrorGate.bytes += size;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mirrorGate.active = Math.max(0, mirrorGate.active - 1);
    mirrorGate.bytes = Math.max(0, mirrorGate.bytes - size);
  };
}

/** 守卫/诊断用：当前镜像闸的状态。 */
export function upstreamMediaMirrorGateState() {
  return { ...mirrorGate, maxFiles: MIRROR_MAX_INFLIGHT, maxBytes: MIRROR_MAX_INFLIGHT_BYTES };
}

/** 守卫用：清缓存 / 看缓存条数。 */
export function resetUpstreamMediaMirrorCache() { cache.clear(); inflight.clear(); mirrorGate.active = 0; mirrorGate.bytes = 0; }
export function upstreamMediaMirrorCacheSize() { return cache.size; }

/**
 * 这个 URL 是不是「我们自己站点上的素材」。data: / mock: 这类内联地址不算（上游自己收 data URI）。
 *
 * ⚠️ **相对地址（`/api/…`）也要算"我们自己的"**（2026-09-24 补，用户报的图生图 bug）：
 *    画布快照里存的素材地址本来就是相对路径（客户端 `getIncomingAssetRefs` 直接把节点的
 *    assetUrl 原样发上来），而**图生图的参考图必须先镜像到上游**（私有素材上游根本取不到）。
 *    以前这里只认绝对 http(s)，相对地址被判"不是自站素材"→ 原样发出去 →
 *    上游回 `images must contain public HTTP(S) URLs`。
 *    相对地址没有 origin，但在**我们的请求体**里它只可能是我们自己的地址。
 */
export function isSelfHostedMediaUrl(url, selfOrigins = []) {
  const value = String(url || '').trim();
  if (/^\/api\//i.test(value)) return true;
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
 * 我们自己的文件资产 URL → **本地文件路径 + 大小 + MIME**（读不到就返回 null，交给 HTTP 那条路试）。
 * 只在"文件确实在库里且 storage_kind=INTERNAL_PROXY"时才走这条路。
 *
 * 两条来源：
 *   a) 本地磁盘（storageBackend=local 的老数据）；
 *   b) ⭐ **对象存储**（生产就是 OSS）：本地根本没有那份字节（storagePath=null），
 *      取回来落到一个临时文件再读。这一条以前缺了 —— 于是"自站素材在 OSS 上"时这里返回 null，
 *      掉到 HTTP 兜底（私有素材要会话，401）→ 上游拿到我们的 /api 地址 →
 *      回 `images must contain public HTTP(S) URLs`（用户 2026-09-24 报的图生图 bug）。
 *
 * ⚠️ 这里返回**路径**而不是 `readFileSync` 的 Buffer：50MB 视频 × 100 路并发就是 5GB。
 *    真正的读取交给 `openFileBlob`（Node 22 的 `fs.openAsBlob` 是文件背书的 Blob，喂给
 *    FormData/fetch 时按块读，不会整份进内存）。
 */
async function locateOwnFile(source) {
  const match = String(source || '').match(/\/api\/(?:public|student|admin|org)\/file-assets\/([^/]+)\/download(?:$|[?#])/);
  if (!match) return null;
  try {
    const file = await arow('SELECT storage_kind,storage_key,mime_type,metadata FROM file_assets WHERE id=?', [match[1]]);
    if (!file || file.storage_kind !== 'INTERNAL_PROXY') return null;
    const key = String(file.storage_key || '').replaceAll('\\', '/');
    if (!key || key.startsWith('/') || /^[A-Za-z]:/.test(key) || key.split('/').includes('..')) return null;
    const root = uploadRoot();
    const contentType = String(file.mime_type || '').split(';')[0].trim() || 'application/octet-stream';
    const absolute = path.resolve(root, key);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
    try {
      const info = await stat(absolute);
      if (info.isFile() && info.size > 0) return { path: absolute, size: info.size, contentType };
    } catch { /* 本地没有，往下看 OSS */ }
    // 本地没有这份字节 → OSS 后端就把它取回来（其它后端直接放弃）
    if (rowStorageBackend(file) !== 'oss') return null;
    const scratch = path.join(root, '.mirror-cache', `${match[1]}${path.extname(key) || '.bin'}`);
    await mkdir(path.dirname(scratch), { recursive: true });
    await materializeObject(file, scratch);
    const info = await stat(scratch);
    if (!info.isFile() || info.size <= 0) return null;
    return { path: scratch, size: info.size, contentType };
  } catch { return null; }
}

/**
 * 文件 → Blob：优先 `fs.openAsBlob`（Node 19.8+，文件背书、不整份进内存）；
 * 本地开发 Node 16 没有这个 API 时退回 Buffer。返回 null 表示调用方应该走 Buffer 兜底。
 */
async function openFileBlob(filePath, contentType) {
  try {
    const fs = await import('node:fs');
    if (typeof fs.openAsBlob !== 'function') return null;
    return await fs.openAsBlob(filePath, { type: contentType || 'application/octet-stream' });
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
export async function mirrorMediaUrl(url, { uploadUrl, apiKey = '', timeoutMs = MIRROR_TIMEOUT_MS, fetchImpl = null, fitRatioValue = '', selfOrigin = '', pickUploadedUrl = null } = {}) {
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
  const task = uploadMirrored(source, { uploadUrl, apiKey, timeoutMs, fetchImpl: doFetch, fitRatioValue, selfOrigin, pickUploadedUrl, cacheKey });
  inflight.set(cacheKey, task);
  try { return await task; } finally { inflight.delete(cacheKey); }
}

async function uploadMirrored(source, { uploadUrl, apiKey, timeoutMs, fetchImpl: doFetch, fitRatioValue = '', selfOrigin = '', pickUploadedUrl = null, cacheKey = source }) {
  let contentType = '';
  let blob = null;
  let releaseMirror = null;
  try {
    // ① 取源素材。两条路：
    //    a) 我们自己站点上的文件资产 → **直接从磁盘/OSS 取到本地文件**。为什么不能走 HTTP：
    //       私有素材（学生自己上传的）在 /api/public/... 上是 **403**（那条路由只服务公开文件），
    //       而 /api/student/... 要会话；顺带省掉一次"自己请求自己"的回环。
    //    b) 别处（上游自己的存储、外部图床、或 a 读不到时）→ HTTP 取回来。
    const disk = await locateOwnFile(source);
    if (disk) {
      contentType = disk.contentType;
      assertWithinUpstreamLimit(disk.size, contentType);
      // 先按**字节**占名额，再读文件 —— 否则 100 路同时读到 50MB 才排队，已经晚了。
      releaseMirror = await acquireMirrorSlot(disk.size);
      if (fitRatioValue) {
        // 裁剪必须完整 bytes 交给 ffmpeg；这条只对图片且只对固定比例生效，图片上限 30MB。
        let bytes = new Uint8Array(readFileSync(disk.path));
        const fitted = await fitMediaToRatio(Buffer.from(bytes), fitRatioValue, { source });
        if (fitted.changed) {
          bytes = new Uint8Array(fitted.bytes);
          contentType = fitted.contentType;
        }
        blob = new Blob([bytes], { type: contentType || 'application/octet-stream' });
      } else {
        // 文件背书的 Blob：FormData/fetch 按块读，不把整份视频读进内存。
        blob = await openFileBlob(disk.path, contentType);
        if (!blob) blob = new Blob([readFileSync(disk.path)], { type: contentType || 'application/octet-stream' });
      }
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        // 相对地址（/media/… 这类公开素材）要拼上自站 origin 才 fetch 得了；
        // 私有素材在上一段已经定位到本地文件了，走不到这里。
        const httpSource = source.startsWith('/') && selfOrigin ? new URL(source, selfOrigin).toString() : source;
        const response = await doFetch(httpSource, { signal: controller.signal });
        if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
        contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim();
        // 大小闸：在**读 body 之前**按 content-length 判（上游上限只有 30/50MB，我们单文件上限是 200MB）
        const declared = Number(response.headers?.get?.('content-length') || 0);
        assertWithinUpstreamLimit(declared, contentType);
        releaseMirror = await acquireMirrorSlot(declared || 50 * 1024 * 1024);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw mirrorFailure('素材是空的');
        blob = new Blob([bytes], { type: contentType || 'application/octet-stream' });
      } catch (error) {
        // 已经是给用户看的那句（大小超限）就别再套一层「读取素材失败」
        if (/^素材上传到上游失败/.test(String(error?.message || ''))) throw error;
        throw mirrorFailure(`读取素材失败（${String(error?.message || error).slice(0, 120)}）`);
      } finally { clearTimeout(timer); }
    }
    if (!blob || !blob.size) throw mirrorFailure('素材是空的');

    // ② 传给上游
    const form = new FormData();
    form.append('file', blob, mediaFileName(contentType, source));
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
    // 不同上游的响应形状不一样：默认 OpenAI 风格 `url`，RunningHub 是 `data.download_url`。
    const picked = typeof pickUploadedUrl === 'function' ? pickUploadedUrl(payload) : payload?.url;
    const mirrored = String(picked || '').trim();
    if (!/^https?:\/\//i.test(mirrored)) throw new Error(`响应里没有素材 URL（HTTP ${status}）`);
    // ⚠️ 缓存键要用 `cacheKey`（带 `#fit=`），不是 source：同一张图裁成不同比例得到的上游 URL 不同。
    cache.set(cacheKey, { url: mirrored, at: Date.now() });
    while (cache.size > MIRROR_CACHE_MAX) cache.delete(cache.keys().next().value);
    return mirrored;
  } catch (error) {
    if (/^素材上传到上游失败/.test(String(error?.message || ''))) throw error;
    throw mirrorFailure(String(error?.message || error).slice(0, 120));
  } finally {
    releaseMirror?.();
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
export async function mirrorSelfHostedMedia(options, { selfOrigins = [], uploadUrl = '', apiKey = '', timeoutMs = MIRROR_TIMEOUT_MS, fetchImpl = null, frameFitRatio = '', pickUploadedUrl = null } = {}) {
  const source = options && typeof options === 'object' ? options : {};
  if (!uploadUrl || !Array.isArray(selfOrigins) || !selfOrigins.length) return source;
  const ratio = parseRatio(frameFitRatio) ? frameFitRatio : '';
  const selfOrigin = String(selfOrigins[0] || '').trim();   // 相对地址要靠它补成绝对（见 uploadMirrored）
  // 首帧/尾帧：要裁（ratio 有值）时**不管素材在哪家**都得先取回来（上游托管的那张也一样会被拉扁）
  const prepareFrame = (value, fitRatioValue) => {
    if (!value) return Promise.resolve(value);
    if (!fitRatioValue && !isSelfHostedMediaUrl(value, selfOrigins)) return Promise.resolve(value);
    return mirrorMediaUrl(value, { uploadUrl, apiKey, timeoutMs, fetchImpl, fitRatioValue, selfOrigin, pickUploadedUrl });
  };
  const mirror = (value) => (isSelfHostedMediaUrl(value, selfOrigins)
    ? mirrorMediaUrl(value, { uploadUrl, apiKey, timeoutMs, fetchImpl, selfOrigin, pickUploadedUrl })
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
