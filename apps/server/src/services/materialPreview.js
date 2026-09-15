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
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';

const PREVIEW_DIR = '.preview';
const CONVERT_TIMEOUT_MS = 120000;
const TICKET_TTL_MS = 60 * 60 * 1000; // 1 小时：够一节课看完，转发出去也很快失效
const OFFICE_EXTENSIONS = ['.ppt', '.pptx', '.doc', '.docx', '.odp', '.odt', '.xls', '.xlsx'];

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
