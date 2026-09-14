/**
 * 官方账单 API 自动对账（拉取侧）。
 *
 * 与 `supplierBilling.js`（CSV 手工导入）并列：那一条是「运营把账单文件导进来」，这一条是
 * 「平台自己按账期去供应商的账单接口把官方数字拉回来」。两条路的产物都落进同一套
 * supplier_billing_* 表口径吗？**不是**。官方拉取另建两张表：
 *   · `provider_bill_snapshots` —— 每次拉取的不可变快照（成功与失败都留痕，原始响应体原样保存）；
 *   · `provider_bill_aggregates` —— 快照里「按模型 × 币种」摊平后的官方金额。
 * 这样对账视图能同时给出「官方合计」与「平台口径合计」，而不必假装两者是同一种证据。
 *
 * 三条不变量（守卫专门钉它们，别为了省事放宽）：
 *   1. **幂等**：账号 + 账期 + 响应哈希 唯一 —— 同一份账单重复拉取只落一份快照与一份聚合。
 *   2. **失败不写脏**：超时 / 非 2xx / 结构不符 / 金额非法 —— 只记 FAILED 快照并保留错误，
 *      **绝不**写半截成功的聚合行（聚合与快照在同一个事务里写）。
 *   3. **凭据不外泄**：凭据只经 providerSecret.js（AES-256-GCM）存放，key 为
 *      `supplier-billing:<accountId>`；任何响应只回 `hasCredential` 布尔值，绝不回显明文，
 *      也绝不写进 supplier_accounts 的配置列。
 */
import { createHash } from 'node:crypto';
import { errors, id, json, nowIso, parseJson, q, row, rows, transaction } from '../lib.js';
import { clearProviderApiKey, getProviderApiKey, hasProviderApiKey, setProviderApiKey } from './providerSecret.js';

const CURRENCY = /^[A-Z]{3}$/;
const SECRET_KEY = /(api.?key|secret|password|token|credential|authorization|auth.?header|bearer)/i;
const MAX_ITEMS = 20000;
const DEFAULT_TIMEOUT_MS = Number(process.env.PROVIDER_BILL_TIMEOUT_MS || 20000);
const MAX_PAGES = 10;

export const PROVIDER_BILL_ERROR_CODES = Object.freeze({
  CONFIG_INVALID: 'PROVIDER_BILL_CONFIG_INVALID',
  CONFIG_SECRET_FORBIDDEN: 'PROVIDER_BILL_CONFIG_SECRET_FORBIDDEN',
  ADAPTER_UNKNOWN: 'PROVIDER_BILL_ADAPTER_UNKNOWN',
  NOT_CONFIGURED: 'PROVIDER_BILL_NOT_CONFIGURED',
  CREDENTIAL_MISSING: 'PROVIDER_BILL_CREDENTIAL_MISSING',
  ACCOUNT_DISABLED: 'PROVIDER_BILL_ACCOUNT_DISABLED',
  UNREACHABLE: 'PROVIDER_BILL_UNREACHABLE',
  TIMEOUT: 'PROVIDER_BILL_TIMEOUT',
  AUTH_FAILED: 'PROVIDER_BILL_AUTH_FAILED',
  HTTP_ERROR: 'PROVIDER_BILL_HTTP_ERROR',
  STRUCTURE_INVALID: 'PROVIDER_BILL_STRUCTURE_INVALID',
  AMOUNT_INVALID: 'PROVIDER_BILL_AMOUNT_INVALID',
  SNAPSHOT_NOT_FOUND: 'PROVIDER_BILL_SNAPSHOT_NOT_FOUND',
  // 上游可能返回别的币种：能记就记，但聚合金额不允许跨币种相加。
  MIXED_CURRENCY: 'PROVIDER_BILL_MIXED_CURRENCY',
});

/**
 * 适配器注册表。任何「按天/按模型聚合的账单接口」都能用 generic-http 接：
 * 只要给 URL、方法、请求头（非敏感）与 JSON 路径映射即可；专用适配器只是把已知供应商的
 * 路径/币种/分页规则固化下来，少填几个字段。
 */
export const BILLING_ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'generic-http',
    label: '通用 HTTP 账单接口',
    description: '可配置 URL / 方法 / 请求头与 JSON 路径映射（itemsPath、modelPath、amountPath…），任何聚合账单接口都能接。',
    credentialRequired: false,
    defaultEndpoint: '',
    defaultMethod: 'GET',
    mappingKeys: ['itemsPath', 'modelPath', 'amountPath', 'amountScale', 'currencyPath', 'quantityPath', 'unitPath', 'datePath', 'modelDefault', 'startParam', 'endParam', 'timeFormat', 'credentialHeader', 'credentialScheme', 'extraQuery', 'filterByPeriod'],
  }),
  Object.freeze({
    id: 'openai-costs',
    label: 'OpenAI 组织成本接口',
    description: 'GET /v1/organization/costs，Bearer 组织管理员 key，按天 × line_item（模型）聚合。',
    credentialRequired: true,
    defaultEndpoint: 'https://api.openai.com',
    defaultMethod: 'GET',
    mappingKeys: ['extraQuery', 'credentialScheme'],
  }),
  Object.freeze({
    id: 'anthropic-usage',
    label: 'Anthropic 用量与成本报表',
    description: 'GET /v1/organizations/cost_report（Bearer + anthropic-version），按模型聚合；可选附拉用量报表取 token 数量。',
    credentialRequired: true,
    defaultEndpoint: 'https://api.anthropic.com',
    defaultMethod: 'GET',
    mappingKeys: ['includeUsage', 'extraQuery', 'credentialScheme'],
  }),
]);

