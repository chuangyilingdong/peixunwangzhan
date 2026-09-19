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
import { plazaCategoryLabelOf, plazaCategoryMap, plazaCategoryOf } from '../../services/plazaCategories.js';
import { WEBSITE_CONTENT_KEYS } from '../../services/websiteContentKeys.js';
import { prepareFileDownload, prepareFilePreview } from '../fileAssets.js';
import {
  publicArtifactCatalog,
  publicSnapshotFiles,
  renderSnapshotDocument,
  snapshotArtifactByName,
  snapshotDocumentFileIds,
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
    // ⚠️ 上限 60 → 500（2026-09-19 晚）：作品广场导入了 476 件（见 scripts/import-plaza-works.mjs），
    //    而这一页原来是把「画布作品 + 导入件」一次取回、在前端做类型筛选与搜索的 —— 卡在 60 的话
    //    广场永远只显示前 60 件、类型胶囊上的件数也是错的。这一条是**公开只读**的口子，
    //    500 条元数据（不含内容）约 200KB，比图片本身小两个数量级；真要再涨就得改成翻页。
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 500, fallback: 60 });
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
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 500, fallback: 60 });
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

  // 已发布作品里的文档产物（PPT / Word / Excel）。
  // 两种存法在这里分道扬镳，**都要能下**：
  //   · 规格文本（平台内沙箱那条老链路）：当场从提交快照渲染成真文件再发；
  //   · 真文件（学生创作环境交上来的 .pptx/.docx/.xlsx）：字节就存在 file_assets 里，直接发原文件。
  // 为什么必须从快照取：学生提交后还能接着改，广场要给的必须是**交上来的那一版**。
  // 文件名允许中文，所以要 decode。
  const publicDocumentMatch = pathname.match(/^\/api\/public\/vibecoding-works\/([\w-]+)\/files\/(.+)\/download$/);
  if (publicDocumentMatch && method === 'GET') {
    const submission = publicSubmission(publicDocumentMatch[1]);
    let name = '';
    try { name = decodeURIComponent(publicDocumentMatch[2]); } catch { throw errors.badRequest('文件名编码无效', 'INVALID_FILE_NAME_ENCODING'); }
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) throw errors.badRequest('文件名不合法', 'INVALID_VIBECODING_FILE_NAME');
    const stored = snapshotArtifactByName(submission, name)?.fileId;
    if (stored) return prepareFileDownload(ctx, publicWorkFile(submission, stored));
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

  // 已发布作品里的**真文件**产物怎么看：服务端用 LibreOffice 转成 PDF 再发（inline）。
  // 为什么不在客户端预览：prptx/docx/xlsx 浏览器渲染不了，而广场的用途就是「给人看」——
  // 一个只能下载、点了没反应的卡片等于没发。转出来的 PDF 也顺手让原始 Office 文件不外发。
  const publicDocumentPreviewMatch = pathname.match(/^\/api\/public\/vibecoding-works\/([\w-]+)\/files\/(.+)\/preview$/);
  if (publicDocumentPreviewMatch && method === 'GET') {
    const submission = publicSubmission(publicDocumentPreviewMatch[1]);
    let name = '';
    try { name = decodeURIComponent(publicDocumentPreviewMatch[2]); } catch { throw errors.badRequest('文件名编码无效', 'INVALID_FILE_NAME_ENCODING'); }
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) throw errors.badRequest('文件名不合法', 'INVALID_VIBECODING_FILE_NAME');
    const stored = snapshotArtifactByName(submission, name)?.fileId;
    if (!stored) throw errors.notFound('这份作品没有可在线预览的文件', 'PUBLIC_VIBECODING_FILE_NOT_FOUND');
    return prepareFilePreview(ctx, publicWorkFile(submission, stored));
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
    if (!String(file.mime_type || '').startsWith('image/')) throw errors.notFound('图片不存在于这份作品中', 'PUBLIC_VIBECODING_IMAGE_NOT_FOUND');
    if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    return prepareFileDownload(ctx, file);
  }

  // P5-W05: 公开课包列表（无需登录）。公开口径 = 平台自有的 PUBLISHED 且「上架课程广场」的课包
  // （visibility='PUBLIC'）。visibility='ASSIGNED_ORGS' 是「不上架、只给授权机构」，不能出现在这里。
  if (pathname === '/api/public/course-series' && method === 'GET') {
    const params = [];
    const wheres = ["series.status = 'PUBLISHED'", "series.owner_type = 'PLATFORM'", "series.visibility = 'PUBLIC'"];
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
      "SELECT * FROM course_series WHERE id=? AND status='PUBLISHED' AND owner_type='PLATFORM' AND visibility='PUBLIC'",
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

  // 课程广场：平台自有、已发布（PUBLISHED）、可见范围是「上架课程广场」（visibility='PUBLIC'）
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
    const wheres = ["series.status='PUBLISHED'", "series.owner_type='PLATFORM'", "series.visibility='PUBLIC'"];
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
        // 2026-09-18 晚：官网课程广场要显示「课包缩略图」与「价格」，但这两个字段**以前没下发** ——
        // 官网里 `item.coverAssetId` / `item.priceFen` 的引用一直是死的（缩略图只剩首字占位、
        // 价格那段 UI 永远不出现）。这里按官网已经在用的字段名补齐（详情接口同）。
        coverAssetId: item.cover_asset_id || null,
        priceFen: Number(item.price_fen || 0),
        // 2026-09-18 晚：官网课包列表的参数位从「适学年龄」换来「版本号」（用户口径：适学年龄那几个
        // 都是「未设置」）。版本号在课包编辑表单里是有的，但**列表接口以前没下发** —— 补上，
        // 否则页面又会显示「未设置」。
        version: item.version || '',
        difficultyLevel: item.difficulty_level != null ? Number(item.difficulty_level) : null,
        ageRangeMin: item.age_range_min != null ? Number(item.age_range_min) : null,
        ageRangeMax: item.age_range_max != null ? Number(item.age_range_max) : null,
        tags,
        lessonCount: Number(item.lesson_count || 0),
        deliveryMode: item.delivery_mode || 'CANVAS',
        // 2026-09-18：不再下发 marketplaceRewardCredits（「积分激励」已随积分口径整体删除，
        // 官网也不再显示；该列保留在库里作为历史数据）。
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
      "SELECT * FROM course_series WHERE id=? AND status='PUBLISHED' AND owner_type='PLATFORM' AND visibility='PUBLIC'",
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
      // 与列表同口径补齐（官网详情页的 `d.coverAssetId` / `d.priceFen` 原来也是死的）
      coverAssetId: series.cover_asset_id || null,
      priceFen: Number(series.price_fen || 0),
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
      createdAt: series.created_at,
      updatedAt: series.updated_at,
    };
  }

  return null;
}

