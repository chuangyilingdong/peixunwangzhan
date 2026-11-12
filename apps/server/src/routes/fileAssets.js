// P4-C04 统一文件元数据与访问授权模型
// 提供：file_assets / file_access_grants 表的 CRUD + 授权校验 + 受保护文件流下载
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, stat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import {
  audit,
  errors,
  id,
  json,
  nowIso,
  parseJson,
  platformPermissionForPathname,
  q,
  requirePlatformPermission,
  requireRole,
  row,
  rows,
  assignmentActiveSql,
  orgSeriesAccessSql,
  previewInfoFor, arows, arow, aq, jsonText, isMysql, parseOptionalIsoDate } from '../lib.js';
import { assertTransition } from '../services/domainState.js';
import { maxUploadBytes, parseMultipartFormData, persistSecureUpload, uploadRoot, validateMimeAndExtension, cleanFileName } from '../services/fileUploadSecurity.js';
import { ensurePreviewPdf, needsConversion, previewKindFor, verifyPreviewTicket, previewPdfInOss, publishPreviewPdf, canRenderNatively } from '../services/materialPreview.js';
import { reserveUpload } from '../services/uploadLimits.js';
import { rowStorageBackend, ossRedirectUrl, ossStableRedirectUrl, materializeObject, imageProcessFor, persistUploadFile } from '../services/fileStorage.js';
import { ossConfigured, signedUrl } from '../services/objectStorage.js';

/** 预览 302 到 OSS 的签名有效期（1 小时，与预览票据同量级）。 */
const PREVIEW_LINK_TTL_SECONDS = 3600;

/**
 * 取一件"生成成功但还没归档完"的产物时，**最多等多久**（毫秒，2026-11-02）。
 *
 * 为什么不是直接 302 到上游：那台上游 CDN 从国内网络时通时不通（实测连打三次：超时 20s、
 * 超时 20s、1.5s 成功）。学生点开的那几秒正好是"还没归档完"的窗口，于是破图；
 * 再刷新时已经归档，走 OSS 就好了。所以这里等**我们自己的**归档完成再发。
 *
 * 预算：图片 2-3MB、视频 20MB，归档入口现在 150Mbps（约 20MB/s）、并发 3 ——
 * 单件通常 1-3 秒；给 30 秒是为了扛"一次来了几十个请求"的排队。
 * 真等到超时（队列被大文件占满 / 上游彻底不可达）才退回 302 上游作为保底。
 */
const ARCHIVE_WAIT_MS = Math.max(0, Number(process.env.ARCHIVE_DOWNLOAD_WAIT_MS ?? 30000) || 0);

/**
 * 兜底：**由我们服务器去上游取字节，边取边转发**（2026-11-02）。
 *
 * 为什么不用 302：上游 CDN 从国内网络时通时不通（实测同一地址连打三次：20s 超时、20s 超时、
 * 1.5s 成功）。把浏览器指过去 = 一半概率是破图。而**我们服务器访问那个 CDN 一直很稳**
 * （7 天归档 0 失败）—— 所以兜底走服务器转发，浏览器永远只跟我们打交道。
 *
 * ⚠️ 这条只在"等到超时 / 归档失败"时才走，正常路径根本不经过（字节走 OSS 302）。
 * ⚠️ 必须原样转发 `Range`：视频要拖进度条，206 与 content-range 都得带出去。
 * ⚠️ 用流式（Readable.fromWeb），不把 20MB 读进内存。
 */
