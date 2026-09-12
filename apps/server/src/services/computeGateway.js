// 算力网关（new-api）客户端：平台用它配置渠道、给机构/学生分发令牌、读用量日志。
//
// 设计取舍（见 docs/项目重梳理-03-平台侧重做梳理.md 第 7 节）：
//   · 我们**不改** new-api 的代码（AGPL：改了就要开源那部分），只通过它的管理接口读写；
//   · 渠道与密钥在 new-api 那一侧维护，我们这边只保存「网关地址 + 管理员账号」，
//     管理员密码复用既有的加密密钥文件（providerSecret.js，AES-256-GCM）；
//   · 令牌名就是归集维度：约定 `机构:<orgId>` / `学生:<studentId>` / `课时:<lessonId>`，
//     用量日志按令牌名解析即可还原「哪个机构/哪个学生/哪节课花了多少」，不需要动它一行代码。
import { errors } from '../lib.js';
import { getProviderApiKey, setProviderApiKey } from './providerSecret.js';
import { row, q, nowIso, parseJson, json } from '../lib.js';

const ADMIN_SECRET_KEY = 'compute-gateway-admin';

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

export async function listGatewayChannels() {
  const data = await gatewayRequest('/api/channel/?p=1&page_size=100');
  return (data?.items || []).map((item) => ({
    id: item.id, name: item.name, type: item.type, baseUrl: item.base_url || null, models: item.models || '',
    status: Number(item.status || 0), group: item.group || null,
  }));
}

export async function listGatewayTokens() {
  const data = await gatewayRequest('/api/token/?p=1&page_size=100');
  return (data?.items || []).map((item) => ({
    id: item.id, name: item.name, status: Number(item.status || 0),
    remainQuota: Number(item.remain_quota || 0), usedQuota: Number(item.used_quota || 0),
    unlimited: item.unlimited_quota === true, models: item.model_limits || '',
  }));
}

/**
 * 分发令牌：额度按「分」换算成网关的 quota（QuotaPerUnit 默认 500000 = 1 元）。
 * 名字里带上机构/学生/课时的标识，方便用量日志归集。
 */
export async function createGatewayToken({ name, budgetFen, models = '', unlimited = false, quotaPerUnit = 500000 }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw errors.badRequest('令牌名称必填（约定：机构:<id> / 学生:<id> / 课时:<id>）', 'GATEWAY_TOKEN_NAME_REQUIRED');
  const remainQuota = unlimited ? 0 : Math.max(1, Math.round((Number(budgetFen || 0) / 100) * quotaPerUnit));
  await gatewayRequest('/api/token/', {
    method: 'POST',
    body: { name: cleanName, remain_quota: remainQuota, unlimited_quota: unlimited, expired_time: -1, model_limits_enabled: Boolean(models), model_limits: String(models || ''), group: 'default', allow_ips: '' },
  });
  const tokens = await listGatewayTokens();
  const created = tokens.find((item) => item.name === cleanName) || null;
  return { token: created, budgetFen: Number(budgetFen || 0), unlimited };
}

/** 读网关的用量日志（分页拉，最多 maxRows 条，够看一个周期即可） */
export async function listGatewayLogs({ days = 7, maxRows = 2000 } = {}) {
  const since = Math.floor((Date.now() - Number(days) * 24 * 60 * 60 * 1000) / 1000);
  const rowsOut = [];
  const pageSize = 100;
  for (let page = 1; page <= Math.ceil(maxRows / pageSize); page += 1) {
    const data = await gatewayRequest(`/api/log/?p=${page}&page_size=${pageSize}&type=0&start_timestamp=${since}`);
    const items = data?.items || [];
    if (!items.length) break;
    rowsOut.push(...items);
    if (rowsOut.length >= maxRows) break;
  }
  return rowsOut.slice(0, maxRows);
}

/**
 * 按令牌名归集消耗：令牌名约定成 `机构:<id>` / `学生:<id>` / `课时:<id>`，
 * 所以「哪个机构/哪个学员/哪节课花了多少」不需要改网关一行代码就能还原。
 * 没按约定命名的令牌进 `unattributed`（写清楚是「未归属」，不要混进任何一个维度）。
 */
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
    const match = name.match(/^(机构|学生|课时):\s*(.+)$/);
    if (!match) continue;
    const kind = match[1] === '机构' ? 'org' : (match[1] === '学生' ? 'student' : 'lesson');
    const key = match[2].trim();
    const bucket = buckets[kind].get(key) || { key, calls: 0, quota: 0 };
    bucket.calls += 1; bucket.quota += quota; buckets[kind].set(key, bucket);
  }
  const shape = (map) => [...map.values()].sort((a, b) => b.quota - a.quota).map((item) => ({ ...item, yuan: toYuan(item.quota) }));
  return {
    calls, totalQuota, totalYuan: toYuan(totalQuota),
    byOrg: shape(buckets.org), byStudent: shape(buckets.student), byLesson: shape(buckets.lesson), byToken: shape(buckets.token),
    unattributed: [...buckets.token.values()].filter((item) => !/^(机构|学生|课时):/.test(item.key)).map((item) => ({ ...item, yuan: toYuan(item.quota) })),
  };
}

/** 平台端用：读日志并归集（默认近 7 天） */
export async function gatewayUsageOverview({ days = 7 } = {}) {
  const config = getComputeGatewayConfig();
  const rowsOut = await listGatewayLogs({ days });
  const summary = aggregateUsage(rowsOut, { quotaPerUnit: config.quotaPerUnit || 500000 });
  return { days, quotaPerUnit: config.quotaPerUnit || 500000, ...summary };
}
