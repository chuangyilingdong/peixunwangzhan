// P4-C04 统一文件元数据与访问授权模型
// 提供：file_assets / file_access_grants 表的 CRUD + 授权校验 + 受保护文件流下载
import { createReadStream } from 'node:fs';
import { stat, rm } from 'node:fs/promises';
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
} from '../lib.js';
import { assertTransition } from '../services/domainState.js';
import { parseMultipartFormData, persistSecureUpload, uploadRoot } from '../services/fileUploadSecurity.js';
import { reserveUpload } from '../services/uploadLimits.js';

const STORAGE_KINDS = new Set(['EXTERNAL_URL', 'INTERNAL_PROXY', 'PENDING']);
const VISIBILITY_MODES = new Set(['PRIVATE', 'ORG', 'ASSIGNED_ORGS', 'PUBLIC_PLATFORM', 'PUBLIC_RELEASE']);
const CATEGORIES = new Set(['PROMO_MATERIAL', 'PROMO_COVER', 'CLIENT_INSTALLER', 'MEDIA_ASSET', 'GENERAL']);
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

function validateAudienceOrgIds(orgIds) {
  if (!Array.isArray(orgIds) || !orgIds.length) return [];
  const cleaned = [...new Set(orgIds.map((id) => String(id).trim()).filter(Boolean))];
  if (cleaned.length > 200) throw errors.badRequest('最多 200 个机构', 'TOO_MANY_ORGS');
  const placeholders = cleaned.map(() => '?').join(',');
  const found = rows(`SELECT id FROM organizations WHERE id IN (${placeholders})`, cleaned).map((r) => r.id);
  if (found.length !== cleaned.length) throw errors.badRequest('存在不存在的机构', 'INVALID_ORG_ID');
  return cleaned;
}

/**
 * 校验当前用户对指定 file_id 是否有 permission 权限（READ/DOWNLOAD）。
 * @param {Object} ctx - 路由上下文
 * @param {string} fileId
 * @param {string} permission - 'READ' | 'DOWNLOAD'
 * @returns {Object} file_assets 行
 */
