import assert from 'node:assert/strict';
import fs from 'node:fs';

await import('./p77-organizations-authorization.mjs');

const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { handleOrg } = await import('../apps/server/src/routes/orgAdmin.js');
const { q, row, rows, arow, arows } = await import('../apps/server/src/lib.js');
const ctx = (pathname, method = 'GET', body = null) => ({
  pathname, method, body, search: new URLSearchParams(),
  req: { socket: { remoteAddress: '127.0.0.1' } },
  auth: { user: { id: 'root', login: 'root', role: 'SUPER_ADMIN', orgId: null, permissions: [] }, rawUser: { permissions: '[]' } },
});
const admin = (path, method, body) => handleAdmin(ctx('/api/admin' + path, method, body));
const org = (orgId, path, method, body) => handleOrg({ ...ctx('/api/org' + path, method, body), auth: { user: { id: 'org-admin', login: 'org-admin', role: 'ORG_ADMIN', orgId, permissions: [] }, rawUser: { permissions: '[]' } } });
const rejects = async (fn, code) => assert.rejects(fn, (error) => error.code === code, code);
const orgA = await arow("SELECT id FROM organizations WHERE name='A'");
const orgB = await arow("SELECT id FROM organizations WHERE name='B'");
assert.ok(orgA?.id && orgB?.id);

await rejects(
  () => admin('/course-series/p77/assignments', 'POST', { orgIds: [orgA.id, orgB.id], quotaTotal: 2 }),
  'INVALID_ORG_IDS',
);

const compatible = await admin('/course-series/p77/assignments', 'POST', { orgId: orgA.id, validityDays: 400 });
assert.equal(compatible.assignedCount, 1);
const beforeAppend = await arow("SELECT * FROM course_assignments WHERE series_id='p77' AND org_id=?", [orgA.id]);
const appendPurchase = { amountMinor: 12345, currency: 'CNY', paymentStatus: 'PAID', orderNo: 'P82-O-1', contractNo: 'P82-C-1', idempotencyKey: 'p82-append-1' };
const appended = await admin('/course-series/p77/assignments/append', 'POST', { orgId: orgA.id, additionalQuota: 1, ...appendPurchase });
assert.equal(appended.assignment.quotaTotal, 3);
assert.equal(appended.assignment.quotaUsed, 2);
assert.equal(appended.assignment.remaining, 1);
assert.equal(appended.assignment.expiresAt, beforeAppend.expires_at);
const replayed = await admin('/course-series/p77/assignments/append', 'POST', { orgId: orgA.id, additionalQuota: 1, ...appendPurchase });
assert.equal(replayed.assignment.quotaTotal, 3);
assert.equal((await arow("SELECT COUNT(*) n FROM license_purchase_batches WHERE idempotency_key='p82-append-1'")).n, 1);

// ① 授权的到期时间 = 该机构的**合同到期日**（2026-09-16 口径，平台不再单独填有效期）
{
  const orgRow = await arow("SELECT * FROM organizations WHERE id=?", [orgA.id]);
  const assignmentRow = await arow("SELECT * FROM course_assignments WHERE series_id='p77' AND org_id=?", [orgA.id]);
  assert.equal(assignmentRow.expires_at, orgRow.contract_expires_at, '授权到期日应等于机构合同到期日');
}

// ② 改机构合同到期日 → 它的有效授权跟着变（「同步」的全部含义）
{
  const nextContract = new Date(Date.now() + 30 * 86400000).toISOString();
  const original = await arow("SELECT * FROM organizations WHERE id=?", [orgA.id]);
  await admin(`/organizations/${orgA.id}`, 'PUT', {
    name: original.name,
    contractStartAt: original.contract_start_at,
    contractExpiresAt: nextContract,
  });
  const moved = await arow("SELECT * FROM course_assignments WHERE series_id='p77' AND org_id=?", [orgA.id]);
  assert.equal(moved.expires_at, nextContract, '合同改期后授权应同步到新的合同到期日');
  // 还原，免得影响后面的用例（后面的用例拿它做撤销/重授权）
  await admin(`/organizations/${orgA.id}`, 'PUT', {
    name: original.name,
    contractStartAt: original.contract_start_at,
    contractExpiresAt: original.contract_expires_at,
  });
}

