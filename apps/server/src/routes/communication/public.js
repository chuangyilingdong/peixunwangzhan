// 通知/物料/官网内容/线索/站内信：public 域，从 communication.js 拆出。
import {
  audit,
  errors,
  id,
  json,
  nonEmptyString,
  normalizeSeries,
  nowIso,
  parseJson,
  platformPermissionForPathname,
  q,
  requirePlatformPermission,
  requireRole,
  row,
  rows,
  transaction,
} from '../../lib.js';
import { hostname } from 'node:os';
import { assertTransition } from '../../services/domainState.js';
import { WEBSITE_CONTENT_DEFAULTS, WEBSITE_CONTENT_KEYS, websiteContentDefault } from '../../services/websiteContentDefaults.js';
import {
  LEGAL_POLICY_VERSION,
  MATERIAL_CATEGORIES,
  NOTIFICATION_KINDS,
  NOTIFICATION_ROLES,
  NOTIFICATION_SCOPES,
  WORKER_ID,
  backoffSeconds,
  bool,
  claimDispatchJobs,
  dispatchDueNotifications,
  dispatchRecipientEvent,
  effectiveNotificationStatus,
  enqueueDispatchJob,
  integer,
  listDeadLetters,
  markAllNotificationsRead,
  markJobFailed,
  markJobSucceeded,
  markNotificationRead,
  markRecipientFailed,
  materialRows,
  materialStats,
  normalizeLead,
  normalizeMaterial,
  normalizeNotification,
  normalizeTemplate,
  normalizeWebsiteContent,
  notificationAdminRows,
  notificationRecipientRows,
  notificationRecipients,
  orgId,
  releaseWorkerJobs,
  reminderInterval,
  reminderStarted,
  requeueDeadLetters,
  retryRecipient,
  runWorkerTick,
  scheduleReminder,
  scheduledPublishAt,
  scheduler,
  selectAudienceUsers,
  shutdownCommunicationWorkers,
  startNotificationWorker,
  startReminderScheduler,
  summarizeQueue,
  templateRows,
  validateAudience,
  validateKind,
  validateMaterialBody,
  validateRoles,
  validateTemplateBody,
  websiteContentDefaultEntry,
  websiteContentKey,
  websiteContentRevisions,
  websiteContentValue,
  workerInterval,
  workerStarted,
} from './helpers.js';

