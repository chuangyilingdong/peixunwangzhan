/**
 * 生成产物的落地归档：**上游给的结果是临时地址，会用完就 404**，我们只存了引用。
 *
 * 为什么必须做（2026-09-22 实测，别重复走这条弯路）：
 *   作品读面里的图/视频，`media_assets.asset_url` 存的都是上游返回的地址
 *   （`getapib.org` 的图、腾讯 COS 的视频）。追下去逐条 curl：
 *   `getapib.org` 那 21 条里 **14 条还 200、7 条已经 403**（CloudFront 回 `application/xml`），
 *   浏览器按 **ORB** 挡掉 → 学生/老师/访客看到的就是一片坏图占位。
 *   **"任务成功"不等于"这件东西以后还在"** —— 与口径 71（交给外部的素材对方可能读不到）
 *   是同一族错误的另一半：外部给的地址，对方随时可以收回。
 *
 * 三条刻意的取舍：
 *   ① **方向与本文件的反面（`upstreamMediaMirror`）正好相反**：那个是"我们的素材传给上游"，
 *      失败**必须报错**（静默的后果是"生成一段跟参考无关的作品"）；这个是"上游的产物拿回我们自己这存"，
 *      失败**绝不能报错** —— 学生已经花过钱、上游已经出片，为了一次归档失败把整条成功判死，
 *      比丢一个地址糟得多。所以这里一律 best-effort：拿不到就保留原地址，把原因记进 metadata。
 *   ② 存成**学生本人的私有素材**（`PRIVATE` + `/api/student/file-assets/<id>/download`），
 *      与「学生自己传的图」「PPT 插画」同一条路 —— 作品没发布之前不该有公网地址。
 *      ⚠️ 别改成 `PUBLIC_PLATFORM`：那会让未提交作品里的图有一个公网可取地址，是隐私口径倒退。
 *   ③ 只收**我们自己落盘校验认得的类型**（见 fileUploadSecurity 的 MIME_EXTENSIONS）。
 *      上游会给 `.mov`（容器品牌 `ftypqt`，浏览器本来就播不了）之类，那些**跳过并记原因**，
 *      不做转码 —— 转码是另一件事，别塞进生成链路里。
 */
import { readFileSync } from 'node:fs';
import { sniffMime } from './fileUploadSecurity.js';
import { storeGeneratedAsset } from '../routes/fileAssets.js';

/** 归档时能存的产物类型 → 落盘用的扩展名（与 fileUploadSecurity 的 MIME_EXTENSIONS 对齐）。 */
export const ARCHIVABLE_MIME_EXTENSION = Object.freeze({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/webm': 'webm',
});

// 上游对产物的上限是图片 30MB / 音视频 50MB（它自己的素材上限），留一点余量即可；
// 这里再卡一道是为了"别为了一件归档把内存吃爆"（这台机器 1.6GB）。
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;

/** 学生私有素材的取用地址（与「学生自己传的图」逐字同一个形状，读面才认得出 fileId）。 */
export function studentAssetUrl(fileId) {
  return `/api/student/file-assets/${encodeURIComponent(fileId)}/download`;
}

function normalizeMime(value) {
  return String(value || '').toLowerCase().split(';', 1)[0].trim();
}

/**
 * 把生成出来的字节存成学生私有素材。
 * @returns {Promise<{ok: true, url: string, mimeType: string, bytes: number}|{ok: false, reason: string}>}
 */
