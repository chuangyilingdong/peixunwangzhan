// 平台管理端「organizations」域路由：从 adminOrg.js 拆出，行为不变。
import {
  audit, count, errors, id, json, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  assignmentActiveSql, pageParams, pageResult, PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction, verifyPassword, normalizeLogin, assertLoginAvailable, assertDisplayNameAvailable, arow, arows, aq, atransaction, amap } from '../../lib.js';
import { syncAssignmentExpiryForOrg } from '../../lib.js';
import { hashPassword, nextOrgCode } from '@platform/database';
import { randomUUID } from 'node:crypto';
import { scheduleReminder } from '../communication.js';
import { assertKnownState, assertTransition } from '../../services/domainState.js';
import { getAiProviderPolicy } from '../billingConfig.js';
import { effectiveCapabilities, normalizeAspectRatio } from '../../services/modelCapabilities.js';
import { disableMfa, enableMfa, mfaSummary, regenerateRecoveryCodes, startMfaSetup } from '../../services/mfa.js';
import { normalizeSubmission } from '../vibecoding.js';
import { COURSE_QUOTA_CHANGE_TYPES, COURSE_QUOTA_SOURCES, normalizeQuotaChange, recordQuotaChange } from '../../services/courseQuotaLedger.js';
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

/**
 * 机构的可选文本字段（简称 / 所属区域）：不传 = 不改；传空串 = 清空（落 NULL）；
 * 传了就 trim，超长直接报错（不静默截断，免得前端以为存进去了）。
 */
