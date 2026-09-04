import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname);
const nodeExe = process.execPath;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p8-q02-'));
const data = path.join(root, 'data');
const dbPath = path.join(data, 'platform.db');
const env = { ...process.env, DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: data, PLATFORM_DB_PATH: dbPath, AUTH_PEPPER: 'p8-q02-temporary-only', AI_PROVIDER: 'local-mock' };
let pass = 0; let fail = 0;
function check(name, value) { if (value) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.error(`FAIL ${name}`); } }
function throwsCode(fn, code) { try { fn(); return false; } catch (error) { return error?.code === code; } }
try {
  fs.mkdirSync(data, { recursive: true });
  execFileSync(nodeExe, ['packages/database/src/db.js'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync(nodeExe, ['packages/database/src/seed.js'], { cwd: repo, env, stdio: 'pipe' });
  Object.assign(process.env, { DEPLOYMENT_MODE: 'internal-test', PLATFORM_DATA_DIR: data, PLATFORM_DB_PATH: dbPath, AUTH_PEPPER: 'p8-q02-temporary-only', AI_PROVIDER: 'local-mock' });
  const { row } = await import('./packages/database/src/schema.js');
  const lib = await import('./apps/server/src/lib.js');
  const ledger = await import('./apps/server/src/services/creditLedger.js');
  const orgId = row("SELECT id FROM organizations ORDER BY created_at LIMIT 1")?.id;
  const actorId = row("SELECT id FROM users WHERE role='PLATFORM_ADMIN' LIMIT 1")?.id;
  check('测试库与 seed 隔离', fs.existsSync(dbPath) && dbPath.startsWith(root) && Boolean(orgId));
  const hash = lib.hashPassword('Unit#123');
  check('密码哈希可验证正确密码', lib.verifyPassword('Unit#123', hash));
  check('密码哈希拒绝错误密码', !lib.verifyPassword('wrong', hash));
  check('tokenHash 对同一 token 稳定', lib.tokenHash('abc') === lib.tokenHash('abc') && lib.tokenHash('abc') !== lib.tokenHash('abd'));
  check('ApiError 输出不含堆栈', lib.errors.badRequest('bad', 'BAD').toResponse().error.code === 'BAD' && !JSON.stringify(lib.errors.badRequest('bad', 'BAD').toResponse()).includes('stack'));
  check('requestContext 规范化路径和方法', lib.requestContext({ url: 'http://local/a///?x=1', method: 'post' }).pathname === '/a' && lib.requestContext({ url: 'http://local/a///?x=1', method: 'post' }).method === 'POST');
  const normalized = ledger.normalizeEntry({ id: 'e1', org_id: orgId, direction: 'OUT', type: 'AI_SPEND', credits: 3, balance_after: 7, class_session_id: 's1', created_at: '2026-09-04T00:00:00Z' });
  check('积分流水 normalize 字段映射', normalized.orgId === orgId && normalized.credits === 3 && normalized.sessionId === 's1' && normalized.balanceAfter === 7);
  const added = ledger.adjustCredits({ orgId, type: 'ORG_ADJUSTMENT_IN', credits: 100, reason: 'unit test top up', actorId });
  check('人工入账增加余额并写流水', added.balanceAfter > 0 && added.entry.direction === 'IN' && added.entry.type === 'ORG_ADJUSTMENT_IN');
  const spent = ledger.adjustCredits({ orgId, type: 'ORG_ADJUSTMENT_OUT', credits: 30, reason: 'unit test spend', actorId });
  check('人工出账减少余额并写流水', spent.balanceAfter === added.balanceAfter - 30 && spent.entry.direction === 'OUT');
  check('无效人工账务类型被拒绝', throwsCode(() => ledger.adjustCredits({ orgId, type: 'BAD', credits: 1, reason: 'x', actorId }), 'INVALID_CREDIT_ADJUSTMENT_TYPE'));
  check('人工调整必须填写原因', throwsCode(() => ledger.adjustCredits({ orgId, type: 'ORG_ADJUSTMENT_IN', credits: 1, reason: '', actorId }), 'ADJUSTMENT_REASON_REQUIRED'));
  check('人工出账不得透支', throwsCode(() => ledger.adjustCredits({ orgId, type: 'ORG_ADJUSTMENT_OUT', credits: 99999999, reason: 'too much', actorId }), 'INSUFFICIENT_CREDITS'));
  const reversed = ledger.refundOrReverseEntry({ orgId, sourceEntryId: spent.entryId, reason: 'unit test reversal', actorId, mode: 'REVERSAL' });
  check('冲正生成反向流水并作废源流水', reversed.entry.reversalOf === spent.entryId && reversed.sourceEntry.status === 'VOIDED');
  check('同一流水不可重复冲正', throwsCode(() => ledger.refundOrReverseEntry({ orgId, sourceEntryId: spent.entryId, reason: 'duplicate', actorId, mode: 'REVERSAL' }), 'CREDIT_ENTRY_ALREADY_VOIDED'));
  const held = ledger.setFrozenCredits({ orgId, frozenCredits: 10, reason: 'unit hold', actorId });
  check('冻结积分减少可用余额并写留痕', held.frozenCredits === 10 && held.entry.type === 'FROZEN_HOLD');
  const released = ledger.setFrozenCredits({ orgId, frozenCredits: 0, reason: 'unit release', actorId });
  check('释放冻结积分恢复可用余额', released.frozenCredits === 0 && released.entry.type === 'FROZEN_RELEASE');
  check('零积分扣费安全跳过', ledger.chargeCreditsInTransaction({ orgId, credits: 0, type: 'AI_SPEND' }).skipped === true);
  console.log(JSON.stringify({ pass, fail, status: fail === 0 ? 'UNIT_BASELINE_READY' : 'FAILED', database: dbPath }, null, 2));
  if (fail > 0) process.exitCode = 1;
} catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
finally { for (let i = 0; i < 8; i += 1) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } }
