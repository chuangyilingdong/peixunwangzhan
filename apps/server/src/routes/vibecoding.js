// VibeCoding 课堂运行时：对话式代码创作（SSE 流式）+ 产物 + 受限运行 + 提交点评。
// 计费沿用平台既有链路：每轮 AI 回复扣 1 积分（credit_entries / usage_records）。
//
// 产物模型的要点：学生不能手写代码，代码只有一个来源——AI 回复里带文件名的围栏。
// 每有一个围栏闭合就立刻落库并推 `artifact` 事件，所以产物卡片是逐个出现的。
import {
  ApiError, audit, count, corsHeaders, errors, id, json, nonEmptyString, nowIso,
  pageParams, pageResult, parseJson, q, requireRole, row, rows, transaction,
} from '../lib.js';
import { Readable } from 'node:stream';
import { PUBLIC_SITE_URL } from '../config.js';
import { resolveStudentLessonContext } from '../services/studentContext.js';
import { assertSessionAiControls } from '../services/aiControls.js';
import { getGenerationProvider } from '../services/generationProvider.js';
import { chargeCreditsInTransaction } from '../services/creditLedger.js';
import { debitUserAiCredits, recordAiUsage } from '../services/creditUsage.js';
import { getAiProviderPolicy, isModalityEnabled } from './billingConfig.js';
import { modalityChannel } from '../services/modelCapabilities.js';
import { providerSelectionForModality } from './aiGeneration.js';
import { applyGatewayRoute } from '../services/computeGateway.js';
import { assertComputePoolBudget, computePoolSummary, priceFenFor } from '../services/computePool.js';

/** 会话归属的课包 id（算力池的键）。会话只存了课时，所以这里回查一次。 */
function conversationSeriesId(conversation) {
  if (!conversation?.lesson_id) return null;
  return row('SELECT series_id FROM course_lessons WHERE id=?', [conversation.lesson_id])?.series_id || null;
}
import { normalizeProviderError, PROVIDER_ERROR_CODES } from '../services/providerContract.js';
import {
  artifactsAsFiles, createArtifactScanner, extractArtifacts, getArtifact, kindForName,
  listArtifacts, pickEntryArtifact, seedDefaultArtifacts, setArtifactGeneratedImages, upsertArtifact, upsertArtifacts,
} from '../services/vibecodingArtifacts.js';
import { MAX_ILLUSTRATIONS_PER_DECK, collectIllustrationTargets, generateIllustrationsForArtifacts } from '../services/vibecodingIllustrations.js';
import { isDocumentKind, renderDocument } from '../services/ooxml/documents.js';
import { uploadRoot } from '../services/fileUploadSecurity.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TITLE = '新的创作对话';
const MAX_MESSAGE_CHARS = 4000;
const HISTORY_MESSAGES = 20;

// 提交与作品广场沿用 files JSON 快照（按文件名取内容）。
// ⚠️ 这份快照**只读**：写入口是产物表（配额在 vibecodingArtifacts.js），
// 学生也不能再直接改文件（PUT 会拒掉 files/entryFile）——所以这里不再留写侧校验。
// 读侧刻意宽松（见 parseSnapshotFiles）：产物名允许中文，写侧的 ASCII 路径校验用在这里会误伤。

function normalizeConversation(value, { includeArtifacts = false, artifacts: provided = null } = {}) {
  if (!value) return null;
  const artifacts = includeArtifacts ? (provided || listArtifacts(value.id, { includeContent: true })) : null;
  const entry = includeArtifacts ? pickEntryArtifact(artifacts) : null;
  return {
    id: value.id, title: value.title, status: value.status, model: value.model || null,
    lessonId: value.lesson_id || null, lessonTitle: value.lesson_title || null,
    classId: value.class_id || null, className: value.class_name || null,
    classSessionId: value.class_session_id || null,
    // 入口文件由产物推导：index.html 优先，其次第一个 HTML
    entryFile: value.entry_file || entry?.name || 'index.html',
    pinnedAt: value.pinned_at || null,
    ...(includeArtifacts ? { artifacts } : {}),
    // 列表页只给数量：悬停卡片要显示「3 个文件」，但不值得把正文一起传
    ...(value.artifact_count == null ? {} : { artifactCount: Number(value.artifact_count) }),
    lastMessageAt: value.last_message_at || null,
    createdAt: value.created_at, updatedAt: value.updated_at,
  };
}


function normalizeMessage(value) {
  return {
    id: value.id, role: value.role, content: value.content, model: value.model || null,
    status: value.status, errorCode: value.error_code || null,
    creditsCharged: Number(value.credits_charged || 0), createdAt: value.created_at,
    attachments: parseAttachments(value.attachments),
  };
}

// 每条消息最多带几张图（够用，也挡住刷量）
const MAX_ATTACHMENTS = 4;
// 内联给模型的图上限（base64 后的字符数）；超过就只保留外链、不进模型请求
const MAX_INLINE_CHARS = 1.5 * 1024 * 1024;

/** 消息上的附件（[{id,name,url}]）。字段是 JSON，坏数据一律当空，不让它打断对话。 */
function parseAttachments(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed
      // mime 必须带出来：产物配图要按它筛「这一轮有几张图」。只带 id/name/url/inline 的话，
      // 「有几张图」永远是 0 —— 表现为 PPT 里就是没图，而且**一句错都不报**。
      .map((item) => ({
        id: String(item?.id || ''), name: String(item?.name || ''), url: String(item?.url || ''),
        mime: String(item?.mime || ''), inline: String(item?.inline || ''),
      }))
      .filter((item) => item.id && item.url);
  } catch { return []; }
}

/**
 * 公开下载地址（**绝对** URL）：外联给模型与生成出来的页面用。
 * ⚠️ 必须是绝对地址——上游模型在外部，站内相对路径它抓不到
 *（画布那边踩过同一个坑，见 aiGeneration.js 的 publicFileAssetUrl）。
 */
function publicAssetUrl(assetId) {
  return `${String(PUBLIC_SITE_URL || '').replace(/\/+$/, '')}/api/public/file-assets/${assetId}/download`;
}

function conversationScopeSql(alias = 'conversation') {
  return `${alias}.student_id = ? AND ${alias}.org_id = ?`;
}

function ownConversation(ctx, conversationId) {
  const auth = requireRole(ctx, ['STUDENT']);
  const conversation = row(
    `SELECT conversation.*, lesson.title AS lesson_title, class.name AS class_name
     FROM vibecoding_conversations conversation
     LEFT JOIN course_lessons lesson ON lesson.id = conversation.lesson_id
     LEFT JOIN classes class ON class.id = conversation.class_id
     WHERE conversation.id = ? AND ${conversationScopeSql()}`,
    [conversationId, auth.user.id, auth.user.orgId],
  );
  if (!conversation) throw errors.notFound('创作会话不存在', 'VIBECODING_CONVERSATION_NOT_FOUND');
  return { auth, conversation };
}

/**
 * 把学生传来的附件 id 列表校验成可落库的 [{id,name,url,mime,inline}]。
 * 只接受**本人上传的、公开的**文件：别人的素材、没公开的一律拒掉并说明原因。
 * 类型不设限（以服务端上传白名单为准）；**能不能让模型看见**由 mime 决定，见 conversationHistory。
 */
function resolveAttachments(auth, rawList) {
  const entries = (Array.isArray(rawList) ? rawList : [])
    .map((item) => ({ id: String(typeof item === 'string' ? item : item?.id || '').trim(), inline: String(typeof item === 'string' ? '' : item?.inline || '') }))
    .filter((item) => item.id);
  const ids = entries.map((item) => item.id);
  if (!ids.length) return [];
  if (ids.length > MAX_ATTACHMENTS) throw errors.badRequest(`一次最多带 ${MAX_ATTACHMENTS} 个附件`, 'VIBECODING_TOO_MANY_ATTACHMENTS');
  const resolved = [];
  for (const assetId of ids) {
    const asset = row('SELECT * FROM file_assets WHERE id=?', [assetId]);
    if (!asset || asset.status !== 'ACTIVE') throw errors.badRequest('附件不存在或已失效', 'VIBECODING_ATTACHMENT_NOT_FOUND');
    if (asset.owner_user_id !== auth.user.id) throw errors.forbidden('只能引用自己上传的附件', 'VIBECODING_ATTACHMENT_NOT_OWNED');
    if (asset.visibility !== 'PUBLIC_PLATFORM' && asset.visibility !== 'PUBLIC_RELEASE') {
      throw errors.badRequest('附件需要是公开素材（外联给模型和页面用）', 'VIBECODING_ATTACHMENT_NOT_PUBLIC');
    }
    // inline 只接受图片 data URL，且限长（超限/非图片就不带，模型看不到但页面能用外链）
    const raw = entries.find((item) => item.id === assetId)?.inline || '';
    const inline = raw.startsWith('data:image/') && raw.length <= MAX_INLINE_CHARS ? raw : '';
    resolved.push({
      id: asset.id, name: String(asset.file_name || '附件'), url: publicAssetUrl(asset.id),
      mime: String(asset.mime_type || ''), inline,
    });
  }
  return resolved;
}

