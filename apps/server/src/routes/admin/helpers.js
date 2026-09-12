import {
  audit, count, errors, id, json, normalizeClass, normalizeOrg, normalizePackage,
  normalizeLesson, normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  assignmentActiveSql, orgSeriesAccessSql, PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction, verifyPassword,
  normalizeGenerationBox, GENERATION_BOX_MATERIAL_TYPE,
} from '../../lib.js';
import { hashPassword } from '@platform/database';
import { randomUUID } from 'node:crypto';
import { adjustCredits, normalizeEntry, reconcileCredits, refundOrReverseEntry, setFrozenCredits } from '../../services/creditLedger.js';
import { scheduleReminder } from '../communication.js';
import { assertKnownState, assertTransition } from '../../services/domainState.js';
import { disableMfa, enableMfa, mfaSummary, regenerateRecoveryCodes, startMfaSetup } from '../../services/mfa.js';
import { normalizeSubmission } from '../vibecoding.js';

function ensureOrgBilling(orgId) { q('INSERT OR IGNORE INTO org_billing_accounts(org_id) VALUES (?)', [orgId]); }
function platformIssuerName() {
  const settings = row('SELECT platform_name FROM platform_settings WHERE id=1');
  return String(settings?.platform_name || '').trim() || 'AI魔法学院';
}
// 二次验证的敏感操作（关闭 / 重发恢复码）要求再输一次登录密码
function assertSelfPassword(ctx, auth, action) {
  const password = String(ctx.body?.password || '');
  if (!password) throw errors.badRequest('请输入当前密码', 'CURRENT_PASSWORD_REQUIRED');
  const me = row('SELECT * FROM users WHERE id=? AND deleted_at IS NULL', [auth.user.id]);
  if (!me) throw errors.notFound('账号不存在', 'USER_NOT_FOUND');
  if (!verifyPassword(password, me.password_hash)) throw errors.forbidden(`当前密码不正确，无法${action}`, 'CURRENT_PASSWORD_INVALID');
}
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
/**
 * 一个课时的上课类型（可多选：画布 + VibeCoding 同时开，学生端两个入口并列）。
 * 传空/非法时回退到 fallbackMode（兼容老客户端只传单值 deliveryMode 的写法）。
 * 返回值里第一种同时写回老字段 delivery_mode，保证既有读取方不受影响。
 */
