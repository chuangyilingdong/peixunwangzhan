import { errors, requireRole, row, rows } from '../lib.js';

export async function handleWebsiteCredits(ctx) {
  const { pathname, method } = ctx;
  if (!pathname.startsWith('/api/website/my-credits')) return null;
  const auth = requireRole(ctx, ['STUDENT']);
  const userId = auth.user.id;
  const orgId = auth.user.orgId;
  if (!orgId) throw errors.forbidden('当前账号未绑定机构', 'ORG_SCOPE_REQUIRED');
  const part = pathname.slice('/api/website'.length);

  if (part === '/my-credits/summary' && method === 'GET') {
    const user = row('SELECT ai_credit_limit, ai_credits_used FROM users WHERE id=? AND org_id=?', [userId, orgId]);
    if (!user) throw errors.notFound('用户不存在', 'USER_NOT_FOUND');
    const totalAllocated = Number(user.ai_credit_limit || 0);
    const totalUsed = Number(user.ai_credits_used || 0);
    return { totalAllocated, totalUsed, balance: Math.max(0, totalAllocated - totalUsed) };
  }

  if (part === '/my-credits/usage' && method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(ctx.search.get('limit') || 20)));
    const items = rows(`
      SELECT usage.id, usage.modality, usage.credits_charged credits,
             usage.created_at, project.title project_title
      FROM usage_records usage
      LEFT JOIN student_projects project ON project.id=usage.project_id
        AND project.student_id=usage.user_id AND project.org_id=usage.org_id
      WHERE usage.user_id=? AND usage.org_id=? AND usage.status='SUCCESS'
      ORDER BY usage.created_at DESC LIMIT ?`, [userId, orgId, limit]);
    const user = row('SELECT ai_credit_limit, ai_credits_used FROM users WHERE id=? AND org_id=?', [userId, orgId]);
    let balance = Math.max(0, Number(user?.ai_credit_limit || 0) - Number(user?.ai_credits_used || 0));
    return { items: items.map((item) => {
      const result = { id:item.id, modality:item.modality, credits:Number(item.credits || 0), balanceAfter:balance, projectTitle:item.project_title, createdAt:item.created_at };
      balance += Number(item.credits || 0);
      return result;
    }) };
  }

  if (part === '/my-credits/allocations' && method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(ctx.search.get('limit') || 20)));
    const items = rows(`SELECT id, credits_change credits, credits_after balance_after, reason, adjustment_type type, created_at FROM user_credit_adjustments WHERE user_id=? AND org_id=? ORDER BY created_at DESC LIMIT ?`, [userId, orgId, limit]);
    return { items: items.map((item) => ({ id:item.id, type:item.type, credits:Number(item.credits || 0), balanceAfter:Number(item.balance_after || 0), reason:item.reason, createdAt:item.created_at })) };
  }
  return null;
}
