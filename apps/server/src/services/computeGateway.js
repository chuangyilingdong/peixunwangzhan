// 算力网关（new-api）客户端：平台用它配置渠道、给机构/学生分发令牌、读用量日志。
//
// 设计取舍（见 docs/项目重梳理-03-平台侧重做梳理.md 第 7 节）：
//   · 我们**不改** new-api 的代码（AGPL：改了就要开源那部分），只通过它的管理接口读写；
//   · 渠道与密钥在 new-api 那一侧维护，我们这边只保存「网关地址 + 管理员账号」，
//     管理员密码复用既有的加密密钥文件（providerSecret.js，AES-256-GCM）；
//   · 令牌名就是归集维度：约定 `机构:<orgId>` / `学生:<studentId>` / `课时:<lessonId>`，
//     用量日志按令牌名解析即可还原「哪个机构/哪个学生/哪节课花了多少」，不需要动它一行代码。
import { errors, id } from '../lib.js';
import { getProviderApiKey, setProviderApiKey } from './providerSecret.js';
import { row, rows, q, nowIso, parseJson, json } from '../lib.js';

const ADMIN_SECRET_KEY = 'compute-gateway-admin';

/**
 * 走网关的模态白名单：只放**同步 OpenAI 兼容**的两类（对话 / 图片）。
 * 音乐与视频在我们的上游是「自定义路径 + 提交后轮询」的异步任务，new-api 要用它的任务插件才能接
 * （写了插件就受 AGPL 约束，见梳理文档 7.2.1）→ 这两类继续走我们自己的出口，只把用量记进我们自己的表。
 * 换句话说：**网关拦的是对话与图片的额度**，视频/音乐目前不受令牌额度约束（这是已知缺口，别当成已完成）。
 */
const GATEWAY_MODALITIES = new Set(['TEXT', 'IMAGE']);

/** 路由解析结果的进程内短缓存：省掉每次生成都登录网关 + 列一遍令牌。令牌 key 不变，缓存是安全的。 */
const ROUTE_CACHE_TTL_MS = 60000;
const routeCache = new Map();
/** 正在自动发令牌的名字：并发的第一次调用不该发两张同名令牌。 */
const provisioning = new Set();

export function getComputeGatewayConfig() {
  const value = parseJson(row('SELECT compute_gateway FROM platform_settings WHERE id=1')?.compute_gateway, {});
  return {
    baseUrl: String(value.baseUrl || '').replace(/\/+$/, ''),
    username: String(value.username || 'root'),
    enabled: value.enabled === true,
    // 只回显「配没配密码」，不回显密码本身
    passwordConfigured: Boolean(getProviderApiKey(ADMIN_SECRET_KEY)),
    quotaPerUnit: Number(value.quotaPerUnit || 500000),
    updatedAt: value.updatedAt || null,
  };
}

