// 平台管理端「users」域路由：从 adminOrg.js 拆出，行为不变。
import {
  audit, count, errors, id, json, normalizeClass, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  assignmentActiveSql, PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction, verifyPassword,
} from '../../lib.js';
import { hashPassword } from '@platform/database';
import { randomUUID } from 'node:crypto';
import { adjustCredits, normalizeEntry, reconcileCredits, refundOrReverseEntry, setFrozenCredits } from '../../services/creditLedger.js';
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
  assertTeachingClassManager,
  auditListQuery,
  auditQuery,
  auditRow,
  buildOrganizationDetail,
  buildStudentDataExport,
  bumpSeriesVersion,
  classDetail,
  classInOrg,
  classMemberships,
  classProgressRows,
  classSessionRows,
  contactPayload,
  createMember,
  csvDocument,
  csvFileName,
  curriculumItem,
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
  orgAccountRequestRow,
  orgAccountRequestRows,
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
  teacherCanAccessClass,
  teacherScope,
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

export async function handleUsers(ctx, part, method) {
  if (part === '/platform-users' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const role = ctx.search.get('role'); const orgIdFilter = ctx.search.get('orgId'); const search = String(ctx.search.get('search') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const sortKey = String(ctx.search.get('sort') || 'created').trim();
    const sort = Object.hasOwn({ created: true, name: true, status: true }, sortKey) ? sortKey : 'created';
    const sortSql = {
      created: 'user.created_at DESC, user.id DESC',
      name: 'user.display_name COLLATE NOCASE ASC, user.id DESC',
      status: 'user.status ASC, user.created_at DESC, user.id DESC',
    }[sort];
    const { where, params } = platformUserFilters(ctx);
    const total = Number(row('SELECT COUNT(*) n FROM users user WHERE ' + where, params)?.n || 0);
    const items = rows(
      'SELECT user.*, organization.name organization_name, billing_package.name billing_package_name FROM users user LEFT JOIN organizations organization ON organization.id=user.org_id LEFT JOIN billing_packages billing_package ON billing_package.id=user.billing_package_id WHERE ' + where + ' ORDER BY ' + sortSql + ' LIMIT ? OFFSET ?',
      [...params, limit, (page - 1) * limit],
    ).map(platformUserRow);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  if (part === '/platform-users/export' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const { where, params } = platformUserFilters(ctx);
    const items = rows(
      'SELECT user.*, organization.name organization_name, billing_package.name billing_package_name FROM users user LEFT JOIN organizations organization ON organization.id=user.org_id LEFT JOIN billing_packages billing_package ON billing_package.id=user.billing_package_id WHERE ' + where + ' ORDER BY user.created_at DESC, user.id DESC LIMIT 5000',
      params,
    );
    const content = csvDocument(
      ['登录名', '姓名', '角色', '机构', '状态', '手机号', '套餐', '有效期至', '创建时间'],
      items.map((user) => [user.login, user.display_name, user.role, user.organization_name || '平台', user.status, user.phone || '', user.billing_package_name || '', user.expires_at || '', user.created_at]),
    );
    audit(ctx, 'PLATFORM_USER_EXPORT', 'USER', null, null, { count: items.length, filters: { role: ctx.search.get('role') || null, orgId: ctx.search.get('orgId') || null, search: ctx.search.get('search') || null } });
    return { filename: csvFileName('platform-users'), content, count: items.length };
  }
  const platformUserDetailMatch = part.match(/^\/platform-users\/([^/]+)$/);
  if (platformUserDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const target = row('SELECT user.*, organization.name organization_name, billing_package.name billing_package_name FROM users user LEFT JOIN organizations organization ON organization.id=user.org_id LEFT JOIN billing_packages billing_package ON billing_package.id=user.billing_package_id WHERE user.id=? AND user.deleted_at IS NULL', [platformUserDetailMatch[1]]);
    if (!target) throw errors.notFound('用户不存在', 'USER_NOT_FOUND');
    return platformUserRow(target);
  }
  const platformUserMatch = part.match(/^\/platform-users\/([^/]+)\/(status|password|phone|role)$/);
  if (platformUserMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const target = row('SELECT * FROM users WHERE id=? AND deleted_at IS NULL', [platformUserMatch[1]]);
    if (!target) throw errors.notFound('用户不存在', 'USER_NOT_FOUND');
    const body = ctx.body || {}; const now = nowIso();
    const targetWithJoins = 'SELECT user.*, organization.name organization_name, billing_package.name billing_package_name FROM users user LEFT JOIN organizations organization ON organization.id=user.org_id LEFT JOIN billing_packages billing_package ON billing_package.id=user.billing_package_id WHERE user.id=?';
    if (platformUserMatch[2] === 'role') {
      // 平台侧只调整机构内角色；平台管理员角色在「平台管理员」页单独管理，避免这里成为提权入口
      const role = String(body.role || '').trim().toUpperCase();
      if (!['STUDENT', 'TEACHER', 'ORG_ADMIN'].includes(role)) throw errors.badRequest('只能调整为学生 / 教师 / 机构管理员', 'INVALID_USER_ROLE');
      if (target.role === 'SUPER_ADMIN') throw errors.forbidden('平台管理员角色请在「平台管理员」页管理', 'PLATFORM_ADMIN_ROLE_IMMUTABLE');
      if (target.role === role) return platformUserRow(row(targetWithJoins, [target.id]));
      if (!target.org_id) throw errors.badRequest('该用户没有所属机构，不能调整机构内角色', 'USER_ORG_REQUIRED');
      q('UPDATE users SET role=?,updated_at=? WHERE id=?', [role, now, target.id]);
      q('UPDATE sessions SET superseded_at=? WHERE user_id=? AND superseded_at IS NULL', [now, target.id]);
      audit(ctx, 'PLATFORM_USER_ROLE', 'USER', target.id, { login: target.login, role: target.role }, { role }, { orgId: target.org_id || null });
      return platformUserRow(row(targetWithJoins, [target.id]));
    }
    if (platformUserMatch[2] === 'status') {
      const status = body.status;
      if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('用户状态无效', 'INVALID_USER_STATUS');
      if (status === target.status) { const unchanged = row(targetWithJoins, [target.id]); return platformUserRow(unchanged); }
      assertTransition(ctx, 'user', target.status, status, { targetType: 'USER', targetId: target.id, before: target, code: 'INVALID_USER_STATUS' });
      if (status === 'DISABLED') {
        if (target.id === auth.user.id) throw errors.badRequest('不能停用当前登录账号', 'ADMIN_SELF_DISABLE_FORBIDDEN');
        lastSuperAdminGuard(target);
      }
      q('UPDATE users SET status=?,updated_at=? WHERE id=?', [status, now, target.id]);
      if (status === 'DISABLED') q('UPDATE sessions SET superseded_at=? WHERE user_id=? AND superseded_at IS NULL', [now, target.id]);
      audit(ctx, 'PLATFORM_USER_STATUS', 'USER', target.id, { login: target.login, displayName: target.display_name, status: target.status }, { status }, { orgId: target.org_id || null });
      return platformUserRow(row(targetWithJoins, [target.id]));
    }
    if (platformUserMatch[2] === 'password') {
      const password = String(body.password || '');
      if (password.length < 6) throw errors.badRequest('密码至少6位', 'USER_PASSWORD_REQUIRED');
      q('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', [hashPassword(password), now, target.id]);
      q('UPDATE sessions SET superseded_at=? WHERE user_id=? AND superseded_at IS NULL', [now, target.id]);
      audit(ctx, 'PLATFORM_USER_PASSWORD_RESET', 'USER', target.id, { login: target.login }, { passwordChanged: true }, { orgId: target.org_id || null });
      return { id: target.id, login: target.login, passwordReset: true };
    }
    const phone = validateMemberPhone(body.phone === undefined ? '' : body.phone, target.id);
    q('UPDATE users SET phone=?,phone_verified_at=?,updated_at=? WHERE id=?', [phone, phone ? (target.phone_verified_at || now) : null, now, target.id]);
    audit(ctx, 'PLATFORM_USER_PHONE_UPDATE', 'USER', target.id, { phone: target.phone || null }, { phone }, { orgId: target.org_id || null });
    return platformUserRow(row(targetWithJoins, [target.id]));
  }
  return null;
}
