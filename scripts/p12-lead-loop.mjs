/**
 * P12 官网预约线索闭环测试。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：官网公开表单写入线索 → 平台管理端可见 → 状态按合法路径流转 →
 * 非法流转被拒 → 跟进记录落库。
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(path.join(tmpdir(), 'p12-lead-loop-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';

const LEGAL_VERSION = '2026.09.03';
const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
async function expectError(fn, code, label) {
  try { await fn(); failures.push(`${label}: expected ${code}`); }
  catch (error) { check(error?.code === code, `${label}: got ${error?.code || error?.message}`); }
}

const publicCtx = (pathname, method, body) => ({ pathname, method, body, auth: null, search: new URLSearchParams(), req: { socket: { remoteAddress: '127.0.0.1' } } });
const adminAuth = { user: { id: 'root', login: 'root', displayName: 'Root', role: 'SUPER_ADMIN', orgId: null, permissions: [] }, rawUser: { permissions: '[]' } };
const adminCtx = (pathname, method = 'GET', body = {}) => ({ pathname, method, body, auth: adminAuth, search: new URLSearchParams(), req: { socket: { remoteAddress: '127.0.0.1' } } });

try {
  const { handlePublicCommunication, handleAdminCommunication } = await import('../apps/server/src/routes/communication.js');
  const { row } = await import('../apps/server/src/lib.js');

  // 官网公开预约表单
  const created = await handlePublicCommunication(publicCtx('/api/public/contact', 'POST', {
    orgName: '测试创新学校', contactName: '张三', contactPhone: '13800000000',
    intent: '想了解课程', notes: '希望本周联系', legalConsentVersion: LEGAL_VERSION, legalConsentAt: new Date().toISOString(),
  }));
  check(Boolean(created?.id), '公开预约表单应返回线索 id');
  check(created?.status === 'NEW', `新建线索状态应为 NEW，实际 ${created?.status}`);

  // 平台管理端可见
  const listed = await handleAdminCommunication(adminCtx('/api/admin/leads'));
  check((listed?.items || []).length === 1, `管理端应能看到 1 条线索，实际 ${(listed?.items || []).length}`);
  const lead = listed.items[0];
  check(lead.orgName === '测试创新学校' && lead.contactPhone === '13800000000', '线索字段映射不正确');
  check(lead.legalConsentVersion === LEGAL_VERSION, '线索应保留法务同意版本');

  // 非法流转：NEW 不能直接到 CONVERTED
  await expectError(() => handleAdminCommunication(adminCtx('/api/admin/leads/' + lead.id, 'PUT', { status: 'CONVERTED' })), 'INVALID_LEAD_STATUS_TRANSITION', 'illegal transition');

  // 合法流转 + 跟进记录
  const contacted = await handleAdminCommunication(adminCtx('/api/admin/leads/' + lead.id, 'PUT', { status: 'CONTACTED', assignedTo: '小美', adminNotes: '已电话联系，约周三演示' }));
  check(contacted?.status === 'CONTACTED' && contacted?.assignedTo === '小美', '状态与跟进人应更新');
  check(String(contacted?.adminNotes || '').includes('周三'), '跟进记录应落库');
  const demo = await handleAdminCommunication(adminCtx('/api/admin/leads/' + lead.id, 'PUT', { status: 'DEMO_SCHEDULED' }));
  check(demo?.status === 'DEMO_SCHEDULED', '应能推进到已约演示');
  const converted = await handleAdminCommunication(adminCtx('/api/admin/leads/' + lead.id, 'PUT', { status: 'CONVERTED' }));
  check(converted?.status === 'CONVERTED', '应能推进到已转化');

  // 状态变更写审计
  const auditRow = row("SELECT COUNT(*) AS n FROM audit_logs WHERE action='LEAD_UPDATE'");
  check(Number(auditRow?.n || 0) >= 3, `线索状态变更应写审计，实际 ${auditRow?.n || 0} 条`);

  if (failures.length) throw new Error(failures.join('; '));
  console.log('P12 lead loop passed');
} finally {
  // 临时目录留给 OS 清理；不触碰任何项目/生产数据。
}
