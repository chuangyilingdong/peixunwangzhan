/**
 * 招生军师 · 内容工作台接口。
 *
 * 所有接口都要求机构登录；数据按 owner_key（org:<机构id> / user:<用户id>）隔离。
 * 生成走平台 TEXT 渠道（services/junshiChat.js 的 runRawText），不另配 key。
 * 资料检索复用 junshi 自带的 chunks/knowledge 语料，因此工作台回答仍然是「这家机构自己的答案」。
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import { stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aq, arow, arows, corsHeaders, errors, id, nowIso, requireAuth } from '../lib.js';
import { retrieveChunks, retrieveStructured, runRawText, textProviderIsMock } from '../services/junshiChat.js';
import { isMockProvider } from '../services/providerContract.js';
import { maxUploadBytes, parseMultipartFormData, persistSecureUpload, uploadRoot } from '../services/fileUploadSecurity.js';
import { ossRedirectUrl, removeObject, rowStorageBackend } from '../services/fileStorage.js';
import {
  WORKBENCH_SYSTEM,
  buildChatSystem,
  buildCopyPrompt,
  buildSrt,
  buildVideoPrompt,
  demoChat,
  demoCopy,
  demoVideo,
} from '../services/junshiWorkbenchContent.js';

const EMPTY_PROFILE = {
  name: '',
  platform: '抖音',
  product: '',
  audience: '',
  goal: '',
  tone: '',
  boundaries: '',
  positioning: '',
};
const PROFILE_FIELDS = Object.keys(EMPTY_PROFILE);
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/junshi');
let knowledgeCache = null;
function knowledge() {
  if (!knowledgeCache) {
    knowledgeCache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'knowledge.json'), 'utf8'));
  }
  return knowledgeCache;
}
const text = (value) => String(value ?? '').trim();
const clampInt = (value, fallback, min, max) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const MAX_TEXT = 4000;

function ownerOf(ctx) {
  const auth = requireAuth(ctx);
  return {
    auth,
    key: auth.user.orgId ? `org:${auth.user.orgId}` : `user:${auth.user.id}`,
    orgId: auth.user.orgId || null,
  };
}

/* ───────────── 限流 ───────────── */
const WINDOW_MS = 60 * 60 * 1000;
const HOUR_LIMIT = 120;
const hits = new Map();
function rateLimit(ownerKey) {
  const now = Date.now();
  const recent = (hits.get(ownerKey) || []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= HOUR_LIMIT) {
    throw errors.badRequest('这个机构本小时的工作台生成次数已达上限，请稍后再试。', 'WORKBENCH_RATE_LIMITED');
  }
  recent.push(now);
  hits.set(ownerKey, recent);
  if (hits.size > 3000) {
    for (const [key, values] of hits) if (!values.some((at) => now - at < WINDOW_MS)) hits.delete(key);
  }
}

/* ───────────── 画像 ───────────── */
function cleanProfile(input) {
  const out = {};
  for (const field of PROFILE_FIELDS) {
    const value = text(input?.[field]);
    if (value.length > 2000) throw errors.badRequest(`字段 ${field} 超长`, 'VALIDATION_ERROR', { field });
    out[field] = value;
  }
  out.name = out.name || '我的内容账号';
  out.platform = out.platform || '抖音';
  return out;
}

async function readProfile(ownerKey) {
  const row = await arow('SELECT content, updated_at FROM junshi_workbench_profiles WHERE owner_key=?', [ownerKey]);
  if (!row) return { profile: { ...EMPTY_PROFILE }, updatedAt: null };
  try {
    return { profile: { ...EMPTY_PROFILE, ...JSON.parse(row.content || '{}') }, updatedAt: row.updated_at || null };
  } catch {
    return { profile: { ...EMPTY_PROFILE }, updatedAt: row.updated_at || null };
  }
}

async function saveProfile(ownerKey, orgId, profile) {
  const now = nowIso();
  const content = JSON.stringify(profile);
  const existing = await arow('SELECT owner_key FROM junshi_workbench_profiles WHERE owner_key=?', [ownerKey]);
  if (existing) {
    await aq('UPDATE junshi_workbench_profiles SET content=?, updated_at=? WHERE owner_key=?', [content, now, ownerKey]);
  } else {
    await aq('INSERT INTO junshi_workbench_profiles (owner_key, org_id, content, created_at, updated_at) VALUES (?,?,?,?,?)',
      [ownerKey, orgId, content, now, now]);
  }
}