function activeStudent(auth) {
  const user = row("SELECT * FROM users WHERE id=? AND org_id=? AND status='ACTIVE'", [auth.user.id, auth.user.orgId]);
  if (!user) throw errors.forbidden('学生账号不可用', 'ACCOUNT_DISABLED');
  return user;
}

function vibeCodingContext(user, lessonId, classId) {
  const context = resolveStudentLessonContext(user, lessonId, classId);
  if (!context.canUseVibeCodingNow) {
    throw errors.forbidden(context.vibeCodingBlockReason || '当前不可进入 VibeCoding 课堂', context.vibeCodingBlockCode || 'VIBECODING_CLASSROOM_UNAVAILABLE');
  }
  return context;
}

// 调上游前的预检：课堂管控 / 平台模态开关 / 课时能力 / 个人额度，任一不满足就不发起调用。
function assertChatPreflight({ user, orgId, context, model = '' }) {
  assertSessionAiControls({ modality: 'TEXT', session: context.activeSession, orgId, userId: user.id, credits: 1 });
  if (!isModalityEnabled(orgId, 'TEXT').enabled) throw errors.forbidden('平台已关闭该 AI 能力', 'MODALITY_DISABLED');
  if (!(context.lesson?.capabilities || []).includes('text')) throw errors.forbidden('本课时未开放 AI 文字能力', 'LESSON_CAPABILITY_DISABLED');
  const aiLimit = user.ai_credit_limit == null ? null : Number(user.ai_credit_limit);
  if (aiLimit !== null && Number(user.ai_credits_used || 0) + 1 > aiLimit) throw errors.forbidden('该账号 AI 积分使用上限已用尽', 'AI_MEMBER_CREDIT_LIMIT');
  const allowance = Number(user.monthly_credit_allowance || 0) + Number(user.monthly_bonus_credits || 0) + Number(user.month_period_boost_credits || 0);
  if (Number(user.used_credits_this_period || 0) + 1 > allowance) throw errors.forbidden('个人额度不足', 'STUDENT_CREDIT_LIMIT');
  // 算力池（学生 × 课包）：对话也从这个池子扣，与画布/视频/音乐共用一个上限
  assertComputePoolBudget({ userId: user.id, seriesId: context.series?.id || null, modality: 'TEXT', model });
}

function sseOpen(ctx) {
  ctx.res.writeHead(200, corsHeaders(ctx.req, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }));
}

function sseSend(ctx, event, payload) {
  if (ctx.res.writableEnded || ctx.res.destroyed) return;
  ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function recordFailedMessage(conversationId, model, content, errorCode) {
  const messageId = id('vibemsg');
  q('INSERT INTO vibecoding_messages(id,conversation_id,role,content,model,status,error_code,credits_charged,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [messageId, conversationId, 'assistant', content, model, 'FAILED', errorCode || 'VIBECODING_CHAT_FAILED', 0, nowIso()]);
  return messageId;
}

function assertConversationEditable(conversation) {
  // 「提交」现在只是把作品交给平台，**不再锁住创作** —— 学生提交完接着改是常态。
  // 只有归档会话才拒绝写入（归档是运营动作，不是学生能触发的）。
  if (conversation.status === 'ARCHIVED') throw errors.conflict('该创作已归档，不能再修改', 'VIBECODING_CONVERSATION_ARCHIVED');
}

/**
 * 课时上下文：多轮 history 会覆盖渠道模板里的 system 提示词，所以这里自己拼一条。
 *
 * 2026-09-11 用户要求：**不再注入人设与产物约定**（原来那条「阿飞」人设、
 * 「带文件名的围栏才算产物」的约定、以及给模型的产物清单，都已删除）。
 * 现在只保留两块：
 *   ① 面向未成年人的一句安全底线（不属于"人设"，是平台底线；要一并删掉说一声）；
 *   ② 本节课的课时内容（标题/简介/正文），从 course_lessons 读。
 *
 * ⚠️ 删掉产物约定后的后果：产物仍然只从「带文件名的围栏」解析（服务端规则没变），
 * 所以模型需要**自己**用 ```语言 文件名 的写法，预览才会更新。如果要约定回来，
 * 可以写进渠道配置的「请求模板」，不必改服务端代码。
 */
/**
 * 产出这份产物的那一轮里，学生传了哪些图片（按顺序，只数图片、不数非图片附件）。
 *
 * 为什么要「那一轮」而不是「最近一轮」：模型写 `{"attachment":1}` 时指的是它当时看到的那几张图，
 * 学生在之后又聊了几轮的话，用「最近一轮」就会取错图。
 * 关联是可靠的：助手消息落库后会把 message_id 回填到产物上（见 streamAssistantReply）。
 */
function triggeringImageAttachments(conversationId, artifact) {
  // getArtifact() 返回的是驼峰字段（messageId），别按数据库列名（message_id）去读 —— 读错就永远取不到图，
  // 而且**不报错**：表现为「PPT 里就是没图」，最难查的那种。
  const messageId = artifact?.messageId || artifact?.message_id;
  if (!messageId) return [];
  const message = row(
    `SELECT attachments FROM vibecoding_messages
      WHERE conversation_id=? AND role='user' AND attachments IS NOT NULL AND attachments<>''
        AND rowid < (SELECT rowid FROM vibecoding_messages WHERE id=?)
      ORDER BY rowid DESC LIMIT 1`,
    [conversationId, messageId],
  );
  return parseAttachments(message?.attachments).filter((item) => String(item.mime || '').startsWith('image/'));
}

/** 从本地存储读回一份素材的字节（不给自己的接口发 HTTP 请求，磁盘上就是那份文件） */
function readAssetBytes(fileId) {
  const asset = row('SELECT storage_kind, storage_key FROM file_assets WHERE id=?', [fileId]);
  if (!asset || asset.storage_kind !== 'INTERNAL_PROXY') return null;
  const key = String(asset.storage_key || '').replaceAll('\\', '/');
  if (!key || key.startsWith('/') || key.split('/').includes('..')) return null;
  const root = uploadRoot();
  const absolute = path.resolve(root, key);
  if (!absolute.startsWith(root + path.sep)) return null;
  try { return readFileSync(absolute); } catch { return null; }
}

/**
 * 「图片引用清单 → 幻灯片下标/序号 → 图片字节」的公共实现。
 * 两个来源（平台插画、学生上传的图）在这里合流，**读取端只有这一份**：
 * 活会话（学生自己下载）与提交快照（作品广场下载）走同一条路，
 * 免得「学生下载的 PPT 有图、广场下载的没图」这种两边都察觉不到的漂移。
 */
function imageMapFrom(items, indexOf) {
  const images = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.fileId || item.error) continue;
    const index = indexOf(item);
    if (!Number.isInteger(index) || index < -1) continue;
    const buffer = readAssetBytes(item.fileId);
    if (buffer) images.set(index, buffer);
  }
  return images;
}

/**
 * 产物记着的生成插画（幻灯片下标 → 图片字节）。
 * ⚠️ **-1 是封面**（见 pptx.js 的 COVER_IMAGE_KEY），别当成非法下标丢掉 ——
 * 那样封面永远是纯色版、而且不报错。失败项与读不到的素材照样跳过。
 */
function generatedImageMap(artifact) {
  return imageMapFrom(artifact?.generatedImages, (item) => Number(item.slideIndex));
}

