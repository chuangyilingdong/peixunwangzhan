const SESSION_KEY_PREFIX = 'ai-kids-platform.session.v1';

/**
 * 会话按应用分开存。
 * 三个前端在生产上同源（iicili.cyou 的 /、/admin/、/org/），共用同一个 localStorage key
 * 会让「谁最后登录谁把别人顶掉」：学生会话一写，平台端/机构端下一次请求就 401 被踢回登录页。
 * 按路径前缀分桶后，同一个浏览器可以同时开着学生端、平台端、机构端三个账号。
 */
export function sessionStorageKey() {
  let path = '/';
  try { path = String(window.location.pathname || '/'); } catch { /* 无 window：按官网/学生端处理 */ }
  if (path === '/admin' || path.startsWith('/admin/')) return `${SESSION_KEY_PREFIX}.admin`;
  if (path === '/org' || path.startsWith('/org/')) return `${SESSION_KEY_PREFIX}.org`;
  return `${SESSION_KEY_PREFIX}.student`;
}

export function readSession() {
  try {
    const stored = window.localStorage.getItem(sessionStorageKey());
    const session = stored ? JSON.parse(stored) : null;
    return session?.token ? session : null;
  } catch { return null; }
}

export function writeSession(value) {
  const session = { token: value.token, expiresAt: value.expiresAt, user: value.user, organization: value.organization || null };
  window.localStorage.setItem(sessionStorageKey(), JSON.stringify(session));
  return session;
}

export function clearSession() {
  try { window.localStorage.removeItem(sessionStorageKey()); } catch { /* storage is optional */ }
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatCredits(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}
