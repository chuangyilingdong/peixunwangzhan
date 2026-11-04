/**
 * RunningHub 账户余额（官方 accountStatus）。
 *
 * 为什么要单独一层：现有 `overview.js` 的 upstream-wallet 探的是 seedance/new-api 风格的
 * `GET /api/usage/wallet/`（字段 display_type/amount）；RunningHub 是
 * `POST /uc/openapi/accountStatus` + Bearer，字段 remainMoney/remainCoins/currency。
 * 硬套会让 7 条 RunningHub 渠道全部报「没有余额字段」，所以按域名分流。
 *
 * 口径（别改坏）：
 *   · 只用**渠道自己的 key**，不回落到文本渠道的 default key —— 那把不是 RunningHub 的，
 *     发到 RunningHub 既探不到余额，也等于把文本 Key 交给了别家；
 *   · 7 条渠道通常共用一把 Enterprise-Shared Key：按 key 指纹去重，只探一次；
 *   · 余额是团队账户级的，不是「每条渠道各一份」；
 *   · 60 秒缓存 + stale-while-revalidate：监控页 5 秒轮询，不能每 5 秒打上游；
 *   · 永不把 key 写进返回值/日志，上游 msg 里回显的 key 也要擦掉。
 */
import { createHash } from 'node:crypto';
import { arow } from '../lib.js';
import { getProviderApiKey } from './providerSecret.js';

const ACCOUNT_STATUS_PATH = '/uc/openapi/accountStatus';
const TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 60_000;

const isRunningHubHost = (hostname) => /(^|\.)runninghub\.(ai|cn)$/i.test(String(hostname || ''));

/** 这个渠道地址是不是 RunningHub（余额探测要按域名分流）。 */
export function isRunningHubEndpoint(endpoint) {
  try { return isRunningHubHost(new URL(String(endpoint || '').trim()).hostname); } catch { return false; }
}

function scrub(text, secret) {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('[已隐藏]');
  // RunningHub 的 Key 可能是 JWT；上游错误文案回显时也要擦
  return out
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '[已隐藏]')
    .slice(0, 240);
}

function fingerprint(secret) {
  return createHash('sha256').update(String(secret || '')).digest('hex').slice(0, 12);
}

function priceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 单次探测：POST /uc/openapi/accountStatus。永不抛错，失败返回 ok:false。 */
export async function probeRunningHubAccount({ endpoint, apiKey } = {}) {
  const raw = String(endpoint || '').trim();
  let url = null;
  try { url = new URL(raw); } catch { url = null; }
  if (!url || !isRunningHubHost(url.hostname)) return { ok: false, error: '不是 RunningHub 的调用地址' };
  if (!apiKey) return { ok: false, reason: 'NO_API_KEY', error: '该渠道未配置 API Key' };

  const target = `${url.origin}${ACCOUNT_STATUS_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apikey: apiKey }),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok) {
      const upstream = scrub(payload?.msg || payload?.message || '', apiKey);
      return { ok: false, error: response.status === 401 || response.status === 403
        ? `上游拒绝这把 API Key（HTTP ${response.status}）`
        : `上游返回 HTTP ${response.status}${upstream ? `：${upstream}` : ''}` };
    }
    // HTTP 200 也可能是业务错误：只认 code === 0
    if (payload && payload.code !== undefined && Number(payload.code) !== 0) {
      return { ok: false, error: `上游业务错误（code=${scrub(payload.code, apiKey)}）${payload.msg ? `：${scrub(payload.msg, apiKey)}` : ''}` };
    }
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : null;
    if (!data) return { ok: false, error: '上游响应里没有 data' };
    const amount = priceNumber(data.remainMoney);
    const currency = data.currency === null || data.currency === undefined ? null : String(data.currency).slice(0, 16);
    if (amount === null && priceNumber(data.remainCoins) === null) return { ok: false, error: '上游响应里没有余额字段（remainMoney / remainCoins 都没有）' };
    return {
      ok: true,
      amount,
      currency,
      currencyLike: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
      remainCoins: priceNumber(data.remainCoins),
      currentTaskCounts: priceNumber(data.currentTaskCounts),
      apiType: data.apiType ? String(data.apiType).slice(0, 32) : null,
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return { ok: false, error: aborted ? `上游 ${TIMEOUT_MS} 毫秒内没有响应` : `连不上上游（${scrub(error?.cause?.code || error?.message || '未知原因', apiKey)}）` };
  } finally {
    clearTimeout(timer);
  }
}

let cache = null; // { at, value }
let inflight = null;

async function loadBalance() {
  const row = await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1');
  let policy = {};
  try { policy = JSON.parse(row?.ai_provider_policy || '{}') || {}; } catch { policy = {}; }
  const channels = (Array.isArray(policy.channels) ? policy.channels : [])
    .filter((item) => String(item?.provider || '').toLowerCase() === 'runninghub' && String(item?.endpoint || '').trim());
  if (!channels.length) return { ok: true, fetchedAt: new Date().toISOString(), accounts: [], note: '没有配置 RunningHub 渠道' };

  // 按 key 去重：同一把 Enterprise-Shared Key 只探一次，列出共用它的渠道名
  const groups = new Map();
  for (const channel of channels) {
    const key = getProviderApiKey(channel.id) || '';
    const fp = key ? fingerprint(key) : 'NO_KEY';
    if (!groups.has(fp)) groups.set(fp, { key, fingerprint: fp, channels: [], endpoint: String(channel.endpoint || '').trim() });
    groups.get(fp).channels.push(String(channel.name || channel.id));
  }
  const accounts = await Promise.all([...groups.values()].map(async (group) => {
    if (!group.key) {
      return { fingerprint: group.fingerprint, channels: group.channels, ok: false, reason: 'NO_API_KEY', error: '这些渠道都没有保存 API Key' };
    }
    const result = await probeRunningHubAccount({ endpoint: group.endpoint, apiKey: group.key });
    return { fingerprint: group.fingerprint, channels: group.channels, ...result };
  }));
  return { ok: accounts.every((item) => item.ok), fetchedAt: new Date().toISOString(), accounts };
}

/** 60 秒缓存；`refresh=1` 强制刷新。并发请求共用同一次探测。 */
export async function getRunningHubBalance({ refresh = false } = {}) {
  const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
  if (!refresh && fresh) return { ...cache.value, cached: true, cachedAt: new Date(cache.at).toISOString() };
  if (!inflight) {
    inflight = (async () => {
      try {
        const value = await loadBalance();
        cache = { at: Date.now(), value };
        return value;
      } catch (error) {
        if (cache) return { ...cache.value, stale: true, error: scrub(error?.message || '余额刷新失败') };
        return { ok: false, fetchedAt: new Date().toISOString(), accounts: [], error: scrub(error?.message || '余额刷新失败') };
      } finally {
        inflight = null;
      }
    })();
  }
  const value = await inflight;
  return { ...value, cached: false };
}

/** 守卫用：清缓存。 */
export function resetRunningHubBalanceCache() {
  cache = null;
  inflight = null;
}
