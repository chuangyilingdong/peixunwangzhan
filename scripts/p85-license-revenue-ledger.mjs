import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p85-license-ledger-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');

const { q, row, rows, transaction } = await import('../apps/server/src/lib.js');
const {
  appendLicenseGrantRevenue,
  appendLicenseReversal,
  createLicensePurchaseBatch,
  licensePurchaseHistory,
  normalizeLicensePurchaseInput,
  voidLicensePurchaseBatches,
} = await import('../apps/server/src/services/licenseLedger.js');

const now = new Date().toISOString();
q("INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES ('org85','P85','ACTIVE',?,?,0,?,?)", [now, new Date(Date.now() + 86400000).toISOString(), now, now]);
q("INSERT INTO course_series(id,title,status,owner_type,visibility,stock_total,created_at,updated_at) VALUES ('series85','Ledger','PUBLISHED','PLATFORM','ASSIGNED_ORGS',30,?,?)", [now, now]);
q("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_at,quota_total,quota_used) VALUES ('legacy85','series85','org85','ACTIVE',?,8,3)", [now]);
q("INSERT INTO student_course_grants(id,org_id,student_id,series_id,source_assignment_id,granted_by,granted_at) VALUES ('legacy-grant85','org85','student85','series85','legacy85','org-admin',?)", [now]);

// 模拟老库重开时的 schema 迁移，并重复执行验证幂等。
function migrateLegacy() {
  transaction(() => {
    q(`INSERT OR IGNORE INTO license_purchase_batches(
        id,assignment_id,org_id,series_id,purchase_type,quantity,amount_minor,currency,payment_status,status,
        order_no,contract_no,idempotency_key,purchased_by,purchased_at,created_at)
      SELECT 'license_purchase_legacy_' || id,id,org_id,series_id,'LEGACY_OPENING_BALANCE',quota_total,
        NULL,NULL,'UNKNOWN','ACTIVE',NULL,NULL,'legacy-opening-balance:' || id,assigned_by,assigned_at,assigned_at
      FROM course_assignments WHERE id='legacy85' AND quota_total>0`);
    q(`INSERT OR IGNORE INTO license_revenue_events(
        id,assignment_id,org_id,series_id,grant_id,event_type,quantity,amount_minor,currency,reversal_of_event_id,
        idempotency_key,actor_id,occurred_at,created_at)
      SELECT 'license_revenue_legacy_grant_' || id,source_assignment_id,org_id,series_id,id,'GRANT',1,
        NULL,NULL,NULL,'legacy-grant:' || id,granted_by,granted_at,granted_at
      FROM student_course_grants WHERE id='legacy-grant85' AND revoked_at IS NULL`);
    q(`INSERT OR IGNORE INTO license_revenue_allocations(id,revenue_event_id,purchase_batch_id,quantity,amount_minor,currency,created_at)
      VALUES ('license_allocation_legacy_grant_legacy-grant85','license_revenue_legacy_grant_legacy-grant85',
        'license_purchase_legacy_legacy85',1,NULL,NULL,?)`, [now]);
    for (let index = 1; index <= 2; index += 1) {
      q(`INSERT OR IGNORE INTO license_revenue_events(
          id,assignment_id,org_id,series_id,grant_id,event_type,quantity,amount_minor,currency,reversal_of_event_id,
          idempotency_key,actor_id,occurred_at,created_at)
        VALUES (?,?,?,?,?,'GRANT',1,NULL,NULL,NULL,?,NULL,?,?)`, [
        `license_revenue_legacy_used_legacy85_${index}`, 'legacy85', 'org85', 'series85',
        `legacy-used:legacy85_${index}`, `legacy-used:legacy85_${index}`, now, now,
      ]);
      q(`INSERT OR IGNORE INTO license_revenue_allocations(id,revenue_event_id,purchase_batch_id,quantity,amount_minor,currency,created_at)
        VALUES (?,?,?,1,NULL,NULL,?)`, [
        `license_allocation_legacy_used_legacy85_${index}`, `license_revenue_legacy_used_legacy85_${index}`,
        'license_purchase_legacy_legacy85', now,
      ]);
    }
  });
}
migrateLegacy();
migrateLegacy();
const legacy = row("SELECT * FROM license_purchase_batches WHERE assignment_id='legacy85'");
assert.equal(legacy.quantity, 8);
assert.equal(legacy.amount_minor, null);
assert.equal(legacy.currency, null);
assert.equal(row("SELECT COUNT(*) n FROM license_revenue_events WHERE assignment_id='legacy85' AND event_type='GRANT'").n, 3);
assert.equal(row("SELECT SUM(quantity) n FROM license_revenue_allocations WHERE purchase_batch_id=?", [legacy.id]).n, 3);

