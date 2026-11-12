/**
 * P215 普通课池子键下架后的授权守卫（2026-11-12）。
 *
 * 现场：普通课池子的存储键 = 最早创建的、计入池子的普通课系列（生产是 S1）。
 * 下架 S1 之后，`resolveAuthorizationSeries()` 仍然把 S2/S3 的授权解析到 S1 —— 这是对的，
 * 键不能漂移，否则 S1 上的授权单 / 学生许可 / 核销明细会全部失去归属。
 * 但三个授权入口原来都直接看「键这一行 status !== PUBLISHED」→ 所有普通课系列都授权不了。
 *
 * 这条守卫钉住修好之后的口径：
 *   ① 池子键下架、但池子里还有已发布系列 → 授权 / 追加次数 / 采购次数都照常，次数仍落在键上；
 *   ② 池子全部下架 → 拒绝（COURSE_NOT_PUBLISHED）；
 *   ③ 池子键下架期间，学生许可的核销照常（记账不看内容状态）；
 *   ④ 池子键不会因为下架而漂移到 S2。
 *
 * 跑法：node scripts/p215-normal-pool-archived-key.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p215-pool-archived-key-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';

const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { aq, arow } = await import('../apps/server/src/lib.js');
const { consumeGrantUnit, normalPoolSeries } = await import('../apps/server/src/services/courseGrants.js');
const { appendLicensePurchase } = await import('../apps/server/src/services/licenseLedger.js');

const now = new Date().toISOString();
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const adminAuth = { user: { id: 'root', login: 'root', displayName: 'Root', role: 'SUPER_ADMIN', orgId: null, permissions: [] }, rawUser: { permissions: '[]' } };
const ctx = (pathname, method = 'GET', body = null) => ({ pathname, method, body, auth: adminAuth, search: new URLSearchParams(), req: { socket: { remoteAddress: '127.0.0.1' } } });
const purchaseFields = (tag) => ({
  amountMinor: 100, currency: 'CNY', paymentStatus: 'PAID',
  orderNo: `P215-O-${tag}`, contractNo: `P215-C-${tag}`, idempotencyKey: `p215-${tag}`,
});
const expectCode = async (fn, code, label) => {
  try { await fn(); check(label, false, `没有抛错（期望 ${code}）`); }
  catch (error) { check(label, error?.code === code, `实际 ${error?.code || error?.message}`); }
};

try {
  await aq('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ['org215', 'P215 学校', 'ACTIVE', now, new Date(Date.now() + 730 * 86400000).toISOString(), 0, 3, 0, null, now, now]);
  await aq("INSERT INTO users(id,org_id,login,display_name,role,password_hash,status,created_at,updated_at) VALUES ('stu215','org215','stu215','学生215','STUDENT','x','ACTIVE',?,?)", [now, now]);

  const createSeries = async (title, lessonTitle) => {
    const created = await handleAdmin(ctx('/api/admin/course-series', 'POST', {
      title, description: 'P215 普通课池子键验证', stockTotal: 0, coverImageUrl: 'https://example.com/p215-cover.png',
      visibility: 'PRIVATE', lessons: [{ title: lessonTitle, status: 'PUBLISHED', capabilities: ['text'] }],
    }));
    assert.ok(created?.id, `创建课包失败: ${title}`);
    await handleAdmin(ctx(`/api/admin/course-series/${created.id}/status`, 'POST', { action: 'publish' }));
    return created;
  };

  const s1 = await createSeries('P215 普通课一（池子键）', '第1课');
  const s2 = await createSeries('P215 普通课二', '第1课');
  // 确保 S1 是最早创建的：normalPoolSeries 按 created_at → sort → id 取第一条。
  await aq('UPDATE course_series SET created_at=? WHERE id=?', [new Date(Date.now() - 60_000).toISOString(), s1.id]);
  const pool = await normalPoolSeries();
  check('池子键 = 最早创建的 S1', pool?.id === s1.id, `${pool?.id} vs ${s1.id}`);

  // ① 先给机构开一次（0 次 = 只开通访问）
  const initial = await handleAdmin(ctx(`/api/admin/course-series/${s1.id}/assignments`, 'POST', { orgIds: ['org215'], quotaTotal: 0 }));
  check('池子键正常时首次授权 200', Boolean(initial?.allocations?.length), JSON.stringify(initial));

  // ② 下架池子键 S1
  await handleAdmin(ctx(`/api/admin/course-series/${s1.id}/status`, 'POST', { action: 'archive' }));
  check('S1 已下架', (await arow('SELECT status FROM course_series WHERE id=?', [s1.id]))?.status === 'ARCHIVED');
  check('下架后池子键仍是 S1（不漂移）', (await normalPoolSeries())?.id === s1.id);

  // ③ 通过 S2 授权：仍解析到 S1，且必须成功
  const viaS2 = await handleAdmin(ctx(`/api/admin/course-series/${s2.id}/assignments`, 'POST', { orgIds: ['org215'], quotaTotal: 0 }));
  check('池子键下架后通过 S2 授权 200', Boolean(viaS2?.allocations?.length), JSON.stringify(viaS2));
  const afterS2 = await arow("SELECT series_id, quota_total FROM course_assignments WHERE org_id='org215' AND series_id=?", [s1.id]);
  check('授权单仍挂在池子键 S1 上', afterS2?.series_id === s1.id, JSON.stringify(afterS2));

  // ④ 追加次数（NORMAL 标识）→ 200
  const appended = await handleAdmin(ctx('/api/admin/course-series/NORMAL/assignments/append', 'POST', {
    orgIds: ['org215'], additionalQuota: 3, ...purchaseFields('append'),
  }));
  check('池子键下架后追加次数 200', Number(appended?.assignment?.quotaTotal) === 3, JSON.stringify(appended));

  // ⑤ 财务入口直接采购次数 → 200
  await appendLicensePurchase({
    seriesId: 'NORMAL', orgId: 'org215', additionalQuota: 2, actorId: 'root', ...purchaseFields('ledger'),
  });
  const quota = Number((await arow("SELECT quota_total FROM course_assignments WHERE org_id='org215' AND series_id=?", [s1.id]))?.quota_total || 0);
  check('财务入口采购次数仍落在 S1（累计 5）', quota === 5, String(quota));

  // ⑥ 池子键下架期间核销照常：次数账不看内容状态
  await aq(`INSERT INTO student_course_grants(id,org_id,student_id,series_id,granted_at,granted_units,consumed_units)
    VALUES ('grant215','org215','stu215',?,?,2,0)`, [s1.id, now]);
  const consumed = await consumeGrantUnit({ orgId: 'org215', studentId: 'stu215', seriesId: s1.id, sessionId: 'sess_p215', lessonId: 'lesson_p215' });
  check('池子键下架后学生许可仍能核销', consumed?.consumed === true, JSON.stringify(consumed));
  check('核销后 consumed_units=1', Number((await arow("SELECT consumed_units FROM student_course_grants WHERE id='grant215'"))?.consumed_units) === 1);

  // ⑦ 池子全部下架 → 新增授权必须被拒
  await handleAdmin(ctx(`/api/admin/course-series/${s2.id}/status`, 'POST', { action: 'archive' }));
  await expectCode(
    () => handleAdmin(ctx('/api/admin/course-series/NORMAL/assignments/append', 'POST', { orgIds: ['org215'], additionalQuota: 1, ...purchaseFields('reject') })),
    'COURSE_NOT_PUBLISHED',
    '池子全部下架后追加次数被拒',
  );
} catch (error) {
  failures.push(`unexpected: ${error?.stack || error?.message || error}`);
}

if (failures.length) {
  console.error(`P215 FAILED:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('P215 passed: 池子键下架后授权/追加/采购/核销照常，池子全下架才拒绝，键不漂移');
