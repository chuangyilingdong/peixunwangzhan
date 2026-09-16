const CONSENT_KEY = 'ai-magic-analytics-consent';
const ANONYMOUS_ID_KEY = 'ai-magic-anonymous-id';
const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE ? String(import.meta.env.VITE_API_BASE).replace(/\/$/, '') : '/api');

function browserStorage() {
  try { return window.localStorage; } catch { return null; }
}
/**
 * 是否允许发送匿名统计。
 *
 * ⚠️ 同意横幅已按用户要求删除（2026-09-16），所以现在**没有入口**把这里写成 granted：
 *    新访客一律拿不到同意 → `trackAnalytics` 直接返回，官网不发任何匿名事件。
 *    这是刻意的默认（宁可不统计，也不在没同意的情况下上报）；
 *    以前点过「同意匿名分析」的浏览器里留着 granted，仍会照旧上报。
 *    真要重新开统计，得先决定隐私口径（回到横幅，或改成无需同意的口径），别偷偷把这里改成默认 true。
 */
export function getAnalyticsConsent() {
  const value = browserStorage()?.getItem(CONSENT_KEY);
  return value === 'granted' ? true : value === 'denied' ? false : null;
}
function anonymousId() {
  const storage = browserStorage();
  if (!storage) return null;
  let value = storage.getItem(ANONYMOUS_ID_KEY);
  if (!value) { value = globalThis.crypto?.randomUUID?.() || `anon_${Date.now()}_${Math.random().toString(36).slice(2)}`; storage.setItem(ANONYMOUS_ID_KEY, value); }
  return value;
}
export function trackAnalytics(eventName, metadata = {}) {
  if (getAnalyticsConsent() !== true) return;
  const id = anonymousId();
  if (!id) return;
  const body = JSON.stringify({ analyticsConsent: true, anonymousId: id, eventName, path: `${window.location.pathname}`, metadata });
  try {
    fetch(`${API_BASE}/public/analytics/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch { /* analytics must never affect the product path */ }
}
