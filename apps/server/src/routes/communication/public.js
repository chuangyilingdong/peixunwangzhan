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
import { Readable } from 'node:stream';
import { assertTransition } from '../../services/domainState.js';
import { WEBSITE_CONTENT_KEYS } from '../../services/websiteContentKeys.js';
import { prepareFileDownload } from '../fileAssets.js';
import {
  publicArtifactCatalog,
  renderSnapshotDocument,
  snapshotImageFileIds,
  submissionPreview,
} from '../vibecoding.js';
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
    if (!item) throw errors.notFound('官网内容不存在', 'WEBSITE_CONTENT_NOT_FOUND');
    return normalizeWebsiteContent(item);
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
      SELECT submission.id, submission.title, submission.description, submission.entry_file, submission.files, submission.artifacts,
             submission.featured_at, submission.submitted_at, submission.share_token,
             user.display_name AS student_name, user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM vibecoding_submissions submission
      JOIN users user ON user.id=submission.student_id
      LEFT JOIN organizations organization ON organization.id=submission.org_id
      WHERE submission.is_public=1 AND submission.share_token IS NOT NULL
        AND submission.copyright_confirmed_at IS NOT NULL
      ORDER BY submission.featured_at DESC NULLS LAST, submission.submitted_at DESC
      LIMIT ?
    `, [limit]).map((item) => publicVibeCodingWorkRow(item));
    return { items, total: items.length };
  }
  const publicVibeCodingWorkMatch = pathname.match(/^\/api\/public\/vibecoding-works\/([\w-]+)$/);
  if (publicVibeCodingWorkMatch && method === 'GET') {
    const work = row(`
      SELECT submission.id, submission.title, submission.description, submission.entry_file, submission.files, submission.artifacts,
             submission.featured_at, submission.submitted_at, submission.share_token,
             user.display_name AS student_name, user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM vibecoding_submissions submission
      JOIN users user ON user.id=submission.student_id
      LEFT JOIN organizations organization ON organization.id=submission.org_id
      WHERE submission.share_token=? AND submission.is_public=1
        AND submission.copyright_confirmed_at IS NOT NULL
    `, [publicVibeCodingWorkMatch[1]]);
    if (!work) throw errors.notFound('作品不存在或已取消公开', 'PUBLIC_WORK_NOT_FOUND');
    return publicVibeCodingWorkRow(work, { includeFiles: true });
  }

  // 已发布作品里的文档产物（PPT / Word / Excel）：当场从**提交快照**渲染成真文件发出去。
  // 为什么必须从快照渲染：产物里存的是规格文本，真文件是渲染出来的；而学生提交后还能接着改，
  // 广场要给的必须是交上来的那一版。文件名允许中文，所以要 decode。
  const publicDocumentMatch = pathname.match(/^\/api\/public\/vibecoding-works\/([\w-]+)\/files\/(.+)\/download$/);
  if (publicDocumentMatch && method === 'GET') {
    const submission = publicSubmission(publicDocumentMatch[1]);
    let name = '';
    try { name = decodeURIComponent(publicDocumentMatch[2]); } catch { throw errors.badRequest('文件名编码无效', 'INVALID_FILE_NAME_ENCODING'); }
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) throw errors.badRequest('文件名不合法', 'INVALID_VIBECODING_FILE_NAME');
    const rendered = renderSnapshotDocument(submission, name);
    if (rendered.error) throw errors.notFound(rendered.error, 'PUBLIC_VIBECODING_FILE_NOT_FOUND');
    const safeName = String(rendered.filename || name || 'download').replace(/[\r\n"\\/]/g, '_');
    return {
      __fileResponse: true,
      status: 200,
      headers: {
        'content-type': rendered.mime,
        'content-length': String(rendered.buffer.length),
        'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=300',
      },
      stream: Readable.from(rendered.buffer),
    };
  }

  // 作品里用到的学生上传图（PPT 规格里的 {"attachment": N}）。
  // 学生传的图不是公开素材，所以这里**只认出现在这份已发布作品快照里的 fileId**：
  // 广场页要显示、下载出来的 pptx 里也嵌着它，不代理就只能显示空页。
  // 准入名单来自提交快照，未发布的提交拿不到 token，也就无从枚举。
  const publicWorkImageMatch = pathname.match(/^\/api\/public\/vibecoding-works\/([\w-]+)\/images\/([\w-]+)$/);
  if (publicWorkImageMatch && method === 'GET') {
    const submission = publicSubmission(publicWorkImageMatch[1]);
    if (!snapshotImageFileIds(submission).has(publicWorkImageMatch[2])) {
      throw errors.notFound('图片不存在于这份作品中', 'PUBLIC_VIBECODING_IMAGE_NOT_FOUND');
    }
    const file = row('SELECT * FROM file_assets WHERE id=?', [publicWorkImageMatch[2]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
    if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    return prepareFileDownload(ctx, file);
  }

  // P5-W05: 公开课包列表（无需登录）。公开口径 = 平台自有的 PUBLISHED 且「上架课程广场」的课包
  // （visibility='ALL_ORGS'）。visibility='ASSIGNED_ORGS' 是「不上架、只给授权机构」，不能出现在这里。
  if (pathname === '/api/public/course-series' && method === 'GET') {
    const params = [];
    const wheres = ["series.status = 'PUBLISHED'", "series.owner_type = 'PLATFORM'", "series.visibility = 'ALL_ORGS'"];
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
      "SELECT * FROM course_series WHERE id=? AND status='PUBLISHED' AND owner_type='PLATFORM' AND visibility='ALL_ORGS'",
      [publicCourseDetailMatch[1]],
    );
    if (!series) throw errors.notFound('课包不存在或不可公开访问', 'COURSE_SERIES_NOT_FOUND');
    const detail = normalizeSeries(series, { includeLessons: true, parseTags: true, asPublished: true });
    detail.lessons = (detail.lessons || []).filter((l) => l.status === 'PUBLISHED');
    // lessonContent 截断到 2000 字
    detail.lessons = detail.lessons.map((l) => ({
      ...l,
      lessonContent: l.lessonContent ? String(l.lessonContent).slice(0, 2000) : '',
      // 算力预算是平台成本口径，不下发到官网公开接口（机构端/平台端才有）
      perStudentBudgetFen: undefined,
    }));
    return detail;
  }

  // 课程广场：平台自有、已发布（PUBLISHED）、可见范围是「上架课程广场」（visibility='ALL_ORGS'）
  // 的课包自动出现，按课堂类型分为「画布课程」与「VibeCoding 课程」两类，不再需要人工上架。
  // 注意：上架广场 **不等于** 授权给机构 —— 机构后台只认 course_assignments（见 orgSeriesAccessSql）。
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
    const wheres = ["series.status='PUBLISHED'", "series.owner_type='PLATFORM'", "series.visibility='ALL_ORGS'"];
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
      // 与上面的列表用**同一套条件**：早先这里多要一个 marketplace_status='APPROVED'（而全站没有任何
      // 入口能把它置成 APPROVED），于是广场里点开的课程必然 404。上架与否只看 PUBLISHED + 上架范围。
      "SELECT * FROM course_series WHERE id=? AND status='PUBLISHED' AND owner_type='PLATFORM' AND visibility='ALL_ORGS'",
      [publicMarketplaceDetailMatch[1]],
    );
    if (!series) throw errors.notFound('课程不存在或未上架', 'MARKETPLACE_COURSE_NOT_FOUND');
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

// VibeCoding 作品：官网详情页用 files + entryFile 在 sandbox iframe 里直接运行；
// 文档产物（PPT/Word/Excel）另给一份清单：能不能下载、配图在哪（见 publicArtifactCatalog）。
// ⚠️ 「显示哪一份产物」由 preview 说了算（最近产出的那份），**不是** entryFile——
// 种子 index.html 永远在，按它拼预览会把作品显示成「你好，AI 魔法学院」起始页。
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
    preview: submissionPreview(row),
    ...(includeFiles ? { files, artifacts: publicArtifactCatalog(row) } : {}),
  };
}

/**
 * 公开取一份已发布的 VibeCoding 作品（按分享码）。
 * 发布口径与列表/详情一致：is_public=1 且学生确认过展示授权。
 */
function publicSubmission(token) {
  const submission = row(
    'SELECT * FROM vibecoding_submissions WHERE share_token=? AND is_public=1 AND copyright_confirmed_at IS NOT NULL',
    [token],
  );
  if (!submission) throw errors.notFound('作品不存在或已取消公开', 'PUBLIC_WORK_NOT_FOUND');
  return submission;
}