export function saveComputeGatewayConfig(patch, { password } = {}) {
  const current = parseJson(row('SELECT compute_gateway FROM platform_settings WHERE id=1')?.compute_gateway, {});
  const next = {
    baseUrl: patch.baseUrl === undefined ? String(current.baseUrl || '') : String(patch.baseUrl || '').trim().replace(/\/+$/, ''),
    username: patch.username === undefined ? String(current.username || 'root') : String(patch.username || '').trim() || 'root',
    enabled: patch.enabled === undefined ? current.enabled === true : patch.enabled === true,
    quotaPerUnit: patch.quotaPerUnit === undefined ? Number(current.quotaPerUnit || 500000) : Number(patch.quotaPerUnit || 500000),
    updatedAt: nowIso(),
  };
  if (next.baseUrl && !/^https?:\/\//.test(next.baseUrl)) throw errors.badRequest('网关地址必须带 http(s)://', 'INVALID_GATEWAY_URL');
  if (password !== undefined && password !== null && String(password) !== '') setProviderApiKey(String(password), ADMIN_SECRET_KEY);
  q('UPDATE platform_settings SET compute_gateway=? WHERE id=1', [json(next)]);
  return getComputeGatewayConfig();
}

/** 登录拿 JWT（new-api 的管理接口要 Bearer）。不缓存：管理员改密码后立刻生效，代价是一次登录请求。 */
async function gatewayToken() {
  const config = getComputeGatewayConfig();
  if (!config.enabled) throw errors.forbidden('算力网关未启用', 'COMPUTE_GATEWAY_DISABLED');
  if (!config.baseUrl) throw errors.badRequest('还没有配置算力网关地址', 'COMPUTE_GATEWAY_NOT_CONFIGURED');
  const password = getProviderApiKey(ADMIN_SECRET_KEY);
  if (!password) throw errors.badRequest('还没有配置算力网关管理员密码', 'COMPUTE_GATEWAY_NO_PASSWORD');
  let response;
  try {
    response = await fetch(config.baseUrl + '/api/user/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: config.username, password }),
    });
  } catch (error) {
    throw errors.badRequest('连不上算力网关：' + String(error?.message || error), 'COMPUTE_GATEWAY_UNREACHABLE');
  }
  const payload = await response.json().catch(() => ({}));
  const token = payload?.data?.access_token;
  if (!response.ok || !token) throw errors.badRequest('算力网关登录失败：' + String(payload?.message || response.status), 'COMPUTE_GATEWAY_LOGIN_FAILED');
  return { baseUrl: config.baseUrl, token };
}

async function gatewayRequest(path, { method = 'GET', body } = {}) {
  const { baseUrl, token } = await gatewayToken();
  const response = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw errors.badRequest('算力网关返回错误：' + String(payload?.message || response.status), 'COMPUTE_GATEWAY_ERROR');
  }
  return payload?.data ?? payload;
}

export async function testComputeGateway() {
  const started = Date.now();
  const self = await gatewayRequest('/api/user/self');
  return { ok: true, gatewayUser: self?.username || self?.display_name || null, latencyMs: Date.now() - started, baseUrl: getComputeGatewayConfig().baseUrl };
}

/**
 * 分页读网关的列表接口。
 *
 * ⚠️ 这里有一处**静默失败**要防：网关若不认 `p` 参数（或分页失效），会反复返回同一页，
 * 我们的循环就会把同一批数据重复累加（实测把 9.2 元算成 184 元），而且**不报错**。
 * 所以按「本页首条记录的标识是否与上一页相同」提前停止 —— 宁可少读，不可重复计数。
 */
