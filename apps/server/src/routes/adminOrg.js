import {
  audit, count, errors, id, json, normalizeClass, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  assignmentActiveSql, PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction,
} from '../lib.js';
import { hashPassword } from '@platform/database';
import { randomUUID } from 'node:crypto';
import { adjustCredits, normalizeEntry, reconcileCredits, refundOrReverseEntry, setFrozenCredits } from '../services/creditLedger.js';
import { scheduleReminder } from './communication.js';
import { assertKnownState, assertTransition } from '../services/domainState.js';
import { handleTeachingTasks } from '../services/teachingTasks.js';
import { getAiProviderPolicy } from './billingConfig.js';
import { effectiveCapabilities, normalizeAspectRatio } from '../services/modelCapabilities.js';

function ensureOrgBilling(orgId) { q('INSERT OR IGNORE INTO org_billing_accounts(org_id) VALUES (?)', [orgId]); }
function integer(value, label, { min = 0, max = 1000000, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw errors.badRequest(label + '必须是有效整数', 'VALIDATION_ERROR');
  return n;
}
function normalizeDeliveryMode(value) {
  const mode = String(value || 'CANVAS').trim().toUpperCase();
  if (!['CANVAS', 'VIBECODING'].includes(mode)) throw errors.badRequest('课堂类型只能是画布课堂或 VibeCoding 课堂', 'INVALID_DELIVERY_MODE');
  return mode;
}
// 生成参数：比例 / 清晰度 / 时长 / 音频，取值必须落在该模型声明（或模态默认）的能力范围内。
function classroomCapabilities(modality, modelId) {
  const policy = getAiProviderPolicy();
  const channelId = policy?.modalityChannels?.[modality];
  const channel = Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === channelId) : null;
  const model = String(modelId || '').trim() || String(channel?.model || '').trim();
  return effectiveCapabilities(channel, modality, model);
}
function pickCapability(value, allowed, label, fallback) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (allowed.length && !allowed.includes(text)) throw errors.badRequest(`${label}「${text}」不在当前模型支持范围内（可用：${allowed.join('、')}）`, 'INVALID_GENERATION_CONFIG');
  return text;
}
function normalizeClassroomConfig(value) {
  const input = value && typeof value === 'object' ? value : {};
  const source = input.generationSlots && typeof input.generationSlots === 'object' ? input.generationSlots : {};
  const normalizeSlot = (key, modality, defaults) => {
    const raw = source[key] && typeof source[key] === 'object' ? source[key] : {};
    const count = integer(raw.count, `${key} 生成框体数量`, { min: 0, max: 20, fallback: defaults.count });
    const model = String(raw.model || '').trim().slice(0, 120) || null;
    const capabilities = classroomCapabilities(modality, model);
    // 留空时回落到该模型支持的第一个取值，避免默认值恰好不被该模型支持。
    const submittedRatio = normalizeAspectRatio(raw.aspectRatio);
    const aspectRatio = submittedRatio
      ? pickCapability(submittedRatio, capabilities.aspectRatios, `${key} 生成比例`, submittedRatio)
      : (capabilities.aspectRatios[0] || defaults.aspectRatio);
    const submittedResolution = String(raw.resolution ?? '').trim();
    const resolution = submittedResolution
      ? pickCapability(submittedResolution, capabilities.resolutions, `${key} 清晰度`, submittedResolution)
      : (capabilities.resolutions[0] || defaults.resolution);
    if (key === 'video') {
      const submittedDuration = raw.durationSeconds === undefined || raw.durationSeconds === '' ? null : integer(raw.durationSeconds, '视频时长', { min: 1, max: 600 });
      const durationSeconds = submittedDuration === null ? (capabilities.durations[0] || defaults.durationSeconds) : submittedDuration;
      if (capabilities.durations.length && !capabilities.durations.includes(durationSeconds)) {
        throw errors.badRequest(`视频时长「${durationSeconds}秒」不在当前模型支持范围内（可用：${capabilities.durations.join('、')}秒）`, 'INVALID_GENERATION_CONFIG');
      }
      // 模型不支持生成音频时，勾选也按关闭处理。
      return { count, aspectRatio, resolution, durationSeconds, model, audio: raw.audio === true && capabilities.audio === true };
    }
    return { count, aspectRatio, resolution, model };
  };
  const result = {
    version: 1,
    generationSlots: {
      image: normalizeSlot('image', 'IMAGE', { count: 0, aspectRatio: '16:9', resolution: '1k' }),
      video: normalizeSlot('video', 'VIDEO', { count: 0, aspectRatio: '16:9', resolution: '480p', durationSeconds: 5 }),
    },
  };
  if (input.vibeCoding && typeof input.vibeCoding === 'object') result.vibeCoding = input.vibeCoding;
  return result;
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
// 班级的日常教务由教师负责，不要求机构管理员额外授予账号管理权限。
// 仍然沿用 teacherCanAccessClass，确保教师只能操作本人负责或被授权的班级。
function assertTeachingClassManager(auth, cls) {
  if (auth.user.role === 'ORG_ADMIN') return;
  if (auth.user.role === 'TEACHER' && teacherCanAccessClass(auth, cls)) return;
  throw errors.forbidden('无班级教务权限', 'CLASS_PERMISSION_DENIED');
}
function accessibleLesson(currentOrgId, lessonId) {
  return row(
    `SELECT lesson.* FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql()} WHERE lesson.id=? AND lesson.status='PUBLISHED' AND series.status='PUBLISHED' AND ((series.owner_type='PLATFORM' AND (series.visibility='ALL_ORGS' OR assignment.id IS NOT NULL)) OR (series.owner_type='ORG' AND series.org_id=?))`,
    [currentOrgId, lessonId, currentOrgId],
  );
}
function normalizeCanvasTemplateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.slice(0, 50) : [];
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges.slice(0, 100) : [];
  const viewport = snapshot.viewport && typeof snapshot.viewport === 'object'
    ? { x: Number(snapshot.viewport.x) || 0, y: Number(snapshot.viewport.y) || 0, zoom: Number(snapshot.viewport.zoom) || 1 }
    : { x: 0, y: 0, zoom: 1 };
  return { nodes, edges, viewport };
}

