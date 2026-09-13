// 平台管理端「admins」域路由：从 adminOrg.js 拆出，行为不变。
import {
  audit, count, errors, id, json, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  assignmentActiveSql, PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction, verifyPassword,
} from '../../lib.js';
import { hashPassword } from '@platform/database';
import { randomUUID } from 'node:crypto';
import { scheduleReminder } from '../communication.js';
import { assertKnownState, assertTransition } from '../../services/domainState.js';
import { getAiProviderPolicy } from '../billingConfig.js';
import { effectiveCapabilities, normalizeAspectRatio } from '../../services/modelCapabilities.js';
import { disableMfa, enableMfa, mfaSummary, regenerateRecoveryCodes, startMfaSetup } from '../../services/mfa.js';
import { normalizeSubmission } from '../vibecoding.js';
import {
  ENROLLMENT_STATUSES,
  ORG_MEMBER_ROLES,
  ORG_TEACHER_PERMISSIONS,
  PAYMENT_STATUSES,
  accessibleLesson,
  accessibleSeries,
  annotationRows,
  appendEnrollmentEvent,
  assertAnnotationNode,
  assertEnrollmentSeat,
  assertNotLastOrgAdmin,
  assertSelfPassword,
  auditListQuery,
  auditQuery,
  auditRow,
  buildOrganizationDetail,
  buildStudentDataExport,
  bumpSeriesVersion,
  contactPayload,
  createMember,
  csvDocument,
  csvFileName,
  enrollmentDate,
  enrollmentRow,
  ensureOrgBilling,
  escapeCsv,
  expireDueEnrollments,
  hasAnyPlatformPermission,
  hasPermission,
  importItems,
  integer,
  lastSuperAdminGuard,
  normalizeCanvasTemplateSnapshot,
  normalizeClassroomConfig,
  normalizeDeliveryMode,
  normalizeEnrollment,
  normalizeWorkPublishRequest,
  occupiedStudentSeats,
  orgAdminRows,
  orgContractMeta,
  orgId,
  orgMemberRow,
  orgUser,
  organizationFilters,
  organizationRow,
  packageSnapshot,
  packageWithSeatUsage,
  platformAdminPermissions,
  platformIssuerName,
  platformUserFilters,
  platformUserRow,
  platformWorkFilters,
  previewImport,
  replaceLessonCanvasConfig,
  replaceLessonTeachingMaterials,
  reportResolution,
  setStudentEnrollmentAccess,
  softDeleteStudent,
  userLoginMeta,
  validateImportItem,
  validateMemberPermissions,
  validateMemberPhone,
  validateSeriesForPublishing,
  validateTeacher,
  workInReviewScope,
  workReportInReviewScope,
  workReportRows,
} from './helpers.js';

