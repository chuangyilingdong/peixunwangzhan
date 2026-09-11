/**
 * P40 课包「发布 ≠ 授权给机构」守卫（自包含临时库，不碰默认库/生产库）。
 *
 * 平台口径（见交接说明第四节）：
 *   发布 = 上架官网课程广场给所有人看，**不对任何机构生效**；
 *   机构后台能看到/使用平台课包，唯一途径是「机构授权」里有一条 ACTIVE 且未过期的授权；
 *   授权带时效（1 年 / 2 年 …），到期或撤销后该机构立即看不到。
 *
 * 这个用例盯死三件容易回退的事：
 *   ① 发布后未授权机构看不到（旧行为是 visibility='ALL_ORGS' 直接放行所有机构）；
 *   ② 授权后在有效期内能看到、过期/撤销后立刻看不到；
 *   ③ 课程广场「列表点得开」——详情与列表必须用同一套条件。
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(path.join(tmpdir(), 'p40-course-auth-gate-'));
process.env.PLATFORM_DATA_DIR = dir;
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';

const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
async function expectError(fn, code, label) {
  try { await fn(); failures.push(`${label}: expected ${code}`); }
  catch (error) { check(error?.code === code, `${label}: got ${error?.code || error?.message}`); }
}

const now = new Date().toISOString();

try {
  const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
  const { handleOrg } = await import('../apps/server/src/routes/orgAdmin.js');
  const { handlePublicCommunication } = await import('../apps/server/src/routes/communication.js');
  const { q, row, rows } = await import('../apps/server/src/lib.js');
  const { getStudentAccessibleCourses } = await import('../apps/server/src/services/studentContext.js');

  const adminAuth = { user: { id: 'root', login: 'root', displayName: 'Root', role: 'SUPER_ADMIN', orgId: null, permissions: [] }, rawUser: { permissions: '[]' } };
  const adminCtx = (pathname, method = 'GET', body = null) => ({ pathname, method, body, auth: adminAuth, search: new URLSearchParams(), req: { socket: { remoteAddress: '127.0.0.1' } } });
  const orgCtx = (orgId, pathname, method = 'GET', body = null) => ({ pathname, method, body, auth: { user: { id: `oa_${orgId}`, login: `oa_${orgId}`, role: 'ORG_ADMIN', orgId, permissions: [] }, rawUser: { permissions: '[]' } }, search: new URLSearchParams(), req: { socket: { remoteAddress: '127.0.0.1' } } });
  const publicCtx = (pathname, search = '') => ({ pathname, method: 'GET', body: null, auth: null, search: new URLSearchParams(search), req: { socket: { remoteAddress: '127.0.0.1' } } });

  const listOrgCourses = async (orgId) => (await handleOrg(orgCtx(orgId, '/api/org/course-series')))?.items || [];
  const hasCourse = async (orgId, seriesId) => (await listOrgCourses(orgId)).some((item) => item.id === seriesId);
  const plazaIds = async () => ((await handlePublicCommunication(publicCtx('/api/public/marketplace')))?.items || []).map((item) => item.id);

  // ── 夹具：两家机构（org1 会被授权，org2 不会）
  for (const [orgId, name] of [['org1', '已授权学校'], ['org2', '未授权学校']]) {
    q('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [orgId, name, 'ACTIVE', now, now, 0, 1, 0, null, now, now]);
  }
  q("INSERT INTO users(id,org_id,login,display_name,role,password_hash,status,created_at,updated_at) VALUES ('stu1','org1','stu1','学生1','STUDENT','x','ACTIVE',?,?)", [now, now]);

  // ── 平台建课包并发布
  const created = await handleAdmin(adminCtx('/api/admin/course-series', 'POST', {
    title: 'P40 授权门禁用例课包',
    description: '发布只上课程广场，机构要授权才可见。',
    visibility: 'ALL_ORGS',
    lessons: [{ title: '第1课 授权门禁', status: 'PUBLISHED', capabilities: ['text'] }],
  }));
  check(Boolean(created?.id), '创建课包应返回 id');
  const seriesId = created.id;
  const published = await handleAdmin(adminCtx(`/api/admin/course-series/${seriesId}/status`, 'POST', { action: 'publish' }));
  check(published?.status === 'PUBLISHED', `课包应发布成功，实际 ${published?.status}`);

  // ① 发布只上课程广场：广场列表能点到，详情也点得开（详情不再要求 marketplace_status）
  check((await plazaIds()).includes(seriesId), '发布后课包应出现在课程广场列表');
  const plazaDetail = await handlePublicCommunication(publicCtx(`/api/public/marketplace/${seriesId}`));
  check(plazaDetail?.id === seriesId, '课程广场详情应与列表同口径（否则广场里点开就是 404）');

  // ② 但机构后台看不到 —— 这正是旧行为错的地方
  check(!(await hasCourse('org1', seriesId)), '发布后未授权机构不应看到课包（发布 ≠ 授权）');
  check(!(await hasCourse('org2', seriesId)), '发布后未授权机构不应看到课包');
  await expectError(() => handleOrg(orgCtx('org1', `/api/org/course-series/${seriesId}`)), 'COURSE_SERIES_NOT_FOUND', '未授权机构读课包详情');
  const beforeAssign = getStudentAccessibleCourses({ id: 'stu1', org_id: 'org1' });
  check(!(beforeAssign || []).some((item) => item.id === seriesId), '未授权机构的学生端也不应看到课包');

  // ③ 授权 2 年后：机构可见，且带出有效期
  const assigned = await handleAdmin(adminCtx(`/api/admin/course-series/${seriesId}/assignments`, 'POST', { orgIds: ['org1'], validityDays: 730 }));
  check(assigned?.assignedCount === 1, `授权应写入 1 条，实际 ${assigned?.assignedCount}`);
  const twoYearsOut = Date.now() + 729 * 24 * 60 * 60 * 1000;
  check(new Date(assigned.expiresAt).getTime() > twoYearsOut, `2 年授权的到期时间应在 2 年后，实际 ${assigned?.expiresAt}`);
  check(await hasCourse('org1', seriesId), '授权后机构应能看到课包');
  check(!(await hasCourse('org2', seriesId)), '未被授权的另一家机构仍不应看到课包');
  const orgListed = (await listOrgCourses('org1')).find((item) => item.id === seriesId);
  check(orgListed?.assignedToCurrentOrg === true, '机构端应标记该课包为「平台已授权」');
  check(orgListed?.assignmentExpiresAt === assigned.expiresAt, '机构端应带出授权到期时间供展示');
  const orgDetail = await handleOrg(orgCtx('org1', `/api/org/course-series/${seriesId}`));
  check(orgDetail?.id === seriesId, '授权后机构应能读到课包详情');
  check(getStudentAccessibleCourses({ id: 'stu1', org_id: 'org1' }).some((item) => item.id === seriesId), '授权后该机构学生端应能看到课包');

  // ④ 授权到期 → 机构立刻看不到（不需要任何定时任务）
  q("UPDATE course_assignments SET expires_at=? WHERE series_id=? AND org_id='org1'", [new Date(Date.now() - 60 * 1000).toISOString(), seriesId]);
  check(!(await hasCourse('org1', seriesId)), '授权过期后机构不应再看到课包');
  await expectError(() => handleOrg(orgCtx('org1', `/api/org/course-series/${seriesId}`)), 'COURSE_SERIES_NOT_FOUND', '授权过期后读课包详情');
  check(!getStudentAccessibleCourses({ id: 'stu1', org_id: 'org1' }).some((item) => item.id === seriesId), '授权过期后学生端也不应看到课包');

  // ⑤ 重新授权（续期覆盖原有效期）→ 又能看到
  const renewed = await handleAdmin(adminCtx(`/api/admin/course-series/${seriesId}/assignments`, 'POST', { orgIds: ['org1'], validityDays: 365 }));
  check(new Date(renewed.expiresAt).getTime() > Date.now(), '续期后到期时间应回到未来');
  check(await hasCourse('org1', seriesId), '续期后机构应重新看到课包');
  check(rows('SELECT id FROM course_assignments WHERE series_id=? AND org_id=?', [seriesId, 'org1']).length === 1, '续期应复用同一条授权记录');

  // ⑥ 撤销 → 立刻看不到；课包本身与广场展示不受影响
  await handleAdmin(adminCtx(`/api/admin/course-series/${seriesId}/assignments/revoke`, 'POST', { orgId: 'org1' }));
  check(!(await hasCourse('org1', seriesId)), '撤销授权后机构应立刻看不到课包');
  check((await plazaIds()).includes(seriesId), '撤销授权不应影响课程广场展示（授权与上架是两件事）');
  const detail = await handleAdmin(adminCtx(`/api/admin/course-series/${seriesId}/detail`));
  check(!(detail?.assignedOrgs || []).some((item) => item.orgId === 'org1'), '撤销后的授权不应再出现在课包详情的有效授权列表里');

  // ⑦ 撤销后重新授权（REVOKED → ACTIVE）：这是「先撤销、过阵子再给」的实际路径，
  //    曾经因为续期分支只查 id 不查 status 而直接抛「status 无效」。
  await handleAdmin(adminCtx(`/api/admin/course-series/${seriesId}/assignments`, 'POST', { orgIds: ['org1'], validityDays: 365 }));
  check(await hasCourse('org1', seriesId), '撤销后重新授权应能恢复机构可见');

  // ⑧ 下架 → 广场不再展示，机构本来就看不到
  await handleAdmin(adminCtx(`/api/admin/course-series/${seriesId}/status`, 'POST', { action: 'archive' }));
  check(!(await plazaIds()).includes(seriesId), '下架后课包应退出课程广场');

  // ⑨ 「不上架（ASSIGNED_ORGS）」不上广场，但授权后机构照样可见 —— 两件事互不干涉
  const privateSeries = await handleAdmin(adminCtx('/api/admin/course-series', 'POST', {
    title: 'P40 不上架授权课包',
    visibility: 'ASSIGNED_ORGS',
    lessons: [{ title: '第1课 定向课', status: 'PUBLISHED', capabilities: ['text'] }],
  }));
  await handleAdmin(adminCtx(`/api/admin/course-series/${privateSeries.id}/status`, 'POST', { action: 'publish' }));
  check(!(await plazaIds()).includes(privateSeries.id), '「不上架」课包不应出现在课程广场');
  await handleAdmin(adminCtx(`/api/admin/course-series/${privateSeries.id}/assignments`, 'POST', { orgIds: ['org1'], validityDays: 365 }));
  check(await hasCourse('org1', privateSeries.id), '「不上架」课包授权后机构应能看到');
  check(!(await plazaIds()).includes(privateSeries.id), '机构可见不应把课包带上课程广场');
} catch (error) {
  failures.push(`unexpected: ${error?.stack || error?.message || error}`);
}

if (failures.length) {
  console.error(JSON.stringify({ name: 'p40-course-publish-authorization-gate', pass: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p40-course-publish-authorization-gate', pass: true, failures: 0 }, null, 2));