async function pagedItems(pathname, { pageSize = 100, maxPages = 20 } = {}) {
  // 有 id 用 id；老网关/假网关可能不带 id，退化成「整条记录的 JSON」当标识。
  const signatureOf = (item) => {
    if (item === null || item === undefined) return '';
    const id = item.id;
    if (id !== undefined && id !== null && String(id) !== '') return `id:${String(id)}`;
    try { return `json:${JSON.stringify(item)}`; } catch { return ''; }
  };
  const out = [];
  const seen = new Set();
  let previousFirst = '';
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await gatewayRequest(`${pathname}${pathname.includes('?') ? '&' : '?'}p=${page}&page_size=${pageSize}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) break;
    const first = signatureOf(items[0]);
    if (first && first === previousFirst) break; // 同一页被重复返回：停，绝不重复累加
    previousFirst = first;
    let fresh = 0;
    for (const item of items) {
      const key = signatureOf(item);
      if (key) { if (seen.has(key)) continue; seen.add(key); }
      out.push(item); fresh += 1;
    }
    if (!fresh) break; // 整页都是重复的
    if (items.length < pageSize) break; // 最后一页
  }
  return out;
}

export async function listGatewayChannels() {
  const items = await pagedItems('/api/channel/');
  return items.map((item) => ({
    id: item.id, name: item.name, type: item.type, baseUrl: item.base_url || null, models: item.models || '',
    status: Number(item.status || 0), group: item.group || null,
  }));
}

export async function listGatewayTokens() {
  const items = await pagedItems('/api/token/');
  return items.map((item) => ({
    id: item.id, name: item.name, status: Number(item.status || 0),
    remainQuota: Number(item.remain_quota || 0), usedQuota: Number(item.used_quota || 0),
    unlimited: item.unlimited_quota === true, models: item.model_limits || '',
  }));
}

/**
 * 按名字找令牌，**连 key 一起**取回（key 是调用上游时要带的凭证，只在发请求时用，
 * 不进列表接口的返回 —— 平台端界面上不该能看到别人的 key）。
 */
async function findGatewayTokenByName(name) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  const items = await pagedItems('/api/token/');
  const item = items.find((entry) => String(entry?.name || '').trim() === wanted) || null;
  if (!item) return null;
  return {
    id: item.id, name: item.name, key: String(item.key || '').trim(),
    remainQuota: Number(item.remain_quota || 0), usedQuota: Number(item.used_quota || 0),
    unlimited: item.unlimited_quota === true, status: Number(item.status || 0),
  };
}

/**
 * 分发令牌：额度按「分」换算成网关的 quota（QuotaPerUnit 默认 500000 = 1 元）。
 * 名字里带上机构/学生/课时的标识，方便用量日志归集。
 */
export async function createGatewayToken({ name, budgetFen, models = '', unlimited = false, quotaPerUnit = 500000 }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw errors.badRequest('令牌名称必填（约定：机构:<id>/学生:<id>/课时:<id>）', 'GATEWAY_TOKEN_NAME_REQUIRED');
  const remainQuota = unlimited ? 0 : Math.max(1, Math.round((Number(budgetFen || 0) / 100) * quotaPerUnit));
  await gatewayRequest('/api/token/', {
    method: 'POST',
    body: { name: cleanName, remain_quota: remainQuota, unlimited_quota: unlimited, expired_time: -1, model_limits_enabled: Boolean(models), model_limits: String(models || ''), group: 'default', allow_ips: '' },
  });
  const created = await findGatewayTokenByName(cleanName);
  return { token: created ? { id: created.id, name: created.name, remainQuota: created.remainQuota, unlimited: created.unlimited } : null, budgetFen: Number(budgetFen || 0), unlimited };
}

/** 读网关的用量日志（分页拉，最多 maxRows 条，够看一个周期即可） */
export async function listGatewayLogs({ days = 7, maxRows = 2000 } = {}) {
  const since = Math.floor((Date.now() - Number(days) * 24 * 60 * 60 * 1000) / 1000);
  const items = await pagedItems(`/api/log/?type=0&start_timestamp=${since}`, { maxPages: Math.max(1, Math.ceil(maxRows / 100)) });
  return items.slice(0, maxRows);
}

/**
 * 按令牌名归集消耗。
 *
 * 令牌名约定成**多段**：`机构:<id>/学生:<id>/课时:<id>`（能带几段就带几段），
 * 用量日志按名字逐段解析 —— 「哪个机构/哪个学员/哪节课花了多少」不需要改网关一行代码就能还原。
 * 一段都没有的令牌进 `unattributed`（写清楚是「未归属」，绝不混进任何一个维度，
 * 否则报表会莫名其妙多出钱）。单段的老名字（`学生:<id>`）继续能用。
 */
const TOKEN_SEGMENT_PATTERN = /(机构|学生|课时)\s*[:：]\s*([^/]+)/g;

/** 令牌名里能解析出的归集维度；解析不出任何一段时返回空数组。 */
export function parseTokenSegments(name) {
  const text = String(name || '');
  const out = [];
  TOKEN_SEGMENT_PATTERN.lastIndex = 0;
  let match = TOKEN_SEGMENT_PATTERN.exec(text);
  while (match) {
    const kind = match[1] === '机构' ? 'org' : (match[1] === '学生' ? 'student' : 'lesson');
    const key = String(match[2] || '').trim();
    if (key) out.push({ kind, key });
    match = TOKEN_SEGMENT_PATTERN.exec(text);
  }
  return out;
}

export function aggregateUsage(rowsInput, { quotaPerUnit = 500000 } = {}) {
  const toYuan = (quota) => Number(((Number(quota || 0) / quotaPerUnit)).toFixed(4));
  const buckets = { org: new Map(), student: new Map(), lesson: new Map(), token: new Map() };
  let calls = 0; let totalQuota = 0;
  for (const row of Array.isArray(rowsInput) ? rowsInput : []) {
    const quota = Number(row.quota || 0);
    calls += 1; totalQuota += quota;
    const name = String(row.token_name || '(未命名令牌)');
    const token = buckets.token.get(name) || { key: name, calls: 0, quota: 0 };
    token.calls += 1; token.quota += quota; buckets.token.set(name, token);
    // 一次调用只加一次：同一个名字里重复写了同一段（例如 `学生:1/学生:1`）也只算一次。
    const seen = new Set();
    for (const segment of parseTokenSegments(name)) {
      const dedupeKey = `${segment.kind}:${segment.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const bucket = buckets[segment.kind].get(segment.key) || { key: segment.key, calls: 0, quota: 0 };
      bucket.calls += 1; bucket.quota += quota; buckets[segment.kind].set(segment.key, bucket);
    }
  }
  const shape = (map) => [...map.values()].sort((a, b) => b.quota - a.quota).map((item) => ({ ...item, yuan: toYuan(item.quota) }));
  return {
    calls, totalQuota, totalYuan: toYuan(totalQuota),
    byOrg: shape(buckets.org), byStudent: shape(buckets.student), byLesson: shape(buckets.lesson), byToken: shape(buckets.token),
    unattributed: [...buckets.token.values()].filter((item) => !parseTokenSegments(item.key).length).map((item) => ({ ...item, yuan: toYuan(item.quota) })),
  };
}

