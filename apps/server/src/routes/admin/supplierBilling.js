import {
  audit, errors, platformPermissionForPathname, requirePlatformPermission,
} from '../../lib.js';
import {
  SUPPLIER_CSV_HEADER,
  SUPPLIER_CSV_VERSION,
  cancelSupplierImport,
  cancelSupplierMatch,
  createSupplierAccount,
  exportSupplierImport,
  getSupplierImport,
  importSupplierCsv,
  listSupplierAccounts,
  listSupplierEvents,
  listSupplierLineCandidates,
  listSupplierLines,
  manuallyMatchSupplierLine,
  previewSupplierCsv,
  setSupplierLineState,
} from '../../services/supplierBilling.js';

function integer(value, field, { min = 0, max = 10000, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw errors.badRequest(`${field} 必须是 ${min} 到 ${max} 的整数`, 'VALIDATION_ERROR', { field });
  return parsed;
}

function reason(body, { required = false } = {}) {
  const value = String(body?.reason || '').trim();
  if (required && !value) throw errors.badRequest('人工操作必须填写原因', 'SUPPLIER_REASON_REQUIRED');
  if (value.length > 1000) throw errors.badRequest('原因不能超过 1000 个字符', 'SUPPLIER_REASON_TOO_LONG');
  return value;
}

export async function handleSupplierBilling(ctx, part, method) {
  if (!part.startsWith('/supplier-billing')) return null;
  const auth = requirePlatformPermission(ctx, platformPermissionForPathname(ctx.pathname));
  const actorId = auth.user.id;

  if (part === '/supplier-billing/template' && method === 'GET') {
    return { version: SUPPLIER_CSV_VERSION, header: [...SUPPLIER_CSV_HEADER], content: '\ufeff' + SUPPLIER_CSV_HEADER.join(',') + '\r\n' };
  }
  if (part === '/supplier-billing/accounts' && method === 'GET') return { items: listSupplierAccounts() };
  if (part === '/supplier-billing/accounts' && method === 'POST') {
    const created = createSupplierAccount(ctx.body || {}, actorId);
    audit(ctx, 'SUPPLIER_ACCOUNT_CREATE', 'SUPPLIER_ACCOUNT', created.id, null, created);
    return created;
  }
  if (part === '/supplier-billing/imports/preview' && method === 'POST') {
    const preview = previewSupplierCsv(ctx.body?.csv);
    return { version: preview.version, header: preview.header, canonicalCsv: preview.canonicalCsv, fileHash: preview.fileHash, lineCount: preview.lineCount, netAmountMinor: preview.netAmountMinor, currencies: preview.currencies, lineTypes: preview.lineTypes, lines: preview.lines.map((item) => ({ lineNumber: item.lineNumber, provider: item.provider, providerAccountId: item.provider_account_id, invoiceId: item.invoice_id, lineId: item.line_id, lineType: item.line_type, occurredAt: item.occurred_at, currency: item.currency, amountMinor: item.amountMinor, originalLineId: item.original_line_id || null, identifiers: { usageId: item.usage_id || null, responsePayloadId: item.response_payload_id || null, responseRequestId: item.response_request_id || null, requestId: item.request_id || null, taskId: item.task_id || null, gatewayId: item.gateway_id || null }, description: item.description })) };
  }
  if (part === '/supplier-billing/imports' && method === 'POST') {
    const result = importSupplierCsv({ supplierAccountId: ctx.body?.supplierAccountId, fileName: ctx.body?.fileName, csv: ctx.body?.csv }, actorId);
    audit(ctx, result.idempotent ? 'SUPPLIER_BILLING_IMPORT_REPLAY' : 'SUPPLIER_BILLING_IMPORT', 'SUPPLIER_BILLING_IMPORT', result.id, null, { supplierAccountId: result.supplierAccountId, fileHash: result.fileHash, lineCount: result.lineCount, idempotent: result.idempotent });
    return result;
  }
  if (part === '/supplier-billing/lines' && method === 'GET') {
    return listSupplierLines({ supplierAccountId: String(ctx.search.get('supplierAccountId') || ''), status: String(ctx.search.get('status') || '').toUpperCase(), limit: integer(ctx.search.get('limit'), 'limit', { min: 1, max: 500, fallback: 200 }), offset: integer(ctx.search.get('offset'), 'offset', { min: 0, max: 100000, fallback: 0 }) });
  }
  if (part === '/supplier-billing/events' && method === 'GET') {
    return { items: listSupplierEvents({ supplierAccountId: String(ctx.search.get('supplierAccountId') || ''), lineId: String(ctx.search.get('lineId') || ''), limit: integer(ctx.search.get('limit'), 'limit', { min: 1, max: 500, fallback: 200 }) }) };
  }

  let match = part.match(/^\/supplier-billing\/lines\/([^/]+)\/candidates$/);
  if (match && method === 'GET') return listSupplierLineCandidates(match[1]);
  match = part.match(/^\/supplier-billing\/imports\/([^/]+)$/);
  if (match && method === 'GET') return getSupplierImport(match[1]);
  match = part.match(/^\/supplier-billing\/imports\/([^/]+)\/export$/);
  if (match && method === 'GET') {
    const exported = exportSupplierImport(match[1]);
    audit(ctx, 'SUPPLIER_BILLING_EXPORT', 'SUPPLIER_BILLING_IMPORT', match[1], null, { fileHash: exported.fileHash, lineCount: exported.lineCount });
    return exported;
  }
  match = part.match(/^\/supplier-billing\/imports\/([^/]+)\/cancel$/);
  if (match && method === 'POST') {
    const operationReason = reason(ctx.body, { required: true });
    const result = cancelSupplierImport(match[1], { actorId, reason: operationReason });
    audit(ctx, 'SUPPLIER_BILLING_IMPORT_CANCEL', 'SUPPLIER_BILLING_IMPORT', match[1], null, { status: result.status, reason: result.cancelReason });
    return result;
  }
  match = part.match(/^\/supplier-billing\/lines\/([^/]+)\/matches$/);
  if (match && method === 'POST') {
    const operationReason = reason(ctx.body, { required: true });
    const result = manuallyMatchSupplierLine(match[1], ctx.body?.allocations, { actorId, reason: operationReason });
    audit(ctx, 'SUPPLIER_BILLING_MANUAL_MATCH', 'SUPPLIER_BILLING_LINE', match[1], null, { reconciliationStatus: result.reconciliationStatus, allocatedAmountMinor: result.allocatedAmountMinor, matchCount: result.matches.length, reason: operationReason });
    return result;
  }
  match = part.match(/^\/supplier-billing\/matches\/([^/]+)\/cancel$/);
  if (match && method === 'POST') {
    const operationReason = reason(ctx.body, { required: true });
    const result = cancelSupplierMatch(match[1], { actorId, reason: operationReason });
    audit(ctx, 'SUPPLIER_BILLING_MATCH_CANCEL', 'SUPPLIER_BILLING_MATCH', match[1], null, { cancelled: true, reason: operationReason });
    return result;
  }
  match = part.match(/^\/supplier-billing\/lines\/([^/]+)\/(exclude|dispute|cancel)$/);
  if (match && method === 'POST') {
    const operationReason = reason(ctx.body, { required: true });
    const result = setSupplierLineState(match[1], match[2], { actorId, reason: operationReason });
    audit(ctx, `SUPPLIER_BILLING_LINE_${match[2].toUpperCase()}`, 'SUPPLIER_BILLING_LINE', match[1], null, { reconciliationStatus: result.reconciliationStatus, reason: result.stateReason });
    return result;
  }
  return null;
}