async function proxyUpstreamBytes(ctx, sourceUrl, { fallbackMime = '', timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  // 浏览器断线就别继续拉了（学生切走页面时别白占出口）
  try { ctx.req?.once?.('close', () => controller.abort()); } catch { /* 没有 req 就算了 */ }
  const range = String(ctx.req?.headers?.range || '').trim();
  let response;
  try {
    response = await fetch(sourceUrl, { signal: controller.signal, headers: range ? { range } : {} });
  } catch (error) {
    clearTimeout(timer);
    throw errors.badRequest('素材还在转存，请稍后再试', 'UPSTREAM_TEMPORARILY_UNAVAILABLE');
  }
  if (!response.ok || !response.body) {
    clearTimeout(timer);
    throw errors.badRequest('素材还在转存，请稍后再试', 'UPSTREAM_TEMPORARILY_UNAVAILABLE');
  }
  const headers = {
    'content-type': response.headers.get('content-type') || fallbackMime || 'application/octet-stream',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  };
  for (const name of ['content-length', 'accept-ranges', 'content-range']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  const stream = Readable.fromWeb(response.body);
  stream.on('close', () => clearTimeout(timer));
  stream.on('error', () => clearTimeout(timer));
  return { __fileResponse: true, status: response.status === 206 ? 206 : 200, headers, stream };
}

/** 这一行是不是"生成成功但字节还没搬回来"的占位行。 */
function isPendingArchive(file) {
  const archive = parseJson(file?.metadata, {})?.archive || {};
  // ⚠️ **必须包含 ARCHIVING**（2026-11-02 血的教训）：队列认领这一行时就把它从 PENDING 改成 ARCHIVING，
  //    而"正在搬"的这几秒正是学生点开的时间窗 —— 只认 PENDING 的话，这 3-4 秒里读面全部 404。
  //    现象与"占位行没等"一模一样：刚生成完是破图，刷新一下（已 ARCHIVED）就好。
  return !String(file?.storage_key || '').trim()
    && (archive.state === 'PENDING' || archive.state === 'ARCHIVING' || archive.state === 'FAILED')
    && /^https?:\/\//i.test(String(archive.sourceUrl || ''));
}

/**
 * 占位行的**统一等待**（下载 / 作品图 / 预览三处共用，2026-11-02）。
 *
 * 为什么三处都要：`storage_key` 为空时，三个读面原来**各自**走不同的兜底 ——
 * 下载口 302 到上游（破图根源，已改成等待），作品图与预览直接 `FILE_STORAGE_NOT_FOUND`
 * （404）。同一个窗口、同一种"看起来像文件丢了"的故障，不该有三套行为。
 *
 * 返回最新的行（可能已经归档完成），或 null（超时/状态没变）。
 * ⚠️ 只有 PENDING 才等；FAILED 立刻返回，让调用方走各自的老兜底。
 */
async function kickAndWaitArchive(file) {
  if (!file?.id) return null;
  const meta = parseJson(file.metadata, {}) || {};
  const archive = meta.archive || {};
  // PENDING = 还没人搬（要踢）；ARCHIVING = 已经有 worker 在搬（只需要等）
  if (archive.state !== 'PENDING' && archive.state !== 'ARCHIVING') return null;
  if (archive.state === 'PENDING') {
    // 提到队首 + 立刻踢一下队列（默认 2 秒一轮，学生就在等，别空转）
    const bumped = json({ ...meta, archive: { ...archive, priority: true } });
    await aq('UPDATE file_assets SET metadata=?, updated_at=? WHERE id=?', [bumped, nowIso(), file.id]).catch(() => {});
    // 索引列同步（迁移 55 之前不存在时忽略）。
    await aq('UPDATE file_assets SET archive_priority=1 WHERE id=?', [file.id]).catch(() => {});
    import('../services/generatedAssetArchiveQueue.js')
      .then((mod) => mod.drainArchiveQueue?.())
      .catch(() => {});
  }
  const deadline = Date.now() + ARCHIVE_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const fresh = await arow('SELECT * FROM file_assets WHERE id=?', [file.id]).catch(() => null);
    if (!fresh) continue;
    if (String(fresh.storage_key || '').trim()) return fresh;
    if ((parseJson(fresh.metadata, {})?.archive?.state) === 'FAILED') return fresh;
  }
  return null;
}

const STORAGE_KINDS = new Set(['EXTERNAL_URL', 'INTERNAL_PROXY', 'PENDING']);
const VISIBILITY_MODES = new Set(['PRIVATE', 'ORG', 'ASSIGNED_ORGS', 'PUBLIC_PLATFORM', 'PUBLIC_RELEASE']);
const CATEGORIES = new Set(['PROMO_MATERIAL', 'PROMO_COVER', 'CLIENT_INSTALLER', 'MEDIA_ASSET', 'TEACHING_ASSET', 'GENERAL']);
const REVIEW_STATUSES = new Set(['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED']);
const GRANT_TYPES = new Set(['ORG', 'ROLE', 'USER', 'PUBLIC']);


function integer(value, label, { min = 0, max = 1000000, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw errors.badRequest(`${label} 必须是整数`, 'INVALID_INTEGER');
  if (n < min) throw errors.badRequest(`${label} 不能小于 ${min}`, 'INTEGER_TOO_SMALL');
  if (n > max) throw errors.badRequest(`${label} 不能超过 ${max}`, 'INTEGER_TOO_LARGE');
  return n;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function nonEmptyString(value, label, { max = 200 } = {}) {
  const str = String(value || '').trim();
  if (!str) throw errors.badRequest(`${label} 必填`, 'FIELD_REQUIRED');
  if (str.length > max) throw errors.badRequest(`${label} 长度不能超过 ${max}`, 'FIELD_TOO_LONG');
  return str;
}

function normalizeFileAsset(value) {
  if (!value) return null;
  return {
    id: value.id,
    ownerType: value.owner_type,
    ownerOrgId: value.owner_org_id || null,
    ownerUserId: value.owner_user_id || null,
    storageKind: value.storage_kind,
    storageUrl: value.storage_url || null,
    storageKey: value.storage_key || null,
    proxyRoute: value.proxy_route || null,
    publicPath: value.public_path || null,
    fileName: value.file_name,
    mimeType: value.mime_type || null,
    fileSize: value.file_size == null ? null : Number(value.file_size),
    checksum: value.checksum || null,
    category: value.category,
    visibility: value.visibility,
    status: value.status,
    reviewStatus: value.review_status,
    expiresAt: value.expires_at || null,
    metadata: parseJson(value.metadata, {}),
    createdBy: value.created_by || null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function normalizeGrant(value) {
  if (!value) return null;
  return {
    id: value.id,
    fileId: value.file_id,
    grantType: value.grant_type,
    orgId: value.org_id || null,
    userId: value.user_id || null,
    role: value.role || null,
    permission: value.permission,
    grantedBy: value.granted_by || null,
    expiresAt: value.expires_at || null,
    createdAt: value.created_at,
  };
}

/**
 * 校验 storageKind 字段与对应 URL/key 的搭配是否合理。
 */
function validateStoragePayload(storageKind, body) {
  if (!STORAGE_KINDS.has(storageKind)) throw errors.badRequest('storageKind 无效', 'INVALID_STORAGE_KIND');
  const storageUrl = body.storageUrl === undefined ? null : (body.storageUrl ? String(body.storageUrl).trim().slice(0, 2000) : null);
  const storageKey = body.storageKey === undefined ? null : (body.storageKey ? String(body.storageKey).trim().slice(0, 500) : null);
  const proxyRoute = body.proxyRoute === undefined ? null : (body.proxyRoute ? String(body.proxyRoute).trim().slice(0, 500) : null);
  if (storageKind === 'EXTERNAL_URL' && !storageUrl) throw errors.badRequest('EXTERNAL_URL 必须提供 storageUrl', 'STORAGE_URL_REQUIRED');
  if (storageKind === 'EXTERNAL_URL' && !/^https?:\/\//i.test(storageUrl || '')) throw errors.badRequest('storageUrl 必须为 http(s)://', 'INVALID_STORAGE_URL');
  if (storageKind === 'INTERNAL_PROXY' && !proxyRoute) throw errors.badRequest('INTERNAL_PROXY 必须提供 proxyRoute', 'PROXY_ROUTE_REQUIRED');
  if (storageKind === 'INTERNAL_PROXY' && !/^\/[A-Za-z0-9_\-./]+$/.test(proxyRoute)) throw errors.badRequest('proxyRoute 必须以 / 开头，仅允许字母数字与 / _ - .', 'INVALID_PROXY_ROUTE');
  if (storageKind === 'PENDING' && (storageUrl || storageKey || proxyRoute)) {
    throw errors.badRequest('PENDING 状态下不能有 storageUrl / storageKey / proxyRoute', 'PENDING_NO_STORAGE');
  }
  return { storageUrl, storageKey, proxyRoute };
}

function validateVisibility(visibility, audience) {
  if (!VISIBILITY_MODES.has(visibility)) throw errors.badRequest('visibility 无效', 'INVALID_VISIBILITY');
  if (visibility === 'ASSIGNED_ORGS') {
    if (!audience?.orgIds || !Array.isArray(audience.orgIds) || !audience.orgIds.length) {
      throw errors.badRequest('ASSIGNED_ORGS 必须提供至少一个 orgId', 'VISIBILITY_ORGS_REQUIRED');
    }
  }
  return visibility;
}

async function validateAudienceOrgIds(orgIds) {
  if (!Array.isArray(orgIds) || !orgIds.length) return [];
  const cleaned = [...new Set(orgIds.map((id) => String(id).trim()).filter(Boolean))];
  if (cleaned.length > 200) throw errors.badRequest('最多 200 个机构', 'TOO_MANY_ORGS');
  const placeholders = cleaned.map(() => '?').join(',');
  const found = (await arows(`SELECT id FROM organizations WHERE id IN (${placeholders})`, cleaned)).map((r) => r.id);
  if (found.length !== cleaned.length) throw errors.badRequest('存在不存在的机构', 'INVALID_ORG_ID');
  return cleaned;
}

/**
 * 教学素材（教师备课资料）的访问判定：必须挂在某个课时上，且该课时的课包
 * 对本机构有效授权（含未过期）。学生端不适用此函数。
 */
async function teachingAssetVisibleToOrg(fileId, orgId) {
/**
 * 快照里是否引用了这个教学素材：`teachingGroups[].assets[].fileAssetId = ?`。
 * · SQLite 用 `json_each`（表值函数）展开两层；
 * · MySQL 没有 json_each，用 `JSON_TABLE`（MySQL 8）—— 语义一致：把两层数组展开后逐项比对。
 * 抽成函数是因为**整条 EXISTS 子句没法用翻译层处理**（形状不同，不是换个函数名的事）。
 */
const snapshotHasAssetSql = () => (isMysql
  ? `EXISTS (SELECT 1 FROM JSON_TABLE(lesson.published_content, '$.teachingGroups[*]' COLUMNS (grp JSON PATH '$')) AS g,
            JSON_TABLE(g.grp, '$.assets[*]' COLUMNS (asset JSON PATH '$')) AS a
            WHERE JSON_UNQUOTE(JSON_EXTRACT(a.asset, '$.fileAssetId')) = ?)`
  : `EXISTS (SELECT 1 FROM json_each(lesson.published_content, '$.teachingGroups') grp,
            json_each(grp.value, '$.assets') asset WHERE json_extract(asset.value, '$.fileAssetId') = ?)`);

  if (!orgId) return false;
  return !!await arow(
    `SELECT 1 FROM course_lessons lesson
     JOIN course_series series ON series.id = lesson.series_id
     LEFT JOIN course_assignments assignment ON assignment.series_id = series.id AND assignment.org_id = ? AND ${assignmentActiveSql()}
     WHERE lesson.status='PUBLISHED' AND series.status='PUBLISHED' AND ${orgSeriesAccessSql()}
       AND (
         -- ① 快照里**有** teachingGroups → 以快照为准（机构端读「最近一次更新发布」定格的那份）
         (lesson.published_content IS NOT NULL AND json_valid(lesson.published_content)
          AND ${jsonText('lesson.published_content', '$.teachingGroups')} IS NOT NULL
          AND ${snapshotHasAssetSql()})
         -- ② 快照里**没有这一键** → 按实时表判。
         --    ⚠️ 这条必须与界面**同一口径**（口径㉞）：normalizeLesson 的 pick 是**逐键**回退 ——
         --    快照没有 teachingGroups 这一键时，机构端看到的就是实时素材清单。
         --    线上踩过：1-4 魔法画室那节课实时挂着 PPT 与教案，而它的快照是在挂素材**之前**定格的
         --    （没有 teachingGroups 键）→ 界面照常列出「在线预览」，点开却报
         --    「当前账号无权访问此教学素材」——界面在撒谎，根因是这里只认快照这一支。
         OR ((lesson.published_content IS NULL OR NOT json_valid(lesson.published_content)
              OR ${jsonText('lesson.published_content', '$.teachingGroups')} IS NULL)
          AND EXISTS (SELECT 1 FROM course_lesson_teaching_assets asset
            JOIN course_lesson_teaching_groups grp ON grp.id=asset.group_id
            WHERE grp.lesson_id=lesson.id AND asset.file_asset_id=?))
       )
     LIMIT 1`,
    [orgId, orgId, fileId, fileId],
  );
}

/**
 * 校验当前用户对指定 file_id 是否有 permission 权限（READ/DOWNLOAD）。
 * @param {Object} ctx - 路由上下文
 * @param {string} fileId
 * @param {string} permission - 'READ' | 'DOWNLOAD'
 * @returns {Object} file_assets 行
 */
export async function authorizeFileAccess(ctx, fileId, permission = 'READ') {
  if (!ctx?.auth?.user) throw errors.forbidden('需要登录', 'SESSION_INVALID');
  const file = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
  if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
  if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
  if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
  if (file.review_status === 'PENDING') throw errors.forbidden('文件等待审核', 'FILE_PENDING_REVIEW');
  if (file.review_status === 'REJECTED') throw errors.forbidden('文件未通过审核', 'FILE_REJECTED');
  const auth = ctx.auth;
  const user = auth.user;
  const role = user.role;
  const orgId = user.orgId || null;
  // 1. 平台超管：完全访问
  if (role === 'SUPER_ADMIN') return file;
  // 2. 教学素材是教师备课资料：学生一律不可访问，机构用户要求课包对本机构有效授权。
  if (file.category === 'TEACHING_ASSET') {
    if (role === 'STUDENT') throw errors.forbidden('教学素材仅教师可见', 'TEACHING_ASSET_FORBIDDEN');
    if ((role === 'ORG_ADMIN' || role === 'TEACHER') && await teachingAssetVisibleToOrg(file.id, orgId)) return file;
    throw errors.forbidden('当前账号无权访问此教学素材', 'FILE_ACCESS_DENIED');
  }
  // 3. 公开可见
  if (file.visibility === 'PUBLIC_PLATFORM' || file.visibility === 'PUBLIC_RELEASE') return file;
  // 4. 所有者
  if (file.owner_type === 'USER' && file.owner_user_id === user.id) return file;
  if (file.owner_type === 'ORG' && file.owner_org_id === orgId) return file;
  // 5. 授权表匹配
  const grants = await arows('SELECT * FROM file_access_grants WHERE file_id=?', [fileId]);
  const now = Date.now();
  for (const g of grants) {
    if (g.expires_at && new Date(g.expires_at).getTime() <= now) continue;
    if (g.permission !== 'READ' && g.permission !== permission) continue;
    if (g.grant_type === 'PUBLIC') return file;
    if (g.grant_type === 'USER' && g.user_id === user.id) return file;
    if (g.grant_type === 'ORG' && g.org_id && g.org_id === orgId) return file;
    if (g.grant_type === 'ROLE' && g.org_id === orgId && g.role === role) return file;
  }
  throw errors.forbidden('当前账号无权访问此文件', 'FILE_ACCESS_DENIED');
}

/**
 * 同步把 file_assets 行链接到业务对象（写入 metadata）并把 visibility 投射到 grants。
 * 由其他业务表在创建/更新文件元数据时调用。
 */
// 导出给「作品广场」的附件图代理用（见 routes/communication/public.js）：
// 那边的准入判断是「这个 fileId 必须出现在这份已发布作品的提交快照里」，
// 通过之后走的就是这里同一套落盘读取与 Range 处理，不另写一份。
export async function prepareFileDownload(ctx, file) {
  if (file.storage_kind !== 'INTERNAL_PROXY') {
    await audit(ctx, 'FILE_DOWNLOAD', 'FILE_ASSET', file.id, null, { storageKind: file.storage_kind, external: true });
    return {
      id: file.id, fileName: file.file_name, mimeType: file.mime_type, fileSize: file.file_size,
      storageKind: file.storage_kind, storageUrl: file.storage_url, proxyRoute: file.proxy_route,
      publicPath: file.public_path,
      statement: 'EXTERNAL_URL 模式：客户端可直接使用已授权的 storageUrl。',
    };
  }
  // ── 占位行：生成成功但**字节还没搬回来**（2026-11-01，见 services/generatedAssetArchiveQueue.js）──
  // 为什么要有这一支：一条 H3 是 20-22MB，把"归档完成"塞进任务的完成条件里，
  // 1000 路并行时这 20GB 会把整节课堵在入口带宽上。现在任务完成时先建一行占位
  // （INTERNAL_PROXY + 空 storage_key + metadata.archive.state=PENDING）。
  //
  // ⚠️⚠️ 2026-11-02 修正：**不要**把浏览器 302 到上游 CDN。
  //   第一版就是那么做的，结果画布刚生成完时图片是破的、刷新一下才好 —— 因为上游 CDN
  //   （media.seedance.nz / 腾讯 COS）从国内网络**时通时不通**，实测同一个地址连打三次：
  //   超时 20s、超时 20s、1.5s 才成功。学生点开的那几秒正好撞上"还没归档完"，于是破图；
  //   等几秒后归档完成、再刷新就走 OSS 了，于是"刷新一下就好了"。
  //   现在改成：**等服务端把字节搬回来再给**（下面这段有界等待），浏览器完全不碰第三方地址。
  //   真等到超时（归档队列被大文件占满 / 上游彻底不可达）才退回 302，作为最后的保底。
  const archiveMeta = parseJson(file.metadata, {})?.archive || {};
  if (isPendingArchive(file)) {
    const fresh = await kickAndWaitArchive(file);
    if (fresh && String(fresh.storage_key || '').trim()) return prepareFileDownload(ctx, fresh);
    // 等到超时 / 归档失败 → **由我们服务器转发字节**（2026-11-02）
    await audit(ctx, 'FILE_DOWNLOAD', 'FILE_ASSET', file.id, null, { storageKind: file.storage_kind, archiveState: archiveMeta.state, proxied: true });
    return proxyUpstreamBytes(ctx, String(archiveMeta.sourceUrl), { fallbackMime: file.mime_type || '' });
  }
  // OSS 行：**不经过我们转发字节**，而是 302 到带签名的临时地址（见 services/fileStorage.js）。
  // 为什么必须这样：这台机的公网出口只有 5 Mbps，媒体全从它出去会拖慢所有人。
  // 授权判断在这之前已经做完了（调用方先校验 grants / 票据），签名地址只是"取件凭证"。
  // ⭐ 2026-11-11：公开素材用**稳定签名**（同一时间窗地址恒定），并把 302 本身缓存住 ——
  //    否则同一张图每次打开都是新 URL，浏览器缓存不住，课堂里反复打开就反复回源 OSS。
  //    私有素材仍用 15 分钟签名，但允许浏览器缓存 5 分钟（窗口内重复打开不再打 Node/OSS）。
  const downloadDisposition = `attachment; filename*=UTF-8''${encodeURIComponent(String(file.file_name || 'download').replace(/[\r\n"\\/]/g, '_'))}`;
  const isPublicFile = file.visibility === 'PUBLIC_PLATFORM' || file.visibility === 'PUBLIC_RELEASE';
  const redirectUrl = isPublicFile
    ? ossStableRedirectUrl(file, { windowSeconds: 7200, contentDisposition: downloadDisposition })
    : ossRedirectUrl(file, { expires: 900, contentDisposition: downloadDisposition });
  if (redirectUrl) {
    await audit(ctx, 'FILE_DOWNLOAD', 'FILE_ASSET', file.id, null, { storageKind: file.storage_kind, storageBackend: 'oss', redirected: true });
    return {
      __fileResponse: true,
      status: 302,
      headers: { 'cache-control': isPublicFile ? 'public, max-age=3600' : 'private, max-age=300' },
      redirectUrl,
    };
  }
  const root = uploadRoot();
  const storageKey = String(file.storage_key || '').replaceAll('\\', '/');
  if (!storageKey || storageKey.startsWith('/') || /^[A-Za-z]:/.test(storageKey) || storageKey.split('/').includes('..')) {
    throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
  }
  const absolute = path.resolve(root, storageKey);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
  let info;
  try { info = await stat(absolute); } catch { throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND'); }
  if (!info.isFile()) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
  const total = info.size;
  const rangeHeader = String(ctx.req.headers.range || '');
  let start = 0; let end = total - 1; let status = 200;
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) throw errors.badRequest('Range 请求无效', 'INVALID_RANGE');
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    else end = total - 1;
    if (!match[1]) { const suffix = Number(match[2]); start = suffix > 0 ? Math.max(total - suffix, 0) : 0; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) {
      const error = errors.badRequest('Range 超出文件范围', 'RANGE_NOT_SATISFIABLE');
      error.status = 416;
      throw error;
    }
    end = Math.min(end, total - 1); status = 206;
  }
  await audit(ctx, 'FILE_DOWNLOAD', 'FILE_ASSET', file.id, null, { storageKind: file.storage_kind, storageKey: file.storage_key, range: rangeHeader || null });
  const safeName = String(file.file_name || 'download').replace(/[\r\n"\\/]/g, '_');
  return {
    __fileResponse: true,
    status,
    headers: {
      'content-type': file.mime_type || 'application/octet-stream',
      'content-length': String(end - start + 1),
      'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${total}` } : {}),
      'cache-control': 'private, no-store',
    },
    stream: createReadStream(absolute, { start, end }),
  };
}

/**
 * 画布批量取签名地址（2026-11-11）。
 *
 * 为什么要有它：画布上每个素材都是 `/api/.../file-assets/<id>/download`，原来客户端对每个
 * 素材各发一次请求 → Node 鉴权 → 302 → OSS。30 个学生 × 25 个素材就是 750 次 Node 请求；
 * 而字节本来就要从 OSS 取，Node 只是“多转一道手的收费站”。
 *
 * 现在客户端在画布打开时**一次**把全部素材地址发上来，服务端逐个鉴权后返回签名直链：
 *   · OSS 行 → 稳定签名（同一时间窗地址恒定，浏览器能缓存）；
 *   · 本地行 / 待归档占位行 → 不下发，客户端回退原来的 `/api` 地址（流式 / 等待归档）。
 *
 * 安全口径与单条下载完全一致：每个 fileId 都走 `authorizeFileAccess`，没权限的直接跳过。
 */
const SIGN_URL_RE = /^\/api\/(?:student|org)\/file-assets\/([\w-]+)\/download(?:\?.*)?$/;
async function signFileAssetUrls(ctx, urls) {
  const list = Array.isArray(urls) ? urls : [];
  const unique = [...new Set(list.map((item) => String(item || '').trim()).filter((url) => SIGN_URL_RE.test(url)))].slice(0, 300);
  const signed = {};
  for (const url of unique) {
    const fileId = url.match(SIGN_URL_RE)?.[1];
    if (!fileId) continue;
    try {
      const file = await authorizeFileAccess(ctx, fileId, 'READ');
      // 2 小时窗口：一节课足够长；窗口内同一素材地址恒定，浏览器缓存得住。
      const redirect = ossStableRedirectUrl(file, { windowSeconds: 7200 });
      if (redirect) signed[url] = redirect;
    } catch {
      // 无权限 / 文件不存在 / 本地行 / PENDING：不阻断其它素材，客户端会回退原地址。
    }
  }
  return { urls: signed };
}

export async function prepareWorkImage(ctx, file) {
  const mimeType = String(file?.mime_type || '').toLowerCase();
  // ⭐ 2026-10-01：svg 也走这条（它同样是"作品里的图"）—— 它的 XSS 补偿在下面的 svgLike/attachment。
  if (file?.storage_kind !== 'INTERNAL_PROXY' || !/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(mimeType)) {
    throw errors.notFound('作品图片不可用', 'WORK_IMAGE_UNAVAILABLE');
  }
  // 2026-11-02：占位行（刚生成、还没归档完）→ 等服务端搬完再来一次，别直接 404。
  // 作品广场/学生主页的作品图也走这条路 —— 学生生成完立刻发布时，原来会看到一片坏图。
  if (isPendingArchive(file)) {
    const fresh = await kickAndWaitArchive(file);
    if (fresh && String(fresh.storage_key || '').trim()) return prepareWorkImage(ctx, fresh);
    // 等不到 → **服务端转发**，保证作品图不出现破图
    const archive = parseJson(file.metadata, {})?.archive || {};
    return proxyUpstreamBytes(ctx, String(archive.sourceUrl), { fallbackMime: file.mime_type || '' });
  }
  // Keep previews aligned with the upload policy. The stream below enforces this
  // again for OSS rows whose metadata or response headers are missing/stale.
  const maxBytes = maxUploadBytes();
  if (file.file_size != null && Number(file.file_size) > maxBytes) {
    throw errors.badRequest('作品图片过大，无法在线预览', 'WORK_IMAGE_TOO_LARGE');
  }

  const storageKey = String(file.storage_key || '').replaceAll('\\', '/');
  if (!storageKey || storageKey.startsWith('/') || /^[A-Za-z]:/.test(storageKey) || storageKey.split('/').includes('..')) {
    throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
  }
  let stream;
  let bytes;
  // ⭐ 2026-09-25：OSS 行**不再把字节搬过这台机**（本来是从内网取回来再转发给浏览器）——
  //    这台机的公网出口只有 5 Mbps，7 张 2.4MB 的作品图要几十秒（用户看到的"预览一直是失效的样子"，
  //    见交接 §二十二）；改成和下载口同一条路子：**302 到带签名的临时地址**，字节由 OSS 直接服务。
  //    · `<img>/<video>/<audio>` 跟着 302 走 ✓（CSP 的 img-src/media-src 都允许 https:）；
  //    · 需要字节的调用方（VibeCoding 沙箱文档要内联成 data:）走 `fetch` —— 桶上已配 CORS
  //      （ACAO https://aicyld.com + credentials），所以 fetch 也读得到 ✓（2026-09-25 实测）。
  //    · 大小上限改成看**库里记的字节数**（302 之后没法再拦响应体）：
  //      file_size 是上传时校验过的，且下面这条与流式那条原来是同一个阈值。
  // ⚠️ 2026-10-01：**svg 一律 `Content-Disposition: attachment`** —— svg 能带脚本，
  //    而"直接在地址栏打开这个地址"会让浏览器把它当文档渲染、脚本在**我们域**里跑（存储型 XSS）。
  //    `<img src>` 不受影响（disposition 只作用于顶层导航），所以学生页里的 svg 照常显示。
  const svgLike = /^image\/svg\+xml/i.test(String(file.mime_type || ''));
  if (rowStorageBackend(file) === 'oss') {
    const isPublicFile = file.visibility === 'PUBLIC_PLATFORM' || file.visibility === 'PUBLIC_RELEASE';
    const disposition = svgLike ? { contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent('image.svg')}` } : {};
    const signed = isPublicFile
      ? ossStableRedirectUrl(file, { windowSeconds: 7200, ...disposition })
      : ossRedirectUrl(file, { expires: 900, ...disposition });
    if (!signed) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
    await audit(ctx, 'FILE_WORK_IMAGE_PROXY', 'FILE_ASSET', file.id, null, { storageBackend: 'oss', redirected: true, bytes: file.file_size == null ? null : Number(file.file_size) });
    return {
      __fileResponse: true,
      status: 302,
      headers: { 'cache-control': isPublicFile ? 'public, max-age=3600' : 'private, max-age=300' },
      redirectUrl: signed,
    };
  }
  // 本地盘的行：没有 OSS 可指，照旧流式发（数量很少，且是本机文件）
  {
    const root = uploadRoot();
    const absolute = path.resolve(root, storageKey);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
    let info;
    try { info = await stat(absolute); } catch { throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND'); }
    if (!info.isFile()) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
    bytes = info.size;
    if (bytes > maxBytes) throw errors.badRequest('作品图片过大，无法在线预览', 'WORK_IMAGE_TOO_LARGE');
    stream = createReadStream(absolute);
  }
  try {
    await audit(ctx, 'FILE_WORK_IMAGE_PROXY', 'FILE_ASSET', file.id, null, { storageBackend: rowStorageBackend(file), bytes });
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return {
    __fileResponse: true,
    status: 200,
    headers: {
      'content-type': file.mime_type,
      ...(bytes == null ? {} : { 'content-length': String(bytes) }),
      'content-disposition': svgLike ? 'attachment' : 'inline',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
    stream,
  };
}

export async function linkFileAsset({ fileId, businessType, businessId, audience, grantedBy }) {
  if (!fileId) return;
  const file = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
  if (!file) return;
  const meta = parseJson(file.metadata, {});
  meta.linkedBusiness = { type: businessType, id: businessId };
  await aq('UPDATE file_assets SET metadata=?, updated_at=? WHERE id=?', [json(meta), nowIso(), fileId]);
  // 同步生成 grants：visibility → grants
  await syncFileGrants(fileId, file, audience, grantedBy);
}

async function syncFileGrants(fileId, file, audience, grantedBy) {
  const now = nowIso();
  await aq('DELETE FROM file_access_grants WHERE file_id=?', [fileId]);
  if (file.visibility === 'PUBLIC_PLATFORM' || file.visibility === 'PUBLIC_RELEASE') {
    await aq('INSERT INTO file_access_grants(id,file_id,grant_type,permission,granted_by,created_at) VALUES (?,?,?,?,?,?)', [id('fag'), fileId, 'PUBLIC', 'READ', grantedBy || null, now]);
    return;
  }
  if (file.visibility === 'ORG' && file.owner_org_id) {
    await aq('INSERT INTO file_access_grants(id,file_id,grant_type,org_id,permission,granted_by,created_at) VALUES (?,?,?,?,?,?,?)', [id('fag'), fileId, 'ORG', file.owner_org_id, 'READ', grantedBy || null, now]);
  }
  if (file.visibility === 'ASSIGNED_ORGS' && Array.isArray(audience?.orgIds)) {
    for (const oid of audience.orgIds) {
      await aq('INSERT INTO file_access_grants(id,file_id,grant_type,org_id,permission,granted_by,created_at) VALUES (?,?,?,?,?,?,?)', [id('fag'), fileId, 'ORG', oid, 'READ', grantedBy || null, now]);
    }
  }
  if (file.visibility === 'PRIVATE' && file.owner_user_id) {
    await aq('INSERT INTO file_access_grants(id,file_id,grant_type,user_id,permission,granted_by,created_at) VALUES (?,?,?,?,?,?,?)', [id('fag'), fileId, 'USER', file.owner_user_id, 'READ', grantedBy || null, now]);
  }
}

export async function createUploadedFileAsset(ctx, { auth, ownerType, ownerOrgId = null, scope, defaultVisibility }) {
  const contentType = String(ctx.req.headers['content-type'] || '');
  let multipart = { fields: {}, file: null };
  try { multipart = parseMultipartFormData(ctx.rawBody || Buffer.alloc(0), contentType); }
  catch (error) {
    await audit(ctx, 'FILE_UPLOAD_REJECTED', 'FILE_ASSET', null, null, { code: error?.code || 'INVALID_MULTIPART' }, ownerOrgId ? { orgId: ownerOrgId } : undefined);
    throw error;
  }
  const fields = multipart.fields;
  const category = String(fields.category || 'MEDIA_ASSET').toUpperCase();
  if (!CATEGORIES.has(category)) throw errors.badRequest('文件分类无效', 'INVALID_FILE_CATEGORY');
  const audience = fields.audience ? (() => { try { return JSON.parse(fields.audience); } catch { throw errors.badRequest('audience JSON 无效', 'INVALID_AUDIENCE'); } })() : {};
  const visibility = validateVisibility(String(fields.visibility || defaultVisibility).toUpperCase(), audience);
  if (ownerType === 'ORG' && !['ORG', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibility)) throw errors.badRequest('机构文件仅允许 PRIVATE/ORG/ASSIGNED_ORGS', 'INVALID_ORG_VISIBILITY');
  const orgIds = visibility === 'ASSIGNED_ORGS' ? await validateAudienceOrgIds(audience.orgIds) : [];
  if (ownerType === 'ORG' && visibility === 'ASSIGNED_ORGS' && !orgIds.includes(ownerOrgId)) orgIds.unshift(ownerOrgId);
  const expiresAt = parseOptionalIsoDate(fields.expiresAt);

  const releaseUpload = await reserveUpload({ userId: auth.user.id, orgId: ownerOrgId || `platform:${ownerType}`, bytes: multipart.file?.buffer?.length || 0 });
  let stored;
  try {
    stored = await persistSecureUpload(multipart.file);
  } catch (error) {
    await audit(ctx, 'FILE_UPLOAD_REJECTED', 'FILE_ASSET', null, null, {
      code: error?.code || 'UPLOAD_REJECTED', fileName: multipart.file?.fileName || null,
      mimeType: multipart.file?.mimeType || null, fileSize: multipart.file?.buffer?.length || 0,
    }, ownerOrgId ? { orgId: ownerOrgId } : undefined);
    releaseUpload();
    throw error;
  }
  try {
    const fileId = id('file');
    const now = nowIso();
    // 记下这一行落在哪个后端：读的时候（下载 / 预览）靠它分流。
    // 老数据没有这个字段 → 一律当本地盘，所以**不需要为历史数据做迁移**，回滚也就是删掉这个标记。
    const metadata = { upload: { originalName: stored.fileName, security: stored.security, uploadedAt: now }, storageBackend: stored.storageBackend || 'local' };
    const proxyRoute = `/api/${scope}/file-assets/${fileId}/download`;
    await aq(
      `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fileId, ownerType, ownerOrgId, ownerType === 'USER' ? auth.user.id : null, 'INTERNAL_PROXY', null, stored.storageKey, proxyRoute, null, stored.fileName, stored.mimeType, stored.fileSize, stored.checksum, category, visibility, 'ACTIVE', 'NOT_REQUIRED', expiresAt, json(metadata), auth.user.id, now, now],
    );
    const created = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
    await syncFileGrants(fileId, created, { orgIds }, auth.user.id);
    await audit(ctx, 'FILE_UPLOAD', 'FILE_ASSET', fileId, null, { category, visibility, mimeType: stored.mimeType, fileSize: stored.fileSize, checksum: stored.checksum, storageKey: stored.storageKey, scanner: stored.security }, ownerOrgId ? { orgId: ownerOrgId } : undefined);
    releaseUpload();
    return normalizeFileAsset(created);
  } catch (error) {
    if (stored?.storagePath) await rm(stored.storagePath, { force: true }).catch(() => {});
    releaseUpload();
    throw error;
  }
}
/**
 * 把一段**平台自己产出**的字节存成公开素材（AI 生成的插画走这条路）。
 *
 * 与「学生上传」的区别：没有 multipart、不占上传频次配额（这不是学生在刷卡），
 * 但**复用同一套校验与存储布局**（persistSecureUpload 会验扩展名/魔术字节/大小），
 * 于是生成出来的图和学生传的图共用同一条公开下载地址，产物渲染与页面显示都不用特殊处理。
 */
export async function storeGeneratedAsset({ buffer, mimeType, fileName, ownerUserId = null, ownerOrgId = null, category = 'MEDIA_ASSET', visibility = 'PUBLIC_PLATFORM', metadata = {} }) {
  const stored = await persistSecureUpload({ fileName, mimeType, buffer });
  const fileId = id('file');
  const now = nowIso();
  await aq(
    `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [fileId, ownerUserId ? 'USER' : 'PLATFORM', ownerOrgId, ownerUserId, 'INTERNAL_PROXY', null, stored.storageKey,
      `/api/public/file-assets/${fileId}/download`, null, stored.fileName, stored.mimeType, stored.fileSize,
      stored.checksum, category, visibility, 'ACTIVE', 'NOT_REQUIRED', null,
      json({ ...metadata, generated: true, security: stored.security, storageBackend: stored.storageBackend || 'local' }), ownerUserId, now, now],
  );
  const created = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
  return { id: fileId, url: `/api/public/file-assets/${fileId}/download`, fileName: stored.fileName, mimeType: stored.mimeType, bytes: stored.fileSize, row: created };
}

/** 读文件头几个字节（嗅探用；不要为了一次校验把整个产物读进内存）。 */
async function readFileHead(filePath, bytes) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/**
 * 生成产物的**流式**落库（2026-11-01）：字节已经在临时文件里，不再整段进内存。
 *
 * 与上面 `storeGeneratedAsset` 的差别只有"字节从哪来"：那个收 Buffer（调用方已经把整段读进内存），
 * 这个收文件路径。**落库字段、返回形状、默认可见性与它逐字一致** —— 因为读面（下载 / 预览 /
 * 作品发布改写）只认 `file_assets` 行，不关心字节当初怎么进来的。
 *
 * ⚠️ 为什么不直接复用 `persistSecureUpload`：它的签名要 Buffer，还要对整段做 sha256 与 clamscan。
 *    生成产物是**上游给的**、不是用户上传，那两道口径本来就不适用；checksum 由调用方边下边算
 *    （见 services/generatedAssetArchive.js）。这里仍走 `validateMimeAndExtension` —— 魔术字节那道
 *    校验不能省，否则一个伪装成 mp4 的什么东西也能落盘。
 *
 * ⚠️ 临时文件由**调用方**删（归档那边 finally 里 unlink）；这里只读，不搬不删。
 */
export async function storeGeneratedAssetFromFile({ tempPath, bytes, mimeType, checksum, fileName, ownerUserId = null, ownerOrgId = null, category = 'MEDIA_ASSET', visibility = 'PUBLIC_PLATFORM', metadata = {} }) {
  const { persisted, validated, safeName, digest, size } = await persistGeneratedFileBytes({ tempPath, bytes, mimeType, fileName, checksum });
  const fileId = id('file');
  const stamp = nowIso();
  await aq(
    `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [fileId, ownerUserId ? 'USER' : 'PLATFORM', ownerOrgId, ownerUserId, 'INTERNAL_PROXY', null, persisted.storageKey,
      `/api/public/file-assets/${fileId}/download`, null, safeName, validated.mimeType, size,
      digest, category, visibility, 'ACTIVE', 'NOT_REQUIRED', null,
      json({ ...metadata, generated: true, security: { signature: validated.detectedMime || 'textual', scanner: 'SKIPPED', status: 'SKIPPED' }, storageBackend: persisted.storageBackend || 'local' }), ownerUserId, stamp, stamp],
  );
  const created = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
  return { id: fileId, url: `/api/public/file-assets/${fileId}/download`, fileName: safeName, mimeType: validated.mimeType, bytes: size, row: created };
}

/**
 * 校验 + 落盘（不建行、不改行）—— `storeGeneratedAssetFromFile` 与
 * `replaceGeneratedAssetFromFile` 共用这一段，免得两条路的校验口径分叉。
 */
async function persistGeneratedFileBytes({ tempPath, bytes, mimeType, fileName, checksum }) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size < 1) throw errors.badRequest('文件内容无效', 'INVALID_FILE_CONTENT');
  if (size > maxUploadBytes()) throw errors.badRequest(`文件大小不能超过 ${Math.floor(maxUploadBytes() / 1024 / 1024)} MB`, 'FILE_TOO_LARGE');
  const head = await readFileHead(tempPath, 8192);
  const validated = validateMimeAndExtension(fileName, mimeType, head);
  const safeName = cleanFileName(fileName).normalized;
  const root = uploadRoot();
  const now = new Date();
  const relative = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), `${randomUUID()}${validated.extension}`);
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) throw errors.badRequest('存储路径无效', 'INVALID_STORAGE_PATH');
  let persisted;
  try {
    persisted = await persistUploadFile({
      relativeKey: relative.replaceAll(path.sep, '/'),
      filePath: tempPath,
      size,
      mimeType: validated.mimeType,
      // 用 copy 不用 rename：临时目录与 uploads 根目录**不保证同一个挂载点**，rename 跨盘会 EXDEV。
      moveLocal: async () => {
        await mkdir(path.dirname(absolute), { recursive: true, mode: 0o750 });
        await copyFile(tempPath, absolute);
        return absolute;
      },
    });
  } catch (error) {
    // 后端（OSS）的原始错误不能吞 —— 否则线上只有一句「文件存储失败」，无从下手
    console.warn('[storage] 流式归档写入失败：', error?.message || error);
    throw errors.badRequest('文件存储失败', 'FILE_STORAGE_FAILED');
  }
  // checksum 正常由调用方边下边算；没给就补算一次（别让库里出现空 checksum，回填脚本靠它比对）
  const digest = String(checksum || '') || await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(tempPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  return { persisted, validated, safeName, digest, size };
}

/**
 * 建一条**占位行**：生成成功、字节还没搬回来（2026-11-01，B2 解耦）。
 *
 * 对外地址在**这一刻**就固定成 `/api/student/file-assets/<id>/download`，
 * 之后归档完成只是把字节填进同一行 —— 学生的画布快照、已分享的作品都不用改写。
 *
 * ⚠️ `storage_kind` 仍是 `INTERNAL_PROXY`（**不是** `PENDING`）：读面有十几处按
 *    `storage_kind !== 'INTERNAL_PROXY'` 早退，换成 PENDING 会让预览/取源那些分支提前报"没有文件"。
 *    判据改成"INTERNAL_PROXY 且 storage_key 为空"，语义一样但所有既有分支照常工作。
 */
export async function createPendingGeneratedAsset({ sourceUrl, modality, jobId, ownerUserId = null, ownerOrgId = null, fileName, declaredMime = '', metadata = {} }) {
  const fileId = id('file');
  const stamp = nowIso();
  const proxyRoute = `/api/student/file-assets/${fileId}/download`;
  const baseColumns = 'id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at';
  const baseValues = [fileId, ownerUserId ? 'USER' : 'PLATFORM', ownerOrgId, ownerUserId, 'INTERNAL_PROXY', null, null, proxyRoute, null,
    fileName, declaredMime || null, null, null, 'MEDIA_ASSET', 'PRIVATE', 'ACTIVE', 'NOT_REQUIRED', null];
  const tailValues = [
    json({ ...metadata, generated: true, archive: { state: 'PENDING', sourceUrl, modality, jobId, attempts: 0, priority: false, queuedAt: stamp } }),
    ownerUserId, stamp, stamp,
  ];
  try {
    // 迁移 55 之后：同时写索引列 archive_state（队列取件靠它，不再扫 metadata）。
    await aq(
      `INSERT INTO file_assets(${baseColumns},archive_state,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...baseValues, 'PENDING', ...tailValues],
    );
  } catch (error) {
    // 迁移 55 没跑的库：archive_state 列不存在。退回不带该列的插入，队列走 legacy 扫描；
    // 不能因为一次「索引列还没建」把整条生成变成同步归档。
    if (!/archive_state|Unknown column|no column named/i.test(String(error?.message || ''))) throw error;
    await aq(
      `INSERT INTO file_assets(${baseColumns},metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...baseValues, ...tailValues],
    );
  }
  return { id: fileId, url: proxyRoute };
}

/** 归档落地：把字节填进**已存在**的占位行（不新建行，对外地址不变）。 */
export async function replaceGeneratedAssetFromFile({ fileId, tempPath, bytes, mimeType, checksum, fileName }) {
  const existing = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
  if (!existing) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
  const { persisted, validated, safeName, digest, size } = await persistGeneratedFileBytes({ tempPath, bytes, mimeType, fileName, checksum });
  const meta = parseJson(existing.metadata, {}) || {};
  const stamp = nowIso();
  await aq(
    'UPDATE file_assets SET storage_key=?, file_name=?, mime_type=?, file_size=?, checksum=?, metadata=?, updated_at=? WHERE id=?',
    [persisted.storageKey, safeName, validated.mimeType, size, digest,
      json({ ...meta, storageBackend: persisted.storageBackend || 'local', security: { signature: validated.detectedMime || 'textual', scanner: 'SKIPPED', status: 'SKIPPED' },
        archive: { ...(meta.archive || {}), state: 'ARCHIVED', archivedAt: stamp, bytes: size } }),
      stamp, fileId],
  );
  // 索引列同步（迁移 55 之前不存在时忽略；metadata 仍是真相）。
  await aq("UPDATE file_assets SET archive_state='ARCHIVED', archive_next_attempt_at=NULL WHERE id=?", [fileId]).catch(() => {});
  return { id: fileId, storageKey: persisted.storageKey, mimeType: validated.mimeType, bytes: size };
}

/**
 * 把学生作品里的一个二进制素材存成**私有**文件资产（2026-09-16 加）。
 *
 * 什么时候用：学生的创作环境（dsh）里做出的网页，图片是**工作区里的本地文件**（`hero.png`），
 * 而我们的作品快照 `files` 只能装文本。所以把字节存成私有素材，再把 HTML 里的引用改写成
 * 学生的私有下载地址 —— 与「学生在工作台里传图、模型用绝对地址引用」是同一套机制。
 *
 * 三个口径：
 *   · `PRIVATE` + 属主是学生本人 —— 作品没发布之前不该有公网地址；
 *   · proxy 路由必须是 `/api/student/file-assets/<id>/download`：作品发布时
 *     `publicSnapshotFiles` 正是按这个前缀把它改写成作品专属的公开代理地址（前缀不一致就改写不到）；
 *   · 仍走 `persistSecureUpload`（验扩展名/魔术字节/大小），所以生成物与学生手传的图共用一条路。
 */
export async function storeStudentArtifactAsset({ buffer, mimeType, fileName, ownerUserId, ownerOrgId = null, metadata = {}, scan = null }) {
  // `scan`：整单已经扫过就把结果透传进来（见 studentRuntime 的 `scanUploadBuffers`）——
  // 一个作品有几个二进制文件就少起几次扫描器（`clamscan` 每次冷启动 16–40 秒，2026-10-05）。
  const stored = await persistSecureUpload({ fileName, mimeType, buffer, scan });
  const fileId = id('file');
  const now = nowIso();
  await aq(
    `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [fileId, 'USER', ownerOrgId, ownerUserId, 'INTERNAL_PROXY', null, stored.storageKey,
      `/api/student/file-assets/${fileId}/download`, null, stored.fileName, stored.mimeType, stored.fileSize,
      stored.checksum, 'GENERAL', 'PRIVATE', 'ACTIVE', 'NOT_REQUIRED', null,
      // ⚠️⚠️ 2026-09-30（生产 P1，用户报「图片/视频还是不展示」）：
      //    **`storageBackend` 必须记下来** —— 它是"这一行的字节在本地盘还是 OSS"的**唯一判据**
      //    （见 `fileStorage.js` 的 `rowStorageBackend`：缺省一律当**本地盘**）。
      //    这里原来漏了这个字段：字节被 `persistUploadBytes` 写进了 OSS，而读面按"本地盘"去找
      //    → `stat` 找不到 → `404 FILE_STORAGE_NOT_FOUND`（老师端预览一张图都取不到、分享卡同样）。
      //    生成产物那条路（上面 `createUploadedFileAsset` / `storeGeneratedAsset`）都带着它，只有
      //    **学生工作区素材**（客户端交作品随带的本地图/视频）这一条漏了。
      json({ ...metadata, source: 'STUDENT_RUNTIME', security: stored.security, storageBackend: stored.storageBackend || 'local' }), ownerUserId, now, now],
  );
  return {
    id: fileId,
    url: `/api/student/file-assets/${fileId}/download`,
    fileName: stored.fileName, mimeType: stored.mimeType, bytes: stored.fileSize,
  };
}

/**
 * 直传 OSS 的作品资产（2026-11-12）：字节已经在 OSS 上，这里只登记 file_assets 行。
 * `storageKey` 是带 OSS_PREFIX 的完整键；读面按 storageBackend=oss 302 到签名地址。
 */
export async function registerDirectUploadedAsset({
  storageKey, fileName, mimeType, size, checksum = null,
  ownerUserId, ownerOrgId = null, security = null, metadata = {},
}) {
  const fileId = id('file');
  const now = nowIso();
  const bytes = Number(size) || 0;
  await aq(
    `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [fileId, 'USER', ownerOrgId, ownerUserId, 'INTERNAL_PROXY', null, storageKey,
      `/api/student/file-assets/${fileId}/download`, null, fileName, mimeType, bytes, checksum,
      'GENERAL', 'PRIVATE', 'ACTIVE', 'NOT_REQUIRED', null,
      json({ ...metadata, source: 'STUDENT_RUNTIME', directUpload: true, storageBackend: 'oss', security }),
      ownerUserId, now, now],
  );
  return {
    id: fileId,
    url: `/api/student/file-assets/${fileId}/download`,
    fileName, mimeType, bytes,
  };
}

export async function handleAdminFileAssets(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/admin/file-assets')) return null;
  requirePlatformPermission(ctx, platformPermissionForPathname(pathname));
  const part = pathname.slice('/api/admin'.length);

  if (part === '/file-assets' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const category = String(ctx.search.get('category') || '').trim();
    const status = String(ctx.search.get('status') || '').trim();
    const visibility = String(ctx.search.get('visibility') || '').trim();
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const conditions = []; const params = [];
    if (category) { conditions.push('category=?'); params.push(category); }
    if (status) { conditions.push('status=?'); params.push(status); }
    if (visibility) { conditions.push('visibility=?'); params.push(visibility); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const items = (await arows(`SELECT * FROM file_assets ${where} ORDER BY created_at DESC LIMIT ${limit}`, params)).map(normalizeFileAsset);
    return { items, total: items.length, limit };
  }
  if (part === '/file-assets/upload' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    return createUploadedFileAsset(ctx, { auth, ownerType: 'PLATFORM', scope: 'admin', defaultVisibility: 'PRIVATE' });
  }
  if (part === '/file-assets' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const body = ctx.body || {};
    const storageKind = String(body.storageKind || 'EXTERNAL_URL').toUpperCase();
    const storage = validateStoragePayload(storageKind, body);
    const fileName = nonEmptyString(body.fileName, '文件名', { max: 500 });
    const category = String(body.category || 'GENERAL').toUpperCase();
    if (!CATEGORIES.has(category)) throw errors.badRequest('文件分类无效', 'INVALID_FILE_CATEGORY');
    const visibility = validateVisibility(String(body.visibility || 'PRIVATE').toUpperCase(), body.audience || {});
    const audience = body.audience || {};
    const orgIds = visibility === 'ASSIGNED_ORGS' ? await validateAudienceOrgIds(audience.orgIds) : [];
    const reviewStatus = String(body.reviewStatus || 'NOT_REQUIRED').toUpperCase();
    if (!REVIEW_STATUSES.has(reviewStatus)) throw errors.badRequest('reviewStatus 无效', 'INVALID_REVIEW_STATUS');
    const mimeType = body.mimeType ? String(body.mimeType).trim().slice(0, 120) : null;
    const fileSize = body.fileSize == null ? null : integer(body.fileSize, '文件大小', { min: 0, max: 10 * 1024 * 1024 * 1024 });
    const checksum = body.checksum ? String(body.checksum).trim().slice(0, 128) : null;
    const expiresAt = parseOptionalIsoDate(body.expiresAt);
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const fileId = id('file');
    const now = nowIso();
    await aq(
      `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fileId, 'PLATFORM', null, null, storageKind, storage.storageUrl, storage.storageKey, storage.proxyRoute, body.publicPath ? String(body.publicPath).trim().slice(0, 500) : null, fileName, mimeType, fileSize, checksum, category, visibility, 'ACTIVE', reviewStatus, expiresAt, json(metadata), auth.user.id, now, now],
    );
    const created = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
    await syncFileGrants(fileId, created, { orgIds }, auth.user.id);
    await audit(ctx, 'FILE_ASSET_CREATE', 'FILE_ASSET', fileId, null, { category, visibility, storageKind });
    return normalizeFileAsset(created);
  }

  const downloadMatch = part.match(/^\/file-assets\/([^/]+)\/download$/);
  if (downloadMatch && method === 'GET') return prepareFileDownload(ctx, await authorizeFileAccess(ctx, downloadMatch[1], 'DOWNLOAD'));

  const idMatch = part.match(/^\/file-assets\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    const auth = requireRole(ctx, ['SUPER_ADMIN', 'ORG_ADMIN', 'TEACHER', 'STUDENT']);
    return normalizeFileAsset(await authorizeFileAccess(ctx, idMatch[1], 'READ'));
  }
  if (idMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [idMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    const body = ctx.body || {};
    if (body.storageKind !== undefined || body.storageUrl !== undefined || body.storageKey !== undefined || body.proxyRoute !== undefined) {
      const storageKind = body.storageKind === undefined ? file.storage_kind : String(body.storageKind).toUpperCase();
      const storage = validateStoragePayload(storageKind, body);
      await aq('UPDATE file_assets SET storage_kind=?, storage_url=?, storage_key=?, proxy_route=?, updated_at=? WHERE id=?', [storageKind, storage.storageUrl, storage.storageKey, storage.proxyRoute, nowIso(), file.id]);
    }
    if (body.fileName !== undefined) await aq('UPDATE file_assets SET file_name=?, updated_at=? WHERE id=?', [nonEmptyString(body.fileName, '文件名', { max: 500 }), nowIso(), file.id]);
    if (body.mimeType !== undefined) await aq('UPDATE file_assets SET mime_type=?, updated_at=? WHERE id=?', [body.mimeType ? String(body.mimeType).trim().slice(0, 120) : null, nowIso(), file.id]);
    if (body.checksum !== undefined) await aq('UPDATE file_assets SET checksum=?, updated_at=? WHERE id=?', [body.checksum ? String(body.checksum).trim().slice(0, 128) : null, nowIso(), file.id]);
    if (body.visibility !== undefined) {
      const visibility = validateVisibility(String(body.visibility).toUpperCase(), body.audience || {});
      await aq('UPDATE file_assets SET visibility=?, updated_at=? WHERE id=?', [visibility, nowIso(), file.id]);
      const audience = body.audience || {};
      const orgIds = visibility === 'ASSIGNED_ORGS' ? await validateAudienceOrgIds(audience.orgIds) : [];
      const updated = await arow('SELECT * FROM file_assets WHERE id=?', [file.id]);
      await syncFileGrants(file.id, updated, { orgIds }, auth.user.id);
    }
    if (body.reviewStatus !== undefined) {
      const reviewStatus = String(body.reviewStatus).toUpperCase();
      if (!REVIEW_STATUSES.has(reviewStatus)) throw errors.badRequest('reviewStatus 无效', 'INVALID_REVIEW_STATUS');
      await assertTransition(ctx, 'fileReview', file.review_status, reviewStatus, { targetType: 'FILE_REVIEW', targetId: file.id, before: file, allowSameState: true });
      await aq('UPDATE file_assets SET review_status=?, updated_at=? WHERE id=?', [reviewStatus, nowIso(), file.id]);
    }
    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase();
      if (!['PENDING', 'ACTIVE', 'DISABLED', 'REMOVED'].includes(status)) throw errors.badRequest('status 无效', 'INVALID_FILE_STATUS');
      await assertTransition(ctx, 'fileAsset', file.status, status, { targetType: 'FILE_ASSET', targetId: file.id, before: file, allowSameState: true });
      await aq('UPDATE file_assets SET status=?, updated_at=? WHERE id=?', [status, nowIso(), file.id]);
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = parseOptionalIsoDate(body.expiresAt);
      await aq('UPDATE file_assets SET expires_at=?, updated_at=? WHERE id=?', [expiresAt, nowIso(), file.id]);
    }
    await audit(ctx, 'FILE_ASSET_UPDATE', 'FILE_ASSET', file.id, normalizeFileAsset(file), body);
    return normalizeFileAsset(await arow('SELECT * FROM file_assets WHERE id=?', [file.id]));
  }
  if (idMatch && method === 'DELETE') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [idMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    await assertTransition(ctx, 'fileAsset', file.status, 'REMOVED', { targetType: 'FILE_ASSET', targetId: file.id, before: file });
    await aq("UPDATE file_assets SET status='REMOVED', updated_at=? WHERE id=?", [nowIso(), file.id]);
    await aq('DELETE FROM file_access_grants WHERE file_id=?', [file.id]);
    await audit(ctx, 'FILE_ASSET_REMOVE', 'FILE_ASSET', file.id, normalizeFileAsset(file), null);
    return { id: file.id, status: 'REMOVED' };
  }

  // 单文件授权管理
  const grantsMatch = part.match(/^\/file-assets\/([^/]+)\/grants$/);
  if (grantsMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const fileId = grantsMatch[1];
    const file = await arow('SELECT id FROM file_assets WHERE id=?', [fileId]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    const grants = (await arows('SELECT * FROM file_access_grants WHERE file_id=? ORDER BY created_at DESC', [fileId])).map(normalizeGrant);
    return { items: grants, total: grants.length };
  }
  if (grantsMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const fileId = grantsMatch[1];
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    const body = ctx.body || {};
    const grantType = String(body.grantType || '').toUpperCase();
    if (!GRANT_TYPES.has(grantType)) throw errors.badRequest('grantType 无效', 'INVALID_GRANT_TYPE');
    const permission = String(body.permission || 'READ').toUpperCase();
    if (!['READ', 'DOWNLOAD'].includes(permission)) throw errors.badRequest('permission 无效', 'INVALID_PERMISSION');
    const role = body.role ? String(body.role).toUpperCase() : null;
    if (grantType === 'ROLE' && !['ORG_ADMIN', 'TEACHER', 'STUDENT'].includes(role || '')) throw errors.badRequest('role 无效', 'INVALID_ROLE');
    const orgId = body.orgId || null;
    // 角色授权必须绑定机构，否则一个机构的 STUDENT/TEACHER 角色会意外获得所有机构的文件。
    if (grantType === 'ROLE' && !orgId) throw errors.badRequest('ROLE 授权必须提供 orgId', 'ORG_REQUIRED');
    if (grantType === 'ORG' && !orgId) throw errors.badRequest('ORG 授权必须提供 orgId', 'ORG_REQUIRED');
    if (orgId && !await arow('SELECT id FROM organizations WHERE id=?', [orgId])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    const userId = body.userId || null;
    if (grantType === 'USER' && !userId) throw errors.badRequest('USER 授权必须提供 userId', 'USER_REQUIRED');
    const grantedUser = userId ? await arow('SELECT id,org_id FROM users WHERE id=?', [userId]) : null;
    if (userId && !grantedUser) throw errors.badRequest('用户不存在', 'USER_NOT_FOUND');
    if (grantType === 'USER' && orgId && grantedUser.org_id !== orgId) throw errors.badRequest('用户不属于指定机构', 'USER_ORG_MISMATCH');
    const expiresAt = parseOptionalIsoDate(body.expiresAt);
    const grantId = id('fag');
    const now = nowIso();
    await aq('INSERT INTO file_access_grants(id,file_id,grant_type,org_id,user_id,role,permission,granted_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [grantId, fileId, grantType, orgId, userId, role, permission, auth.user.id, expiresAt, now]);
    await audit(ctx, 'FILE_ACCESS_GRANT_CREATE', 'FILE_ACCESS_GRANT', grantId, null, { fileId, grantType, permission });
    return normalizeGrant(await arow('SELECT * FROM file_access_grants WHERE id=?', [grantId]));
  }
  const grantDelMatch = part.match(/^\/file-assets\/([^/]+)\/grants\/([^/]+)$/);
  if (grantDelMatch && method === 'DELETE') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const fileId = grantDelMatch[1]; const grantId = grantDelMatch[2];
    const target = await arow('SELECT * FROM file_access_grants WHERE id=? AND file_id=?', [grantId, fileId]);
    if (!target) throw errors.notFound('授权不存在', 'GRANT_NOT_FOUND');
    await aq('DELETE FROM file_access_grants WHERE id=?', [grantId]);
    await audit(ctx, 'FILE_ACCESS_GRANT_DELETE', 'FILE_ACCESS_GRANT', grantId, normalizeGrant(target), null);
    return { id: grantId };
  }
  return null;
}

/**
 * 在线预览：与下载**同一套落盘读取与 Range 处理**，但有两点关键差别 ——
 *   ① `content-disposition: inline`（浏览器直接渲染，不弹下载）；
 *   ② Office 文档先转成 PDF 再发，**原始 .pptx/.docx 不出服务器**。
 * 用户口径 A（2026-09-15）：机构/老师只能在线看。
 * ⚠️ 边界：能渲染就能被录屏/截屏，这是 web 的物理限制；这里保证的是「没有下载入口 +
 *    链接带短时票据 + 原始 Office 文件不外发」。
 */
export async function prepareFilePreview(ctx, file, { ossOffload = false } = {}) {
  const kind = previewKindFor({ mimeType: file.mime_type, fileName: file.file_name });
  let servePath = null;
  let mimeType = file.mime_type || 'application/octet-stream';
  if (file.storage_kind !== 'INTERNAL_PROXY') throw errors.badRequest('这份素材没有可预览的文件', 'PREVIEW_UNAVAILABLE');
  // 2026-11-02：占位行 → 等归档完成后重来（否则预览在"刚生成"的几秒里是 404）
  if (isPendingArchive(file)) {
    const fresh = await kickAndWaitArchive(file);
    if (fresh && String(fresh.storage_key || '').trim()) return prepareFilePreview(ctx, fresh, { ossOffload });
    const archive = parseJson(file.metadata, {})?.archive || {};
    return proxyUpstreamBytes(ctx, String(archive.sourceUrl), { fallbackMime: file.mime_type || '' });
  }
  const root = uploadRoot();
  const storageKey = String(file.storage_key || '').replaceAll('\\', '/');
  if (!storageKey || storageKey.startsWith('/') || /^[A-Za-z]:/.test(storageKey) || storageKey.split('/').includes('..')) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');

  // ⭐ 2026-09-25：OSS 行 + 调用方允许跳转 → **302 到签名地址，字节不过这台机**
  //    （这台机公网出口只有 5 Mbps；一份课件转出来的 PDF 有几 MB 到几十 MB，
  //     从这儿流出去就是全班一起等。口径见交接 §〇 ⭐4）。
  //    `ossOffload` 是**调用方**显式打开的：只有自己渲染的页面才用得上（pdf.js 走 fetch、
  //    桶上配了 CORS）。把预览地址塞进 `<iframe>` 的地方（平台端作品文件）不能跳 ——
  //    站点 CSP 的 `default-src 'self'` 会把跨域 iframe 直接挡掉，那是白屏不是预览。
  const ossRow = rowStorageBackend(file) === 'oss';
  const offloadPossible = ossRow && ossOffload && ossConfigured();
  const redirect = (url) => ({
    __fileResponse: true, status: 302,
    // 10 分钟内重复打开直接命中缓存（签名本身 1 小时有效，缓存的跳转目标仍然可用）
    headers: { 'cache-control': 'private, max-age=600', 'x-content-type-options': 'nosniff' },
    redirectUrl: url,
  });
  if (offloadPossible) {
    if (!needsConversion(kind)) {
      const url = ossRedirectUrl(file, { expires: PREVIEW_LINK_TTL_SECONDS });
      if (url) return redirect(url);
    } else {
      // 已经转好并推上 OSS 的这一份 —— 连 LibreOffice 都不用跑
      const published = await previewPdfInOss(file.id, file.file_size);
      if (published) {
        const url = signedUrl(published, { expires: PREVIEW_LINK_TTL_SECONDS });
        if (url) return redirect(url);
      }
    }
  }

  // OSS 行：预览必须先把对象取到本地 —— Office 转换（LibreOffice）只认本地文件路径。
  // 落到 uploads 下的一个缓存目录（该目录不在 web 根内），文件名用 file.id，同一份只下一次。
  let absolute;
  if (ossRow) {
    const scratch = path.resolve(root, '.oss-preview-cache', `${file.id}${path.extname(storageKey) || ''}`);
    try {
      absolute = await materializeObject(file, scratch);
    } catch (error) {
      console.warn('[preview] 从 OSS 取对象失败：', error?.message || error);
      throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
    }
  } else {
    absolute = path.resolve(root, storageKey);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
  }
  if (needsConversion(kind)) {
    const converted = await ensurePreviewPdf({ sourcePath: absolute, cacheKey: file.id });
    // 转不出来就明说「无法预览」，**绝不回退去发原始 Office 文件** —— 那等于把下载又放回来了
    if (!converted) throw errors.badRequest('这份课件暂时无法在线预览（转换失败），请联系平台', 'PREVIEW_CONVERSION_FAILED');
    servePath = converted; mimeType = 'application/pdf';
    // 转好之后顺手推一份到 OSS：这一次请求不必等它（下面照旧从本地发），
    // 从此**每一次**预览都是 302 —— 本机不再搬课件字节。
    if (offloadPossible) {
      const published = await publishPreviewPdf({ fileId: file.id, pdfPath: converted, sourceSize: file.file_size });
      if (published) {
        const url = signedUrl(published, { expires: PREVIEW_LINK_TTL_SECONDS });
        if (url) return redirect(url);
      }
    }
  } else {
    servePath = absolute;
  }
  let info;
  try { info = await stat(servePath); } catch { throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND'); }
  const total = info.size;
  const rangeHeader = String(ctx.req.headers.range || '');
  let start = 0; let end = total - 1; let status = 200;
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (match) {
      if (match[1]) start = Number(match[1]); else { const suffix = Number(match[2]); start = suffix > 0 ? Math.max(total - suffix, 0) : 0; }
      end = match[2] && match[1] ? Number(match[2]) : total - 1;
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && start < total) { end = Math.min(end, total - 1); status = 206; } else { start = 0; end = total - 1; }
    }
  }
  return {
    __fileResponse: true, status,
    headers: {
      'content-type': mimeType,
      'content-length': String(end - start + 1),
      // 关键差别：inline，且不带 filename —— 界面上不给「另存为」的入口
      'content-disposition': 'inline',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      // 预览是**在我们自己的页面里 iframe 打开的**，所以必须显式声明允许同源内嵌：
      // 默认安全头是 x-frame-options: DENY（见 lib.js 的 securityHeaders），浏览器会直接拒收这个 iframe
      // （教师看到的是「iicili.cyou 拒绝了我们的连接请求」）。这里覆盖成 SAMEORIGIN，
      // nginx 那边也对 /api/**/preview 做了同样放行 —— 两处都要，因为两边都会加这个头。
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'self'",
      ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${total}` } : {}),
      'cache-control': 'private, no-store',
    },
    stream: createReadStream(servePath, { start, end }),
  };
}