export function listBillingAdapters() {
  return BILLING_ADAPTERS.map((item) => ({ ...item, mappingKeys: [...item.mappingKeys] }));
}
function billingAdapter(adapterId) {
  return BILLING_ADAPTERS.find((item) => item.id === adapterId) || null;
}

const secretKeyOf = (accountId) => `supplier-billing:${String(accountId || '')}`;
const hashOf = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message, details) => Object.assign(new Error(message), { code, details });

// ── JSON 路径解析 ────────────────────────────────────────────────────────────
// 支持 `$.data.items` / `data.items` / `results[0].amount`：账单接口的字段命名各家不同，
// 映射写成路径比要求上游改结构现实得多。
export function resolveJsonPath(source, path) {
  if (!path) return undefined;
  const tokens = String(path)
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((token) => token !== '');
  let current = source;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    current = current[token];
  }
  return current;
}

function toMinorUnits(value, scale, where) {
  if (value === null || value === undefined || value === '') throw fail(PROVIDER_BILL_ERROR_CODES.AMOUNT_INVALID, `${where} 的金额缺失`, { where });
  if (scale === 'MINOR') {
    const text = String(value).trim();
    if (!/^-?\d+$/.test(text)) throw fail(PROVIDER_BILL_ERROR_CODES.AMOUNT_INVALID, `${where} 的金额不是整数最小单位（amountScale=MINOR）`, { where, value: text.slice(0, 40) });
    const amount = Number(text);
    if (!Number.isSafeInteger(amount)) throw fail(PROVIDER_BILL_ERROR_CODES.AMOUNT_INVALID, `${where} 的金额超出安全整数范围`, { where });
    return amount;
  }
  const numeric = Number(String(value).trim());
  if (!Number.isFinite(numeric)) throw fail(PROVIDER_BILL_ERROR_CODES.AMOUNT_INVALID, `${where} 的金额不是有效数字`, { where, value: String(value).slice(0, 40) });
  return Math.round(numeric * 100);
}

