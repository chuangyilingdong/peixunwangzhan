/**
 * 监控台「供应商钱包」：RunningHub 全球站 / RunningHub 国内站 / 星空无穷（xkwuai）。
 *
 * 口径（2026-11-04 用户确认）：
 *   · 三个来源都只读余额，不发任何生成请求；
 *   · RunningHub 两个站是同一套 `POST /uc/openapi/accountStatus`，差别只在站点和 Key；
 *   · xkwuai 是 New API 类中转站：访问令牌调 `GET /api/user/self` 取 quota，
 *     `quota_per_unit`（默认 500000）把 quota 换成美元；
 *   · 美元口径分两类（2026-11-04 用户确认）：
 *     - RunningHub 全球站是真美元，按 **1 USD = 7.2 元** 折算；
 *     - xkwuai 虽然显示 USD，但站内按人民币 1:1 计价，**不乘 7.2**（amount 即人民币）；
 *   · 原币金额始终保留，cny 是展示用的人民币口径；
 *   · Key/令牌存在 provider-secrets 的 `wallet-runninghub-cn` / `wallet-xkwuai`，
 *     永不回显、永不进日志；未配置时如实返回「未配置」而不是 0；
 *   · 60 秒缓存：监控页 5 秒轮询，不能每 5 秒打三家上游。
 */
import { getProviderApiKey } from './providerSecret.js';
import { getRunningHubBalance, probeRunningHubAccount } from './runningHubAccount.js';

const USD_CNY_RATE = 7.2;
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 9000;
const XKWUAI_BASE = 'https://www.xkwuai.cn';
const XKWUAI_STATUS_TTL_MS = 10 * 60_000;
const CN_SITE = 'https://www.runninghub.cn';
const GLOBAL_SITE = 'https://www.runninghub.ai';

const SECRET_CN = 'wallet-runninghub-cn';
const SECRET_XKWUAI = 'wallet-xkwuai';

function scrub(text) {
  return String(text ?? '')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '[已隐藏]')
    .slice(0, 240);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toCny(amount, currency) {
  const n = numberOrNull(amount);
  if (n === null) return null;
  return String(currency || '').toUpperCase() === 'USD' ? Math.round(n * USD_CNY_RATE * 100) / 100 : n;
}

/** xkwuai 的 quota 换算参数（quota_per_unit 可能被站方改过，不写死）。 */
let statusCache = null;

async function fetchXkwuaiUnit() {
  if (statusCache && Date.now() - statusCache.at < XKWUAI_STATUS_TTL_MS) return statusCache.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${XKWUAI_BASE}/api/status`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const quotaPerUnit = numberOrNull(data.quota_per_unit);
    const value = {
      quotaPerUnit: quotaPerUnit && quotaPerUnit > 0 ? quotaPerUnit : 500_000,
      displayType: data.quota_display_type ? String(data.quota_display_type).slice(0, 16) : null,
    };
    statusCache = { at: Date.now(), value };
    return value;
  } catch {
    // 状态接口失败不挡余额：按 New API 默认 500000 quota = 1 USD
    return { quotaPerUnit: 500_000, displayType: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 单次探测 xkwuai：GET /api/user/self。永不抛错。 */
export async function probeXkwuaiAccount({ token, userId } = {}) {
  if (!token) return { ok: false, reason: 'NO_API_KEY', error: '未配置访问令牌' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${XKWUAI_BASE}/api/user/self`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(userId ? { 'New-Api-User': String(userId) } : {}),
      },
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok) {
      return { ok: false, error: response.status === 401 || response.status === 403
        ? `访问令牌被拒绝（HTTP ${response.status}）`
        : `上游返回 HTTP ${response.status}` };
    }
    if (payload && payload.success === false) {
      return { ok: false, error: `上游业务错误${payload.message ? `：${scrub(payload.message)}` : ''}` };
    }
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : null;
    if (!data) return { ok: false, error: '上游响应里没有 data' };
    const quota = numberOrNull(data.quota);
    if (quota === null) return { ok: false, error: '上游响应里没有 quota' };
    const unit = await fetchXkwuaiUnit();
    const usd = Math.round((quota / unit.quotaPerUnit) * 1000) / 1000;
    return {
      ok: true,
      amount: usd,
      currency: 'USD',
      quota,
      usedQuota: numberOrNull(data.used_quota),
      userName: data.username ? String(data.username).slice(0, 64) : null,
      quotaPerUnit: unit.quotaPerUnit,
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return { ok: false, error: aborted ? `上游 ${TIMEOUT_MS} 毫秒内没有响应` : `连不上上游（${scrub(error?.cause?.code || error?.message || '未知原因')}）` };
  } finally {
    clearTimeout(timer);
  }
}