/**
 * 取**原始文件**（不转换）—— 只给能在浏览器里原生渲染的形态（`.pptx`）。
 *
 * 为什么单开一条（2026-09-25）：用户口径要「PowerPoint 原生渲染效果」，而原生渲染必须让浏览器
 * 拿到 .pptx 自己解析（形状/文字/图片都在 XML 里）。这条与 `prepareFilePreview` 的区别就是
 * **不做转换**：OSS 行 302 到对象自己的签名地址（106MB 的课件也从 OSS 直取，不吃本机 5 Mbps），
 * 本地行照旧流式发。
 *
 * ⚠️ 授权与 `/preview` **完全同一套**（票据 + 会话兜底 + 角色），别在这里放宽 ——
 *    它的产物是原始文件，比转出来的 PDF 更"重"。
 * ⚠️ 只认 pptx：其它格式一律 400。别做成"通用原始文件下载口"，那等于把下载入口又开回来了。
 */
export async function prepareFileSource(ctx, file) {
  if (file.storage_kind !== 'INTERNAL_PROXY') throw errors.badRequest('这份素材没有可取的文件', 'SOURCE_UNAVAILABLE');
  if (!canRenderNatively({ mimeType: file.mime_type, fileName: file.file_name })) {
    throw errors.badRequest('这种格式不支持原生预览', 'SOURCE_NOT_RENDERABLE');
  }
  if (rowStorageBackend(file) === 'oss') {
    const url = ossRedirectUrl(file, { expires: PREVIEW_LINK_TTL_SECONDS });
    if (!url) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
    return { __fileResponse: true, status: 302, headers: { 'cache-control': 'private, max-age=600', 'x-content-type-options': 'nosniff' }, redirectUrl: url };
  }
  const root = uploadRoot();
  const storageKey = String(file.storage_key || '').replaceAll('\\', '/');
  if (!storageKey || storageKey.startsWith('/') || /^[A-Za-z]:/.test(storageKey) || storageKey.split('/').includes('..')) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
  const absolute = path.resolve(root, storageKey);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND');
  let info;
  try { info = await stat(absolute); } catch { throw errors.notFound('文件存储对象不存在', 'FILE_STORAGE_NOT_FOUND'); }
  return {
    __fileResponse: true, status: 200,
    headers: {
      'content-type': file.mime_type || 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'content-length': String(info.size),
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
    stream: createReadStream(absolute),
  };
}

export async function handleOrgFileAssets(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/org/file-assets')) return null;
  const part = pathname.slice('/api/org'.length);

  // 预览路由放在 requireRole 之前：它靠**短时票据**放行（老师看课件时 <iframe>/<video> 不会带
  // Authorization 头，而票据就在 URL 上），票据无效才回落到正常会话鉴权。
  const previewMatch = part.match(/^\/file-assets\/([^/]+)\/preview$/);
  if (previewMatch && method === 'GET') {
    const fileId = previewMatch[1];
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    const ticketOk = verifyPreviewTicket(fileId, ctx.search.get('t'));
    if (!ticketOk) {
      const session = requireRole(ctx, ['ORG_ADMIN', 'TEACHER', 'STUDENT']);
      if (!session.user.orgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');
      await authorizeFileAccess(ctx, fileId, 'READ');
    }
    await audit(ctx, 'FILE_PREVIEW', 'FILE_ASSET', file.id, null, { ticket: ticketOk });
    // ⭐ 这一条**允许 302 到 OSS**：老师的预览器是自己渲染的（pdf.js 走 fetch 读 PDF、
    //    图片/视频是 <img>/<video>），两样都跟得上跨域跳转。别的地方（作品文件走 <iframe>）
    //    不能跳 —— 站点 CSP 的 default-src 'self' 会把跨域 iframe 挡成白屏。
    return await prepareFilePreview(ctx, file, { ossOffload: true });
  }

  // 原始文件（原生渲染用）：鉴权口径与 /preview **一字不差**，只是不做转换。见 prepareFileSource。
  const sourceMatch = part.match(/^\/file-assets\/([^/]+)\/preview-source$/);
  if (sourceMatch && method === 'GET') {
    const fileId = sourceMatch[1];
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    const ticketOk = verifyPreviewTicket(fileId, ctx.search.get('t'));
    if (!ticketOk) {
      const session = requireRole(ctx, ['ORG_ADMIN', 'TEACHER', 'STUDENT']);
      if (!session.user.orgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');
      await authorizeFileAccess(ctx, fileId, 'READ');
    }
    await audit(ctx, 'FILE_PREVIEW_SOURCE', 'FILE_ASSET', file.id, null, { ticket: ticketOk, native: true });
    return await prepareFileSource(ctx, file);
  }

  const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER', 'STUDENT']);
  const currentOrgId = auth.user.orgId;
  if (!currentOrgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');

  // 现取一张预览票据（2026-09-17）：抽屉可能是几小时前打开的，payload 里那张早过期了。
  // 老师**点开素材那一刻**再来拿一张新鲜的，于是「课包里的素材随时能看」不依赖任何长时链接。
  const ticketMatch = part.match(/^\/file-assets\/([^/]+)\/preview-ticket$/);
  if (ticketMatch && method === 'GET') {
    const file = await authorizeFileAccess(ctx, ticketMatch[1], 'READ');
    return await previewInfoFor(file.id);
  }

  // 备课画布（老师端）也一次签完素材直链；URL 前缀是 /api/org/file-assets/...。
  if (part === '/file-assets/sign' && method === 'POST') {
    return await signFileAssetUrls(ctx, ctx.body?.urls);
  }

  if (part === '/file-assets' && method === 'GET') {
    const category = String(ctx.search.get('category') || '').trim();
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const conditions = [
      "(visibility='ASSIGNED_ORGS' AND EXISTS (SELECT 1 FROM file_access_grants g WHERE g.file_id=file_assets.id AND g.org_id=? AND g.grant_type='ORG'))",
      "OR (visibility='ORG' AND owner_org_id=?)",
      "OR owner_org_id=?",
      "OR visibility='PUBLIC_PLATFORM'",
    ];
    const where = `WHERE (${conditions.join(' ')}) AND category<>'TEACHING_ASSET' ${category ? 'AND category=?' : ''}`;
    const params = [currentOrgId, currentOrgId, currentOrgId];
    if (category) params.push(category);
    const items = (await arows(`SELECT DISTINCT file_assets.* FROM file_assets ${where} ORDER BY created_at DESC LIMIT ${limit}`, params)).map(normalizeFileAsset);
    return { items, total: items.length, limit };
  }
  if (part === '/file-assets/upload' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可上传文件', 'ORG_ADMIN_REQUIRED');
    return createUploadedFileAsset(ctx, { auth, ownerType: 'ORG', ownerOrgId: currentOrgId, scope: 'org', defaultVisibility: 'ORG' });
  }
  if (part === '/file-assets' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可上传文件', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {};
    const storageKind = String(body.storageKind || 'EXTERNAL_URL').toUpperCase();
    const storage = validateStoragePayload(storageKind, body);
    const fileName = nonEmptyString(body.fileName, '文件名', { max: 500 });
    const category = String(body.category || 'GENERAL').toUpperCase();
    if (!CATEGORIES.has(category)) throw errors.badRequest('文件分类无效', 'INVALID_FILE_CATEGORY');
    const visibility = validateVisibility(String(body.visibility || 'ORG').toUpperCase(), body.audience || {});
    if (!['ORG', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibility)) throw errors.badRequest('机构文件仅允许 PRIVATE/ORG/ASSIGNED_ORGS', 'INVALID_ORG_VISIBILITY');
    const audience = body.audience || {};
    let orgIds = visibility === 'ASSIGNED_ORGS' ? await validateAudienceOrgIds(audience.orgIds) : [];
    if (visibility === 'ASSIGNED_ORGS' && !orgIds.includes(currentOrgId)) orgIds = [currentOrgId, ...orgIds];
    const reviewStatus = String(body.reviewStatus || 'NOT_REQUIRED').toUpperCase();
    if (!REVIEW_STATUSES.has(reviewStatus)) throw errors.badRequest('reviewStatus 无效', 'INVALID_REVIEW_STATUS');
    const mimeType = body.mimeType ? String(body.mimeType).trim().slice(0, 120) : null;
    const fileSize = body.fileSize == null ? null : integer(body.fileSize, '文件大小', { min: 0, max: 10 * 1024 * 1024 * 1024 });
    const checksum = body.checksum ? String(body.checksum).trim().slice(0, 128) : null;
    const expiresAt = parseOptionalIsoDate(body.expiresAt);
    const fileId = id('file');
    const now = nowIso();
    await aq(
      `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fileId, 'ORG', currentOrgId, null, storageKind, storage.storageUrl, storage.storageKey, storage.proxyRoute, body.publicPath ? String(body.publicPath).trim().slice(0, 500) : null, fileName, mimeType, fileSize, checksum, category, visibility, 'ACTIVE', reviewStatus, expiresAt, json({}), auth.user.id, now, now],
    );
    const created = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
    await syncFileGrants(fileId, created, { orgIds }, auth.user.id);
    await audit(ctx, 'FILE_ASSET_CREATE', 'FILE_ASSET', fileId, null, { category, visibility, storageKind }, { orgId: currentOrgId });
    return normalizeFileAsset(created);
  }

  const idMatch = part.match(/^\/file-assets\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    return normalizeFileAsset(await authorizeFileAccess(ctx, idMatch[1], 'READ'));
  }
  if (idMatch && method === 'PUT') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可更新文件', 'ORG_ADMIN_REQUIRED');
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [idMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.owner_type !== 'ORG' || file.owner_org_id !== currentOrgId) throw errors.forbidden('只能修改本机构文件', 'FILE_OWNER_REQUIRED');
    const body = ctx.body || {};
    if (body.storageKind !== undefined || body.storageUrl !== undefined || body.storageKey !== undefined || body.proxyRoute !== undefined) {
      const storageKind = body.storageKind === undefined ? file.storage_kind : String(body.storageKind).toUpperCase();
      const storage = validateStoragePayload(storageKind, body);
      await aq('UPDATE file_assets SET storage_kind=?, storage_url=?, storage_key=?, proxy_route=?, updated_at=? WHERE id=?', [storageKind, storage.storageUrl, storage.storageKey, storage.proxyRoute, nowIso(), file.id]);
    }
    if (body.fileName !== undefined) await aq('UPDATE file_assets SET file_name=?, updated_at=? WHERE id=?', [nonEmptyString(body.fileName, '文件名', { max: 500 }), nowIso(), file.id]);
    if (body.mimeType !== undefined) await aq('UPDATE file_assets SET mime_type=?, updated_at=? WHERE id=?', [body.mimeType ? String(body.mimeType).trim().slice(0, 120) : null, nowIso(), file.id]);
    if (body.checksum !== undefined) await aq('UPDATE file_assets SET checksum=?, updated_at=? WHERE id=?', [body.checksum ? String(body.checksum).trim().slice(0, 128) : null, nowIso(), file.id]);
    if (body.visibility !== undefined) {
      const visibility = validateVisibility(String(body.visibility).toUpperCase(), body.audience || {});
      if (!['ORG', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibility)) throw errors.badRequest('机构文件仅允许 PRIVATE/ORG/ASSIGNED_ORGS', 'INVALID_ORG_VISIBILITY');
      await aq('UPDATE file_assets SET visibility=?, updated_at=? WHERE id=?', [visibility, nowIso(), file.id]);
      const audience = body.audience || {};
      let orgIds = visibility === 'ASSIGNED_ORGS' ? await validateAudienceOrgIds(audience.orgIds) : [];
      if (visibility === 'ASSIGNED_ORGS' && !orgIds.includes(currentOrgId)) orgIds = [currentOrgId, ...orgIds];
      const updated = await arow('SELECT * FROM file_assets WHERE id=?', [file.id]);
      await syncFileGrants(file.id, updated, { orgIds }, auth.user.id);
    }
    if (body.reviewStatus !== undefined) {
      const reviewStatus = String(body.reviewStatus).toUpperCase();
      if (!REVIEW_STATUSES.has(reviewStatus)) throw errors.badRequest('reviewStatus 无效', 'INVALID_REVIEW_STATUS');
      await assertTransition(ctx, 'fileReview', file.review_status, reviewStatus, { targetType: 'FILE_REVIEW', targetId: file.id, before: file, allowSameState: true });
      await aq('UPDATE file_assets SET review_status=?, updated_at=? WHERE id=?', [reviewStatus, nowIso(), file.id]);
    }
    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase();
      if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('status 无效', 'INVALID_FILE_STATUS');
      await assertTransition(ctx, 'fileAsset', file.status, status, { targetType: 'FILE_ASSET', targetId: file.id, before: file, allowSameState: true });
      await aq('UPDATE file_assets SET status=?, updated_at=? WHERE id=?', [status, nowIso(), file.id]);
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = parseOptionalIsoDate(body.expiresAt);
      await aq('UPDATE file_assets SET expires_at=?, updated_at=? WHERE id=?', [expiresAt, nowIso(), file.id]);
    }
    await audit(ctx, 'FILE_ASSET_UPDATE', 'FILE_ASSET', file.id, normalizeFileAsset(file), body, { orgId: currentOrgId });
    return normalizeFileAsset(await arow('SELECT * FROM file_assets WHERE id=?', [file.id]));
  }
  if (idMatch && method === 'DELETE') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可删除文件', 'ORG_ADMIN_REQUIRED');
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [idMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.owner_type !== 'ORG' || file.owner_org_id !== currentOrgId) throw errors.forbidden('只能删除本机构文件', 'FILE_OWNER_REQUIRED');
    await assertTransition(ctx, 'fileAsset', file.status, 'REMOVED', { targetType: 'FILE_ASSET', targetId: file.id, before: file });
    await aq("UPDATE file_assets SET status='REMOVED', updated_at=? WHERE id=?", [nowIso(), file.id]);
    await aq('DELETE FROM file_access_grants WHERE file_id=?', [file.id]);
    await audit(ctx, 'FILE_ASSET_REMOVE', 'FILE_ASSET', file.id, normalizeFileAsset(file), null, { orgId: currentOrgId });
    return { id: file.id, status: 'REMOVED' };
  }

  // 文件访问代理下载（先授权，再从 Web 根目录外流式输出）
  const proxyMatch = part.match(/^\/file-assets\/([^/]+)\/download$/);
  if (proxyMatch && method === 'GET') return prepareFileDownload(ctx, await authorizeFileAccess(ctx, proxyMatch[1], 'DOWNLOAD'));
  return null;
}

export async function handleStudentFileAssets(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/student/file-assets')) return null;
  const part = pathname.slice('/api/student'.length);
  const auth = requireRole(ctx, ['STUDENT']);
  const currentOrgId = auth.user.orgId;
  if (!currentOrgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');

  if (part === '/file-assets' && method === 'GET') {
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const items = (await arows(
      `SELECT DISTINCT file_assets.* FROM file_assets
       WHERE ((visibility='ASSIGNED_ORGS' AND EXISTS (SELECT 1 FROM file_access_grants g WHERE g.file_id=file_assets.id AND g.org_id=? AND g.grant_type='ORG'))
          OR (visibility='ORG' AND owner_org_id=?)
          OR (visibility='PRIVATE' AND owner_user_id=?)
          OR visibility='PUBLIC_PLATFORM')
         AND category<>'TEACHING_ASSET'
       ORDER BY created_at DESC LIMIT ${limit}`,
      [currentOrgId, currentOrgId, auth.user.id],
    )).map(normalizeFileAsset);
    return { items, total: items.length, limit };
  }
  if (part === '/file-assets/upload' && method === 'POST') {
    // 学生把桌面上的图片/视频/音频拖进画布时上传：归属本人、仅自己可见（PRIVATE）。
    // 扩展名/魔术字节/大小/频次校验复用与管理端同一套 persistSecureUpload + reserveUpload。
    return createUploadedFileAsset(ctx, { auth, ownerType: 'USER', ownerOrgId: currentOrgId, scope: 'student', defaultVisibility: 'PRIVATE' });
  }
  // 画布打开时一次签完所有素材直链（见 signFileAssetUrls）；必须放在 `/:id` 之前，否则会被当成 fileId。
  if (part === '/file-assets/sign' && method === 'POST') {
    return await signFileAssetUrls(ctx, ctx.body?.urls);
  }
  const idMatch = part.match(/^\/file-assets\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    return normalizeFileAsset(await authorizeFileAccess(ctx, idMatch[1], 'READ'));
  }
  const proxyMatch = part.match(/^\/file-assets\/([^/]+)\/download$/);
  if (proxyMatch && method === 'GET') return prepareFileDownload(ctx, await authorizeFileAccess(ctx, proxyMatch[1], 'DOWNLOAD'));
  // 预览口（2026-09-20）：「我的作品」打开一件真文件产物（学生创作环境交上来的 PPT/Word/Excel）时
  // 要给服务端**转出来的 PDF**，否则 iframe 里塞原文件只会触发下载。
  // 权限与下载同一档（都是自己的文件）；鉴权头之外还有 cookie 兜底 —— iframe 发不出 Authorization。
  const previewMatch = part.match(/^\/file-assets\/([^/]+)\/preview$/);
  if (previewMatch && method === 'GET') return prepareFilePreview(ctx, await authorizeFileAccess(ctx, previewMatch[1], 'DOWNLOAD'));
  return null;
}

export async function handlePublicFileAssets(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/public/file-assets')) return null;
  const part = pathname.slice('/api/public'.length);

  const idMatch = part.match(/^\/file-assets\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [idMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
    if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    if (file.category === 'TEACHING_ASSET') throw errors.forbidden('教学素材不是公开资源', 'FILE_NOT_PUBLIC');
    if (file.visibility !== 'PUBLIC_PLATFORM' && file.visibility !== 'PUBLIC_RELEASE') {
      throw errors.forbidden('文件不是公开资源', 'FILE_NOT_PUBLIC');
    }
    return normalizeFileAsset(file);
  }

  const downloadMatch = part.match(/^\/file-assets\/([^/]+)\/download$/);
  if (downloadMatch && method === 'GET') {
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [downloadMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
    if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    if (file.category === 'TEACHING_ASSET') throw errors.forbidden('教学素材不是公开资源', 'FILE_NOT_PUBLIC');
    if (file.visibility !== 'PUBLIC_PLATFORM' && file.visibility !== 'PUBLIC_RELEASE') {
      throw errors.forbidden('文件不是公开资源', 'FILE_NOT_PUBLIC');
    }
    // ⭐ `?w=<px>`：图片**按宽度取缩略图**（2026-09-26，用户口径「保证官网的流畅度」）。
    // 背景：官网首页 CMS 里有几块配图直接引了上传原图（一张 3MB 的 PNG），首屏以下一共要拉 6MB。
    // 加 900px 之后同一张图变几十 KB（OSS 的 x-oss-process 现算，不用预先转码）。
    // ⚠️ 只对**图片**生效；带了这个参数就一定是"展示用"，不再当"下载原件"（缩略图不给 attachment）。
    const width = Number(ctx.search.get('w') || 0);
    const isImage = /^image\//.test(String(file.mime_type || ''));
    if (isImage && Number.isFinite(width) && width > 0) {
      const url = ossStableRedirectUrl(file, { windowSeconds: 7200, imageProcess: imageProcessFor(width) });
      if (url) {
        await audit(ctx, 'FILE_DOWNLOAD', 'FILE_ASSET', file.id, null, { storageBackend: 'oss', imageProcess: imageProcessFor(width) });
        return { __fileResponse: true, status: 302, headers: { 'cache-control': 'public, max-age=3600' }, redirectUrl: url };
      }
    }
    return prepareFileDownload(ctx, file);
  }

  return null;
}
