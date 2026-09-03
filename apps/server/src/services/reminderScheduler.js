/**
 * P4-O09 自动提醒扫赻器
 * 低余额预警（5min）+ 合同到期预警（5min）+ 课节开始提醒（24h 前）
 */
import { id, nowIso, q, row, rows } from '../lib.js';
import { scheduleReminder } from '../routes/communication.js';

const LOW_BALANCE_THRESHOLD = 0; // credits 余额 <= 0 时告警
const CONTRACT_EXPIRY_DAYS = 7;  // 到期前 7 天内提醒
const SESSION_REMINDER_HOURS = 24; // 课节开始前 24h 提醒

// ---------- 低余额预警扫赻器（5min） ----------
/**
 * 扫全量 org_billing_accounts，余额 <= 0 且上次提醒已超 24h 的机构 → 发给 ORG_ADMIN
 * @returns {Array} { orgId, admins: string[] }
 */
export function scanLowBalanceOrgs() {
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  // 余额 <= 0 且上次提醒在 24h 之前
  const orgs = rows(`
    SELECT ba.org_id,
      COALESCE((SELECT MAX(nr.created_at) FROM notification_recipients nr
        JOIN notifications n ON n.id=nr.notification_id
        WHERE n.scope_type='ORG' AND n.org_id=ba.org_id
        AND nr.event_key LIKE 'LOW_BALANCE:%'), '1970-01-01') last_reminder
    FROM org_billing_accounts ba
    JOIN organizations o ON o.id=ba.org_id
    WHERE o.status='ACTIVE' AND ba.balance<=?
  `, [LOW_BALANCE_THRESHOLD]);

  const results = [];
  for (const row of orgs) {
    if (row.last_reminder && row.last_reminder > cutoff24h) continue; // 24h 内已提醒过
    const admins = rows("SELECT id FROM users WHERE org_id=? AND role='ORG_ADMIN' AND status='ACTIVE' AND deleted_at IS NULL", [row.org_id]);
    for (const admin of admins) {
      try {
        scheduleReminder({
          title: '账户余额不足',
          body: `您的账户余额已不足（${row.balance} 积分），为保障服务连续性，请及时充值。`,
          kind: 'REMINDER',
          targetUserId: admin.id,
          targetOrgId: row.org_id,
          eventKey: `LOW_BALANCE:${row.org_id}`,
          targetUrl: '/admin/billing',
        });
      } catch { /* ignore */ }
    }
    results.push({ orgId: row.org_id, adminCount: admins.length });
  }
  return results;
}

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

// ---------- 课节提醒扫赻器（创建时触发，24h 前） ----------
/**
 * 在 class_sessions 创建时调用：若 session.start_at 在未来 24h 内，发提醒给相关老师+学生
 * @param {string} sessionId - 课节 ID
 */
export function triggerClassSessionReminder(sessionId) {
  const session = row(`
    SELECT cs.id, cs.title, cs.start_at, cs.end_at,
      cs.class_id, class.name class_name, class.org_id
    FROM class_sessions cs
    JOIN classes class ON class.id=cs.class_id
    WHERE cs.id=?
  `, [sessionId]);
  if (!session) return { skipped: true, reason: 'SESSION_NOT_FOUND' };

  const now = Date.now();
  const reminderWindowMs = SESSION_REMINDER_HOURS * 3600 * 1000;
  const startMs = new Date(session.start_at).getTime();
  const hoursUntilStart = (startMs - now) / (3600 * 1000);

  // 只在开始前 24h±5min 窗口内提醒（避免重复触发）
  if (hoursUntilStart < 0 || hoursUntilStart > SESSION_REMINDER_HOURS + 0.1) {
    return { skipped: true, reason: 'OUTSIDE_REMINDER_WINDOW', hoursUntilStart };
  }

  // 查是否已提醒过（eventKey 去重）
  const existing = row(
    "SELECT id FROM notification_recipients WHERE event_key=? ORDER BY created_at DESC LIMIT 1",
    [`SESSION_REMINDER:${session.id}`],
  );
  if (existing) return { skipped: true, reason: 'ALREADY_REMINDED' };

  const targets = rows(`
    SELECT DISTINCT u.id FROM class_members cm
    JOIN users u ON u.id=cm.user_id AND u.status='ACTIVE' AND u.deleted_at IS NULL
    WHERE cm.class_id=? AND cm.removed_at IS NULL
    UNION
    SELECT teacher_id id FROM classes WHERE id=? AND teacher_id IS NOT NULL
  `, [session.class_id, session.class_id]);

  const startLocal = new Date(session.start_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  const results = [];
  for (const target of targets) {
    try {
      scheduleReminder({
        title: '课节即将开始',
        body: `课节「${session.title || session.class_name}」将于 ${startLocal} 开始，请提前准备。`,
        kind: 'REMINDER',
        targetUserId: target.id,
        targetOrgId: session.org_id,
        eventKey: `SESSION_REMINDER:${session.id}`,
        targetUrl: '/schedule',
      });
      results.push(target.id);
    } catch { /* ignore */ }
  }
  return { sent: results.length, targets: results };
}

// ---------- 触发器：在作品审核/举报处理完成后调用的内置提醒 ----------
// （已直接写入 adminOrg.js — 此处导出仅为文档占位，触发点见 adminOrg.js）
export { scheduleReminder } from '../routes/communication.js';
