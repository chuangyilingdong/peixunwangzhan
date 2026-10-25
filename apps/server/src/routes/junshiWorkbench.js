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
import { aq, arow, arows, corsHeaders, errors, id, nowIso, requireAuth, ApiError } from '../lib.js';
import { retrieveChunks, retrieveStructured, runRawText, textProviderIsMock } from '../services/junshiChat.js';
import { isMockProvider, normalizeProviderError } from '../services/providerContract.js';
import { getGenerationProvider, generationProviderInfo } from '../services/generationProvider.js';
import { providerSelectionForModality, generationOptionsFor } from './aiGeneration.js';
import { getAiProviderPolicy } from './billingConfig.js';
import { getProviderApiKey } from '../services/providerSecret.js';
import { AI_PROVIDER_API_KEY } from '../config.js';
import {
  douyinRateLimit,
  douyinPython,
  resolveDouyinTarget,
  fetchDouyinVideo,
  fetchDouyinProfile,
  downloadDouyinVideo,
  seedanceAsrConfig,
  transcribeMedia,
} from '../services/junshiDouyin.js';
import {
  seedanceChannelConfig,
  uploadToSeedance,
  submitAudioTask,
  pollAudioTask,
  submitVideoTask,
  pollVideoTask,
  parseFaceSession,
} from '../services/junshiAvatar.js';
import { maxUploadBytes, parseMultipartFormData, persistSecureUpload, uploadRoot } from '../services/fileUploadSecurity.js';
import { ossRedirectUrl, removeObject, rowStorageBackend } from '../services/fileStorage.js';
import {
  WORKBENCH_SYSTEM,
  COPY_STYLES,
  HOTSPOT_ANGLES,
  VIRAL_STRENGTHS,
  buildBrainDistillPrompt,
  buildChatSystem,
  buildHotspotPickPrompt,
  buildCopyPrompt,
  buildHotspotCopyPrompt,
  buildPeerReportPrompt,
  buildSrt,
  buildTodayIdeasPrompt,
  buildVideoPrompt,
  buildViralOnePrompt,
  buildViralRewritePrompt,
  demoBrain,
  demoChat,
  demoCopy,
  demoHotspotCopies,
  demoIdeas,
  demoPeerReport,
  demoPickedHotspots,
  demoVideo,
  demoViralOne,
  demoViralRewrites,
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

/* ───────────── 视频渲染限流（真实渠道要花钱，单独预算） ───────────── */
const RENDER_HOUR_LIMIT = 20;
const renderHits = new Map();
function renderRateLimit(ownerKey) {
  const now = Date.now();
  const recent = (renderHits.get(ownerKey) || []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= RENDER_HOUR_LIMIT) {
    throw errors.badRequest('这个机构本小时的视频渲染次数已达上限（20 次），请稍后再试。', 'WORKBENCH_RENDER_RATE_LIMITED');
  }
  recent.push(now);
  renderHits.set(ownerKey, recent);
  if (renderHits.size > 3000) {
    for (const [key, values] of renderHits) if (!values.some((at) => now - at < WINDOW_MS)) renderHits.delete(key);
  }
}

/* ───────────── 多创作账号 ───────────── */
const DEFAULT_ACCOUNT_OUT = Object.freeze({ id: 'default', name: '默认账号', platform: '抖音', note: '', createdAt: null });
function accountOut(row) {
  return { id: row.id, name: row.name, platform: row.platform, note: row.note, createdAt: row.created_at };
}
/** 校验账号归属：'default' 是隐式账号，其余必须真实存在且属于该机构。 */
async function resolveAccountId(ownerKey, input) {
  const accountId = text(input) || 'default';
  if (accountId === 'default') return accountId;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) throw errors.badRequest('账号无效', 'VALIDATION_ERROR', { field: 'accountId' });
  const row = await arow('SELECT id FROM junshi_workbench_accounts WHERE id=? AND owner_key=?', [accountId, ownerKey]);
  if (!row) throw errors.notFound('账号不存在', 'NOT_FOUND');
  return accountId;
}

