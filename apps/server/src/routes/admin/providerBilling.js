// 官方账单 API 自动对账（拉取侧）的平台管理端路由。
// 挂载点：/api/admin/provider-billing（权限域 ADMIN_BILLING，见 lib.js platformPermissionForPathname）。
//
// 约定：凭据只经 `POST /accounts/:id/credential` 写入加密存储，任何响应都只回
// `credentialConfigured: true|false`，绝不回显明文；配置列里也拒绝任何密钥类字段。
import { audit, errors, platformPermissionForPathname, requirePlatformPermission } from '../../lib.js';
import {
  clearSupplierBillingCredential,
  getProviderBillSnapshot,
  listBillingAccounts,
  listBillingAdapters,
  listProviderBillSnapshots,
  providerBillingStatus,
  providerBillingSchedulerState,
  saveSupplierBillingConfig,
  setSupplierBillingCredential,
  syncAllProviderBills,
  syncProviderBill,
} from '../../services/providerBilling.js';

function integer(value, field, { min = 0, max = 10000, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw errors.badRequest(`${field} 必须是 ${min} 到 ${max} 的整数`, 'VALIDATION_ERROR', { field });
  return parsed;
}

export async function handleProviderBilling(ctx, part, method) {
  if (!part.startsWith('/provider-billing')) return null;
  const auth = requirePlatformPermission(ctx, platformPermissionForPathname(ctx.pathname));
  const actorId = auth.user.id;

  if (part === '/provider-billing/adapters' && method === 'GET') {
    return { items: listBillingAdapters() };
  }
  if (part === '/provider-billing/accounts' && method === 'GET') {
    return { items: listBillingAccounts(), scheduler: providerBillingSchedulerState() };
  }
  if (part === '/provider-billing/status' && method === 'GET') {
    return providerBillingStatus({
      supplierAccountId: String(ctx.search.get('supplierAccountId') || ''),
      limit: integer(ctx.search.get('limit'), 'limit', { min: 1, max: 200, fallback: 20 }),
    });
  }
  if (part === '/provider-billing/snapshots' && method === 'GET') {
    return listProviderBillSnapshots({
      supplierAccountId: String(ctx.search.get('supplierAccountId') || ''),
      status: String(ctx.search.get('status') || '').toUpperCase(),
      limit: integer(ctx.search.get('limit'), 'limit', { min: 1, max: 200, fallback: 50 }),
      offset: integer(ctx.search.get('offset'), 'offset', { min: 0, max: 100000, fallback: 0 }),
    });
  }
  if (part === '/provider-billing/sync' && method === 'POST') {
    const result = await syncAllProviderBills({
      actorId, source: 'MANUAL',
      periodStart: ctx.body?.periodStart || undefined,
      periodEnd: ctx.body?.periodEnd || undefined,
    });
    audit(ctx, 'PROVIDER_BILL_SYNC_ALL', 'PROVIDER_BILL_SYNC', null, null, { accountCount: result.accountCount, fetchedCount: result.fetchedCount, failedCount: result.failedCount });
    return result;
  }

  let match = part.match(/^\/provider-billing\/accounts\/([^/]+)\/config$/);
  if (match && (method === 'POST' || method === 'PUT')) {
    const updated = saveSupplierBillingConfig(match[1], ctx.body || {}, actorId);
    audit(ctx, 'PROVIDER_BILL_CONFIG_UPDATE', 'SUPPLIER_ACCOUNT', match[1], null, { adapter: updated.billing.adapter, enabled: updated.billing.enabled });
    return updated;
  }
  match = part.match(/^\/provider-billing\/accounts\/([^/]+)\/credential$/);
  if (match && method === 'POST') {
    // 只回「配没配」；明文既不入审计、不入响应，也不落业务库。
    const result = setSupplierBillingCredential(match[1], ctx.body?.credential, actorId);
    audit(ctx, 'PROVIDER_BILL_CREDENTIAL_SET', 'SUPPLIER_ACCOUNT', match[1], null, { credentialConfigured: true });
    return result;
  }
  if (match && method === 'DELETE') {
    const result = clearSupplierBillingCredential(match[1], actorId);
    audit(ctx, 'PROVIDER_BILL_CREDENTIAL_CLEAR', 'SUPPLIER_ACCOUNT', match[1], null, { credentialConfigured: false });
    return result;
  }
  match = part.match(/^\/provider-billing\/accounts\/([^/]+)\/sync$/);
  if (match && method === 'POST') {
    // 立即同步：上游拉取失败**不抛**，返回 status='FAILED' 与错误原文（已落 FAILED 快照，绝不写半截聚合）。
    const result = await syncProviderBill(match[1], {
      actorId, source: 'MANUAL',
      periodStart: ctx.body?.periodStart,
      periodEnd: ctx.body?.periodEnd,
    });
    audit(ctx, result.status === 'FETCHED' ? 'PROVIDER_BILL_SYNC' : 'PROVIDER_BILL_SYNC_FAILED', 'PROVIDER_BILL_SNAPSHOT', result.snapshot?.id || null, null,
      { supplierAccountId: match[1], status: result.status, idempotent: result.idempotent, itemCount: result.snapshot?.itemCount || 0, responseHash: result.snapshot?.responseHash || null, errorCode: result.error?.code || null });
    return result;
  }
  match = part.match(/^\/provider-billing\/accounts\/([^/]+)\/status$/);
  if (match && method === 'GET') {
    return providerBillingStatus({ supplierAccountId: match[1], limit: integer(ctx.search.get('limit'), 'limit', { min: 1, max: 200, fallback: 20 }) });
  }
  match = part.match(/^\/provider-billing\/snapshots\/([^/]+)$/);
  if (match && method === 'GET') return getProviderBillSnapshot(match[1]);
  return null;
}