function publicWorkRow(row) {
  const canvas = parseJson(row.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
  // ⚠️ 导入件（`scripts/import-plaza-works.mjs` 从用户自己的另一个站扒过来的）：
  //    作品内容不是画布快照，而是「一张封面 + 一个本体（视频/图片/或原平台链接）」，
  //    元数据塞在 `canvas_snapshot.imported` 里。这一块要原样吐给前端 —— 广场按 workType
  //    显示角标、按 coverUrl 显示真封面、按 contentUrls 看大图/播视频、按 externalUrl 跳原平台。
  const imported = canvas && typeof canvas === 'object' && canvas.imported && typeof canvas.imported === 'object'
    ? canvas.imported
    : null;
  // 脱敏作者信息
  let studentName = '小创作者';
  if (!row.student_anon && row.student_name) {
    const trimmed = String(row.student_name).trim();
    if (trimmed) studentName = trimmed.charAt(0) + '同学';
  }
  // ⚠️ 导入件**不套「X同学」那套脱敏**：那些名字本来就是原站公开的昵称/机构老师名
  //    （「宸宸」「二七」「乐高机器人编程中心雪儿老师」），套上去反而认不出是谁的作品。
  if (imported?.authorName) studentName = String(imported.authorName);
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
    // 导入件才有的字段（我们自己的画布/VibeCoding 作品一律是 null/false，前端据此分支）
    imported: Boolean(imported),
    // 广场上的两个分类（画布作品 / VibeCoding作品）：导入件按映射表，站内作品按它自己的来源
    plazaCategory: plazaCategoryOf({ imported, workType: imported?.workType, type: row.type }),
    plazaCategoryLabel: plazaCategoryLabelOf({ imported, workType: imported?.workType, type: row.type }),
    workType: imported?.workType || null,
    workTypeLabel: imported?.workTypeLabel || null,
    coverUrl: imported?.coverUrl || null,
    contentUrls: Array.isArray(imported?.contentUrls) ? imported.contentUrls : [],
    externalUrl: imported?.externalUrl || null,
    createdAt: imported?.createdAt || null,
  };
}

// VibeCoding 作品：官网详情页用 files + entryFile 在 sandbox iframe 里直接运行；
// 文档产物（PPT/Word/Excel）另给一份清单：能不能下载、配图在哪（见 publicArtifactCatalog）。
// ⚠️ 「显示哪一份产物」由提交时的 entryFile 明确指定，不能再按时间或种子 index.html 猜。
function publicVibeCodingWorkRow(row, { includeFiles = false } = {}) {
  let studentName = '小创作者';
  if (!row.student_anon && row.student_name) {
    const trimmed = String(row.student_name).trim();
    if (trimmed) studentName = trimmed.charAt(0) + '同学';
  }
  const files = includeFiles ? publicSnapshotFiles(row) : parseJson(row.files, {});
  return {
    id: row.id,
    type: 'VIBECODING',
    // 站内的 VibeCoding 提交天然属于「VibeCoding作品」这一类（不查映射表）
    plazaCategory: 'VIBECODING',
    plazaCategoryLabel: plazaCategoryLabelOf({ imported: false, type: 'VIBECODING' }),
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

/**
 * 取这份已发布作品里的一个**真文件**产物（拿 fileId 换出 file_assets 行）。
 * 准入只认**提交快照里出现过的 fileId** —— 拿得到别人的 fileId 也读不到别人的文件。
 */
function publicWorkFile(submission, fileId) {
  if (!snapshotDocumentFileIds(submission).has(String(fileId))) {
    throw errors.notFound('文件不存在于这份作品中', 'PUBLIC_VIBECODING_FILE_NOT_FOUND');
  }
  const file = row('SELECT * FROM file_assets WHERE id=?', [fileId]);
  if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
  if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
  if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
  return file;
}