const legacyReversal = appendLicenseReversal({ grantId: 'legacy-grant85', actorId: 'root', idempotencyKey: 'reverse-legacy85' });
const legacyRetry = appendLicenseReversal({ grantId: 'legacy-grant85', actorId: 'root', idempotencyKey: 'reverse-legacy85' });
assert.equal(legacyRetry.id, legacyReversal.id);
const legacyRegrant = appendLicenseGrantRevenue({ assignmentId: 'legacy85', orgId: 'org85', seriesId: 'series85', grantId: 'legacy-grant85', actorId: 'org-admin', idempotencyKey: 'legacy-regrant85' });
assert.equal(legacyRegrant.amount_minor, null);
assert.equal(row("SELECT COUNT(*) n FROM license_revenue_events WHERE grant_id='legacy-grant85' AND event_type='GRANT'").n, 2);
assert.equal(row("SELECT SUM(quantity) n FROM license_revenue_allocations WHERE purchase_batch_id=?", [legacy.id]).n, 3);

for (const paymentStatus of ['UNPAID', 'PARTIAL', 'REFUNDED']) {
  assert.throws(
    () => normalizeLicensePurchaseInput({ amountMinor: 100, currency: 'CNY', paymentStatus, orderNo: `O-${paymentStatus}`, contractNo: 'C-85', idempotencyKey: `P85-${paymentStatus}` }, 1),
    (error) => error.code === 'LICENSE_PURCHASE_NOT_PAID',
  );
  assert.throws(
    () => createLicensePurchaseBatch({ assignmentId: 'legacy85', orgId: 'org85', seriesId: 'series85', actorId: 'root', quantity: 1, amountMinor: 100, currency: 'CNY', paymentStatus, orderNo: `O-${paymentStatus}`, contractNo: 'C-85', idempotencyKey: `direct-${paymentStatus}` }),
    (error) => error.code === 'LICENSE_PURCHASE_NOT_PAID',
  );
}

q("INSERT INTO course_series(id,title,status,owner_type,visibility,stock_total,created_at,updated_at) VALUES ('paid-series85','Paid Ledger','PUBLISHED','PLATFORM','ASSIGNED_ORGS',10,?,?)", [now, now]);
q("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_at,quota_total,quota_used) VALUES ('paid85','paid-series85','org85','ACTIVE',?,5,0)", [now]);
const first = normalizeLicensePurchaseInput({ amountMinor: 100, currency: 'cny', paymentStatus: 'PAID', orderNo: 'O-85-1', contractNo: 'C-85', idempotencyKey: 'P85-1' }, 3);
const second = normalizeLicensePurchaseInput({ amountMinor: 10, currency: 'CNY', paymentStatus: 'PAID', orderNo: 'O-85-2', contractNo: 'C-85', idempotencyKey: 'P85-2' }, 2);
const batch1 = createLicensePurchaseBatch({ assignmentId: 'paid85', orgId: 'org85', seriesId: 'series85', actorId: 'root', purchasedAt: new Date(Date.now() + 1000).toISOString(), ...first });
const batch2 = createLicensePurchaseBatch({ assignmentId: 'paid85', orgId: 'org85', seriesId: 'series85', actorId: 'root', purchasedAt: new Date(Date.now() + 2000).toISOString(), ...second });
assert.equal(createLicensePurchaseBatch({ assignmentId: 'paid85', orgId: 'org85', seriesId: 'series85', actorId: 'root', ...first }).id, batch1.id);
assert.throws(() => createLicensePurchaseBatch({ assignmentId: 'paid85', orgId: 'org85', seriesId: 'series85', actorId: 'root', ...first, amountMinor: 101 }), (error) => error.code === 'LICENSE_PURCHASE_IDEMPOTENCY_CONFLICT');
for (let index = 0; index < 4; index += 1) {
  appendLicenseGrantRevenue({ assignmentId: 'paid85', orgId: 'org85', seriesId: 'series85', grantId: `paid-grant${index}`, actorId: 'org-admin', occurredAt: new Date(Date.now() + 3000 + index).toISOString(), idempotencyKey: `paid-event-${index}` });
}
const paidAllocations = rows(`SELECT allocation.purchase_batch_id,allocation.amount_minor
  FROM license_revenue_allocations allocation JOIN license_revenue_events event ON event.id=allocation.revenue_event_id
  WHERE event.assignment_id='paid85' AND event.event_type='GRANT' ORDER BY event.occurred_at,event.id`);
assert.deepEqual(paidAllocations.map((item) => item.purchase_batch_id), [batch1.id, batch1.id, batch1.id, batch2.id]);
assert.deepEqual(paidAllocations.map((item) => item.amount_minor), [33, 33, 34, 5]);
voidLicensePurchaseBatches('paid85');
assert.equal(row("SELECT COUNT(*) n FROM license_purchase_batches WHERE assignment_id='paid85' AND status='ACTIVE'").n, 0);
assert.throws(() => appendLicenseGrantRevenue({ assignmentId: 'paid85', orgId: 'org85', seriesId: 'series85', grantId: 'after-void', actorId: 'org-admin' }), (error) => error.code === 'LICENSE_PURCHASE_BALANCE_EXHAUSTED');
assert.equal(licensePurchaseHistory('paid85').find((item) => item.id === batch1.id).recognizedQuantity, 3);

console.log('P85 passed: complete/idempotent legacy migration, reversible legacy grants, reversal retry, PAID-only quota, FIFO rounding, immutable VOIDED history.');
