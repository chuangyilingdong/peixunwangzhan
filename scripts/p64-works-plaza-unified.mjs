/**
 * P64 作品发布：机构端审批已下线 + 两条链路一套状态话术（2026-09-12，梳理文档第 5 节）。
 *
 * 两件事：
 *   ① **平台是唯一审核方**：机构端审批接口与学生端「申请发布」接口都已下线（两边的界面早已不存在，
 *      留着的话学生点了也没人能处理 —— 是一条死路）。历史数据（work_publish_requests 表）仍可读，
 *      平台端作品详情还能看到历史申请。
 *   ② **状态话术统一**：两条链路（画布 works / VibeCoding vibecoding_submissions）以前各说一套，
 *      现在对外只讲「已提交待发布 / 已发布到作品广场 / 精选 / 已下架」，由 packages/shared 的
 *      workPlazaState() 一处推导（只读层，不动库里 status 语义）。
 * 这一条把②的推导逻辑钉住（纯函数，四种状态的优先级与「下架优先」都要对）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p64-work-plaza-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(code)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

/* ── ① 状态推导（纯函数，不需要服务） ── */
const { workPlazaState, workPlazaLabel } = await import('../packages/shared/src/worksState.js');
check('没提交过（不在广场、没下架原因、没精选）→ 已提交待发布', workPlazaState({}) === 'SUBMITTED', workPlazaState({}));
check('画布链路在广场（plazaPublished）→ 已发布到作品广场', workPlazaState({ plazaPublished: true }) === 'PLAZA');
check('VibeCoding 链路在广场（isPublic）→ 同一句话', workPlazaState({ isPublic: true }) === 'PLAZA');
check('精选优先于「在广场」（精选作品本来就在广场上）', workPlazaState({ plazaPublished: true, featured: true }) === 'FEATURED');
check('**下架优先**：有下架原因且不在广场 → 已下架（哪怕 status 还写着 APPROVED）',
  workPlazaState({ status: 'APPROVED', unpublishReason: '含联系方式', plazaPublished: false }) === 'UNPUBLISHED',
  workPlazaState({ status: 'APPROVED', unpublishReason: '含联系方式', plazaPublished: false }));
check('重新发布后（在广场）不再显示已下架', workPlazaState({ plazaPublished: true, unpublishReason: '旧原因' }) === 'PLAZA');
check('两条链路同一件事同一句话（画布 vs VibeCoding）',
  workPlazaLabel({ plazaPublished: true }) === workPlazaLabel({ isPublic: true }) &&
  workPlazaLabel({ unpublishReason: 'x' }) === workPlazaLabel({ isPublic: false, unpublishReason: 'x' }),
  `${workPlazaLabel({ plazaPublished: true })} / ${workPlazaLabel({ isPublic: false, unpublishReason: 'x' })}`);

/* ── ② 审批链路已下线（起服务，打那两个接口应当不认识） ── */
const port = 18997;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const org = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(org && student, '登录失败');

  const orgList = await api('/api/org/work-publish-requests', { token: org });
  check('① 机构端「发布申请列表」接口已下线（404，界面本来就不存在）', orgList.status === 404, `${orgList.status} ${orgList.error?.code}`);
  const orgAct = await api('/api/org/work-publish-requests/whatever', { method: 'PUT', token: org, body: { status: 'APPROVED' } });
  check('① 机构端「审批」接口已下线（404）', orgAct.status === 404, `${orgAct.status} ${orgAct.error?.code}`);
  const studentAsk = await api('/api/student/works/whatever/publish-request', { method: 'POST', token: student, body: {} });
  check('① 学生端「申请发布」接口已下线（404；留着就是点了没人处理的死路）', studentAsk.status === 404, `${studentAsk.status} ${studentAsk.error?.code}`);
  const studentWithdraw = await api('/api/student/works/whatever/publish-request/withdraw', { method: 'POST', token: student, body: {} });
  check('① 学生端「撤回申请」接口已下线（404）', studentWithdraw.status === 404, `${studentWithdraw.status} ${studentWithdraw.error?.code}`);

  // 学生自己的作品列表仍要能读（历史申请/下架原因照常展示）—— 删接口不能把读取路径删坏
  const myWorks = await api('/api/student/works?limit=5', { token: student });
  check('① 学生端作品列表仍可读（没把读取路径删坏）', myWorks.status === 200 && Array.isArray(myWorks.data?.items), JSON.stringify(myWorks).slice(0, 200));

  console.log(JSON.stringify({ name: 'works-plaza-unified', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-2500));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
