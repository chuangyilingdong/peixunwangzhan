/**
 * P4-O09 自动提醒验收（隔离临时 SQLite）
 *
 * 覆盖：
 * - 低余额扫描：通知机构管理员，重复扫描去重
 * - 合同到期扫描：通知机构管理员，重复扫描去重
 * - scheduleReminder：通知与收件人落库，禁用用户不投递
 *
 * 本脚本只创建操作系统临时目录中的 SQLite，不打开或修改默认/生产数据库。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'p4-o09-reminders-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';

const schema = await import('../packages/database/src/schema.js');
const seed = await import('../packages/database/src/seed.js');
const communication = await import('../apps/server/src/routes/communication.js');
const scheduler = await import('../apps/server/src/services/reminderScheduler.js');

const { db } = schema;
const seeded = seed.seedDatabase();
const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(seeded.organizationId);
const orgAdmin = db.prepare("SELECT * FROM users WHERE org_id=? AND role='ORG_ADMIN'").get(seeded.organizationId);

const checks = [];
function check(name, condition, details = {}) {
  checks.push({ name, pass: Boolean(condition), details });
  if (!condition) throw new Error(`${name} failed: ${JSON.stringify(details)}`);
}

try {
  // 1) low balance scan + event-key deduplication
  db.prepare('UPDATE org_billing_accounts SET credit_balance=0 WHERE org_id=?').run(seeded.organizationId);
  const lowFirst = scheduler.scanLowBalanceOrgs();
  const lowSecond = scheduler.scanLowBalanceOrgs();
  const lowRecipients = db.prepare("SELECT COUNT(*) AS count FROM notification_recipients WHERE event_key=? AND user_id=? AND delivery_status='DELIVERED'").get(`LOW_BALANCE:${seeded.organizationId}`, orgAdmin.id).count;
  check('low-balance first scan finds active organization', lowFirst.length === 1 && lowFirst[0].orgId === seeded.organizationId, { lowFirst });
  check('low-balance first scan targets organization admin', Number(lowFirst[0]?.adminCount) >= 1, { lowFirst });
  check('low-balance second scan is deduplicated', lowSecond.length === 0 && Number(lowRecipients) === 1, { lowSecond, lowRecipients });

  // 2) contract expiry scan + event-key deduplication
  const expiry = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE organizations SET contract_expires_at=? WHERE id=?').run(expiry, seeded.organizationId);
  const contractFirst = scheduler.scanContractExpiryOrgs();
  const contractSecond = scheduler.scanContractExpiryOrgs();
  const contractRecipients = db.prepare("SELECT COUNT(*) AS count FROM notification_recipients WHERE event_key LIKE ? AND user_id=? AND delivery_status='DELIVERED'").get(`CONTRACT_EXPIRY:${seeded.organizationId}:%`, orgAdmin.id).count;
  check('contract-expiry first scan finds organization in 7-day window', contractFirst.length === 1 && contractFirst[0].orgId === seeded.organizationId, { contractFirst });
  check('contract-expiry first scan reports positive days remaining', Number(contractFirst[0]?.daysLeft) >= 1 && Number(contractFirst[0]?.daysLeft) <= 4, { contractFirst });
  check('contract-expiry second scan is deduplicated', contractSecond.length === 0 && Number(contractRecipients) === 1, { contractSecond, contractRecipients });

  // 3) direct scheduleReminder persistence and disabled-user guard
  const directKey = `P4-O09-ACCEPTANCE:${Date.now()}`;
  const direct = communication.scheduleReminder({
    title: 'P4-O09 验收提醒',
    body: '隔离数据库验收记录',
    targetUserId: orgAdmin.id,
    targetOrgId: seeded.organizationId,
    eventKey: directKey,
    targetUrl: '/admin/billing',
  });
  const directAgain = communication.scheduleReminder({
    title: 'P4-O09 验收提醒',
    body: '隔离数据库验收记录',
    targetUserId: orgAdmin.id,
    targetOrgId: seeded.organizationId,
    eventKey: directKey,
    targetUrl: '/admin/billing',
  });
  const disabledId = 'p4-o09-disabled-user';
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,org_id,login,display_name,role,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(disabledId, seeded.organizationId, disabledId, '验收禁用用户', 'STUDENT', 'not-a-password', 'DISABLED', now, now);
  const disabled = communication.scheduleReminder({
    title: '不应投递',
    body: '禁用用户不得收到提醒',
    targetUserId: disabledId,
    targetOrgId: seeded.organizationId,
    eventKey: `P4-O09-DISABLED:${Date.now()}`,
  });
  check('scheduleReminder writes notification and delivered recipient', Boolean(direct.notificationId && direct.recipientId && !direct.suppressed), { direct });
  check('scheduleReminder deduplicates same user and event key', Boolean(directAgain.suppressed && directAgain.reason === 'event_dedup'), { directAgain });
  check('scheduleReminder skips disabled user', disabled.notificationId === null && disabled.reason === 'USER_NOT_FOUND_OR_DISABLED', { disabled });

  const totals = {
    notifications: db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count,
    deliveredRecipients: db.prepare("SELECT COUNT(*) AS count FROM notification_recipients WHERE delivery_status='DELIVERED'").get().count,
  };
  const output = { ok: true, database: 'isolated-temporary-sqlite', organizationId: seeded.organizationId, checks, totals };
  console.log(JSON.stringify(output, null, 2));} finally {
  // communication.js 注册了 exit 清理钩子；先停止 worker，保持数据库打开直到进程退出，避免 exit 钩子访问已关闭连接。
  communication.shutdownCommunicationWorkers();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* Windows may release SQLite handles after process exit; directory remains isolated temp data. */ }
}
