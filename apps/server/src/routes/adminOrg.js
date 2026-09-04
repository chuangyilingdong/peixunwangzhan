import {
  audit, count, errors, id, json, normalizeClass, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, nonEmptyString, nowIso, parseJson,
  q, requireRole, row, rows, transaction,
} from '../lib.js';
import { hashPassword } from '@platform/database';
import { adjustCredits, normalizeEntry, reconcileCredits, refundOrReverseEntry, setFrozenCredits } from '../services/creditLedger.js';
import { scheduleReminder } from './communication.js';
import { assertKnownState, assertTransition } from '../services/domainState.js';

function ensureOrgBilling(orgId) { q('INSERT OR IGNORE INTO org_billing_accounts(org_id) VALUES (?)', [orgId]); }
function integer(value, label, { min = 0, max = 1000000, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw errors.badRequest(label + '必须是有效整数', 'VALIDATION_ERROR');
  return n;
}
function orgId(auth) { if (!auth.user.orgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED'); return auth.user.orgId; }
function orgUser(auth, userId) {
  const user = row('SELECT * FROM users WHERE id=? AND org_id=? AND deleted_at IS NULL', [userId, orgId(auth)]);
  if (!user) throw errors.notFound('用户不存在', 'USER_NOT_FOUND');
  return user;
}
function hasPermission(auth, permission) {
  return auth.user.role === 'ORG_ADMIN' || (auth.user.role === 'TEACHER' && parseJson(auth.rawUser.permissions, []).includes(permission));
}
function classInOrg(auth, classId) {
  const cls = row('SELECT class.*, teacher.display_name AS teacher_name FROM classes class LEFT JOIN users teacher ON teacher.id=class.teacher_id AND teacher.org_id=class.org_id WHERE class.id=? AND class.org_id=?', [classId, orgId(auth)]);
  if (!cls) throw errors.notFound('班级不存在', 'CLASS_NOT_FOUND');
  return cls;
}
function assertClassManager(auth, cls, permission = 'MANAGE_CLASSES') {
  if (auth.user.role === 'ORG_ADMIN') return;
  if (auth.user.role === 'TEACHER' && teacherCanAccessClass(auth, cls) && hasPermission(auth, permission)) return;
  throw errors.forbidden('无班级管理权限', 'CLASS_PERMISSION_DENIED');
}
function accessibleLesson(currentOrgId, lessonId) {
  return row(
    "SELECT lesson.* FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND assignment.status='ACTIVE' WHERE lesson.id=? AND lesson.status='PUBLISHED' AND series.status='PUBLISHED' AND ((series.owner_type='PLATFORM' AND (series.visibility='ALL_ORGS' OR assignment.id IS NOT NULL)) OR (series.owner_type='ORG' AND series.org_id=?))",
    [currentOrgId, lessonId, currentOrgId],
  );
}
function accessibleSeries(currentOrgId, seriesId) {
  return row(
    "SELECT series.* FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND assignment.status='ACTIVE' WHERE series.id=? AND series.status='PUBLISHED' AND ((series.owner_type='PLATFORM' AND (series.visibility='ALL_ORGS' OR assignment.id IS NOT NULL)) OR (series.owner_type='ORG' AND series.org_id=?))",
    [currentOrgId, seriesId, currentOrgId],
  );
}
const ORG_MEMBER_ROLES = new Set(['TEACHER', 'STUDENT']);
const ORG_TEACHER_PERMISSIONS = new Set(['MANAGE_MEMBERS', 'MANAGE_CLASSES']);

function validateMemberPhone(phone, existingId = null) {
  const value = phone == null ? '' : String(phone).trim();
  if (!value) return null;
  if (!/^[0-9+()\-\s]{6,30}$/.test(value)) throw errors.badRequest('手机号格式无效', 'INVALID_PHONE');
  const duplicate = row('SELECT id FROM users WHERE phone=? AND deleted_at IS NULL' + (existingId ? ' AND id<>?' : ''), existingId ? [value, existingId] : [value]);
  if (duplicate) throw errors.conflict('手机号已被其他账号使用', 'PHONE_EXISTS');
  return value;
}

function validateMemberPermissions(value, role) {
  if (role !== 'TEACHER') return [];
  const permissions = Array.isArray(value) ? [...new Set(value)] : [];
  if (permissions.some((item) => typeof item !== 'string' || !ORG_TEACHER_PERMISSIONS.has(item))) throw errors.badRequest('包含无效的教师权限码', 'INVALID_MEMBER_PERMISSION');
  return permissions;
}

function classMemberships(orgIdValue, userId) {
  return rows(`SELECT class.id,class.name,class.teacher_id,class.status,class_member.role AS member_role
    FROM class_members class_member JOIN classes class ON class.id=class_member.class_id
    WHERE class.org_id=? AND class_member.user_id=? AND class_member.removed_at IS NULL
    ORDER BY class.created_at DESC`, [orgIdValue, userId]).map((item) => ({
    id: item.id, name: item.name, teacherId: item.teacher_id || null, status: item.status, role: item.member_role,
  }));
}

function orgMemberRow(value, currentOrgId) {
  return { ...normalizeUser(value, { includeAuthMeta: true }), classes: classMemberships(currentOrgId, value.id) };
}

const ENROLLMENT_STATUSES = new Set(['PENDING', 'ACTIVE', 'SUSPENDED', 'VOIDED', 'EXPIRED']);
const PAYMENT_STATUSES = new Set(['UNRECORDED', 'RECORDED', 'WAIVED']);

function packageSnapshot(pkg) {
  return {
    name: pkg.name,
    priceFen: Number(pkg.price_fen || 0),
    monthlyCredits: Number(pkg.monthly_credits || 0),
    bonusCredits: Number(pkg.bonus_credits || 0),
    durationDays: Number(pkg.duration_days || 0),
    capabilities: {
      allowImage: !!pkg.allow_image, allowMusic: !!pkg.allow_music, allowVideo: !!pkg.allow_video,
      allowPodcast: !!pkg.allow_podcast, allowDubbing: !!pkg.allow_dubbing,
    },
  };
}

function enrollmentDate(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw errors.badRequest(label + '无效', 'INVALID_ENROLLMENT_DATE');
  return parsed.toISOString();
}

function enrollmentRow(currentOrgId, enrollmentId) {
  const item = row(`SELECT enrollment.*, student.display_name student_name, student.login student_login,
      package.name package_name, package.student_seats package_student_seats
    FROM student_enrollments enrollment
    JOIN users student ON student.id=enrollment.student_id AND student.org_id=enrollment.org_id
    JOIN billing_packages package ON package.id=enrollment.package_id AND package.org_id=enrollment.org_id
    WHERE enrollment.id=? AND enrollment.org_id=?`, [enrollmentId, currentOrgId]);
  if (!item) throw errors.notFound('学员开通单不存在', 'ENROLLMENT_NOT_FOUND');
  return item;
}

function normalizeEnrollment(value, { includeEvents = false } = {}) {
  if (!value) return null;
  const snapshot = parseJson(value.package_snapshot, {});
  const result = {
    id: value.id, orgId: value.org_id, studentId: value.student_id, studentName: value.student_name || null,
    studentLogin: value.student_login || null, packageId: value.package_id, packageName: value.package_name || snapshot.name || null,
    status: value.status, paymentStatus: value.payment_status, priceFen: Number(value.price_fen || 0),
    packageSnapshot: snapshot, startsAt: value.starts_at, expiresAt: value.expires_at,
    activatedAt: value.activated_at || null, suspendedAt: value.suspended_at || null, voidedAt: value.voided_at || null,
    notes: value.notes || '', eventCount: Number(value.event_count || 0), lastEventAt: value.last_event_at || null,
    createdAt: value.created_at, updatedAt: value.updated_at,
  };
  if (includeEvents) result.events = rows(`SELECT event.* , actor.display_name actor_name
    FROM student_enrollment_events event LEFT JOIN users actor ON actor.id=event.actor_id
    WHERE event.enrollment_id=? ORDER BY event.created_at DESC LIMIT 100`, [value.id]).map((event) => ({
    id: event.id, type: event.event_type, beforeStatus: event.before_status || null, afterStatus: event.after_status || null,
    data: parseJson(event.data, {}), actorName: event.actor_name || '系统', createdAt: event.created_at,
  }));
  return result;
}

function appendEnrollmentEvent({ enrollmentId, currentOrgId, eventType, beforeStatus = null, afterStatus = null, actorId = null, data = {} }) {
  q(`INSERT INTO student_enrollment_events(id,enrollment_id,org_id,event_type,before_status,after_status,data,actor_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, [id('enroll_event'), enrollmentId, currentOrgId, eventType, beforeStatus, afterStatus, json(data), actorId, nowIso()]);
}

function expireDueEnrollments(currentOrgId) {
  const now = nowIso();
  const due = rows("SELECT * FROM student_enrollments WHERE org_id=? AND status='ACTIVE' AND expires_at<=?", [currentOrgId, now]);
  due.forEach((enrollment) => {
    q("UPDATE student_enrollments SET status='EXPIRED',updated_at=? WHERE id=?", [now, enrollment.id]);
    q("UPDATE users SET status='DISABLED',billing_package_id=NULL,monthly_credit_allowance=0,monthly_bonus_credits=0,month_period_boost_credits=0,updated_at=? WHERE id=? AND org_id=? AND billing_package_id=?", [now, enrollment.student_id, currentOrgId, enrollment.package_id]);
    q('UPDATE sessions SET superseded_at=COALESCE(superseded_at,?) WHERE user_id=? AND superseded_at IS NULL', [now, enrollment.student_id]);
    appendEnrollmentEvent({ enrollmentId: enrollment.id, currentOrgId, eventType: 'EXPIRE', beforeStatus: 'ACTIVE', afterStatus: 'EXPIRED', data: { reason: '有效期届满' } });
  });
  return due.length;
}

function occupiedStudentSeats(currentOrgId, packageId, { excludeEnrollmentId = null } = {}) {
  const params = [currentOrgId, packageId, nowIso()];
  let where = "org_id=? AND package_id=? AND status='ACTIVE' AND expires_at>?";
  if (excludeEnrollmentId) { where += ' AND id<>?'; params.push(excludeEnrollmentId); }
  return count('SELECT COUNT(*) n FROM student_enrollments WHERE ' + where, params);
}

function assertEnrollmentSeat(currentOrgId, pkg, { excludeEnrollmentId = null } = {}) {
  const limit = Number(pkg.student_seats || 0);
  const occupied = occupiedStudentSeats(currentOrgId, pkg.id, { excludeEnrollmentId });
  if (limit < 1) throw errors.conflict('套餐尚未配置可开通的学员席位', 'PACKAGE_STUDENT_SEATS_REQUIRED');
  if (occupied >= limit) throw errors.conflict('套餐可用学员席位不足', 'STUDENT_SEAT_LIMIT');
  return { limit, occupied, available: Math.max(0, limit - occupied) };
}

function setStudentEnrollmentAccess(currentOrgId, enrollment, status) {
  const snapshot = parseJson(enrollment.package_snapshot, {});
  const now = nowIso();
  if (status === 'ACTIVE') {
    q(`UPDATE users SET status='ACTIVE',expires_at=?,billing_package_id=?,monthly_credit_allowance=?,monthly_bonus_credits=?,month_period_boost_credits=0,used_credits_this_period=0,period_start_at=?,period_reset_at=?,updated_at=?
      WHERE id=? AND org_id=? AND role='STUDENT'`, [enrollment.expires_at, enrollment.package_id, Number(snapshot.monthlyCredits || 0), Number(snapshot.bonusCredits || 0), enrollment.starts_at, enrollment.expires_at, now, enrollment.student_id, currentOrgId]);
  } else {
    q(`UPDATE users SET status='DISABLED',billing_package_id=NULL,monthly_credit_allowance=0,monthly_bonus_credits=0,month_period_boost_credits=0,updated_at=?
      WHERE id=? AND org_id=? AND role='STUDENT' AND billing_package_id=?`, [now, enrollment.student_id, currentOrgId, enrollment.package_id]);
    q('UPDATE sessions SET superseded_at=COALESCE(superseded_at,?) WHERE user_id=? AND superseded_at IS NULL', [now, enrollment.student_id]);
  }
}

function packageWithSeatUsage(currentOrgId, value) {
  const normalized = normalizePackage(value);
  const occupiedSeats = occupiedStudentSeats(currentOrgId, value.id);
  return { ...normalized, occupiedSeats, availableSeats: Math.max(0, Number(value.student_seats || 0) - occupiedSeats) };
}

function teacherCanAccessClass(auth, cls) {
  return auth.user.role !== 'TEACHER' || cls.teacher_id === auth.user.id || Boolean(row(
    "SELECT id FROM class_members WHERE class_id=? AND user_id=? AND role='TEACHER' AND removed_at IS NULL",
    [cls.id, auth.user.id],
  ));
}

function teacherScope(alias, auth, params) {
  if (auth.user.role !== 'TEACHER') return '';
  params.push(auth.user.id, auth.user.id);
  return ` AND (${alias}.teacher_id=? OR EXISTS (SELECT 1 FROM class_members scoped_member WHERE scoped_member.class_id=${alias}.id AND scoped_member.user_id=? AND scoped_member.role='TEACHER' AND scoped_member.removed_at IS NULL))`;
}

function classSessionRows(classId) {
  return rows(`SELECT session.*, lesson.title AS lesson_title,
      starter.display_name AS started_by_name, ender.display_name AS ended_by_name
    FROM class_sessions session
    LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id
    LEFT JOIN users starter ON starter.id=session.started_by
    LEFT JOIN users ender ON ender.id=session.ended_by
    WHERE session.class_id=? ORDER BY session.started_at DESC`, [classId]).map((session) => ({
    ...normalizeSession(session),
    startedByName: session.started_by_name || null,
    endedByName: session.ended_by_name || null,
  }));
}

function classProgressRows(classId) {
  return rows(`SELECT item.lesson_id, item.sort, item.source_series_id,
      lesson.title, lesson.summary, lesson.duration_minutes, lesson.status AS lesson_status,
      COUNT(DISTINCT CASE WHEN member.role='STUDENT' AND member.removed_at IS NULL AND student.deleted_at IS NULL THEN member.user_id END) AS student_count,
      COUNT(DISTINCT CASE WHEN member.role='STUDENT' AND member.removed_at IS NULL AND project.id IS NOT NULL THEN member.user_id END) AS started_student_count,
      COUNT(DISTINCT CASE WHEN member.role='STUDENT' AND member.removed_at IS NULL AND (project.status IN ('SUBMITTED','GRADED') OR work.id IS NOT NULL) THEN member.user_id END) AS submitted_student_count,
      COUNT(DISTINCT CASE WHEN member.role='STUDENT' AND member.removed_at IS NULL AND work.status IN ('APPROVED','PUBLISHED') THEN member.user_id END) AS published_student_count
    FROM class_curriculum_items item
    JOIN course_lessons lesson ON lesson.id=item.lesson_id
    LEFT JOIN class_members member ON member.class_id=item.class_id
    LEFT JOIN users student ON student.id=member.user_id AND student.role='STUDENT'
    LEFT JOIN student_projects project ON project.class_id=item.class_id AND project.course_lesson_id=item.lesson_id AND project.student_id=member.user_id AND project.status!='ARCHIVED'
    LEFT JOIN works work ON work.class_id=item.class_id AND work.course_lesson_id=item.lesson_id AND work.student_id=member.user_id
    WHERE item.class_id=? GROUP BY item.lesson_id,item.sort,item.source_series_id,lesson.title,lesson.summary,lesson.duration_minutes,lesson.status
    ORDER BY item.sort`, [classId]).map((item) => {
    const studentCount = Number(item.student_count || 0);
    const startedCount = Number(item.started_student_count || 0);
    const submittedCount = Number(item.submitted_student_count || 0);
    const publishedCount = Number(item.published_student_count || 0);
    return {
      lessonId: item.lesson_id, sort: Number(item.sort || 0), sourceSeriesId: item.source_series_id,
      title: item.title, summary: item.summary || '', durationMinutes: Number(item.duration_minutes || 0), lessonStatus: item.lesson_status,
      studentCount, startedStudentCount: startedCount, submittedStudentCount: submittedCount, publishedStudentCount: publishedCount,
      startedPercent: studentCount ? Math.round((startedCount / studentCount) * 100) : 0,
      submittedPercent: studentCount ? Math.round((submittedCount / studentCount) * 100) : 0,
      publishedPercent: studentCount ? Math.round((publishedCount / studentCount) * 100) : 0,
    };
  });
}

function classDetail(auth, cls) {
  const detail = normalizeClass(cls, { detail: true });
  const sessions = classSessionRows(cls.id);
  const progress = classProgressRows(cls.id);
  return {
    ...detail,
    sessions,
    progress,
    summary: {
      studentCount: detail.studentCount,
      curriculumCount: progress.length,
      sessionCount: sessions.length,
      completedSessionCount: sessions.filter((session) => session.status === 'ENDED' && session.endedReason !== 'CANCELED').length,
      canceledSessionCount: sessions.filter((session) => session.endedReason === 'CANCELED').length,
    },
  };
}

function importItems(body) {
  const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.rows) ? body.rows : null;
  if (!items) throw errors.badRequest('批量导入必须提供 items 数组', 'IMPORT_ITEMS_REQUIRED');
  if (!items.length) throw errors.badRequest('批量导入不能为空', 'IMPORT_ITEMS_REQUIRED');
  if (items.length > 500) throw errors.badRequest('单批最多导入 500 条', 'IMPORT_LIMIT');
  return items;
}

function validateImportItem(raw, currentOrgId, index, seenLogins, seenPhones, teacherSeatOffset = 0) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const role = String(item.role || '').trim().toUpperCase();
  const login = String(item.login || '').trim();
  const displayName = String(item.displayName || item.name || '').trim();
  const password = String(item.password || '');
  const phone = String(item.phone || '').trim();
  const errorsForRow = [];
  let monthlyCreditAllowance = 0;
  if (!ORG_MEMBER_ROLES.has(role)) errorsForRow.push('角色必须是 TEACHER 或 STUDENT');
  if (!login) errorsForRow.push('登录名不能为空');
  if (login.length > 100) errorsForRow.push('登录名不能超过 100 个字符');
  if (!displayName) errorsForRow.push('姓名不能为空');
  if (password.length < 6) errorsForRow.push('初始密码至少 6 位');
  if (phone && !/^[0-9+()\-\s]{6,30}$/.test(phone)) errorsForRow.push('手机号格式无效');
  if (seenLogins.has(login)) errorsForRow.push('本批次登录名重复');
  if (row('SELECT id FROM users WHERE login=?', [login])) errorsForRow.push('登录名已存在');
  if (phone && (seenPhones.has(phone) || row('SELECT id FROM users WHERE phone=? AND deleted_at IS NULL', [phone]))) errorsForRow.push('手机号已被其他账号使用');
  let permissions = [];
  if (role === 'TEACHER') {
    try { permissions = validateMemberPermissions(item.permissions, role); } catch (error) { errorsForRow.push(error.message); }
  }
  if (role === 'STUDENT' && item.studentUsageScope !== undefined && !['FOLLOW_CLASS', 'HOME_PRACTICE'].includes(item.studentUsageScope)) errorsForRow.push('学员额度范围无效');
  if (role === 'STUDENT') { try { monthlyCreditAllowance = integer(item.monthlyCreditAllowance, '月度积分'); } catch (error) { errorsForRow.push(error.message); } }
  if (item.billingPackageId && !row('SELECT id FROM billing_packages WHERE id=? AND org_id=?', [item.billingPackageId, currentOrgId])) errorsForRow.push('套餐不属于当前机构');
  if (Array.isArray(item.classIds)) {
    item.classIds.map(String).filter((classId, position, values) => values.indexOf(classId) === position).forEach((classId) => {
      if (!row("SELECT id FROM classes WHERE id=? AND org_id=? AND status='ACTIVE'", [classId, currentOrgId])) errorsForRow.push('包含不存在或已归档班级');
    });
  }
  seenLogins.add(login);
  if (phone) seenPhones.add(phone);
  return {
    index,
    valid: errorsForRow.length === 0,
    errors: errorsForRow,
    value: {
      role, login, displayName, password, phone: phone || null,
      permissions,
      expiresAt: item.expiresAt || null,
      studentUsageScope: role === 'STUDENT' ? (item.studentUsageScope || 'HOME_PRACTICE') : null,
      billingPackageId: role === 'STUDENT' ? (item.billingPackageId || null) : null,
      monthlyCreditAllowance,
      classIds: Array.isArray(item.classIds) ? [...new Set(item.classIds.map(String))] : [],
    },
  };
}

function previewImport(body, currentOrgId) {
  const items = importItems(body);
  const seenLogins = new Set(); const seenPhones = new Set();
  const normalized = items.map((item, index) => validateImportItem(item, currentOrgId, index + 1, seenLogins, seenPhones));
  const teacherCount = normalized.filter((item) => item.valid && item.value.role === 'TEACHER').length;
  const org = normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [currentOrgId]));
  if ((org.teacherSeats - org.teacherUsedSeats) < teacherCount) normalized.forEach((item) => { if (item.valid && item.value.role === 'TEACHER') { item.valid = false; item.errors.push('教师席位不足'); } });
  return { total: normalized.length, validCount: normalized.filter((item) => item.valid).length, invalidCount: normalized.filter((item) => !item.valid).length, items: normalized };
}

function createMember(currentOrgId, value) {
  const now = nowIso(); const userId = id('user');
  q('INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,phone,status,expires_at,student_usage_scope,billing_package_id,monthly_credit_allowance,period_start_at,period_reset_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [userId, currentOrgId, value.login, value.displayName, value.role, json(value.permissions), hashPassword(value.password), value.phone, 'ACTIVE', value.expiresAt, value.studentUsageScope, value.billingPackageId, value.monthlyCreditAllowance, now, new Date(Date.now() + 30 * 86400000).toISOString(), now, now]);
  value.classIds.forEach((classId) => {
    const cls = row('SELECT id FROM classes WHERE id=? AND org_id=? AND status=\'ACTIVE\'', [classId, currentOrgId]);
    if (!cls) throw errors.badRequest(`第 ${value.login} 条记录包含不存在或已归档班级`, 'INVALID_CLASS');
    if (!['TEACHER', 'STUDENT'].includes(value.role)) return;
    q('INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES (?,?,?,?,?)', [id('member'), cls.id, userId, value.role, now]);
  });
  return row('SELECT * FROM users WHERE id=?', [userId]);
}

function validateTeacher(currentOrgId, teacherId) {
  if (!teacherId) return null;
  const teacher = row("SELECT id FROM users WHERE id=? AND org_id=? AND role='TEACHER' AND status='ACTIVE' AND deleted_at IS NULL", [teacherId, currentOrgId]);
  if (!teacher) throw errors.badRequest('教师不属于当前机构或已停用', 'INVALID_TEACHER');
  return teacher;
}
const PLATFORM_ADMIN_PERMISSIONS = new Set([
  'ADMIN_DASHBOARD', 'ADMIN_ORGANIZATIONS', 'ADMIN_USERS', 'ADMIN_COURSES', 'ADMIN_WORKS',
  'ADMIN_HACKATHON', 'ADMIN_BILLING', 'ADMIN_MATERIALS', 'ADMIN_INBOX', 'ADMIN_ADMINS',
  'ADMIN_ADJUSTMENT',
]);
function platformAdminPermissions(value) {
  const items = Array.isArray(value) ? value : [];
  if (items.some((item) => typeof item !== 'string' || !PLATFORM_ADMIN_PERMISSIONS.has(item))) throw errors.badRequest('包含无效的平台权限码', 'INVALID_ADMIN_PERMISSION');
  return [...new Set(items)];
}
function platformUserRow(value) {
  return { ...normalizeUser(value, { includeAuthMeta: true }), organizationName: value.organization_name || null, billingPackageName: value.billing_package_name || null };
}
function lastSuperAdminGuard(target) {
  if (target.role !== 'SUPER_ADMIN' || target.status !== 'ACTIVE') return;
  const activeSuperAdmins = rows("SELECT id FROM users WHERE role='SUPER_ADMIN' AND status='ACTIVE' AND deleted_at IS NULL");
  if (activeSuperAdmins.length <= 1 && activeSuperAdmins.some((item) => item.id === target.id)) throw errors.badRequest('不能停用最后一个有效平台管理员', 'LAST_SUPER_ADMIN_FORBIDDEN');
}

function bumpSeriesVersion(version) {
  const parts = String(version || '1.0').split('.');
  const minor = Number(parts[1] || 0);
  if (Number.isFinite(minor)) { parts[1] = String(minor + 1); return parts.slice(0, 2).join('.'); }
  return '1.1';
}
function userLoginMeta(userIds) {
  const meta = new Map();
  if (!userIds.length) return meta;
  const marks = userIds.map(() => '?').join(',');
  for (const item of rows('SELECT actor_id, MAX(created_at) last_login FROM audit_logs WHERE action=\'AUTH_LOGIN\' AND actor_id IN (' + marks + ') GROUP BY actor_id', userIds)) {
    meta.set(item.actor_id, { lastLoginAt: item.last_login, activeSessions: 0 });
  }
  for (const item of rows('SELECT user_id, COUNT(*) n FROM sessions WHERE user_id IN (' + marks + ') AND superseded_at IS NULL AND expires_at>? GROUP BY user_id', [...userIds, nowIso()])) {
    const existing = meta.get(item.user_id) || { lastLoginAt: null, activeSessions: 0 };
    existing.activeSessions = Number(item.n || 0);
    meta.set(item.user_id, existing);
  }
  return meta;
}


function curriculumItem(value) { return { id: value.id, lessonId: value.lesson_id, title: value.title, summary: value.summary || '', sort: Number(value.sort || 0), durationMinutes: Number(value.duration_minutes || 0), sourceSeriesId: value.source_series_id }; }

function orgAccountRequestRow(value) {
  return {
    id: value.id,
    userId: value.user_id,
    orgId: value.org_id || null,
    studentId: value.user_id,
    studentName: value.student_name || null,
    studentLogin: value.student_login || null,
    type: value.type,
    reason: value.reason || null,
    status: value.status,
    requestedAt: value.requested_at,
    resolvedAt: value.resolved_at || null,
    resolvedBy: value.resolved_by || null,
    handlerName: value.handler_name || null,
    resolution: value.resolution || null,
    exportPayload: value.export_payload ? parseJson(value.export_payload, null) : null,
  };
}

function orgAccountRequestRows(where, params) {
  return rows(
    `SELECT request.*, student.display_name AS student_name, student.login AS student_login, handler.display_name AS handler_name
     FROM account_requests request
     JOIN users student ON student.id=request.user_id AND student.org_id=request.org_id
     LEFT JOIN users handler ON handler.id=request.resolved_by
     WHERE ${where}`,
    params,
  ).map(orgAccountRequestRow);
}

function buildStudentDataExport(user, org) {
  const classes = rows(
    `SELECT class.id, class.name, class.usage_mode, class.status, class_member.role AS member_role, class_member.joined_at
     FROM class_members class_member
     JOIN classes class ON class.id=class_member.class_id
     WHERE class_member.user_id=? AND class.org_id=? AND class_member.removed_at IS NULL
     ORDER BY class_member.joined_at DESC`,
    [user.id, user.org_id],
  );
  const projects = rows(
    `SELECT project.id, project.title, project.status, project.created_at, project.updated_at,
            lesson.title AS lesson_title, class.name AS class_name
     FROM student_projects project
     LEFT JOIN course_lessons lesson ON lesson.id=project.course_lesson_id
     LEFT JOIN classes class ON class.id=project.class_id AND class.org_id=project.org_id
     WHERE project.student_id=? AND project.org_id=?
     ORDER BY project.created_at DESC LIMIT 500`,
    [user.id, user.org_id],
  );
  const works = rows(
    `SELECT work.id, work.title, work.status, work.submitted_at, work.reviewed_at,
            lesson.title AS lesson_title, class.name AS class_name
     FROM works work
     LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id
     LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
     WHERE work.student_id=? AND work.org_id=?
     ORDER BY work.submitted_at DESC LIMIT 500`,
    [user.id, user.org_id],
  );
  const generationJobs = rows(
    `SELECT job.id, job.modality, job.provider, job.model, job.status, job.credits_charged,
            job.created_at, job.completed_at, project.title AS project_title
     FROM generation_jobs job
     LEFT JOIN student_projects project ON project.id=job.project_id
     WHERE job.user_id=? AND job.org_id=?
     ORDER BY job.created_at DESC LIMIT 500`,
    [user.id, user.org_id],
  );
  const usageRecords = rows(
    `SELECT usage.id, usage.modality, usage.model, usage.credits_charged, usage.status, usage.created_at,
            project.title AS project_title
     FROM usage_records usage
 LEFT JOIN student_projects project ON project.id=usage.project_id AND project.student_id=usage.user_id AND project.org_id=usage.org_id
     WHERE usage.user_id=? AND usage.org_id=?
     ORDER BY usage.created_at DESC LIMIT 500`,
    [user.id, user.org_id],
  );
  return {
    format: 'STUDENT_DATA_EXPORT_V1',
    generatedAt: nowIso(),
    scope: {
      organizationId: org?.id || null,
      organizationName: org?.name || null,
      statement: '数据来自平台当前数据库，包含该学生在本机构的学习记录概览；不包含密码、会话令牌、内部审计信息等敏感字段。',
    },
    profile: {
      id: user.id,
      login: user.login,
      displayName: user.display_name,
      avatarKey: user.avatar_key || null,
      status: user.status,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      guardian: user.guardian_name == null && user.guardian_phone == null && user.guardian_relationship == null ? null : {
        name: user.guardian_name || null,
        phone: user.guardian_phone || null,
        relationship: user.guardian_relationship || null,
        consentedAt: user.guardian_consented_at || null,
      },
      privacy: {
        showcaseAnonymous: !!user.privacy_showcase_anonymous,
        allowFeature: !!user.privacy_allow_feature,
      },
    },
    classes: classes.map((item) => ({
      id: item.id, name: item.name, usageMode: item.usage_mode, status: item.status,
      memberRole: item.member_role, joinedAt: item.joined_at,
    })),
    projects: projects.map((item) => ({
      id: item.id, title: item.title, status: item.status, lessonTitle: item.lesson_title || null,
      className: item.class_name || null, createdAt: item.created_at, updatedAt: item.updated_at,
    })),
    works: works.map((item) => ({
      id: item.id, title: item.title, status: item.status, lessonTitle: item.lesson_title || null,
      className: item.class_name || null, submittedAt: item.submitted_at, reviewedAt: item.reviewed_at || null,
    })),
    aiTasks: {
      total: generationJobs.length,
      items: generationJobs.map((item) => ({
        id: item.id, modality: item.modality, provider: item.provider, model: item.model,
        status: item.status, creditsCharged: Number(item.credits_charged || 0),
        projectTitle: item.project_title || null, createdAt: item.created_at, completedAt: item.completed_at || null,
      })),
    },
    usageRecords: {
      total: usageRecords.length,
      totalCredits: usageRecords.reduce((total, item) => total + Number(item.credits_charged || 0), 0),
      items: usageRecords.map((item) => ({
        id: item.id, modality: item.modality, model: item.model,
        credits: Number(item.credits_charged || 0), status: item.status,
        projectTitle: item.project_title || null, createdAt: item.created_at,
      })),
    },
  };
}

function softDeleteStudent(ctx, user, now) {
  const changes = q(
    `UPDATE users SET status='DISABLED', deleted_at=?, display_name='已注销学生', avatar_key=NULL,
     guardian_name=NULL, guardian_phone=NULL, guardian_relationship=NULL, guardian_consented_at=NULL,
     updated_at=? WHERE id=? AND org_id=? AND deleted_at IS NULL`,
    [now, now, user.id, user.org_id],
  ).changes;
  if (!changes) throw errors.conflict('学生账号已注销，不能重复处理', 'ACCOUNT_REQUEST_STUDENT_DELETED');
  q('UPDATE sessions SET superseded_at=? WHERE user_id=? AND org_id=? AND superseded_at IS NULL', [now, user.id, user.org_id]);
}

function workInReviewScope(auth, currentOrgId, workId) {
  const work = row(
    `SELECT work.*, student.privacy_allow_feature AS student_allow_feature, class.teacher_id
     FROM works work
     JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id
     LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
     WHERE work.id=? AND work.org_id=?`,
    [workId, currentOrgId],
  );
  if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
  if (auth.user.role === 'TEACHER' && !teacherCanAccessClass(auth, { id: work.class_id, teacher_id: work.teacher_id })) {
    throw errors.forbidden('不能点评未授权班级的作品', 'WORK_PERMISSION_DENIED');
  }
  return work;
}
function annotationRows(workId) {
  return rows(
    `SELECT annotation.*, author.display_name AS author_name, resolver.display_name AS resolver_name
     FROM work_annotations annotation
     JOIN users author ON author.id=annotation.author_id
     LEFT JOIN users resolver ON resolver.id=annotation.resolved_by
     WHERE annotation.work_id=?
     ORDER BY annotation.created_at DESC`,
    [workId],
  ).map((annotation) => ({
    id: annotation.id, workId: annotation.work_id, nodeId: annotation.node_id || null,
    content: annotation.content, authorId: annotation.author_id, authorName: annotation.author_name || '教师',
    createdAt: annotation.created_at, resolvedAt: annotation.resolved_at || null,
    resolvedBy: annotation.resolved_by || null, resolverName: annotation.resolver_name || null,
  }));
}
function assertAnnotationNode(work, nodeId) {
  if (!nodeId) return null;
  const snapshot = parseJson(work.canvas_snapshot, { nodes: [] });
  if (!Array.isArray(snapshot?.nodes) || !snapshot.nodes.some((node) => node?.id === nodeId)) {
    throw errors.badRequest('批注关联的画布卡片不存在', 'ANNOTATION_NODE_NOT_FOUND');
  }
  return nodeId;
}

function workReportRows(where = '1=1', params = []) {
  return rows(
    `SELECT report.*, work.title AS work_title, work.status AS work_status,
      reporter.display_name AS reporter_name, handler.display_name AS handler_name
     FROM work_reports report
     JOIN works work ON work.id=report.work_id AND work.org_id=report.org_id
     JOIN users reporter ON reporter.id=report.reporter_id
     LEFT JOIN users handler ON handler.id=report.handled_by
     WHERE ${where}
     ORDER BY CASE report.status WHEN 'PENDING' THEN 0 ELSE 1 END, report.created_at DESC`,
    params,
  ).map((report) => normalizeWorkReport(report, { includeReporter: true }));
}

function workReportInReviewScope(auth, currentOrgId, reportId) {
  const report = row(
    `SELECT report.*, work.title AS work_title, work.status AS work_status, work.class_id AS class_id, class.teacher_id
     FROM work_reports report
     JOIN works work ON work.id=report.work_id AND work.org_id=report.org_id
     LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
     WHERE report.id=? AND report.org_id=?`,
    [reportId, currentOrgId],
  );
  if (!report) throw errors.notFound('举报记录不存在', 'WORK_REPORT_NOT_FOUND');
  if (auth.user.role === 'TEACHER' && !teacherCanAccessClass(auth, { id: report.class_id, teacher_id: report.teacher_id })) {
    throw errors.forbidden('不能处理未授权班级作品的举报', 'WORK_REPORT_PERMISSION_DENIED');
  }
  return report;
}

function reportResolution(body) {
  const resolution = String(body?.resolution || '').trim();
  if (!resolution) throw errors.badRequest('请填写举报处理说明', 'WORK_REPORT_RESOLUTION_REQUIRED');
  if (resolution.length > 2000) throw errors.badRequest('举报处理说明不能超过 2000 个字符', 'WORK_REPORT_RESOLUTION_TOO_LONG');
  return resolution;
}

function normalizeWorkPublishRequest(request) {
  if (!request) return null;
  return {
    id: request.id,
    workId: request.work_id,
    projectId: request.project_id,
    studentId: request.student_id,
    orgId: request.org_id,
    round: Number(request.round || 0),
    status: request.status,
    reason: request.reason || '',
    requestedAt: request.requested_at,
    resolvedAt: request.resolved_at || null,
    resolvedBy: request.resolved_by || null,
    resolution: request.resolution || null,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
  };
}

function orgWorkPublishRequestRow(request) {
  return {
    ...normalizeWorkPublishRequest(request),
    workTitle: request.work_title || null,
    workStatus: request.work_status || null,
    studentName: request.student_name || null,
    handlerName: request.handler_name || null,
  };
}

function orgWorkPublishRequestRows(where = '1=1', params = []) {
  return rows(
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
}


const WORK_DATA_DAYS = new Set([7, 14, 30]);

function workDataFilters(ctx, auth, currentOrgId) {
  if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('作品数据中心仅机构管理员可访问', 'WORK_DATA_PERMISSION_DENIED');
  const rawDays = ctx.search.get('days');
  const days = rawDays === null || rawDays === '' ? 30 : Number(rawDays);
  if (!Number.isInteger(days) || !WORK_DATA_DAYS.has(days)) throw errors.badRequest('统计周期仅支持 7、14 或 30 天', 'INVALID_WORK_DATA_DAYS');
  const filters = {
    orgId: currentOrgId,
    days,
    since: new Date(Date.now() - days * 86400000).toISOString(),
    classId: String(ctx.search.get('classId') || '').trim() || null,
    lessonId: String(ctx.search.get('lessonId') || '').trim() || null,
    studentId: String(ctx.search.get('studentId') || '').trim() || null,
  };
  if (filters.classId && !row('SELECT id FROM classes WHERE id=? AND org_id=?', [filters.classId, currentOrgId])) {
    throw errors.notFound('班级不存在', 'WORK_DATA_CLASS_NOT_FOUND');
  }
  if (filters.lessonId && !row(
    'SELECT lesson.id FROM course_lessons lesson WHERE lesson.id=? AND (EXISTS (SELECT 1 FROM student_projects project WHERE project.org_id=? AND project.course_lesson_id=lesson.id) OR EXISTS (SELECT 1 FROM works work WHERE work.org_id=? AND work.course_lesson_id=lesson.id))',
    [filters.lessonId, currentOrgId, currentOrgId],
  )) throw errors.notFound('课程课时不存在', 'WORK_DATA_LESSON_NOT_FOUND');
  if (filters.studentId && !row("SELECT id FROM users WHERE id=? AND org_id=? AND role='STUDENT' AND deleted_at IS NULL", [filters.studentId, currentOrgId])) {
    throw errors.notFound('学员不存在', 'WORK_DATA_STUDENT_NOT_FOUND');
  }
  return filters;
}

function appendWorkDataScope(conditions, params, alias, filters) {
  conditions.push(alias + '.org_id=?'); params.push(filters.orgId);
  if (filters.classId) { conditions.push(alias + '.class_id=?'); params.push(filters.classId); }
  if (filters.lessonId) { conditions.push(alias + '.course_lesson_id=?'); params.push(filters.lessonId); }
  if (filters.studentId) { conditions.push(alias + '.student_id=?'); params.push(filters.studentId); }
  return conditions.join(' AND ');
}

function zeroWorkDataMetrics(item) {
  return {
    ...item,
    activeStudentCount: 0, activeProjectCount: 0, completedProjectCount: 0,
    submittedWorkCount: 0, publishedWorkCount: 0, feedbackCount: 0,
    aiCallCount: 0, aiCredits: 0, lastActivityAt: null,
  };
}

function maxTimestamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function workDataDimension(filters, dimension) {
  const config = {
    class: { column: 'class_id', itemKey: 'classId', nameKey: 'className' },
    lesson: { column: 'course_lesson_id', itemKey: 'lessonId', nameKey: 'lessonTitle' },
    student: { column: 'student_id', itemKey: 'studentId', nameKey: 'studentName' },
  }[dimension];
  if (!config) throw new Error('Unknown work-data dimension');

  let baseItems;
  if (dimension === 'class') {
    const params = [filters.orgId]; let where = 'class.org_id=?';
    if (filters.classId) { where += ' AND class.id=?'; params.push(filters.classId); }
    baseItems = rows('SELECT class.id,class.name FROM classes class WHERE ' + where + ' ORDER BY class.name LIMIT 300', params)
      .map((item) => ({ classId: item.id, className: item.name }));
  } else if (dimension === 'lesson') {
    const params = []; const conditions = [];
    const projectScope = appendWorkDataScope(conditions, params, 'project', filters);
    baseItems = rows(
      'SELECT DISTINCT lesson.id,lesson.title FROM course_lessons lesson JOIN student_projects project ON project.course_lesson_id=lesson.id WHERE ' + projectScope + ' AND project.course_lesson_id IS NOT NULL ORDER BY lesson.title LIMIT 300',
      params,
    ).map((item) => ({ lessonId: item.id, lessonTitle: item.title }));
  } else {
    const params = [filters.orgId]; let where = "student.org_id=? AND student.role='STUDENT' AND student.deleted_at IS NULL";
    if (filters.studentId) { where += ' AND student.id=?'; params.push(filters.studentId); }
    baseItems = rows('SELECT student.id,student.display_name FROM users student WHERE ' + where + ' ORDER BY student.display_name LIMIT 500', params)
      .map((item) => ({ studentId: item.id, studentName: item.display_name || '未命名学员' }));
  }

  const index = new Map(baseItems.map((item) => [item[config.itemKey], zeroWorkDataMetrics(item)]));
  const merge = (entries, keys) => {
    for (const entry of entries) {
      const item = index.get(entry.group_id);
      if (!item) continue;
      for (const [source, target] of Object.entries(keys)) {
        if (source === 'last_activity_at') item.lastActivityAt = maxTimestamp(item.lastActivityAt, entry[source]);
        else item[target] = Number(entry[source] || 0);
      }
    }
  };

  {
    const params = [filters.since, filters.since]; const conditions = [];
    const scope = appendWorkDataScope(conditions, params, 'project', filters);
    merge(rows(
      'SELECT project.' + config.column + ' group_id,' +
      ' COUNT(DISTINCT CASE WHEN project.updated_at>=? THEN project.student_id END) active_student_count,' +
      ' SUM(CASE WHEN project.updated_at>=? THEN 1 ELSE 0 END) active_project_count,' +
      " SUM(CASE WHEN project.updated_at>=? AND project.status IN ('SUBMITTED','GRADED') THEN 1 ELSE 0 END) completed_project_count," +
      ' MAX(project.updated_at) last_activity_at FROM student_projects project WHERE ' + scope + ' GROUP BY project.' + config.column,
      [filters.since, ...params],
    ), {
      active_student_count: 'activeStudentCount', active_project_count: 'activeProjectCount',
      completed_project_count: 'completedProjectCount', last_activity_at: 'lastActivityAt',
    });
  }
  {
    const params = [filters.since, filters.since]; const conditions = [];
    const scope = appendWorkDataScope(conditions, params, 'work', filters);
    merge(rows(
      'SELECT work.' + config.column + ' group_id,' +
      ' SUM(CASE WHEN work.submitted_at>=? THEN 1 ELSE 0 END) submitted_work_count,' +
      " SUM(CASE WHEN work.status='PUBLISHED' AND work.reviewed_at>=? THEN 1 ELSE 0 END) published_work_count," +
      ' MAX(COALESCE(work.reviewed_at,work.submitted_at)) last_activity_at FROM works work WHERE ' + scope + ' GROUP BY work.' + config.column,
      [...params],
    ), {
      submitted_work_count: 'submittedWorkCount', published_work_count: 'publishedWorkCount', last_activity_at: 'lastActivityAt',
    });
  }
  {
    const params = [filters.since]; const conditions = [];
    const scope = appendWorkDataScope(conditions, params, 'work', filters);
    merge(rows(
      'SELECT work.' + config.column + ' group_id,COUNT(annotation.id) feedback_count,MAX(annotation.created_at) last_activity_at' +
      ' FROM work_annotations annotation JOIN works work ON work.id=annotation.work_id AND work.org_id=annotation.org_id' +
      ' WHERE annotation.created_at>=? AND ' + scope + ' GROUP BY work.' + config.column,
      params,
    ), { feedback_count: 'feedbackCount', last_activity_at: 'lastActivityAt' });
  }
  {
    const params = [filters.since]; const conditions = [];
    const scope = appendWorkDataScope(conditions, params, 'project', filters);
    merge(rows(
      'SELECT project.' + config.column + ' group_id,COUNT(usage.id) ai_call_count,COALESCE(SUM(usage.credits_charged),0) ai_credits,MAX(usage.created_at) last_activity_at' +
      ' FROM usage_records usage JOIN student_projects project ON project.id=usage.project_id AND project.org_id=usage.org_id' +
      " WHERE usage.status='SUCCESS' AND usage.created_at>=? AND " + scope + ' GROUP BY project.' + config.column,
      params,
    ), { ai_call_count: 'aiCallCount', ai_credits: 'aiCredits', last_activity_at: 'lastActivityAt' });
  }
  return [...index.values()].sort((a, b) => (
    b.submittedWorkCount - a.submittedWorkCount || b.activeProjectCount - a.activeProjectCount || String(a[config.nameKey]).localeCompare(String(b[config.nameKey]), 'zh-CN')
  ));
}

function buildWorkData(ctx, auth, currentOrgId) {
  const filters = workDataFilters(ctx, auth, currentOrgId);
  const classes = workDataDimension(filters, 'class');
  const lessons = workDataDimension(filters, 'lesson');
  const students = workDataDimension(filters, 'student');
  const summary = students.reduce((result, item) => ({
    activeStudents: result.activeStudents + item.activeStudentCount,
    activeProjects: result.activeProjects + item.activeProjectCount,
    completedProjects: result.completedProjects + item.completedProjectCount,
    submittedWorks: result.submittedWorks + item.submittedWorkCount,
    publishedWorks: result.publishedWorks + item.publishedWorkCount,
    feedbackCount: result.feedbackCount + item.feedbackCount,
    aiCalls: result.aiCalls + item.aiCallCount,
    aiCredits: result.aiCredits + item.aiCredits,
  }), { activeStudents: 0, activeProjects: 0, completedProjects: 0, submittedWorks: 0, publishedWorks: 0, feedbackCount: 0, aiCalls: 0, aiCredits: 0 });
  const enrolledStudents = filters.classId
    ? count("SELECT COUNT(DISTINCT member.user_id) n FROM class_members member JOIN users student ON student.id=member.user_id WHERE member.class_id=? AND member.role='STUDENT' AND member.removed_at IS NULL AND student.deleted_at IS NULL", [filters.classId])
    : count("SELECT COUNT(*) n FROM users student WHERE student.org_id=? AND student.role='STUDENT' AND student.deleted_at IS NULL", [currentOrgId]);
  const selectorClasses = rows('SELECT id,name FROM classes WHERE org_id=? ORDER BY name LIMIT 300', [currentOrgId]).map((item) => ({ id: item.id, name: item.name }));
  const selectorLessons = rows(
    'SELECT DISTINCT lesson.id,lesson.title FROM course_lessons lesson JOIN student_projects project ON project.course_lesson_id=lesson.id WHERE project.org_id=? ORDER BY lesson.title LIMIT 300',
    [currentOrgId],
  ).map((item) => ({ id: item.id, title: item.title }));
  const selectorStudents = rows("SELECT id,display_name FROM users WHERE org_id=? AND role='STUDENT' AND deleted_at IS NULL ORDER BY display_name LIMIT 500", [currentOrgId])
    .map((item) => ({ id: item.id, name: item.display_name || '未命名学员' }));
  return {
    scope: { role: 'ORG_ADMIN', days: filters.days, since: filters.since, classId: filters.classId, lessonId: filters.lessonId, studentId: filters.studentId },
    definitions: {
      active: '统计周期内有保存或状态更新的项目及对应学员。',
      completed: '统计周期内进入已提交或已评分状态的项目。',
      published: '统计周期内完成审核并发布到本机构作品墙的作品。',
      feedback: '统计周期内教师新增的画布批注与整体点评。',
      ai: '统计周期内状态为成功且关联项目的 AI 调用与扣减积分。',
    },
    summary: { enrolledStudents, ...summary },
    filters: { classes: selectorClasses, lessons: selectorLessons, students: selectorStudents },
    breakdowns: { classes, lessons, students },
  };
}

function maskedStudentName(name) {
  const value = String(name || '').trim();
  return value ? value.slice(0, 1) + '同学' : '学员';
}

function organizationRow(orgId) {
  const organization = row('SELECT * FROM organizations WHERE id=?', [orgId]);
  if (!organization) throw errors.notFound('机构不存在', 'ORG_NOT_FOUND');
  return organization;
}

function contactPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw errors.badRequest('联系人必须是对象', 'INVALID_ORG_CONTACT');
  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(key)) throw errors.badRequest('联系人字段名无效', 'INVALID_ORG_CONTACT');
    if (item === null || item === undefined || item === '') return;
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') throw errors.badRequest('联系人字段值无效', 'INVALID_ORG_CONTACT');
    result[key] = typeof item === 'string' ? item.slice(0, 200) : item;
  });
  return result;
}

function orgAdminRows(orgId) {
  return rows("SELECT * FROM users WHERE org_id=? AND role='ORG_ADMIN' AND deleted_at IS NULL ORDER BY status='ACTIVE' DESC, created_at ASC", [orgId]).map(normalizeUser);
}

function assertNotLastOrgAdmin(orgId, targetUserId) {
  const activeAdmins = rows("SELECT id FROM users WHERE org_id=? AND role='ORG_ADMIN' AND status='ACTIVE' AND deleted_at IS NULL", [orgId]);
  if (activeAdmins.length <= 1 && activeAdmins.some((item) => item.id === targetUserId)) throw errors.badRequest('不能停用该机构最后一个有效管理员', 'LAST_ORG_ADMIN_FORBIDDEN');
}

function orgContractMeta(organization) {
  const expiresTime = new Date(organization.contract_expires_at).getTime();
  const days = Number.isFinite(expiresTime) ? Math.ceil((expiresTime - Date.now()) / 86400000) : null;
  const expired = days !== null && days <= 0;
  return {
    daysUntilContractExpires: days,
    contractExpiringSoon: days !== null && days > 0 && days <= 30,
    serviceAvailable: ['TRIAL', 'ACTIVE'].includes(organization.status) && !expired,
  };
}

function auditQuery(ctx, opts) {
  opts = opts || {};
  const conditions = [];
  const params = [];
  if (opts.restrictToOrgId) { conditions.push('audit.org_id=?'); params.push(opts.restrictToOrgId); }
  const orgId = String(ctx.search.get('orgId') || '').trim();
  const action = String(ctx.search.get('action') || '').trim();
  const actorId = String(ctx.search.get('actorId') || '').trim();
  const targetType = String(ctx.search.get('targetType') || '').trim();
  const targetId = String(ctx.search.get('targetId') || '').trim();
  const requestPath = String(ctx.search.get('requestPath') || '').trim();
  const fromProvided = ctx.search.has('from');
  const from = fromProvided ? String(ctx.search.get('from') || '').trim() : '';
  const toProvided = ctx.search.has('to');
  const to = toProvided ? String(ctx.search.get('to') || '').trim() : '';
  if (orgId) { conditions.push('audit.org_id=?'); params.push(orgId); }
  if (action) { conditions.push('audit.action=?'); params.push(action); }
  if (actorId) { conditions.push('audit.actor_id=?'); params.push(actorId); }
  if (targetType) { conditions.push('audit.target_type=?'); params.push(targetType); }
  if (targetId) { conditions.push('audit.target_id=?'); params.push(targetId); }
  if (requestPath) { conditions.push('audit.request_path LIKE ?'); params.push('%' + requestPath.replace(/[%_]/g, (c) => '[' + c + ']') + '%'); }
  if (fromProvided) {
    const t = new Date(from);
    if (!from || Number.isNaN(t.getTime())) throw errors.badRequest('开始时间必须是有效 ISO 时间', 'INVALID_FROM');
    if (toProvided) { const t2 = new Date(to); if (!Number.isNaN(t2.getTime()) && t >= t2) throw errors.badRequest('开始时间不能晚于结束时间', 'INVALID_TIME_RANGE'); }
    conditions.push('audit.created_at>=?'); params.push(from);
  }
  if (toProvided) {
    const t = new Date(to);
    if (!to || Number.isNaN(t.getTime())) throw errors.badRequest('结束时间必须是有效 ISO 时间', 'INVALID_TO');
    conditions.push('audit.created_at<?'); params.push(to);
  }
  return { where: conditions.length ? conditions.join(' AND ') : '1=1', params };
}

function auditRow(v) {
  return {
    id: v.id,
    orgId: v.org_id || null,
    orgName: v.org_name || null,
    actorId: v.actor_id || null,
    actorRole: v.actor_role || null,
    actorName: v.actor_name || v.actor_login || '系统',
    actorLogin: v.actor_login || null,
    action: v.action,
    targetType: v.target_type,
    targetId: v.target_id || null,
    requestMethod: v.request_method || null,
    requestPath: v.request_path || null,
    before: parseJson(v.before_data, null),
    after: parseJson(v.after_data, null),
    ip: v.ip || null,
    createdAt: v.created_at,
  };
}

function auditListQuery(where) {
  return 'SELECT audit.*, actor.display_name actor_name, actor.login actor_login, org.name org_name FROM audit_logs audit LEFT JOIN users actor ON actor.id=audit.actor_id LEFT JOIN organizations org ON org.id=audit.org_id WHERE ' + where + ' ORDER BY audit.created_at DESC';
}

function escapeCsv(v) {
  if (v === null || v === undefined) return '';
  const t = String(v);
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function buildOrganizationDetail(orgId) {
  const organization = organizationRow(orgId);
  ensureOrgBilling(organization.id);
  const org = { ...normalizeOrg(organization), ...orgContractMeta(organization) };
  const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [organization.id]);
  const admins = orgAdminRows(organization.id);
  const packages = rows('SELECT * FROM billing_packages WHERE org_id=? ORDER BY created_at DESC LIMIT 100', [organization.id]).map(normalizePackage);
  const courseAssignments = rows(`SELECT assignment.id, assignment.series_id, assignment.status, assignment.assigned_at, series.title AS series_title
    FROM course_assignments assignment JOIN course_series series ON series.id=assignment.series_id
    WHERE assignment.org_id=? ORDER BY assignment.assigned_at DESC LIMIT 100`, [organization.id]).map((item) => ({
    id: item.id, seriesId: item.series_id, title: item.series_title, status: item.status, assignedAt: item.assigned_at,
  }));
  const summary = {
    teachers: count("SELECT COUNT(*) AS n FROM users WHERE org_id=? AND role='TEACHER' AND deleted_at IS NULL", [organization.id]),
    students: count("SELECT COUNT(*) AS n FROM users WHERE org_id=? AND role='STUDENT' AND deleted_at IS NULL", [organization.id]),
    activeClasses: count("SELECT COUNT(*) AS n FROM classes WHERE org_id=? AND status='ACTIVE'", [organization.id]),
    activeSessions: count(`SELECT COUNT(*) AS n FROM class_sessions session JOIN classes class ON class.id=session.class_id WHERE class.org_id=? AND session.status='ACTIVE'`, [organization.id]),
    projects: count('SELECT COUNT(*) AS n FROM student_projects WHERE org_id=? AND deleted_at IS NULL', [organization.id]),
    works: count('SELECT COUNT(*) AS n FROM works WHERE org_id=?', [organization.id]),
  };
  const audits = rows('SELECT id,action,target_type,target_id,actor_id,actor_role,ip,created_at,before_data,after_data FROM audit_logs WHERE org_id=? ORDER BY created_at DESC LIMIT 50', [organization.id]).map((item) => ({
    id: item.id, action: item.action, targetType: item.target_type, targetId: item.target_id, actorId: item.actor_id,
    actorRole: item.actor_role, ip: item.ip, createdAt: item.created_at,
    beforeData: parseJson(item.before_data, null), afterData: parseJson(item.after_data, null),
  }));
  return {
    organization: org,
    admins,
    billing: {
      balance: Number(account?.credit_balance || 0),
      frozenCredits: Number(account?.frozen_credits || 0),
      totalCreditsIn: Number(account?.total_credits_in || 0),
      totalCreditsSpent: Number(account?.total_credits_spent || 0),
    },
    packages,
    courseAssignments,
    summary,
    audits,
  };
}

export async function handleAdmin(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/admin/')) return null;
  const part = pathname.slice('/api/admin'.length) || '/';
  if (part === '/audit-logs' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const q = auditQuery(ctx);
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const total = Number(row('SELECT COUNT(*) n FROM audit_logs WHERE ' + q.where.replace(/audit\./g, ''), q.params)?.n || 0);
    const items = rows(auditListQuery(q.where) + ' LIMIT ? OFFSET ?', [...q.params, limit, (page - 1) * limit]).map(auditRow);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }
  if (part === '/audit-logs/summary' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const q = auditQuery(ctx);
    const base = 'SELECT audit.*, actor.display_name actor_name, actor.login actor_login, org.name org_name FROM audit_logs audit LEFT JOIN users actor ON actor.id=audit.actor_id LEFT JOIN organizations org ON org.id=audit.org_id WHERE ' + q.where;
    const byAction = rows('SELECT action, COUNT(*) n FROM (' + base + ') s GROUP BY action ORDER BY n DESC LIMIT 20', q.params).map((i) => ({ action: i.action, count: Number(i.n) }));
    const byActor = rows("SELECT actor_id, COALESCE(actor_name, actor_login, '系统') as actor_name, COUNT(*) n FROM (" + base + ') s GROUP BY actor_id, actor_name ORDER BY n DESC LIMIT 10', q.params).map((i) => ({ actorId: i.actor_id || null, actorName: i.actor_name, count: Number(i.n) }));
    const byOrg = rows('SELECT org_id, org_name, COUNT(*) n FROM (' + base + ') s GROUP BY org_id, org_name ORDER BY n DESC LIMIT 10', q.params).map((i) => ({ orgId: i.org_id || null, orgName: i.org_name || '平台', count: Number(i.n) }));
    const total = row('SELECT COUNT(*) n FROM audit_logs WHERE ' + q.where.replace(/audit\./g, ''), q.params);
    return { total: Number(total && total.n || 0), byAction, byActor, byOrg };
  }
  if (part === '/audit-logs/export' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const q = auditQuery(ctx);
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 2000, fallback: 500 });
    const items = rows(auditListQuery(q.where) + ' LIMIT ' + limit, q.params).map(auditRow);
    const hdr = ['时间', '操作者', '角色', '机构', '动作', '目标类型', '目标ID', '请求方法', '请求路径', 'IP', '变更前', '变更后'];
    const lines = [hdr.map(escapeCsv).join(',')];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      lines.push([item.createdAt, item.actorName, item.actorRole || '', item.orgName || '', item.action, item.targetType, item.targetId || '', item.requestMethod || '', item.requestPath || '', item.ip || '', JSON.stringify(item.before || {}), JSON.stringify(item.after || {})].map(escapeCsv).join(','));
    }
    const csv = '\ufeff' + lines.join('\r\n') + '\r\n';
    audit(ctx, 'PLATFORM_AUDIT_EXPORT', 'AUDIT_LOG', null, null, { count: items.length, filters: { orgId: ctx.search.get('orgId') || null, action: ctx.search.get('action') || null, from: ctx.search.get('from') || null, to: ctx.search.get('to') || null, actorId: ctx.search.get('actorId') || null, targetType: ctx.search.get('targetType') || null, targetId: ctx.search.get('targetId') || null } });
    return { filename: 'audit-logs-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv', content: csv, count: items.length };
  }
  if (part === '/audit-logs/actions' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const items = rows('SELECT action, COUNT(*) n FROM audit_logs GROUP BY action ORDER BY action ASC').map((i) => ({ action: i.action, count: Number(i.n) }));
    return { items, total: items.length };
  }

  if (part === '/organizations' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const search = String(ctx.search.get('search') || '').trim();
    const items = rows("SELECT * FROM organizations WHERE ?='' OR name LIKE ? ORDER BY created_at DESC LIMIT 200", [search, '%' + search + '%']).map(normalizeOrg);
    return { items, total: items.length };
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
  match = part.match(/^\/organizations\/([^/]+)\/(credit-adjustments|seat-adjustments)$/);
  if (match && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const organization = row('SELECT * FROM organizations WHERE id=?', [match[1]]);
    if (!organization) throw errors.notFound('机构不存在', 'ORG_NOT_FOUND');
    if (match[2] === 'seat-adjustments') {
      q('UPDATE organizations SET purchased_teacher_seats=?,updated_at=? WHERE id=?', [integer(ctx.body?.purchasedTeacherSeats, '购买教师席位'), nowIso(), organization.id]);
      audit(ctx, 'ORG_SEAT_ADJUST', 'ORG', organization.id, null, ctx.body); return normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [organization.id]));
    }
    const credits = Number(ctx.body?.credits);
    if (!Number.isInteger(credits) || !Number.isFinite(credits) || credits === 0) throw errors.badRequest('积分必须是非零整数', 'INVALID_CREDITS');
    ensureOrgBilling(organization.id);
    const balanceAfter = transaction(() => {
      const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [organization.id]); const balance = Number(account.credit_balance) + credits;
      if (balance < 0) throw errors.badRequest('机构积分余额不足', 'INSUFFICIENT_CREDITS');
      q('UPDATE org_billing_accounts SET credit_balance=?,total_credits_in=total_credits_in+?,updated_version=updated_version+1 WHERE org_id=?', [balance, Math.max(0, credits), organization.id]);
      q('INSERT INTO credit_entries(id,org_id,direction,type,credits,balance_after,status,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [id('credit'), organization.id, credits > 0 ? 'IN' : 'OUT', 'PLATFORM_ADJUSTMENT', Math.abs(credits), balance, 'EFFECTIVE', String(ctx.body?.reason || '平台调整').slice(0, 300), auth.user.id, nowIso()]);
      return balance;
    });
    audit(ctx, 'ORG_CREDIT_ADJUST', 'ORG', organization.id, null, ctx.body); return { balanceAfter };
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

  if (part === '/course-series' && method === 'GET') { requireRole(ctx, ['SUPER_ADMIN']); return { items: rows('SELECT * FROM course_series ORDER BY sort,title').map((item) => normalizeSeries(item, { includeLessons: true, includeAllLessons: true })) }; }
  if (part === '/course-series' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const body = ctx.body || {}; const title = String(body.title || '').trim();
    if (!title) throw errors.badRequest('课包标题不能为空', 'COURSE_TITLE_REQUIRED');
    if (title.length > 200) throw errors.badRequest('课包标题不能超过200个字符', 'VALIDATION_ERROR');
    const visibility = body.visibility || 'ALL_ORGS'; const status = body.status || 'PUBLISHED';
    if (!['ALL_ORGS', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibility)) throw errors.badRequest('课包可见范围无效', 'INVALID_VISIBILITY');
    if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) throw errors.badRequest('课包状态无效', 'INVALID_COURSE_STATUS');
    const lessons = body.lessons === undefined ? [] : body.lessons;
    if (!Array.isArray(lessons) || lessons.length > 200) throw errors.badRequest('课时列表无效', 'INVALID_LESSONS');
    // P5-W05: 课程资料核验字段校验
    const difficultyLevel = body.difficultyLevel;
    if (difficultyLevel !== undefined && difficultyLevel !== null) {
      const dl = Number(difficultyLevel);
      if (!Number.isInteger(dl) || dl < 1 || dl > 5) throw errors.badRequest('难度等级必须是 1-5 的整数', 'INVALID_DIFFICULTY');
    }
    const ageRangeMin = body.ageRangeMin !== undefined ? integer(body.ageRangeMin, '适学年龄下限', { min: 3, max: 99 }) : null;
    const ageRangeMax = body.ageRangeMax !== undefined ? integer(body.ageRangeMax, '适学年龄上限', { min: 3, max: 99 }) : null;
    if (ageRangeMin !== null && ageRangeMax !== null && ageRangeMin > ageRangeMax) throw errors.badRequest('年龄下限不能大于年龄上限', 'INVALID_AGE_RANGE');
    let tags = [];
    if (Array.isArray(body.tags)) {
      tags = body.tags.map((t) => String(t || '').trim()).filter((t) => t.length > 0 && t.length <= 50).slice(0, 20);
    } else if (typeof body.tags === 'string' && body.tags.trim()) {
      tags = body.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 50).slice(0, 20);
    }
    if (row("SELECT id FROM course_series WHERE title=? AND owner_type='PLATFORM'", [title])) throw errors.conflict('同名平台课包已存在', 'COURSE_SERIES_EXISTS');
    const seriesId = id('series'); const now = nowIso();
    transaction(() => {
      q('INSERT INTO course_series(id,title,description,cover_image_url,owner_type,org_id,visibility,version,sort,status,difficulty_level,age_range_min,age_range_max,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [seriesId, title, String(body.description || '').slice(0, 10000), body.coverImageUrl ? String(body.coverImageUrl).slice(0, 2000) : null, 'PLATFORM', null, visibility, String(body.version || '1.0').slice(0, 100), integer(body.sort, '课包排序', { min: 0, max: 100000, fallback: 0 }), status, difficultyLevel != null ? Number(difficultyLevel) : null, ageRangeMin, ageRangeMax, JSON.stringify(tags), now, now]);
      lessons.forEach((lesson, index) => {
        const lessonTitle = String(lesson?.title || '').trim();
        if (!lessonTitle) throw errors.badRequest(`第${index + 1}课标题不能为空`, 'LESSON_TITLE_REQUIRED');
        if (lessonTitle.length > 200) throw errors.badRequest(`第${index + 1}课标题不能超过200个字符`, 'VALIDATION_ERROR');
        const lessonStatus = status === 'ARCHIVED' ? 'ARCHIVED' : (lesson.status || 'PUBLISHED');
        if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(lessonStatus)) throw errors.badRequest(`第${index + 1}课状态无效`, 'INVALID_LESSON_STATUS');
        q('INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [id('lesson'), seriesId, lessonTitle, String(lesson.summary || '').slice(0, 10000), index + 1, lessonStatus, integer(lesson.durationMinutes, '课时时长', { min: 1, max: 1440, fallback: 45 }), String(lesson.lessonContent || '').slice(0, 50000), now, now]);
      });
    });
    audit(ctx, 'COURSE_SERIES_CREATE', 'COURSE_SERIES', seriesId, null, { title, lessonCount: lessons.length });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [seriesId]), { includeLessons: true, includeAllLessons: true });
  }
  let seriesDetailMatch = part.match(/^\/course-series\/([^/]+)\/detail$/);
  if (seriesDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesDetailMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const assignedOrgs = rows('SELECT assignment.id, assignment.org_id, assignment.assigned_at, organization.name org_name FROM course_assignments assignment JOIN organizations organization ON organization.id=assignment.org_id WHERE assignment.series_id=? AND assignment.status=\'ACTIVE\' ORDER BY assignment.assigned_at DESC', [series.id]).map((item) => ({ id: item.id, orgId: item.org_id, orgName: item.org_name, assignedAt: item.assigned_at }));
    const usage = {
      classesUsingSeries: count('SELECT COUNT(*) AS n FROM classes WHERE default_series_id=?', [series.id]),
      curriculumItems: count('SELECT COUNT(*) AS n FROM class_curriculum_items WHERE source_series_id=?', [series.id]),
      classSessions: count('SELECT COUNT(*) AS n FROM class_sessions session JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE lesson.series_id=?', [series.id]),
      studentWorks: count('SELECT COUNT(*) AS n FROM works work JOIN course_lessons lesson ON lesson.id=work.course_lesson_id WHERE lesson.series_id=?', [series.id]),
    };
    return { series: normalizeSeries(series, { includeLessons: true, includeAllLessons: true }), assignedOrgs, usage };
  }

  let seriesEditMatch = part.match(/^\/course-series\/([^/]+)$/);
  if (seriesEditMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesEditMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const body = ctx.body || {};
    if (body.status !== undefined) throw errors.badRequest('课包状态必须通过状态动作接口修改', 'COURSE_STATUS_ACTION_REQUIRED');
    const title = body.title === undefined ? series.title : nonEmptyString(body.title, '课包标题', { max: 200 });
    if (title !== series.title && row("SELECT id FROM course_series WHERE title=? AND owner_type='PLATFORM'", [title])) throw errors.conflict('同名平台课包已存在', 'COURSE_SERIES_EXISTS');
    const description = body.description === undefined ? series.description : String(body.description).slice(0, 10000);
    const coverImageUrl = body.coverImageUrl === undefined ? series.cover_image_url : (body.coverImageUrl ? String(body.coverImageUrl).slice(0, 2000) : null);
    if (coverImageUrl && !/^https:\/\//.test(coverImageUrl)) throw errors.badRequest('封面地址必须是 HTTPS 链接', 'INVALID_COVER_URL');
    const visibility = body.visibility === undefined ? series.visibility : body.visibility;
    if (!['ALL_ORGS', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibility)) throw errors.badRequest('课包可见范围无效', 'INVALID_VISIBILITY');
    const sort = body.sort === undefined ? series.sort : integer(body.sort, '课包排序', { min: 0, max: 100000 });
    const version = bumpSeriesVersion(series.version);
    // P5-W05: 课程资料核验字段
    const difficultyLevel = body.difficultyLevel;
    if (difficultyLevel !== undefined && difficultyLevel !== null) {
      const dl = Number(difficultyLevel);
      if (!Number.isInteger(dl) || dl < 1 || dl > 5) throw errors.badRequest('难度等级必须是 1-5 的整数', 'INVALID_DIFFICULTY');
    }
    const ageRangeMin = body.ageRangeMin === null ? null : (body.ageRangeMin !== undefined ? integer(body.ageRangeMin, '适学年龄下限', { min: 3, max: 99 }) : undefined);
    const ageRangeMax = body.ageRangeMax === null ? null : (body.ageRangeMax !== undefined ? integer(body.ageRangeMax, '适学年龄上限', { min: 3, max: 99 }) : undefined);
    if (ageRangeMin !== undefined && ageRangeMax !== undefined && ageRangeMin > ageRangeMax) throw errors.badRequest('年龄下限不能大于年龄上限', 'INVALID_AGE_RANGE');
    let tags;
    if (body.tags !== undefined) {
      if (Array.isArray(body.tags)) {
        tags = body.tags.map((t) => String(t || '').trim()).filter((t) => t.length > 0 && t.length <= 50).slice(0, 20);
      } else if (typeof body.tags === 'string') {
        tags = body.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 50).slice(0, 20);
      } else {
        tags = undefined;
      }
    }
    const before = normalizeSeries(series);
    q('UPDATE course_series SET title=?,description=?,cover_image_url=?,visibility=?,sort=?,version=?,difficulty_level=?,age_range_min=?,age_range_max=?,tags=?,updated_at=? WHERE id=?', [title, description, coverImageUrl, visibility, sort, version, difficultyLevel != null ? Number(difficultyLevel) : null, ageRangeMin, ageRangeMax, tags != null ? JSON.stringify(tags) : series.tags, nowIso(), series.id]);
    const after = normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]));
    audit(ctx, 'COURSE_SERIES_UPDATE', 'COURSE_SERIES', series.id, { difficultyLevel: before.difficultyLevel, ageRangeMin: before.ageRangeMin, ageRangeMax: before.ageRangeMax, tags: before.tags }, { difficultyLevel: difficultyLevel != null ? Number(difficultyLevel) : null, ageRangeMin, ageRangeMax, tags });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { includeLessons: true, includeAllLessons: true });
  }

  let seriesStatusMatch = part.match(/^\/course-series\/([^/]+)\/status$/);
  if (seriesStatusMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesStatusMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const action = String(ctx.body?.action || '').trim();
    const transitions = {
      publish: { to: 'PUBLISHED', from: ['DRAFT', 'ARCHIVED'], auditAction: 'COURSE_SERIES_PUBLISH', requireLessons: true },
      archive: { to: 'ARCHIVED', from: ['DRAFT', 'PUBLISHED'], auditAction: 'COURSE_SERIES_ARCHIVE' },
    };
    const transition = transitions[action];
    if (!transition) throw errors.badRequest('无效的课包状态操作', 'INVALID_COURSE_STATUS_ACTION');
    assertTransition(ctx, 'courseSeries', series.status, transition.to, {
      targetType: 'COURSE_SERIES', targetId: series.id, before: normalizeSeries(series),
      allowedFrom: transition.from, code: 'INVALID_COURSE_STATUS_TRANSITION',
      message: '当前状态 ' + series.status + ' 不允许执行 ' + action, details: { action },
    });
    if (transition.requireLessons && !row('SELECT id FROM course_lessons WHERE series_id=?', [series.id])) throw errors.badRequest('课包至少需要一个课时才能发布', 'COURSE_LESSONS_REQUIRED');
    const before = normalizeSeries(series);
    q('UPDATE course_series SET status=?,updated_at=? WHERE id=?', [transition.to, nowIso(), series.id]);
    const after = normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]));
    audit(ctx, transition.auditAction, 'COURSE_SERIES', series.id, { status: before.status }, { action, status: after.status });
    return after;
  }

  let seriesLessonsMatch = part.match(/^\/course-series\/([^/]+)\/lessons$/);
  if (seriesLessonsMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesLessonsMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const lessons = ctx.body?.lessons;
    if (!Array.isArray(lessons) || lessons.length === 0 || lessons.length > 100) throw errors.badRequest('请提交 1-100 个课时', 'INVALID_LESSONS');
    const maxSort = Number(row('SELECT MAX(sort) m FROM course_lessons WHERE series_id=?', [series.id])?.m || 0);
    const now = nowIso();
    transaction(() => {
      lessons.forEach((lesson, index) => {
        const lessonTitle = String(lesson?.title || '').trim();
        if (!lessonTitle || lessonTitle.length > 200) throw errors.badRequest('第' + (index + 1) + '课标题不能为空且不超过200字', 'LESSON_TITLE_REQUIRED');
        const lessonStatus = lesson.status || 'PUBLISHED';
        if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(lessonStatus)) throw errors.badRequest('第' + (index + 1) + '课状态无效', 'INVALID_LESSON_STATUS');
        q('INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [id('lesson'), series.id, lessonTitle, String(lesson.summary || '').slice(0, 10000), maxSort + index + 1, lessonStatus, integer(lesson.durationMinutes, '课时时长', { min: 1, max: 1440, fallback: 45 }), String(lesson.lessonContent || '').slice(0, 50000), now, now]);
      });
      q('UPDATE course_series SET version=?,updated_at=? WHERE id=?', [bumpSeriesVersion(series.version), now, series.id]);
    });
    audit(ctx, 'COURSE_LESSON_CREATE', 'COURSE_SERIES', series.id, null, { count: lessons.length, titles: lessons.map((lesson) => String(lesson?.title || '').trim()) });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { includeLessons: true, includeAllLessons: true });
  }

  let seriesReorderMatch = part.match(/^\/course-series\/([^/]+)\/lessons\/reorder$/);
  if (seriesReorderMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesReorderMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const lessonIds = Array.isArray(ctx.body?.lessonIds) ? ctx.body.lessonIds.map((value) => String(value || '').trim()).filter(Boolean) : null;
    if (!lessonIds || lessonIds.length === 0) throw errors.badRequest('请提交课时排序', 'INVALID_LESSON_IDS');
    const existing = rows('SELECT id FROM course_lessons WHERE series_id=?', [series.id]).map((item) => item.id);
    const requested = [...new Set(lessonIds)];
    if (requested.length !== lessonIds.length) throw errors.badRequest('课时标识重复', 'INVALID_LESSON_IDS');
    if (requested.length !== existing.length || requested.some((lessonId) => !existing.includes(lessonId))) throw errors.badRequest('课时列表必须与课包现有课时完全一致', 'LESSON_SET_MISMATCH');
    const now = nowIso();
    const maxSort = Number(row('SELECT MAX(sort) m FROM course_lessons WHERE series_id=?', [series.id])?.m || 0);
    transaction(() => {
      requested.forEach((lessonId, index) => {
        q('UPDATE course_lessons SET sort=?,updated_at=? WHERE id=?', [maxSort + index + 1, now, lessonId]);
      });
      requested.forEach((lessonId, index) => {
        q('UPDATE course_lessons SET sort=?,updated_at=? WHERE id=?', [index + 1, now, lessonId]);
      });
      q('UPDATE course_series SET version=?,updated_at=? WHERE id=?', [bumpSeriesVersion(series.version), now, series.id]);
    });
    audit(ctx, 'COURSE_LESSON_REORDER', 'COURSE_SERIES', series.id, null, { lessonIds: requested });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { includeLessons: true, includeAllLessons: true });
  }

  let seriesRevokeMatch = part.match(/^\/course-series\/([^/]+)\/assignments\/revoke$/);
  if (seriesRevokeMatch && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesRevokeMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const orgId = String(ctx.body?.orgId || '').trim();
    if (!orgId) throw errors.badRequest('请选择要撤销授权的机构', 'INVALID_ORG_IDS');
    const assignment = row("SELECT * FROM course_assignments WHERE series_id=? AND org_id=? AND status='ACTIVE'", [series.id, orgId]);
    if (!assignment) throw errors.notFound('该机构没有此课包的有效授权', 'ASSIGNMENT_NOT_FOUND');
    assertTransition(ctx, 'courseAssignment', assignment.status, 'REVOKED', { targetType: 'COURSE_ASSIGNMENT', targetId: assignment.id, before: { status: assignment.status, orgId }, code: 'INVALID_ASSIGNMENT_TRANSITION', message: '该课程授权当前状态不能撤销' });
    q("UPDATE course_assignments SET status='REVOKED' WHERE id=?", [assignment.id]);
    audit(ctx, 'COURSE_SERIES_ASSIGN_REVOKE', 'COURSE_SERIES', series.id, { orgId }, { orgId, status: 'REVOKED' });
    return { revoked: true, orgId };
  }

  let lessonEditMatch = part.match(/^\/course-lessons\/([^/]+)$/);
  if (lessonEditMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const lesson = row('SELECT lesson.*, series.owner_type owner_type FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id WHERE lesson.id=?', [lessonEditMatch[1]]);
    if (!lesson || lesson.owner_type !== 'PLATFORM') throw errors.notFound('平台课时不存在', 'LESSON_NOT_FOUND');
    const body = ctx.body || {};
    const title = body.title === undefined ? lesson.title : nonEmptyString(body.title, '课时标题', { max: 200 });
    const summary = body.summary === undefined ? lesson.summary : String(body.summary).slice(0, 10000);
    const durationMinutes = body.durationMinutes === undefined ? lesson.duration_minutes : integer(body.durationMinutes, '课时时长', { min: 1, max: 1440 });
    const status = body.status === undefined ? lesson.status : String(body.status).toUpperCase();
    if (body.status !== undefined) assertTransition(ctx, 'courseLesson', lesson.status, status, {
      targetType: 'COURSE_LESSON', targetId: lesson.id, before: { status: lesson.status, title: lesson.title },
      code: 'INVALID_LESSON_STATUS_TRANSITION', message: '当前课时状态不允许转换', details: { requestedStatus: status },
    });
    const lessonContent = body.lessonContent === undefined ? lesson.lesson_content : String(body.lessonContent).slice(0, 50000);
    q('UPDATE course_lessons SET title=?,summary=?,duration_minutes=?,status=?,lesson_content=?,updated_at=? WHERE id=?', [title, summary, durationMinutes, status, lessonContent, nowIso(), lesson.id]);
    q('UPDATE course_series SET version=?,updated_at=? WHERE id=?', [bumpSeriesVersion(row('SELECT version FROM course_series WHERE id=?', [lesson.series_id]).version), nowIso(), lesson.series_id]);
    audit(ctx, 'COURSE_LESSON_UPDATE', 'COURSE_LESSON', lesson.id, { title: lesson.title, status: lesson.status, durationMinutes: lesson.duration_minutes }, { title, status, durationMinutes, lessonContentChanged: body.lessonContent !== undefined && body.lessonContent !== lesson.lesson_content }, {});
    if (body.lessonContent !== undefined && body.lessonContent !== lesson.lesson_content) {
      audit(ctx, 'COURSE_LESSON_CONTENT_UPDATE', 'COURSE_LESSON', lesson.id, { lessonContent: lesson.lesson_content }, { lessonContent });
    }
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [lesson.series_id]), { includeLessons: true, includeAllLessons: true });
  }

  if (lessonEditMatch && method === 'DELETE') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const lesson = row('SELECT lesson.*, series.owner_type owner_type, series.version series_version FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id WHERE lesson.id=?', [lessonEditMatch[1]]);
    if (!lesson || lesson.owner_type !== 'PLATFORM') throw errors.notFound('平台课时不存在', 'LESSON_NOT_FOUND');
    const curriculumRefs = count('SELECT COUNT(*) AS n FROM class_curriculum_items WHERE lesson_id=?', [lesson.id]);
    const sessionRefs = count('SELECT COUNT(*) AS n FROM class_sessions WHERE lesson_id=?', [lesson.id]);
    if (curriculumRefs > 0 || sessionRefs > 0) throw errors.badRequest('该课时已被班级课单或课堂引用（课单 ' + curriculumRefs + ' 处、课堂 ' + sessionRefs + ' 处），请改为归档', 'LESSON_IN_USE');
    const now = nowIso();
    transaction(() => {
      q('DELETE FROM course_lessons WHERE id=?', [lesson.id]);
      const remaining = rows('SELECT id FROM course_lessons WHERE series_id=? ORDER BY sort, created_at', [lesson.series_id]);
      remaining.forEach((item, index) => {
        q('UPDATE course_lessons SET sort=?,updated_at=? WHERE id=?', [index + 1, now, item.id]);
      });
      q('UPDATE course_series SET version=?,updated_at=? WHERE id=?', [bumpSeriesVersion(lesson.series_version), now, lesson.series_id]);
    });
    audit(ctx, 'COURSE_LESSON_DELETE', 'COURSE_LESSON', lesson.id, { title: lesson.title }, { deleted: true, resequenced: true }, {});
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [lesson.series_id]), { includeLessons: true, includeAllLessons: true });
  }
  match = part.match(/^\/course-series\/([^/]+)\/assignments$/);
  if (match && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [match[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const requestedOrgIds = Array.isArray(ctx.body?.orgIds) ? ctx.body.orgIds : null;
    if (!requestedOrgIds || requestedOrgIds.length === 0 || requestedOrgIds.length > 500) throw errors.badRequest('请选择有效的机构', 'INVALID_ORG_IDS');
    const assignmentOrgIds = [...new Set(requestedOrgIds.map((value) => String(value || '').trim()).filter(Boolean))];
    if (assignmentOrgIds.length !== requestedOrgIds.length) throw errors.badRequest('机构标识无效或重复', 'INVALID_ORG_IDS');
    const placeholders = assignmentOrgIds.map(() => '?').join(','); const existingOrgs = rows(`SELECT id FROM organizations WHERE id IN (${placeholders})`, assignmentOrgIds);
    if (existingOrgs.length !== assignmentOrgIds.length) throw errors.badRequest('存在不存在的机构', 'ORG_NOT_FOUND');
    const now = nowIso();
    transaction(() => {
      assignmentOrgIds.forEach((assignmentOrgId) => {
        const existing = row('SELECT id FROM course_assignments WHERE series_id=? AND org_id=?', [series.id, assignmentOrgId]);
        if (existing) {
          assertTransition(ctx, 'courseAssignment', existing.status, 'ACTIVE', { targetType: 'COURSE_ASSIGNMENT', targetId: existing.id, before: { status: existing.status, orgId: assignmentOrgId }, allowSameState: true, code: 'INVALID_ASSIGNMENT_TRANSITION', message: '该课程授权当前状态不能启用' });
          q("UPDATE course_assignments SET status='ACTIVE',assigned_by=?,assigned_at=? WHERE id=?", [auth.user.id, now, existing.id]);
        }
        else q("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at) VALUES (?,?,?,?,?,?)", [id('assign'), series.id, assignmentOrgId, 'ACTIVE', auth.user.id, now]);
      });
    });
    audit(ctx, 'COURSE_SERIES_ASSIGN', 'COURSE_SERIES', series.id, null, { orgIds: assignmentOrgIds });
    return { assignedCount: assignmentOrgIds.length };
  }

  // P5-M01: Marketplace management endpoints
  if (part === '/course-marketplace' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const statusFilter = String(ctx.search.get('marketplaceStatus') || ctx.search.get('status') || '').trim().toUpperCase();
    const search = String(ctx.search.get('search') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const offset = (page - 1) * limit;
    const wheres = ["series.status='PUBLISHED'"];
    const params = [];
    if (['PENDING', 'APPROVED', 'REJECTED', 'NONE'].includes(statusFilter)) { wheres.push('series.marketplace_status=?'); params.push(statusFilter); }
    if (search) { wheres.push('series.title LIKE ?'); params.push('%' + search.replace(/[%_]/g, (c) => '[' + c + ']') + '%'); }
    const where = wheres.join(' AND ');
    const total = Number(row('SELECT COUNT(*) n FROM course_series series WHERE ' + where, params)?.n || 0);
    const items = rows(
      `SELECT series.* FROM course_series series WHERE ${where}
       ORDER BY CASE series.marketplace_status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'REJECTED' THEN 2 ELSE 3 END, series.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((item) => {
      const normalized = normalizeSeries(item, { parseTags: true });
      return {
        id: normalized.id,
        title: normalized.title,
        difficultyLevel: normalized.difficultyLevel,
        ageRangeMin: normalized.ageRangeMin,
        ageRangeMax: normalized.ageRangeMax,
        tags: normalized.tags,
        status: normalized.status,
        marketplaceStatus: normalized.marketplaceStatus,
        marketplaceRewardCredits: normalized.marketplaceRewardCredits,
        visibility: normalized.visibility,
        createdAt: normalized.createdAt,
      };
    });
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  const marketplaceDetailMatch = part.match(/^\/course-marketplace\/([^/]+)$/);
  if (marketplaceDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=?", [marketplaceDetailMatch[1]]);
    if (!series) throw errors.notFound('课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const detail = normalizeSeries(series, { includeLessons: true, includeAllLessons: true, parseTags: true });
    return {
      ...detail,
      marketplaceStatus: detail.marketplaceStatus,
      marketplaceRewardCredits: detail.marketplaceRewardCredits,
      lessonTitles: (detail.lessons || []).map((l) => ({ id: l.id, title: l.title, sort: l.sort })),
    };
  }

  if (marketplaceDetailMatch && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=?", [marketplaceDetailMatch[1]]);
    if (!series) throw errors.notFound('课包不存在', 'COURSE_SERIES_NOT_FOUND');
    if (series.status !== 'PUBLISHED') throw errors.badRequest('仅已发布课包可变更应用市场状态', 'COURSE_NOT_PUBLISHED');
    const body = ctx.body || {};
    const newStatus = body.marketplaceStatus === undefined ? series.marketplace_status : body.marketplaceStatus;
    if (!['PENDING', 'APPROVED', 'REJECTED', 'NONE'].includes(newStatus)) throw errors.badRequest('应用市场状态无效', 'INVALID_MARKETPLACE_STATUS');
    const newCredits = body.marketplaceRewardCredits === undefined ? Number(series.marketplace_reward_credits || 0) : integer(body.marketplaceRewardCredits, '积分激励', { min: 0, max: 999999 });
    const before = normalizeSeries(series, { parseTags: true });
    q('UPDATE course_series SET marketplace_status=?,marketplace_reward_credits=?,updated_at=? WHERE id=?', [newStatus, newCredits, nowIso(), series.id]);
    const after = normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { parseTags: true });
    audit(ctx, 'COURSE_SERIES_MARKETPLACE_UPDATE', 'COURSE_SERIES', series.id, { marketplaceStatus: before.marketplaceStatus, marketplaceRewardCredits: before.marketplaceRewardCredits }, { marketplaceStatus: after.marketplaceStatus, marketplaceRewardCredits: after.marketplaceRewardCredits });
    return after;
  }

  const marketplaceRewardsMatch = part.match(/^\/course-marketplace\/([^/]+)\/rewards$/);
  if (marketplaceRewardsMatch && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=?", [marketplaceRewardsMatch[1]]);
    if (!series) throw errors.notFound('课包不存在', 'COURSE_SERIES_NOT_FOUND');
    if (series.status !== 'PUBLISHED') throw errors.badRequest('仅已发布课包可调整积分激励', 'COURSE_NOT_PUBLISHED');
    const body = ctx.body || {};
    const newCredits = integer(body.marketplaceRewardCredits, '积分激励', { min: 0, max: 999999 });
    const before = normalizeSeries(series, { parseTags: true });
    q('UPDATE course_series SET marketplace_reward_credits=?,updated_at=? WHERE id=?', [newCredits, nowIso(), series.id]);
    const after = normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { parseTags: true });
    audit(ctx, 'COURSE_SERIES_MARKETPLACE_REWARD_UPDATE', 'COURSE_SERIES', series.id, { marketplaceRewardCredits: before.marketplaceRewardCredits }, { marketplaceRewardCredits: after.marketplaceRewardCredits });
    return after;
  }

  if (part === '/platform-users' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const role = ctx.search.get('role'); const orgIdFilter = ctx.search.get('orgId'); const search = String(ctx.search.get('search') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const params = []; const conditions = ['user.deleted_at IS NULL'];
    if (['SUPER_ADMIN', 'ORG_ADMIN', 'TEACHER', 'STUDENT'].includes(role)) { conditions.push('user.role=?'); params.push(role); }
    if (orgIdFilter) { conditions.push('user.org_id=?'); params.push(orgIdFilter); }
    if (search) { conditions.push('(user.login LIKE ? OR user.display_name LIKE ? OR user.phone LIKE ?)'); const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; params.push(keyword, keyword, keyword); }
    const where = conditions.join(' AND ');
    const total = Number(row('SELECT COUNT(*) n FROM users user WHERE ' + where, params)?.n || 0);
    const items = rows(
      'SELECT user.*, organization.name organization_name, billing_package.name billing_package_name FROM users user LEFT JOIN organizations organization ON organization.id=user.org_id LEFT JOIN billing_packages billing_package ON billing_package.id=user.billing_package_id WHERE ' + where + ' ORDER BY user.created_at DESC, user.id DESC LIMIT ? OFFSET ?',
      [...params, limit, (page - 1) * limit],
    ).map(platformUserRow);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }
  const platformUserMatch = part.match(/^\/platform-users\/([^/]+)\/(status|password|phone)$/);
  if (platformUserMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const target = row('SELECT * FROM users WHERE id=? AND deleted_at IS NULL', [platformUserMatch[1]]);
    if (!target) throw errors.notFound('用户不存在', 'USER_NOT_FOUND');
    const body = ctx.body || {}; const now = nowIso();
    const targetWithJoins = 'SELECT user.*, organization.name organization_name, billing_package.name billing_package_name FROM users user LEFT JOIN organizations organization ON organization.id=user.org_id LEFT JOIN billing_packages billing_package ON billing_package.id=user.billing_package_id WHERE user.id=?';
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
  if (part === '/platform-admins' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const search = String(ctx.search.get('search') || '').trim();
    const statusFilter = String(ctx.search.get('status') || '').trim();
    const params = []; const conditions = ["user.role='SUPER_ADMIN'", 'user.deleted_at IS NULL'];
    if (search) { conditions.push('(user.login LIKE ? OR user.display_name LIKE ?)'); const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; params.push(keyword, keyword); }
    if (['ACTIVE', 'DISABLED'].includes(statusFilter)) { conditions.push('user.status=?'); params.push(statusFilter); }
    const adminUsers = rows('SELECT user.* FROM users user WHERE ' + conditions.join(' AND ') + ' ORDER BY user.created_at DESC LIMIT 200', params);
    const meta = userLoginMeta(adminUsers.map((item) => item.id));
    const items = adminUsers.map((item) => ({ ...normalizeUser(item, { includeAuthMeta: true }), lastLoginAt: meta.get(item.id)?.lastLoginAt || null, activeSessions: meta.get(item.id)?.activeSessions || 0 }));
    return { items, total: items.length };
  }
  if (part === '/platform-admins' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const body = ctx.body || {};
    const login = String(body.login || '').trim(); const displayName = String(body.displayName || '').trim(); const password = String(body.password || '');
    if (!login || !displayName || password.length < 6) throw errors.badRequest('登录名、姓名不能为空且密码至少6位', 'ADMIN_INPUT_REQUIRED');
    if (row('SELECT id FROM users WHERE login=?', [login])) throw errors.conflict('登录名已存在', 'LOGIN_EXISTS');
    const permissions = platformAdminPermissions(body.permissions); const adminId = id('user'); const now = nowIso();
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
    const permissions = body.permissions === undefined ? parseJson(target.permissions, []) : platformAdminPermissions(body.permissions);
    if (!Array.isArray(permissions) || permissions.some((item) => !PLATFORM_ADMIN_PERMISSIONS.has(item))) throw errors.badRequest('包含无效的平台权限码', 'INVALID_ADMIN_PERMISSION');
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

  if (part === '/dashboard/overview' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const orgFilter = String(ctx.search.get('orgId') || '').trim();
    const fromProvided = ctx.search.has('from'); const from = fromProvided ? String(ctx.search.get('from') || '').trim() : '';
    const toProvided = ctx.search.has('to'); const to = toProvided ? String(ctx.search.get('to') || '').trim() : '';
    if (orgFilter && !row('SELECT id FROM organizations WHERE id=?', [orgFilter])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    const fromTime = from ? new Date(from) : null;
    const toTime = to ? new Date(to) : null;
    if (fromProvided && (!from || !fromTime || Number.isNaN(fromTime.getTime()) || fromTime.toISOString() !== from)) throw errors.badRequest('开始时间必须是有效 ISO 时间', 'INVALID_FROM');
    if (toProvided && (!to || !toTime || Number.isNaN(toTime.getTime()) || toTime.toISOString() !== to)) throw errors.badRequest('结束时间必须是有效 ISO 时间', 'INVALID_TO');
    if (fromTime && toTime && fromTime >= toTime) throw errors.badRequest('开始时间必须早于结束时间', 'INVALID_TIME_RANGE');
    const upperTime = toTime || new Date();
    const lowerTime = fromTime || new Date(upperTime.getTime() - 29 * 86400000);
    const since = lowerTime.toISOString();
    const until = upperTime.toISOString();
    const scoped = (table) => {
      const conditions = [`${table}.created_at>=?`, `${table}.created_at<?`];
      const params = [since, until];
      if (orgFilter) { conditions.push(`${table}.org_id=?`); params.push(orgFilter); }
      return { where: conditions.join(' AND '), params };
    };
    const singleNumber = (sql, params = []) => Number(row(sql, params)?.n || 0);
    const organizations = singleNumber("SELECT COUNT(*) n FROM organizations WHERE (?='' OR id=?)", [orgFilter, orgFilter]);
    const activeOrganizations = singleNumber("SELECT COUNT(*) n FROM organizations WHERE (?='' OR id=?) AND status IN ('TRIAL','ACTIVE')", [orgFilter, orgFilter]);
    const orgScope = orgFilter ? rows('SELECT id,name,status FROM organizations WHERE id=?', [orgFilter]) : rows('SELECT id,name,status FROM organizations');
    const orgIds = orgScope.map((item) => item.id);
    const usersScope = orgFilter ? "org_id=?" : "org_id IS NOT NULL";
    const usersParams = orgFilter ? [orgFilter] : [];
    const teachers = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='TEACHER' AND deleted_at IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>?)`, [...usersParams, nowIso()]);
    const students = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='STUDENT' AND deleted_at IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>?)`, [...usersParams, nowIso()]);
    const admins = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='ORG_ADMIN' AND deleted_at IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>?)`, [...usersParams, nowIso()]);
    const classes = singleNumber(`SELECT COUNT(*) n FROM classes WHERE (?='' OR org_id=?) AND status='ACTIVE'`, [orgFilter, orgFilter]);
    const publishedCourses = singleNumber(`SELECT COUNT(*) n FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED'`);
    const activeAssignments = singleNumber(`SELECT COUNT(*) n FROM course_assignments WHERE status='ACTIVE' AND (?='' OR org_id=?)`, [orgFilter, orgFilter]);
    const marketplaceCourses = singleNumber(`SELECT COUNT(*) n FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED' AND marketplace_status='APPROVED'`);
    const classSessions = singleNumber(`SELECT COUNT(*) n FROM class_sessions session JOIN classes class ON class.id=session.class_id WHERE (LENGTH(?)=0 OR class.org_id=?) AND session.started_at>=? AND session.started_at<?`, [orgFilter, orgFilter, since, until]);
    const projects = singleNumber(`SELECT COUNT(*) n FROM student_projects WHERE (?='' OR org_id=?) AND created_at>=? AND created_at<?`, [orgFilter, orgFilter, since, until]);
    const works = singleNumber(`SELECT COUNT(*) n FROM works WHERE (?='' OR org_id=?) AND submitted_at>=? AND submitted_at<?`, [orgFilter, orgFilter, since, until]);
    const usage = scoped('usage_records');
    const usageTotal = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where}`, usage.params);
    const usageSuccess = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='SUCCESS'`, usage.params);
    const usageFailed = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='FAILED'`, usage.params);
    const usageBlocked = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='BLOCKED'`, usage.params);
    const abnormalTasks = usageFailed + usageBlocked;
    const creditsSpent = singleNumber(`SELECT COALESCE(SUM(credits_charged),0) n FROM usage_records WHERE ${usage.where}`, usage.params);
    const aiTasks = singleNumber(`SELECT COUNT(*) n FROM generation_jobs WHERE ${scoped('generation_jobs').where}`, scoped('generation_jobs').params);
    const account = orgIds.length ? singleNumber(`SELECT COALESCE(SUM(credit_balance),0) n FROM org_billing_accounts WHERE org_id IN (${orgIds.map(() => '?').join(',')})`, orgIds) : 0;
    const frozenCredits = orgIds.length ? singleNumber(`SELECT COALESCE(SUM(frozen_credits),0) n FROM org_billing_accounts WHERE org_id IN (${orgIds.map(() => '?').join(',')})`, orgIds) : 0;
    const byOrg = rows(`SELECT organization.id,organization.name,COALESCE(SUM(usage.credits_charged),0) credits,COUNT(usage.id) calls
      FROM organizations organization LEFT JOIN usage_records usage ON usage.org_id=organization.id AND usage.created_at>=? AND usage.created_at<?
      ${orgFilter ? 'WHERE organization.id=?' : ''} GROUP BY organization.id ORDER BY credits DESC,organization.name ASC LIMIT 10`, orgFilter ? [since, until, orgFilter] : [since, until]).map((item) => ({ id: item.id, name: item.name, credits: Number(item.credits || 0), calls: Number(item.calls || 0) }));
    const byModality = rows(`SELECT modality,COUNT(*) calls,COALESCE(SUM(credits_charged),0) credits,COUNT(CASE WHEN status='SUCCESS' THEN 1 END) successCalls,COUNT(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 END) abnormalCalls
      FROM usage_records WHERE ${usage.where} GROUP BY modality ORDER BY credits DESC,modality ASC`, usage.params).map((item) => ({ modality: item.modality, calls: Number(item.calls || 0), credits: Number(item.credits || 0), successCalls: Number(item.success_calls ?? item.successCalls ?? 0), abnormalCalls: Number(item.abnormal_calls ?? item.abnormalCalls ?? 0) }));
    return {
      metrics: {
        organizations, activeOrganizations, admins, teachers, students,
        publishedCourses, activeAssignments, activeClasses: classes, classSessions, projects, works,
        aiTasks, abnormalTasks, usageCalls: usageTotal, successfulCalls: usageSuccess, failedCalls: usageFailed, blockedCalls: usageBlocked,
        creditsSpent, creditBalance: account, frozenCredits,
      },
      byOrg, byModality,
      filters: { orgId: orgFilter || null, from: since, to: until },
      meta: {
        generatedAt: nowIso(), timezone: 'UTC', dataSource: 'local SQLite', version: 'P4-A01',
        metricDefinitions: {
          organizations: '机构总数；orgId 筛选后为 1。',
          activeOrganizations: "状态为 TRIAL 或 ACTIVE 的机构，不含 FROZEN/DISABLED/EXPIRED。",
          admins: '未删除、未禁用且未过期的机构管理员数量。',
          teachers: '未删除、未禁用且未过期的机构教师数量。',
          students: '未删除、未禁用且未过期的机构学生数量。',
          publishedCourses: '平台已发布课程系列数；不受机构筛选影响。',
          activeAssignments: 'ACTIVE 状态课程授权数。',
          activeClasses: 'ACTIVE 状态班级数，为存量口径。',
          classSessions: '查询时间内启动的课堂场次。',
          projects: '查询时间内创建的项目数。',
          works: '查询时间内提交的作品数。',
          aiTasks: '查询时间内创建的生成任务数。',
          abnormalTasks: '查询时间内 usage_records 中状态为 FAILED 或 BLOCKED 的调用次数。',
          creditsSpent: '查询时间内 usage_records.credits_charged 求和。',
          creditBalance: '机构账面积分余额，含冻结；为筛选范围当前存量。',
          frozenCredits: '机构冻结积分，为筛选范围当前存量。',
        },
        boundary: 'from/to 均为左闭右开 UTC ISO 时间；未传时默认最近 30 天；机构与用户统计不按时间过滤。',
      },
    };
  }
  if (part === '/billing/usage-overview' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { totalCredits: Number(row('SELECT COALESCE(SUM(credit_balance),0) n FROM org_billing_accounts').n || 0), usage: rows('SELECT modality,SUM(credits_charged) credits,COUNT(*) calls FROM usage_records GROUP BY modality'), topOrgs: rows('SELECT organization.id,organization.name,COALESCE(SUM(usage.credits_charged),0) credits FROM organizations organization LEFT JOIN usage_records usage ON usage.org_id=organization.id GROUP BY organization.id ORDER BY credits DESC LIMIT 10') };
  }
  if (part === '/billing/usage-records' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const orgFilter = ctx.search.get('orgId'); const modality = ctx.search.get('modality'); const status = ctx.search.get('status'); const search = String(ctx.search.get('search') || '').trim();
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const conditions = ['usage.created_at>=?']; const params = [since];
    if (orgFilter) { conditions.push('usage.org_id=?'); params.push(orgFilter); }
    if (modality) { conditions.push('usage.modality=?'); params.push(modality); }
    if (['SUCCESS', 'FAILED', 'BLOCKED'].includes(status)) { conditions.push('usage.status=?'); params.push(status); }
    if (search) {
      conditions.push('(organization.name LIKE ? OR user.login LIKE ? OR user.display_name LIKE ? OR project.title LIKE ? OR work.title LIKE ?)');
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      params.push(keyword, keyword, keyword, keyword, keyword);
    }
    const items = rows(
      'SELECT usage.*,organization.name organization_name,user.login user_login,user.display_name user_name,project.title project_title,work.title work_title,session.id session_id,session.lesson_id session_lesson_id,class.id class_id,class.name class_name FROM usage_records usage JOIN organizations organization ON organization.id=usage.org_id LEFT JOIN users user ON user.id=usage.user_id AND user.org_id=usage.org_id LEFT JOIN student_projects project ON project.id=usage.project_id LEFT JOIN works work ON work.id=usage.work_id LEFT JOIN class_sessions session ON session.id=usage.class_session_id LEFT JOIN classes class ON class.id=session.class_id WHERE ' + conditions.join(' AND ') + ' ORDER BY usage.created_at DESC LIMIT 200',
      params,
    ).map((item) => ({
      id: item.id, orgId: item.org_id, organizationName: item.organization_name || null,
      userId: item.user_id, userLogin: item.user_login || null, userName: item.user_name || null,
      classSessionId: item.class_session_id || null, classId: item.class_id || null, className: item.class_name || null,
      lessonId: item.session_lesson_id || null, projectId: item.project_id || null, projectTitle: item.project_title || null,
      workId: item.work_id || null, workTitle: item.work_title || null, modality: item.modality, model: item.model,
      credits: Number(item.credits_charged || 0), inputTokens: Number(item.input_tokens || 0), outputTokens: Number(item.output_tokens || 0),
      status: item.status, failCode: item.fail_code || null, createdAt: item.created_at,
    }));
    return { items, total: items.length };
  }
  if (part === '/works' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const status = ctx.search.get('status'); const orgFilter = ctx.search.get('orgId'); const search = String(ctx.search.get('search') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const sortKey = String(ctx.search.get('sort') || 'featured').trim();
    const sort = Object.hasOwn({ featured: true, submitted: true, title: true }, sortKey) ? sortKey : 'featured';
    const sortSql = { featured: 'work.featured_at DESC, work.submitted_at DESC, work.id DESC', submitted: 'work.submitted_at DESC, work.id DESC', title: 'work.title COLLATE NOCASE ASC, work.id DESC' }[sort];
    const conditions = []; const params = [];
    if (['PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED'].includes(status)) { conditions.push('work.status=?'); params.push(status); }
    if (orgFilter) { conditions.push('work.org_id=?'); params.push(orgFilter); }
    if (search) {
      conditions.push('(work.title LIKE ? OR student.display_name LIKE ? OR organization.name LIKE ?)');
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      params.push(keyword, keyword, keyword);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = Number(row('SELECT COUNT(*) n FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN organizations organization ON organization.id=work.org_id' + where, params)?.n || 0);
    const items = rows(
      `SELECT work.*,student.display_name student_name,organization.name organization_name,class.name class_name,lesson.title lesson_title,reviewer.display_name reviewer_name,COALESCE((SELECT COUNT(1) FROM work_reports report WHERE report.work_id=work.id AND report.status='PENDING'),0) pending_report_count FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN organizations organization ON organization.id=work.org_id LEFT JOIN classes class ON class.id=work.class_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by${where} ORDER BY ${sortSql} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    ).map((work) => ({ ...normalizeWork(work), organizationName: work.organization_name || null, pendingReportCount: Number(work.pending_report_count || 0) }));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  let platformWorkMatch = part.match(/^\/works\/([^/]+)\/unpublish$/);
  if (platformWorkMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const work = row('SELECT * FROM works WHERE id=?', [platformWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
    assertTransition(ctx, 'work', work.status, 'REJECTED', { targetType: 'WORK', targetId: work.id, before: normalizeWork(work), allowedFrom: ['PUBLISHED'], code: 'INVALID_WORK_TRANSITION', message: '仅已发布作品可以下架', details: { action: 'unpublish' } });
    const reason = String(ctx.body?.reason || '').trim();
    if (!reason) throw errors.badRequest('请填写下架原因', 'WORK_UNPUBLISH_REASON_REQUIRED');
    if (reason.length > 2000) throw errors.badRequest('下架原因不能超过 2000 个字符', 'WORK_UNPUBLISH_REASON_TOO_LONG');
    q('UPDATE works SET status=?,teacher_comment=?,reviewed_by=?,reviewed_at=?,featured_at=NULL,featured_by=NULL,featured_reason=NULL WHERE id=?', ['REJECTED', reason, auth.user.id, nowIso(), work.id]);
    audit(ctx, 'PLATFORM_WORK_UNPUBLISH', 'WORK', work.id, normalizeWork(work), { status: 'REJECTED', reason }, { orgId: work.org_id });
    const updated = row('SELECT work.*,student.display_name student_name,organization.name organization_name,class.name class_name,lesson.title lesson_title,reviewer.display_name reviewer_name FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN organizations organization ON organization.id=work.org_id LEFT JOIN classes class ON class.id=work.class_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by WHERE work.id=?', [work.id]);
    return { ...normalizeWork(updated), organizationName: updated.organization_name || null };
  }
  platformWorkMatch = part.match(/^\/works\/([^/]+)\/feature$/);
  if (platformWorkMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const work = row('SELECT work.*, student.privacy_allow_feature AS student_allow_feature FROM works work JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id WHERE work.id=?', [platformWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
    if (!Object.hasOwn(ctx.body || {}, 'featured') || typeof ctx.body.featured !== 'boolean') throw errors.badRequest('请选择是否设为精选', 'WORK_FEATURED_REQUIRED');
    const featured = ctx.body.featured;
    if (featured && work.status !== 'PUBLISHED') throw errors.conflict('仅已发布作品可以设为精选', 'WORK_NOT_PUBLISHED');
    if (featured && !work.student_allow_feature) throw errors.forbidden('该学生已关闭精选展示授权', 'STUDENT_FEATURE_OPT_OUT');
    const reason = featured ? String(ctx.body?.reason || '').trim().slice(0, 500) : null;
    q('UPDATE works SET featured_at=?,featured_by=?,featured_reason=? WHERE id=?', [featured ? nowIso() : null, featured ? auth.user.id : null, reason || null, work.id]);
    audit(ctx, featured ? 'PLATFORM_WORK_FEATURE' : 'PLATFORM_WORK_UNFEATURE', 'WORK', work.id, normalizeWork(work), { featured, reason: reason || null }, { orgId: work.org_id });
    return normalizeWork(row('SELECT * FROM works WHERE id=?', [work.id]));
  }
  if (part === '/work-reports' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const status = ctx.search.get('status'); const orgFilter = ctx.search.get('orgId');
    const conditions = ['1=1']; const params = [];
    if (['PENDING', 'RESOLVED', 'DISMISSED'].includes(status)) { conditions.push('report.status=?'); params.push(status); }
    if (orgFilter) { conditions.push('report.org_id=?'); params.push(orgFilter); }
    const items = workReportRows(conditions.join(' AND '), params);
    return { items, total: items.length, pending: items.filter((item) => item.status === 'PENDING').length };
  }
  let platformReportMatch = part.match(/^\/work-reports\/([^/]+)$/);
  if (platformReportMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const report = row('SELECT * FROM work_reports WHERE id=?', [platformReportMatch[1]]);
    if (!report) throw errors.notFound('举报记录不存在', 'WORK_REPORT_NOT_FOUND');
    if (report.status !== 'PENDING') throw errors.conflict('举报已处理，不能重复处理', 'WORK_REPORT_ALREADY_HANDLED');
    const status = ctx.body?.status;
    if (!['RESOLVED', 'DISMISSED'].includes(status)) throw errors.badRequest('举报处理状态无效', 'INVALID_WORK_REPORT_STATUS');
    const actionTaken = ctx.body?.actionTaken || 'NONE';
    if (!['NONE', 'UNPUBLISH'].includes(actionTaken)) throw errors.badRequest('举报处理动作无效', 'INVALID_WORK_REPORT_ACTION');
    const resolution = reportResolution(ctx.body); const work = row('SELECT * FROM works WHERE id=? AND org_id=?', [report.work_id, report.org_id]);
    if (!work) throw errors.notFound('关联作品不存在', 'WORK_NOT_FOUND');
    if (actionTaken === 'UNPUBLISH' && work.status !== 'PUBLISHED') throw errors.conflict('仅已发布作品可因举报下架', 'WORK_NOT_PUBLISHED');
    const now = nowIso();
    transaction(() => {
      if (actionTaken === 'UNPUBLISH') q('UPDATE works SET status=?,teacher_comment=?,reviewed_by=?,reviewed_at=?,featured_at=NULL,featured_by=NULL,featured_reason=NULL WHERE id=?', ['REJECTED', resolution, auth.user.id, now, work.id]);
      q('UPDATE work_reports SET status=?,handled_by=?,handled_at=?,resolution=?,action_taken=? WHERE id=?', [status, auth.user.id, now, resolution, actionTaken, report.id]);
    });
    audit(ctx, 'PLATFORM_WORK_REPORT_HANDLE', 'WORK_REPORT', report.id, normalizeWorkReport(report), { status, actionTaken, resolution }, { orgId: report.org_id });
    if (actionTaken === 'UNPUBLISH') audit(ctx, 'PLATFORM_WORK_UNPUBLISH_REPORT', 'WORK', work.id, normalizeWork(work), { status: 'REJECTED', reportId: report.id }, { orgId: work.org_id });
    return workReportRows('report.id=?', [report.id])[0];
  }
  let workDetailMatch = part.match(/^\/works\/([^/]+)\/detail$/);
  if (workDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const workId = workDetailMatch[1];
    const workRow = row(
      `SELECT work.*,
              student.id AS student_id, student.login AS student_login, student.display_name AS student_name,
              student.privacy_allow_feature AS student_allow_feature,
              student.privacy_showcase_anonymous AS student_showcase_anonymous,
              reviewer.display_name AS reviewer_name,
              organization.id AS org_id, organization.name AS organization_name,
              class.id AS class_id, class.name AS class_name,
              lesson.id AS course_lesson_id, lesson.title AS course_lesson_title
       FROM works work
       JOIN users student ON student.id=work.student_id
       LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by
       LEFT JOIN organizations organization ON organization.id=work.org_id
       LEFT JOIN classes class ON class.id=work.class_id
       LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id
       WHERE work.id=?`,
      [workId],
    );
    if (!workRow) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');

    const submissions = rows(
      `SELECT s.*
       FROM work_submissions s
       WHERE s.work_id=? ORDER BY s.round DESC LIMIT 10`,
      [workId],
    ).map((s) => ({
      id: s.id, round: s.round, title: s.title, description: s.description || '',
      reviewStatus: s.review_status || null, reviewComment: s.review_comment || null,
      reviewerName: null, reviewedAt: s.reviewed_at || null,
      submittedAt: s.submitted_at,
    }));

    const annotations = rows(
      `SELECT a.*, author.display_name AS author_name
       FROM work_annotations a
       JOIN users author ON author.id=a.author_id
       WHERE a.work_id=? ORDER BY a.created_at DESC LIMIT 5`,
      [workId],
    ).map((a) => ({
      id: a.id, nodeId: a.node_id || null, content: a.content,
      authorName: a.author_name, createdAt: a.created_at,
      resolvedAt: a.resolved_at || null, resolvedBy: a.resolved_by || null,
    }));

    const reports = rows(
      `SELECT report.*, reporter.display_name AS reporter_name, handler.display_name AS handler_name
       FROM work_reports report
       JOIN users reporter ON reporter.id=report.reporter_id
       LEFT JOIN users handler ON handler.id=report.handled_by
       WHERE report.work_id=? ORDER BY report.created_at DESC`,
      [workId],
    ).map((r) => ({
      id: r.id, category: r.category, details: r.details || '',
      status: r.status, resolution: r.resolution || null, actionTaken: r.action_taken || 'NONE',
      reporterName: r.reporter_name, handlerName: r.handler_name || null,
      handledAt: r.handled_at || null, createdAt: r.created_at,
    }));

    const latestPublishRequest = row(
      `SELECT pr.*, handler.display_name AS handler_name
       FROM work_publish_requests pr
       LEFT JOIN users handler ON handler.id=pr.resolved_by
       WHERE pr.work_id=? ORDER BY pr.requested_at DESC LIMIT 1`,
      [workId],
    );

    return {
      ...normalizeWork(workRow, { includeSnapshot: true }),
      studentLogin: workRow.student_login,
      studentAllowFeature: Boolean(workRow.student_allow_feature),
      studentShowcaseAnonymous: Boolean(workRow.student_showcase_anonymous),
      organizationName: workRow.organization_name || null,
      courseLessonTitle: workRow.course_lesson_title || null,
      pendingReportCount: reports.filter((r) => r.status === 'PENDING').length,
      submissions,
      annotations,
      annotationCount: Number(
        row('SELECT COUNT(*) AS n FROM work_annotations WHERE work_id=?', [workId])?.n || 0,
      ),
      reports,
      latestPublishRequest: latestPublishRequest ? normalizeWorkPublishRequest(latestPublishRequest) : null,
    };
  }
  return null;
}

export async function handleOrg(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/org/')) return null;
  // /api/org/file-assets 由独立路由处理（含 STUDENT 角色）
  if (pathname.startsWith('/api/org/file-assets')) return null;
  const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER']); const currentOrgId = orgId(auth); const part = pathname.slice('/api/org'.length);
  if (part === '/work-data' && method === 'GET') {
    return buildWorkData(ctx, auth, currentOrgId);
  }
  if (part === '/work-data/export' && method === 'GET') {
    const data = buildWorkData(ctx, auth, currentOrgId);
    const items = data.breakdowns.students
      .filter((item) => item.activeProjectCount || item.completedProjectCount || item.submittedWorkCount || item.publishedWorkCount || item.feedbackCount || item.aiCallCount)
      .map((item) => ({
        studentAlias: maskedStudentName(item.studentName),
        activeProjects: item.activeProjectCount, completedProjects: item.completedProjectCount,
        submittedWorks: item.submittedWorkCount, publishedWorks: item.publishedWorkCount,
        feedbackCount: item.feedbackCount, aiCalls: item.aiCallCount, aiCredits: item.aiCredits,
      }));
    audit(ctx, 'ORG_WORK_DATA_EXPORT', 'WORK_DATA', currentOrgId, null, {
      days: data.scope.days, classId: data.scope.classId, lessonId: data.scope.lessonId, studentId: data.scope.studentId, rowCount: items.length,
    }, { orgId: currentOrgId });
    return {
      fileName: '作品数据中心-近' + data.scope.days + '日-脱敏学员汇总.csv',
      columns: [
        { key: 'studentAlias', label: '学员（脱敏）' }, { key: 'activeProjects', label: '活跃项目' },
        { key: 'completedProjects', label: '完成项目' }, { key: 'submittedWorks', label: '提交作品' },
        { key: 'publishedWorks', label: '已发布作品' }, { key: 'feedbackCount', label: '教师反馈' },
        { key: 'aiCalls', label: '成功 AI 调用' }, { key: 'aiCredits', label: 'AI 消耗积分' },
      ],
      items,
    };
  }
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
    if (!hasPermission(auth, 'MANAGE_MEMBERS')) throw errors.forbidden('无账号管理权限', 'ORG_MEMBER_PERMISSION_REQUIRED');
    const role = ctx.search.get('role'); const search = String(ctx.search.get('search') || '').trim(); const params = [currentOrgId]; let where = 'org_id=? AND deleted_at IS NULL';
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
      classIds,
    }));
    audit(ctx, 'USER_CREATE', 'USER', created.id, null, { role, login, classIds });
    return orgMemberRow(created, currentOrgId);
  }  let match = part.match(/^\/users\/([^/]+)$/);
  if (match && ['GET','PUT','DELETE'].includes(method)) {
    if (!hasPermission(auth, 'MANAGE_MEMBERS')) throw errors.forbidden('无账号管理权限', 'ORG_MEMBER_PERMISSION_REQUIRED'); const target = orgUser(auth, match[1]); if (method === 'GET') return normalizeUser(target, { includeAuthMeta: true });
    if (method === 'DELETE') {
      const now = nowIso();
      assertTransition(ctx, 'user', target.status, 'DISABLED', { targetType: 'USER', targetId: target.id, before: target });
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
    transaction(() => { q('UPDATE users SET display_name=?,phone=?,permissions=?,status=?,student_usage_scope=?,billing_package_id=?,monthly_credit_allowance=?,updated_at=? WHERE id=? AND org_id=?', [displayName, phone, json(permissions), nextStatus, usageScope, body.billingPackageId === undefined ? target.billing_package_id : body.billingPackageId, body.monthlyCreditAllowance === undefined ? target.monthly_credit_allowance : integer(body.monthlyCreditAllowance, '月度积分'), now, target.id, currentOrgId]); if (nextStatus === 'DISABLED') q('UPDATE sessions SET superseded_at=COALESCE(superseded_at,?) WHERE user_id=? AND superseded_at IS NULL', [now, target.id]); });
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
    if (modality && !['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING'].includes(modality)) throw errors.badRequest('不支持的素材类型', 'UNSUPPORTED_MODALITY');
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
      credits: Number(item.credits_charged || 0), inputTokens: Number(item.input_tokens || 0), outputTokens: Number(item.output_tokens || 0),
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
      credits: Number(item.credits_charged || 0), inputTokens: Number(item.input_tokens || 0), outputTokens: Number(item.output_tokens || 0),
      status: item.status, failCode: item.fail_code || null, createdAt: item.created_at,
    }));
    return { items, total: items.length };
  }
  const requireOrgBillingAdmin = () => {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可管理机构账务', 'ORG_BILLING_PERMISSION_DENIED');
    return currentOrgId;
  };
  function creditEntryFilters() {
    const conditions = ['entry.org_id=?'];
    const params = [currentOrgId];
    const direction = ctx.search.get('direction');
    const type = ctx.search.get('type');
    const status = ctx.search.get('status');
    const startDate = ctx.search.get('startDate');
    const endDate = ctx.search.get('endDate');
    const classId = ctx.search.get('classId');
    const studentId = ctx.search.get('studentId');
    const model = ctx.search.get('model');
    const modality = ctx.search.get('modality');
    if (['IN','OUT'].includes(direction)) { conditions.push('entry.direction=?'); params.push(direction); }
    if (type) { conditions.push('entry.type=?'); params.push(type); }
    if (['EFFECTIVE','VOIDED'].includes(status)) { conditions.push('entry.status=?'); params.push(status); }
    if (startDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw errors.badRequest('开始日期格式无效', 'INVALID_START_DATE');
      conditions.push('entry.created_at>=?'); params.push(startDate + 'T00:00:00.000Z');
    }
    if (endDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw errors.badRequest('结束日期格式无效', 'INVALID_END_DATE');
      conditions.push('entry.created_at<=?'); params.push(endDate + 'T23:59:59.999Z');
    }
    if (classId) { conditions.push('session.class_id=?'); params.push(classId); }
    if (studentId) { conditions.push('entry.user_id=?'); params.push(studentId); }
    if (model) { conditions.push('entry.model=?'); params.push(model); }
    if (modality) { conditions.push('entry.modality=?'); params.push(modality); }
    return { conditions, params };
  }
  function orgCreditEntries(limit = 200) {
    const normalizedLimit = integer(limit, '流水条数', { min: 1, max: 1000, fallback: 200 });
    const { conditions, params } = creditEntryFilters();
    return rows(
      'SELECT entry.*,session.class_id,class.name class_name FROM credit_entries entry LEFT JOIN class_sessions session ON session.id=entry.class_session_id LEFT JOIN classes class ON class.id=session.class_id WHERE ' + conditions.join(' AND ') + ' ORDER BY entry.created_at DESC,entry.id DESC LIMIT ' + normalizedLimit,
      params,
    ).map((entry) => ({ ...normalizeEntry(entry), className: entry.class_name || null }));
  }
  function normalizedRechargeOrders(limit = 100) {
    return rows('SELECT * FROM recharge_orders WHERE org_id=? ORDER BY created_at DESC LIMIT ' + integer(limit, '订单条数', { min: 1, max: 1000, fallback: 100 }), [currentOrgId]).map((order) => ({
      id: order.id, orderNo: order.order_no, packageId: order.package_id || null, amountFen: Number(order.amount_fen || 0),
      credits: Number(order.credits || 0), bonusCredits: Number(order.bonus_credits || 0), status: order.status,
      paidAt: order.paid_at || null, invoiceStatus: order.invoice_status, createdAt: order.created_at,
    }));
  }
  function reconciliationExport() {
    const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [currentOrgId]);
    const reconciliation = reconcileCredits(currentOrgId);
    const items = rows(
      "SELECT entry.*,user.login user_login,user.display_name user_name,session.class_id,class.name class_name FROM credit_entries entry LEFT JOIN users user ON user.id=entry.user_id AND user.org_id=entry.org_id LEFT JOIN class_sessions session ON session.id=entry.class_session_id LEFT JOIN classes class ON class.id=session.class_id WHERE entry.org_id=? ORDER BY entry.created_at,entry.id",
      [currentOrgId],
    ).map((entry) => ({
      entryId: entry.id, createdAt: entry.created_at, type: entry.type, direction: entry.direction,
      credits: Number(entry.credits || 0), balanceAfter: Number(entry.balance_after || 0),
      status: entry.status, reversalOf: entry.reversal_of || '', user: entry.user_login || entry.user_name || '',
      classId: entry.class_id || '', class: entry.class_name || '', modality: entry.modality || '',
      model: entry.model || '', reason: entry.reason || '',
      countsAsIncome: entry.direction === 'IN' && entry.status === 'EFFECTIVE' && !['FROZEN_HOLD','FROZEN_RELEASE'].includes(entry.type) && !entry.reversal_of,
      countsAsSpend: entry.direction === 'OUT' && entry.status === 'EFFECTIVE' && !['FROZEN_HOLD','FROZEN_RELEASE'].includes(entry.type) && !entry.reversal_of,
    }));
    const columns = [
      { key: 'entryId', label: '流水ID' }, { key: 'createdAt', label: '时间' }, { key: 'type', label: '类型' },
      { key: 'direction', label: '方向' }, { key: 'credits', label: '积分' }, { key: 'balanceAfter', label: '记账后可用余额' },
      { key: 'status', label: '状态' }, { key: 'reversalOf', label: '冲销源流水' }, { key: 'user', label: '用户' },
      { key: 'classId', label: '班级ID' }, { key: 'class', label: '班级' }, { key: 'modality', label: '能力' },
      { key: 'model', label: '模型' }, { key: 'reason', label: '原因' },
      { key: 'countsAsIncome', label: '计入收入' }, { key: 'countsAsSpend', label: '计入消耗' },
    ];
    const summary = [
      { key: 'availableBalance', label: '账面可用余额', value: reconciliation.availableBalance },
      { key: 'frozenCredits', label: '冻结积分', value: reconciliation.frozenCredits },
      { key: 'accountBalance', label: '账面总余额', value: reconciliation.accountBalance },
      { key: 'ledgerBalance', label: '流水复算余额', value: reconciliation.ledgerBalance },
      { key: 'difference', label: '差异', value: reconciliation.difference },
      { key: 'balanced', label: '对账结果', value: reconciliation.balanced ? '一致' : '不一致' },
      { key: 'entryCount', label: '流水条数', value: reconciliation.entryCount },
      { key: 'ledgerCreditsIn', label: '流水收入合计', value: reconciliation.ledgerCreditsIn },
      { key: 'ledgerCreditsOut', label: '流水消耗合计', value: reconciliation.ledgerCreditsOut },
      { key: 'totalCreditsIn', label: '账户累计收入', value: Number(account.total_credits_in || 0) },
      { key: 'totalCreditsSpent', label: '账户累计消耗', value: Number(account.total_credits_spent || 0) },
    ];
    return { reconciliation, summary, columns, items, fileName: '机构积分对账-' + new Date().toISOString().slice(0, 10) + '.csv' };
  }
  if (part === '/billing/account-overview' && method === 'GET') {
    requireOrgBillingAdmin(); ensureOrgBilling(currentOrgId);
    const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [currentOrgId]);
    const orders = normalizedRechargeOrders();
    const reconciliation = reconcileCredits(currentOrgId);
    const entries = orgCreditEntries();
    return {
      balance: Number(account.credit_balance || 0),
      frozenCredits: Number(account.frozen_credits || 0),
      availableBalance: Number(account.credit_balance || 0),
      totalBalance: Number(account.credit_balance || 0) + Number(account.frozen_credits || 0),
      totalCreditsIn: Number(account.total_credits_in || 0), totalCreditsSpent: Number(account.total_credits_spent || 0),
      paidTotalFen: Number(account.currency_paid_total_fen || 0), reconciliation,
      pendingOrderCount: orders.filter((order) => order.status === 'PENDING').length,
      paidOrderCount: orders.filter((order) => order.status === 'PAID').length,
      orders, entries,
      policy: {
        onlinePayment: false, paymentCallback: false, autoRenew: false,
        failedJobRule: 'AI 任务成功后才扣积分；策略拦截记录 BLOCKED，provider 失败记录 FAILED，均不扣积分，因此无需自动退款。',
        frozenRule: '冻结只锁定可用积分，不改变流水收支净额；可用余额 + 冻结积分必须等于流水复算余额。',
      },
    };
  }
  if (part === '/billing/credit-entries' && method === 'GET') {
    requireOrgBillingAdmin();
    const items = orgCreditEntries(ctx.search.get('limit'));
    return { items, total: items.length };
  }
  if (part === '/billing/credit-adjustments' && method === 'POST') {
    requireOrgBillingAdmin(); const body = ctx.body || {};
    const result = adjustCredits({ orgId: currentOrgId, type: body.type, credits: body.credits, reason: body.reason, actorId: auth.user.id });
    audit(ctx, 'ORG_CREDIT_ADJUSTMENT', 'CREDIT_ENTRY', result.entryId, null, { type: body.type, credits: body.credits, reason: body.reason, balanceAfter: result.balanceAfter }, { orgId: currentOrgId });
    return result;
  }
  if (part === '/billing/frozen-credits' && method === 'PUT') {
    requireOrgBillingAdmin(); const body = ctx.body || {};
    const before = reconcileCredits(currentOrgId);
    const result = setFrozenCredits({ orgId: currentOrgId, frozenCredits: body.frozenCredits, reason: body.reason, actorId: auth.user.id });
    audit(ctx, 'ORG_CREDIT_FROZEN_UPDATE', 'ORG_BILLING_ACCOUNT', currentOrgId, { frozenCredits: before.frozenCredits }, { frozenCredits: result.frozenCredits, availableBalance: result.availableBalance, reason: body.reason }, { orgId: currentOrgId });
    return result;
  }
  let creditEntryMatch = part.match(/^\/billing\/credit-entries\/([^/]+)\/(refund|reverse)$/);
  if (creditEntryMatch && method === 'POST') {
    requireOrgBillingAdmin(); const body = ctx.body || {};
    const result = refundOrReverseEntry({ orgId: currentOrgId, sourceEntryId: creditEntryMatch[1], reason: body.reason, actorId: auth.user.id, mode: creditEntryMatch[2] === 'refund' ? 'REFUND' : 'REVERSAL' });
    audit(ctx, creditEntryMatch[2] === 'refund' ? 'ORG_CREDIT_REFUND' : 'ORG_CREDIT_REVERSAL', 'CREDIT_ENTRY', result.entryId, { sourceEntryId: result.sourceEntryId }, { sourceEntryId: result.sourceEntryId, reason: body.reason, balanceAfter: result.balanceAfter }, { orgId: currentOrgId });
    return result;
  }
  if (part === '/billing/reconciliation' && method === 'GET') {
    requireOrgBillingAdmin(); ensureOrgBilling(currentOrgId);
    return reconcileCredits(currentOrgId);
  }
  if (part === '/billing/reconciliation/export' && method === 'GET') {
    requireOrgBillingAdmin(); ensureOrgBilling(currentOrgId);
    const data = reconciliationExport();
    audit(ctx, 'ORG_BILLING_RECONCILIATION_EXPORT', 'ORG_BILLING_ACCOUNT', currentOrgId, null, { rowCount: data.items.length, balanced: data.reconciliation.balanced }, { orgId: currentOrgId });
    return data;
  }

  if (part === '/course-series' && method === 'GET') {
    const items = rows("SELECT DISTINCT series.* FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND assignment.status='ACTIVE' WHERE series.status='PUBLISHED' AND ((series.owner_type='PLATFORM' AND (series.visibility='ALL_ORGS' OR assignment.id IS NOT NULL)) OR (series.owner_type='ORG' AND series.org_id=?)) ORDER BY series.sort,series.title", [currentOrgId, currentOrgId]).map((series) => normalizeSeries(series, { orgId: currentOrgId, includeLessons: true }));
    return { items };
  }
  let orgCourseDetailMatch = part.match(/^\/course-series\/([^/]+)$/);
  if (orgCourseDetailMatch && method === 'GET') {
    const series = row("SELECT series.* FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND assignment.status='ACTIVE' WHERE series.id=? AND series.status='PUBLISHED' AND ((series.owner_type='PLATFORM' AND (series.visibility='ALL_ORGS' OR assignment.id IS NOT NULL)) OR (series.owner_type='ORG' AND series.org_id=?))", [currentOrgId, orgCourseDetailMatch[1], currentOrgId]);
    if (!series) throw errors.notFound('课包不存在或不可访问', 'COURSE_SERIES_NOT_FOUND');
    const detail = normalizeSeries(series, { orgId: currentOrgId, includeLessons: true });
    detail.lessons = (detail.lessons || []).filter((l) => l.status === 'PUBLISHED');
    return detail;
  }
  if (part === '/classes' && method === 'GET') {
    const params = [currentOrgId]; let where = 'class.org_id=?';
    if (auth.user.role === 'TEACHER') where += teacherScope('class', auth, params);
    return { items: rows('SELECT class.*,teacher.display_name AS teacher_name FROM classes class LEFT JOIN users teacher ON teacher.id=class.teacher_id AND teacher.org_id=class.org_id WHERE ' + where + ' ORDER BY class.created_at DESC', params).map(normalizeClass) };
  }
  if (part === '/classes' && method === 'POST') {
    if (!hasPermission(auth, 'MANAGE_CLASSES')) throw errors.forbidden('无班级管理权限', 'CLASS_PERMISSION_DENIED');
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
    assertClassManager(auth, cls);
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
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls); if (cls.status !== 'ACTIVE') throw errors.conflict('已归档班级不能修改课程计划', 'CLASS_ARCHIVED'); const lessonIds = Array.isArray(ctx.body?.lessonIds) ? [...new Set(ctx.body.lessonIds)] : [];
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
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls, 'MANAGE_MEMBERS'); if (cls.status !== 'ACTIVE') throw errors.conflict('已归档班级不能变更成员', 'CLASS_ARCHIVED'); const target = orgUser(auth, classMatch[2]); if (target.role !== 'STUDENT') throw errors.badRequest('只能管理学员成员', 'INVALID_MEMBER_ROLE');
    if (method === 'POST') q('INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING', [id('member'), cls.id, target.id, 'STUDENT', nowIso()]); else q('UPDATE class_members SET removed_at=? WHERE class_id=? AND user_id=? AND removed_at IS NULL', [nowIso(), cls.id, target.id]);
    audit(ctx, method === 'POST' ? 'CLASS_MEMBER_ADD' : 'CLASS_MEMBER_REMOVE', 'CLASS', cls.id, null, { userId: target.id }); return { ok: true };
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/(start|makeup)$/);
  if (classMatch && method === 'POST') {
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls); if (cls.status !== 'ACTIVE') throw errors.conflict('已归档班级不能开课', 'CLASS_ARCHIVED'); const lessonId = String(ctx.body?.lessonId || '').trim();
    if (!lessonId) throw errors.badRequest('开课必须指定课时', 'LESSON_REQUIRED');
    if (!row('SELECT id FROM class_curriculum_items WHERE class_id=? AND lesson_id=?', [cls.id, lessonId]) || !accessibleLesson(currentOrgId, lessonId)) throw errors.badRequest('课时不在本班已授权课单中', 'LESSON_NOT_ASSIGNED');
    if (row("SELECT id FROM class_sessions WHERE class_id=? AND status='ACTIVE'", [cls.id])) throw errors.conflict('当前班级已有进行中的课堂', 'CLASS_SESSION_ACTIVE');
    const cap = ctx.body?.sessionCreditCap === undefined || ctx.body?.sessionCreditCap === null ? null : integer(ctx.body.sessionCreditCap, '课堂积分上限'); const capability = ctx.body?.capabilities || {}; const sessionId = id('csession'); const now = nowIso(); const sessionKind = classMatch[2] === 'makeup' || ctx.body?.sessionKind === 'MAKEUP' ? 'MAKEUP' : 'REGULAR';
    transaction(() => { q('INSERT INTO class_sessions(id,class_id,lesson_id,status,session_kind,session_credit_cap,consumed_credits_total,ai_paused,student_call_cap,allow_text,allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,started_by,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [sessionId, cls.id, lessonId, 'ACTIVE', sessionKind, cap, 0, capability.aiPaused ? 1 : 0, capability.studentCallCap === undefined || capability.studentCallCap === null ? null : integer(capability.studentCallCap, '单学生调用次数', { min: 1, max: 100000 }), capability.allowText === undefined ? 1 : (capability.allowText ? 1 : 0), capability.allowImage === undefined ? 1 : (capability.allowImage ? 1 : 0), capability.allowMusic === undefined ? 1 : (capability.allowMusic ? 1 : 0), capability.allowVideo ? 1 : 0, capability.allowPodcast ? 1 : 0, capability.allowDubbing ? 1 : 0, auth.user.id, now]); q('UPDATE classes SET current_session_id=?,updated_at=? WHERE id=? AND org_id=?', [sessionId, now, cls.id, currentOrgId]); });
    audit(ctx, sessionKind === 'MAKEUP' ? 'MAKEUP_SESSION_START' : 'SESSION_START', 'CLASS_SESSION', sessionId, null, { classId: cls.id, lessonId, sessionKind }); return normalizeSession(row('SELECT session.*,lesson.title AS lesson_title FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE session.id=? AND session.class_id=?', [sessionId, cls.id]));
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/([^/]+)\/cancel$/);
  if (classMatch && method === 'POST') {
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls); const session = row('SELECT * FROM class_sessions WHERE id=? AND class_id=?', [classMatch[2], cls.id]);
    if (!session) throw errors.notFound('课堂不存在', 'CLASS_SESSION_NOT_FOUND');
    if (session.status !== 'ACTIVE') throw errors.conflict('课堂已结束，不能重复取消', 'CLASS_SESSION_ENDED');
    const now = nowIso(); transaction(() => { q("UPDATE class_sessions SET status='ENDED',ended_at=?,ended_by=?,ended_reason='CANCELED' WHERE id=? AND class_id=? AND status='ACTIVE'", [now, auth.user.id, session.id, cls.id]); q('UPDATE classes SET current_session_id=NULL,updated_at=? WHERE id=? AND org_id=? AND current_session_id=?', [now, cls.id, currentOrgId, session.id]); });
    audit(ctx, 'SESSION_CANCEL', 'CLASS_SESSION', session.id, null, { classId: cls.id, reason: ctx.body?.reason || null }); return normalizeSession(row('SELECT session.*,lesson.title AS lesson_title FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE session.id=? AND session.class_id=?', [session.id, cls.id]));
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/([^/]+)\/ai-controls$/);
  if (classMatch && method === 'PUT') {
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls); const session = row('SELECT * FROM class_sessions WHERE id=? AND class_id=?', [classMatch[2], cls.id]);
    if (!session) throw errors.notFound('课堂不存在', 'CLASS_SESSION_NOT_FOUND');
    if (session.status !== 'ACTIVE') throw errors.conflict('课堂已结束', 'CLASS_SESSION_ENDED');
    const body = ctx.body || {}; const capabilities = body.capabilities || {};
    const value = (key, fallback) => Object.prototype.hasOwnProperty.call(capabilities, key) ? (capabilities[key] ? 1 : 0) : fallback;
    const sessionCreditCap = Object.prototype.hasOwnProperty.call(body, 'sessionCreditCap') ? (body.sessionCreditCap === null || body.sessionCreditCap === '' ? null : integer(body.sessionCreditCap, '课堂积分上限')) : session.session_credit_cap;
    const studentCallCap = Object.prototype.hasOwnProperty.call(body, 'studentCallCap') ? (body.studentCallCap === null || body.studentCallCap === '' ? null : integer(body.studentCallCap, '单学生调用次数', { min: 1, max: 100000 })) : session.student_call_cap;
    const aiPaused = Object.prototype.hasOwnProperty.call(body, 'aiPaused') ? (body.aiPaused ? 1 : 0) : session.ai_paused;
    q("UPDATE class_sessions SET session_credit_cap=?,student_call_cap=?,ai_paused=?,allow_text=?,allow_image=?,allow_music=?,allow_video=?,allow_podcast=?,allow_dubbing=? WHERE id=? AND class_id=? AND status='ACTIVE'", [sessionCreditCap, studentCallCap, aiPaused, value('allowText', session.allow_text), value('allowImage', session.allow_image), value('allowMusic', session.allow_music), value('allowVideo', session.allow_video), value('allowPodcast', session.allow_podcast), value('allowDubbing', session.allow_dubbing), session.id, cls.id]);
    const updated = normalizeSession(row('SELECT session.*,lesson.title AS lesson_title FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE session.id=? AND session.class_id=?', [session.id, cls.id]));
    audit(ctx, 'SESSION_AI_CONTROLS_UPDATE', 'CLASS_SESSION', session.id, normalizeSession(session), updated); return updated;
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/([^/]+)\/(end|credit-cap|capabilities)$/);
  if (classMatch && method === 'POST') {
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls); const session = row('SELECT * FROM class_sessions WHERE id=? AND class_id=?', [classMatch[2], cls.id]); if (!session) throw errors.notFound('课堂不存在', 'CLASS_SESSION_NOT_FOUND'); const action = classMatch[3];
    if (action === 'end') assertTransition(ctx, 'classSession', session.status, 'ENDED', { targetType: 'CLASS_SESSION', targetId: session.id, before: normalizeSession(session), code: 'INVALID_CLASS_SESSION_TRANSITION', message: '课堂已结束，不能重复结束' });
    else if (session.status !== 'ACTIVE') throw errors.conflict('课堂已结束', 'CLASS_SESSION_ENDED');
    if (action === 'end') transaction(() => { q("UPDATE class_sessions SET status='ENDED',ended_at=?,ended_by=?,ended_reason=? WHERE id=? AND class_id=? AND status='ACTIVE'", [nowIso(), auth.user.id, String(ctx.body?.reason || 'MANUAL').slice(0, 100), session.id, cls.id]); q('UPDATE classes SET current_session_id=NULL,updated_at=? WHERE id=? AND org_id=? AND current_session_id=?', [nowIso(), cls.id, currentOrgId, session.id]); });
    if (action === 'credit-cap') q("UPDATE class_sessions SET session_credit_cap=? WHERE id=? AND class_id=? AND status='ACTIVE'", [ctx.body?.sessionCreditCap === null ? null : integer(ctx.body?.sessionCreditCap, '课堂积分上限'), session.id, cls.id]);
    if (action === 'capabilities') { const capability = ctx.body?.capabilities || {}; q("UPDATE class_sessions SET allow_text=?,allow_image=?,allow_music=?,allow_video=?,allow_podcast=?,allow_dubbing=? WHERE id=? AND class_id=? AND status='ACTIVE'", [capability.allowText === undefined ? session.allow_text : (capability.allowText ? 1 : 0), capability.allowImage === undefined ? session.allow_image : (capability.allowImage ? 1 : 0), capability.allowMusic === undefined ? session.allow_music : (capability.allowMusic ? 1 : 0), capability.allowVideo === undefined ? session.allow_video : (capability.allowVideo ? 1 : 0), capability.allowPodcast === undefined ? session.allow_podcast : (capability.allowPodcast ? 1 : 0), capability.allowDubbing === undefined ? session.allow_dubbing : (capability.allowDubbing ? 1 : 0), session.id, cls.id]); }
    audit(ctx, 'SESSION_' + action.toUpperCase(), 'CLASS_SESSION', session.id, null, ctx.body); return normalizeSession(row('SELECT session.*,lesson.title AS lesson_title FROM class_sessions session LEFT JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE session.id=? AND session.class_id=?', [session.id, cls.id]));
  }
  let annotationMatch = part.match(/^\/works\/([^/]+)\/annotations(?:\/([^/]+))?$/);
  if (annotationMatch && method === 'GET') {
    const work = workInReviewScope(auth, currentOrgId, annotationMatch[1]);
    return { items: annotationRows(work.id) };
  }
  if (annotationMatch && method === 'POST' && !annotationMatch[2]) {
    const work = workInReviewScope(auth, currentOrgId, annotationMatch[1]);
    const content = String(ctx.body?.content || '').trim();
    if (!content) throw errors.badRequest('点评内容不能为空', 'ANNOTATION_CONTENT_REQUIRED');
    if (content.length > 1000) throw errors.badRequest('点评内容不能超过 1000 个字符', 'ANNOTATION_CONTENT_TOO_LONG');
    const nodeId = assertAnnotationNode(work, ctx.body?.nodeId ? String(ctx.body.nodeId).slice(0, 160) : null);
    const annotationId = id('annotation');
    q('INSERT INTO work_annotations(id,work_id,org_id,node_id,content,author_id,created_at) VALUES (?,?,?,?,?,?,?)', [annotationId, work.id, currentOrgId, nodeId, content, auth.user.id, nowIso()]);
    audit(ctx, 'WORK_ANNOTATION_CREATE', 'WORK_ANNOTATION', annotationId, null, { workId: work.id, nodeId });
    return annotationRows(work.id).find((annotation) => annotation.id === annotationId);
  }
  if (annotationMatch && method === 'PUT' && annotationMatch[2]) {
    const work = workInReviewScope(auth, currentOrgId, annotationMatch[1]);
    const annotation = row('SELECT * FROM work_annotations WHERE id=? AND work_id=? AND org_id=?', [annotationMatch[2], work.id, currentOrgId]);
    if (!annotation) throw errors.notFound('画布点评不存在', 'ANNOTATION_NOT_FOUND');
    const body = ctx.body || {};
    const hasContent = Object.prototype.hasOwnProperty.call(body, 'content');
    const hasResolved = Object.prototype.hasOwnProperty.call(body, 'resolved');
    if (!hasContent && !hasResolved) throw errors.badRequest('请提供需要更新的点评内容或完成状态', 'ANNOTATION_UPDATE_REQUIRED');
    let content = annotation.content;
    if (hasContent) {
      content = String(body.content || '').trim();
      if (!content) throw errors.badRequest('点评内容不能为空', 'ANNOTATION_CONTENT_REQUIRED');
      if (content.length > 1000) throw errors.badRequest('点评内容不能超过 1000 个字符', 'ANNOTATION_CONTENT_TOO_LONG');
    }
    const resolved = hasResolved ? Boolean(body.resolved) : Boolean(annotation.resolved_at);
    q('UPDATE work_annotations SET content=?,resolved_at=?,resolved_by=? WHERE id=? AND work_id=? AND org_id=?', [content, resolved ? nowIso() : null, resolved ? auth.user.id : null, annotation.id, work.id, currentOrgId]);
    audit(ctx, 'WORK_ANNOTATION_UPDATE', 'WORK_ANNOTATION', annotation.id, null, { workId: work.id, resolved });
    return annotationRows(work.id).find((item) => item.id === annotation.id);
  }

  if (part === '/work-reports' && method === 'GET') {
    const params = [currentOrgId]; let where = 'report.org_id=?';
    if (auth.user.role === 'TEACHER') { where += " AND (class.teacher_id=? OR EXISTS (SELECT 1 FROM class_members scoped_member WHERE scoped_member.class_id=class.id AND scoped_member.user_id=? AND scoped_member.role='TEACHER' AND scoped_member.removed_at IS NULL))"; params.push(auth.user.id, auth.user.id); }
    const status = ctx.search.get('status'); if (['PENDING', 'RESOLVED', 'DISMISSED'].includes(status)) { where += ' AND report.status=?'; params.push(status); }
    const items = rows(
      `SELECT report.*, work.title AS work_title, work.status AS work_status, reporter.display_name AS reporter_name, handler.display_name AS handler_name
       FROM work_reports report JOIN works work ON work.id=report.work_id AND work.org_id=report.org_id
       LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
       JOIN users reporter ON reporter.id=report.reporter_id LEFT JOIN users handler ON handler.id=report.handled_by
       WHERE ${where}
       ORDER BY CASE report.status WHEN 'PENDING' THEN 0 ELSE 1 END, report.created_at DESC`, params,
    ).map((report) => normalizeWorkReport(report, { includeReporter: true }));
    return { items, total: items.length, pending: items.filter((item) => item.status === 'PENDING').length };
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
  let workMatch = part.match(/^\/works\/([^/]+)\/review$/);
  if (workMatch && method === 'PUT') {
    const work = workInReviewScope(auth, currentOrgId, workMatch[1]);
    const status = String(ctx.body?.status || '').toUpperCase();
    assertKnownState('work', status, { field: '作品状态' });
    if (status === 'PENDING') throw errors.badRequest('作品状态无效', 'INVALID_WORK_STATUS');
    assertTransition(ctx, 'work', work.status, status, { targetType: 'WORK', targetId: work.id, before: normalizeWork(work), code: 'INVALID_WORK_TRANSITION', message: '当前作品状态不允许执行该操作' });
    if (status === 'PUBLISHED' && !work.copyright_confirmed_at) throw errors.conflict('学生尚未确认作品版权与展示授权，不能发布', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    const comment = String(ctx.body?.teacherComment || '').trim(); if (comment.length > 2000) throw errors.badRequest('老师点评不能超过 2000 个字符', 'WORK_COMMENT_TOO_LONG');
    const now = nowIso();
    transaction(() => {
      q('UPDATE works SET status=?,teacher_comment=?,reviewed_by=?,reviewed_at=? WHERE id=? AND org_id=?', [status, comment, auth.user.id, now, work.id, currentOrgId]);
      const latestSubmission = row('SELECT id FROM work_submissions WHERE work_id=? ORDER BY round DESC LIMIT 1', [work.id]);
      if (latestSubmission) {
        q('UPDATE work_submissions SET review_status=?,review_comment=?,reviewed_at=?,updated_at=? WHERE id=?', [status, comment, now, now, latestSubmission.id]);
      }
      if (status === 'REJECTED') {
        q(
          "UPDATE student_projects SET status='DRAFT',updated_at=? WHERE id=? AND org_id=? AND status='SUBMITTED' AND deleted_at IS NULL",
          [now, work.project_id, currentOrgId],
        );
      }
    });
    audit(ctx, 'WORK_REVIEW', 'WORK', work.id, normalizeWork(work), { status, teacherComment: comment || null, projectReopened: status === 'REJECTED' }, { orgId: currentOrgId });
    // 自动提醒：作品审核完成 → 通知学生（P4-O09）
    try {
      scheduleReminder({
        title: status === 'REJECTED' ? '作品需要修改' : status === 'PUBLISHED' ? '作品已发布' : '作品已通过',
        body: status === 'REJECTED'
          ? `作品《${work.title}》未通过审核：${comment || '请查看详情'}`
          : status === 'PUBLISHED'
            ? `作品《${work.title}》已发布到作品墙`
            : `作品《${work.title}》已通过审核`,
        targetUserId: work.student_id,
        targetOrgId: currentOrgId,
        eventKey: `WORK_REVIEW_COMPLETED:${work.id}:${status}`,
        targetUrl: '/works',
      });
    } catch { /* 提醒失败不影响主流程 */ }
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
  if (part === '/account-requests' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可以处理账号申请', 'ACCOUNT_REQUEST_PERMISSION_DENIED');
    const status = ctx.search.get('status');
    const type = ctx.search.get('type');
    let where = 'request.org_id=?'; const params = [currentOrgId];
    if (['PENDING','APPROVED','REJECTED','CANCELLED'].includes(status)) { where += ' AND request.status=?'; params.push(status); }
    if (['DELETION','DATA_EXPORT'].includes(type)) { where += ' AND request.type=?'; params.push(type); }
    const items = orgAccountRequestRows(where + " ORDER BY CASE request.status WHEN 'PENDING' THEN 0 ELSE 1 END, request.requested_at DESC", params);
    return { items, total: items.length, pending: items.filter((item) => item.status === 'PENDING').length };
  }

  let accountRequestMatch = part.match(/^\/account-requests\/([^/]+)$/);
  if (accountRequestMatch && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可以处理账号申请', 'ACCOUNT_REQUEST_PERMISSION_DENIED');
    const request = orgAccountRequestRows('request.id=? AND request.org_id=?', [accountRequestMatch[1], currentOrgId])[0];
    if (!request) throw errors.notFound('账号申请不存在', 'ACCOUNT_REQUEST_NOT_FOUND');
    return request;
  }
  if (accountRequestMatch && method === 'PUT') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可以处理账号申请', 'ACCOUNT_REQUEST_PERMISSION_DENIED');
    const requestRow = row('SELECT * FROM account_requests WHERE id=? AND org_id=?', [accountRequestMatch[1], currentOrgId]);
    if (!requestRow) throw errors.notFound('账号申请不存在', 'ACCOUNT_REQUEST_NOT_FOUND');
    if (requestRow.status !== 'PENDING') throw errors.conflict('账号申请已处理，不能重复处理', 'ACCOUNT_REQUEST_ALREADY_HANDLED');
    const status = ctx.body?.status;
    if (!['APPROVED','REJECTED'].includes(status)) throw errors.badRequest('账号申请处理状态无效', 'INVALID_ACCOUNT_REQUEST_STATUS');
    const resolution = nonEmptyString(ctx.body?.resolution, '处理说明', { max: 2000 });
    const student = orgUser(auth, requestRow.user_id);
    const now = nowIso();
    let exportPayload = null;
    if (status === 'APPROVED' && requestRow.type === 'DATA_EXPORT') {
      exportPayload = buildStudentDataExport(student, ctx.auth.org || row('SELECT * FROM organizations WHERE id=?', [currentOrgId]));
    }
    transaction(() => {
      q(
        'UPDATE account_requests SET status=?,resolved_at=?,resolved_by=?,resolution=?,export_payload=? WHERE id=? AND org_id=? AND status=?',
        [status, now, auth.user.id, resolution, exportPayload ? json(exportPayload) : null, requestRow.id, currentOrgId, 'PENDING'],
      );
      if (status === 'APPROVED' && requestRow.type === 'DELETION') softDeleteStudent(ctx, student, now);
    });
    audit(
      ctx,
      requestRow.type === 'DELETION' ? 'ORG_ACCOUNT_DELETION_' + status : 'ORG_ACCOUNT_DATA_EXPORT_' + status,
      'ACCOUNT_REQUEST',
      requestRow.id,
      orgAccountRequestRow(requestRow),
      { status, resolution, studentDisabled: status === 'APPROVED' && requestRow.type === 'DELETION' },
      { orgId: currentOrgId },
    );
    return orgAccountRequestRows('request.id=?', [requestRow.id])[0];
  }
  return null;
}