function replaceLessonCanvasConfig(lessonId, materialGroups, capabilities, deliveryMode = 'CANVAS', classroomConfig = {}, canvasTemplateSnapshot = {}) {
  const groups = Array.isArray(materialGroups) ? materialGroups.slice(0, 50) : [];
  const caps = Array.isArray(capabilities) ? [...new Set(capabilities.map((value) => String(value).trim().toLowerCase()).filter((value) => ['text', 'image', 'video', 'music', 'podcast', 'dubbing'].includes(value)))] : ['text'];
  const now = nowIso();
  transaction(() => {
    q('DELETE FROM course_lesson_capabilities WHERE lesson_id=?', [lessonId]);
    caps.forEach((capability) => q('INSERT INTO course_lesson_capabilities(lesson_id,capability,created_at) VALUES (?,?,?)', [lessonId, capability, now]));
    q('DELETE FROM course_lesson_materials WHERE group_id IN (SELECT id FROM course_lesson_material_groups WHERE lesson_id=?)', [lessonId]);
    q('DELETE FROM course_lesson_material_groups WHERE lesson_id=?', [lessonId]);
    groups.forEach((group, groupIndex) => {
      const groupId = id('material-group');
      const title = String(group?.title || `素材${groupIndex + 1}`).trim().slice(0, 100) || `素材${groupIndex + 1}`;
      q('INSERT INTO course_lesson_material_groups(id,lesson_id,title,sort,created_at,updated_at) VALUES (?,?,?,?,?,?)', [groupId, lessonId, title, groupIndex + 1, now, now]);
      const materials = Array.isArray(group?.materials) ? group.materials.slice(0, 100) : [];
      materials.forEach((material, materialIndex) => {
        const materialId = id('material');
        q('INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [materialId, groupId, String(material?.title || `素材${materialIndex + 1}`).trim().slice(0, 160), String(material?.description || '').slice(0, 1000), String(material?.materialType || 'NOTE').toUpperCase().slice(0, 30), material?.assetUrl ? String(material.assetUrl).slice(0, 2000) : null, json(material?.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {}), materialIndex + 1, now, now]);
      });
    });
    q('UPDATE course_lessons SET delivery_mode=?,classroom_config=?,canvas_template_snapshot=?,updated_at=? WHERE id=?', [normalizeDeliveryMode(deliveryMode), json(normalizeClassroomConfig(classroomConfig)), json(normalizeCanvasTemplateSnapshot(canvasTemplateSnapshot)), now, lessonId]);
  });
}

// 教学素材（教师备课资料）：整组替换，不影响学生画布素材。
function replaceLessonTeachingMaterials(lessonId, groups) {
  const list = Array.isArray(groups) ? groups.slice(0, 50) : [];
  const now = nowIso();
  transaction(() => {
    q('DELETE FROM course_lesson_teaching_assets WHERE group_id IN (SELECT id FROM course_lesson_teaching_groups WHERE lesson_id=?)', [lessonId]);
    q('DELETE FROM course_lesson_teaching_groups WHERE lesson_id=?', [lessonId]);
    list.forEach((group, groupIndex) => {
      const groupId = id('teaching-group');
      const title = String(group?.title || `教学素材${groupIndex + 1}`).trim().slice(0, 100) || `教学素材${groupIndex + 1}`;
      q('INSERT INTO course_lesson_teaching_groups(id,lesson_id,title,sort,created_at,updated_at) VALUES (?,?,?,?,?,?)', [groupId, lessonId, title, groupIndex + 1, now, now]);
      const assets = Array.isArray(group?.assets) ? group.assets.slice(0, 100) : [];
      assets.forEach((asset, assetIndex) => {
        const assetId = id('teaching-asset');
        q('INSERT INTO course_lesson_teaching_assets(id,group_id,title,description,asset_type,asset_url,file_asset_id,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [
          assetId, groupId, String(asset?.title || `素材${assetIndex + 1}`).trim().slice(0, 160),
          String(asset?.description || '').slice(0, 1000), String(asset?.assetType || 'FILE').toUpperCase().slice(0, 30),
          asset?.assetUrl ? String(asset.assetUrl).slice(0, 2000) : null, asset?.fileAssetId ? String(asset.fileAssetId).slice(0, 100) : null,
          assetIndex + 1, now, now,
        ]);
      });
    });
  });
}

