/**
 * P211 普通课节数口径：`course_series.include_in_normal_pool`（2026-11-10 用户口径）。
 *
 * 用户确认：
 *   · 普通课只算 S1/S2/S3 = 48 节；成人/商家两门课**不算节数、不进池子**；
 *   · 以后新建课包要有「算不算节数」的选项（默认算）；
 *   · 不计入池子的独立课程：授权/核销落在自己的系列上，不占普通课余额；
 *   · 课包上还有授权次数/学生许可时，不允许切换「计入普通课」（避免余额凭空消失）。
 *
 * 本脚本走真 HTTP，钉住上面四条 + 平台/机构两个读取面的节数与授权口径。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p211-normal-pool-flag-'));
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

const port = 19091;
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

const lessonBody = (title) => ({ title, status: 'PUBLISHED', deliveryModes: ['CANVAS'], capabilities: ['text', 'image'] });
const purchase = (suffix, quantity) => ({ amountMinor: quantity * 10000, currency: 'CNY', paymentStatus: 'PAID', orderNo: `P211-O-${suffix}`, contractNo: 'P211-C', idempotencyKey: `p211-${suffix}` });
const normalCount = async () => Number((await arow(`SELECT COUNT(*) n FROM course_lessons lesson
  JOIN course_series series ON series.id=lesson.series_id
  WHERE series.owner_type='PLATFORM' AND series.series_type='NORMAL'
    AND series.include_in_normal_pool<>0
    AND series.status='PUBLISHED' AND lesson.status='PUBLISHED'`))?.n || 0);
const normalOptionTitle = async (admin) => {
  const res = await api('/api/admin/authorizations', { token: admin });
  return (res.data?.items || []).find((item) => item.id === 'NORMAL')?.title || '';
};

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data?.token;
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data?.token;
  const studentToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data?.token;
  assert.ok(admin && orgAdmin && studentToken, '登录失败');

  const pool = await arow(`SELECT id FROM course_series
    WHERE owner_type='PLATFORM' AND series_type='NORMAL' AND include_in_normal_pool<>0
    ORDER BY created_at, sort, id LIMIT 1`);
  assert.ok(pool?.id, 'seed 没有普通课池子系列');
  const baseCount = await normalCount();

  /* ① 新建「不计入节数」的独立课程：默认口径是计入，显式传 false 才排除 */
  const excludedTitle = 'P211 独立课程（不计节数）';
  let excludedId = '';
  let excludedLessonId = '';
  let switchableId = '';
  {
    const created = await api('/api/admin/course-series', {
      method: 'POST', token: admin,
      body: { title: excludedTitle, description: 'P211 测试课程', coverImageUrl: 'https://example.com/p211.png', seriesType: 'NORMAL', includeInNormalPool: false, lessons: [lessonBody('独立课程第 1 节'), lessonBody('独立课程第 2 节')] },
    });
    excludedId = created.data?.id || '';
    excludedLessonId = created.data?.lessons?.[0]?.id || '';
    check('① 建包时可直接标记「不计入普通课节数」', created.status === 200 && Boolean(excludedId), JSON.stringify(created.error || created.data).slice(0, 200));
    const published = await api(`/api/admin/course-series/${excludedId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
    check('① 独立课程发布成功', published.status === 200, JSON.stringify(published.error || {}).slice(0, 200));
    const row = await arow('SELECT include_in_normal_pool FROM course_series WHERE id=?', [excludedId]);
    check('① 库里 include_in_normal_pool=0', Number(row?.include_in_normal_pool) === 0, JSON.stringify(row));
    check('① 平台「普通课（N 节）」节数不变 ★', (await normalOptionTitle(admin)) === `普通课（${baseCount} 节）`, await normalOptionTitle(admin));
    check('① 平台授权页把独立课程单出一行（可单独授权）', (await api('/api/admin/authorizations', { token: admin })).data?.items?.some((item) => item.id === excludedId && item.seriesType === 'NORMAL'));
  }

  /* ② 新建默认（计入）的普通课：节数 +1；机构已开通池子时自动补 0 次数访问授权 */
  let includedId = '';
  {
    const created = await api('/api/admin/course-series', {
      method: 'POST', token: admin,
      body: { title: 'P211 普通课（默认计入）', description: 'P211 测试课程', coverImageUrl: 'https://example.com/p211.png', seriesType: 'NORMAL', lessons: [lessonBody('普通课第 1 节')] },
    });
    includedId = created.data?.id || '';
    check('② 不传 includeInNormalPool 时默认计入', created.status === 200 && Boolean(includedId), JSON.stringify(created.error || created.data).slice(0, 200));
    await api(`/api/admin/course-series/${includedId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
    const row = await arow('SELECT include_in_normal_pool FROM course_series WHERE id=?', [includedId]);
    check('② 库里 include_in_normal_pool=1', Number(row?.include_in_normal_pool) === 1, JSON.stringify(row));
    check('② 平台「普通课（N 节）」节数 +1 ★', (await normalOptionTitle(admin)) === `普通课（${baseCount + 1} 节）`, await normalOptionTitle(admin));

    const assigned = await api(`/api/admin/course-series/${pool.id}/assignments`, { method: 'POST', token: admin, body: { orgId: seeded.orgId, quotaTotal: 2, ...purchase('pool', 2) } });
    check('② 给机构开通普通课池子 2 次', assigned.status === 200 && assigned.data?.quotaTotal === 2, JSON.stringify(assigned.error || assigned.data).slice(0, 200));
    const access = await arow('SELECT quota_total FROM course_assignments WHERE series_id=? AND org_id=?', [includedId, seeded.orgId]);
    check('② 计入池子的系列自动拿到 0 次数访问授权', Number(access?.quota_total) === 0 && Boolean(access), JSON.stringify(access));
    const excludedAccess = await arow('SELECT id FROM course_assignments WHERE series_id=? AND org_id=?', [excludedId, seeded.orgId]);
    check('② 不计入池子的系列**没有**访问授权 ★', !excludedAccess, JSON.stringify(excludedAccess));
    const batch = await arow('SELECT scope_type, scope_key FROM license_purchase_batches WHERE org_id=? AND series_id=? ORDER BY created_at DESC LIMIT 1', [seeded.orgId, pool.id]);
    check('② 池子采购批次 scope=NORMAL', batch?.scope_type === 'NORMAL' && batch?.scope_key === 'NORMAL', JSON.stringify(batch));

    // 学生端：许可记在池子系列上，但「我的课程」要展开成池子里的**全部系列**（S1/S2/S3 各一张卡）。
    const dashboard = await api('/api/student/dashboard', { token: studentToken });
    const studentCourses = dashboard.data?.classroomCourses || [];
    check('② 学生端能看到池子系列 S1 的卡', studentCourses.some((item) => item.id === pool.id), JSON.stringify(studentCourses.map((item) => ({ id: item.id, title: item.title, hasGrant: item.hasGrant }))).slice(0, 400));
    check('② 学生端也能看到池子里的新系列（S2 卡，无单独学生许可）★', studentCourses.some((item) => item.id === includedId && item.hasGrant === true), JSON.stringify(studentCourses.map((item) => ({ id: item.id, title: item.title, hasGrant: item.hasGrant }))).slice(0, 400));
  }

  /* ③ 独立课程可以单独授权：次数落在自己系列上，不占普通课池子 */
  {
    const poolBeforeAssign = await arow('SELECT quota_total, quota_used FROM course_assignments WHERE series_id=? AND org_id=?', [pool.id, seeded.orgId]);
    const assigned = await api(`/api/admin/course-series/${excludedId}/assignments`, { method: 'POST', token: admin, body: { orgId: seeded.orgId, quotaTotal: 3, ...purchase('excluded', 3) } });
    check('③ 独立课程可单独给机构开通 3 次 ★', assigned.status === 200 && assigned.data?.quotaTotal === 3, JSON.stringify(assigned.error || assigned.data).slice(0, 200));
    const batch = await arow('SELECT scope_type, scope_key FROM license_purchase_batches WHERE org_id=? AND series_id=? ORDER BY created_at DESC LIMIT 1', [seeded.orgId, excludedId]);
    check('③ 独立课程财务 scope=SERIES/自身 ★', batch?.scope_type === 'SERIES' && batch?.scope_key === excludedId, JSON.stringify(batch));
    const poolRow = await arow('SELECT quota_total, quota_used FROM course_assignments WHERE series_id=? AND org_id=?', [pool.id, seeded.orgId]);
    check('③ 普通课池子余额不受独立课程影响', Number(poolRow?.quota_total) === Number(poolBeforeAssign?.quota_total) && Number(poolRow?.quota_used) === Number(poolBeforeAssign?.quota_used), JSON.stringify({ before: poolBeforeAssign, after: poolRow }));
  }

  /* ④ 机构端：节数只算池子；独立课程单独一行 */
  {
    const overview = await api('/api/org/series-overview?days=30', { token: orgAdmin });
    const items = overview.data?.items || [];
    const normalRow = items.find((item) => item.seriesId === 'NORMAL');
    check('④ 机构「普通课（N 节）」只算池子 ★', normalRow?.title === `普通课（${baseCount + 1} 节）`, JSON.stringify(normalRow));
    check('④ 计入池子的系列不单独出行', !items.some((item) => item.seriesId === includedId));
    const excludedRow = items.find((item) => item.seriesId === excludedId);
    check('④ 独立课程单独一行、带自己的 3 次', excludedRow?.quotaTotal === 3 && excludedRow?.title === excludedTitle, JSON.stringify(excludedRow));
  }

  /* ⑤ 机构给独立课程授权：许可落在自己的系列上，不落到普通课池子 */
  {
    const granted = await api('/api/org/course-grants', { method: 'POST', token: orgAdmin, body: { seriesId: excludedId, studentIds: [seeded.studentId], units: 1, idempotencyKey: 'p211-grant-1' } });
    check('⑤ 独立课程可给学生授权', granted.status === 200, JSON.stringify(granted.error || granted.data).slice(0, 200));
    const grant = await arow('SELECT series_id FROM student_course_grants WHERE org_id=? AND student_id=? AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1', [seeded.orgId, seeded.studentId]);
    check('⑤ 许可 series_id = 独立课程（不是池子）★', grant?.series_id === excludedId, JSON.stringify(grant));
    const list = await api(`/api/org/course-grants?seriesId=${encodeURIComponent(excludedId)}`, { token: orgAdmin });
    check('⑤ 机构许可列表按独立课程筛选得到它', list.data?.items?.some((item) => item.seriesId === excludedId), JSON.stringify(list.data).slice(0, 200));
  }

  /* ⑤′ 独立课程的课堂：核销落在自己系列，不扣普通课池子的次数 */
  {
    const poolGrantBefore = await arow('SELECT granted_units, consumed_units FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=? AND revoked_at IS NULL', [seeded.orgId, seeded.studentId, pool.id]);
    const opened = await api('/api/org/sessions', { method: 'POST', token: orgAdmin, body: { lessonId: excludedLessonId, deliveryMode: 'CANVAS', title: 'P211 独立课程课堂' } });
    const sessionId = opened.data?.id || '';
    check('⑤′ 独立课程可建课堂', opened.status === 200 && Boolean(sessionId), JSON.stringify(opened.error || opened.data).slice(0, 200));
    const added = await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: orgAdmin, body: { studentIds: [seeded.studentId] } });
    check('⑤′ 独立课程许可可加学生', (added.data?.added || []).includes(seeded.studentId), JSON.stringify(added.error || added.data).slice(0, 200));
    const started = await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: orgAdmin });
    check('⑤′ 独立课程课堂可开始', started.status === 200, JSON.stringify(started.error || {}).slice(0, 200));
    await aq(`INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,pricing_snapshot,created_at,cost_fen)
      VALUES (?,?,?,?,'TEXT','real-model',0,'SUCCESS','{"provider":"real"}',?,0)`,
      ['p211_usage_1', seeded.orgId, seeded.studentId, sessionId, new Date().toISOString()]);
    const ended = await api(`/api/org/sessions/${sessionId}/end`, { method: 'POST', token: orgAdmin, body: {} });
    check('⑤′ 独立课程课堂结束成功', ended.status === 200, JSON.stringify(ended.error || {}).slice(0, 200));
    const part = await arow('SELECT status FROM session_students WHERE session_id=? AND student_id=?', [sessionId, seeded.studentId]);
    check('⑤′ 学生结算为已完课', part?.status === 'COMPLETED', JSON.stringify(part));
    const excludedGrant = await arow('SELECT granted_units, consumed_units FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=? AND revoked_at IS NULL', [seeded.orgId, seeded.studentId, excludedId]);
    check('⑤′ 扣的是独立课程自己的 1 次 ★', Number(excludedGrant?.granted_units) === 1 && Number(excludedGrant?.consumed_units) === 1, JSON.stringify(excludedGrant));
    const poolGrantAfter = await arow('SELECT granted_units, consumed_units FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=? AND revoked_at IS NULL', [seeded.orgId, seeded.studentId, pool.id]);
    check('⑤′ 普通课池子的学生次数一分没动 ★', Number(poolGrantAfter?.consumed_units) === Number(poolGrantBefore?.consumed_units || 0), JSON.stringify({ before: poolGrantBefore, after: poolGrantAfter }));
  }

  /* ⑥ 有余额时不能切换「计入普通课」；清零后切换会补/删访问授权 */
  {
    const blocked = await api(`/api/admin/course-series/${excludedId}`, { method: 'PUT', token: admin, body: { includeInNormalPool: true } });
    check('⑥ 独立课程还有 3 次授权时，切换被拒 ★', blocked.status === 409 && blocked.code === 'NORMAL_POOL_IN_USE', `${blocked.status} ${blocked.code} ${JSON.stringify(blocked.error || {})}`);

    // 再建一个没有余额的独立课程：切进池子 → 补访问授权、节数 +1；切出去 → 删访问授权、节数回去
    const created = await api('/api/admin/course-series', {
      method: 'POST', token: admin,
      body: { title: 'P211 无余额可切换', description: 'P211 测试课程', coverImageUrl: 'https://example.com/p211.png', seriesType: 'NORMAL', includeInNormalPool: false, lessons: [lessonBody('无余额第 1 节')] },
    });
    switchableId = created.data?.id || '';    await api(`/api/admin/course-series/${switchableId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
    check('⑥ 无余额独立课程建包成功', Boolean(switchableId), JSON.stringify(created.error || {}).slice(0, 200));

    const before = await normalCount();
    const on = await api(`/api/admin/course-series/${switchableId}`, { method: 'PUT', token: admin, body: { includeInNormalPool: true } });
    check('⑥ 无余额时切进池子成功', on.status === 200, JSON.stringify(on.error || {}).slice(0, 200));
    check('⑥ 切进后节数 +1 ★', (await normalCount()) === before + 1, `${before} → ${await normalCount()}`);
    const access = await arow('SELECT quota_total FROM course_assignments WHERE series_id=? AND org_id=?', [switchableId, seeded.orgId]);
    check('⑥ 切进后自动补 0 次数访问授权', Number(access?.quota_total) === 0 && Boolean(access), JSON.stringify(access));

    const off = await api(`/api/admin/course-series/${switchableId}`, { method: 'PUT', token: admin, body: { includeInNormalPool: false } });
    check('⑥ 无余额时切出池子成功', off.status === 200, JSON.stringify(off.error || {}).slice(0, 200));
    check('⑥ 切出后节数回到原值', (await normalCount()) === before, `${before} → ${await normalCount()}`);
    const accessAfter = await arow('SELECT id FROM course_assignments WHERE series_id=? AND org_id=?', [switchableId, seeded.orgId]);
    check('⑥ 切出后 0 次数访问授权被清掉', !accessAfter, JSON.stringify(accessAfter));
    const overview = await api('/api/org/series-overview?days=30', { token: orgAdmin });
    check('⑥ 机构端也不再看到它', !(overview.data?.items || []).some((item) => item.seriesId === switchableId));
  }

  /* ⑦ 体验课包永远不计入普通课节数 */
  {
    const exp = await api('/api/admin/course-series', {
      method: 'POST', token: admin,
      body: { title: 'P211 体验课（不计节数）', description: 'P211 测试课程', coverImageUrl: 'https://example.com/p211.png', seriesType: 'EXPERIENCE', includeInNormalPool: true, lessons: [lessonBody('体验第 1 节')] },
    });
    const expId = exp.data?.id || '';
    const row = await arow('SELECT include_in_normal_pool FROM course_series WHERE id=?', [expId]);
    check('⑦ 体验课包即使传 true 也存 0 ★', exp.status === 200 && Number(row?.include_in_normal_pool) === 0, JSON.stringify(row));
    const normalized = await api(`/api/admin/course-series/${expId}/detail`, { token: admin }).catch(() => ({}));
    const series = normalized.data?.series || normalized.data;
    check('⑦ 接口返回 includeInNormalPool=false', series?.includeInNormalPool === false, JSON.stringify(series?.includeInNormalPool));
  }

  /* ⑧ 删除保护：有授权/许可/采购的课包不能删；没有的可以删 */
  {
    const delBlocked = await api(`/api/admin/course-series/${excludedId}`, { method: 'DELETE', token: admin });
    check('⑧ 有课堂引用的课包不能删除', delBlocked.status === 400 && delBlocked.code === 'COURSE_SERIES_IN_USE', `${delBlocked.status} ${delBlocked.code}`);

    // 只挂授权次数、没有课堂/作品的课包：必须由「余额保护」拦下（不然删课包会把授权单和许可一起带走）。
    const balanceOnly = await api('/api/admin/course-series', {
      method: 'POST', token: admin,
      body: { title: 'P211 只有余额的课包', description: 'P211 测试课程', coverImageUrl: 'https://example.com/p211.png', seriesType: 'NORMAL', includeInNormalPool: false, lessons: [lessonBody('只有余额第 1 节')] },
    });
    const balanceOnlyId = balanceOnly.data?.id || '';
    await api(`/api/admin/course-series/${balanceOnlyId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
    await api(`/api/admin/course-series/${balanceOnlyId}/assignments`, { method: 'POST', token: admin, body: { orgId: seeded.orgId, quotaTotal: 1, ...purchase('balanceonly', 1) } });
    const delBalance = await api(`/api/admin/course-series/${balanceOnlyId}`, { method: 'DELETE', token: admin });
    check('⑧ 只有授权余额的课包不能删除 ★', delBalance.status === 400 && delBalance.code === 'COURSE_SERIES_HAS_BALANCE', `${delBalance.status} ${delBalance.code} ${JSON.stringify(delBalance.error || {})}`);

    const delOk = await api(`/api/admin/course-series/${switchableId}`, { method: 'DELETE', token: admin });
    check('⑧ 无余额/无许可的课包可以删除', delOk.status === 200, `${delOk.status} ${JSON.stringify(delOk.error || {})}`);
  }

  /* ⑨ 池子键锁定：没有余额也不能把池子键取消计入（防止池子漂移） */
  {
    await aq('UPDATE course_assignments SET quota_total=0, quota_used=0 WHERE series_id=?', [pool.id]);
    await aq('UPDATE student_course_grants SET revoked_at=? WHERE series_id=? AND revoked_at IS NULL', [new Date().toISOString(), pool.id]);
    const locked = await api(`/api/admin/course-series/${pool.id}`, { method: 'PUT', token: admin, body: { includeInNormalPool: false } });
    check('⑨ 池子键不能取消计入（防止池子漂移）★', locked.status === 409 && locked.code === 'NORMAL_POOL_KEY_LOCKED', `${locked.status} ${locked.code} ${JSON.stringify(locked.error || {})}`);
  }

  console.log(JSON.stringify({ name: 'normal-pool-include-flag', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-4000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
