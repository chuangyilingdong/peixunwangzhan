import { platformPermissionForPathname, requirePlatformPermission, arows, amap } from '../../lib.js';
import { financialCallSummary, financialReconciliationReport, financialReportOptions, listFinancialCalls } from '../../services/financialReporting.js';
import { appendLicensePurchase, licensePurchaseHistory } from '../../services/licenseLedger.js';
import { rows } from '../../lib.js';

const filters = (search) => Object.fromEntries(search.entries());

export async function handleFinancialReporting(ctx, part, method) {
  if (!part.startsWith('/financial-reporting') && !part.startsWith('/license-purchases') && part !== '/authorizations') return null;
  requirePlatformPermission(ctx, platformPermissionForPathname(ctx.pathname));
  if (part === '/authorizations' && method === 'GET') {
    const items = await amap((await arows("SELECT * FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED' ORDER BY title")), async (series) => {
      const allocations = await amap((await arows('SELECT assignment.*,organization.name org_name FROM course_assignments assignment JOIN organizations organization ON organization.id=assignment.org_id WHERE assignment.series_id=? ORDER BY assignment.assigned_at DESC', [series.id])), async (assignment) => ({
        id: assignment.id, orgId: assignment.org_id, orgName: assignment.org_name, status: assignment.status,
        quotaTotal: Number(assignment.quota_total), quotaUsed: Number(assignment.quota_used),
        remaining: assignment.status === 'ACTIVE' ? Math.max(0, Number(assignment.quota_total) - Number(assignment.quota_used)) : 0,
        expiresAt: assignment.expires_at || null, purchaseBatches: await licensePurchaseHistory(assignment.id),
      }));
      const reserved = allocations.reduce((sum, assignment) => sum + (assignment.status === 'ACTIVE' ? assignment.quotaTotal : assignment.quotaUsed), 0);
      return { id: series.id, title: series.title, stockTotal: Number(series.stock_total || 0), reserved, available: Math.max(0, Number(series.stock_total || 0) - reserved), allocations };
    });
    return { items, organizations: await arows('SELECT id,name,status FROM organizations ORDER BY name,id') };
  }
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