/**
 * 附件序号（1 起） → 图片字节。取不到的序号直接不进 Map，渲染时那一页就不放图。
 * 导出是为了给 p47 做守卫：这条链路连着「产物 messageId」「附件里的 mime」「磁盘上的素材」
 * 三处，任何一处断掉都**不报错**、只是 PPT 里没图 —— 必须能被自动化盯住。
 */
export function attachmentImageMap(conversationId, artifact) {
  const sources = triggeringImageAttachments(conversationId, artifact);
  return imageMapFrom(sources.map((source, index) => ({ fileId: source.id, index: index + 1 })), (item) => Number(item.index));
}

/**
 * 提交快照里的配图（同一口径，只是数据来自快照而不是活会话）：
 *   · generatedImages：[{slideIndex, fileId}]，-1 是封面
 *   · attachmentImages：[{index, fileId}]，index 从 1 起（对应规格里的 {"attachment": N}）
 */
export function snapshotImageMaps(artifact) {
  return {
    generatedImages: imageMapFrom(artifact?.generatedImages, (item) => Number(item.slideIndex)),
    attachmentImages: imageMapFrom(artifact?.attachmentImages, (item) => Number(item.index)),
  };
}

/**
 * 能产出哪些**文档**、分别怎么写。
 *
 * ⚠️ 这不是「人设」，也不是 2026-09-11 删掉的那种「产物约定」（当时删的是人设 + 要求模型自己起文件名）。
 * 这是三种文件格式的**写法说明**——模型不可能凭空猜出我们的规格长什么样，不给它，这个能力就等于不存在。
 * 反过来，这里也只说格式，不规定它必须产生产物、不规定话术。
 */
const DOCUMENT_GUIDE = [
  '除了网页，你也可以直接产出 Office 文档：用一个带扩展名的代码块写**内容**，平台会渲染成真正的文件，学生下载后能用 PowerPoint / Word / Excel / WPS 打开。',
  '· PPT：```pptx 文件名.pptx ```，内容是一段 JSON —— {"title":"标题","subtitle":"副标题","author":"署名","theme":"ocean","slides":[{"title":"这一页的标题","bullets":["要点一","要点二"]}]}。每页 3~6 条要点、单条不超过 40 字，页数按需要；不要只做一页，也不要把整段话塞进一条要点。',
  '  · theme 选一个贴合内容的配色：ocean（蓝，风景/科技）、forest（绿，自然/环保）、sunset（橙，美食/热情）、candy（紫，童趣/节日）、ink（默认）。',
  '  · 版式（可选，写在那一页里）：{"layout":"section","title":"第二部分"} 做**章节分隔页**、{"layout":"quote","title":"一句话"} 做**金句页**、{"layout":"thanks"} 做**结尾页**。一份 8 页以上的 PPT 值得用 1~2 个章节页分段，结尾页收个尾。',
  '  **配图**（很影响成品像不像样，值得用）：封面写 {"cover":{"prompt":"…"}}，正文页在那一页加 image 字段，两种写法 ——',
  '  ① 让平台生成插画：{"title":"赛里木湖","bullets":["湖水蓝得像宝石"],"image":{"prompt":"新疆赛里木湖的夏天，写实插画风格，蓝天、雪山倒影、湖边草地，横构图"}}。'
    + `提示词要具体（画什么、什么风格、什么构图），**全篇最多 ${MAX_ILLUSTRATIONS_PER_DECK} 张（含封面）**，优先给封面和最有画面感的那几页，**不要每页都配**。`,
  '  ② 用学生自己传的图：{"image":{"attachment":1}} —— attachment 是**学生这条消息里第几张图**（平台会告诉你有几张、怎么编号）。学生传了图又做 PPT 时，就该把图用上，别浪费。',
  '  配图是**可选**的：拿不准风格、或内容本身就是表格/流程时，不配图反而更好。',
  '· Word：```docx 文件名.docx ```，内容是 Markdown —— # 一级标题、- 无序列表、1. 有序列表、| 表格 |、**粗体**。',
  '· Excel：```xlsx 文件名.xlsx ```，内容是 CSV，**第一行是表头**。',
  '学生要文档时就直接给对应的代码块，不要用文字描述一遍内容来代替。',
].join('\n');

export function lessonSystemMessage(conversation) {
  const lesson = row('SELECT title, summary, lesson_content FROM course_lessons WHERE id=?', [conversation.lesson_id]);
  const parts = [
    '请用适合 8–16 岁学生理解的中文回答，避免任何危险或不适龄内容。',
    DOCUMENT_GUIDE,
  ];
  // 产物清单原来是为了配合「产物约定」——约定删了，这段也随之删掉。
  // 允许不带 id 调用（单测里只验证课时上下文的拼装）。
  if (lesson) {
    if (lesson.title) parts.push(`本节 VibeCoding 课时：${lesson.title}`);
    if (lesson.summary) parts.push(`课时简介：${String(lesson.summary).slice(0, 600)}`);
    if (lesson.lesson_content) parts.push(`课时正文与教学指引：\n${String(lesson.lesson_content).slice(0, 4000)}`);
  }
  return { role: 'system', content: parts.join('\n\n') };
}

export function conversationHistory(conversationId, limit = HISTORY_MESSAGES) {
  return rows(
    "SELECT role, content, attachments FROM vibecoding_messages WHERE conversation_id=? AND status='SUCCEEDED' ORDER BY created_at DESC, rowid DESC LIMIT ?",
    [conversationId, limit],
  ).reverse().map((message) => {
    const attachments = parseAttachments(message.attachments);
    // 带图的用户消息必须发成**内容块**：只发纯文本的话，模型完全看不到图
    //（实测过：同样的问题，纯文本回「未看到图片」）。
    //
    // ⚠️ 只能用 **inline**（base64）不能用外链：上游**不会去抓我们的公网地址**，
    // 给它 https://iicili.cyou/... 会直接报错（实测：data URL 答出「红 蓝」，外链 HTTP 报错）。
    // 没有 inline 的就不放进请求——宁可不带，也不能让整轮对话失败。
    const usable = attachments.filter((item) => item.inline);
    // 有附件却进不了请求的（图太大 / 非图片文件）：**如实告诉模型它看不到**。
    // 不然学生传一篇 PDF 问「帮我看看」，模型会当作没这回事、直接编一段内容出来。
    const invisible = attachments.filter((item) => !item.inline);
    if (message.role !== 'user' || !attachments.length) return { role: message.role, content: message.content };
    const blocks = [{ type: 'text', text: message.content }];
    if (usable.length) {
      // 图是按顺序发过去的，但模型不知道我们给它们编了号 —— 做 PPT 要引用「第几张图」时必须说清楚。
      blocks.push({
        type: 'text',
        text: usable.length === 1
          ? '［平台提示］这条消息附了 1 张图片，编号为 1。'
          : `［平台提示］这条消息附了 ${usable.length} 张图片，按上面的先后顺序编号为 1、2…${usable.length}。`,
      });
    }
    if (invisible.length) {
      blocks.push({
        type: 'text',
        text: `［平台提示］这条消息还附了 ${invisible.length} 个文件：${invisible.map((item) => item.name).join('、')}。`
          + '你读不到它们的内容（图片以外、或体积超限的文件不会传给你）。如果学生需要你看内容，请让他把文字贴进对话。',
      });
    }
    blocks.push(...usable.map((item) => ({ type: 'image_url', image_url: { url: item.inline }, role: 'reference_image' })));
    return { role: 'user', content: blocks };
  });
}

/**
 * 当前 TEXT 渠道**实际启用**的模型（供学生每个会话自己挑，默认沿用渠道默认模型）。
 *
 * ⚠️ 只给 `models`（管理员在后台勾选/录入的启用项）+ 渠道默认模型，
 * **不要把 `modelMappings` 一起放进来**——那是「读取模型」返回的候选清单，是给管理员
 * 挑选用的大列表（几百条，跨供应商），下发给学生就会冒出 gpt 之类的无关模型。
 */
