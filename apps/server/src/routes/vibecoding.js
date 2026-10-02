// VibeCoding 课堂运行时：对话式代码创作（SSE 流式）+ 产物 + 受限运行 + 提交点评。
// 2026-09-13（P4 删积分）：每一轮 AI 回复不再扣积分；费用由**算力池**按单价记 cost_fen
// （学生 × 课包，四种模态共用一个上限，见 services/computePool.js）。
//
// 产物模型的要点：学生不能手写代码，代码只有一个来源——AI 回复里带文件名的围栏。
// 每有一个围栏闭合就立刻落库并推 `artifact` 事件，所以产物卡片是逐个出现的。
import {
  ApiError, audit, count, corsHeaders, errors, id, json, modelDisplayName, nonEmptyString, nowIso, normalizeLesson,
  pageParams, pageResult, parseJson, q, requireRole, row, rows, transaction, arow, aq, arows, acount, likeKeyword, likeEscapeClause, atransaction, amap, isMysql,
} from '../lib.js';
import { Readable } from 'node:stream';
import { resolveStudentLessonContext } from '../services/studentContext.js';
import { assertSessionAiControls } from '../services/aiControls.js';
import { generationProviderInfo, getGenerationProvider } from '../services/generationProvider.js';
import { recordAiUsage } from '../services/creditUsage.js';
import { getAiProviderPolicy, isModalityEnabled } from './billingConfig.js';
import { modalityChannel } from '../services/modelCapabilities.js';
import { providerSelectionForModality } from './aiGeneration.js';
import { applyGatewayRoute } from '../services/computeGateway.js';
import { computePoolSummary, priceFenFor } from '../services/computePool.js';

/** 会话归属的课包 id（算力池的键）。会话只存了课时，所以这里回查一次。 */
async function conversationSeriesId(conversation) {
  if (!conversation?.lesson_id) return null;
  return (await arow('SELECT series_id FROM course_lessons WHERE id=?', [conversation.lesson_id]))?.series_id || null;
}
import { assertExternalAiAllowed, normalizeProviderError, PROVIDER_ERROR_CODES } from '../services/providerContract.js';
import {
  artifactsAsFiles, createArtifactScanner, extractArtifacts, getArtifact, isSubmittableArtifactKind, kindForName,
  listArtifacts, pickEntryArtifact, seedDefaultArtifacts, setArtifactAttachmentImages, setArtifactGeneratedImages, upsertArtifact, upsertArtifacts,
} from '../services/vibecodingArtifacts.js';
import { MAX_ILLUSTRATIONS_PER_DECK, collectIllustrationTargets, generateIllustrationsForArtifacts } from '../services/vibecodingIllustrations.js';
import { isDocumentKind, parseDeckSpec, renderDocument } from '../services/ooxml/documents.js';
import { uploadRoot } from '../services/fileUploadSecurity.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TITLE = '新的创作对话';
const MAX_MESSAGE_CHARS = 4000;
const HISTORY_MESSAGES = 20;

// SQLite rowid records the insertion order of existing messages, including timestamp collisions.
// RDS MySQL has no rowid or message sequence yet: id is only a deterministic tie-breaker,
// NOT insertion order. Do not change the SQLite branch or claim MySQL parity without a
// separately deployed/backfilled sequence on the production RDS schema.
const messageOrderKey = isMysql ? 'id' : 'rowid';
const messageOrderDesc = `created_at DESC, ${messageOrderKey} DESC`;
const messageOrderAsc = `created_at, ${messageOrderKey}`;
const messagePosition = isMysql ? '*' : 'rowid AS message_rowid, *';
const messagePositionValue = (message) => isMysql ? message.id : message.message_rowid;
const messageBefore = isMysql
  ? '(created_at, id) < (SELECT created_at, id FROM vibecoding_messages WHERE id=?)'
  : 'rowid < (SELECT rowid FROM vibecoding_messages WHERE id=?)';

// 提交与作品广场沿用 files JSON 快照（按文件名取内容）。
// ⚠️ 这份快照**只读**：写入口是产物表（配额在 vibecodingArtifacts.js），
// 学生也不能再直接改文件（PUT 会拒掉 files/entryFile）——所以这里不再留写侧校验。
// 读侧刻意宽松（见 parseSnapshotFiles）：产物名允许中文，写侧的 ASCII 路径校验用在这里会误伤。

async function normalizeConversation(value, { includeArtifacts = false, artifacts: provided = null } = {}) {
  if (!value) return null;
  const artifacts = includeArtifacts ? (provided || await listArtifacts(value.id, { includeContent: true })) : null;
  const entry = includeArtifacts ? pickEntryArtifact(artifacts) : null;
  return {
    id: value.id, title: value.title, status: value.status, model: value.model || null,
    // 三个选项之一；老会话没有 → null（界面据此按老行为处理）
    mode: normalizeVibeMode(value.mode) || null,
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
    createdAt: value.created_at,
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
 * 平铺名要带**已知资源扩展名**才算引用（目录式路径不受此限）。
 * ⭐ 2026-10-02（老师端那条假警报）：`"name"` / `"f"` / `"d.name"` / `"bg"` 这类
 * JS 标识符、CSS 值、字体栈以前会被当成"引用"，于是 `missingLocalAssets` 给老师报
 * 「这件作品引用了 7 个本地素材（`name`、`new Blob([b]…）」，完全是无中生有。
 */
const ASSET_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|aac|flac|pptx?|docx?|xlsx?|pdf|woff2?|ttf|otf|eot|json|txt|md|csv|tsv|js|mjs|jsx|css|html?|xml|glb|gltf|obj|wasm|map|zip)$/i;

/** `type="image/png"` / `href="text/css"` 这类是 **MIME 类型**不是文件路径 ——
 *  它们恰好也含 `/`，不单独排掉就会被当成"缺素材"报给老师。 */
const MIME_LIKE = /^(?:image|text|audio|video|application|font|multipart|message|model|chemical)\/[a-z0-9.+-]+$/i;

/**
 * 长得像"文件引用"吗。**必须带已知资源扩展名**（`assets/hero`、`api/upload`、`files/` 这类
 * 一律不算 —— 实测那份"文件管理"作品里，`api/upload`、`api/list`、`files/` 都会被误当素材）。
 * 另外挡掉空白/括号/引号/分号/`$`（JS 片段与 CSS 值）与 MIME 类型（`image/png`）。
 */
function looksLikeAssetPath(clean) {
  if (/[\s(){}[\]<>"'`$;,|]/.test(clean)) return false;
  if (MIME_LIKE.test(clean)) return false;
  return ASSET_EXTENSION.test(clean);
}

/**
 * JS 里**真正会去取一个文件**的上下文（2026-10-02）。只认这些写法，不再扫"所有引号串" ——
 * 因为引号串里躺着的东西实在太杂：内置演示清单的 `{name:'萌宠角色.png', size:…}`、
 * zip 内部条目 `zip.text('word/document.xml')`、接口路由 `fetch('./api/upload?name=…')`
 * 全都会被当成"缺素材"报给老师（实测那份"文件管理"作品报了 13 条，一条真的都没有）。
 * 回写侧不受影响：`rewriteLocalReferences` 只替换**真交上来的**素材名，写法多松都安全。
 */