export function handlePublicCommunication(ctx) {
  const { pathname, method } = ctx;
  if (pathname === '/api/public/website-content' && method === 'GET') {
    const items = rows("SELECT * FROM website_contents WHERE published_content IS NOT NULL ORDER BY content_key").map((item) => normalizeWebsiteContent(item));
    return { generatedAt: nowIso(), items, byKey: Object.fromEntries(items.map((item) => [item.key, item.content])) };
  }

  const publicWebsiteKey = pathname.match(/^\/api\/public\/website-content\/([A-Za-z0-9_]+)$/);
  if (publicWebsiteKey && method === 'GET') {
    const key = websiteContentKey(publicWebsiteKey[1]);
    const item = row('SELECT * FROM website_contents WHERE content_key=? AND published_content IS NOT NULL', [key]);
    if (item) return normalizeWebsiteContent(item);
    // 尚未发布过该区块：回落到内置默认内容，官网不空窗（目前只有 COURSES 走这条）
    const fallback = websiteContentDefaultEntry(key);
    if (fallback) return fallback;
    throw errors.notFound('官网内容不存在', 'WEBSITE_CONTENT_NOT_FOUND');
  }

  // P5-W08: 公开协议元数据；正文由官网静态页展示，版本由业务 / 法务确认后替换。
  if (pathname === '/api/public/legal' && method === 'GET') {
    return { version: LEGAL_POLICY_VERSION, effectiveDate: '2026-09-03', status: 'DRAFT_PENDING_LEGAL_CONFIRMATION', documents: [{ type: 'TERMS', path: '/terms' }, { type: 'PRIVACY', path: '/privacy' }, { type: 'MINORS', path: '/minors' }] };
  }

  // P5-W02: 演示预约（公开 POST，无需认证）
  if (pathname === '/api/public/contact' && method === 'POST') {
    const body = ctx.body || {};
    const orgName = nonEmptyString(body.orgName, '机构/学校名称', { max: 200 });
    const contactName = nonEmptyString(body.contactName, '联系人', { max: 100 });
    const contactPhone = nonEmptyString(body.contactPhone, '联系电话', { max: 20 });
    if (!/^1[3-9]\d{9}$/.test(contactPhone)) {
      throw errors.badRequest('手机号格式无效', 'INVALID_PHONE_FORMAT');
    }
    const intent = body.intent ? String(body.intent).trim().slice(0, 200) : '';
    const notes = body.notes ? String(body.notes).trim().slice(0, 2000) : '';
    const legalConsentVersion = String(body.legalConsentVersion || '').trim();
    if (legalConsentVersion !== LEGAL_POLICY_VERSION) throw errors.badRequest('请先阅读并同意当前版本的协议与隐私说明', 'LEGAL_CONSENT_REQUIRED');
    const legalConsentDate = new Date(body.legalConsentAt || '');
    if (Number.isNaN(legalConsentDate.getTime())) throw errors.badRequest('协议同意时间格式无效', 'INVALID_LEGAL_CONSENT_AT');
    const legalConsentAt = legalConsentDate.toISOString();
    const leadId = id('lead');
    const now = nowIso();
    q("INSERT INTO leads(id,org_name,contact_name,contact_phone,intent,notes,status,admin_notes,created_at,updated_at,legal_consent_version,legal_consented_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [leadId, orgName, contactName, contactPhone, intent, notes, 'NEW', '', now, now, legalConsentVersion, legalConsentAt]);
    audit(ctx, 'LEAD_CREATE', 'LEAD', leadId, null, { orgName, intent, legalConsentVersion, legalConsentedAt: legalConsentAt }, { orgId: null });
    return { id: leadId, status: 'NEW', createdAt: now, legalConsentVersion, legalConsentedAt: legalConsentAt };
  }

  // P5-W04: 公开作品列表
  if (pathname === '/api/public/works' && method === 'GET') {
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 60, fallback: 20 });
    const items = rows(`
      SELECT work.id, work.title, work.description, work.canvas_snapshot,
             work.featured_at, work.submitted_at, work.share_token,
             user.display_name AS student_name,
             user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM works work
      JOIN users user ON user.id=work.student_id
      LEFT JOIN organizations organization ON organization.id=work.org_id
      WHERE work.is_public=1 AND work.status='PUBLISHED' AND work.share_token IS NOT NULL
        AND work.copyright_confirmed_at IS NOT NULL
      ORDER BY work.featured_at DESC NULLS LAST, work.submitted_at DESC
      LIMIT ?
    `, [limit]).map((row) => publicWorkRow(row));
    return { items, total: items.length };
  }

  // P5-W04: 公开作品详情
  const publicWorkMatch = pathname.match(/^\/api\/public\/works\/([\w-]+)$/);
  if (publicWorkMatch && method === 'GET') {
    const work = row(`
      SELECT work.id, work.title, work.description, work.canvas_snapshot,
             work.featured_at, work.submitted_at, work.share_token,
             user.display_name AS student_name,
             user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM works work
      JOIN users user ON user.id=work.student_id
      LEFT JOIN organizations organization ON organization.id=work.org_id
      WHERE work.share_token=? AND work.is_public=1
    `, [publicWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在或已取消公开', 'PUBLIC_WORK_NOT_FOUND');
    return publicWorkRow(work);
  }

  // 公开 VibeCoding 作品（平台把老师已通过的作品发布到作品广场后，官网可点开直接玩）
  if (pathname === '/api/public/vibecoding-works' && method === 'GET') {
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 60, fallback: 20 });
    const items = rows(`
      SELECT submission.id, submission.title, submission.description, submission.entry_file, submission.files,
             submission.featured_at, submission.submitted_at, submission.share_token,
             user.display_name AS student_name, user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM vibecoding_submissions submission
      JOIN users user ON user.id=submission.student_id
      LEFT JOIN organizations organization ON organization.id=submission.org_id
      WHERE submission.is_public=1 AND submission.status='APPROVED' AND submission.share_token IS NOT NULL
        AND submission.copyright_confirmed_at IS NOT NULL
      ORDER BY submission.featured_at DESC NULLS LAST, submission.submitted_at DESC
      LIMIT ?
    `, [limit]).map((item) => publicVibeCodingWorkRow(item));
    return { items, total: items.length };
  }
  const publicVibeCodingWorkMatch = pathname.match(/^\/api\/public\/vibecoding-works\/([\w-]+)$/);
  if (publicVibeCodingWorkMatch && method === 'GET') {
    const work = row(`
      SELECT submission.id, submission.title, submission.description, submission.entry_file, submission.files,
             submission.featured_at, submission.submitted_at, submission.share_token,
             user.display_name AS student_name, user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM vibecoding_submissions submission
      JOIN users user ON user.id=submission.student_id
      LEFT JOIN organizations organization ON organization.id=submission.org_id
      WHERE submission.share_token=? AND submission.is_public=1 AND submission.status='APPROVED'
        AND submission.copyright_confirmed_at IS NOT NULL
    `, [publicVibeCodingWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在或已取消公开', 'PUBLIC_WORK_NOT_FOUND');
    return publicVibeCodingWorkRow(work, { includeFiles: true });
  }

  // P5-W05: 公开课包列表（无需登录，只返回 PUBLISHED 且可见范围合规的课包）
  if (pathname === '/api/public/course-series' && method === 'GET') {
    const params = [];
    const wheres = ["series.status = 'PUBLISHED'", "series.visibility IN ('ALL_ORGS', 'ASSIGNED_ORGS')"];
    if (ctx.search.get('difficulty') != null) {
      wheres.push('series.difficulty_level = ?');
      params.push(Number(ctx.search.get('difficulty')));
    }
    if (ctx.search.get('ageMin') != null) {
      wheres.push('series.age_range_max IS NOT NULL AND series.age_range_max >= ?');
      params.push(Number(ctx.search.get('ageMin')));
    }
    if (ctx.search.get('ageMax') != null) {
      wheres.push('series.age_range_min IS NOT NULL AND series.age_range_min <= ?');
      params.push(Number(ctx.search.get('ageMax')));
    }
    if (ctx.search.get('tag')) {
      wheres.push('series.tags LIKE ?');
      params.push('%' + String(ctx.search.get('tag')) + '%');
    }
    const items = rows(
      `SELECT series.* FROM course_series series WHERE ${wheres.join(' AND ')} ORDER BY series.sort, series.title`,
      params,
    ).map((item) => normalizeSeries(item, { parseTags: true }));
    return { items, total: items.length };
  }

  // P5-W05: 公开课包详情
  const publicCourseDetailMatch = pathname.match(/^\/api\/public\/course-series\/([\w-]+)$/);
  if (publicCourseDetailMatch && method === 'GET') {
    const series = row(
      "SELECT * FROM course_series WHERE id=? AND status='PUBLISHED' AND visibility IN ('ALL_ORGS', 'ASSIGNED_ORGS')",
      [publicCourseDetailMatch[1]],
    );
    if (!series) throw errors.notFound('课包不存在或不可公开访问', 'COURSE_SERIES_NOT_FOUND');
    const detail = normalizeSeries(series, { includeLessons: true, parseTags: true });
    detail.lessons = (detail.lessons || []).filter((l) => l.status === 'PUBLISHED');
    // lessonContent 截断到 2000 字
    detail.lessons = detail.lessons.map((l) => ({
      ...l,
      lessonContent: l.lessonContent ? String(l.lessonContent).slice(0, 2000) : '',
    }));
    return detail;
  }

  // 课程广场：所有已发布（PUBLISHED）且对所有机构可见的平台课包自动出现，
  // 按课堂类型分为「画布课程」与「VibeCoding 课程」两类，不再需要人工上架。
  if (pathname === '/api/public/marketplace' && method === 'GET') {
    const difficulty = ctx.search.get('difficulty');
    const ageMin = ctx.search.get('ageMin');
    const ageMax = ctx.search.get('ageMax');
    const tag = ctx.search.get('tag');
    const search = ctx.search.get('search');
    const category = String(ctx.search.get('category') || '').trim().toUpperCase();
    const sort = ctx.search.get('sort') || 'popular';
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 100, fallback: 20 });
    const offset = (page - 1) * limit;
    const wheres = ["series.status='PUBLISHED'", "series.visibility='ALL_ORGS'"];
    const params = [];
    if (['CANVAS', 'VIBECODING'].includes(category)) { wheres.push('series.delivery_mode=?'); params.push(category); }
    if (difficulty != null) { wheres.push('series.difficulty_level=?'); params.push(Number(difficulty)); }
    if (ageMin != null) { wheres.push('series.age_range_max IS NOT NULL AND series.age_range_max>=?'); params.push(Number(ageMin)); }
    if (ageMax != null) { wheres.push('series.age_range_min IS NOT NULL AND series.age_range_min<=?'); params.push(Number(ageMax)); }
    if (tag) { wheres.push('series.tags LIKE ?'); params.push('%' + String(tag) + '%'); }
    if (search) { wheres.push('series.title LIKE ?'); params.push('%' + String(search) + '%'); }
    const where = wheres.join(' AND ');
    const total = Number(row('SELECT COUNT(*) n FROM course_series series WHERE ' + where, params)?.n || 0);
    const orderBy = sort === 'recent' ? 'series.created_at DESC' : 'series.sort ASC, series.title COLLATE NOCASE ASC';
    const items = rows(
      `SELECT series.*, (SELECT COUNT(*) FROM course_lessons lesson WHERE lesson.series_id=series.id AND lesson.status='PUBLISHED') lesson_count
       FROM course_series series WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((item) => {
      let tags = [];
      try { tags = item.tags ? JSON.parse(item.tags) : []; } catch { tags = []; }
      return {
        id: item.id,
        title: item.title,
        description: item.description || '',
        coverImageUrl: item.cover_image_url || null,
        difficultyLevel: item.difficulty_level != null ? Number(item.difficulty_level) : null,
        ageRangeMin: item.age_range_min != null ? Number(item.age_range_min) : null,
        ageRangeMax: item.age_range_max != null ? Number(item.age_range_max) : null,
        tags,
        lessonCount: Number(item.lesson_count || 0),
        deliveryMode: item.delivery_mode || 'CANVAS',
        marketplaceRewardCredits: Number(item.marketplace_reward_credits || 0),
      };
    });
    return { items, total, page, limit };
  }

  // P5-M02: Public marketplace detail
  const publicMarketplaceDetailMatch = pathname.match(/^\/api\/public\/marketplace\/([\w-]+)$/);
  if (publicMarketplaceDetailMatch && method === 'GET') {
    const series = row(
      "SELECT * FROM course_series WHERE id=? AND status='PUBLISHED' AND marketplace_status='APPROVED' AND visibility='ALL_ORGS'",
      [publicMarketplaceDetailMatch[1]],
    );
    if (!series) throw errors.notFound('课程不存在或暂未上架', 'MARKETPLACE_COURSE_NOT_FOUND');
    const lessons = rows(
      "SELECT id, series_id, title, summary, sort, status, duration_minutes, lesson_content, created_at, updated_at FROM course_lessons WHERE series_id=? AND status='PUBLISHED' ORDER BY sort, created_at",
      [series.id],
    ).map((l) => ({
      id: l.id,
      seriesId: l.series_id,
      title: l.title,
      summary: l.summary || '',
      sort: Number(l.sort || 0),
      status: l.status,
      durationMinutes: Number(l.duration_minutes || 0),
      lessonContent: l.lesson_content ? String(l.lesson_content).slice(0, 2000) : '',
      createdAt: l.created_at,
      updatedAt: l.updated_at,
    }));
    let tags = [];
    try { tags = series.tags ? JSON.parse(series.tags) : []; } catch { tags = []; }
    return {
      id: series.id,
      title: series.title,
      description: series.description || '',
      coverImageUrl: series.cover_image_url || null,
      ownerType: series.owner_type,
      visibility: series.visibility,
      version: series.version,
      sort: Number(series.sort || 0),
      status: series.status,
      difficultyLevel: series.difficulty_level != null ? Number(series.difficulty_level) : null,
      ageRangeMin: series.age_range_min != null ? Number(series.age_range_min) : null,
      ageRangeMax: series.age_range_max != null ? Number(series.age_range_max) : null,
      tags,
      lessonCount: lessons.length,
      lessons,
      marketplaceRewardCredits: Number(series.marketplace_reward_credits || 0),
      createdAt: series.created_at,
      updatedAt: series.updated_at,
    };
  }

  return null;
}

function publicWorkRow(row) {
  const canvas = parseJson(row.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
  // 脱敏作者信息
  let studentName = '小创作者';
  if (!row.student_anon && row.student_name) {
    const trimmed = String(row.student_name).trim();
    if (trimmed) studentName = trimmed.charAt(0) + '同学';
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    canvasSnapshot: canvas,
    featured: Boolean(row.featured_at),
    submittedAt: row.submitted_at,
    publicUrl: row.share_token ? `/works/${row.share_token}` : null,
    orgName: row.org_name || null,
    studentName,
  };
}

// VibeCoding 作品：官网详情页用 files + entryFile 在 sandbox iframe 里直接运行
function publicVibeCodingWorkRow(row, { includeFiles = false } = {}) {
  let studentName = '小创作者';
  if (!row.student_anon && row.student_name) {
    const trimmed = String(row.student_name).trim();
    if (trimmed) studentName = trimmed.charAt(0) + '同学';
  }
  const files = parseJson(row.files, {});
  return {
    id: row.id,
    type: 'VIBECODING',
    title: row.title,
    description: row.description || '',
    entryFile: row.entry_file || 'index.html',
    fileCount: Object.keys(files).length,
    featured: Boolean(row.featured_at),
    submittedAt: row.submitted_at,
    publicUrl: row.share_token ? `/works/${row.share_token}` : null,
    orgName: row.org_name || null,
    studentName,
    ...(includeFiles ? { files } : {}),
  };
}
