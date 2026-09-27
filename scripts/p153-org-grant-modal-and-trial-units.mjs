/**
 * P153 机构端：体验课包「授权次数」要看得见 + 「添加课包」改成弹窗（2026-09-26 用户口径四条）。
 *
 * 用户口径（逐条钉住，别按自己的理解改）：
 *   ① 「机构后台学生被体验课包授权次数是没有展示的……应该要看到他这个账号体验课包的授权次数」；
 *   ② 「机构端 / 老师端要显示机构名字」（截图里只有「授课教师」那个角色胶囊）；
 *   ③ 「学生添加课包，不是跳转而是弹窗：为谁添加、添加什么课包；体验课包要填次数，正常课包就确认」；
 *   ④ 「批量导入这块直接删除」。
 *
 * 这张网分两半：
 *   · **真请求那半**（起真服务、发真请求）：体验课包给同一个学生授权 5 次（3 + 2，可重复分配），
 *     学生授权中心必须把这 5 次读出来；普通课包不串这两格；series-overview 必须给出课包类型
 *     （弹窗靠它决定要不要填次数）。
 *   · **静态契约那半**（读源码，与 p140 ④″ 同一套写法）：弹窗的形状、次数只对体验课包出现、
 *     页签里不再有「添加课包」、机构名接进外壳、批量导入面板没了。
 *
 * ⚠️ 为什么次数必须从服务端账上读：体验课包的次数记在**同一行**许可上（`granted_units` 累加），
 *    按许可行数数会把它算成 1 —— 那正是用户看到「没有展示」的那件事。这条口径的最强守护其实是
 *    `p140`（按次授权/核销的真账），本脚本管的是**机构端看不看得见**与**弹窗的形状**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p153-org-grant-'));
const dbPath = path.join(temp, 'platform.db');
// 硬设（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略。
process.env.PLATFORM_DB_PATH = dbPath;
// 夹具走数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import。
const { arow } = await import('../packages/database/src/store.js');

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
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

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

const port = 19083;
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

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data?.token;
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data?.token;
  assert.ok(admin && orgAdmin, '登录失败');

  const purchase = (suffix, quantity) => ({ amountMinor: quantity * 10000, currency: 'CNY', paymentStatus: 'PAID', orderNo: `P153-O-${suffix}`, contractNo: 'P153-C', idempotencyKey: `p153-${suffix}` });
  const lessonBody = (title) => ({ title, status: 'PUBLISHED', deliveryModes: ['CANVAS'], capabilities: ['text', 'image'] });
  async function makeSeries(title, seriesType) {
    const created = await api('/api/admin/course-series', {
      method: 'POST', token: admin,
      body: { title, description: `${title} 简介`, coverImageUrl: 'https://example.com/p153.png', priceFen: 0, stockTotal: 10, seriesType, lessons: [lessonBody('第 1 节')] },
    });
    const id = created.data?.id || '';
    await api(`/api/admin/course-series/${id}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
    return { id, created };
  }
  const grantTo = (seriesId, units, source = 'STUDENT_CENTER') => api('/api/org/course-grants', {
    method: 'POST', token: orgAdmin, body: { seriesId, studentIds: [seeded.studentId], units, source },
  });

  let experienceId = '';
  let normalId = '';

  /* ① 准备：一个体验课包 + 一个普通课包，平台各给本机构 6 / 3 次 */
  {
    const exp = await makeSeries('P153 体验课包', 'EXPERIENCE');
    experienceId = exp.id;
    const normal = await makeSeries('P153 普通课包', 'NORMAL');
    normalId = normal.id;
    check('① 体验课包建出来且类型落库', exp.created.status === 200 && exp.created.data?.seriesType === 'EXPERIENCE',
      `HTTP ${exp.created.status} ${JSON.stringify(exp.created.error || exp.created.data).slice(0, 200)}`);
    const a1 = await api(`/api/admin/course-series/${experienceId}/assignments`, { method: 'POST', token: admin, body: { orgId: seeded.orgId, quotaTotal: 6, ...purchase('exp', 6) } });
    const a2 = await api(`/api/admin/course-series/${normalId}/assignments`, { method: 'POST', token: admin, body: { orgId: seeded.orgId, quotaTotal: 3, ...purchase('normal', 3) } });
    check('① 平台给机构授权：体验包 6 次 / 普通包 3 次', a1.data?.quotaTotal === 6 && a2.data?.quotaTotal === 3,
      `exp=${a1.status}/${a1.data?.quotaTotal} normal=${a2.status}/${a2.data?.quotaTotal}`);
  }

  /* ② 真请求：体验课包给**同一个学生**授权 3 次，再 2 次（可重复分配、次数累加） */
  {
    const first = await grantTo(experienceId, 3);
    check('② 一次授权 3 次（弹窗里填的那个数）', first.status === 200 && Number(first.data?.usedUnits) === 3,
      `HTTP ${first.status} ${JSON.stringify(first.error || first.data).slice(0, 220)}`);
    const row = await arow('SELECT granted_units, consumed_units FROM student_course_grants WHERE org_id=? AND student_id=? AND series_id=?',
      [seeded.orgId, seeded.studentId, experienceId]);
    check('② 次数记在**同一行**上（granted_units=3，不是 3 行 × 1）', Number(row?.granted_units) === 3, JSON.stringify(row));
    const again = await grantTo(experienceId, 2);
    check('② 同一个体验课包可以再分给同一个学生（次数累加到 5）',
      again.status === 200 && Number(again.data?.usedUnits) === 2,
      `HTTP ${again.status} ${JSON.stringify(again.error || again.data).slice(0, 200)}`);
  }

  /* ③ ⭐ 用户要的那一格：学生授权中心必须给出「这个账号的体验课包授权次数」 */
  {
    const list = await api('/api/org/student-grants-summary?page=1&limit=50', { token: orgAdmin });
    const mine = (list.data?.items || []).find((item) => item.studentId === seeded.studentId);
    check('③ 列表带出 experienceGrantedUnits = 5（授权次数）', Number(mine?.experienceGrantedUnits) === 5,
      `实际 ${mine?.experienceGrantedUnits}；item=${JSON.stringify(mine || {}).slice(0, 200)}`);
    check('③ 还剩几次也算得出来（5 授权 - 0 已核销 = 剩 5）',
      Number(mine?.experienceRemainingUnits) === 5 && Number(mine?.experienceConsumedUnits) === 0,
      `剩 ${mine?.experienceRemainingUnits} / 已核销 ${mine?.experienceConsumedUnits}`);
    check('③ 课包明细里带类型与次数（前端那一列靠它显示 ×N）',
      (mine?.grantedSeries || []).some((row) => row.seriesId === experienceId && row.seriesType === 'EXPERIENCE' && Number(row.grantedUnits) === 5),
      JSON.stringify(mine?.grantedSeries || []).slice(0, 240));
  }

  /* ④ 普通课包不串账：授一次之后，体验包那两格还是 5 / 5 */
  {
    const granted = await grantTo(normalId, 1);
    check('④ 普通课包授权成功', granted.status === 200, `HTTP ${granted.status} ${JSON.stringify(granted.error || {}).slice(0, 160)}`);
    const list = await api('/api/org/student-grants-summary?page=1&limit=50', { token: orgAdmin });
    const mine = (list.data?.items || []).find((item) => item.studentId === seeded.studentId);
    check('④ 普通课包不动体验包那两格（仍 5 / 5）',
      Number(mine?.experienceGrantedUnits) === 5 && Number(mine?.experienceRemainingUnits) === 5,
      `授权 ${mine?.experienceGrantedUnits} / 剩 ${mine?.experienceRemainingUnits}`);
    const normalRow = (mine?.grantedSeries || []).find((row) => row.seriesId === normalId);
    check('④ 普通课包在明细里是 NORMAL 且 grantedUnits=1（前端不显示 ×N）',
      normalRow?.seriesType === 'NORMAL' && Number(normalRow?.grantedUnits) === 1, JSON.stringify(normalRow || {}));
  }

  /* ⑤ 弹窗靠这个字段决定「要不要填次数」：series-overview 必须给出课包类型 */
  {
    const overview = await api('/api/org/series-overview?days=30', { token: orgAdmin });
    const exp = (overview.data?.items || []).find((item) => item.seriesId === experienceId);
    const normal = (overview.data?.items || []).find((item) => item.seriesId === normalId);
    check('⑤ 库存接口带 seriesType（体验包 EXPERIENCE / 普通包 NORMAL）',
      exp?.seriesType === 'EXPERIENCE' && normal?.seriesType === 'NORMAL', `exp=${exp?.seriesType} normal=${normal?.seriesType}`);
    // 体验包 6 次已分掉 5 → 剩 1（弹窗里次数输入的上限就是它）
    check('⑤ 剩余人次也带出来了（次数输入的上限）', Number(exp?.remaining) === 1, `实际 remaining=${exp?.remaining}`);
  }
} catch (error) {
  failures += 1;
  console.error(serverLog.slice(-2000));
  console.error('真请求段异常：', error.message);
} finally {
  server.kill('SIGKILL');
}

