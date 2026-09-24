/**
 * P86 机构与课包「授权次数」链路守卫（2026-09-18，P03 按线框图对齐的服务端）。
 *
 * 覆盖（对应线框图 P03-01 ~ P03-04 的服务端部分）：
 *   ① 机构三列：简称 / 机构编码（ORG + 4 位序号，创建时生成、唯一、不可改）/ 所属区域 + 存量回填
 *   ② 禁用机构必须填原因（空/纯空格 400，上限 500），原因落审计；其它状态动作不强制
 *   ③ 平台侧「调整某机构某课包的授权次数」：+N / −N 都改总授权次数（quota_total），
 *      调整后**不得低于已授权次数**（409，且把当前已授权次数说清）、不得为负
 *   ④ 授权次数变更流水 course_quota_changes 的五个写入点与前后值算得对
 *      （INITIAL_OPEN / ADD / REDUCE / GRANT_CONSUME / GRANT_REFUND）
 *   ⑤ 流水列表接口：按课包 / 类型 / 时间范围筛 + 分页 + 课包名与操作人
 *
 * 用词口径（用户 2026-09-18）：平台侧只有「授权次数」（总/已授权/剩余）这一个说法。
 * 这张流水是**授权次数（库存账）**，不是财务账（license_purchase_batches / license_revenue_events）。
 *
 * 用临时 SQLite，不读取或修改默认 / 生产数据库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-course-quota-ledger-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
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

const { DatabaseSync } = await import('node:sqlite');
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import("../packages/database/src/store.js");

const sqlite = () => new DatabaseSync(dbPath);

// ① 存量回填：直接 INSERT 一家「没有机构编码」的老机构，服务启动（= 重新执行 schema.js 的补号语句）后应有编码
{
  
  await aq("INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,base_teacher_seats,purchased_teacher_seats,created_at,updated_at) VALUES ('org-legacy-p86','P86 存量机构','ACTIVE','2020-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z',0,3,0,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')");
  const before = await arow("SELECT org_code FROM organizations WHERE id='org-legacy-p86'");
  check('① 存量机构回填前没有编码', before.org_code == null, JSON.stringify(before));
  
}

const port = 18986;
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
  assert.ok(admin, '平台 root 登录失败');

  // ── ① 机构三列 + 编码生成 + 存量回填 ────────────────────────────────────────
  {
    
    const legacy = await arow("SELECT org_code FROM organizations WHERE id='org-legacy-p86'");
    check('① 存量机构回填后拿到 ORG 编码', /^ORG\d{4,}$/.test(String(legacy?.org_code || '')), JSON.stringify(legacy));
    check('① 已回填的编码不重复', Number((await arow("SELECT COUNT(*) n FROM (SELECT org_code FROM organizations WHERE org_code IS NOT NULL GROUP BY org_code HAVING COUNT(*) > 1)")).n) === 0);
    
  }
  const createdA = await api('/api/admin/organizations', { method: 'POST', token: admin, body: { name: 'P86 甲机构', shortName: '甲校', region: '北京市·海淀区', adminLogin: 'p86-admin-a', adminPassword: 'secret123', studentSeats: 5 } });
  check('① 建机构返回机构简称/编码/区域', createdA.status === 200 && createdA.data.shortName === '甲校' && createdA.data.region === '北京市·海淀区' && /^ORG\d{4,}$/.test(String(createdA.data.orgCode || '')), JSON.stringify(createdA.data).slice(0, 220));
  const createdB = await api('/api/admin/organizations', { method: 'POST', token: admin, body: { name: 'P86 乙机构', adminLogin: 'p86-admin-b', adminPassword: 'secret123', studentSeats: 5 } });
  const seqA = Number(String(createdA.data.orgCode).replace('ORG', ''));
  const seqB = Number(String(createdB.data.orgCode).replace('ORG', ''));
  check('① 第二家机构编码递增（ORG 序号 +1）', seqB === seqA + 1, `${createdA.data.orgCode} → ${createdB.data.orgCode}`);
  const listed = await api(`/api/admin/organizations?search=${encodeURIComponent('P86 甲机构')}`, { token: admin });
  check('① 列表回显三列', (listed.data.items || []).some((item) => item.orgCode === createdA.data.orgCode && item.shortName === '甲校' && item.region === '北京市·海淀区'), JSON.stringify(listed.data.items || []).slice(0, 200));
  const edited = await api(`/api/admin/organizations/${createdA.data.id}`, { method: 'PUT', token: admin, body: { shortName: '甲校（改）', region: '上海市·徐汇区' } });
  check('① 编辑机构简称/区域生效且编码不变', edited.data.shortName === '甲校（改）' && edited.data.region === '上海市·徐汇区' && edited.data.orgCode === createdA.data.orgCode, JSON.stringify(edited.data).slice(0, 200));
  const codeChange = await api(`/api/admin/organizations/${createdA.data.id}`, { method: 'PUT', token: admin, body: { orgCode: 'ORG9999' } });
  check('① 机构编码不许改（400 ORG_CODE_IMMUTABLE）', codeChange.status === 400 && codeChange.error?.code === 'ORG_CODE_IMMUTABLE', `${codeChange.status} ${codeChange.error?.code}`);
  // 还原简称，后面的流水/列表用例读起来清楚
  await api(`/api/admin/organizations/${createdA.data.id}`, { method: 'PUT', token: admin, body: { shortName: '甲校', region: '北京市·海淀区' } });

  // ── ② 禁用必须填原因 ───────────────────────────────────────────────────────
  {
    const missing = await api(`/api/admin/organizations/${createdA.data.id}/status`, { method: 'POST', token: admin, body: { action: 'disable' } });
    check('② 禁用不带原因 → 400', missing.status === 400 && missing.error?.code === 'ORG_DISABLE_REASON_REQUIRED', `${missing.status} ${missing.error?.code}`);
    const blank = await api(`/api/admin/organizations/${createdA.data.id}/status`, { method: 'POST', token: admin, body: { action: 'disable', reason: '   ' } });
    check('② 禁用原因纯空格 → 400', blank.status === 400 && blank.error?.code === 'ORG_DISABLE_REASON_REQUIRED', `${blank.status} ${blank.error?.code}`);
    const tooLong = await api(`/api/admin/organizations/${createdA.data.id}/status`, { method: 'POST', token: admin, body: { action: 'disable', reason: 'x'.repeat(501) } });
    check('② 禁用原因超 500 → 400', tooLong.status === 400 && tooLong.error?.code === 'ORG_DISABLE_REASON_TOO_LONG', `${tooLong.status} ${tooLong.error?.code}`);
    const disabled = await api(`/api/admin/organizations/${createdA.data.id}/status`, { method: 'POST', token: admin, body: { action: 'disable', reason: '合同欠费，暂停服务' } });
    check('② 禁用带原因成功且状态 = DISABLED', disabled.status === 200 && disabled.data.status === 'DISABLED', JSON.stringify(disabled.data).slice(0, 160));
    
    const auditRow = await arow("SELECT before_data, after_data FROM audit_logs WHERE action='ORG_DISABLE' ORDER BY created_at DESC LIMIT 1");
    
    check('② 禁用原因落审计（ORG_DISABLE.after.reason）', JSON.parse(auditRow?.after_data || '{}').reason === '合同欠费，暂停服务', JSON.stringify(auditRow?.after_data));
    const recovered = await api(`/api/admin/organizations/${createdA.data.id}/status`, { method: 'POST', token: admin, body: { action: 'recover' } });
    check('② 恢复不强制原因（200）', recovered.status === 200 && recovered.data.status === 'ACTIVE', `${recovered.status} ${JSON.stringify(recovered.data).slice(0, 120)}`);
  }

  // ── 夹具：平台课包（库存 20 次）+ 发布 ──────────────────────────────────────
  const orgA = createdA.data.id;
  const createdSeries = await api('/api/admin/course-series', {
    method: 'POST', token: admin,
    body: { title: 'P86 授权次数课包', description: 'P86 守卫夹具', coverImageUrl: 'https://example.com/p86-cover.png', visibility: 'ALL_ORGS', stockTotal: 20, lessons: [{ title: '第1课', status: 'PUBLISHED', capabilities: ['text'], deliveryModes: ['CANVAS'] }] },
  });
  assert.equal(createdSeries.status, 200, `建课包失败: ${JSON.stringify(createdSeries.data).slice(0, 200)}`);
  const seriesId = createdSeries.data.id;
  const published = await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
  assert.equal(published.status, 200, `发布课包失败: ${JSON.stringify(published.error)}`);
  const purchase = (suffix, quantity) => ({ amountMinor: quantity * 10000, currency: 'CNY', paymentStatus: 'PAID', orderNo: `P86-O-${suffix}`, contractNo: 'P86-C-1', idempotencyKey: `p86-${suffix}` });
  const changes = (query = '') => api(`/api/admin/organizations/${orgA}/course-quota-changes${query}`, { token: admin });

  // ── ③ 开通课包 → INITIAL_OPEN ──────────────────────────────────────────────
  const assigned = await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgId: orgA, quotaTotal: 5, ...purchase('initial', 5) } });
  check('③ 平台给机构开通课包成功（总授权次数 5）', assigned.status === 200 && assigned.data.quotaTotal === 5, JSON.stringify(assigned.data).slice(0, 200));
  {
    const list = await changes(`?seriesId=${seriesId}`);
    const first = (list.data.items || [])[0] || {};
    check('③ 流水出现 INITIAL_OPEN 且前后值 0/0 → 5/0', first.changeType === 'INITIAL_OPEN' && first.quotaTotalBefore === 0 && first.quotaTotalAfter === 5 && first.quotaUsedBefore === 0 && first.quotaUsedAfter === 0 && first.delta === 5, JSON.stringify(first).slice(0, 260));
    check('③ 流水带上操作人（平台 root）与来源', first.actorLogin === 'root' && first.source === 'ADMIN_COURSE_SERIES_ASSIGN', JSON.stringify({ actorLogin: first.actorLogin, source: first.source }));
  }
  // 重复开通同一课包（配额没变）不写空流水
  await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgId: orgA } });
  {
    const list = await changes(`?seriesId=${seriesId}`);
    check('③ 重复开通（配额没变）不写空流水', Number(list.data.total) === 1, `total=${list.data.total}`);
  }

  // ── ④ 平台调整授权次数：+N / −N / 越界 ─────────────────────────────────────
  const adjust = (body) => api(`/api/admin/organizations/${orgA}/course-quotas/${seriesId}/adjust`, { method: 'POST', token: admin, body });
  const plus = await adjust({ delta: 3, reason: '机构追加采购，平台加 3 次' });
  check('④ 调整 +3 成功（总授权次数 5 → 8，剩余 8）', plus.status === 200 && plus.data.quotaTotal === 8 && plus.data.remaining === 8, JSON.stringify(plus.data).slice(0, 220));
  check('④ 调整 +3 落 ADD 流水（5/0 → 8/0，变更值 +3）', plus.data.change?.changeType === 'ADD' && plus.data.change?.quotaTotalBefore === 5 && plus.data.change?.quotaTotalAfter === 8 && plus.data.change?.delta === 3, JSON.stringify(plus.data.change).slice(0, 260));
  const minus = await adjust({ delta: -2, reason: '机构退订 2 次，平台收回' });
  check('④ 调整 −2 落 REDUCE 流水（8/0 → 6/0，变更值 −2）', minus.status === 200 && minus.data.change?.changeType === 'REDUCE' && minus.data.quotaTotal === 6 && minus.data.change?.delta === -2, JSON.stringify(minus.data).slice(0, 220));
  const zero = await adjust({ delta: 0, reason: '试试 0' });
  check('④ 调整值 0 → 400', zero.status === 400 && zero.error?.code === 'INVALID_QUOTA_DELTA', `${zero.status} ${zero.error?.code}`);
  const noReason = await adjust({ delta: 1 });
  check('④ 调整不带原因 → 400', noReason.status === 400 && noReason.error?.code === 'VALIDATION_ERROR', `${noReason.status} ${noReason.error?.code}`);
  const crossOrg = await api(`/api/admin/organizations/${createdB.data.id}/course-quotas/${seriesId}/adjust`, { method: 'POST', token: admin, body: { delta: 1, reason: '没开通就调' } });
  check('④ 未开通该课包的机构调整 → 404', crossOrg.status === 404 && crossOrg.error?.code === 'ASSIGNMENT_NOT_FOUND', `${crossOrg.status} ${crossOrg.error?.code}`);

  // ── ⑤ 机构把课包授权给学生 → GRANT_CONSUME ─────────────────────────────────
  const orgLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'p86-admin-a', password: 'secret123' } });
  const orgToken = orgLogin.data.token;
  assert.ok(orgToken, `机构管理员登录失败: ${JSON.stringify(orgLogin.error || orgLogin.data).slice(0, 160)}`);
  const student = await api('/api/org/users', { method: 'POST', token: orgToken, body: { role: 'STUDENT', login: 'p86-student-1', displayName: 'P86 学员一', password: 'secret123' } });
  assert.ok(student.data?.id, `建学员失败: ${JSON.stringify(student.data || student.error).slice(0, 160)}`);
  const granted = await api('/api/org/course-grants', { method: 'POST', token: orgToken, body: { seriesId, studentIds: [student.data.id] } });
  check('⑤ 机构授权给学生成功（已授权次数 0 → 1）', granted.status === 200 && granted.data.granted === 1 && granted.data.quotaUsed === 1, JSON.stringify(granted.data).slice(0, 200));
  const skipped = await api('/api/org/course-grants', { method: 'POST', token: orgToken, body: { seriesId, studentIds: [student.data.id] } });
  check('⑤ 重复授权同一学生被跳过（不重复扣次数）', skipped.data.granted === 0 && skipped.data.skipped === 1, JSON.stringify(skipped.data).slice(0, 160));
  {
    const list = await changes(`?seriesId=${seriesId}&changeType=GRANT_CONSUME`);
    const row = (list.data.items || [])[0] || {};
    check('⑤ 流水只有一笔 GRANT_CONSUME（6/0 → 6/1，变更值 −1）', list.data.total === 1 && row.changeType === 'GRANT_CONSUME' && row.quotaTotalBefore === 6 && row.quotaTotalAfter === 6 && row.quotaUsedBefore === 0 && row.quotaUsedAfter === 1 && row.delta === -1, JSON.stringify({ total: list.data.total, row }).slice(0, 300));
    check('⑤ 授权消耗的操作人是机构管理员、来源是机构端', row.actorLogin === 'p86-admin-a' && row.source === 'ORG_COURSE_GRANT', JSON.stringify({ actorLogin: row.actorLogin, source: row.source }));
  }

  // ── ④b 已授权次数是「调整后不得低于」的下界（409）────────────────────────────
  {
    const tooLow = await adjust({ delta: -6, reason: '想调到 0' });
    check('④ 调整后低于已授权次数 → 409 且带上当前已授权次数', tooLow.status === 409 && tooLow.error?.code === 'COURSE_QUOTA_BELOW_USED' && String(tooLow.error?.message || '').includes('1'), `${tooLow.status} ${tooLow.error?.code} ${tooLow.error?.message}`);
    const okFloor = await adjust({ delta: -5, reason: '调到刚好等于已授权次数' });
    check('④ 调到刚好等于已授权次数（6→1，剩余 0）允许', okFloor.status === 200 && okFloor.data.quotaTotal === 1 && okFloor.data.remaining === 0, JSON.stringify(okFloor.data).slice(0, 200));
    // 负数优先报「不能为负」（此时必然也低于已授权次数，两条都 409，先说更直白的那条）
    const negative = await adjust({ delta: -5, reason: '再减就成负数' });
    check('④ 调整后为负 → 409 COURSE_QUOTA_NEGATIVE', negative.status === 409 && negative.error?.code === 'COURSE_QUOTA_NEGATIVE', `${negative.status} ${negative.error?.code}`);
    // 还原到 6 次，方便后面撤销返还与筛选用例
    const restore = await adjust({ delta: 5, reason: '守卫还原，调回 6 次' });
    check('④ 调整 +5 还原到 6 次', restore.status === 200 && restore.data.quotaTotal === 6 && restore.data.quotaUsed === 1, JSON.stringify(restore.data).slice(0, 200));
  }

  // ── ⑥ 平台撤销学生授权 → GRANT_REFUND ──────────────────────────────────────
  const grantList = await api(`/api/org/course-grants?seriesId=${seriesId}`, { token: orgToken });
  const grantId = (grantList.data.items || [])[0]?.id;
  assert.ok(grantId, '机构授权记录缺失');
  const revoked = await api(`/api/admin/course-grants/${grantId}/revoke`, { method: 'POST', token: admin, body: { reason: '机构误授权，平台兜底撤销' } });
  check('⑥ 平台撤销成功且退回 1 次', revoked.status === 200 && revoked.data.quotaRefunded === true, JSON.stringify(revoked.data).slice(0, 160));
  {
    const list = await changes(`?seriesId=${seriesId}&changeType=GRANT_REFUND`);
    const row = (list.data.items || [])[0] || {};
    check('⑥ 流水出现 GRANT_REFUND（6/1 → 6/0，变更值 +1）', list.data.total === 1 && row.changeType === 'GRANT_REFUND' && row.quotaUsedBefore === 1 && row.quotaUsedAfter === 0 && row.delta === 1, JSON.stringify({ total: list.data.total, row }).slice(0, 300));
    check('⑥ 撤销原因写进流水', row.reason === '机构误授权，平台兜底撤销', String(row.reason));
  }
  // 撤销后重新授权（同一条 grant 复活）只记一笔 GRANT_CONSUME
  {
    const before = Number((await changes(`?seriesId=${seriesId}&changeType=GRANT_CONSUME`)).data.total);
    const regrant = await api('/api/org/course-grants', { method: 'POST', token: orgToken, body: { seriesId, studentIds: [student.data.id] } });
    const after = await changes(`?seriesId=${seriesId}&changeType=GRANT_CONSUME`);
    check('⑥ 重新授权只记一笔 GRANT_CONSUME（不重不漏）', regrant.data.granted === 1 && Number(after.data.total) === before + 1 && (after.data.items || [])[0]?.quotaUsedBefore === 0 && (after.data.items || [])[0]?.quotaUsedAfter === 1, JSON.stringify({ granted: regrant.data.granted, before, after: after.data.total }).slice(0, 200));
  }

  // ── ⑦ 流水列表：筛选 / 分页 / 课包名与操作人 ────────────────────────────────
  {
    const all = await changes('');
    check('⑦ 列表返回分页字段与五个变更类型', typeof all.data.total === 'number' && all.data.page === 1 && Number(all.data.limit) > 0 && Array.isArray(all.data.changeTypes) && all.data.changeTypes.length === 5, JSON.stringify({ total: all.data.total, page: all.data.page, limit: all.data.limit, changeTypes: all.data.changeTypes }));
    check('⑦ 每行带课包名与前后四值', all.data.items.every((item) => item.seriesTitle === 'P86 授权次数课包' && ['quotaTotalBefore', 'quotaTotalAfter', 'quotaUsedBefore', 'quotaUsedAfter'].every((key) => typeof item[key] === 'number')), JSON.stringify((all.data.items || [])[0] || {}).slice(0, 240));
    check('⑦ 按课包筛（seriesOptions 供下拉用）', (all.data.seriesOptions || []).some((item) => item.id === seriesId && item.changeCount > 0), JSON.stringify(all.data.seriesOptions || []).slice(0, 160));
    const byType = await changes('?changeType=REDUCE');
    check('⑦ 按变更类型筛 REDUCE', Number(byType.data.total) === 2 && byType.data.items.every((item) => item.changeType === 'REDUCE'), `total=${byType.data.total}`);
    const badType = await changes('?changeType=NOPE');
    check('⑦ 非法变更类型 → 400', badType.status === 400 && badType.error?.code === 'INVALID_CHANGE_TYPE', `${badType.status} ${badType.error?.code}`);
    const fromPast = new Date(Date.now() - 3600000).toISOString();
    const fromFuture = new Date(Date.now() + 3600000).toISOString();
    const inRange = await changes(`?from=${encodeURIComponent(fromPast)}&to=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`);
    check('⑦ 时间范围（最近一小时）能筛到全部流水', Number(inRange.data.total) >= 7, `total=${inRange.data.total}`);
    const future = await changes(`?from=${encodeURIComponent(fromFuture)}`);
    check('⑦ 时间范围（未来）筛不到任何流水', Number(future.data.total) === 0, `total=${future.data.total}`);
    const badFrom = await changes('?from=not-a-date');
    check('⑦ 非法时间 → 400', badFrom.status === 400 && badFrom.error?.code === 'INVALID_FROM', `${badFrom.status} ${badFrom.error?.code}`);
    const paged = await changes('?limit=2&page=2');
    check('⑦ 分页 limit=2 page=2 生效', paged.data.items.length === 2 && paged.data.page === 2 && paged.data.totalPages === Math.ceil(paged.data.total / 2), JSON.stringify({ items: paged.data.items.length, page: paged.data.page, totalPages: paged.data.totalPages }));
    const other = await changes(`?seriesId=${seriesId}&from=${encodeURIComponent(fromPast)}`);
    void other;
    const orgBCount = await api(`/api/admin/organizations/${createdB.data.id}/course-quota-changes`, { token: admin });
    check('⑦ 只返回本机构的流水', Number(orgBCount.data.total) === 0, `乙机构 total=${orgBCount.data.total}`);
  }

  // 存量与新增的编码都唯一（唯一索引兜底）
  {
    
    const dup = await arow("SELECT COUNT(*) n FROM (SELECT org_code FROM organizations WHERE org_code IS NOT NULL GROUP BY org_code HAVING COUNT(*) > 1)");
    const nulls = await arow("SELECT COUNT(*) n FROM organizations WHERE org_code IS NULL OR TRIM(org_code) = ''");
    
    check('① 全库机构编码唯一且无空值', Number(dup.n) === 0 && Number(nulls.n) === 0, JSON.stringify({ dup: dup.n, nulls: nulls.n }));
  }
} catch (error) {
  failures += 1;
  console.log(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\nP86 结果：${failures} 项失败\n` : '\nP86 结果：全部通过\n');
process.exit(failures ? 1 : 0);