/**
 * 课时预算对照：把网关的实际消耗挂回「这节课的总预算」上。
 *
 * 口径（2026-09-11 用户答复）：预算**按学生算** —— 每学生 50 元，机构加 5 个学生，这节课就是 250 元。
 * 所以总预算 = 每学生上限 × 参与学生数（排课名单 `class_lesson_students` 里的去重人数），
 * 加人会**自动放大**预算；实际消耗取网关日志按「课时」维度的合计（同一张令牌名里的课时段）。
 *
 * ⚠️ 两个已知边界（写在这里免得被当成 bug）：
 *   ① 用量日志里那张令牌是 `…/课时:<id>`，所以实际消耗能按课时归集 —— 与预算同源，口径一致；
 *   ② 视频/音乐目前不走网关（异步任务要写 new-api 插件，见 7.2.3），**它们的花费不在这一列里**。
 */
export function lessonBudgetOverview({ byLesson = [] } = {}) {
  const budgetRows = rows(
    `SELECT lesson.id AS lesson_id, lesson.title AS lesson_title,
            lesson.per_student_budget_fen AS per_student_fen,
            (SELECT COUNT(DISTINCT roster.student_id)
               FROM class_lesson_students roster
              WHERE roster.lesson_id = lesson.id) AS student_count
       FROM course_lessons lesson
      WHERE lesson.per_student_budget_fen IS NOT NULL AND lesson.per_student_budget_fen > 0`,
  );
  const toYuan = (fen) => Number((Number(fen || 0) / 100).toFixed(2));
  const actualOf = new Map((Array.isArray(byLesson) ? byLesson : []).map((item) => [String(item.key), item]));
  return budgetRows.map((item) => {
    const perStudentFen = Number(item.per_student_fen || 0);
    const studentCount = Number(item.student_count || 0);
    const budgetFen = perStudentFen * studentCount;
    const used = actualOf.get(String(item.lesson_id)) || { calls: 0, yuan: 0 };
    const usedFen = Math.round(Number(used.yuan || 0) * 100);
    return {
      lessonId: item.lesson_id, lessonTitle: item.lesson_title,
      perStudentYuan: toYuan(perStudentFen), studentCount,
      budgetYuan: toYuan(budgetFen),
      usedYuan: Number(Number(used.yuan || 0).toFixed(2)),
      calls: Number(used.calls || 0),
      // 没有学生参与时预算为 0：不给百分比（否则会出现除零或「∞%」这种看不懂的数）
      usagePercent: budgetFen > 0 ? Number(((usedFen / budgetFen) * 100).toFixed(1)) : null,
    };
  }).sort((a, b) => Number(b.usedYuan || 0) - Number(a.usedYuan || 0));
}

