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
  publishedLessonStatusSql,
  publishedLessonVisibilitySql,
  q,
  requirePlatformPermission,
  requireRole,
  row,
  rows,
  seriesDeliveryModesOf,
  transaction, canvasMediaFrom, workCoverFromSnapshot, arows, arow, aq, amap, likeKeyword, likeEscapeClause, avatarUrlOf } from '../../lib.js';
import { hostname } from 'node:os';
import { Readable } from 'node:stream';
import { assertTransition } from '../../services/domainState.js';
import { plazaCategoryLabelOf, plazaCategoryMap, plazaCategoryOf } from '../../services/plazaCategories.js';
import { WEBSITE_CONTENT_KEYS } from '../../services/websiteContentKeys.js';
import { prepareFileDownload, prepareFilePreview, prepareWorkImage } from '../fileAssets.js';
import { kindForName } from '../../services/vibecodingArtifacts.js';
import {
  missingLocalAssets,
  publicArtifactCatalog,
  publicSnapshotFiles,
  renderSnapshotDocument,
  shareCodeSnapshotFiles,
  snapshotArtifactByName,
  snapshotDocumentFileIds,
  snapshotImageFileIds,
  parseSnapshotArtifacts,
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

export async function handlePublicCommunication(ctx) {
  const { pathname, method } = ctx;
  if (pathname === '/api/public/website-content' && method === 'GET') {
    const items = (await arows("SELECT * FROM website_contents WHERE published_content IS NOT NULL ORDER BY content_key")).map((item) => normalizeWebsiteContent(item));
    return { generatedAt: nowIso(), items, byKey: Object.fromEntries(items.map((item) => [item.key, item.content])) };
  }

  const publicWebsiteKey = pathname.match(/^\/api\/public\/website-content\/([A-Za-z0-9_]+)$/);
  if (publicWebsiteKey && method === 'GET') {
    const key = websiteContentKey(publicWebsiteKey[1]);
    const item = await arow('SELECT * FROM website_contents WHERE content_key=? AND published_content IS NOT NULL', [key]);
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
    await aq("INSERT INTO leads(id,org_name,contact_name,contact_phone,intent,notes,status,admin_notes,created_at,updated_at,legal_consent_version,legal_consented_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [leadId, orgName, contactName, contactPhone, intent, notes, 'NEW', '', now, now, legalConsentVersion, legalConsentAt]);
    await audit(ctx, 'LEAD_CREATE', 'LEAD', leadId, null, { orgName, intent, legalConsentVersion, legalConsentedAt: legalConsentAt }, { orgId: null });
    return { id: leadId, status: 'NEW', createdAt: now, legalConsentVersion, legalConsentedAt: legalConsentAt };
  }

  // P5-W04: 公开作品列表
  if (pathname === '/api/public/works' && method === 'GET') {
    // ⚠️ 上限 60 → 500（2026-09-19 晚）：作品广场导入了 476 件（见 scripts/import-plaza-works.mjs），
    //    而这一页原来是把「画布作品 + 导入件」一次取回、在前端做类型筛选与搜索的 —— 卡在 60 的话
    //    广场永远只显示前 60 件、类型胶囊上的件数也是错的。这一条是**公开只读**的口子，
    //    500 条元数据（不含内容）约 200KB，比图片本身小两个数量级；真要再涨就得改成翻页。
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 500, fallback: 60 });
    const items = await amap((await arows(`
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
    `, [limit])), async (row) => await publicWorkRow(row));
    return { items, total: items.length };
  }

  // P5-W04: 公开作品详情
  const publicWorkMatch = pathname.match(/^\/api\/public\/works\/([\w-]+)$/);
  if (publicWorkMatch && method === 'GET') {
    const work = await arow(`
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
    return await publicWorkRow(work);
  }

  // 画布作品的媒体代理（2026-09-22）：生成产物现在归档在**我们自己**这里（学生私有的
  // `/api/student/file-assets/<id>/download`），而公开页是未登录的访客 —— 那个地址他们拿不动。
  // 所以由服务端按「这个 fileId 真的出现在这份**已公开**作品里」放行，与 VibeCoding 那条
  // （`/api/public/vibecoding-works/<token>/images/<fileId>`）**同一套判据**。
  // ⚠️ 这里的准入条件必须与上面那条详情路由**逐字相同**（`share_token=? AND is_public=1`）：
  //    宽一格就是"看得到作品页、图却 403"，窄一格就是"图能取、作品页说没有"。
  const publicCanvasWorkImageMatch = pathname.match(/^\/api\/public\/works\/([\w-]+)\/images\/([\w-]+)$/);
  if (publicCanvasWorkImageMatch && method === 'GET') {
    const work = await arow('SELECT id, canvas_snapshot FROM works WHERE share_token=? AND is_public=1', [publicCanvasWorkImageMatch[1]]);
    if (!work) throw errors.notFound('作品不存在或已取消公开', 'PUBLIC_WORK_NOT_FOUND');
    const allowed = new Set(canvasMediaFrom(parseJson(work.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }))
      .map((item) => item.fileId).filter(Boolean));
    if (!allowed.has(publicCanvasWorkImageMatch[2])) throw errors.notFound('图片不存在于这份作品中', 'PUBLIC_WORK_IMAGE_NOT_FOUND');
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [publicCanvasWorkImageMatch[2]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
    if (!/^(image|audio|video)\//.test(String(file.mime_type || ''))) throw errors.notFound('图片不存在于这份作品中', 'PUBLIC_WORK_IMAGE_NOT_FOUND');
    if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    return prepareFileDownload(ctx, file);
  }

  // 公开 VibeCoding 作品（平台把老师已通过的作品发布到作品广场后，官网可点开直接玩）
  if (pathname === '/api/public/vibecoding-works' && method === 'GET') {
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 500, fallback: 60 });
    const items = await amap((await arows(`
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
    `, [limit])), async (item) => await publicVibeCodingWorkRow(item));
    return { items, total: items.length };
  }
  const publicVibeCodingWorkMatch = pathname.match(/^\/api\/public\/vibecoding-works\/([\w-]+)$/);
  if (publicVibeCodingWorkMatch && method === 'GET') {
    const work = await arow(`
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
    return await publicVibeCodingWorkRow(work, { includeFiles: true });
  }

  // ⭐ 2026-09-27：学生**个人主页**（用户口径「学生创建了账号应该就有个主页的专属链接。现在需要把
  //    『我的作品』改成主页的概念。对外公开并且可以分享」→ 晚些时候又明确了一次：
  //    「主页把全部作品都列出来……就是需要公开。」）。前端公开页 `/u/<token>` 用它。
  //   · ⚠️⭐ **列全部作品**（与「我的主页」那一屏同一套筛选：`student_id + org_id`，不看可见性/状态）。
  //     这是用户明确要的第二次口径 —— 第一次我做的是"只列已公开"，被要求改掉。
  //     **后果是有意为之**：课堂上的半成品、被驳回的、已下架的，都会出现在这个公开页上。
  //   · 未公开的作品没有 share_token → 媒体走 creator 作用域的代理
  //     （`/api/public/creators/<主页token>/works/<来源>/<作品id>/images/<fileId>`，准入 = 拿到主页链接）。
  //   · ⚠️ **名字就是要显示机构建号时那个名字**（用户口径：「名字默认就是机构给他创建的账号名啊，
  //     不需要匿名。也不需要小创作者。」）—— 这里**不套广场那套脱敏**，直接给 display_name。
  //     （作品广场那条链路**没动**：它仍按 `privacy_showcase_anonymous` 显示「小创作者」/「X同学」。）
  //   · 只认 STUDENT + 未注销 —— 这是"学生主页"，教师/管理员不该有对外页面。
  const creatorMatch = pathname.match(/^\/api\/public\/creators\/([\w-]+)$/);
  if (creatorMatch && method === 'GET') {
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 500, fallback: 200 });
    const creator = await arow(`
      SELECT id, org_id, display_name, login, avatar_key, avatar_asset_id, created_at
      FROM users WHERE home_token=? AND role='STUDENT' AND deleted_at IS NULL
    `, [creatorMatch[1]]);
    if (!creator) throw errors.notFound('个人主页不存在', 'PUBLIC_CREATOR_NOT_FOUND');
    const token = creatorMatch[1];
    // ⭐ 2026-09-27 用户口径（第二次）：「主页把全部作品都列出来……就是需要公开。」
    //    → 主人的作品**全部**列出来，与「我的主页」那一屏看到的**同一套筛选**：
    //      `student_id=? AND org_id=?`，**没有任何可见性/状态过滤**（学生自己那页也是这样）。
    //    ⚠️ 后果（记录在案，是有意为之）：课堂上的半成品、被驳回、已下架的也会出现在这个公开页上。
    //    ⚠️ 未公开的作品没有 share_token，媒体得走 creator 作用域的代理；
    //      所以每条都要带上 mediaBase / openUrl（准入 = 拿到这个主页链接）。
    const canvasBase = (workId) => `/api/public/creators/${encodeURIComponent(token)}/works/CANVAS/${encodeURIComponent(workId)}`;
    const vibeBase = (id) => `/api/public/creators/${encodeURIComponent(token)}/works/VIBECODING/${encodeURIComponent(id)}`;
    const canvasItems = await amap((await arows(`
      SELECT work.id, work.title, work.description, work.canvas_snapshot,
             work.featured_at, work.submitted_at, work.share_token,
             user.display_name AS student_name,
             user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM works work
      JOIN users user ON user.id=work.student_id
      LEFT JOIN organizations organization ON organization.id=work.org_id
      WHERE work.student_id=? AND work.org_id=?
      ORDER BY work.featured_at DESC NULLS LAST, work.submitted_at DESC
      LIMIT ?
    `, [creator.id, creator.org_id, limit])), async (row) => ({ ...await publicWorkRow(row, {
      mediaBase: canvasBase(row.id),
      openUrl: `/u/${token}/w/CANVAS/${row.id}`,
    }), source: 'CANVAS', isPublic: Boolean(row.share_token) }));
    const vibeItems = await amap((await arows(`
      SELECT submission.id, submission.title, submission.description, submission.entry_file, submission.files, submission.artifacts,
             submission.featured_at, submission.submitted_at, submission.share_token,
             user.display_name AS student_name, user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM vibecoding_submissions submission
      JOIN users user ON user.id=submission.student_id
      LEFT JOIN organizations organization ON organization.id=submission.org_id
      WHERE submission.student_id=? AND submission.org_id=?
      ORDER BY submission.featured_at DESC NULLS LAST, submission.submitted_at DESC
      LIMIT ?
    `, [creator.id, creator.org_id, limit])), async (item) => ({ ...await publicVibeCodingWorkRow(item, {
      mediaBase: vibeBase(item.id),
      openUrl: `/u/${token}/w/VIBECODING/${item.id}`,
      // ⭐ 2026-09-30：主页要**逐件**发分享码 → 带上产物清单（元数据，不含文件内容）
      includePieces: true,
    }), source: 'VIBECODING', isPublic: Boolean(item.share_token) }));
    // 两条链路合并后**精选优先、再按提交时间倒序**（与广场列表的排序口径一致）
    const items = [...canvasItems, ...vibeItems].sort((a, b) => {
      if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
      return String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
    }).slice(0, limit);
    // 计数走**真 COUNT**（列表有条数上限，不能拿 items.length 冒充总数）
    const workTotal = Number((await arow('SELECT COUNT(*) n FROM works WHERE student_id=? AND org_id=?', [creator.id, creator.org_id]))?.n || 0);
    const vibeTotal = Number((await arow('SELECT COUNT(*) n FROM vibecoding_submissions WHERE student_id=? AND org_id=?', [creator.id, creator.org_id]))?.n || 0);
    const name = String(creator.display_name || '').trim() || String(creator.login || '').trim() || '同学';
    return {
      name,
      avatarKey: creator.avatar_key || null,
      // 学生自己上传的照片（没传就是 null，前端退回预设头像 / "首字圆形"）
      avatarUrl: avatarUrlOf(creator.avatar_asset_id),
      joinedAt: creator.created_at || null,
      workCount: workTotal + vibeTotal,
      shownCount: items.length,
      featuredCount: items.filter((item) => item.featured).length,
      items,
    };
  }

  // ⭐ 2026-09-27：**个人主页里点开一件作品**（含未公开的）。
  //   准入只有一条：URL 里那个主页 token 有效（= 拿到了主页链接），且这件作品确实属于那个学生。
  //   形状与 `/api/public/works/:token` 完全一致（前端复用同一个 WorkDetailPage），
  //   区别只是媒体地址换成 creator 作用域的代理（未公开作品没有 share_token，走不了那条路）。
  const creatorWorkMatch = pathname.match(/^\/api\/public\/creators\/([\w-]+)\/works\/(CANVAS|VIBECODING)\/([\w-]+)$/);
  if (creatorWorkMatch && method === 'GET') {
    const [token, source, workId] = [creatorWorkMatch[1], creatorWorkMatch[2], creatorWorkMatch[3]];
    const creator = await arow("SELECT id, org_id FROM users WHERE home_token=? AND role='STUDENT' AND deleted_at IS NULL", [token]);
    if (!creator) throw errors.notFound('个人主页不存在', 'PUBLIC_CREATOR_NOT_FOUND');
    const base = `/api/public/creators/${encodeURIComponent(token)}/works/${source}/${encodeURIComponent(workId)}`;
    if (source === 'CANVAS') {
      const work = await arow(`
        SELECT work.id, work.title, work.description, work.canvas_snapshot,
               work.featured_at, work.submitted_at, work.share_token,
               user.display_name AS student_name, user.privacy_showcase_anonymous AS student_anon,
               organization.name AS org_name
        FROM works work
        JOIN users user ON user.id=work.student_id
        LEFT JOIN organizations organization ON organization.id=work.org_id
        WHERE work.id=? AND work.student_id=? AND work.org_id=?
      `, [workId, creator.id, creator.org_id]);
      if (!work) throw errors.notFound('作品不存在', 'PUBLIC_WORK_NOT_FOUND');
      return await publicWorkRow(work, { mediaBase: base, openUrl: `/u/${token}/w/CANVAS/${workId}` });
    }
    const submission = await arow(`
      SELECT submission.*, user.display_name AS student_name, user.privacy_showcase_anonymous AS student_anon,
             organization.name AS org_name
      FROM vibecoding_submissions submission
      JOIN users user ON user.id=submission.student_id
      LEFT JOIN organizations organization ON organization.id=submission.org_id
      WHERE submission.id=? AND submission.student_id=? AND submission.org_id=?
    `, [workId, creator.id, creator.org_id]);
    if (!submission) throw errors.notFound('作品不存在', 'PUBLIC_WORK_NOT_FOUND');
    return await publicVibeCodingWorkRow(submission, { includeFiles: true, mediaBase: base, openUrl: `/u/${token}/w/VIBECODING/${workId}` });
  }

  // ⭐ 2026-09-30 用户口径：「这个分享只针对于学生的主页」「每个作品都可以有个分享，比如这节课有 1 个图片
  //    和 1 个视频，每个都可以独立去分享」。
  //    与**作品广场**完全解耦：这些码来自 `work_share_links`（学生自己发的），**不看 is_public / share_token**
  //    —— 未公开到广场的作品照样能分享，扫它也不改变任何公开状态。
  //    ⚠️ 码是**不透明**的（`shs_…`）：拿到码只能看**这一件**，看不到学生主页 token 之外的别的东西
  //      （主页地址照给，因为"学生主页"本来就是对外可分享的 —— 图3 那个「分享这个主页」）。
  const shareMatch = pathname.match(/^\/api\/public\/share-links\/([\w-]+)$/);
  if (shareMatch && method === 'GET') {
    const link = await arow('SELECT * FROM work_share_links WHERE code=?', [shareMatch[1]]);
    if (!link) throw errors.notFound('分享链接不存在', 'PUBLIC_SHARE_LINK_NOT_FOUND');
    const owner = await arow('SELECT id, display_name, login, avatar_asset_id, home_token FROM users WHERE id=? AND role=? AND deleted_at IS NULL', [link.student_id, 'STUDENT']);
    if (!owner) throw errors.notFound('分享链接不存在', 'PUBLIC_SHARE_LINK_NOT_FOUND');
    const organization = await arow('SELECT name FROM organizations WHERE id=?', [link.org_id]);
    const base = `/api/public/share-links/${encodeURIComponent(link.code)}`;
    const mediaUrlFor = (fileId) => (fileId ? `${base}/media/${encodeURIComponent(fileId)}` : null);
    const homeToken = String(owner.home_token || '').trim();
    const openUrl = homeToken ? `/u/${encodeURIComponent(homeToken)}/w/${link.source}/${encodeURIComponent(link.work_id)}` : null;
    if (link.source === 'CANVAS') {
      const work = await arow(`SELECT work.id, work.title, work.description, work.canvas_snapshot,
             COALESCE(lesson.published_title, lesson.title) AS lesson_title
        FROM works work LEFT JOIN course_lessons lesson ON lesson.id = work.course_lesson_id
       WHERE work.id=? AND work.student_id=? AND work.org_id=?`, [link.work_id, link.student_id, link.org_id]);
      if (!work) throw errors.notFound('分享链接不存在', 'PUBLIC_SHARE_LINK_NOT_FOUND');
      const media = canvasMediaFrom(parseJson(work.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }));
      const piece = media.find((item) => `media:${item.fileId || item.url}` === link.piece_key) || null;
      return {
        code: link.code, createdAt: link.created_at, source: 'CANVAS',
        student: { name: publicCreatorName(owner), avatarUrl: avatarUrlOf(owner.avatar_asset_id) },
        org: { name: organization?.name || null },
        lessonTitle: work.lesson_title || null,
        homeUrl: homeToken ? `/u/${encodeURIComponent(homeToken)}` : null,
        work: { id: work.id, title: work.title || null, description: work.description || null },
        // 这一件：画布侧就是一份媒体（图/视频/音频），直接在分享卡里展示
        piece: piece ? {
          key: link.piece_key, render: piece.modality, name: piece.caption || null, caption: piece.caption || null,
          fileId: piece.fileId || null, mediaUrl: mediaUrlFor(piece.fileId), openUrl,
        } : null,
      };
    }
    const submission = await arow(`SELECT submission.id, submission.title, submission.description, submission.files, submission.artifacts,
             submission.entry_file, COALESCE(lesson.published_title, lesson.title) AS lesson_title
        FROM vibecoding_submissions submission LEFT JOIN course_lessons lesson ON lesson.id = submission.lesson_id
       WHERE submission.id=? AND submission.student_id=? AND submission.org_id=?`, [link.work_id, link.student_id, link.org_id]);
    if (!submission) throw errors.notFound('分享链接不存在', 'PUBLIC_SHARE_LINK_NOT_FOUND');
    const artifact = parseSnapshotArtifacts(submission).find((item) => `artifact:${item.name}` === link.piece_key) || null;
    const render = artifact ? shareRenderOf(artifact.name) : null;
    // ⭐ 2026-09-30 用户口径（原话）：「手机扫码能否……**直接显示作品**，点击后立马可以在线看游玩，
    //    而不是跳转，跳转又各种无限跳转」。
    //    → 网页作品这一件，分享页要能**就地把它跑起来**（沙箱 iframe，与作品广场同一套口径），
    //      所以这里直接把这一份产物文档给出去。文档里的私有素材地址已经换成**这一枚码专属、
    //      免登录**的分享域代理（`/media/<fileId>`）—— 沙箱是 opaque origin，带不上 cookie，
    //      不换成免登录地址图与视频都显示不出来。
    const entryFile = String(submission.entry_file || artifact?.name || '').trim();
    const files = render === 'HTML' ? shareCodeSnapshotFiles(submission, link.code) : null;
    // ⭐ 2026-09-30 用户口径：「图3打开体验，应该不能这样展示，应该就**直接展示**」——
    //    他截的那一件是 `notes.txt`：卡片上只有一颗「打开体验」按钮，内容一个字都看不到。
    //    这里把**人读得懂**的文本类产物（txt/md/csv/json…）的正文一起给出去，卡片直接铺开显示。
    //    ⚠️ `.pptx/.docx/.xlsx` 的正文是给渲染器看的规格文本（提纲 JSON / Markdown / CSV），
    //       对人没意义也不该外发 —— 那三类仍走"封面 + 打开体验"。
    const artifactKind = artifact ? kindForName(artifact.name) : '';
    const rawText = artifact && SHARE_TEXT_KINDS.has(artifactKind)
      ? String(parseJson(submission.files, {})?.[artifact.name] ?? '')
      : '';
    const textContent = rawText ? rawText.slice(0, MAX_SHARE_TEXT_CHARS) : '';
    return {
      code: link.code, createdAt: link.created_at, source: 'VIBECODING',
      student: { name: publicCreatorName(owner), avatarUrl: avatarUrlOf(owner.avatar_asset_id) },
      org: { name: organization?.name || null },
      lessonTitle: submission.lesson_title || null,
      homeUrl: homeToken ? `/u/${encodeURIComponent(homeToken)}` : null,
      work: { id: submission.id, title: submission.title || null, description: submission.description || null },
      // 网页这一件就地可玩（`document`）；其余类型（图/视频/音频/文档）照旧在卡里给本色
      document: render === 'HTML' && files ? { files, entry: entryFile || artifact.name } : null,
      // 这件作品里**还指着本地文件、但没随作品交上来**的引用（客户端旧版本不带素材）——
      // 卡面据此说一句人话，而不是让学生对着破图猜（见 vibecoding.js 的 missingLocalAssets）。
      missingAssets: render === 'HTML' && files ? missingLocalAssets(files, entryFile || artifact.name) : [],
      // 这一件：网页/图片/视频/音频可以在卡里直接给（图片优先封面），文档类给封面 + 「打开体验」走既有作品页
      piece: artifact ? {
        key: link.piece_key, render, name: artifact.name, caption: artifact.name,
        fileId: artifact.fileId || artifact.coverFileId || null,
        mediaUrl: mediaUrlFor(artifact.fileId),
        coverUrl: mediaUrlFor(artifact.coverFileId),
        openUrl,
        // 能直接读的正文（没有就是空串）；`textTruncated` 让卡片如实说明"还有后半截"
        textContent,
        textTruncated: Boolean(rawText && rawText.length > MAX_SHARE_TEXT_CHARS),
        // 真文件类产物（PPT/Word/Excel）：一条**服务端转 PDF** 的预览地址 —— 分享卡就地 iframe 显示，
        // 不再只给一颗「打开体验」按钮（用户口径「就直接展示」）。文本/网页件为 null。
        previewUrl: artifact.fileId ? `${base}/files/${encodeURIComponent(artifact.name)}/preview` : null,
      } : null,
    };
  }

  // 分享卡里那一件的**字节**（准入 = 码有效 + 这个 fileId 真的属于那一件）——
  // 与个人主页那条媒体代理同一套判据，只是"作品"由**分享码**定位（所以不需要主页 token 也在链接里）。
  const shareMediaMatch = pathname.match(/^\/api\/public\/share-links\/([\w-]+)\/media\/([\w-]+)$/);
  if (shareMediaMatch && method === 'GET') {
    const [code, fileId] = [shareMediaMatch[1], shareMediaMatch[2]];
    const link = await arow('SELECT * FROM work_share_links WHERE code=?', [code]);
    if (!link) throw errors.notFound('分享链接不存在', 'PUBLIC_SHARE_LINK_NOT_FOUND');
    let allowed = new Set();
    if (link.source === 'CANVAS') {
      const work = await arow('SELECT id, canvas_snapshot FROM works WHERE id=? AND student_id=? AND org_id=?', [link.work_id, link.student_id, link.org_id]);
      if (!work) throw errors.notFound('分享链接不存在', 'PUBLIC_SHARE_LINK_NOT_FOUND');
      allowed = new Set(canvasMediaFrom(parseJson(work.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }))
        .map((item) => item.fileId).filter(Boolean));
    } else {
      const submission = await arow('SELECT id, files, artifacts FROM vibecoding_submissions WHERE id=? AND student_id=? AND org_id=?', [link.work_id, link.student_id, link.org_id]);
      if (!submission) throw errors.notFound('分享链接不存在', 'PUBLIC_SHARE_LINK_NOT_FOUND');
      // 这一件的本体 + 它的封面 + 它引用的图（HTML 产物里的配图要显示得出来）
      allowed = new Set([...snapshotImageFileIds(submission), ...parseSnapshotArtifacts(submission).map((item) => item.coverFileId).filter(Boolean)]);
      for (const item of parseSnapshotArtifacts(submission)) {
        if (`artifact:${item.name}` !== link.piece_key) continue;
        if (item.fileId) allowed.add(item.fileId);
        for (const image of [...(item.generatedImages || []), ...(item.embeddedImages || []), ...(item.attachmentImages || [])]) {
          if (image?.fileId) allowed.add(image.fileId);
        }
      }
    }
    if (!allowed.has(fileId)) throw errors.notFound('这一件里没有这个文件', 'PUBLIC_SHARE_MEDIA_NOT_FOUND');
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
    if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    if (link.source === 'VIBECODING') {
      const mime = String(file.mime_type || '').toLowerCase();
      if (/^(image|audio|video)\//.test(mime)) {
        return mime.startsWith('image/') ? prepareWorkImage(ctx, file) : prepareFilePreview(ctx, file, { ossOffload: true });
      }
    }
    return prepareFileDownload(ctx, file);
  }

  // ⭐ 2026-09-30：分享卡上的**真文件**产物（PPT / Word / Excel）怎么看 —— 与作品广场同一条路子：
  //    服务端用 LibreOffice 转成 PDF 再 inline 发（浏览器渲染不了 .pptx，卡片上只能下载 = 等于没展示；
  //    用户 2026-09-30 原话：「应该就**直接展示**就像图4那样」）。
  //    准入与分享卡那条媒体口同一套：码有效 + 这份文件**真的出现在这件作品的快照里**。
  const shareDocPreviewMatch = pathname.match(/^\/api\/public\/share-links\/([\w-]+)\/files\/(.+)\/preview$/);
  if (shareDocPreviewMatch && method === 'GET') {
    const link = await arow('SELECT * FROM work_share_links WHERE code=?', [shareDocPreviewMatch[1]]);
    if (!link) throw errors.notFound('分享链接不存在', 'PUBLIC_SHARE_LINK_NOT_FOUND');
    let docName = '';
    try { docName = decodeURIComponent(shareDocPreviewMatch[2]); } catch { throw errors.badRequest('文件名编码无效', 'INVALID_FILE_NAME_ENCODING'); }
    // 反斜杠用 charCode 拼（这仓库踩过两次：写进文件的转义常被吃掉一层，直接写就是语法错）
    const BACKSLASH = String.fromCharCode(92);
    if (!docName || docName.includes('/') || docName.includes(BACKSLASH) || docName.includes('..')) throw errors.badRequest('文件名不合法', 'INVALID_VIBECODING_FILE_NAME');
    const docSubmission = await arow('SELECT id, files, artifacts FROM vibecoding_submissions WHERE id=? AND student_id=? AND org_id=?', [link.work_id, link.student_id, link.org_id]);
    if (!docSubmission) throw errors.notFound('分享链接不存在', 'PUBLIC_SHARE_LINK_NOT_FOUND');
    const docFileId = snapshotArtifactByName(docSubmission, docName)?.fileId;
    if (!docFileId || !snapshotDocumentFileIds(docSubmission).has(String(docFileId))) {
      throw errors.notFound('这份作品没有可在线预览的文件', 'PUBLIC_SHARE_FILE_NOT_FOUND');
    }
    const docFile = await arow('SELECT * FROM file_assets WHERE id=?', [String(docFileId)]);
    if (!docFile) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (docFile.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
    if (docFile.expires_at && new Date(docFile.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    return prepareFilePreview(ctx, docFile);
  }

  // ⭐ 2026-09-27：个人主页那条链路的**媒体代理**（画布与 VibeCoding 共用）。
  //   准入 = 主页 token 有效 + 这件作品属于该学生 + fileId **真的出现在这件作品里**
  //   （与 `/api/public/works/:token/images/:fileId` 同一套判据，只是"作品"的定位方式不同）。
  //   为什么需要它：未公开的作品没有 share_token，图片走不了公开作品那条代理；而主页要列全部作品。
  const creatorImageMatch = pathname.match(/^\/api\/public\/creators\/([\w-]+)\/works\/(CANVAS|VIBECODING)\/([\w-]+)\/images\/([\w-]+)$/);
  if (creatorImageMatch && method === 'GET') {
    const [token, source, workId, fileId] = [creatorImageMatch[1], creatorImageMatch[2], creatorImageMatch[3], creatorImageMatch[4]];
    const creator = await arow("SELECT id, org_id FROM users WHERE home_token=? AND role='STUDENT' AND deleted_at IS NULL", [token]);
    if (!creator) throw errors.notFound('个人主页不存在', 'PUBLIC_CREATOR_NOT_FOUND');
    let allowed = new Set();
    if (source === 'CANVAS') {
      const work = await arow('SELECT id, canvas_snapshot FROM works WHERE id=? AND student_id=? AND org_id=?', [workId, creator.id, creator.org_id]);
      if (!work) throw errors.notFound('作品不存在', 'PUBLIC_WORK_NOT_FOUND');
      allowed = new Set(canvasMediaFrom(parseJson(work.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }))
        .map((item) => item.fileId).filter(Boolean));
    } else {
      const submission = await arow('SELECT id, files, artifacts FROM vibecoding_submissions WHERE id=? AND student_id=? AND org_id=?', [workId, creator.id, creator.org_id]);
      if (!submission) throw errors.notFound('作品不存在', 'PUBLIC_WORK_NOT_FOUND');
      allowed = new Set([...snapshotImageFileIds(submission), ...parseSnapshotArtifacts(submission).map((item) => item.coverFileId).filter(Boolean)]);
    }
    if (!allowed.has(fileId)) throw errors.notFound('图片不存在于这份作品中', 'PUBLIC_WORK_IMAGE_NOT_FOUND');
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
    if (!/^(image|audio|video)\//.test(String(file.mime_type || ''))) throw errors.notFound('图片不存在于这份作品中', 'PUBLIC_WORK_IMAGE_NOT_FOUND');
    if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    if (source === 'VIBECODING') {
      const mime = String(file.mime_type || '').toLowerCase();
      return mime.startsWith('image/') ? prepareWorkImage(ctx, file) : prepareFilePreview(ctx, file, { ossOffload: true });
    }
    return prepareFileDownload(ctx, file);
  }

  // 已发布作品里的文档产物（PPT / Word / Excel）。
  // 两种存法在这里分道扬镳，**都要能下**：
  //   · 规格文本（平台内沙箱那条老链路）：当场从提交快照渲染成真文件再发；
  //   · 真文件（学生创作环境交上来的 .pptx/.docx/.xlsx）：字节就存在 file_assets 里，直接发原文件。
  // 为什么必须从快照取：学生提交后还能接着改，广场要给的必须是**交上来的那一版**。
  // 文件名允许中文，所以要 decode。
  const publicDocumentMatch = pathname.match(/^\/api\/public\/vibecoding-works\/([\w-]+)\/files\/(.+)\/download$/);
  if (publicDocumentMatch && method === 'GET') {
    const submission = await publicSubmission(publicDocumentMatch[1]);
    let name = '';
    try { name = decodeURIComponent(publicDocumentMatch[2]); } catch { throw errors.badRequest('文件名编码无效', 'INVALID_FILE_NAME_ENCODING'); }
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) throw errors.badRequest('文件名不合法', 'INVALID_VIBECODING_FILE_NAME');
    const stored = snapshotArtifactByName(submission, name)?.fileId;
    if (stored) return prepareFileDownload(ctx, await publicWorkFile(submission, stored));
    const rendered = await renderSnapshotDocument(submission, name);
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
    const submission = await publicSubmission(publicDocumentPreviewMatch[1]);
    let name = '';
    try { name = decodeURIComponent(publicDocumentPreviewMatch[2]); } catch { throw errors.badRequest('文件名编码无效', 'INVALID_FILE_NAME_ENCODING'); }
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) throw errors.badRequest('文件名不合法', 'INVALID_VIBECODING_FILE_NAME');
    const stored = snapshotArtifactByName(submission, name)?.fileId;
    if (!stored) throw errors.notFound('这份作品没有可在线预览的文件', 'PUBLIC_VIBECODING_FILE_NOT_FOUND');
    return prepareFilePreview(ctx, await publicWorkFile(submission, stored));
  }

  // 作品里用到的学生上传图（PPT 规格里的 {"attachment": N}）。
  // 学生传的图不是公开素材，所以这里**只认出现在这份已发布作品快照里的 fileId**：
  // 广场页要显示、下载出来的 pptx 里也嵌着它，不代理就只能显示空页。
  // 准入名单来自提交快照，未发布的提交拿不到 token，也就无从枚举。
  const publicWorkImageMatch = pathname.match(/^\/api\/public\/vibecoding-works\/([\w-]+)\/images\/([\w-]+)$/);
  if (publicWorkImageMatch && method === 'GET') {
    const submission = await publicSubmission(publicWorkImageMatch[1]);
    if (!snapshotImageFileIds(submission).has(publicWorkImageMatch[2])) {
      throw errors.notFound('图片不存在于这份作品中', 'PUBLIC_VIBECODING_IMAGE_NOT_FOUND');
    }
    const file = await arow('SELECT * FROM file_assets WHERE id=?', [publicWorkImageMatch[2]]);
    if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
    if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
    const mime = String(file.mime_type || '').toLowerCase();
    if (!/^(image|audio|video)\//.test(mime)) throw errors.notFound('作品媒体不可用', 'PUBLIC_VIBECODING_MEDIA_NOT_FOUND');
    if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
    return mime.startsWith('image/') ? prepareWorkImage(ctx, file) : prepareFilePreview(ctx, file, { ossOffload: true });
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
      wheres.push(`series.tags LIKE ? ${likeEscapeClause()}`);
      params.push(likeKeyword(String(ctx.search.get('tag'))));
    }
    const items = await amap((await arows(
      `SELECT series.* FROM course_series series WHERE ${wheres.join(' AND ')} ORDER BY series.sort, series.title`,
      params,
    )), async (item) => await normalizeSeries(item, { parseTags: true }));
    return { items, total: items.length };
  }

  // P5-W05: 公开课包详情
  const publicCourseDetailMatch = pathname.match(/^\/api\/public\/course-series\/([\w-]+)$/);
  if (publicCourseDetailMatch && method === 'GET') {
    const series = await arow(
      "SELECT * FROM course_series WHERE id=? AND status='PUBLISHED' AND owner_type='PLATFORM' AND visibility='PUBLIC'",
      [publicCourseDetailMatch[1]],
    );
    if (!series) throw errors.notFound('课包不存在或不可公开访问', 'COURSE_SERIES_NOT_FOUND');
    const detail = await normalizeSeries(series, { includeLessons: true, parseTags: true, asPublished: true });
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
  // 的课包自动出现，不再需要人工上架。
  // ⚠️ 课堂形式**不是二选一**（2026-09-20 用户口径）：一个课包可以同时有画布与 VibeCoding 两类课时，
  //    所以下发的是 `deliveryModes`（已发布课时的并集，见 lib.js），官网照它显示「画布课程」或
  //    「画布课程/VibeCoding 课程」。
  // ⚠️ 下面那个 `category` 查询参数仍然按课包自己的单值字段 `series.delivery_mode` 过滤 —— 它与
  //    课时并集**可能不一致**（线上有该字段=CANVAS 而课时是 VIBECODING 的课包）。官网已不用这个
  //    筛选（2026-09-18 删掉了入口），目前没有已知调用方，所以没有顺手改语义；将来真要按形式筛，
  //    得改成按课时并集筛，否则筛「VibeCoding」会漏掉那些被显示成 VibeCoding 的课包。
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
    if (tag) { wheres.push(`series.tags LIKE ? ${likeEscapeClause()}`); params.push(likeKeyword(String(tag))); }
    if (search) { wheres.push(`series.title LIKE ? ${likeEscapeClause()}`); params.push(likeKeyword(String(search))); }
    const where = wheres.join(' AND ');
    const total = Number((await arow('SELECT COUNT(*) n FROM course_series series WHERE ' + where, params))?.n || 0);
    const orderBy = sort === 'recent' ? 'series.created_at DESC' : 'series.sort ASC, series.title COLLATE NOCASE ASC';
    const series = await arows(
      `SELECT series.* FROM course_series series WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    // 课包的「课堂形式」与「课时数」都以**已发布读取面可见的课时**为准，不读 course_series.delivery_mode
    // （两者会不一致 —— 线上有 series=CANVAS 而课时是 VIBECODING 的错配），也不按实时 status 过滤
    // （那会让没「更新发布」的新课时提前露面）。判据只写一遍：lib.js 的 publishedLessonVisibilitySql。
    // 一次把本页所有课包的课时查回来，避免 N+1。
    const lessonsBySeries = new Map();
    if (series.length) {
      const placeholders = series.map(() => '?').join(',');
      for (const lesson of await arows(
        `SELECT lesson.series_id, lesson.delivery_mode, lesson.delivery_modes FROM course_lessons lesson
         WHERE lesson.series_id IN (${placeholders}) AND ${publishedLessonVisibilitySql('lesson')}`,
        series.map((item) => item.id),
      )) {
        if (!lessonsBySeries.has(lesson.series_id)) lessonsBySeries.set(lesson.series_id, []);
        lessonsBySeries.get(lesson.series_id).push(lesson);
      }
    }
    const items = series.map((item) => {
      let tags = [];
      try { tags = item.tags ? JSON.parse(item.tags) : []; } catch { tags = []; }
      // 课包提供的课堂形式（画布 / VibeCoding，可两者都有）= 已发布课时的并集；一个已发布课时都
      // 没有的课包退回课包自己的单值字段（老行为）。官网据此显示「画布课程」或
      // 「画布课程/VibeCoding 课程」；deliveryMode 仍是「第一种」，兼容既有读取方。
      const lessonModes = seriesDeliveryModesOf(lessonsBySeries.get(item.id));
      const deliveryModes = lessonModes.length ? lessonModes : [item.delivery_mode || 'CANVAS'];
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
        lessonCount: (lessonsBySeries.get(item.id) || []).length,
        deliveryMode: deliveryModes[0],
        deliveryModes,
        // 2026-09-18：不再下发 marketplaceRewardCredits（「积分激励」已随积分口径整体删除，
        // 官网也不再显示；该列保留在库里作为历史数据）。
      };
    });
    return { items, total, page, limit };
  }

  // P5-M02: Public marketplace detail
  const publicMarketplaceDetailMatch = pathname.match(/^\/api\/public\/marketplace\/([\w-]+)$/);
  if (publicMarketplaceDetailMatch && method === 'GET') {
    const series = await arow(
      // 与上面的列表用**同一套条件**：早先这里多要一个 marketplace_status='APPROVED'（而全站没有任何
      // 入口能把它置成 APPROVED），于是广场里点开的课程必然 404。上架与否只看 PUBLISHED + 上架范围。
      "SELECT * FROM course_series WHERE id=? AND status='PUBLISHED' AND owner_type='PLATFORM' AND visibility='PUBLIC'",
      [publicMarketplaceDetailMatch[1]],
    );
    if (!series) throw errors.notFound('课程不存在或未上架', 'MARKETPLACE_COURSE_NOT_FOUND');
    // 与列表同一个判据（publishedLessonVisibilitySql）：没「更新发布」的新课时不该出现在官网，
    // 也不能被算进课时数 —— lessonCount 就是按这个数组的长度算的，改一处两处都对。
    const lessons = (await arows(
      `SELECT lesson.id, lesson.series_id, lesson.title, lesson.summary, lesson.sort,
              ${publishedLessonStatusSql('lesson')} AS status,
              lesson.duration_minutes, lesson.lesson_content, lesson.created_at, lesson.updated_at
       FROM course_lessons lesson WHERE lesson.series_id=? AND ${publishedLessonVisibilitySql('lesson')}
       ORDER BY lesson.sort, lesson.created_at`,
      [series.id],
    )).map((l) => ({
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

/** 分享卡怎么渲染这一件：网页 / 图片 / 视频 / 音频 / 文档（文档类给封面 + 「打开体验」/下载）。 */
/** 分享卡里"直接铺开显示"的正文上限（超出截断并如实说明）。 */
const MAX_SHARE_TEXT_CHARS = 20000;

/** 能**直接给人读**的产物类型（其余如 pptx/docx/xlsx 的正文是给渲染器看的规格文本，不外发）。 */
const SHARE_TEXT_KINDS = new Set(['text', 'md', 'csv', 'json']);

function shareRenderOf(name) {
  const extension = String(name || '').split('.').pop()?.toLowerCase() || '';
  if (['html', 'htm'].includes(extension)) return 'HTML';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(extension)) return 'IMAGE';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(extension)) return 'VIDEO';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(extension)) return 'AUDIO';
  return 'DOC';
}

/** 对外显示的学生名：**机构建号时那个名字**（用户口径「不需要匿名」）—— 与个人主页同一套取值。 */
function publicCreatorName(user) {
  return String(user?.display_name || '').trim() || String(user?.login || '').trim() || '同学';
}

async function publicWorkRow(row, { mediaBase = '', openUrl = '' } = {}) {
  const canvas = parseJson(row.canvas_snapshot, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
  // ⭐ 2026-09-27：媒体地址的**基路径**可以外部指定 —— 学生个人主页要把**未公开**的作品也列出来，
  //    那些作品没有 share_token，走不了 `/api/public/works/<token>/images/<fileId>`，改走
  //    `/api/public/creators/<主页token>/works/<来源>/<作品id>/images/<fileId>`（准入 = 拿到主页链接）。
  //    不传 mediaBase 时保持原行为（有 share_token 才给代理地址，否则原样/为空）。
  const base = mediaBase || (row.share_token ? `/api/public/works/${encodeURIComponent(row.share_token)}` : '');
  const urlFor = (fileId) => (base ? `${base}/images/${encodeURIComponent(fileId)}` : null);
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
    // 广场作品详情的**媒体清单**（图/视频/音频）：用户 2026-09-21 口径 —— 作品页要看成出来的东西，
    // 不是画布。与站内那两条链路共用同一个提取函数（`canvasMediaFrom`）。
    // ⚠️ 里面但凡是我们**自己的**素材（生成产物归档后就是），地址都得换成这份作品专属的公开代理：
    //    访客没登录，`/api/student/file-assets/<id>/download` 对他是 403（前端也一样转不出 data:，
    //    那条路要 token）。换完前端 `srcOf` 直接用 `item.url` 就能显示，不必再动前端。
    // ⭐ 2026-09-30：每件产出物带上 `pieceKey` —— 学生主页要**逐件**发分享码，键必须由服务端算
    //    （与 `sharePieceKeysOf()` 同一套规则；前端自己拼的话两边口径迟早飘）。
    media: canvasMediaFrom(canvas).map((item) => ({
      ...item,
      ...(item.fileId && urlFor(item.fileId) ? { url: urlFor(item.fileId) } : {}),
      pieceKey: `media:${item.fileId || item.url}`,
    })),
    featured: Boolean(row.featured_at),
    submittedAt: row.submitted_at,
    publicUrl: row.share_token ? `/works/${row.share_token}` : (openUrl || null),
    orgName: row.org_name || null,
    studentName,
    // 导入件才有的字段（我们自己的画布/VibeCoding 作品一律是 null/false，前端据此分支）
    imported: Boolean(imported),
    // 广场上的两个分类（画布作品 / VibeCoding作品）：导入件按映射表，站内作品按它自己的来源
    plazaCategory: await plazaCategoryOf({ imported, workType: imported?.workType, type: row.type }),
    plazaCategoryLabel: await plazaCategoryLabelOf({ imported, workType: imported?.workType, type: row.type }),
    workType: imported?.workType || null,
    workTypeLabel: imported?.workTypeLabel || null,
    // ⭐ 2026-09-27 用户口径：站内**画布作品自动用快照里第一张真图当封面**（原来是 null，
    //    前端只能画一张同款渐变插图，一屏作品看着全像"填充的"）。导入件保留它们自己的封面。
    coverUrl: imported?.coverUrl || workCoverFromSnapshot(canvas, urlFor),
    contentUrls: Array.isArray(imported?.contentUrls) ? imported.contentUrls : [],
    externalUrl: imported?.externalUrl || null,
    // ⭐ 托管在**我们自己** `/media/` 下的可运行网页作品（2026-09-19 从 aimagc.cn 抓的那 9 件，
    //    见 `scripts/import-aimagc-webworks.mjs`）：入口页是站内地址，前端要在
    //    **不带 `allow-same-origin` 的沙箱**里跑它 —— 它与主站同源，少了那条限制学生 HTML
    //    就能读我们的 cookie / localStorage。所以这一项**不能**当普通外链处理。
    entryUrl: imported?.entryUrl || null,
    createdAt: imported?.createdAt || null,
  };
}

// VibeCoding 作品：官网详情页用 files + entryFile 在 sandbox iframe 里直接运行；
// 文档产物（PPT/Word/Excel）另给一份清单：能不能下载、配图在哪（见 publicArtifactCatalog）。
// ⚠️ 「显示哪一份产物」由提交时的 entryFile 明确指定，不能再按时间或种子 index.html 猜。
async function publicVibeCodingWorkRow(row, { includeFiles = false, includePieces = false, mediaBase = '', openUrl = '' } = {}) {
  // 与 publicWorkRow 同一个道理：学生个人主页要列**未公开**的作品，那些没有 share_token，
  // 图片得走 creator 作用域的代理（基路径由调用方给）。
  const base = mediaBase || (row.share_token ? `/api/public/vibecoding-works/${encodeURIComponent(row.share_token)}` : '');
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
    plazaCategoryLabel: await plazaCategoryLabelOf({ imported: false, type: 'VIBECODING' }),
    title: row.title,
    description: row.description || '',
    entryFile: row.entry_file || 'index.html',
    fileCount: Object.keys(files).length,
    featured: Boolean(row.featured_at),
    submittedAt: row.submitted_at,
    publicUrl: row.share_token ? `/works/${row.share_token}` : (openUrl || null),
    orgName: row.org_name || null,
    studentName,
    preview: submissionPreview(row),
    // ⭐ 2026-09-27 用户口径：「图1 为什么还有作品还是默认界面」——VibeCoding 作品也能有**真封面**：
    //    它没有画布快照，但页面里可能带图（生成图/附件图/内嵌图，见 snapshotImageFileIds）。
    //    有图就用第一张（走公开口 `/api/public/vibecoding-works/<token>/images/<fileId>`）；
    //    一张图都没有的（例如纯代码的小游戏）仍然没有真封面可用 —— 前端继续用那张按类型画的插图，
    //    要做成"页面截图"得在客户端截或在服务器跑无头浏览器（这台机明确不跑，见 §〇）。
    coverUrl: (() => {
      // ⭐ 优先用**客户端截的封面**（提交时随 `cover.png` 一起传上来的那张，见 studentRuntime 的采集段）：
      //    纯代码作品（例如一个小游戏）页面里没有图，只有这样才在广场上有真封面。
      //    老数据没有它 → 退回页面里的第一张图（2026-09-27 加的规则）。
      const fromClient = parseSnapshotArtifacts(row).map((item) => item.coverFileId).find(Boolean) || null;
      const first = fromClient || [...snapshotImageFileIds(row)][0];
      return first && base ? `${base}/images/${encodeURIComponent(first)}` : null;
    })(),
    // ⭐ 2026-09-30：`includePieces` 只给**产物清单（元数据）**、不带文件内容 ——
    //    学生主页要"逐件分享"，而主页一次可能列 200 件作品，带上 files 内容会白白变胖。
    ...(includeFiles ? { files, artifacts: publicArtifactCatalog(row) } : includePieces ? { artifacts: publicArtifactCatalog(row) } : {}),
  };
}

/**
 * 公开取一份已发布的 VibeCoding 作品（按分享码）。
 * 发布口径与列表/详情一致：is_public=1 且学生确认过展示授权。
 */
async function publicSubmission(token) {
  const submission = await arow(
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
async function publicWorkFile(submission, fileId) {
  if (!snapshotDocumentFileIds(submission).has(String(fileId))) {
    throw errors.notFound('文件不存在于这份作品中', 'PUBLIC_VIBECODING_FILE_NOT_FOUND');
  }
  const file = await arow('SELECT * FROM file_assets WHERE id=?', [fileId]);
  if (!file) throw errors.notFound('文件不存在', 'FILE_NOT_FOUND');
  if (file.status !== 'ACTIVE') throw errors.forbidden('文件不可用', 'FILE_NOT_ACTIVE');
  if (file.expires_at && new Date(file.expires_at).getTime() <= Date.now()) throw errors.forbidden('文件已过期', 'FILE_EXPIRED');
  return file;
}
