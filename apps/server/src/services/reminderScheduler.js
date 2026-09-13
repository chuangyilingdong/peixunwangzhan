/**
 * P4-O09 自动提醒扫描器
 * 合同到期预警（5min）+ 课节开始提醒（24h 前）
 *
 * ⚠️ 2026-09-13（P4 删积分）：原来的「低余额预警」已删除 —— 它按机构积分余额判定，
 * 积分体系废弃后这个口径没有意义了（扫描器本体也已去掉 scanLowBalanceOrgs）。
 */
import { id, nowIso, q, row, rows } from '../lib.js';
import { scheduleReminder } from '../routes/communication.js';

const CONTRACT_EXPIRY_DAYS = 7;  // 到期前 7 天内提醒

// ---------- 合同到期预警扫赻器（5min） ----------
/**
 * 扫 organizations，contract_expires_at 在未来 7 天内且上次提醒已超 3 天的 → 发 ORG_ADMIN
 */
export function scanContractExpiryOrgs() {
  const now = new Date();
  const in7days = new Date(now.getTime() + CONTRACT_EXPIRY_DAYS * 24 * 3600 * 1000).toISOString();
  const cutoff3d = new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString();
  const orgs = rows(`
    SELECT o.id, o.name, o.contract_expires_at,
      COALESCE((SELECT MAX(nr.created_at) FROM notification_recipients nr
        JOIN notifications n ON n.id=nr.notification_id
        WHERE n.scope_type='ORG' AND n.org_id=o.id
        AND nr.event_key LIKE 'CONTRACT_EXPIRY:%'), '1970-01-01') last_reminder
    FROM organizations o
    WHERE o.status='ACTIVE'
      AND o.contract_expires_at IS NOT NULL
      AND o.contract_expires_at <= ?
      AND o.contract_expires_at > ?
  `, [in7days, now.toISOString()]);

  const results = [];
  for (const org of orgs) {
    if (org.last_reminder && org.last_reminder > cutoff3d) continue; // 3 天内已提醒过
    const daysLeft = Math.ceil((new Date(org.contract_expires_at).getTime() - now.getTime()) / (24 * 3600 * 1000));
    const admins = rows("SELECT id FROM users WHERE org_id=? AND role='ORG_ADMIN' AND status='ACTIVE' AND deleted_at IS NULL", [org.id]);
    for (const admin of admins) {
      try {
        scheduleReminder({
          title: '合同即将到期',
          body: `您的合同将于 ${daysLeft} 天后（${org.contract_expires_at.split('T')[0]}）到期，请及时续费以保障服务连续。`,
          kind: 'ANNOUNCEMENT',
          targetUserId: admin.id,
          targetOrgId: org.id,
          eventKey: `CONTRACT_EXPIRY:${org.id}:${daysLeft}d`,
          targetUrl: '/admin/billing',
        });
      } catch { /* ignore */ }
    }
    results.push({ orgId: org.id, orgName: org.name, daysLeft, adminCount: admins.length });
  }
  return results;
}
