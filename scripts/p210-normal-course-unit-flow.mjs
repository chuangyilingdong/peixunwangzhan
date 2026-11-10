/**
 * P210 普通课包「按课时次数」全链路守卫（2026-11-10 用户口径）。
 *
 * 用户确认过的口径：
 *   · 普通课包 1 次授权 = 1 个**课时次数**：学生上 1 节课扣 1 次，上 5 节就要有 5 次；
 *   · 同一个课包可以重复分给同一学生、未用次数累积；
 *   · 老师端只能添加「没上过这节课、且剩余次数 > 0」的学生（上过的课不能重复上）；
 *   · 机构可以回收学生未使用的次数（可指定回收几次），退回机构总次数；
 *   · 学生还在待上课/上课中的课堂里时不能回收；
 *   · 平台库存（stock_total）对普通课包不再生效；
 *   · 平台撤销按未消费余额退；
 *   · 机构能看到每个学生上了哪些具体的课（/api/org/students/:id/course-usage）。
 *
 * 体验课包的独立回归在 p140；本脚本只钉普通课包，且所有断言走真 HTTP。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p210-normal-units-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const seeded = {};
{
  const student = await arow("SELECT id, org_id FROM users WHERE login='student-2'");
  Object.assign(seeded, { studentId: student.id, orgId: student.org_id });
}

const port = 19090;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null, code: payload?.error?.code || null };
}

let seriesId = '';
const lessonIds = [];
const grantOf = async () => arow('SELECT * FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=?', [seeded.orgId, seeded.studentId, seriesId]);
const balanceOf = async () => {
  const grant = await grantOf();
  return Number(grant?.granted_units || 0) - Number(grant?.consumed_units || 0);
};
const quotaOf = async () => (await arow('SELECT quota_total, quota_used FROM course_assignments WHERE series_id=? AND org_id=?', [seriesId, seeded.orgId])) || {};

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data?.token;
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data?.token;
  assert.ok(admin && orgAdmin, '登录失败');

  const purchase = (suffix, quantity) => ({ amountMinor: quantity * 10000, currency: 'CNY', paymentStatus: 'PAID', orderNo: `P210-O-${suffix}`, contractNo: 'P210-C', idempotencyKey: `p210-${suffix}` });
  const lessonBody = (title) => ({ title, status: 'PUBLISHED', deliveryModes: ['CANVAS'], capabilities: ['text', 'image'] });

  /* ① 建包：库存故意写 0，普通课包照样能开 10 次（平台库存概念已取消） */
  {
    const created = await api('/api/admin/course-series', {
      method: 'POST', token: admin,
      body: {
        title: 'P210 普通课时包', description: '普通课包按课时次数', coverImageUrl: 'https://example.com/p210.png',
        priceFen: 0, stockTotal: 0, seriesType: 'NORMAL',
        lessons: [lessonBody('第 1 节'), lessonBody('第 2 节'), lessonBody('第 3 节'), lessonBody('第 4 节')],
      },
    });
    check('① 普通课包建 4 节课成功', created.status === 200 && (created.data?.lessons || []).length === 4, JSON.stringify(created.error || created.data).slice(0, 200));
    seriesId = created.data?.id || '';
    for (const lesson of created.data?.lessons || []) lessonIds.push(lesson.id);
    const published = await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
    check('① 发布成功', published.status === 200, JSON.stringify(published.error || {}).slice(0, 200));
    const assigned = await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgId: seeded.orgId, quotaTotal: 10, ...purchase('initial', 10) } });
    check('① stock_total=0 仍能给机构开 10 次（普通包不再校验平台库存）★', assigned.status === 200 && assigned.data?.quotaTotal === 10, JSON.stringify(assigned.error || assigned.data).slice(0, 200));
  }

  /* ② 授权：可一次发多次；同一 key 重复提交只算一次 */
  {
    const first = await api('/api/org/course-grants', { method: 'POST', token: orgAdmin, body: { seriesId, studentIds: [seeded.studentId], units: 3, idempotencyKey: 'p210-grant-1' } });
    check('② 一次发 3 次', first.status === 200 && first.data?.granted === 1 && Number(first.data?.usedUnits) === 3, JSON.stringify(first.error || first.data).slice(0, 200));
    const replay = await api('/api/org/course-grants', { method: 'POST', token: orgAdmin, body: { seriesId, studentIds: [seeded.studentId], units: 3, idempotencyKey: 'p210-grant-1' } });
    check('② 同一幂等键重复提交：回放且不再扣次数 ★', replay.status === 200 && (await balanceOf()) === 3, JSON.stringify(replay.error || replay.data).slice(0, 200));
    const quota = await quotaOf();
    check('② 机构已用次数 = 3', Number(quota.quota_used) === 3, JSON.stringify(quota));
    const row = await grantOf();
    check('② 次数记在同一行（granted_units=3）', Number(row?.granted_units) === 3, JSON.stringify(row));
  }

  const openSession = async (lessonId, title) => {
    const created = await api('/api/org/sessions', { method: 'POST', token: orgAdmin, body: { lessonId, deliveryMode: 'CANVAS', title } });
    return created.data?.id;
  };
  const addStudents = (sessionId, studentIds = [seeded.studentId]) => api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: orgAdmin, body: { studentIds } });
  const startSession = (sessionId) => api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: orgAdmin });
  const endSession = (sessionId) => api(`/api/org/sessions/${sessionId}/end`, { method: 'POST', token: orgAdmin, body: {} });
  const partStatusOf = async (sessionId) => (await arow('SELECT status FROM session_students WHERE session_id=? AND student_id=?', [sessionId, seeded.studentId]))?.status;
  // 「有有效产出」= 这场课堂里有真实非 mock 的成功调用（与完课判定同一套条件）
  const giveRealUsage = (sessionId, id) => aq(
    `INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,pricing_snapshot,created_at,cost_fen)
     VALUES (?,?,?,?,'TEXT','real-model',0,'SUCCESS','{"provider":"real"}',?,0)`,
    [id, seeded.orgId, seeded.studentId, sessionId, new Date().toISOString()],
  );

  /* ③ 上第 1 节：有产出 → 完课、扣 1 次；同课时不能再上 */
  let session1 = '';
  {
    session1 = await openSession(lessonIds[0], 'P210 第 1 节（有产出）');
    const candidates = await api(`/api/org/sessions/${session1}/candidates`, { token: orgAdmin });
    const candidate = (candidates.data?.selectable || []).find((item) => item.id === seeded.studentId);
    check('③ 候选人带「剩余次数」', Number(candidate?.remainingUnits) === 3, JSON.stringify(candidate || candidates.data || candidates.error).slice(0, 220));
    const added = await addStudents(session1);
    check('③ 有剩余次数就能加进课堂', (added.data?.added || []).includes(seeded.studentId), JSON.stringify(added.error || added.data).slice(0, 200));
    const started = await startSession(session1);
    check('③ 开始上课成功（预检通过）', started.status === 200, JSON.stringify(started.error || {}).slice(0, 200));
    await giveRealUsage(session1, 'p210_usage_1');
    const ended = await endSession(session1);
    check('③ 结束课堂成功、结算为已完课', ended.status === 200 && (await partStatusOf(session1)) === 'COMPLETED', JSON.stringify(ended.error || {}).slice(0, 200));
    check('③ **核销 1 次**（可用 3 → 2）★', (await balanceOf()) === 2, `剩余 ${await balanceOf()}`);
  }

  /* ④ 同课时不能再上（普通包保留"完课拦截"）；没产出的场次可以重上 */
  {
    const again = await openSession(lessonIds[0], 'P210 第 1 节（重上）');
    const blocked = await api(`/api/org/sessions/${again}/candidates`, { token: orgAdmin });
    const completedRow = (blocked.data?.blocked || []).find((item) => item.id === seeded.studentId);
    check('④ 候选人里「这节课已完课」被拦（COMPLETED）★', completedRow?.reason === 'COMPLETED', JSON.stringify(completedRow || blocked.data || blocked.error).slice(0, 240));
    const added = await addStudents(again);
    check('④ 直接加人也拦（skipped=COMPLETED）', (added.data?.skipped || []).some((item) => item.reason === 'COMPLETED'), JSON.stringify(added.data || added.error).slice(0, 200));
    await api(`/api/org/sessions/${again}/dissolve`, { method: 'POST', token: orgAdmin, body: {} });

    const retry = await openSession(lessonIds[1], 'P210 第 2 节（第一次没产出）');
    const added2 = await addStudents(retry);
    check('④ 没上过的第 2 节可以加', (added2.data?.added || []).includes(seeded.studentId), JSON.stringify(added2.error || added2.data).slice(0, 200));
    await startSession(retry);
    const ended = await endSession(retry);
    check('④ 没产出 → 未完课，**不扣次**（仍是 2）★', ended.status === 200 && (await partStatusOf(retry)) === 'INCOMPLETE' && (await balanceOf()) === 2, `剩余 ${await balanceOf()}`);

    const retry2 = await openSession(lessonIds[1], 'P210 第 2 节（重上，有产出）');
    const added3 = await addStudents(retry2);
    check('④ 没产出的课可以重上（未被 COMPLETED 拦）', (added3.data?.added || []).includes(seeded.studentId), JSON.stringify(added3.error || added3.data).slice(0, 200));
    await startSession(retry2);
    await giveRealUsage(retry2, 'p210_usage_2');
    const ended2 = await endSession(retry2);
    check('④ 重上后有产出 → 完课、扣 1 次（可用 2 → 1）', ended2.status === 200 && (await partStatusOf(retry2)) === 'COMPLETED' && (await balanceOf()) === 1, `剩余 ${await balanceOf()}`);
  }

  /* ⑤ 学生在课堂里时不能回收；上完第 3 节扣到 0 后加不进新课堂 */
  let session3 = '';
  {
    session3 = await openSession(lessonIds[2], 'P210 第 3 节（最后一节）');
    const added = await addStudents(session3);
    check('⑤ 剩余 1 次还能加第 3 节', (added.data?.added || []).includes(seeded.studentId), JSON.stringify(added.error || added.data).slice(0, 200));
    const reclaimLive = await api(`/api/org/course-grants/${(await grantOf()).id}/reclaim`, { method: 'POST', token: orgAdmin, body: { units: 1, reason: '课堂中回收' } });
    check('⑤ 学生还在待上课课堂里 → **拒绝回收**（STUDENT_IN_LIVE_SESSION）★', reclaimLive.status === 409 && reclaimLive.code === 'STUDENT_IN_LIVE_SESSION', `${reclaimLive.status} ${reclaimLive.code}`);
    await startSession(session3);
    await giveRealUsage(session3, 'p210_usage_3');
    const ended = await endSession(session3);
    check('⑤ 上完第 3 节 → 扣到 0（已用 3 次）★', ended.status === 200 && (await balanceOf()) === 0, `剩余 ${await balanceOf()}`);

    const fourth = await openSession(lessonIds[3], 'P210 剩余 0 还想上（第 4 节没上过）');
    const candidates = await api(`/api/org/sessions/${fourth}/candidates`, { token: orgAdmin });
    const noUnits = (candidates.data?.blocked || []).find((item) => item.id === seeded.studentId);
    check('⑤ 剩余 0：候选人里写 NO_UNITS（不是含糊的"没有许可"）★', noUnits?.reason === 'NO_UNITS', JSON.stringify(noUnits || candidates.data || candidates.error).slice(0, 240));
    const addedFourth = await addStudents(fourth);
    check('⑤ 剩余 0：加人被拒（skipped=NO_UNITS）', (addedFourth.data?.skipped || []).some((item) => item.reason === 'NO_UNITS'), JSON.stringify(addedFourth.data || addedFourth.error).slice(0, 200));
    await api(`/api/org/sessions/${fourth}/dissolve`, { method: 'POST', token: orgAdmin, body: {} });
  }

  /* ⑥ 回收：可指定次数、幂等、全回收后标记已回收、可再授权复活 */
  {
    const zero = await api(`/api/org/course-grants/${(await grantOf()).id}/reclaim`, { method: 'POST', token: orgAdmin, body: { units: 1, reason: '没有余额' } });
    check('⑥ 没有未使用余额时不能回收', zero.status === 409 && zero.code === 'COURSE_GRANT_NO_REMAINING', `${zero.status} ${zero.code}`);

    const topup = await api('/api/org/course-grants', { method: 'POST', token: orgAdmin, body: { seriesId, studentIds: [seeded.studentId], units: 2, idempotencyKey: 'p210-grant-2' } });
    check('⑥ 用完还能再分 2 次（次数累加）', topup.status === 200 && (await balanceOf()) === 2, JSON.stringify(topup.error || topup.data).slice(0, 200));

    const grant = await grantOf();
    const reclaim1 = await api(`/api/org/course-grants/${grant.id}/reclaim`, { method: 'POST', token: orgAdmin, body: { units: 1, reason: '学生转班', idempotencyKey: 'p210-reclaim-1' } });
    check('⑥ 回收 1 次成功（可用 2 → 1）', reclaim1.status === 200 && reclaim1.data?.reclaimedUnits === 1 && reclaim1.data?.remainingUnits === 1, JSON.stringify(reclaim1.error || reclaim1.data).slice(0, 200));
    check('⑥ 机构已用次数同步 −1（5 → 4）', Number((await quotaOf()).quota_used) === 4, JSON.stringify(await quotaOf()));
    const replay = await api(`/api/org/course-grants/${grant.id}/reclaim`, { method: 'POST', token: orgAdmin, body: { units: 1, reason: '学生转班', idempotencyKey: 'p210-reclaim-1' } });
    check('⑥ 回收也幂等：同 key 重放不重复退 ★', replay.status === 200 && (await balanceOf()) === 1 && Number((await quotaOf()).quota_used) === 4, JSON.stringify(replay.error || replay.data).slice(0, 200));

    const rest = await api(`/api/org/course-grants/${grant.id}/reclaim`, { method: 'POST', token: orgAdmin, body: { units: 1, reason: '全部收回' } });
    check('⑥ 回收最后 1 次 → 整条许可标记已回收', rest.status === 200 && rest.data?.fullyReclaimed === true && (await balanceOf()) === 0, JSON.stringify(rest.error || rest.data).slice(0, 200));
    check('⑥ 机构已用次数回到 3（已核销的 3 次不退）', Number((await quotaOf()).quota_used) === 3, JSON.stringify(await quotaOf()));
    const afterRevoke = await api(`/api/org/course-grants/${grant.id}/reclaim`, { method: 'POST', token: orgAdmin, body: { units: 1, reason: '再退' } });
    check('⑥ 已回收的许可不能再回收', afterRevoke.status === 409 && afterRevoke.code === 'COURSE_GRANT_ALREADY_REVOKED', `${afterRevoke.status} ${afterRevoke.code}`);

    const regrant = await api('/api/org/course-grants', { method: 'POST', token: orgAdmin, body: { seriesId, studentIds: [seeded.studentId], units: 1 } });
    check('⑥ 回收后可以再分给同一学生（复活同一行）', regrant.status === 200 && (await balanceOf()) === 1, JSON.stringify(regrant.error || regrant.data).slice(0, 200));
  }

  /* ⑦ 机构能看「这个学生上了哪些具体的课」 */
  {
    const usage = await api(`/api/org/students/${seeded.studentId}/course-usage`, { token: orgAdmin });
    const items = usage.data?.items || [];
    const summary = usage.data?.summary || {};
    check('⑦ 已上课程面板返回明细', usage.status === 200 && items.length >= 4, JSON.stringify(usage.error || { total: items.length }).slice(0, 200));
    check('⑦ 明细带具体课时标题（第 1/2/3 节）', new Set(items.map((item) => item.lessonTitle)).size >= 3, JSON.stringify(items.map((item) => item.lessonTitle)).slice(0, 240));
    check('⑦ 汇总：已完课 3 场、未完课 1 场、扣次 3 次', summary.completed === 3 && summary.incomplete === 1 && summary.consumed === 3, JSON.stringify(summary));
    check('⑦ 未完课的那场明确标「未扣次」', items.some((item) => item.status === 'INCOMPLETE' && item.consumed === false), JSON.stringify(items.map((item) => [item.status, item.consumed])).slice(0, 240));
  }

  /* ⑧ 体验课包不开放机构回收（用户口径：体验包逻辑不动） */
  {
    const exp = await api('/api/admin/course-series', {
      method: 'POST', token: admin,
      body: { title: 'P210 体验包（回收应被拒）', description: '体验包', coverImageUrl: 'https://example.com/p210-exp.png', priceFen: 0, stockTotal: 5, seriesType: 'EXPERIENCE', lessons: [lessonBody('体验课')] },
    });
    const expId = exp.data?.id;
    await api(`/api/admin/course-series/${expId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
    await api(`/api/admin/course-series/${expId}/assignments`, { method: 'POST', token: admin, body: { orgId: seeded.orgId, quotaTotal: 2, ...purchase('exp', 2) } });
    await api('/api/org/course-grants', { method: 'POST', token: orgAdmin, body: { seriesId: expId, studentIds: [seeded.studentId], units: 1 } });
    const expGrant = await arow('SELECT id FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=?', [seeded.orgId, seeded.studentId, expId]);
    const reclaim = await api(`/api/org/course-grants/${expGrant.id}/reclaim`, { method: 'POST', token: orgAdmin, body: { units: 1, reason: '体验包试试' } });
    check('⑧ 体验课包回收被拒（RECLAIM_NOT_SUPPORTED）', reclaim.status === 400 && reclaim.code === 'RECLAIM_NOT_SUPPORTED', `${reclaim.status} ${reclaim.code}`);
  }

  /* ⑨ 库存流水：授权消耗 + 回收返还都在 */
  {
    const changes = await api(`/api/admin/organizations/${seeded.orgId}/course-quota-changes?seriesId=${seriesId}&limit=100`, { token: admin });
    const list = changes.data?.items || [];
    const consume = list.filter((item) => item.changeType === 'GRANT_CONSUME').length;
    const refund = list.filter((item) => item.changeType === 'GRANT_REFUND').length;
    check('⑨ 流水记下 GRANT_CONSUME / GRANT_REFUND', consume >= 2 && refund >= 2, JSON.stringify({ total: list.length, consume, refund }));
  }

  console.log(JSON.stringify({ name: 'normal-course-unit-flow', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-4000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