/* ⑥ 静态契约：弹窗的形状 + 机构名 + 页签 + 批量导入（前端源码，读文件不读 dist） */
{
  const page = read('apps/org/src/pages/SeriesOverview.jsx');
  const main = read('apps/org/src/main.jsx');
  const shell = read('packages/shared/src/ui.jsx');
  const styles = read('packages/shared/src/styles.css');
  const orgRoute = read('apps/server/src/routes/orgAdmin.js');

  check('⑥ 「添加课包」是**弹窗**（AddGrantModal + 共享 Modal 外壳），不再是页签/跳转页',
    /function AddGrantModal\(/.test(page)
    && /import \{ Modal \} from '\.\/classroom\/ui\.jsx';/.test(page)
    && /<Modal title="添加课包"/.test(page));
  check('⑥ 页签只剩四个只读视角（「为学生添加课包」不再占页签）',
    /\[\['overview', '课包库存'\], \['students', '学生授权中心'\], \['records', '学生授权记录'\], \['batches', '采购与开通记录'\]\]/.test(page)
    && !/\['grant', '为学生添加课包'\]/.test(page));
  check('⑥ 为谁添加 + 添加什么课包 + 确认（弹窗三步都在）',
    /① 为谁添加/.test(page) && /② 添加什么课包/.test(page) && /③ 确认/.test(page));
  check('⑥ 次数输入是体验课包专属：普通课包固定 1 次（服务端对 units>1 会 400）',
    /const isExperience = picked\?\.seriesType === 'EXPERIENCE';/.test(page)
    && /const useNow = isExperience \? units : 1;/.test(page)
    && /isExperience \? <div className="row-actions">[\s\S]{0,700}units-input/.test(page));
  check('⑥ 次数上限 = 该课包剩余人次（服务端在事务里还会再算一次）',
    /const maxUnits = picked \? Math\.max\(1, Number\(picked\.remaining \|\| 1\)\) : 1;/.test(page));
  check('⑥ 提交带 units 与受限枚举 source；弹窗用的两个来源都在服务端白名单里',
    /units: useNow, source \}\);/.test(page)
    && /source="STUDENT_CENTER"/.test(page) && /source="STUDENT_DETAIL"/.test(page)
    && /STUDENT_CENTER: '学生授权中心'/.test(orgRoute) && /STUDENT_DETAIL: '学生授权详情'/.test(orgRoute));
  check('⑥ 学生授权中心有「体验课包授权次数」列（含 已核销 / 剩 的拆分）',
    /体验课包授权次数/.test(page) && /experienceGrantedUnits/.test(page) && /experienceRemainingUnits/.test(page));
  check('⑥ 机构名接进外壳并会渲染（orgName → .org-name），样式在共享样式表里',
    /<AppShell product="灵动ai学院" orgName=\{session\.organization\?\.name/.test(main)
    && /orgName = ''/.test(shell) && /className="org-name"/.test(shell) && /\.org-name\{/.test(styles));
  check('⑥ 成员页的「批量导入」面板已删（含它的状态与两个函数）',
    !/预览导入/.test(main) && !/parseImport/.test(main) && !/api\.post\('org\/users\/import\//.test(main));
  check('⑥ 服务端的两个导入接口**没被顺手删掉**（p4-o14 还在按真接口验账号唯一性/席位/回滚）',
    orgRoute.includes('importMatch') && orgRoute.includes('(preview|commit)'));
  check('⑥ 老记录的来源标签不许删（ADD_GRANT_DRAWER 是历史授权记录在用的）',
    /ADD_GRANT_DRAWER: '学生授权详情（添加课包）'/.test(orgRoute));
}

if (failures) {
  console.error(JSON.stringify({ name: 'p153-org-grant-modal-and-trial-units', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p153-org-grant-modal-and-trial-units', pass: true }, null, 1));