export function authorizeFileAccess(ctx, fileId, permission = 'READ') {
  if (!ctx?.auth?.user) throw errors.forbidden('需要登录', 'SESSION_INVALID');
  const file = row('SELECT * FROM file_assets WHERE id=?', [fileId]);
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
  // 2. 公开可见
  if (file.visibility === 'PUBLIC_PLATFORM' || file.visibility === 'PUBLIC_RELEASE') return file;
  // 3. 所有者
  if (file.owner_type === 'USER' && file.owner_user_id === user.id) return file;
  if (file.owner_type === 'ORG' && file.owner_org_id === orgId) return file;
  // 4. 授权表匹配
  const grants = rows('SELECT * FROM file_access_grants WHERE file_id=?', [fileId]);
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
async function prepareFileDownload(ctx, file) {
  if (file.storage_kind !== 'INTERNAL_PROXY') {
    audit(ctx, 'FILE_DOWNLOAD', 'FILE_ASSET', file.id, null, { storageKind: file.storage_kind, external: true });
    return {
      id: file.id, fileName: file.file_name, mimeType: file.mime_type, fileSize: file.file_size,
      storageKind: file.storage_kind, storageUrl: file.storage_url, proxyRoute: file.proxy_route,
      publicPath: file.public_path,
      statement: 'EXTERNAL_URL 模式：客户端可直接使用已授权的 storageUrl。',
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
  audit(ctx, 'FILE_DOWNLOAD', 'FILE_ASSET', file.id, null, { storageKind: file.storage_kind, storageKey: file.storage_key, range: rangeHeader || null });
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

export function linkFileAsset({ fileId, businessType, businessId, audience, grantedBy }) {
  if (!fileId) return;
  const file = row('SELECT * FROM file_assets WHERE id=?', [fileId]);
  if (!file) return;
  const meta = parseJson(file.metadata, {});
  meta.linkedBusiness = { type: businessType, id: businessId };
  q('UPDATE file_assets SET metadata=?, updated_at=? WHERE id=?', [json(meta), nowIso(), fileId]);
  // 同步生成 grants：visibility → grants
  syncFileGrants(fileId, file, audience, grantedBy);
}

function syncFileGrants(fileId, file, audience, grantedBy) {
  const now = nowIso();
  q('DELETE FROM file_access_grants WHERE file_id=?', [fileId]);
  if (file.visibility === 'PUBLIC_PLATFORM' || file.visibility === 'PUBLIC_RELEASE') {
    q('INSERT INTO file_access_grants(id,file_id,grant_type,permission,granted_by,created_at) VALUES (?,?,?,?,?,?)', [id('fag'), fileId, 'PUBLIC', 'READ', grantedBy || null, now]);
    return;
  }
  if (file.visibility === 'ORG' && file.owner_org_id) {
    q('INSERT INTO file_access_grants(id,file_id,grant_type,org_id,permission,granted_by,created_at) VALUES (?,?,?,?,?,?,?)', [id('fag'), fileId, 'ORG', file.owner_org_id, 'READ', grantedBy || null, now]);
  }
  if (file.visibility === 'ASSIGNED_ORGS' && Array.isArray(audience?.orgIds)) {
    for (const oid of audience.orgIds) {
      q('INSERT INTO file_access_grants(id,file_id,grant_type,org_id,permission,granted_by,created_at) VALUES (?,?,?,?,?,?,?)', [id('fag'), fileId, 'ORG', oid, 'READ', grantedBy || null, now]);
    }
  }
  if (file.visibility === 'PRIVATE' && file.owner_user_id) {
    q('INSERT INTO file_access_grants(id,file_id,grant_type,user_id,permission,granted_by,created_at) VALUES (?,?,?,?,?,?,?)', [id('fag'), fileId, 'USER', file.owner_user_id, 'READ', grantedBy || null, now]);
  }
}

async function createUploadedFileAsset(ctx, { auth, ownerType, ownerOrgId = null, scope, defaultVisibility }) {
  const contentType = String(ctx.req.headers['content-type'] || '');
  let multipart = { fields: {}, file: null };
  try { multipart = parseMultipartFormData(ctx.rawBody || Buffer.alloc(0), contentType); }
  catch (error) {
    audit(ctx, 'FILE_UPLOAD_REJECTED', 'FILE_ASSET', null, null, { code: error?.code || 'INVALID_MULTIPART' }, ownerOrgId ? { orgId: ownerOrgId } : undefined);
    throw error;
  }
  const fields = multipart.fields;
  const category = String(fields.category || 'MEDIA_ASSET').toUpperCase();
  if (!CATEGORIES.has(category)) throw errors.badRequest('文件分类无效', 'INVALID_FILE_CATEGORY');
  const audience = fields.audience ? (() => { try { return JSON.parse(fields.audience); } catch { throw errors.badRequest('audience JSON 无效', 'INVALID_AUDIENCE'); } })() : {};
  const visibility = validateVisibility(String(fields.visibility || defaultVisibility).toUpperCase(), audience);
  if (ownerType === 'ORG' && !['ORG', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibility)) throw errors.badRequest('机构文件仅允许 PRIVATE/ORG/ASSIGNED_ORGS', 'INVALID_ORG_VISIBILITY');
  const orgIds = visibility === 'ASSIGNED_ORGS' ? validateAudienceOrgIds(audience.orgIds) : [];
  if (ownerType === 'ORG' && visibility === 'ASSIGNED_ORGS' && !orgIds.includes(ownerOrgId)) orgIds.unshift(ownerOrgId);
  const expiresAt = fields.expiresAt ? new Date(fields.expiresAt).toISOString() : null;
  if (fields.expiresAt && Number.isNaN(new Date(fields.expiresAt).getTime())) throw errors.badRequest('expiresAt 无效', 'INVALID_EXPIRES_AT');

  const releaseUpload = reserveUpload({ userId: auth.user.id, orgId: ownerOrgId || `platform:${ownerType}`, bytes: multipart.file?.buffer?.length || 0 });
  let stored;
  try {
    stored = await persistSecureUpload(multipart.file);
  } catch (error) {
    audit(ctx, 'FILE_UPLOAD_REJECTED', 'FILE_ASSET', null, null, {
      code: error?.code || 'UPLOAD_REJECTED', fileName: multipart.file?.fileName || null,
      mimeType: multipart.file?.mimeType || null, fileSize: multipart.file?.buffer?.length || 0,
    }, ownerOrgId ? { orgId: ownerOrgId } : undefined);
    releaseUpload();
    throw error;
  }
  try {
    const fileId = id('file');
    const now = nowIso();
    const metadata = { upload: { originalName: stored.fileName, security: stored.security, uploadedAt: now } };
    const proxyRoute = `/api/${scope}/file-assets/${fileId}/download`;
    q(
      `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fileId, ownerType, ownerOrgId, ownerType === 'USER' ? auth.user.id : null, 'INTERNAL_PROXY', null, stored.storageKey, proxyRoute, null, stored.fileName, stored.mimeType, stored.fileSize, stored.checksum, category, visibility, 'ACTIVE', 'NOT_REQUIRED', expiresAt, json(metadata), auth.user.id, now, now],
    );
    const created = row('SELECT * FROM file_assets WHERE id=?', [fileId]);
    syncFileGrants(fileId, created, { orgIds }, auth.user.id);
    audit(ctx, 'FILE_UPLOAD', 'FILE_ASSET', fileId, null, { category, visibility, mimeType: stored.mimeType, fileSize: stored.fileSize, checksum: stored.checksum, storageKey: stored.storageKey, scanner: stored.security }, ownerOrgId ? { orgId: ownerOrgId } : undefined);
    releaseUpload();
    return normalizeFileAsset(created);
  } catch (error) {
    if (stored?.storagePath) await rm(stored.storagePath, { force: true }).catch(() => {});
    releaseUpload();
    throw error;
  }
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
    const items = rows(`SELECT * FROM file_assets ${where} ORDER BY created_at DESC LIMIT ${limit}`, params).map(normalizeFileAsset);
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
    const orgIds = visibility === 'ASSIGNED_ORGS' ? validateAudienceOrgIds(audience.orgIds) : [];
    const reviewStatus = String(body.reviewStatus || 'NOT_REQUIRED').toUpperCase();
    if (!REVIEW_STATUSES.has(reviewStatus)) throw errors.badRequest('reviewStatus 无效', 'INVALID_REVIEW_STATUS');
    const mimeType = body.mimeType ? String(body.mimeType).trim().slice(0, 120) : null;
    const fileSize = body.fileSize == null ? null : integer(body.fileSize, '文件大小', { min: 0, max: 10 * 1024 * 1024 * 1024 });
    const checksum = body.checksum ? String(body.checksum).trim().slice(0, 128) : null;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
    if (body.expiresAt && Number.isNaN(new Date(body.expiresAt).getTime())) throw errors.badRequest('expiresAt 无效', 'INVALID_EXPIRES_AT');
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const fileId = id('file');
    const now = nowIso();
    q(
      `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fileId, 'PLATFORM', null, null, storageKind, storage.storageUrl, storage.storageKey, storage.proxyRoute, body.publicPath ? String(body.publicPath).trim().slice(0, 500) : null, fileName, mimeType, fileSize, checksum, category, visibility, 'ACTIVE', reviewStatus, expiresAt, json(metadata), auth.user.id, now, now],
    );
    const created = row('SELECT * FROM file_assets WHERE id=?', [fileId]);
    syncFileGrants(fileId, created, { orgIds }, auth.user.id);
    audit(ctx, 'FILE_ASSET_CREATE', 'FILE_ASSET', fileId, null, { category, visibility, storageKind });
    return normalizeFileAsset(created);
  }

  const idMatch = part.match(/^\/file-assets\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    const auth = requireRole(ctx, ['SUPER_ADMIN', 'ORG_ADMIN', 'TEACHER', 'STUDENT']);
    return normalizeFileAsset(authorizeFileAccess(ctx, idMatch[1], 'READ'));
  }
  if (idMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const file = row('SELECT * FROM file_assets WHERE id=?', [idMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    const body = ctx.body || {};
    if (body.storageKind !== undefined || body.storageUrl !== undefined || body.storageKey !== undefined || body.proxyRoute !== undefined) {
      const storageKind = body.storageKind === undefined ? file.storage_kind : String(body.storageKind).toUpperCase();
      const storage = validateStoragePayload(storageKind, body);
      q('UPDATE file_assets SET storage_kind=?, storage_url=?, storage_key=?, proxy_route=?, updated_at=? WHERE id=?', [storageKind, storage.storageUrl, storage.storageKey, storage.proxyRoute, nowIso(), file.id]);
    }
    if (body.fileName !== undefined) q('UPDATE file_assets SET file_name=?, updated_at=? WHERE id=?', [nonEmptyString(body.fileName, '文件名', { max: 500 }), nowIso(), file.id]);
    if (body.mimeType !== undefined) q('UPDATE file_assets SET mime_type=?, updated_at=? WHERE id=?', [body.mimeType ? String(body.mimeType).trim().slice(0, 120) : null, nowIso(), file.id]);
    if (body.checksum !== undefined) q('UPDATE file_assets SET checksum=?, updated_at=? WHERE id=?', [body.checksum ? String(body.checksum).trim().slice(0, 128) : null, nowIso(), file.id]);
    if (body.visibility !== undefined) {
      const visibility = validateVisibility(String(body.visibility).toUpperCase(), body.audience || {});
      q('UPDATE file_assets SET visibility=?, updated_at=? WHERE id=?', [visibility, nowIso(), file.id]);
      const audience = body.audience || {};
      const orgIds = visibility === 'ASSIGNED_ORGS' ? validateAudienceOrgIds(audience.orgIds) : [];
      const updated = row('SELECT * FROM file_assets WHERE id=?', [file.id]);
      syncFileGrants(file.id, updated, { orgIds }, auth.user.id);
    }
    if (body.reviewStatus !== undefined) {
      const reviewStatus = String(body.reviewStatus).toUpperCase();
      if (!REVIEW_STATUSES.has(reviewStatus)) throw errors.badRequest('reviewStatus 无效', 'INVALID_REVIEW_STATUS');
      assertTransition(ctx, 'fileReview', file.review_status, reviewStatus, { targetType: 'FILE_REVIEW', targetId: file.id, before: file, allowSameState: true });
      q('UPDATE file_assets SET review_status=?, updated_at=? WHERE id=?', [reviewStatus, nowIso(), file.id]);
    }
    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase();
      if (!['PENDING', 'ACTIVE', 'DISABLED', 'REMOVED'].includes(status)) throw errors.badRequest('status 无效', 'INVALID_FILE_STATUS');
      assertTransition(ctx, 'fileAsset', file.status, status, { targetType: 'FILE_ASSET', targetId: file.id, before: file, allowSameState: true });
      q('UPDATE file_assets SET status=?, updated_at=? WHERE id=?', [status, nowIso(), file.id]);
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
      if (body.expiresAt && Number.isNaN(new Date(body.expiresAt).getTime())) throw errors.badRequest('expiresAt 无效', 'INVALID_EXPIRES_AT');
      q('UPDATE file_assets SET expires_at=?, updated_at=? WHERE id=?', [expiresAt, nowIso(), file.id]);
    }
    audit(ctx, 'FILE_ASSET_UPDATE', 'FILE_ASSET', file.id, normalizeFileAsset(file), body);
    return normalizeFileAsset(row('SELECT * FROM file_assets WHERE id=?', [file.id]));
  }
  if (idMatch && method === 'DELETE') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const file = row('SELECT * FROM file_assets WHERE id=?', [idMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    assertTransition(ctx, 'fileAsset', file.status, 'REMOVED', { targetType: 'FILE_ASSET', targetId: file.id, before: file });
    q("UPDATE file_assets SET status='REMOVED', updated_at=? WHERE id=?", [nowIso(), file.id]);
    q('DELETE FROM file_access_grants WHERE file_id=?', [file.id]);
    audit(ctx, 'FILE_ASSET_REMOVE', 'FILE_ASSET', file.id, normalizeFileAsset(file), null);
    return { id: file.id, status: 'REMOVED' };
  }

  // 单文件授权管理
  const grantsMatch = part.match(/^\/file-assets\/([^/]+)\/grants$/);
  if (grantsMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const fileId = grantsMatch[1];
    const file = row('SELECT id FROM file_assets WHERE id=?', [fileId]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    const grants = rows('SELECT * FROM file_access_grants WHERE file_id=? ORDER BY created_at DESC', [fileId]).map(normalizeGrant);
    return { items: grants, total: grants.length };
  }
  if (grantsMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const fileId = grantsMatch[1];
    const file = row('SELECT * FROM file_assets WHERE id=?', [fileId]);
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
    if (orgId && !row('SELECT id FROM organizations WHERE id=?', [orgId])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    const userId = body.userId || null;
    if (grantType === 'USER' && !userId) throw errors.badRequest('USER 授权必须提供 userId', 'USER_REQUIRED');
    const grantedUser = userId ? row('SELECT id,org_id FROM users WHERE id=?', [userId]) : null;
    if (userId && !grantedUser) throw errors.badRequest('用户不存在', 'USER_NOT_FOUND');
    if (grantType === 'USER' && orgId && grantedUser.org_id !== orgId) throw errors.badRequest('用户不属于指定机构', 'USER_ORG_MISMATCH');
    const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
    if (body.expiresAt && Number.isNaN(new Date(body.expiresAt).getTime())) throw errors.badRequest('expiresAt 无效', 'INVALID_EXPIRES_AT');
    const grantId = id('fag');
    const now = nowIso();
    q('INSERT INTO file_access_grants(id,file_id,grant_type,org_id,user_id,role,permission,granted_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [grantId, fileId, grantType, orgId, userId, role, permission, auth.user.id, expiresAt, now]);
    audit(ctx, 'FILE_ACCESS_GRANT_CREATE', 'FILE_ACCESS_GRANT', grantId, null, { fileId, grantType, permission });
    return normalizeGrant(row('SELECT * FROM file_access_grants WHERE id=?', [grantId]));
  }
  const grantDelMatch = part.match(/^\/file-assets\/([^/]+)\/grants\/([^/]+)$/);
  if (grantDelMatch && method === 'DELETE') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const fileId = grantDelMatch[1]; const grantId = grantDelMatch[2];
    const target = row('SELECT * FROM file_access_grants WHERE id=? AND file_id=?', [grantId, fileId]);
    if (!target) throw errors.notFound('授权不存在', 'GRANT_NOT_FOUND');
    q('DELETE FROM file_access_grants WHERE id=?', [grantId]);
    audit(ctx, 'FILE_ACCESS_GRANT_DELETE', 'FILE_ACCESS_GRANT', grantId, normalizeGrant(target), null);
    return { id: grantId };
  }
  return null;
}

export async function handleOrgFileAssets(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/org/file-assets')) return null;
  const part = pathname.slice('/api/org'.length);
  const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER', 'STUDENT']);
  const currentOrgId = auth.user.orgId;
  if (!currentOrgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');

  if (part === '/file-assets' && method === 'GET') {
    const category = String(ctx.search.get('category') || '').trim();
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const conditions = [
      "(visibility='ASSIGNED_ORGS' AND EXISTS (SELECT 1 FROM file_access_grants g WHERE g.file_id=file_assets.id AND g.org_id=? AND g.grant_type='ORG'))",
      "OR (visibility='ORG' AND owner_org_id=?)",
      "OR owner_org_id=?",
      "OR visibility='PUBLIC_PLATFORM'",
    ];
    const where = `WHERE (${conditions.join(' ')}) ${category ? 'AND category=?' : ''}`;
    const params = [currentOrgId, currentOrgId, currentOrgId];
    if (category) params.push(category);
    const items = rows(`SELECT DISTINCT file_assets.* FROM file_assets ${where} ORDER BY created_at DESC LIMIT ${limit}`, params).map(normalizeFileAsset);
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
    let orgIds = visibility === 'ASSIGNED_ORGS' ? validateAudienceOrgIds(audience.orgIds) : [];
    if (visibility === 'ASSIGNED_ORGS' && !orgIds.includes(currentOrgId)) orgIds = [currentOrgId, ...orgIds];
    const reviewStatus = String(body.reviewStatus || 'NOT_REQUIRED').toUpperCase();
    if (!REVIEW_STATUSES.has(reviewStatus)) throw errors.badRequest('reviewStatus 无效', 'INVALID_REVIEW_STATUS');
    const mimeType = body.mimeType ? String(body.mimeType).trim().slice(0, 120) : null;
    const fileSize = body.fileSize == null ? null : integer(body.fileSize, '文件大小', { min: 0, max: 10 * 1024 * 1024 * 1024 });
    const checksum = body.checksum ? String(body.checksum).trim().slice(0, 128) : null;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
    if (body.expiresAt && Number.isNaN(new Date(body.expiresAt).getTime())) throw errors.badRequest('expiresAt 无效', 'INVALID_EXPIRES_AT');
    const fileId = id('file');
    const now = nowIso();
    q(
      `INSERT INTO file_assets(id,owner_type,owner_org_id,owner_user_id,storage_kind,storage_url,storage_key,proxy_route,public_path,file_name,mime_type,file_size,checksum,category,visibility,status,review_status,expires_at,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fileId, 'ORG', currentOrgId, null, storageKind, storage.storageUrl, storage.storageKey, storage.proxyRoute, body.publicPath ? String(body.publicPath).trim().slice(0, 500) : null, fileName, mimeType, fileSize, checksum, category, visibility, 'ACTIVE', reviewStatus, expiresAt, json({}), auth.user.id, now, now],
    );
    const created = row('SELECT * FROM file_assets WHERE id=?', [fileId]);
    syncFileGrants(fileId, created, { orgIds }, auth.user.id);
    audit(ctx, 'FILE_ASSET_CREATE', 'FILE_ASSET', fileId, null, { category, visibility, storageKind }, { orgId: currentOrgId });
    return normalizeFileAsset(created);
  }

  const idMatch = part.match(/^\/file-assets\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    return normalizeFileAsset(authorizeFileAccess(ctx, idMatch[1], 'READ'));
  }
  if (idMatch && method === 'PUT') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可更新文件', 'ORG_ADMIN_REQUIRED');
    const file = row('SELECT * FROM file_assets WHERE id=?', [idMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.owner_type !== 'ORG' || file.owner_org_id !== currentOrgId) throw errors.forbidden('只能修改本机构文件', 'FILE_OWNER_REQUIRED');
    const body = ctx.body || {};
    if (body.storageKind !== undefined || body.storageUrl !== undefined || body.storageKey !== undefined || body.proxyRoute !== undefined) {
      const storageKind = body.storageKind === undefined ? file.storage_kind : String(body.storageKind).toUpperCase();
      const storage = validateStoragePayload(storageKind, body);
      q('UPDATE file_assets SET storage_kind=?, storage_url=?, storage_key=?, proxy_route=?, updated_at=? WHERE id=?', [storageKind, storage.storageUrl, storage.storageKey, storage.proxyRoute, nowIso(), file.id]);
    }
    if (body.fileName !== undefined) q('UPDATE file_assets SET file_name=?, updated_at=? WHERE id=?', [nonEmptyString(body.fileName, '文件名', { max: 500 }), nowIso(), file.id]);
    if (body.mimeType !== undefined) q('UPDATE file_assets SET mime_type=?, updated_at=? WHERE id=?', [body.mimeType ? String(body.mimeType).trim().slice(0, 120) : null, nowIso(), file.id]);
    if (body.checksum !== undefined) q('UPDATE file_assets SET checksum=?, updated_at=? WHERE id=?', [body.checksum ? String(body.checksum).trim().slice(0, 128) : null, nowIso(), file.id]);
    if (body.visibility !== undefined) {
      const visibility = validateVisibility(String(body.visibility).toUpperCase(), body.audience || {});
      if (!['ORG', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibility)) throw errors.badRequest('机构文件仅允许 PRIVATE/ORG/ASSIGNED_ORGS', 'INVALID_ORG_VISIBILITY');
      q('UPDATE file_assets SET visibility=?, updated_at=? WHERE id=?', [visibility, nowIso(), file.id]);
      const audience = body.audience || {};
      let orgIds = visibility === 'ASSIGNED_ORGS' ? validateAudienceOrgIds(audience.orgIds) : [];
      if (visibility === 'ASSIGNED_ORGS' && !orgIds.includes(currentOrgId)) orgIds = [currentOrgId, ...orgIds];
      const updated = row('SELECT * FROM file_assets WHERE id=?', [file.id]);
      syncFileGrants(file.id, updated, { orgIds }, auth.user.id);
    }
    if (body.reviewStatus !== undefined) {
      const reviewStatus = String(body.reviewStatus).toUpperCase();
      if (!REVIEW_STATUSES.has(reviewStatus)) throw errors.badRequest('reviewStatus 无效', 'INVALID_REVIEW_STATUS');
      assertTransition(ctx, 'fileReview', file.review_status, reviewStatus, { targetType: 'FILE_REVIEW', targetId: file.id, before: file, allowSameState: true });
      q('UPDATE file_assets SET review_status=?, updated_at=? WHERE id=?', [reviewStatus, nowIso(), file.id]);
    }
    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase();
      if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('status 无效', 'INVALID_FILE_STATUS');
      assertTransition(ctx, 'fileAsset', file.status, status, { targetType: 'FILE_ASSET', targetId: file.id, before: file, allowSameState: true });
      q('UPDATE file_assets SET status=?, updated_at=? WHERE id=?', [status, nowIso(), file.id]);
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
      if (body.expiresAt && Number.isNaN(new Date(body.expiresAt).getTime())) throw errors.badRequest('expiresAt 无效', 'INVALID_EXPIRES_AT');
      q('UPDATE file_assets SET expires_at=?, updated_at=? WHERE id=?', [expiresAt, nowIso(), file.id]);
    }
    audit(ctx, 'FILE_ASSET_UPDATE', 'FILE_ASSET', file.id, normalizeFileAsset(file), body, { orgId: currentOrgId });
    return normalizeFileAsset(row('SELECT * FROM file_assets WHERE id=?', [file.id]));
  }
  if (idMatch && method === 'DELETE') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可删除文件', 'ORG_ADMIN_REQUIRED');
    const file = row('SELECT * FROM file_assets WHERE id=?', [idMatch[1]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.owner_type !== 'ORG' || file.owner_org_id !== currentOrgId) throw errors.forbidden('只能删除本机构文件', 'FILE_OWNER_REQUIRED');
    assertTransition(ctx, 'fileAsset', file.status, 'REMOVED', { targetType: 'FILE_ASSET', targetId: file.id, before: file });
    q("UPDATE file_assets SET status='REMOVED', updated_at=? WHERE id=?", [nowIso(), file.id]);
    q('DELETE FROM file_access_grants WHERE file_id=?', [file.id]);
    audit(ctx, 'FILE_ASSET_REMOVE', 'FILE_ASSET', file.id, normalizeFileAsset(file), null, { orgId: currentOrgId });
    return { id: file.id, status: 'REMOVED' };
  }

  // 文件访问代理下载（先授权，再从 Web 根目录外流式输出）
  const proxyMatch = part.match(/^\/file-assets\/([^/]+)\/download$/);
  if (proxyMatch && method === 'GET') return prepareFileDownload(ctx, authorizeFileAccess(ctx, proxyMatch[1], 'DOWNLOAD'));
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
    const items = rows(
      `SELECT DISTINCT file_assets.* FROM file_assets
       WHERE (visibility='ASSIGNED_ORGS' AND EXISTS (SELECT 1 FROM file_access_grants g WHERE g.file_id=file_assets.id AND g.org_id=? AND g.grant_type='ORG'))
          OR (visibility='ORG' AND owner_org_id=?)
          OR (visibility='PRIVATE' AND owner_user_id=?)
          OR visibility='PUBLIC_PLATFORM'
       ORDER BY created_at DESC LIMIT ${limit}`,
      [currentOrgId, currentOrgId, auth.user.id],
    ).map(normalizeFileAsset);
    return { items, total: items.length, limit };
  }
  const idMatch = part.match(/^\/file-assets\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    return normalizeFileAsset(authorizeFileAccess(ctx, idMatch[1], 'READ'));
  }
  const proxyMatch = part.match(/^\/file-assets\/([^/]+)\/download$/);
  if (proxyMatch && method === 'GET') return prepareFileDownload(ctx, authorizeFileAccess(ctx, proxyMatch[1], 'DOWNLOAD'));
  return null;
}