function normalizeDeliveryModes(value, fallbackMode = 'CANVAS') {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  const list = [...new Set(raw
    .map((item) => String(item || '').trim().toUpperCase())
    .filter((item) => ['CANVAS', 'VIBECODING'].includes(item)))];
  return list.length ? list : [normalizeDeliveryMode(fallbackMode)];
}
/** 每学生算力上限（分）：不填 = null（不拦，只记账）；填了必须是 0~10000000 的整数 */
function normalizePerStudentBudgetFen(value) {
  if (value === undefined || value === null || value === '') return null;
  return integer(value, '每学生算力上限（分）', { min: 0, max: 10000000, fallback: null });
}
// 生成框体现在是素材表里的一种素材（material_type=GENERATION_BOX），顺序跟着素材走；
// classroom_config 只留版本号与 VibeCoding 配置。
function normalizeClassroomConfig(value) {
  const input = value && typeof value === 'object' ? value : {};
  const result = { version: 3 };
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
    `SELECT lesson.* FROM course_lessons lesson JOIN course_series series ON series.id=lesson.series_id LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql()} WHERE lesson.id=? AND lesson.status='PUBLISHED' AND series.status='PUBLISHED' AND ${orgSeriesAccessSql()}`,
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

// 生成框体素材：把「素材行的字段 + snapshot.content」当成一个框体来严格校验，
// 通过后写回 snapshot.box（模型与参数）与 snapshot.content（预填提示词）。
function normalizeBoxMaterial(material, materialIndex, title) {
  const snapshot = material?.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {};
  const raw = snapshot.box && typeof snapshot.box === 'object' ? snapshot.box : {};
  let box;
  try {
    box = normalizeGenerationBox({
      ...raw,
      title,
      assetUrl: material?.assetUrl,
      prompt: snapshot.content,
    }, { strict: true, index: materialIndex });
  } catch (error) {
    if (error?.code === 'INVALID_GENERATION_CONFIG') throw errors.badRequest(error.message, 'INVALID_GENERATION_CONFIG');
    throw error;
  }
  if (!box) throw errors.badRequest(`第 ${materialIndex + 1} 个生成框体的类型无效`, 'INVALID_GENERATION_CONFIG');
  const boxSnapshot = { modality: box.modality, model: box.model };
  // 只存平台真的选了的项：空着＝不指定，学生在画布课堂里自己选（写死默认值学生就没得选了）。
  if (box.modality === 'IMAGE' || box.modality === 'VIDEO') {
    if (box.aspectRatio) boxSnapshot.aspectRatio = box.aspectRatio;
    if (box.resolution) boxSnapshot.resolution = box.resolution;
  }
  if (box.modality === 'VIDEO') {
    if (Number.isInteger(box.durationSeconds)) boxSnapshot.durationSeconds = box.durationSeconds;
    if (box.audio === true || box.audio === false) boxSnapshot.audio = box.audio;
  }
  // 音乐：记下生成模式（歌词生音乐 / 描述生音乐）
  if (box.modality === 'MUSIC') { boxSnapshot.mode = box.mode; }
  return { ...snapshot, box: boxSnapshot, content: box.prompt };
}

/**
 * 把课包与课时的**当前内容**定格成「已发布内容」快照（草稿隔离的落点）。
 * 平台端之后继续编辑的是实时数据；机构端/学生端/官网读的是这份快照，
 * 所以「改了但没点更新发布」时它们看不到改动。
 */
function capturePublishedContent(seriesId, at = nowIso()) {
  const series = row('SELECT * FROM course_series WHERE id=?', [seriesId]);
  if (!series) return { lessons: 0 };
  const lessons = rows('SELECT * FROM course_lessons WHERE series_id=?', [seriesId]);
  transaction(() => {
    q('UPDATE course_series SET published_content=? WHERE id=?', [json({
      title: series.title, description: series.description || '', coverImageUrl: series.cover_image_url || null,
      coverAssetId: series.cover_asset_id || null, priceFen: Number(series.price_fen || 0), stockTotal: Number(series.stock_total || 0),
      difficultyLevel: series.difficulty_level == null ? null : Number(series.difficulty_level),
      visibility: series.visibility, gradeRange: series.grade_range || '', tags: parseJson(series.tags, []),
      estimatedCreditsPerPerson: Number(series.estimated_credits_per_person || 0),
    }), seriesId]);
    lessons.forEach((lessonRow) => {
      const live = normalizeLesson(lessonRow);
      q('UPDATE course_lessons SET published_content=?,published_title=? WHERE id=?', [json({
        title: live.title, summary: live.summary, durationMinutes: live.durationMinutes, lessonContent: live.lessonContent,
        deliveryMode: live.deliveryMode, deliveryModes: live.deliveryModes, perStudentBudgetFen: live.perStudentBudgetFen,
        classroomConfig: live.classroomConfig, canvasTemplateSnapshot: live.canvasTemplateSnapshot,
        capabilities: live.capabilities, materialGroups: live.materialGroups, generationBoxes: live.generationBoxes,
      }), live.title, lessonRow.id]);
    });
  });
  return { lessons: lessons.length, at };
}

function replaceLessonCanvasConfig(lessonId, materialGroups, capabilities, deliveryMode = 'CANVAS', classroomConfig = {}, canvasTemplateSnapshot = {}, extra = {}) {
  const groups = Array.isArray(materialGroups) ? materialGroups.slice(0, 50) : [];
  const caps = Array.isArray(capabilities) ? [...new Set(capabilities.map((value) => String(value).trim().toLowerCase()).filter((value) => ['text', 'image', 'video', 'music'].includes(value)))] : ['text'];
  const now = nowIso();
  // 素材/素材组的 id 保持不变：学生画布节点和 generation_jobs.box_id 都按 id 指回来，
  // 每次保存换新 id 会让「这个框体已经生成过」失效、学生端节点也认不出来。
  const existingGroupIds = new Set(rows('SELECT id FROM course_lesson_material_groups WHERE lesson_id=?', [lessonId]).map((item) => item.id));
  const existingMaterialIds = new Set(rows('SELECT id FROM course_lesson_materials WHERE group_id IN (SELECT id FROM course_lesson_material_groups WHERE lesson_id=?)', [lessonId]).map((item) => item.id));
  // 先整体校验再落库：框体素材的非法取值要在这里当场拒绝，避免写了一半。
  const prepared = groups.map((group, groupIndex) => ({
    id: existingGroupIds.has(String(group?.id || '')) ? String(group.id) : id('material-group'),
    title: String(group?.title || `素材${groupIndex + 1}`).trim().slice(0, 100) || `素材${groupIndex + 1}`,
    materials: (Array.isArray(group?.materials) ? group.materials.slice(0, 100) : []).map((material, materialIndex) => {
      const title = String(material?.title || `素材${materialIndex + 1}`).trim().slice(0, 160);
      const materialType = String(material?.materialType || 'NOTE').toUpperCase().slice(0, 30);
      const snapshot = materialType === GENERATION_BOX_MATERIAL_TYPE
        ? normalizeBoxMaterial(material, materialIndex, title)
        : (material?.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {});
      return {
        id: existingMaterialIds.has(String(material?.id || '')) ? String(material.id) : id('material'),
        title,
        description: String(material?.description || '').slice(0, 1000),
        materialType,
        assetUrl: material?.assetUrl ? String(material.assetUrl).slice(0, 2000) : null,
        snapshot,
      };
    }),
  }));
  transaction(() => {
    q('DELETE FROM course_lesson_capabilities WHERE lesson_id=?', [lessonId]);
    caps.forEach((capability) => q('INSERT INTO course_lesson_capabilities(lesson_id,capability,created_at) VALUES (?,?,?)', [lessonId, capability, now]));
    q('DELETE FROM course_lesson_materials WHERE group_id IN (SELECT id FROM course_lesson_material_groups WHERE lesson_id=?)', [lessonId]);
    q('DELETE FROM course_lesson_material_groups WHERE lesson_id=?', [lessonId]);
    prepared.forEach((group, groupIndex) => {
      q('INSERT INTO course_lesson_material_groups(id,lesson_id,title,sort,created_at,updated_at) VALUES (?,?,?,?,?,?)', [group.id, lessonId, group.title, groupIndex + 1, now, now]);
      group.materials.forEach((material, materialIndex) => {
        q('INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [material.id, group.id, material.title, material.description, material.materialType, material.assetUrl, json(material.snapshot), materialIndex + 1, now, now]);
      });
    });
    // 上课类型可多选：数组进新列，第一种同时写回老列（兼容既有读取方）
    const modes = normalizeDeliveryModes(extra.deliveryModes, deliveryMode);
    const budgetFen = normalizePerStudentBudgetFen(extra.perStudentBudgetFen);
    q('UPDATE course_lessons SET delivery_mode=?,delivery_modes=?,per_student_budget_fen=?,classroom_config=?,canvas_template_snapshot=?,updated_at=? WHERE id=?',
      [modes[0], json(modes), budgetFen, json(normalizeClassroomConfig(classroomConfig)), json(normalizeCanvasTemplateSnapshot(canvasTemplateSnapshot)), now, lessonId]);
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
    if (mode === 'VIBECODING') {
      // VibeCoding 课时没有画布框体/素材绑定，改为校验学生进课堂后能真的对话
      const capabilities = lessonCanvasConfig(lesson.id).capabilities || [];
      if (!capabilities.includes('text')) throw errors.badRequest(`VibeCoding 课时「${lesson.title}」需要开放 AI 文字能力，否则学生进入课堂后无法对话`, 'VIBECODING_TEXT_CAPABILITY_REQUIRED');
      return;
    }
    // 生成框体（素材表里 type=GENERATION_BOX 的素材）必须落在本课开放的能力里，
    // 否则学生端看不到入口、配了也没用。
    const canvas = lessonCanvasConfig(lesson.id);
    const capabilities = canvas.capabilities || [];
    canvas.materialGroups.forEach((group) => (group.materials || []).forEach((material) => {
      if (material.materialType !== GENERATION_BOX_MATERIAL_TYPE) return;
      const modality = String(material.snapshot?.box?.modality || '').toUpperCase();
      if (!capabilities.includes(modality.toLowerCase())) throw errors.badRequest(`课时「${lesson.title}」的生成框体「${material.title}」类型是 ${modality}，但本课没有开放该能力`, 'GENERATION_BOX_CAPABILITY_MISMATCH');
    }));
  });
}
function accessibleSeries(currentOrgId, seriesId) {
  return row(
    `SELECT series.* FROM course_series series LEFT JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id=? AND ${assignmentActiveSql()} WHERE series.id=? AND series.status='PUBLISHED' AND ${orgSeriesAccessSql()}`,
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
     ORDER BY annotation.created_at DESC LIMIT 500`,
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
function csvDocument(header, dataRows) {
  const lines = [header.map(escapeCsv).join(',')];
  for (const row of dataRows) lines.push(row.map(escapeCsv).join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}
function csvFileName(prefix) {
  return prefix + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
}
// 列表与导出共用同一套筛选，避免「看到的和导出的不一致」
function platformUserFilters(ctx) {
  const role = ctx.search.get('role'); const orgIdFilter = ctx.search.get('orgId'); const search = String(ctx.search.get('search') || '').trim();
  const params = []; const conditions = ['user.deleted_at IS NULL'];
  if (['SUPER_ADMIN', 'ORG_ADMIN', 'TEACHER', 'STUDENT'].includes(role)) { conditions.push('user.role=?'); params.push(role); }
  if (orgIdFilter) { conditions.push('user.org_id=?'); params.push(orgIdFilter); }
  if (search) { conditions.push('(user.login LIKE ? OR user.display_name LIKE ? OR user.phone LIKE ?)'); const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'; params.push(keyword, keyword, keyword); }
  return { where: conditions.join(' AND '), params };
}
function organizationFilters(ctx) {
  const search = String(ctx.search.get('search') || '').trim();
  const statusFilter = String(ctx.search.get('status') || '').trim();
  const conditions = []; const params = [];
  if (search) {
    conditions.push('(organization.name LIKE ? OR organization.id LIKE ?)');
    const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
    params.push(keyword, keyword);
  }
  if (['TRIAL', 'ACTIVE', 'DISABLED'].includes(statusFilter)) { conditions.push('organization.status=?'); params.push(statusFilter); }
  return { where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params };
}
function platformWorkFilters(ctx) {
  const status = ctx.search.get('status'); const orgFilter = ctx.search.get('orgId'); const search = String(ctx.search.get('search') || '').trim();
  const conditions = []; const params = [];
  if (['PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED'].includes(status)) { conditions.push('work.status=?'); params.push(status); }
  if (orgFilter) { conditions.push('work.org_id=?'); params.push(orgFilter); }
  if (search) {
    conditions.push('(work.title LIKE ? OR student.display_name LIKE ? OR organization.name LIKE ?)');
    const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
    params.push(keyword, keyword, keyword);
  }
  return { where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params };
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


export {
  ENROLLMENT_STATUSES,
  ORG_MEMBER_ROLES,
  ORG_TEACHER_PERMISSIONS,
  PAYMENT_STATUSES,
  WORK_DATA_DAYS,
  accessibleLesson,
  accessibleSeries,
  annotationRows,
  appendEnrollmentEvent,
  appendWorkDataScope,
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
  buildWorkData,
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
  maskedStudentName,
  maxTimestamp,
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
  orgWorkPublishRequestRow,
  orgWorkPublishRequestRows,
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
  capturePublishedContent,
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
  workDataDimension,
  workDataFilters,
  workInReviewScope,
  workReportInReviewScope,
  workReportRows,
  zeroWorkDataMetrics,
};