const JS_URL_CONTEXT_PATTERNS = [
  /\bnew\s+(?:Audio|Image|Worker|SharedWorker)\s*\(\s*["'`]([^"'`\n]{1,160})["'`]/gi,
  /\.\s*(?:src|href|poster)\s*=\s*["'`]([^"'`\n]{1,160})["'`]/gi,
  /\b(?:fetch|importScripts)\s*\(\s*["'`]([^"'`\n]{1,160})["'`]/gi,
  /\bimport\s*\(\s*["'`]([^"'`\n]{1,160})["'`]/gi,
];

function normalizeLocalReference(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('#') || /^(?:[a-z]+:|\/\/|\/)/i.test(raw)) return '';
  const clean = raw.split(/[?#]/)[0].replace(/^\.\//, '');
  if (!clean || clean.includes('..') || clean.includes('\\')) return '';
  if (!looksLikeAssetPath(clean)) return '';
  // ⚠️ 2026-09-30（用户报「教师后台看作品里图片/视频显示不出来」）：这里原来连 `/` 一起拒 ——
  //    只认**平铺名**（`hero.png`）。而学生工作区里的网页几乎都把素材放在子目录里
  //    （AI 生成的 HTML 写的就是 `src="assets/hero.png"`），于是这类引用
  //    **既不被收集（哪些文件算作品的一部分）、也不被回写（换成下载地址）**：
  //    客户端交作品时它们不在文件清单里、平台侧也认不出来 —— 交上来的作品在老师端、
  //    广场、分享页里就是一片破图/空播放器（字节压根没上来）。
  //    现在按**相对路径**收进来。仍然拒绝：绝对路径、协议、`//`、`..`、反斜杠、盘符（上面几条）。
  //    ⚠️ 与上传侧（studentRuntime.js 的 normalizeArtifactName）**同一套路径规矩**，两处要一起改。
  return clean;
}

function localArtifactReferences(name, content) {
  const kind = kindForName(name);
  const text = String(content || '');
  const values = [];
  if (kind === 'html' || kind === 'svg') {
    for (const match of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) values.push(match[1]);
  }
  if (kind === 'html' || kind === 'css' || kind === 'svg') {
    // ⚠️ 2026-10-02：`url(` 前面必须是**非标识符边界** —— 否则 `URL.createObjectURL(new Blob(…))`
    //    里的 `url(` 也会命中，抓出一串 JS 代码当"素材"（老师端那条假警报就是这么来的）。
    for (const match of text.matchAll(/(?<![\w$])url\(\s*["']?([^"')]+)["']?\s*\)/gi)) values.push(match[1]);
  }
  // ⭐ 2026-10-01：**JS 里引用的素材**也要收 —— 学生做的小游戏十有八九是这样写的：
  //    `new Audio("assets/sfx.wav")` / `fetch("assets/level.json")` / `img.src = "assets/x.png"`。
  //    只扫 html/css/svg 的话，这些**既不被收集、也不被回写**：音效/关卡文件永远丢
  //    （用户问「还有什么BUG」时用素材矩阵实测出来的，见 §八十二）。
  //    ⚠️ 只认**带引号的整段相对路径**（单/双引号、反引号），不做裸词匹配 ——
  //       正文里随便一句提到 hero.png 不该被当成引用（与上面 html 那条同一套谨慎）。
  if (kind === 'js' || kind === 'json') {
    // ⚠️ 2026-10-01 那版扫的是"所有引号串"（为了 `new Audio("assets/sfx.wav")` 这类写法）；
    //    2026-10-02 收紧成**只认真正取文件的上下文**（见 JS_URL_CONTEXT_PATTERNS 的注释）——
    //    json 例外（它是纯数据，`{"image":"assets/x.png"}` 这种就该认）。
    if (kind === 'json') {
      for (const match of text.matchAll(/["'`]([^"'`\n]{1,120})["'`]/g)) values.push(match[1]);
    } else {
      for (const pattern of JS_URL_CONTEXT_PATTERNS) {
        for (const match of text.matchAll(pattern)) values.push(match[1]);
      }
    }
  }
  // ⭐ 2026-10-02：**HTML 的内联 `<script>`** 与 .js 同一套（`new Audio("assets/sfx.wav")`）——
  //    改写侧（rewriteLocalReferences）早就认这种写法，收集侧却只认 src/href/url()，
  //    于是"只在内联脚本里引用"的素材既不被收进作品清单、也不进回写表（不对称）。
  if (kind === 'html') {
    for (const pattern of JS_URL_CONTEXT_PATTERNS) {
      for (const match of text.matchAll(pattern)) values.push(match[1]);
    }
  }
  return values.map(normalizeLocalReference).filter(Boolean);
}

/** 提交只定格当前主产物；HTML 会连同它引用的本地产物一起定格。 */
export function submissionArtifactNames(allFiles, entryFile) {
  if (!Object.hasOwn(allFiles, entryFile)) return [];
  const entryKind = kindForName(entryFile);
  if (isDocumentKind(entryKind)) return [entryFile];
  if (entryKind !== 'html') return [];
  const selected = new Set([entryFile]);
  const queue = [entryFile];
  while (queue.length) {
    const current = queue.shift();
    for (const reference of localArtifactReferences(current, allFiles[current])) {
      if (!Object.hasOwn(allFiles, reference) || selected.has(reference) || kindForName(reference) === 'html') continue;
      selected.add(reference);
      queue.push(reference);
    }
  }
  return [...selected];
}

function pickFiles(files, names) {
  return Object.fromEntries(names.filter((name) => Object.hasOwn(files, name)).map((name) => [name, files[name]]));
}

function conversationScopeSql(alias = 'conversation') {
  return `${alias}.student_id = ? AND ${alias}.org_id = ?`;
}

async function ownConversation(ctx, conversationId) {
  const auth = requireRole(ctx, ['STUDENT']);
  const conversation = await arow(
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
 * 只接受本人上传的私有或公开文件；是否让模型看见由 mime/inline 决定。
 * 私有附件通过登录态下载，提交发布后再由作品快照代理公开，上传本身不会产生匿名公网入口。
 */
async function resolveAttachments(auth, rawList) {
  const entries = (Array.isArray(rawList) ? rawList : [])
    .map((item) => ({ id: String(typeof item === 'string' ? item : item?.id || '').trim(), inline: String(typeof item === 'string' ? '' : item?.inline || '') }))
    .filter((item) => item.id);
  const ids = entries.map((item) => item.id);
  if (!ids.length) return [];
  if (ids.length > MAX_ATTACHMENTS) throw errors.badRequest(`一次最多带 ${MAX_ATTACHMENTS} 个附件`, 'VIBECODING_TOO_MANY_ATTACHMENTS');
  const resolved = [];
  for (const assetId of ids) {
    const asset = await arow('SELECT * FROM file_assets WHERE id=?', [assetId]);
    if (!asset || asset.status !== 'ACTIVE') throw errors.badRequest('附件不存在或已失效', 'VIBECODING_ATTACHMENT_NOT_FOUND');
    if (asset.owner_user_id !== auth.user.id) throw errors.forbidden('只能引用自己上传的附件', 'VIBECODING_ATTACHMENT_NOT_OWNED');
    if (!['PRIVATE', 'PUBLIC_PLATFORM', 'PUBLIC_RELEASE'].includes(asset.visibility)) {
      throw errors.badRequest('附件可见范围不适用于 VibeCoding', 'VIBECODING_ATTACHMENT_VISIBILITY_INVALID');
    }
    // inline 只接受图片 data URL，且限长（超限/非图片就不带，模型看不到但页面能用外链）
    const raw = entries.find((item) => item.id === assetId)?.inline || '';
    const inline = raw.startsWith('data:image/') && raw.length <= MAX_INLINE_CHARS ? raw : '';
    resolved.push({
      id: asset.id, name: String(asset.file_name || '附件'), url: `/api/student/file-assets/${asset.id}/download`,
      mime: String(asset.mime_type || ''), inline,
    });
  }
  return resolved;
}

async function activeStudent(auth) {
  const user = await arow("SELECT * FROM users WHERE id=? AND org_id=? AND status='ACTIVE'", [auth.user.id, auth.user.orgId]);
  if (!user) throw errors.forbidden('学生账号不可用', 'ACCOUNT_DISABLED');
  return user;
}

async function vibeCodingContext(user, lessonId, classId) {
  const context = await resolveStudentLessonContext(user, lessonId, classId);
  if (!context.canUseVibeCodingNow) {
    throw errors.forbidden(context.vibeCodingBlockReason || '当前不可进入 VibeCoding 课堂', context.vibeCodingBlockCode || 'VIBECODING_CLASSROOM_UNAVAILABLE');
  }
  return context;
}

// 调上游前的预检：课堂管控 / 平台模态开关 / 课时能力 / 个人额度，任一不满足就不发起调用。
async function assertChatPreflight({ user, orgId, context, model = '' }) {
  assertSessionAiControls({ modality: 'TEXT', session: context.activeSession, orgId, userId: user.id });
  if (!(await isModalityEnabled(orgId, 'TEXT')).enabled) throw errors.forbidden('平台已关闭该 AI 能力', 'MODALITY_DISABLED');
  if (!(context.lesson?.capabilities || []).includes('text')) throw errors.forbidden('本课时未开放 AI 文字能力', 'LESSON_CAPABILITY_DISABLED');
  // 2026-09-13（P4 删积分）：成员 AI 上限 / 周期额度两道刹车已删除（额度看算力池）。
  // 算力池（学生 × 课包）：对话也从这个池子扣，与画布/视频/音乐共用一个上限
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

async function recordFailedMessage(conversationId, model, content, errorCode) {
  const messageId = id('vibemsg');
  await aq('INSERT INTO vibecoding_messages(id,conversation_id,role,content,model,status,error_code,credits_charged,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [messageId, conversationId, 'assistant', content, model, 'FAILED', errorCode || 'VIBECODING_CHAT_FAILED', 0, nowIso()]);  return messageId;
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
async function triggeringImageAttachments(conversationId, artifact) {
  // getArtifact() 返回的是驼峰字段（messageId），别按数据库列名（message_id）去读 —— 读错就永远取不到图，
  // 而且**不报错**：表现为「PPT 里就是没图」，最难查的那种。
  const messageId = artifact?.messageId || artifact?.message_id;
  if (!messageId) return [];
  const message = await arow(
    `SELECT attachments FROM vibecoding_messages
      WHERE conversation_id=? AND role='user' AND attachments IS NOT NULL AND attachments<>''
        AND ${messageBefore}
      ORDER BY ${isMysql ? messageOrderDesc : 'rowid DESC'} LIMIT 1`,
    [conversationId, messageId],
  );
  return parseAttachments(message?.attachments).filter((item) => String(item.mime || '').startsWith('image/'));
}

function referencedAttachmentOrdinals(artifact) {
  if (String(artifact?.kind || '').toLowerCase() !== 'pptx') return [];
  const deck = parseDeckSpec(String(artifact?.content || ''));
  if (!deck) return [];
  return [...new Set(deck.slides.map((slide) => Number(slide.imageAttachment)).filter((value) => Number.isInteger(value) && value > 0))];
}

async function currentAttachmentImages(conversationId, artifact) {
  if (Array.isArray(artifact?.attachmentImages)) return artifact.attachmentImages;
  const sources = await triggeringImageAttachments(conversationId, artifact);
  return referencedAttachmentOrdinals(artifact)
    .map((index) => ({ index, fileId: sources[index - 1]?.id || '' }))
    .filter((item) => item.fileId);
}

async function persistArtifactAttachmentImages(conversationId, artifact) {
  if (!artifact?.id || String(artifact.kind || '').toLowerCase() !== 'pptx' || Array.isArray(artifact.attachmentImages)) return;
  await setArtifactAttachmentImages(artifact.id, await currentAttachmentImages(conversationId, artifact));
}

async function persistConversationAttachmentImages(conversationId) {
  for (const artifact of await listArtifacts(conversationId, { includeContent: true })) await persistArtifactAttachmentImages(conversationId, artifact);
}

/** 从本地存储读回一份素材的字节（不给自己的接口发 HTTP 请求，磁盘上就是那份文件） */
async function readAssetBytes(fileId) {
  const asset = await arow('SELECT storage_kind, storage_key FROM file_assets WHERE id=?', [fileId]);
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
async function imageMapFrom(items, indexOf) {
  const images = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.fileId || item.error) continue;
    const index = indexOf(item);
    if (!Number.isInteger(index) || index < -1) continue;
    const buffer = await readAssetBytes(item.fileId);
    if (buffer) images.set(index, buffer);
  }
  return images;
}

/**
 * 产物记着的生成插画（幻灯片下标 → 图片字节）。
 * ⚠️ **-1 是封面**（见 pptx.js 的 COVER_IMAGE_KEY），别当成非法下标丢掉 ——
 * 那样封面永远是纯色版、而且不报错。失败项与读不到的素材照样跳过。
 */
async function generatedImageMap(artifact) {
  return await imageMapFrom(artifact?.generatedImages, (item) => Number(item.slideIndex));
}

/**
 * 附件序号（1 起） → 图片字节。取不到的序号直接不进 Map，渲染时那一页就不放图。
 * 导出是为了给 p47 做守卫：这条链路连着「产物 messageId」「附件里的 mime」「磁盘上的素材」
 * 三处，任何一处断掉都**不报错**、只是 PPT 里没图 —— 必须能被自动化盯住。
 */
export async function attachmentImageMap(conversationId, artifact) {
  return await imageMapFrom(await currentAttachmentImages(conversationId, artifact), (item) => Number(item.index));
}

/**
 * 提交快照里的配图（同一口径，只是数据来自快照而不是活会话）：
 *   · generatedImages：[{slideIndex, fileId}]，-1 是封面
 *   · attachmentImages：[{index, fileId}]，index 从 1 起（对应规格里的 {"attachment": N}）
 */
export async function snapshotImageMaps(artifact) {
  return {
    generatedImages: await imageMapFrom(artifact?.generatedImages, (item) => Number(item.slideIndex)),
    attachmentImages: await imageMapFrom(artifact?.attachmentImages, (item) => Number(item.index)),
  };
}

/**
 * 能产出哪些**文档**、分别怎么写。
 *
 * ⚠️ 这不是「人设」，也不是 2026-09-11 删掉的那种「产物约定」（当时删的是人设 + 要求模型自己起文件名）。
 * 这是三种文件格式的**写法说明**——模型不可能凭空猜出我们的规格长什么样，不给它，这个能力就等于不存在。
 * 反过来，这里也只说格式，不规定它必须产生产物、不规定话术。
 */
const WEB_APP_GUIDE = [
  '网页与互动作品请输出可直接运行的完整 HTML（可以配套本地 CSS/JS/SVG 文件），必须包含 viewport，桌面和手机都不能横向溢出。当前预览器不支持 npm、ES module/import、Worker 或用 fetch 读取本地 JSON；相关逻辑请写成普通浏览器脚本，数据直接放进 JS。',
  '学生说“做小程序、手机应用、App”时，这里指的是浏览器内可点击的手机模拟作品，不是微信小程序：仍输出 HTML/CSS/JS，按 390×844 画布优先设计，并确保按钮、输入、切换、计分、弹层等核心交互真的可用。',
  '成品要有清晰的信息层级、统一色板、可读字体、稳定间距，以及 hover/active/focus、加载、空状态或结果反馈；不要放点不动的装饰按钮、# 空链接、功能说明文案或 Lorem Ipsum。',
  '写完前自行检查：脚本选择器存在、按钮都有事件、首屏无重叠、手机可滚动、外部素材加载失败时有可用的视觉兜底。',
].join('\n');

const DOCUMENT_GUIDE = [
  '除了网页，你也可以直接产出 Office 文档：用一个带扩展名的代码块写**内容**，平台会渲染成真正的文件，学生下载后能用 PowerPoint / Word / Excel / WPS 打开。',
  '· PPT：```pptx 文件名.pptx ```，内容是一段 JSON —— {"title":"标题","subtitle":"副标题","author":"署名","theme":"ocean","slides":[{"title":"这一页的标题","bullets":["要点一","要点二"]}]}。先规划故事线再写页面；每页只表达一个结论，正文页 3~6 条要点、单条不超过 40 字，不要把每页都做成相同的项目符号列表。',
  '  · theme 选一个贴合内容的配色：ocean（蓝，风景/科技）、forest（绿，自然/环保）、sunset（橙，美食/热情）、candy（紫，童趣/节日）、ink（默认）。',
  '  · 版式按内容选择：section 做章节页，quote 做金句页，thanks 做结尾页；metrics 用 metrics:[{"value":"72%","label":"参与率"}] 展示 2~4 个指标；timeline 用 steps:["调研","设计","验证"] 展示 3~6 个时间节点；comparison 用 columns:[{"title":"方案 A","bullets":["…"]},{"title":"方案 B","bullets":["…"]}] 做双栏对比。',
  '  · 数据与结构组件：chart 用 chart:{"type":"bar","labels":["一月","二月","三月"],"values":[42,58,76],"unit":"%","highlight":2}；table 用 table:{"headers":["项目","本周","变化"],"rows":[["晨读","5次","+2"]]}；process 用 process:[{"title":"调研","detail":"确认问题"},{"title":"设计","detail":"形成方案"},{"title":"验证","detail":"收集反馈"}]。metrics、chart 和 table 页必须写 source；若是虚构演示数据就明确写“课堂示例数据”，不能编造机构或报告名。',
  '  · 8 页以上至少使用 3 种内容版式，用 1~2 个章节页分段；不要连续 4 页使用同一种版式。每页只有一个视觉焦点，能用图表/流程/对比表达就不要退回长段项目符号。',
  '  **配图**（很影响成品像不像样，值得用）：封面写 {"cover":{"prompt":"…"}}，正文页在那一页加 image 字段，两种写法 ——',
  '  ① 让平台生成插画：{"title":"赛里木湖","bullets":["湖水蓝得像宝石"],"image":{"prompt":"新疆赛里木湖的夏天，写实插画风格，蓝天、雪山倒影、湖边草地，横构图"}}。'
    + `提示词要具体（画什么、什么风格、什么构图），**全篇最多 ${MAX_ILLUSTRATIONS_PER_DECK} 张（含封面）**，优先给封面和最有画面感的那几页，**不要每页都配**。`,
  '  ② 用学生自己传的图：{"image":{"attachment":1}} —— attachment 是**学生这条消息里第几张图**（平台会告诉你有几张、怎么编号）。学生传了图又做 PPT 时，就该把图用上，别浪费。',
  '  配图是**可选**的：拿不准风格、或内容本身就是表格/流程时，不配图反而更好。',
  '· Word：```docx 文件名.docx ```，内容是 Markdown —— # 一级标题、- 无序列表、1. 有序列表、| 表格 |、**粗体**。',
  '· Excel：```xlsx 文件名.xlsx ```，内容是 CSV，**第一行是表头**。',
  '学生要文档时就直接给对应的代码块，不要用文字描述一遍内容来代替。',
].join('\n');

/**
 * 学生进 VibeCoding 时选的「做什么」（2026-09-17）。
 * 它只决定**AI 的角色与默认产出**，不决定能力边界 —— 三种选项都照旧遵守上面的格式说明，
 * 所以选了「对话」也不会突然不会写网页。
 *
 * ⚠️ **空值 = 迁移前的老会话**：那时没有选项，提示词就是「格式说明 + 课时上下文」。
 * 老会话必须逐字保持原样（零回归），所以这里的空值分支不许再加料。
 */
export const VIBE_MODES = ['CHAT', 'CODE', 'WEB'];

export function normalizeVibeMode(value) {
  const text = String(value || '').trim().toUpperCase();
  return VIBE_MODES.includes(text) ? text : '';
}

/** 三个选项各自的角色说明（能力说明在上面那两份 guide 里，公用）。 */
const MODE_ROLE_GUIDE = {
  CHAT: [
    '【本节选项：对话】学生选的是「对话」，你的角色是这节课的助教：讲清概念、答疑、给思路、检查他的想法对不对。',
    '默认**不要**产出文件 —— 除非学生明确要你写代码或做个东西，那就照后面的格式说明产出。',
  ].join('\n'),
  CODE: [
    '【本节选项：写代码】学生选的是「写代码」，你要陪他把代码写出来：产出完整可运行的文件（用围栏加文件名），并**讲清每段关键代码在干什么**，让他看懂而不是只拿到一堆代码。',
    '允许多文件工程（HTML + CSS + JS 分开），但要在文件之间说明关系。写完按上面的自查项过一遍。',
  ].join('\n'),
  WEB: [
    '【本节选项：做网页】学生选的是「做网页」，你要做出一个**能直接在右边预览**的页面：优先单文件 `index.html`（CSS 与 JS 内联在里面），桌面和手机都不能横向溢出。',
    '**不要依赖外网资源**（CDN 上的库、图、字体在预览里会加载失败或直接被拦）：需要图标/插画就用内联 SVG 或 CSS 画出来。',
  ].join('\n'),
};

export async function lessonSystemMessage(conversation) {
  const lesson = conversation?.lesson_id
    ? await arow('SELECT title, summary, lesson_content FROM course_lessons WHERE id=?', [conversation.lesson_id])
    : null;
  const mode = normalizeVibeMode(conversation?.mode);
  const parts = [
    '请用适合 8–16 岁学生理解的中文回答，避免任何危险或不适龄内容。',
  ];
  // 选了选项就在最前面放它的角色说明；没选（老会话）与迁移前逐字一致。
  if (mode) parts.push(MODE_ROLE_GUIDE[mode]);
  // 两种产出格式说明**永远都给**：选项只改默认行为，不改能力边界。
  parts.push(WEB_APP_GUIDE, DOCUMENT_GUIDE);
  // 产物清单原来是为了配合「产物约定」——约定删了，这段也随之删掉。
  // 允许不带 id 调用（单测里只验证课时上下文的拼装）。
  if (lesson) {
    if (lesson.title) parts.push(`本节 VibeCoding 课时：${lesson.title}`);
    if (lesson.summary) parts.push(`课时简介：${String(lesson.summary).slice(0, 600)}`);
    if (lesson.lesson_content) parts.push(`课时正文与教学指引：\n${String(lesson.lesson_content).slice(0, 4000)}`);
  }
  return { role: 'system', content: parts.join('\n\n') };
}

export async function conversationHistory(conversationId, limit = HISTORY_MESSAGES) {
  return (await arows(
    `SELECT role, content, attachments FROM vibecoding_messages WHERE conversation_id=? AND status='SUCCEEDED' ORDER BY ${messageOrderDesc} LIMIT ?`,
    [conversationId, limit],
  )).reverse().map((message) => {
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
export async function textModelOptions() {
  const channel = modalityChannel(await getAiProviderPolicy(), 'TEXT');
  if (!channel) return [];
  const mappings = Array.isArray(channel.modelMappings) ? channel.modelMappings : [];
  // 显示名：**运营配的别名优先**，没配就还用「读取模型」拿到的上游名，再没有就是 ID
  // （2026-09-23 用户口径：「在画布或者 vibecoding 课堂模型名字这里可以映射我改过的名字」）。
  // ⚠️ 只是显示名 —— 会话里存、发上游用的都是 `id`（选模型那条校验也仍然比 ID）。
  const policy = await getAiProviderPolicy();
  const displayNameOf = (id) => modelDisplayName(policy, id, mappings.find((item) => item?.id === id)?.displayName);
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
export async function textDefaultModel() {
  return String(modalityChannel(await getAiProviderPolicy(), 'TEXT')?.model || '').trim();
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
  const policy = await getAiProviderPolicy();
  const lesson = await normalizeLesson(await arow('SELECT * FROM course_lessons WHERE id=?', [conversation.lesson_id]), { asPublished: true });
  const lessonModel = lesson?.classroomConfig?.vibeCoding?.model || '';
  // Resolve each new logical request once; its provider instance retains this route in flight.
  const selection = await applyGatewayRoute(
    providerSelectionForModality(policy, 'TEXT', lessonModel || conversation.model || ''),
    { orgId: auth.user.orgId, studentId: auth.user.id, lessonId: conversation.lesson_id || '', modality: 'TEXT' },
  );
  const provider = getGenerationProvider(selection);
  const providerInfo = generationProviderInfo(selection);
  assertExternalAiAllowed({ mode: providerInfo.mode, allowStudentExternalContent: policy.allowStudentExternalContent });
  if (typeof provider.generateStream !== 'function') throw errors.conflict('当前 AI 渠道不支持流式对话', 'VIBECODING_STREAM_UNAVAILABLE');

  const history = [await lessonSystemMessage(conversation), ...await conversationHistory(conversation.id)];
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
  async function flushArtifacts(deltas) {
    for (const candidate of deltas) {
      const saved = await upsertArtifact({
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
      computeContext: { orgId: auth.session?.org_id || auth.user.orgId, userId: auth.user.id, sessionId: conversation.class_session_id || null, lessonId: conversation.lesson_id },
      signal: abortController.signal,
      onReasoning: (delta) => {
        const piece = String(delta || '');
        reasoningChars += piece.length;
        // 只推**增量**而不是累积全文：推理可能几万字，每来一小段就重发整段是 O(n²) 的流量。
        // 前端自己累积（见 vibecodingWorkspace 的 onStatus）。
        sseSend(ctx, 'status', { phase: 'thinking', chars: reasoningChars, delta: piece });
      },
      onDelta: async (delta, full) => {
        streamedText = full;
        sseSend(ctx, 'delta', { delta });
        // 每来一段就找一遍「这次新闭合」的围栏；未闭合的不会命中，所以不会产出半截文件
        const closed = scanner.push(delta);
        if (closed.length) await flushArtifacts(closed);
      },
    });
    // C3 前置：流式上游在最后一帧带 usage 时才有值（默认不比这个）；没有就是 null，不影响任何口径
    const streamedUsage = result?.usage || result?.assets?.find((asset) => asset?.metadata?.tokens)?.metadata?.tokens || null;
    const text = String(result?.assets?.[0]?.metadata?.text || streamedText || '').trim();
    if (!text) throw errors.conflict('AI 没有返回内容', 'GENERATION_EMPTY_RESULT');

    // 兜底：万一渠道不是逐 delta 推的（一次性返回），这里再整段扫一遍
    const remaining = scanner.text === text ? [] : extractArtifacts(text);
    if (remaining.length) await flushArtifacts(remaining);

    const assistantMessageId = id('vibemsg');
    await atransaction(async () => {
      const fresh = await arow('SELECT * FROM vibecoding_conversations WHERE id=? AND student_id=?', [conversation.id, auth.user.id]);
      if (!fresh) throw errors.notFound('创作会话不存在', 'VIBECODING_CONVERSATION_NOT_FOUND');
      // 2026-09-13（P4 删积分）：不再扣积分（原来这里是 chargeCreditsInTransaction + debitUserAiCredits）。
      // C3 前置：流式响应里若带 usage（上游支持 include_usage 时）就记下来；不带就是 0，计费口径不变
      await recordAiUsage({
        orgId: auth.user.orgId, userId: auth.user.id, sessionId: fresh.class_session_id || null,
        modality: 'TEXT', model: selection.model, status: 'SUCCESS',
        inputTokens: streamedUsage?.inputTokens || 0, outputTokens: streamedUsage?.outputTokens || 0,
        // 算力池账本：对话也从这个池子扣（与画布/视频/音乐共用一个上限）
        costFen: provider.compute?.saleSnapshot?.unitFen ?? await priceFenFor({ modality: 'TEXT', model: selection.model }), seriesId: await conversationSeriesId(conversation),
        pricing: { compute: provider.compute, source: 'vibecoding', provider: provider.name, conversationId: fresh.id, mode: selection.provider },
      });
      await aq('INSERT INTO vibecoding_messages(id,conversation_id,role,content,model,status,credits_charged,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [assistantMessageId, fresh.id, 'assistant', text, selection.model, 'SUCCEEDED', 0, nowIso()]);
      // 这一轮产出的产物认领到这条消息上，方便聊天里按消息分组
      if (emittedArtifactIds.size) {
        const placeholders = [...emittedArtifactIds].map(() => '?').join(',');
        await aq(`UPDATE vibecoding_artifacts SET message_id=? WHERE id IN (${placeholders}) AND message_id IS NULL`,
          [assistantMessageId, ...emittedArtifactIds]);
      }
      const entry = pickEntryArtifact(await listArtifacts(fresh.id));
      await aq('UPDATE vibecoding_conversations SET model=?,entry_file=?,last_message_at=?,updated_at=? WHERE id=?',
        [selection.model, entry?.name || 'index.html', nowIso(), nowIso(), fresh.id]);
    });
    const message = normalizeMessage(await arow('SELECT * FROM vibecoding_messages WHERE id=?', [assistantMessageId]));
    // 文档产物要配的插画，在这一轮**消息落库之后**才生成：这时产物已认领到这条消息上，
    // 也才有「产出那一轮」可回溯。生成期间照常推 status 事件，学生能看到「正在生成插画」，
    // 而不是干等（参考实现里那一步「正在收集 PPT 素材」就是这个位置）。
    // ⚠️ 注意：fresh 是在上面的 transaction 回调里声明的，出了回调就没了 ——
    // 在这里直接用它会在求值实参时抛 ReferenceError，被本层的 catch 吞掉，
    // 表现成「插画静默不生成」（我踩过）。所以在外面重新取一次。
    const freshConversation = await arow('SELECT * FROM vibecoding_conversations WHERE id=? AND student_id=?', [conversation.id, auth.user.id]) || conversation;
    for (const artifact of (await listArtifacts(conversation.id, { includeContent: true })).filter((item) => emittedArtifactIds.has(item.id))) {
      await persistArtifactAttachmentImages(conversation.id, artifact);
    }
    await illustrateTurn(ctx, auth, freshConversation, emittedArtifactIds);
    sseSend(ctx, 'done', {
      message,
      // 权威产物清单：前端拿它跟流式期间收到的卡片对账
      artifacts: await listArtifacts(conversation.id, { includeContent: true }),
      entryFile: pickEntryArtifact(await listArtifacts(conversation.id))?.name || 'index.html',
      streamed: result?.streamed !== false,
    });
  } catch (error) {
    const rawCode = error?.code || 'VIBECODING_CHAT_FAILED';
    // 学生主动停止时连接先断，抛出的可能是底层 socket 错误而不是我们自己的 ABORTED，
    // 所以以 abortController 状态为准：不落失败消息、不扣费。
    if (abortController.signal.aborted || rawCode === PROVIDER_ERROR_CODES.ABORTED) {
      sseSend(ctx, 'aborted', { code: 'VIBECODING_ABORTED', artifacts: await listArtifacts(conversation.id, { includeContent: true }) });
    } else {
      // ⚠️ 这里必须**归一化后再给学生看**：网关「额度用尽」在 HTTP 上是 403，
      // 直接透原始文案就会把「请在管理后台重新填写并保存该渠道 API Key」这种给运维看的话
      // 甩给一个十来岁的学生（而且真正的原因是他这节课的钱花完了）。
      const normalized = normalizeProviderError(error);
      const code = normalized.code || rawCode;
      await recordFailedMessage(conversation.id, selection.model, streamedText, code);
      await recordAiUsage({
        orgId: auth.user.orgId, userId: auth.user.id, sessionId: conversation.class_session_id || null,
        modality: 'TEXT', model: selection.model, status: 'FAILED', failCode: code,
        costFen: 0, seriesId: await conversationSeriesId(conversation),
        pricing: { compute: provider.compute, source: 'vibecoding', provider: provider.name, conversationId: conversation.id },
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
  const artifacts = (await listArtifacts(conversation.id, { includeContent: true })).filter((item) => artifactIds.has(item.id));
  if (!collectIllustrationTargets(artifacts).length) return;
  try {
    const user = await activeStudent(auth);
    const context = await resolveStudentLessonContext(user, conversation.lesson_id, conversation.class_session_id || 'MISSING_SESSION');
    const results = await generateIllustrationsForArtifacts({
      auth: { ...auth, rawUser: user },
      context,
      artifacts,
      onProgress: (info) => sseSend(ctx, 'status', info),
    });
    for (const [artifactId, images] of results) {
      await setArtifactGeneratedImages(artifactId, images);
      const updated = await getArtifact(conversation.id, artifactId);
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

async function embeddedFileIds(files, ownerUserId = '') {
  const ids = new Set();
  for (const content of Object.values(files || {})) {
    for (const match of String(content || '').matchAll(/\/api\/student\/file-assets\/([\w-]+)\/download/g)) {
      const file = await arow('SELECT owner_user_id,visibility,status,mime_type FROM file_assets WHERE id=?', [match[1]]);
      if (file?.status === 'ACTIVE' && String(file.mime_type || '').startsWith('image/')
        && (file.owner_user_id === ownerUserId || ['PUBLIC_PLATFORM', 'PUBLIC_RELEASE'].includes(file.visibility))) ids.add(match[1]);
    }
  }
  return [...ids];
}

/**
 * 提交那一刻的产物清单。只存元信息与图片引用（fileId），不存正文，所以这一列很小。
 * ⚠️ 配图引用必须一起定格：只存正文的话，广场渲染出来的 PPT 会**静默**丢掉所有图
 * （学生自己下载的那份有图、广场那份没有，而两边都不报错）。
 */
export async function snapshotArtifacts(conversationId, names = null, files = {}, ownerUserId = '') {
  const allowed = names ? new Set(names) : null;
  const webImageIds = await embeddedFileIds(files, ownerUserId);
  return await amap((await listArtifacts(conversationId, { includeContent: true })).filter((artifact) => !allowed || allowed.has(artifact.name)), async (artifact) => ({
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
    attachmentImages: await currentAttachmentImages(conversationId, artifact),
    embeddedImages: artifact.name === names?.[0] && kindForName(artifact.name) === 'html'
      ? webImageIds.map((fileId) => ({ fileId })) : [],
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
      // 存的是**真文件**时的引用（学生创作环境交上来的 .pptx/.docx/.xlsx 走这条）：
      // 正文在 file_assets 里，快照只记 id。空串/缺失一律当「这份是规格文本」。
      fileId: item.fileId ? String(item.fileId) : null,
      // ⭐ 2026-09-30：`coverFileId`（客户端交作品时截的那一屏，见 studentRuntime 的 COVER_FILE_NAME）
      //    原来在这里被**整条丢掉** —— 快照里明明写着，可这个归一化函数只搬"它认识的那几个字段"，
      //    于是下游全灭：分享卡的 `piece.coverUrl` 恒 null（扫码看到的卡片没封面）、
      //    取图准入名单少一个 id、封面回退到按类型画的占位图。
      //    教训与 §三十三 同款：**归一化函数漏字段 = 全链路静默失效，而且每层看起来都"正常"**。
      coverFileId: item.coverFileId ? String(item.coverFileId) : null,
      generatedImages: (Array.isArray(item.generatedImages) ? item.generatedImages : []).filter((image) => image?.fileId),
      attachmentImages: (Array.isArray(item.attachmentImages) ? item.attachmentImages : []).filter((image) => image?.fileId && Number(image.index) > 0),
      embeddedImages: (Array.isArray(item.embeddedImages) ? item.embeddedImages : []).filter((image) => image?.fileId),
      // HTML 里**被引用的本地素材**（图/视频/音频…）：`embeddedImages` 只管图片那半边，
      // 视频/音频在这里（见 studentRuntime.js 的 embeddedAssets）。准入名单要用到它，
      // 不然作品里的视频在老师端与分享页里取不到（学生本地看得见、别人全看不到）。
      embeddedAssets: (Array.isArray(item.embeddedAssets) ? item.embeddedAssets : []).filter((asset) => asset?.fileId),
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
 * 「这次交上来的主产物」由提交时的 entry_file 明确指定，不再根据时间猜测。
 */
export function submissionPreview(submission) {
  const artifacts = parseSnapshotArtifacts(submission);
  if (!artifacts.length) return null;
  const entryFile = String(submission?.entry_file || '').trim();
  const selected = artifacts.find((item) => item.name === entryFile) || artifacts[0];
  return { name: selected.name, kind: selected.kind, document: isDocumentKind(selected.kind) };
}

/**
 * 作品广场的产物清单：每个文件是什么、能不能下载、配图在哪。
 * 图片地址在这一层拼好（前端不再自己定规则），附件图走**限定在本作品快照内**的代理地址：
 * 学生传的图不是公开素材，只有出现在这份已发布作品里的那几张才允许被公开取到。
 */
/**
 * 一件作品里的**全部产物名**：`files` ∪ `artifacts` 的并集。
 * ⚠️ 必须取并集：二进制产物（学生交上来的真 .pptx）**不在 files 里**，只以 fileId 存在快照里 ——
 *    只枚举 files 的话它会从清单里凭空消失（广场看不到、也没法下载，而两边都不报错）。
 * ⭐ 2026-09-30：**主页产物清单**（publicArtifactCatalog）与**分享码**（sharePieceKeysOf）
 *    两边共用这一份 —— 各枚举一套的话，"主页上看得到的那一件"可能发不了码（写守卫时实测踩到）。
 */
export function snapshotArtifactNames(submission) {
  const files = parseSnapshotFiles(submission?.files);
  const artifacts = parseSnapshotArtifacts(submission);
  return [...new Set([...Object.keys(files), ...artifacts.map((item) => item.name)])].sort();
}

/**
 * 这件作品里**可独立分享的产出物**（2026-10-02 用户口径：
 * 「客户端那边传过来的是 1 个主文件，然后是一些引用文件……这里肯定就是一个整体啊」）。
 *
 *   · **网页作品**（入口是 html）：可分享的 = **入口那一个整体** —— 它 `src/href` 引用的
 *     css / js / 图片 / 音视频都是**它的零件**，不是独立作品（分享「styles.css」毫无意义）；
 *     外加**没被入口引用**的产物（学生另外交的 pptx、单独录的视频）才算另一件。
 *   · 其它（入口是 pptx/docx/… 的文档件）：全部产物照旧各自成件。
 *
 * 用途：① 分享面板的「选哪一件」——只剩一件时那个下拉根本不该出现；
 *      ② 发码的准入（`sharePieceKeysOf`）——两边同一套，免得"看得见却分享不了"。
 * ⚠️ 分享**卡**的取件是按名字直接查 `parseSnapshotArtifacts` 的，不依赖这份清单 ——
 *    所以收窄它不会让**已发出的**老码失效（老码指向某个零件时照旧渲染）。
 */
export function shareableArtifactNames(submission) {
  const files = parseSnapshotFiles(submission?.files);
  const names = snapshotArtifactNames(submission);
  const entry = String(submission?.entry_file || '').trim();
  if (!entry || !Object.hasOwn(files, entry) || kindForName(entry) !== 'html') return names;
  const parts = new Set(submissionArtifactNames(files, entry));
  parts.delete(entry);
  return names.filter((name) => name === entry || !parts.has(name));
}

export function publicArtifactCatalog(submission) {  const artifacts = parseSnapshotArtifacts(submission);
  const byName = new Map(artifacts.map((item) => [item.name, item]));
  const base = `/api/public/vibecoding-works/${submission.share_token}`;
  // 可独立分享的那几件（2026-10-02：网页作品的 css/js 是零件，不是独立的"一件"）——
  // 清单里**照样列出**每个文件（预览/下载要用），只是**零件不带 pieceKey 语义**：
  // `shareable:false` 让前端的"选哪一件"不列它，发码准入也不认它。
  const shareable = new Set(shareableArtifactNames(submission));
  return snapshotArtifactNames(submission).map((name) => {
    const meta = byName.get(name) || {};
    const kind = meta.kind || kindForName(name);
    // ⭐ 2026-09-30：每件产物带 `pieceKey` —— 学生主页要**逐件**发分享码，键由服务端算
    //    （与 `sharePieceKeysOf()` 同一套规则；前端别自己拼，两边口径迟早飘）。
    const item = { name, kind, document: isDocumentKind(kind), updatedAt: meta.updatedAt || null, pieceKey: `artifact:${name}`, shareable: shareable.has(name) };
    if (!item.document) return item;
    if (meta.fileId) {
      // 这份是**真文件**：预览用服务端转出来的 PDF（Office 转 PDF，见 materialPreview），
      // 下载给原文件。两者都不经过「规格文本渲染」那条路。
      return {
        ...item,
        storage: 'FILE',
        previewUrl: `${base}/files/${encodeURIComponent(name)}/preview`,
        downloadUrl: `${base}/files/${encodeURIComponent(name)}/download`,
      };
    }
    return {
      ...item,
      storage: 'SPEC',
      downloadUrl: `${base}/files/${encodeURIComponent(name)}/download`,
      images: {
        generated: Object.fromEntries((meta.generatedImages || [])
          .map((image) => [String(image.slideIndex), `${base}/images/${image.fileId}`])),
        attachment: Object.fromEntries((meta.attachmentImages || [])
          .map((image) => [String(image.index), `${base}/images/${image.fileId}`])),
      },
    };
  });
}

/**
 * 这份作品快照里**以真文件存的产物** id 集合（公开取文件的准入名单）。
 * 与 `snapshotImageFileIds` 同一个道理：作品里引用了什么就只放行什么，
 * 不能因为拿得到一个 fileId 就去读别人的文件。
 */
export function snapshotDocumentFileIds(submission) {
  const ids = new Set();
  for (const item of parseSnapshotArtifacts(submission)) if (item.fileId) ids.add(String(item.fileId));
  return ids;
}

/** 快照里某一份产物（按名字），广场/机构端取文件前用它换出 fileId。 */
export function snapshotArtifactByName(submission, name) {
  return parseSnapshotArtifacts(submission).find((item) => item.name === String(name || '')) || null;
}

/** 从提交快照渲染一份真文件（广场的下载口用它；学生自己下载走的是活会话那条） */
export async function renderSnapshotDocument(submission, name) {
  const files = parseSnapshotFiles(submission?.files);
  if (!Object.hasOwn(files, name)) return { error: '作品里没有这个文件' };
  const meta = parseSnapshotArtifacts(submission).find((item) => item.name === name);
  const kind = meta?.kind || kindForName(name);
  if (!isDocumentKind(kind)) return { error: '这个文件不是可下载的文档' };
  return renderDocument(
    { name, kind, content: String(files[name] ?? '') },
    await snapshotImageMaps(meta || {}),
  );
}

/**
 * 快照里**出现过的素材 id**（公开取图/取媒体的准入名单，见 public.js 的 /images/:fileId）。
 *
 * ⚠️ 2026-09-30 补两类（用户报「教师后台看作品里图片/视频显示不出来」）：
 *   · `embeddedAssets`：HTML 引用的本地素材，**含视频/音频**（原来只有图片那半边，视频永远取不到）；
 *   · `coverFileId`：客户端交上来的封面（原来 `parseSnapshotArtifacts` 把它整个丢了）。
 * 口径不变：**作品里引用了什么就只放行什么** —— 拿得到一个 fileId 不等于能读别人的文件。
 */
export function snapshotImageFileIds(submission) {
  const ids = new Set();
  for (const item of parseSnapshotArtifacts(submission)) {
    if (item.coverFileId) ids.add(String(item.coverFileId));
    for (const asset of [...item.generatedImages, ...item.attachmentImages, ...item.embeddedImages, ...item.embeddedAssets]) {
      ids.add(String(asset.fileId));
    }
  }
  return ids;
}

/**
 * 这件作品里**还指着本地文件、但没随作品交上来**的引用（给老师/学生一句人话的解释）。
 *
 * 为什么要它：客户端（旧版本）只把文本产物和一个封面传上来，工作区里 `assets/` 那些
 * 图与视频一个字节都没上传 —— 老师端看到的就是"图裂了、视频空着"，而**平台侧没有任何字段**
 * 能说明这件事（界面上看起来像平台坏了）。这里把这类引用扫出来，让界面能说清：
 * 「这件作品引用了 N 个本地素材，但没有随作品提交上来」。
 *
 * 判据：入口 HTML（含被它引用的 css）里，`src/href/url()` 指向的**相对路径**在 `files` 里找不到同名文件
 * （找得到＝文本文件，会在预览时内联；找不到且不是已改写的 `/api/…` 地址＝素材没上来）。
 */
export function missingLocalAssets(files, entryFile) {
  const map = files && typeof files === 'object' ? files : {};
  const entry = String(entryFile || '').trim();
  if (!entry || !Object.hasOwn(map, entry)) return [];
  const missing = new Set();
  const visited = new Set();
  const queue = [entry];
  while (queue.length) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    const kind = kindForName(name);
    if (kind !== 'html' && kind !== 'css' && kind !== 'svg') continue;
    for (const reference of localArtifactReferences(name, map[name])) {
      if (Object.hasOwn(map, reference)) { if (kindForName(reference) !== 'html') queue.push(reference); continue; }
      missing.add(reference);
    }
  }
  return [...missing];
}

/** 把文本产物里指向私有素材的地址换成给定代理地址（公开页面用；沙箱里没有 cookie，只能走免登录的代理）。 */
function rewritePrivateAssetRefs(files, fileIds, urlOf) {
  return Object.fromEntries(Object.entries(files).map(([name, content]) => {
    let text = String(content ?? '');
    for (const fileId of fileIds) {
      const privateUrl = `/api/student/file-assets/${fileId}/download`;
      text = text.split(privateUrl).join(urlOf(fileId));
    }
    return [name, text];
  }));
}

/** 公开页面只把当前提交快照准入的私有素材地址改写成作品专属代理。 */
export function publicSnapshotFiles(submission) {
  const files = parseSnapshotFiles(submission?.files);
  const token = String(submission?.share_token || '').trim();
  if (!token) return files;
  return rewritePrivateAssetRefs(files, snapshotImageFileIds(submission),
    (fileId) => `/api/public/vibecoding-works/${token}/images/${fileId}`);
}

/**
 * 分享码那条链路（`/s/<码>`）：把私有素材地址改写成**这一枚码专属**的公开代理。
 *
 * 与 `publicSnapshotFiles` 同一个道理（沙箱 iframe 是 opaque origin，带不上 cookie，
 * 所以作品里引用的图/视频必须换成免登录的代理地址才显示得出来），区别只有"作品怎么定位"：
 * 那边靠广场的 `share_token`，这边靠学生自己发的分享码（**不看公开状态**，见 §七十四）。
 */
export function shareCodeSnapshotFiles(submission, code) {
  const files = parseSnapshotFiles(submission?.files);
  if (!files || !Object.keys(files).length) return files;
  return rewritePrivateAssetRefs(files, snapshotImageFileIds(submission),
    (fileId) => `/api/public/share-links/${encodeURIComponent(code)}/media/${encodeURIComponent(fileId)}`);
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
    // 当前提交的主产物由 entryFile 明确指定；老记录没有快照时才会是 null。
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
    if (search) { conditions.push(`conversation.title LIKE ? ${likeEscapeClause()}`); params.push(likeKeyword(search)); }
    const where = conditions.join(' AND ');
    const total = Number(await acount(`SELECT COUNT(*) n FROM vibecoding_conversations conversation WHERE ${where}`, params) || 0);
    const items = await amap((await arows(
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
    )), async (item) => await normalizeConversation(item));
    return pageResult(items, { page, limit, total });
  }

  if (part === '/conversations' && method === 'POST') {
    const lessonId = nonEmptyString(body.lessonId, '课时', { max: 100 });
    const classId = body.classId === undefined || body.classId === '' ? null : nonEmptyString(body.classId, '班级', { max: 100 });
    const user = await activeStudent(auth);
    const context = await vibeCodingContext(user, lessonId, body.sessionId || null);
    const existing = await arow('SELECT * FROM vibecoding_conversations WHERE student_id=? AND org_id=? AND lesson_id=? AND class_session_id=? ORDER BY updated_at DESC LIMIT 1', [auth.user.id, auth.user.orgId, lessonId, context.activeSession.id]);
    if (existing) return { ...await normalizeConversation(existing, { includeArtifacts: true }), modelOptions: await textModelOptions(), defaultModel: await textDefaultModel() };
    const now = nowIso();
    const conversationId = id('vibeconv');
    const title = body.title === undefined || String(body.title).trim() === '' ? DEFAULT_TITLE : nonEmptyString(body.title, '会话标题', { max: 60 });
    await atransaction(async () => {
      await aq(`INSERT INTO vibecoding_conversations(
           id,org_id,student_id,class_id,lesson_id,class_session_id,title,model,files,entry_file,status,last_message_at,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [conversationId, auth.user.orgId, auth.user.id, null, lessonId,
          context.activeSession?.id || null, title, null, '{}', 'index.html', 'DRAFT', null, now, now]);
      // 起始产物：让学生一进课堂就有东西可跑，而不是面对一块空白
      await seedDefaultArtifacts(conversationId);
      await audit(ctx, 'VIBECODING_CONVERSATION_CREATE', 'VIBECODING_CONVERSATION', conversationId, null, { lessonId, title });
    });
    const created = await arow(
      `SELECT conversation.*, lesson.title AS lesson_title, class.name AS class_name
       FROM vibecoding_conversations conversation
       LEFT JOIN course_lessons lesson ON lesson.id = conversation.lesson_id
       LEFT JOIN classes class ON class.id = conversation.class_id
       WHERE conversation.id = ?`, [conversationId]);
    return { ...await normalizeConversation(created, { includeArtifacts: true }), modelOptions: await textModelOptions(), defaultModel: await textDefaultModel() };
  }

  const conversationMatch = part.match(/^\/conversations\/([^/]+)$/);
  if (conversationMatch && method === 'GET') {
    const { conversation } = await ownConversation(ctx, conversationMatch[1]);
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 50 });
    const total = Number(await acount('SELECT COUNT(*) n FROM vibecoding_messages WHERE conversation_id = ?', [conversation.id]) || 0);
    const messages = (await arows(
      `SELECT * FROM vibecoding_messages WHERE conversation_id = ? ORDER BY ${messageOrderDesc} LIMIT ? OFFSET ?`,
      [conversation.id, limit, offset],
    )).reverse().map(normalizeMessage);
    // 一个对话现在可以有**多份产物的提交**（按产物提交，2026-09-15）。
    // 这里取最新的一条作为「当前提交」（旧代码是 row(...) 取一条 —— 有多条时是不确定的），
    // 同时把已提交过的产物名一并下发，界面才能准确标出哪几份已经交过。
    const submissions = await arows(submissionSelect() + ' WHERE submission.conversation_id = ? ORDER BY submission.submitted_at DESC', [conversation.id]);
    const submission = submissions[0] || null;
    // 历史产物（message_id 为空，来自旧 files JSON 的迁移）挂到最后一条助手消息上。
    // 迁移不可能知道每个文件是哪一轮写出来的，但「这次创作产出了哪些文件」必须看得见——
    // 否则老会话在聊天里一张产物卡片都没有，看起来像功能没生效。
    const artifacts = await listArtifacts(conversation.id, { includeContent: true });
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    if (lastAssistant) {
      for (const artifact of artifacts) if (!artifact.messageId) artifact.messageId = lastAssistant.id;
    }
    return {
      ...await normalizeConversation(conversation, { includeArtifacts: true, artifacts }),
      messages, messagesTotal: total, messagesPage: page,
      submission: normalizeSubmission(submission),
      submittedEntries: submissions.map((item) => item.entry_file),
      modelOptions: await textModelOptions(),
      defaultModel: await textDefaultModel(),
      // 算力池摘要（本课包还剩多少）随会话详情下发，工作台顶部显示
      computePool: await computePoolSummary({ userId: conversation.student_id, seriesId: await conversationSeriesId(conversation) }),
    };
  }

  // 单个产物的完整内容：产物列表默认不带正文，工作台点开某个文件时才取
  const artifactMatch = part.match(/^\/conversations\/([^/]+)\/artifacts\/([^/]+)$/);
  if (artifactMatch && method === 'GET') {
    const { conversation } = await ownConversation(ctx, artifactMatch[1]);
    const artifact = await getArtifact(conversation.id, artifactMatch[2]);
    if (!artifact) throw errors.notFound('产物不存在', 'VIBECODING_ARTIFACT_NOT_FOUND');
    return artifact;
  }

  // 文档产物的下载：产物里存的是**规格文本**（JSON/Markdown/CSV），这里当场渲染成真正的
  // .pptx / .docx / .xlsx 再发出去。见 services/ooxml/documents.js 里的取舍说明。
  const documentMatch = part.match(/^\/conversations\/([^/]+)\/artifacts\/([^/]+)\/download$/);
  if (documentMatch && method === 'GET') {
    const { conversation } = await ownConversation(ctx, documentMatch[1]);
    const artifact = await getArtifact(conversation.id, documentMatch[2]);
    if (!artifact) throw errors.notFound('产物不存在', 'VIBECODING_ARTIFACT_NOT_FOUND');
    if (!isDocumentKind(artifact.kind)) throw errors.badRequest('这个产物不是可下载的文档', 'VIBECODING_ARTIFACT_NOT_DOCUMENT');
    // 配图两个来源都要喂给渲染器：
    //   · 平台生成的插画（按幻灯片下标）
    //   · 规格里 {"attachment": N} 指的是**产出这一轮里学生传的第 N 张图**，按序号取
    // 越界/读不到就不放图，不让整份下载失败。
    const rendered = renderDocument(artifact, {
      attachmentImages: await attachmentImageMap(conversation.id, artifact),
      generatedImages: await generatedImageMap(artifact),
    });
    if (rendered.error) throw errors.badRequest(rendered.error, 'VIBECODING_DOCUMENT_RENDER_FAILED');
    const safeName = String(rendered.filename || 'download').replace(/[\r\n"\\/]/g, '_');
    await audit(ctx, 'VIBECODING_ARTIFACT_DOWNLOAD', 'VIBECODING_ARTIFACT', artifact.id, null, { kind: artifact.kind, bytes: rendered.buffer.length });
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
    const { auth: ownerAuth, conversation } = await ownConversation(ctx, pinMatch[1]);
    if (!Object.hasOwn(body, 'pinned') || typeof body.pinned !== 'boolean') throw errors.badRequest('请选择是否置顶', 'VIBECODING_PIN_FLAG_REQUIRED');
    await aq('UPDATE vibecoding_conversations SET pinned_at=?,updated_at=? WHERE id=? AND student_id=? AND org_id=?',
      [body.pinned ? nowIso() : null, nowIso(), conversation.id, ownerAuth.user.id, ownerAuth.user.orgId]);
    return await normalizeConversation(await arow('SELECT * FROM vibecoding_conversations WHERE id=?', [conversation.id]));
  }

  if (conversationMatch && method === 'PUT') {
    const { auth: ownerAuth, conversation } = await ownConversation(ctx, conversationMatch[1]);
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
      else if (!(await textModelOptions()).some((item) => item.id === requested)) throw errors.badRequest('该模型不在当前 AI 渠道的可选范围内', 'VIBECODING_MODEL_NOT_AVAILABLE');
      else nextModel = requested;
    }
    // 功能（对话 / 写代码 / 做网页，2026-09-17）：它决定系统提示词怎么拼。
    // **随时可切** —— 界面上它就在输入框那一排（照豆包那种排法），学生换功能就该立刻换行为。
    // 只影响**下一条消息起**的那一轮：系统提示词是每轮按当前值重拼的，历史不动，也不会两套说明叠在一起。
    let nextMode = normalizeVibeMode(conversation.mode);
    if (body.mode !== undefined) {
      const requested = normalizeVibeMode(body.mode);
      if (!requested) throw errors.badRequest('不认识的课堂功能（可选：对话 / 写代码 / 做网页）', 'INVALID_VIBE_MODE');
      nextMode = requested;
    }
    await aq('UPDATE vibecoding_conversations SET title=?,model=?,mode=?,updated_at=? WHERE id=? AND student_id=? AND org_id=?',
      [title, nextModel, nextMode || null, nowIso(), conversation.id, ownerAuth.user.id, ownerAuth.user.orgId]);
    const updated = await arow('SELECT * FROM vibecoding_conversations WHERE id = ?', [conversation.id]);
    return await normalizeConversation(updated, { includeArtifacts: true });
  }

  if (conversationMatch && method === 'DELETE') {
    const { auth: ownerAuth, conversation } = await ownConversation(ctx, conversationMatch[1]);
    await atransaction(async () => {
      await aq('DELETE FROM vibecoding_conversations WHERE id=? AND student_id=? AND org_id=?', [conversation.id, ownerAuth.user.id, ownerAuth.user.orgId]);
      await audit(ctx, 'VIBECODING_CONVERSATION_DELETE', 'VIBECODING_CONVERSATION', conversation.id, await normalizeConversation(conversation), null);
    });
    return { deleted: true, id: conversation.id };
  }

  const messageMatch = part.match(/^\/conversations\/([^/]+)\/messages$/);
  if (messageMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = await ownConversation(ctx, messageMatch[1]);
    assertConversationEditable(conversation);
    const user = await activeStudent(ownerAuth);
    const context = await vibeCodingContext(user, conversation.lesson_id, conversation.class_session_id || 'MISSING_SESSION');
    await assertChatPreflight({ user, orgId: ownerAuth.user.orgId, context, model: conversation.model || '' });
    // 附件先校验，再决定正文是否可以为空（只发图不发字是允许的）
    const attachments = await resolveAttachments(ownerAuth, body.attachments);
    const rawContent = String(body.content ?? '').trim();
    if (!rawContent && !attachments.length) throw errors.badRequest('消息内容不能为空', 'VALIDATION_REQUIRED');
    const content = nonEmptyString(rawContent || '看看这张图', '消息内容', { max: MAX_MESSAGE_CHARS });

    const userMessageId = id('vibemsg');
    const now = nowIso();
    await aq('INSERT INTO vibecoding_messages(id,conversation_id,role,content,model,status,attachments,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [userMessageId, conversation.id, 'user', content, conversation.model || null, 'SUCCEEDED', json(attachments), now]);
    const autoTitle = !conversation.title || conversation.title === DEFAULT_TITLE;
    await aq('UPDATE vibecoding_conversations SET last_message_at=?,updated_at=? WHERE id=?', [now, now, conversation.id]);
    if (autoTitle) await aq('UPDATE vibecoding_conversations SET title=? WHERE id=?', [content.slice(0, 24), conversation.id]);
    return streamAssistantReply(ctx, { auth: ownerAuth, conversation, userMessageId });
  }
  if (messageMatch && method === 'DELETE') {
    // 清空对话（保留会话本身与代码文件）
    const { conversation } = await ownConversation(ctx, messageMatch[1]);
    assertConversationEditable(conversation);
    const removed = Number(await acount('SELECT COUNT(*) n FROM vibecoding_messages WHERE conversation_id=?', [conversation.id]) || 0);
    await persistConversationAttachmentImages(conversation.id);
    await aq('DELETE FROM vibecoding_messages WHERE conversation_id=?', [conversation.id]);
    const preservedArtifacts = await listArtifacts(conversation.id, { includeContent: true });
    await audit(ctx, 'VIBECODING_MESSAGES_CLEAR', 'VIBECODING_CONVERSATION', conversation.id, { count: removed }, { count: 0 });
    return { cleared: true, removed, artifacts: preservedArtifacts };
  }

  // 重新生成：清掉最后一条用户消息之后的回答，重新问一次（失败重试也走这里）
  // SQLite 用原来的 rowid 边界，避免同毫秒随机 id 把历史消息删错；
  // MySQL 尚无插入顺序列，只能按 (created_at, id) 做确定性截断（并非真实插入顺序）。
  const regenerateMatch = part.match(/^\/conversations\/([^/]+)\/messages\/regenerate$/);
  if (regenerateMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = await ownConversation(ctx, regenerateMatch[1]);
    assertConversationEditable(conversation);
    const lastUser = await arow(`SELECT ${messagePosition} FROM vibecoding_messages WHERE conversation_id=? AND role='user' ORDER BY ${messageOrderDesc} LIMIT 1`, [conversation.id]);
    if (!lastUser) throw errors.badRequest('还没有可以重新生成的消息', 'VIBECODING_NO_MESSAGE');
    await persistConversationAttachmentImages(conversation.id);
    const lastUserPosition = messagePositionValue(lastUser);
    await aq(`DELETE FROM vibecoding_messages WHERE conversation_id=? AND (created_at > ? OR (created_at = ? AND ${messageOrderKey} > ?))`,
      [conversation.id, lastUser.created_at, lastUser.created_at, lastUserPosition]);
    return streamAssistantReply(ctx, { auth: ownerAuth, conversation, userMessageId: lastUser.id });
  }

  // 编辑并重发：只允许改最后一条用户消息，改完连同后续回答一起重来
  const messageEditMatch = part.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)\/edit$/);
  if (messageEditMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = await ownConversation(ctx, messageEditMatch[1]);
    assertConversationEditable(conversation);
    const message = await arow(`SELECT ${messagePosition} FROM vibecoding_messages WHERE id=? AND conversation_id=?`, [messageEditMatch[2], conversation.id]);
    if (!message) throw errors.notFound('消息不存在', 'VIBECODING_MESSAGE_NOT_FOUND');
    if (message.role !== 'user') throw errors.badRequest('只能编辑自己发出的消息', 'VIBECODING_MESSAGE_NOT_EDITABLE');
    const lastUser = await arow(`SELECT id FROM vibecoding_messages WHERE conversation_id=? AND role='user' ORDER BY ${messageOrderDesc} LIMIT 1`, [conversation.id]);
    if (lastUser?.id !== message.id) throw errors.badRequest('只能编辑最后一条消息', 'VIBECODING_MESSAGE_NOT_LAST');
    const content = nonEmptyString(body.content, '消息内容', { max: MAX_MESSAGE_CHARS });
    await persistConversationAttachmentImages(conversation.id);
    const messagePositionValueForEdit = messagePositionValue(message);
    await aq(`DELETE FROM vibecoding_messages WHERE conversation_id=? AND (created_at > ? OR (created_at = ? AND ${messageOrderKey} > ?))`,
      [conversation.id, message.created_at, message.created_at, messagePositionValueForEdit]);
    await aq('UPDATE vibecoding_messages SET content=? WHERE id=?', [content, message.id]);
    await aq('UPDATE vibecoding_conversations SET last_message_at=?,updated_at=? WHERE id=?', [nowIso(), nowIso(), conversation.id]);
    return streamAssistantReply(ctx, { auth: ownerAuth, conversation, userMessageId: message.id });
  }

  // 删除单条消息：连同它之后的回答一起删，避免留下孤立的回复
  const messageDeleteMatch = part.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)$/);
  if (messageDeleteMatch && method === 'DELETE') {
    const { conversation } = await ownConversation(ctx, messageDeleteMatch[1]);
    assertConversationEditable(conversation);
    const message = await arow(`SELECT ${messagePosition} FROM vibecoding_messages WHERE id=? AND conversation_id=?`, [messageDeleteMatch[2], conversation.id]);
    if (!message) throw errors.notFound('消息不存在', 'VIBECODING_MESSAGE_NOT_FOUND');
    await persistConversationAttachmentImages(conversation.id);
    await aq(`DELETE FROM vibecoding_messages WHERE conversation_id=? AND (created_at > ? OR (created_at = ? AND ${messageOrderKey} >= ?))`,
      [conversation.id, message.created_at, message.created_at, messagePositionValue(message)]);
    await audit(ctx, 'VIBECODING_MESSAGE_DELETE', 'VIBECODING_CONVERSATION', conversation.id, { messageId: message.id, role: message.role }, null);
    return { deleted: true, id: message.id };
  }

  const submitMatch = part.match(/^\/conversations\/([^/]+)\/submit$/);
  if (submitMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = await ownConversation(ctx, submitMatch[1]);
    const user = await activeStudent(ownerAuth);
    await vibeCodingContext(user, conversation.lesson_id, conversation.class_session_id || 'MISSING_SESSION');
    const allFiles = await artifactsAsFiles(conversation.id);
    // 2026-09-15 用户口径：**按产物提交**，不是按对话提交。
    // 「不需要提交整个作品，而是针对能展示出来的作品来提交」——学生做完一个游戏、一份 PPT，
    // 各自提交一次；后台才能把每一份都发到官网展示。同一份产物重复提交是覆盖（round+1），
    // 不同产物各自成条（唯一性 = (conversation_id, entry_file)，见 schema 里那次重建表）。
    const requestedEntry = String(ctx.body?.entryFile || '').trim().slice(0, 200);
    const entryFile = requestedEntry || String(conversation.entry_file || '').trim() || 'index.html';
    if (allFiles[entryFile] === undefined) {
      throw errors.badRequest(`这份产物（${entryFile}）不在当前作品里，无法提交`, 'VIBECODING_ARTIFACT_NOT_FOUND');
    }
    const entryKind = kindForName(entryFile);
    if (!isSubmittableArtifactKind(entryKind)) {
      throw errors.badRequest('只有网页、PPT、Word 和 Excel 可以作为作品提交', 'VIBECODING_ARTIFACT_NOT_SUBMITTABLE');
    }
    const includedNames = submissionArtifactNames(allFiles, entryFile);
    const existing = await arow('SELECT * FROM vibecoding_submissions WHERE conversation_id = ? AND entry_file = ?', [conversation.id, entryFile]);
    // 没有老师点评这一环了：提交只是「交给平台」，可以反复提交（round+1），不再挡第二次
    // 与画布作品一致：提交即确认版权与展示授权，平台后续才可发布到作品广场
    if (ctx.body?.copyrightConfirmed !== true) {
      throw errors.badRequest('提交前请确认作品版权与展示授权', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    }
    const files = pickFiles(allFiles, includedNames);
    // 产物清单也要一起定格：作品广场靠它判断「这次交上来的到底是哪份产物」（见 submissionPreview），
    // 以及那份文档的配图在哪。只在提交这一刻取，之后学生再改也不会影响广场那一版。
    const artifacts = await snapshotArtifacts(conversation.id, includedNames, files, ownerAuth.user.id);
    const transcript = (await arows(`SELECT role, content, created_at FROM vibecoding_messages WHERE conversation_id=? AND status='SUCCEEDED' ORDER BY ${messageOrderAsc}`, [conversation.id]))
      .map((message) => ({ role: message.role, content: message.content, createdAt: message.created_at }));
    const title = body.title === undefined || String(body.title).trim() === '' ? conversation.title : nonEmptyString(body.title, '作品标题', { max: 60 });
    const description = String(body.description || '').slice(0, 1000);
    const now = nowIso();
    const submissionId = existing?.id || id('vibesub');
    await atransaction(async () => {
      if (existing) {
        await aq(`UPDATE vibecoding_submissions SET title=?,description=?,files=?,artifacts=?,transcript=?,entry_file=?,round=round+1,status='PENDING',
             teacher_comment=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=?,updated_at=?,
             copyright_confirmed_at=?,copyright_confirmed_by=?,is_public=0,share_token=NULL,published_at=NULL,published_by=NULL,
             featured_at=NULL,unpublish_reason=NULL WHERE id=?`,
          [title, description, json(files), json(artifacts), json(transcript), entryFile, now, now, now, ownerAuth.user.id, submissionId]);
      } else {
        await aq(`INSERT INTO vibecoding_submissions(
             id,conversation_id,student_id,org_id,class_id,lesson_id,title,description,files,artifacts,transcript,entry_file,round,status,submitted_at,created_at,updated_at,
             copyright_confirmed_at,copyright_confirmed_by
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [submissionId, conversation.id, ownerAuth.user.id, ownerAuth.user.orgId, conversation.class_id, conversation.lesson_id,
            title, description, json(files), json(artifacts), json(transcript), entryFile, 1, 'PENDING', now, now, now, now, ownerAuth.user.id]);
      }
      await aq("UPDATE vibecoding_conversations SET status='SUBMITTED',updated_at=? WHERE id=?", [now, conversation.id]);
      await audit(ctx, 'VIBECODING_SUBMIT', 'VIBECODING_CONVERSATION', conversation.id, existing ? { round: existing.round } : null, { title, entryFile, round: Number(existing?.round || 0) + 1 });
    });
    return normalizeSubmission(await arow(submissionSelect() + ' WHERE submission.id = ?', [submissionId]), { includeContent: true });
  }

  if (part === '/submissions' && method === 'GET') {
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 20 });
    const total = Number(await acount('SELECT COUNT(*) n FROM vibecoding_submissions submission WHERE submission.student_id = ?', [auth.user.id]) || 0);
    const items = (await arows(submissionSelect() + ' WHERE submission.student_id = ? ORDER BY submission.submitted_at DESC LIMIT ? OFFSET ?', [auth.user.id, limit, offset]))
      .map((item) => normalizeSubmission(item));
    return pageResult(items, { page, limit, total });
  }

  return null;
}

/**
 * 把文本产物里**指向某个本地素材**的引用改写成给定地址（学生创作环境的作品回传用）。
 *
 * 为什么不能直接做全局字符串替换：正文里随便一句提到 `hero.png` 也会被改掉。
 * 所以只动我们认得的引用写法 —— 与 `localArtifactReferences` 同一套规则，
 * 两处要一起改（否则「扫得到、改不到」，作品在广场上会丢图而两边都不报错）。
 *
 * @param {string} content 文本产物正文
 * @param {string} name 产物名（决定按 HTML 还是 CSS 的写法扫）
 * @param {Map<string,string>} replacements 本地素材名 → 替换成的地址
 */
export function rewriteLocalReferences(content, name, replacements) {
  const kind = kindForName(name);
  const rewrite = (raw) => {
    const clean = normalizeLocalReference(raw);
    if (!clean) return raw;
    const target = replacements.get(clean);
    return target === undefined ? raw : target;
  };
  let text = String(content ?? '');
  if (kind === 'html' || kind === 'svg') {
    text = text.replace(/(\b(?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (whole, head, value, tail) => head + rewrite(value) + tail);
  }
  if (kind === 'html' || kind === 'css' || kind === 'svg') {
    text = text.replace(/(url\(\s*["']?)([^"')]+)(["']?\s*\))/gi, (whole, head, value, tail) => head + rewrite(value) + tail);
  }
  // ⭐ 2026-10-01：**带引号的整段素材路径**一律换掉 —— 不管它在独立的 .js/.json 里，
  //    还是在 **HTML 的内联 <script>** 里（`new Audio("assets/sfx.wav")`：学生做的小游戏
  //    十有八九是一个 index.html 全套内联；只按 html 的 src/href/url() 扫，这条永远漏）。
  //    ⚠️ 只认"引号里**整段等于**某个本地素材名"的字符串（不做裸词替换、也不动别的引号内容）——
  //       正文里提一句 hero.png、或写别的话都不会被改；`replacements` 里只有**真交上来的**素材名。
  {
    // 逐个"本地素材名 → 地址"精确替换**带引号的整段**（与扫描侧同一套写法）。
    // ⚠️ 不做全局字符串替换：注释里随便提一句 `hero.png` 不该被改（与 html 那条同一套口径）。
    for (const [from, to] of replacements) {
      const quoted = new RegExp('(["\'`])' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\1', 'g');
      text = text.replace(quoted, (whole, quote) => quote + to + quote);
    }
  }
  return text;
}

/**
 * 给「不是平台内沙箱产出」的作品写一条提交记录（学生自己的创作环境 = dsh，2026-09-16）。
 *
 * 为什么复用这张表：作品广场、平台发布/下架、机构查看、老师端读的全是 `vibecoding_submissions`。
 * dsh 的作品只是**怎么产出的**不一样，交上来之后要走的还是同一条链路 —— 所以不另起一张表，
 * 也就不会出现「两边各有一套提交、广场只认一套」的分叉。
 *
 * 与会话提交（上面的 /submit）只有两处不同，别的都一样：
 *   · 产物不是从 `vibecoding_artifacts` 里取的，而是宿主侧从学生工作区取回来、调用方传进来的
 *     —— 它就是**提交这一刻要定格的快照**（学生之后再改工作区，广场上那一版不受影响）；
 *   · 没有平台内的聊天记录，所以 transcript 是空的。
 * 规则保持一致：入口只允许网页/PPT/Word/Excel、必须确认版权、重复提交是覆盖（round+1）。
 *
 * @param {{ctx: object, auth: object, conversation: object, entryFile: string,
 *          files: Record<string,string>, artifacts: Array<object>, title: string, description?: string}} input
 */
export async function recordRuntimeSubmission({ ctx, auth, conversation, entryFile, files, artifacts, title, description = '' }) {
  const now = nowIso();
  const existing = await arow('SELECT * FROM vibecoding_submissions WHERE conversation_id = ? AND entry_file = ?', [conversation.id, entryFile]);
  const submissionId = existing?.id || id('vibesub');
  const transcript = json([]);
  await atransaction(async () => {
    if (existing) {
      await aq(`UPDATE vibecoding_submissions SET title=?,description=?,files=?,artifacts=?,transcript=?,entry_file=?,round=round+1,status='PENDING',
           teacher_comment=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=?,updated_at=?,
           copyright_confirmed_at=?,copyright_confirmed_by=?,is_public=0,share_token=NULL,published_at=NULL,published_by=NULL,
           featured_at=NULL,unpublish_reason=NULL WHERE id=?`,
        [title, description, json(files), json(artifacts), transcript, entryFile, now, now, now, auth.user.id, submissionId]);
    } else {
      await aq(`INSERT INTO vibecoding_submissions(
           id,conversation_id,student_id,org_id,class_id,lesson_id,title,description,files,artifacts,transcript,entry_file,round,status,submitted_at,created_at,updated_at,
           copyright_confirmed_at,copyright_confirmed_by
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [submissionId, conversation.id, auth.user.id, auth.user.orgId, conversation.class_id || null, conversation.lesson_id || null,
          title, description, json(files), json(artifacts), transcript, entryFile, 1, 'PENDING', now, now, now, now, auth.user.id]);
    }
    await aq("UPDATE vibecoding_conversations SET status='SUBMITTED',updated_at=? WHERE id=?", [now, conversation.id]);
    await audit(ctx, 'VIBECODING_SUBMIT', 'VIBECODING_CONVERSATION', conversation.id,
      existing ? { round: existing.round } : null,
      { title, entryFile, round: Number(existing?.round || 0) + 1, source: 'STUDENT_RUNTIME' });
  });
  return normalizeSubmission(await arow(submissionSelect() + ' WHERE submission.id = ?', [submissionId]), { includeContent: true });
}

/**
 * 把一条提交投影成「我的作品」里的那一条 —— **`/api/student/works` 与 `submit-upload` 的 `works`
 * 共用这一份**。
 *
 * 为什么抽出来：客户端交完作品要**直接回显"交上来了哪几条"**（契约《平台接口契约-zcode.md》
 * 「作品提交」一节要 `warnings` / `missing` / `works`），而它在 /我的作品 里拿到的又是另一种
 * 投影。两条路各写一遍的话，形状迟早只在一半上对上（本文件上面那条纪律的同一条理由）。
 *
 * ⚠️ 入参是**库里的原始行**（snake_case）—— 与 `/student/works` 的查询结果同一个形状；
 *    `lessonTitle` / `seriesTitle` / `classSessionId` 由调用方按自己手上的查询补
 *    （列表那条路是 JOIN 出来的，提交那条路直接用课堂上下文）。
 */
export function vibecodingWorkItem(submission, { lessonTitle = null, seriesTitle = null, classSessionId = null } = {}) {
  const isPublic = Number(submission.is_public || 0) === 1;
  return {
    id: submission.id,
    projectId: null,
    studentId: submission.student_id,
    studentName: null,
    orgId: submission.org_id,
    classId: submission.class_id || null,
    className: null,
    courseLessonId: submission.lesson_id || null,
    courseLessonTitle: lessonTitle || null,
    title: submission.title,
    description: submission.description || '',
    status: submission.status,
    teacherComment: null,
    unpublishReason: submission.unpublish_reason || null,
    submittedAt: submission.submitted_at,
    plazaPublished: isPublic,
    shareToken: submission.share_token || null,
    source: 'VIBECODING',
    seriesTitle: seriesTitle || null,
    entryFile: submission.entry_file || 'index.html',
    classSessionId: classSessionId || null,
    submissionRound: Number(submission.round || 1),
    submissions: [],
    publishRequests: [],
    pendingPublishRequest: null,
    latestPublishRequest: null,
    actions: {},
    sharing: {
      scope: isPublic ? 'PUBLIC' : 'ORGANIZATION',
      isPublic,
      shareToken: isPublic ? submission.share_token : null,
      publicUrl: isPublic && submission.share_token ? `/works/${submission.share_token}` : null,
    },
  };
}

/**
 * 刚提交完那一条的回显：按**主键**取这一条（连带它挂到的课时/课包标题），形状与列表逐字一致。
 * 找不到就返回 null（调用方给空数组，不因为它把一次已经成功的提交判成失败）。
 */
export async function runtimeSubmissionWorkItem(submissionId, { classSessionId = null } = {}) {
  const row = await arow(
    `SELECT submission.*, COALESCE(lesson.published_title, lesson.title) AS lesson_title,
            series.title AS series_title
     FROM vibecoding_submissions submission
     LEFT JOIN course_lessons lesson ON lesson.id = submission.lesson_id
     LEFT JOIN course_series series ON series.id = lesson.series_id
     WHERE submission.id = ?`,
    [submissionId],
  );
  if (!row) return null;
  return vibecodingWorkItem(row, { lessonTitle: row.lesson_title, seriesTitle: row.series_title, classSessionId });
}

/**
 * 这个学生在这节课上的「创作会话」身份 —— dsh 那条路没有平台内的聊天，
 * 但提交记录必须挂在一条会话上（表结构如此：conversation_id NOT NULL + 外键），
 * 作品广场也按「会话 × 产物」去重。所以按「学生 + 课 + 本次课堂」找一条现成的，
 * 没有就建一条（与老 /conversations 的查询同一套键，两处不会各建各的）。
 */
export async function ensureRuntimeConversation({ auth, lessonId, classSessionId, classId = null, title }) {
  const existing = await arow(
    'SELECT * FROM vibecoding_conversations WHERE student_id=? AND org_id=? AND lesson_id=? AND class_session_id=? ORDER BY updated_at DESC LIMIT 1',
    [auth.user.id, auth.user.orgId, lessonId, classSessionId],
  );
  if (existing) return existing;
  const now = nowIso();
  const conversationId = id('vibeconv');
  await atransaction(async () => {
    await aq(`INSERT INTO vibecoding_conversations(
         id,org_id,student_id,class_id,lesson_id,class_session_id,title,model,files,entry_file,status,last_message_at,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [conversationId, auth.user.orgId, auth.user.id, classId, lessonId, classSessionId,
        String(title || '创作环境').slice(0, 60), null, '{}', 'index.html', 'DRAFT', null, now, now]);
  });
  return await arow('SELECT * FROM vibecoding_conversations WHERE id = ?', [conversationId]);
}

export async function handleVibeCoding(ctx) {
  const { pathname } = ctx;
  if (!pathname.startsWith('/api/student/vibecoding')) return null;
  if (!ctx.auth) throw errors.unauthorized('请先登录', 'UNAUTHORIZED');
  const auth = requireRole(ctx, ['STUDENT']);
  const part = pathname.slice('/api/student/vibecoding'.length) || '/';
  return handleStudentVibeCoding(ctx, auth, part);
}
