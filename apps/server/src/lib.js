import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, q, rows, row, count, json, parseJson, transaction } from '../../../packages/database/src/schema.js';
import { AUTH_PEPPER, CORS_ALLOWED_ORIGINS } from './config.js';
import { effectiveCapabilities, modalityChannel, normalizeAspectRatio, requiresFirstFrameFor, MUSIC_MODES } from './services/modelCapabilities.js';
import { previewKindFor, signPreviewTicket } from './services/materialPreview.js';

const TOKEN_TTL_DAYS = 7;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.DEPLOYMENT_MODE === 'internal-test' || process.env.NODE_ENV === 'production';
const PEPPER = AUTH_PEPPER;

export const PLATFORM_ADMIN_PERMISSIONS = Object.freeze([
  'ADMIN_ORGANIZATIONS',
  'ADMIN_COURSES',
  'ADMIN_WORKS',
  'ADMIN_BILLING',
  'ADMIN_CONTENT',
  'ADMIN_ANALYTICS',
  'ADMIN_AUDIT',
]);
const PLATFORM_ADMIN_PERMISSION_SET = new Set(PLATFORM_ADMIN_PERMISSIONS);
// 未登记的 /api/admin/* 用这个标记：默认拒绝，避免新增端点静默落到某个业务域
export const UNREGISTERED_PLATFORM_PERMISSION = 'ADMIN_UNREGISTERED';

export function isRootPlatformAdmin(auth) {
  return auth?.user?.role === 'SUPER_ADMIN'
    && (auth.user.login === 'root'
      || auth.user.permissions?.includes('*')
      || PLATFORM_ADMIN_PERMISSIONS.every((permission) => auth.user.permissions?.includes(permission)));
}

export function requirePlatformPermission(ctx, permission) {
  const auth = requireRole(ctx, ['SUPER_ADMIN']);
  if (permission === UNREGISTERED_PLATFORM_PERMISSION) {
    if (isRootPlatformAdmin(auth)) return auth;
    throw errors.forbidden('该平台端点尚未登记权限域，默认拒绝访问', 'PLATFORM_ENDPOINT_UNREGISTERED');
  }
  // 自助类端点（如改自己的密码）不挂业务域权限，登录即可
  if (permission === 'ADMIN_SELF') return auth;
  if (!PLATFORM_ADMIN_PERMISSION_SET.has(permission)) throw new Error(`Unknown platform permission: ${permission}`);
  if (!isRootPlatformAdmin(auth) && !(auth.user.permissions || []).includes(permission)) {
    throw errors.forbidden('当前账号没有该业务域权限', 'PERMISSION_DENIED', { permission });
  }
  return auth;
}

export function platformPermissionForPathname(pathname) {
  const value = String(pathname || '');
  if (!value.startsWith('/api/admin/')) return null;
  const routes = [
    ['/api/admin/audit-logs', 'ADMIN_AUDIT'],
    ['/api/admin/platform-admins', 'ADMIN_AUDIT'],
    ['/api/admin/dashboard', 'ADMIN_ANALYTICS'],
    ['/api/admin/overview', 'ADMIN_ANALYTICS'],
    ['/api/admin/ai-usage', 'ADMIN_ANALYTICS'],
    ['/api/admin/organizations', 'ADMIN_ORGANIZATIONS'],
    ['/api/admin/platform-users', 'ADMIN_ORGANIZATIONS'],
    ['/api/admin/course-series', 'ADMIN_COURSES'],
    ['/api/admin/course-lessons', 'ADMIN_COURSES'],
    ['/api/admin/course-marketplace', 'ADMIN_COURSES'],
    ['/api/admin/works', 'ADMIN_WORKS'],
    ['/api/admin/vibecoding-works', 'ADMIN_WORKS'],
    ['/api/admin/work-reports', 'ADMIN_WORKS'],
    ['/api/admin/work-data', 'ADMIN_WORKS'],
    ['/api/admin/billing', 'ADMIN_BILLING'],
    ['/api/admin/billing-config', 'ADMIN_BILLING'],
    ['/api/admin/compute-attempts', 'ADMIN_BILLING'],
    ['/api/admin/compute-gateway', 'ADMIN_BILLING'],
    ['/api/admin/compute-pricing', 'ADMIN_BILLING'],
    ['/api/admin/compute-pools', 'ADMIN_BILLING'],
    ['/api/admin/financial-reporting', 'ADMIN_BILLING'],
    ['/api/admin/authorizations', 'ADMIN_BILLING'],
    ['/api/admin/license-purchases', 'ADMIN_BILLING'],
    ['/api/admin/license-reports', 'ADMIN_BILLING'],
    ['/api/admin/file-assets', 'ADMIN_CONTENT'],
    ['/api/admin/website-content', 'ADMIN_CONTENT'],
    // 通知 / 物料 / 线索：此前靠兜底落到 ADMIN_CONTENT，这里显式登记
    ['/api/admin/inbox', 'ADMIN_CONTENT'],
    ['/api/admin/materials', 'ADMIN_CONTENT'],
    ['/api/admin/notification-templates', 'ADMIN_CONTENT'],
    ['/api/admin/notification-events', 'ADMIN_CONTENT'],
    ['/api/admin/notification-failures', 'ADMIN_CONTENT'],
    ['/api/admin/notification-queue', 'ADMIN_CONTENT'],
    ['/api/admin/leads', 'ADMIN_ORGANIZATIONS'],
    // 自助操作（改自己的密码等）：只要登录了平台管理员就能用，不挂业务域权限
    ['/api/admin/me', 'ADMIN_SELF'],
  ];
  return routes.find(([prefix]) => value === prefix || value.startsWith(prefix + '/'))?.[1] || UNREGISTERED_PLATFORM_PERMISSION;
}

export function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(`${PEPPER}:${String(password)}`, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, storedHash] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !salt || !storedHash) return false;
  const actual = scryptSync(`${PEPPER}:${String(password)}`, salt, 64);
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toResponse() {
    const error = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { success: false, ok: false, error };
  }
}

export const errors = {
  unauthorized: (message = '登录状态无效', code = 'SESSION_INVALID', details) => new ApiError(401, code, message, details),
  tooMany: (message = '请求过于频繁，请稍后再试', code = 'RATE_LIMITED', details) => new ApiError(429, code, message, details),
  forbidden: (message = '无权访问', code = 'FORBIDDEN', details) => new ApiError(403, code, message, details),
  notFound: (message = '资源不存在', code = 'NOT_FOUND', details) => new ApiError(404, code, message, details),
  badRequest: (message = '请求参数错误', code = 'VALIDATION_ERROR', details) => new ApiError(400, code, message, details),
  conflict: (message = '资源状态冲突', code = 'CONFLICT', details) => new ApiError(409, code, message, details),
  serviceUnavailable: (message = '服务暂不可用', code = 'SERVICE_UNAVAILABLE', details) => new ApiError(503, code, message, details),
};

