import assert from 'node:assert/strict';
import fs from 'node:fs';

await import('./p77-organizations-authorization.mjs');

const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { handleOrg } = await import('../apps/server/src/routes/orgAdmin.js');
const { q, row, rows } = await import('../apps/server/src/lib.js');
const ctx = (pathname, method = 'GET', body = null) => ({
  pathname, method, body, search: new URLSearchParams(),
  req: { socket: { remoteAddress: '127.0.0.1' } },
  auth: { user: { id: 'root', login: 'root', role: 'SUPER_ADMIN', orgId: null, permissions: [] }, rawUser: { permissions: '[]' } },
});
const admin = (path, method, body) => handleAdmin(ctx('/api/admin' + path, method, body));
const org = (orgId, path, method, body) => handleOrg({ ...ctx('/api/org' + path, method, body), auth: { user: { id: 'org-admin', login: 'org-admin', role: 'ORG_ADMIN', orgId, permissions: [] }, rawUser: { permissions: '[]' } } });
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
const appendPurchase = { amountMinor: 12345, currency: 'CNY', paymentStatus: 'PAID', orderNo: 'P82-O-1', contractNo: 'P82-C-1', idempotencyKey: 'p82-append-1' };
const appended = await admin('/course-series/p77/assignments/append', 'POST', { orgId: orgA.id, additionalQuota: 1, ...appendPurchase });
assert.equal(appended.assignment.quotaTotal, 3);
assert.equal(appended.assignment.quotaUsed, 2);
assert.equal(appended.assignment.remaining, 1);
assert.equal(appended.assignment.expiresAt, beforeAppend.expires_at);
const replayed = await admin('/course-series/p77/assignments/append', 'POST', { orgId: orgA.id, additionalQuota: 1, ...appendPurchase });
assert.equal(replayed.assignment.quotaTotal, 3);
assert.equal(row("SELECT COUNT(*) n FROM license_purchase_batches WHERE idempotency_key='p82-append-1'").n, 1);

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

const originalGrant = row(`SELECT grant.* FROM student_course_grants grant
  JOIN users student ON student.id=grant.student_id AND student.org_id=grant.org_id
  WHERE grant.org_id=? AND grant.series_id='p77' AND grant.revoked_at IS NULL ORDER BY grant.granted_at LIMIT 1`, [orgA.id]);
assert.ok(originalGrant?.id);
const grantRevoke = await admin(`/course-grants/${originalGrant.id}/revoke`, 'POST', { reason: 'P82 撤销重授权回归' });
assert.equal(grantRevoke.quotaRefunded, true);
const afterGrantRevoke = row("SELECT * FROM course_assignments WHERE series_id='p77' AND org_id=?", [orgA.id]);
assert.equal(afterGrantRevoke.quota_used, 1);
await admin('/course-series/p77/assignments/revoke', 'POST', { orgId: orgA.id });
const afterAssignmentRevoke = row("SELECT * FROM course_assignments WHERE series_id='p77' AND org_id=?", [orgA.id]);
assert.equal(afterAssignmentRevoke.status, 'REVOKED');
assert.equal(afterAssignmentRevoke.quota_total, afterAssignmentRevoke.quota_used);
assert.equal(row("SELECT COUNT(*) n FROM license_purchase_batches WHERE assignment_id=? AND status='ACTIVE'", [afterAssignmentRevoke.id]).n, 0);
assert.ok(row("SELECT COUNT(*) n FROM license_revenue_events WHERE assignment_id=?", [afterAssignmentRevoke.id]).n >= 3);

const reauthorizePurchase = { seriesId: 'p77', orgId: orgA.id, additionalQuota: 1, amountMinor: 2222, currency: 'CNY', paymentStatus: 'PAID', orderNo: 'P82-REAUTH-O', contractNo: 'P82-REAUTH-C', idempotencyKey: 'p82-reauthorize' };
const reauthorized = await admin('/license-purchases/append', 'POST', reauthorizePurchase);
assert.equal(reauthorized.assignment.quotaTotal, 2);
assert.equal(reauthorized.assignment.quotaUsed, 1);
assert.equal(reauthorized.assignment.remaining, 1);
const newBatch = row("SELECT * FROM license_purchase_batches WHERE idempotency_key='p82-reauthorize'");
assert.equal(newBatch.status, 'ACTIVE');
const regrant = await org(orgA.id, '/course-grants', 'POST', { seriesId: 'p77', studentIds: [originalGrant.student_id] });
assert.equal(regrant.granted, 1);
const stableGrant = row('SELECT * FROM student_course_grants WHERE id=?', [originalGrant.id]);
assert.equal(stableGrant.id, originalGrant.id);
const latestGrantAllocation = row(`SELECT allocation.purchase_batch_id FROM license_revenue_events event
  JOIN license_revenue_allocations allocation ON allocation.revenue_event_id=event.id
  WHERE event.grant_id=? AND event.event_type='GRANT' ORDER BY event.occurred_at DESC,event.created_at DESC,event.id DESC LIMIT 1`, [originalGrant.id]);
assert.equal(latestGrantAllocation.purchase_batch_id, newBatch.id);
const activeNet = Number(row(`SELECT COALESCE(SUM(batch.quantity),0)-COALESCE(SUM((SELECT COALESCE(SUM(allocation.quantity),0)
  FROM license_revenue_allocations allocation WHERE allocation.purchase_batch_id=batch.id)),0) remaining
  FROM license_purchase_batches batch WHERE batch.assignment_id=? AND batch.status='ACTIVE'`, [afterAssignmentRevoke.id]).remaining);
const finalAssignment = row('SELECT * FROM course_assignments WHERE id=?', [afterAssignmentRevoke.id]);
assert.equal(activeNet, finalAssignment.quota_total - finalAssignment.quota_used);
assert.equal(rows("SELECT * FROM license_revenue_events WHERE grant_id=? AND event_type='GRANT'", [originalGrant.id]).length, 2);

const authorizationPage = fs.readFileSync(new URL('../apps/admin/src/pages/Organizations.jsx', import.meta.url), 'utf8');
assert.match(authorizationPage, /SearchSelect ariaLabel="搜索课包" value=\{seriesId\}/);
assert.match(authorizationPage, /SearchSelect ariaLabel="搜索机构" value=\{orgId\}/);
assert.equal((authorizationPage.match(/ariaLabel="搜索课包"/g) || []).length, 1);
assert.equal((authorizationPage.match(/ariaLabel="搜索机构"/g) || []).length, 1);
assert.match(authorizationPage, /license-purchases\/append/);
assert.match(authorizationPage, /assignments\/validity/);
assert.match(authorizationPage, /deepLink\.get\('seriesId'\)/);
assert.match(authorizationPage, /deepLink\.get\('orgId'\)/);
assert.match(authorizationPage, /实际成交总额（元）/);
assert.match(authorizationPage, /paymentStatus: 'PAID'/);
assert.match(authorizationPage, /收款状态<input value="已收款" readOnly/);
assert.doesNotMatch(authorizationPage, /<option value="(?:PARTIAL|UNPAID|REFUNDED)"/);
assert.match(authorizationPage, /订单号/);
assert.match(authorizationPage, /合同号/);
assert.match(authorizationPage, /未知（历史导入）/);
assert.doesNotMatch(authorizationPage, /select multiple|可多选|保存购买 \/ 续期/);

console.log('P82 passed: authorization UX, PAID-only purchase, assignment revoke/repurchase, stable grant reissue history, new-batch allocation, active batch net equals assignment remaining.');
