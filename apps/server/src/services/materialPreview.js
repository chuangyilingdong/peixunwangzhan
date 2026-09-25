/**
 * 教学素材在线预览（2026-09-15）。
 *
 * 需求（用户口径 A）：平台的备课资料在机构/老师界面**只能在线看、不给下载**。
 *   · 视频 / PDF / 图片：浏览器能直接渲染 → 用 inline 方式提供，不给 attachment 下载入口。
 *   · PPT / DOCX：浏览器渲染不了 → **服务端用 LibreOffice 转成 PDF 再预览**。
 *     这反而是最彻底的一层：原始 .pptx/.docx **根本不发给客户端**。
 *
 * ⚠️ 「不能下载」的边界（写在这里免得以后有人以为漏了）：
 *   只要浏览器能显示，字节就到达了客户端 —— 录屏、截屏、开发者工具都拦不住。
 *   这里能做到的是：不给下载入口、URL 带**短时签名票据**（复制给别人也很快失效）、
 *   界面盖水印。**拦不住决心要存的人**，这是 web 的物理限制，不是实现缺陷。
 *
 * 2026-09-25 两处新增：
 *   · `previewModeFor`：把「幻灯片」与「文档」分开。PPT 走**放映形态**（一屏一张 + 缩略图条，
 *     见 apps/org 的 TeachingAssetViewer），Word / PDF 仍走连续滚动的文档形态。
 *   · `publishPreviewPdf`：转出来的 PDF **推到 OSS**，之后预览是 302 到签名地址 ——
 *     本机那 5 Mbps 出口不再搬课件字节（从前每看一次都要从这台机流出整份 PDF）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ossConfigured, putObject, headObject } from './objectStorage.js';

const PREVIEW_DIR = '.preview';
const CONVERT_TIMEOUT_MS = 300000; // 300s：106MB 的课件转出来要一分多钟，120s 会把它判死
const TICKET_TTL_MS = 60 * 60 * 1000; // 1 小时：够一节课看完，转发出去也很快失效
const OFFICE_EXTENSIONS = ['.ppt', '.pptx', '.doc', '.docx', '.odp', '.odt', '.xls', '.xlsx'];
// 「幻灯片」形态：只按扩展名/类型判，不看内容。PPT 才按一屏一张放映，Word 仍是文档。
const SLIDE_EXTENSIONS = ['.ppt', '.pptx', '.pps', '.ppsx', '.odp'];
/** 预览产物在 OSS 里的目录（相对键，最终还会带上 OSS_PREFIX） */
const PREVIEW_OBJECT_DIR = '_preview';

/** 预览形态：决定前端用什么元素渲染，与后端要不要转换。 */
export function previewKindFor({ mimeType = '', fileName = '' } = {}) {
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (mime.startsWith('video/') || ['.mp4', '.webm', '.mov', '.m4v'].includes(ext)) return 'VIDEO';
  if (mime === 'application/pdf' || ext === '.pdf') return 'PDF';
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'IMAGE';
  if (mime.startsWith('audio/') || ['.mp3', '.wav', '.m4a'].includes(ext)) return 'AUDIO';
  if (OFFICE_EXTENSIONS.includes(ext) || /officedocument|msword|ms-powerpoint|ms-excel/.test(mime)) return 'OFFICE';
  return 'OTHER';
}

/** 只有 Office 文档需要转换；其它形态浏览器自己就能渲染。 */
export function needsConversion(kind) {
  return kind === 'OFFICE';
}

/**
 * 预览**形态**：'SLIDES'（成套幻灯片，一屏一张）还是 'DOCUMENT'（连续排版的文档）。
 * 两者都可能是 OFFICE 转换来的 PDF，但观感完全不同 —— PPT 当文档滚动不是"PPT 形式"。
 */
export function previewModeFor({ mimeType = '', fileName = '' } = {}) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (SLIDE_EXTENSIONS.includes(ext)) return 'SLIDES';
  // 没有扩展名时按 mime 兜底；识别不出来就当文档（滚动阅读，最保守）
  if (/presentationml|ms-powerpoint/.test(String(mimeType || '').toLowerCase())) return 'SLIDES';
  return 'DOCUMENT';
}

