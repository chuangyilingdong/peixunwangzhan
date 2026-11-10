/**
 * P55 课包「次数」授权链路守卫（2026-09-12 建立；2026-11-10 按新口径重写）。
 *
 * 2026-11-10 用户口径（普通课包改成"按课时次数"）：
 *   ① 平台给机构授权时带**次数**；**普通课包不再受平台库存约束**（stock_total 只对体验课包生效）；
 *   ② 机构把次数分给学生：1 次 = 1 个课时次数；同一学生可以重复分、次数累加；
 *   ③ 机构可以**回收**学生未使用的次数（可指定回收几次），退回机构总次数；
 *   ④ 平台兜底撤销：按**未消费余额**退（与体验课包同一口径）。
 *
 * 体验课包的独立回归见 p140；本脚本只钉普通课包的次数账。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p55-course-quota-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp, PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const port = 18910;
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
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const org = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data;
  assert.ok(admin && org?.token, '登录失败');
  const students = (await api('/api/org/users?role=STUDENT', { token: org.token })).data.items || [];
  check('机构下有可授权的学员', students.length >= 1, `学员数 ${students.length}`);
  const [first, second] = students;

  // 建课包（平台库存故意只写 1 次：普通课包**不校验**库存，开 6 次也应该成功）并发布
  const created = await api('/api/admin/course-series', {
    method: 'POST', token: admin,
    body: { title: 'P55 次数课包', description: '次数授权回归课包', coverImageUrl: 'https://example.com/p55-cover.png', visibility: 'ALL_ORGS', stockTotal: 1, lessons: [{ title: '第1课', status: 'PUBLISHED', capabilities: ['text'], deliveryModes: ['CANVAS'] }] },
  });
  assert.equal(created.status, 200, `建课包失败: ${JSON.stringify(created.data).slice(0, 160)}`);
  const seriesId = created.data.id;
  const lessonId = created.data.lessons[0].id;
  const published = await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
  assert.equal(published.status, 200, `发布夹具失败: ${JSON.stringify(published.error)}`);

  const purchase = (suffix, quantity, amountMinor = quantity * 10000) => ({ amountMinor, currency: 'CNY', paymentStatus: 'PAID', orderNo: `P55-O-${suffix}`, contractNo: 'P55-C-1', idempotencyKey: `p55-${suffix}` });
  const quotaOf = async () => ((await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin })).data.assignedOrgs || [])[0] || {};

  // ① 普通课包不再受平台库存约束（stock_total=1，开 6 次必须成功）
  const assigned = await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgIds: [org.organization.id], validityDays: 365, quotaTotal: 6, ...purchase('initial', 6) } });
  check('① 普通课包开 6 次不受 stock_total 约束（平台库存概念已取消）', assigned.status === 200 && assigned.data.quotaTotal === 6, `${assigned.status} ${JSON.stringify(assigned.error || assigned.data).slice(0, 160)}`);
  const assignedOrg = await quotaOf();
  check('① 详情里能看到授权次数与已用次数', assignedOrg.quotaTotal === 6 && assignedOrg.quotaUsed === 0, JSON.stringify(assignedOrg).slice(0, 140));

  // ② 机构分给学生：一次可发多次；同一学生重复分配 = 次数累加
  const grant1 = await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [first.id], units: 3 } });
  check('② 一次发 3 次（quotaUsed=3）', grant1.status === 200 && grant1.data.granted === 1 && grant1.data.quotaUsed === 3, JSON.stringify(grant1.data || grant1.error).slice(0, 160));
  const grantAgain = await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [first.id], units: 1 } });
  check('② 同一学生再分 1 次：**累加**（quotaUsed=4）', grantAgain.status === 200 && grantAgain.data.granted === 1 && grantAgain.data.quotaUsed === 4, JSON.stringify(grantAgain.data || grantAgain.error).slice(0, 160));
  const list = await api(`/api/org/course-grants?seriesId=${seriesId}`, { token: org.token });
  const grantRow = (list.data.items || []).find((item) => item.studentId === first.id) || {};
  check('② 列表带次数账（授权 4 / 已用 0 / 可用 4）', Number(grantRow.grantedUnits) === 4 && Number(grantRow.consumedUnits) === 0 && Number(grantRow.remainingUnits) === 4, JSON.stringify(grantRow).slice(0, 200));
  const grantId = grantRow.id;

  const secondGrant = second
    ? await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [second.id], units: 2 } })
    : null;
  check('② 第二个学生还能分 2 次（合计用满 6）', !second || (secondGrant.status === 200 && secondGrant.data.quotaUsed === 6), second ? `${secondGrant.status} ${JSON.stringify(secondGrant.error || secondGrant.data).slice(0, 120)}` : '（机构只有一个学员，跳过）');
  const exhausted = second
    ? await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [second.id], units: 1 } })
    : null;
  check('② 次数用尽后不能再分给学生', !second || (exhausted.status === 409 && exhausted.error?.code === 'COURSE_QUOTA_EXHAUSTED'), second ? `${exhausted.status} ${exhausted.error?.code}` : '（机构只有一个学员，跳过）');

  // ③ 机构回收：可指定次数；只能回收未使用余额；全回收后标记已回收、可再授权复活
  const reclaim1 = await api(`/api/org/course-grants/${grantId}/reclaim`, { method: 'POST', token: org.token, body: { units: 1, reason: '学生转班，退 1 次' } });
  if (reclaim1.status >= 500) console.error(serverLog.slice(-4000));
  check('③ 机构可回收 1 次（指定次数）', reclaim1.status === 200 && reclaim1.data.reclaimedUnits === 1 && reclaim1.data.remainingUnits === 3, JSON.stringify(reclaim1.data || reclaim1.error).slice(0, 200));
  const afterReclaim1 = await quotaOf();
  check('③ 回收后机构已用次数 6 → 5', afterReclaim1.quotaUsed === 5, JSON.stringify(afterReclaim1).slice(0, 140));

  const overReclaim = await api(`/api/org/course-grants/${grantId}/reclaim`, { method: 'POST', token: org.token, body: { units: 99, reason: '多退' } });
  check('③ 回收不能超过未使用余额', overReclaim.status === 400 && overReclaim.error?.code === 'RECLAIM_EXCEEDS_REMAINING', `${overReclaim.status} ${overReclaim.error?.code}`);

  const reclaimRest = await api(`/api/org/course-grants/${grantId}/reclaim`, { method: 'POST', token: org.token, body: { units: 3, reason: '全部收回' } });
  check('③ 回收剩余 3 次后整条许可标记已回收', reclaimRest.status === 200 && reclaimRest.data.fullyReclaimed === true && reclaimRest.data.remainingUnits === 0, JSON.stringify(reclaimRest.data || reclaimRest.error).slice(0, 200));
  const afterReclaimAll = await quotaOf();
  check('③ 全部回收后机构已用次数 5 → 2（另一个学生仍占 2 次）', afterReclaimAll.quotaUsed === 2, JSON.stringify(afterReclaimAll).slice(0, 140));

  const regrant = await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [first.id], units: 1 } });
  check('③ 回收后可以再分给同一学生（复活同一行）', regrant.status === 200 && regrant.data.quotaUsed === 3, JSON.stringify(regrant.data || regrant.error).slice(0, 160));

  // ④ 平台兜底撤销：按**未消费余额**退（不再是"没交作品退 1 次"）
  const revoke = await api(`/api/admin/course-grants/${grantId}/revoke`, { method: 'POST', token: admin, body: { reason: '平台兜底撤销' } });
  check('④ 平台撤销按未消费余额退 1 次', revoke.status === 200 && revoke.data.refundedUnits === 1 && revoke.data.quotaRefunded === true, JSON.stringify(revoke.data || revoke.error).slice(0, 160));
  const afterRevoke = await quotaOf();
  check('④ 撤销后机构已用次数回到 2', afterRevoke.quotaUsed === 2, JSON.stringify(afterRevoke).slice(0, 140));

  // ⑤ 库存流水（库存账的唯一审计线）：消耗 6 次、返还 4+1=5 次
  const changes = await api(`/api/admin/organizations/${org.organization.id}/course-quota-changes?seriesId=${seriesId}&limit=100`, { token: admin });
  const changeItems = changes.data?.items || [];
  const countType = (type) => changeItems.filter((item) => item.changeType === type).length;
  check('⑤ 流水记下了 GRANT_CONSUME / GRANT_REFUND', countType('GRANT_CONSUME') >= 3 && countType('GRANT_REFUND') >= 2, JSON.stringify({ total: changeItems.length, consume: countType('GRANT_CONSUME'), refund: countType('GRANT_REFUND') }));

  console.log(JSON.stringify({ name: 'course-quota-grant', pass: failures === 0, seriesId, lessonId, failures }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
