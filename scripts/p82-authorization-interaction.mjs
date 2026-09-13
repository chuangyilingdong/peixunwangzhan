import assert from 'node:assert/strict';
import fs from 'node:fs';

await import('./p77-organizations-authorization.mjs');

const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { q, row } = await import('../apps/server/src/lib.js');
const ctx = (pathname, method = 'GET', body = null) => ({
  pathname, method, body, search: new URLSearchParams(),
  req: { socket: { remoteAddress: '127.0.0.1' } },
  auth: { user: { id: 'root', login: 'root', role: 'SUPER_ADMIN', orgId: null, permissions: [] }, rawUser: { permissions: '[]' } },
});
const admin = (path, method, body) => handleAdmin(ctx('/api/admin' + path, method, body));
const rejects = async (fn, code) => assert.rejects(fn, (error) => error.code === code, code);
const orgA = row("SELECT id FROM organizations WHERE name='A'");
const orgB = row("SELECT id FROM organizations WHERE name='B'");
assert.ok(orgA?.id && orgB?.id);

await rejects(
  () => admin('/course-series/p77/assignments', 'POST', { orgIds: [orgA.id, orgB.id], quotaTotal: 2 }),
  'INVALID_ORG_IDS',
);

const compatible = await admin('/course-series/p77/assignments', 'POST', { orgId: orgA.id, validityDays: 400 });
assert.equal(compatible.assignedCount, 1);
const beforeAppend = row("SELECT * FROM course_assignments WHERE series_id='p77' AND org_id=?", [orgA.id]);
const appended = await admin('/course-series/p77/assignments/append', 'POST', { orgId: orgA.id, additionalQuota: 1 });
assert.equal(appended.assignment.quotaTotal, 3);
assert.equal(appended.assignment.quotaUsed, 2);
assert.equal(appended.assignment.remaining, 1);
assert.equal(appended.assignment.expiresAt, beforeAppend.expires_at);

const requestedExpiry = new Date(Date.now() + 30 * 86400000).toISOString();
const validity = await admin('/course-series/p77/assignments/validity', 'PUT', { orgId: orgA.id, expiresAt: requestedExpiry });
assert.equal(validity.assignment.quotaTotal, 3);
assert.equal(validity.assignment.quotaUsed, 2);
assert.equal(validity.assignment.remaining, 1);
assert.equal(validity.assignment.expiresAt, requestedExpiry);
q("UPDATE course_assignments SET status='REVOKED' WHERE series_id='p77' AND org_id=?", [orgB.id]);
await rejects(
  () => admin('/course-series/p77/assignments/validity', 'PUT', { orgId: orgB.id, expiresAt: requestedExpiry }),
  'ASSIGNMENT_NOT_ACTIVE',
);

const appendAudit = row("SELECT * FROM audit_logs WHERE action='COURSE_ASSIGNMENT_QUOTA_APPEND' ORDER BY created_at DESC LIMIT 1");
const validityAudit = row("SELECT * FROM audit_logs WHERE action='COURSE_ASSIGNMENT_VALIDITY_UPDATE' ORDER BY created_at DESC LIMIT 1");
assert.equal(appendAudit.org_id, orgA.id);
assert.deepEqual(
  [JSON.parse(appendAudit.before_data).quotaTotal, JSON.parse(appendAudit.after_data).quotaTotal],
  [2, 3],
);
assert.equal(JSON.parse(appendAudit.after_data).additionalQuota, 1);
assert.equal(validityAudit.org_id, orgA.id);
assert.equal(JSON.parse(validityAudit.before_data).quotaTotal, JSON.parse(validityAudit.after_data).quotaTotal);
assert.notEqual(JSON.parse(validityAudit.before_data).expiresAt, JSON.parse(validityAudit.after_data).expiresAt);

const authorizationPage = fs.readFileSync(new URL('../apps/admin/src/pages/Organizations.jsx', import.meta.url), 'utf8');
assert.match(authorizationPage, /SearchSelect ariaLabel="搜索课包" value=\{seriesId\}/);
assert.match(authorizationPage, /SearchSelect ariaLabel="搜索机构" value=\{orgId\}/);
assert.equal((authorizationPage.match(/ariaLabel="搜索课包"/g) || []).length, 1);
assert.equal((authorizationPage.match(/ariaLabel="搜索机构"/g) || []).length, 1);
assert.match(authorizationPage, /assignments\/append/);
assert.match(authorizationPage, /assignments\/validity/);
assert.match(authorizationPage, /deepLink\.get\('seriesId'\)/);
assert.match(authorizationPage, /deepLink\.get\('orgId'\)/);
assert.doesNotMatch(authorizationPage, /select multiple|可多选|保存购买 \/ 续期/);

console.log('P82 passed: single-organization guard, orgId compatibility, explicit append/validity actions, preserved independent values, before/after audit, searchable single-select UI and deep links');
