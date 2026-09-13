// 平台管理端「organizations」域路由：从 adminOrg.js 拆出，行为不变。
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

export async function handleOrganizations(ctx, part, method) {
  if (part === '/organizations' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 100 });
    const sortKey = String(ctx.search.get('sort') || 'created').trim();
    const sort = Object.hasOwn({ created: true, name: true, expires: true }, sortKey) ? sortKey : 'created';
    const sortSql = {
      created: 'organization.created_at DESC, organization.id DESC',
      name: 'organization.name COLLATE NOCASE ASC, organization.id DESC',
      expires: 'organization.contract_expires_at ASC, organization.id DESC',
    }[sort];
    const { where, params } = organizationFilters(ctx);
    const total = Number(row('SELECT COUNT(*) n FROM organizations organization' + where, params)?.n || 0);
    const items = rows('SELECT organization.* FROM organizations organization' + where + ' ORDER BY ' + sortSql + ' LIMIT ? OFFSET ?', [...params, limit, (page - 1) * limit]).map(normalizeOrg);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  if (part === '/organizations/export' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const { where, params } = organizationFilters(ctx);
    const items = rows('SELECT organization.* FROM organizations organization' + where + ' ORDER BY organization.created_at DESC, organization.id DESC LIMIT 2000', params);
    const content = csvDocument(
      ['机构名称', '机构ID', '状态', '试用', '合同开始', '合同到期', '基础教师席位', '购买教师席位', '创建时间'],
      items.map((org) => [org.name, org.id, org.status, org.is_trial ? '是' : '否', org.contract_start_at || '', org.contract_expires_at || '', org.base_teacher_seats, org.purchased_teacher_seats, org.created_at]),
    );
    audit(ctx, 'PLATFORM_ORG_EXPORT', 'ORGANIZATION', null, null, { count: items.length, filters: { status: ctx.search.get('status') || null, search: ctx.search.get('search') || null } });
    return { filename: csvFileName('organizations'), content, count: items.length };
  }
  if (part === '/organizations' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const body = ctx.body || {}; const name = String(body.name || '').trim();
    if (!name) throw errors.badRequest('机构名称不能为空');
    if (row('SELECT id FROM organizations WHERE name=?', [name])) throw errors.conflict('机构名称已存在', 'ORG_NAME_EXISTS');
    const now = nowIso(); const organizationId = id('org');
    transaction(() => {
      q('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,contact,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [organizationId, name, body.isTrial ? 'TRIAL' : 'ACTIVE', body.contractStartAt || now, body.contractExpiresAt || new Date(Date.now() + 365 * 86400000).toISOString(), body.isTrial ? 1 : 0, integer(body.baseTeacherSeats, '基础教师席位', { fallback: 3 }), integer(body.purchasedTeacherSeats, '购买教师席位'), json(body.contact || {}), auth.user.id, now, now]);
      ensureOrgBilling(organizationId);
      if (body.adminLogin) q('INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [id('user'), organizationId, String(body.adminLogin).trim(), String(body.adminDisplayName || body.adminLogin).trim(), 'ORG_ADMIN', '[]', hashPassword(String(body.adminPassword || 'org123')), 'ACTIVE', now, now]);
    });
    audit(ctx, 'ORG_CREATE', 'ORG', organizationId, null, { name });
    return normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [organizationId]));
  }
  // 下拉/筛选专用：只返回 id/name/status，上限 500 并带 total，避免前端用分页接口当选项源而静默丢机构
  if (part === '/organizations/options' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const total = Number(row('SELECT COUNT(*) n FROM organizations')?.n || 0);
    const items = rows('SELECT id,name,status FROM organizations ORDER BY name COLLATE NOCASE,id LIMIT 500')
      .map((item) => ({ id: item.id, name: item.name, status: item.status }));
    return { items, total, limit: 500 };
  }
  let match = part.match(/^\/organizations\/([^/]+)$/);
  if (match && ['GET', 'PUT'].includes(method)) {
    requireRole(ctx, ['SUPER_ADMIN']); const organization = organizationRow(match[1]);
    if (method === 'GET') return normalizeOrg(organization);
    const body = ctx.body || {};
    if (body.status !== undefined && body.status !== organization.status) throw errors.badRequest('机构状态必须通过状态动作接口修改', 'ORG_STATUS_ACTION_REQUIRED');
    const name = body.name === undefined ? organization.name : nonEmptyString(body.name, '机构名称', { max: 200 });
    if (name !== organization.name && row('SELECT id FROM organizations WHERE name=?', [name])) throw errors.conflict('机构名称已存在', 'ORG_NAME_EXISTS');
    const contractStartAt = body.contractStartAt === undefined ? organization.contract_start_at : nonEmptyString(body.contractStartAt, '合同开始时间', { max: 64 });
    const contractExpiresAt = body.contractExpiresAt === undefined ? organization.contract_expires_at : nonEmptyString(body.contractExpiresAt, '合同到期时间', { max: 64 });
    if (contractStartAt >= contractExpiresAt) throw errors.badRequest('合同开始时间必须早于到期时间', 'INVALID_CONTRACT_TIME');
    const baseTeacherSeats = body.baseTeacherSeats === undefined ? organization.base_teacher_seats : integer(body.baseTeacherSeats, '基础教师席位');
    const purchasedTeacherSeats = body.purchasedTeacherSeats === undefined ? organization.purchased_teacher_seats : integer(body.purchasedTeacherSeats, '购买教师席位');
    if (baseTeacherSeats + purchasedTeacherSeats < organization.base_teacher_seats + organization.purchased_teacher_seats) throw errors.badRequest('教师席位总数不能低于当前配置，请先确认教师数量', 'TEACHER_SEATS_TOO_FEW');
    const contact = body.contact === undefined ? parseJson(organization.contact, {}) : contactPayload(body.contact);
    const before = normalizeOrg(organization);
    q('UPDATE organizations SET name=?,contract_start_at=?,contract_expires_at=?,base_teacher_seats=?,purchased_teacher_seats=?,contact=?,updated_at=? WHERE id=?', [name, contractStartAt, contractExpiresAt, baseTeacherSeats, purchasedTeacherSeats, json(contact), nowIso(), organization.id]);
    const after = normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [organization.id]));
    audit(ctx, 'ORG_UPDATE', 'ORG', organization.id, before, { name: after.name, contractStartAt, contractExpiresAt, baseTeacherSeats, purchasedTeacherSeats, contact }, { orgId: organization.id });
    return after;
  }
  match = part.match(/^\/organizations\/([^/]+)\/seat-adjustments$/);
  if (match && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const organization = row('SELECT * FROM organizations WHERE id=?', [match[1]]);
    if (!organization) throw errors.notFound('机构不存在', 'ORG_NOT_FOUND');
    // 2026-09-13（P4 删积分）：原来的 credit-adjustments（平台给机构充值/调整积分）已删除。
    q('UPDATE organizations SET purchased_teacher_seats=?,updated_at=? WHERE id=?', [integer(ctx.body?.purchasedTeacherSeats, '购买教师席位'), nowIso(), organization.id]);
    audit(ctx, 'ORG_SEAT_ADJUST', 'ORG', organization.id, null, ctx.body); return normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [organization.id]));
  }
  let orgDetailMatch = part.match(/^\/organizations\/([^/]+)\/detail$/);
  if (orgDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return buildOrganizationDetail(orgDetailMatch[1]);
  }

  let orgAdminMatch = part.match(/^\/organizations\/([^/]+)\/admins$/);
  if (orgAdminMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const organization = organizationRow(orgAdminMatch[1]);
    return { items: orgAdminRows(organization.id) };
  }
  if (orgAdminMatch && method === 'POST') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const organization = organizationRow(orgAdminMatch[1]);
    const body = ctx.body || {}; const now = nowIso();
    const login = String(body.login || '').trim(); const displayName = String(body.displayName || '').trim(); const password = String(body.password || '');
    if (!login || !displayName) throw errors.badRequest('登录名和姓名不能为空', 'ORG_ADMIN_INPUT_REQUIRED');
    if (password.length < 6) throw errors.badRequest('管理员密码至少6位', 'ORG_ADMIN_INPUT_REQUIRED');
    if (row('SELECT id FROM users WHERE login=?', [login])) throw errors.conflict('登录名已存在', 'LOGIN_EXISTS');
    const userId = id('user');
    q('INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [userId, organization.id, login, displayName, 'ORG_ADMIN', '[]', hashPassword(password), 'ACTIVE', now, now]);
    const admin = row('SELECT * FROM users WHERE id=?', [userId]);
    audit(ctx, 'ORG_ADMIN_CREATE', 'USER', userId, null, { orgId: organization.id, login, displayName }, { orgId: organization.id });
    return normalizeUser(admin);
  }

  let orgAdminUpdateMatch = part.match(/^\/organizations\/([^/]+)\/admins\/([^/]+)$/);
  if (orgAdminUpdateMatch && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const organization = organizationRow(orgAdminUpdateMatch[1]);
    const target = row("SELECT * FROM users WHERE id=? AND org_id=? AND role='ORG_ADMIN' AND deleted_at IS NULL", [orgAdminUpdateMatch[2], organization.id]);
    if (!target) throw errors.notFound('机构管理员不存在', 'ORG_ADMIN_NOT_FOUND');
    const body = ctx.body || {};
    const displayName = body.displayName === undefined ? target.display_name : String(body.displayName || '').trim();
    if (!displayName) throw errors.badRequest('管理员姓名不能为空', 'ORG_ADMIN_INPUT_REQUIRED');
    let passwordHash = target.password_hash;
    if (body.password !== undefined) {
      const password = String(body.password || '');
      if (password.length < 6) throw errors.badRequest('管理员密码至少6位', 'ORG_ADMIN_INPUT_REQUIRED');
      passwordHash = hashPassword(password);
    }
    let status = target.status;
    if (body.status !== undefined) {
      status = body.status;
      if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('管理员状态无效', 'INVALID_ORG_ADMIN_STATUS');
      if (status === 'DISABLED') assertNotLastOrgAdmin(organization.id, target.id);
    }
    q('UPDATE users SET display_name=?,password_hash=?,status=?,updated_at=? WHERE id=?', [displayName, passwordHash, status, nowIso(), target.id]);
    if (status === 'DISABLED' && target.status !== 'DISABLED') q('UPDATE sessions SET superseded_at=? WHERE user_id=? AND superseded_at IS NULL', [nowIso(), target.id]);
    audit(ctx, 'ORG_ADMIN_UPDATE', 'USER', target.id, { login: target.login, displayName: target.display_name, status: target.status }, { displayName, status, passwordChanged: body.password !== undefined }, { orgId: organization.id });
    return normalizeUser(row('SELECT * FROM users WHERE id=?', [target.id]));
  }

  let orgStatusMatch = part.match(/^\/organizations\/([^/]+)\/status$/);
  if (orgStatusMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const organization = organizationRow(orgStatusMatch[1]);
    const action = String(ctx.body?.action || '').trim();
    const transitions = {
      disable: { to: 'DISABLED', from: ['TRIAL', 'ACTIVE', 'FROZEN'], auditAction: 'ORG_DISABLE' },
      recover: { to: 'ACTIVE', from: ['DISABLED'], auditAction: 'ORG_RECOVER', requiresValidContract: true },
      freeze: { to: 'FROZEN', from: ['TRIAL', 'ACTIVE'], auditAction: 'ORG_FROZEN' },
      activate: { to: 'ACTIVE', from: ['TRIAL', 'FROZEN'], auditAction: 'ORG_ACTIVATE', requiresValidContract: true },
    };
    const transition = transitions[action];
    if (!transition) throw errors.badRequest('无效的机构状态操作', 'INVALID_ORG_STATUS_ACTION');
    assertTransition(ctx, 'organization', organization.status, transition.to, {
      targetType: 'ORGANIZATION', targetId: organization.id, before: normalizeOrg(organization),
      message: `当前状态 ${organization.status} 不允许执行 ${action}`, code: 'INVALID_ORG_STATUS_TRANSITION',
      details: { action }, allowedFrom: transition.from,
    });
    if (transition.requiresValidContract && organization.contract_expires_at <= nowIso()) throw errors.badRequest('机构合同已到期，请先续签合同再恢复服务', 'ORG_CONTRACT_EXPIRED');
    const before = normalizeOrg(organization);
    q('UPDATE organizations SET status=?,is_trial=?,updated_at=? WHERE id=?', [transition.to, transition.to === 'ACTIVE' ? 0 : organization.is_trial, nowIso(), organization.id]);
    const after = normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [organization.id]));
    audit(ctx, transition.auditAction, 'ORG', organization.id, before, { action, status: after.status, actor: auth.user.login }, { orgId: organization.id });
    return after;
  }

  return null;
}
