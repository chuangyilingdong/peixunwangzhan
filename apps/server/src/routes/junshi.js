/**
 * 招生军师（官网 `/junshi/` 这个入口）的数据与接口层。
 *
 * 这一层只做两件事：
 *   1. **参考数据**（素材库 / 异议库 / 钩子玩法 / 全年日历 / 激励与 SOP / 合规词表）
 *      —— 只读，来自 `apps/server/data/junshi/*.json`，随发布一起进 release。
 *   2. **机构自己的数据**（机构画像）—— 按 org 读写，落 `junshi_profiles` 表。
 *
 * ⚠️ 为什么参考数据用 JSON 文件而不是建表：它是**随代码版本走的只读语料**
 *    （由资料库离线加工产出），跟着 git 走才有可复现性；建表就得有迁移和种子数据，
 *    而它一年也变不了几次。约 1.7MB，进程启动后懒加载一次常驻内存 —— 别在请求里重复读盘。
 *
 * ⚠️ 全部走**异步**数据层（aq/arow/arows）：生产是 MySQL，同步的 q/row 在那边是
 *    `syncUnavailable` 占位（调用即抛），见 packages/database/src/store.js 顶部。
 *
 * ⚠️⚠️ 画像表 `junshi_profiles`：SQLite 侧由 packages/database/src/schema.js 自动建，
 *    **生产(RDS/MySQL) 必须手工执行 `deploy/production/migrate/27-junshi-profiles-mysql.sql`**。
 *    漏了这一步的现象很容易漏诊：页面能打开、下面所有参考数据接口都 200，**只有 PUT /profile 会 500**。
 *
 * ⚠️ 这个入口按用户口径「暂时先不对外展示」（`/junshi/index.html` 里有 noindex），
 *    所以参考数据接口**没加鉴权**；机构画像接口必须登录，且只能读写自己机构的数据。
 *    以后要正式对外时，先把下面这些 get 接口的 requireAuth 打开再挂导航。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arow, arows, aq, corsHeaders, errors, id, nowIso, requireAuth, requireRole } from '../lib.js';
import { EXPERTS, runChat } from '../services/junshiChat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/junshi');
const PREFIX = '/api/junshi';

// 能改机构画像的角色（与机构后台一致：管理员 + 老师；平台超管也放行，便于排障）
const PROFILE_ROLES = ['ORG_ADMIN', 'TEACHER', 'SUPER_ADMIN'];

let cached = null;
function load() {
  if (cached) return cached;
  const read = (file) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  cached = {
    library: read('library.json'),
    knowledge: read('knowledge.json'),
    compliance: read('compliance.json'),
  };
  return cached;
}

const text = (v) => String(v ?? '').trim();
const clampInt = (v, def, min, max) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/** 把一条文档索引压成一行可搜文本（只在打分时用，不回传）。 */
function haystackOf(item) {
  return [item.t, item.cat, item.path, item.kind, (item.nodes || []).join(' '), (item.scenes || []).join(' '), item.digest]
    .join(' ').toLowerCase();
}

/**
 * 素材库检索。
 * 打分刻意做得简单可解释：标题命中权重最高，其次是分类/路径/标签，最后是摘要正文。
 * 命中词按空格切分做 AND —— 「中秋 物料」要同时出现，不然搜出来全是噪声。
 */
function searchLibrary(items, query, limit, offset) {
  const q = text(query).toLowerCase();
  if (!q) return { total: items.length, rows: items.slice(offset, offset + limit) };
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const item of items) {
    const title = item.t.toLowerCase();
    const meta = [item.cat, item.path, item.kind, (item.nodes || []).join(' '), (item.scenes || []).join(' ')].join(' ').toLowerCase();
    const digest = (item.digest || '').toLowerCase();
    let score = 0;
    let miss = false;
    for (const term of terms) {
      let hit = 0;
      if (title.includes(term)) hit += 10;
      if (meta.includes(term)) hit += 5;
      if (digest.includes(term)) hit += 2;
      if (!hit) { miss = true; break; }
      score += hit;
    }
    if (miss) continue;
    scored.push([score, item]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return { total: scored.length, rows: scored.slice(offset, offset + limit).map((x) => x[1]) };
}

function facetsOf(items) {
  const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  const cat = new Map(); const kind = new Map(); const node = new Map(); const scene = new Map();
  for (const it of items) {
    bump(cat, it.cat); bump(kind, it.kind);
    for (const n of it.nodes || []) bump(node, n);
    for (const s of it.scenes || []) bump(scene, s);
  }
  const toList = (map) => [...map.entries()].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);
  return { cat: toList(cat), kind: toList(kind), node: toList(node), scene: toList(scene) };
}

