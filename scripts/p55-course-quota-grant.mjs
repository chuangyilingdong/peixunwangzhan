/**
 * P55 课包「次数」授权链路守卫（2026-09-12，平台侧重做梳理 P2）。
 *
 * 用户的规则（4.3 最终版）：
 *   ① 平台给机构授权时带**次数**，受课包**库存**约束；
 *   ② 机构把课包分给一个学生 = 用掉 1 次；同一学生同一课包**只能一次**；
 *   ③ **机构侧不可撤销**（次数已消耗不可逆），平台留**兜底撤销**；
 *   ④ 兜底撤销时：该学生还没提交过该课包任何一节课的作品 → 退回 1 次；已经上过 → 不退。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p55-course-quota-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
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

  // 建课包（库存 3 次）并发布
  const created = await api('/api/admin/course-series', {
    method: 'POST', token: admin,
    body: { title: 'P55 次数课包', visibility: 'ALL_ORGS', stockTotal: 3, lessons: [{ title: '第1课', status: 'PUBLISHED', capabilities: ['text'], deliveryModes: ['CANVAS'] }] },
  });
  assert.equal(created.status, 200, `建课包失败: ${JSON.stringify(created.data).slice(0, 160)}`);
  const seriesId = created.data.id;
  const lessonId = created.data.lessons[0].id;
  await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });

  // ① 授权次数不能超过库存
  const over = await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgIds: [org.organization.id], validityDays: 365, quotaTotal: 5 } });
  check('① 授权次数超过库存被拒', over.status === 409 && over.error?.code === 'COURSE_QUOTA_EXCEEDS_STOCK', `${over.status} ${over.error?.code} ${over.error?.message || ''}`);

  const assigned = await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgIds: [org.organization.id], validityDays: 365, quotaTotal: 1 } });
  check('① 授权 1 次成功', assigned.status === 200 && assigned.data.quotaTotal === 1, JSON.stringify(assigned.data).slice(0, 140));
  const detail = await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin });
  const assignedOrg = (detail.data.assignedOrgs || [])[0] || {};
  check('① 详情里能看到授权次数与已用次数', assignedOrg.quotaTotal === 1 && assignedOrg.quotaUsed === 0, JSON.stringify(assignedOrg).slice(0, 140));

  // ② 机构分给学生：用掉 1 次；同一学生再来一次不重复扣
  const grant1 = await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [first.id] } });
  check('② 机构把课包分给学生成功（用掉 1 次）', grant1.status === 200 && grant1.data.granted === 1 && grant1.data.quotaUsed === 1, JSON.stringify(grant1.data).slice(0, 140));
  const grantAgain = await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [first.id] } });
  check('② 同一学生同一课包不会重复授权（跳过且不扣次数）', grantAgain.status === 200 && grantAgain.data.granted === 0 && grantAgain.data.skipped === 1, JSON.stringify(grantAgain.data).slice(0, 140));
  const exhausted = second
    ? await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [second.id] } })
    : null;
  check('② 次数用尽后不能再分给学生', !second || (exhausted.status === 409 && exhausted.error?.code === 'COURSE_QUOTA_EXHAUSTED'), second ? `${exhausted.status} ${exhausted.error?.code}` : '（机构只有一个学员，跳过）');

  const list = await api(`/api/org/course-grants?seriesId=${seriesId}`, { token: org.token });
  check('② 机构能看到已分发的许可列表', (list.data.items || []).length === 1 && list.data.items[0].studentId === first.id, JSON.stringify(list.data).slice(0, 160));
  const grantId = list.data.items[0].id;

  // ③ 机构侧没有撤销入口（不可逆），平台有
  const orgRevoke = await api(`/api/org/course-grants/${grantId}/revoke`, { method: 'POST', token: org.token, body: { reason: '试试' } });
  check('③ 机构侧撤销入口不存在（404）', orgRevoke.status === 404, `${orgRevoke.status}`);

  // ④ 平台兜底撤销：学生还没上过课 → 退回 1 次
  const revoke = await api(`/api/admin/course-grants/${grantId}/revoke`, { method: 'POST', token: admin, body: { reason: '机构误授权，平台兜底撤销' } });
  check('④ 平台撤销成功且退回 1 次', revoke.status === 200 && revoke.data.quotaRefunded === true, JSON.stringify(revoke.data).slice(0, 140));
  const afterRevoke = await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin });
  check('④ 撤销后授权已用次数回到 0', ((afterRevoke.data.assignedOrgs || [])[0] || {}).quotaUsed === 0, JSON.stringify((afterRevoke.data.assignedOrgs || [])[0]).slice(0, 120));
  const regrant = await api('/api/org/course-grants', { method: 'POST', token: org.token, body: { seriesId, studentIds: [first.id] } });
  check('④ 退回的次数能再次分给学生', regrant.status === 200 && regrant.data.granted === 1 && regrant.data.quotaUsed === 1, JSON.stringify(regrant.data).slice(0, 140));

  console.log(JSON.stringify({ name: 'course-quota-grant', pass: failures === 0, seriesId, failures }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
