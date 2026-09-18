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
    UNREGISTERED_PLATFORM_PERMISSION,
    platformPermissionForPathname,
    requirePlatformPermission,
    q,
    row,
  } = await import('../apps/server/src/lib.js');
  const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');

  const root = auth('root', []);
  const domains = [
    ['ADMIN_ORGANIZATIONS', '/api/admin/organizations'],
    ['ADMIN_COURSES', '/api/admin/course-series'],
    ['ADMIN_WORKS', '/api/admin/works'],
    ['ADMIN_BILLING', '/api/admin/billing/usage-overview'],
    ['ADMIN_CONTENT', '/api/admin/inbox'],
    // 官网匿名统计已整体下线（2026-09-16）：ADMIN_ANALYTICS 这个域现在由工作台/总览接口代表。
    ['ADMIN_ANALYTICS', '/api/admin/dashboard'],
    ['ADMIN_AUDIT', '/api/admin/audit-logs'],
  ];
  for (const [permission, pathname] of domains) {
    check(platformPermissionForPathname(pathname) === permission, `${pathname}: wrong domain mapping`);
    requirePlatformPermission(ctx(pathname, auth('operator', [permission])), permission);
    await expectError(() => requirePlatformPermission(ctx(pathname, auth('limited', [])), permission), 'PERMISSION_DENIED', `${permission} deny`);
  }
  check(PLATFORM_ADMIN_PERMISSIONS.length === 7, 'permission catalog must contain 7 domains');
  check(platformPermissionForPathname('/api/admin/unregistered') === UNREGISTERED_PLATFORM_PERMISSION, 'unregistered admin API must not fall back to a business domain');
  await expectError(() => requirePlatformPermission(ctx('/api/admin/unregistered', auth('limited', [])), UNREGISTERED_PLATFORM_PERMISSION), 'PLATFORM_ENDPOINT_UNREGISTERED', 'unregistered admin API deny');
  requirePlatformPermission(ctx('/api/admin/unregistered', root), UNREGISTERED_PLATFORM_PERMISSION);
  check(platformPermissionForPathname('/api/admin/notification-queue/summary') === 'ADMIN_CONTENT', 'notification endpoints must be explicitly registered');
  // 2026-09-18：供应商账单两条线整体下线（用户口径），相关断言随之下线 —— 这是口径变更，不是测试漂移。
  for (const pathname of ['/api/admin/compute-attempts', '/api/admin/compute-gateway/channels', '/api/admin/compute-pricing', '/api/admin/compute-pools/reconciliation', '/api/admin/financial-reporting', '/api/admin/authorizations', '/api/admin/license-purchases', '/api/admin/license-reports']) {
    check(platformPermissionForPathname(pathname) === 'ADMIN_BILLING', `${pathname}: finance endpoint must use billing domain`);
    requirePlatformPermission(ctx(pathname, auth('finance', ['ADMIN_BILLING'])), 'ADMIN_BILLING');
    await expectError(() => requirePlatformPermission(ctx(pathname, auth('courses-only', ['ADMIN_COURSES'])), 'ADMIN_BILLING'), 'PERMISSION_DENIED', `${pathname} cross-domain deny`);
  }
  check(platformPermissionForPathname('/api/admin/course-lessons') === 'ADMIN_COURSES', 'course administration must remain in courses domain');
  requirePlatformPermission(ctx('/api/admin/organizations', root), 'ADMIN_ORGANIZATIONS');

  q("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES ('root','root','Root','SUPER_ADMIN','[]','x','ACTIVE',datetime('now'),datetime('now'))");
  q("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES ('operator','operator','Operator','SUPER_ADMIN',?, 'x','ACTIVE',datetime('now'),datetime('now'))", [JSON.stringify(PLATFORM_ADMIN_PERMISSIONS)]);
  q("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES ('solo','solo','Solo','SUPER_ADMIN',?, 'x','ACTIVE',datetime('now'),datetime('now'))", [JSON.stringify(PLATFORM_ADMIN_PERMISSIONS)]);

  const allowedOrganizations = await handleAdmin(ctx('/api/admin/organizations', auth('operator', ['ADMIN_ORGANIZATIONS'])));
  check(Array.isArray(allowedOrganizations.items), 'organization domain allow matrix failed');
  await expectError(() => handleAdmin(ctx('/api/admin/organizations', auth('operator', ['ADMIN_COURSES']))), 'PERMISSION_DENIED', 'cross-domain organization access');

  const orgOptions = await handleAdmin(ctx('/api/admin/organizations/options', auth('operator', ['ADMIN_ORGANIZATIONS'])));
  check(Array.isArray(orgOptions.items) && orgOptions.items.every((item) => item.id && item.name && item.status), 'organization options should return compact id/name/status rows');
  check(Number(orgOptions.total) >= orgOptions.items.length, 'organization options should expose total for truncation awareness');
  await expectError(() => handleAdmin(ctx('/api/admin/organizations/options', auth('operator', ['ADMIN_COURSES']))), 'PERMISSION_DENIED', 'organization options cross-domain access');

  const financeOnly = auth('finance-only', ['ADMIN_BILLING']);
  const coursesOnly = auth('courses-only-live', ['ADMIN_COURSES']);
  const organizationsOnly = auth('organizations-only-live', ['ADMIN_ORGANIZATIONS']);
  const financeInventory = await handleAdmin(ctx('/api/admin/authorizations', financeOnly));
  check(Array.isArray(financeInventory.items) && Array.isArray(financeInventory.organizations), 'billing admin must read authorization purchase inventory');
  await expectError(() => handleAdmin(ctx('/api/admin/authorizations', coursesOnly)), 'PERMISSION_DENIED', 'courses-only authorization inventory deny');
  q("INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES ('org-p9-billing','P9 Billing Org','ACTIVE',datetime('now'),datetime('now','+1 year'),0,datetime('now'),datetime('now'))");
  q("INSERT INTO course_series(id,title,owner_type,status,stock_total,created_at,updated_at) VALUES ('series-p9-billing','P9 Billing Series','PLATFORM','PUBLISHED',10,datetime('now'),datetime('now'))");
  const purchaseBody = { seriesId: 'series-p9-billing', orgId: 'org-p9-billing', additionalQuota: 2, amountMinor: 1200, currency: 'CNY', paymentStatus: 'PAID', orderNo: 'P9-ORDER', contractNo: 'P9-CONTRACT', idempotencyKey: 'p9-license-purchase' };
  const purchased = await handleAdmin(ctx('/api/admin/license-purchases/append', financeOnly, 'POST', purchaseBody));
  check(purchased.assignment?.quotaTotal === 2, 'billing-only admin must append license purchase');
  await expectError(() => handleAdmin(ctx('/api/admin/license-purchases/append', coursesOnly, 'POST', { ...purchaseBody, idempotencyKey: 'p9-course-denied' })), 'PERMISSION_DENIED', 'courses-only purchase deny');
  await expectError(() => handleAdmin(ctx('/api/admin/license-purchases/append', organizationsOnly, 'POST', { ...purchaseBody, idempotencyKey: 'p9-org-denied' })), 'PERMISSION_DENIED', 'organizations-only purchase deny');
  const courseList = await handleAdmin(ctx('/api/admin/course-series', coursesOnly));
  check(Array.isArray(courseList.items), 'courses-only admin must retain course read permission');
  const organizationDetail = await handleAdmin(ctx('/api/admin/organizations/org-p9-billing/detail', organizationsOnly));
  check(Array.isArray(organizationDetail.courseAssignments), 'organization admin must retain non-financial assignment summary');
  check(!JSON.stringify(organizationDetail).includes('purchaseBatches') && !JSON.stringify(organizationDetail).includes('P9-ORDER') && !JSON.stringify(organizationDetail).includes('P9-CONTRACT'), 'organization detail must not expose purchase amounts or commercial references');

  await handleAdmin(ctx('/api/admin/platform-admins/operator', root, 'PUT', { status: 'DISABLED' }));
  await handleAdmin(ctx('/api/admin/platform-admins/root', auth('solo', [...PLATFORM_ADMIN_PERMISSIONS]), 'PUT', { status: 'DISABLED' }));
  await expectError(() => handleAdmin(ctx('/api/admin/platform-admins/solo', auth('solo', [...PLATFORM_ADMIN_PERMISSIONS]), 'PUT', { permissions: [] })), 'LAST_SUPER_ADMIN_FORBIDDEN', 'last effective administrator permission clear');
  await expectError(() => handleAdmin(ctx('/api/admin/platform-admins/solo', auth('solo', [...PLATFORM_ADMIN_PERMISSIONS]), 'PUT', { status: 'DISABLED' })), 'ADMIN_SELF_DISABLE_FORBIDDEN', 'self disable');

  const audit = row("SELECT * FROM audit_logs WHERE action='PLATFORM_ADMIN_UPDATE' AND target_id='operator' ORDER BY created_at DESC LIMIT 1");
  check(Boolean(audit), 'platform admin update audit missing');
  check(String(audit?.after_data || '').includes('permissions'), 'platform admin audit does not include permission data');

  if (failures.length) throw new Error(failures.join('; '));
  console.log('P9-R03 platform permission matrix: 7 domain allow + 7 domain deny + cross-domain + admin guards + audit passed');
} finally {
  // Temporary directory is intentionally left for OS cleanup; no project or production data is touched.
}
