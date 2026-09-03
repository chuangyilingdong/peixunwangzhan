const CONSENT_KEY = 'ai-magic-analytics-consent';
const ANONYMOUS_ID_KEY = 'ai-magic-anonymous-id';
const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE ? String(import.meta.env.VITE_API_BASE).replace(/\/$/, '') : '/api');

function browserStorage() {
  try { return window.localStorage; } catch { return null; }
}
export function getAnalyticsConsent() {
  const value = browserStorage()?.getItem(CONSENT_KEY);
  return value === 'granted' ? true : value === 'denied' ? false : null;
}
export function setAnalyticsConsent(value) {
  browserStorage()?.setItem(CONSENT_KEY, value ? 'granted' : 'denied');
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
