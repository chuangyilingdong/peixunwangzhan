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
import { providerSelectionForModality } from './aiGeneration.js';
import { runJavaScript, sandboxCapability } from '../services/vibecodingRunner.js';

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

function normalizeSubmission(value, { includeContent = false } = {}) {
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
    const where = conditions.join(' AND ');
    const total = Number(count(`SELECT COUNT(*) n FROM vibecoding_conversations conversation WHERE ${where}`, params) || 0);
    const items = rows(
      `SELECT conversation.*, lesson.title AS lesson_title, class.name AS class_name
       FROM vibecoding_conversations conversation
       LEFT JOIN course_lessons lesson ON lesson.id = conversation.lesson_id
       LEFT JOIN classes class ON class.id = conversation.class_id
       WHERE ${where}
       ORDER BY COALESCE(conversation.last_message_at, conversation.created_at) DESC, conversation.id DESC
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
    return { ...normalizeConversation(conversation, { includeFiles: true }), messages, messagesTotal: total, messagesPage: page, submission: normalizeSubmission(submission) };
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
    q('UPDATE vibecoding_conversations SET title=?,files=?,entry_file=?,updated_at=? WHERE id=? AND student_id=? AND org_id=?',
      [title, json(nextFiles), entryFile, now, conversation.id, ownerAuth.user.id, ownerAuth.user.orgId]);
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
    if (conversation.status !== 'DRAFT') throw errors.conflict('已提交的会话不能继续对话', 'VIBECODING_CONVERSATION_LOCKED');
    const content = nonEmptyString(body.content, '消息内容', { max: MAX_MESSAGE_CHARS });
    const user = activeStudent(ownerAuth);
    const context = vibeCodingContext(user, conversation.lesson_id, conversation.class_id);
    assertChatPreflight({ user, orgId: ownerAuth.user.orgId, context });
    const policy = getAiProviderPolicy();
    const selection = providerSelectionForModality(policy, 'TEXT', conversation.model || '');
    const provider = getGenerationProvider(selection);
    if (typeof provider.generateStream !== 'function') throw errors.conflict('当前 AI 渠道不支持流式对话', 'VIBECODING_STREAM_UNAVAILABLE');

    const userMessageId = id('vibemsg');
    const now = nowIso();
    q('INSERT INTO vibecoding_messages(id,conversation_id,role,content,model,status,created_at) VALUES (?,?,?,?,?,?,?)',
      [userMessageId, conversation.id, 'user', content, selection.model, 'SUCCEEDED', now]);
    const autoTitle = !conversation.title || conversation.title === DEFAULT_TITLE;
    q('UPDATE vibecoding_conversations SET last_message_at=?,updated_at=? WHERE id=?', [now, now, conversation.id]);
    if (autoTitle) q('UPDATE vibecoding_conversations SET title=? WHERE id=?', [content.slice(0, 24), conversation.id]);

    const history = rows(
      "SELECT role, content FROM vibecoding_messages WHERE conversation_id=? AND status='SUCCEEDED' ORDER BY created_at DESC, rowid DESC LIMIT ?",
      [conversation.id, HISTORY_MESSAGES],
    ).reverse().map((message) => ({ role: message.role, content: message.content }));

    sseOpen(ctx);
    sseSend(ctx, 'start', { userMessageId, conversationId: conversation.id, model: selection.model, provider: provider.name });
    let streamedText = '';
    try {
      const result = await provider.generateStream({
        messages: history,
        onDelta: (delta, full) => { streamedText = full; sseSend(ctx, 'delta', { delta }); },
      });
      const text = String(result?.assets?.[0]?.metadata?.text || streamedText || '').trim();
      if (!text) throw errors.conflict('AI 没有返回内容', 'GENERATION_EMPTY_RESULT');
      const assistantMessageId = id('vibemsg');
      let balanceAfter = 0;
      transaction(() => {
        const fresh = row('SELECT * FROM vibecoding_conversations WHERE id=? AND student_id=?', [conversation.id, ownerAuth.user.id]);
        if (!fresh) throw errors.notFound('创作会话不存在', 'VIBECODING_CONVERSATION_NOT_FOUND');
        const charged = chargeCreditsInTransaction({
          orgId: ownerAuth.user.orgId, credits: 1, type: 'AI_VIBECODING_CHAT', modality: 'TEXT', model: selection.model,
          userId: ownerAuth.user.id, sessionId: fresh.class_session_id || null,
        });
        debitUserAiCredits({ userId: ownerAuth.user.id, orgId: ownerAuth.user.orgId, credits: 1 });
        recordAiUsage({
          orgId: ownerAuth.user.orgId, userId: ownerAuth.user.id, sessionId: fresh.class_session_id || null,
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
      recordFailedMessage(conversation.id, selection.model, streamedText, code);
      recordAiUsage({
        orgId: ownerAuth.user.orgId, userId: ownerAuth.user.id, sessionId: conversation.class_session_id || null,
        modality: 'TEXT', model: selection.model, credits: 0, status: 'FAILED', failCode: code,
        pricing: { source: 'vibecoding', provider: provider.name, conversationId: conversation.id },
      });
      sseSend(ctx, 'error', { code, message: error?.message || 'AI 回复失败' });
    } finally {
      if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end();
    }
    return { __streamed: true };
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
             teacher_comment=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=?,updated_at=? WHERE id=?`,
          [title, description, json(files), json(transcript), conversation.entry_file || 'index.html', now, now, submissionId]);
      } else {
        q(`INSERT INTO vibecoding_submissions(
             id,conversation_id,student_id,org_id,class_id,lesson_id,title,description,files,transcript,entry_file,round,status,submitted_at,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [submissionId, conversation.id, ownerAuth.user.id, ownerAuth.user.orgId, conversation.class_id, conversation.lesson_id,
            title, description, json(files), json(transcript), conversation.entry_file || 'index.html', 1, 'PENDING', now, now, now]);
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
