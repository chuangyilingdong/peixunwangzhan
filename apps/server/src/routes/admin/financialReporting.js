import { platformPermissionForPathname, requirePlatformPermission } from '../../lib.js';
import { financialCallSummary, financialReconciliationReport, financialReportOptions, listFinancialCalls } from '../../services/financialReporting.js';
import { appendLicensePurchase } from '../../services/licenseLedger.js';

const filters = (search) => Object.fromEntries(search.entries());

export async function handleFinancialReporting(ctx, part, method) {
  if (!part.startsWith('/financial-reporting') && !part.startsWith('/license-purchases')) return null;
  requirePlatformPermission(ctx, platformPermissionForPathname(ctx.pathname));
  if (part === '/license-purchases/append' && method === 'POST') {
    return await appendLicensePurchase({ ...ctx.body, actorId: ctx.auth.user.id });
  }
  if (part === '/financial-reporting/options' && method === 'GET') return await financialReportOptions();
  if (part === '/financial-reporting/calls' && method === 'GET') return await listFinancialCalls(filters(ctx.search));
  if (part === '/financial-reporting/call-summary' && method === 'GET') return await financialCallSummary(filters(ctx.search));
  if (part === '/financial-reporting/summary' && method === 'GET') return await financialReconciliationReport(filters(ctx.search));
  // 2026-09-18：官方账单 API 对账（provider-bill-reconciliation）随供应商账单两条线整体下线，handler 一并删除。
  return null;
}
