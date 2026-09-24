/**
 * P140 平台「体验课包」（2026-09-24 用户口径，交接文档 §十二.B）。
 *
 * 用户确认过的口径（逐条钉住，别按自己的理解改）：
 *   · 课包类型是**独立字段** `course_series.series_type`（NORMAL 默认 / EXPERIENCE），
 *     **不要**复用机构试用 `organizations.is_trial`、也不要靠标题或标签猜；
 *   · 体验课包**只包含一节课**（普通课包**不加**任何新的节数限制）；
 *   · 与普通课包**相同**的人次消耗/分配机制与课程编排逻辑；
 *   · **同一个体验课包可以重复分给同一学生**，且**未使用的次数可以预先累积**；
 *   · **每场课堂正常结束、且该学生有有效 AI 产出时，核销 1 次**（无产出不扣、INCOMPLETE 不扣、解散不扣）；
 *   · **普通课包行为完全不变**（授权即扣、重复授权跳过、同课时完课拦截）。
 *
 * ⚠️ 起真服务、发真请求（p78/p86 那套）：核销发生在 `/sessions/:id/end` 的同一个事务里，
 *    直接调 settleSessionStudents 会漏掉"结束失败要不要回滚"这条。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p140-experience-pkg-'));
const dbPath = path.join(temp, 'platform.db');
// 硬设（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略。
process.env.PLATFORM_DB_PATH = dbPath;
// 夹具走数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import。
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

const port = 19080;
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

// 体验课包的 id 由服务端生成（② 建课时拿到），后面所有夹具都跟着它走
let experienceSeriesId = '';
let experienceLessonId = '';
const balanceOf = async () => {
  const grant = await arow('SELECT granted_units, consumed_units FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=?', [seeded.orgId, seeded.studentId, experienceSeriesId]);
  return Number(grant?.granted_units || 0) - Number(grant?.consumed_units || 0);
};
const consumptionsOf = async () => Number((await arow('SELECT COUNT(*) n FROM student_course_grant_consumptions WHERE series_id=? AND student_id=?', [experienceSeriesId, seeded.studentId]))?.n || 0);

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data?.token;
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data?.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data?.token;
  assert.ok(admin && orgAdmin && student, '登录失败');

  const purchase = (suffix, quantity) => ({ amountMinor: quantity * 10000, currency: 'CNY', paymentStatus: 'PAID', orderNo: `P140-O-${suffix}`, contractNo: 'P140-C', idempotencyKey: `p140-${suffix}` });
  const createSeries = (title, seriesType, lessons) => api('/api/admin/course-series', {
    method: 'POST', token: admin,
    // stockTotal = 平台可分配出去的次数池：给机构的授权次数不能超过它（不给会被 COURSE_QUOTA_EXCEEDS_STOCK 拒）
    body: { title, description: `${title} 简介`, coverImageUrl: 'https://example.com/p140.png', priceFen: 0, stockTotal: 10, seriesType, lessons },
  });
  const lessonBody = (title) => ({ title, status: 'PUBLISHED', deliveryModes: ['CANVAS'], capabilities: ['text', 'image'] });
  const grantToStudent = () => api('/api/org/course-grants', { method: 'POST', token: orgAdmin, body: { seriesId: experienceSeriesId, studentIds: [seeded.studentId] } });

  /* ① 体验课包只能 1 节课（建课 / 课时编排 / 改成体验包 三条入口都要拦） */
  {
    const two = await createSeries('P140 体验包两节', 'EXPERIENCE', [lessonBody('第 1 节'), lessonBody('第 2 节')]);
    check('① 体验课包建课时就拒绝 2 节课（EXPERIENCE_SERIES_LESSON_LIMIT）★',
      two.status === 400 && two.code === 'EXPERIENCE_SERIES_LESSON_LIMIT', `HTTP ${two.status} ${JSON.stringify(two.error).slice(0, 180)}`);
    const normalTwo = await createSeries('P140 普通包两节', 'NORMAL', [lessonBody('第 1 节'), lessonBody('第 2 节')]);
    check('① 普通课包不受节数限制（两节课照建）', normalTwo.status === 200 && (normalTwo.data.lessons || []).length === 2,
      `HTTP ${normalTwo.status} ${JSON.stringify(normalTwo.error || {}).slice(0, 160)}`);
  }

  /* ② 建体验课包 + 发布（类型要能下发给机构端/官网） */
  {
    const created = await createSeries('P140 体验课包', 'EXPERIENCE', [lessonBody('体验课')]);
    check('② 体验课包（1 节课）建成功且类型落库', created.status === 200 && created.data?.seriesType === 'EXPERIENCE',
      `HTTP ${created.status} seriesType=${created.data?.seriesType} ${JSON.stringify(created.error || {}).slice(0, 160)}`);
    experienceSeriesId = created.data?.id || '';
    experienceLessonId = (created.data?.lessons || [])[0]?.id || '';
    const published = await api(`/api/admin/course-series/${experienceSeriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
    check('② 体验课包发布成功', published.status === 200 && published.data?.status === 'PUBLISHED',
      `HTTP ${published.status} ${JSON.stringify(published.error || {}).slice(0, 200)}`);

    const extra = await api(`/api/admin/course-series/${experienceSeriesId}/lessons`, { method: 'POST', token: admin, body: { lessons: [lessonBody('偷加的第 2 节')] } });
    check('② 课时编排给体验课包再加一节被拒', extra.status === 400 && extra.code === 'EXPERIENCE_SERIES_LESSON_LIMIT',
      `HTTP ${extra.status} ${JSON.stringify(extra.error || {}).slice(0, 180)}`);

    const normalTwoId = (await arow("SELECT id FROM course_series WHERE title='P140 普通包两节'"))?.id;
    const switchType = await api(`/api/admin/course-series/${normalTwoId}`, { method: 'PUT', token: admin, body: { seriesType: 'EXPERIENCE' } });
    check('② 普通包（2 节课）改成体验课包被拒', switchType.status === 400 && switchType.code === 'EXPERIENCE_SERIES_LESSON_LIMIT',
      `HTTP ${switchType.status} ${JSON.stringify(switchType.error || {}).slice(0, 180)}`);

    // 发布校验兜底：绕过前面两道，直接往库里塞第 2 节课 → 版本发布必须拦住
    const now = new Date().toISOString();
    await aq(`INSERT INTO course_lessons(id,series_id,title,sort,status,duration_minutes,lesson_content,delivery_mode,classroom_config,created_at,updated_at)
      VALUES ('p140-extra-lesson',?,?,9,'PUBLISHED',45,'','CANVAS','{}',?,?)`, [experienceSeriesId, '绕过入口塞进来的第 2 节', now, now]);
    const republish = await api(`/api/admin/course-series/${experienceSeriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.1', note: 'P140' } });
    check('② 发布校验兜底：库里被塞了第 2 节，版本发布被拒 ★',
      republish.status === 400 && republish.code === 'EXPERIENCE_SERIES_LESSON_LIMIT', `HTTP ${republish.status} ${JSON.stringify(republish.error || {}).slice(0, 200)}`);
    await aq("DELETE FROM course_lessons WHERE id='p140-extra-lesson'");
    const publishedAgain = await api(`/api/admin/course-series/${experienceSeriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.1', note: 'P140' } });
    check('② 删掉多出来的课时后，更新发布恢复可用', publishedAgain.status === 200, `HTTP ${publishedAgain.status} ${JSON.stringify(publishedAgain.error || {}).slice(0, 200)}`);
  }

  /* ③ 授权给机构 6 次（本脚本一共要分 4 次：④×2 + ⑧×1 + ⑨×1）；机构端读面带类型 */
  {
    const assigned = await api(`/api/admin/course-series/${experienceSeriesId}/assignments`, { method: 'POST', token: admin, body: { orgId: seeded.orgId, quotaTotal: 6, ...purchase('exp', 6) } });
    check('③ 平台把体验课包授权给机构（6 次）', assigned.status === 200 && assigned.data?.quotaTotal === 6,
      `HTTP ${assigned.status} ${JSON.stringify(assigned.error || assigned.data).slice(0, 200)}`);
    const orgSeries = await api('/api/org/course-series?limit=100', { token: orgAdmin });
    const row = (orgSeries.data?.items || []).find((item) => item.id === experienceSeriesId);
    check('③ 机构端读面带 seriesType=EXPERIENCE（发布快照下发）★', row?.seriesType === 'EXPERIENCE', JSON.stringify(row || {}).slice(0, 200));
  }

  /* ④ 重复分配给同一学生：**累加**而不是跳过 */
  {
    const first = await grantToStudent();
    const second = await grantToStudent();
    check('④ 第一次分配：1 人次、不跳过', first.status === 200 && first.data?.granted === 1 && first.data?.skipped === 0, JSON.stringify(first.data || first.error).slice(0, 200));
    check('④ 同一个学生**再分一次**：仍然 granted=1、skipped=0（体验包不跳过）★', second.status === 200 && second.data?.granted === 1 && second.data?.skipped === 0, JSON.stringify(second.data || second.error).slice(0, 200));
    const grant = await arow('SELECT id, granted_units, consumed_units FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=?', [seeded.orgId, seeded.studentId, experienceSeriesId]);
    check('④ 次数**累加在同一行**上（granted_units=2、还剩 2 次）★', Number(grant?.granted_units) === 2 && Number(grant?.consumed_units) === 0, JSON.stringify(grant));
    const assignment = await arow('SELECT quota_total, quota_used FROM course_assignments WHERE series_id=? AND org_id=?', [experienceSeriesId, seeded.orgId]);
    check('④ 机构次数被扣 2 次（每次分配都算一次人次）', Number(assignment?.quota_used) === 2, JSON.stringify(assignment));
    const list = await api(`/api/org/course-grants?seriesId=${encodeURIComponent(experienceSeriesId)}`, { token: orgAdmin });
    const row = (list.data?.items || [])[0];
    check('④ 机构端授权列表带「可用 N 次」', row?.remainingUnits === 2 && row?.seriesType === 'EXPERIENCE', JSON.stringify(row || {}).slice(0, 200));
  }

  // 开一场体验课（PENDING → 加人 → 开始上课）
  const openSession = async (title) => {
    const created = await api('/api/org/sessions', { method: 'POST', token: orgAdmin, body: { lessonId: experienceLessonId, deliveryMode: 'CANVAS', title } });
    const sessionId = created.data?.id;
    const added = await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: orgAdmin, body: { studentIds: [seeded.studentId] } });
    const started = await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: orgAdmin });
    return { sessionId, created, added, started };
  };
  const endSession = (sessionId) => api(`/api/org/sessions/${sessionId}/end`, { method: 'POST', token: orgAdmin, body: {} });
  const dissolveSession = (sessionId) => api(`/api/org/sessions/${sessionId}/dissolve`, { method: 'POST', token: orgAdmin, body: {} });
  const partStatusOf = async (sessionId) => (await arow('SELECT status FROM session_students WHERE session_id=? AND student_id=?', [sessionId, seeded.studentId]))?.status;
  // 「有有效产出」= 这场课堂里有真实非 mock 的成功调用（与完课判定同一套条件，见 classroomSessions.js）
  const giveRealUsage = (sessionId, id) => aq(
    `INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,pricing_snapshot,created_at,cost_fen)
     VALUES (?,?,?,?,'TEXT','real-model',0,'SUCCESS','{"provider":"real"}',?,0)`,
    [id, seeded.orgId, seeded.studentId, sessionId, new Date().toISOString()],
  );

  /* ⑤ 课堂正常结束 + 有有效产出 → 核销 1 次 */
  {
    const { sessionId, added, started } = await openSession('P140 第一场（有产出）');
    check('⑤ 体验课包能正常开课、加人、开始上课', Boolean(sessionId) && (added.data?.added || []).length === 1 && started.status === 200,
      JSON.stringify({ added: added.data || added.error, start: started.error }).slice(0, 220));
    await giveRealUsage(sessionId, 'p140_usage_1');
    const ended = await endSession(sessionId);
    check('⑤ 结束课堂成功', ended.status === 200, JSON.stringify(ended.error || {}).slice(0, 200));
    check('⑤ 学员结算成**已完课**', (await partStatusOf(sessionId)) === 'COMPLETED', String(await partStatusOf(sessionId)));
    check('⑤ **核销 1 次**（可用 2 → 1）★', (await balanceOf()) === 1 && (await consumptionsOf()) === 1, `剩余 ${await balanceOf()} 次 / 核销记录 ${await consumptionsOf()} 条`);
    const again = await endSession(sessionId);
    check('⑤ 重复点「结束」不会再扣一次（幂等）', again.status >= 400 && (await balanceOf()) === 1, `HTTP ${again.status} 剩余 ${await balanceOf()}`);
  }

  /* ⑥ 同课时**可以再上**（体验包的意义）；无产出 → 不扣 */
  {
    const { added, started, sessionId } = await openSession('P140 第二场（无产出）');
    check('⑥ 同课时可以再开一场、并把这个学生再加进去（普通包的"完课拦截"对体验包放行）★',
      (added.data?.added || []).length === 1 && started.status === 200, JSON.stringify({ added: added.data || added.error, start: started.error }).slice(0, 220));
    const ended = await endSession(sessionId);
    check('⑥ 结束课堂成功', ended.status === 200, JSON.stringify(ended.error || {}).slice(0, 200));
    check('⑥ 学员结算成**未完课**（这场没有产出）', (await partStatusOf(sessionId)) === 'INCOMPLETE', String(await partStatusOf(sessionId)));
    check('⑥ **无产出不扣**（可用次数仍是 1）★', (await balanceOf()) === 1 && (await consumptionsOf()) === 1, `剩余 ${await balanceOf()} / 核销 ${await consumptionsOf()}`);
  }

  /* ⑦ 解散课堂 → 不扣（解散只能发生在开课前：排了课但没上，不该扣学生次数） */
  {
    const created = await api('/api/org/sessions', { method: 'POST', token: orgAdmin, body: { lessonId: experienceLessonId, deliveryMode: 'CANVAS', title: 'P140 第三场（解散）' } });
    const sessionId = created.data?.id;
    const added = await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: orgAdmin, body: { studentIds: [seeded.studentId] } });
    check('⑦ 夹具：把学生排进待上课的课堂', (added.data?.added || []).length === 1, JSON.stringify(added.data || added.error).slice(0, 200));
    const dissolved = await dissolveSession(sessionId);
    check('⑦ 课堂解散成功', dissolved.status === 200, JSON.stringify(dissolved.error || {}).slice(0, 200));
    check('⑦ **解散不核销**（核销只发生在"正常结束"那条路径上）★', (await balanceOf()) === 1 && (await consumptionsOf()) === 1, `剩余 ${await balanceOf()} / 核销 ${await consumptionsOf()}`);
    check('⑦ 解散后学员是"被移除"（不是完课/未完课）', (await partStatusOf(sessionId)) === 'REMOVED', String(await partStatusOf(sessionId)));
  }

  /* ⑧ 用掉最后一次 → 余额为 0 就加不进课堂；预检也拦 */
  {
    const { sessionId } = await openSession('P140 第四场（用完）');
    await giveRealUsage(sessionId, 'p140_usage_4');
    await endSession(sessionId);
    check('⑧ 最后 1 次也核销掉（可用 0）★', (await balanceOf()) === 0 && (await consumptionsOf()) === 2, `剩余 ${await balanceOf()} / 核销 ${await consumptionsOf()}`);

    const created = await api('/api/org/sessions', { method: 'POST', token: orgAdmin, body: { lessonId: experienceLessonId, deliveryMode: 'CANVAS', title: 'P140 第五场（余额不足）' } });
    const fifthId = created.data?.id;
    const added = await api(`/api/org/sessions/${fifthId}/students`, { method: 'POST', token: orgAdmin, body: { studentIds: [seeded.studentId] } });
    check('⑧ 次数用完：加不进课堂（NO_EXPERIENCE_UNITS）★',
      (added.data?.skipped || []).some((item) => item.reason === 'NO_EXPERIENCE_UNITS'), JSON.stringify(added.data || added.error).slice(0, 220));
    const candidates = await api(`/api/org/sessions/${fifthId}/candidates`, { token: orgAdmin });
    const row = (candidates.data?.blocked || []).find((item) => item.id === seeded.studentId);
    check('⑧ 候选人名单里也写明"体验次数已用完"', row?.reason === 'NO_EXPERIENCE_UNITS', JSON.stringify(row || candidates.data || candidates.error).slice(0, 240));
    await dissolveSession(fifthId);

    // 预检：先把学生用残余次数排进课堂，再把余额抹平（模拟"排完课之后次数被用掉了"）→ 开始上课必须被拦
    const sixth = await api('/api/org/sessions', { method: 'POST', token: orgAdmin, body: { lessonId: experienceLessonId, deliveryMode: 'CANVAS', title: 'P140 第六场（预检）' } });
    const sixthId = sixth.data?.id;
    await grantToStudent();
    await api(`/api/org/sessions/${sixthId}/students`, { method: 'POST', token: orgAdmin, body: { studentIds: [seeded.studentId] } });
    await aq('UPDATE student_course_grants SET granted_units=consumed_units WHERE org_id=? AND student_id=? AND series_id=?', [seeded.orgId, seeded.studentId, experienceSeriesId]);
    const precheck = await api(`/api/org/sessions/${sixthId}/precheck`, { token: orgAdmin });
    const eligible = (precheck.data?.checks || []).find((item) => item.key === 'STUDENTS_ELIGIBLE');
    check('⑧ 开始上课前的预检把"次数用完"算成失效（不让老师到结束时才撞墙）★',
      eligible?.passed === false && String(eligible?.detail || '').includes('失效'),
      JSON.stringify(eligible || precheck.data || precheck.error).slice(0, 260));
    await dissolveSession(sixthId);
  }

  /* ⑨ 平台撤销：按**未消费余额**退，已核销的历史不动 */
  {
    const grant = await arow('SELECT id FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=?', [seeded.orgId, seeded.studentId, experienceSeriesId]);
    const before = await arow('SELECT quota_total, quota_used FROM course_assignments WHERE series_id=? AND org_id=?', [experienceSeriesId, seeded.orgId]);
    void before;
    // 先再分一次（可用 1 次，一次都没核销）→ 撤销时该退 1 次，而 2 次已核销的历史要原样留着
    await grantToStudent();
    check('⑨ 余额 0 时还能再分（预先累积），可用回到 1 次', (await balanceOf()) === 1, `剩余 ${await balanceOf()}`);
    const assignmentBefore = await arow('SELECT quota_used FROM course_assignments WHERE series_id=? AND org_id=?', [experienceSeriesId, seeded.orgId]);
    const revoked = await api(`/api/admin/course-grants/${encodeURIComponent(grant.id)}/revoke`, { method: 'POST', token: admin, body: { reason: 'P140 平台兜底撤销' } });
    check('⑨ 撤销返回：退 1 次、已消费 2 次', revoked.status === 200 && revoked.data?.refundedUnits === 1 && revoked.data?.consumedUnits === 2,
      `HTTP ${revoked.status} ${JSON.stringify(revoked.error || revoked.data).slice(0, 220)}`);
    const assignmentAfter = await arow('SELECT quota_used FROM course_assignments WHERE series_id=? AND org_id=?', [experienceSeriesId, seeded.orgId]);
    check('⑨ 机构次数**只退未消费的那 1 次**（4 → 3）★',
      Number(assignmentBefore?.quota_used) === 4 && Number(assignmentAfter?.quota_used) === 3,
      `before=${JSON.stringify(assignmentBefore)} after=${JSON.stringify(assignmentAfter)}`);
    const grantAfter = await arow('SELECT granted_units, consumed_units, revoked_at FROM student_course_grants WHERE id=?', [grant.id]);
    check('⑨ 已核销的历史**一个字没动**（consumed_units 仍是 2）★',
      Number(grantAfter?.consumed_units) === 2 && Number(grantAfter?.granted_units) === 2 && Boolean(grantAfter?.revoked_at),
      JSON.stringify(grantAfter));
    const seventh = await api('/api/org/sessions', { method: 'POST', token: orgAdmin, body: { lessonId: experienceLessonId, deliveryMode: 'CANVAS', title: 'P140 撤销后' } });
    const added = await api(`/api/org/sessions/${seventh.data?.id}/students`, { method: 'POST', token: orgAdmin, body: { studentIds: [seeded.studentId] } });
    check('⑨ 撤销后立刻进不了课（许可门禁）', (added.data?.skipped || []).some((item) => item.reason === 'NO_GRANT'), JSON.stringify(added.data || added.error).slice(0, 200));
    await dissolveSession(seventh.data?.id);
  }

  /* ⑩ 普通课包行为不变：重复授权跳过、次数账不动 */
  {
    const normalSeries = await createSeries('P140 普通课包', 'NORMAL', [lessonBody('第 1 节')]);
    const normalId = normalSeries.data?.id;
    await api(`/api/admin/course-series/${normalId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
    await api(`/api/admin/course-series/${normalId}/assignments`, { method: 'POST', token: admin, body: { orgId: seeded.orgId, quotaTotal: 3, ...purchase('normal', 3) } });
    const first = await api('/api/org/course-grants', { method: 'POST', token: orgAdmin, body: { seriesId: normalId, studentIds: [seeded.studentId] } });
    const second = await api('/api/org/course-grants', { method: 'POST', token: orgAdmin, body: { seriesId: normalId, studentIds: [seeded.studentId] } });
    check('⑩ 普通课包：第一次 granted=1', first.data?.granted === 1, JSON.stringify(first.data || first.error).slice(0, 160));
    check('⑩ 普通课包：**重复授权仍然跳过**（行为不变）★', second.data?.granted === 0 && second.data?.skipped === 1, JSON.stringify(second.data || second.error).slice(0, 160));
    const row = await arow('SELECT granted_units, consumed_units FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=?', [seeded.orgId, seeded.studentId, normalId]);
    check('⑩ 普通课包的行没被加次数（granted_units 仍是 1）', Number(row?.granted_units) === 1 && Number(row?.consumed_units) === 0, JSON.stringify(row));
    const seriesRow = await arow('SELECT series_type FROM course_series WHERE id=?', [normalId]);
    check('⑩ 普通课包类型默认 NORMAL', seriesRow?.series_type === 'NORMAL', JSON.stringify(seriesRow));
  }

  console.log(JSON.stringify({ name: 'experience-course-package', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