/* ───────────── 卡死任务回收（服务重启会丢掉进程内的渲染） ───────────── */
const STALE_RUNNING_MS = 45 * 60 * 1000;
async function reapStale(ownerKey) {
  try {
    const rows = await arows("SELECT id, updated_at FROM junshi_workbench_jobs WHERE owner_key=? AND status='running'", [ownerKey]);
    const cutoff = Date.now() - STALE_RUNNING_MS;
    const staleIds = rows.filter((row) => Date.parse(row.updated_at || '') < cutoff).map((row) => row.id);
    for (const jobId of staleIds) {
      await aq("UPDATE junshi_workbench_jobs SET status='failed', detail=CASE WHEN detail='' THEN '超时未完成（可能服务重启中断）' ELSE detail END, updated_at=? WHERE id=? AND status='running'", [nowIso(), jobId]);
      await aq("UPDATE junshi_workbench_video_renders SET status='failed', error='超时未完成（可能服务重启中断）', updated_at=? WHERE job_id=? AND status='running'", [nowIso(), jobId]);
    }
  } catch { /* 回收失败不影响读列表 */ }
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

async function readProfile(ownerKey, accountId = 'default') {
  const row = await arow('SELECT content, updated_at FROM junshi_workbench_account_profiles WHERE owner_key=? AND account_id=?', [ownerKey, accountId]);
  if (!row) return { profile: { ...EMPTY_PROFILE }, updatedAt: null };
  try {
    return { profile: { ...EMPTY_PROFILE, ...JSON.parse(row.content || '{}') }, updatedAt: row.updated_at || null };
  } catch {
    return { profile: { ...EMPTY_PROFILE }, updatedAt: row.updated_at || null };
  }
}

async function saveProfile(ownerKey, orgId, accountId, profile) {
  const now = nowIso();
  const content = JSON.stringify(profile);
  const existing = await arow('SELECT owner_key FROM junshi_workbench_account_profiles WHERE owner_key=? AND account_id=?', [ownerKey, accountId]);
  if (existing) {
    await aq('UPDATE junshi_workbench_account_profiles SET content=?, updated_at=? WHERE owner_key=? AND account_id=?', [content, now, ownerKey, accountId]);
  } else {
    await aq('INSERT INTO junshi_workbench_account_profiles (owner_key, account_id, org_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [ownerKey, accountId, orgId, content, now, now]);
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
async function collectText(ctx, { system, user, messages, signal, onStatus, onDelta, model = '' }) {
  let output = '';
  const result = await runRawText(ctx, {
    system,
    user,
    messages,
    signal,
    statusLabel: '生成',
    model,
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
    folder: row.folder || '',
    accountId: row.account_id || 'default',
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
    accountId: row.account_id || 'default',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function renderOut(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    accountId: row.account_id || 'default',
    title: row.title,
    prompt: row.prompt,
    durationSeconds: Number(row.duration_seconds || 0),
    aspectRatio: row.aspect_ratio || '',
    status: row.status,
    assetId: row.asset_id,
    assetUrl: row.asset_id ? `/api/junshi/workbench/assets/${encodeURIComponent(row.asset_id)}/file` : null,
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ───────────── 路由 ───────────── */
export async function handleJunshiWorkbench(ctx, rest = '/', search = new URLSearchParams(), method = 'GET') {
  const owner = ownerOf(ctx);

  if (rest === '/bootstrap' && method === 'GET') {
    await reapStale(owner.key);
    const profile = await readProfile(owner.key, 'default');
    const accounts = await arows('SELECT * FROM junshi_workbench_accounts WHERE owner_key=? ORDER BY created_at', [owner.key]);
    return {
      signedIn: true,
      orgName: ctx.auth?.org?.name || null,
      userName: ctx.auth?.user?.displayName || ctx.auth?.user?.login || null,
      profile: profile.profile,
      profileUpdatedAt: profile.updatedAt,
      accounts: [DEFAULT_ACCOUNT_OUT, ...accounts.map(accountOut)],
      stats: await counts(owner.key),
      jobs: (await arows('SELECT * FROM junshi_workbench_jobs WHERE owner_key=? ORDER BY created_at DESC LIMIT 8', [owner.key])).map((row) => ({
        id: row.id, kind: row.kind, status: row.status, detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at,
      })),
    };
  }

  /* ── 创作账号 ── */
  if (rest === '/accounts' && method === 'GET') {
    const accounts = await arows('SELECT * FROM junshi_workbench_accounts WHERE owner_key=? ORDER BY created_at', [owner.key]);
    return { accounts: [DEFAULT_ACCOUNT_OUT, ...accounts.map(accountOut)] };
  }
  if (rest === '/accounts' && method === 'POST') {
    const name = text(ctx.body?.name);
    if (!name) throw errors.badRequest('请填写账号名称', 'VALIDATION_ERROR', { field: 'name' });
    if (name.length > 60) throw errors.badRequest('账号名称最多 60 字', 'VALIDATION_ERROR', { field: 'name' });
    if (name === '默认账号') throw errors.badRequest('「默认账号」是保留名称，请换一个', 'WORKBENCH_ACCOUNT_NAME_RESERVED');
    const platform = text(ctx.body?.platform) || '抖音';
    const note = text(ctx.body?.note).slice(0, 500);
    const accountId = id('jwacc');
    const at = nowIso();
    try {
      await aq('INSERT INTO junshi_workbench_accounts (id,owner_key,org_id,name,platform,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [accountId, owner.key, owner.orgId, name, platform, note, at, at]);
    } catch (error) {
      if (/unique|duplicate/i.test(String(error?.message || ''))) throw errors.badRequest('已经有同名账号', 'WORKBENCH_ACCOUNT_EXISTS');
      throw error;
    }
    return { account: accountOut(await arow('SELECT * FROM junshi_workbench_accounts WHERE id=?', [accountId])) };
  }
  if (rest.startsWith('/accounts/') && method === 'DELETE') {
    const accountId = decodeURIComponent(rest.slice('/accounts/'.length));
    if (accountId === 'default') throw errors.badRequest('默认账号不能删除', 'VALIDATION_ERROR');
    const row = await arow('SELECT id FROM junshi_workbench_accounts WHERE id=? AND owner_key=?', [accountId, owner.key]);
    if (!row) throw errors.notFound('账号不存在', 'NOT_FOUND');
    // 账号删了，它名下的内容并回默认账号，不丢数据。
    await aq("UPDATE junshi_workbench_copy_drafts SET account_id='default' WHERE owner_key=? AND account_id=?", [owner.key, accountId]);
    await aq("UPDATE junshi_workbench_video_projects SET account_id='default' WHERE owner_key=? AND account_id=?", [owner.key, accountId]);
    await aq("UPDATE junshi_workbench_assets SET account_id='default' WHERE owner_key=? AND account_id=?", [owner.key, accountId]);
    await aq("UPDATE junshi_workbench_video_renders SET account_id='default' WHERE owner_key=? AND account_id=?", [owner.key, accountId]);
    await aq('DELETE FROM junshi_workbench_account_profiles WHERE owner_key=? AND account_id=?', [owner.key, accountId]);
    await aq('DELETE FROM junshi_workbench_accounts WHERE id=? AND owner_key=?', [accountId, owner.key]);
    return { ok: true };
  }

  if (rest === '/profile' && method === 'GET') {
    const accountId = await resolveAccountId(owner.key, search.get('accountId'));
    const profile = await readProfile(owner.key, accountId);
    return { accountId, profile: profile.profile, updatedAt: profile.updatedAt };
  }
  if (rest === '/profile' && method === 'PUT') {
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    const profile = cleanProfile(ctx.body?.profile || ctx.body || {});
    await saveProfile(owner.key, owner.orgId, accountId, profile);
    return { accountId, profile, updatedAt: nowIso() };
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
    const chatAccountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    const profile = (await readProfile(owner.key, chatAccountId)).profile;
    const memories = await arows("SELECT kind, content FROM junshi_workbench_memories WHERE owner_key=? AND account_id=? ORDER BY created_at DESC LIMIT 12", [owner.key, chatAccountId]).catch(() => []);
    const orgProfile = await orgProfileText(owner.key);
    const refs = await arows('SELECT * FROM junshi_workbench_refs WHERE owner_key=? ORDER BY created_at DESC LIMIT 5', [owner.key]);
    const chunks = retrieve(message);
    const citations = citationsOf(chunks);
    const kb = knowledge();
    const system = buildChatSystem({ profile, orgProfile, chunks, refs, calendar: kb.calendar, hooks: kb.hooks, memories });
    const messages = [{ role: 'system', content: system }, ...history];
    // 附件（对齐原版 @图片N）：只支持图片走视觉；最后一条 user 消息变成 content blocks。
    const attachmentIds = Array.isArray(ctx.body?.attachments) ? ctx.body.attachments.map((item) => text(item)).filter(Boolean).slice(0, 4) : [];
    if (attachmentIds.length) {
      const blocks = [{ type: 'text', text: message }];
      for (const assetId of attachmentIds) {
        const assetRow = await arow('SELECT * FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [assetId, owner.key]).catch(() => null);
        if (!assetRow || !/^image\//.test(String(assetRow.mime_type || ''))) continue;
        try {
          const buffer = await assetBytes(assetRow);
          if (!buffer.length || buffer.length > 6 * 1024 * 1024) continue;
          blocks.push({ type: 'image_url', image_url: { url: `data:${assetRow.mime_type};base64,${buffer.toString('base64')}` } });
        } catch { /* 单张读取失败不影响整条消息 */ }
      }
      if (blocks.length > 1) messages[messages.length - 1] = { role: 'user', content: blocks };
    }

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
      // 模型档位（对齐原版 标准/快速 双档）：deep 取渠道里异于默认的另一个模型。
      let tierModel = '';
      if (text(ctx.body?.tier) === 'deep') {
        const policy = await getAiProviderPolicy();
        const textChannel = (policy?.channels || []).find((channel) => /deepseek/i.test(String(channel.endpoint || ''))) || (policy?.channels || [])[0] || null;
        const models = Array.isArray(textChannel?.models) ? textChannel.models : [];
        tierModel = models.find((candidate) => candidate && candidate !== textChannel?.model) || '';
      }
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
            model: tierModel,
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
    const accountIdFilter = text(search.get('accountId'));
    const rows = accountIdFilter
      ? await arows('SELECT * FROM junshi_workbench_copy_drafts WHERE owner_key=? AND account_id=? ORDER BY created_at DESC LIMIT 50', [owner.key, accountIdFilter])
      : await arows('SELECT * FROM junshi_workbench_copy_drafts WHERE owner_key=? ORDER BY created_at DESC LIMIT 50', [owner.key]);
    return {
      items: rows.map((row) => ({
        id: row.id, topic: row.topic, style: row.style, content: row.content,
        accountId: row.account_id || 'default', createdAt: row.created_at,
        stats: (() => { try { return row.stats ? JSON.parse(row.stats) : null; } catch { return null; } })(),
      })),
    };
  }
  if (rest === '/copy' && method === 'POST') {
    const topic = text(ctx.body?.topic);
    if (!topic) throw errors.badRequest('请填写文案主题', 'VALIDATION_ERROR', { field: 'topic' });
    if (topic.length > 200) throw errors.badRequest('主题最多 200 字', 'VALIDATION_ERROR', { field: 'topic' });
    const count = clampInt(ctx.body?.count, 5, 1, 10);
    const style = text(ctx.body?.style) || '口语化';
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    rateLimit(owner.key);
    const job = jobStart(owner, '文案生成', `主题：${topic} · ${count} 条`);
    await job.promise;
    try {
      const profile = (await readProfile(owner.key, accountId)).profile;
      const orgProfile = await orgProfileText(owner.key);
      const chunks = retrieve(topic, ['文案', '营销'], 4);
      const copies = retrieveCopies(topic, 3);
      const userPrompt = buildCopyPrompt({ profile, orgProfile, topic, count, style, chunks, copies });
      const providerMock = await textProviderIsMock().catch(() => false);
      const result = providerMock ? { text: '', provider: 'demo' } : await collectText(ctx, { system: WORKBENCH_SYSTEM, user: userPrompt });
      const content = mockOrEmpty(result) ? demoCopy(profile, topic, count, style) : result.text;
      const draftId = id('jwc');
      const at = nowIso();
      await aq('INSERT INTO junshi_workbench_copy_drafts (id,owner_key,org_id,account_id,topic,style,content,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [draftId, owner.key, owner.orgId, accountId, topic, style, content, at]);
      await jobDone(job, 'succeeded', `已生成 ${count} 条文案`);
      return {
        draft: { id: draftId, topic, style, content, accountId, createdAt: at },
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
    const accountIdFilter = text(search.get('accountId'));
    const rows = accountIdFilter
      ? await arows('SELECT * FROM junshi_workbench_video_projects WHERE owner_key=? AND account_id=? ORDER BY created_at DESC LIMIT 50', [owner.key, accountIdFilter])
      : await arows('SELECT * FROM junshi_workbench_video_projects WHERE owner_key=? ORDER BY created_at DESC LIMIT 50', [owner.key]);
    return { items: rows.map(videoOut) };
  }
  if (rest === '/videos' && method === 'POST') {
    const title = text(ctx.body?.title);
    if (!title) throw errors.badRequest('请填写视频主题', 'VALIDATION_ERROR', { field: 'title' });
    if (title.length > 120) throw errors.badRequest('视频主题最多 120 字', 'VALIDATION_ERROR', { field: 'title' });
    const mode = text(ctx.body?.mode) === '复刻' ? '复刻' : '原创';
    const brief = text(ctx.body?.brief).slice(0, 4000);
    const referenceText = text(ctx.body?.referenceText || ctx.body?.reference_text).slice(0, 4000);
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    rateLimit(owner.key);
    const job = jobStart(owner, '视频脚本', `${mode} · ${title}`);
    await job.promise;
    try {
      const profile = (await readProfile(owner.key, accountId)).profile;
      const orgProfile = await orgProfileText(owner.key);
      const chunks = retrieve(`${title} ${brief}`, ['营销', '转化', '续费', '文案'], 4);
      const userPrompt = buildVideoPrompt({ profile, orgProfile, title, brief, referenceText, mode, chunks });
      const providerMock = await textProviderIsMock().catch(() => false);
      const result = providerMock ? { text: '', provider: 'demo' } : await collectText(ctx, { system: WORKBENCH_SYSTEM, user: userPrompt });
      const script = mockOrEmpty(result) ? demoVideo(profile, title, brief, referenceText, mode) : result.text;
      const projectId = id('jwv');
      const at = nowIso();
      await aq('INSERT INTO junshi_workbench_video_projects (id,owner_key,org_id,account_id,title,brief,reference_text,mode,script,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [projectId, owner.key, owner.orgId, accountId, title, brief, referenceText, mode, script, 'draft', at, at]);
      await jobDone(job, 'succeeded', '分镜脚本已生成');
      return {
        project: { id: projectId, title, brief, referenceText, mode, script, status: 'draft', accountId, createdAt: at, updatedAt: at },
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

/* ───────────── 引导式创作工作流（今日选题/爆款复刻/热点结合）+ 长期记忆 ───────────── */
const WORKFLOW_KINDS = { today: '今日选题', viral: '爆款复刻', hotspot: '热点结合' };
const WORKFLOW_STAGE_LABELS = {
  idea: '选选题', style: '选表达', copy: '选版本', done: '完成',
  transcript: '确认原文', strength: '选改造强度', angle: '选结合方式',
  searching: '联网搜索中', hotspots_ready: '选热点', search_failed: '搜索失败',
  extracting: '提取原文', extract_failed: '提取失败',
  brain: '选写作大脑', rewriting: '改写中', ready: '选版本',
};

/* ── DeepSeek Search API（与文本渠道同一把 Key；官方文档 /v1/tools/search）── */
/* 本地开发：WORKBENCH_FAKE_SEARCH=1 时用 canned 结果走通全链（不花真钱、不需要真 Key）。 */
const FAKE_SEARCH_RESULTS = [
  { title: '多地教育部门发布寒假托管服务指引', url: 'https://example.com/news/1', snippet: '多地把寒假托管纳入公共服务，明确开放时段与报名方式。', summary: '多地把寒假托管纳入公共服务，明确开放时段与报名方式，家长讨论度高。', siteName: '示例新闻网', date: new Date().toISOString(), rerankScore: 2.4, authority: 3 },
  { title: '“体育类校外培训”新规征求意见', url: 'https://example.com/news/2', snippet: '主管部门就体育类校外培训准入与收费公示征求意见。', summary: '主管部门就体育类校外培训准入、收费公示与退费规则公开征求意见，行业关注。', siteName: '示例教育报', date: new Date().toISOString(), rerankScore: 1.9, authority: 4 },
  { title: '寒假研学类课程搜索量上涨', url: 'https://example.com/news/3', snippet: '平台数据显示寒假前后研学类课程搜索量明显上涨。', summary: '平台数据显示寒假前后研学、托管类课程搜索量明显上涨，机构备战寒假档。', siteName: '示例财经', date: new Date().toISOString(), rerankScore: 1.6, authority: 2 },
];
async function textChannelSearchConfig() {
  const policy = await getAiProviderPolicy();
  const selection = providerSelectionForModality(policy, 'TEXT');
  if (process.env.WORKBENCH_FAKE_SEARCH === '1' && isMockProvider(selection.provider)) {
    return { origin: 'https://api.deepseek.com', apiKey: 'fake-local', model: selection.model };
  }
  let origin = '';
  try { origin = new URL(selection.endpoint || '').origin; } catch { return null; }
  if (!/^(https?:)?\/\/api\.deepseek\.com$/i.test(origin)) return null;
  const apiKey = selection.apiKey || getProviderApiKey(selection.channelId) || getProviderApiKey() || AI_PROVIDER_API_KEY;
  return apiKey ? { origin, apiKey, model: selection.model } : null;
}

/** 联网搜索：返回归一化结果；失败抛错（调用方兜底）。计费口径见官方文档：成功且有结果才计费。 */
async function deepseekWebSearch({ query, count = 10 }) {
  const config = await textChannelSearchConfig();
  if (!config) throw Object.assign(new Error('当前文本渠道不是 DeepSeek 官方接口，或没有可用 Key；请改用手动填写热点'), { code: 'WORKBENCH_SEARCH_UNSUPPORTED' });
  if (config.apiKey === 'fake-local') return FAKE_SEARCH_RESULTS.slice(0, Math.max(1, Math.min(3, count)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  timer.unref?.();
  try {
    const response = await fetch(`${config.origin}/v1/tools/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: String(query).slice(0, 128), count: Math.min(50, Math.max(1, count)) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = String(await response.text().catch(() => '')).slice(0, 200);
      if (response.status === 402) throw Object.assign(new Error('搜索服务余额不足（DeepSeek 账户需充值），请联系平台管理员'), { code: 'WORKBENCH_SEARCH_402' });
      throw Object.assign(new Error(`搜索接口返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`), { code: 'WORKBENCH_SEARCH_HTTP' });
    }
    const payload = await response.json();
    return (Array.isArray(payload?.results) ? payload.results : []).map((item) => ({
      title: String(item.title || '').slice(0, 200),
      url: String(item.url || ''),
      snippet: String(item.snippet || '').slice(0, 300),
      summary: String(item.summary || item.snippet || '').slice(0, 800),
      siteName: String(item.site_name || ''),
      date: String(item.date || ''),
      rerankScore: Number(item.rerank_score || 0),
      authority: Number(item.authority || 0),
    }));
  } finally { clearTimeout(timer); }
}

/** 关键词模式的后台执行：搜索 → 模型按账号相关性挑 3 条 → 进 hotspots_ready。 */
async function runHotspotSearch(ctx, owner, { wfId, keyword, accountId }) {
  const fail = async (message) => {
    await wfUpdate(wfId, owner.key, { stage: 'search_failed', state: JSON.stringify({ keyword, searchError: String(message).slice(0, 500) }) }).catch(() => {});
  };
  try {
    const after = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const query = `${keyword} after:${after}`;
    const results = await deepseekWebSearch({ query, count: 12 });
    const profile = (await readProfile(owner.key, accountId)).profile;
    const orgProfile = await orgProfileText(owner.key);
    let hotspots; let demo = false;
    const providerMock = await textProviderIsMock().catch(() => false);
    if (providerMock || !results.length) {
      // 渠道是 mock（本地开发）或搜索无结果：mock 时给演示热点；无结果时如实失败。
      if (providerMock) { hotspots = demoPickedHotspots(keyword); demo = true; }
      else { await fail(`“${keyword.slice(0, 40)}”近 3 天没有搜到结果，换个关键词试试，或改用手动填写`); return; }
    } else {
      const generated = await generateOptions(ctx, owner, {
        prompt: buildHotspotPickPrompt({ profile, orgProfile, keyword, results }),
        demoContent: demoPickedHotspots(keyword),
      });
      hotspots = generated.options.map((option, index) => ({ id: `h${index + 1}`, ...option }));
      demo = generated.demo;
      if (!hotspots.length) { await fail('模型没有从搜索结果里挑出可用热点，请重试或改用手动填写'); return; }
    }
    await wfUpdate(wfId, owner.key, { stage: 'hotspots_ready', state: JSON.stringify({ keyword, hotspots, demo }) });
  } catch (error) {
    await fail(error?.message || '搜索失败');
  }
}

/** 模型被要求「只输出 JSON 数组」，但仍可能带围栏或前后杂字：宽松取出第一个 JSON 数组。 */
function parseLooseJsonArray(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** 同上，但取第一个 JSON 对象。 */
function parseLooseJsonObject(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function wfOut(row) {
  let input = {}; let state = {};
  try { input = JSON.parse(row.input || '{}'); } catch { /* ignore */ }
  try { state = JSON.parse(row.state || '{}'); } catch { /* ignore */ }
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: WORKFLOW_KINDS[row.kind] || row.kind,
    accountId: row.account_id || 'default',
    stage: row.stage,
    stageLabel: WORKFLOW_STAGE_LABELS[row.stage] || row.stage,
    status: row.status,
    error: row.error || '',
    draftId: row.draft_id || null,
    input,
    state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function wfUpdate(id, ownerKey, fields) {
  const sets = Object.keys(fields).map((key) => `${key}=?`).join(', ');
  await aq(`UPDATE junshi_workbench_workflows SET ${sets}, updated_at=? WHERE id=? AND owner_key=?`,
    [...Object.values(fields), nowIso(), id, ownerKey]);
}

/** 走 TEXT 渠道生成一组候选；mock/空回执落演示内容（与文案大脑同一口径）。 */
async function generateOptions(ctx, owner, { prompt, demoContent }) {
  const providerMock = await textProviderIsMock().catch(() => false);
  const result = providerMock ? { text: '', provider: 'demo' } : await collectText(ctx, { system: WORKBENCH_SYSTEM, user: prompt });
  const parsed = mockOrEmpty(result) ? null : parseLooseJsonArray(result.text);
  if (parsed && parsed.length) {
    return { options: parsed.filter((item) => item && typeof item === 'object').slice(0, 3).map((item, index) => ({ id: `opt${index + 1}`, ...item })), demo: false };
  }
  return { options: demoContent.map((item, index) => ({ id: `opt${index + 1}`, ...item })), demo: true };
}

/* ── 工作流文案生成（流式预览版）：一次生成一个版本，完成即落库，前端轮询可见 ── */
const WF_COPY_VARIATIONS = ['走最稳的写法：结构清晰、信息密度高。', '换一个明显不同的切入角度。', '走最大胆的写法：反转或反常识开场。'];

async function wfBrainBlock(ownerKey, state) {
  if (!state.brainId) return '';
  const row = await arow('SELECT name, profile, sections FROM junshi_workbench_brains WHERE id=? AND owner_key=?', [state.brainId, ownerKey]).catch(() => null);
  if (!row) return '';
  let profile = {}; let sections = [];
  try { profile = JSON.parse(row.profile || '{}'); } catch { /* ignore */ }
  try { sections = JSON.parse(row.sections || '[]'); } catch { /* ignore */ }
  const lines = [];
  if (profile.thinking_framework) lines.push(`思考框架：${profile.thinking_framework}`);
  if (profile.topic_approach) lines.push(`选题切入：${profile.topic_approach}`);
  if (profile.tone) lines.push(`语言风格：${profile.tone}`);
  for (const section of sections) if (section?.title && section?.content) lines.push(`${section.title}：${String(section.content).slice(0, 300)}`);
  if (!lines.length) return '';
  return `\n【写作大脑「${row.name}」（只借方法与节奏，不模仿原作者身份）】\n${lines.join('\n')}\n`;
}

/** 逐版本生成并即时落库（对齐原版 stream_options 的「先完成先展示」）。 */
async function runWfCopy(ctx, owner, wfId) {
  const row = await arow('SELECT * FROM junshi_workbench_workflows WHERE id=? AND owner_key=?', [wfId, owner.key]);
  if (!row) return;
  const wf = wfOut(row);
  const state = { ...wf.state };
  const providerMock = await textProviderIsMock().catch(() => false);
  const profileData = await (async () => (await readProfile(owner.key, wf.accountId)).profile)();
  const orgProfileTextValue = await orgProfileText(owner.key);
  state.copyOptions = state.copyOptions || [];
  let failed = 0;
  for (let index = 1; index <= 3; index += 1) {
    try {
      let option = null;
      if (providerMock) {
        option = wf.kind === 'viral'
          ? demoViralOne(profileData, state.transcript, state.strength || 'medium', index)
          : (() => {
              const idea = state.selectedIdea || {};
              const hotspot = wf.kind === 'today' ? { title: idea.title || '', fact: `选题：${idea.title || ''}。钩子：${idea.hook || ''}` } : (state.hotspot || {});
              const demoList = demoHotspotCopies(profileData, hotspot, state.angle || '热点做引子', state.style || '口语化');
              return demoList[(index - 1) % demoList.length];
            })();
        if (index === 1 && wf.kind === 'viral' && option.blueprint) state.blueprint = option.blueprint;
      } else {
        let prompt;
        if (wf.kind === 'viral') {
          prompt = buildViralOnePrompt({ profile: profileData, orgProfile: orgProfileTextValue, sourceText: state.transcript, strength: state.strength || 'medium', index });
        } else {
          const idea = state.selectedIdea || {};
          const hotspot = wf.kind === 'today'
            ? { title: idea.title || '', fact: `选题：${idea.title || ''}。钩子：${idea.hook || ''}。适合原因：${idea.why || ''}` }
            : (state.hotspot || {});
          prompt = buildHotspotCopyPrompt({ profile: profileData, orgProfile: orgProfileTextValue, hotspot, angle: state.angle || '热点做引子', style: state.style || '口语化' });
          prompt += `\n【本次要求】这是第 ${index} 个版本。${WF_COPY_VARIATIONS[index - 1]}`;
        }
        prompt += await wfBrainBlock(owner.key, state);
        const result = await collectText(ctx, { system: WORKBENCH_SYSTEM, user: prompt });
        const parsed = mockOrEmpty(result) ? null : parseLooseJsonObject(result.text);
        if (!parsed || (!parsed.content && !parsed.title)) throw new Error('这次没有生成有效版本');
        if (index === 1 && wf.kind === 'viral' && parsed.blueprint && typeof parsed.blueprint === 'object') state.blueprint = parsed.blueprint;
        option = { title: String(parsed.title || '').slice(0, 200), content: String(parsed.content || '').trim() };
      }
      option.id = `opt${index}`;
      option.title = option.title || `版本${index}`;
      state.copyOptions = state.copyOptions.filter((item) => item.id !== option.id);
      state.copyOptions.push(option);
      state.demo = Boolean(providerMock);
      await wfUpdate(wfId, owner.key, { state: JSON.stringify(state) });
    } catch (error) {
      failed += 1;
      console.warn('[junshi workbench] 工作流版本生成失败：', error?.message || error);
    }
  }
  if (state.copyOptions.length) {
    await wfUpdate(wfId, owner.key, { stage: 'ready', state: JSON.stringify({ ...state, message: '' }) });
  } else {
    await wfUpdate(wfId, owner.key, { stage: 'rewriting', state: JSON.stringify({ ...state, message: failed ? '生成失败了，点「换一批」再试一次。' : '正在生成…' }) });
  }
}

/** 后台启动一轮文案生成（不阻塞 action 响应）。 */
function startWfCopy(ctx, owner, wfId, job = null) {
  void runWfCopy(ctx, owner, wfId)
    .catch((error) => console.warn('[junshi workbench] 生成轮失败：', error?.message || error))
    .finally(() => { if (job) jobDone(job, 'succeeded', '本轮生成结束').catch(() => {}); });
}

/* ───────────── 数字人口播（音色克隆 + 对口型）+ 截图回填 ───────────── */
function voiceOut(row) {
  return { id: row.id, name: row.name, speakerId: row.speaker_id || '', status: row.status, error: row.error || '', sampleAssetId: row.sample_asset_id || null, accountId: row.account_id || 'default', createdAt: row.created_at, updatedAt: row.updated_at };
}
function avatarRunOut(row) {
  let steps = [];
  try { steps = JSON.parse(row.steps || '[]'); } catch { /* ignore */ }
  return {
    id: row.id, voiceId: row.voice_id || null, speakerId: row.speaker_id || '',
    imageAssetId: row.image_asset_id || null, text: row.text || '', status: row.status,
    error: row.error || '', steps, videoAssetId: row.video_asset_id || null,
    videoUrl: row.video_asset_id ? `/api/junshi/workbench/assets/${encodeURIComponent(row.video_asset_id)}/file` : null,
    accountId: row.account_id || 'default', createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
async function avatarStepsUpdate(id, ownerKey, steps) {
  await aq('UPDATE junshi_workbench_avatar_runs SET steps=?, updated_at=? WHERE id=? AND owner_key=?', [JSON.stringify(steps), nowIso(), id, ownerKey]).catch(() => {});
}

/** 后台克隆音色：样本直链上传 → doubao-voice-clone → speaker_id。 */
async function runCloneVoice(owner, { voiceId, assetRow, auditionText }) {
  const fail = async (message) => {
    await aq('UPDATE junshi_workbench_voices SET status=?, error=?, updated_at=? WHERE id=? AND owner_key=?', ['failed', String(message).slice(0, 1000), nowIso(), voiceId, owner.key]).catch(() => {});
  };
  try {
    const policy = await getAiProviderPolicy();
    const config = await seedanceChannelConfig(policy?.channels);
    if (!config) throw Object.assign(new Error('数字人渠道未配置（需要 seedance.nz 渠道 Key）'), { code: 'WORKBENCH_AVATAR_NOT_CONFIGURED' });
    const sampleBuffer = await assetBytes(assetRow);
    if (sampleBuffer.length > 10 * 1024 * 1024) throw Object.assign(new Error('音色样本超过 10MB，请剪短一些（10-30 秒清晰人声即可）'), { code: 'WORKBENCH_VOICE_SAMPLE_TOO_LARGE' });
    const sampleUrl = await uploadToSeedance({ ...config, buffer: sampleBuffer, fileName: assetRow.file_name || 'voice-sample.mp3', mimeType: assetRow.mime_type || 'audio/mpeg' });
    const taskId = await submitAudioTask({ ...config, model: 'doubao-voice-clone', prompt: auditionText, metadata: { audio_url: sampleUrl, enable_audio_denoise: true } });
    const result = await pollAudioTask({ ...config, taskId, timeoutMs: 600000 });
    const speakerId = result.resultText;
    if (!speakerId) throw Object.assign(new Error('克隆完成但没有返回音色 ID'), { code: 'WORKBENCH_VOICE_NO_SPEAKER' });
    await aq('UPDATE junshi_workbench_voices SET status=?, speaker_id=?, error="", updated_at=? WHERE id=? AND owner_key=?', ['ready', String(speakerId).slice(0, 200), nowIso(), voiceId, owner.key]);
  } catch (error) {
    await fail(error?.message || '克隆失败');
  }
}

/** 后台数字人合成：底片生成（形象照 i2v）→ TTS → 人脸分析 → 对口型 → 存素材库。
 *  合同细节与上游已知故障见 services/junshiAvatar.js 文件头。 */
async function runTalkingHead(owner, { runId, text, speakerId, imageAssetRow }) {
  const steps = [
    { key: 'base', label: '生成人物底片（形象照 → 视频）', status: 'running' },
    { key: 'tts', label: '口播语音合成', status: 'pending' },
    { key: 'face', label: '人脸分析', status: 'pending' },
    { key: 'lipsync', label: '对口型合成视频', status: 'pending' },
    { key: 'save', label: '存入素材库', status: 'pending' },
  ];
  const fail = async (message) => {
    await aq('UPDATE junshi_workbench_avatar_runs SET status=?, error=?, updated_at=? WHERE id=? AND owner_key=?', ['failed', String(message).slice(0, 1000), nowIso(), runId, owner.key]).catch(() => {});
  };
  const mark = (key, status) => { const step = steps.find((s) => s.key === key); if (step) step.status = status; return avatarStepsUpdate(runId, owner.key, steps); };
  try {
    const policy = await getAiProviderPolicy();
    const config = await seedanceChannelConfig(policy?.channels);
    if (!config) throw Object.assign(new Error('数字人渠道未配置（需要 seedance.nz 渠道 Key）'), { code: 'WORKBENCH_AVATAR_NOT_CONFIGURED' });
    // ⓪ 底片：形象照 → 5 秒人物正面视频（kling 对口型吃视频不吃照片）
    const imageBuffer = await assetBytes(imageAssetRow);
    if (imageBuffer.length > 10 * 1024 * 1024) throw Object.assign(new Error('形象照超过 10MB，请压缩后重传'), { code: 'WORKBENCH_AVATAR_IMAGE_TOO_LARGE' });
    const imageUrl = await uploadToSeedance({ ...config, buffer: imageBuffer, fileName: imageAssetRow.file_name || 'face.jpg', mimeType: imageAssetRow.mime_type || 'image/jpeg' });
    const baseTask = await submitVideoTask({ ...config, model: 'seedance-2.0-standard-i2v', metadata: { images: [imageUrl] }, promptOverride: '一位教师正面面对镜头，微微点头，嘴唇自然开合像在讲话，背景不变，光线稳定' });
    const base = await pollVideoTask({ ...config, taskId: baseTask, timeoutMs: 600000 });
    if (!base.url) throw Object.assign(new Error('底片生成没有返回视频地址'), { code: 'WORKBENCH_BASE_NO_URL' });
    await mark('base', 'done'); await mark('tts', 'running');
    // ① TTS（用克隆音色）
    const ttsTask = await submitAudioTask({ ...config, model: 'doubao-seed-icl-2.0', prompt: text, metadata: { speaker: speakerId, voice_model: 'seed-tts-2.0-standard', format: 'mp3' } });
    const tts = await pollAudioTask({ ...config, taskId: ttsTask, timeoutMs: 600000 });
    if (!tts.url) throw Object.assign(new Error('语音合成没有返回音频地址'), { code: 'WORKBENCH_TTS_NO_URL' });
    await mark('tts', 'done'); await mark('face', 'running');
    // ② 人脸分析（底片签名直链；注意必须完整签名 URL，裸 COS 路径上游处理不了）
    const faceTask = await submitVideoTask({ ...config, model: 'kling-lip-sync-identify-face', metadata: { video_url: base.url } });
    const face = await pollVideoTask({ ...config, taskId: faceTask, timeoutMs: 600000 });
    const { sessionId, faceId } = parseFaceSession(face.resultText);
    await mark('face', 'done'); await mark('lipsync', 'running');
    // ③ 对口型合成（soundEndTime 用底片实际时长上限 30000ms 内；session 过期是上游已知故障）
    const syncTask = await submitVideoTask({ ...config, model: 'kling-lip-sync-video', metadata: { sessionId, faceId, audio_url: tts.url, soundStartTime: 0, soundEndTime: 30000, soundInsertTime: 0, soundVolume: 1, originalAudioVolume: 0 } });
    const synced = await pollVideoTask({ ...config, taskId: syncTask, timeoutMs: 900000 });
    if (!synced.url) throw Object.assign(new Error('对口型完成但没有返回视频地址'), { code: 'WORKBENCH_LIPSYNC_NO_URL' });
    await mark('lipsync', 'done'); await mark('save', 'running');
    // ④ 转存素材库（上游地址 24h 过期）
    const videoResponse = await fetch(synced.url, { signal: AbortSignal.timeout(300000) });
    if (!videoResponse.ok) throw Object.assign(new Error(`成片下载失败（HTTP ${videoResponse.status}）`), { status: 502 });
    const buffer = Buffer.from(await videoResponse.arrayBuffer());
    const stored = await persistSecureUpload({ fileName: `${runId}.mp4`, mimeType: 'video/mp4', buffer });
    const assetId = id('jwa');
    await aq('INSERT INTO junshi_workbench_assets (id,owner_key,org_id,account_id,file_name,storage_key,storage_backend,mime_type,kind,file_size,folder,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [assetId, owner.key, owner.orgId, 'default', stored.fileName, stored.storageKey, stored.storageBackend || 'local', stored.mimeType || 'video/mp4', 'video', stored.fileSize || buffer.length, '数字人', nowIso()]);
    await aq('UPDATE junshi_workbench_avatar_runs SET status=?, video_asset_id=?, error="", updated_at=? WHERE id=? AND owner_key=?', ['succeeded', assetId, nowIso(), runId, owner.key]);
    await mark('save', 'done');
  } catch (error) {
    await fail(error?.message || '数字人合成失败');
  }
}
function transcriptOut(row, { withSegments = false } = {}) {
  let segments = [];
  try { segments = JSON.parse(row.segments || '[]'); } catch { /* ignore */ }
  return {
    id: row.id,
    assetId: row.asset_id || null,
    source: row.source,
    title: row.title,
    sourceUrl: row.source_url || '',
    nickname: row.nickname || '',
    durationSeconds: Number(row.duration_seconds || 0),
    status: row.status,
    error: row.error || '',
    text: row.text || '',
    segments: withSegments ? segments : undefined,
    segmentCount: segments.length,
    accountId: row.account_id || 'default',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 读取素材字节：本地盘直读，OSS 走签名 URL（sign 后取回字节）。 */
async function assetBytes(row) {
  const pseudo = { storage_key: row.storage_key, metadata: JSON.stringify({ storageBackend: row.storage_backend }) };
  if (rowStorageBackend(pseudo) === 'oss') {
    const url = ossRedirectUrl(pseudo, { expires: 600 });
    if (!url) throw Object.assign(new Error('素材签名地址生成失败'), { status: 502 });
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Object.assign(new Error(`素材读取失败（HTTP ${response.status}）`), { status: 502 });
    return Buffer.from(await response.arrayBuffer());
  }
  const root = uploadRoot();
  const absolute = path.resolve(root, String(row.storage_key || ''));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw errors.notFound('素材路径不合法', 'NOT_FOUND');
  const { readFile } = await import('node:fs/promises');
  return Buffer.from(await readFile(absolute));
}

/** 后台转写一条素材：写档案行（running）→ whisper → 回填。返回档案 id。 */
async function startTranscription(owner, { assetRow, source, title, sourceUrl, nickname, accountId }) {
  const transcriptId = id('jwts');
  const at = nowIso();
  // MySQL 的 TEXT 列不能有字面量默认值：INSERT 必须显式给全 text/segments/error/duration。
  await aq('INSERT INTO junshi_workbench_transcripts (id,owner_key,org_id,account_id,asset_id,source,title,source_url,nickname,status,error,text,segments,duration_seconds,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [transcriptId, owner.key, owner.orgId, accountId, assetRow?.id || null, source, String(title || '').slice(0, 300), String(sourceUrl || '').slice(0, 1000), String(nickname || '').slice(0, 200), 'running', '', '', '[]', 0, at, at]);
  const job = jobStart(owner, '视频转写', String(title || '').slice(0, 60));
  void (async () => {
    try {
      const policy = await getAiProviderPolicy();
      const asr = await seedanceAsrConfig(policy?.channels);
      if (!asr) throw Object.assign(new Error('转写渠道未配置（需要 seedance.nz 渠道 Key 或 JUNSHI_ASR_ENDPOINT/KEY）'), { code: 'WORKBENCH_ASR_NOT_CONFIGURED' });
      const buffer = await assetBytes(assetRow);
      const result = await transcribeMedia({ endpoint: asr.endpoint, apiKey: asr.apiKey, buffer, fileName: assetRow.file_name || `${transcriptId}.mp4`, mimeType: assetRow.mime_type || 'video/mp4' });
      if (!result.text.trim()) throw Object.assign(new Error('这条内容没有识别出语音（可能是纯音乐或时长太短）'), { code: 'WORKBENCH_ASR_EMPTY' });
      await aq('UPDATE junshi_workbench_transcripts SET status=?, text=?, segments=?, duration_seconds=?, error="", updated_at=? WHERE id=?',
        ['succeeded', result.text.slice(0, 100000), JSON.stringify(result.segments.slice(0, 2000)), Number(result.duration) || 0, nowIso(), transcriptId]);
      await jobDone(job, 'succeeded', `转写完成：${result.segments.length} 段 / ${Math.round(result.duration)} 秒`);
    } catch (error) {
      await aq('UPDATE junshi_workbench_transcripts SET status=?, error=?, updated_at=? WHERE id=?',
        ['failed', String(error?.message || error).slice(0, 1000), nowIso(), transcriptId]).catch(() => {});
      await jobDone(job, 'failed', String(error?.message || error).slice(0, 1000)).catch(() => {});
    }
  })();
  return transcriptId;
}

async function workflowsRoute(ctx, rest, search, method, owner) {
  /* 列表：进行中的排最前，再带最近 10 条 */
  if (rest === '/workflows' && method === 'GET') {
    const accountIdFilter = text(search.get('accountId'));
    const rows = accountIdFilter
      ? await arows('SELECT * FROM junshi_workbench_workflows WHERE owner_key=? AND account_id=? ORDER BY created_at DESC LIMIT 30', [owner.key, accountIdFilter])
      : await arows('SELECT * FROM junshi_workbench_workflows WHERE owner_key=? ORDER BY created_at DESC LIMIT 30', [owner.key]);
    // extracting 阶段自动推进：档案转写完成 → 进入原文确认；失败 → extract_failed
    for (const row of rows) {
      if (row.status !== 'active' || row.stage !== 'extracting') continue;
      let st = {};
      try { st = JSON.parse(row.state || '{}'); } catch { /* ignore */ }
      if (!st.transcriptId) continue;
      const tsRow = await arow('SELECT status, text, title, nickname FROM junshi_workbench_transcripts WHERE id=?', [st.transcriptId]).catch(() => null);
      if (!tsRow) continue;
      if (tsRow.status === 'succeeded') {
        const nextState = { ...st, transcript: String(tsRow.text || '').slice(0, 4000), transcriptNickname: tsRow.nickname || '', message: '' };
        await wfUpdate(row.id, owner.key, { stage: 'transcript', state: JSON.stringify(nextState) });
        row.stage = 'transcript';
        row.state = JSON.stringify(nextState);
      } else if (tsRow.status === 'failed') {
        await wfUpdate(row.id, owner.key, { stage: 'extract_failed', state: JSON.stringify({ ...st, extractError: '这条内容的转写失败了（可能是纯音乐或太短），换一条试试' }) });
        row.stage = 'extract_failed';
      }
    }
    const items = rows.map(wfOut);
    items.sort((a, b) => (b.status === 'active') - (a.status === 'active'));
    const brains = await arows("SELECT id, name, kind, status FROM junshi_workbench_brains WHERE owner_key=? AND status='ready' ORDER BY created_at DESC LIMIT 20", [owner.key]).catch(() => []);
    return { items: items.slice(0, 11), styles: COPY_STYLES, angles: HOTSPOT_ANGLES, strengths: VIRAL_STRENGTHS, brains: brains.map((row) => ({ id: row.id, name: row.name, kind: row.kind })) };
  }

  /* 发起：today 先出 3 个选题；viral 先确认原文；hotspot 先选结合方式 */
  if (rest === '/workflows' && method === 'POST') {
    const kind = text(ctx.body?.kind);
    if (!WORKFLOW_KINDS[kind]) throw errors.badRequest('未知的工作流类型', 'VALIDATION_ERROR', { field: 'kind' });
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    const wfId = id('jwwf');
    const input = ctx.body?.input && typeof ctx.body.input === 'object' ? ctx.body.input : {};
    let stage; let state = {};
    const jobLabel = WORKFLOW_KINDS[kind];
    if (kind === 'today') {
      const goal = text(input.goal).slice(0, 200);
      rateLimit(owner.key);
      const job = jobStart(owner, jobLabel, goal ? `方向：${goal}` : '不限方向');
      await job.promise;
      try {
        const profile = (await readProfile(owner.key, accountId)).profile;
        const orgProfile = await orgProfileText(owner.key);
        const chunks = retrieve(goal || '今日选题', ['营销', '文案', '转化'], 4);
        const generated = await generateOptions(ctx, owner, {
          prompt: buildTodayIdeasPrompt({ profile, orgProfile, goal, chunks }),
          demoContent: demoIdeas(profile, goal),
        });
        stage = 'idea';
        state = { goal, ideaOptions: generated.options, demo: generated.demo };
        await jobDone(job, 'succeeded', `已给出 ${generated.options.length} 个选题候选`);
      } catch (error) {
        await jobDone(job, 'failed', String(error?.message || error).slice(0, 1000));
        throw error;
      }
    } else if (kind === 'viral') {
      // 五种来源对齐原版：text 现有文案 / transcript 转写档案 / link 分享链接 / upload 本地视频 / transcriptWait 提取中。
      const sourceType = text(input.sourceType) || (text(input.sourceText) ? 'text' : text(input.transcriptId) ? 'transcript' : '');
      if (sourceType === 'text') {
        const sourceText = text(input.sourceText).slice(0, 4000);
        if (!sourceText) throw errors.badRequest('请粘贴爆款原文（口播文字或文案）', 'VALIDATION_ERROR', { field: 'sourceText' });
        stage = 'transcript';
        state = { sourceType, sourceLabel: '用户粘贴的现有文案', transcript: sourceText };
      } else if (sourceType === 'transcript') {
        const tsRow = await arow('SELECT * FROM junshi_workbench_transcripts WHERE id=? AND owner_key=?', [text(input.transcriptId), owner.key]);
        if (!tsRow) throw errors.notFound('转写档案不存在', 'NOT_FOUND');
        if (tsRow.status === 'succeeded') {
          stage = 'transcript';
          state = { sourceType, sourceLabel: tsRow.title || '转写档案', transcript: String(tsRow.text || '').slice(0, 4000), transcriptId: tsRow.id, transcriptNickname: tsRow.nickname || '' };
        } else if (tsRow.status === 'running') {
          stage = 'extracting';
          state = { sourceType, sourceLabel: tsRow.title || '转写档案', transcriptId: tsRow.id, message: '正在等待这条档案的转写完成…' };
        } else {
          throw errors.badRequest('这条档案转写失败，请重新采集或换一条', 'WORKBENCH_TRANSCRIPT_NOT_READY');
        }
      } else if (sourceType === 'link') {
        const shareText = text(input.shareText).slice(0, 2000);
        if (!shareText) throw errors.badRequest('请粘贴抖音分享内容或链接', 'VALIDATION_ERROR', { field: 'shareText' });
        const target = await resolveDouyinTarget(shareText).catch((error) => { throw errors.badRequest(error.message, 'DOUYIN_RESOLVE_FAILED'); });
        if (target.kind !== 'video') throw errors.badRequest('这是主页链接；爆款复刻需要单条作品，请粘贴作品分享', 'VALIDATION_ERROR');
        douyinRateLimit(owner.key);
        stage = 'extracting';
        state = { sourceType, sourceLabel: '抖音爆款链接', message: '正在下载这条作品并提取口播文案…' };
        void (async () => {
          try {
            const video = await fetchDouyinVideo(target.id);
            if (!video.playUrl) throw new Error('这条作品取不到可下载的视频地址');
            const buffer = await downloadDouyinVideo(video.playUrl);
            const stored = await persistSecureUpload({ fileName: `${video.awemeId}.mp4`, mimeType: 'video/mp4', buffer });
            const assetId = id('jwa');
            await aq('INSERT INTO junshi_workbench_assets (id,owner_key,org_id,account_id,file_name,storage_key,storage_backend,mime_type,kind,file_size,folder,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
              [assetId, owner.key, owner.orgId, accountId, stored.fileName, stored.storageKey, stored.storageBackend || 'local', stored.mimeType || 'video/mp4', 'video', stored.fileSize || buffer.length, '抖音采集', nowIso()]);
            const assetRow = await arow('SELECT * FROM junshi_workbench_assets WHERE id=?', [assetId]);
            const transcriptId = await startTranscription(owner, { assetRow, source: 'douyin', title: video.desc || `抖音视频 ${video.awemeId}`, sourceUrl: `https://www.douyin.com/video/${video.awemeId}`, nickname: video.nickname, accountId });
            await wfUpdate(wfId, owner.key, { state: JSON.stringify({ ...state, transcriptId }) });
          } catch (error) {
            await wfUpdate(wfId, owner.key, { stage: 'extract_failed', state: JSON.stringify({ ...state, extractError: String(error?.message || error).slice(0, 400) }) }).catch(() => {});
          }
        })();
        state = { ...state };
      } else if (sourceType === 'upload') {
        const assetRow = await arow('SELECT * FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [text(input.assetId), owner.key]);
        if (!assetRow) throw errors.notFound('先上传视频素材（素材库），再作为复刻来源', 'NOT_FOUND');
        if (!/^(video|audio)\//.test(String(assetRow.mime_type || ''))) throw errors.badRequest('复刻来源需要是视频或音频素材', 'VALIDATION_ERROR');
        douyinRateLimit(owner.key);
        stage = 'extracting';
        state = { sourceType, sourceLabel: assetRow.file_name || '本地上传视频', message: '正在提取这条视频的口播文案…' };
        const transcriptId = await startTranscription(owner, { assetRow, source: 'upload', title: assetRow.file_name || '本地上传视频', sourceUrl: '', nickname: '', accountId });
        state.transcriptId = transcriptId;
      } else {
        throw errors.badRequest('请选择一种爆款来源', 'VALIDATION_ERROR', { field: 'sourceType' });
      }
    } else {
      if (text(input.mode) === 'keyword') {
        const keyword = text(input.keyword).slice(0, 120);
        if (!keyword) throw errors.badRequest('请填写搜索关键词', 'VALIDATION_ERROR', { field: 'keyword' });
        rateLimit(owner.key);
        const searchConfig = await textChannelSearchConfig();
        if (!searchConfig) throw errors.badRequest('当前文本渠道不支持自动搜索（需 DeepSeek 官方接口）。请改用「手动填写热点」。', 'WORKBENCH_SEARCH_UNSUPPORTED');
        stage = 'searching';
        state = { keyword };
      } else {
        const title = text(input.title).slice(0, 200);
        const fact = text(input.fact).slice(0, 2000);
        if (!title || !fact) throw errors.badRequest('热点需要标题和事实描述', 'VALIDATION_ERROR', { field: 'title' });
        stage = 'angle';
        state = { hotspot: { title, fact, sourceUrl: text(input.sourceUrl).slice(0, 500) } };
      }
    }
    const at = nowIso();
    await aq('INSERT INTO junshi_workbench_workflows (id,owner_key,org_id,account_id,kind,stage,input,state,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [wfId, owner.key, owner.orgId, accountId, kind, stage, JSON.stringify(input), JSON.stringify(state), 'active', '', at, at]);
    if (kind === 'hotspot' && stage === 'searching') {
      const job = jobStart(owner, '热点搜索', String(state.keyword || '').slice(0, 60));
      await job.promise;
      void runHotspotSearch(ctx, owner, { wfId, keyword: state.keyword || '', accountId })
        .finally(() => jobDone(job, 'succeeded', '热点搜索完成').catch(() => {}));
    }
    return { workflow: wfOut(await arow('SELECT * FROM junshi_workbench_workflows WHERE id=?', [wfId])) };
  }

  /* 推进 / 取消 */
  const actionMatch = rest.match(/^\/workflows\/([^/]+)\/action$/);
  if (actionMatch && method === 'POST') {
    const wfId = decodeURIComponent(actionMatch[1]);
    const row = await arow('SELECT * FROM junshi_workbench_workflows WHERE id=? AND owner_key=?', [wfId, owner.key]);
    if (!row) throw errors.notFound('工作流不存在', 'NOT_FOUND');
    if (row.status !== 'active') throw errors.conflict('这个工作流已经结束', 'WORKFLOW_NOT_ACTIVE');
    const wf = wfOut(row);
    const action = text(ctx.body?.action);
    const state = { ...wf.state };
    const profile = async () => (await readProfile(owner.key, wf.accountId)).profile;
    const orgProfile = () => orgProfileText(owner.key);

    if (action === 'cancel') {
      await wfUpdate(wfId, owner.key, { status: 'cancelled' });
      return { workflow: wfOut(await arow('SELECT * FROM junshi_workbench_workflows WHERE id=?', [wfId])) };
    }

    /* 热点·关键词模式：搜索完成后的三个阶段动作 */
    if (action === 'select_hotspot' && wf.kind === 'hotspot' && wf.stage === 'hotspots_ready') {
      const hotspot = (state.hotspots || []).find((item) => item.id === text(ctx.body?.hotspotId));
      if (!hotspot) throw errors.badRequest('热点不存在', 'VALIDATION_ERROR', { field: 'hotspotId' });
      state.selectedHotspot = hotspot;
      state.hotspot = { title: hotspot.title, fact: hotspot.fact, sourceUrl: hotspot.sourceUrl || '' };
      if (hotspot.recommendedAngle && HOTSPOT_ANGLES.some((item) => item[0] === hotspot.recommendedAngle)) state.recommendedAngle = hotspot.recommendedAngle;
      await wfUpdate(wfId, owner.key, { stage: 'angle', state: JSON.stringify(state) });
    } else if (action === 'search_retry' && wf.kind === 'hotspot' && wf.stage === 'search_failed') {
      rateLimit(owner.key);
      await wfUpdate(wfId, owner.key, { stage: 'searching', state: JSON.stringify({ keyword: state.keyword || '' }) });
      const job = jobStart(owner, '热点搜索', String(state.keyword || '').slice(0, 60));
      await job.promise;
      void runHotspotSearch(ctx, owner, { wfId, keyword: state.keyword || '', accountId: wf.accountId })
        .finally(() => jobDone(job, 'succeeded', '热点搜索完成').catch(() => {}));
      return { workflow: wfOut(await arow('SELECT * FROM junshi_workbench_workflows WHERE id=?', [wfId])) };
    } else if (action === 'search_switch_manual' && wf.kind === 'hotspot' && wf.stage === 'search_failed') {
      await wfUpdate(wfId, owner.key, { status: 'cancelled' });
      return { workflow: wfOut(await arow('SELECT * FROM junshi_workbench_workflows WHERE id=?', [wfId])), switchToManual: true };
    }

    /* 阶段一：各类选择/确认（无 LLM）。⚠️ 必须与上面的搜索分支同一条 if/else 链，
       否则匹配过搜索分支后会掉进链尾的 WORKFLOW_ACTION_INVALID（2026-10-24 踩过）。 */
    else if (action === 'select_idea' && wf.kind === 'today' && wf.stage === 'idea') {
      const option = (state.ideaOptions || []).find((item) => item.id === text(ctx.body?.optionId));
      if (!option) throw errors.badRequest('候选不存在', 'VALIDATION_ERROR', { field: 'optionId' });
      state.selectedIdea = option;
      await wfUpdate(wfId, owner.key, { stage: 'brain', state: JSON.stringify(state) });
    } else if (action === 'select_angle' && wf.kind === 'hotspot' && wf.stage === 'angle') {
      const angle = text(ctx.body?.angle);
      if (!HOTSPOT_ANGLES.some((item) => item[0] === angle)) throw errors.badRequest('未知结合方式', 'VALIDATION_ERROR', { field: 'angle' });
      state.angle = angle;
      await wfUpdate(wfId, owner.key, { stage: 'brain', state: JSON.stringify(state) });
    } else if (action === 'confirm_transcript' && wf.kind === 'viral' && wf.stage === 'transcript') {
      const transcript = text(ctx.body?.text).slice(0, 4000);
      if (!transcript) throw errors.badRequest('原文不能为空', 'VALIDATION_ERROR', { field: 'text' });
      state.transcript = transcript;
      // 对齐原版：确认后自动进入改写，不需要再选强度/风格；蓝图与 3 版本流式产出。
      await wfUpdate(wfId, owner.key, { stage: 'rewriting', state: JSON.stringify({ ...state, copyOptions: [], blueprint: null, message: '正在拆解爆款结构并结合账号资料改写 3 个版本…' }) });
      startWfCopy(ctx, owner, wfId);
    } else if (action === 'select_brain' && wf.stage === 'brain') {
      const brainId = text(ctx.body?.brainId);
      const style = text(ctx.body?.style) || '口语化';
      if (brainId) {
        const brainRow = await arow('SELECT name, profile, sections FROM junshi_workbench_brains WHERE id=? AND owner_key=? AND status=?', [brainId, owner.key, 'ready']);
        if (!brainRow) throw errors.badRequest('这个写作大脑不存在或还没蒸馏完成', 'VALIDATION_ERROR', { field: 'brainId' });
        state.brainId = brainId;
        state.brainName = brainRow.name;
        state.brainProfile = brainRow.profile;
        state.brainSections = brainRow.sections;
      } else {
        state.brainId = '';
        state.brainName = '系统基础表达';
        state.style = COPY_STYLES.includes(style) ? style : '口语化';
      }
      rateLimit(owner.key);
      const job = jobStart(owner, wf.kindLabel, `${state.brainName} · 3 个版本`);
      await wfUpdate(wfId, owner.key, { stage: 'rewriting', state: JSON.stringify({ ...state, copyOptions: [], blueprint: null, message: `正在用「${state.brainName}」写 3 个版本…` }) });
      await job.promise;
      startWfCopy(ctx, owner, wfId, job);
    } else if (action === 'select_style' && wf.stage === 'style') {
      // 兼容旧数据（style 阶段）：等价于选「系统基础表达」。
      const style = text(ctx.body?.style) || '口语化';
      state.style = COPY_STYLES.includes(style) ? style : '口语化';
      state.brainName = '系统基础表达';
      rateLimit(owner.key);
      const job = jobStart(owner, wf.kindLabel, `${state.style} · 3 个版本`);
      await wfUpdate(wfId, owner.key, { stage: 'rewriting', state: JSON.stringify({ ...state, copyOptions: [], blueprint: null, message: `正在用「${state.style}」写 3 个版本…` }) });
      await job.promise;
      startWfCopy(ctx, owner, wfId, job);
    } else if (action === 'regenerate' && (wf.stage === 'idea' || ['rewriting', 'copy', 'ready'].includes(wf.stage))) {
      rateLimit(owner.key);
      if (wf.stage === 'idea') {
        const job = jobStart(owner, wf.kindLabel, '换一批选题');
        await job.promise;
        try {
          const profileData = await profile();
          const orgProfileTextValue = await orgProfile();
          const generated = await generateOptions(ctx, owner, {
            prompt: buildTodayIdeasPrompt({ profile: profileData, orgProfile: orgProfileTextValue, goal: state.goal, chunks: retrieve(state.goal || '今日选题', ['营销', '文案'], 4) }),
            demoContent: demoIdeas(profileData, state.goal),
          });
          state.ideaOptions = generated.options;
          state.demo = generated.demo;
          await wfUpdate(wfId, owner.key, { state: JSON.stringify(state) });
          await jobDone(job, 'succeeded', '已换一批选题');
        } catch (error) {
          await jobDone(job, 'failed', String(error?.message || error).slice(0, 1000));
          throw error;
        }
      } else {
        const job = jobStart(owner, wf.kindLabel, '换一批版本');
        await job.promise;
        await wfUpdate(wfId, owner.key, { stage: 'rewriting', state: JSON.stringify({ ...state, copyOptions: [], message: '正在重新生成 3 个版本…' }) });
        startWfCopy(ctx, owner, wfId, job);
      }
    } else if (action === 'select_copy' && ['copy', 'ready'].includes(wf.stage)) {
      const option = (state.copyOptions || []).find((item) => item.id === text(ctx.body?.optionId));
      if (!option) throw errors.badRequest('候选不存在', 'VALIDATION_ERROR', { field: 'optionId' });
      const draftId = id('jwc');
      const at = nowIso();
      const topic = String(option.title || wf.input?.title || wf.kindLabel).slice(0, 200);
      // 双击改稿（原版逻辑）：edited_content 直接作为终稿，不再调模型。
      const content = String(ctx.body?.editedContent || '').trim()
        || String(option.content || '').trim()
        || `**${option.title || ''}**\n${option.hook || ''}\n${option.why || ''}`;
      await aq('INSERT INTO junshi_workbench_copy_drafts (id,owner_key,org_id,account_id,topic,style,content,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [draftId, owner.key, owner.orgId, wf.accountId, topic, state.style || state.brainName || '口语化', content, at]);
      await wfUpdate(wfId, owner.key, { status: 'done', stage: 'done', draft_id: draftId, state: JSON.stringify({ ...state, selectedCopy: { ...option, content } }) });
      return {
        workflow: wfOut(await arow('SELECT * FROM junshi_workbench_workflows WHERE id=?', [wfId])),
        draft: { id: draftId, topic, style: state.style || '口语化', content, accountId: wf.accountId, createdAt: at },
      };
    } else {
      throw errors.badRequest('当前阶段不支持这个操作', 'WORKFLOW_ACTION_INVALID');
    }
    return { workflow: wfOut(await arow('SELECT * FROM junshi_workbench_workflows WHERE id=?', [wfId])) };
  }

  /* ── 文案大脑 / 同行研究简报（蒸馏自转写档案） ── */
  if (rest === '/brains' && method === 'GET') {
    const kindFilter = text(search.get('kind'));
    const rows = kindFilter
      ? await arows('SELECT * FROM junshi_workbench_brains WHERE owner_key=? AND kind=? ORDER BY created_at DESC LIMIT 50', [owner.key, kindFilter])
      : await arows('SELECT * FROM junshi_workbench_brains WHERE owner_key=? ORDER BY created_at DESC LIMIT 50', [owner.key]);
    return {
      items: rows.map((row) => {
        let profile = {}; let sections = [];
        try { profile = JSON.parse(row.profile || '{}'); } catch { /* ignore */ }
        try { sections = JSON.parse(row.sections || '[]'); } catch { /* ignore */ }
        return {
          id: row.id, kind: row.kind, name: row.name, status: row.status, error: row.error || '',
          profile, sections, sourceNote: row.source_note || '',
          accountId: row.account_id || 'default', createdAt: row.created_at, updatedAt: row.updated_at,
        };
      }),
    };
  }
  if (rest === '/brains' && method === 'POST') {
    rateLimit(owner.key);
    const kind = text(ctx.body?.kind) === 'peer_report' ? 'peer_report' : 'copy_brain';
    const name = text(ctx.body?.name);
    if (!name) throw errors.badRequest('请填写名称', 'VALIDATION_ERROR', { field: 'name' });
    if (name.length > 100) throw errors.badRequest('名称最多 100 字', 'VALIDATION_ERROR', { field: 'name' });
    const transcriptIds = Array.isArray(ctx.body?.transcriptIds) ? ctx.body.transcriptIds.map((item) => text(item)).filter(Boolean).slice(0, 12) : [];
    if (!transcriptIds.length) throw errors.badRequest('请选择至少一条已转写的档案作为语料', 'VALIDATION_ERROR', { field: 'transcriptIds' });
    const transcripts = [];
    for (const transcriptId of transcriptIds) {
      const row = await arow('SELECT * FROM junshi_workbench_transcripts WHERE id=? AND owner_key=? AND status=?', [transcriptId, owner.key, 'succeeded']);
      if (row) transcripts.push({ title: row.title, text: row.text, segments: (() => { try { return JSON.parse(row.segments || '[]'); } catch { return []; } })() });
    }
    if (!transcripts.length) throw errors.badRequest('选中的档案都还没转写完成', 'VALIDATION_ERROR');
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    const brainId = id('jwb2');
    const at = nowIso();
    await aq('INSERT INTO junshi_workbench_brains (id,owner_key,org_id,account_id,kind,name,status,error,profile,sections,source_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [brainId, owner.key, owner.orgId, accountId, kind, name.slice(0, 100), 'running', '', '{}', '[]', `${transcripts.length} 条口播档案`, at, at]);
    const job = jobStart(owner, kind === 'peer_report' ? '研究简报' : '蒸馏大脑', `${name} · ${transcripts.length} 条语料`);
    void (async () => {
      try {
        const providerMock = await textProviderIsMock().catch(() => false);
        let payload = null;
        if (providerMock) {
          payload = kind === 'peer_report' ? demoPeerReport(name) : demoBrain(name);
        } else {
          const prompt = kind === 'peer_report'
            ? buildPeerReportPrompt({ name, transcripts })
            : buildBrainDistillPrompt({ name, transcripts });
          const result = await collectText(ctx, { system: WORKBENCH_SYSTEM, user: prompt });
          payload = mockOrEmpty(result) ? null : parseLooseJsonObject(result.text);
        }
        if (!payload || typeof payload !== 'object') throw new Error('这次没有蒸馏出有效档案，重试一次');
        const profile = payload.profile && typeof payload.profile === 'object' ? payload.profile : {};
        const sections = Array.isArray(payload.sections) ? payload.sections : Array.isArray(payload.combined_rules) ? [{ title: '综合规则', content: payload.combined_rules.join('；') }] : [];
        const extra = kind === 'copy_brain'
          ? [{ title: '创作者明确讲授的方法', content: (payload.teaching_methods || []).map((item) => `${item.title}：${item.method}${item.applicability ? `（适用：${item.applicability}）` : ''}`).join('\n') || '' },
             { title: '作品里反复出现的写作习惯', content: (payload.writing_patterns || []).map((item) => `${item.title}：${item.pattern}`).join('\n') || '' }].filter((item) => item.content)
          : [];
        await aq('UPDATE junshi_workbench_brains SET status=?, error=?, profile=?, sections=?, updated_at=? WHERE id=? AND owner_key=?',
          ['ready', '', JSON.stringify(profile), JSON.stringify([...sections, ...extra]), nowIso(), brainId, owner.key]);
        await jobDone(job, 'succeeded', '蒸馏完成');
      } catch (error) {
        await aq('UPDATE junshi_workbench_brains SET status=?, error=?, updated_at=? WHERE id=? AND owner_key=?', ['failed', String(error?.message || error).slice(0, 1000), nowIso(), brainId, owner.key]).catch(() => {});
        await jobDone(job, 'failed', String(error?.message || error).slice(0, 1000)).catch(() => {});
      }
    })();
    return { brain: { id: brainId, kind, name: name.slice(0, 100), status: 'running' } };
  }
  const brainDetailMatch = rest.match(/^\/brains\/([^/]+)$/);
  if (brainDetailMatch && method === 'GET') {
    const row = await arow('SELECT * FROM junshi_workbench_brains WHERE id=? AND owner_key=?', [decodeURIComponent(brainDetailMatch[1]), owner.key]);
    if (!row) throw errors.notFound('档案不存在', 'NOT_FOUND');
    let profile = {}; let sections = [];
    try { profile = JSON.parse(row.profile || '{}'); } catch { /* ignore */ }
    try { sections = JSON.parse(row.sections || '[]'); } catch { /* ignore */ }
    return { brain: { id: row.id, kind: row.kind, name: row.name, status: row.status, error: row.error || '', profile, sections, sourceNote: row.source_note || '', createdAt: row.created_at } };
  }
  const brainDeleteMatch = rest.match(/^\/brains\/([^/]+)$/);
  if (brainDeleteMatch && method === 'DELETE') {
    await aq('DELETE FROM junshi_workbench_brains WHERE id=? AND owner_key=?', [decodeURIComponent(brainDeleteMatch[1]), owner.key]);
    return { ok: true };
  }

  /* ── 长期记忆 / 灵感 ── */
  if (rest === '/memories' && method === 'GET') {
    const accountIdFilter = text(search.get('accountId'));
    const kindFilter = text(search.get('kind'));
    const conditions = ['owner_key=?'];
    const params = [owner.key];
    if (accountIdFilter) { conditions.push('account_id=?'); params.push(accountIdFilter); }
    if (kindFilter) { conditions.push('kind=?'); params.push(kindFilter); }
    const rows = await arows(`SELECT * FROM junshi_workbench_memories WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 100`, params);
    return {
      items: rows.map((row) => ({
        id: row.id, kind: row.kind, content: row.content, source: row.source,
        accountId: row.account_id || 'default', createdAt: row.created_at,
      })),
    };
  }
  if (rest === '/memories' && method === 'POST') {
    const content = text(ctx.body?.content);
    if (!content) throw errors.badRequest('内容不能为空', 'VALIDATION_ERROR', { field: 'content' });
    if (content.length > 2000) throw errors.badRequest('记忆最多 2000 字', 'VALIDATION_ERROR', { field: 'content' });
    const kind = text(ctx.body?.kind) === 'inspiration' ? 'inspiration' : 'memory';
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    const source = text(ctx.body?.source).slice(0, 200);
    const memoryId = id('jwm2');
    const at = nowIso();
    await aq('INSERT INTO junshi_workbench_memories (id,owner_key,org_id,account_id,kind,content,source,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [memoryId, owner.key, owner.orgId, accountId, kind, content, source, at]);
    return { memory: { id: memoryId, kind, content, source, accountId, createdAt: at } };
  }
  if (rest.startsWith('/memories/') && method === 'DELETE') {
    const memoryId = decodeURIComponent(rest.slice('/memories/'.length));
    await aq('DELETE FROM junshi_workbench_memories WHERE id=? AND owner_key=?', [memoryId, owner.key]);
    return { ok: true };
  }

  return null;
}

/* ── 真实视频渲染（走平台既有 VIDEO 渠道：提交 + 轮询 + 成本观测都在 provider 层） ── */
  if (rest === '/video/render' && method === 'POST') {
    const prompt = text(ctx.body?.prompt);
    if (!prompt) throw errors.badRequest('请填写要生成视频的画面描述或口播', 'VALIDATION_ERROR', { field: 'prompt' });
    if (prompt.length > 2000) throw errors.badRequest('描述最多 2000 字', 'VALIDATION_ERROR', { field: 'prompt' });
    const durationSeconds = clampInt(ctx.body?.durationSeconds, 0, 0, 600);
    const aspectRatio = text(ctx.body?.aspectRatio).slice(0, 16);
    const resolution = text(ctx.body?.resolution).slice(0, 16);
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    let projectId = text(ctx.body?.projectId);
    let projectTitle = '';
    if (projectId) {
      const project = await arow('SELECT id, title FROM junshi_workbench_video_projects WHERE id=? AND owner_key=?', [projectId, owner.key]);
      if (!project) throw errors.notFound('视频项目不存在', 'NOT_FOUND');
      projectTitle = project.title || '';
    } else {
      projectId = null;
    }
    renderRateLimit(owner.key);
    // 渠道预检放在进任务之前：mock / 没配好 / 不支持视频，当场说清楚，别让机构等一个必失败的任务。
    const policy = await getAiProviderPolicy();
    const selection = providerSelectionForModality(policy, 'VIDEO');
    const info = generationProviderInfo(selection);
    if (isMockProvider(info.provider) || info.mode === 'mock') {
      throw errors.badRequest('当前 AI 渠道是本地模拟，还没接入真实的视频生成服务。请联系平台管理员在后台把「视频」渠道换成真实供应商。', 'WORKBENCH_VIDEO_CHANNEL_NOT_CONFIGURED');
    }
    if (!info.configured || !info.adapterAvailable || !(info.capabilities || []).includes('VIDEO')) {
      throw errors.badRequest('视频生成渠道未配置完整或不支持视频，请联系平台管理员检查后台的 AI 渠道设置。', 'WORKBENCH_VIDEO_CHANNEL_NOT_CONFIGURED');
    }
    const title = (text(ctx.body?.title) || projectTitle || prompt).slice(0, 120);
    const renderId = id('jwrd');
    const at = nowIso();
    const job = jobStart(owner, '视频渲染', title);
    await aq('INSERT INTO junshi_workbench_video_renders (id,owner_key,org_id,project_id,account_id,job_id,title,prompt,duration_seconds,aspect_ratio,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [renderId, owner.key, owner.orgId, projectId, accountId, job.id, title, prompt, durationSeconds, aspectRatio, 'running', '', at, at]);
    // 视频生成要几分钟：提交后在进程内异步跑，HTTP 立刻返回任务号，前端轮询 /video/renders。
    // 服务重启会丢掉进程内任务，由 reapStale 在 45 分钟后兜底标失败。
    void (async () => {
      try {
        const studentOptions = { aspectRatio: aspectRatio || '9:16', resolution, audio: true };
        if (durationSeconds > 0) studentOptions.durationSeconds = durationSeconds;
        const options = await generationOptionsFor({
          context: null, modality: 'VIDEO', policy, selection, box: {}, studentOptions,
        });
        const provider = getGenerationProvider(selection);
        const generated = await provider.generate({
          modality: 'VIDEO', prompt, title, options,
          userId: owner.auth.user.id,
          computeContext: { orgId: owner.orgId, userId: owner.auth.user.id, jobId: job.id },
        });
        const assetPayload = (Array.isArray(generated?.assets) ? generated.assets : [])[0] || null;
        const upstreamUrl = String(assetPayload?.assetUrl || '').trim();
        if (!upstreamUrl) throw Object.assign(new Error('生成服务没有返回视频'), { code: 'GENERATION_EMPTY_RESULT' });
        // 上游地址是临时的（过一阵就 403，见 generatedAssetArchive 的教训）：把字节转存进工作台素材库。
        // 平台上传白名单只有 mp4/webm；mov 或转存失败时任务仍算成功，把上游地址放进说明让人工尽快下载。
        let stored = null;
        let note = '';
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 180000);
          timer.unref?.();
          const response = await fetch(upstreamUrl, { signal: controller.signal }).finally(() => clearTimeout(timer));
          if (!response?.ok) throw new Error(`下载产物失败（HTTP ${response?.status || 0}）`);
          const buffer = Buffer.from(await response.arrayBuffer());
          if (!buffer.length || buffer.length > 64 * 1024 * 1024) throw new Error('产物为空或超过 64MB');
          const mime = String(assetPayload.mimeType || response.headers?.get?.('content-type') || 'video/mp4').toLowerCase().split(';', 1)[0].trim();
          if (mime !== 'video/mp4' && mime !== 'video/webm') throw new Error(`上游产物类型是 ${mime}，不在素材白名单（mp4/webm）`);
          stored = await persistSecureUpload({ fileName: `${renderId}.${mime === 'video/webm' ? 'webm' : 'mp4'}`, mimeType: mime, buffer });
        } catch (archiveError) {
          note = `视频已生成，但转存素材库失败（${String(archiveError?.message || archiveError).slice(0, 120)}）。请尽快手动下载上游临时地址（会过期）：${upstreamUrl.slice(0, 300)}`;
        }
        let assetId = null;
        if (stored) {
          assetId = id('jwa');
          await aq('INSERT INTO junshi_workbench_assets (id,owner_key,org_id,account_id,file_name,storage_key,storage_backend,mime_type,kind,file_size,folder,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [assetId, owner.key, owner.orgId, accountId, stored.fileName, stored.storageKey, stored.storageBackend || 'local', stored.mimeType || 'video/mp4', 'video', stored.fileSize || 0, 'AI 生成', nowIso()]);
        }
        const costFen = generated?.compute?.upstreamCostFen;
        const costText = Number.isFinite(costFen) ? `，上游成本约 ${(costFen / 100).toFixed(2)} 元` : '';
        await aq("UPDATE junshi_workbench_video_renders SET status='succeeded', asset_id=?, error='', updated_at=? WHERE id=?", [assetId, nowIso(), renderId]);
        await jobDone(job, 'succeeded', stored ? `视频已生成并存入素材库（文件夹：AI 生成）${costText}` : note);
      } catch (error) {
        const message = error instanceof ApiError ? error.message : normalizeProviderError(error).message;
        await aq("UPDATE junshi_workbench_video_renders SET status='failed', error=?, updated_at=? WHERE id=?", [String(message).slice(0, 1000), nowIso(), renderId]).catch(() => {});
        await jobDone(job, 'failed', String(message).slice(0, 1000)).catch(() => {});
      }
    })();
    return { render: renderOut(await arow('SELECT * FROM junshi_workbench_video_renders WHERE id=?', [renderId])) };
  }
  if (rest === '/video/renders' && method === 'GET') {
    await reapStale(owner.key);
    const projectId = text(search.get('projectId'));
    const rows = projectId
      ? await arows('SELECT * FROM junshi_workbench_video_renders WHERE owner_key=? AND project_id=? ORDER BY created_at DESC LIMIT 50', [owner.key, projectId])
      : await arows('SELECT * FROM junshi_workbench_video_renders WHERE owner_key=? ORDER BY created_at DESC LIMIT 50', [owner.key]);
    return { items: rows.map(renderOut) };
  }

  /* ── 素材 ── */
  if (rest === '/assets' && method === 'GET') {
    const accountIdFilter = text(search.get('accountId'));
    const folderFilter = text(search.get('folder'));
    const conditions = ['owner_key=?'];
    const params = [owner.key];
    if (accountIdFilter) { conditions.push('account_id=?'); params.push(accountIdFilter); }
    if (folderFilter) { conditions.push('folder=?'); params.push(folderFilter); }
    const rows = await arows(`SELECT * FROM junshi_workbench_assets WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
    const folders = await arows('SELECT folder, COUNT(*) AS n FROM junshi_workbench_assets WHERE owner_key=? GROUP BY folder ORDER BY folder', [owner.key]);
    return { items: rows.map(assetOut), folders: folders.map((row) => ({ folder: row.folder || '', count: Number(row.n || 0) })) };
  }
  if (rest === '/assets' && method === 'POST') {
    const contentType = String(ctx.req.headers['content-type'] || '');
    let multipart;
    try { multipart = parseMultipartFormData(ctx.rawBody || Buffer.alloc(0), contentType); }
    catch (error) { throw error; }
    const file = multipart.file;
    if (!file?.buffer?.length) throw errors.badRequest('请选择要上传的文件', 'VALIDATION_ERROR', { field: 'file' });
    if (file.buffer.length > maxUploadBytes()) throw errors.badRequest('文件过大', 'FILE_TOO_LARGE');
    const accountId = await resolveAccountId(owner.key, multipart.fields?.accountId);
    const folder = text(multipart.fields?.folder).slice(0, 120);
    const stored = await persistSecureUpload(file);
    const kind = String(stored.mimeType || '').startsWith('image/') ? 'image'
      : String(stored.mimeType || '').startsWith('video/') ? 'video'
        : String(stored.mimeType || '').startsWith('audio/') ? 'audio' : 'file';
    const assetId = id('jwa');
    const at = nowIso();
    try {
      await aq('INSERT INTO junshi_workbench_assets (id,owner_key,org_id,account_id,file_name,storage_key,storage_backend,mime_type,kind,file_size,folder,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [assetId, owner.key, owner.orgId, accountId, stored.fileName, stored.storageKey, stored.storageBackend || 'local', stored.mimeType || '', kind, stored.fileSize || file.buffer.length, folder, at]);
    } catch (error) {
      if (stored.storagePath) await rm(stored.storagePath, { force: true }).catch(() => {});
      else await removeObject({ storage_key: stored.storageKey, metadata: JSON.stringify({ storageBackend: stored.storageBackend }) }).catch(() => {});
      throw error;
    }
    return {
      asset: assetOut({
        id: assetId, file_name: stored.fileName, mime_type: stored.mimeType, kind,
        file_size: stored.fileSize || file.buffer.length, folder, account_id: accountId, created_at: at,
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
  const assetMoveMatch = rest.match(/^\/assets\/([^/]+)$/);
  if (assetMoveMatch && method === 'PUT') {
    const assetId = decodeURIComponent(assetMoveMatch[1]);
    const row = await arow('SELECT * FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [assetId, owner.key]);
    if (!row) throw errors.notFound('素材不存在', 'NOT_FOUND');
    const folder = text(ctx.body?.folder).slice(0, 120);
    await aq('UPDATE junshi_workbench_assets SET folder=? WHERE id=? AND owner_key=?', [folder, assetId, owner.key]);
    return { asset: assetOut(await arow('SELECT * FROM junshi_workbench_assets WHERE id=?', [assetId])) };
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
    await reapStale(owner.key);
    const rows = await arows('SELECT * FROM junshi_workbench_jobs WHERE owner_key=? ORDER BY created_at DESC LIMIT 100', [owner.key]);
    return {
      items: rows.map((row) => ({
        id: row.id, kind: row.kind, status: row.status, detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at,
      })),
    };
  }

  /* ── 抖音采集（公开数据走 F2 隔离进程；自有账号登录在后续版本） ── */
  if (rest === '/douyin/resolve' && method === 'POST') {
    douyinRateLimit(owner.key);
    const target = await resolveDouyinTarget(ctx.body?.text).catch((error) => { throw errors.badRequest(error.message, 'DOUYIN_RESOLVE_FAILED'); });
    return { target };
  }
  if (rest === '/douyin/profile' && method === 'POST') {
    douyinRateLimit(owner.key);
    const secUserId = text(ctx.body?.secUserId);
    if (!secUserId) throw errors.badRequest('缺少主页 ID', 'VALIDATION_ERROR', { field: 'secUserId' });
    const cursor = clampInt(ctx.body?.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const profile = await fetchDouyinProfile(secUserId, cursor).catch((error) => { throw errors.badRequest(error.message, 'DOUYIN_FETCH_FAILED'); });
    return { profile };
  }
  if (rest === '/douyin/video' && method === 'POST') {
    douyinRateLimit(owner.key);
    const awemeId = text(ctx.body?.awemeId);
    if (!/^\d{6,25}$/.test(awemeId)) throw errors.badRequest('作品 ID 无效', 'VALIDATION_ERROR', { field: 'awemeId' });
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    const video = await fetchDouyinVideo(awemeId).catch((error) => { throw errors.badRequest(error.message, 'DOUYIN_FETCH_FAILED'); });
    if (!video.playUrl) throw errors.badRequest('这条作品取不到可下载的视频地址（可能已删除）', 'DOUYIN_NO_PLAY_URL');
    const buffer = await downloadDouyinVideo(video.playUrl).catch((error) => { throw errors.badRequest(error.message, 'DOUYIN_DOWNLOAD_FAILED'); });
    const stored = await persistSecureUpload({ fileName: `${video.awemeId}.mp4`, mimeType: 'video/mp4', buffer });
    const assetId = id('jwa');
    try {
      await aq('INSERT INTO junshi_workbench_assets (id,owner_key,org_id,account_id,file_name,storage_key,storage_backend,mime_type,kind,file_size,folder,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [assetId, owner.key, owner.orgId, accountId, stored.fileName, stored.storageKey, stored.storageBackend || 'local', stored.mimeType || 'video/mp4', 'video', stored.fileSize || buffer.length, '抖音采集', nowIso()]);
    } catch (error) {
      if (stored.storagePath) await rm(stored.storagePath, { force: true }).catch(() => {});
      else await removeObject({ storage_key: stored.storageKey, metadata: JSON.stringify({ storageBackend: stored.storageBackend }) }).catch(() => {});
      throw error;
    }
    const assetRow = await arow('SELECT * FROM junshi_workbench_assets WHERE id=?', [assetId]);
    const transcriptId = await startTranscription(owner, {
      assetRow, source: 'douyin',
      title: video.desc || `抖音视频 ${video.awemeId}`,
      sourceUrl: `https://www.douyin.com/video/${video.awemeId}`,
      nickname: video.nickname, accountId,
    });
    return {
      video,
      asset: assetOut(assetRow),
      transcriptId,
    };
  }

  /* ── 转写档案 ── */
  if (rest === '/transcripts' && method === 'GET') {
    const accountIdFilter = text(search.get('accountId'));
    const rows = accountIdFilter
      ? await arows('SELECT * FROM junshi_workbench_transcripts WHERE owner_key=? AND account_id=? ORDER BY created_at DESC LIMIT 50', [owner.key, accountIdFilter])
      : await arows('SELECT * FROM junshi_workbench_transcripts WHERE owner_key=? ORDER BY created_at DESC LIMIT 50', [owner.key]);
    return { items: rows.map((row) => transcriptOut(row)) };
  }
  const transcriptDetailMatch = rest.match(/^\/transcripts\/([^/]+)$/);
  if (transcriptDetailMatch && method === 'GET') {
    const row = await arow('SELECT * FROM junshi_workbench_transcripts WHERE id=? AND owner_key=?', [decodeURIComponent(transcriptDetailMatch[1]), owner.key]);
    if (!row) throw errors.notFound('档案不存在', 'NOT_FOUND');
    return { transcript: transcriptOut(row, { withSegments: true }) };
  }
  const transcribeMatch = rest.match(/^\/assets\/([^/]+)\/transcribe$/);
  if (transcribeMatch && method === 'POST') {
    const assetId = decodeURIComponent(transcribeMatch[1]);
    const assetRow = await arow('SELECT * FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [assetId, owner.key]);
    if (!assetRow) throw errors.notFound('素材不存在', 'NOT_FOUND');
    if (!/^(video|audio)\//.test(String(assetRow.mime_type || ''))) throw errors.badRequest('只能转写视频或音频素材', 'VALIDATION_ERROR');
    douyinRateLimit(owner.key);
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    const transcriptId = await startTranscription(owner, {
      assetRow, source: 'upload',
      title: text(ctx.body?.title) || assetRow.file_name || '素材转写',
      sourceUrl: '', nickname: '', accountId,
    });
    return { transcriptId };
  }

  /* ── 数字人口播 ── */
  if (rest === '/voices' && method === 'GET') {
    const rows = await arows('SELECT * FROM junshi_workbench_voices WHERE owner_key=? ORDER BY created_at DESC LIMIT 50', [owner.key]);
    return { items: rows.map(voiceOut) };
  }
  if (rest === '/voices' && method === 'POST') {
    renderRateLimit(owner.key);
    const assetId = text(ctx.body?.assetId);
    const assetRow = await arow('SELECT * FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [assetId, owner.key]);
    if (!assetRow) throw errors.notFound('音色样本素材不存在', 'NOT_FOUND');
    if (!/^audio\//.test(String(assetRow.mime_type || ''))) throw errors.badRequest('音色样本需要是音频素材（先上传到素材库）', 'VALIDATION_ERROR');
    const name = text(ctx.body?.name) || assetRow.file_name || '我的音色';
    const auditionText = (text(ctx.body?.auditionText) || '大家好，欢迎关注我们的账号。').slice(0, 300);
    const policy = await getAiProviderPolicy();
    const config = await seedanceChannelConfig(policy?.channels);
    if (!config) throw errors.badRequest('数字人渠道未配置（需要 seedance.nz 渠道 Key）', 'WORKBENCH_AVATAR_NOT_CONFIGURED');
    const voiceId = id('jwv2');
    const at = nowIso();
    await aq('INSERT INTO junshi_workbench_voices (id,owner_key,org_id,account_id,name,speaker_id,status,error,sample_asset_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [voiceId, owner.key, owner.orgId, await resolveAccountId(owner.key, ctx.body?.accountId), name.slice(0, 60), '', 'training', '', assetId, at, at]);
    void runCloneVoice(owner, { voiceId, assetRow, auditionText });
    return { voice: voiceOut(await arow('SELECT * FROM junshi_workbench_voices WHERE id=?', [voiceId])) };
  }
  if (rest.startsWith('/voices/') && method === 'DELETE') {
    const voiceId = decodeURIComponent(rest.slice('/voices/'.length));
    await aq('DELETE FROM junshi_workbench_voices WHERE id=? AND owner_key=?', [voiceId, owner.key]);
    return { ok: true };
  }
  if (rest === '/avatar/runs' && method === 'GET') {
    const accountIdFilter = text(search.get('accountId'));
    const rows = accountIdFilter
      ? await arows('SELECT * FROM junshi_workbench_avatar_runs WHERE owner_key=? AND account_id=? ORDER BY created_at DESC LIMIT 20', [owner.key, accountIdFilter])
      : await arows('SELECT * FROM junshi_workbench_avatar_runs WHERE owner_key=? ORDER BY created_at DESC LIMIT 20', [owner.key]);
    return { items: rows.map(avatarRunOut) };
  }
  if (rest === '/avatar/run' && method === 'POST') {
    renderRateLimit(owner.key);
    const speech = text(ctx.body?.text);
    if (!speech) throw errors.badRequest('请填写口播文案', 'VALIDATION_ERROR', { field: 'text' });
    if (speech.length > 3000) throw errors.badRequest('口播文案最多 3000 字', 'VALIDATION_ERROR', { field: 'text' });
    const voiceId = text(ctx.body?.voiceId);
    const voiceRow = await arow('SELECT * FROM junshi_workbench_voices WHERE id=? AND owner_key=?', [voiceId, owner.key]);
    if (!voiceRow) throw errors.notFound('音色不存在', 'NOT_FOUND');
    if (voiceRow.status !== 'ready' || !voiceRow.speaker_id) throw errors.badRequest('这个音色还没克隆完成（或克隆失败）', 'WORKBENCH_VOICE_NOT_READY');
    const imageAssetId = text(ctx.body?.imageAssetId);
    const imageAssetRow = await arow('SELECT * FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [imageAssetId, owner.key]);
    if (!imageAssetRow) throw errors.notFound('形象照素材不存在', 'NOT_FOUND');
    if (!/^image\//.test(String(imageAssetRow.mime_type || ''))) throw errors.badRequest('形象照需要是图片素材（人脸清晰、正面）', 'VALIDATION_ERROR');
    const policy = await getAiProviderPolicy();
    const config = await seedanceChannelConfig(policy?.channels);
    if (!config) throw errors.badRequest('数字人渠道未配置（需要 seedance.nz 渠道 Key）', 'WORKBENCH_AVATAR_NOT_CONFIGURED');
    const accountId = await resolveAccountId(owner.key, ctx.body?.accountId);
    const runId = id('jwav');
    const at = nowIso();
    await aq('INSERT INTO junshi_workbench_avatar_runs (id,owner_key,org_id,account_id,voice_id,speaker_id,image_asset_id,text,status,error,steps,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [runId, owner.key, owner.orgId, accountId, voiceId, voiceRow.speaker_id, imageAssetId, speech, 'running', '', '[]', at, at]);
    const job = jobStart(owner, '数字人口播', speech.slice(0, 60));
    void runTalkingHead(owner, { runId, text: speech, speakerId: voiceRow.speaker_id, imageAssetRow })
      .finally(() => jobDone(job, 'succeeded', '数字人口播完成').catch(() => {}));
    return { run: avatarRunOut(await arow('SELECT * FROM junshi_workbench_avatar_runs WHERE id=?', [runId])) };
  }

  /* ── 文案发布数据回填（截图 → 多模态识别） ── */
  const statsMatch = rest.match(/^\/copy\/([^/]+)\/stats$/);
  if (statsMatch && method === 'POST') {
    const draftId = decodeURIComponent(statsMatch[1]);
    const draft = await arow('SELECT * FROM junshi_workbench_copy_drafts WHERE id=? AND owner_key=?', [draftId, owner.key]);
    if (!draft) throw errors.notFound('文案不存在', 'NOT_FOUND');
    const assetId = text(ctx.body?.assetId);
    const assetRow = await arow('SELECT * FROM junshi_workbench_assets WHERE id=? AND owner_key=?', [assetId, owner.key]);
    if (!assetRow) throw errors.notFound('截图素材不存在（请先上传到素材库）', 'NOT_FOUND');
    if (!/^image\//.test(String(assetRow.mime_type || ''))) throw errors.badRequest('请上传图片截图', 'VALIDATION_ERROR');
    rateLimit(owner.key);
    const buffer = await assetBytes(assetRow);
    if (buffer.length > 8 * 1024 * 1024) throw errors.badRequest('截图超过 8MB，请压缩后重传', 'VALIDATION_ERROR');
    const dataUrl = `data:${assetRow.mime_type};base64,${buffer.toString('base64')}`;
    const messages = [{ role: 'user', content: [
      { type: 'text', text: '这是一张抖音作者端的作品数据截图。只依据图中可见的数字提取：{"plays":播放,"likes":点赞,"comments":评论,"shares":分享,"saves":收藏,"publishedAt":"发布时间原文","note":"一句备注"}。数字看不清或没有的字段填 null。只输出这个 JSON，不要其他文字。' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] }];
    let stats = null;
    try {
      const result = await collectText(ctx, { system: WORKBENCH_SYSTEM, messages });
      const parsed = parseLooseJsonObject(result.text);
      if (parsed) stats = parsed;
    } catch (error) { /* 落到下面的失败分支 */ }
    if (!stats) throw errors.badRequest('没能从截图里识别出数据；换一张更清晰的作者端数据截图试试', 'WORKBENCH_STATS_UNRECOGNIZED');
    const cleaned = {};
    for (const key of ['plays', 'likes', 'comments', 'shares', 'saves']) {
      const value = Number(stats[key]);
      cleaned[key] = Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
    }
    cleaned.publishedAt = String(stats.publishedAt || '').slice(0, 60);
    cleaned.note = String(stats.note || '').slice(0, 200);
    cleaned.backfilledAt = nowIso();
    await aq('UPDATE junshi_workbench_copy_drafts SET stats=?, created_at=created_at WHERE id=? AND owner_key=?', [JSON.stringify(cleaned), draftId, owner.key]);
    return { stats: cleaned };
  }

  /* ── 设置状态（只读：渠道与依赖一览，Key 仍在平台后台管理） ── */
  if (rest === '/settings-status' && method === 'GET') {
    const policy = await getAiProviderPolicy();
    const textInfo = generationProviderInfo(providerSelectionForModality(policy, 'TEXT'));
    const videoInfo = generationProviderInfo(providerSelectionForModality(policy, 'VIDEO'));
    const asr = await seedanceAsrConfig(policy?.channels).catch(() => null);
    const douyinPythonPath = douyinPython();
    const douyinReady = await new Promise((resolve) => {
      fs.access(douyinPythonPath, (error) => resolve(!error));
    }).catch(() => false);
    const brainCount = Number((await arow('SELECT COUNT(*) AS n FROM junshi_workbench_brains WHERE owner_key=? AND status=?', [owner.key, 'ready']).catch(() => ({ n: 0 })))?.n || 0);
    return {
      text: { provider: textInfo.provider, model: textSelectionModel(textInfo, policy), mode: textInfo.mode, configured: textInfo.configured },
      video: { provider: videoInfo.provider, model: videoInfo.model, mode: videoInfo.mode, configured: videoInfo.configured },
      asr: Boolean(asr),
      douyinWorker: Boolean(douyinReady),
      brains: brainCount,
      keysManagedIn: '平台管理后台（AI 渠道设置）',
    };
  }

  /* ── 引导式创作工作流 + 长期记忆（今日选题/爆款复刻/热点结合/记忆） ── */
  const workflowResult = await workflowsRoute(ctx, rest, search, method, owner);
  if (workflowResult) return workflowResult;

  return null;
}

function textSelectionModel(textInfo, policy) {
  const channel = (policy?.channels || []).find((item) => item.id === policy?.modalityChannels?.TEXT) || (policy?.channels || [])[0] || null;
  return channel?.model || textInfo.model || '';
}