function currencyOf(value, fallback, where) {
  const currency = String(value || fallback || '').trim().toUpperCase();
  if (!CURRENCY.test(currency)) throw fail(PROVIDER_BILL_ERROR_CODES.STRUCTURE_INVALID, `${where} 的币种无效`, { where, currency });
  return currency;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function requestJson({ url, method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = null; }
    }
    return { status: Number(response.status || 0), ok: Boolean(response.ok), text, payload };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw fail(PROVIDER_BILL_ERROR_CODES.TIMEOUT, `账单接口超时（>${timeoutMs}ms）`, { url });
    throw fail(PROVIDER_BILL_ERROR_CODES.UNREACHABLE, `连不上账单接口：${String(error?.message || error).slice(0, 200)}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(response, url) {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) throw fail(PROVIDER_BILL_ERROR_CODES.AUTH_FAILED, `账单接口认证失败（HTTP ${response.status}）`, { url, status: response.status });
  throw fail(PROVIDER_BILL_ERROR_CODES.HTTP_ERROR, `账单接口返回 HTTP ${response.status}`, { url, status: response.status, body: String(response.text || '').slice(0, 300) });
}

function queryString(pairs) {
  const search = new URLSearchParams();
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(key, String(item)));
    else search.append(key, String(value));
  }
  return search.toString();
}

function appendQuery(url, pairs) {
  const query = queryString(pairs);
  if (!query) return url;
  return url + (url.includes('?') ? '&' : '?') + query;
}

function itemsToAggregates(items, { where = '账单' } = {}) {
  if (items.length > MAX_ITEMS) throw fail(PROVIDER_BILL_ERROR_CODES.STRUCTURE_INVALID, `${where}行数超过 ${MAX_ITEMS} 上限`, { count: items.length });
  const map = new Map();
  for (const item of items) {
    const key = `${item.model}\u0000${item.currency}`;
    const current = map.get(key) || { model: item.model, currency: item.currency, amountMinor: 0, quantity: null, unit: item.unit || null };
    current.amountMinor += item.amountMinor;
    if (item.quantity !== null && item.quantity !== undefined) current.quantity = (current.quantity || 0) + Number(item.quantity);
    if (!current.unit && item.unit) current.unit = item.unit;
    map.set(key, current);
  }
  return [...map.values()];
}

// ── 适配器 ───────────────────────────────────────────────────────────────────
async function genericHttpAdapter({ config, credential, account, periodStart, periodEnd, timeoutMs, fetchImpl }) {
  const mapping = config.mapping;
  const headers = { accept: 'application/json', ...config.headers };
  if (credential) {
    const header = String(mapping.credentialHeader || 'authorization').trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) throw fail(PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, 'credentialHeader 必须是合法的请求头名', { header });
    const scheme = mapping.credentialScheme === undefined ? 'Bearer' : String(mapping.credentialScheme);
    headers[header] = scheme ? `${scheme} ${credential}` : credential;
  }
  // 账期传参名与格式可配：ISO 是默认，Unix 秒对接「要时间戳」的接口。
  const timeFormat = mapping.timeFormat === 'UNIX_SECONDS' ? 'UNIX_SECONDS' : 'ISO';
  const timeValue = (value) => (timeFormat === 'UNIX_SECONDS' ? String(Math.floor(Date.parse(value) / 1000)) : value);
  const url = appendQuery(config.endpoint, [
    [String(mapping.startParam || 'start'), timeValue(periodStart)],
    [String(mapping.endParam || 'end'), timeValue(periodEnd)],
    ...Object.entries(mapping.extraQuery || {}),
  ]);
  const method = config.method;
  const response = await requestJson({
    url, method, headers, fetchImpl, timeoutMs,
    body: method === 'GET' || method === 'HEAD' ? null : JSON.stringify({ periodStart, periodEnd }),
  });
  assertOk(response, url);
  if (response.payload === null) throw fail(PROVIDER_BILL_ERROR_CODES.STRUCTURE_INVALID, '账单接口响应不是合法 JSON', { url });
  const rawItems = mapping.itemsPath ? resolveJsonPath(response.payload, mapping.itemsPath) : response.payload;
  if (!Array.isArray(rawItems)) throw fail(PROVIDER_BILL_ERROR_CODES.STRUCTURE_INVALID, `itemsPath「${mapping.itemsPath || '(根)'}」未指向数组`, { url, itemsPath: mapping.itemsPath || null });
  const scale = mapping.amountScale === 'MINOR' ? 'MINOR' : 'MAJOR';
  const since = Date.parse(periodStart); const until = Date.parse(periodEnd);
  const filterByPeriod = Boolean(mapping.datePath) && mapping.filterByPeriod !== false;
  const items = [];
  rawItems.forEach((item, index) => {
    const where = `第 ${index + 1} 条账单`;
    if (filterByPeriod) {
      const at = Date.parse(String(resolveJsonPath(item, mapping.datePath) || ''));
      if (!Number.isFinite(at) || at < since || at >= until) return;
    }
    const model = String(resolveJsonPath(item, mapping.modelPath) ?? mapping.modelDefault ?? '').trim().slice(0, 120);
    const currency = currencyOf(mapping.currencyPath ? resolveJsonPath(item, mapping.currencyPath) : null, account.default_currency, where);
    const unit = mapping.unitPath ? resolveJsonPath(item, mapping.unitPath) : null;
    const quantity = mapping.quantityPath ? resolveJsonPath(item, mapping.quantityPath) : null;
    items.push({
      model, currency,
      amountMinor: toMinorUnits(resolveJsonPath(item, mapping.amountPath), scale, where),
      quantity: quantity === null || quantity === undefined || quantity === '' ? null : Number(quantity),
      unit: unit === null || unit === undefined ? null : String(unit).slice(0, 40),
    });
  });
  return { currency: null, items, raw: response.payload, httpStatus: response.status };
}

async function openAiCostsAdapter({ config, credential, periodStart, periodEnd, timeoutMs, fetchImpl }) {
  const base = String(config.endpoint || 'https://api.openai.com').replace(/\/+$/, '');
  const headers = { accept: 'application/json', authorization: `Bearer ${credential}`, ...config.headers };
  const startSeconds = Math.floor(Date.parse(periodStart) / 1000);
  const endSeconds = Math.floor(Date.parse(periodEnd) / 1000);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) throw fail(PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, '账期无效', { periodStart, periodEnd });
  const items = [];
  let page = null; let httpStatus = 200; let raw = null;
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const url = appendQuery(`${base}/v1/organization/costs`, [
      ['start_time', startSeconds], ['end_time', endSeconds], ['bucket_width', '1d'],
      ['limit', config.mapping.limit || 180], ['group_by[]', 'line_item'], ['page', page],
      ...Object.entries(config.mapping.extraQuery || {}),
    ]);
    const response = await requestJson({ url, headers, timeoutMs, fetchImpl });
    assertOk(response, url);
    httpStatus = response.status; raw = response.payload;
    if (!response.payload || !Array.isArray(response.payload.data)) throw fail(PROVIDER_BILL_ERROR_CODES.STRUCTURE_INVALID, 'OpenAI 成本接口响应缺少 data 数组', { url });
    for (const bucket of response.payload.data) {
      for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
        const amount = result?.amount || {};
        const model = String(result?.line_item || result?.project_id || '').trim().slice(0, 120);
        items.push({
          model,
          currency: currencyOf(amount.currency, config.accountCurrency, 'OpenAI 成本'),
          amountMinor: toMinorUnits(amount.value, 'MAJOR', 'OpenAI 成本'),
          quantity: null, unit: null,
        });
      }
    }
    if (!response.payload.has_more || !response.payload.next_page) break;
    page = response.payload.next_page;
  }
  return { currency: null, items, raw, httpStatus };
}

async function anthropicUsageAdapter({ config, credential, periodStart, periodEnd, timeoutMs, fetchImpl }) {
  const base = String(config.endpoint || 'https://api.anthropic.com').replace(/\/+$/, '');
  const headers = { accept: 'application/json', authorization: `Bearer ${credential}`, 'anthropic-version': '2023-06-01', ...config.headers };
  const url = appendQuery(`${base}/v1/organizations/cost_report`, [
    ['starting_at', periodStart], ['ending_at', periodEnd], ['limit', config.mapping.limit || 31],
    ...Object.entries(config.mapping.extraQuery || {}),
  ]);
  const response = await requestJson({ url, headers, timeoutMs, fetchImpl });
  assertOk(response, url);
  if (!response.payload || !Array.isArray(response.payload.data)) throw fail(PROVIDER_BILL_ERROR_CODES.STRUCTURE_INVALID, 'Anthropic 成本报表响应缺少 data 数组', { url });
  const items = [];
  for (const bucket of response.payload.data) {
    for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
      items.push({
        model: String(result?.model || result?.description || '').trim().slice(0, 120),
        currency: currencyOf(result?.currency, config.accountCurrency, 'Anthropic 成本'),
        // Anthropic 的 amount 是「美元」十进制字符串（不是最小单位），按 MAJOR 换算。
        amountMinor: toMinorUnits(result?.amount, 'MAJOR', 'Anthropic 成本'),
        quantity: null, unit: null,
      });
    }
  }
  if (config.mapping.includeUsage === true) {
    const usageUrl = appendQuery(`${base}/v1/organizations/usage_report/messages`, [
      ['starting_at', periodStart], ['ending_at', periodEnd], ['bucket_width', '1d'], ['group_by[]', 'model'], ['limit', config.mapping.limit || 31],
    ]);
    const usage = await requestJson({ url: usageUrl, headers, timeoutMs, fetchImpl });
    assertOk(usage, usageUrl);
    if (!usage.payload || !Array.isArray(usage.payload.data)) throw fail(PROVIDER_BILL_ERROR_CODES.STRUCTURE_INVALID, 'Anthropic 用量报表响应缺少 data 数组', { url: usageUrl });
    const tokens = new Map();
    for (const bucket of usage.payload.data) {
      for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
        const model = String(result?.model || '').trim().slice(0, 120);
        const total = ['uncached_input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
          .reduce((sum, key) => sum + Number(result?.[key] || 0), 0);
        if (model) tokens.set(model, (tokens.get(model) || 0) + total);
      }
    }
    for (const item of items) {
      if (tokens.has(item.model)) { item.quantity = tokens.get(item.model); item.unit = 'TOKEN'; }
    }
  }
  return { currency: null, items, raw: response.payload, httpStatus: response.status };
}

const ADAPTER_RUNNERS = Object.freeze({ 'generic-http': genericHttpAdapter, 'openai-costs': openAiCostsAdapter, 'anthropic-usage': anthropicUsageAdapter });

// ── 账户配置 ─────────────────────────────────────────────────────────────────
function billingAccountRow(accountId, { active = false } = {}) {
  const account = row('SELECT * FROM supplier_accounts WHERE id=?', [String(accountId || '')]);
  if (!account) throw errors.notFound('供应商账户不存在', 'SUPPLIER_ACCOUNT_NOT_FOUND');
  if (active && account.status !== 'ACTIVE') throw errors.conflict('供应商账户已停用', PROVIDER_BILL_ERROR_CODES.ACCOUNT_DISABLED);
  return account;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function assertNoSecrets(input, label) {
  for (const key of Object.keys(plainObject(input))) {
    if (SECRET_KEY.test(key)) throw errors.badRequest(`${label}不允许包含密钥、令牌或密码（凭据走单独的凭据接口，加密存储、不回显）`, PROVIDER_BILL_ERROR_CODES.CONFIG_SECRET_FORBIDDEN, { field: key });
  }
}

function normalizeMapping(value, adapterDefinition) {
  // 只复制白名单键：未知键一律丢弃，所以这里**不**再对键名做「像不像密钥」的二次拦截 ——
  // `credentialHeader` 这类「请求头名字」是合法配置（值才是秘密，值只走凭据接口）。
  const input = plainObject(value);
  const allowed = new Set(adapterDefinition.mappingKeys);
  const mapping = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    if (key === 'extraQuery') { mapping.extraQuery = plainObject(raw); continue; }
    if (key === 'filterByPeriod' || key === 'includeUsage') { mapping[key] = raw === true; continue; }
    if (key === 'amountScale') {
      const scale = String(raw || '').trim().toUpperCase();
      if (!['MAJOR', 'MINOR'].includes(scale)) throw errors.badRequest('amountScale 只能是 MAJOR 或 MINOR', PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, { field: 'amountScale' });
      mapping.amountScale = scale; continue;
    }
    if (key === 'limit') { const limit = Number(raw); if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw errors.badRequest('limit 必须是 1 到 1000 的整数', PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, { field: 'limit' }); mapping.limit = limit; continue; }
    mapping[key] = String(raw ?? '').trim().slice(0, 300);
  }
  return mapping;
}

function normalizeBillingConfig(input) {
  const body = plainObject(input);
  assertNoSecrets(body, '供应商账单配置');
  const rawAdapter = String(body.adapter || '').trim();
  const adapterDefinition = rawAdapter ? billingAdapter(rawAdapter) : null;
  if (rawAdapter && !adapterDefinition) throw errors.badRequest('未知的账单适配器', PROVIDER_BILL_ERROR_CODES.ADAPTER_UNKNOWN, { adapter: rawAdapter });
  const endpoint = String(body.endpoint || '').trim().slice(0, 500);
  if (endpoint) {
    let parsed;
    try { parsed = new URL(endpoint); } catch { throw errors.badRequest('账单接口地址必须是合法 URL', PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, { field: 'endpoint' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw errors.badRequest('账单接口地址必须使用 http 或 https', PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, { field: 'endpoint' });
  }
  const method = String(body.method || 'GET').trim().toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw errors.badRequest('账单接口方法只支持 GET 或 POST', PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, { field: 'method' });
  const headers = plainObject(body.headers);
  assertNoSecrets(headers, 'billingHeaders');
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) throw errors.badRequest('请求头名称无效', PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, { field: key });
    headers[key] = String(value ?? '').slice(0, 500);
  }
  const periodDays = Number(body.periodDays === undefined ? 1 : body.periodDays);
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 31) throw errors.badRequest('periodDays 必须是 1 到 31 的整数', PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, { field: 'periodDays' });
  return {
    adapter: adapterDefinition ? adapterDefinition.id : null,
    endpoint, method, headers,
    mapping: adapterDefinition ? normalizeMapping(body.mapping, adapterDefinition) : {},
    enabled: body.enabled === true,
    periodDays,
  };
}

/** 账单配置视图：**只**回 adapter/endpoint/method/headers/mapping 与「配没配凭据」，绝不回凭据。 */
export function billingAccountView(account) {
  if (!account) return null;
  const adapter = account.billing_adapter || null;
  return {
    id: account.id, code: account.code, name: account.name, provider: account.provider, status: account.status,
    defaultCurrency: account.default_currency, timezone: account.timezone,
    billing: {
      adapter,
      adapterLabel: billingAdapter(adapter)?.label || null,
      endpoint: account.billing_endpoint || null,
      method: account.billing_method || 'GET',
      headers: parseJson(account.billing_headers, {}),
      mapping: parseJson(account.billing_mapping, {}),
      enabled: Number(account.billing_enabled || 0) === 1,
      periodDays: Number(account.billing_period_days || 1),
      credentialConfigured: hasProviderApiKey(secretKeyOf(account.id)),
      lastSyncAt: account.billing_last_sync_at || null,
      lastSyncStatus: account.billing_last_sync_status || null,
      lastSyncError: account.billing_last_sync_error || null,
      lastSnapshotId: account.billing_last_snapshot_id || null,
    },
  };
}

export function listBillingAccounts() {
  return rows('SELECT * FROM supplier_accounts ORDER BY name COLLATE NOCASE,id').map(billingAccountView);
}

export function saveSupplierBillingConfig(accountId, input, actorId = null) {
  const account = billingAccountRow(accountId);
  const config = normalizeBillingConfig(input);
  q(`UPDATE supplier_accounts SET billing_adapter=?,billing_endpoint=?,billing_method=?,billing_headers=?,billing_mapping=?,billing_enabled=?,billing_period_days=?,updated_at=? WHERE id=?`,
    [config.adapter, config.endpoint || null, config.method, json(config.headers), json(config.mapping), config.enabled ? 1 : 0, config.periodDays, nowIso(), account.id]);
  event({ accountId: account.id, action: 'BILLING_CONFIG_UPDATE', after: { adapter: config.adapter, endpoint: config.endpoint || null, method: config.method, enabled: config.enabled, periodDays: config.periodDays, actorId } });
  return billingAccountView(billingAccountRow(account.id));
}

/** 写凭据：加密进 providerSecret 文件，库里只留「配没配」这一位事实。 */
export function setSupplierBillingCredential(accountId, secret, actorId = null) {
  const account = billingAccountRow(accountId);
  const text = String(secret || '').trim();
  if (!text) throw errors.badRequest('凭据不能为空', PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, { field: 'credential' });
  setProviderApiKey(text, secretKeyOf(account.id));
  event({ accountId: account.id, action: 'BILLING_CREDENTIAL_SET', after: { credentialConfigured: true, actorId } });
  return { id: account.id, credentialConfigured: true };
}

export function clearSupplierBillingCredential(accountId, actorId = null) {
  const account = billingAccountRow(accountId);
  clearProviderApiKey(secretKeyOf(account.id));
  event({ accountId: account.id, action: 'BILLING_CREDENTIAL_CLEAR', after: { credentialConfigured: false, actorId } });
  return { id: account.id, credentialConfigured: false };
}

// ── 拉取 ─────────────────────────────────────────────────────────────────────
function event({ accountId = null, snapshotId = null, action, after = null, reason = '', actorId = null }) {
  q('INSERT INTO supplier_billing_events(id,supplier_account_id,import_id,line_id,match_id,action,before_data,after_data,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id('supplier_event'), accountId, null, null, null, `PROVIDER_BILL_${action}`, null, after == null ? null : json(after), String(reason).slice(0, 1000), actorId, nowIso()]);
}

function snapshotView(value) {
  if (!value) return null;
  return {
    id: value.id, supplierAccountId: value.supplier_account_id, adapter: value.adapter, source: value.source,
    periodStart: value.period_start, periodEnd: value.period_end, currency: value.currency || null,
    status: value.status, responseHash: value.response_hash, httpStatus: value.http_status === null || value.http_status === undefined ? null : Number(value.http_status),
    itemCount: Number(value.item_count || 0),
    totalAmountMinor: value.total_amount_minor === null || value.total_amount_minor === undefined ? null : Number(value.total_amount_minor),
    errorCode: value.error_code || null, errorMessage: value.error_message || null,
    // 详情里可能有上游原文（含 URL），保留但截断；凭据从不进这里。
    errorDetail: parseJson(value.error_detail, null),
    durationMs: Number(value.duration_ms || 0), fetchedBy: value.fetched_by || null, fetchedAt: value.fetched_at,
  };
}

function aggregateView(value) {
  return {
    id: value.id, snapshotId: value.snapshot_id, model: value.model || null, currency: value.currency,
    amountMinor: Number(value.amount_minor), quantity: value.quantity === null || value.quantity === undefined ? null : Number(value.quantity),
    unit: value.unit || null, periodStart: value.period_start, periodEnd: value.period_end,
  };
}

function recordFailure({ account, adapter, source, periodStart, periodEnd, code, message, detail, httpStatus, durationMs, actorId }) {
  const snapshotId = id('provider_bill');
  const responseHash = hashOf(json({ failed: code, status: httpStatus || 0, message: String(message || '').slice(0, 400) }));
  const now = nowIso();
  transaction(() => {
    q(`INSERT INTO provider_bill_snapshots(id,supplier_account_id,adapter,source,period_start,period_end,currency,status,response_hash,http_status,raw_payload,item_count,total_amount_minor,error_code,error_message,error_detail,duration_ms,fetched_by,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [snapshotId, account.id, adapter, source, periodStart, periodEnd, null, 'FAILED', responseHash, httpStatus || null, null, 0, null, code, String(message || '').slice(0, 500), json(detail || {}), durationMs, actorId, now]);
    q('UPDATE supplier_accounts SET billing_last_sync_at=?,billing_last_sync_status=?,billing_last_sync_error=?,billing_last_snapshot_id=?,updated_at=? WHERE id=?',
      [now, 'FAILED', `${code}: ${String(message || '').slice(0, 300)}`, snapshotId, now, account.id]);
  });
  event({ accountId: account.id, snapshotId, action: 'FETCH_FAILED', reason: message, after: { code, httpStatus: httpStatus || null, periodStart, periodEnd }, actorId });
  return snapshotView(row('SELECT * FROM provider_bill_snapshots WHERE id=?', [snapshotId]));
}