// ③ 老接口必须已经不存在：有效期只能通过「改合同」来变
//    （哪天有人把 /assignments/validity 加回来，这里会红）
{
  const legacy = await admin('/course-series/p77/assignments/validity', 'PUT', { orgId: orgA.id, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(legacy, null, '「调整授权有效期」接口应已删除（返回 null → 路由层 404）');
}

const appendAudit = await arow("SELECT * FROM audit_logs WHERE action='COURSE_ASSIGNMENT_QUOTA_APPEND' ORDER BY created_at DESC LIMIT 1");
const validityAudit = await arow("SELECT * FROM audit_logs WHERE action='COURSE_ASSIGNMENT_VALIDITY_UPDATE' ORDER BY created_at DESC LIMIT 1");
void validityAudit;
assert.equal(appendAudit.org_id, orgA.id);
assert.deepEqual(
  [JSON.parse(appendAudit.before_data).quotaTotal, JSON.parse(appendAudit.after_data).quotaTotal],
  [2, 3],
);
assert.equal(JSON.parse(appendAudit.after_data).additionalQuota, 1);
// 有效期调整已不再是平台动作 → 这条审计不该再产生（它只在旧接口里写）
assert.equal(validityAudit, undefined, '不该再有 COURSE_ASSIGNMENT_VALIDITY_UPDATE 审计');

const originalGrant = await arow(`SELECT \`grant\`.* FROM student_course_grants \`grant\`
  JOIN users student ON student.id=\`grant\`.student_id AND student.org_id=\`grant\`.org_id
  WHERE \`grant\`.org_id=? AND \`grant\`.series_id='p77' AND \`grant\`.revoked_at IS NULL
  ORDER BY \`grant\`.granted_at, \`grant\`.id LIMIT 1`, [orgA.id]);
assert.ok(originalGrant?.id);
const grantRevoke = await admin(`/course-grants/${originalGrant.id}/revoke`, 'POST', { reason: 'P82 撤销重授权回归' });
assert.equal(grantRevoke.quotaRefunded, true);
const afterGrantRevoke = await arow("SELECT * FROM course_assignments WHERE series_id='p77' AND org_id=?", [orgA.id]);
assert.equal(afterGrantRevoke.quota_used, 1);
await admin('/course-series/p77/assignments/revoke', 'POST', { orgId: orgA.id });
const afterAssignmentRevoke = await arow("SELECT * FROM course_assignments WHERE series_id='p77' AND org_id=?", [orgA.id]);
assert.equal(afterAssignmentRevoke.status, 'REVOKED');
assert.equal(afterAssignmentRevoke.quota_total, afterAssignmentRevoke.quota_used);
assert.equal((await arow("SELECT COUNT(*) n FROM license_purchase_batches WHERE assignment_id=? AND status='ACTIVE'", [afterAssignmentRevoke.id])).n, 0);
assert.ok((await arow("SELECT COUNT(*) n FROM license_revenue_events WHERE assignment_id=?", [afterAssignmentRevoke.id])).n >= 3);

const reauthorizePurchase = { seriesId: 'p77', orgId: orgA.id, additionalQuota: 1, amountMinor: 2222, currency: 'CNY', paymentStatus: 'PAID', orderNo: 'P82-REAUTH-O', contractNo: 'P82-REAUTH-C', idempotencyKey: 'p82-reauthorize' };
const reauthorized = await admin('/license-purchases/append', 'POST', reauthorizePurchase);
assert.equal(reauthorized.assignment.quotaTotal, 2);
assert.equal(reauthorized.assignment.quotaUsed, 1);
assert.equal(reauthorized.assignment.remaining, 1);
const newBatch = await arow("SELECT * FROM license_purchase_batches WHERE idempotency_key='p82-reauthorize'");
assert.equal(newBatch.status, 'ACTIVE');
const regrant = await org(orgA.id, '/course-grants', 'POST', { seriesId: 'p77', studentIds: [originalGrant.student_id] });
assert.equal(regrant.granted, 1);
const stableGrant = await arow('SELECT * FROM student_course_grants WHERE id=?', [originalGrant.id]);
assert.equal(stableGrant.id, originalGrant.id);
const latestGrantAllocation = await arow(`SELECT allocation.purchase_batch_id FROM license_revenue_events event
  JOIN license_revenue_allocations allocation ON allocation.revenue_event_id=event.id
  WHERE event.grant_id=? AND event.event_type='GRANT' ORDER BY event.occurred_at DESC,event.created_at DESC,event.id DESC LIMIT 1`, [originalGrant.id]);
assert.equal(latestGrantAllocation.purchase_batch_id, newBatch.id);
const activeNet = Number((await arow(`SELECT COALESCE(SUM(batch.quantity),0)-COALESCE(SUM((SELECT COALESCE(SUM(allocation.quantity),0)
  FROM license_revenue_allocations allocation WHERE allocation.purchase_batch_id=batch.id)),0) remaining
  FROM license_purchase_batches batch WHERE batch.assignment_id=? AND batch.status='ACTIVE'`, [afterAssignmentRevoke.id])).remaining);
const finalAssignment = await arow('SELECT * FROM course_assignments WHERE id=?', [afterAssignmentRevoke.id]);
assert.equal(activeNet, finalAssignment.quota_total - finalAssignment.quota_used);
assert.equal((await arows("SELECT * FROM license_revenue_events WHERE grant_id=? AND event_type='GRANT'", [originalGrant.id])).length, 2);

const authorizationPage = fs.readFileSync(new URL('../apps/admin/src/pages/Organizations.jsx', import.meta.url), 'utf8');
assert.match(authorizationPage, /SearchSelect ariaLabel="搜索课包" value=\{seriesId\}/);
assert.match(authorizationPage, /SearchSelect ariaLabel="搜索机构" value=\{orgId\}/);
assert.equal((authorizationPage.match(/ariaLabel="搜索课包"/g) || []).length, 1);
assert.equal((authorizationPage.match(/ariaLabel="搜索机构"/g) || []).length, 1);
assert.match(authorizationPage, /license-purchases\/append/);
// 授权有效期不再由平台填（2026-09-16 口径）：界面上**不该**再有这个调用了，
// 取而代之的是「跟随机构合同到期日」的说明。哪天有人把入口加回来，这里会红。
assert.doesNotMatch(authorizationPage, /assignments\/validity/);
assert.match(authorizationPage, /合同到期日/);
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
