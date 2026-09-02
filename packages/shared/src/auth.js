const SESSION_KEY = 'ai-kids-platform.session.v1';

export function readSession() {
  try {
    const stored = window.localStorage.getItem(SESSION_KEY);
    const session = stored ? JSON.parse(stored) : null;
    return session?.token ? session : null;
  } catch { return null; }
}

export function writeSession(value) {
  const session = { token: value.token, expiresAt: value.expiresAt, user: value.user, organization: value.organization || null };
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function clearSession() {
  try { window.localStorage.removeItem(SESSION_KEY); } catch { /* storage is optional */ }
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatCredits(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}
