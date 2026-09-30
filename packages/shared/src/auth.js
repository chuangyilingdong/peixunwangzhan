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

/**
 * 按**应用**读会话（不按当前路径）。
 * 为什么要它：老师的「画布备课」挂在网站域（`/learn/prep/<课时 id>`，见 CanvasPrepPage），
 * 而 `readSession()` 是按**当前路径**分桶的 —— 在 `/learn/...` 下它只会读学生那份会话，
 * 老师自然是 null。这一条让那个页面能明确去读**机构端**那份会话。
 * @param {'student'|'org'|'admin'} app
 */
export function readAppSession(app) {
  try {
    const stored = window.localStorage.getItem(`${SESSION_KEY_PREFIX}.${app}`);
    const session = stored ? JSON.parse(stored) : null;
    return session?.token ? session : null;
  } catch { return null; }
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

/**
 * 算力口径的金额格式化：入参是**分**（算力池账本 cost_fen 就是分），输出「¥x.xx」。
 * 2026-09-13（P4 删积分）：积分单位废弃后，机构端/平台端的消耗一律用「元」显示。
 */
export function formatYuan(fen) {
  return `¥${(Number(fen || 0) / 100).toFixed(2)}`;
}
