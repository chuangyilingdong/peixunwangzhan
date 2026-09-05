/**
 * P9-R03 平台管理员权限专项测试。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(path.join(tmpdir(), 'p9-r03-platform-permissions-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';

const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
async function expectError(fn, code, label) {
  try { await fn(); failures.push(`${label}: expected ${code}`); }
  catch (error) { check(error?.code === code, `${label}: got ${error?.code || error?.message}`); }
}
function auth(login, permissions) {
  return { user: { id: login, login, displayName: login, role: 'SUPER_ADMIN', orgId: null, permissions }, rawUser: { permissions: JSON.stringify(permissions) } };
}
function ctx(pathname, currentAuth, method = 'GET', body = {}) {
  return { pathname, method, body, auth: currentAuth, search: new URLSearchParams(), req: { socket: { remoteAddress: '127.0.0.1' } } };
}

try {
  const {
    PLATFORM_ADMIN_PERMISSIONS,
    platformPermissionForPathname,
    requirePlatformPermission,
    q,
    row,
  } = await import('../apps/server/src/lib.js');
  const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
  const { handleFeatureFlags } = await import('../apps/server/src/routes/featureFlags.js');

  const root = auth('root', []);
  const domains = [
    ['ADMIN_ORGANIZATIONS', '/api/admin/organizations'],
    ['ADMIN_COURSES', '/api/admin/course-series'],
    ['ADMIN_WORKS', '/api/admin/works'],
    ['ADMIN_BILLING', '/api/admin/billing/usage-overview'],
    ['ADMIN_CONTENT', '/api/admin/inbox'],
    ['ADMIN_ANALYTICS', '/api/admin/analytics/overview'],
    ['ADMIN_FEATURE_FLAGS', '/api/admin/feature-flags'],
    ['ADMIN_AUDIT', '/api/admin/audit-logs'],
  ];
  for (const [permission, pathname] of domains) {
    check(platformPermissionForPathname(pathname) === permission, `${pathname}: wrong domain mapping`);
    requirePlatformPermission(ctx(pathname, auth('operator', [permission])), permission);
    await expectError(() => requirePlatformPermission(ctx(pathname, auth('limited', [])), permission), 'PERMISSION_DENIED', `${permission} deny`);
  }
  check(PLATFORM_ADMIN_PERMISSIONS.length === 8, 'permission catalog must contain 8 domains');
  check(platformPermissionForPathname('/api/admin/unregistered') === 'ADMIN_CONTENT', 'unknown admin API must default to content domain');
  await expectError(() => requirePlatformPermission(ctx('/api/admin/unregistered', auth('limited', [])), 'ADMIN_CONTENT'), 'PERMISSION_DENIED', 'unknown admin API deny');
  requirePlatformPermission(ctx('/api/admin/organizations', root), 'ADMIN_ORGANIZATIONS');

  q("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES ('root','root','Root','SUPER_ADMIN','[]','x','ACTIVE',datetime('now'),datetime('now'))");
  q("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES ('operator','operator','Operator','SUPER_ADMIN',?, 'x','ACTIVE',datetime('now'),datetime('now'))", [JSON.stringify(PLATFORM_ADMIN_PERMISSIONS)]);
  q("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES ('solo','solo','Solo','SUPER_ADMIN',?, 'x','ACTIVE',datetime('now'),datetime('now'))", [JSON.stringify(PLATFORM_ADMIN_PERMISSIONS)]);

  const allowedOrganizations = await handleAdmin(ctx('/api/admin/organizations', auth('operator', ['ADMIN_ORGANIZATIONS'])));
  check(Array.isArray(allowedOrganizations.items), 'organization domain allow matrix failed');
  await expectError(() => handleAdmin(ctx('/api/admin/organizations', auth('operator', ['ADMIN_COURSES']))), 'PERMISSION_DENIED', 'cross-domain organization access');
  const flags = handleFeatureFlags(ctx('/api/admin/feature-flags', auth('operator', ['ADMIN_FEATURE_FLAGS'])));
  check(flags && Array.isArray(flags.items), 'feature flag allow matrix failed');
  await expectError(() => handleFeatureFlags(ctx('/api/admin/feature-flags', auth('operator', ['ADMIN_WORKS']))), 'PERMISSION_DENIED', 'cross-domain feature flag access');

  await handleAdmin(ctx('/api/admin/platform-admins/operator', root, 'PUT', { status: 'DISABLED' }));
  await handleAdmin(ctx('/api/admin/platform-admins/root', auth('solo', [...PLATFORM_ADMIN_PERMISSIONS]), 'PUT', { status: 'DISABLED' }));
  await expectError(() => handleAdmin(ctx('/api/admin/platform-admins/solo', auth('solo', [...PLATFORM_ADMIN_PERMISSIONS]), 'PUT', { permissions: [] })), 'LAST_SUPER_ADMIN_FORBIDDEN', 'last effective administrator permission clear');
  await expectError(() => handleAdmin(ctx('/api/admin/platform-admins/solo', auth('solo', [...PLATFORM_ADMIN_PERMISSIONS]), 'PUT', { status: 'DISABLED' })), 'ADMIN_SELF_DISABLE_FORBIDDEN', 'self disable');

  const audit = row("SELECT * FROM audit_logs WHERE action='PLATFORM_ADMIN_UPDATE' AND target_id='operator' ORDER BY created_at DESC LIMIT 1");
  check(Boolean(audit), 'platform admin update audit missing');
  check(String(audit?.after_data || '').includes('permissions'), 'platform admin audit does not include permission data');

  if (failures.length) throw new Error(failures.join('; '));
  console.log('P9-R03 platform permission matrix: 8 domain allow + 8 domain deny + cross-domain + admin guards + audit passed');
} finally {
  // Temporary directory is intentionally left for OS cleanup; no project or production data is touched.
}
