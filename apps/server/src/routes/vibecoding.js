// VibeCoding 课堂运行时：对话式代码创作（SSE 流式）+ 受限运行 + 提交点评。
// 计费沿用平台既有链路：每轮 AI 回复扣 1 积分（credit_entries / usage_records）。
import {
  audit, count, corsHeaders, errors, id, json, nonEmptyString, nowIso,
  pageParams, pageResult, q, requireRole, row, rows, transaction,
} from '../lib.js';
import { resolveStudentLessonContext } from '../services/studentContext.js';
import { assertSessionAiControls } from '../services/aiControls.js';
import { getGenerationProvider } from '../services/generationProvider.js';
import { chargeCreditsInTransaction } from '../services/creditLedger.js';
import { debitUserAiCredits, recordAiUsage } from '../services/creditUsage.js';
import { getAiProviderPolicy, isModalityEnabled } from './billingConfig.js';
import { modalityChannel } from '../services/modelCapabilities.js';
import { providerSelectionForModality } from './aiGeneration.js';
import { runJavaScript, sandboxCapability } from '../services/vibecodingRunner.js';
import { PROVIDER_ERROR_CODES } from '../services/providerContract.js';

const DEFAULT_TITLE = '新的创作对话';
const MAX_FILES = 12;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const HISTORY_MESSAGES = 20;

const DEFAULT_FILES = Object.freeze({
  'index.html': '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>我的第一个网页</title>\n  <link rel="stylesheet" href="style.css" />\n</head>\n<body>\n  <h1>你好，AI 魔法学院！</h1>\n  <p>在这里写下你的第一个网页。</p>\n  <script src="script.js"></script>\n</body>\n</html>\n',
  'style.css': 'body {\n  font-family: system-ui, -apple-system, "PingFang SC", sans-serif;\n  padding: 24px;\n  color: #2f2a45;\n}\n',
  'script.js': "console.log('你好，VibeCoding！');\n",
});

