import {
  audit, count, errors, id, json, normalizeClass, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, nowIso, parseJson,
  q, requireRole, row, rows, transaction,
} from '@platform/server-lib';
import { hashPassword } from '@platform/database';

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
  const cls = row('SELECT * FROM classes WHERE id=? AND org_id=?', [classId, orgId(auth)]);
  if (!cls) throw errors.notFound('班级不存在', 'CLASS_NOT_FOUND');
  return cls;
}
function assertClassManager(auth, cls, permission = 'MANAGE_CLASSES') {
  if (auth.user.role === 'ORG_ADMIN') return;
  if (auth.user.role === 'TEACHER' && cls.teacher_id === auth.user.id && hasPermission(auth, permission)) return;
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

function curriculumItem(value) { return { id: value.id, lessonId: value.lesson_id, title: value.title, summary: value.summary || '', sort: Number(value.sort || 0), durationMinutes: Number(value.duration_minutes || 0), sourceSeriesId: value.source_series_id }; }

function workInReviewScope(auth, currentOrgId, workId) {
  const work = row(
    `SELECT work.*, class.teacher_id
     FROM works work
     LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id
     WHERE work.id=? AND work.org_id=?`,
    [workId, currentOrgId],
  );
  if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
  if (auth.user.role === 'TEACHER' && work.teacher_id !== auth.user.id) {
    throw errors.forbidden('不能点评其他教师班级的作品', 'WORK_PERMISSION_DENIED');
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

export async function handleAdmin(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/admin/')) return null;
  const part = pathname.slice('/api/admin'.length) || '/';
  if (part === '/organizations' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const search = String(ctx.search.get('search') || '').trim();
    const items = rows("SELECT * FROM organizations WHERE ?='' OR name LIKE ? ORDER BY created_at DESC LIMIT 200", [search, '%' + search + '%']).map(normalizeOrg);
    return { items, total: items.length };
  }
  if (part === '/organizations' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const body = ctx.body || {}; const name = String(body.name || '').trim();
    if (!name) throw errors.badRequest('机构名称不能为空');
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
    requireRole(ctx, ['SUPER_ADMIN']); const organization = row('SELECT * FROM organizations WHERE id=?', [match[1]]);
    if (!organization) throw errors.notFound('机构不存在', 'ORG_NOT_FOUND'); if (method === 'GET') return normalizeOrg(organization);
    const body = ctx.body || {};
    q('UPDATE organizations SET name=?,status=COALESCE(?,status),contract_start_at=COALESCE(?,contract_start_at),contract_expires_at=COALESCE(?,contract_expires_at),base_teacher_seats=COALESCE(?,base_teacher_seats),purchased_teacher_seats=COALESCE(?,purchased_teacher_seats),contact=COALESCE(?,contact),updated_at=? WHERE id=?', [body.name ? String(body.name).trim() : organization.name, body.status || null, body.contractStartAt || null, body.contractExpiresAt || null, body.baseTeacherSeats === undefined ? null : integer(body.baseTeacherSeats, '基础教师席位'), body.purchasedTeacherSeats === undefined ? null : integer(body.purchasedTeacherSeats, '购买教师席位'), body.contact === undefined ? null : json(body.contact), nowIso(), organization.id]);
    audit(ctx, 'ORG_UPDATE', 'ORG', organization.id, normalizeOrg(organization), body);
    return normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [organization.id]));
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
    if (row("SELECT id FROM course_series WHERE title=? AND owner_type='PLATFORM'", [title])) throw errors.conflict('同名平台课包已存在', 'COURSE_SERIES_EXISTS');
    const seriesId = id('series'); const now = nowIso();
    transaction(() => {
      q('INSERT INTO course_series(id,title,description,cover_image_url,owner_type,org_id,visibility,version,sort,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [seriesId, title, String(body.description || '').slice(0, 10000), body.coverImageUrl ? String(body.coverImageUrl).slice(0, 2000) : null, 'PLATFORM', null, visibility, String(body.version || '1.0').slice(0, 100), integer(body.sort, '课包排序', { min: 0, max: 100000, fallback: 0 }), status, now, now]);
      lessons.forEach((lesson, index) => {
        const lessonTitle = String(lesson?.title || '').trim();
        if (!lessonTitle) throw errors.badRequest(`第${index + 1}课标题不能为空`, 'LESSON_TITLE_REQUIRED');
        if (lessonTitle.length > 200) throw errors.badRequest(`第${index + 1}课标题不能超过200个字符`, 'VALIDATION_ERROR');
        const lessonStatus = status === 'ARCHIVED' ? 'ARCHIVED' : (lesson.status || 'PUBLISHED');
        if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(lessonStatus)) throw errors.badRequest(`第${index + 1}课状态无效`, 'INVALID_LESSON_STATUS');
        q('INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', [id('lesson'), seriesId, lessonTitle, String(lesson.summary || '').slice(0, 10000), index + 1, lessonStatus, integer(lesson.durationMinutes, '课时时长', { min: 1, max: 1440, fallback: 45 }), now, now]);
      });
    });
    audit(ctx, 'COURSE_SERIES_CREATE', 'COURSE_SERIES', seriesId, null, { title, lessonCount: lessons.length });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [seriesId]), { includeLessons: true, includeAllLessons: true });
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
        if (existing) q("UPDATE course_assignments SET status='ACTIVE',assigned_by=?,assigned_at=? WHERE id=?", [auth.user.id, now, existing.id]);
        else q("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at) VALUES (?,?,?,?,?,?)", [id('assign'), series.id, assignmentOrgId, 'ACTIVE', auth.user.id, now]);
      });
    });
    audit(ctx, 'COURSE_SERIES_ASSIGN', 'COURSE_SERIES', series.id, null, { orgIds: assignmentOrgIds });
    return { assignedCount: assignmentOrgIds.length };
  }
  if (part === '/platform-users' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const role = ctx.search.get('role'); const orgIdFilter = ctx.search.get('orgId'); const search = String(ctx.search.get('search') || '').trim();
    const params = []; const conditions = ['user.deleted_at IS NULL'];
    if (['SUPER_ADMIN', 'ORG_ADMIN', 'TEACHER', 'STUDENT'].includes(role)) { conditions.push('user.role=?'); params.push(role); }
    if (orgIdFilter) { conditions.push('user.org_id=?'); params.push(orgIdFilter); }
    if (search) { conditions.push('(user.login LIKE ? OR user.display_name LIKE ? OR user.phone LIKE ?)'); const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; params.push(keyword, keyword, keyword); }
    const items = rows(
      'SELECT user.*, organization.name organization_name, billing_package.name billing_package_name FROM users user LEFT JOIN organizations organization ON organization.id=user.org_id LEFT JOIN billing_packages billing_package ON billing_package.id=user.billing_package_id WHERE ' + conditions.join(' AND ') + ' ORDER BY user.created_at DESC LIMIT 500',
      params,
    ).map(platformUserRow);
    return { items, total: items.length };
  }
  if (part === '/platform-admins' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const items = rows("SELECT * FROM users WHERE role='SUPER_ADMIN' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200").map((item) => normalizeUser(item, { includeAuthMeta: true }));
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
    }
    const login = body.login === undefined ? target.login : String(body.login).trim();
    if (!login) throw errors.badRequest('登录名不能为空', 'ADMIN_INPUT_REQUIRED');
    q('UPDATE users SET login=?,display_name=?,permissions=?,password_hash=?,status=?,updated_at=? WHERE id=?', [login, displayName, json([...new Set(permissions)]), passwordHash, status, nowIso(), target.id]);
    audit(ctx, 'PLATFORM_ADMIN_UPDATE', 'USER', target.id, { login: target.login, displayName: target.display_name, status: target.status }, { displayName, status, passwordChanged: body.password !== undefined, permissions });
    return normalizeUser(row('SELECT * FROM users WHERE id=?', [target.id]), { includeAuthMeta: true });
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
    const conditions = []; const params = [];
    if (['PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED'].includes(status)) { conditions.push('work.status=?'); params.push(status); }
    if (orgFilter) { conditions.push('work.org_id=?'); params.push(orgFilter); }
    if (search) {
      conditions.push('(work.title LIKE ? OR student.display_name LIKE ? OR organization.name LIKE ?)');
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      params.push(keyword, keyword, keyword);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const items = rows(
      'SELECT work.*,student.display_name student_name,organization.name organization_name,class.name class_name,lesson.title lesson_title,reviewer.display_name reviewer_name FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN organizations organization ON organization.id=work.org_id LEFT JOIN classes class ON class.id=work.class_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by' + where + ' ORDER BY work.submitted_at DESC LIMIT 200',
      params,
    ).map((work) => ({ ...normalizeWork(work), organizationName: work.organization_name || null }));
    return { items, total: items.length };
  }
  let platformWorkMatch = part.match(/^\/works\/([^/]+)\/unpublish$/);
  if (platformWorkMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const work = row('SELECT * FROM works WHERE id=?', [platformWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
    const reason = String(ctx.body?.reason || '平台下架').trim().slice(0, 2000);
    q('UPDATE works SET status=?,teacher_comment=?,reviewed_by=?,reviewed_at=? WHERE id=?', ['REJECTED', reason, auth.user.id, nowIso(), work.id]);
    audit(ctx, 'PLATFORM_WORK_UNPUBLISH', 'WORK', work.id, normalizeWork(work), { status: 'REJECTED', reason }, { orgId: work.org_id });
    const updated = row('SELECT work.*,student.display_name student_name,organization.name organization_name,class.name class_name,lesson.title lesson_title,reviewer.display_name reviewer_name FROM works work JOIN users student ON student.id=work.student_id LEFT JOIN organizations organization ON organization.id=work.org_id LEFT JOIN classes class ON class.id=work.class_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by WHERE work.id=?', [work.id]);
    return { ...normalizeWork(updated), organizationName: updated.organization_name || null };
  }
  return null;
}

export async function handleOrg(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/org/')) return null;
  const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER']); const currentOrgId = orgId(auth); const part = pathname.slice('/api/org'.length);
  if (part === '/overview' && method === 'GET') {
    ensureOrgBilling(currentOrgId); const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [currentOrgId]);
    return { org: normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [currentOrgId])), students: count("SELECT COUNT(*) n FROM users WHERE org_id=? AND role='STUDENT' AND deleted_at IS NULL", [currentOrgId]), teachers: count("SELECT COUNT(*) n FROM users WHERE org_id=? AND role='TEACHER' AND deleted_at IS NULL", [currentOrgId]), activeClasses: count("SELECT COUNT(*) n FROM classes WHERE org_id=? AND status='ACTIVE'", [currentOrgId]), activeSessions: count("SELECT COUNT(*) n FROM class_sessions session JOIN classes class ON class.id=session.class_id WHERE class.org_id=? AND session.status='ACTIVE'", [currentOrgId]), works: count('SELECT COUNT(*) n FROM works WHERE org_id=?', [currentOrgId]), usage7: Number(row('SELECT COALESCE(SUM(credits_charged),0) n FROM usage_records WHERE org_id=? AND created_at>=?', [currentOrgId, new Date(Date.now() - 7 * 86400000).toISOString()]).n || 0), creditBalance: Number(account?.credit_balance || 0) };
  }
  if (part === '/users' && method === 'GET') {
    if (!hasPermission(auth, 'MANAGE_MEMBERS')) throw errors.forbidden('无账号管理权限', 'ORG_MEMBER_PERMISSION_REQUIRED');
    const role = ctx.search.get('role'); const params = [currentOrgId]; let where = 'org_id=? AND deleted_at IS NULL'; if (['TEACHER','STUDENT'].includes(role)) { where += ' AND role=?'; params.push(role); }
    const items = rows('SELECT * FROM users WHERE ' + where + ' ORDER BY created_at DESC LIMIT 500', params).map((item) => normalizeUser(item, { includeAuthMeta: true })); return { items, total: items.length };
  }
  if (part === '/users' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可创建账号', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {}; const role = body.role; const login = String(body.login || '').trim(); const displayName = String(body.displayName || '').trim();
    if (!['TEACHER','STUDENT'].includes(role) || !login || !displayName || String(body.password || '').length < 6) throw errors.badRequest('账号信息不完整');
    if (row('SELECT id FROM users WHERE login=?', [login])) throw errors.conflict('登录名已存在', 'LOGIN_EXISTS');
    if (role === 'TEACHER' && normalizeOrg(row('SELECT * FROM organizations WHERE id=?', [currentOrgId])).remainingTeacherSeats <= 0) throw errors.badRequest('教师席位不足', 'TEACHER_SEAT_LIMIT');
    if (body.billingPackageId && !row('SELECT id FROM billing_packages WHERE id=? AND org_id=?', [body.billingPackageId, currentOrgId])) throw errors.badRequest('套餐不属于当前机构', 'INVALID_BILLING_PACKAGE');
    const now = nowIso(); const userId = id('user');
    q('INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,expires_at,student_usage_scope,billing_package_id,monthly_credit_allowance,period_start_at,period_reset_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [userId, currentOrgId, login, displayName, role, json(role === 'TEACHER' && Array.isArray(body.permissions) ? body.permissions : []), hashPassword(String(body.password)), 'ACTIVE', body.expiresAt || null, role === 'STUDENT' ? (body.studentUsageScope || 'HOME_PRACTICE') : null, role === 'STUDENT' ? (body.billingPackageId || null) : null, role === 'STUDENT' ? integer(body.monthlyCreditAllowance, '月度积分') : 0, now, new Date(Date.now() + 30 * 86400000).toISOString(), now, now]);
    audit(ctx, 'USER_CREATE', 'USER', userId, null, { role, login }); return normalizeUser(row('SELECT * FROM users WHERE id=?', [userId]), { includeAuthMeta: true });
  }
  let match = part.match(/^\/users\/([^/]+)$/);
  if (match && ['GET','PUT','DELETE'].includes(method)) {
    if (!hasPermission(auth, 'MANAGE_MEMBERS')) throw errors.forbidden('无账号管理权限', 'ORG_MEMBER_PERMISSION_REQUIRED'); const target = orgUser(auth, match[1]); if (method === 'GET') return normalizeUser(target, { includeAuthMeta: true });
    if (method === 'DELETE') { q('UPDATE users SET deleted_at=?,status=?,updated_at=? WHERE id=? AND org_id=?', [nowIso(), 'DISABLED', nowIso(), target.id, currentOrgId]); audit(ctx, 'USER_DELETE', 'USER', target.id); return { ok: true }; }
    const body = ctx.body || {}; if (body.billingPackageId && !row('SELECT id FROM billing_packages WHERE id=? AND org_id=?', [body.billingPackageId, currentOrgId])) throw errors.badRequest('套餐不属于当前机构', 'INVALID_BILLING_PACKAGE');
    q('UPDATE users SET display_name=COALESCE(?,display_name),phone=COALESCE(?,phone),status=COALESCE(?,status),student_usage_scope=COALESCE(?,student_usage_scope),billing_package_id=COALESCE(?,billing_package_id),monthly_credit_allowance=COALESCE(?,monthly_credit_allowance),updated_at=? WHERE id=? AND org_id=?', [body.displayName || null, body.phone || null, body.status || null, body.studentUsageScope || null, body.billingPackageId || null, body.monthlyCreditAllowance === undefined ? null : integer(body.monthlyCreditAllowance, '月度积分'), nowIso(), target.id, currentOrgId]); audit(ctx, 'USER_UPDATE', 'USER', target.id, normalizeUser(target), body); return normalizeUser(row('SELECT * FROM users WHERE id=?', [target.id]), { includeAuthMeta: true });
  }
  match = part.match(/^\/users\/([^/]+)\/(password|permissions|period-boosts)$/);
  if (match && method === 'PUT') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可操作', 'ORG_ADMIN_REQUIRED'); const target = orgUser(auth, match[1]);
    if (match[2] === 'password') { const password = String(ctx.body?.password || ''); if (password.length < 6) throw errors.badRequest('密码至少6位'); q('UPDATE users SET password_hash=?,updated_at=? WHERE id=? AND org_id=?', [hashPassword(password), nowIso(), target.id, currentOrgId]); }
    if (match[2] === 'permissions') { if (target.role !== 'TEACHER') throw errors.badRequest('只能设置教师权限', 'INVALID_ROLE'); q('UPDATE users SET permissions=?,updated_at=? WHERE id=? AND org_id=?', [json(Array.isArray(ctx.body?.permissions) ? ctx.body.permissions : []), nowIso(), target.id, currentOrgId]); }
    if (match[2] === 'period-boosts') q('UPDATE users SET month_period_boost_credits=?,updated_at=? WHERE id=? AND org_id=?', [integer(ctx.body?.bonusCredits, '额外积分'), nowIso(), target.id, currentOrgId]);
    audit(ctx, 'USER_' + match[2].toUpperCase(), 'USER', target.id, null, ctx.body); return normalizeUser(row('SELECT * FROM users WHERE id=?', [target.id]), { includeAuthMeta: true });
  }
  if (part === '/billing/packages' && method === 'GET') return { items: rows('SELECT * FROM billing_packages WHERE org_id=? ORDER BY created_at DESC', [currentOrgId]).map(normalizePackage) };
  if (part === '/billing/packages' && method === 'POST') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可创建套餐', 'ORG_ADMIN_REQUIRED'); const body = ctx.body || {}; const name = String(body.name || '').trim(); if (!name) throw errors.badRequest('套餐名称必填'); if (row('SELECT id FROM billing_packages WHERE org_id=? AND name=?', [currentOrgId, name])) throw errors.conflict('同名套餐已存在', 'BILLING_PACKAGE_EXISTS'); const capabilities = body.capabilities || {}; const packageId = id('pkg'); const now = nowIso();
    q('INSERT INTO billing_packages(id,org_id,name,price_fen,monthly_credits,bonus_credits,duration_days,allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [packageId, currentOrgId, name, integer(body.priceFen, '价格'), integer(body.monthlyCredits, '月度积分'), integer(body.bonusCredits, '赠送积分'), integer(body.durationDays, '套餐有效期', { min: 1, max: 3650, fallback: 30 }), capabilities.allowImage ? 1 : 0, capabilities.allowMusic ? 1 : 0, capabilities.allowVideo ? 1 : 0, capabilities.allowPodcast ? 1 : 0, capabilities.allowDubbing ? 1 : 0, now, now]); return normalizePackage(row('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [packageId, currentOrgId]));
  }
  let packageMatch = part.match(/^\/billing\/packages\/([^/]+)$/);
  if (packageMatch && ['GET', 'PUT'].includes(method)) {
    const target = row('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [packageMatch[1], currentOrgId]);
    if (!target) throw errors.notFound('套餐不存在', 'BILLING_PACKAGE_NOT_FOUND');
    if (method === 'GET') return normalizePackage(target);
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可修改套餐', 'ORG_ADMIN_REQUIRED');
    const body = ctx.body || {}; const capabilities = body.capabilities || {};
    const name = body.name === undefined ? target.name : String(body.name).trim();
    if (!name) throw errors.badRequest('套餐名称必填', 'PACKAGE_NAME_REQUIRED');
    let status = target.status;
    if (body.status !== undefined) {
      status = body.status;
      if (!['ACTIVE', 'DISABLED'].includes(status)) throw errors.badRequest('套餐状态无效', 'INVALID_PACKAGE_STATUS');
    }
    q('UPDATE billing_packages SET name=?,price_fen=?,monthly_credits=?,bonus_credits=?,duration_days=?,allow_image=?,allow_music=?,allow_video=?,allow_podcast=?,allow_dubbing=?,status=?,updated_at=? WHERE id=? AND org_id=?', [
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
      status, nowIso(), target.id, currentOrgId,
    ]);
    audit(ctx, 'BILLING_PACKAGE_UPDATE', 'BILLING_PACKAGE', target.id, normalizePackage(target), body);
    return normalizePackage(row('SELECT * FROM billing_packages WHERE id=? AND org_id=?', [target.id, currentOrgId]));
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
  if (part === '/billing/account-overview' && method === 'GET') {
    if (auth.user.role !== 'ORG_ADMIN') throw errors.forbidden('仅机构管理员可查看账务视图', 'ORG_BILLING_PERMISSION_DENIED');
    ensureOrgBilling(currentOrgId);
    const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [currentOrgId]);
    const orders = rows('SELECT * FROM recharge_orders WHERE org_id=? ORDER BY created_at DESC LIMIT 100', [currentOrgId]).map((order) => ({
      id: order.id, orderNo: order.order_no, packageId: order.package_id || null, amountFen: Number(order.amount_fen || 0),
      credits: Number(order.credits || 0), bonusCredits: Number(order.bonus_credits || 0), status: order.status,
      paidAt: order.paid_at || null, invoiceStatus: order.invoice_status, createdAt: order.created_at,
    }));
    const entries = rows('SELECT * FROM credit_entries WHERE org_id=? ORDER BY created_at DESC LIMIT 200', [currentOrgId]).map((entry) => ({
      id: entry.id, direction: entry.direction, type: entry.type, credits: Number(entry.credits || 0),
      balanceAfter: Number(entry.balance_after || 0), modality: entry.modality || null, model: entry.model || null,
      relatedOrderId: entry.related_order_id || null, status: entry.status, reason: entry.reason || null, createdAt: entry.created_at,
    }));
    return {
      balance: Number(account.credit_balance || 0), totalCreditsIn: Number(account.total_credits_in || 0),
      totalCreditsSpent: Number(account.total_credits_spent || 0), paidTotalFen: Number(account.currency_paid_total_fen || 0),
      pendingOrderCount: orders.filter((order) => order.status === 'PENDING').length,
      paidOrderCount: orders.filter((order) => order.status === 'PAID').length,
      orders, entries,
    };
  }
  if (part === '/billing/credit-entries' && method === 'GET') { const items = rows('SELECT * FROM credit_entries WHERE org_id=? ORDER BY created_at DESC LIMIT 200', [currentOrgId]); return { items, total: items.length }; }

  if (part === '/course-series' && method === 'GET') {
    const items = rows("SELECT DISTINCT series.* FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND assignment.status='ACTIVE' WHERE series.status='PUBLISHED' AND ((series.owner_type='PLATFORM' AND (series.visibility='ALL_ORGS' OR assignment.id IS NOT NULL)) OR (series.owner_type='ORG' AND series.org_id=?)) ORDER BY series.sort,series.title", [currentOrgId, currentOrgId]).map((series) => normalizeSeries(series, { orgId: currentOrgId, includeLessons: true }));
    return { items };
  }
  if (part === '/classes' && method === 'GET') {
    const params = [currentOrgId]; let where = 'class.org_id=?';
    if (auth.user.role === 'TEACHER') { where += ' AND class.teacher_id=?'; params.push(auth.user.id); }
    return { items: rows('SELECT class.* FROM classes class WHERE ' + where + ' ORDER BY class.created_at DESC', params).map(normalizeClass) };
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
    if (method === 'GET') { if (auth.user.role === 'TEACHER' && cls.teacher_id !== auth.user.id) throw errors.notFound('班级不存在', 'CLASS_NOT_FOUND'); return normalizeClass(cls, { detail: true }); }
    assertClassManager(auth, cls);
    if (method === 'DELETE') {
      transaction(() => { const active = row("SELECT * FROM class_sessions WHERE class_id=? AND status='ACTIVE'", [cls.id]); if (active) q("UPDATE class_sessions SET status='ENDED',ended_at=?,ended_by=?,ended_reason='CLASS_ARCHIVED' WHERE id=?", [nowIso(), auth.user.id, active.id]); q("UPDATE classes SET status='ARCHIVED',archived_at=?,current_session_id=NULL,updated_at=? WHERE id=? AND org_id=?", [nowIso(), nowIso(), cls.id, currentOrgId]); });
      audit(ctx, 'CLASS_ARCHIVE', 'CLASS', cls.id); return { ok: true };
    }
    const body = ctx.body || {}; const teacherId = body.teacherId === undefined ? cls.teacher_id : body.teacherId; validateTeacher(currentOrgId, teacherId);
    if (body.defaultSeriesId && !accessibleSeries(currentOrgId, body.defaultSeriesId)) throw errors.badRequest('默认课包未授权给当前机构', 'COURSE_NOT_AUTHORIZED');
    q('UPDATE classes SET name=COALESCE(?,name),teacher_id=?,usage_mode=COALESCE(?,usage_mode),default_series_id=?,updated_at=? WHERE id=? AND org_id=?', [body.name ? String(body.name).trim() : null, teacherId, body.usageMode || null, body.defaultSeriesId === undefined ? cls.default_series_id : body.defaultSeriesId, nowIso(), cls.id, currentOrgId]);
    return normalizeClass(row('SELECT * FROM classes WHERE id=? AND org_id=?', [cls.id, currentOrgId]));
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/curriculum$/);
  if (classMatch && method === 'GET') {
    const cls = classInOrg(auth, classMatch[1]); if (auth.user.role === 'TEACHER' && cls.teacher_id !== auth.user.id) throw errors.notFound('班级不存在', 'CLASS_NOT_FOUND');
    const items = rows('SELECT item.*,lesson.title,lesson.summary,lesson.duration_minutes FROM class_curriculum_items item JOIN course_lessons lesson ON lesson.id=item.lesson_id WHERE item.class_id=? ORDER BY item.sort', [cls.id]); return { items: items.map(curriculumItem) };
  }
  if (classMatch && method === 'PUT') {
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls); const lessonIds = Array.isArray(ctx.body?.lessonIds) ? [...new Set(ctx.body.lessonIds)] : [];
    if (lessonIds.length > 80) throw errors.badRequest('课单最多80节', 'CURRICULUM_LIMIT');
    transaction(() => { const lessons = lessonIds.map((lessonId) => { const lesson = accessibleLesson(currentOrgId, lessonId); if (!lesson) throw errors.badRequest('课时未授权或不存在', 'COURSE_NOT_AUTHORIZED'); return lesson; }); q('DELETE FROM class_curriculum_items WHERE class_id=?', [cls.id]); lessons.forEach((lesson, index) => q('INSERT INTO class_curriculum_items(id,class_id,lesson_id,sort,source_series_id,added_at) VALUES (?,?,?,?,?,?)', [id('curr'), cls.id, lesson.id, index + 1, lesson.series_id, nowIso()])); });
    return normalizeClass(row('SELECT * FROM classes WHERE id=? AND org_id=?', [cls.id, currentOrgId]), { detail: true });
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/members\/([^/]+)$/);
  if (classMatch && ['POST','DELETE'].includes(method)) {
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls, 'MANAGE_MEMBERS'); const target = orgUser(auth, classMatch[2]); if (target.role !== 'STUDENT') throw errors.badRequest('只能管理学员成员', 'INVALID_MEMBER_ROLE');
    if (method === 'POST') q('INSERT INTO class_members(id,class_id,user_id,role,joined_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING', [id('member'), cls.id, target.id, 'STUDENT', nowIso()]); else q('UPDATE class_members SET removed_at=? WHERE class_id=? AND user_id=? AND removed_at IS NULL', [nowIso(), cls.id, target.id]);
    audit(ctx, method === 'POST' ? 'CLASS_MEMBER_ADD' : 'CLASS_MEMBER_REMOVE', 'CLASS', cls.id, null, { userId: target.id }); return { ok: true };
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/start$/);
  if (classMatch && method === 'POST') {
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls); const lessonId = String(ctx.body?.lessonId || '').trim();
    if (!lessonId) throw errors.badRequest('开课必须指定课时', 'LESSON_REQUIRED');
    if (!row('SELECT id FROM class_curriculum_items WHERE class_id=? AND lesson_id=?', [cls.id, lessonId]) || !accessibleLesson(currentOrgId, lessonId)) throw errors.badRequest('课时不在本班已授权课单中', 'LESSON_NOT_ASSIGNED');
    if (row("SELECT id FROM class_sessions WHERE class_id=? AND status='ACTIVE'", [cls.id])) throw errors.conflict('当前班级已有进行中的课堂', 'CLASS_SESSION_ACTIVE');
    const cap = ctx.body?.sessionCreditCap === undefined || ctx.body?.sessionCreditCap === null ? null : integer(ctx.body.sessionCreditCap, '课堂积分上限'); const capability = ctx.body?.capabilities || {}; const sessionId = id('csession'); const now = nowIso();
    transaction(() => { q('INSERT INTO class_sessions(id,class_id,lesson_id,status,session_credit_cap,allow_image,allow_music,allow_video,allow_podcast,allow_dubbing,started_by,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [sessionId, cls.id, lessonId, 'ACTIVE', cap, capability.allowImage ? 1 : 0, capability.allowMusic ? 1 : 0, capability.allowVideo ? 1 : 0, capability.allowPodcast ? 1 : 0, capability.allowDubbing ? 1 : 0, auth.user.id, now]); q('UPDATE classes SET current_session_id=?,updated_at=? WHERE id=? AND org_id=?', [sessionId, now, cls.id, currentOrgId]); });
    audit(ctx, 'SESSION_START', 'CLASS_SESSION', sessionId, null, { classId: cls.id, lessonId }); return normalizeSession(row('SELECT * FROM class_sessions WHERE id=? AND class_id=?', [sessionId, cls.id]));
  }
  classMatch = part.match(/^\/classes\/([^/]+)\/sessions\/([^/]+)\/(end|credit-cap|capabilities)$/);
  if (classMatch && method === 'POST') {
    const cls = classInOrg(auth, classMatch[1]); assertClassManager(auth, cls); const session = row('SELECT * FROM class_sessions WHERE id=? AND class_id=?', [classMatch[2], cls.id]); if (!session) throw errors.notFound('课堂不存在', 'CLASS_SESSION_NOT_FOUND'); const action = classMatch[3];
    if (session.status !== 'ACTIVE') throw errors.conflict('课堂已结束', 'CLASS_SESSION_ENDED');
    if (action === 'end') transaction(() => { q("UPDATE class_sessions SET status='ENDED',ended_at=?,ended_by=?,ended_reason=? WHERE id=? AND class_id=? AND status='ACTIVE'", [nowIso(), auth.user.id, String(ctx.body?.reason || 'MANUAL').slice(0, 100), session.id, cls.id]); q('UPDATE classes SET current_session_id=NULL,updated_at=? WHERE id=? AND org_id=? AND current_session_id=?', [nowIso(), cls.id, currentOrgId, session.id]); });
    if (action === 'credit-cap') q("UPDATE class_sessions SET session_credit_cap=? WHERE id=? AND class_id=? AND status='ACTIVE'", [ctx.body?.sessionCreditCap === null ? null : integer(ctx.body?.sessionCreditCap, '课堂积分上限'), session.id, cls.id]);
    if (action === 'capabilities') { const capability = ctx.body?.capabilities || {}; q("UPDATE class_sessions SET allow_image=?,allow_music=?,allow_video=?,allow_podcast=?,allow_dubbing=? WHERE id=? AND class_id=? AND status='ACTIVE'", [capability.allowImage ? 1 : 0, capability.allowMusic ? 1 : 0, capability.allowVideo ? 1 : 0, capability.allowPodcast ? 1 : 0, capability.allowDubbing ? 1 : 0, session.id, cls.id]); }
    audit(ctx, 'SESSION_' + action.toUpperCase(), 'CLASS_SESSION', session.id, null, ctx.body); return normalizeSession(row('SELECT * FROM class_sessions WHERE id=? AND class_id=?', [session.id, cls.id]));
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

  if (part === '/works' && method === 'GET') {
    const params = [currentOrgId]; let where = 'work.org_id=?'; if (auth.user.role === 'TEACHER') { where += ' AND class.teacher_id=?'; params.push(auth.user.id); }
    const items = rows('SELECT work.*,student.display_name student_name,class.name class_name,lesson.title lesson_title,reviewer.display_name reviewer_name FROM works work JOIN users student ON student.id=work.student_id AND student.org_id=work.org_id LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id LEFT JOIN course_lessons lesson ON lesson.id=work.course_lesson_id LEFT JOIN users reviewer ON reviewer.id=work.reviewed_by WHERE ' + where + ' ORDER BY work.submitted_at DESC LIMIT 200', params).map((work) => normalizeWork(work, { includeSnapshot: ctx.search.get('includeSnapshot') === 'true' })); return { items };
  }
  let workMatch = part.match(/^\/works\/([^/]+)\/review$/);
  if (workMatch && method === 'PUT') {
    const work = row('SELECT work.*,class.teacher_id FROM works work LEFT JOIN classes class ON class.id=work.class_id AND class.org_id=work.org_id WHERE work.id=? AND work.org_id=?', [workMatch[1], currentOrgId]); if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND'); if (auth.user.role === 'TEACHER' && work.teacher_id !== auth.user.id) throw errors.forbidden('不能点评其他教师班级的作品', 'WORK_PERMISSION_DENIED');
    const status = ctx.body?.status; if (!['APPROVED','REJECTED','PUBLISHED'].includes(status)) throw errors.badRequest('作品状态无效', 'INVALID_WORK_STATUS'); q('UPDATE works SET status=?,teacher_comment=?,reviewed_by=?,reviewed_at=? WHERE id=? AND org_id=?', [status, String(ctx.body?.teacherComment || '').slice(0, 2000), auth.user.id, nowIso(), work.id, currentOrgId]); audit(ctx, 'WORK_REVIEW', 'WORK', work.id, null, { status }); return normalizeWork(row('SELECT * FROM works WHERE id=? AND org_id=?', [work.id, currentOrgId]));
  }
  return null;
}
