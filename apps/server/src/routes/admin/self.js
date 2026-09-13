// 平台管理端「self」域路由：从 adminOrg.js 拆出，行为不变。
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

export async function handleSelf(ctx, part, method) {
  if (part === '/me/password' && method === 'PUT') {
    // 自助改密：任何登录中的平台管理员都能改自己的密码，不需要业务域权限
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const currentPassword = String(ctx.body?.currentPassword || '');
    const newPassword = String(ctx.body?.newPassword || '');
    if (!currentPassword) throw errors.badRequest('请输入当前密码', 'CURRENT_PASSWORD_REQUIRED');
    if (newPassword.length < 6) throw errors.badRequest('新密码至少6位', 'USER_PASSWORD_REQUIRED');
    if (newPassword === currentPassword) throw errors.badRequest('新密码不能与当前密码相同', 'PASSWORD_UNCHANGED');
    const me = row('SELECT * FROM users WHERE id=? AND deleted_at IS NULL', [auth.user.id]);
    if (!me) throw errors.notFound('账号不存在', 'USER_NOT_FOUND');
    if (!verifyPassword(currentPassword, me.password_hash)) throw errors.forbidden('当前密码不正确', 'CURRENT_PASSWORD_INVALID');
    const now = nowIso();
    transaction(() => {
      q('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', [hashPassword(newPassword), now, me.id]);
      // 改密后所有会话失效（含当前会话），前端据此重新登录
      q('UPDATE sessions SET superseded_at=? WHERE user_id=? AND superseded_at IS NULL', [now, me.id]);
      audit(ctx, 'PLATFORM_SELF_PASSWORD_UPDATE', 'USER', me.id, { login: me.login }, { passwordChanged: true }, { orgId: me.org_id || null });
    });
    return { passwordChanged: true, reauthRequired: true };
  }
  if (part === '/me/mfa' && method === 'GET') {
    // 二次验证自助端点：登录中的平台管理员即可查看自己的绑定状态
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    return mfaSummary(auth.user.id);
  }
  if (part === '/me/mfa/setup' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const setup = startMfaSetup(auth.user.id, { account: auth.user.login, issuer: platformIssuerName() });
    audit(ctx, 'PLATFORM_MFA_SETUP', 'USER', auth.user.id, null, { account: auth.user.login });
    return setup;
  }
  if (part === '/me/mfa/enable' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const code = String(ctx.body?.code || '').trim();
    return transaction(() => {
      const result = enableMfa(auth.user.id, code);
      audit(ctx, 'PLATFORM_MFA_ENABLE', 'USER', auth.user.id, null, { account: auth.user.login, recoveryCodes: result.recoveryCodes.length });
      return result;
    });
  }
  if (part === '/me/mfa/disable' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    assertSelfPassword(ctx, auth, '关闭二次验证');
    const code = String(ctx.body?.code || '').trim();
    return transaction(() => {
      const result = disableMfa(auth.user.id, code);
      audit(ctx, 'PLATFORM_MFA_DISABLE', 'USER', auth.user.id, { account: auth.user.login }, { enabled: false });
      return result;
    });
  }
  if (part === '/me/mfa/recovery-codes' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    assertSelfPassword(ctx, auth, '重新生成恢复码');
    const code = String(ctx.body?.code || '').trim();
    return transaction(() => {
      const result = regenerateRecoveryCodes(auth.user.id, code);
      audit(ctx, 'PLATFORM_MFA_RECOVERY_REGENERATE', 'USER', auth.user.id, null, { account: auth.user.login, recoveryCodes: result.recoveryCodes.length });
      return result;
    });
  }
  return null;
}
