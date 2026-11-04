/**
 * P209 实时监控台守卫（2026-11-04）。
 *
 * 钉住四件事：
 *   ① 快照：活跃课堂/在线学生/运行任务、窗口调用与错误率、60 个分钟桶；
 *   ② 机构矩阵 / 课堂下钻 / 学生用量：人数、调用、售价、已知成本、未知成本分开；
 *   ③ 错误流四源合并（attempt / usage / job / vibecoding）+ 按 jobId 去重 + 主备切换降级；
 *   ④ 权限：ADMIN_ANALYTICS 看得到监控，但**看不到**成本/余额字段；余额接口 403。
 * 另外用 fetch stub 验证 RunningHub accountStatus 映射（remainMoney/currency/remainCoins）
 * 和 60 秒缓存（第二次不再打上游）；供应商钱包三家并出、xkwuai quota→USD 且按人民币 1:1、
 * RunningHub 全球站 USD 按 7.2 折算。
 *
 * 跑法：node scripts/p209-monitor.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p209-monitor-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_SECRET_FILE = path.join(temp, 'secrets.json');

const run = (args) => {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
};
run(['packages/database/src/db.js', '--init']);

const { aq, arow, arows } = await import('../packages/database/src/store.js');
const { handleMonitor } = await import('../apps/server/src/routes/admin/monitor.js');
const { getRunningHubBalance, resetRunningHubBalanceCache, probeRunningHubAccount } = await import('../apps/server/src/services/runningHubAccount.js');
const { getWalletBalances, resetWalletBalanceCache, probeXkwuaiAccount } = await import('../apps/server/src/services/walletAccounts.js');
const { setProviderApiKey, clearProviderApiKey } = await import('../apps/server/src/services/providerSecret.js');

const now = new Date().toISOString();
const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  catch (error) { checks.push({ name, ok: false, message: error?.message || String(error) }); console.log(`  ✗ ${name} — ${error?.message || error}`); }
};

await aq('UPDATE platform_settings SET ai_provider_policy=?,updated_at=? WHERE id=1', ['{}', now]);
const future = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
for (const [id, name] of [['org_a', '机构 A'], ['org_b', '机构 B']]) {
  await aq('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [id, name, 'ACTIVE', now, future, now, now]);
}
const insertUser = (id, orgId, login, name, role) => aq(
  'INSERT INTO users(id,org_id,login,display_name,role,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  [id, orgId, login, name, role, 'x', 'ACTIVE', now, now],
);
await insertUser('teacher_a', 'org_a', 'teacher_a', '老师 A', 'TEACHER');
await insertUser('student_a1', 'org_a', 'student_a1', '学生 A1', 'STUDENT');
await insertUser('student_a2', 'org_a', 'student_a2', '学生 A2', 'STUDENT');
await insertUser('student_b1', 'org_b', 'student_b1', '学生 B1', 'STUDENT');

await aq(`INSERT INTO class_sessions(id,title,org_id,teacher_id,status,delivery_mode,started_at,platform_budget_fen,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`, ['sess_a', '课堂 A', 'org_a', 'teacher_a', 'ACTIVE', 'CANVAS', now, 10000, now, now]);
await aq(`INSERT INTO class_sessions(id,title,org_id,teacher_id,status,delivery_mode,started_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`, ['sess_b', '课堂 B', 'org_b', null, 'ACTIVE', 'CANVAS', now, now, now]);
const insertRoster = (id, sessionId, studentId, orgId, status) => aq(
  'INSERT INTO session_students(id,session_id,student_id,org_id,status,added_at) VALUES (?,?,?,?,?,?)',
  [id, sessionId, studentId, orgId, status, now],
);
await insertRoster('roster_a1', 'sess_a', 'student_a1', 'org_a', 'ACTIVE');
await insertRoster('roster_a2', 'sess_a', 'student_a2', 'org_a', 'PENDING');
await insertRoster('roster_b1', 'sess_b', 'student_b1', 'org_b', 'ACTIVE');

const insertProject = (id, studentId, orgId, sessionId, title) => aq(
  'INSERT INTO student_projects(id,student_id,org_id,class_session_id,title,status,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  [id, studentId, orgId, sessionId, title, 'DRAFT', now, now, now],
);
await insertProject('proj_a', 'student_a1', 'org_a', 'sess_a', '项目 A');
await insertProject('proj_b', 'student_b1', 'org_b', 'sess_b', '项目 B');

const insertJob = (id, orgId, userId, projectId, status, errorCode = null, errorMessage = null) => aq(
  'INSERT INTO generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,error_code,error_message,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  [id, orgId, userId, projectId, 'IMAGE', 'runninghub', 'rhart-image-g-2.5-t2i', 'p', status, errorCode, errorMessage, now, now],
);
await insertJob('job_fail', 'org_a', 'student_a1', 'proj_a', 'SUCCEEDED');
await insertJob('job_shared', 'org_a', 'student_a1', 'proj_a', 'FAILED', 'GENERATION_PROVIDER_TIMEOUT', '上游超时');
await insertJob('job_only', 'org_b', 'student_b1', 'proj_b', 'FAILED', 'GENERATION_INTERRUPTED', '服务重启');

const insertAttempt = (id, callId, attempt, orgId, userId, sessionId, jobId, status, { sale = null, costSource = 'UNKNOWN', upstream = null, errorCode = null, errorMessage = null, taskId = null } = {}) => aq(
  `INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,generation_job_id,modality,channel_id,provider,model,routed_via,status,task_id,cost_source,upstream_cost_fen,sale_price_fen,sale_snapshot,error_code,error_message,class_session_id,created_at,completed_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, callId, attempt, orgId, userId, jobId, 'IMAGE', 'channel-runhub-img-main', 'runninghub', 'rhart-image-g-2.5-t2i', 'direct', status, taskId, costSource, upstream, sale, '{}', errorCode, errorMessage, sessionId, now, now],
);
await insertAttempt('att_a1_ok', 'call_a1', 1, 'org_a', 'student_a1', 'sess_a', null, 'SUCCESS', { sale: 500, costSource: 'COMPUTED', upstream: 300 });
await insertAttempt('att_a1_fail', 'call_a1b', 1, 'org_a', 'student_a1', 'sess_a', 'job_fail', 'FAILED', { errorCode: 'GENERATION_PROVIDER_AUTH_FAILED', errorMessage: 'key 无效' });
await insertAttempt('att_a2_unknown', 'call_a2', 1, 'org_a', 'student_a2', 'sess_a', null, 'SUCCESS', { sale: 0, costSource: 'UNKNOWN', upstream: null });
await insertAttempt('att_b1_fail', 'call_b1', 1, 'org_b', 'student_b1', 'sess_b', null, 'FAILED', { errorCode: 'GENERATION_PROVIDER_RATE_LIMITED', errorMessage: '429' });

await aq(`INSERT INTO usage_records(id,org_id,user_id,class_session_id,generation_job_id,modality,model,credits_charged,status,fail_code,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ['usage_blocked', 'org_a', 'student_a2', 'sess_a', null, 'IMAGE', 'rhart-image-g-2.5-t2i', 0, 'BLOCKED', 'SESSION_AI_PAUSED', now]);
await aq(`INSERT INTO usage_records(id,org_id,user_id,class_session_id,generation_job_id,modality,model,credits_charged,status,fail_code,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ['usage_failed_shared', 'org_a', 'student_a1', 'sess_a', 'job_shared', 'IMAGE', 'rhart-image-g-2.5-t2i', 0, 'FAILED', 'GENERATION_FAILED', now]);

await aq(`INSERT INTO vibecoding_conversations(id,org_id,student_id,class_session_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
  ['conv_a', 'org_a', 'student_a1', 'sess_a', '对话 A', now, now]);
await aq(`INSERT INTO vibecoding_messages(id,conversation_id,role,content,status,error_code,created_at) VALUES (?,?,?,?,?,?,?)`,
  ['msg_a', 'conv_a', 'assistant', '', 'FAILED', 'GENERATION_PROVIDER_UPSTREAM_ERROR', now]);

const rootAuth = { user: { id: 'u_root', role: 'SUPER_ADMIN', login: 'root', permissions: [] } };
const analyticsAuth = { user: { id: 'u_ana', role: 'SUPER_ADMIN', login: 'analytics', permissions: ['ADMIN_ANALYTICS'] } };
const call = (suffix, search = {}, auth = rootAuth) => handleMonitor(
  { auth, search: new URLSearchParams(search), pathname: `/api/admin/dashboard/monitor${suffix}`, method: 'GET' },
  `/dashboard/monitor${suffix}`,
  'GET',
);

const snapshot = await call('/snapshot', { window: '5m' });
await check('快照：活跃课堂 2 / 在线学生 2 / 按窗口的分钟桶', async () => {
  assert.equal(snapshot.live.activeSessions, 2);
  assert.equal(snapshot.live.activeStudents, 2);
  assert.equal(snapshot.series.length, 5);
  const hour = await call('/snapshot', { window: '60m' });
  assert.equal(hour.series.length, 60);
});
await check('快照：5 分钟调用 4（成功 2 / 失败 2）、错误率 50%、拦截 1', () => {
  assert.equal(snapshot.usage.calls, 4);
  assert.equal(snapshot.usage.success, 2);
  assert.equal(snapshot.usage.failed, 2);
  assert.equal(snapshot.usage.errorRate, 50);
  assert.equal(snapshot.usage.blocked, 1);
});
await check('快照：机构人数与课堂数', () => {
  const orgA = snapshot.orgs.find((item) => item.id === 'org_a');
  const orgB = snapshot.orgs.find((item) => item.id === 'org_b');
  assert.equal(orgA.teachers, 1);
  assert.equal(orgA.students, 2);
  assert.equal(orgA.activeSessions, 1);
  assert.equal(orgB.students, 1);
});
await check('快照：售价/已知成本/未知成本分开（不混 usage_records.cost_fen）', () => {
  assert.equal(snapshot.usage.saleFen, 500);
  assert.equal(snapshot.usage.knownCostFen, 300);
  assert.equal(snapshot.usage.unknownCostCalls, 1);
  const session = snapshot.sessions.find((item) => item.id === 'sess_a');
  assert.equal(session.calls, 3);
  assert.equal(session.saleFen, 500);
  assert.equal(session.knownCostFen, 300);
  assert.equal(session.unknownCostCalls, 1);
  // 与 classroomBudgetStatus 同口径：只要有一笔成本未知（含失败尝试），整场就是 UNKNOWN，不谎报“没超”
  assert.equal(session.budget.state, 'UNKNOWN');
});
await check('权限：只有 ADMIN_ANALYTICS 时不下发成本字段', async () => {
  const limited = await call('/snapshot', { window: '5m' }, analyticsAuth);
  assert.equal(limited.billingVisible, false);
  assert.equal(limited.usage.saleFen, undefined);
  assert.equal(limited.usage.knownCostFen, undefined);
  assert.equal(limited.orgs[0].knownCostFen, undefined);
  assert.equal(limited.sessions[0].saleFen, undefined);
  assert.equal(limited.sessions[0].budget.knownCostFen, undefined);
});

const classroom = await call('/classroom/sess_a');
await check('课堂下钻：名单 2 人，A1 调用 2 / 成本 300，A2 未知 1 笔', () => {
  assert.equal(classroom.students.length, 2);
  const a1 = classroom.students.find((item) => item.userId === 'student_a1');
  const a2 = classroom.students.find((item) => item.userId === 'student_a2');
  assert.equal(a1.calls, 2);
  assert.equal(a1.success, 1);
  assert.equal(a1.failed, 1);
  assert.equal(a1.knownCostFen, 300);
  assert.equal(a2.calls, 1);
  assert.equal(a2.unknownCostCalls, 1);
  assert.equal(classroom.totals.calls, 3);
  assert.equal(classroom.budget.budgetFen, 10000);
});

const errors = await call('/errors', { since: now, limit: 50 });
await check('错误流：四源合并、jobId 去重、主备切换降级为 warning', () => {
  const byJob = errors.items.find((item) => item.jobId === 'job_shared');
  assert.ok(byJob, '缺少 job_shared');
  assert.deepEqual([...byJob.sources].sort(), ['JOB', 'USAGE']);
  const failover = errors.items.find((item) => item.jobId === 'job_fail');
  assert.equal(failover.severity, 'warning');
  assert.equal(failover.recovered, true);
  assert.ok(errors.items.some((item) => item.errorCode === 'SESSION_AI_PAUSED'));
  assert.ok(errors.items.some((item) => item.errorCode === 'GENERATION_INTERRUPTED' && item.severity === 'critical'));
  assert.ok(errors.items.some((item) => item.errorCode === 'GENERATION_PROVIDER_UPSTREAM_ERROR' && item.source === 'VIBE'));
});

// 余额：stub 掉 fetch，验证映射与 60s 缓存
await aq('UPDATE platform_settings SET ai_provider_policy=?,updated_at=? WHERE id=1', [
  JSON.stringify({ channels: [{ id: 'channel-rh', name: 'RH 主', provider: 'runninghub', endpoint: 'https://www.runninghub.ai/openapi/v2' }] }), now,
]);
setProviderApiKey('rh-test-key', 'channel-rh');
resetRunningHubBalanceCache();
const realFetch = globalThis.fetch;
let accountCalls = 0;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes('runninghub.cn') && target.includes('/uc/openapi/accountStatus')) {
    return new Response(JSON.stringify({ code: 0, msg: 'success', data: { remainMoney: '720', remainCoins: '0', currency: 'CNY', currentTaskCounts: '1', apiType: 'SHARED' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (target.includes('/uc/openapi/accountStatus')) {
    accountCalls += 1;
    return new Response(JSON.stringify({ code: 0, msg: 'success', data: { remainMoney: '199.5', remainCoins: '9', currency: 'CNY', currentTaskCounts: '2', apiType: 'SHARED' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (target.includes('xkwuai.cn/api/user/self')) {
    return new Response(JSON.stringify({ success: true, data: { quota: 2500000, used_quota: 100, username: 'xkw' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (target.includes('xkwuai.cn/api/status')) {
    return new Response(JSON.stringify({ data: { quota_per_unit: 500000, quota_display_type: 'USD' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, options);
};
try {
  const balance = await getRunningHubBalance({ refresh: true });
  await check('余额：accountStatus 映射 remainMoney/currency/remainCoins/任务数', () => {
    assert.equal(balance.ok, true);
    const account = balance.accounts[0];
    assert.equal(account.amount, 199.5);
    assert.equal(account.currency, 'CNY');
    assert.equal(account.currencyLike, 'CNY');
    assert.equal(account.remainCoins, 9);
    assert.equal(account.currentTaskCounts, 2);
    assert.equal(account.apiType, 'SHARED');
    assert.equal(accountCalls, 1);
  });
  const cached = await getRunningHubBalance();
  await check('余额：60 秒缓存，第二次不再打上游', () => {
    assert.equal(cached.cached, true);
    assert.equal(accountCalls, 1);
  });

  // 供应商钱包：RH 全球 + RH 国内 + xkwuai，USD 统一按 7.2 折人民币
  setProviderApiKey('cn-test-key', 'wallet-runninghub-cn');
  setProviderApiKey(JSON.stringify({ token: 'xk-test-token', userId: '7' }), 'wallet-xkwuai');
  resetWalletBalanceCache();
  const wallets = await getWalletBalances({ refresh: true, runningHub: balance });
  await check('钱包：三家并出，CN 原币、xkwuai quota→USD 5 且按人民币 1:1、RH 全球 USD×7.2', () => {
    const byId = Object.fromEntries(wallets.sources.map((item) => [item.id, item]));
    assert.equal(wallets.fx.usdCny, 7.2);
    assert.deepEqual(Object.keys(byId).sort(), ['runninghub-cn', 'runninghub-global', 'xkwuai']);
    assert.equal(byId['runninghub-global'].amount, 199.5);
    assert.equal(byId['runninghub-global'].cny, 199.5);
    assert.equal(byId['runninghub-cn'].ok, true);
    assert.equal(byId['runninghub-cn'].amount, 720);
    assert.equal(byId['runninghub-cn'].cny, 720);
    assert.equal(byId['xkwuai'].ok, true);
    assert.equal(byId['xkwuai'].amount, 5);
    assert.equal(byId['xkwuai'].cny, 5);
  });

  const usdWallets = await getWalletBalances({ refresh: true, runningHub: { accounts: [{ ok: true, amount: 15.009, currency: 'USD', currencyLike: 'USD' }] } });
  await check('钱包：全球站 USD 余额折人民币（15.009 → ¥108.06）', () => {
    assert.equal(usdWallets.sources.find((item) => item.id === 'runninghub-global').cny, 108.06);
  });

  clearProviderApiKey('wallet-runninghub-cn');
  clearProviderApiKey('wallet-xkwuai');
  resetWalletBalanceCache();
  const emptyWallets = await getWalletBalances({ refresh: true, runningHub: { accounts: [] } });
  await check('钱包：未配置 Key/令牌时如实报未配置，不记成 0', () => {
    for (const id of ['runninghub-cn', 'xkwuai']) {
      const item = emptyWallets.sources.find((source) => source.id === id);
      assert.equal(item.ok, false);
      assert.equal(item.reason, 'NOT_CONFIGURED');
      assert.equal(item.amount, null);
      assert.equal(item.cny, null);
    }
  });
  const noToken = await probeXkwuaiAccount({});
  await check('钱包：xkwuai 没有令牌时直接返回 NO_API_KEY', () => {
    assert.equal(noToken.ok, false);
    assert.equal(noToken.reason, 'NO_API_KEY');
  });

  let forbidden = null;
  try { await call('/balance', {}, analyticsAuth); } catch (error) { forbidden = error; }
  await check('余额：没有 ADMIN_BILLING 时 403 PERMISSION_DENIED', () => {
    assert.equal(forbidden?.code, 'PERMISSION_DENIED');
    assert.equal(forbidden?.status, 403);
  });
  await check('余额：单次探测拒绝非 RunningHub 地址', async () => {
    const result = await probeRunningHubAccount({ endpoint: 'https://api.example.com/v1', apiKey: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.error, /RunningHub/);
  });
} finally {
  globalThis.fetch = realFetch;
  resetRunningHubBalanceCache();
  resetWalletBalanceCache();
}

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
