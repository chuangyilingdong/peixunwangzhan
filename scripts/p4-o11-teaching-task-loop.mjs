/**
 * P4-O11 机构端/老师端「课堂任务」等 7 个功能的**删除守卫**（2026-09-11 按用户要求整套删除）。
 *
 * 这个脚本原来是「课堂任务闭环」的正向用例（发布任务 → 学生看到 → 开始/提交 → 老师看提交队列）。
 * 用户要求把机构端的 7 样东西删掉（课堂任务 / 进入学习上课 / 积分流水 / 积分账务 /
 * 作品数据中心 / 积分套餐 / 账号申请），所以它改成**反向守卫**：
 *   ① 被删的接口必须 404（课堂任务的老师端与学生端、作品数据中心、积分流水与账务、
 *      账号申请、机构端不可达的两个充值查询）；
 *   ② 保留的接口必须还活着（别把不该删的删了 —— 这条比 ① 更重要）。
 * 数据库表保留（learning_tasks / account_requests / recharge_orders 等只留历史数据，代码不读写）。
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
const root = path.resolve(process.cwd()); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-task-removed-')); const env = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: path.join(temp, 'platform.db'), DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => { const c = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let o = '', e = ''; c.stdout.on('data', (x) => o += x); c.stderr.on('data', (x) => e += x); c.on('close', (n) => n ? reject(new Error(e || o)) : resolve(o)); });
await run(['packages/database/src/db.js', '--init']); await run(['packages/database/src/seed.js']);
const port = 18812;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', (x) => log += x); server.stderr.on('data', (x) => log += x);
const base = `http://127.0.0.1:${port}/api`; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait() { for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* wait */ } await sleep(100); } throw Error(log); }
async function req(token, p, opts = {}) { const r = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } }); const b = await r.json().catch(() => ({})); return { status: r.status, data: b.data, raw: b }; }
async function login(loginName, password) { const r = await req('', '/auth/login', { method: 'POST', body: JSON.stringify({ login: loginName, password }) }); if (r.status !== 200) throw Error(JSON.stringify(r.raw)); return r.data.token; }
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };
const gone = async (label, token, p, method = 'GET', body) => { const r = await req(token, p, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); check(`${label} 已删除（404）`, r.status === 404, `实际 ${r.status} ${JSON.stringify(r.raw || r.data || {}).slice(0, 90)}`); };
const alive = async (label, token, p, expect = 200) => { const r = await req(token, p); check(`${label} 仍然可用（${expect}）`, r.status === expect, `实际 ${r.status} ${JSON.stringify(r.raw || r.data || {}).slice(0, 90)}`); };

try {
  await wait();
  const admin = await login('org-admin', 'org123');
  const teacher = await login('teacher-1', 'teach123');
  const student = await login('student-1', 'study123');

  // ① 被删的接口：机构端与老师端（课堂任务 / 作品数据中心 / 积分账务 / 积分流水 / 账号申请）
  await gone('机构端课堂任务列表', teacher, '/org/teaching/tasks');
  await gone('机构端发布课堂任务', teacher, '/org/teaching/tasks', 'POST', { classId: 'x', title: 'x' });
  await gone('机构端任务提交队列', teacher, '/org/teaching/tasks/t1/submissions');
  await gone('机构端班级学习进度', teacher, '/org/teaching/classes/c1/progress');
  await gone('机构端作品数据中心', admin, '/org/work-data');
  await gone('机构端作品数据中心导出', admin, '/org/work-data/export');
  await gone('机构端账号总览（积分账务）', admin, '/org/billing/account-overview');
  await gone('机构端积分流水列表', admin, '/org/billing/credit-entries');
  await gone('机构端人工调整积分', admin, '/org/billing/credit-adjustments', 'POST', { type: 'ORG_ADJUSTMENT_IN', credits: 1, reason: 'x' });
  await gone('机构端冻结积分', admin, '/org/billing/frozen-credits', 'PUT', { frozenCredits: 0, reason: 'x' });
  await gone('机构端积分对账', admin, '/org/billing/reconciliation');
  await gone('机构端积分对账导出', admin, '/org/billing/reconciliation/export');
  await gone('机构端积分流水查询', admin, '/org/billing/transactions');
  await gone('机构端账号申请列表', admin, '/org/account-requests');
  await gone('机构端账号申请处理', admin, '/org/account-requests/r1', 'PUT', { status: 'APPROVED', resolution: 'x' });
  await gone('机构端充值历史（本就不可达）', admin, '/org/organizations/org-1/billing/recharge-history');
  await gone('机构端账户信息（本就不可达）', admin, '/org/organizations/org-1/billing/account');
  // 学生端的学习任务一起删掉：机构端没有发布入口了，留着就是「谁都不能创建的任务清单」
  await gone('学生学习任务列表', student, '/student/learning/tasks');
  await gone('学生开始任务', student, '/student/learning/tasks/t1/start', 'POST', {});

  // ② 保留的接口必须还活着（比 ① 更要紧：删多了就是这时候照出来）
  await alive('机构总览', admin, '/org/overview');
  await alive('机构班级列表', admin, '/org/classes');
  await alive('机构成员列表', admin, '/org/users');
  await alive('机构作品列表', admin, '/org/works');
  await alive('机构举报列表', admin, '/org/work-reports');
  await alive('机构课包列表', admin, '/org/course-series');
  await alive('机构审计日志', admin, '/org/audit-logs');
  await alive('学员开通单', admin, '/org/billing/enrollments');
  await alive('学员套餐列表（学员开通要用）', admin, '/org/billing/packages');
  await alive('积分用量概览', admin, '/org/billing/usage-overview');
  await alive('AI 用量明细', admin, '/org/ai-usage');
  await alive('成员配额列表', admin, '/org/members/credits');
  await alive('问题反馈列表', admin, '/org/help-feedback');
  await alive('学生看板（学生端仍可用）', student, '/student/dashboard');
  await alive('学生学习总览', student, '/student/learning/overview');
  await alive('学生课程列表', student, '/student/courses');

  console.log(JSON.stringify({ name: 'org-features-removed', pass: failures === 0, removed: 7, failures }, null, 2));
} catch (error) {
  console.error(log);
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