export function isSlideDeck(input) {
  return previewModeFor(input) === 'SLIDES';
}

/**
 * 这份课件能不能**在浏览器里原生渲染**（2026-09-25 用户口径「我需要的原生渲染效果」）。
 *
 * 只有 `.pptx`（OOXML zip）可以：前端用 pptx-preview 解析 XML 自己画出来 —— 排版、字体、
 * 图片与 PowerPoint 一致，而且**不再是"服务端转成 PDF 再当文档看"**。
 *   · `.ppt`（97-2003 二进制）解析不了 → 仍旧走 LibreOffice 转 PDF 那条路；
 *   · `.docx/.xlsx` 同理只走 PDF（这一轮只做幻灯片）。
 * ⚠️ 代价要写清楚：原生渲染意味着**原始文件会到浏览器**（不然解析不了）。原来"原始 .pptx
 *    绝不下发"的承诺在这条路上不成立 —— 界面文案已改成"不提供下载入口"，别再写"原始文件不下发"。
 */
export function canRenderNatively({ mimeType = '', fileName = '' } = {}) {
  return /\.pptx$/i.test(String(fileName || '')) || /presentationml\.presentation/i.test(String(mimeType || ''));
}

function secret() {
  return String(process.env.AUTH_PEPPER || 'p0-local-pepper');
}

function signature(fileId, expiresAt) {
  return createHmac('sha256', secret()).update(`${fileId}.${expiresAt}`).digest('base64url');
}

/** 短时签名票据：URL 形如 ?t=<expiresAt>.<sig>，过期即失效（复制给别人也没用多久）。 */
export function signPreviewTicket(fileId, { now = Date.now(), ttlMs = TICKET_TTL_MS } = {}) {
  const expiresAt = now + ttlMs;
  return { expiresAt, ticket: `${expiresAt}.${signature(fileId, expiresAt)}` };
}