export async function handleAdmins(ctx, part, method) {
  if (part === '/platform-admins' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const search = String(ctx.search.get('search') || '').trim();
    const statusFilter = String(ctx.search.get('status') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const sortKey = String(ctx.search.get('sort') || 'created').trim();
    const sort = Object.hasOwn({ created: true, name: true, status: true }, sortKey) ? sortKey : 'created';
    const sortSql = {
      created: 'user.created_at DESC, user.id DESC',
      name: 'user.display_name COLLATE NOCASE ASC, user.id DESC',
      status: 'user.status ASC, user.created_at DESC, user.id DESC',
    }[sort];
    const params = []; const conditions = ["user.role='SUPER_ADMIN'", 'user.deleted_at IS NULL'];
    if (search) { conditions.push('(user.login LIKE ? OR user.display_name LIKE ?)'); const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; params.push(keyword, keyword); }
    if (['ACTIVE', 'DISABLED'].includes(statusFilter)) { conditions.push('user.status=?'); params.push(statusFilter); }
    const where = conditions.join(' AND ');
    const total = Number(row('SELECT COUNT(*) n FROM users user WHERE ' + where, params)?.n || 0);
    const adminUsers = rows('SELECT user.* FROM users user WHERE ' + where + ' ORDER BY ' + sortSql + ' LIMIT ? OFFSET ?', [...params, limit, (page - 1) * limit]);
    const meta = userLoginMeta(adminUsers.map((item) => item.id));
    const mfaRows = adminUsers.length
      ? rows(`SELECT user_id, status FROM user_mfa_credentials WHERE user_id IN (${adminUsers.map(() => '?').join(',')})`, adminUsers.map((item) => item.id))
      : [];
    const mfaMap = new Map(mfaRows.map((item) => [item.user_id, item.status === 'ENABLED']));
    const items = adminUsers.map((item) => ({ ...normalizeUser(item, { includeAuthMeta: true }), lastLoginAt: meta.get(item.id)?.lastLoginAt || null, activeSessions: meta.get(item.id)?.activeSessions || 0, mfaEnabled: mfaMap.get(item.id) || false }));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  if (part === '/platform-admins' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const body = ctx.body || {};
    const login = String(body.login || '').trim(); const displayName = String(body.displayName || '').trim(); const password = String(body.password || '');
    if (!login || !displayName || password.length < 6) throw errors.badRequest('登录名、姓名不能为空且密码至少6位', 'ADMIN_INPUT_REQUIRED');
    if (row('SELECT id FROM users WHERE login=?', [login])) throw errors.conflict('登录名已存在', 'LOGIN_EXISTS');
    const permissions = login === 'root' ? [...PLATFORM_ADMIN_PERMISSIONS] : platformAdminPermissions(body.permissions); const adminId = id('user'); const now = nowIso();
    q('INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [adminId, null, login, displayName, 'SUPER_ADMIN', json(permissions), hashPassword(password), body.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE', now, now]);
    audit(ctx, 'PLATFORM_ADMIN_CREATE', 'USER', adminId, null, { login, permissions });
    return normalizeUser(row('SELECT * FROM users WHERE id=?', [adminId]), { includeAuthMeta: true });
  }
  const adminLogMatch = part.match(/^\/platform-admins\/([^/]+)\/audit-logs$/);
  if (adminLogMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const target = row("SELECT * FROM users WHERE id=? AND role='SUPER_ADMIN' AND deleted_at IS NULL", [adminLogMatch[1]]);
    if (!target) throw errors.notFound('平台管理员不存在', 'ADMIN_NOT_FOUND');
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 50 });
    const items = rows('SELECT audit.*, target_user.display_name target_name FROM audit_logs audit LEFT JOIN users target_user ON target_user.id=audit.target_id AND audit.target_type=\'USER\' WHERE audit.actor_id=? ORDER BY audit.created_at DESC LIMIT ' + limit, [target.id]).map((item) => ({
      id: item.id, action: item.action, targetType: item.target_type, targetId: item.target_id || null, targetName: item.target_name || null,
      requestPath: item.request_path || null, before: parseJson(item.before_data, null), after: parseJson(item.after_data, null), ip: item.ip || null, createdAt: item.created_at,
    }));
    return { admin: normalizeUser(target, { includeAuthMeta: true }), items, total: items.length };
  }
  const adminMatch = part.match(/^\/platform-admins\/([^/]+)$/);
  if (adminMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const target = row("SELECT * FROM users WHERE id=? AND role='SUPER_ADMIN' AND deleted_at IS NULL", [adminMatch[1]]);
    if (!target) throw errors.notFound('平台管理员不存在', 'ADMIN_NOT_FOUND');
    const body = ctx.body || {};
    if (body.login !== undefined && String(body.login).trim() !== target.login && row('SELECT id FROM users WHERE login=?', [String(body.login).trim()])) throw errors.conflict('登录名已存在', 'LOGIN_EXISTS');
    const displayName = body.displayName === undefined ? target.display_name : String(body.displayName).trim();
    if (!displayName) throw errors.badRequest('姓名不能为空', 'ADMIN_INPUT_REQUIRED');
    const permissions = target.login === 'root' ? [...PLATFORM_ADMIN_PERMISSIONS] : (body.permissions === undefined ? parseJson(target.permissions, []) : platformAdminPermissions(body.permissions));
    if (!Array.isArray(permissions) || permissions.some((item) => !PLATFORM_ADMIN_PERMISSIONS.includes(item))) throw errors.badRequest('包含无效的平台权限码', 'INVALID_ADMIN_PERMISSION');
    if (target.status === 'ACTIVE' && !hasAnyPlatformPermission(permissions)) {
      const effectiveAdmins = rows("SELECT id FROM users WHERE role='SUPER_ADMIN' AND status='ACTIVE' AND deleted_at IS NULL");
      if (effectiveAdmins.length <= 1 && effectiveAdmins.some((item) => item.id === target.id)) throw errors.badRequest('不能移除最后一个有效平台管理员的全部权限', 'LAST_SUPER_ADMIN_FORBIDDEN');
    }
    let passwordHash = target.password_hash;
    if (body.password !== undefined) { const password = String(body.password || ''); if (password.length < 6) throw errors.badRequest('密码至少6位', 'ADMIN_INPUT_REQUIRED'); passwordHash = hashPassword(password); }
    let status = target.status;
    if (body.status !== undefined) {
      status = body.status;
      if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('管理员状态无效', 'INVALID_ADMIN_STATUS');
      if (status === 'DISABLED' && target.id === auth.user.id) throw errors.badRequest('不能停用当前登录账号', 'ADMIN_SELF_DISABLE_FORBIDDEN');
      if (status === 'DISABLED' && target.status !== 'DISABLED') lastSuperAdminGuard(target);
    }
    const login = body.login === undefined ? target.login : String(body.login).trim();
    if (!login) throw errors.badRequest('登录名不能为空', 'ADMIN_INPUT_REQUIRED');
    q('UPDATE users SET login=?,display_name=?,permissions=?,password_hash=?,status=?,updated_at=? WHERE id=?', [login, displayName, json([...new Set(permissions)]), passwordHash, status, nowIso(), target.id]);
    if ((status === 'DISABLED' && target.status !== 'DISABLED') || body.password !== undefined) q('UPDATE sessions SET superseded_at=? WHERE user_id=? AND superseded_at IS NULL', [nowIso(), target.id]);
    audit(ctx, 'PLATFORM_ADMIN_UPDATE', 'USER', target.id, { login: target.login, displayName: target.display_name, status: target.status }, { displayName, status, passwordChanged: body.password !== undefined, permissions });
    return normalizeUser(row('SELECT * FROM users WHERE id=?', [target.id]), { includeAuthMeta: true });
  }

  return null;
}