function optionalOrgText(value, field, { max = 100 } = {}) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw errors.badRequest(`${field}不能超过 ${max} 个字符`, 'VALIDATION_ERROR', { field });
  return text;
}

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
    const total = Number((await arow('SELECT COUNT(*) n FROM organizations organization' + where, params))?.n || 0);
    const items = await amap((await arows('SELECT organization.* FROM organizations organization' + where + ' ORDER BY ' + sortSql + ' LIMIT ? OFFSET ?', [...params, limit, (page - 1) * limit])), normalizeOrg);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  if (part === '/organizations/export' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const { where, params } = organizationFilters(ctx);
    const items = await arows('SELECT organization.* FROM organizations organization' + where + ' ORDER BY organization.created_at DESC, organization.id DESC LIMIT 2000', params);
    const content = csvDocument(
      ['机构名称', '机构ID', '状态', '试用', '合同开始', '合同到期', '基础教师席位', '购买教师席位', '创建时间'],
      items.map((org) => [org.name, org.id, org.status, org.is_trial ? '是' : '否', org.contract_start_at || '', org.contract_expires_at || '', org.base_teacher_seats, org.purchased_teacher_seats, org.created_at]),
    );
    await audit(ctx, 'PLATFORM_ORG_EXPORT', 'ORGANIZATION', null, null, { count: items.length, filters: { status: ctx.search.get('status') || null, search: ctx.search.get('search') || null } });
    return { filename: csvFileName('organizations'), content, count: items.length };
  }
  if (part === '/organizations' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const body = ctx.body || {}; const name = String(body.name || '').trim();
    if (!name) throw errors.badRequest('机构名称不能为空');
    if (await arow('SELECT id FROM organizations WHERE name=?', [name])) throw errors.conflict('机构名称已存在', 'ORG_NAME_EXISTS');
    const login = normalizeLogin(body.adminLogin, '管理员账号');
    const adminDisplayName = String(body.adminDisplayName || login).trim().slice(0, 100);
    const password = String(body.adminPassword || '');
    if (password.length < 6) throw errors.badRequest('请显式设置至少6位的管理员密码', 'ORG_ADMIN_INPUT_REQUIRED');
    await assertLoginAvailable(login);
    const now = nowIso(); const organizationId = id('org');
    const purchasedTeacherSeats = integer(body.purchasedTeacherSeats, '购买教师席位');
    const totalTeacherSeats = body.teacherSeats === undefined ? null : integer(body.teacherSeats, '教师数量上限');
    if (totalTeacherSeats !== null && totalTeacherSeats < purchasedTeacherSeats) throw errors.badRequest('教师数量上限不能低于已购买教师席位', 'TEACHER_SEATS_BELOW_PURCHASED');
    const baseTeacherSeats = totalTeacherSeats === null
      ? integer(body.baseTeacherSeats, '基础教师席位', { fallback: 3 })
      : totalTeacherSeats - purchasedTeacherSeats;
    const contractStartAt = enrollmentDate(body.contractStartAt, '合同开始时间', now);
    const contractExpiresAt = enrollmentDate(body.contractExpiresAt, '合同到期时间', new Date(Date.now() + 365 * 86400000).toISOString());
    if (contractStartAt >= contractExpiresAt) throw errors.badRequest('合同开始时间必须早于到期时间', 'INVALID_CONTRACT_TIME');
    // P03（2026-09-18 按线框图）：机构简称 / 所属区域随创建落库；机构编码由系统生成（ORG + 4 位序号，
    // 见 packages/database/src/schema.js 的 nextOrgCode）。编码**不接受前端自定义**，也不在界面上编辑。
    const shortName = optionalOrgText(body.shortName, '机构简称');
    const region = optionalOrgText(body.region, '所属区域');
    const orgCode = await nextOrgCode();   // RDS 阶段 2：mysql 驱动下这一步是异步的（sqlite 下 await 是空操作）
    await atransaction(async () => {
      await aq('INSERT INTO organizations(id,name,short_name,org_code,region,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,student_seats,contact,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [organizationId, name, shortName, orgCode, region, body.isTrial ? 'TRIAL' : 'ACTIVE', contractStartAt, contractExpiresAt, body.isTrial ? 1 : 0, baseTeacherSeats, purchasedTeacherSeats, integer(body.studentSeats, '学生数量上限'), json(contactPayload(body.contact ?? {})), auth.user.id, now, now]);
      await ensureOrgBilling(organizationId);
      await aq('INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [id('user'), organizationId, login, adminDisplayName, 'ORG_ADMIN', '[]', hashPassword(password), 'ACTIVE', now, now]);
    });
    await audit(ctx, 'ORG_CREATE', 'ORG', organizationId, null, { name, shortName, orgCode, region });
    return await normalizeOrg(await arow('SELECT * FROM organizations WHERE id=?', [organizationId]));
  }
  // 下拉/筛选专用：只返回 id/name/status，上限 500 并带 total，避免前端用分页接口当选项源而静默丢机构
  if (part === '/organizations/options' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const total = Number((await arow('SELECT COUNT(*) n FROM organizations'))?.n || 0);
    const items = (await arows('SELECT id,name,status FROM organizations ORDER BY name COLLATE NOCASE,id LIMIT 500'))
      .map((item) => ({ id: item.id, name: item.name, status: item.status }));
    return { items, total, limit: 500 };
  }
  let match = part.match(/^\/organizations\/([^/]+)$/);
  if (match && ['GET', 'PUT'].includes(method)) {
    requireRole(ctx, ['SUPER_ADMIN']); const organization = await organizationRow(match[1]);
    if (method === 'GET') return await normalizeOrg(organization);
    const body = ctx.body || {};
    if (body.status !== undefined && body.status !== organization.status) throw errors.badRequest('机构状态必须通过状态动作接口修改', 'ORG_STATUS_ACTION_REQUIRED');
    const name = body.name === undefined ? organization.name : nonEmptyString(body.name, '机构名称', { max: 200 });
    if (name !== organization.name && await arow('SELECT id FROM organizations WHERE name=?', [name])) throw errors.conflict('机构名称已存在', 'ORG_NAME_EXISTS');
    // 机构编码**创建后不可变**（「可读且稳定」的前提：它是对外报的口径，改了就跟历史对不上）；
    // 机构简称 / 所属区域可改，传空串等于清空。
    if (body.orgCode !== undefined && String(body.orgCode).trim() !== String(organization.org_code || '')) {
      throw errors.badRequest('机构编码由系统生成，不支持修改', 'ORG_CODE_IMMUTABLE');
    }
    const shortName = body.shortName === undefined ? organization.short_name : optionalOrgText(body.shortName, '机构简称');
    const region = body.region === undefined ? organization.region : optionalOrgText(body.region, '所属区域');
    const contractStartAt = body.contractStartAt === undefined ? organization.contract_start_at : enrollmentDate(body.contractStartAt, '合同开始时间', null);
    const contractExpiresAt = body.contractExpiresAt === undefined ? organization.contract_expires_at : enrollmentDate(body.contractExpiresAt, '合同到期时间', null);
    if (contractStartAt >= contractExpiresAt) throw errors.badRequest('合同开始时间必须早于到期时间', 'INVALID_CONTRACT_TIME');
    const purchasedTeacherSeats = body.purchasedTeacherSeats === undefined ? organization.purchased_teacher_seats : integer(body.purchasedTeacherSeats, '购买教师席位');
    const totalTeacherSeats = body.teacherSeats === undefined ? null : integer(body.teacherSeats, '教师数量上限');
    if (totalTeacherSeats !== null && totalTeacherSeats < purchasedTeacherSeats) throw errors.badRequest('教师数量上限不能低于已购买教师席位', 'TEACHER_SEATS_BELOW_PURCHASED');
    const baseTeacherSeats = totalTeacherSeats === null
      ? (body.baseTeacherSeats === undefined ? organization.base_teacher_seats : integer(body.baseTeacherSeats, '基础教师席位'))
      : totalTeacherSeats - purchasedTeacherSeats;
    const studentSeats = body.studentSeats === undefined ? Number(organization.student_seats || 0) : integer(body.studentSeats, '学生数量上限');
    const contact = body.contact === undefined ? parseJson(organization.contact, {}) : contactPayload(body.contact);
    const before = await normalizeOrg(organization);
    await atransaction(async () => {
      const usage = await normalizeOrg(organization);
      if (baseTeacherSeats + purchasedTeacherSeats < usage.teacherUsedSeats) throw errors.conflict('教师上限不能低于现有人数', 'TEACHER_SEATS_TOO_FEW');
      if (studentSeats < usage.studentUsedSeats) throw errors.conflict('学生上限不能低于现有人数', 'STUDENT_SEAT_LIMIT');
      await aq('UPDATE organizations SET name=?,short_name=?,region=?,contract_start_at=?,contract_expires_at=?,base_teacher_seats=?,purchased_teacher_seats=?,student_seats=?,contact=?,updated_at=? WHERE id=?', [name, shortName, region, contractStartAt, contractExpiresAt, baseTeacherSeats, purchasedTeacherSeats, studentSeats, json(contact), nowIso(), organization.id]);
      // 授权有效期 = 机构合同到期日（2026-09-16 用户口径），所以合同一改就要同步过去：
      // 续签之后机构不该还因为「原来那条授权到期了」而看不到课包。
      if (contractExpiresAt !== organization.contract_expires_at) await syncAssignmentExpiryForOrg(organization.id, contractExpiresAt);
    });
    const after = await normalizeOrg(await arow('SELECT * FROM organizations WHERE id=?', [organization.id]));
    await audit(ctx, 'ORG_UPDATE', 'ORG', organization.id, before, { name: after.name, shortName: after.shortName, region: after.region, contractStartAt, contractExpiresAt, baseTeacherSeats, purchasedTeacherSeats, contact }, { orgId: organization.id });
    return after;
  }
  match = part.match(/^\/organizations\/([^/]+)\/seat-adjustments$/);
  if (match && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const organization = await arow('SELECT * FROM organizations WHERE id=?', [match[1]]);
    if (!organization) throw errors.notFound('机构不存在', 'ORG_NOT_FOUND');
    // 2026-09-13（P4 删积分）：原来的 credit-adjustments（平台给机构充值/调整积分）已删除。
    await atransaction(async () => {
      const seats = integer(ctx.body?.purchasedTeacherSeats, '购买教师席位');
      if (organization.base_teacher_seats + seats < (await normalizeOrg(organization)).teacherUsedSeats) throw errors.conflict('教师上限不能低于现有人数', 'TEACHER_SEATS_TOO_FEW');
      await aq('UPDATE organizations SET purchased_teacher_seats=?,updated_at=? WHERE id=?', [seats, nowIso(), organization.id]);
    });
    await audit(ctx, 'ORG_SEAT_ADJUST', 'ORG', organization.id, null, ctx.body); return await normalizeOrg(await arow('SELECT * FROM organizations WHERE id=?', [organization.id]));
  }
  let orgDetailMatch = part.match(/^\/organizations\/([^/]+)\/detail$/);
  if (orgDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return await buildOrganizationDetail(orgDetailMatch[1]);
  }

  let orgAdminMatch = part.match(/^\/organizations\/([^/]+)\/admins$/);
  if (orgAdminMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const organization = await organizationRow(orgAdminMatch[1]);
    return { items: await orgAdminRows(organization.id) };
  }
  if (orgAdminMatch && method === 'POST') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const organization = await organizationRow(orgAdminMatch[1]);
    const body = ctx.body || {}; const now = nowIso();
    const login = String(body.login || '').trim(); const displayName = String(body.displayName || '').trim(); const password = String(body.password || '');
    if (!displayName) throw errors.badRequest('姓名不能为空', 'ORG_ADMIN_INPUT_REQUIRED');
    if (password.length < 6) throw errors.badRequest('管理员密码至少6位', 'ORG_ADMIN_INPUT_REQUIRED');
    normalizeLogin(login, '登录名');
    await assertLoginAvailable(login);
    await assertDisplayNameAvailable(displayName, { orgId: organization.id, role: 'ORG_ADMIN' });
    const userId = id('user');
    await aq('INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [userId, organization.id, login, displayName, 'ORG_ADMIN', '[]', hashPassword(password), 'ACTIVE', now, now]);
    const admin = await arow('SELECT * FROM users WHERE id=?', [userId]);
    await audit(ctx, 'ORG_ADMIN_CREATE', 'USER', userId, null, { orgId: organization.id, login, displayName }, { orgId: organization.id });
    return normalizeUser(admin);
  }

  let orgAdminUpdateMatch = part.match(/^\/organizations\/([^/]+)\/admins\/([^/]+)$/);
  if (orgAdminUpdateMatch && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const organization = await organizationRow(orgAdminUpdateMatch[1]);
    const target = await arow("SELECT * FROM users WHERE id=? AND org_id=? AND role='ORG_ADMIN' AND deleted_at IS NULL", [orgAdminUpdateMatch[2], organization.id]);
    if (!target) throw errors.notFound('机构管理员不存在', 'ORG_ADMIN_NOT_FOUND');
    const body = ctx.body || {};
    const displayName = body.displayName === undefined ? target.display_name : String(body.displayName || '').trim();
    if (!displayName) throw errors.badRequest('管理员姓名不能为空', 'ORG_ADMIN_INPUT_REQUIRED');
    if (displayName !== target.display_name) await assertDisplayNameAvailable(displayName, { orgId: organization.id, role: 'ORG_ADMIN', excludeUserId: target.id });
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
      if (status === 'DISABLED') await assertNotLastOrgAdmin(organization.id, target.id);
    }
    await aq('UPDATE users SET display_name=?,password_hash=?,status=?,updated_at=? WHERE id=?', [displayName, passwordHash, status, nowIso(), target.id]);
    if (status === 'DISABLED' && target.status !== 'DISABLED') await aq('UPDATE sessions SET superseded_at=? WHERE user_id=? AND superseded_at IS NULL', [nowIso(), target.id]);
    await audit(ctx, 'ORG_ADMIN_UPDATE', 'USER', target.id, { login: target.login, displayName: target.display_name, status: target.status }, { displayName, status, passwordChanged: body.password !== undefined }, { orgId: organization.id });
    return normalizeUser(await arow('SELECT * FROM users WHERE id=?', [target.id]));
  }

  let orgStatusMatch = part.match(/^\/organizations\/([^/]+)\/status$/);
  if (orgStatusMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const organization = await organizationRow(orgStatusMatch[1]);
    const action = String(ctx.body?.action || '').trim();
    const transitions = {
      disable: { to: 'DISABLED', from: ['TRIAL', 'ACTIVE', 'FROZEN'], auditAction: 'ORG_DISABLE' },
      recover: { to: 'ACTIVE', from: ['DISABLED'], auditAction: 'ORG_RECOVER', requiresValidContract: true },
      freeze: { to: 'FROZEN', from: ['TRIAL', 'ACTIVE'], auditAction: 'ORG_FROZEN' },
      activate: { to: 'ACTIVE', from: ['TRIAL', 'FROZEN'], auditAction: 'ORG_ACTIVATE', requiresValidContract: true },
    };
    const transition = transitions[action];
    if (!transition) throw errors.badRequest('无效的机构状态操作', 'INVALID_ORG_STATUS_ACTION');
    await assertTransition(ctx, 'organization', organization.status, transition.to, {
      targetType: 'ORGANIZATION', targetId: organization.id, before: await normalizeOrg(organization),
      message: `当前状态 ${organization.status} 不允许执行 ${action}`, code: 'INVALID_ORG_STATUS_TRANSITION',
      details: { action }, allowedFrom: transition.from,
    });
    if (transition.requiresValidContract && organization.contract_expires_at <= nowIso()) throw errors.badRequest('机构合同已到期，请先续签合同再恢复服务', 'ORG_CONTRACT_EXPIRED');
    // 禁用必须写原因（P03 图4「禁用机构」抽屉）：空/纯空格 400、上限 500。
    // 恢复 / 冻结 / 激活**不强制**（线框图只有禁用这一个动作要求原因），但传了就一起落审计。
    let reason = String(ctx.body?.reason ?? '').trim();
    if (action === 'disable') {
      if (!reason) throw errors.badRequest('禁用机构必须填写原因', 'ORG_DISABLE_REASON_REQUIRED');
      if (reason.length > 500) throw errors.badRequest('禁用原因不能超过 500 个字符', 'ORG_DISABLE_REASON_TOO_LONG');
    }
    if (reason.length > 500) reason = reason.slice(0, 500);
    const before = await normalizeOrg(organization);
    await aq('UPDATE organizations SET status=?,is_trial=?,updated_at=? WHERE id=?', [transition.to, transition.to === 'ACTIVE' ? 0 : organization.is_trial, nowIso(), organization.id]);
    const after = await normalizeOrg(await arow('SELECT * FROM organizations WHERE id=?', [organization.id]));
    // reason 落进审计（原来只有 {action,status,actor}）——「为什么禁用它」是这条审计的全部价值。
    await audit(ctx, transition.auditAction, 'ORG', organization.id, before, { action, status: after.status, actor: auth.user.login, reason: reason || null }, { orgId: organization.id });
    return after;
  }

  /**
   * 平台侧「调整某机构某课包的授权次数」（P03-03 图7「调整授权次数」抽屉的服务端）。
   *
   * 口径（用户 2026-09-18）：
   *   · 改的是**总授权次数** `course_assignments.quota_total`（按 org_id + series_id 找那条 ACTIVE 的授权单）。
   *   · `delta` 必须是非零整数（可正可负）；`reason` 必填、上限 200（图7 的「调整原因」）。
   *   · 硬校验：调整后不得小于**已授权次数** `quota_used`（图7 那条橙色警示），否则 409 并把当前值说清；
   *     同时不得为负。
   *   · **不生成许可批次**（财务账不受影响，用户未要求联动）——两者是不同口径，见 courseQuotaLedger.js 表头。
   *   · 整个过程在一个事务里：改授权单 + 写流水（ADD/REDUCE），任一步失败则一起回滚。
   */
  const quotaAdjustMatch = part.match(/^\/organizations\/([^/]+)\/course-quotas\/([^/]+)\/adjust$/);
  if (quotaAdjustMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const organization = await organizationRow(quotaAdjustMatch[1]);
    const seriesId = String(quotaAdjustMatch[2] || '').trim();
    const series = await arow('SELECT id, title FROM course_series WHERE id=?', [seriesId]);
    if (!series) throw errors.notFound('课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const delta = integer(ctx.body?.delta, '调整值', { min: -100000000, max: 100000000, fallback: null });
    if (delta === null) throw errors.badRequest('请填写调整值（非零整数）', 'INVALID_QUOTA_DELTA');
    if (!delta) throw errors.badRequest('调整值不能为 0（正数=增加授权次数，负数=减少授权次数）', 'INVALID_QUOTA_DELTA');
    const reason = nonEmptyString(ctx.body?.reason, '调整原因', { max: 200 });
    const applied = await atransaction(async () => {
      const assignment = await arow("SELECT * FROM course_assignments WHERE org_id=? AND series_id=? AND status='ACTIVE'", [organization.id, series.id]);
      if (!assignment) throw errors.notFound('该机构没有此课包的有效授权，请先给机构开通课包', 'ASSIGNMENT_NOT_FOUND');
      const quotaTotalBefore = Number(assignment.quota_total || 0);
      const quotaUsedBefore = Number(assignment.quota_used || 0);
      const quotaTotalAfter = quotaTotalBefore + delta;
      if (quotaTotalAfter < 0) throw errors.conflict('调整后总授权次数不能为负', 'COURSE_QUOTA_NEGATIVE');
      if (quotaTotalAfter < quotaUsedBefore) {
        throw errors.conflict(`调整后总授权次数（${quotaTotalAfter}）不能少于当前已授权次数（${quotaUsedBefore}）`, 'COURSE_QUOTA_BELOW_USED');
      }
      await aq('UPDATE course_assignments SET quota_total=? WHERE id=?', [quotaTotalAfter, assignment.id]);
      const change = await recordQuotaChange({
        orgId: organization.id, seriesId: series.id, assignmentId: assignment.id,
        changeType: delta > 0 ? 'ADD' : 'REDUCE',
        quotaTotalBefore, quotaUsedBefore,
        actorId: auth.user.id, actorRole: auth.user.role, reason,
        source: COURSE_QUOTA_SOURCES.ADMIN_ADJUST,
      });
      return { assignmentId: assignment.id, expiresAt: assignment.expires_at || null, quotaTotalBefore, quotaUsedBefore, quotaTotalAfter, quotaUsedAfter: quotaUsedBefore, change };
    });
    await audit(ctx, 'ORG_COURSE_QUOTA_ADJUST', 'COURSE_ASSIGNMENT', applied.assignmentId,
      { orgId: organization.id, seriesId: series.id, quotaTotal: applied.quotaTotalBefore, quotaUsed: applied.quotaUsedBefore },
      { orgId: organization.id, seriesId: series.id, quotaTotal: applied.quotaTotalAfter, quotaUsed: applied.quotaUsedAfter, delta, reason },
      { orgId: organization.id });
    return {
      orgId: organization.id, seriesId: series.id, seriesTitle: series.title || null,
      assignmentId: applied.assignmentId, expiresAt: applied.expiresAt,
      delta, reason,
      quotaTotal: applied.quotaTotalAfter,
      quotaUsed: applied.quotaUsedAfter,
      remaining: Math.max(0, applied.quotaTotalAfter - applied.quotaUsedAfter),
      change: applied.change,
    };
  }

  /**
   * 授权次数变更流水列表（P03-04 图8「授权次数变更记录」页的服务端；只读）。
   *
   * 记的是**授权次数（库存账）**的变更，不是财务账 —— 财务口径见
   * license_purchase_batches / license_revenue_events（成交金额与收入确认），
   * 两者允许不一致（平台开/调授权次数默认不生成许可批次）。
   *
   * 支持筛选：seriesId（课包）/ changeType（五个类型之一）/ from-to（按 created_at，
   * 与 audit-logs 同一套约定：from 含、to 不含，非法时间报 400）；分页沿用 pageParams/pageResult。
   * ⚠️ 历史数据补不出来：这张表只记建表之后发生的事。
   */
  const quotaChangesMatch = part.match(/^\/organizations\/([^/]+)\/course-quota-changes$/);
  if (quotaChangesMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const organization = await organizationRow(quotaChangesMatch[1]);
    const conditions = ['change.org_id=?'];
    const params = [organization.id];
    const seriesId = String(ctx.search.get('seriesId') || '').trim();
    if (seriesId) { conditions.push('change.series_id=?'); params.push(seriesId); }
    const changeType = String(ctx.search.get('changeType') || '').trim().toUpperCase();
    if (changeType) {
      if (!COURSE_QUOTA_CHANGE_TYPES.includes(changeType)) throw errors.badRequest('变更类型无效', 'INVALID_CHANGE_TYPE');
      conditions.push('change.change_type=?'); params.push(changeType);
    }
    const fromProvided = ctx.search.has('from');
    const from = fromProvided ? String(ctx.search.get('from') || '').trim() : '';
    const toProvided = ctx.search.has('to');
    const to = toProvided ? String(ctx.search.get('to') || '').trim() : '';
    if (fromProvided) {
      if (!from || Number.isNaN(new Date(from).getTime())) throw errors.badRequest('开始时间必须是有效 ISO 时间', 'INVALID_FROM');
      if (toProvided && !Number.isNaN(new Date(to).getTime()) && new Date(from) >= new Date(to)) throw errors.badRequest('开始时间不能晚于结束时间', 'INVALID_TIME_RANGE');
      conditions.push('change.created_at>=?'); params.push(from);
    }
    if (toProvided) {
      if (!to || Number.isNaN(new Date(to).getTime())) throw errors.badRequest('结束时间必须是有效 ISO 时间', 'INVALID_TO');
      conditions.push('change.created_at<?'); params.push(to);
    }
    const where = ' WHERE ' + conditions.join(' AND ');
    const total = Number((await arow('SELECT COUNT(*) n FROM course_quota_changes change' + where, params))?.n || 0);
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 20, maxLimit: 200 });
    const items = (await arows(`SELECT change.*, series.title series_title, actor.display_name actor_name, actor.login actor_login
        FROM course_quota_changes change
        LEFT JOIN course_series series ON series.id=change.series_id
        LEFT JOIN users actor ON actor.id=change.actor_id
        ${where}
        ORDER BY change.created_at DESC, change.id DESC
        LIMIT ? OFFSET ?`, [...params, limit, offset])).map(normalizeQuotaChange);
    // 筛选项（不受上面筛选影响）：本机构有过变更的课包 + 五个变更类型，供图8 的下拉直接用。
    const seriesOptions = (await arows(`SELECT series.id, series.title, COUNT(*) n FROM course_quota_changes change
        JOIN course_series series ON series.id=change.series_id
        WHERE change.org_id=? GROUP BY series.id, series.title ORDER BY series.title`, [organization.id]))
      .map((item) => ({ id: item.id, title: item.title, changeCount: Number(item.n || 0) }));
    return { ...pageResult(items, { page, limit, total }), changeTypes: [...COURSE_QUOTA_CHANGE_TYPES], seriesOptions };
  }

  return null;
}