/** 机构画像。没有就返回一份空模板（前端据此算完成度）。 */
const EMPTY_PROFILE = { org: {}, product: {}, teacher: {}, biz: {}, reach: {}, cases: {}, risk: {} };

async function readProfile(ownerKey) {
  const row = await arow('SELECT content, updated_at FROM junshi_profiles WHERE owner_key=?', [ownerKey]);
  if (!row) return { profile: EMPTY_PROFILE, updatedAt: null };
  let profile = EMPTY_PROFILE;
  try { profile = { ...EMPTY_PROFILE, ...JSON.parse(row.content || '{}') }; } catch { /* 存坏了就当空模板，别让页面打不开 */ }
  return { profile, updatedAt: row.updated_at || null };
}

/** 画像完成度：按「填了的字段数 / 该分组字段数」算，前端显示用。 */
function completeness(profile) {
  const groups = {
    org: ['name', 'shortName', 'foundedYear', 'city', 'campuses'],
    product: ['categories', 'classTypes', 'unitPrice', 'mainPackage', 'discountFloor'],
    teacher: ['headcount', 'education', 'seniority', 'star'],
    biz: ['students', 'perCampus', 'fullRate', 'renewRate'],
    reach: ['wecomQr', 'officialAccount', 'douyin', 'phone', 'addressScript'],
    cases: ['caseStudy', 'praise', 'achievements'],
    risk: ['forbiddenWords', 'noPromise', 'prepayRule'],
  };
  let filled = 0; let total = 0;
  const missing = [];
  for (const [key, fields] of Object.entries(groups)) {
    const bag = profile[key] || {};
    let groupFilled = 0;
    for (const f of fields) {
      total += 1;
      if (text(bag[f])) { filled += 1; groupFilled += 1; }
    }
    if (groupFilled < fields.length) missing.push(key);
  }
  return { percent: total ? Math.round((filled / total) * 100) : 0, filled, total, missing };
}

function ownerKeyOf(ctx) {
  const auth = requireAuth(ctx);
  const orgId = auth.user.orgId;
  // 机构用户按机构存（同机构的人共享一份画像）；平台侧没有机构的账号按用户存，便于自己试。
  return orgId ? `org:${orgId}` : `user:${auth.user.id}`;
}

/* ───────────── 会话归属（含匿名）─────────────
 * 机构画像必须登录才能写（那是机构资产）；**会话不要求登录** —— 没登录的人也让他
 * 刷新不丢、能翻历史，登录后再自动并到机构名下。所以这里比 ownerKeyOf 宽一档：
 *   登录 → org:<机构id> / user:<用户id>（跨设备、同机构共享）
 *   匿名 → anon:<cookie 里的随机 id>（只在这台浏览器有效）
 */
const ANON_COOKIE = 'junshi_anon';