/** 平台端用：读日志并归集（默认近 7 天） */
export async function gatewayUsageOverview({ days = 7 } = {}) {
  const config = getComputeGatewayConfig();
  const rowsOut = await listGatewayLogs({ days });
  const summary = aggregateUsage(rowsOut, { quotaPerUnit: config.quotaPerUnit || 500000 });
  return {
    days, quotaPerUnit: config.quotaPerUnit || 500000, ...summary,
    byLessonBudget: lessonBudgetOverview({ byLesson: summary.byLesson }),
  };
}

/* ───────────────────────── 令牌路由：把 AI 调用真的接到网关 ─────────────────────────
 *
 * 上面那些是「看得见消耗」，这一段才是「拦得住」：学生的 AI 调用带着**自己的令牌**打到网关，
 * 令牌额度用尽网关就拒服务 → 「1 个学生 50 元」是硬闸，而不是我们自己算出来的一个数。
 *
 * 令牌名的解析顺序是**最具体优先**：
 *   机构:X/学生:Y/课时:Z  →  学生:Y/课时:Z  →  机构:X/学生:Y  →  学生:Y
 * 这样平台管理员手动分发的令牌（老约定，单段）和我们按课时预算自动发的令牌都能被用上。
 */

/** 令牌名（多段）：机构:<id>/学生:<id>/课时:<id>，能给几段给几段。 */
export function gatewayTokenName({ orgId, studentId, lessonId } = {}) {
  const parts = [];
  if (orgId) parts.push(`机构:${orgId}`);
  if (studentId) parts.push(`学生:${studentId}`);
  if (lessonId) parts.push(`课时:${lessonId}`);
  return parts.join('/');
}

