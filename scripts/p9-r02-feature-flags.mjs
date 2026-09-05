/**
 * P9-R02 Feature Flag 隔离验收。
 * 只创建操作系统临时 SQLite，不读取或修改默认 / 生产数据库。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'p9-r02-feature-flags-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';

try {
  const { handleFeatureFlags } = await import('../apps/server/src/routes/featureFlags.js');
  const { q } = await import('../apps/server/src/lib.js');
  q("INSERT INTO users(id,login,display_name,role,password_hash,created_at,updated_at) VALUES ('admin_test','admin_test','Test Admin','SUPER_ADMIN','x',datetime('now'),datetime('now'))");
  const admin = { user: { id: 'admin_test', role: 'SUPER_ADMIN', orgId: null, permissions: ['ADMIN_FEATURE_FLAGS'] }, rawUser: { permissions: '["ADMIN_FEATURE_FLAGS"]' } };
  const ctx = (method, pathname, body, auth = admin) => ({ method, pathname, body, auth, search: new URLSearchParams(), req: { socket: {} } });
  const created = handleFeatureFlags(ctx('POST', '/api/admin/feature-flags', { key: 'real-ai-generation', name: '真实 AI 生成', defaultEnabled: false, rolloutPercent: 0, enabledOrgIds: ['org_test'], enabledUserIds: [] }));
  const allowlisted = handleFeatureFlags(ctx('GET', '/api/feature-flags', {}, { user: { id: 'student_test', orgId: 'org_test' } }));
  handleFeatureFlags(ctx('PATCH', '/api/admin/feature-flags/real-ai-generation', { enabled: false }));
  const switchedOff = handleFeatureFlags(ctx('GET', '/api/feature-flags', {}, { user: { id: 'student_test', orgId: 'org_test' } }));
  if (created.key !== 'real-ai-generation') throw new Error('create failed');
  if (!allowlisted.flags['real-ai-generation']) throw new Error('organization allowlist failed');
  if (switchedOff.flags['real-ai-generation']) throw new Error('master switch failed');
  console.log('P9-R02 feature flag matrix: 3/3 passed');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite may release handles at process exit. */ }
}