export function verifyPreviewTicket(fileId, ticket, { now = Date.now() } = {}) {
  const value = String(ticket || '');
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const expiresAt = Number(value.slice(0, dot));
  const given = value.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const expected = signature(fileId, expiresAt);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 把 Office 文档转成 PDF（LibreOffice headless），结果按「源文件路径 + 大小 + 修改时间」缓存。
 * - 幂等：同一个源文件只转一次，之后直接复用缓存。
 * - 并发安全：先写临时目录再 rename，避免两个请求同时转换时读到半个文件。
 * - 失败返回 null（调用方按「无法预览」处理，绝不给出原始文件）。
 */
export async function ensurePreviewPdf({ sourcePath, cacheKey }) {
  const cacheDir = path.join(path.dirname(sourcePath), PREVIEW_DIR);
  const target = path.join(cacheDir, `${cacheKey}.pdf`);
  try {
    const [src, cached] = await Promise.all([stat(sourcePath), stat(target)]);
    if (cached.size > 0 && cached.mtimeMs >= src.mtimeMs) return target;
  } catch { /* 没缓存，继续转 */ }
  // ⚠️ 临时工作目录必须和最终产物在**同一个文件系统**里：
  // 服务器上 /tmp 是独立挂载的 tmpfs，而上传目录在磁盘上 —— 用 os.tmpdir() 的话
  // 最后那步 rename 会以 EXDEV（cross-device link）失败，而且**看起来像「转换失败」**。
  // 2026-09-15 真机验证就是这么翻车的：手工 soffice 能转，代码里一直返回 null。
  //
  // ⚠️ 建目录也必须包在 try 里：缓存目录归服务账号（ai-kids-prod）所有，但只要有谁以 root
  // 在上传目录里留下过 root 所有的目录（运维手工操作、备份还原），服务就写不进去 ——
  // 那样会抛 EACCES 冒到最外层变成 **500 内部错误**，而正确的对外表现是「这份课件暂时无法预览」。
  const work = path.join(cacheDir, `.work-${cacheKey}-${Date.now()}`);
  try {
    await mkdir(cacheDir, { recursive: true });
    await mkdir(work, { recursive: true });
    await new Promise((resolve, reject) => {
      execFile('soffice', [
        '--headless', '--norestore', '--invisible',
        // 独立 profile：默认 profile 被占用时 soffice 会静默失败（并发/重复调用都踩过）
        `-env:UserInstallation=file://${path.join(work, 'profile')}`,
        '--convert-to', 'pdf', '--outdir', work, sourcePath,
      ], { timeout: CONVERT_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve()));
    });
    const produced = (await readdir(work)).find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!produced) {
      console.error(`[materialPreview] 转换没有产出 PDF：${path.basename(sourcePath)}`);
      return null;
    }
    // rename 落在同一文件系统里就是原子的：要么完整可见，要么不存在
    const { rename, copyFile } = await import('node:fs/promises');
    try {
      await rename(path.join(work, produced), target);
    } catch (error) {
      // 兜底：万一还是跨设备（缓存目录被换到别的挂载点），退化成复制
      console.error(`[materialPreview] rename 失败（${error.code}），改用复制：${path.basename(target)}`);
      await copyFile(path.join(work, produced), target);
    }
    return target;
  } catch (error) {
    // 不要静默：转换失败必须能在 journalctl 里看到原因（这个坑就是静默吞错埋的）
    console.error(`[materialPreview] 转换失败：${path.basename(sourcePath)} — ${error.message}`);
    return null;
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** 预览缓存目录名，供清理脚本/守卫识别（不要当成用户上传的文件）。 */
export const PREVIEW_CACHE_DIR = PREVIEW_DIR;

/**
 * 转换产物在 OSS 里的**对象键**（相对键，putObject 会补上 OSS_PREFIX）。
 *
 * 键里带**源文件字节数**，于是"这份 PDF 还算不算数"不用查库、不用比时间戳：
 * 对象在 = 就是这份源文件转出来的；源文件被换掉（字节数变了）→ 键跟着变 → 自然重转。
 * `size` 拿不到时退回不带尺寸的老式键（宁可多转一次，也不给错版本的 PDF）。
 */
export function previewPdfObjectKey(fileId, sourceSize) {
  const id = String(fileId || '').trim();
  const size = Number(sourceSize);
  if (!id) return null;
  return `${PREVIEW_OBJECT_DIR}/${id}${Number.isFinite(size) && size > 0 ? `-${size}` : ''}.pdf`;
}

/** 这份转换产物在 OSS 上有没有（探测失败一律当"没有" → 走转换，绝不给一个不存在的地址）。 */
export async function previewPdfInOss(fileId, sourceSize) {
  const key = previewPdfObjectKey(fileId, sourceSize);
  if (!key || !ossConfigured()) return null;
  try {
    const head = await headObject(key);
    return head.exists && head.size > 0 ? key : null;
  } catch { return null; }
}

/**
 * 把转好的 PDF 推到 OSS（幂等：大小一致就不重传）。
 * 返回对象键；**任何一步失败都返回 null**（调用方退回"本机流式发"这条老路，
 * 宁可这一次仍占带宽，也不能让老师看到"无法预览"）。
 */
export async function publishPreviewPdf({ fileId, pdfPath, sourceSize }) {
  const key = previewPdfObjectKey(fileId, sourceSize);
  if (!key || !ossConfigured()) return null;
  try {
    const info = await stat(pdfPath);
    if (!info.isFile() || info.size <= 0) return null;
    const head = await headObject(key).catch(() => ({ exists: false, size: 0 }));
    if (head.exists && Number(head.size) === info.size) return key;
    // Cache-Control 写在**对象**上（阿里云不允许在签名 URL 上覆盖它）：同一份课件反复看时
    // 浏览器直接命中缓存，连 OSS 的流量都省了。有效期与票据同量级（1 小时）。
    await putObject(key, await readFile(pdfPath), 'application/pdf', { cacheControl: 'private, max-age=3600' });
    return key;
  } catch (error) {
    console.error(`[materialPreview] 预览 PDF 推 OSS 失败（退回本机流式发）：${fileId} — ${error.message}`);
    return null;
  }
}