/**
 * 拉一次官方账单。
 *
 * 返回 `{ status, snapshot, aggregates, idempotent, error }`：
 *   · status='FETCHED' —— 快照与聚合已落库（同账号+账期+响应哈希重复拉取时 idempotent=true，不重复写）；
 *   · status='FAILED'  —— 只落了 FAILED 快照与错误原文，**没有**任何聚合行。
 * 上游失败不抛异常（那是「这次没拉到」这一事实，已被记录），只有「配置/参数/账户」问题才抛。
 */
export async function syncProviderBill(accountId, { periodStart, periodEnd, actorId = null, source = 'MANUAL', fetchImpl, timeoutMs } = {}) {
  const account = billingAccountRow(accountId, { active: true });
  const adapter = account.billing_adapter;
  const definition = billingAdapter(adapter);
  if (!adapter || !definition) throw errors.badRequest('该供应商账户还没有配置账单适配器', PROVIDER_BILL_ERROR_CODES.NOT_CONFIGURED, { accountId: account.id });
  if (!String(account.billing_endpoint || '').trim()) throw errors.badRequest('该供应商账户还没有配置账单接口地址', PROVIDER_BILL_ERROR_CODES.NOT_CONFIGURED, { accountId: account.id });
  const start = new Date(periodStart); const end = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) throw errors.badRequest('账期无效（periodStart 必须早于 periodEnd）', PROVIDER_BILL_ERROR_CODES.CONFIG_INVALID, { periodStart, periodEnd });
  const normalizedStart = start.toISOString(); const normalizedEnd = end.toISOString();

  const credential = getProviderApiKey(secretKeyOf(account.id));
  const startedAt = Date.now();
  const base = { account, adapter, source, periodStart: normalizedStart, periodEnd: normalizedEnd, actorId };

  if (definition.credentialRequired && !credential) {
    const snapshot = recordFailure({ ...base, code: PROVIDER_BILL_ERROR_CODES.CREDENTIAL_MISSING, message: '该供应商账户还没有配置账单接口凭据', durationMs: 0 });
    return { status: 'FAILED', snapshot, aggregates: [], idempotent: false, error: { code: snapshot.errorCode, message: snapshot.errorMessage } };
  }

  let fetched = null;
  try {
    fetched = await ADAPTER_RUNNERS[adapter]({
      config: {
        endpoint: account.billing_endpoint, method: account.billing_method || 'GET',
        headers: parseJson(account.billing_headers, {}), mapping: parseJson(account.billing_mapping, {}),
        accountCurrency: account.default_currency,
      },
      credential, account, periodStart: normalizedStart, periodEnd: normalizedEnd,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS, fetchImpl: fetchImpl || globalThis.fetch,
    });
  } catch (error) {
    const code = error?.code && String(error.code).startsWith('PROVIDER_BILL_') ? error.code : PROVIDER_BILL_ERROR_CODES.HTTP_ERROR;
    const snapshot = recordFailure({ ...base, code, message: String(error?.message || error), detail: error?.details || {}, httpStatus: error?.details?.status || null, durationMs: Date.now() - startedAt });
    return { status: 'FAILED', snapshot, aggregates: [], idempotent: false, error: { code: snapshot.errorCode, message: snapshot.errorMessage } };
  }

  const rawText = json(fetched.raw);
  const responseHash = hashOf(rawText);
  const repeated = row("SELECT * FROM provider_bill_snapshots WHERE supplier_account_id=? AND period_start=? AND period_end=? AND response_hash=? AND status='FETCHED'", [account.id, normalizedStart, normalizedEnd, responseHash]);
  if (repeated) {
    event({ accountId: account.id, snapshotId: repeated.id, action: 'FETCH_REPLAY', after: { responseHash, periodStart: normalizedStart, periodEnd: normalizedEnd }, actorId });
    return { status: 'FETCHED', snapshot: snapshotView(repeated), aggregates: aggregatesOfSnapshot(repeated.id), idempotent: true };
  }

  const aggregates = itemsToAggregates(fetched.items);
  const currencies = [...new Set(aggregates.map((item) => item.currency))];
  const snapshotId = id('provider_bill');
  const now = nowIso();
  transaction(() => {
    q(`INSERT INTO provider_bill_snapshots(id,supplier_account_id,adapter,source,period_start,period_end,currency,status,response_hash,http_status,raw_payload,item_count,total_amount_minor,error_code,error_message,error_detail,duration_ms,fetched_by,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [snapshotId, account.id, adapter, source, normalizedStart, normalizedEnd, currencies.length === 1 ? currencies[0] : null, 'FETCHED', responseHash, fetched.httpStatus || null, rawText, fetched.items.length,
        currencies.length === 1 ? aggregates.reduce((sum, item) => sum + item.amountMinor, 0) : null, null, null, json({ currencies }), Date.now() - startedAt, actorId, now]);
    for (const item of aggregates) {
      q('INSERT INTO provider_bill_aggregates(id,snapshot_id,supplier_account_id,period_start,period_end,model,currency,amount_minor,quantity,unit,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [id('provider_bill_agg'), snapshotId, account.id, normalizedStart, normalizedEnd, item.model, item.currency, item.amountMinor, item.quantity, item.unit, now]);
    }
    q('UPDATE supplier_accounts SET billing_last_sync_at=?,billing_last_sync_status=?,billing_last_sync_error=?,billing_last_snapshot_id=?,updated_at=? WHERE id=?',
      [now, 'FETCHED', null, snapshotId, now, account.id]);
  });
  event({ accountId: account.id, snapshotId, action: 'FETCH', after: { responseHash, itemCount: fetched.items.length, aggregateCount: aggregates.length, currencies }, actorId });
  return { status: 'FETCHED', snapshot: snapshotView(row('SELECT * FROM provider_bill_snapshots WHERE id=?', [snapshotId])), aggregates: aggregatesOfSnapshot(snapshotId), idempotent: false };
}

export function aggregatesOfSnapshot(snapshotId) {
  return rows('SELECT * FROM provider_bill_aggregates WHERE snapshot_id=? ORDER BY model,currency', [snapshotId]).map(aggregateView);
}

export function listProviderBillSnapshots({ supplierAccountId = '', status = '', limit = 50, offset = 0 } = {}) {
  const conditions = []; const params = [];
  if (supplierAccountId) { conditions.push('supplier_account_id=?'); params.push(supplierAccountId); }
  if (status) { conditions.push('status=?'); params.push(status); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return {
    items: rows(`SELECT * FROM provider_bill_snapshots${where} ORDER BY fetched_at DESC,id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]).map(snapshotView),
    total: Number(row(`SELECT COUNT(*) n FROM provider_bill_snapshots${where}`, params)?.n || 0),
    limit, offset,
  };
}

