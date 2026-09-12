import { audit, count, errors, id, json, normalizeClass, normalizeOrg, normalizePackage, normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson, assignmentActiveSql, orgSeriesAccessSql, pageParams, pageResult, q, requireRole, row, rows, transaction } from '../lib.js';
import { hashPassword } from '@platform/database';

import { scheduleReminder } from './communication.js';
import { assertTransition } from '../services/domainState.js';

import { ensureOrgBilling, integer, orgId, orgUser, hasPermission, classInOrg, assertTeachingClassManager, accessibleLesson, accessibleSeries, ORG_MEMBER_ROLES, validateMemberPhone, validateMemberPermissions, classMemberships, orgMemberRow, ENROLLMENT_STATUSES, PAYMENT_STATUSES, packageSnapshot, enrollmentDate, enrollmentRow, normalizeEnrollment, appendEnrollmentEvent, expireDueEnrollments, occupiedStudentSeats, assertEnrollmentSeat, setStudentEnrollmentAccess, packageWithSeatUsage, teacherCanAccessClass, teacherScope, classSessionRows, classProgressRows, classDetail, previewImport, createMember, validateTeacher, curriculumItem, workInReviewScope, workReportRows, workReportInReviewScope, reportResolution, normalizeWorkPublishRequest, orgWorkPublishRequestRow, orgWorkPublishRequestRows } from './adminOrg.js';
export async function handleOrg(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/org/')) return null;
  // /api/org/file-assets 由独立路由处理（含 STUDENT 角色）
  if (pathname.startsWith('/api/org/file-assets')) return null;
  const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER']); const currentOrgId = orgId(auth); const part = pathname.slice('/api/org'.length);

  if (part === '/overview' && method === 'GET') {
    ensureOrgBilling(currentOrgId);
    const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [currentOrgId]);
    const isTeacher = auth.user.role === 'TEACHER';
    const orgRecord = row('SELECT * FROM organizations WHERE id=?', [currentOrgId]);
    const normalizedOrg = normalizeOrg(orgRecord);
    const teacherScope = isTeacher ? ' AND (klass.teacher_id=? OR EXISTS (SELECT 1 FROM class_members scoped_member WHERE scoped_member.class_id=klass.id AND scoped_member.user_id=? AND scoped_member.role=\'TEACHER\' AND scoped_member.removed_at IS NULL))' : '';
    const teacherParams = isTeacher ? [auth.user.id, auth.user.id] : [];
    const activeClassParams = [currentOrgId, ...teacherParams];
    const activeClasses = count('SELECT COUNT(*) n FROM classes klass WHERE klass.org_id=? AND klass.status=\'ACTIVE\'' + teacherScope, activeClassParams);
    const activeSessions = count('SELECT COUNT(*) n FROM class_sessions session JOIN classes klass ON klass.id=session.class_id WHERE klass.org_id=? AND session.status=\'ACTIVE\'' + teacherScope, activeClassParams);
    const students = count(
      'SELECT COUNT(DISTINCT member.user_id) n FROM class_members member JOIN classes klass ON klass.id=member.class_id JOIN users student ON student.id=member.user_id WHERE klass.org_id=? AND klass.status=\'ACTIVE\' AND member.role=\'STUDENT\' AND member.removed_at IS NULL AND student.deleted_at IS NULL' + teacherScope,
      activeClassParams,
    );
    const teachers = isTeacher ? 1 : count("SELECT COUNT(*) n FROM users WHERE org_id=? AND role='TEACHER' AND deleted_at IS NULL", [currentOrgId]);
    const worksScope = isTeacher
      ? 'work.org_id=? AND work.class_id IS NOT NULL AND EXISTS (SELECT 1 FROM classes scoped_class WHERE scoped_class.id=work.class_id AND scoped_class.org_id=work.org_id AND (scoped_class.teacher_id=? OR EXISTS (SELECT 1 FROM class_members scoped_member WHERE scoped_member.class_id=scoped_class.id AND scoped_member.user_id=? AND scoped_member.role=\'TEACHER\' AND scoped_member.removed_at IS NULL)))'
      : 'work.org_id=?';
    const worksParams = isTeacher ? [currentOrgId, auth.user.id, auth.user.id] : [currentOrgId];
    const works = count('SELECT COUNT(*) n FROM works work WHERE ' + worksScope, worksParams);
    const pendingWorks = count('SELECT COUNT(*) n FROM works work WHERE ' + worksScope + ' AND work.status=\'PENDING\'', worksParams);
    const workBreakdown = rows('SELECT work.status,COUNT(*) n FROM works work WHERE ' + worksScope + ' GROUP BY work.status', worksParams)
      .reduce((result, item) => ({ ...result, [item.status]: Number(item.n || 0) }), {});
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
    const usageScope = isTeacher
      ? 'usage.org_id=? AND usage.created_at>=? AND usage.class_session_id IS NOT NULL AND EXISTS (SELECT 1 FROM class_sessions scoped_session JOIN classes scoped_class ON scoped_class.id=scoped_session.class_id WHERE scoped_session.id=usage.class_session_id AND (scoped_class.teacher_id=? OR EXISTS (SELECT 1 FROM class_members scoped_member WHERE scoped_member.class_id=scoped_class.id AND scoped_member.user_id=? AND scoped_member.role=\'TEACHER\' AND scoped_member.removed_at IS NULL)))'
      : 'usage.org_id=? AND usage.created_at>=?';
    const usageParams = isTeacher ? [currentOrgId, since7, auth.user.id, auth.user.id] : [currentOrgId, since7];
    const usage7 = Number(row('SELECT COALESCE(SUM(usage.credits_charged),0) n FROM usage_records usage WHERE ' + usageScope, usageParams)?.n || 0);
    const sessionParams = [currentOrgId, ...teacherParams];
    const recentSessions = rows(
      'SELECT session.id,session.class_id,session.lesson_id,session.status,session.started_at,session.ended_at,klass.name class_name,lesson.title lesson_title,starter.display_name starter_name FROM class_sessions session JOIN classes klass ON klass.id=session.class_id LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id LEFT JOIN users starter ON starter.id=session.started_by WHERE klass.org_id=?' + teacherScope + ' ORDER BY COALESCE(session.started_at,\'\') DESC LIMIT 8',
      sessionParams,
    ).map((item) => ({
      id: item.id, classId: item.class_id, className: item.class_name, lessonId: item.lesson_id || null, lessonTitle: item.lesson_title || null,
      status: item.status, startedAt: item.started_at, endedAt: item.ended_at || null, startedByName: item.starter_name || null,
    }));
    const pendingWorkItems = rows(
      'SELECT work.*,student.display_name student_name,klass.name class_name,lesson.title lesson_title FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN classes klass ON klass.id=work.class_id AND klass.org_id=work.org_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id WHERE ' + worksScope + ' AND work.status=\'PENDING\' ORDER BY work.submitted_at DESC LIMIT 6',
      worksParams,
    ).map((item) => normalizeWork(item));
    const notificationNow = nowIso();
    const notificationScope = "recipient.user_id=? AND recipient.delivery_status='DELIVERED' AND recipient.read_at IS NULL AND n.status='PUBLISHED' AND (n.publish_at IS NULL OR n.publish_at<=?) AND (n.scope_type='PLATFORM' OR (n.scope_type='ORG' AND n.org_id=?))";
    const notificationParams = [auth.user.id, notificationNow, currentOrgId];
    const unreadNotifications = count('SELECT COUNT(*) n FROM notification_recipients recipient JOIN notifications n ON n.id=recipient.notification_id WHERE ' + notificationScope, notificationParams);
    const unreadNotificationItems = rows(
      'SELECT n.*,sender.display_name sender_name,recipient.read_at,recipient.delivery_status FROM notification_recipients recipient JOIN notifications n ON n.id=recipient.notification_id LEFT JOIN users sender ON sender.id=n.sender_id WHERE ' + notificationScope + ' ORDER BY n.pinned DESC,COALESCE(n.publish_at,n.created_at) DESC LIMIT 5',
      notificationParams,
    ).map((item) => ({ id: item.id, title: item.title, body: item.body, kind: item.kind, senderName: item.sender_name || null, createdAt: item.created_at, publishAt: item.publish_at || null }));
    const alerts = [];
    if (!isTeacher) {
      const contractTimestamp = Date.parse(normalizedOrg?.contractExpiresAt || '');
      const contractDaysRemaining = Number.isFinite(contractTimestamp) ? Math.ceil((contractTimestamp - Date.now()) / 86400000) : null;
      if (contractDaysRemaining !== null && contractDaysRemaining <= 30) alerts.push({ code: contractDaysRemaining < 0 ? 'CONTRACT_EXPIRED' : 'CONTRACT_EXPIRING', level: contractDaysRemaining < 0 ? 'danger' : 'warning', title: contractDaysRemaining < 0 ? '合同已到期' : '合同即将到期', message: contractDaysRemaining < 0 ? '请尽快联系平台处理续约或停用安排。' : '请提前确认续约安排，避免影响机构使用。', daysRemaining: contractDaysRemaining });
      if (normalizedOrg.teacherSeats > 0 && normalizedOrg.teacherUsedSeats >= normalizedOrg.teacherSeats) alerts.push({ code: 'TEACHER_SEATS_FULL', level: 'warning', title: '教师席位已用满', message: '当前有效教师数已达到可用席位上限。', used: normalizedOrg.teacherUsedSeats, total: normalizedOrg.teacherSeats });
      if (Number(account?.credit_balance || 0) <= 0) alerts.push({ code: 'CREDIT_BALANCE_EMPTY', level: 'danger', title: '积分余额为零', message: '当前没有可用机构积分，新增 AI 用量可能被拦截。', balance: Number(account?.credit_balance || 0) });
    }
    if (isTeacher) normalizedOrg.teacherUsedSeats = null;
    return {
      scope: { role: auth.user.role, label: isTeacher ? '教师教学视图' : '机构管理员经营视图', description: isTeacher ? '仅统计本人负责或已授权班级的教学数据。' : '统计当前机构的经营与教学运行数据。', classCount: activeClasses },
      org: normalizedOrg, students, teachers, activeClasses, activeSessions, works, pendingWorks, usage7,
      creditBalance: isTeacher ? null : Number(account?.credit_balance || 0), unreadNotifications,
      recentSessions, pendingWorkItems, unreadNotificationItems, alerts,
      breakdown: { students, activeClasses, activeSessions, works: workBreakdown, pendingWorks, usage7 },
    };
  }
  if (part === '/users' && method === 'GET') {
    const role = ctx.search.get('role');
    // 教师需要读取本机构学生名册，才能履行“将学生加入班级”的职责；不开放教师名册和机构成员管理权限。
    if (!(auth.user.role === 'TEACHER' && role === 'STUDENT') && !hasPermission(auth, 'MANAGE_MEMBERS')) throw errors.forbidden('无账号管理权限', 'ORG_MEMBER_PERMISSION_REQUIRED');
    const search = String(ctx.search.get('search') || '').trim(); const params = [currentOrgId]; let where = 'org_id=? AND deleted_at IS NULL';
    if (ORG_MEMBER_ROLES.has(role)) { where += ' AND role=?'; params.push(role); }
    if (search) { where += ' AND (login LIKE ? OR display_name LIKE ? OR phone LIKE ?)'; const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; params.push(keyword, keyword, keyword); }
    const items = rows('SELECT * FROM users WHERE ' + where + ' ORDER BY created_at DESC LIMIT 500', params).map((item) => orgMemberRow(item, currentOrgId)); return { items, total: items.length };
  }
  let importMatch = part.match(/^\/users\/import\/(preview|commit)$/);
  if (importMatch && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可批量导入账号', 'ORG_ADMIN_REQUIRED');
    const preview = previewImport(ctx.body || {}, currentOrgId);
    if (importMatch[1] === 'preview') return preview;
    if (preview.invalidCount) throw errors.badRequest('批量导入校验失败，未写入任何账号', 'IMPORT_VALIDATION_FAILED', preview);
    const created = transaction(() => preview.items.map((item) => createMember(currentOrgId, item.value)));
    created.forEach((item) => audit(ctx, 'USER_IMPORT_CREATE', 'USER', item.id, null, { role: item.role, login: item.login }));
    audit(ctx, 'USER_IMPORT_COMMIT', 'IMPORT_BATCH', null, null, { total: created.length, logins: created.map((item) => item.login) });
    return { total: created.length, validCount: created.length, invalidCount: 0, items: created.map((item) => orgMemberRow(item, currentOrgId)) };
  }
  if (part === '/users' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可创建账号', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {}; const role = String(body.role || '').trim().toUpperCase(); const login = String(body.login || '').trim(); const displayName = String(body.displayName || '').trim();
    if (!ORG_MEMBER_ROLES.has(role) || !login || !displayName || String(body.password || '').length < 6) throw errors.badRequest('账号信息不完整');
    if (row('SELECT id FROM users WHERE login=?', [login])) throw errors.conflict('登录名已存在', 'LOGIN_EXISTS');
    const phone = validateMemberPhone(body.phone);
    const permissions = validateMemberPermissions(body.permissions, role);
    const organization = normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [currentOrgId]));
    if (role === 'TEACHER' && organization.teacherSeats - organization.teacherUsedSeats <= 0) throw errors.badRequest('教师席位不足', 'TEACHER_SEAT_LIMIT');
    if (body.billingPackageId && !row('SELECT id FROM billing_packages WHERE id=? AND org_id=?', [body.billingPackageId, currentOrgId])) throw errors.badRequest('套餐不属于当前机构', 'INVALID_BILLING_PACKAGE');
    const classIds = Array.isArray(body.classIds) ? [...new Set(body.classIds.map(String))] : [];
    classIds.forEach((classId) => {
      if (!row("SELECT id FROM classes WHERE id=? AND org_id=? AND status='ACTIVE'", [classId, currentOrgId])) throw errors.badRequest('包含不存在或已归档班级', 'INVALID_CLASS');
    });
    const created = transaction(() => createMember(currentOrgId, {
      role, login, displayName, password: String(body.password), phone: phone || null,
      permissions, expiresAt: body.expiresAt || null,
      studentUsageScope: role === 'STUDENT' ? (body.studentUsageScope || 'HOME_PRACTICE') : null,
      billingPackageId: role === 'STUDENT' ? (body.billingPackageId || null) : null,
      monthlyCreditAllowance: role === 'STUDENT' ? integer(body.monthlyCreditAllowance, '月度积分') : 0,
      aiCreditLimit: body.aiCreditLimit === undefined || body.aiCreditLimit === null || body.aiCreditLimit === '' ? null : integer(body.aiCreditLimit, 'AI 积分上限', { max: 100000000 }),
      classIds,
    }));
    audit(ctx, 'USER_CREATE', 'USER', created.id, null, { role, login, classIds });
    return orgMemberRow(created, currentOrgId);
  }  let match = part.match(/^\/users\/([^/]+)$/);
  if (match && ['GET','PUT','DELETE'].includes(method)) {
    if (!hasPermission(auth, 'MANAGE_MEMBERS')) throw errors.forbidden('无账号管理权限', 'ORG_MEMBER_PERMISSION_REQUIRED'); const target = orgUser(auth, match[1]); if (method === 'GET') return normalizeUser(target, { includeAuthMeta: true });
    if (method === 'DELETE') {
      const now = nowIso();
      assertTransition(ctx, 'user', target.status, 'DISABLED', { targetType: 'USER', targetId: target.id, before: target, allowSameState: true });
      transaction(() => { q('UPDATE users SET deleted_at=?,status=?,updated_at=? WHERE id=? AND org_id=?', [now, 'DISABLED', now, target.id, currentOrgId]); q('UPDATE sessions SET superseded_at=COALESCE(superseded_at,?) WHERE user_id=? AND superseded_at IS NULL', [now, target.id]); });
      audit(ctx, 'USER_DELETE', 'USER', target.id, normalizeUser(target), { status: 'DISABLED', deletedAt: now }); return { ok: true };
    }
    const body = ctx.body || {};
    if (body.billingPackageId && !row('SELECT id FROM billing_packages WHERE id=? AND org_id=?', [body.billingPackageId, currentOrgId])) throw errors.badRequest('套餐不属于当前机构', 'INVALID_BILLING_PACKAGE');
    const nextStatus = body.status === undefined ? target.status : body.status;
    if (!['ACTIVE', 'DISABLED'].includes(nextStatus)) throw errors.badRequest('账号状态无效', 'INVALID_MEMBER_STATUS');
    assertTransition(ctx, 'user', target.status, nextStatus, { targetType: 'USER', targetId: target.id, before: target, allowSameState: true, code: 'INVALID_MEMBER_STATUS' });
    if (nextStatus === 'DISABLED' && target.id === auth.user.id) throw errors.badRequest('不能停用当前登录账号', 'SELF_DISABLE_FORBIDDEN');
    const phone = body.phone === undefined ? target.phone : validateMemberPhone(body.phone, target.id);
    const displayName = body.displayName === undefined ? target.display_name : String(body.displayName).trim(); if (!displayName) throw errors.badRequest('姓名不能为空', 'DISPLAY_NAME_REQUIRED');
    const usageScope = body.studentUsageScope === undefined ? target.student_usage_scope : body.studentUsageScope; if (usageScope && !['FOLLOW_CLASS', 'HOME_PRACTICE'].includes(usageScope)) throw errors.badRequest('学员额度范围无效', 'INVALID_USAGE_SCOPE');
    const permissions = body.permissions === undefined ? parseJson(target.permissions, []) : validateMemberPermissions(body.permissions, target.role);
    const now = nowIso();
    transaction(() => { q('UPDATE users SET display_name=?,phone=?,permissions=?,status=?,student_usage_scope=?,billing_package_id=?,monthly_credit_allowance=?,ai_credit_limit=?,updated_at=? WHERE id=? AND org_id=?', [displayName, phone, json(permissions), nextStatus, usageScope, body.billingPackageId === undefined ? target.billing_package_id : body.billingPackageId, body.monthlyCreditAllowance === undefined ? target.monthly_credit_allowance : integer(body.monthlyCreditAllowance, '月度积分'), body.aiCreditLimit === undefined || body.aiCreditLimit === null || body.aiCreditLimit === '' ? target.ai_credit_limit : integer(body.aiCreditLimit, 'AI 积分上限', { max: 100000000 }), now, target.id, currentOrgId]); if (nextStatus === 'DISABLED') q('UPDATE sessions SET superseded_at=COALESCE(superseded_at,?) WHERE user_id=? AND superseded_at IS NULL', [now, target.id]); });
    audit(ctx, 'USER_UPDATE', 'USER', target.id, normalizeUser(target), { ...body, status: nextStatus }); return orgMemberRow(row('SELECT * FROM users WHERE id=?', [target.id]), currentOrgId);
  }
  let memberClassesMatch = part.match(/^\/users\/([^/]+)\/classes$/);
  if (memberClassesMatch && method === 'PUT') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可调整成员班级', 'ORG_ADMIN_REQUIRED');
    const target = orgUser(auth, memberClassesMatch[1]);
    if (!['TEACHER', 'STUDENT'].includes(target.role)) throw errors.badRequest('该账号不能加入班级', 'INVALID_ROLE');
    const classIds = Array.isArray(ctx.body?.classIds) ? [...new Set(ctx.body.classIds.map(String))] : [];
    const validClasses = classIds.map((classId) => row("SELECT id FROM classes WHERE id=? AND org_id=? AND status='ACTIVE'", [classId, currentOrgId]));
    if (validClasses.some((item) => !item)) throw errors.badRequest('包含不存在或已归档班级', 'INVALID_CLASS');
    const beforeClassIds = classMemberships(currentOrgId, target.id).filter((item) => item.role === target.role).map((item) => item.id);
    const now = nowIso();
    transaction(() => {
      q('UPDATE class_members SET removed_at=? WHERE user_id=? AND role=? AND removed_at IS NULL AND class_id IN (SELECT id FROM classes WHERE org_id=?)', [now, target.id, target.role, currentOrgId]);
      classIds.forEach((classId) => q('INSERT INTO class_members(id,class_id,user_id,role,joined_at,removed_at) VALUES (?,?,?,?,?,NULL) ON CONFLICT DO UPDATE SET role=excluded.role,removed_at=NULL', [id('member'), classId, target.id, target.role, now]));
    });
    audit(ctx, 'USER_CLASSES_REPLACE', 'USER', target.id, { classIds: beforeClassIds, role: target.role }, { classIds, role: target.role });
    return orgMemberRow(row('SELECT * FROM users WHERE id=?', [target.id]), currentOrgId);
  }
  match = part.match(/^\/users\/([^/]+)\/(password|permissions|period-boosts)$/);
  if (match && method === 'PUT') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可操作', 'ORG_ADMIN_REQUIRED'); const target = orgUser(auth, match[1]);
    if (match[2] === 'password') { const password = String(ctx.body?.password || ''); if (password.length < 6) throw errors.badRequest('密码至少6位'); const now = nowIso(); transaction(() => { q('UPDATE users SET password_hash=?,updated_at=? WHERE id=? AND org_id=?', [hashPassword(password), now, target.id, currentOrgId]); q('UPDATE sessions SET superseded_at=COALESCE(superseded_at,?) WHERE user_id=? AND superseded_at IS NULL', [now, target.id]); }); }
    if (match[2] === 'permissions') { if (target.role !== 'TEACHER') throw errors.badRequest('只能设置教师权限', 'INVALID_ROLE'); q('UPDATE users SET permissions=?,updated_at=? WHERE id=? AND org_id=?', [json(validateMemberPermissions(ctx.body?.permissions, target.role)), nowIso(), target.id, currentOrgId]); }
    if (match[2] === 'period-boosts') q('UPDATE users SET month_period_boost_credits=?,updated_at=? WHERE id=? AND org_id=?', [integer(ctx.body?.bonusCredits, '额外积分'), nowIso(), target.id, currentOrgId]);
    audit(ctx, 'USER_' + match[2].toUpperCase(), 'USER', target.id, null, ctx.body); return normalizeUser(row('SELECT * FROM users WHERE id=?', [target.id]), { includeAuthMeta: true });
  }
  if (part === '/audit-logs' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看操作审计', 'ORG_ADMIN_REQUIRED');
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const action = String(ctx.search.get('action') || '').trim(); const params = [currentOrgId]; let where = 'audit.org_id=?';
    if (action) { where += ' AND audit.action=?'; params.push(action); }
    const items = rows(`SELECT audit.*,actor.display_name actor_name,actor.login actor_login
      FROM audit_logs audit LEFT JOIN users actor ON actor.id=audit.actor_id
      WHERE ${where} ORDER BY audit.created_at DESC LIMIT ${limit}`, params).map((item) => ({
      id: item.id, action: item.action, targetType: item.target_type, targetId: item.target_id || null,
      actorName: item.actor_name || item.actor_login || '系统', actorRole: item.actor_role || null,
      before: parseJson(item.before_data, null), after: parseJson(item.after_data, null), createdAt: item.created_at,
    }));
    return { items, total: items.length };
  }
  if (part === '/billing/packages' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看积分套餐', 'ORG_ADMIN_REQUIRED');
    expireDueEnrollments(currentOrgId);
    return { items: rows('SELECT * FROM billing_packages WHERE org_id=? ORDER BY created_at DESC', [currentOrgId]).map((item) => packageWithSeatUsage(currentOrgId, item)) };
  }
  if (part === '/billing/packages' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可创建套餐', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {}; const name = String(body.name || '').trim();
    if (!name) throw errors.badRequest('套餐名称必填', 'PACKAGE_NAME_REQUIRED');
    if (row('SELECT id FROM billing_packages WHERE org_id=? AND name=?', [currentOrgId, name])) throw errors.conflict('同名套餐已存在', 'BILLING_PACKAGE_EXISTS');
    const capabilities = body.capabilities || {}; const packageId = id('pkg'); const now = nowIso();
    const studentSeats = integer(body.studentSeats, '学员席位', { min: 1, max: 100000, fallback: 1 });
    q('INSERT INTO billing_packages(id,org_id,name,price_fen,monthly_credits,bonus_credits,duration_days,allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,student_seats,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      packageId, currentOrgId, name, integer(body.priceFen, '价格'), integer(body.monthlyCredits, '月度积分'), integer(body.bonusCredits, '赠送积分'), integer(body.durationDays, '套餐有效期', { min: 1, max: 3650, fallback: 30 }),
      capabilities.allowImage ? 1 : 0, capabilities.allowMusic ? 1 : 0, capabilities.allowVideo ? 1 : 0, capabilities.allowPodcast ? 1 : 0, capabilities.allowDubbing ? 1 : 0, studentSeats, now, now,
    ]);
    const created = row('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [packageId, currentOrgId]);
    audit(ctx, 'BILLING_PACKAGE_CREATE', 'BILLING_PACKAGE', packageId, null, normalizePackage(created), { orgId: currentOrgId });
    return packageWithSeatUsage(currentOrgId, created);
  }
  let packageMatch = part.match(/^\/billing\/packages\/([^/]+)$/);
  if (packageMatch && ['GET', 'PUT'].includes(method)) {
    const target = row('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [packageMatch[1], currentOrgId]);
    if (!target) throw errors.notFound('套餐不存在', 'BILLING_PACKAGE_NOT_FOUND');
    if (method === 'GET') return packageWithSeatUsage(currentOrgId, target);
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可修改套餐', 'ORG_ADMIN_REQUIRED');
    expireDueEnrollments(currentOrgId);
    const body = ctx.body || {}; const capabilities = body.capabilities || {};
    const name = body.name === undefined ? target.name : String(body.name).trim();
    if (!name) throw errors.badRequest('套餐名称必填', 'PACKAGE_NAME_REQUIRED');
    let status = target.status;
    if (body.status !== undefined) {
      status = body.status;
      if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('套餐状态无效', 'INVALID_PACKAGE_STATUS');
      if (status === 'DISABLED' && target.status !== 'DISABLED' && occupiedStudentSeats(currentOrgId, target.id) > 0) {
        throw errors.conflict('套餐仍有已开通学员，请先停用或到期处理对应开通单', 'PACKAGE_HAS_ACTIVE_ENROLLMENTS');
      }
    }
    const studentSeats = body.studentSeats === undefined ? Number(target.student_seats || 0) : integer(body.studentSeats, '学员席位', { min: 1, max: 100000, fallback: 1 });
    const occupied = occupiedStudentSeats(currentOrgId, target.id);
    if (studentSeats < occupied) throw errors.conflict('学员席位不能低于当前已占用数量', 'STUDENT_SEAT_BELOW_OCCUPIED');
    q('UPDATE billing_packages SET name=?,price_fen=?,monthly_credits=?,bonus_credits=?,duration_days=?,allow_image=?,allow_music=?,allow_video=?,allow_podcast=?,allow_dubbing=?,student_seats=?,status=?,updated_at=? WHERE id=? AND org_id=?', [
      name,
      body.priceFen === undefined ? target.price_fen : integer(body.priceFen, '价格'),
      body.monthlyCredits === undefined ? target.monthly_credits : integer(body.monthlyCredits, '月度积分'),
      body.bonusCredits === undefined ? target.bonus_credits : integer(body.bonusCredits, '赠送积分'),
      body.durationDays === undefined ? target.duration_days : integer(body.durationDays, '套餐有效期', { min: 1, max: 3650, fallback: 30 }),
      capabilities.allowImage === undefined ? target.allow_image : (capabilities.allowImage ? 1 : 0),
      capabilities.allowMusic === undefined ? target.allow_music : (capabilities.allowMusic ? 1 : 0),
      capabilities.allowVideo === undefined ? target.allow_video : (capabilities.allowVideo ? 1 : 0),
      capabilities.allowPodcast === undefined ? target.allow_podcast : (capabilities.allowPodcast ? 1 : 0),
      capabilities.allowDubbing === undefined ? target.allow_dubbing : (capabilities.allowDubbing ? 1 : 0),
      studentSeats, status, nowIso(), target.id, currentOrgId,
    ]);
    const updated = row('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [target.id, currentOrgId]);
    audit(ctx, 'BILLING_PACKAGE_UPDATE', 'BILLING_PACKAGE', target.id, normalizePackage(target), normalizePackage(updated), { orgId: currentOrgId });
    return packageWithSeatUsage(currentOrgId, updated);
  }

  if (part === '/billing/enrollments' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看学员开通', 'ORG_ADMIN_REQUIRED');
    expireDueEnrollments(currentOrgId);
    const status = String(ctx.search.get('status') || '').trim().toUpperCase();
    if (status && !ENROLLMENT_STATUSES.has(status)) throw errors.badRequest('开通状态无效', 'INVALID_ENROLLMENT_STATUS');
    const params = [currentOrgId]; let where = 'enrollment.org_id=?';
    if (status) { where += ' AND enrollment.status=?'; params.push(status); }
    const items = rows(`SELECT enrollment.*,student.display_name student_name,student.login student_login,package.name package_name,
        COUNT(event.id) event_count,MAX(event.created_at) last_event_at
      FROM student_enrollments enrollment
      JOIN users student ON student.id=enrollment.student_id AND student.org_id=enrollment.org_id
      JOIN billing_packages package ON package.id=enrollment.package_id AND package.org_id=enrollment.org_id
      LEFT JOIN student_enrollment_events event ON event.enrollment_id=enrollment.id
      WHERE ${where}
      GROUP BY enrollment.id ORDER BY CASE enrollment.status WHEN 'ACTIVE' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'SUSPENDED' THEN 2 ELSE 3 END,enrollment.expires_at ASC,enrollment.created_at DESC LIMIT 500`, params).map(normalizeEnrollment);
    const active = items.filter((item) => item.status === 'ACTIVE');
    const now = Date.now();
    return { items, summary: { total: items.length, pending: items.filter((item) => item.status === 'PENDING').length, active: active.length, suspended: items.filter((item) => item.status === 'SUSPENDED').length, expiringSoon: active.filter((item) => { const days = Math.ceil((Date.parse(item.expiresAt) - now) / 86400000); return days >= 0 && days <= 30; }).length } };
  }
  if (part === '/billing/enrollments' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可创建学员开通单', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {}; const studentId = String(body.studentId || '').trim(); const packageId = String(body.packageId || '').trim();
    const student = row("SELECT * FROM users WHERE id=? AND org_id=? AND role='STUDENT' AND deleted_at IS NULL", [studentId, currentOrgId]);
    if (!student) throw errors.badRequest('学员不属于当前机构', 'INVALID_ENROLLMENT_STUDENT');
    const pkg = row("SELECT * FROM billing_packages WHERE id=? AND org_id=? AND status='ACTIVE'", [packageId, currentOrgId]);
    if (!pkg) throw errors.badRequest('套餐不存在或已停用', 'INVALID_ENROLLMENT_PACKAGE');
    if (row("SELECT id FROM student_enrollments WHERE student_id=? AND status='ACTIVE'", [student.id])) throw errors.conflict('该学员已有生效中的开通单，请使用续费或停用操作', 'STUDENT_ALREADY_ENROLLED');
    const now = nowIso(); const startsAt = enrollmentDate(body.startsAt, '开始时间', now);
    const expiresAt = new Date(new Date(startsAt).valueOf() + Number(pkg.duration_days || 0) * 86400000).toISOString();
    const paymentStatus = body.paymentStatus === undefined ? 'UNRECORDED' : String(body.paymentStatus).trim().toUpperCase();
    if (!PAYMENT_STATUSES.has(paymentStatus)) throw errors.badRequest('线下收款登记状态无效', 'INVALID_PAYMENT_STATUS');
    const notes = String(body.notes || '').trim(); if (notes.length > 2000) throw errors.badRequest('备注不能超过 2000 个字符', 'ENROLLMENT_NOTES_TOO_LONG');
    const enrollmentId = id('enrollment'); const snapshot = packageSnapshot(pkg);
    q(`INSERT INTO student_enrollments(id,org_id,student_id,package_id,status,payment_status,price_fen,package_snapshot,starts_at,expires_at,notes,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [enrollmentId, currentOrgId, student.id, pkg.id, 'PENDING', paymentStatus, Number(pkg.price_fen || 0), json(snapshot), startsAt, expiresAt, notes, auth.user.id, auth.user.id, now, now]);
    appendEnrollmentEvent({ enrollmentId, currentOrgId, eventType: 'CREATE', afterStatus: 'PENDING', actorId: auth.user.id, data: { packageId: pkg.id, paymentStatus, startsAt, expiresAt, notes } });
    const created = enrollmentRow(currentOrgId, enrollmentId);
    audit(ctx, 'STUDENT_ENROLLMENT_CREATE', 'STUDENT_ENROLLMENT', enrollmentId, null, normalizeEnrollment(created), { orgId: currentOrgId });
    return normalizeEnrollment(created, { includeEvents: true });
  }
  let enrollmentMatch = part.match(/^\/billing\/enrollments\/([^/]+)$/);
  if (enrollmentMatch && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看学员开通', 'ORG_ADMIN_REQUIRED');
    expireDueEnrollments(currentOrgId);
    return normalizeEnrollment(enrollmentRow(currentOrgId, enrollmentMatch[1]), { includeEvents: true });
  }
  let enrollmentActionMatch = part.match(/^\/billing\/enrollments\/([^/]+)\/(payment-record|activate|suspend|resume|renew|void)$/);
  if (enrollmentActionMatch && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可操作学员开通', 'ORG_ADMIN_REQUIRED');
    expireDueEnrollments(currentOrgId);
    const enrollment = enrollmentRow(currentOrgId, enrollmentActionMatch[1]); const action = enrollmentActionMatch[2]; const before = enrollment.status; const now = nowIso();
    const pkg = row('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [enrollment.package_id, currentOrgId]);
    if (!pkg) throw errors.conflict('开通单关联套餐已不可用', 'ENROLLMENT_PACKAGE_MISSING');
    let after = before; let eventData = {};
    if (action === 'payment-record') {
      const paymentStatus = String(ctx.body?.paymentStatus || 'RECORDED').trim().toUpperCase();
      if (!PAYMENT_STATUSES.has(paymentStatus)) throw errors.badRequest('线下收款登记状态无效', 'INVALID_PAYMENT_STATUS');
      assertTransition(ctx, 'payment', enrollment.payment_status, paymentStatus, {
        targetType: 'STUDENT_ENROLLMENT', targetId: enrollment.id, before: normalizeEnrollment(enrollment),
        code: 'INVALID_PAYMENT_STATUS_TRANSITION', details: { action }, message: `收款状态 ${enrollment.payment_status} 不允许转换为 ${paymentStatus}`, allowSameState: true,
      });
    } else {
      const requestedStatus = { activate: 'ACTIVE', suspend: 'SUSPENDED', resume: 'ACTIVE', renew: 'ACTIVE', void: 'VOIDED' }[action];
      const allowedFrom = { activate: ['PENDING'], suspend: ['ACTIVE'], resume: ['SUSPENDED'], renew: ['ACTIVE', 'SUSPENDED', 'EXPIRED'], void: ['PENDING', 'SUSPENDED'] }[action];
      if (requestedStatus) assertTransition(ctx, 'enrollment', before, requestedStatus, {
        targetType: 'STUDENT_ENROLLMENT', targetId: enrollment.id, before: normalizeEnrollment(enrollment),
        code: 'INVALID_ENROLLMENT_TRANSITION', details: { action }, message: `当前开通单状态 ${before} 不允许执行 ${action}`, allowedFrom, allowSameState: action === 'renew',
      });
    }
    transaction(() => {
      if (action === 'payment-record') {
        const paymentStatus = String(ctx.body?.paymentStatus || 'RECORDED').trim().toUpperCase();
        const notes = ctx.body?.notes === undefined ? enrollment.notes : String(ctx.body.notes || '').trim();
        if (notes.length > 2000) throw errors.badRequest('备注不能超过 2000 个字符', 'ENROLLMENT_NOTES_TOO_LONG');
        q('UPDATE student_enrollments SET payment_status=?,notes=?,updated_by=?,updated_at=? WHERE id=? AND org_id=?', [paymentStatus, notes, auth.user.id, now, enrollment.id, currentOrgId]);
        eventData = { paymentStatus, notes };
      } else if (action === 'activate') {
        if (before !== 'PENDING') throw errors.conflict('仅待开通记录可以完成开通', 'INVALID_ENROLLMENT_TRANSITION');
        if (pkg.status !== 'ACTIVE') throw errors.conflict('套餐已停用，不能继续开通', 'PACKAGE_DISABLED');
        assertEnrollmentSeat(currentOrgId, pkg);
        after = 'ACTIVE';
        q("UPDATE student_enrollments SET status='ACTIVE',activated_at=?,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [now, auth.user.id, now, enrollment.id, currentOrgId]);
        setStudentEnrollmentAccess(currentOrgId, enrollment, 'ACTIVE');
      } else if (action === 'suspend') {
        if (before !== 'ACTIVE') throw errors.conflict('仅生效中的开通单可以停用', 'INVALID_ENROLLMENT_TRANSITION');
        after = 'SUSPENDED';
        q("UPDATE student_enrollments SET status='SUSPENDED',suspended_at=?,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [now, auth.user.id, now, enrollment.id, currentOrgId]);
        setStudentEnrollmentAccess(currentOrgId, enrollment, 'SUSPENDED');
      } else if (action === 'resume') {
        if (before !== 'SUSPENDED') throw errors.conflict('仅已停用记录可以恢复', 'INVALID_ENROLLMENT_TRANSITION');
        if (enrollment.expires_at <= now) throw errors.conflict('开通单已到期，请先续费后再恢复', 'ENROLLMENT_EXPIRED');
        if (pkg.status !== 'ACTIVE') throw errors.conflict('套餐已停用，不能恢复开通', 'PACKAGE_DISABLED');
        assertEnrollmentSeat(currentOrgId, pkg, { excludeEnrollmentId: enrollment.id });
        after = 'ACTIVE';
        q("UPDATE student_enrollments SET status='ACTIVE',suspended_at=NULL,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [auth.user.id, now, enrollment.id, currentOrgId]);
        setStudentEnrollmentAccess(currentOrgId, enrollment, 'ACTIVE');
      } else if (action === 'renew') {
        if (!['ACTIVE', 'SUSPENDED', 'EXPIRED'].includes(before)) throw errors.conflict('当前开通单不能续费', 'INVALID_ENROLLMENT_TRANSITION');
        if (pkg.status !== 'ACTIVE') throw errors.conflict('套餐已停用，不能续费', 'PACKAGE_DISABLED');
        if (before !== 'ACTIVE') assertEnrollmentSeat(currentOrgId, pkg, { excludeEnrollmentId: enrollment.id });
        const snapshot = parseJson(enrollment.package_snapshot, packageSnapshot(pkg)); const durationDays = Number(snapshot.durationDays || pkg.duration_days || 0);
        if (!Number.isInteger(durationDays) || durationDays < 1) throw errors.conflict('开通单套餐快照无有效期，无法续费', 'INVALID_ENROLLMENT_SNAPSHOT');
        const baseTime = Math.max(Date.parse(enrollment.expires_at), Date.now()); const expiresAt = new Date(baseTime + durationDays * 86400000).toISOString();
        after = 'ACTIVE'; eventData = { previousExpiresAt: enrollment.expires_at, expiresAt, durationDays };
        q("UPDATE student_enrollments SET status='ACTIVE',expires_at=?,activated_at=COALESCE(activated_at,?),suspended_at=NULL,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [expiresAt, now, auth.user.id, now, enrollment.id, currentOrgId]);
        const renewed = { ...enrollment, expires_at: expiresAt };
        setStudentEnrollmentAccess(currentOrgId, renewed, 'ACTIVE');
      } else if (action === 'void') {
        if (!['PENDING', 'SUSPENDED'].includes(before)) throw errors.conflict('仅待开通或已停用记录可以作废', 'INVALID_ENROLLMENT_TRANSITION');
        after = 'VOIDED';
        q("UPDATE student_enrollments SET status='VOIDED',voided_at=?,updated_by=?,updated_at=? WHERE id=? AND org_id=?", [now, auth.user.id, now, enrollment.id, currentOrgId]);
        if (before === 'SUSPENDED') setStudentEnrollmentAccess(currentOrgId, enrollment, 'VOIDED');
      }
      appendEnrollmentEvent({ enrollmentId: enrollment.id, currentOrgId, eventType: action.toUpperCase(), beforeStatus: before, afterStatus: after, actorId: auth.user.id, data: eventData });
    });
    const updated = enrollmentRow(currentOrgId, enrollment.id);
    audit(ctx, 'STUDENT_ENROLLMENT_' + action.toUpperCase(), 'STUDENT_ENROLLMENT', enrollment.id, normalizeEnrollment(enrollment), normalizeEnrollment(updated), { orgId: currentOrgId });
    return normalizeEnrollment(updated, { includeEvents: true });
  }

  if (part === '/ai-usage' && method === 'GET') {
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 500, fallback: 200 });
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const modality = String(ctx.search.get('modality') || '').trim().toUpperCase();
    const status = String(ctx.search.get('status') || '').trim().toUpperCase();
    const classId = String(ctx.search.get('classId') || '').trim();
    const sessionId = String(ctx.search.get('sessionId') || '').trim();
    const studentId = String(ctx.search.get('studentId') || '').trim();
    const search = String(ctx.search.get('search') || '').trim();
    if (modality && !['TEXT', 'IMAGE', 'MUSIC', 'VIDEO'].includes(modality)) throw errors.badRequest('不支持的素材类型', 'UNSUPPORTED_MODALITY');
    if (status && !['SUCCESS', 'FAILED', 'BLOCKED'].includes(status)) throw errors.badRequest('无效的用量状态', 'INVALID_USAGE_STATUS');
    const params = [currentOrgId, since]; const conditions = ['usage.org_id=?', 'usage.created_at>=?'];
    if (modality) { conditions.push('usage.modality=?'); params.push(modality); }
    if (status) { conditions.push('usage.status=?'); params.push(status); }
    if (classId) { conditions.push('class.id=?'); params.push(classId); }
    if (sessionId) { conditions.push('usage.class_session_id=?'); params.push(sessionId); }
    if (studentId) { conditions.push('usage.user_id=?'); params.push(studentId); }
    if (auth.user.role === 'TEACHER') {
      conditions.push(`usage.class_session_id IS NOT NULL AND EXISTS (SELECT 1 FROM class_sessions scoped_session JOIN classes scoped_class ON scoped_class.id=scoped_session.class_id WHERE scoped_session.id=usage.class_session_id AND scoped_class.org_id=? AND (scoped_class.teacher_id=? OR EXISTS (SELECT 1 FROM class_members scoped_member WHERE scoped_member.class_id=scoped_class.id AND scoped_member.user_id=? AND scoped_member.role='TEACHER' AND scoped_member.removed_at IS NULL)))`);
      params.push(currentOrgId, auth.user.id, auth.user.id);
    }
    if (search) { const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; conditions.push('(user.login LIKE ? OR user.display_name LIKE ? OR project.title LIKE ? OR class.name LIKE ? OR usage.fail_code LIKE ?)'); params.push(keyword, keyword, keyword, keyword, keyword); }
    const items = rows(`SELECT usage.*,user.login user_login,user.display_name user_name,project.title project_title,project.course_lesson_id project_lesson_id,
      class.id class_id,class.name class_name,session.lesson_id session_lesson_id,lesson.title lesson_title,
      job.provider job_provider,job.model job_model
      FROM usage_records usage
      LEFT JOIN users user ON user.id=usage.user_id AND user.org_id=usage.org_id
      LEFT JOIN student_projects project ON project.id=usage.project_id AND project.org_id=usage.org_id
      LEFT JOIN class_sessions session ON session.id=usage.class_session_id
      LEFT JOIN classes class ON class.id=session.class_id AND class.org_id=usage.org_id
      LEFT JOIN course_lessons lesson ON lesson.id=COALESCE(session.lesson_id, project.course_lesson_id)
      LEFT JOIN generation_jobs job ON job.id=usage.generation_job_id AND job.org_id=usage.org_id
      WHERE ${conditions.join(' AND ')} ORDER BY usage.created_at DESC LIMIT ${limit}`, params).map((item) => ({
      id: item.id, userId: item.user_id, userLogin: item.user_login || null, userName: item.user_name || null,
      classSessionId: item.class_session_id || null, classId: item.class_id || null, className: item.class_name || null,
      lessonId: item.session_lesson_id || item.project_lesson_id || null, lessonTitle: item.lesson_title || null,
      projectId: item.project_id || null, projectTitle: item.project_title || null, generationJobId: item.generation_job_id || null,
      modality: item.modality, model: item.model || item.job_model || null, provider: item.job_provider || null,
      credits: Number(item.credits_charged || 0),
      status: item.status, failCode: item.fail_code || null, createdAt: item.created_at,
    }));
    return { items, total: items.length, filters: { days, modality: modality || null, status: status || null, classId: classId || null, sessionId: sessionId || null, studentId: studentId || null } };
  }
  if (part === '/billing/usage-overview' && method === 'GET') {
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 }); const since = new Date(Date.now() - days * 86400000).toISOString(); ensureOrgBilling(currentOrgId); const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [currentOrgId]);
    return { balance: Number(account.credit_balance || 0), totalCreditsIn: Number(account.total_credits_in || 0), totalCreditsSpent: Number(account.total_credits_spent || 0), modalities: rows('SELECT modality,SUM(credits_charged) credits,COUNT(*) calls FROM usage_records WHERE org_id=? AND created_at>=? GROUP BY modality', [currentOrgId, since]), topUsers: rows('SELECT user.id,user.display_name studentName,SUM(usage.credits_charged) credits,COUNT(*) calls FROM usage_records usage JOIN users user ON user.id=usage.user_id AND user.org_id=usage.org_id WHERE usage.org_id=? AND usage.created_at>=? GROUP BY user.id ORDER BY credits DESC LIMIT 10', [currentOrgId, since]) };
  }
  if (part === '/billing/usage-records' && method === 'GET') {
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 }); const modality = ctx.search.get('modality'); const status = ctx.search.get('status'); const search = String(ctx.search.get('search') || '').trim();
    const since = new Date(Date.now() - days * 86400000).toISOString(); const params = [currentOrgId, since]; const conditions = ['usage.org_id=?', 'usage.created_at>=?'];
    if (modality) { conditions.push('usage.modality=?'); params.push(modality); }
    if (['SUCCESS', 'FAILED', 'BLOCKED'].includes(status)) { conditions.push('usage.status=?'); params.push(status); }
    if (search) { conditions.push('(user.login LIKE ? OR user.display_name LIKE ? OR project.title LIKE ? OR work.title LIKE ?)'); const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; params.push(keyword, keyword, keyword, keyword); }
    const items = rows(
      'SELECT usage.*,user.login user_login,user.display_name user_name,project.title project_title,work.title work_title,session.id session_id,session.lesson_id session_lesson_id,class.id class_id,class.name class_name FROM usage_records usage LEFT JOIN users user ON user.id=usage.user_id AND user.org_id=usage.org_id LEFT JOIN student_projects project ON project.id=usage.project_id LEFT JOIN works work ON work.id=usage.work_id LEFT JOIN class_sessions session ON session.id=usage.class_session_id LEFT JOIN classes class ON class.id=session.class_id WHERE ' + conditions.join(' AND ') + ' ORDER BY usage.created_at DESC LIMIT 200',
      params,
    ).map((item) => ({
      id: item.id, userId: item.user_id, userLogin: item.user_login || null, userName: item.user_name || null,
      classSessionId: item.class_session_id || null, classId: item.class_id || null, className: item.class_name || null,
      lessonId: item.session_lesson_id || item.lesson_id || null, projectId: item.project_id || null, projectTitle: item.project_title || null,
      workId: item.work_id || null, workTitle: item.work_title || null, modality: item.modality, model: item.model,
      credits: Number(item.credits_charged || 0),
      status: item.status, failCode: item.fail_code || null, createdAt: item.created_at,
    }));
    return { items, total: items.length };
  }

  if (part === '/course-series' && method === 'GET') {
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 50 });
    const fromWhere = `FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql()} WHERE series.status='PUBLISHED' AND ${orgSeriesAccessSql()}`;
    const total = Number(row(`SELECT COUNT(DISTINCT series.id) n ${fromWhere}`, [currentOrgId, currentOrgId])?.n || 0);
    const items = rows(`SELECT DISTINCT series.* ${fromWhere} ORDER BY series.sort,series.title LIMIT ? OFFSET ?`, [currentOrgId, currentOrgId, limit, offset]).map((series) => normalizeSeries(series, { orgId: currentOrgId, includeLessons: true, includeTeaching: true, asPublished: true }));
    return pageResult(items, { page, limit, total });
  }
  let orgCourseDetailMatch = part.match(/^\/course-series\/([^/]+)$/);
  if (orgCourseDetailMatch && method === 'GET') {
    const series = row(`SELECT series.* FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql()} WHERE series.id=? AND series.status='PUBLISHED' AND ${orgSeriesAccessSql()}`, [currentOrgId, orgCourseDetailMatch[1], currentOrgId]);
    if (!series) throw errors.notFound('课包不存在或不可访问', 'COURSE_SERIES_NOT_FOUND');
    const detail = normalizeSeries(series, { orgId: currentOrgId, includeLessons: true, includeTeaching: true, asPublished: true });
    detail.lessons = (detail.lessons || []).filter((l) => l.status === 'PUBLISHED');
    return detail;
  }
  if (part === '/classes' && method === 'GET') {
    const params = [currentOrgId]; let where = 'class.org_id=?';
    if (auth.user.role === 'TEACHER') where += teacherScope('class', auth, params);
    return { items: rows('SELECT class.*,teacher.display_name AS teacher_name FROM classes class LEFT JOIN users teacher ON teacher.id=class.teacher_id AND teacher.org_id=class.org_id WHERE ' + where + ' ORDER BY class.created_at DESC', params).map(normalizeClass) };
  }
  if (part === '/classes' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN' && auth.user.role !== 'TEACHER') throw errors.forbidden('无班级教务权限', 'CLASS_PERMISSION_DENIED');
    const body = ctx.body || {}; const name = String(body.name || '').trim(); if (!name) throw errors.badRequest('班级名称必填');
    const teacherId = auth.user.role === 'TEACHER' ? auth.user.id : (body.teacherId || null); validateTeacher(currentOrgId, teacherId);
    if (body.defaultSeriesId && !accessibleSeries(currentOrgId, body.defaultSeriesId)) throw errors.badRequest('默认课包未授权给当前机构', 'COURSE_NOT_AUTHORIZED');
    const classId = id('class'); const now = nowIso();
    transaction(() => { q('INSERT INTO classes(id,org_id,name,teacher_id,usage_mode,default_series_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [classId, currentOrgId, name, teacherId, body.usageMode === 'ALWAYS_AVAILABLE' ? 'ALWAYS_AVAILABLE' : 'CLASS_ONLY', body.defaultSeriesId || null, now, now]); if (teacherId) q('INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES (?,?,?,?,?)', [id('member'), classId, teacherId, 'TEACHER', now]); });
    audit(ctx, 'CLASS_CREATE', 'CLASS', classId, null, body); return normalizeClass(row('SELECT * FROM classes WHERE id=? AND org_id=?', [classId, currentOrgId]));
  }
  let classMatch = part.match(/^\/classes\/([^/]+)$/);
  if (classMatch && ['GET','PUT','DELETE'].includes(method)) {
    const cls = classInOrg(auth, classMatch[1]);
    if (method === 'GET') { if (!teacherCanAccessClass(auth, cls)) throw errors.notFound('班级不存在', 'CLASS_NOT_FOUND'); return classDetail(auth, cls); }
    assertTeachingClassManager(auth, cls);
    if (method === 'DELETE') {
      assertTransition(ctx, 'class', cls.status, 'ARCHIVED', { targetType: 'CLASS', targetId: cls.id, before: normalizeClass(cls), code: 'INVALID_CLASS_TRANSITION', message: '已归档班级不能重复归档' });
      transaction(() => { const active = row("SELECT * FROM class_sessions WHERE class_id=? AND status='ACTIVE'", [cls.id]); if (active) q("UPDATE class_sessions SET status='ENDED',ended_at=?,ended_by=?,ended_reason='CLASS_ARCHIVED' WHERE id=?", [nowIso(), auth.user.id, active.id]); q("UPDATE classes SET status='ARCHIVED',archived_at=?,current_session_id=NULL,updated_at=? WHERE id=? AND org_id=?", [nowIso(), nowIso(), cls.id, currentOrgId]); });
      audit(ctx, 'CLASS_ARCHIVE', 'CLASS', cls.id); return { ok: true };
    }
    if (cls.status !== 'ACTIVE') throw errors.conflict('已归档班级不能修改', 'CLASS_ARCHIVED');
    const body = ctx.body || {};
    if (auth.user.role === 'TEACHER' && body.teacherId !== undefined && body.teacherId !== auth.user.id) throw errors.forbidden('教师不能改派其他负责教师', 'TEACHER_ASSIGNMENT_DENIED');
    const teacherId = auth.user.role === 'TEACHER' ? auth.user.id : (body.teacherId === undefined ? cls.teacher_id : body.teacherId); validateTeacher(currentOrgId, teacherId);
    if (body.defaultSeriesId && !accessibleSeries(currentOrgId, body.defaultSeriesId)) throw errors.badRequest('默认课包未授权给当前机构', 'COURSE_NOT_AUTHORIZED');
    const before = normalizeClass(cls);
    q('UPDATE classes SET name=COALESCE(?,name),teacher_id=?,usage_mode=COALESCE(?,usage_mode),default_series_id=?,updated_at=? WHERE id=? AND org_id=?', [body.name ? String(body.name).trim() : null, teacherId, body.usageMode || null, body.defaultSeriesId === undefined ? cls.default_series_id : body.defaultSeriesId, nowIso(), cls.id, currentOrgId]);
    const updated = normalizeClass(row('SELECT class.*,teacher.display_name AS teacher_name FROM classes class LEFT JOIN users teacher ON teacher.id=class.teacher_id AND teacher.org_id=class.org_id WHERE class.id=? AND class.org_id=?', [cls.id, currentOrgId]));
    audit(ctx, 'CLASS_UPDATE', 'CLASS', cls.id, before, updated);
    return updated;
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/curriculum$/);
  if (classMatch && method === 'GET') {
    const cls = classInOrg(auth, classMatch[1]); if (!teacherCanAccessClass(auth, cls)) throw errors.notFound('班级不存在', 'CLASS_NOT_FOUND');
    const items = rows('SELECT item.*,lesson.title,lesson.summary,lesson.duration_minutes FROM class_curriculum_items item JOIN course_lessons lesson ON lesson.id=item.lesson_id WHERE item.class_id=? ORDER BY item.sort', [cls.id]); return { items: items.map(curriculumItem) };
  }
  if (classMatch && method === 'PUT') {
    const cls = classInOrg(auth, classMatch[1]); assertTeachingClassManager(auth, cls); if (cls.status !== 'ACTIVE') throw errors.conflict('已归档班级不能修改课程计划', 'CLASS_ARCHIVED'); const lessonIds = Array.isArray(ctx.body?.lessonIds) ? [...new Set(ctx.body.lessonIds)] : [];
    if (lessonIds.length > 80) throw errors.badRequest('课单最多80节', 'CURRICULUM_LIMIT');
    transaction(() => { const lessons = lessonIds.map((lessonId) => { const lesson = accessibleLesson(currentOrgId, lessonId); if (!lesson) throw errors.badRequest('课时未授权或不存在', 'COURSE_NOT_AUTHORIZED'); return lesson; }); q('DELETE FROM class_curriculum_items WHERE class_id=?', [cls.id]); lessons.forEach((lesson, index) => q('INSERT INTO class_curriculum_items(id,class_id,lesson_id,sort,source_series_id,added_at) VALUES (?,?,?,?,?,?)', [id('curr'), cls.id, lesson.id, index + 1, lesson.series_id, nowIso()])); });
    return classDetail(auth, row('SELECT * FROM classes WHERE id=? AND org_id=?', [cls.id, currentOrgId]));
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/(sessions|progress)$/);
  if (classMatch && method === 'GET') {
    const cls = classInOrg(auth, classMatch[1]); if (!teacherCanAccessClass(auth, cls)) throw errors.notFound('班级不存在', 'CLASS_NOT_FOUND');
    if (classMatch[2] === 'sessions') { const items = classSessionRows(cls.id); return { items, total: items.length }; }
    const items = classProgressRows(cls.id); return { items, total: items.length };
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/members\/([^/]+)$/);
  if (classMatch && ['POST','DELETE'].includes(method)) {
    const cls = classInOrg(auth, classMatch[1]); assertTeachingClassManager(auth, cls); if (cls.status !== 'ACTIVE') throw errors.conflict('已归档班级不能变更成员', 'CLASS_ARCHIVED'); const target = orgUser(auth, classMatch[2]); if (target.role !== 'STUDENT') throw errors.badRequest('只能管理学员成员', 'INVALID_MEMBER_ROLE');
    if (method === 'POST') q('INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING', [id('member'), cls.id, target.id, 'STUDENT', nowIso()]); else q('UPDATE class_members SET removed_at=? WHERE class_id=? AND user_id=? AND removed_at IS NULL', [nowIso(), cls.id, target.id]);
    audit(ctx, method === 'POST' ? 'CLASS_MEMBER_ADD' : 'CLASS_MEMBER_REMOVE', 'CLASS', cls.id, null, { userId: target.id }); return { ok: true };
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/(start|makeup)$/);
  if (classMatch && method === 'POST') {
    const cls = classInOrg(auth, classMatch[1]); assertTeachingClassManager(auth, cls); if (cls.status !== 'ACTIVE') throw errors.conflict('已归档班级不能开课', 'CLASS_ARCHIVED'); const lessonId = String(ctx.body?.lessonId || '').trim();
    if (!lessonId) throw errors.badRequest('开课必须指定课时', 'LESSON_REQUIRED');
    if (!row('SELECT id FROM class_curriculum_items WHERE class_id=? AND lesson_id=?', [cls.id, lessonId]) || !accessibleLesson(currentOrgId, lessonId)) throw errors.badRequest('课时不在本班已授权课单中', 'LESSON_NOT_ASSIGNED');
    if (row("SELECT id FROM class_sessions WHERE class_id=? AND status='ACTIVE'", [cls.id])) throw errors.conflict('当前班级已有进行中的课堂', 'CLASS_SESSION_ACTIVE');
    const cap = ctx.body?.sessionCreditCap === undefined || ctx.body?.sessionCreditCap === null ? null : integer(ctx.body.sessionCreditCap, '课堂积分上限'); const capability = ctx.body?.capabilities || {}; const sessionId = id('csession'); const now = nowIso();
    // 课堂能力默认跟随课时：课时开放了生视频，课堂就默认开生视频（此前硬编码导致新课堂永远是关的）
    const lessonCapabilities = lessonCanvasConfig(lessonId).capabilities || [];
    const capabilityDefault = (flag, key) => (capability[flag] === undefined ? (lessonCapabilities.includes(key) ? 1 : 0) : (capability[flag] ? 1 : 0)); const sessionKind = classMatch[2] === 'makeup' || ctx.body?.sessionKind === 'MAKEUP' ? 'MAKEUP' : 'REGULAR'; const deliveryMode = String(ctx.body?.deliveryMode || 'CANVAS').trim().toUpperCase(); if (!['CANVAS', 'VIBECODING'].includes(deliveryMode)) throw errors.badRequest('课堂入口类型无效', 'INVALID_DELIVERY_MODE');
    transaction(() => { q('INSERT INTO class_sessions(id,class_id,lesson_id,status,session_kind,delivery_mode,session_credit_cap,consumed_credits_total,ai_paused,student_call_cap,allow_text,allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,started_by,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [sessionId, cls.id, lessonId, 'ACTIVE', sessionKind, deliveryMode, cap, 0, capability.aiPaused ? 1 : 0, capability.studentCallCap === undefined || capability.studentCallCap === null ? null : integer(capability.studentCallCap, '单学生调用次数', { min: 1, max: 100000 }), capabilityDefault('allowText', 'text'), capabilityDefault('allowImage', 'image'), capabilityDefault('allowMusic', 'music'), capabilityDefault('allowVideo', 'video'), 0, 0, auth.user.id, now]); q('UPDATE classes SET current_session_id=?,updated_at=? WHERE id=? AND org_id=?', [sessionId, now, cls.id, currentOrgId]); });
    audit(ctx, sessionKind === 'MAKEUP' ? 'MAKEUP_SESSION_START' : 'SESSION_START', 'CLASS_SESSION', sessionId, null, { classId: cls.id, lessonId, sessionKind, deliveryMode }); return normalizeSession(row('SELECT session.*,COALESCE(lesson.published_title, lesson.title) AS lesson_title FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE session.id=? AND session.class_id=?', [sessionId, cls.id]));
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/([^/]+)\/cancel$/);
  if (classMatch && method === 'POST') {
    const cls = classInOrg(auth, classMatch[1]); assertTeachingClassManager(auth, cls); const session = row('SELECT * FROM class_sessions WHERE id=? AND class_id=?', [classMatch[2], cls.id]);
    if (!session) throw errors.notFound('课堂不存在', 'CLASS_SESSION_NOT_FOUND');
    if (session.status !== 'ACTIVE') throw errors.conflict('课堂已结束，不能重复取消', 'CLASS_SESSION_ENDED');
    const now = nowIso(); transaction(() => { q("UPDATE class_sessions SET status='ENDED',ended_at=?,ended_by=?,ended_reason='CANCELED' WHERE id=? AND class_id=? AND status='ACTIVE'", [now, auth.user.id, session.id, cls.id]); q('UPDATE classes SET current_session_id=NULL,updated_at=? WHERE id=? AND org_id=? AND current_session_id=?', [now, cls.id, currentOrgId, session.id]); });
    audit(ctx, 'SESSION_CANCEL', 'CLASS_SESSION', session.id, null, { classId: cls.id, reason: ctx.body?.reason || null }); return normalizeSession(row('SELECT session.*,COALESCE(lesson.published_title, lesson.title) AS lesson_title FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE session.id=? AND session.class_id=?', [session.id, cls.id]));
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/([^/]+)\/ai-controls$/);
  if (classMatch && method === 'PUT') {
    const cls = classInOrg(auth, classMatch[1]); assertTeachingClassManager(auth, cls); const session = row('SELECT * FROM class_sessions WHERE id=? AND class_id=?', [classMatch[2], cls.id]);
    if (!session) throw errors.notFound('课堂不存在', 'CLASS_SESSION_NOT_FOUND');
    if (session.status !== 'ACTIVE') throw errors.conflict('课堂已结束', 'CLASS_SESSION_ENDED');
    const body = ctx.body || {}; const capabilities = body.capabilities || {};
    const value = (key, fallback) => Object.prototype.hasOwnProperty.call(capabilities, key) ? (capabilities[key] ? 1 : 0) : fallback;
    const sessionCreditCap = Object.prototype.hasOwnProperty.call(body, 'sessionCreditCap') ? (body.sessionCreditCap === null || body.sessionCreditCap === '' ? null : integer(body.sessionCreditCap, '课堂积分上限')) : session.session_credit_cap;
    const studentCallCap = Object.prototype.hasOwnProperty.call(body, 'studentCallCap') ? (body.studentCallCap === null || body.studentCallCap === '' ? null : integer(body.studentCallCap, '单学生调用次数', { min: 1, max: 100000 })) : session.student_call_cap;
    const aiPaused = Object.prototype.hasOwnProperty.call(body, 'aiPaused') ? (body.aiPaused ? 1 : 0) : session.ai_paused;
    q("UPDATE class_sessions SET session_credit_cap=?,student_call_cap=?,ai_paused=?,allow_text=?,allow_image=?,allow_music=?,allow_video=?,allow_podcast=?,allow_dubbing=? WHERE id=? AND class_id=? AND status='ACTIVE'", [sessionCreditCap, studentCallCap, aiPaused, value('allowText', session.allow_text), value('allowImage', session.allow_image), value('allowMusic', session.allow_music), value('allowVideo', session.allow_video), value('allowPodcast', session.allow_podcast), value('allowDubbing', session.allow_dubbing), session.id, cls.id]);
    const updated = normalizeSession(row('SELECT session.*,COALESCE(lesson.published_title, lesson.title) AS lesson_title FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE session.id=? AND session.class_id=?', [session.id, cls.id]));
    audit(ctx, 'SESSION_AI_CONTROLS_UPDATE', 'CLASS_SESSION', session.id, normalizeSession(session), updated); return updated;
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/([^/]+)\/(end|credit-cap|capabilities)$/);
  if (classMatch && method === 'POST') {
    const cls = classInOrg(auth, classMatch[1]); assertTeachingClassManager(auth, cls); const session = row('SELECT * FROM class_sessions WHERE id=? AND class_id=?', [classMatch[2], cls.id]); if (!session) throw errors.notFound('课堂不存在', 'CLASS_SESSION_NOT_FOUND'); const action = classMatch[3];
    if (action === 'end') assertTransition(ctx, 'classSession', session.status, 'ENDED', { targetType: 'CLASS_SESSION', targetId: session.id, before: normalizeSession(session), code: 'INVALID_CLASS_SESSION_TRANSITION', message: '课堂已结束，不能重复结束' });
    else if (session.status !== 'ACTIVE') throw errors.conflict('课堂已结束', 'CLASS_SESSION_ENDED');
    if (action === 'end') transaction(() => { q("UPDATE class_sessions SET status='ENDED',ended_at=?,ended_by=?,ended_reason=? WHERE id=? AND class_id=? AND status='ACTIVE'", [nowIso(), auth.user.id, String(ctx.body?.reason || 'MANUAL').slice(0, 100), session.id, cls.id]); q('UPDATE classes SET current_session_id=NULL,updated_at=? WHERE id=? AND org_id=? AND current_session_id=?', [nowIso(), cls.id, currentOrgId, session.id]); });
    if (action === 'credit-cap') q("UPDATE class_sessions SET session_credit_cap=? WHERE id=? AND class_id=? AND status='ACTIVE'", [ctx.body?.sessionCreditCap === null ? null : integer(ctx.body?.sessionCreditCap, '课堂积分上限'), session.id, cls.id]);
    if (action === 'capabilities') { const capability = ctx.body?.capabilities || {}; q("UPDATE class_sessions SET allow_text=?,allow_image=?,allow_music=?,allow_video=?,allow_podcast=?,allow_dubbing=? WHERE id=? AND class_id=? AND status='ACTIVE'", [capability.allowText === undefined ? session.allow_text : (capability.allowText ? 1 : 0), capability.allowImage === undefined ? session.allow_image : (capability.allowImage ? 1 : 0), capability.allowMusic === undefined ? session.allow_music : (capability.allowMusic ? 1 : 0), capability.allowVideo === undefined ? session.allow_video : (capability.allowVideo ? 1 : 0), capability.allowPodcast === undefined ? session.allow_podcast : (capability.allowPodcast ? 1 : 0), capability.allowDubbing === undefined ? session.allow_dubbing : (capability.allowDubbing ? 1 : 0), session.id, cls.id]); }
    audit(ctx, 'SESSION_' + action.toUpperCase(), 'CLASS_SESSION', session.id, null, ctx.body); return normalizeSession(row('SELECT session.*,COALESCE(lesson.published_title, lesson.title) AS lesson_title FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE session.id=? AND session.class_id=?', [session.id, cls.id]));
  }
  if (part === '/work-reports' && method === 'GET') {
    const params = [currentOrgId]; let where = 'report.org_id=?';
    if (auth.user.role === 'TEACHER') { where += " AND (class.teacher_id=? OR EXISTS (SELECT 1 FROM class_members scoped_member WHERE scoped_member.class_id=class.id AND scoped_member.user_id=? AND scoped_member.role='TEACHER' AND scoped_member.removed_at IS NULL))"; params.push(auth.user.id, auth.user.id); }
    const status = ctx.search.get('status'); if (['PENDING', 'RESOLVED', 'DISMISSED'].includes(status)) { where += ' AND report.status=?'; params.push(status); }
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 50 });
    const fromWhere = `FROM work_reports report JOIN works work ON work.id=report.work_id AND work.org_id=report.org_id LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id WHERE ${where}`;
    const total = Number(row(`SELECT COUNT(*) n ${fromWhere}`, params)?.n || 0);
    // pending 是筛选范围内的待处理总数（不是本页条数），页头徽标要一直准确
    const pending = Number(row(`SELECT COUNT(*) n ${fromWhere} AND report.status='PENDING'`, params)?.n || 0);
    const items = rows(
      `SELECT report.*, work.title AS work_title, work.status AS work_status, reporter.display_name AS reporter_name, handler.display_name AS handler_name
       FROM work_reports report JOIN works work ON work.id=report.work_id AND work.org_id=report.org_id
       LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
       JOIN users reporter ON reporter.id=report.reporter_id LEFT JOIN users handler ON handler.id=report.handled_by
       WHERE ${where}
       ORDER BY CASE report.status WHEN 'PENDING' THEN 0 ELSE 1 END, report.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset],
    ).map((report) => normalizeWorkReport(report, { includeReporter: true }));
    return { ...pageResult(items, { page, limit, total }), pending };
  }
  let orgReportMatch = part.match(/^\/work-reports\/([^/]+)$/);
  if (orgReportMatch && method === 'PUT') {
    const report = workReportInReviewScope(auth, currentOrgId, orgReportMatch[1]);
    if (report.status !== 'PENDING') throw errors.conflict('举报已处理，不能重复处理', 'WORK_REPORT_ALREADY_HANDLED');
    const status = ctx.body?.status; if (!['RESOLVED', 'DISMISSED'].includes(status)) throw errors.badRequest('举报处理状态无效', 'INVALID_WORK_REPORT_STATUS');
    const actionTaken = ctx.body?.actionTaken || 'NONE'; if (!['NONE', 'UNPUBLISH'].includes(actionTaken)) throw errors.badRequest('举报处理动作无效', 'INVALID_WORK_REPORT_ACTION');
    const resolution = reportResolution(ctx.body); const work = workInReviewScope(auth, currentOrgId, report.work_id);
    if (actionTaken === 'UNPUBLISH' && work.status !== 'PUBLISHED') throw errors.conflict('仅已发布作品可因举报下架', 'WORK_NOT_PUBLISHED');
    const now = nowIso();
    transaction(() => {
      if (actionTaken === 'UNPUBLISH') {
        q('UPDATE works SET status=?,teacher_comment=?,reviewed_by=?,reviewed_at=?,featured_at=NULL,featured_by=NULL,featured_reason=NULL WHERE id=? AND org_id=?', ['REJECTED', resolution, auth.user.id, now, work.id, currentOrgId]);
        const latestSubmission = row('SELECT id FROM work_submissions WHERE work_id=? ORDER BY round DESC LIMIT 1', [work.id]);
        if (latestSubmission) q('UPDATE work_submissions SET review_status=?,review_comment=?,reviewed_at=?,updated_at=? WHERE id=?', ['REJECTED', resolution, now, now, latestSubmission.id]);
        q(
          "UPDATE student_projects SET status='DRAFT',updated_at=? WHERE id=? AND org_id=? AND status='SUBMITTED' AND deleted_at IS NULL",
          [now, work.project_id, currentOrgId],
        );
      }
      q('UPDATE work_reports SET status=?,handled_by=?,handled_at=?,resolution=?,action_taken=? WHERE id=? AND org_id=?', [status, auth.user.id, now, resolution, actionTaken, report.id, currentOrgId]);
    });
    audit(ctx, 'ORG_WORK_REPORT_HANDLE', 'WORK_REPORT', report.id, normalizeWorkReport(report), { status, actionTaken, resolution }, { orgId: currentOrgId });
    if (actionTaken === 'UNPUBLISH') audit(ctx, 'ORG_WORK_UNPUBLISH_REPORT', 'WORK', work.id, normalizeWorkReport(report), { status: 'REJECTED', reportId: report.id }, { orgId: currentOrgId });
    // 自动提醒：举报已处理 → 通知作品作者学生（P4-O09）
    try {
      if (work?.student_id) {
        scheduleReminder({
          title: status === 'RESOLVED' ? '举报已有处理结果' : '举报已被驳回',
          body: status === 'RESOLVED'
            ? `您举报的作品《${work.title || report.work_id}》已处理：${resolution}`
            : `您举报的作品《${work.title || report.work_id}》因证据不足已被驳回`,
          targetUserId: work.student_id,
          targetOrgId: currentOrgId,
          eventKey: `WORK_REPORT_RESOLVED:${report.id}`,
          targetUrl: '/works',
        });
      }
    } catch { /* 提醒失败不影响主流程 */ }
    return workReportRows('report.id=?', [report.id])[0];
  }
  if (part === '/works' && method === 'GET') {
    const status = String(ctx.search.get('status') || '').trim();
    const classFilter = String(ctx.search.get('classId') || '').trim();
    const search = String(ctx.search.get('search') || '').trim().slice(0, 100);
    if (status && !['PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED'].includes(status)) throw errors.badRequest('作品状态筛选无效', 'INVALID_WORK_STATUS_FILTER');
    const params = [currentOrgId]; let where = 'work.org_id=?';
    if (status) { where += ' AND work.status=?'; params.push(status); }
    if (classFilter) { where += ' AND work.class_id=?'; params.push(classFilter); }
    if (search) {
      const keyword = '%' + search.replace(new RegExp(`[%\\_]`, 'g'), (char) => '\\' + char) + '%';
      where += " AND (work.title LIKE ? ESCAPE '\\' OR student.display_name LIKE ? ESCAPE '\\' OR lesson.title LIKE ? ESCAPE '\\')";
      params.push(keyword, keyword, keyword);
    }
    if (auth.user.role === 'TEACHER') { where += " AND (class.teacher_id=? OR EXISTS (SELECT 1 FROM class_members scoped_member WHERE scoped_member.class_id=class.id AND scoped_member.user_id=? AND scoped_member.role='TEACHER' AND scoped_member.removed_at IS NULL))"; params.push(auth.user.id, auth.user.id); }
    const items = rows(`SELECT work.*,student.display_name student_name,class.name class_name,lesson.title lesson_title,reviewer.display_name reviewer_name,COALESCE((SELECT COUNT(1) FROM work_reports report WHERE report.work_id=work.id AND report.status='PENDING'),0) pending_report_count FROM works work JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by WHERE ${where} ORDER BY CASE WHEN work.featured_at IS NULL THEN 1 ELSE 0 END, work.featured_at DESC, work.submitted_at DESC LIMIT 200`, params).map((work) => ({ ...normalizeWork(work, { includeSnapshot: ctx.search.get('includeSnapshot') === 'true' }), pendingReportCount: Number(work.pending_report_count || 0) })); return { items };
  }
  let orgFeatureMatch = part.match(/^\/works\/([^/]+)\/feature$/);
  if (orgFeatureMatch && method === 'PUT') {
    const work = workInReviewScope(auth, currentOrgId, orgFeatureMatch[1]);
    if (!Object.hasOwn(ctx.body || {}, 'featured') || typeof ctx.body.featured !== 'boolean') throw errors.badRequest('请选择是否设为机构精选', 'WORK_FEATURED_REQUIRED');
    const featured = ctx.body.featured;
    if (featured && work.status !== 'PUBLISHED') throw errors.conflict('仅已发布作品可以设为机构精选', 'WORK_NOT_PUBLISHED');
    if (featured && !work.student_allow_feature) throw errors.forbidden('该学生已关闭机构精选展示授权', 'STUDENT_FEATURE_OPT_OUT');
    const reason = featured ? String(ctx.body?.reason || '').trim().slice(0, 500) : null;
    const now = nowIso();
    transaction(() => {
      q('UPDATE works SET featured_at=?,featured_by=?,featured_reason=? WHERE id=? AND org_id=?', [featured ? now : null, featured ? auth.user.id : null, reason || null, work.id, currentOrgId]);
    });
    audit(ctx, featured ? 'ORG_WORK_FEATURE' : 'ORG_WORK_UNFEATURE', 'WORK', work.id, normalizeWork(work), { featured, reason: reason || null }, { orgId: currentOrgId });
    return normalizeWork(row('SELECT * FROM works WHERE id=? AND org_id=?', [work.id, currentOrgId]));
  }

  if (part === '/work-publish-requests' && method === 'GET') {
    const params = [currentOrgId]; let where = 'request.org_id=?';
    if (auth.user.role === 'TEACHER') {
      where += ` AND (class.teacher_id=? OR EXISTS (
        SELECT 1 FROM class_members scoped_member
        WHERE scoped_member.class_id=class.id AND scoped_member.user_id=?
          AND scoped_member.role='TEACHER' AND scoped_member.removed_at IS NULL
      ))`;
      params.push(auth.user.id, auth.user.id);
    }
    const status = ctx.search.get('status');
    if (['PENDING','APPROVED','REJECTED','WITHDRAWN'].includes(status)) { where += ' AND request.status=?'; params.push(status); }
    const items = rows(
      `SELECT request.*, work.title AS work_title, work.status AS work_status, work.class_id AS work_class_id,
              student.display_name AS student_name, handler.display_name AS handler_name
       FROM work_publish_requests request
       JOIN works work ON work.id=request.work_id AND work.org_id=request.org_id
       JOIN users student ON student.id=request.student_id AND student.org_id=request.org_id
       LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
       LEFT JOIN users handler ON handler.id=request.resolved_by
       WHERE ${where}
       ORDER BY CASE request.status WHEN 'PENDING' THEN 0 ELSE 1 END, request.requested_at DESC`,
      params,
    ).map(orgWorkPublishRequestRow);
    return { items, total: items.length, pending: items.filter((item) => item.status === 'PENDING').length };
  }

  let publishRequestMatch = part.match(/^\/work-publish-requests\/([^/]+)$/);
  if (publishRequestMatch && method === 'PUT') {
    const requestRow = row('SELECT * FROM work_publish_requests WHERE id=? AND org_id=?', [publishRequestMatch[1], currentOrgId]);
    if (!requestRow) throw errors.notFound('发布申请不存在', 'WORK_PUBLISH_REQUEST_NOT_FOUND');
    const work = workInReviewScope(auth, currentOrgId, requestRow.work_id);
    if (requestRow.status !== 'PENDING') throw errors.conflict('发布申请已处理，不能重复处理', 'WORK_PUBLISH_REQUEST_ALREADY_HANDLED');
    const status = String(ctx.body?.status || '').toUpperCase();
    if (!['APPROVED','REJECTED'].includes(status)) throw errors.badRequest('发布申请处理状态无效', 'INVALID_WORK_PUBLISH_REQUEST_STATUS');
    assertTransition(ctx, 'workPublishRequest', requestRow.status, status, { targetType: 'WORK_PUBLISH_REQUEST', targetId: requestRow.id, before: normalizeWorkPublishRequest(requestRow), code: 'INVALID_WORK_PUBLISH_REQUEST_TRANSITION', message: '发布申请当前状态不允许处理' });
    const resolution = String(ctx.body?.resolution || '').trim();
    if (resolution.length > 2000) throw errors.badRequest('处理说明不能超过 2000 个字符', 'WORK_PUBLISH_RESOLUTION_TOO_LONG');
    if (status === 'APPROVED' && work.status !== 'APPROVED') throw errors.conflict('仅审核通过的作品可以批准发布', 'WORK_NOT_APPROVED');
    if (status === 'APPROVED' && !work.copyright_confirmed_at) throw errors.conflict('学生尚未确认作品版权与展示授权，不能发布', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    const now = nowIso();
    transaction(() => {
      q(
        'UPDATE work_publish_requests SET status=?,resolved_at=?,resolved_by=?,resolution=?,updated_at=? WHERE id=? AND org_id=? AND status=?',
        [status, now, auth.user.id, resolution, now, requestRow.id, currentOrgId, 'PENDING'],
      );
      if (status === 'APPROVED') {
        q(
          `UPDATE works SET status='PUBLISHED',reviewed_by=?,reviewed_at=?,featured_at=NULL,featured_by=NULL,featured_reason=NULL
           WHERE id=? AND org_id=? AND status='APPROVED'`,
          [auth.user.id, now, work.id, currentOrgId],
        );
        const latestSubmission = row('SELECT id FROM work_submissions WHERE work_id=? ORDER BY round DESC LIMIT 1', [work.id]);
        if (latestSubmission) q('UPDATE work_submissions SET review_status=?,reviewed_at=?,updated_at=? WHERE id=?', ['PUBLISHED', now, now, latestSubmission.id]);
      }
    });
    audit(ctx, status === 'APPROVED' ? 'WORK_PUBLISH_REQUEST_APPROVE' : 'WORK_PUBLISH_REQUEST_REJECT', 'WORK_PUBLISH_REQUEST', requestRow.id, normalizeWorkPublishRequest(requestRow), { status, resolution, workId: work.id }, { orgId: currentOrgId });
    return orgWorkPublishRequestRows('request.id=?', [requestRow.id])[0];
  }

  // 机构端：把课包的「可用次数」分给学生（用掉 1 次；同一学生同一课包只能一次；机构侧不可撤销）
  if (part === '/course-grants' && method === 'GET') {
    const seriesFilter = String(ctx.search.get('seriesId') || '').trim();
    const params = [currentOrgId];
    let where = 'grant.org_id=?';
    if (seriesFilter) { where += ' AND grant.series_id=?'; params.push(seriesFilter); }
    const items = rows(`SELECT grant.id, grant.student_id, grant.series_id, grant.granted_at, grant.revoked_at, grant.revoke_reason,
        student.display_name student_name, student.login student_login, series.title series_title
      FROM student_course_grants grant
      JOIN users student ON student.id=grant.student_id
      JOIN course_series series ON series.id=grant.series_id
      WHERE ${where} ORDER BY grant.granted_at DESC LIMIT 500`, params).map((item) => ({
      id: item.id, studentId: item.student_id, studentName: item.student_name || null, studentLogin: item.student_login || null,
      seriesId: item.series_id, seriesTitle: item.series_title || null, grantedAt: item.granted_at,
      revokedAt: item.revoked_at || null, revokeReason: item.revoke_reason || null,
    }));
    return { items, total: items.length };
  }
  if (part === '/course-grants' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可以给学员授权课包', 'ORG_ADMIN_REQUIRED');
    const seriesId = nonEmptyString(ctx.body?.seriesId, '课包', { max: 100 });
    const requested = Array.isArray(ctx.body?.studentIds) ? ctx.body.studentIds : [];
    const studentIds = [...new Set(requested.map((value) => String(value || '').trim()).filter(Boolean))];
    if (!studentIds.length || studentIds.length > 200) throw errors.badRequest('请选择 1-200 名学员', 'INVALID_STUDENT_IDS');
    const assignment = row("SELECT * FROM course_assignments WHERE series_id=? AND org_id=? AND status='ACTIVE' AND (expires_at IS NULL OR expires_at > ?)", [seriesId, currentOrgId, nowIso()]);
    if (!assignment) throw errors.forbidden('该课包未授权给当前机构', 'COURSE_NOT_AUTHORIZED');
    const placeholders = studentIds.map(() => '?').join(',');
    const students = rows(`SELECT id, display_name, login FROM users WHERE id IN (${placeholders}) AND org_id=? AND role='STUDENT' AND deleted_at IS NULL`, [...studentIds, currentOrgId]);
    if (students.length !== studentIds.length) throw errors.badRequest('存在不属于本机构的学员', 'STUDENT_NOT_FOUND');
    // 已授权过的跳过（不重复扣次数）：同一机构 + 同一学生 + 同一课包只允许一条有效记录
    const already = new Set(rows(`SELECT student_id FROM student_course_grants WHERE org_id=? AND series_id=? AND revoked_at IS NULL AND student_id IN (${placeholders})`, [currentOrgId, seriesId, ...studentIds]).map((item) => item.student_id));
    const fresh = studentIds.filter((studentId) => !already.has(studentId));
    const quotaTotal = Number(assignment.quota_total || 0);
    const quotaUsed = Number(assignment.quota_used || 0);
    if (quotaTotal > 0 && quotaUsed + fresh.length > quotaTotal) {
      throw errors.conflict(`可用次数不足：授权 ${quotaTotal} 次，已用 ${quotaUsed} 次，本次需要 ${fresh.length} 次`, 'COURSE_QUOTA_EXHAUSTED');
    }
    const now = nowIso();
    transaction(() => {
      fresh.forEach((studentId) => {
        const existing = row('SELECT id FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=?', [currentOrgId, studentId, seriesId]);
        if (existing) {
          // 撤销过的那条沿用（谁什么时候被授权过留痕），并把它重新置为有效
          q('UPDATE student_course_grants SET revoked_at=NULL,revoked_by=NULL,revoke_reason=NULL,granted_at=?,granted_by=?,source_assignment_id=? WHERE id=?', [now, auth.user.id, assignment.id, existing.id]);
        } else {
          q('INSERT INTO student_course_grants(id,org_id,student_id,series_id,source_assignment_id,granted_by,granted_at) VALUES (?,?,?,?,?,?,?)', [id('coursegrant'), currentOrgId, studentId, seriesId, assignment.id, auth.user.id, now]);
        }
      });
      if (fresh.length) q('UPDATE course_assignments SET quota_used=quota_used+? WHERE id=?', [fresh.length, assignment.id]);
    });
    audit(ctx, 'ORG_COURSE_GRANT', 'COURSE_SERIES', seriesId, null, { studentIds: fresh, skipped: studentIds.length - fresh.length }, { orgId: currentOrgId });
    return { granted: fresh.length, skipped: studentIds.length - fresh.length, quotaTotal, quotaUsed: quotaUsed + fresh.length };
  }

  // P1: 机构端 - 查看成员配额列表
  if (part === '/members/credits' && method === 'GET') {
    const auth = requireRole(ctx, ['ORG_ADMIN']);
    const currentOrgId = auth.user.orgId;
    const role = ctx.search?.role || 'STUDENT';
    if (!['STUDENT', 'TEACHER'].includes(role)) throw errors.badRequest('角色必须是 STUDENT 或 TEACHER', 'INVALID_ROLE');
    
    const page = Math.max(1, Number(ctx.search?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(ctx.search?.limit || 50)));
    const offset = (page - 1) * limit;
    
    const items = rows(
      `SELECT u.id AS user_id, u.display_name, u.role, u.ai_credit_limit, u.ai_credits_used,
              (SELECT MAX(created_at) FROM usage_records WHERE user_id = u.id) AS last_used_at,
              (SELECT MAX(created_at) FROM user_credit_adjustments WHERE user_id = u.id AND adjustment_type = 'ALLOCATION') AS last_allocated_at
       FROM users u
       WHERE u.org_id = ? AND u.role = ? AND u.deleted_at IS NULL
       ORDER BY u.display_name
       LIMIT ? OFFSET ?`,
      [currentOrgId, role, limit, offset]
    );
    
    const total = count(
      'SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = ? AND deleted_at IS NULL',
      [currentOrgId, role]
    );
    
    return {
      items: items.map(item => ({
        userId: item.user_id,
        displayName: item.display_name,
        role: item.role,
        aiCredits: Number(item.ai_credit_limit || 0),
        aiCreditsUsed: Number(item.ai_credits_used),
        aiCreditsAvailable: Number(item.ai_credit_limit || 0) - Number(item.ai_credits_used),
        lastUsedAt: item.last_used_at,
        lastAllocatedAt: item.last_allocated_at
      })),
      total,
      page
    };
  }
  
  // P1: 机构端 - 调整单个用户配额
  match = part.match(/^\/members\/([^/]+)\/credits\/adjust$/);
  if (match && method === 'POST') {
    const auth = requireRole(ctx, ['ORG_ADMIN']);
    const currentOrgId = auth.user.orgId;
    const userId = match[1];
    
    const user = row('SELECT * FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL', [userId, currentOrgId]);
    if (!user) throw errors.notFound('用户不存在或不属于当前机构', 'USER_NOT_FOUND');
    if (!['STUDENT', 'TEACHER'].includes(user.role)) throw errors.badRequest('只能为学生或教师分配配额', 'INVALID_ROLE');
    
    const creditsChange = integer(ctx.body?.creditsChange, '配额变化量', { min: -1000000, max: 1000000 });
    if (creditsChange === 0) throw errors.badRequest('配额变化量不能为零', 'INVALID_CREDITS_CHANGE');
    
    const reason = String(ctx.body?.reason || '配额调整').slice(0, 300);
    const adjustmentType = creditsChange > 0 ? 'ALLOCATION' : 'ADJUSTMENT';
    
    const result = transaction(() => {
      const creditsBefore = Number(user.ai_credit_limit || 0);
      const creditsAfter = creditsBefore + creditsChange;
      
      if (creditsAfter < 0) throw errors.badRequest('调整后配额不能为负数', 'INSUFFICIENT_CREDITS');
      
      // 如果是增加配额,需要检查机构余额
      if (creditsChange > 0) {
        ensureOrgBilling(currentOrgId);
        const account = row('SELECT credit_balance FROM org_billing_accounts WHERE org_id = ?', [currentOrgId]);
        const orgBalance = Number(account.credit_balance);
        if (orgBalance < creditsChange) throw errors.badRequest('机构积分余额不足', 'INSUFFICIENT_ORG_CREDITS');
        
        // 扣减机构余额
        q('UPDATE org_billing_accounts SET credit_balance = credit_balance - ?, updated_version = updated_version + 1 WHERE org_id = ?', [creditsChange, currentOrgId]);
        
        // 记录机构积分流水
        q('INSERT INTO credit_entries(id,org_id,direction,type,credits,balance_after,user_id,status,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [id('credit'), currentOrgId, 'OUT', 'USER_ALLOCATION', creditsChange, orgBalance - creditsChange, userId, 'EFFECTIVE', `为 ${user.display_name} 分配配额`, auth.user.id, nowIso()]
        );
      }
      
      // 更新用户配额
      q('UPDATE users SET ai_credit_limit = ?, updated_at = ? WHERE id = ?', [creditsAfter, nowIso(), userId]);
      
      // 记录配额调整历史
      q('INSERT INTO user_credit_adjustments(id,org_id,user_id,credits_before,credits_after,credits_change,reason,adjustment_type,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id('adjustment'), currentOrgId, userId, creditsBefore, creditsAfter, creditsChange, reason, adjustmentType, auth.user.id, nowIso()]
      );
      
      return { creditsBefore, creditsAfter };
    });
    
    audit(ctx, 'ORG_USER_CREDIT_ADJUST', 'USER', userId, { aiCredits: result.creditsBefore }, { aiCredits: result.creditsAfter, reason }, { orgId: currentOrgId });
    
    return {
      success: true,
      creditsAfter: result.creditsAfter,
      adjustment: {
        id: id('adjustment'),
        creditsBefore: result.creditsBefore,
        creditsAfter: result.creditsAfter,
        createdAt: nowIso()
      }
    };
  }
  
  // P1: 机构端 - 批量分配配额
  if (part === '/members/credits/batch-allocate' && method === 'POST') {
    const auth = requireRole(ctx, ['ORG_ADMIN']);
    const currentOrgId = auth.user.orgId;
    
    const userIds = ctx.body?.userIds;
    if (!Array.isArray(userIds) || userIds.length === 0) throw errors.badRequest('用户ID列表不能为空', 'INVALID_USER_IDS');
    if (userIds.length > 100) throw errors.badRequest('批量分配最多支持100个用户', 'TOO_MANY_USERS');
    
    const creditsPerUser = integer(ctx.body?.creditsPerUser, '每人配额', { min: 1, max: 100000 });
    const reason = String(ctx.body?.reason || '批量配额分配').slice(0, 300);
    const totalCreditsNeeded = userIds.length * creditsPerUser;
    
    // 验证用户存在且属于当前机构
    const users = rows(
      `SELECT id, display_name, role, ai_credit_limit, ai_credits_used FROM users WHERE id IN (${userIds.map(() => '?').join(',')}) AND org_id = ? AND deleted_at IS NULL`,
      [...userIds, currentOrgId]
    );
    
    if (users.length !== userIds.length) throw errors.badRequest('部分用户不存在或不属于当前机构', 'INVALID_USERS');
    
    const result = transaction(() => {
      // 检查机构余额
      ensureOrgBilling(currentOrgId);
      const account = row('SELECT credit_balance FROM org_billing_accounts WHERE org_id = ?', [currentOrgId]);
      const orgBalance = Number(account.credit_balance);
      if (orgBalance < totalCreditsNeeded) throw errors.badRequest(`机构积分余额不足，需要 ${totalCreditsNeeded} 积分，当前余额 ${orgBalance}`, 'INSUFFICIENT_ORG_CREDITS');
      
      // 扣减机构余额
      q('UPDATE org_billing_accounts SET credit_balance = credit_balance - ?, updated_version = updated_version + 1 WHERE org_id = ?', [totalCreditsNeeded, currentOrgId]);
      
      const now = nowIso();
      let allocated = 0;
      
      // 为每个用户分配配额
      for (const user of users) {
        const creditsBefore = Number(user.ai_credit_limit || 0);
        const creditsAfter = creditsBefore + creditsPerUser;
        
        q('UPDATE users SET ai_credit_limit = ?, updated_at = ? WHERE id = ?', [creditsAfter, now, user.id]);
        
        q('INSERT INTO user_credit_adjustments(id,org_id,user_id,credits_before,credits_after,credits_change,reason,adjustment_type,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [id('adjustment'), currentOrgId, user.id, creditsBefore, creditsAfter, creditsPerUser, reason, 'ALLOCATION', auth.user.id, now]
        );
        
        allocated++;
      }
      
      // 记录机构积分流水
      q('INSERT INTO credit_entries(id,org_id,direction,type,credits,balance_after,status,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id('credit'), currentOrgId, 'OUT', 'BATCH_USER_ALLOCATION', totalCreditsNeeded, orgBalance - totalCreditsNeeded, 'EFFECTIVE', `批量为 ${allocated} 个用户分配配额`, auth.user.id, now]
      );
      
      return { allocated, orgBalanceAfter: orgBalance - totalCreditsNeeded };
    });
    
    audit(ctx, 'ORG_BATCH_CREDIT_ALLOCATE', 'ORG', currentOrgId, null, { userCount: result.allocated, creditsPerUser, totalCredits: totalCreditsNeeded }, { orgId: currentOrgId });
    
    return {
      success: true,
      allocated: result.allocated,
      totalCreditsUsed: totalCreditsNeeded,
      orgBalanceAfter: result.orgBalanceAfter
    };
  }
  
  // P1: 机构端 - 查看用户配额调整历史
  match = part.match(/^\/members\/([^/]+)\/credits\/history$/);
  if (match && method === 'GET') {
    const auth = requireRole(ctx, ['ORG_ADMIN']);
    const currentOrgId = auth.user.orgId;
    const userId = match[1];
    
    const user = row('SELECT * FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL', [userId, currentOrgId]);
    if (!user) throw errors.notFound('用户不存在或不属于当前机构', 'USER_NOT_FOUND');
    
    const page = Math.max(1, Number(ctx.search?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(ctx.search?.limit || 20)));
    const offset = (page - 1) * limit;
    
    const items = rows(
      `SELECT a.*, u.display_name AS actor_name
       FROM user_credit_adjustments a
       LEFT JOIN users u ON a.actor_id = u.id
       WHERE a.user_id = ? AND a.org_id = ?
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, currentOrgId, limit, offset]
    );
    
    const total = count(
      'SELECT COUNT(*) AS n FROM user_credit_adjustments WHERE user_id = ? AND org_id = ?',
      [userId, currentOrgId]
    );
    
    return {
      items: items.map(item => ({
        id: item.id,
        creditsBefore: item.credits_before,
        creditsAfter: item.credits_after,
        creditsChange: item.credits_change,
        reason: item.reason,
        adjustmentType: item.adjustment_type,
        actorName: item.actor_name,
        createdAt: item.created_at
      })),
      total,
      page
    };
  }

  return null;
}