function textModelOptions() {
  const channel = modalityChannel(getAiProviderPolicy(), 'TEXT');
  if (!channel) return [];
  const mappings = Array.isArray(channel.modelMappings) ? channel.modelMappings : [];
  const displayNameOf = (id) => mappings.find((item) => item?.id === id)?.displayName || id;
  const ids = new Set();
  for (const item of (Array.isArray(channel.models) ? channel.models : [])) {
    const id = String(typeof item === 'string' ? item : item?.id || item?.name || '').trim();
    if (id) ids.add(id);
  }
  // 默认模型即使没被勾进 models，也应该在列表里（否则前端选不中当前默认值）
  if (channel.model) ids.add(String(channel.model));
  return [...ids].filter(Boolean).map((id) => ({ id, displayName: displayNameOf(id) }));
}

/**
 * 当前 TEXT 渠道的**默认模型**（后台配的那个）。
 *
 * 会话表里的 model 留空 = 「跟随渠道默认」——所以学生一进来下拉要显示的是**这个值**，
 * 而不是一个空的「渠道默认模型」。留空存储、显示默认，是为了后台改了默认之后
 * 没自己选过模型的老会话能跟着走。
 */
function textDefaultModel() {
  return String(modalityChannel(getAiProviderPolicy(), 'TEXT')?.model || '').trim();
}

/**
 * 跑一轮助手回复：SSE 保活 + 中止透传 + 产物实时落库 + 成功才扣费。
 * 发送 / 重新生成 / 编辑重发三个入口共用，避免三份实现走偏。
 *
 * 事件序列：start → status* → delta* → artifact* → done / aborted / error
 *
 * 产物在**围栏闭合的那一刻**就落库并推事件，而不是等整轮结束：
 * 这样学生看到的是产物卡片一个个出现。中止或失败时已经写入的产物会保留
 * （代码确实已经「写出来」了），只是不扣费。
 */