export function getProviderBillSnapshot(snapshotId) {
  const snapshot = row('SELECT * FROM provider_bill_snapshots WHERE id=?', [String(snapshotId || '')]);
  if (!snapshot) throw errors.notFound('官方账单快照不存在', PROVIDER_BILL_ERROR_CODES.SNAPSHOT_NOT_FOUND);
  return { ...snapshotView(snapshot), rawPayload: parseJson(snapshot.raw_payload, null), aggregates: aggregatesOfSnapshot(snapshot.id) };
}

/** 最近状态：账号配置 + 凭据「有没有」+ 最近一次同步结果 + 最近快照列表（供 UI 轮询）。 */
export function providerBillingStatus({ supplierAccountId = '', limit = 20 } = {}) {
  const conditions = []; const params = [];
  if (supplierAccountId) { conditions.push('supplier_account_id=?'); params.push(supplierAccountId); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return {
    accounts: listBillingAccounts().filter((item) => !supplierAccountId || item.id === supplierAccountId),
    snapshots: rows(`SELECT * FROM provider_bill_snapshots${where} ORDER BY fetched_at DESC,id DESC LIMIT ?`, [...params, limit]).map(snapshotView),
    adapters: listBillingAdapters(),
    scheduler: providerBillingSchedulerState(),
  };
}

// ── 账期 ─────────────────────────────────────────────────────────────────────
/** 默认账期：[今天 UTC 零点 − periodDays, 今天 UTC 零点)。 */
export function defaultPeriodRange(account, { now = new Date() } = {}) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const days = Math.min(31, Math.max(1, Number(account?.billing_period_days || 1)));
  return { periodStart: new Date(end.getTime() - days * 86400000).toISOString(), periodEnd: end.toISOString() };
}

