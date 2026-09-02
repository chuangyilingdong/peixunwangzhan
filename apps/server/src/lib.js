import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, q, rows, row, count, json, parseJson, transaction } from '../../../packages/database/src/schema.js';

const TOKEN_TTL_DAYS = 7;
const PEPPER = process.env.AUTH_PEPPER || 'p0-local-pepper';

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
  forbidden: (message = '无权访问', code = 'FORBIDDEN', details) => new ApiError(403, code, message, details),
  notFound: (message = '资源不存在', code = 'NOT_FOUND', details) => new ApiError(404, code, message, details),
  badRequest: (message = '请求参数错误', code = 'VALIDATION_ERROR', details) => new ApiError(400, code, message, details),
  conflict: (message = '资源状态冲突', code = 'CONFLICT', details) => new ApiError(409, code, message, details),
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

export function corsHeaders(req, extra = {}) {
  const origin = req?.headers?.origin;
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type,authorization,x-requested-with',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
    ...extra,
  };
}

export function sendJson(res, status, payload, req, extraHeaders = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, corsHeaders(req, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  }));
  res.end(text);
}

export function sendNoContent(res, req, extraHeaders = {}) {
  res.writeHead(204, corsHeaders(req, extraHeaders));
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

export function nonEmptyString(value, field, { max = 500, fallback = undefined } = {}) {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  const text = String(value ?? '').trim();
  if (!text) throw errors.badRequest(`${field} 不能为空`, 'VALIDATION_ERROR', { field });
  if (text.length > max) throw errors.badRequest(`${field} 不能超过 ${max} 个字符`, 'VALIDATION_ERROR', { field });
  return text;
}

export function normalizeUser(value, { includeAuthMeta = false } = {}) {
  if (!value) return null;
  const result = {
    id: value.id,
    orgId: value.org_id || null,
    login: value.login,
    displayName: value.display_name,
    role: value.role,
    permissions: parseJson(value.permissions, []),
    phone: value.phone || null,
    phoneVerifiedAt: value.phone_verified_at || null,
    mustBindPhone: !!value.must_bind_phone,
    status: value.status,
    expiresAt: value.expires_at || null,
    studentUsageScope: value.student_usage_scope || null,
    billingPackageId: value.billing_package_id || null,
    monthlyCreditAllowance: Number(value.monthly_credit_allowance || 0),
    monthlyBonusCredits: Number(value.monthly_bonus_credits || 0),
    monthPeriodBoostCredits: Number(value.month_period_boost_credits || 0),
    usedCreditsThisPeriod: Number(value.used_credits_this_period || 0),
    creditsRemaining: Math.max(0, Number(value.monthly_credit_allowance || 0) + Number(value.monthly_bonus_credits || 0) + Number(value.month_period_boost_credits || 0) - Number(value.used_credits_this_period || 0)),
    periodStartAt: value.period_start_at || null,
    periodResetAt: value.period_reset_at || null,
    magicStones: Number(value.magic_stones || 0),
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
    teacherUsedSeats: count("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'TEACHER' AND status = 'ACTIVE' AND deleted_at IS NULL", [value.id]),
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
    monthlyCredits: Number(value.monthly_credits || 0),
    bonusCredits: Number(value.bonus_credits || 0),
    durationDays: Number(value.duration_days || 0),
    capabilities: {
      allowImage: !!value.allow_image,
      allowMusic: !!value.allow_music,
      allowVideo: !!value.allow_video,
      allowPodcast: !!value.allow_podcast,
      allowDubbing: !!value.allow_dubbing,
    },
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

export function normalizeLesson(value) {
  if (!value) return null;
  return {
    id: value.id,
    seriesId: value.series_id,
    title: value.title,
    summary: value.summary || '',
    sort: Number(value.sort || 0),
    status: value.status,
    durationMinutes: Number(value.duration_minutes || 0),
    promptPackAssetId: value.prompt_pack_asset_id || null,
    outcomePackAssetId: value.outcome_pack_asset_id || null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

export function normalizeSeries(value, { includeLessons = false, orgId = null, includeAllLessons = false } = {}) {
  if (!value) return null;
  const result = {
    id: value.id,
    title: value.title,
    description: value.description || '',
    coverImageUrl: value.cover_image_url || null,
    ownerType: value.owner_type,
    orgId: value.org_id || null,
    visibility: value.visibility,
    version: value.version,
    sort: Number(value.sort || 0),
    status: value.status,
    marketplaceStatus: value.marketplace_status,
    marketplaceRewardCredits: Number(value.marketplace_reward_credits || 0),
    lessonCount: count(`SELECT COUNT(*) AS n FROM course_lessons WHERE series_id = ?${includeAllLessons ? '' : " AND status = 'PUBLISHED'"}`, [value.id]),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
  if (orgId) result.assignedToCurrentOrg = !!row("SELECT id FROM course_assignments WHERE series_id = ? AND org_id = ? AND status = 'ACTIVE'", [value.id, orgId]);
  if (includeLessons) {
    result.lessons = rows(`SELECT * FROM course_lessons WHERE series_id = ?${includeAllLessons ? '' : " AND status = 'PUBLISHED'"} ORDER BY sort, created_at`, [value.id]).map(normalizeLesson);
  }
  return result;
}

export function normalizeClass(value, { detail = false } = {}) {
  if (!value) return null;
  const result = {
    id: value.id,
    orgId: value.org_id,
    name: value.name,
    teacherId: value.teacher_id || null,
    teacherName: value.teacher_name || null,
    usageMode: value.usage_mode,
    defaultSeriesId: value.default_series_id || null,
    status: value.status,
    currentSessionId: value.current_session_id || null,
    studentCount: count(`SELECT COUNT(*) AS n FROM class_members cm JOIN users u ON u.id = cm.user_id WHERE cm.class_id = ? AND cm.removed_at IS NULL AND cm.role = 'STUDENT' AND u.deleted_at IS NULL`, [value.id]),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    archivedAt: value.archived_at || null,
  };
  if (detail) {
    result.curriculum = rows(`SELECT ci.*, l.title, l.summary, l.duration_minutes, l.status AS lesson_status
      FROM class_curriculum_items ci JOIN course_lessons l ON l.id = ci.lesson_id
      WHERE ci.class_id = ? ORDER BY ci.sort`, [value.id]).map((item) => ({
      id: item.id,
      lessonId: item.lesson_id,
      title: item.title,
      summary: item.summary || '',
      sort: Number(item.sort || 0),
      durationMinutes: Number(item.duration_minutes || 0),
      lessonStatus: item.lesson_status,
      sourceSeriesId: item.source_series_id,
    }));
    result.members = rows(`SELECT u.*, cm.role AS class_role FROM class_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.class_id = ? AND cm.removed_at IS NULL AND u.deleted_at IS NULL ORDER BY cm.joined_at`, [value.id])
      .map((member) => ({ ...normalizeUser(member), classRole: member.class_role }));
  }
  return result;
}

export function normalizeSession(value) {
  if (!value) return null;
  return {
    id: value.id,
    classId: value.class_id,
    lessonId: value.lesson_id || null,
    lessonTitle: value.lesson_title || null,
    sessionKind: value.session_kind || 'REGULAR',
    status: value.status,
    sessionCreditCap: value.session_credit_cap === null || value.session_credit_cap === undefined ? null : Number(value.session_credit_cap),
    consumedCreditsTotal: Number(value.consumed_credits_total || 0),
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
    startedBy: value.started_by,
    startedAt: value.started_at,
    endedBy: value.ended_by || null,
    endedAt: value.ended_at || null,
    endedReason: value.ended_reason || null,
  };
}

export function normalizeProject(value, { includeSnapshot = false } = {}) {
  if (!value) return null;
  const result = {
    id: value.id,
    studentId: value.student_id,
    orgId: value.org_id || null,
    classId: value.class_id || null,
    courseLessonId: value.course_lesson_id || null,
    courseLessonTitle: value.lesson_title || null,
    title: value.title,
    status: value.status,
    latestVersion: Number(value.latest_version || 0),
    lastSavedAt: value.last_saved_at,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
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
  return `platform_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_TTL_DAYS * 86400}`;
}

export function clearAuthCookie() {
  return 'platform_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

export function tokenExpiresAt() {
  return new Date(Date.now() + TOKEN_TTL_DAYS * 86400_000).toISOString();
}

export { db, q, rows, row, count, json, parseJson, transaction };