function readCookie(ctx, name) {
  const part = String(ctx.req?.headers?.cookie || '').split(/;\s*/).find((x) => x.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

/** 返回 { key, cookie }；cookie 非空时**调用方必须把它写进响应头**（JSON 走 ctx.setCookie，
 *  SSE 要在 writeHead 里自己带上 —— 流式响应不经过 index.js 的信封）。 */
function resolveOwner(ctx) {
  if (ctx.auth) {
    const orgId = ctx.auth.user.orgId;
    return { key: orgId ? `org:${orgId}` : `user:${ctx.auth.user.id}`, cookie: null };
  }
  let anon = readCookie(ctx, ANON_COOKIE);
  let cookie = null;
  if (!anon || !/^[A-Za-z0-9_-]{8,64}$/.test(anon)) {
    anon = id('a').replace(/[^A-Za-z0-9_-]/g, '');
    // 一年有效；与平台其它 cookie 同款属性（生产带 Secure）
    cookie = `${ANON_COOKIE}=${anon}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
      + (process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' ? '; Secure' : '');
  }
  return { key: `anon:${anon}`, cookie };
}

/** 会话消息数：**每次都重新数**，不做 ±1 累加。
 *  为什么：累加一旦有一处漏了（比如重生成删消息时那条 SQL 报错）就永久漂移，而列表上会一直显示错。
 *  重新数的代价是每条消息多一次 COUNT，可以忽略。
 *  ⚠️ 这里也踩过一个 SQLite→MySQL 的坑：别写 `MAX(message_count-1, 0)` ——
 *     SQLite 的 max(a,b) 是标量函数，MySQL 的 MAX() 只有聚合形式，这句在 RDS 上是语法错误（实测 500）。 */
async function recountConversation(convId, at) {
  const n = await arow('SELECT COUNT(*) AS n FROM junshi_messages WHERE conversation_id=?', [convId]);
  await aq('UPDATE junshi_conversations SET message_count=?, updated_at=? WHERE id=?', [n?.n || 0, at, convId]);
}

/* ───────────── 对话相关的辅助 ───────────── */

/**
 * 对话限流。
 *
 * 用户口径（2026-10-15）：「肯定是可以一直聊的」—— 原来那个「未登录 20 次/小时」
 * 正常聊几轮就撞墙，而且提示会**打断正在进行的对话**，这不能要。
 *
 * 改成两条口径：
 *   · 登录用户（机构）：**不按小时限**，只留一条当日兜底（防脚本跑飞），额度按机构算。
 *   · 匿名：放宽到 60 次/小时（够正常试；要无止境聊就登录，这也是机构级的自然动线）。
 * 命中时的文案说明「怎么解除」，而不是一句「请稍后再试」。
 *
 * ⚠️ 内存计数，多进程部署时每进程各算一份 —— 那时候要换共享存储。现在单进程够用。
 */
const CHAT_WINDOW_MS = 60 * 60 * 1000;
const CHAT_DAY_MS = 24 * 60 * 60 * 1000;
const chatHits = new Map();
function chatRateLimit(ctx, ownerKey) {
  const signedIn = Boolean(ctx.auth);
  const now = Date.now();
  const windowMs = signedIn ? CHAT_DAY_MS : CHAT_WINDOW_MS;
  const limit = signedIn ? 500 : 60;
  const who = signedIn ? ownerKey : `ip:${String(ctx.req?.headers?.['x-forwarded-for'] || ctx.req?.socket?.remoteAddress || 'unknown').split(',')[0].trim()}`;
  const hits = (chatHits.get(who) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    throw errors.badRequest(
      signedIn
        ? '今天这个机构已经问满 500 轮了，明天再来（或联系平台调额度）'
        : '未登录每小时最多问 60 轮，登录后基本不受限（机构账号还能跨设备看历史）',
      'CHAT_RATE_LIMITED');
  }
  hits.push(now);
  chatHits.set(who, hits);
  if (chatHits.size > 5000) {
    for (const [k, v] of chatHits) if (!v.some((t) => now - t < windowMs)) chatHits.delete(k);
  }
}

/** 会话历史：取最近 N 条，并**丢掉夹在中间的「问了没答」**（同前端 apiMessages 的判据）。 */
function usableHistory(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') { out.push(m); continue; }
    const next = messages[i + 1];
    if (next && next.role === 'assistant') out.push(m);   // 中间没答完的丢掉，别让模型看到两条连续 user
  }
  return out;
}

// SSE 头：`x-accel-buffering: no` 是必须的 —— 没有它 nginx 会把整个流缓冲住，
// 表现是「模型早就答完了，页面一直转圈，最后一次性全出现」。照 routes/vibecoding.js 的写法。
// extraCookie：流式响应不经过 index.js 的 JSON 信封，ctx.setCookie 在这里没人替我们发，
// 所以新发的匿名 cookie 必须自己塞进 writeHead。
function sseOpen(ctx, extraCookie) {
  const headers = corsHeaders(ctx.req, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (extraCookie) headers['set-cookie'] = extraCookie;
  ctx.res.writeHead(200, headers);
}
function sseSend(ctx, event, payload) {
  if (ctx.res.writableEnded || ctx.res.destroyed) return;
  ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function handleJunshi(ctx) {
  const pathname = String(ctx.pathname || '');
  if (!pathname.startsWith(PREFIX)) return null;
  const rest = pathname.slice(PREFIX.length) || '/';
  const search = ctx.search;
  const method = ctx.method;
  const { library, knowledge, compliance } = load();

  // ── GET /api/junshi/overview ── 作战台首屏：当前月份、日历、画像完成度、数据规模
  if (rest === '/overview' && method === 'GET') {
    const now = new Date();
    // 平台面向国内机构，月份按 Asia/Shanghai 算（服务器时区是 UTC，直接 getMonth 会差一天）
    const month = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric' }).format(now));
    let profile = EMPTY_PROFILE; let updatedAt = null;
    if (ctx.auth) {
      const found = await readProfile(ownerKeyOf(ctx));
      profile = found.profile; updatedAt = found.updatedAt;
    }
    return {
      month,
      today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now),
      calendar: knowledge.calendar,
      profile,
      profileUpdatedAt: updatedAt,
      completion: completeness(profile),
      stats: {
        library: library.count,
        objections: knowledge.objections.length,
        hooks: knowledge.hooks.length,
        complianceWords: compliance.words.length,
        scannedDocs: compliance.scanned,
        scannedChars: compliance.chars,
      },
    };
  }

  // ── GET /api/junshi/library ── 素材库检索
  if (rest === '/library' && method === 'GET') {
    const limit = clampInt(search.get('limit'), 30, 1, 100);
    const offset = clampInt(search.get('offset'), 0, 0, 100000);
    const cat = text(search.get('cat'));
    const kind = text(search.get('kind'));
    const node = text(search.get('node'));
    const scene = text(search.get('scene'));
    let items = library.items;
    if (cat) items = items.filter((x) => x.cat === cat);
    if (kind) items = items.filter((x) => x.kind === kind);
    if (node) items = items.filter((x) => (x.nodes || []).includes(node));
    if (scene) items = items.filter((x) => (x.scenes || []).includes(scene));
    const { total, rows } = searchLibrary(items, search.get('q'), limit, offset);
    return { total, limit, offset, items: rows };
  }

  // ── GET /api/junshi/library/facets ── 筛选维度计数（受当前 cat 之外的筛选影响小，直接全量给）
  if (rest === '/library/facets' && method === 'GET') {
    return facetsOf(library.items);
  }

  // ── GET /api/junshi/objections ── 异议库
  if (rest === '/objections' && method === 'GET') {
    const limit = clampInt(search.get('limit'), 20, 1, 60);
    const offset = clampInt(search.get('offset'), 0, 0, 100000);
    const cat = text(search.get('cat'));
    const tag = text(search.get('tag'));
    const q = text(search.get('q')).toLowerCase();
    let items = knowledge.objections;
    if (cat) items = items.filter((x) => x.cat === cat);
    if (tag) items = items.filter((x) => (x.tags || []).includes(tag));
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      items = items.filter((x) => terms.every((t) => (x.q + x.a).toLowerCase().includes(t)));
    }
    return {
      total: items.length,
      limit,
      offset,
      items: items.slice(offset, offset + limit),
      cats: [...new Set(knowledge.objections.map((x) => x.cat))],
      tags: [...new Set(knowledge.objections.flatMap((x) => x.tags || []))],
    };
  }

  // ── GET /api/junshi/copies ── 朋友圈文案库（原文里带 XX 占位符，前端按机构画像替换）
  if (rest === '/copies' && method === 'GET') {
    const limit = clampInt(search.get('limit'), 12, 1, 60);
    const offset = clampInt(search.get('offset'), 0, 0, 100000);
    const kind = text(search.get('kind'));
    const q = text(search.get('q')).toLowerCase();
    let items = knowledge.copies || [];
    if (kind) items = items.filter((x) => x.kind === kind);
    if (q) items = items.filter((x) => x.c.toLowerCase().includes(q));
    return {
      total: items.length,
      limit,
      offset,
      items: items.slice(offset, offset + limit),
      kinds: [...new Set((knowledge.copies || []).map((x) => x.kind))],
    };
  }

  // ── GET /api/junshi/playbook ── 钩子玩法 + 全年日历 + 激励 + SOP（一次给全，量很小）
  if (rest === '/playbook' && method === 'GET') {
    return {
      hooks: knowledge.hooks,
      calendar: knowledge.calendar,
      incentives: knowledge.incentives,
      sops: knowledge.sops,
    };
  }

  // ── POST /api/junshi/compliance ── 合规体检：给一段文案，返回命中项与改法
  if (rest === '/compliance' && method === 'POST') {
    const content = text(ctx.body?.content);
    if (!content) throw errors.badRequest('请提供要检查的文本', 'VALIDATION_ERROR', { field: 'content' });
    if (content.length > 20000) throw errors.badRequest('单次最多检查 20000 字', 'VALIDATION_ERROR', { field: 'content' });
    const lower = content.toLowerCase();
    const hits = [];
    for (const w of compliance.words) {
      const word = w.word;
      let from = 0; let n = 0; const positions = [];
      for (;;) {
        const at = content.indexOf(word, from);
        if (at < 0) break;
        n += 1; positions.push(at); from = at + word.length;
        if (positions.length >= 50) break;
      }
      if (n) hits.push({ ...w, hits: n, positions: positions.slice(0, 10) });
    }
    hits.sort((a, b) => b.hits - a.hits);
    // 极限词之外，再给三条"这类玩法要人工确认"的提示（资料里大量出现的高风险玩法）
    const risky = [];
    if (/股权|终身班|存课|膨胀金|众筹|消费券/.test(content)) risky.push('涉及长期预收（股权/终身班/存课/膨胀金/众筹/消费券），先核当地预收费监管口径');
    if (/抽奖|砸金蛋|红包墙|彩票|大转盘/.test(content)) risky.push('涉及有奖销售，需确认资质与最高奖金额上限');
    if (/原价\s*\d+\s*[^\d]{0,10}(现价|到手|只要)\s*0/.test(content)) risky.push('价格对比表述（原价 X 现价 0）存在价格欺诈风险');
    return {
      length: content.length,
      total: hits.reduce((s, h) => s + h.hits, 0),
      hits,
      risky,
      pass: hits.length === 0 && risky.length === 0,
    };
  }

  // ── GET /api/junshi/compliance/words ── 词表本身（合规哨兵页展示用）
  if (rest === '/compliance/words' && method === 'GET') {
    return { words: compliance.words, scanned: compliance.scanned, chars: compliance.chars };
  }

  // ── GET /api/junshi/profile ── 机构画像读取（未登录给空模板，不报错）
  if (rest === '/profile' && method === 'GET') {
    if (!ctx.auth) return { profile: EMPTY_PROFILE, updatedAt: null, completion: completeness(EMPTY_PROFILE), guest: true };
    const found = await readProfile(ownerKeyOf(ctx));
    return { ...found, completion: completeness(found.profile), guest: false };
  }

  // ── PUT /api/junshi/profile ── 机构画像保存
  if (rest === '/profile' && method === 'PUT') {
    const auth = requireRole(ctx, PROFILE_ROLES);
    const incoming = ctx.body?.profile;
    if (!incoming || typeof incoming !== 'object') throw errors.badRequest('缺少 profile', 'VALIDATION_ERROR', { field: 'profile' });
    const ownerKey = auth.user.orgId ? `org:${auth.user.orgId}` : `user:${auth.user.id}`;
    // 只认已知分组，且每组只留字符串值 —— 别把前端塞进来的任意结构原样落库
    const clean = {};
    for (const group of Object.keys(EMPTY_PROFILE)) {
      const bag = incoming[group];
      if (!bag || typeof bag !== 'object') continue;
      const out = {};
      for (const [k, v] of Object.entries(bag)) {
        if (typeof k !== 'string' || k.length > 40) continue;
        if (v === null || v === undefined) continue;
        const s = String(v);
        if (s.length > 2000) throw errors.badRequest(`字段 ${k} 超长`, 'VALIDATION_ERROR', { field: k });
        out[k] = s;
      }
      clean[group] = out;
    }
    const now = nowIso();
    const existing = await arow('SELECT owner_key FROM junshi_profiles WHERE owner_key=?', [ownerKey]);
    if (existing) {
      await aq('UPDATE junshi_profiles SET content=?, updated_at=? WHERE owner_key=?', [JSON.stringify(clean), now, ownerKey]);
    } else {
      await aq('INSERT INTO junshi_profiles (owner_key, org_id, content, created_at, updated_at) VALUES (?,?,?,?,?)',
        [ownerKey, auth.user.orgId || null, JSON.stringify(clean), now, now]);
    }
    return { profile: { ...EMPTY_PROFILE, ...clean }, updatedAt: now, completion: completeness({ ...EMPTY_PROFILE, ...clean }), guest: false };
  }

  // ── 会话 CRUD（机构级：登录按机构/用户存，匿名按 cookie 存）──
  // GET /api/junshi/conversations?expertId=  列表（不含消息体）
  if (rest === '/conversations' && method === 'GET') {
    const owner = resolveOwner(ctx);
    if (owner.cookie) ctx.setCookie = owner.cookie;
    const expertId = text(search.get('expertId'));
    const rows2 = expertId
      ? await arows('SELECT id, expert_id, title, message_count, updated_at FROM junshi_conversations WHERE owner_key=? AND expert_id=? ORDER BY updated_at DESC LIMIT 50', [owner.key, expertId])
      : await arows('SELECT id, expert_id, title, message_count, updated_at FROM junshi_conversations WHERE owner_key=? ORDER BY updated_at DESC LIMIT 50', [owner.key]);
    return { conversations: rows2.map((r) => ({ id: r.id, expertId: r.expert_id, title: r.title, messageCount: r.message_count, updatedAt: r.updated_at })) };
  }

  // POST /api/junshi/conversations  新建空会话
  if (rest === '/conversations' && method === 'POST') {
    const owner = resolveOwner(ctx);
    if (owner.cookie) ctx.setCookie = owner.cookie;
    const expertId = text(ctx.body?.expertId) || 'marketing';
    if (!EXPERTS.some((e) => e.id === expertId)) throw errors.badRequest('未知的专家', 'VALIDATION_ERROR', { field: 'expertId' });
    const now = nowIso();
    const convId = id('jc');
    await aq('INSERT INTO junshi_conversations (id, owner_key, org_id, expert_id, title, message_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [convId, owner.key, ctx.auth?.user?.orgId || null, expertId, '', 0, now, now]);
    return { id: convId, expertId, title: '', messageCount: 0, updatedAt: now };
  }

  // /api/junshi/conversations/:id  —— GET 取详情（含消息） / DELETE 删除
  if (rest.startsWith('/conversations/')) {
    const convId = decodeURIComponent(rest.slice('/conversations/'.length));
    const owner = resolveOwner(ctx);
    if (owner.cookie) ctx.setCookie = owner.cookie;
    const conv = await arow('SELECT * FROM junshi_conversations WHERE id=? AND owner_key=?', [convId, owner.key]);
    if (!conv) throw errors.notFound('会话不存在', 'NOT_FOUND');
    if (method === 'GET') {
      const msgs = await arows('SELECT role, content, citations, created_at FROM junshi_messages WHERE conversation_id=? ORDER BY created_at, id', [convId]);
      return {
        conversation: { id: conv.id, expertId: conv.expert_id, title: conv.title, messageCount: conv.message_count, updatedAt: conv.updated_at },
        messages: msgs.map((m) => {
          let citations = null;
          try { citations = m.citations ? JSON.parse(m.citations) : null; } catch { /* 存坏了就当没有 */ }
          return { role: m.role, content: m.content, citations };
        }),
      };
    }
    if (method === 'DELETE') {
      await aq('DELETE FROM junshi_messages WHERE conversation_id=?', [convId]);
      await aq('DELETE FROM junshi_conversations WHERE id=? AND owner_key=?', [convId, owner.key]);
      return { ok: true };
    }
  }

  // ── GET /api/junshi/experts ── 专家花名册（前端左侧列表用；提示词留在服务端不返回）
  if (rest === '/experts' && method === 'GET') {
    return {
      experts: EXPERTS.map(({ id: eid, name, tag, avatar, intro, greeting, starters }) => ({ id: eid, name, tag, avatar, intro, greeting, starters })),
    };
  }

  // ── POST /api/junshi/chat ── 跟专家对话（SSE 流式，服务端落库）
  // 入参：{ conversationId?, expertId, content } —— 只传这一句，历史由服务端按会话读。
  // 事件：start（会话 id 与标题）→ status → citations → delta* → thinking → done / error
  //
  // ⚠️ 为什么从「前端传整个 messages 数组」改成「只传一句 + conversationId」：
  //    机构级要的是服务端权威 —— 同机构同事接上下文、换设备能看到、以后才有用量统计。
  //    前端那份 localStorage 退化成「渲染缓存」，不再是事实来源。
  if (rest === '/chat' && method === 'POST') {
    const owner = resolveOwner(ctx);
    const expertId = String(ctx.body?.expertId || 'marketing');
    const content = String(ctx.body?.content || '').trim();
    // 「重新生成」：不插入新的用户消息，而是把会话里**最后一条助手消息删掉**再重跑一遍。
    // ⚠️ 不能走「把上一句再发一遍」那条路 —— 那样会在历史里留下两条一样的用户消息。
    const regenerate = ctx.body?.regenerate === true;
    if (!content) throw errors.badRequest('没有可回答的问题', 'VALIDATION_ERROR', { field: 'content' });
    if (content.length > 4000) throw errors.badRequest('单条消息最多 4000 字', 'VALIDATION_ERROR', { field: 'content' });
    chatRateLimit(ctx, owner.key);

    // 取会话：给了 id 就用（并校验归属），没给就现建一个（标题取首句）
    let conv = null;
    const convIdIn = String(ctx.body?.conversationId || '').trim();
    if (convIdIn) {
      conv = await arow('SELECT * FROM junshi_conversations WHERE id=? AND owner_key=?', [convIdIn, owner.key]);
      if (!conv) throw errors.notFound('会话不存在', 'NOT_FOUND');
    } else {
      const now0 = nowIso();
      const newId = id('jc');
      const title = content.slice(0, 30) + (content.length > 30 ? '…' : '');
      await aq('INSERT INTO junshi_conversations (id, owner_key, org_id, expert_id, title, message_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [newId, owner.key, ctx.auth?.user?.orgId || null, expertId, title, 0, now0, now0]);
      conv = { id: newId, expert_id: expertId, title, message_count: 0 };
    }

    // 历史：取最近 24 条（约 12 轮），夹在中间的「问了没答」丢掉
    const stored = await arows('SELECT id, role, content FROM junshi_messages WHERE conversation_id=? ORDER BY created_at, id', [conv.id]);
    if (regenerate) {
      // 把最后一条助手消息删掉（如果有），它就是要被重写的那条
      for (let i = stored.length - 1; i >= 0; i--) {
        if (stored[i].role === 'assistant') {
          await aq('DELETE FROM junshi_messages WHERE id=?', [stored[i].id]);
          await recountConversation(conv.id, nowIso());
          stored.splice(i, 1);
          break;
        }
        if (stored[i].role === 'user') break;     // 先碰到用户消息＝本来就没答完，不用删
      }
    }
    const history = usableHistory(stored.map((m) => ({ role: m.role, content: m.content }))).slice(-24);

    // 先把这一问落库（哪怕后面生成失败，问题也留得住）。重新生成时不重复插。
    if (!regenerate) {
      const userMsgId = id('jm');
      const qAt = nowIso();
      await aq('INSERT INTO junshi_messages (id, conversation_id, role, content, citations, created_at) VALUES (?,?,?,?,?,?)',
        [userMsgId, conv.id, 'user', content, null, qAt]);
      await recountConversation(conv.id, qAt);
    }

    sseOpen(ctx, owner.cookie);
    const controller = new AbortController();
    ctx.req.on('close', () => controller.abort());
    // 推理型模型（deepseek-flash）会先思考几十秒，期间一个 data 事件都没有 ——
    // 定期写 SSE 注释行（`: ping`）保活，否则 nginx 按 proxy_read_timeout 掐断连接。
    const heartbeat = setInterval(() => {
      if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.write(': ping\n\n');
    }, 15000);
    heartbeat.unref?.();
    let answer = '';
    let cites = null;
    try {
      sseSend(ctx, 'start', { conversationId: conv.id, expertId, title: conv.title });
      // 空回答自动重试一次。
      // ⚠️ 为什么会有空回答：deepseek-flash 是**推理型**模型，思考 token 算在输出预算里；
      //    而这条 TEXT 渠道的请求模板里没有 max_tokens（内置默认模板只有 model + messages），
      //    于是思考一大就把正文预算吃光 —— content 为空、finish_reason=length。
      //    2026-10-15 实测 6 次真回答里空了 2 次（约 30%），这个比率不能上线。
      //    不去改共享渠道配置（画布的 VibeCoding 也走这条 TEXT 渠道），在自己这层补一次。
      for (let attempt = 0; ; attempt++) {
        answer = '';
        cites = null;
        const callMessages = regenerate
          ? (attempt ? [...history, { role: 'user', content: '（上一条没有产出正文，这次请直接给出答案，不要再展开推理。）' }] : history)
          : [...history, { role: 'user', content }];
        const out = await runChat(ctx, {
          expertId: conv.expert_id || expertId,
          messages: callMessages,
          signal: controller.signal,
          onStatus: (t) => sseSend(ctx, 'status', { text: t }),
          onCitations: (c) => { cites = c; sseSend(ctx, 'citations', c); },
          onDelta: (t) => { answer += t || ''; sseSend(ctx, 'delta', { text: t }); },
          onReasoning: () => sseSend(ctx, 'thinking', {}),
        });
        if (out.citations && !cites) cites = out.citations;
        if (answer.trim() || attempt >= 1 || controller.signal.aborted) {
          sseSend(ctx, 'done', { conversationId: conv.id, model: out.model, provider: out.provider, citations: cites, usage: out.usage });
          break;
        }
        sseSend(ctx, 'status', { text: '这次没生成出正文，重试一次…' });
        sseSend(ctx, 'reset', {});          // 让前端清空气泡，别把两次的正文接在一起
      }
      if (answer.trim()) {
        const aAt = nowIso();
        await aq('INSERT INTO junshi_messages (id, conversation_id, role, content, citations, created_at) VALUES (?,?,?,?,?,?)',
          [id('jm'), conv.id, 'assistant', answer, cites ? JSON.stringify(cites) : null, aAt]);
        await recountConversation(conv.id, aAt);
      }
    } catch (error) {
      const aborted = ctx.req.destroyed || controller.signal.aborted;
      // 中止时把已经生成的部分存下来 —— 用户按了停止，那些字也是他要的
      if (answer.trim()) {
        try {
          const aAt = nowIso();
          await aq('INSERT INTO junshi_messages (id, conversation_id, role, content, citations, created_at) VALUES (?,?,?,?,?,?)',
            [id('jm'), conv.id, 'assistant', answer, cites ? JSON.stringify(cites) : null, aAt]);
          await recountConversation(conv.id, aAt);
        } catch { /* 落库失败不能让流断在这儿 */ }
      }
      if (!aborted) {
        console.warn('[junshi chat] 生成失败：', error?.message || error);
        sseSend(ctx, 'error', { message: error?.message || '生成失败，请重试' });
      } else {
        sseSend(ctx, 'stopped', { conversationId: conv.id, partial: answer.length });
      }
    } finally {
      clearInterval(heartbeat);
      if (!ctx.res.writableEnded) ctx.res.end();
    }
    // 响应已经自己写完，告诉 index.js 不要再套 JSON 信封（见 dispatch 里的 __streamed 分支）
    return { __streamed: true };
  }

  return null;
}

export const JUNSHI_PROFILE_ROLES = PROFILE_ROLES;