/** 立即（或定时）批量同步：逐账号顺序拉，单个失败不影响其他账号。 */
export async function syncAllProviderBills({ actorId = null, source = 'SCHEDULED', now = new Date(), periodStart, periodEnd, fetchImpl, timeoutMs } = {}) {
  const accounts = rows('SELECT * FROM supplier_accounts WHERE status=? AND billing_enabled=1 AND billing_adapter IS NOT NULL ORDER BY name COLLATE NOCASE,id', ['ACTIVE']);
  const results = [];
  for (const account of accounts) {
    const range = defaultPeriodRange(account, { now });
    try {
      const result = await syncProviderBill(account.id, {
        actorId, source, fetchImpl, timeoutMs,
        periodStart: periodStart || range.periodStart, periodEnd: periodEnd || range.periodEnd,
      });
      results.push({ supplierAccountId: account.id, code: account.code, status: result.status, snapshotId: result.snapshot?.id || null, idempotent: result.idempotent, error: result.error || null });
    } catch (error) {
      results.push({ supplierAccountId: account.id, code: account.code, status: 'SKIPPED', snapshotId: null, idempotent: false, error: { code: error?.code || 'PROVIDER_BILL_CONFIG_INVALID', message: String(error?.message || error) } });
    }
  }
  return { results, accountCount: accounts.length, fetchedCount: results.filter((item) => item.status === 'FETCHED').length, failedCount: results.filter((item) => item.status === 'FAILED').length };
}