export async function archiveOneGeneratedAsset({ assetUrl, modality, jobId, ownerUserId, ownerOrgId, fetchImpl = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const source = String(assetUrl || '').trim();
  if (!/^https?:\/\//i.test(source)) return { ok: false, reason: '不是 http(s) 地址（data: / mock: 之类不归档）' };
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' };

  let buffer;
  let declaredMime = '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await doFetch(source, { signal: controller.signal });
    if (!response?.ok) return { ok: false, reason: `下载产物失败（HTTP ${response?.status || 0}）` };
    declaredMime = normalizeMime(response.headers?.get?.('content-type'));
    const declaredLength = Number(response.headers?.get?.('content-length') || 0);
    if (declaredLength > MAX_ARCHIVE_BYTES) return { ok: false, reason: `产物 ${(declaredLength / 1048576).toFixed(1)}MB，超过归档上限` };
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, reason: `下载产物失败（${String(error?.message || error).slice(0, 100)}）` };
  } finally { clearTimeout(timer); }

  if (!buffer?.length) return { ok: false, reason: '产物是空的' };
  if (buffer.length > MAX_ARCHIVE_BYTES) return { ok: false, reason: `产物 ${(buffer.length / 1048576).toFixed(1)}MB，超过归档上限` };

  // 上游偶尔回 `application/octet-stream`（不报错也不说是什么），这时按字节自己嗅；
  // 两边都认不出来就跳过 —— 宁可留一个会过期的地址，也别塞一个存不进我们落盘校验的东西。
  let mimeType = ARCHIVABLE_MIME_EXTENSION[declaredMime] ? declaredMime : '';
  if (!mimeType) {
    const sniffed = normalizeMime(sniffMime(buffer));
    if (ARCHIVABLE_MIME_EXTENSION[sniffed]) mimeType = sniffed;
  }
  if (!mimeType) return { ok: false, reason: `产物类型不在落盘白名单里（上游给的是 ${declaredMime || '未知'}）` };

  try {
    const stored = await storeGeneratedAsset({
      buffer,
      mimeType,
      fileName: `${String(modality || 'asset').toLowerCase()}-${jobId || 'job'}.${ARCHIVABLE_MIME_EXTENSION[mimeType]}`,
      ownerUserId,
      ownerOrgId,
      visibility: 'PRIVATE',
      metadata: { source: 'generated-asset-archive', modality: String(modality || '').toUpperCase(), jobId: jobId || null, upstreamUrl: source, upstreamMimeType: declaredMime || null },
    });
    return { ok: true, url: studentAssetUrl(stored.id), mimeType, bytes: stored.bytes };
  } catch (error) {
    return { ok: false, reason: `落盘失败（${String(error?.message || error).slice(0, 120)}）` };
  }
}

/**
 * 把一次生成返回的产物清单**整体归档**，返回一份可以照常结算的新清单。
 *
 * ⚠️ 这个函数**不抛错**：任何一件归档失败都只是那一件保留原地址 + 记一条 metadata，
 *    生成该成功还是成功（见文件头的取舍 ①）。
 * ⚠️ 文本产物（TEXT / data: 地址）不动：它们本来就在我们库里。
 */
export async function archiveGeneratedAssets(assetPayloads, { modality, jobId, ownerUserId, ownerOrgId, fetchImpl = null, timeoutMs = DEFAULT_TIMEOUT_MS, log = null } = {}) {
  const list = Array.isArray(assetPayloads) ? assetPayloads : [];
  if (!list.length) return list;
  const archived = await Promise.all(list.map(async (asset) => {
    const payload = asset && typeof asset === 'object' ? asset : {};
    const source = String(payload.assetUrl || payload.previewUrl || '').trim();
    const result = await archiveOneGeneratedAsset({ assetUrl: source, modality, jobId, ownerUserId, ownerOrgId, fetchImpl, timeoutMs });
    const metadata = { ...(payload.metadata || {}) };
    if (!result.ok) {
      metadata.archive = { mirrored: false, sourceUrl: source || null, reason: result.reason };
      if (log) log(`产物归档跳过：${result.reason}`);
      return { ...payload, metadata };
    }
    metadata.archive = { mirrored: true, sourceUrl: source, mimeType: result.mimeType, bytes: result.bytes };
    if (log) log(`产物已归档到本机：${result.url}（${(result.bytes / 1024).toFixed(0)}KB）`);
    // previewUrl 与 assetUrl 常常是同一个上游地址；只在它确实指同一份东西时才一起改写
    // （有的产物给的是"预览用的另一张图"，改了就把那张弄丢了）。
    const next = { ...payload, assetUrl: result.url, mimeType: result.mimeType || payload.mimeType, metadata };
    if (String(payload.previewUrl || '').trim() === source) next.previewUrl = result.url;
    return next;
  }));
  return archived;
}

/** 守卫用：不联网只看规则 —— 这个地址/类型会不会被归档。 */
export function archivableMimeFor(declaredMime, buffer = null) {
  const value = normalizeMime(declaredMime);
  if (ARCHIVABLE_MIME_EXTENSION[value]) return value;
  if (buffer?.length) {
    const sniffed = normalizeMime(sniffMime(buffer));
    if (ARCHIVABLE_MIME_EXTENSION[sniffed]) return sniffed;
  }
  return '';
}

/** 守卫用：读一份本地文件当作"上游产物"，验归档链路（不联网）。 */
export function readBytesForTest(absolutePath) {
  return readFileSync(absolutePath);
}