function parseXkwuaiSecret(raw) {
  const text = String(raw || '').trim();
  if (!text) return { token: '', userId: '' };
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return { token: String(parsed.token || '').trim(), userId: String(parsed.userId || '').trim() };
    } catch { /* 不是 JSON 就当成裸令牌 */ }
  }
  return { token: text, userId: '' };
}

async function runningHubSource({ id, name, site, account, configured }) {
  if (!configured) {
    return { id, name, site, ok: false, reason: 'NOT_CONFIGURED', error: '未配置 Key', amount: null, currency: null, cny: null };
  }
  if (!account) {
    return { id, name, site, ok: false, error: '上游没有返回账户信息', amount: null, currency: null, cny: null };
  }
  return {
    id,
    name,
    site,
    ok: Boolean(account.ok),
    error: account.ok ? null : (account.error || '余额读取失败'),
    amount: numberOrNull(account.amount),
    currency: account.currency || null,
    cny: account.ok ? toCny(account.amount, account.currency) : null,
    remainCoins: numberOrNull(account.remainCoins),
    currentTaskCounts: numberOrNull(account.currentTaskCounts),
    apiType: account.apiType || null,
    channels: Array.isArray(account.channels) ? account.channels : [],
  };
}

let cache = null; // { at, value }
let inflight = null;

async function loadWallets({ runningHub }) {
  const fetchedAt = new Date().toISOString();
  const global = await runningHub;
  const globalAccount = global?.accounts?.find((item) => item.ok) || global?.accounts?.[0] || null;

  const cnKey = getProviderApiKey(SECRET_CN) || '';
  const xk = parseXkwuaiSecret(getProviderApiKey(SECRET_XKWUAI) || '');

  const [cn, xkwuai] = await Promise.all([
    cnKey ? probeRunningHubAccount({ endpoint: CN_SITE, apiKey: cnKey }) : null,
    xk.token ? probeXkwuaiAccount({ token: xk.token, userId: xk.userId }) : null,
  ]);

  const sources = [
    await runningHubSource({ id: 'runninghub-global', name: 'RunningHub 全球站', site: GLOBAL_SITE, account: globalAccount, configured: Boolean(globalAccount) }),
    await runningHubSource({ id: 'runninghub-cn', name: 'RunningHub 国内站', site: CN_SITE, account: cn, configured: Boolean(cnKey) }),
  ];
  sources.push({
    id: 'xkwuai',
    name: '星空无穷（xkwuai）',
    site: `${XKWUAI_BASE}/dashboard/overview`,
    ok: Boolean(xkwuai?.ok),
    error: xkwuai ? (xkwuai.ok ? null : xkwuai.error) : '未配置访问令牌',
    reason: xkwuai ? undefined : 'NOT_CONFIGURED',
    amount: numberOrNull(xkwuai?.amount),
    currency: xkwuai?.currency || null,
    // xkwuai 的 USD 是站内计价单位，按人民币 1:1 记（用户口径）
    cny: xkwuai?.ok ? numberOrNull(xkwuai.amount) : null,
    quota: numberOrNull(xkwuai?.quota),
    usedQuota: numberOrNull(xkwuai?.usedQuota),
    userName: xkwuai?.userName || null,
  });

  return {
    ok: sources.some((item) => item.ok),
    fetchedAt,
    fx: { usdCny: USD_CNY_RATE },
    sources,
  };
}

/** 60 秒缓存；`refresh=1` 强制刷新。RunningHub 全球站的探测自带缓存，这里只补另外两家。 */
export async function getWalletBalances({ refresh = false, runningHub = null } = {}) {
  const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
  if (!refresh && fresh) return { ...cache.value, cached: true, cachedAt: new Date(cache.at).toISOString() };
  const globalPromise = runningHub || getRunningHubBalance({ refresh: false });
  if (!inflight) {
    inflight = (async () => {
      try {
        const value = await loadWallets({ runningHub: globalPromise });
        cache = { at: Date.now(), value };
        return value;
      } catch (error) {
        if (cache) return { ...cache.value, stale: true, error: scrub(error?.message || '钱包刷新失败') };
        return { ok: false, fetchedAt: new Date().toISOString(), fx: { usdCny: USD_CNY_RATE }, sources: [], error: scrub(error?.message || '钱包刷新失败') };
      } finally {
        inflight = null;
      }
    })();
  }
  const value = await inflight;
  return { ...value, cached: false };
}

/** 守卫用：清缓存。 */
export function resetWalletBalanceCache() {
  cache = null;
  inflight = null;
  statusCache = null;
}
