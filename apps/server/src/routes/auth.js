import { randomBytes } from 'node:crypto';
import {
  audit,
  clearAuthCookie,
  errors,
  nonEmptyString,
  normalizeOrg,
  normalizeUser,
  nowIso,
  q,
  requireAuth,
  row,
  setAuthCookie,
  tokenExpiresAt,
  tokenHash,
  verifyPassword,
  id,
  assertUserAccountAvailable,
} from '../lib.js';

const CLIENT_TYPES = new Set(['web', 'admin', 'org', 'student']);

function loginAuditContext(ctx, user) {
  return {
    ...ctx,
    auth: {
      user: normalizeUser(user, { includeAuthMeta: true }),
    },
  };
}

export async function handleAuth(ctx) {
  const { pathname, method } = ctx;

  if (pathname === '/api/auth/login' && method === 'POST') {
    const login = nonEmptyString(ctx.body?.login, '登录名', { max: 100 });
    const password = nonEmptyString(ctx.body?.password, '密码', { max: 500 });
    const suppliedClientType = String(ctx.body?.clientType || 'web').trim().toLowerCase();
    const clientType = CLIENT_TYPES.has(suppliedClientType) ? suppliedClientType : 'web';
    const user = row('SELECT * FROM users WHERE login = ? AND deleted_at IS NULL', [login]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw errors.unauthorized('登录名或密码错误', 'INVALID_CREDENTIALS');
    }
    const org = user.org_id ? row('SELECT * FROM organizations WHERE id = ?', [user.org_id]) : null;
    assertUserAccountAvailable(user, org);

    const now = nowIso();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = tokenExpiresAt();
    // P0 uses a single active session per account so a later login deterministically
    // supersedes any previous browser/client session.
    q('UPDATE sessions SET superseded_at = ? WHERE user_id = ? AND superseded_at IS NULL', [now, user.id]);
    q(
      `INSERT INTO sessions(id,token_hash,user_id,role,org_id,client_type,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id('session'), tokenHash(token), user.id, user.role, user.org_id || null, clientType, now, expiresAt],
    );
    ctx.setCookie = setAuthCookie(token);
    audit(loginAuditContext(ctx, user), 'AUTH_LOGIN', 'USER', user.id, null, { clientType });
    return {
      token,
      expiresAt,
      user: normalizeUser(user, { includeAuthMeta: true }),
      organization: normalizeOrg(org),
    };
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const auth = requireAuth(ctx);
    q('UPDATE sessions SET superseded_at = COALESCE(superseded_at, ?) WHERE id = ?', [nowIso(), auth.session.id]);
    ctx.setCookie = clearAuthCookie();
    audit(ctx, 'AUTH_LOGOUT', 'USER', auth.user.id);
    return { loggedOut: true };
  }

  if (pathname === '/api/me' && method === 'GET') {
    const auth = requireAuth(ctx);
    return {
      ...auth.user,
      organization: normalizeOrg(auth.org),
      session: {
        id: auth.session.id,
        clientType: auth.session.client_type,
        expiresAt: auth.session.expires_at,
      },
    };
  }

  if (pathname === '/api/me/display-name' && method === 'PUT') {
    const auth = requireAuth(ctx);
    const displayName = nonEmptyString(ctx.body?.displayName, '显示名称', { max: 60 });
    const before = { displayName: auth.user.displayName };
    q('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', [displayName, nowIso(), auth.user.id]);
    audit(ctx, 'USER_UPDATE_DISPLAY_NAME', 'USER', auth.user.id, before, { displayName });
    return normalizeUser(row('SELECT * FROM users WHERE id = ?', [auth.user.id]), { includeAuthMeta: true });
  }

  return null;
}