function validateSeriesForPublishing(seriesId) {
  const lessons = rows('SELECT * FROM course_lessons WHERE series_id=? ORDER BY sort, created_at', [seriesId]);
  const activeLessons = lessons.filter((lesson) => lesson.status !== 'ARCHIVED');
  if (!activeLessons.length) throw errors.badRequest('课包至少需要一个未归档课时才能发布', 'COURSE_LESSONS_REQUIRED');
  const unfinished = activeLessons.filter((lesson) => lesson.status !== 'PUBLISHED');
  if (unfinished.length) throw errors.badRequest(`还有 ${unfinished.length} 个课时未发布，请先完成课时配置并发布课时`, 'COURSE_LESSONS_UNPUBLISHED');
  activeLessons.forEach((lesson) => {
    const mode = normalizeDeliveryMode(lesson.delivery_mode);
    if (mode === 'VIBECODING') throw errors.conflict('VibeCoding 课堂运行时尚未完成，暂不能发布包含 VibeCoding 课时的课包', 'VIBECODING_RUNTIME_NOT_READY');
    const config = normalizeClassroomConfig(parseJson(lesson.classroom_config, {}));
    const canvas = lessonCanvasConfig(lesson.id);
    const imageCount = config.generationSlots.image.count;
    const videoCount = config.generationSlots.video.count;
    canvas.materialGroups.forEach((group) => (group.materials || []).forEach((material) => {
      const action = material.snapshot?.insertAction;
      if (!action || !action.targetNodeType) return;
      const limit = action.targetNodeType === 'image' ? imageCount : action.targetNodeType === 'video' ? videoCount : 1;
      const index = Number(action.targetIndex || 0);
      if (!Number.isInteger(index) || index < 0 || index >= limit) throw errors.badRequest(`课时「${lesson.title}」存在未绑定到有效框体的素材「${material.title}」`, 'INVALID_MATERIAL_BINDING');
    }));
  });
}
function accessibleSeries(currentOrgId, seriesId) {
  return row(
    `SELECT series.* FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql()} WHERE series.id=? AND series.status='PUBLISHED' AND ((series.owner_type='PLATFORM' AND (series.visibility='ALL_ORGS' OR assignment.id IS NOT NULL)) OR (series.owner_type='ORG' AND series.org_id=?))`,
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
  let aiCreditLimit = null;
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
  if (item.aiCreditLimit !== undefined && item.aiCreditLimit !== null && item.aiCreditLimit !== '') { try { aiCreditLimit = integer(item.aiCreditLimit, 'AI 积分上限', { max: 100000000 }); } catch (error) { errorsForRow.push(error.message); } }
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
      aiCreditLimit,
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
  q('INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,phone,status,expires_at,student_usage_scope,billing_package_id,monthly_credit_allowance,ai_credit_limit,period_start_at,period_reset_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [userId, currentOrgId, value.login, value.displayName, value.role, json(value.permissions), hashPassword(value.password), value.phone, 'ACTIVE', value.expiresAt, value.studentUsageScope, value.billingPackageId, value.monthlyCreditAllowance, value.aiCreditLimit, now, new Date(Date.now() + 30 * 86400000).toISOString(), now, now]);
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
function platformAdminPermissions(value) {
  const items = Array.isArray(value) ? value : [];
  if (items.some((item) => typeof item !== 'string' || !PLATFORM_ADMIN_PERMISSIONS.includes(item))) throw errors.badRequest('包含无效的平台权限码', 'INVALID_ADMIN_PERMISSION');
  return [...new Set(items)];
}
function hasAnyPlatformPermission(value) {
  const permissions = Array.isArray(value) ? value : [];
  return permissions.includes('*') || permissions.some((item) => PLATFORM_ADMIN_PERMISSIONS.includes(item));
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
  const courseAssignments = rows(`SELECT assignment.id, assignment.series_id, assignment.status, assignment.assigned_at, assignment.expires_at, series.title AS series_title
    FROM course_assignments assignment JOIN course_series series ON series.id=assignment.series_id
    WHERE assignment.org_id=? ORDER BY assignment.assigned_at DESC LIMIT 100`, [organization.id]).map((item) => ({
    id: item.id, seriesId: item.series_id, title: item.series_title, status: item.status, assignedAt: item.assigned_at,
    expiresAt: item.expires_at || null, expired: Boolean(item.expires_at) && new Date(item.expires_at).getTime() <= Date.now(),
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
      currencyPaidTotalFen: Number(account?.currency_paid_total_fen || 0),
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
  const platformPermission = platformPermissionForPathname(pathname);
  if (platformPermission) requirePlatformPermission(ctx, platformPermission);
  const part = pathname.slice('/api/admin'.length) || '/';
  if (part === '/audit-logs' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const q = auditQuery(ctx);
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    // 审计列表固定按时间倒序；返回 sort 元数据保持十类列表协议一致。
    const sort = 'created';
    const total = Number(row('SELECT COUNT(*) n FROM audit_logs WHERE ' + q.where.replace(/audit\./g, ''), q.params)?.n || 0);
    const items = rows(auditListQuery(q.where) + ' LIMIT ? OFFSET ?', [...q.params, limit, (page - 1) * limit]).map(auditRow);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
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
    const statusFilter = String(ctx.search.get('status') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 100 });
    const sortKey = String(ctx.search.get('sort') || 'created').trim();
    const sort = Object.hasOwn({ created: true, name: true, expires: true }, sortKey) ? sortKey : 'created';
    const sortSql = {
      created: 'organization.created_at DESC, organization.id DESC',
      name: 'organization.name COLLATE NOCASE ASC, organization.id DESC',
      expires: 'organization.contract_expires_at ASC, organization.id DESC',
    }[sort];
    const conditions = []; const params = [];
    if (search) {
      conditions.push('(organization.name LIKE ? OR organization.id LIKE ?)');
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      params.push(keyword, keyword);
    }
    if (['TRIAL', 'ACTIVE', 'DISABLED'].includes(statusFilter)) { conditions.push('organization.status=?'); params.push(statusFilter); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = Number(row('SELECT COUNT(*) n FROM organizations organization' + where, params)?.n || 0);
    const items = rows('SELECT organization.* FROM organizations organization' + where + ' ORDER BY ' + sortSql + ' LIMIT ? OFFSET ?', [...params, limit, (page - 1) * limit]).map(normalizeOrg);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
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
    const amountFen = ctx.body?.amountFen !== undefined ? integer(ctx.body.amountFen, '付款金额（分）', { min: 0, max: 1000000000 }) : null;
    const paymentMethod = ctx.body?.paymentMethod ? String(ctx.body.paymentMethod).trim().slice(0, 50) : null;
    const paymentReference = ctx.body?.paymentReference ? String(ctx.body.paymentReference).trim().slice(0, 100) : null;
    let reasonText = String(ctx.body?.reason || '平台调整').slice(0, 300);
    if (credits > 0 && (amountFen || paymentMethod || paymentReference)) {
      const parts = ['线下充值'];
      if (amountFen) parts.push(`金额：¥${(amountFen / 100).toFixed(2)}`);
      if (paymentMethod) parts.push(`方式：${paymentMethod}`);
      if (paymentReference) parts.push(`订单号：${paymentReference}`);
      if (ctx.body?.reason) parts.push(`备注：${ctx.body.reason}`);
      reasonText = parts.join('，');
    }
    ensureOrgBilling(organization.id);
    const balanceAfter = transaction(() => {
      const account = row('SELECT * FROM org_billing_accounts WHERE org_id=?', [organization.id]); const balance = Number(account.credit_balance) + credits;
      if (balance < 0) throw errors.badRequest('机构积分余额不足', 'INSUFFICIENT_CREDITS');
      const updateCreditsIn = credits > 0 ? Math.abs(credits) : 0;
      if (credits > 0 && amountFen) {
        q('UPDATE org_billing_accounts SET credit_balance=?,total_credits_in=total_credits_in+?,currency_paid_total_fen=currency_paid_total_fen+?,updated_version=updated_version+1 WHERE org_id=?', [balance, updateCreditsIn, amountFen, organization.id]);
      } else {
        q('UPDATE org_billing_accounts SET credit_balance=?,total_credits_in=total_credits_in+?,updated_version=updated_version+1 WHERE org_id=?', [balance, updateCreditsIn, organization.id]);
      }
      q('INSERT INTO credit_entries(id,org_id,direction,type,credits,balance_after,status,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [id('credit'), organization.id, credits > 0 ? 'IN' : 'OUT', 'PLATFORM_ADJUSTMENT', Math.abs(credits), balance, 'EFFECTIVE', reasonText, auth.user.id, nowIso()]);
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

  if (part === '/course-series' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const search = String(ctx.search.get('search') || '').trim();
    const statusFilter = String(ctx.search.get('status') || '').trim();
    const visibilityFilter = String(ctx.search.get('visibility') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 200, fallback: 50 });
    const sortKey = String(ctx.search.get('sort') || 'manual').trim();
    const sort = Object.hasOwn({ manual: true, created: true, updated: true, title: true }, sortKey) ? sortKey : 'manual';
    const sortSql = {
      manual: 'series.sort ASC, series.title COLLATE NOCASE ASC, series.id DESC',
      created: 'series.created_at DESC, series.id DESC',
      updated: 'series.updated_at DESC, series.id DESC',
      title: 'series.title COLLATE NOCASE ASC, series.id DESC',
    }[sort];
    const conditions = []; const params = [];
    if (search) {
      conditions.push('(series.title LIKE ? OR series.id LIKE ?)');
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      params.push(keyword, keyword);
    }
    if (['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(statusFilter)) { conditions.push('series.status=?'); params.push(statusFilter); }
    if (['ALL_ORGS', 'ASSIGNED_ORGS', 'PRIVATE'].includes(visibilityFilter)) { conditions.push('series.visibility=?'); params.push(visibilityFilter); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = Number(row('SELECT COUNT(*) n FROM course_series series' + where, params)?.n || 0);
    const items = rows('SELECT series.* FROM course_series series' + where + ' ORDER BY ' + sortSql + ' LIMIT ? OFFSET ?', [...params, limit, (page - 1) * limit]).map((item) => normalizeSeries(item));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }
  if (part === '/course-series' && method === 'POST') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']); const body = ctx.body || {}; const title = String(body.title || '').trim();
    if (!title) throw errors.badRequest('课包标题不能为空', 'COURSE_TITLE_REQUIRED');
    if (title.length > 200) throw errors.badRequest('课包标题不能超过200个字符', 'VALIDATION_ERROR');
    const visibility = body.visibility || 'ALL_ORGS'; const status = body.status || 'DRAFT';
     const priceFen = integer(body.priceFen, '课程包价格（分）', { min: 0, max: 1000000000, fallback: 0 });
     const estimatedCreditsPerPerson = integer(body.estimatedCreditsPerPerson, '预估积分/人', { min: 0, max: 1000000000, fallback: 0 });
     const gradeRange = String(body.gradeRange || '').trim().slice(0, 100);
     const coverImageUrl = body.coverImageUrl ? String(body.coverImageUrl).trim().slice(0, 2000) : null;
     // 封面可以是外链 HTTPS，也可以是平台自己上传后返回的 /api/... 相对地址。
     if (coverImageUrl && !/^(https:\/\/|\/api\/)/.test(coverImageUrl)) throw errors.badRequest('封面地址必须是 HTTPS 链接或平台上传地址', 'INVALID_COVER_URL');
     const coverAssetId = body.coverAssetId ? String(body.coverAssetId).trim() : null;
     if (coverAssetId && !coverAssetId.startsWith('file_')) throw errors.badRequest('封面资源 ID 格式无效', 'INVALID_COVER_ASSET_ID');
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
    const seriesId = id('series');
    const now = nowIso();
    const seriesDeliveryMode = normalizeDeliveryMode(body.deliveryMode);
    const createdLessonIds = [];
    transaction(() => {
      q('INSERT INTO course_series(id,title,description,cover_image_url,cover_asset_id,price_fen,estimated_credits_per_person,grade_range,owner_type,org_id,visibility,version,sort,status,difficulty_level,age_range_min,age_range_max,tags,delivery_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [seriesId, title, String(body.description || '').slice(0, 10000), coverImageUrl, coverAssetId, priceFen, estimatedCreditsPerPerson, gradeRange, 'PLATFORM', null, visibility, String(body.version || '1.0').slice(0, 100), integer(body.sort, '课包排序', { min: 0, max: 100000, fallback: 0 }), status, difficultyLevel != null ? Number(difficultyLevel) : null, ageRangeMin, ageRangeMax, JSON.stringify(tags), seriesDeliveryMode, now, now]);
      lessons.forEach((lesson, index) => {
        const lessonTitle = String(lesson?.title || '').trim();
        if (!lessonTitle) throw errors.badRequest(`第${index + 1}课标题不能为空`, 'LESSON_TITLE_REQUIRED');
        if (lessonTitle.length > 200) throw errors.badRequest(`第${index + 1}课标题不能超过200个字符`, 'VALIDATION_ERROR');
        const lessonStatus = status === 'ARCHIVED' ? 'ARCHIVED' : (lesson.status || 'DRAFT');
        if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(lessonStatus)) throw errors.badRequest(`第${index + 1}课状态无效`, 'INVALID_LESSON_STATUS');
         const lessonId = id('lesson'); const deliveryMode = normalizeDeliveryMode(lesson.deliveryMode || seriesDeliveryMode); const classroomConfig = normalizeClassroomConfig(lesson.classroomConfig);
         q('INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,delivery_mode,classroom_config,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [lessonId, seriesId, lessonTitle, String(lesson.summary || '').slice(0, 10000), index + 1, lessonStatus, integer(lesson.durationMinutes, '课时时长', { min: 1, max: 1440, fallback: 45 }), String(lesson.lessonContent || '').slice(0, 50000), deliveryMode, json(classroomConfig), now, now]);
         createdLessonIds.push({ id: lessonId, materialGroups: lesson.materialGroups, capabilities: lesson.capabilities, deliveryMode, classroomConfig, canvasTemplateSnapshot: lesson.canvasTemplateSnapshot });
      });
    });
     createdLessonIds.forEach((lesson) => replaceLessonCanvasConfig(lesson.id, lesson.materialGroups || [], lesson.capabilities || ['text'], lesson.deliveryMode, lesson.classroomConfig, lesson.canvasTemplateSnapshot));
    audit(ctx, 'COURSE_SERIES_CREATE', 'COURSE_SERIES', seriesId, null, { title, lessonCount: lessons.length });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [seriesId]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
  }
  let seriesDetailMatch = part.match(/^\/course-series\/([^/]+)\/detail$/);
  if (seriesDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesDetailMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const assignedOrgs = rows('SELECT assignment.id, assignment.org_id, assignment.assigned_at, assignment.expires_at, organization.name org_name FROM course_assignments assignment JOIN organizations organization ON organization.id=assignment.org_id WHERE assignment.series_id=? AND assignment.status=\'ACTIVE\' ORDER BY assignment.assigned_at DESC', [series.id]).map((item) => ({ id: item.id, orgId: item.org_id, orgName: item.org_name, assignedAt: item.assigned_at, expiresAt: item.expires_at || null, expired: Boolean(item.expires_at) && new Date(item.expires_at).getTime() <= Date.now() }));
    const usage = {
      classesUsingSeries: count('SELECT COUNT(*) AS n FROM classes WHERE default_series_id=?', [series.id]),
      curriculumItems: count('SELECT COUNT(*) AS n FROM class_curriculum_items WHERE source_series_id=?', [series.id]),
      classSessions: count('SELECT COUNT(*) AS n FROM class_sessions session JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE lesson.series_id=?', [series.id]),
      studentWorks: count('SELECT COUNT(*) AS n FROM works work JOIN course_lessons lesson ON lesson.id=work.course_lesson_id WHERE lesson.series_id=?', [series.id]),
    };
    return { series: normalizeSeries(series, { includeLessons: true, includeAllLessons: true, includeTeaching: true }), assignedOrgs, usage };
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
    if (coverImageUrl && !/^(https:\/\/|\/api\/)/.test(coverImageUrl)) throw errors.badRequest('封面地址必须是 HTTPS 链接或平台上传地址', 'INVALID_COVER_URL');
    const coverAssetId = body.coverAssetId === undefined ? series.cover_asset_id : (body.coverAssetId ? String(body.coverAssetId).trim() : null);
    if (coverAssetId && !coverAssetId.startsWith('file_')) throw errors.badRequest('封面资源 ID 格式无效', 'INVALID_COVER_ASSET_ID');
     const priceFen = body.priceFen === undefined ? Number(series.price_fen || 0) : integer(body.priceFen, '课程包价格（分）', { min: 0, max: 1000000000 });
     const estimatedCreditsPerPerson = body.estimatedCreditsPerPerson === undefined ? Number(series.estimated_credits_per_person || 0) : integer(body.estimatedCreditsPerPerson, '预估积分/人', { min: 0, max: 1000000000 });
     const gradeRange = body.gradeRange === undefined ? (series.grade_range || '') : String(body.gradeRange || '').trim().slice(0, 100);
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
    // 未提交的字段回落到库里现值，避免 undefined 直接绑定到 SQLite 参数。
    const ageRangeMin = body.ageRangeMin === null ? null : (body.ageRangeMin !== undefined ? integer(body.ageRangeMin, '适学年龄下限', { min: 3, max: 99 }) : (series.age_range_min ?? null));
    const ageRangeMax = body.ageRangeMax === null ? null : (body.ageRangeMax !== undefined ? integer(body.ageRangeMax, '适学年龄上限', { min: 3, max: 99 }) : (series.age_range_max ?? null));
    if (ageRangeMin !== null && ageRangeMax !== null && ageRangeMin > ageRangeMax) throw errors.badRequest('年龄下限不能大于年龄上限', 'INVALID_AGE_RANGE');
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
    const deliveryMode = body.deliveryMode === undefined ? undefined : normalizeDeliveryMode(body.deliveryMode);
     q('UPDATE course_series SET title=?,description=?,cover_image_url=?,cover_asset_id=?,price_fen=?,estimated_credits_per_person=?,grade_range=?,visibility=?,sort=?,version=?,difficulty_level=?,age_range_min=?,age_range_max=?,tags=?,delivery_mode=?,updated_at=? WHERE id=?', [title, description, coverImageUrl, coverAssetId, priceFen, estimatedCreditsPerPerson, gradeRange, visibility, sort, version, difficultyLevel != null ? Number(difficultyLevel) : (difficultyLevel === null ? null : series.difficulty_level), ageRangeMin, ageRangeMax, tags != null ? JSON.stringify(tags) : series.tags, deliveryMode ?? series.delivery_mode, nowIso(), series.id]);
    const after = normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]));
    audit(ctx, 'COURSE_SERIES_UPDATE', 'COURSE_SERIES', series.id, { difficultyLevel: before.difficultyLevel, ageRangeMin: before.ageRangeMin, ageRangeMax: before.ageRangeMax, tags: before.tags }, { difficultyLevel: difficultyLevel != null ? Number(difficultyLevel) : null, ageRangeMin, ageRangeMax, tags });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
  }

  // 删除平台课包：仅当没有任何班级/课单/课堂/作品引用时才允许，否则引导改用「下架」。
  if (seriesEditMatch && method === 'DELETE') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=? AND owner_type='PLATFORM'", [seriesEditMatch[1]]);
    if (!series) throw errors.notFound('平台课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const refs = {
      classes: count('SELECT COUNT(*) AS n FROM classes WHERE default_series_id=?', [series.id]),
      curriculumItems: count('SELECT COUNT(*) AS n FROM class_curriculum_items WHERE source_series_id=?', [series.id]),
      sessions: count('SELECT COUNT(*) AS n FROM class_sessions session JOIN course_lessons lesson ON lesson.id=session.lesson_id WHERE lesson.series_id=?', [series.id]),
      works: count('SELECT COUNT(*) AS n FROM works work JOIN course_lessons lesson ON lesson.id=work.course_lesson_id WHERE lesson.series_id=?', [series.id]),
    };
    const blocked = refs.classes || refs.curriculumItems || refs.sessions || refs.works;
    if (blocked) {
      throw errors.badRequest(`该课包已被引用（班级 ${refs.classes} 处、课单 ${refs.curriculumItems} 处、课堂 ${refs.sessions} 场、作品 ${refs.works} 件），不能删除；请改用「下架」`, 'COURSE_SERIES_IN_USE');
    }
    const before = normalizeSeries(series, { includeLessons: true, includeAllLessons: true, includeTeaching: true });
    transaction(() => {
      q('DELETE FROM course_assignments WHERE series_id=?', [series.id]);
      q('DELETE FROM course_series WHERE id=?', [series.id]);
    });
    audit(ctx, 'COURSE_SERIES_DELETE', 'COURSE_SERIES', series.id, before, { deleted: true }, {});
    return { deleted: true, id: series.id };
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
    if (transition.requireLessons) validateSeriesForPublishing(series.id);
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
    const now = nowIso(); const replaceQueue = [];
    transaction(() => {
      lessons.forEach((lesson, index) => {
        const lessonTitle = String(lesson?.title || '').trim();
        if (!lessonTitle || lessonTitle.length > 200) throw errors.badRequest('第' + (index + 1) + '课标题不能为空且不超过200字', 'LESSON_TITLE_REQUIRED');
        const lessonStatus = lesson.status || 'DRAFT';
        if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(lessonStatus)) throw errors.badRequest('第' + (index + 1) + '课状态无效', 'INVALID_LESSON_STATUS');
        const lessonId = id('lesson');
        const deliveryMode = normalizeDeliveryMode(lesson.deliveryMode || series.delivery_mode);
        const classroomConfig = normalizeClassroomConfig(lesson.classroomConfig);
        q('INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,delivery_mode,classroom_config,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [lessonId, series.id, lessonTitle, String(lesson.summary || '').slice(0, 10000), maxSort + index + 1, lessonStatus, integer(lesson.durationMinutes, '课时时长', { min: 1, max: 1440, fallback: 45 }), String(lesson.lessonContent || '').slice(0, 50000), deliveryMode, json(classroomConfig), now, now]);
        replaceQueue.push({ id: lessonId, lesson, deliveryMode, classroomConfig });
      });
      q('UPDATE course_series SET version=?,updated_at=? WHERE id=?', [bumpSeriesVersion(series.version), now, series.id]);
    });
    replaceQueue.forEach((item) => replaceLessonCanvasConfig(item.id, item.lesson.materialGroups || [], item.lesson.capabilities || ['text'], item.deliveryMode, item.classroomConfig, item.lesson.canvasTemplateSnapshot));
    audit(ctx, 'COURSE_LESSON_CREATE', 'COURSE_SERIES', series.id, null, { count: lessons.length, titles: lessons.map((lesson) => String(lesson?.title || '').trim()) });
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
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
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [series.id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
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
      allowSameState: true,
    });
    const lessonContent = body.lessonContent === undefined ? lesson.lesson_content : String(body.lessonContent).slice(0, 50000);
     const deliveryMode = body.deliveryMode === undefined ? (lesson.delivery_mode || 'CANVAS') : normalizeDeliveryMode(body.deliveryMode);
     const classroomConfig = body.classroomConfig === undefined ? parseJson(lesson.classroom_config, {}) : normalizeClassroomConfig(body.classroomConfig);
    q('UPDATE course_lessons SET title=?,summary=?,duration_minutes=?,status=?,lesson_content=?,delivery_mode=?,classroom_config=?,updated_at=? WHERE id=?', [title, summary, durationMinutes, status, lessonContent, deliveryMode, json(classroomConfig), nowIso(), lesson.id]);
    if (body.materialGroups !== undefined || body.capabilities !== undefined || body.deliveryMode !== undefined || body.classroomConfig !== undefined || body.canvasTemplateSnapshot !== undefined) {
      const currentCanvas = lessonCanvasConfig(lesson.id);
      replaceLessonCanvasConfig(lesson.id, body.materialGroups ?? currentCanvas.materialGroups, body.capabilities ?? currentCanvas.capabilities, deliveryMode, classroomConfig, body.canvasTemplateSnapshot ?? parseJson(lesson.canvas_template_snapshot, {}));
    }
    if (body.teachingGroups !== undefined) replaceLessonTeachingMaterials(lesson.id, body.teachingGroups);
    q('UPDATE course_series SET version=?,updated_at=? WHERE id=?', [bumpSeriesVersion(row('SELECT version FROM course_series WHERE id=?', [lesson.series_id]).version), nowIso(), lesson.series_id]);
    audit(ctx, 'COURSE_LESSON_UPDATE', 'COURSE_LESSON', lesson.id, { title: lesson.title, status: lesson.status, durationMinutes: lesson.duration_minutes }, { title, status, durationMinutes, lessonContentChanged: body.lessonContent !== undefined && body.lessonContent !== lesson.lesson_content }, {});
    if (body.lessonContent !== undefined && body.lessonContent !== lesson.lesson_content) {
      audit(ctx, 'COURSE_LESSON_CONTENT_UPDATE', 'COURSE_LESSON', lesson.id, { lessonContent: lesson.lesson_content }, { lessonContent });
    }
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [lesson.series_id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
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
    return normalizeSeries(row('SELECT * FROM course_series WHERE id=?', [lesson.series_id]), { includeLessons: true, includeAllLessons: true, includeTeaching: true });
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
    // 有效期挂在「课包 → 机构」的授权上：平台课包本身不设有效期。
    const validityDays = integer(ctx.body?.validityDays, '授权有效期（天）', { min: 1, max: 3650, fallback: 365 });
    const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString();
    transaction(() => {
      assignmentOrgIds.forEach((assignmentOrgId) => {
        const existing = row('SELECT id FROM course_assignments WHERE series_id=? AND org_id=?', [series.id, assignmentOrgId]);
        if (existing) {
          assertTransition(ctx, 'courseAssignment', existing.status, 'ACTIVE', { targetType: 'COURSE_ASSIGNMENT', targetId: existing.id, before: { status: existing.status, orgId: assignmentOrgId }, allowSameState: true, code: 'INVALID_ASSIGNMENT_TRANSITION', message: '该课程授权当前状态不能启用' });
          q("UPDATE course_assignments SET status='ACTIVE',assigned_by=?,assigned_at=?,expires_at=? WHERE id=?", [auth.user.id, now, expiresAt, existing.id]);
        }
        else q("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at,expires_at) VALUES (?,?,?,?,?,?,?)", [id('assign'), series.id, assignmentOrgId, 'ACTIVE', auth.user.id, now, expiresAt]);
      });
    });
    audit(ctx, 'COURSE_SERIES_ASSIGN', 'COURSE_SERIES', series.id, null, { orgIds: assignmentOrgIds, validityDays, expiresAt });
    return { assignedCount: assignmentOrgIds.length, validityDays, expiresAt };
  }

  // P5-M01: Marketplace management endpoints
  if (part === '/course-marketplace' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const statusFilter = String(ctx.search.get('marketplaceStatus') || ctx.search.get('status') || '').trim().toUpperCase();
    const search = String(ctx.search.get('search') || '').trim();
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    // 课程广场按审核状态优先级排序；返回 sort 元数据保持十类列表协议一致。
    const sort = 'status';
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
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }

  const marketplaceDetailMatch = part.match(/^\/course-marketplace\/([^/]+)$/);
  if (marketplaceDetailMatch && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const series = row("SELECT * FROM course_series WHERE id=?", [marketplaceDetailMatch[1]]);
    if (!series) throw errors.notFound('课包不存在', 'COURSE_SERIES_NOT_FOUND');
    const detail = normalizeSeries(series, { includeLessons: true, includeAllLessons: true, parseTags: true, includeTeaching: true });
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
    const sortKey = String(ctx.search.get('sort') || 'created').trim();
    const sort = Object.hasOwn({ created: true, name: true, status: true }, sortKey) ? sortKey : 'created';
    const sortSql = {
      created: 'user.created_at DESC, user.id DESC',
      name: 'user.display_name COLLATE NOCASE ASC, user.id DESC',
      status: 'user.status ASC, user.created_at DESC, user.id DESC',
    }[sort];
    const params = []; const conditions = ['user.deleted_at IS NULL'];
    if (['SUPER_ADMIN', 'ORG_ADMIN', 'TEACHER', 'STUDENT'].includes(role)) { conditions.push('user.role=?'); params.push(role); }
    if (orgIdFilter) { conditions.push('user.org_id=?'); params.push(orgIdFilter); }
    if (search) { conditions.push('(user.login LIKE ? OR user.display_name LIKE ? OR user.phone LIKE ?)'); const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; params.push(keyword, keyword, keyword); }
    const where = conditions.join(' AND ');
    const total = Number(row('SELECT COUNT(*) n FROM users user WHERE ' + where, params)?.n || 0);
    const items = rows(
      'SELECT user.*, organization.name organization_name, billing_package.name billing_package_name FROM users user LEFT JOIN organizations organization ON organization.id=user.org_id LEFT JOIN billing_packages billing_package ON billing_package.id=user.billing_package_id WHERE ' + where + ' ORDER BY ' + sortSql + ' LIMIT ? OFFSET ?',
      [...params, limit, (page - 1) * limit],
    ).map(platformUserRow);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
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
    const items = adminUsers.map((item) => ({ ...normalizeUser(item, { includeAuthMeta: true }), lastLoginAt: meta.get(item.id)?.lastLoginAt || null, activeSessions: meta.get(item.id)?.activeSessions || 0 }));
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
    const activeAssignments = singleNumber(`SELECT COUNT(*) n FROM course_assignments assignment WHERE ${assignmentActiveSql()} AND (?='' OR org_id=?)`, [orgFilter, orgFilter]);
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
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '每页数量', { min: 1, max: 100, fallback: 20 });
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const orgFilter = ctx.search.get('orgId'); const modality = ctx.search.get('modality'); const status = ctx.search.get('status'); const search = String(ctx.search.get('search') || '').trim();
    const startDate = String(ctx.search.get('startDate') || '').trim(); const endDate = String(ctx.search.get('endDate') || '').trim();
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw errors.badRequest('开始日期格式无效', 'INVALID_START_DATE');
    if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw errors.badRequest('结束日期格式无效', 'INVALID_END_DATE');
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const conditions = ['usage.created_at>=?']; const params = [since];
    if (startDate) { conditions.push('usage.created_at>=?'); params.push(startDate + 'T00:00:00.000Z'); }
    if (endDate) { conditions.push('usage.created_at<=?'); params.push(endDate + 'T23:59:59.999Z'); }
    if (orgFilter) { conditions.push('usage.org_id=?'); params.push(orgFilter); }
    if (modality) { conditions.push('usage.modality=?'); params.push(modality); }
    if (['SUCCESS', 'FAILED', 'BLOCKED'].includes(status)) { conditions.push('usage.status=?'); params.push(status); }
    if (search) {
      conditions.push('(organization.name LIKE ? OR user.login LIKE ? OR user.display_name LIKE ? OR project.title LIKE ? OR work.title LIKE ?)');
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      params.push(keyword, keyword, keyword, keyword, keyword);
    }
    const sortKey = String(ctx.search.get('sort') || 'created').trim();
    const sort = Object.hasOwn({ created: true, credits: true }, sortKey) ? sortKey : 'created';
    const orderBy = sort === 'credits' ? 'usage.credits_charged DESC,usage.created_at DESC,usage.id DESC' : 'usage.created_at DESC,usage.id DESC';
    const where = conditions.join(' AND ');
    const countFromWhere = `FROM usage_records usage JOIN organizations organization ON organization.id=usage.org_id LEFT JOIN users user ON user.id=usage.user_id AND user.org_id=usage.org_id LEFT JOIN student_projects project ON project.id=usage.project_id LEFT JOIN works work ON work.id=usage.work_id ${where ? 'WHERE ' + where : ''}`;
    const total = Number(row(`SELECT COUNT(*) n ${countFromWhere}`, params)?.n || 0);
    const offset = (page - 1) * limit;
    const items = rows(
      `SELECT usage.*,organization.name organization_name,user.login user_login,user.display_name user_name,project.title project_title,work.title work_title,session.id session_id,session.lesson_id session_lesson_id,class.id class_id,class.name class_name FROM usage_records usage JOIN organizations organization ON organization.id=usage.org_id LEFT JOIN users user ON user.id=usage.user_id AND user.org_id=usage.org_id LEFT JOIN student_projects project ON project.id=usage.project_id LEFT JOIN works work ON work.id=usage.work_id LEFT JOIN class_sessions session ON session.id=usage.class_session_id LEFT JOIN classes class ON class.id=session.class_id ${where ? 'WHERE ' + where : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((item) => ({
      id: item.id, orgId: item.org_id, organizationName: item.organization_name || null,
      userId: item.user_id, userLogin: item.user_login || null, userName: item.user_name || null,
      classSessionId: item.class_session_id || null, classId: item.class_id || null, className: item.class_name || null,
      lessonId: item.session_lesson_id || item.lesson_id || null, projectId: item.project_id || null, projectTitle: item.project_title || null,
      workId: item.work_id || null, workTitle: item.work_title || null, modality: item.modality, model: item.model,
      credits: Number(item.credits_charged || 0), inputTokens: Number(item.input_tokens || 0), outputTokens: Number(item.output_tokens || 0),
      status: item.status, failCode: item.fail_code || null, createdAt: item.created_at,
    }));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
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
  // 平台决定哪些作品进入「学生作品广场」：发布需要机构审核通过 + 学生已确认展示授权。
  platformWorkMatch = part.match(/^\/works\/([^/]+)\/plaza$/);
  if (platformWorkMatch && method === 'PUT') {
    const auth = requireRole(ctx, ['SUPER_ADMIN']);
    const work = row('SELECT * FROM works WHERE id=?', [platformWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在', 'WORK_NOT_FOUND');
    if (!Object.hasOwn(ctx.body || {}, 'published') || typeof ctx.body.published !== 'boolean') throw errors.badRequest('请选择是否发布到作品广场', 'WORK_PLAZA_FLAG_REQUIRED');
    const published = ctx.body.published;
    const now = nowIso();
    if (published) {
      if (!['APPROVED', 'PUBLISHED'].includes(work.status)) throw errors.conflict('仅机构审核通过的作品可以发布到作品广场', 'WORK_NOT_APPROVED');
      if (!work.copyright_confirmed_at) throw errors.conflict('学生尚未确认作品版权与展示授权，不能发布到作品广场', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
      let shareToken = work.share_token;
      if (!shareToken) {
        shareToken = 'wst_' + randomUUID().replace(/-/g, '').slice(0, 24);
        while (row('SELECT id FROM works WHERE share_token=?', [shareToken])) shareToken = 'wst_' + randomUUID().replace(/-/g, '').slice(0, 24);
      }
      transaction(() => {
        if (work.status !== 'PUBLISHED') {
          assertTransition(ctx, 'work', work.status, 'PUBLISHED', { targetType: 'WORK', targetId: work.id, before: normalizeWork(work), code: 'INVALID_WORK_TRANSITION', message: '当前状态不能发布到作品广场' });
        }
        q("UPDATE works SET status='PUBLISHED',is_public=1,share_token=?,reviewed_by=?,reviewed_at=? WHERE id=?", [shareToken, auth.user.id, now, work.id]);
      });
    } else {
      q('UPDATE works SET is_public=0,share_token=NULL WHERE id=?', [work.id]);
    }
    audit(ctx, published ? 'PLATFORM_WORK_PLAZA_PUBLISH' : 'PLATFORM_WORK_PLAZA_UNPUBLISH', 'WORK', work.id, { status: work.status, plazaPublished: Boolean(work.is_public) }, { status: published ? 'PUBLISHED' : work.status, plazaPublished: published }, { orgId: work.org_id });
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

export {
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
  WORK_DATA_DAYS,
  workDataFilters,
  appendWorkDataScope,
  zeroWorkDataMetrics,
  maxTimestamp,
  workDataDimension,
  buildWorkData,
  maskedStudentName,
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
};