/** 把 junshi 的机构画像压成一段文本，工作台生成时一起喂给模型。 */
async function orgProfileText(ownerKey) {
  const row = await arow('SELECT content FROM junshi_profiles WHERE owner_key=?', [ownerKey]).catch(() => null);
  if (!row) return '';
  let data = {};
  try { data = JSON.parse(row.content || '{}'); } catch { return ''; }
  const labels = {
    org: { name: '机构名称', shortName: '简称', city: '城市', campuses: '校区' },
    product: { categories: '课程品类', classTypes: '班型', unitPrice: '课时单价', mainPackage: '主力课包', discountFloor: '优惠底线' },
    biz: { students: '在读学员', perCampus: '分校区人数', fullRate: '满班率', renewRate: '历史续班率' },
    reach: { douyin: '抖音号', officialAccount: '公众号', phone: '电话', addressScript: '地址话术' },
    cases: { caseStudy: '学员案例', praise: '家长好评', achievements: '成果数据' },
    risk: { forbiddenWords: '不能说的词', noPromise: '不能承诺的事', prepayRule: '预收费规则' },
  };
  const lines = [];
  for (const [group, fields] of Object.entries(labels)) {
    const bag = data[group];
    if (!bag || typeof bag !== 'object') continue;
    for (const [field, label] of Object.entries(fields)) {
      if (text(bag[field])) lines.push(`${label}：${text(bag[field])}`);
    }
  }
  return lines.join('\n').slice(0, 3000);
}

/* ───────────── 资料检索 ───────────── */
function retrieve(query, domains = ['营销', '文案', '转化', '续费', '合规'], limit = 4) {
  try { return retrieveChunks(query, domains, limit); } catch { return []; }
}
function retrieveCopies(query, limit = 3) {
  try { return retrieveStructured(query, 'copy', limit).copies || []; } catch { return []; }
}
function citationsOf(chunks) {
  return {
    chunks: chunks.map((chunk) => ({
      title: chunk.title,
      domain: chunk.domain,
      src: chunk.src,
      excerpt: String(chunk.text || '').slice(0, 120),
    })),
  };
}

/* ───────────── 生成 ───────────── */
async function collectText(ctx, { system, user, messages, signal, onStatus, onDelta }) {
  let output = '';
  const result = await runRawText(ctx, {
    system,
    user,
    messages,
    signal,
    statusLabel: '生成',
    onStatus,
    onDelta: (chunk) => { output += chunk; onDelta?.(chunk); },
  });
  return { text: output.trim(), ...result };
}

function mockOrEmpty(result) {
  return !result?.text || isMockProvider(result.provider || '');
}