function tokenNameCandidates({ orgId, studentId, lessonId } = {}) {
  const org = orgId ? `机构:${orgId}` : '';
  const student = studentId ? `学生:${studentId}` : '';
  const lesson = lessonId ? `课时:${lessonId}` : '';
  const out = [];
  for (const parts of [[org, student, lesson], [student, lesson], [org, student], [student]]) {
    const name = parts.filter(Boolean).join('/');
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 课时的「每学生算力上限」（元）。没填 = 不按课时自动发令牌（只记账，不拦）。 */
function lessonBudgetFen(lessonId) {
  if (!lessonId) return 0;
  const value = row('SELECT per_student_budget_fen FROM course_lessons WHERE id=?', [lessonId])?.per_student_budget_fen;
  const fen = Number(value);
  return Number.isFinite(fen) && fen > 0 ? Math.round(fen) : 0;
}

/** 发一张令牌；同一名字并发时只发一张（不然两个并发的首次调用会各发一张）。 */
async function ensureGatewayToken({ name, budgetFen, models }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (provisioning.has(name)) {
      // 别人正在发：等它发完再找一次，别自己再发一张同名的
      for (let wait = 0; wait < 20; wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const token = await findGatewayTokenByName(name);
        if (token?.key) return { ...token, created: false };
      }
      return null;
    }
    provisioning.add(name);
    try {
      const existing = await findGatewayTokenByName(name);
      if (existing?.key) return { ...existing, created: false };
      if (existing && !existing.key) return null; // 有令牌但取不到 key：网关没暴露，别当成可用
      await createGatewayToken({ name, budgetFen, models, quotaPerUnit: getComputeGatewayConfig().quotaPerUnit });
      const created = await findGatewayTokenByName(name);
      return created?.key ? { ...created, created: true } : null;
    } finally {
      provisioning.delete(name);
    }
  }
  return null;
}

async function resolveRouteUncached({ orgId, studentId, lessonId, configured, models }) {
  let sawTokenWithoutKey = false;
  for (const name of tokenNameCandidates({ orgId, studentId, lessonId })) {
    const token = await findGatewayTokenByName(name);
    if (!token) continue;
    if (!token.key) { sawTokenWithoutKey = true; continue; }
    return { mode: 'gateway', endpoint: configured.baseUrl, apiKey: token.key, tokenName: name, reason: 'EXISTING_TOKEN', created: false };
  }
  // 没有现成令牌：这节课填了「每学生算力上限」就按它自动发一张 ——
  // 于是「1 个学生 50 元」不需要管理员先手动分发，本身就是硬闸。
  const budgetFen = lessonBudgetFen(lessonId);
  if (budgetFen > 0) {
    const name = gatewayTokenName({ orgId, studentId, lessonId });
    const token = await ensureGatewayToken({ name, budgetFen, models });
    if (token?.key) {
      return { mode: 'gateway', endpoint: configured.baseUrl, apiKey: token.key, tokenName: name, reason: token.created ? 'AUTO_PROVISIONED' : 'EXISTING_TOKEN', budgetFen, created: token.created === true };
    }
    return { mode: 'direct', reason: 'PROVISION_FAILED' };
  }
  return { mode: 'direct', reason: sawTokenWithoutKey ? 'TOKEN_WITHOUT_KEY' : 'NO_TOKEN', tokenName: gatewayTokenName({ orgId, studentId, lessonId }) };
}

/**
 * 解析这次调用该走哪儿。启用的学生文本/图片路由必须成功取得网关令牌；异常直接拒绝，不绕过网关。
 */
export async function resolveGenerationRoute({ orgId = '', studentId = '', lessonId = '', modality = 'TEXT', models = '' } = {}) {
  const configured = getComputeGatewayConfig();
  if (!configured.enabled) return { mode: 'direct', reason: 'GATEWAY_DISABLED' };
  if (!GATEWAY_MODALITIES.has(String(modality || '').toUpperCase())) return { mode: 'direct', reason: 'MODALITY_NOT_ON_GATEWAY' };
  if (!studentId) return { mode: 'direct', reason: 'NO_STUDENT' };
  if (!configured.baseUrl) throw errors.badRequest('算力网关未配置完成，请联系管理员', 'COMPUTE_GATEWAY_UNAVAILABLE');
  const cacheKey = [configured.baseUrl, orgId, studentId, lessonId || ''].join('|');
  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ROUTE_CACHE_TTL_MS) return cached.route;
  try {
    const route = await resolveRouteUncached({ orgId, studentId, lessonId, configured, models });
    if (route.mode !== 'gateway') throw errors.badRequest('无法取得算力网关令牌，请联系管理员', 'COMPUTE_GATEWAY_UNAVAILABLE');
    routeCache.set(cacheKey, { at: Date.now(), route });
    return route;
  } catch (error) {
    throw errors.badRequest('算力网关暂不可用，请稍后重试或联系管理员', 'COMPUTE_GATEWAY_UNAVAILABLE');
  }
}

/** 清掉路由缓存（改了网关配置或令牌后调用，免得 60 秒内还在用旧结果）。 */
export function clearGatewayRouteCache() {
  routeCache.clear();
}

/**
 * 把一个 provider selection 改写成「走网关」的 selection。
 * 仅明确不使用网关时保持直连；启用但解析失败会抛错。
 */
export async function applyGatewayRoute(selection, { orgId = '', studentId = '', lessonId = '', modality = 'TEXT', model = '' } = {}) {
  let route;
  try { route = await resolveGenerationRoute({ orgId, studentId, lessonId, modality, models: model || selection?.model || '' }); }
  catch (error) {
    q(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,modality,channel_id,provider,model,routed_via,status,sale_snapshot,error_code,error_message,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id('attempt'),id('call'),1,orgId || null,studentId || null,modality,selection?.channelId || 'default',selection?.provider || '',model || selection?.model || '', 'gateway','BLOCKED',json({ charged:false, reason:'GATEWAY_PREFLIGHT' }),error.code || 'COMPUTE_GATEWAY_UNAVAILABLE','网关路由不可用，请联系管理员',nowIso(),nowIso()]);
    throw error;
  }
  if (route.mode !== 'gateway') return selection;
  return { ...selection, gateway: { endpoint: route.endpoint, apiKey: route.apiKey, tokenName: route.tokenName } };
}