async function streamAssistantReply(ctx, { auth, conversation, userMessageId }) {
  const policy = getAiProviderPolicy();
  // 学生在哪个课时里创作，就用他在那个课时的令牌走网关（额度用尽网关直接拒服务）。
  const selection = await applyGatewayRoute(
    providerSelectionForModality(policy, 'TEXT', conversation.model || ''),
    { orgId: auth.user.orgId, studentId: auth.user.id, lessonId: conversation.lesson_id || '', modality: 'TEXT' },
  );
  const provider = getGenerationProvider(selection);
  if (typeof provider.generateStream !== 'function') throw errors.conflict('当前 AI 渠道不支持流式对话', 'VIBECODING_STREAM_UNAVAILABLE');

  const history = [lessonSystemMessage(conversation), ...conversationHistory(conversation.id)];
  const scanner = createArtifactScanner();
  const emittedArtifactIds = new Set();
  sseOpen(ctx);
  sseSend(ctx, 'start', { userMessageId, conversationId: conversation.id, model: selection.model, provider: provider.name });
  // 推理型模型可能先思考几十秒才吐第一个可见字，期间没有任何 data 事件；
  // 定期写 SSE 注释（: ping）避免 nginx 等中间层按 proxy_read_timeout 掐断连接。
  const heartbeat = setInterval(() => {
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    ctx.res.write(': ping\n\n');
  }, 15000);
  heartbeat.unref?.();
  // 学生点「停止」或关掉页面时前端会断开连接：同步中止上游请求，避免继续等、继续计费
  const abortController = new AbortController();
  const onClientGone = () => { if (!ctx.res.writableEnded) abortController.abort(); };
  ctx.res.on('close', onClientGone);

  let streamedText = '';
  let reasoningChars = 0;

  /** 把这次新闭合的围栏写进产物表并推给前端 */
  function flushArtifacts(deltas) {
    for (const candidate of deltas) {
      const saved = upsertArtifact({
        conversationId: conversation.id,
        messageId: null, // 助手消息 id 要等整轮成功才有，产物先不挂它
        name: candidate.name,
        content: candidate.content,
      });
      if (!saved) continue; // 配额或超大文件：静默跳过，不打断对话
      emittedArtifactIds.add(saved.id);
      sseSend(ctx, 'artifact', { artifact: saved, created: saved.revision === 1 });
    }
  }

  try {
    const result = await provider.generateStream({
      messages: history,
      signal: abortController.signal,
      onReasoning: (delta) => {
        const piece = String(delta || '');
        reasoningChars += piece.length;
        // 只推**增量**而不是累积全文：推理可能几万字，每来一小段就重发整段是 O(n²) 的流量。
        // 前端自己累积（见 vibecodingWorkspace 的 onStatus）。
        sseSend(ctx, 'status', { phase: 'thinking', chars: reasoningChars, delta: piece });
      },
      onDelta: (delta, full) => {
        streamedText = full;
        sseSend(ctx, 'delta', { delta });
        // 每来一段就找一遍「这次新闭合」的围栏；未闭合的不会命中，所以不会产出半截文件
        const closed = scanner.push(delta);
        if (closed.length) flushArtifacts(closed);
      },
    });
    const text = String(result?.assets?.[0]?.metadata?.text || streamedText || '').trim();
    if (!text) throw errors.conflict('AI 没有返回内容', 'GENERATION_EMPTY_RESULT');

    // 兜底：万一渠道不是逐 delta 推的（一次性返回），这里再整段扫一遍
    const remaining = scanner.text === text ? [] : extractArtifacts(text);
    if (remaining.length) flushArtifacts(remaining);

    const assistantMessageId = id('vibemsg');
    let balanceAfter = 0;
    transaction(() => {
      const fresh = row('SELECT * FROM vibecoding_conversations WHERE id=? AND student_id=?', [conversation.id, auth.user.id]);
      if (!fresh) throw errors.notFound('创作会话不存在', 'VIBECODING_CONVERSATION_NOT_FOUND');
      const charged = chargeCreditsInTransaction({
        orgId: auth.user.orgId, credits: 1, type: 'AI_VIBECODING_CHAT', modality: 'TEXT', model: selection.model,
        userId: auth.user.id, sessionId: fresh.class_session_id || null,
      });
      debitUserAiCredits({ userId: auth.user.id, orgId: auth.user.orgId, credits: 1 });
      recordAiUsage({
        orgId: auth.user.orgId, userId: auth.user.id, sessionId: fresh.class_session_id || null,
        modality: 'TEXT', model: selection.model, credits: 1, status: 'SUCCESS',
        // 算力池账本：对话也从这个池子扣（与画布/视频/音乐共用一个上限）
        costFen: priceFenFor({ modality: 'TEXT', model: selection.model }), seriesId: conversationSeriesId(conversation),
        pricing: { source: 'vibecoding', provider: provider.name, conversationId: fresh.id, mode: selection.provider },
      });
      q('INSERT INTO vibecoding_messages(id,conversation_id,role,content,model,status,credits_charged,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [assistantMessageId, fresh.id, 'assistant', text, selection.model, 'SUCCEEDED', 1, nowIso()]);
      // 这一轮产出的产物认领到这条消息上，方便聊天里按消息分组
      if (emittedArtifactIds.size) {
        const placeholders = [...emittedArtifactIds].map(() => '?').join(',');
        q(`UPDATE vibecoding_artifacts SET message_id=? WHERE id IN (${placeholders}) AND message_id IS NULL`,
          [assistantMessageId, ...emittedArtifactIds]);
      }
      const entry = pickEntryArtifact(listArtifacts(fresh.id));
      q('UPDATE vibecoding_conversations SET model=?,entry_file=?,last_message_at=?,updated_at=? WHERE id=?',
        [selection.model, entry?.name || 'index.html', nowIso(), nowIso(), fresh.id]);
      balanceAfter = Number(charged?.balanceAfter || 0);
    });
    const message = normalizeMessage(row('SELECT * FROM vibecoding_messages WHERE id=?', [assistantMessageId]));
    // 文档产物要配的插画，在这一轮**消息落库之后**才生成：这时产物已认领到这条消息上，
    // 也才有「产出那一轮」可回溯。生成期间照常推 status 事件，学生能看到「正在生成插画」，
    // 而不是干等（参考实现里那一步「正在收集 PPT 素材」就是这个位置）。
    // ⚠️ 注意：fresh 是在上面的 transaction 回调里声明的，出了回调就没了 ——
    // 在这里直接用它会在求值实参时抛 ReferenceError，被本层的 catch 吞掉，
    // 表现成「插画静默不生成」（我踩过）。所以在外面重新取一次。
    const freshConversation = row('SELECT * FROM vibecoding_conversations WHERE id=? AND student_id=?', [conversation.id, auth.user.id]) || conversation;
    await illustrateTurn(ctx, auth, freshConversation, emittedArtifactIds);
    sseSend(ctx, 'done', {
      message,
      // 权威产物清单：前端拿它跟流式期间收到的卡片对账
      artifacts: listArtifacts(conversation.id, { includeContent: true }),
      entryFile: pickEntryArtifact(listArtifacts(conversation.id))?.name || 'index.html',
      creditsCharged: 1,
      balanceAfter,
      streamed: result?.streamed !== false,
    });
  } catch (error) {
    const rawCode = error?.code || 'VIBECODING_CHAT_FAILED';
    // 学生主动停止时连接先断，抛出的可能是底层 socket 错误而不是我们自己的 ABORTED，
    // 所以以 abortController 状态为准：不落失败消息、不扣费。
    if (abortController.signal.aborted || rawCode === PROVIDER_ERROR_CODES.ABORTED) {
      sseSend(ctx, 'aborted', { code: 'VIBECODING_ABORTED', artifacts: listArtifacts(conversation.id, { includeContent: true }) });
    } else {
      // ⚠️ 这里必须**归一化后再给学生看**：网关「额度用尽」在 HTTP 上是 403，
      // 直接透原始文案就会把「请在管理后台重新填写并保存该渠道 API Key」这种给运维看的话
      // 甩给一个十来岁的学生（而且真正的原因是他这节课的钱花完了）。
      const normalized = normalizeProviderError(error);
      const code = normalized.code || rawCode;
      recordFailedMessage(conversation.id, selection.model, streamedText, code);
      recordAiUsage({
        orgId: auth.user.orgId, userId: auth.user.id, sessionId: conversation.class_session_id || null,
        modality: 'TEXT', model: selection.model, credits: 0, status: 'FAILED', failCode: code,
        costFen: 0, seriesId: conversationSeriesId(conversation),
        pricing: { source: 'vibecoding', provider: provider.name, conversationId: conversation.id },
      });
      sseSend(ctx, 'error', { code, message: normalized.message || error?.message || 'AI 回复失败' });
    }
  } finally {
    clearInterval(heartbeat);
    ctx.res.off?.('close', onClientGone);
    if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end();
  }
  return { __streamed: true };
}

/**
 * 给这一轮产出的文档（PPT）生成插画。
 *
 * 三条不可省的规矩：
 *   · **门禁不通过就一张都不生成**（课时没开 image、课堂不允许、平台关了该模态）——
 *     文档产物不能变成绕过能力开关的后门；这时候只推一条说明，不报错、不打断这轮对话。
 *   · **单张失败只影响那一页**，其余照常。
 *   · 生成完把更新后的产物**再推一次**（前端按 id 覆盖），预览里就会换上带插画的版本。
 */
async function illustrateTurn(ctx, auth, conversation, artifactIds) {
  if (!artifactIds?.size) return;
  const artifacts = listArtifacts(conversation.id, { includeContent: true }).filter((item) => artifactIds.has(item.id));
  if (!collectIllustrationTargets(artifacts).length) return;
  try {
    const user = activeStudent(auth);
    const context = resolveStudentLessonContext(user, conversation.lesson_id, conversation.class_id);
    const results = await generateIllustrationsForArtifacts({
      auth: { ...auth, rawUser: user },
      context,
      artifacts,
      onProgress: (info) => sseSend(ctx, 'status', info),
    });
    for (const [artifactId, images] of results) {
      setArtifactGeneratedImages(artifactId, images);
      const updated = getArtifact(conversation.id, artifactId);
      if (updated) sseSend(ctx, 'artifact', { artifact: updated, created: false });
    }
  } catch (error) {
    // 最常见的几种：能力没开、生成渠道不可用、这节课的算力额度用尽。
    // 如实告诉学生「这次没配图」，而不是默默不给 —— 且同样先归一化，别把运维文案透给学生。
    const normalizedImage = error instanceof ApiError ? { code: error.code, message: error.message } : normalizeProviderError(error);
    sseSend(ctx, 'status', {
      phase: 'image', done: 0, total: 0,
      error: String(normalizedImage.message || error?.message || error).slice(0, 160),
      code: normalizedImage.code || error?.code || 'ILLUSTRATION_FAILED',
    });
  }
}

// ── 提交快照（作品广场与公开下载都读它）──────────────────────────────────────
//
// 为什么要有快照：删掉老师点评之后提交不再锁创作（学生可以接着改、反复交），
// 而作品广场要显示的是「交上来的那一版」。所以提交时把**产物清单**（含配图引用）定格一份，
// 正文继续走 files 快照 —— 广场与下载都不去读活会话。

/**
 * 提交那一刻的产物清单。只存元信息与图片引用（fileId），不存正文，所以这一列很小。
 * ⚠️ 配图引用必须一起定格：只存正文的话，广场渲染出来的 PPT 会**静默**丢掉所有图
 * （学生自己下载的那份有图、广场那份没有，而两边都不报错）。
 */
export function snapshotArtifacts(conversationId) {
  return listArtifacts(conversationId, { includeContent: true }).map((artifact) => ({
    name: artifact.name,
    kind: artifact.kind || kindForName(artifact.name),
    bytes: Number(artifact.bytes || 0),
    revision: Number(artifact.revision || 1),
    updatedAt: artifact.updatedAt || artifact.createdAt || null,
    // 平台生成的插画：按幻灯片下标（-1 是封面）
    generatedImages: (Array.isArray(artifact.generatedImages) ? artifact.generatedImages : [])
      .filter((item) => item?.fileId && !item.error)
      .map((item) => ({ slideIndex: Number(item.slideIndex), fileId: String(item.fileId) })),
    // 学生传的图：规格里 {"attachment": N} 指的是**产出这一轮**里的第 N 张
    attachmentImages: triggeringImageAttachments(conversationId, artifact)
      .map((source, index) => ({ index: index + 1, fileId: source.id })),
  }));
}

/** 读回快照里的产物清单：坏数据一律当空，别让一条脏记录把广场打挂 */
export function parseSnapshotArtifacts(submission) {
  const parsed = parseJson(submission?.artifacts, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => item && typeof item.name === 'string' && item.name)
    .map((item) => ({
      name: item.name,
      kind: item.kind || kindForName(item.name),
      bytes: Number(item.bytes || 0),
      revision: Number(item.revision || 1),
      updatedAt: item.updatedAt || null,
      generatedImages: (Array.isArray(item.generatedImages) ? item.generatedImages : []).filter((image) => image?.fileId),
      attachmentImages: (Array.isArray(item.attachmentImages) ? item.attachmentImages : []).filter((image) => image?.fileId && Number(image.index) > 0),
    }));
}

/**
 * 读回提交里的文件正文。
 * **不能**用 parseFiles：它的路径校验只允许 ASCII，而产物名允许中文，
 * 于是「去新疆旅游.pptx」这种名字会在读回时抛错 —— 提交已经落库了，学生却收到 400
 * （写入口的校验照旧保留，那是对客户端的约束）。
 */
function parseSnapshotFiles(value) {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/**
 * 「这次交上来的主产物」＝**最近产出的那一份**。
 * 为什么不是「优先 index.html」：种子产物 index.html 会一直躺在会话里，学生做的是 PPT 时它也在，
 * 按文件名优先挑就会把作品显示成「你好，AI 魔法学院」起始页 —— 这正是作品广场此前显示错东西的原因。
 * 学生侧预览区是同一个口径（Workbench 的 documentArtifact），改要一起改。
 */
export function submissionPreview(submission) {
  const artifacts = parseSnapshotArtifacts(submission);
  if (!artifacts.length) return null;
  const newest = artifacts
    .slice()
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];
  return { name: newest.name, kind: newest.kind, document: isDocumentKind(newest.kind) };
}

/**
 * 作品广场的产物清单：每个文件是什么、能不能下载、配图在哪。
 * 图片地址在这一层拼好（前端不再自己定规则），附件图走**限定在本作品快照内**的代理地址：
 * 学生传的图不是公开素材，只有出现在这份已发布作品里的那几张才允许被公开取到。
 */
export function publicArtifactCatalog(submission) {
  const files = parseSnapshotFiles(submission?.files);
  const byName = new Map(parseSnapshotArtifacts(submission).map((item) => [item.name, item]));
  const base = `/api/public/vibecoding-works/${submission.share_token}`;
  return Object.keys(files).sort().map((name) => {
    const meta = byName.get(name) || {};
    const kind = meta.kind || kindForName(name);
    const item = { name, kind, document: isDocumentKind(kind), updatedAt: meta.updatedAt || null };
    if (!item.document) return item;
    return {
      ...item,
      downloadUrl: `${base}/files/${encodeURIComponent(name)}/download`,
      images: {
        generated: Object.fromEntries((meta.generatedImages || [])
          .map((image) => [String(image.slideIndex), `/api/public/file-assets/${image.fileId}/download`])),
        attachment: Object.fromEntries((meta.attachmentImages || [])
          .map((image) => [String(image.index), `${base}/images/${image.fileId}`])),
      },
    };
  });
}

/** 从提交快照渲染一份真文件（广场的下载口用它；学生自己下载走的是活会话那条） */
export function renderSnapshotDocument(submission, name) {
  const files = parseSnapshotFiles(submission?.files);
  if (!Object.hasOwn(files, name)) return { error: '作品里没有这个文件' };
  const meta = parseSnapshotArtifacts(submission).find((item) => item.name === name);
  const kind = meta?.kind || kindForName(name);
  if (!isDocumentKind(kind)) return { error: '这个文件不是可下载的文档' };
  return renderDocument(
    { name, kind, content: String(files[name] ?? '') },
    snapshotImageMaps(meta || {}),
  );
}

/** 快照里出现过的图片 id（公开取图的准入名单，见 public.js 的 /images/:fileId） */
export function snapshotImageFileIds(submission) {
  const ids = new Set();
  for (const item of parseSnapshotArtifacts(submission)) {
    for (const image of [...item.generatedImages, ...item.attachmentImages]) ids.add(String(image.fileId));
  }
  return ids;
}

export function normalizeSubmission(value, { includeContent = false } = {}) {
  if (!value) return null;
  return {
    id: value.id, conversationId: value.conversation_id, studentId: value.student_id,
    studentName: value.student_name || null, studentLogin: value.student_login || null,
    classId: value.class_id || null, className: value.class_name || null,
    lessonId: value.lesson_id || null, lessonTitle: value.lesson_title || null,
    title: value.title, description: value.description || '', round: Number(value.round || 1),
    entryFile: value.entry_file || 'index.html',
    status: value.status, submittedAt: value.submitted_at,
    copyrightConfirmedAt: value.copyright_confirmed_at || null,
    isPublic: Number(value.is_public || 0) === 1,
    // 被平台从作品广场撤下来时给学生的说明（没有就是 null）
    unpublishReason: value.unpublish_reason || null,
    shareToken: value.share_token || null,
    featured: Boolean(value.featured_at),
    publishedAt: value.published_at || null,
    // 「这次交上来的主产物」把产物清单里最近产出的那份挑出来（老记录没有快照 → null，
    // 平台列表回退到只显示 entryFile）
    preview: submissionPreview(value),
    ...(includeContent ? { files: parseSnapshotFiles(value.files), transcript: JSON.parse(value.transcript || '[]'), artifacts: parseSnapshotArtifacts(value) } : {}),
  };
}

function submissionSelect() {
  return `SELECT submission.*, student.display_name AS student_name, student.login AS student_login,
                 class.name AS class_name, lesson.title AS lesson_title, reviewer.display_name AS reviewer_name
          FROM vibecoding_submissions submission
          LEFT JOIN users student ON student.id = submission.student_id
          LEFT JOIN classes class ON class.id = submission.class_id
          LEFT JOIN course_lessons lesson ON lesson.id = submission.lesson_id
          LEFT JOIN users reviewer ON reviewer.id = submission.reviewed_by`;
}

async function handleStudentVibeCoding(ctx, auth, part) {
  const { method, body = {} } = ctx;

  if (part === '/conversations' && method === 'GET') {
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 20 });
    const conditions = [conversationScopeSql()];
    const params = [auth.user.id, auth.user.orgId];
    const lessonId = String(ctx.search.get('lessonId') || '').trim();
    if (lessonId) { conditions.push('conversation.lesson_id = ?'); params.push(lessonId); }
    const classId = String(ctx.search.get('classId') || '').trim();
    if (classId) { conditions.push('conversation.class_id = ?'); params.push(classId); }
    const status = String(ctx.search.get('status') || '').trim().toUpperCase();
    if (['DRAFT', 'SUBMITTED', 'ARCHIVED'].includes(status)) { conditions.push('conversation.status = ?'); params.push(status); }
    const search = String(ctx.search.get('search') || '').trim();
    if (search) { conditions.push('conversation.title LIKE ?'); params.push('%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%'); }
    const where = conditions.join(' AND ');
    const total = Number(count(`SELECT COUNT(*) n FROM vibecoding_conversations conversation WHERE ${where}`, params) || 0);
    const items = rows(
      `SELECT conversation.*, lesson.title AS lesson_title, class.name AS class_name,
              (SELECT COUNT(*) FROM vibecoding_artifacts artifact WHERE artifact.conversation_id = conversation.id) AS artifact_count
       FROM vibecoding_conversations conversation
       LEFT JOIN course_lessons lesson ON lesson.id = conversation.lesson_id
       LEFT JOIN classes class ON class.id = conversation.class_id
       WHERE ${where}
       ORDER BY CASE WHEN conversation.pinned_at IS NULL THEN 1 ELSE 0 END,
                COALESCE(conversation.last_message_at, conversation.created_at) DESC, conversation.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((item) => normalizeConversation(item));
    return pageResult(items, { page, limit, total });
  }

  if (part === '/conversations' && method === 'POST') {
    const lessonId = nonEmptyString(body.lessonId, '课时', { max: 100 });
    const classId = body.classId === undefined || body.classId === '' ? null : nonEmptyString(body.classId, '班级', { max: 100 });
    const user = activeStudent(auth);
    const context = vibeCodingContext(user, lessonId, classId);
    const now = nowIso();
    const conversationId = id('vibeconv');
    const title = body.title === undefined || String(body.title).trim() === '' ? DEFAULT_TITLE : nonEmptyString(body.title, '会话标题', { max: 60 });
    transaction(() => {
      q(`INSERT INTO vibecoding_conversations(
           id,org_id,student_id,class_id,lesson_id,class_session_id,title,model,files,entry_file,status,last_message_at,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [conversationId, auth.user.orgId, auth.user.id, context.class?.id || classId, lessonId,
          context.activeSession?.id || null, title, null, '{}', 'index.html', 'DRAFT', null, now, now]);
      // 起始产物：让学生一进课堂就有东西可跑，而不是面对一块空白
      seedDefaultArtifacts(conversationId);
      audit(ctx, 'VIBECODING_CONVERSATION_CREATE', 'VIBECODING_CONVERSATION', conversationId, null, { lessonId, title });
    });
    const created = row(
      `SELECT conversation.*, lesson.title AS lesson_title, class.name AS class_name
       FROM vibecoding_conversations conversation
       LEFT JOIN course_lessons lesson ON lesson.id = conversation.lesson_id
       LEFT JOIN classes class ON class.id = conversation.class_id
       WHERE conversation.id = ?`, [conversationId]);
    return { ...normalizeConversation(created, { includeArtifacts: true }), modelOptions: textModelOptions(), defaultModel: textDefaultModel() };
  }

  const conversationMatch = part.match(/^\/conversations\/([^/]+)$/);
  if (conversationMatch && method === 'GET') {
    const { conversation } = ownConversation(ctx, conversationMatch[1]);
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 50 });
    const total = Number(count('SELECT COUNT(*) n FROM vibecoding_messages WHERE conversation_id = ?', [conversation.id]) || 0);
    const messages = rows(
      `SELECT * FROM vibecoding_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [conversation.id, limit, offset],
    ).reverse().map(normalizeMessage);
    const submission = row(submissionSelect() + ' WHERE submission.conversation_id = ?', [conversation.id]);
    // 历史产物（message_id 为空，来自旧 files JSON 的迁移）挂到最后一条助手消息上。
    // 迁移不可能知道每个文件是哪一轮写出来的，但「这次创作产出了哪些文件」必须看得见——
    // 否则老会话在聊天里一张产物卡片都没有，看起来像功能没生效。
    const artifacts = listArtifacts(conversation.id, { includeContent: true });
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    if (lastAssistant) {
      for (const artifact of artifacts) if (!artifact.messageId) artifact.messageId = lastAssistant.id;
    }
    return {
      ...normalizeConversation(conversation, { includeArtifacts: true, artifacts }),
      messages, messagesTotal: total, messagesPage: page,
      submission: normalizeSubmission(submission),
      modelOptions: textModelOptions(),
      defaultModel: textDefaultModel(),
      // 算力池摘要（本课包还剩多少）随会话详情下发，工作台顶部显示
      computePool: computePoolSummary({ userId: conversation.student_id, seriesId: conversationSeriesId(conversation) }),
    };
  }

  // 单个产物的完整内容：产物列表默认不带正文，工作台点开某个文件时才取
  const artifactMatch = part.match(/^\/conversations\/([^/]+)\/artifacts\/([^/]+)$/);
  if (artifactMatch && method === 'GET') {
    const { conversation } = ownConversation(ctx, artifactMatch[1]);
    const artifact = getArtifact(conversation.id, artifactMatch[2]);
    if (!artifact) throw errors.notFound('产物不存在', 'VIBECODING_ARTIFACT_NOT_FOUND');
    return artifact;
  }

  // 文档产物的下载：产物里存的是**规格文本**（JSON/Markdown/CSV），这里当场渲染成真正的
  // .pptx / .docx / .xlsx 再发出去。见 services/ooxml/documents.js 里的取舍说明。
  const documentMatch = part.match(/^\/conversations\/([^/]+)\/artifacts\/([^/]+)\/download$/);
  if (documentMatch && method === 'GET') {
    const { conversation } = ownConversation(ctx, documentMatch[1]);
    const artifact = getArtifact(conversation.id, documentMatch[2]);
    if (!artifact) throw errors.notFound('产物不存在', 'VIBECODING_ARTIFACT_NOT_FOUND');
    if (!isDocumentKind(artifact.kind)) throw errors.badRequest('这个产物不是可下载的文档', 'VIBECODING_ARTIFACT_NOT_DOCUMENT');
    // 配图两个来源都要喂给渲染器：
    //   · 平台生成的插画（按幻灯片下标）
    //   · 规格里 {"attachment": N} 指的是**产出这一轮里学生传的第 N 张图**，按序号取
    // 越界/读不到就不放图，不让整份下载失败。
    const rendered = renderDocument(artifact, {
      attachmentImages: attachmentImageMap(conversation.id, artifact),
      generatedImages: generatedImageMap(artifact),
    });
    if (rendered.error) throw errors.badRequest(rendered.error, 'VIBECODING_DOCUMENT_RENDER_FAILED');
    const safeName = String(rendered.filename || 'download').replace(/[\r\n"\\/]/g, '_');
    audit(ctx, 'VIBECODING_ARTIFACT_DOWNLOAD', 'VIBECODING_ARTIFACT', artifact.id, null, { kind: artifact.kind, bytes: rendered.buffer.length });
    return {
      __fileResponse: true,
      status: 200,
      headers: {
        'content-type': rendered.mime,
        'content-length': String(rendered.buffer.length),
        'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
      stream: Readable.from(rendered.buffer),
    };
  }

  // 置顶 / 取消置顶（只影响自己侧栏排序）
  const pinMatch = part.match(/^\/conversations\/([^/]+)\/pin$/);
  if (pinMatch && method === 'PUT') {
    const { auth: ownerAuth, conversation } = ownConversation(ctx, pinMatch[1]);
    if (!Object.hasOwn(body, 'pinned') || typeof body.pinned !== 'boolean') throw errors.badRequest('请选择是否置顶', 'VIBECODING_PIN_FLAG_REQUIRED');
    q('UPDATE vibecoding_conversations SET pinned_at=?,updated_at=? WHERE id=? AND student_id=? AND org_id=?',
      [body.pinned ? nowIso() : null, nowIso(), conversation.id, ownerAuth.user.id, ownerAuth.user.orgId]);
    return normalizeConversation(row('SELECT * FROM vibecoding_conversations WHERE id=?', [conversation.id]));
  }

  if (conversationMatch && method === 'PUT') {
    const { auth: ownerAuth, conversation } = ownConversation(ctx, conversationMatch[1]);
    // 学生不再手写代码，所以这里只改「会话本身」的属性；代码只有一个来源——AI 产物。
    // 老客户端如果还在传 files/entryFile，明确拒掉而不是静默忽略，免得以为改成功了。
    if (body.files !== undefined || body.entryFile !== undefined) {
      throw errors.badRequest('VibeCoding 的代码由 AI 产出，不能直接编辑文件', 'VIBECODING_FILES_NOT_EDITABLE');
    }
    const title = body.title === undefined ? conversation.title : nonEmptyString(body.title, '会话标题', { max: 60 });
    let nextModel = conversation.model || null;
    if (body.model !== undefined) {
      const requested = String(body.model || '').trim();
      if (!requested) nextModel = null;
      else if (!textModelOptions().some((item) => item.id === requested)) throw errors.badRequest('该模型不在当前 AI 渠道的可选范围内', 'VIBECODING_MODEL_NOT_AVAILABLE');
      else nextModel = requested;
    }
    q('UPDATE vibecoding_conversations SET title=?,model=?,updated_at=? WHERE id=? AND student_id=? AND org_id=?',
      [title, nextModel, nowIso(), conversation.id, ownerAuth.user.id, ownerAuth.user.orgId]);
    const updated = row('SELECT * FROM vibecoding_conversations WHERE id = ?', [conversation.id]);
    return normalizeConversation(updated, { includeArtifacts: true });
  }

  if (conversationMatch && method === 'DELETE') {
    const { auth: ownerAuth, conversation } = ownConversation(ctx, conversationMatch[1]);
    transaction(() => {
      q('DELETE FROM vibecoding_conversations WHERE id=? AND student_id=? AND org_id=?', [conversation.id, ownerAuth.user.id, ownerAuth.user.orgId]);
      audit(ctx, 'VIBECODING_CONVERSATION_DELETE', 'VIBECODING_CONVERSATION', conversation.id, normalizeConversation(conversation), null);
    });
    return { deleted: true, id: conversation.id };
  }

  const messageMatch = part.match(/^\/conversations\/([^/]+)\/messages$/);
  if (messageMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = ownConversation(ctx, messageMatch[1]);
    assertConversationEditable(conversation);
    const user = activeStudent(ownerAuth);
    const context = vibeCodingContext(user, conversation.lesson_id, conversation.class_id);
    assertChatPreflight({ user, orgId: ownerAuth.user.orgId, context, model: conversation.model || '' });
    // 附件先校验，再决定正文是否可以为空（只发图不发字是允许的）
    const attachments = resolveAttachments(ownerAuth, body.attachments);
    const rawContent = String(body.content ?? '').trim();
    if (!rawContent && !attachments.length) throw errors.badRequest('消息内容不能为空', 'VALIDATION_REQUIRED');
    const content = nonEmptyString(rawContent || '看看这张图', '消息内容', { max: MAX_MESSAGE_CHARS });

    const userMessageId = id('vibemsg');
    const now = nowIso();
    q('INSERT INTO vibecoding_messages(id,conversation_id,role,content,model,status,attachments,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [userMessageId, conversation.id, 'user', content, conversation.model || null, 'SUCCEEDED', json(attachments), now]);
    const autoTitle = !conversation.title || conversation.title === DEFAULT_TITLE;
    q('UPDATE vibecoding_conversations SET last_message_at=?,updated_at=? WHERE id=?', [now, now, conversation.id]);
    if (autoTitle) q('UPDATE vibecoding_conversations SET title=? WHERE id=?', [content.slice(0, 24), conversation.id]);
    return streamAssistantReply(ctx, { auth: ownerAuth, conversation, userMessageId });
  }
  if (messageMatch && method === 'DELETE') {
    // 清空对话（保留会话本身与代码文件）
    const { conversation } = ownConversation(ctx, messageMatch[1]);
    assertConversationEditable(conversation);
    const removed = Number(count('SELECT COUNT(*) n FROM vibecoding_messages WHERE conversation_id=?', [conversation.id]) || 0);
    q('DELETE FROM vibecoding_messages WHERE conversation_id=?', [conversation.id]);
    audit(ctx, 'VIBECODING_MESSAGES_CLEAR', 'VIBECODING_CONVERSATION', conversation.id, { count: removed }, { count: 0 });
    return { cleared: true, removed };
  }

  // 重新生成：清掉最后一条用户消息之后的回答，重新问一次（失败重试也走这里）
  const regenerateMatch = part.match(/^\/conversations\/([^/]+)\/messages\/regenerate$/);
  if (regenerateMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = ownConversation(ctx, regenerateMatch[1]);
    assertConversationEditable(conversation);
    const lastUser = row("SELECT rowid AS message_rowid, * FROM vibecoding_messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC, rowid DESC LIMIT 1", [conversation.id]);
    if (!lastUser) throw errors.badRequest('还没有可以重新生成的消息', 'VIBECODING_NO_MESSAGE');
    q('DELETE FROM vibecoding_messages WHERE conversation_id=? AND (created_at > ? OR (created_at = ? AND rowid > ?))',
      [conversation.id, lastUser.created_at, lastUser.created_at, lastUser.message_rowid]);
    return streamAssistantReply(ctx, { auth: ownerAuth, conversation, userMessageId: lastUser.id });
  }

  // 编辑并重发：只允许改最后一条用户消息，改完连同后续回答一起重来
  const messageEditMatch = part.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)\/edit$/);
  if (messageEditMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = ownConversation(ctx, messageEditMatch[1]);
    assertConversationEditable(conversation);
    const message = row('SELECT rowid AS message_rowid, * FROM vibecoding_messages WHERE id=? AND conversation_id=?', [messageEditMatch[2], conversation.id]);
    if (!message) throw errors.notFound('消息不存在', 'VIBECODING_MESSAGE_NOT_FOUND');
    if (message.role !== 'user') throw errors.badRequest('只能编辑自己发出的消息', 'VIBECODING_MESSAGE_NOT_EDITABLE');
    const lastUser = row("SELECT id FROM vibecoding_messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC, rowid DESC LIMIT 1", [conversation.id]);
    if (lastUser?.id !== message.id) throw errors.badRequest('只能编辑最后一条消息', 'VIBECODING_MESSAGE_NOT_LAST');
    const content = nonEmptyString(body.content, '消息内容', { max: MAX_MESSAGE_CHARS });
    q('DELETE FROM vibecoding_messages WHERE conversation_id=? AND (created_at > ? OR (created_at = ? AND rowid > ?))',
      [conversation.id, message.created_at, message.created_at, message.message_rowid]);
    q('UPDATE vibecoding_messages SET content=? WHERE id=?', [content, message.id]);
    q('UPDATE vibecoding_conversations SET last_message_at=?,updated_at=? WHERE id=?', [nowIso(), nowIso(), conversation.id]);
    return streamAssistantReply(ctx, { auth: ownerAuth, conversation, userMessageId: message.id });
  }

  // 删除单条消息：连同它之后的回答一起删，避免留下孤立的回复
  const messageDeleteMatch = part.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)$/);
  if (messageDeleteMatch && method === 'DELETE') {
    const { conversation } = ownConversation(ctx, messageDeleteMatch[1]);
    assertConversationEditable(conversation);
    const message = row('SELECT rowid AS message_rowid, * FROM vibecoding_messages WHERE id=? AND conversation_id=?', [messageDeleteMatch[2], conversation.id]);
    if (!message) throw errors.notFound('消息不存在', 'VIBECODING_MESSAGE_NOT_FOUND');
    q('DELETE FROM vibecoding_messages WHERE conversation_id=? AND (created_at > ? OR (created_at = ? AND rowid >= ?))',
      [conversation.id, message.created_at, message.created_at, message.message_rowid]);
    audit(ctx, 'VIBECODING_MESSAGE_DELETE', 'VIBECODING_CONVERSATION', conversation.id, { messageId: message.id, role: message.role }, null);
    return { deleted: true, id: message.id };
  }

  const submitMatch = part.match(/^\/conversations\/([^/]+)\/submit$/);
  if (submitMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = ownConversation(ctx, submitMatch[1]);
    const user = activeStudent(ownerAuth);
    vibeCodingContext(user, conversation.lesson_id, conversation.class_id);
    const existing = row('SELECT * FROM vibecoding_submissions WHERE conversation_id = ?', [conversation.id]);
    // 没有老师点评这一环了：提交只是「交给平台」，可以反复提交（round+1），不再挡第二次
    // 与画布作品一致：提交即确认版权与展示授权，平台后续才可发布到作品广场
    if (ctx.body?.copyrightConfirmed !== true) {
      throw errors.badRequest('提交前请确认作品版权与展示授权', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    }
    const files = artifactsAsFiles(conversation.id);
    // 产物清单也要一起定格：作品广场靠它判断「这次交上来的到底是哪份产物」（见 submissionPreview），
    // 以及那份文档的配图在哪。只在提交这一刻取，之后学生再改也不会影响广场那一版。
    const artifacts = snapshotArtifacts(conversation.id);
    const transcript = rows("SELECT role, content, created_at FROM vibecoding_messages WHERE conversation_id=? AND status='SUCCEEDED' ORDER BY created_at, rowid", [conversation.id])
      .map((message) => ({ role: message.role, content: message.content, createdAt: message.created_at }));
    const title = body.title === undefined || String(body.title).trim() === '' ? conversation.title : nonEmptyString(body.title, '作品标题', { max: 60 });
    const description = String(body.description || '').slice(0, 1000);
    const now = nowIso();
    const submissionId = existing?.id || id('vibesub');
    transaction(() => {
      if (existing) {
        q(`UPDATE vibecoding_submissions SET title=?,description=?,files=?,artifacts=?,transcript=?,entry_file=?,round=round+1,status='PENDING',
             teacher_comment=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=?,updated_at=?,
             copyright_confirmed_at=?,copyright_confirmed_by=? WHERE id=?`,
          [title, description, json(files), json(artifacts), json(transcript), conversation.entry_file || 'index.html', now, now, now, ownerAuth.user.id, submissionId]);
      } else {
        q(`INSERT INTO vibecoding_submissions(
             id,conversation_id,student_id,org_id,class_id,lesson_id,title,description,files,artifacts,transcript,entry_file,round,status,submitted_at,created_at,updated_at,
             copyright_confirmed_at,copyright_confirmed_by
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [submissionId, conversation.id, ownerAuth.user.id, ownerAuth.user.orgId, conversation.class_id, conversation.lesson_id,
            title, description, json(files), json(artifacts), json(transcript), conversation.entry_file || 'index.html', 1, 'PENDING', now, now, now, now, ownerAuth.user.id]);
      }
      q("UPDATE vibecoding_conversations SET status='SUBMITTED',updated_at=? WHERE id=?", [now, conversation.id]);
      audit(ctx, 'VIBECODING_SUBMIT', 'VIBECODING_CONVERSATION', conversation.id, existing ? { round: existing.round } : null, { title, round: Number(existing?.round || 0) + 1 });
    });
    return normalizeSubmission(row(submissionSelect() + ' WHERE submission.id = ?', [submissionId]), { includeContent: true });
  }

  if (part === '/submissions' && method === 'GET') {
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 20 });
    const total = Number(count('SELECT COUNT(*) n FROM vibecoding_submissions submission WHERE submission.student_id = ?', [auth.user.id]) || 0);
    const items = rows(submissionSelect() + ' WHERE submission.student_id = ? ORDER BY submission.submitted_at DESC LIMIT ? OFFSET ?', [auth.user.id, limit, offset])
      .map((item) => normalizeSubmission(item));
    return pageResult(items, { page, limit, total });
  }

  return null;
}

export async function handleVibeCoding(ctx) {
  const { pathname } = ctx;
  if (!pathname.startsWith('/api/student/vibecoding')) return null;
  if (!ctx.auth) throw errors.unauthorized('请先登录', 'UNAUTHORIZED');
  const auth = requireRole(ctx, ['STUDENT']);
  const part = pathname.slice('/api/student/vibecoding'.length) || '/';
  return handleStudentVibeCoding(ctx, auth, part);
}