function parseFiles(value, { fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw errors.badRequest('代码文件格式无效', 'INVALID_VIBECODING_FILES'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw errors.badRequest('代码文件必须是对象', 'INVALID_VIBECODING_FILES');
  const entries = Object.entries(parsed);
  if (entries.length > MAX_FILES) throw errors.badRequest(`最多 ${MAX_FILES} 个文件`, 'VIBECODING_TOO_MANY_FILES');
  const files = {}; let total = 0;
  for (const [rawPath, rawContent] of entries) {
    const path = String(rawPath || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(path) || path.includes('..')) {
      throw errors.badRequest('文件路径不合法', 'INVALID_VIBECODING_FILE_PATH');
    }
    const content = String(rawContent ?? '');
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_BYTES) throw errors.badRequest(`单个文件不能超过 ${Math.round(MAX_FILE_BYTES / 1024)}KB`, 'VIBECODING_FILE_TOO_LARGE');
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw errors.badRequest(`代码总量不能超过 ${Math.round(MAX_TOTAL_BYTES / 1024)}KB`, 'VIBECODING_FILES_TOO_LARGE');
    files[path] = content;
  }
  if (!Object.keys(files).length) throw errors.badRequest('至少需要一个文件', 'VIBECODING_FILES_REQUIRED');
  return files;
}

function filesOf(conversation) {
  return parseFiles(conversation.files, { fallback: { ...DEFAULT_FILES } }) || { ...DEFAULT_FILES };
}

function normalizeConversation(value, { includeFiles = false } = {}) {
  if (!value) return null;
  return {
    id: value.id, title: value.title, status: value.status, model: value.model || null,
    lessonId: value.lesson_id || null, lessonTitle: value.lesson_title || null,
    classId: value.class_id || null, className: value.class_name || null,
    classSessionId: value.class_session_id || null,
    entryFile: value.entry_file || 'index.html',
    pinnedAt: value.pinned_at || null,
    ...(includeFiles ? { files: filesOf(value) } : {}),
    lastMessageAt: value.last_message_at || null,
    createdAt: value.created_at, updatedAt: value.updated_at,
  };
}

function normalizeRun(value) {
  return {
    id: value.id, conversationId: value.conversation_id, language: value.language, entryFile: value.entry_file,
    status: value.status, exitCode: value.exit_code == null ? null : Number(value.exit_code),
    stdout: value.stdout || '', stderr: value.stderr || '',
    durationMs: value.duration_ms == null ? null : Number(value.duration_ms),
    errorCode: value.error_code || null, createdAt: value.created_at, finishedAt: value.finished_at || null,
  };
}

// 运行串行化：生产机内存紧张，同时只允许一个沙箱进程
let runChain = Promise.resolve();
function serializeRun(task) {
  const next = runChain.then(task, task);
  runChain = next.catch(() => {});
  return next;
}

function normalizeMessage(value) {
  return {
    id: value.id, role: value.role, content: value.content, model: value.model || null,
    status: value.status, errorCode: value.error_code || null,
    creditsCharged: Number(value.credits_charged || 0), createdAt: value.created_at,
  };
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
function assertChatPreflight({ user, orgId, context }) {
  assertSessionAiControls({ modality: 'TEXT', session: context.activeSession, orgId, userId: user.id, credits: 1 });
  if (!isModalityEnabled(orgId, 'TEXT').enabled) throw errors.forbidden('平台已关闭该 AI 能力', 'MODALITY_DISABLED');
  if (!(context.lesson?.capabilities || []).includes('text')) throw errors.forbidden('本课时未开放 AI 文字能力', 'LESSON_CAPABILITY_DISABLED');
  const aiLimit = user.ai_credit_limit == null ? null : Number(user.ai_credit_limit);
  if (aiLimit !== null && Number(user.ai_credits_used || 0) + 1 > aiLimit) throw errors.forbidden('该账号 AI 积分使用上限已用尽', 'AI_MEMBER_CREDIT_LIMIT');
  const allowance = Number(user.monthly_credit_allowance || 0) + Number(user.monthly_bonus_credits || 0) + Number(user.month_period_boost_credits || 0);
  if (Number(user.used_credits_this_period || 0) + 1 > allowance) throw errors.forbidden('个人额度不足', 'STUDENT_CREDIT_LIMIT');
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
  if (conversation.status !== 'DRAFT') throw errors.conflict('已提交的会话不能继续对话', 'VIBECODING_CONVERSATION_LOCKED');
}

/**
 * 课时上下文：多轮 history 会覆盖渠道模板里的 system 提示词，所以这里自己拼一条，
 * 既把本节课的正文/教学指引告诉模型，也保留儿童友好的安全约束与代码块约定
 * （「```语言 文件名」便于学生一键写入文件）。
 */
export function lessonSystemMessage(conversation) {
  const lesson = row('SELECT title, summary, lesson_content FROM course_lessons WHERE id=?', [conversation.lesson_id]);
  const parts = [
    '你是少儿编程学习平台的创作助手「阿飞」，面向 8–16 岁的学生。请用适合儿童理解的中文回答，语气友好，避免任何危险或不适龄内容。',
    '给出完整代码文件时，请用「```语言 文件名」的代码块（例如 ```html index.html），学生可以一键写入文件；说明尽量简短，不要重复整段代码。',
  ];
  if (lesson) {
    if (lesson.title) parts.push(`本节 VibeCoding 课时：${lesson.title}`);
    if (lesson.summary) parts.push(`课时简介：${String(lesson.summary).slice(0, 600)}`);
    if (lesson.lesson_content) parts.push(`课时正文与教学指引：\n${String(lesson.lesson_content).slice(0, 4000)}`);
  }
  return { role: 'system', content: parts.join('\n\n') };
}

function conversationHistory(conversationId, limit = HISTORY_MESSAGES) {
  return rows(
    "SELECT role, content FROM vibecoding_messages WHERE conversation_id=? AND status='SUCCEEDED' ORDER BY created_at DESC, rowid DESC LIMIT ?",
    [conversationId, limit],
  ).reverse().map((message) => ({ role: message.role, content: message.content }));
}

// 当前 TEXT 渠道可选的模型（供学生每个会话自己挑，默认沿用渠道默认模型）
function textModelOptions() {
  const channel = modalityChannel(getAiProviderPolicy(), 'TEXT');
  if (!channel) return [];
  const mappings = Array.isArray(channel.modelMappings) ? channel.modelMappings : [];
  const ids = new Set();
  if (channel.model) ids.add(String(channel.model));
  (Array.isArray(channel.models) ? channel.models : []).forEach((item) => ids.add(String(typeof item === 'string' ? item : item?.id || item?.name || '')));
  mappings.forEach((item) => { if (item?.id) ids.add(String(item.id)); });
  return [...ids].filter(Boolean).map((id) => ({ id, displayName: mappings.find((item) => item?.id === id)?.displayName || id }));
}

/**
 * 跑一轮助手回复：SSE 保活 + 中止透传 + 思考进度 + 成功才扣费。
 * 发送 / 重新生成 / 编辑重发三个入口共用，避免三份实现走偏。
 */
async function streamAssistantReply(ctx, { auth, conversation, userMessageId }) {
  const policy = getAiProviderPolicy();
  const selection = providerSelectionForModality(policy, 'TEXT', conversation.model || '');
  const provider = getGenerationProvider(selection);
  if (typeof provider.generateStream !== 'function') throw errors.conflict('当前 AI 渠道不支持流式对话', 'VIBECODING_STREAM_UNAVAILABLE');

  const history = [lessonSystemMessage(conversation), ...conversationHistory(conversation.id)];
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
  try {
    const result = await provider.generateStream({
      messages: history,
      signal: abortController.signal,
      onReasoning: (delta) => {
        reasoningChars += String(delta || '').length;
        sseSend(ctx, 'thinking', { chars: reasoningChars });
      },
      onDelta: (delta, full) => { streamedText = full; sseSend(ctx, 'delta', { delta }); },
    });
    const text = String(result?.assets?.[0]?.metadata?.text || streamedText || '').trim();
    if (!text) throw errors.conflict('AI 没有返回内容', 'GENERATION_EMPTY_RESULT');
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
        pricing: { source: 'vibecoding', provider: provider.name, conversationId: fresh.id, mode: selection.provider },
      });
      q('INSERT INTO vibecoding_messages(id,conversation_id,role,content,model,status,credits_charged,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [assistantMessageId, fresh.id, 'assistant', text, selection.model, 'SUCCEEDED', 1, nowIso()]);
      q('UPDATE vibecoding_conversations SET model=?,last_message_at=?,updated_at=? WHERE id=?', [selection.model, nowIso(), nowIso(), fresh.id]);
      balanceAfter = Number(charged?.balanceAfter || 0);
    });
    const message = normalizeMessage(row('SELECT * FROM vibecoding_messages WHERE id=?', [assistantMessageId]));
    sseSend(ctx, 'done', { message, creditsCharged: 1, balanceAfter, streamed: result?.streamed !== false });
  } catch (error) {
    const code = error?.code || 'VIBECODING_CHAT_FAILED';
    if (code === PROVIDER_ERROR_CODES.ABORTED) {
      // 学生主动停止：不扣费、不落助手消息，前端据此把气泡标成「已停止」
      sseSend(ctx, 'aborted', { code: 'VIBECODING_ABORTED' });
    } else {
      recordFailedMessage(conversation.id, selection.model, streamedText, code);
      recordAiUsage({
        orgId: auth.user.orgId, userId: auth.user.id, sessionId: conversation.class_session_id || null,
        modality: 'TEXT', model: selection.model, credits: 0, status: 'FAILED', failCode: code,
        pricing: { source: 'vibecoding', provider: provider.name, conversationId: conversation.id },
      });
      sseSend(ctx, 'error', { code, message: error?.message || 'AI 回复失败' });
    }
  } finally {
    clearInterval(heartbeat);
    ctx.res.off?.('close', onClientGone);
    if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end();
  }
  return { __streamed: true };
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
    status: value.status, teacherComment: value.teacher_comment || null,
    reviewedBy: value.reviewed_by || null, reviewerName: value.reviewer_name || null,
    reviewedAt: value.reviewed_at || null, submittedAt: value.submitted_at,
    copyrightConfirmedAt: value.copyright_confirmed_at || null,
    isPublic: Number(value.is_public || 0) === 1,
    shareToken: value.share_token || null,
    featured: Boolean(value.featured_at),
    publishedAt: value.published_at || null,
    ...(includeContent ? { files: parseFiles(value.files, { fallback: {} }), transcript: JSON.parse(value.transcript || '[]') } : {}),
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

