import {
  audit, count, errors, id, json, normalizeClass, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction,
} from '../lib.js';
import { hashPassword } from '@platform/database';
import { adjustCredits, normalizeEntry, reconcileCredits, refundOrReverseEntry, setFrozenCredits } from '../services/creditLedger.js';
import { scheduleReminder } from './communication.js';
import { assertKnownState, assertTransition } from '../services/domainState.js';

import {
  ensureOrgBilling,
  integer,
  normalizeDeliveryMode,
  normalizeClassroomConfig,
  orgId,
  orgUser,
  hasPermission,
  classInOrg,
  assertTeachingClassManager,
  accessibleLesson,
  replaceLessonCanvasConfig,
  validateSeriesForPublishing,
  accessibleSeries,
  ORG_MEMBER_ROLES,
  ORG_TEACHER_PERMISSIONS,
  validateMemberPhone,
  validateMemberPermissions,
  classMemberships,
  orgMemberRow,
  ENROLLMENT_STATUSES,
  PAYMENT_STATUSES,
  packageSnapshot,
  enrollmentDate,
  enrollmentRow,
  normalizeEnrollment,
  appendEnrollmentEvent,
  expireDueEnrollments,
  occupiedStudentSeats,
  assertEnrollmentSeat,
  setStudentEnrollmentAccess,
  packageWithSeatUsage,
  teacherCanAccessClass,
  teacherScope,
  classSessionRows,
  classProgressRows,
  classDetail,
  importItems,
  validateImportItem,
  previewImport,
  createMember,
  validateTeacher,
  platformAdminPermissions,
  hasAnyPlatformPermission,
  platformUserRow,
  lastSuperAdminGuard,
  bumpSeriesVersion,
  userLoginMeta,
  curriculumItem,
  orgAccountRequestRow,
  orgAccountRequestRows,
  buildStudentDataExport,
  softDeleteStudent,
  workInReviewScope,
  annotationRows,
  assertAnnotationNode,
  workReportRows,
  workReportInReviewScope,
  reportResolution,
  normalizeWorkPublishRequest,
  orgWorkPublishRequestRow,
  orgWorkPublishRequestRows,
  organizationRow,
  contactPayload,
  orgAdminRows,
  assertNotLastOrgAdmin,
  orgContractMeta,
  auditQuery,
  auditRow,
  auditListQuery,
  escapeCsv,
  buildOrganizationDetail
} from './adminOrg.js';
export async function handleAdminCreditManagement(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/admin/')) return null;
  const auth = requireRole(ctx, ['SUPER_ADMIN']);
  let match = pathname.match(/^\/api\/admin\/organizations\/([^/]+)\/credit-adjustments$/);
  if (match && method === 'POST') {
    const organization = row('SELECT id FROM organizations WHERE id=?', [match[1]]);
    if (!organization) throw errors.notFound('机构不存在', 'ORG_NOT_FOUND');
    const body = ctx.body || {};
    const credits = integer(body.credits, '充值积分', { min: 1, max: 1000000000 });
    ensureOrgBilling(organization.id);
    const amountFen = body.amountFen == null ? null : integer(body.amountFen, '付款金额（分）', { min: 0, max: 100000000000 });
    const paymentMethod = body.paymentMethod ? String(body.paymentMethod).slice(0, 50) : null;
    const paymentReference = body.paymentReference ? String(body.paymentReference).slice(0, 100) : null;
    const reason = String(body.reason || '线下充值').slice(0, 300);
    const result = transaction(() => {
      const account = row('SELECT credit_balance FROM org_billing_accounts WHERE org_id=?', [organization.id]);
      const balanceAfter = Number(account.credit_balance || 0) + credits;
      const detail = [reason, paymentMethod && `方式：${paymentMethod}`, paymentReference && `凭证：${paymentReference}`].filter(Boolean).join('，');
      q('UPDATE org_billing_accounts SET credit_balance=?,total_credits_in=total_credits_in+?,currency_paid_total_fen=currency_paid_total_fen+?,updated_version=updated_version+1 WHERE org_id=?', [balanceAfter, credits, amountFen || 0, organization.id]);
      const entryId = id('credit');
      q('INSERT INTO credit_entries(id,org_id,direction,type,credits,balance_after,status,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [entryId, organization.id, 'IN', 'PLATFORM_ADJUSTMENT', credits, balanceAfter, 'EFFECTIVE', detail, auth.user.id, nowIso()]);
      return { balanceAfter, entryId };
    });
    audit(ctx, 'ORG_CREDIT_ADJUST', 'ORG', organization.id, null, { ...body, balanceAfter: result.balanceAfter });
    return { balanceAfter: result.balanceAfter, entryId: result.entryId };
  }
  match = pathname.match(/^\/api\/admin\/organizations\/([^/]+)\/billing\/account$/);
  if (match && method === 'GET') {
    const organization = row('SELECT id,name FROM organizations WHERE id=?', [match[1]]);
    if (!organization) throw errors.notFound('机构不存在', 'ORG_NOT_FOUND');
    ensureOrgBilling(organization.id);
    const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [organization.id]);
    const last = row("SELECT credits,created_at FROM credit_entries WHERE org_id=? AND direction='IN' ORDER BY created_at DESC LIMIT 1", [organization.id]);
    return { orgId: organization.id, orgName: organization.name, creditBalance: Number(account.credit_balance || 0), frozenCredits: Number(account.frozen_credits || 0), totalCreditsIn: Number(account.total_credits_in || 0), totalCreditsSpent: Number(account.total_credits_spent || 0), currencyPaidTotalFen: Number(account.currency_paid_total_fen || 0), lastRechargeAt: last?.created_at || null, lastRechargeCredits: Number(last?.credits || 0) };
  }
  match = pathname.match(/^\/api\/admin\/organizations\/([^/]+)\/billing\/recharge-history$/);
  if (match && method === 'GET') {
    const organization = row('SELECT id FROM organizations WHERE id=?', [match[1]]);
    if (!organization) throw errors.notFound('机构不存在', 'ORG_NOT_FOUND');
    const page = Math.max(1, Number(ctx.search.get('page') || 1)); const limit = Math.min(100, Math.max(1, Number(ctx.search.get('limit') || 20))); const offset = (page - 1) * limit;
    const items = rows("SELECT ce.*,u.display_name actor_name FROM credit_entries ce LEFT JOIN users u ON u.id=ce.actor_id WHERE ce.org_id=? AND ce.direction='IN' ORDER BY ce.created_at DESC LIMIT ? OFFSET ?", [organization.id, limit, offset]);
    const total = count("SELECT COUNT(*) n FROM credit_entries WHERE org_id=? AND direction='IN'", [organization.id]);
    return { items: items.map(item => ({ id:item.id, credits:Number(item.credits), balanceAfter:Number(item.balance_after), reason:item.reason, actorName:item.actor_name, createdAt:item.created_at })), total, page, totalPages: Math.ceil(total / limit) };
  }
  return null;
}