function jobStart(owner, kind, detail) {
  const jobId = id('jwj');
  const now = nowIso();
  return { id: jobId, kind, detail, now, promise: aq('INSERT INTO junshi_workbench_jobs (id,owner_key,org_id,kind,status,detail,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [jobId, owner.key, owner.orgId, kind, 'running', detail, now, now]) };
}
async function jobDone(job, status, detail) {
  await aq('UPDATE junshi_workbench_jobs SET status=?, detail=?, updated_at=? WHERE id=?', [status, detail, nowIso(), job.id]);
}

/* ───────────── SSE ───────────── */
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
async function streamDemo(ctx, answer, onDelta) {
  const step = 14;
  for (let index = 0; index < answer.length; index += step) {
    const chunk = answer.slice(index, index + step);
    onDelta(chunk);
    sseSend(ctx, 'delta', { text: chunk });
    await new Promise((resolve) => setTimeout(resolve, 6));
  }
}

/* ───────────── 列表/统计 ───────────── */
async function counts(ownerKey) {
  const count = async (table) => Number((await arow(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_key=?`, [ownerKey]))?.n || 0);
  return {
    messages: await count('junshi_workbench_messages'),
    copy_drafts: await count('junshi_workbench_copy_drafts'),
    videos: await count('junshi_workbench_video_projects'),
    assets: await count('junshi_workbench_assets'),
    references: await count('junshi_workbench_refs'),
    jobs: await count('junshi_workbench_jobs'),
  };
}

function assetOut(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    kind: row.kind,
    size: Number(row.file_size || 0),
    createdAt: row.created_at,
    url: `/api/junshi/workbench/assets/${encodeURIComponent(row.id)}/file`,
  };
}
function messageOut(row) {
  let citations = null;
  try { citations = row.citations ? JSON.parse(row.citations) : null; } catch { /* ignore */ }
  return { id: row.id, role: row.role, content: row.content, citations, createdAt: row.created_at };
}
function videoOut(row) {
  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    referenceText: row.reference_text,
    mode: row.mode,
    script: row.script,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ───────────── 路由 ───────────── */
export async function handleJunshiWorkbench(ctx, rest = '/', search = new URLSearchParams(), method = 'GET') {
  const owner = ownerOf(ctx);

  if (rest === '/bootstrap' && method === 'GET') {
    const profile = await readProfile(owner.key);
    return {
      signedIn: true,
      orgName: ctx.auth?.org?.name || null,
      userName: ctx.auth?.user?.displayName || ctx.auth?.user?.login || null,
      profile: profile.profile,
      profileUpdatedAt: profile.updatedAt,
      stats: await counts(owner.key),
      jobs: (await arows('SELECT * FROM junshi_workbench_jobs WHERE owner_key=? ORDER BY created_at DESC LIMIT 8', [owner.key])).map((row) => ({
        id: row.id, kind: row.kind, status: row.status, detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at,
      })),
    };
  }

  if (rest === '/profile' && method === 'GET') {
    const profile = await readProfile(owner.key);
    return { profile: profile.profile, updatedAt: profile.updatedAt };
  }
  if (rest === '/profile' && method === 'PUT') {
    const profile = cleanProfile(ctx.body?.profile || ctx.body || {});
    await saveProfile(owner.key, owner.orgId, profile);
    return { profile, updatedAt: nowIso() };
  }

  if (rest === '/summary' && method === 'GET') {
    return {
      stats: await counts(owner.key),
      jobs: (await arows('SELECT * FROM junshi_workbench_jobs WHERE owner_key=? ORDER BY created_at DESC LIMIT 8', [owner.key])).map((row) => ({
        id: row.id, kind: row.kind, status: row.status, detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at,
      })),
    };
  }

  /* ── 对话 ── */
  if (rest === '/chat' && method === 'GET') {
    const rows = await arows('SELECT * FROM junshi_workbench_messages WHERE owner_key=? ORDER BY created_at, id LIMIT 200', [owner.key]);
    return { messages: rows.map(messageOut) };
  }
  if (rest === '/chat' && method === 'DELETE') {
    await aq('DELETE FROM junshi_workbench_messages WHERE owner_key=?', [owner.key]);
    return { ok: true };
  }
  if (rest === '/chat/stream' && method === 'POST') {
    const message = text(ctx.body?.message);
    if (!message) throw errors.badRequest('消息不能为空', 'VALIDATION_ERROR', { field: 'message' });
    if (message.length > MAX_TEXT) throw errors.badRequest(`单条消息最多 ${MAX_TEXT} 字`, 'VALIDATION_ERROR', { field: 'message' });
    rateLimit(owner.key);

    const userAt = nowIso();
    const userId = id('jwm');
    await aq('INSERT INTO junshi_workbench_messages (id,owner_key,org_id,role,content,citations,created_at) VALUES (?,?,?,?,?,?,?)',
      [userId, owner.key, owner.orgId, 'user', message, null, userAt]);

    const historyRows = await arows('SELECT role, content FROM junshi_workbench_messages WHERE owner_key=? ORDER BY created_at DESC, id DESC LIMIT 12', [owner.key]);
    const history = historyRows.reverse().map((row) => ({ role: row.role, content: String(row.content || '').slice(0, 4000) }));
    const profile = (await readProfile(owner.key)).profile;
    const orgProfile = await orgProfileText(owner.key);
    const refs = await arows('SELECT * FROM junshi_workbench_refs WHERE owner_key=? ORDER BY created_at DESC LIMIT 5', [owner.key]);
    const chunks = retrieve(message);
    const citations = citationsOf(chunks);
    const kb = knowledge();
    const system = buildChatSystem({ profile, orgProfile, chunks, refs, calendar: kb.calendar, hooks: kb.hooks });
    const messages = [{ role: 'system', content: system }, ...history];

    sseOpen(ctx);
    const controller = new AbortController();
    ctx.res.on('close', () => { if (!ctx.res.writableEnded) controller.abort(); });
    const heartbeat = setInterval(() => {
      if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.write(': ping\n\n');
    }, 15000);
    heartbeat.unref?.();
    let answer = '';
    try {
      sseSend(ctx, 'start', { userMessageId: userId, citations });
      sseSend(ctx, 'citations', citations);
      const providerMock = await textProviderIsMock().catch(() => false);
      let result = null;
      if (providerMock) {
        answer = demoChat(profile, message);
        await streamDemo(ctx, answer, () => {});
        result = { provider: 'demo' };
      } else {
        for (let attempt = 0; attempt < 2; attempt++) {
          answer = '';
          result = await collectText(ctx, {
            system,
            user: message,
            messages,
            signal: controller.signal,
            onStatus: (statusText) => sseSend(ctx, 'status', { text: statusText }),
            onDelta: (chunk) => { answer += chunk; sseSend(ctx, 'delta', { text: chunk }); },
          });
          if (!mockOrEmpty(result)) break;
          if (attempt === 0) {
            sseSend(ctx, 'reset', {});
            messages.push({ role: 'user', content: '（上一条没有产出正文，这次请直接给出答案，不要再展开推理。）' });
          }
        }
        if (mockOrEmpty({ text: answer, provider: result?.provider })) {
          sseSend(ctx, 'reset', {});
          answer = demoChat(profile, message);
          await streamDemo(ctx, answer, () => {});
          result = { ...(result || {}), provider: 'demo' };
        }
      }
      if (!answer.trim()) answer = '（这次没有生成内容，请重试。）';
      const assistantAt = nowIso();
      const assistantId = id('jwm');
      await aq('INSERT INTO junshi_workbench_messages (id,owner_key,org_id,role,content,citations,created_at) VALUES (?,?,?,?,?,?,?)',
        [assistantId, owner.key, owner.orgId, 'assistant', answer, JSON.stringify(citations), assistantAt]);
      sseSend(ctx, 'done', {
        message: { id: assistantId, role: 'assistant', content: answer, citations, createdAt: assistantAt },
        model: result?.model || '',
        provider: result?.provider || '',
        usage: result?.usage || null,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (answer.trim()) {
        try {
          const at = nowIso();
          const assistantId = id('jwm');
          await aq('INSERT INTO junshi_workbench_messages (id,owner_key,org_id,role,content,citations,created_at) VALUES (?,?,?,?,?,?,?)',
            [assistantId, owner.key, owner.orgId, 'assistant', answer, JSON.stringify(citations), at]);
        } catch { /* ignore */ }
      }
      if (!aborted) {
        console.warn('[junshi workbench] 生成失败：', error?.message || error);
        sseSend(ctx, 'error', { message: error?.message || '生成失败，请重试' });
      } else {
        sseSend(ctx, 'stopped', { partial: answer.length });
      }
    } finally {
      clearInterval(heartbeat);
      if (!ctx.res.writableEnded) ctx.res.end();
    }
    return { __streamed: true };
  }

  /* ── 文案 ── */
  if (rest === '/copy' && method === 'GET') {
    const rows = await arows('SELECT * FROM junshi_workbench_copy_drafts WHERE owner_key=? ORDER BY created_at DESC LIMIT 50', [owner.key]);
    return {
      items: rows.map((row) => ({
        id: row.id, topic: row.topic, style: row.style, content: row.content, createdAt: row.created_at,
      })),
    };
  }
  if (rest === '/copy' && method === 'POST') {
    const topic = text(ctx.body?.topic);
    if (!topic) throw errors.badRequest('请填写文案主题', 'VALIDATION_ERROR', { field: 'topic' });
    if (topic.length > 200) throw errors.badRequest('主题最多 200 字', 'VALIDATION_ERROR', { field: 'topic' });
    const count = clampInt(ctx.body?.count, 5, 1, 10);
    const style = text(ctx.body?.style) || '口语化';
    rateLimit(owner.key);
    const job = jobStart(owner, '文案生成', `主题：${topic} · ${count} 条`);
    await job.promise;
    try {
      const profile = (await readProfile(owner.key)).profile;
      const orgProfile = await orgProfileText(owner.key);
      const chunks = retrieve(topic, ['文案', '营销'], 4);
      const copies = retrieveCopies(topic, 3);
      const userPrompt = buildCopyPrompt({ profile, orgProfile, topic, count, style, chunks, copies });
      const providerMock = await textProviderIsMock().catch(() => false);
      const result = providerMock ? { text: '', provider: 'demo' } : await collectText(ctx, { system: WORKBENCH_SYSTEM, user: userPrompt });
      const content = mockOrEmpty(result) ? demoCopy(profile, topic, count, style) : result.text;
      const draftId = id('jwc');
      const at = nowIso();
      await aq('INSERT INTO junshi_workbench_copy_drafts (id,owner_key,org_id,topic,style,content,created_at) VALUES (?,?,?,?,?,?,?)',
        [draftId, owner.key, owner.orgId, topic, style, content, at]);
      await jobDone(job, 'succeeded', `已生成 ${count} 条文案`);
      return {
        draft: { id: draftId, topic, style, content, createdAt: at },
        demo: mockOrEmpty(result),
      };
    } catch (error) {
      await jobDone(job, 'failed', String(error?.message || error).slice(0, 1000));
      throw error;
    }
  }
  if (rest.startsWith('/copy/') && method === 'DELETE') {
    const draftId = decodeURIComponent(rest.slice('/copy/'.length));
    await aq('DELETE FROM junshi_workbench_copy_drafts WHERE id=? AND owner_key=?', [draftId, owner.key]);
    return { ok: true };
  }

  /* ── 视频 ── */
  if (rest === '/videos' && method === 'GET') {
    const rows = await arows('SELECT * FROM junshi_workbench_video_projects WHERE owner_key=? ORDER BY created_at DESC LIMIT 50', [owner.key]);
    return { items: rows.map(videoOut) };
  }
  if (rest === '/videos' && method === 'POST') {
    const title = text(ctx.body?.title);
    if (!title) throw errors.badRequest('请填写视频主题', 'VALIDATION_ERROR', { field: 'title' });
    if (title.length > 120) throw errors.badRequest('视频主题最多 120 字', 'VALIDATION_ERROR', { field: 'title' });
    const mode = text(ctx.body?.mode) === '复刻' ? '复刻' : '原创';
    const brief = text(ctx.body?.brief).slice(0, 4000);
    const referenceText = text(ctx.body?.referenceText || ctx.body?.reference_text).slice(0, 4000);
    rateLimit(owner.key);
    const job = jobStart(owner, '视频脚本', `${mode} · ${title}`);
    await job.promise;
    try {
      const profile = (await readProfile(owner.key)).profile;
      const orgProfile = await orgProfileText(owner.key);
      const chunks = retrieve(`${title} ${brief}`, ['营销', '转化', '续费', '文案'], 4);
      const userPrompt = buildVideoPrompt({ profile, orgProfile, title, brief, referenceText, mode, chunks });
      const providerMock = await textProviderIsMock().catch(() => false);
      const result = providerMock ? { text: '', provider: 'demo' } : await collectText(ctx, { system: WORKBENCH_SYSTEM, user: userPrompt });
      const script = mockOrEmpty(result) ? demoVideo(profile, title, brief, referenceText, mode) : result.text;
      const projectId = id('jwv');
      const at = nowIso();
      await aq('INSERT INTO junshi_workbench_video_projects (id,owner_key,org_id,title,brief,reference_text,mode,script,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [projectId, owner.key, owner.orgId, title, brief, referenceText, mode, script, 'draft', at, at]);
      await jobDone(job, 'succeeded', '分镜脚本已生成');
      return {
        project: { id: projectId, title, brief, referenceText, mode, script, status: 'draft', createdAt: at, updatedAt: at },
        demo: mockOrEmpty(result),
      };
    } catch (error) {
      await jobDone(job, 'failed', String(error?.message || error).slice(0, 1000));
      throw error;
    }
  }
  if (rest.startsWith('/videos/') && method === 'GET' && !rest.endsWith('/export')) {
    const projectId = decodeURIComponent(rest.slice('/videos/'.length));
    const row = await arow('SELECT * FROM junshi_workbench_video_projects WHERE id=? AND owner_key=?', [projectId, owner.key]);
    if (!row) throw errors.notFound('视频项目不存在', 'NOT_FOUND');
    return { project: videoOut(row) };
  }
  if (rest.startsWith('/videos/') && method === 'PUT') {
    const projectId = decodeURIComponent(rest.slice('/videos/'.length));
    const row = await arow('SELECT * FROM junshi_workbench_video_projects WHERE id=? AND owner_key=?', [projectId, owner.key]);
    if (!row) throw errors.notFound('视频项目不存在', 'NOT_FOUND');
    const title = text(ctx.body?.title ?? row.title) || row.title;
    const brief = text(ctx.body?.brief ?? row.brief);
    const script = String(ctx.body?.script ?? row.script ?? '');
    const status = text(ctx.body?.status ?? row.status) || row.status;
    if (title.length > 120) throw errors.badRequest('视频主题最多 120 字', 'VALIDATION_ERROR', { field: 'title' });
    if (script.length > 200000) throw errors.badRequest('脚本过长', 'VALIDATION_ERROR', { field: 'script' });
    await aq('UPDATE junshi_workbench_video_projects SET title=?, brief=?, script=?, status=?, updated_at=? WHERE id=? AND owner_key=?',
      [title, brief, script, status, nowIso(), projectId, owner.key]);
    return { project: videoOut(await arow('SELECT * FROM junshi_workbench_video_projects WHERE id=?', [projectId])) };
  }
  if (rest.startsWith('/videos/') && rest.endsWith('/export') && method === 'GET') {
    const projectId = decodeURIComponent(rest.slice('/videos/'.length, -'/export'.length));
    const row = await arow('SELECT * FROM junshi_workbench_video_projects WHERE id=? AND owner_key=?', [projectId, owner.key]);
    if (!row) throw errors.notFound('视频项目不存在', 'NOT_FOUND');
    const format = text(search.get('format')) || 'md';
    const safeId = String(row.id).replace(/[^A-Za-z0-9_-]/g, '');
    let body; let contentType; let filename;
    if (format === 'json') {
      body = JSON.stringify(videoOut(row), null, 2);
      contentType = 'application/json; charset=utf-8';
      filename = `${safeId}.json`;
    } else if (format === 'srt') {
      body = buildSrt(row.script || '');
      contentType = 'application/x-subrip; charset=utf-8';
      filename = `${safeId}.srt`;
    } else {
      body = `# ${row.title}\n\n${row.script}\n\n---\n\n- 模式：${row.mode}\n- 状态：${row.status}\n`;
      contentType = 'text/markdown; charset=utf-8';
      filename = `${safeId}.md`;
    }
    ctx.res.writeHead(200, corsHeaders(ctx.req, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    }));
    ctx.res.end(body);
    return { __streamed: true };
  }

  /* ── 素材 ── */
  if (rest === '/assets' && method === 'GET') {
    const rows = await arows('SELECT * FROM junshi_workbench_assets WHERE owner_key=? ORDER BY created_at DESC LIMIT 200', [owner.key]);
    return { items: rows.map(assetOut) };
  }
  if (rest === '/assets' && method === 'POST') {
    const contentType = String(ctx.req.headers['content-type'] || '');
    let multipart;
    try { multipart = parseMultipartFormData(ctx.rawBody || Buffer.alloc(0), contentType); }
    catch (error) { throw error; }
    const file = multipart.file;
    if (!file?.buffer?.length) throw errors.badRequest('请选择要上传的文件', 'VALIDATION_ERROR', { field: 'file' });
    if (file.buffer.length > maxUploadBytes()) throw errors.badRequest('文件过大', 'FILE_TOO_LARGE');
    const stored = await persistSecureUpload(file);
    const kind = String(stored.mimeType || '').startsWith('image/') ? 'image'
      : String(stored.mimeType || '').startsWith('video/') ? 'video'
        : String(stored.mimeType || '').startsWith('audio/') ? 'audio' : 'file';
    const assetId = id('jwa');
    const at = nowIso();
    try {
      await aq('INSERT INTO junshi_workbench_assets (id,owner_key,org_id,file_name,storage_key,storage_backend,mime_type,kind,file_size,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [assetId, owner.key, owner.orgId, stored.fileName, stored.storageKey, stored.storageBackend || 'local', stored.mimeType || '', kind, stored.fileSize || file.buffer.length, at]);
    } catch (error) {
      if (stored.storagePath) await rm(stored.storagePath, { force: true }).catch(() => {});
      else await removeObject({ storage_key: stored.storageKey, metadata: JSON.stringify({ storageBackend: stored.storageBackend }) }).catch(() => {});
      throw error;
    }
    return {
      asset: assetOut({
        id: assetId, file_name: stored.fileName, mime_type: stored.mimeType, kind,
        file_size: stored.fileSize || file.buffer.length, created_at: at,
      }),
    };
  }
  if (rest.startsWith('/assets/') && rest.endsWith('/file') && method === 'GET') {
    const assetId = decodeURIComponent(rest.slice('/assets/'.length, -'/file'.length));
    const row = await arow('SELECT * FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [assetId, owner.key]);
    if (!row) throw errors.notFound('素材不存在', 'NOT_FOUND');
    const pseudo = { storage_key: row.storage_key, metadata: JSON.stringify({ storageBackend: row.storage_backend }) };
    if (rowStorageBackend(pseudo) === 'oss') {
      const url = ossRedirectUrl(pseudo, { expires: 600, contentDisposition: 'inline' });
      if (url) {
        ctx.res.writeHead(302, { location: url, 'cache-control': 'private, no-store' });
        ctx.res.end();
        return { __streamed: true };
      }
    }
    const root = uploadRoot();
    const absolute = path.resolve(root, String(row.storage_key || ''));
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw errors.notFound('素材路径不合法', 'NOT_FOUND');
    let info;
    try { info = await stat(absolute); } catch { throw errors.notFound('素材文件不存在', 'NOT_FOUND'); }
    if (!info.isFile()) throw errors.notFound('素材文件不存在', 'NOT_FOUND');
    const inline = /^(image|video|audio)\//.test(String(row.mime_type || ''));
    ctx.res.writeHead(200, corsHeaders(ctx.req, {
      'content-type': row.mime_type || 'application/octet-stream',
      'content-length': info.size,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name || 'asset')}`,
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
    }));
    createReadStream(absolute).on('error', () => { if (!ctx.res.destroyed) ctx.res.destroy(); }).pipe(ctx.res);
    return { __streamed: true };
  }
  if (rest.startsWith('/assets/') && method === 'DELETE') {
    const assetId = decodeURIComponent(rest.slice('/assets/'.length));
    const row = await arow('SELECT * FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [assetId, owner.key]);
    if (!row) throw errors.notFound('素材不存在', 'NOT_FOUND');
    const pseudo = { storage_key: row.storage_key, metadata: JSON.stringify({ storageBackend: row.storage_backend }) };
    if (rowStorageBackend(pseudo) === 'local') {
      const root = uploadRoot();
      const absolute = path.resolve(root, String(row.storage_key || ''));
      if (absolute !== root && absolute.startsWith(root + path.sep)) await rm(absolute, { force: true }).catch(() => {});
    } else {
      await removeObject(pseudo).catch(() => {});
    }
    await aq('DELETE FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [assetId, owner.key]);
    return { ok: true };
  }

  /* ── 同行观察 ── */
  if (rest === '/refs' && method === 'GET') {
    const rows = await arows('SELECT * FROM junshi_workbench_refs WHERE owner_key=? ORDER BY created_at DESC LIMIT 100', [owner.key]);
    return {
      items: rows.map((row) => ({
        id: row.id, name: row.name, url: row.url, notes: row.notes, createdAt: row.created_at,
      })),
    };
  }
  if (rest === '/refs' && method === 'POST') {
    const name = text(ctx.body?.name);
    if (!name) throw errors.badRequest('请填写同行名称', 'VALIDATION_ERROR', { field: 'name' });
    if (name.length > 120) throw errors.badRequest('名称最多 120 字', 'VALIDATION_ERROR', { field: 'name' });
    const url = text(ctx.body?.url).slice(0, 2000);
    const notes = text(ctx.body?.notes).slice(0, 4000);
    const refId = id('jwr');
    const at = nowIso();
    await aq('INSERT INTO junshi_workbench_refs (id,owner_key,org_id,name,url,notes,created_at) VALUES (?,?,?,?,?,?,?)',
      [refId, owner.key, owner.orgId, name, url, notes, at]);
    return { ref: { id: refId, name, url, notes, createdAt: at } };
  }
  if (rest.startsWith('/refs/') && method === 'DELETE') {
    const refId = decodeURIComponent(rest.slice('/refs/'.length));
    await aq('DELETE FROM junshi_workbench_refs WHERE id=? AND owner_key=?', [refId, owner.key]);
    return { ok: true };
  }

  /* ── 任务 ── */
  if (rest === '/jobs' && method === 'GET') {
    const rows = await arows('SELECT * FROM junshi_workbench_jobs WHERE owner_key=? ORDER BY created_at DESC LIMIT 100', [owner.key]);
    return {
      items: rows.map((row) => ({
        id: row.id, kind: row.kind, status: row.status, detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at,
      })),
    };
  }

  return null;
}