export function envelope(data) {
  return { success: true, ok: true, data: data ?? null };
}

export function requestContext(req) {
  const url = new URL(req.url || '/', 'http://local');
  return {
    pathname: url.pathname.replace(/\/+$/, '') || '/',
    search: url.searchParams,
    method: String(req.method || 'GET').toUpperCase(),
  };
}

function parseLimit(limit) {
  if (Number.isFinite(limit)) return Number(limit);
  const match = String(limit || '1mb').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/);
  if (!match) return 1024 * 1024;
  const multiplier = { b: 1, kb: 1024, mb: 1024 * 1024 }[match[2] || 'b'];
  return Math.floor(Number(match[1]) * multiplier);
}

export async function readBodyBuffer(req, limit = '1mb') {
  const maxBytes = parseLimit(limit);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw errors.badRequest('请求体过大', 'PAYLOAD_TOO_LARGE');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function readJson(req, limit = '1mb') {
  const maxBytes = parseLimit(limit);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw errors.badRequest('请求体过大', 'PAYLOAD_TOO_LARGE');
    chunks.push(value);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const result = JSON.parse(text);
    if (result === null || Array.isArray(result) || typeof result !== 'object') {
      throw errors.badRequest('请求体必须为 JSON 对象', 'INVALID_JSON');
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw errors.badRequest('JSON 格式错误', 'INVALID_JSON');
  }
}

function isAllowedOrigin(origin) {
  return !origin || CORS_ALLOWED_ORIGINS.includes(origin);
}

export function securityHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

export function corsHeaders(req, extra = {}) {
  const origin = String(req?.headers?.origin || '').trim();
  const headers = {
    ...securityHeaders(),
    'access-control-allow-headers': 'content-type,authorization,x-requested-with',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
    ...extra,
  };
  if (isAllowedOrigin(origin)) {
    if (origin) headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
  }
  return headers;
}

export function sendJson(res, status, payload, req, extraHeaders = {}) {
  const text = JSON.stringify(payload);
  const internalHeaders = process.env.DEPLOYMENT_MODE === 'internal-test'
    ? { 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-internal-test': 'true' }
    : {};
  res.writeHead(status, corsHeaders(req, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...internalHeaders,
    ...extraHeaders,
  }));
  res.end(text);
}

export function sendNoContent(res, req, extraHeaders = {}) {
  const internalHeaders = process.env.DEPLOYMENT_MODE === 'internal-test'
    ? { 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-internal-test': 'true' }
    : {};
  res.writeHead(204, corsHeaders(req, { ...internalHeaders, ...extraHeaders }));
  res.end();
}

function readToken(req) {
  const authorization = String(req.headers?.authorization || '').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const cookie = String(req.headers?.cookie || '')
    .split(/;\s*/)
    .find((part) => part.startsWith('platform_token='));
  return cookie ? decodeURIComponent(cookie.slice('platform_token='.length)) : null;
}

export function assertUserAccountAvailable(user, org = null) {
  if (!user || user.deleted_at) throw errors.unauthorized('账号不存在或已删除', 'SESSION_INVALID');
  if (user.status !== 'ACTIVE') throw errors.unauthorized('账号已停用', 'ACCOUNT_DISABLED');
  if (user.expires_at && user.expires_at <= nowIso()) throw errors.unauthorized('账号已过期', 'ACCOUNT_EXPIRED');
  if (user.must_bind_phone && !user.phone_verified_at) throw errors.unauthorized('请先绑定手机号', 'PHONE_NOT_BOUND');
  if (!org) return;
  if (org.status === 'FROZEN') throw errors.unauthorized('机构当前已冻结', 'ORG_FROZEN');
  if (org.status === 'DISABLED') throw errors.unauthorized('机构当前已停用', 'ORG_DISABLED');
  if (org.status === 'EXPIRED' || (org.contract_expires_at && org.contract_expires_at <= nowIso())) {
    throw errors.unauthorized('机构合同已到期', 'ORG_CONTRACT_EXPIRED');
  }
}

export function resolveAuth(req) {
  const token = readToken(req);
  if (!token) return { auth: null, error: null };
  const session = row('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
  if (!session) {
    return { auth: null, error: errors.unauthorized('登录状态无效', 'SESSION_INVALID') };
  }
  if (session.superseded_at) {
    return { auth: null, error: errors.unauthorized('当前账号已在其他设备登录', 'SESSION_SUPERSEDED') };
  }
  if (session.expires_at <= nowIso()) {
    return { auth: null, error: errors.unauthorized('登录状态已过期', 'AUTH_EXPIRED') };
  }
  const user = row('SELECT * FROM users WHERE id = ?', [session.user_id]);
  const org = user?.org_id ? row('SELECT * FROM organizations WHERE id = ?', [user.org_id]) : null;
  try {
    assertUserAccountAvailable(user, org);
  } catch (error) {
    return { auth: null, error };
  }
  return { auth: { token, session, user: normalizeUser(user, { includeAuthMeta: true }), rawUser: user, org }, error: null };
}

export function getAuth(req) {
  return resolveAuth(req).auth;
}

export function requireAuth(ctx) {
  if (ctx.auth) return ctx.auth;
  throw ctx.authError || errors.unauthorized();
}

export function requireRole(ctx, roles) {
  const auth = requireAuth(ctx);
  if (!roles.includes(auth.user.role)) throw errors.forbidden('当前角色无权访问该资源');
  return auth;
}

export function requirePermission(ctx, permission) {
  const auth = requireRole(ctx, ['SUPER_ADMIN', 'ORG_ADMIN', 'TEACHER']);
  if (auth.user.role === 'SUPER_ADMIN' || auth.user.role === 'ORG_ADMIN') return auth;
  if (!auth.user.permissions.includes(permission)) {
    throw errors.forbidden('当前账号没有所需权限', 'PERMISSION_DENIED', { permission });
  }
  return auth;
}

export function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function asPositiveInteger(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback = undefined } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw errors.badRequest(`${field} 必须是 ${min} 到 ${max} 之间的整数`, 'VALIDATION_ERROR', { field });
  }
  return numeric;
}

// 列表分页参数：page/limit 从查询串解析，limit 始终有上限，避免无界查询
export function pageParams(search, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page = asPositiveInteger(search?.get?.('page'), '页码', { min: 1, max: 100000, fallback: 1 });
  const limit = asPositiveInteger(search?.get?.('limit'), '每页数量', { min: 1, max: maxLimit, fallback: defaultLimit });
  return { page, limit, offset: (page - 1) * limit };
}

// 统一分页响应：total 是筛选后的总条数，不是本页条数
export function pageResult(items, { page, limit, total }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  return { items, total: safeTotal, page, limit, totalPages: Math.max(1, Math.ceil(safeTotal / limit)) };
}

export function nonEmptyString(value, field, { max = 500, fallback = undefined } = {}) {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  const text = String(value ?? '').trim();
  if (!text) throw errors.badRequest(`${field} 不能为空`, 'VALIDATION_ERROR', { field });
  if (text.length > max) throw errors.badRequest(`${field} 不能超过 ${max} 个字符`, 'VALIDATION_ERROR', { field });
  return text;
}

export function normalizeUser(value, { includeAuthMeta = false } = {}) {
  if (!value) return null;
  const storedPermissions = parseJson(value.permissions, []);
  const permissions = value.role === 'SUPER_ADMIN' && value.login === 'root' && storedPermissions.length === 0
    ? [...PLATFORM_ADMIN_PERMISSIONS]
    : storedPermissions;
  const result = {
    id: value.id,
    orgId: value.org_id || null,
    login: value.login,
    displayName: value.display_name,
    role: value.role,
    permissions,
    phone: value.phone || null,
    phoneVerifiedAt: value.phone_verified_at || null,
    mustBindPhone: !!value.must_bind_phone,
    status: value.status,
    expiresAt: value.expires_at || null,
    studentUsageScope: value.student_usage_scope || null,
    billingPackageId: value.billing_package_id || null,
    // 2026-09-13（P4 删积分）：月度额度 / 魔法石 / 个人积分 / 成员 AI 上限都不再对外返回。
    // 库里那几列保留给历史数据（删代码不删表的惯例），代码不再读写。
    avatarKey: value.avatar_key || null,
    guardian: value.guardian_name == null && value.guardian_phone == null && value.guardian_relationship == null ? null : {
      name: value.guardian_name || null,
      phone: value.guardian_phone || null,
      relationship: value.guardian_relationship || null,
      consentedAt: value.guardian_consented_at || null,
    },
    privacy: {
      showcaseAnonymous: !!value.privacy_showcase_anonymous,
      allowFeature: !!value.privacy_allow_feature,
    },
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
  if (includeAuthMeta) result.authenticated = true;
  return result;
}

export function normalizeOrg(value) {
  if (!value) return null;
  const teacherSeats = Number(value.base_teacher_seats || 0) + Number(value.purchased_teacher_seats || 0);
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    contractStartAt: value.contract_start_at,
    contractExpiresAt: value.contract_expires_at,
    isTrial: !!value.is_trial,
    baseTeacherSeats: Number(value.base_teacher_seats || 0),
    purchasedTeacherSeats: Number(value.purchased_teacher_seats || 0),
    teacherSeats,
    studentSeats: Number(value.student_seats || 0),
    studentUsedSeats: count("SELECT COUNT(*) AS n FROM users WHERE org_id=? AND role='STUDENT' AND deleted_at IS NULL", [value.id]),
    teacherUsedSeats: count("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'TEACHER' AND deleted_at IS NULL", [value.id]),
    contact: parseJson(value.contact, {}),
    createdBy: value.created_by || null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

export function normalizePackage(value) {
  if (!value) return null;
  return {
    id: value.id,
    orgId: value.org_id,
    name: value.name,
    priceFen: Number(value.price_fen || 0),
    // 2026-09-13（P4 删积分）：monthlyCredits / bonusCredits 不再对外返回（列保留，代码不读写）
    durationDays: Number(value.duration_days || 0),
    capabilities: {
      allowImage: !!value.allow_image,
      allowMusic: !!value.allow_music,
      allowVideo: !!value.allow_video,
      allowPodcast: !!value.allow_podcast,
      allowDubbing: !!value.allow_dubbing,
    },
    studentSeats: Number(value.student_seats || 0),
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

// 课包授权的有效条件：状态为 ACTIVE 且未过期（expires_at 为空表示永久有效）。
// 用 SQLite 的 ISO 时间戳与 nowIso() 同格式比较，避免各调用点手工拼参数。
export const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export function assignmentActiveSql(alias = 'assignment') {
  return `(${alias}.status='ACTIVE' AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ${NOW_SQL}))`;
}
export function assignmentIsActive(value) {
  if (!value || value.status !== 'ACTIVE') return false;
  if (!value.expires_at) return true;
  return new Date(value.expires_at).getTime() > Date.now();
}

/**
 * 「机构能不能看到/使用这个课包」的唯一定义（平台口径，见交接说明第四节）。
 *
 * 平台课包**发布 ≠ 授权**：发布只是上架官网课程广场给人看，机构后台一律看不到，
 * 必须有该机构名下 ACTIVE 且未过期的授权（course_assignments）才行。
 * 机构自有课包只对本机构可见。
 *
 * 用法：调用方 FROM 里须 LEFT JOIN course_assignments（`assignmentActiveSql()` 做条件），
 * 本片段里的 `?` 就是**当前机构 id**（与既有 SQL 的参数顺序保持一致，不要挪位）。
 */
export function orgSeriesAccessSql(seriesAlias = 'series', assignmentAlias = 'assignment') {
  return `((${seriesAlias}.owner_type='PLATFORM' AND ${assignmentAlias}.id IS NOT NULL)`
    + ` OR (${seriesAlias}.owner_type='ORG' AND ${seriesAlias}.org_id = ?))`;
}

const DELIVERY_MODE_VALUES = ['CANVAS', 'VIBECODING'];

/**
 * 一个课时支持哪些上课类型。
 * 新字段 `delivery_modes` 是数组（画布 + VibeCoding 可同时开，学生端两个入口并列）；
 * 老数据只有单值 `delivery_mode`，这里统一成数组返回，避免每个读取方各写一遍回退逻辑。
 */
function deliveryModesOf(value) {
  const parsed = parseJson(value?.delivery_modes, null);
  const list = Array.isArray(parsed)
    ? parsed.map((item) => String(item || '').trim().toUpperCase()).filter((item) => DELIVERY_MODE_VALUES.includes(item))
    : [];
  const unique = [...new Set(list)];
  return unique.length ? unique : [value?.delivery_mode || 'CANVAS'];
}

export function normalizeLesson(value, { includeTeaching = false, asPublished = false } = {}) {
  if (!value) return null;
  // 平台端读实时数据（编辑用）；机构端/学生端/官网读「最近一次更新发布」定格的快照。
  // 老数据没有快照 → 回退实时数据，行为与之前一致。
  const snapshot = asPublished ? publishedSnapshotOf(value) : null;
  const liveCanvas = lessonCanvasConfig(value.id);
  const merged = snapshot
    ? {
      ...snapshot,
      capabilities: Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [],
      materialGroups: Array.isArray(snapshot.materialGroups) ? snapshot.materialGroups : [],
      generationBoxes: Array.isArray(snapshot.generationBoxes) ? snapshot.generationBoxes : [],
    }
    : null;
  const pick = (key, fallback) => (merged && merged[key] !== undefined ? merged[key] : fallback);
  return {
    id: value.id,
    seriesId: value.series_id,
    title: pick('title', value.title),
    summary: pick('summary', value.summary) || '',
    sort: Number(value.sort || 0),
    status: value.status,
    durationMinutes: Number(pick('durationMinutes', value.duration_minutes) || 0),
    promptPackAssetId: value.prompt_pack_asset_id || null,
    outcomePackAssetId: value.outcome_pack_asset_id || null,
    lessonContent: pick('lessonContent', value.lesson_content) || '',   // P5-W05
    // 老字段（第一种类型）保留给既有读取方；新代码一律读 deliveryModes
    deliveryMode: pick('deliveryMode', value.delivery_mode || 'CANVAS'),
    deliveryModes: pick('deliveryModes', deliveryModesOf(value)),
    // 每个学生的算力上限（分）；null = 平台没配（不拦，只记账）
    perStudentBudgetFen: (() => { const raw = pick('perStudentBudgetFen', value.per_student_budget_fen); return raw === null || raw === undefined ? null : Number(raw); })(),
    platformBudgetFen: (() => { const raw = pick('platformBudgetFen', value.platform_budget_fen); return raw == null ? null : Number(raw); })(),
    classroomConfig: pick('classroomConfig', parseJson(value.classroom_config, {})) || {},
    canvasTemplateSnapshot: pick('canvasTemplateSnapshot', parseJson(value.canvas_template_snapshot, {})) || {},
    capabilities: merged ? merged.capabilities : liveCanvas.capabilities,
    materialGroups: merged ? merged.materialGroups : liveCanvas.materialGroups,
    generationBoxes: merged ? merged.generationBoxes : liveCanvas.generationBoxes,
    // 教学素材是教师备课资料：只有机构端/平台端显式要求时才下发，学生端与公开接口一律不带。
    ...(includeTeaching ? { teachingGroups: teachingGroupsFor(value.id, merged) } : {}),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}
const GENERATION_BOX_MODALITIES = Object.freeze(['TEXT', 'IMAGE', 'VIDEO', 'MUSIC']);
const MAX_GENERATION_BOXES = 20;
// 生成框体在素材表里的类型：框体就是一种素材，和图片/视频/提示词一起排在同一条顺序里。
export const GENERATION_BOX_MATERIAL_TYPE = 'GENERATION_BOX';

function aiProviderPolicy() {
  return parseJson(row('SELECT ai_provider_policy FROM platform_settings WHERE id=1')?.ai_provider_policy, {});
}

/** 某模态 + 某模型的有效能力（比例/清晰度/时长/音频/首帧）；框体保存校验与下发共用同一套取值。 */
export function generationBoxCapabilities(modality, modelId, policy = null) {
  const key = String(modality || '').toUpperCase();
  const channel = modalityChannel(policy || aiProviderPolicy(), key);
  const model = String(modelId || '').trim() || String(channel?.model || '').trim();
  return effectiveCapabilities(channel, key, model);
}

function uniqueBoxId(value, seen) {
  const candidate = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(candidate) && !seen.has(candidate)) { seen.add(candidate); return candidate; }
  let next = id('box');
  while (seen.has(next)) next = id('box');
  seen.add(next);
  return next;
}

/**
 * 单个生成框体归一化：每个框体单独配模型与生成参数，学生端按顺序逐个生成、每个框体只生成一次。
 * strict=true 用于管理员保存：非法取值当场抛错（错误码 INVALID_GENERATION_CONFIG），不再静默丢弃；
 * strict=false 用于下发：非法取值回落到该模型支持的第一个取值，坏数据不下发到学生端。
 */
export function normalizeGenerationBox(raw, { strict = false, policy = null, index = 0, id: fallbackId = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const providerPolicy = policy || aiProviderPolicy();
  const modality = String(raw.modality || '').trim().toUpperCase();
  const invalid = (message) => { if (strict) throw Object.assign(new Error(message), { code: 'INVALID_GENERATION_CONFIG' }); };
  if (!GENERATION_BOX_MODALITIES.includes(modality)) { invalid(`第 ${index + 1} 个生成框体的类型无效`); return null; }
  const model = String(raw.model || '').trim().slice(0, 120);
  const capabilities = generationBoxCapabilities(modality, model, providerPolicy);
  const box = {
    id: String(fallbackId || '').trim() || uniqueBoxId(raw.id, new Set()),
    title: String(raw.title || '').trim().slice(0, 60) || `素材${index + 1}`,
    modality,
    model,
    prompt: String(raw.prompt || '').slice(0, 2000),
    assetUrl: String(raw.assetUrl || '').trim().slice(0, 2000),
  };
  // 比例 / 清晰度只对图片与视频有意义（音乐只有生成模式，能力里也没有这些字段）
  if (modality === 'IMAGE' || modality === 'VIDEO') {
    const rawRatio = String(raw.aspectRatio ?? '').trim();
    const submittedRatio = normalizeAspectRatio(rawRatio);
    // 写了但解析不出来的比例属于填错，不能静默换成别的值。
    if (rawRatio && !submittedRatio) invalid(`框体「${box.title}」的生成比例「${rawRatio.slice(0, 20)}」格式不对（示例：16:9、9:16）`);
    if (submittedRatio && capabilities.aspectRatios.length && !capabilities.aspectRatios.includes(submittedRatio)) {
      invalid(`框体「${box.title}」的生成比例「${submittedRatio}」不在当前模型支持范围内（可用：${capabilities.aspectRatios.join('、')}）`);
      box.aspectRatio = capabilities.aspectRatios[0];
    } else {
      // 平台不填＝不指定：留给学生在画布课堂里自己选；生成时按学生选的值发，服务端仍按模型能力校验。
      box.aspectRatio = submittedRatio || '';
    }
    const submittedResolution = String(raw.resolution ?? '').trim();
    if (submittedResolution && capabilities.resolutions.length && !capabilities.resolutions.includes(submittedResolution)) {
      invalid(`框体「${box.title}」的清晰度「${submittedResolution}」不在当前模型支持范围内（可用：${capabilities.resolutions.join('、')}）`);
      box.resolution = capabilities.resolutions[0];
    } else {
      box.resolution = submittedResolution || '';
    }
    // 学生端要按模型能力渲染「自己选参数」的下拉框，可选值随框体一起下发。
    box.paramOptions = { aspectRatios: [...capabilities.aspectRatios], resolutions: [...capabilities.resolutions] };
  }
  if (modality === 'MUSIC') {
    // 音乐只有「生成模式」：歌词生音乐（学生直接写词）/ 描述生音乐（平台代写词）。
    // 时长由模型决定，上游不接受时长参数，所以这里不提供该字段。
    const mode = String(raw.mode || '').trim().toUpperCase();
    box.mode = MUSIC_MODES.includes(mode) ? mode : MUSIC_MODES[0];
    // 模型声明里如果只支持一种模式，就跟着模型走，避免配出模型做不了的组合。
    const supported = Array.isArray(capabilities.modes) && capabilities.modes.length ? capabilities.modes : [...MUSIC_MODES];
    if (!supported.includes(box.mode)) box.mode = supported[0];
    return box;
  }
  if (modality === 'VIDEO') {
    const submitted = raw.durationSeconds === undefined || raw.durationSeconds === null || raw.durationSeconds === '' ? null : Number(raw.durationSeconds);
    // 平台不填＝不指定，留给学生自己选时长。
    let durationSeconds = submitted;
    if (submitted !== null) {
      if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 600) {
        invalid(`框体「${box.title}」的视频时长「${String(raw.durationSeconds ?? '').slice(0, 20)}」必须是 1–600 的整数秒`);
        durationSeconds = capabilities.durations[0] || 5;
      } else if (capabilities.durations.length && !capabilities.durations.includes(durationSeconds)) {
        invalid(`框体「${box.title}」的视频时长「${durationSeconds}秒」不在当前模型支持范围内（可用：${capabilities.durations.join('、')}秒）`);
        durationSeconds = capabilities.durations[0];
      }
    }
    box.durationSeconds = durationSeconds;
    // 含音频三态：null＝学生自选，true/false＝平台定了（模型不支持音频时只能是不带音频）。
    box.audio = raw.audio === undefined || raw.audio === null ? null : (raw.audio === true && capabilities.audio === true);
    // 输入画面支持方式（可多选）：只能图生（不支持纯文本）时才要求必须给首帧。
    box.inputModes = Array.isArray(capabilities.inputModes) ? capabilities.inputModes : ['TEXT'];
    box.requiresFirstFrame = requiresFirstFrameFor(box.inputModes);
    box.paramOptions = { ...(box.paramOptions || {}), durations: [...capabilities.durations], audio: capabilities.audio === true };
  }
  return box;
}

export function normalizeGenerationBoxes(value, { strict = false, policy = null } = {}) {
  const list = Array.isArray(value) ? value.slice(0, MAX_GENERATION_BOXES) : [];
  const providerPolicy = policy || aiProviderPolicy();
  const seen = new Set();
  return list.map((raw, index) => {
    const box = normalizeGenerationBox(raw, { strict, policy: providerPolicy, index });
    if (!box) return null;
    if (seen.has(box.id)) box.id = uniqueBoxId('', seen);
    else seen.add(box.id);
    return box;
  }).filter(Boolean);
}

// 框体在素材表里存的是 snapshot.box（模型与参数）+ snapshot.content（预填提示词）。
export function boxFromMaterial(material, index = 0) {
  if (!material || String(material.materialType || material.material_type || '').toUpperCase() !== GENERATION_BOX_MATERIAL_TYPE) return null;
  const snapshot = material.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {};
  const raw = snapshot.box && typeof snapshot.box === 'object' ? snapshot.box : {};
  const box = normalizeGenerationBox(raw, { index, id: material.id });
  if (!box) return null;
  box.id = material.id;
  box.title = String(material.title || box.title).trim().slice(0, 60) || box.title;
  box.prompt = String(snapshot.content || '').slice(0, 2000);
  box.assetUrl = String(material.assetUrl || material.asset_url || '').trim().slice(0, 2000);
  return box;
}

/**
 * 已发布内容快照：平台端编辑的是实时数据，机构端/学生端/官网读的是最近一次「更新发布」定格的这份。
 * 老数据没有快照 → 回退实时数据（行为不变）。
 */
function publishedSnapshotOf(value) {
  const parsed = parseJson(value?.published_content, null);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export function lessonCanvasConfig(lessonId, override = null) {
  if (override && Array.isArray(override.materialGroups)) {
    const groups = override.materialGroups;
    const generationBoxes = [];
    groups.forEach((group) => {
      (group.materials || []).forEach((material) => {
        const box = boxFromMaterial(material, generationBoxes.length);
        if (box) generationBoxes.push({ ...box, groupId: group.id, groupTitle: group.title });
      });
    });
    return { capabilities: override.capabilities?.length ? override.capabilities : ['text'], materialGroups: groups, generationBoxes };
  }
  if (!lessonId) return { capabilities: ['text'], materialGroups: [], generationBoxes: [] };
  const capabilities = rows('SELECT capability FROM course_lesson_capabilities WHERE lesson_id=? ORDER BY capability', [lessonId]).map((item) => item.capability);
  const groups = rows('SELECT * FROM course_lesson_material_groups WHERE lesson_id=? ORDER BY sort, created_at', [lessonId]).map((group) => ({
    id: group.id, title: group.title, sort: Number(group.sort || 0), materials: rows('SELECT * FROM course_lesson_materials WHERE group_id=? ORDER BY sort, created_at', [group.id]).map((item) => ({
      id: item.id, title: item.title, description: item.description || '', materialType: item.material_type || 'NOTE', assetUrl: item.asset_url || null, snapshot: parseJson(item.snapshot, {}), sort: Number(item.sort || 0),
    })),
  }));
  // 生成框体就是素材表里 type=GENERATION_BOX 的素材：顺序跟着素材走，
  // 这里摊平成一条列表供生成链路（按框体取模型/参数、每框体一次）使用。
  const generationBoxes = [];
  groups.forEach((group) => {
    (group.materials || []).forEach((material) => {
      const box = boxFromMaterial(material, generationBoxes.length);
      if (box) generationBoxes.push({ ...box, groupId: group.id, groupTitle: group.title });
    });
  });
  return {
    capabilities: capabilities.length ? capabilities : ['text'],
    materialGroups: groups,
    generationBoxes,
  };
}

// 教学素材：教师备课资料，学生端不可见、不进入画布。
/**
 * 教学素材的**在线预览**信息（2026-09-15，口径 A：机构/老师只能在线看、不给下载入口）。
 * - previewKind 决定前端用什么渲染：VIDEO / PDF / IMAGE / AUDIO / OFFICE / OTHER；
 * - previewUrl 带**短时签名票据**（1 小时）—— 老师直接点开即可预览，把链接转给别人也很快失效；
 * - OFFICE（PPT/DOCX）由服务端转成 PDF 再把 PDF 发出去，**原始文件不出服务器**。
 * ⚠️ 视频/PDF 只要浏览器能渲染就拦不住录屏/截屏，这是 web 的物理限制，见 materialPreview.js。
 */
export function previewInfoFor(fileAssetId) {
  const id = String(fileAssetId || '').trim();
  if (!id) return { previewKind: null, previewUrl: null };
  const file = row('SELECT mime_type, file_name FROM file_assets WHERE id=?', [id]);
  if (!file) return { previewKind: null, previewUrl: null };
  const { ticket } = signPreviewTicket(id);
  return {
    previewKind: previewKindFor({ mimeType: file.mime_type, fileName: file.file_name }),
    previewUrl: `/api/org/file-assets/${encodeURIComponent(id)}/preview?t=${encodeURIComponent(ticket)}`,
  };
}

/**
 * 教学素材的对外形态（2026-09-17 修）。
 *
 * 发布快照里的 teachingGroups 是**定格**的：标题、说明、排序都按发布那一刻算，这是对的。
 * 但 `previewUrl` 绝不能跟着定格 —— 那里面是**短时签名票据**，冻进快照就成了
 * 「发布 1 小时后永久失效的死链」。2026-09-17 的故障就是这么来的：
 * 老师点预览 → 票据早过期 → 回落到会话鉴权 → iframe 带不了鉴权头 → 用 cookie 兜底
 * → 浏览器里恰好是学生会话 → 报出「教学素材仅教师可见」这条驴唇不对马嘴的错。
 *
 * 所以：内容取快照，`previewKind / previewUrl` 一律**现签**。
 */
function teachingGroupsFor(lessonId, snapshot) {
  const frozen = snapshot && Array.isArray(snapshot.teachingGroups) ? snapshot.teachingGroups : null;
  if (!frozen) return lessonTeachingMaterials(lessonId).teachingGroups;
  return frozen.map((group) => ({
    ...group,
    assets: (Array.isArray(group.assets) ? group.assets : []).map((asset) => (
      asset.fileAssetId
        ? { ...asset, ...previewInfoFor(asset.fileAssetId) }
        // 没有 file_asset_id 的素材本来就没有可预览的文件：把快照里可能残留的地址清掉，
        // 宁可前端显示「暂不支持在线预览」，也不要发一条指不回去的链接。
        : { ...asset, previewKind: null, previewUrl: null }
    )),
  }));
}

export function lessonTeachingMaterials(lessonId) {
  if (!lessonId) return { teachingGroups: [] };
  const groups = rows('SELECT * FROM course_lesson_teaching_groups WHERE lesson_id=? ORDER BY sort, created_at', [lessonId]).map((group) => ({
    id: group.id, title: group.title, sort: Number(group.sort || 0),
    assets: rows('SELECT * FROM course_lesson_teaching_assets WHERE group_id=? ORDER BY sort, created_at', [group.id]).map((item) => ({
      id: item.id, title: item.title, description: item.description || '', assetType: item.asset_type || 'FILE',
      assetUrl: item.asset_url || null, fileAssetId: item.file_asset_id || null, sort: Number(item.sort || 0),
      ...previewInfoFor(item.file_asset_id),
    })),
  }));
  return { teachingGroups: groups };
}

/**
 * 课包「可见范围」（2026-09-16 用户口径：三值改两值）。
 * **公开** = 课程广场 + 授权机构都可以；**私有** = 不对外。
 * 老的两个值（ALL_ORGS=上架课程广场 / ASSIGNED_ORGS=仅授权机构）在入口处**照旧收下**并映射成
 * PUBLIC —— 它们本来只差「上不上广场」这一件事，现在合并了；直接报 400 只会让老前端与
 * 历史守卫无谓地红，所以这里做归一化而不是拒绝。
 */
/**
 * 登录名格式（2026-09-16 用户口径）：**只允许英文与数字**（可以带 . _ -）。
 * 口径原话：「登录名现在可以填中文，应该是只能英文、数字」。
 * 为什么保留 . _ - ：历史账号与守卫里已经有 p4-o14-student / teacher-1 这类名字，
 * 一刀切只留字母数字会把它们连同生产账号一起挡在门外。
 * 不允许空格、中文、@ 等 —— 那些正是会被认错、打不出来的字符。
 */
export const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

/** 校验并返回登录名；不合法就报错（错误码 INVALID_LOGIN_FORMAT，前端据此给中文提示）。 */
export function normalizeLogin(value, field = '登录名') {
  const login = String(value ?? '').trim();
  // 空值沿用通用校验码（与原来的 nonEmptyString 一致），只有『格式不对』才是新码
  if (!login) throw errors.badRequest(`${field}不能为空`);
  if (!LOGIN_PATTERN.test(login)) {
    throw errors.badRequest(`${field}只能用英文和数字（可带 . _ -），2-50 位`, 'INVALID_LOGIN_FORMAT');
  }
  return login;
}

/**
 * 登录名全局唯一（忽略大小写）。
 * 口径：不同用户不能同登录名 —— 大小写不同也算同一个（`Zhang` 与 `zhang` 会被人认成一个人）。
 * 软删除的账号**仍然占着**这个登录名（它们还在库里，放行会造成两个同登录名的账号）。
 */
export function assertLoginAvailable(login, { excludeUserId = null } = {}) {
  const clash = row('SELECT id,login,display_name FROM users WHERE LOWER(login)=LOWER(?) AND (? IS NULL OR id<>?) LIMIT 1', [login, excludeUserId, excludeUserId]);
  if (clash) throw errors.conflict(`登录名「${login}」已被占用（${clash.display_name || clash.login}）`, 'LOGIN_EXISTS');
}

/**
 * 姓名唯一：**同一机构 + 同一角色**内不允许重名（2026-09-16 用户口径）。
 * 为什么按这个范围：不同机构的学生当然可以同名；一个机构里「张老师」和「张三同学」也可以同名。
 * 会出问题的场景是「同一批名单里两个同名的人」—— 老师在学员列表里根本分不出来。
 * orgId 为空（平台管理员）时按全局同名同角色算。
 */
export function assertDisplayNameAvailable(displayName, { orgId = null, role = null, excludeUserId = null } = {}) {
  const name = String(displayName ?? '').trim();
  if (!name) return;
  const clash = row(
    `SELECT id,login,display_name FROM users
      WHERE display_name=? AND deleted_at IS NULL
        AND (? IS NULL OR org_id IS ?) AND (? IS NULL OR role=?) AND (? IS NULL OR id<>?)
      LIMIT 1`,
    [name, orgId, orgId, role, role, excludeUserId, excludeUserId],
  );
  if (clash) {
    const scope = orgId ? '本机构' : '平台';
    throw errors.conflict(`${scope}已经有同名的${role === 'STUDENT' ? '学员' : role === 'TEACHER' ? '老师' : '账号'}「${name}」（登录名 ${clash.login}），请换个名字或加个区分`, 'DISPLAY_NAME_EXISTS');
  }
}

export const SERIES_VISIBILITIES = Object.freeze(['PUBLIC', 'PRIVATE']);

export function normalizeSeriesVisibility(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'ALL_ORGS' || raw === 'ASSIGNED_ORGS') return 'PUBLIC';
  return SERIES_VISIBILITIES.includes(raw) ? raw : null;
}

/**
 * 平台→机构授权的到期时间：**跟机构的合同日期走**（2026-09-16 用户口径）。
 *
 * 口径原话：平台给机构授权次数时「还需要填有效期，这里有效期不需要，跟机构创建的合同日期同步即可」。
 * 所以授权不再有自己单独的有效期：合同续了，授权自动跟着续（见 syncAssignmentExpiryForOrg）。
 * 返回 null 表示这家机构没有合同到期日 —— 此时授权不设到期（与 assignmentActiveSql 的语义一致）。
 */
export function contractExpiryForOrg(orgId) {
  return row('SELECT contract_expires_at FROM organizations WHERE id=?', [String(orgId || '')])?.contract_expires_at || null;
}

/**
 * 机构的合同日期变了（续签 / 改期）→ 它的**有效**授权一起跟过去。
 * 契约：授权有效期 = 合同到期日，所以这里不做任何「取更晚的那个」之类的小聪明 ——
 * 合同怎么改，授权就怎么变，这才叫「同步」。
 */
export function syncAssignmentExpiryForOrg(orgId, expiresAt = null) {
  return q("UPDATE course_assignments SET expires_at=? WHERE org_id=? AND status='ACTIVE'", [expiresAt, String(orgId || '')]);
}

export function normalizeSeries(value, { includeLessons = false, orgId = null, includeAllLessons = false, parseTags = true, includeTeaching = false, asPublished = false } = {}) {
  // 课包字段同样支持草稿隔离：机构端/学生端/官网读「更新发布」时的快照
  const seriesSnapshot = asPublished ? publishedSnapshotOf(value) : null;
  const snapPick = (key, fallback) => (seriesSnapshot && seriesSnapshot[key] !== undefined ? seriesSnapshot[key] : fallback);
  if (!value) return null;
  let tags = [];
  if (parseTags) {
    try {
      const parsed = value.tags ? JSON.parse(value.tags) : [];
      tags = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      tags = [];
    }
  }
  const result = {
    id: value.id,
    title: snapPick('title', value.title),
    description: snapPick('description', value.description || ''),
    coverImageUrl: snapPick('coverImageUrl', value.cover_image_url || null),
    coverAssetId: snapPick('coverAssetId', value.cover_asset_id || null),
    priceFen: Number(snapPick('priceFen', value.price_fen) || 0),
    validityDays: Number(value.validity_days || 0),
    estimatedCreditsPerPerson: Number(value.estimated_credits_per_person || 0),
    gradeRange: value.grade_range || '',
    ownerType: value.owner_type,
    orgId: value.org_id || null,
    visibility: value.visibility,
    version: value.version,
    // 平台课包库存（可授权出去的次数池）；机构能拿到多少由 course_assignments.quota_total 决定
    stockTotal: Number(snapPick('stockTotal', value.stock_total) || 0),
    sort: Number(value.sort || 0),
    status: value.status,
    marketplaceStatus: value.marketplace_status,
    marketplaceRewardCredits: Number(value.marketplace_reward_credits || 0),
    // 算力池：**每个学生在这个课包上的总预算**（分，5000 = 50 元）；留空 = 不限制、只记账。
    // 四种模态（对话 / 图片 / 视频 / 音乐）共用这一个池子，闸门在应用侧（services/computePool.js）。
    perStudentBudgetFen: (() => {
      const raw = snapPick('perStudentBudgetFen', value.per_student_budget_fen);
      return raw === null || raw === undefined ? null : Number(raw);
    })(),
    // P5-W05 课程资料核验字段
    difficultyLevel: snapPick('difficultyLevel', value.difficulty_level != null ? Number(value.difficulty_level) : null),
    ageRangeMin: value.age_range_min != null ? Number(value.age_range_min) : null,
    ageRangeMax: value.age_range_max != null ? Number(value.age_range_max) : null,
    tags,
    deliveryMode: value.delivery_mode || 'CANVAS',
    lessonCount: count(`SELECT COUNT(*) AS n FROM course_lessons WHERE series_id = ?${includeAllLessons ? '' : " AND status = 'PUBLISHED'"}`, [value.id]),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
  if (orgId) {
    const assignment = row("SELECT status, expires_at FROM course_assignments WHERE series_id = ? AND org_id = ?", [value.id, orgId]);
    result.assignedToCurrentOrg = assignmentIsActive(assignment);
    result.assignmentExpiresAt = assignment?.expires_at || null;
  }
  if (includeLessons) {
    result.lessons = rows(`SELECT * FROM course_lessons WHERE series_id = ?${includeAllLessons ? '' : " AND status = 'PUBLISHED'"} ORDER BY sort, created_at`, [value.id]).map((lesson) => normalizeLesson(lesson, { includeTeaching, asPublished }));
  }
  return result;
}

// 2026-09-13 批次 D：`normalizeClass` 已删除 —— 班级退场后它没有调用方了，
// 而且它内部还查 class_members / class_curriculum_items 这两张历史表，留着会让人以为班级逻辑还活着。
// 课堂的规范化函数是 normalizeSession（四态）与 normalizeSessionStudent（六态）。

export function normalizeSession(value) {
  if (!value) return null;
  const SESSION_STATUS_LABELS = { PENDING: '待上课', ACTIVE: '上课中', ENDED: '已结束', DISSOLVED: '已解散' };
  return {
    id: value.id,
    title: value.title || null,
    // 2026-09-13（批次 B）：课堂自带课包与负责老师，班级退场后不再依赖 class_id
    classId: value.class_id || null,
    seriesId: value.series_id || null,
    seriesTitle: value.series_title || null,
    teacherId: value.teacher_id || null,
    teacherName: value.teacher_name || null,
    lessonId: value.lesson_id || null,
    lessonTitle: value.lesson_title || null,
    lessonSort: value.lesson_sort === null || value.lesson_sort === undefined ? null : Number(value.lesson_sort),
    sessionKind: value.session_kind || 'REGULAR',
    deliveryMode: value.delivery_mode || 'CANVAS',
    status: value.status,
    statusLabel: SESSION_STATUS_LABELS[value.status] || value.status,
    studentCount: value.student_count === undefined ? undefined : Number(value.student_count || 0),
    // 2026-09-13（P4 删积分）：sessionCreditCap / consumedCreditsTotal 不再对外返回
    aiPaused: !!value.ai_paused,
    studentCallCap: value.student_call_cap === null || value.student_call_cap === undefined ? null : Number(value.student_call_cap),
    capabilities: {
      allowText: value.allow_text === undefined ? true : !!value.allow_text,
      allowImage: !!value.allow_image,
      allowMusic: !!value.allow_music,
      allowVideo: !!value.allow_video,
      allowPodcast: !!value.allow_podcast,
      allowDubbing: !!value.allow_dubbing,
    },
    startedBy: value.started_by || null,
    startedAt: value.started_at || null,
    endedBy: value.ended_by || null,
    endedAt: value.ended_at || null,
    endedReason: value.ended_reason || null,
    createdAt: value.created_at || null,
    updatedAt: value.updated_at || null,
  };
}

export function normalizeProject(value, { includeSnapshot = false } = {}) {
  if (!value) return null;
  const result = {
    id: value.id,
    studentId: value.student_id,
    orgId: value.org_id || null,
    classId: value.class_id || null,
    // 2026-09-13（批次 B）：项目归属的「课堂」（班级退场后它就是上下文）
    classSessionId: value.class_session_id || null,
    courseLessonId: value.course_lesson_id || null,
    courseLessonTitle: value.lesson_title || null,
    title: value.title,
    status: value.status,
    latestVersion: Number(value.latest_version || 0),
    lastSavedAt: value.last_saved_at,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    archivedAt: value.archived_at || null,
    deletedAt: value.deleted_at || null,
    className: value.class_name || null,
    seriesId: value.series_id || null,
    seriesTitle: value.series_title || null,
    workId: value.work_id || null,
    workStatus: value.work_status || null,
    workSubmittedAt: value.work_submitted_at || null,
    ...lessonCanvasConfig(value.course_lesson_id),
  };
  if (includeSnapshot) result.canvasSnapshot = parseJson(value.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
  return result;
}

export function normalizeWork(value, { includeSnapshot = false } = {}) {
  if (!value) return null;
  const result = {
    id: value.id,
    projectId: value.project_id,
    studentId: value.student_id,
    studentName: value.student_name || null,
    orgId: value.org_id || null,
    classId: value.class_id || null,
    className: value.class_name || null,
    courseLessonId: value.course_lesson_id || null,
    courseLessonTitle: value.lesson_title || null,
    title: value.title,
    description: value.description || '',
    status: value.status,
    teacherComment: value.teacher_comment || null,
    // 2026-09-13（C2）：下架原因读**独立列** unpublish_reason。
    // ⚠️ 兜底读 teacher_comment 只为**历史行**：C2 之前下架把原因塞在 teacher_comment 里，
    //    那些行没法可靠地跟「审核不通过」区分开（没有 published_at 这类痕迹），所以保留原状、读取时兜底，
    //    界面话术仍然正确。新写入一律走 unpublish_reason。
    unpublishReason: value.unpublish_reason || value.teacher_comment || null,
    unpublishedAt: value.unpublished_at || null,
    reviewedBy: value.reviewed_by || null,
    reviewerName: value.reviewer_name || null,
    submittedAt: value.submitted_at,
    reviewedAt: value.reviewed_at || null,
    copyrightConfirmedAt: value.copyright_confirmed_at || null,
    copyrightConfirmedBy: value.copyright_confirmed_by || null,
    featured: Boolean(value.featured_at),
    featuredAt: value.featured_at || null,
    featuredBy: value.featured_by || null,
    featuredReason: value.featured_reason || null,
    // 是否已由平台发布到「学生作品广场」
    plazaPublished: Number(value.is_public || 0) === 1,
    shareToken: value.share_token || null,
  };
  if (includeSnapshot) result.canvasSnapshot = parseJson(value.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
  return result;
}

export function normalizeWorkReport(value, { includeReporter = false } = {}) {
  if (!value) return null;
  const result = {
    id: value.id, workId: value.work_id, orgId: value.org_id, category: value.category, details: value.details || '',
    status: value.status, handledBy: value.handled_by || null, handlerName: value.handler_name || null,
    handledAt: value.handled_at || null, resolution: value.resolution || null, actionTaken: value.action_taken || 'NONE',
    createdAt: value.created_at, workTitle: value.work_title || null, workStatus: value.work_status || null,
  };
  if (includeReporter) { result.reporterId = value.reporter_id; result.reporterName = value.reporter_name || null; }
  return result;
}

export function audit(ctx, action, targetType, targetId, beforeData = null, afterData = null, { orgId } = {}) {
  q(`INSERT INTO audit_logs(
    id,org_id,actor_id,actor_role,action,target_type,target_id,request_method,request_path,before_data,after_data,ip,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id('audit'),
    orgId ?? ctx.auth?.user.orgId ?? null,
    ctx.auth?.user.id ?? null,
    ctx.auth?.user.role ?? null,
    action,
    targetType,
    targetId || null,
    ctx.method || null,
    ctx.pathname || null,
    json(beforeData),
    json(afterData),
    ctx.req?.socket?.remoteAddress || null,
    nowIso(),
  ]);
}

export function setAuthCookie(token) {
  return 'platform_token=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax' + (COOKIE_SECURE ? '; Secure' : '') + '; Max-Age=' + (TOKEN_TTL_DAYS * 86400);
}

export function clearAuthCookie() {
  return 'platform_token=; Path=/; HttpOnly; SameSite=Lax' + (COOKIE_SECURE ? '; Secure' : '') + '; Max-Age=0';
}

export function tokenExpiresAt() {
  return new Date(Date.now() + TOKEN_TTL_DAYS * 86400_000).toISOString();
}

export { db, q, rows, row, count, json, parseJson, transaction };
