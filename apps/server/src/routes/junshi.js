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
import { arow, aq, errors, id, nowIso, requireAuth, requireRole } from '../lib.js';

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

  return null;
}

export const JUNSHI_PROFILE_ROLES = PROFILE_ROLES;
