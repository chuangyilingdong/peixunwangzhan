import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-supplier-billing-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;

const {
  SUPPLIER_CSV_HEADER, canonicalSupplierCsv, cancelSupplierImport, cancelSupplierMatch, createSupplierAccount,
  importSupplierCsv, listSupplierEvents, listSupplierLineCandidates, listSupplierLines, manuallyMatchSupplierLine,
  previewSupplierCsv, setSupplierLineState,
} = await import('../apps/server/src/services/supplierBilling.js');
const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { q, row } = await import('../apps/server/src/lib.js');

const actorId = 'p86-admin';
const orgId = 'p86-org'; const studentId = 'p86-student';
q("INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", [orgId, 'P86 Org', 'ACTIVE', new Date().toISOString(), '2099-01-01T00:00:00.000Z', 0, new Date().toISOString(), new Date().toISOString()]);
q("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [actorId, 'p86-admin', 'P86 Admin', 'SUPER_ADMIN', '[\"ADMIN_BILLING\"]', 'test', 'ACTIVE', new Date().toISOString(), new Date().toISOString()]);
q("INSERT INTO users(id,org_id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [studentId, orgId, 'p86-student', 'P86 Student', 'STUDENT', '[]', 'test', 'ACTIVE', new Date().toISOString(), new Date().toISOString()]);
const account = createSupplierAccount({ code: 'acct-main', name: 'Supplier Main', provider: 'vendor-a', channelId: 'channel-a', defaultCurrency: 'CNY', timezone: 'UTC' }, actorId);
assert.throws(() => createSupplierAccount({ code: 'bad', name: 'Bad', provider: 'vendor-a', defaultCurrency: 'CNY', apiKey: 'secret' }), (error) => error.code === 'SUPPLIER_ACCOUNT_SECRET_FORBIDDEN');

const now = new Date().toISOString();
const attempt = (id, request, cost = 100) => q(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,modality,channel_id,provider,model,routed_via,status,client_request_id,response_request_id,response_payload_id,usage_id,gateway_log_id,actual_channel_id,provider_account_ref,cost_source,upstream_cost_fen,sale_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, `call-${id}`, 1, orgId, studentId, 'TEXT', 'channel-a', 'vendor-a', 'model', 'direct', 'SUCCESS', request, request, null, null, null, 'channel-a', 'acct-main', 'REPORTED', cost, '{}', now]);
attempt('attempt-one', 'req-one', 100);
attempt('attempt-amb-a', 'req-amb', 100);
attempt('attempt-amb-b', 'req-amb', 100);
attempt('attempt-split-a', 'req-split-a', 60);
attempt('attempt-split-b', 'req-split-b', 40);
attempt('attempt-many', 'req-many', 100);
attempt('attempt-response', 'req-response', 25);
attempt('attempt-task', 'req-task', 30);
attempt('attempt-gateway', 'req-gateway', 35);
attempt('attempt-line-cascade', 'req-line-cascade', 100);
attempt('attempt-import-cascade', 'req-import-cascade', 100);
q("UPDATE compute_attempts SET response_payload_id='resp-payload' WHERE id='attempt-response'");
q("UPDATE compute_attempts SET task_id='task-exact' WHERE id='attempt-task'");
q("UPDATE compute_attempts SET gateway_log_id='gateway-exact' WHERE id='attempt-gateway'");

const make = (overrides) => ({ schema_version: 'v1', provider: 'vendor-a', provider_account_id: 'acct-main', invoice_id: 'inv-1', line_id: '', line_type: 'USAGE', occurred_at: '2026-09-13T10:00:00+08:00', currency: 'CNY', amount_minor: '100', original_line_id: '', usage_id: '', response_payload_id: '', response_request_id: '', request_id: '', task_id: '', gateway_id: '', description: '', ...overrides });
const five = [
  make({ line_id: 'line-usage', request_id: 'req-one', description: 'quoted, memo' }),
  make({ line_id: 'line-refund', line_type: 'REFUND', amount_minor: '-20', original_line_id: 'line-usage' }),
  make({ line_id: 'line-credit', line_type: 'CREDIT', amount_minor: '-10', original_line_id: 'line-usage' }),
  make({ line_id: 'line-adjust', line_type: 'ADJUSTMENT', amount_minor: '-5' }),
  make({ line_id: 'line-tax', line_type: 'TAX', amount_minor: '6' }),
];
const csv = canonicalSupplierCsv(five);
const preview = previewSupplierCsv(csv.replaceAll('\r\n', '\n'));
assert.ok(preview.canonicalCsv.startsWith('\ufeff'));
assert.ok(preview.canonicalCsv.endsWith('\r\n'));
assert.deepEqual(preview.lineTypes, { USAGE: 1, REFUND: 1, CREDIT: 1, ADJUSTMENT: 1, TAX: 1 });
assert.equal(preview.netAmountMinor, 71);
assert.throws(() => previewSupplierCsv(canonicalSupplierCsv([make({ line_id: 'bad-formula', description: '=SUM(A1)' })])), (error) => error.code === 'SUPPLIER_CSV_FORMULA_REJECTED');
assert.throws(() => previewSupplierCsv(canonicalSupplierCsv([make({ line_id: 'bad-sign', line_type: 'REFUND', amount_minor: '5', original_line_id: 'line-usage' })])), (error) => error.code === 'SUPPLIER_CSV_AMOUNT_SIGN_INVALID');
assert.throws(() => previewSupplierCsv('schema_version,line_id\r\nv1,x\r\n'), (error) => error.code === 'SUPPLIER_CSV_HEADER_INVALID');

const imported = importSupplierCsv({ supplierAccountId: account.id, fileName: 'invoice.csv', csv }, actorId);
assert.equal(imported.insertedLineCount, 5);
assert.equal(importSupplierCsv({ supplierAccountId: account.id, fileName: 'renamed.csv', csv }, actorId).idempotent, true);
let lines = listSupplierLines({ supplierAccountId: account.id }).items;
const byExternalId = (lineId) => lines.find((line) => line.lineId === lineId);
assert.equal(byExternalId('line-usage').reconciliationStatus, 'MATCHED');
assert.equal(byExternalId('line-usage').matches[0].targetId, 'attempt-one');
assert.equal(byExternalId('line-refund').originalInternalLineId, byExternalId('line-usage').id);
assert.equal(byExternalId('line-refund').allocatedAmountMinor, -20);
assert.equal(byExternalId('line-refund').matches[0].originalMatchId, byExternalId('line-usage').matches[0].id);
assert.equal(byExternalId('line-refund').settledAmountMinor, -20);
assert.equal(byExternalId('line-credit').allocatedAmountMinor, -10);
assert.equal(byExternalId('line-adjust').reconciliationStatus, 'EXCLUDED');
assert.equal(byExternalId('line-tax').reconciliationStatus, 'EXCLUDED');

const conflictCsv = canonicalSupplierCsv([make({ line_id: 'line-usage', amount_minor: '99', request_id: 'req-one' })]);
assert.throws(() => importSupplierCsv({ supplierAccountId: account.id, csv: conflictCsv }, actorId), (error) => error.code === 'SUPPLIER_LINE_IDEMPOTENCY_CONFLICT');
const ambiguousCsv = canonicalSupplierCsv([make({ invoice_id: 'inv-2', line_id: 'line-amb', request_id: 'req-amb', amount_minor: '80' })]);
importSupplierCsv({ supplierAccountId: account.id, csv: ambiguousCsv }, actorId);
lines = listSupplierLines({ supplierAccountId: account.id }).items;
const ambiguous = lines.find((line) => line.lineId === 'line-amb');
assert.equal(ambiguous.reconciliationStatus, 'AMBIGUOUS');
assert.equal(ambiguous.matches.length, 0);
const candidateResult = listSupplierLineCandidates(ambiguous.id);
assert.equal(candidateResult.total, 2);
assert.equal(candidateResult.confirmable, false);
assert.deepEqual(candidateResult.items[0].orgId, orgId);
assert.deepEqual(candidateResult.items[0].organizationName, 'P86 Org');
assert.deepEqual(candidateResult.items[0].studentId, studentId);
assert.deepEqual(candidateResult.items[0].studentName, 'P86 Student');
assert.equal(candidateResult.items[0].model, 'model');
assert.equal(candidateResult.items[0].actualChannelId, 'channel-a');
assert.equal(candidateResult.items[0].occurredAt, now);
assert.equal(candidateResult.items[0].evidence.attempt, 1);
assert.equal(candidateResult.items[0].evidence.responseRequestId, 'req-amb');

const splitCsv = canonicalSupplierCsv([make({ invoice_id: 'inv-3', line_id: 'line-split', request_id: '', amount_minor: '100' })]);
importSupplierCsv({ supplierAccountId: account.id, csv: splitCsv }, actorId);
lines = listSupplierLines({ supplierAccountId: account.id }).items;
const split = lines.find((line) => line.lineId === 'line-split');
assert.throws(() => manuallyMatchSupplierLine(split.id, [{ targetType: 'ATTEMPT', targetId: 'attempt-split-a', amountMinor: 60 }], { actorId }), (error) => error.code === 'SUPPLIER_REASON_REQUIRED');
const splitResult = manuallyMatchSupplierLine(split.id, [{ targetType: 'ATTEMPT', targetId: 'attempt-split-a', amountMinor: 60 }, { targetType: 'ATTEMPT', targetId: 'attempt-split-b', amountMinor: 40 }], { actorId, reason: 'manual split' });
assert.equal(splitResult.reconciliationStatus, 'MATCHED');
assert.equal(splitResult.matches.length, 2);
assert.throws(() => manuallyMatchSupplierLine(split.id, [{ targetType: 'ATTEMPT', targetId: 'attempt-split-a', amountMinor: 61 }, { targetType: 'ATTEMPT', targetId: 'attempt-split-b', amountMinor: 40 }], { actorId, reason: 'over allocate' }), (error) => ['SUPPLIER_MATCH_LINE_AMOUNT_EXCEEDED', 'SUPPLIER_MATCH_TARGET_AMOUNT_EXCEEDED'].includes(error.code));
const cancelled = cancelSupplierMatch(splitResult.matches[0].id, { actorId, reason: 'wrong allocation' });
assert.equal(cancelled.line.reconciliationStatus, 'PARTIAL');
const moreCsv = canonicalSupplierCsv([
  make({ invoice_id: 'inv-4', line_id: 'many-a', request_id: '', amount_minor: '60' }),
  make({ invoice_id: 'inv-4', line_id: 'many-b', request_id: '', amount_minor: '50' }),
  make({ invoice_id: 'inv-4', line_id: 'foreign', request_id: 'req-response', currency: 'USD', amount_minor: '25' }),
  make({ invoice_id: 'inv-4', line_id: 'response', response_payload_id: 'resp-payload', amount_minor: '25' }),
  make({ invoice_id: 'inv-4', line_id: 'task', task_id: 'task-exact', amount_minor: '30' }),
  make({ invoice_id: 'inv-4', line_id: 'gateway', gateway_id: 'gateway-exact', amount_minor: '35' }),
]);
importSupplierCsv({ supplierAccountId: account.id, csv: moreCsv }, actorId);
lines = listSupplierLines({ supplierAccountId: account.id }).items;
const manyA = lines.find((line) => line.lineId === 'many-a');
const manyB = lines.find((line) => line.lineId === 'many-b');
manuallyMatchSupplierLine(manyA.id, [{ targetType: 'ATTEMPT', targetId: 'attempt-many', amountMinor: 60 }], { actorId, reason: 'many to one first' });
assert.throws(() => manuallyMatchSupplierLine(manyB.id, [{ targetType: 'ATTEMPT', targetId: 'attempt-many', amountMinor: 50 }], { actorId, reason: 'many to one overflow' }), (error) => error.code === 'SUPPLIER_MATCH_TARGET_AMOUNT_EXCEEDED');
lines = listSupplierLines({ supplierAccountId: account.id }).items;
assert.equal(lines.find((line) => line.lineId === 'foreign').comparisonStatus, 'UNKNOWN_CURRENCY');
assert.equal(lines.find((line) => line.lineId === 'response').matches[0].identifierType, 'RESPONSE');
assert.equal(lines.find((line) => line.lineId === 'task').matches[0].identifierType, 'TASK');
assert.equal(lines.find((line) => line.lineId === 'gateway').matches[0].identifierType, 'GATEWAY');
const disputedMatched = setSupplierLineState(lines.find((line) => line.lineId === 'response').id, 'dispute', { actorId, reason: 'provider review' });
assert.equal(disputedMatched.matches.length, 1);
assert.equal(disputedMatched.settledAmountMinor, null);
assert.equal(disputedMatched.settledMatchCount, 0);
importSupplierCsv({ supplierAccountId: account.id, csv: canonicalSupplierCsv([make({ invoice_id: 'inv-disputed-refund', line_id: 'disputed-refund', line_type: 'REFUND', amount_minor: '-5', original_line_id: 'response', request_id: '' })]) }, actorId);
lines = listSupplierLines({ supplierAccountId: account.id }).items;
assert.equal(lines.find((line) => line.lineId === 'disputed-refund').reconciliationStatus, 'UNMATCHED');
assert.equal(lines.find((line) => line.lineId === 'disputed-refund').settledAmountMinor, null);
assert.throws(() => manuallyMatchSupplierLine(byExternalId('line-tax').id, [{ targetType: 'ATTEMPT', targetId: 'attempt-one', amountMinor: 6 }], { actorId, reason: 'tax match forbidden' }), (error) => error.code === 'SUPPLIER_LINE_STATE_CONFLICT');

const lineCascadeUsageImport = importSupplierCsv({ supplierAccountId: account.id, csv: canonicalSupplierCsv([make({ invoice_id: 'inv-cascade-line-usage', line_id: 'cascade-line-usage', request_id: 'req-line-cascade' })]) }, actorId);
importSupplierCsv({ supplierAccountId: account.id, csv: canonicalSupplierCsv([make({ invoice_id: 'inv-cascade-line-refund', line_id: 'cascade-line-refund', line_type: 'REFUND', amount_minor: '-25', original_line_id: 'cascade-line-usage', request_id: '' })]) }, actorId);
lines = listSupplierLines({ supplierAccountId: account.id }).items;
const cascadeLineUsage = lines.find((line) => line.lineId === 'cascade-line-usage');
const cascadeLineRefund = lines.find((line) => line.lineId === 'cascade-line-refund');
assert.equal(cascadeLineRefund.reconciliationStatus, 'MATCHED');
assert.throws(() => manuallyMatchSupplierLine(cascadeLineRefund.id, [{ targetType: 'ATTEMPT', targetId: 'attempt-line-cascade', amountMinor: -101, originalMatchId: cascadeLineUsage.matches[0].id }], { actorId, reason: 'negative target guard' }), (error) => ['SUPPLIER_MATCH_LINE_AMOUNT_EXCEEDED', 'SUPPLIER_ORIGINAL_MATCH_AMOUNT_EXCEEDED', 'SUPPLIER_MATCH_TARGET_NEGATIVE'].includes(error.code));
setSupplierLineState(cascadeLineUsage.id, 'cancel', { actorId, reason: 'cancel original usage line' });
lines = listSupplierLines({ supplierAccountId: account.id }).items;
assert.equal(lines.find((line) => line.lineId === 'cascade-line-refund').reconciliationStatus, 'UNMATCHED');
assert.equal(lines.find((line) => line.lineId === 'cascade-line-refund').matches.length, 0);

const importCascadeUsage = importSupplierCsv({ supplierAccountId: account.id, csv: canonicalSupplierCsv([make({ invoice_id: 'inv-cascade-import-usage', line_id: 'cascade-import-usage', request_id: 'req-import-cascade' })]) }, actorId);
importSupplierCsv({ supplierAccountId: account.id, csv: canonicalSupplierCsv([make({ invoice_id: 'inv-cascade-import-refund', line_id: 'cascade-import-refund', line_type: 'REFUND', amount_minor: '-30', original_line_id: 'cascade-import-usage', request_id: '' })]) }, actorId);
cancelSupplierImport(importCascadeUsage.id, { actorId, reason: 'cancel original usage import' });
lines = listSupplierLines({ supplierAccountId: account.id }).items;
assert.equal(lines.find((line) => line.lineId === 'cascade-import-usage').reconciliationStatus, 'CANCELLED');
assert.equal(lines.find((line) => line.lineId === 'cascade-import-refund').reconciliationStatus, 'UNMATCHED');
assert.equal(lines.find((line) => line.lineId === 'cascade-import-refund').matches.length, 0);

const excludedAdjustment = lines.find((line) => line.lineId === 'line-adjust');
q("UPDATE supplier_billing_lines SET reconciliation_status='MATCHED' WHERE id=?", [excludedAdjustment.id]);
q("INSERT INTO supplier_billing_matches(id,line_id,target_type,target_id,identifier_type,allocated_amount_minor,currency,method,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", ['legacy-negative-match', excludedAdjustment.id, 'ATTEMPT', 'attempt-one', 'MANUAL', -100, 'CNY', 'MANUAL', actorId, now]);
assert.throws(() => importSupplierCsv({ supplierAccountId: account.id, csv: canonicalSupplierCsv([make({ invoice_id: 'inv-negative-floor', line_id: 'negative-floor-refund', line_type: 'REFUND', amount_minor: '-1', original_line_id: 'line-usage', request_id: '' })]) }, actorId), (error) => error.code === 'SUPPLIER_MATCH_TARGET_NEGATIVE');
q("DELETE FROM supplier_billing_matches WHERE id='legacy-negative-match'");
q("UPDATE supplier_billing_lines SET reconciliation_status='EXCLUDED' WHERE id=?", [excludedAdjustment.id]);

assert.equal(setSupplierLineState(ambiguous.id, 'dispute', { actorId, reason: 'provider review' }).reconciliationStatus, 'DISPUTED');
assert.equal(setSupplierLineState(ambiguous.id, 'cancel', { actorId, reason: 'void line' }).reconciliationStatus, 'CANCELLED');
assert.ok(listSupplierEvents({ supplierAccountId: account.id }).length >= 10);

const adminSource = fs.readFileSync(new URL('../apps/server/src/routes/adminOrg.js', import.meta.url), 'utf8');
assert.match(adminSource, /handleSupplierBilling/);
const ctx = {
  pathname: '/api/admin/supplier-billing/template', method: 'GET', search: new URLSearchParams(), body: {},
  auth: { user: { id: actorId, role: 'SUPER_ADMIN', permissions: ['ADMIN_BILLING'] }, rawUser: row('SELECT * FROM users WHERE id=?', [actorId]) },
};
const routed = await handleAdmin(ctx);
assert.deepEqual(routed.header, SUPPLIER_CSV_HEADER);
const forbiddenCtx = { ...ctx, auth: { ...ctx.auth, user: { ...ctx.auth.user, permissions: [] } } };
await assert.rejects(handleAdmin(forbiddenCtx), (error) => error.code === 'PERMISSION_DENIED');
const candidateCtx = { ...ctx, pathname: `/api/admin/supplier-billing/lines/${split.id}/candidates` };
assert.equal((await handleAdmin(candidateCtx)).line.id, split.id);
console.log('p86 passed: canonical BOM/RFC4180 validation, five signed line types, idempotency/conflict, refund-credit linkage, exact-only matching, ambiguity/candidates, split/manual caps and reasons, state/audit, scoped billing permission, and real admin routing.');