// ── 日级定时任务（沿用 initializeXxx + unref 模式）──────────────────────────
const DEFAULT_INTERVAL_MS = 24 * 3600 * 1000;
let providerBillingTimer = null;
let providerBillingLastRun = null;
let providerBillingLastResult = null;

export function providerBillingSchedulerState() {
  return {
    running: Boolean(providerBillingTimer),
    intervalMs: Number(process.env.PROVIDER_BILLING_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    lastRunAt: providerBillingLastRun,
    lastResult: providerBillingLastResult,
    enabled: String(process.env.PROVIDER_BILLING_SCHEDULER_DISABLED || '').toLowerCase() !== 'true',
  };
}

async function runScheduledSync() {
  providerBillingLastRun = nowIso();
  try {
    providerBillingLastResult = await syncAllProviderBills({ source: 'SCHEDULED' });
  } catch (error) {
    providerBillingLastResult = { error: String(error?.message || error) };
  }
  return providerBillingLastResult;
}

/**
 * 挂日级定时任务。定时器 unref，绝不会因为它在跑而拖住进程退出；
 * 启动时错开 5s 做一次补拉（只补启用中的账号，默认拉「昨天」那一整天）。
 */
export function initializeProviderBillingScheduler({ intervalMs = Number(process.env.PROVIDER_BILLING_INTERVAL_MS || DEFAULT_INTERVAL_MS), runOnStart = true } = {}) {
  if (providerBillingTimer) return providerBillingTimer;
  if (String(process.env.PROVIDER_BILLING_SCHEDULER_DISABLED || '').toLowerCase() === 'true') return null;
  if (runOnStart) {
    const kickoff = setTimeout(() => { runScheduledSync().catch(() => {}); }, 5000);
    kickoff.unref?.();
  }
  providerBillingTimer = setInterval(() => { runScheduledSync().catch(() => {}); }, Math.max(60000, Number(intervalMs) || DEFAULT_INTERVAL_MS));
  providerBillingTimer.unref?.();
  return providerBillingTimer;
}

export function shutdownProviderBillingScheduler() {
  if (!providerBillingTimer) return false;
  clearInterval(providerBillingTimer);
  providerBillingTimer = null;
  return true;
}