function teacherSubmissionScope(auth) {
  if (auth.user.role !== 'TEACHER') return { sql: '', params: [] };
  return {
    sql: ` AND (class.teacher_id = ? OR EXISTS (SELECT 1 FROM class_members member WHERE member.class_id = submission.class_id AND member.user_id = ? AND member.role='TEACHER' AND member.removed_at IS NULL))`,
    params: [auth.user.id, auth.user.id],
  };
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
      `SELECT conversation.*, lesson.title AS lesson_title, class.name AS class_name
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
    const files = parseFiles(body.files, { fallback: { ...DEFAULT_FILES } }) || { ...DEFAULT_FILES };
    transaction(() => {
      q(`INSERT INTO vibecoding_conversations(
           id,org_id,student_id,class_id,lesson_id,class_session_id,title,model,files,entry_file,status,last_message_at,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [conversationId, auth.user.orgId, auth.user.id, context.class?.id || classId, lessonId,
          context.activeSession?.id || null, title, null, json(files), 'index.html', 'DRAFT', null, now, now]);
      audit(ctx, 'VIBECODING_CONVERSATION_CREATE', 'VIBECODING_CONVERSATION', conversationId, null, { lessonId, title });
    });
    const created = row(
      `SELECT conversation.*, lesson.title AS lesson_title, class.name AS class_name
       FROM vibecoding_conversations conversation
       LEFT JOIN course_lessons lesson ON lesson.id = conversation.lesson_id
       LEFT JOIN classes class ON class.id = conversation.class_id
       WHERE conversation.id = ?`, [conversationId]);
    return normalizeConversation(created, { includeFiles: true });
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
    return { ...normalizeConversation(conversation, { includeFiles: true }), messages, messagesTotal: total, messagesPage: page, submission: normalizeSubmission(submission), modelOptions: textModelOptions() };
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
    if (conversation.status !== 'DRAFT') throw errors.conflict('已提交的会话不能修改', 'VIBECODING_CONVERSATION_LOCKED');
    const now = nowIso();
    const title = body.title === undefined ? conversation.title : nonEmptyString(body.title, '会话标题', { max: 60 });
    const files = parseFiles(body.files, { fallback: null });
    const entryFile = body.entryFile === undefined ? conversation.entry_file : nonEmptyString(body.entryFile, '入口文件', { max: 64 });
    const nextFiles = files || filesOf(conversation);
    if (!nextFiles[entryFile]) throw errors.badRequest('入口文件必须存在', 'VIBECODING_ENTRY_FILE_MISSING');
    let nextModel = conversation.model || null;
    if (body.model !== undefined) {
      const requested = String(body.model || '').trim();
      if (!requested) nextModel = null;
      else if (!textModelOptions().some((item) => item.id === requested)) throw errors.badRequest('该模型不在当前 AI 渠道的可选范围内', 'VIBECODING_MODEL_NOT_AVAILABLE');
      else nextModel = requested;
    }
    q('UPDATE vibecoding_conversations SET title=?,files=?,entry_file=?,model=?,updated_at=? WHERE id=? AND student_id=? AND org_id=?',
      [title, json(nextFiles), entryFile, nextModel, now, conversation.id, ownerAuth.user.id, ownerAuth.user.orgId]);
    const updated = row('SELECT * FROM vibecoding_conversations WHERE id = ?', [conversation.id]);
    return normalizeConversation(updated, { includeFiles: true });
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
    const content = nonEmptyString(body.content, '消息内容', { max: MAX_MESSAGE_CHARS });
    const user = activeStudent(ownerAuth);
    const context = vibeCodingContext(user, conversation.lesson_id, conversation.class_id);
    assertChatPreflight({ user, orgId: ownerAuth.user.orgId, context });

    const userMessageId = id('vibemsg');
    const now = nowIso();
    q('INSERT INTO vibecoding_messages(id,conversation_id,role,content,model,status,created_at) VALUES (?,?,?,?,?,?,?)',
      [userMessageId, conversation.id, 'user', content, conversation.model || null, 'SUCCEEDED', now]);
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

  const runMatch = part.match(/^\/conversations\/([^/]+)\/runs$/);
  if (runMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = ownConversation(ctx, runMatch[1]);
    if (conversation.status !== 'DRAFT') throw errors.conflict('已提交的会话不能继续运行代码', 'VIBECODING_CONVERSATION_LOCKED');
    const user = activeStudent(ownerAuth);
    vibeCodingContext(user, conversation.lesson_id, conversation.class_id);
    const capability = sandboxCapability();
    if (!capability.available) throw errors.serviceUnavailable(capability.reason || '代码运行沙箱当前不可用', 'VIBECODING_SANDBOX_UNAVAILABLE');
    const files = filesOf(conversation);
    const entryFile = /\.(m?js)$/i.test(conversation.entry_file)
      ? conversation.entry_file
      : Object.keys(files).find((name) => /\.(m?js)$/i.test(name));
    if (!entryFile) throw errors.badRequest('没有可运行的 JavaScript 文件；HTML 项目请用右侧预览查看效果', 'VIBECODING_RUN_ENTRY_NOT_JAVASCRIPT');

    const runId = id('viberun');
    const now = nowIso();
    q(`INSERT INTO vibecoding_runs(id,conversation_id,org_id,user_id,language,entry_file,status,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [runId, conversation.id, ownerAuth.user.orgId, ownerAuth.user.id, 'javascript', entryFile, 'QUEUED', now]);
    const result = await serializeRun(() => runJavaScript({ files, entryFile }));
    q(`UPDATE vibecoding_runs SET status=?,exit_code=?,stdout=?,stderr=?,duration_ms=?,error_code=?,finished_at=? WHERE id=?`,
      [result.status, result.exitCode, result.stdout, result.stderr, result.durationMs, result.errorCode, nowIso(), runId]);
    audit(ctx, 'VIBECODING_RUN', 'VIBECODING_CONVERSATION', conversation.id, null, { runId, status: result.status, durationMs: result.durationMs });
    return { run: normalizeRun(row('SELECT * FROM vibecoding_runs WHERE id=?', [runId])), sandbox: capability };
  }

  if (runMatch && method === 'GET') {
    const { conversation } = ownConversation(ctx, runMatch[1]);
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 10 });
    const total = Number(count('SELECT COUNT(*) n FROM vibecoding_runs WHERE conversation_id = ?', [conversation.id]) || 0);
    const items = rows('SELECT * FROM vibecoding_runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?', [conversation.id, limit, offset]).map(normalizeRun);
    return { ...pageResult(items, { page, limit, total }), sandbox: sandboxCapability() };
  }

  if (part === '/sandbox' && method === 'GET') {
    return sandboxCapability();
  }

  const submitMatch = part.match(/^\/conversations\/([^/]+)\/submit$/);
  if (submitMatch && method === 'POST') {
    const { auth: ownerAuth, conversation } = ownConversation(ctx, submitMatch[1]);
    const user = activeStudent(ownerAuth);
    vibeCodingContext(user, conversation.lesson_id, conversation.class_id);
    const existing = row('SELECT * FROM vibecoding_submissions WHERE conversation_id = ?', [conversation.id]);
    if (existing && existing.status === 'PENDING') throw errors.conflict('作品已提交，等待老师点评', 'VIBECODING_ALREADY_SUBMITTED');
    // 与画布作品一致：提交即确认版权与展示授权，平台后续才可发布到作品广场
    if (ctx.body?.copyrightConfirmed !== true) {
      throw errors.badRequest('提交前请确认作品版权与展示授权', 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
    }
    const files = filesOf(conversation);
    const transcript = rows("SELECT role, content, created_at FROM vibecoding_messages WHERE conversation_id=? AND status='SUCCEEDED' ORDER BY created_at, rowid", [conversation.id])
      .map((message) => ({ role: message.role, content: message.content, createdAt: message.created_at }));
    const title = body.title === undefined || String(body.title).trim() === '' ? conversation.title : nonEmptyString(body.title, '作品标题', { max: 60 });
    const description = String(body.description || '').slice(0, 1000);
    const now = nowIso();
    const submissionId = existing?.id || id('vibesub');
    transaction(() => {
      if (existing) {
        q(`UPDATE vibecoding_submissions SET title=?,description=?,files=?,transcript=?,entry_file=?,round=round+1,status='PENDING',
             teacher_comment=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=?,updated_at=?,
             copyright_confirmed_at=?,copyright_confirmed_by=? WHERE id=?`,
          [title, description, json(files), json(transcript), conversation.entry_file || 'index.html', now, now, now, ownerAuth.user.id, submissionId]);
      } else {
        q(`INSERT INTO vibecoding_submissions(
             id,conversation_id,student_id,org_id,class_id,lesson_id,title,description,files,transcript,entry_file,round,status,submitted_at,created_at,updated_at,
             copyright_confirmed_at,copyright_confirmed_by
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [submissionId, conversation.id, ownerAuth.user.id, ownerAuth.user.orgId, conversation.class_id, conversation.lesson_id,
            title, description, json(files), json(transcript), conversation.entry_file || 'index.html', 1, 'PENDING', now, now, now, now, ownerAuth.user.id]);
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

async function handleOrgVibeCoding(ctx, auth, part) {
  const { method } = ctx;
  if (part === '/submissions' && method === 'GET') {
    const { page, limit, offset } = pageParams(ctx.search, { defaultLimit: 20 });
    const conditions = ['submission.org_id = ?'];
    const params = [auth.user.orgId];
    const status = String(ctx.search.get('status') || '').trim().toUpperCase();
    if (['PENDING', 'APPROVED', 'REJECTED'].includes(status)) { conditions.push('submission.status = ?'); params.push(status); }
    const scope = teacherSubmissionScope(auth);
    const where = conditions.join(' AND ') + scope.sql;
    const scopeParams = [...params, ...scope.params];
    const total = Number(count(`SELECT COUNT(*) n FROM vibecoding_submissions submission LEFT JOIN classes class ON class.id = submission.class_id WHERE ${where}`, scopeParams) || 0);
    const items = rows(
      submissionSelect() + ` WHERE ${where} ORDER BY CASE submission.status WHEN 'PENDING' THEN 0 ELSE 1 END, submission.submitted_at DESC LIMIT ? OFFSET ?`,
      [...scopeParams, limit, offset],
    ).map((item) => normalizeSubmission(item));
    return { ...pageResult(items, { page, limit, total }), pending: Number(count(`SELECT COUNT(*) n FROM vibecoding_submissions submission LEFT JOIN classes class ON class.id = submission.class_id WHERE ${where} AND submission.status='PENDING'`, scopeParams) || 0) };
  }

  const reviewMatch = part.match(/^\/submissions\/([^/]+)$/);
  if (reviewMatch && method === 'GET') {
    const submission = row(submissionSelect() + ' WHERE submission.id = ? AND submission.org_id = ?', [reviewMatch[1], auth.user.orgId]);
    if (!submission) throw errors.notFound('提交不存在', 'VIBECODING_SUBMISSION_NOT_FOUND');
    if (auth.user.role === 'TEACHER') {
      const scope = teacherSubmissionScope(auth);
      const scoped = row(`SELECT submission.id FROM vibecoding_submissions submission LEFT JOIN classes class ON class.id = submission.class_id WHERE submission.id = ?${scope.sql}`, [reviewMatch[1], ...scope.params]);
      if (!scoped) throw errors.forbidden('该学生不在你的班级里', 'VIBECODING_SUBMISSION_FORBIDDEN');
    }
    return normalizeSubmission(submission, { includeContent: true });
  }

  if (reviewMatch && method === 'PUT') {
    const submission = row(submissionSelect() + ' WHERE submission.id = ? AND submission.org_id = ?', [reviewMatch[1], auth.user.orgId]);
    if (!submission) throw errors.notFound('提交不存在', 'VIBECODING_SUBMISSION_NOT_FOUND');
    if (auth.user.role === 'TEACHER') {
      const scope = teacherSubmissionScope(auth);
      const scoped = row(`SELECT submission.id FROM vibecoding_submissions submission LEFT JOIN classes class ON class.id = submission.class_id WHERE submission.id = ?${scope.sql}`, [reviewMatch[1], ...scope.params]);
      if (!scoped) throw errors.forbidden('该学生不在你的班级里', 'VIBECODING_SUBMISSION_FORBIDDEN');
    }
    if (submission.status !== 'PENDING') throw errors.conflict('该提交已处理，不能重复点评', 'VIBECODING_SUBMISSION_ALREADY_REVIEWED');
    const status = String(ctx.body?.status || '').trim().toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(status)) throw errors.badRequest('点评结果无效', 'INVALID_VIBECODING_REVIEW_STATUS');
    const comment = String(ctx.body?.comment || '').trim().slice(0, 2000);
    if (status === 'REJECTED' && !comment) throw errors.badRequest('驳回时请写明原因', 'VIBECODING_REVIEW_COMMENT_REQUIRED');
    const now = nowIso();
    transaction(() => {
      q('UPDATE vibecoding_submissions SET status=?,teacher_comment=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?',
        [status, comment, auth.user.id, now, now, submission.id]);
      // 驳回后放开继续创作，学生改完可以再提交
      if (status === 'REJECTED') q("UPDATE vibecoding_conversations SET status='DRAFT',updated_at=? WHERE id=?", [now, submission.conversation_id]);
      audit(ctx, 'VIBECODING_REVIEW', 'VIBECODING_SUBMISSION', submission.id, { status: submission.status }, { status, comment });
    });
    return normalizeSubmission(row(submissionSelect() + ' WHERE submission.id = ?', [submission.id]), { includeContent: true });
  }

  return null;
}

export async function handleVibeCoding(ctx) {
  const { pathname } = ctx;
  if (pathname.startsWith('/api/org/vibecoding')) {
    if (!ctx.auth) throw errors.unauthorized('请先登录', 'UNAUTHORIZED');
    const auth = requireRole(ctx, ['ORG_ADMIN', 'TEACHER']);
    const part = pathname.slice('/api/org/vibecoding'.length) || '/';
    return handleOrgVibeCoding(ctx, auth, part);
  }
  if (!pathname.startsWith('/api/student/vibecoding')) return null;
  if (!ctx.auth) throw errors.unauthorized('请先登录', 'UNAUTHORIZED');
  const auth = requireRole(ctx, ['STUDENT']);
  const part = pathname.slice('/api/student/vibecoding'.length) || '/';
  return handleStudentVibeCoding(ctx, auth, part);
}
