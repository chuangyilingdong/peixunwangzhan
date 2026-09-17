/**
P111 课堂四个页面「真浏览器走一遍」守卫（2026-09-17）
 *
 * 为什么需要它：按线框图把课堂拆成四个独立路由（列表 / 创建 / 详情 / 添加学生）之后，
 * 「渲染不报错」离「页面能用」还很远。p70 只能证明页面不白屏，证明不了：
 *   · 线框图里那些小标题（保存后的影响 / 确认开始后的状态变化 …）到底画没画出来；
 *   · 「当前账号已有 N 个课堂，不能创建新的」这句提示是**按真实占用算的**，还是写死的文案；
 *   · 九列的表在真实宽度下会不会把「操作」列挤出可视区；
 *   · 二次确认弹窗里的 ✓ 是不是真来自服务端预检。
 * 这几类问题这一轮全都真的发生过（都是被这个脚本当场抓出来的），所以留成守卫。
 *
 * 做法：临时库 init + seed + 造几种状态的课堂 → 真起 apps/server → vite preview 出构建产物 →
 * 真 Chrome 登录（教师视角，线框图就是教师端）→ 逐页断言「页面上真有那句话」并截图。
 * 截图落在 .tmp/classroom-ui/，人再扫一眼最稳。
 *
 * ⚠️ 依赖 Chrome（与 scripts/verify-production-entrypoints.mjs 同一套口径，可用 CHROME_PATH 覆盖）；
 * ⚠️ vite preview 只绑 ::1，探测与访问都要用 localhost 而不是 127.0.0.1。
 * 跑法：node scripts/p111-classroom-ui-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const root = process.cwd();
const shotDir = path.join(root, '.tmp', 'classroom-ui');
fs.rmSync(shotDir, { recursive: true, force: true });
fs.mkdirSync(shotDir, { recursive: true });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-ui-'));
const dbPath = path.join(temp, 'platform.db');
const env = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'), DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  child.on('close', (code) => (code ? reject(new Error(output)) : resolve(output)));
});
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const db = new DatabaseSync(dbPath);
const lesson = db.prepare("SELECT id, series_id FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1").get();
const teacher = db.prepare("SELECT id, org_id FROM users WHERE login='teacher-1'").get();
const seeded = db.prepare("SELECT id, login, display_name, password_hash FROM users WHERE role='STUDENT' AND org_id=? AND deleted_at IS NULL LIMIT 2").all(teacher.org_id);
assert.equal(seeded.length, 2, 'fixture: seed 应带 2 名学生');
// 种子里每机构只有 2 名学生，候选池太少看不出「可加 / 不可加」的分别 —— 直接补几个。
// 复用已有学生的 password_hash（这些账号只当候选，不登录）。
const extraNames = ['周可欣', '赵天宇', '林子涵', '孙雨桐', '陈语桐'];
const extra = extraNames.map((name, index) => {
  const row = { id: `ui-student-${index + 1}`, login: `ui${index + 10}` };
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users(id,org_id,login,display_name,role,password_hash,status,created_at,updated_at)
    VALUES(?,?,?,?,'STUDENT',?,'ACTIVE',?,?)`).run(row.id, teacher.org_id, row.login, name, seeded[0].password_hash, now, now);
  return row;
});
const students = [...seeded.map((s) => ({ id: s.id, name: s.display_name })), ...extra.map((s, i) => ({ id: s.id, name: extraNames[i] }))];
// 只给前 5 人许可：其余 2 人保持「没有这个课包的许可」→ 判定说明里的 C 类有真实人数
const grantedIds = students.slice(0, 5).map((s) => s.id);
// 进课堂的只有前 3 人 —— 留出 2 个「有许可但没在这堂课」的学生，
// 否则「可添加学生」是空的，那张表根本渲染不出来（夹具踩过这个坑）
const rosterIds = grantedIds.slice(0, 3);
for (const studentId of grantedIds) {
  const exists = db.prepare('SELECT id FROM student_course_grants WHERE org_id=? AND series_id=? AND student_id=?').get(teacher.org_id, lesson.series_id, studentId);
  if (!exists) db.prepare("INSERT INTO student_course_grants(id,org_id,student_id,series_id,granted_at) VALUES(?,?,?,?,?)")
    .run(`grant-ui-${studentId}`, teacher.org_id, studentId, lesson.series_id, new Date().toISOString());
}
db.close();

const apiPort = 18787;
const webPort = 6175;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(apiPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
let web = null;
const api = async (pathname, init = {}) => {
  const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const body = await response.json();
  return { status: response.status, data: body.data ?? body, error: body.error };
};

const problems = [];
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'teacher-1', password: 'teach123' } });
  const token = login.data.token;
  assert.ok(token, 'teacher login failed');

  // 造几种状态的课堂：已结束 / 已解散 / 待上课（待上课那条留到最后当主角）
  const create = async (title) => (await api('/api/org/sessions', { method: 'POST', token, body: { lessonId: lesson.id, title } })).data;
  const a = await create('已结束的课堂 · 故事绘本');
  await api(`/api/org/sessions/${a.id}/students`, { method: 'POST', token, body: { studentIds: students.slice(0, 2).map((s) => s.id) } });
  await api(`/api/org/sessions/${a.id}/start`, { method: 'POST', token, body: {} });
  await api(`/api/org/sessions/${a.id}/end`, { method: 'POST', token, body: {} });
  const b = await create('已解散的课堂 · 太空探索');
  await api(`/api/org/sessions/${b.id}/students`, { method: 'POST', token, body: { studentIds: students.slice(0, 1).map((s) => s.id) } });
  await api(`/api/org/sessions/${b.id}/dissolve`, { method: 'POST', token, body: {} });
  const c = await create('未来城市设计');
  await api(`/api/org/sessions/${c.id}/students`, { method: 'POST', token, body: { studentIds: rosterIds } });
  console.log('fixture ready:', { ended: a.id, dissolved: b.id, pending: c.id, selectable: grantedIds.length, noGrant: students.length - grantedIds.length });

  web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', 'apps/org', '--config', 'apps/org/vite.config.mjs'], {
    cwd: root, env: { ...env, VITE_DEV_API_TARGET: `http://127.0.0.1:${apiPort}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let webLog = '';
  web.stdout.on('data', (c) => { webLog += c; });
  web.stderr.on('data', (c) => { webLog += c; });
  // ⚠️ vite preview 只绑 ::1（localhost），不绑 127.0.0.1 —— 用 127.0.0.1 会 ERR_CONNECTION_REFUSED
  const base = `http://localhost:${webPort}/org`;
  let webUp = false;
  for (let i = 0; i < 120; i += 1) { try { if ((await fetch(`${base}/`)).ok) { webUp = true; break; } } catch {} await new Promise((r) => setTimeout(r, 250)); }
  if (!webUp) throw new Error(`vite preview 没起来（${base}）：\n${webLog.slice(-1500)}`);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 300)));
  // 资源 404 由下面的 response 监听精确记录（带 URL）；这里只收 JS 异常与其它 console 报错，
  // 否则「Failed to load resource」这种不带地址的一句会把上面那条已知字体 404 也混进来。
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource/.test(message.text())) return;
    pageErrors.push(`console: ${message.text().slice(0, 200)}`);
  });
  // 记下到底是哪个地址 404 —— 光有一句「Failed to load resource」定位不到东西
  const badRequests = [];
  page.on('response', (response) => { if (response.status() >= 400) badRequests.push(`${response.status()} ${response.url()}`); });

  const expectText = async (label, texts) => {
    const body = await page.locator('body').innerText();
    for (const text of texts) {
      if (!body.includes(text)) problems.push(`${label}：页面上找不到「${text}」`);
    }
  };
  const shot = async (name) => { await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); };
  const settle = async () => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(350); };

  // 登录（线框图是教师视角）
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await settle();
  await page.getByRole('button', { name: /授课教师/ }).click();
  await page.getByRole('button', { name: /进入工作台/ }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 20000 }).catch(() => {});
  await settle();

  // ── 后台字体：必须与画布课堂同一套（--cv-font = 'Geist', 'Noto Sans SC', …）
  // 「不再 404」还不够 —— 要确认 Geist 真的加载了、body 用的就是那套栈，
  // 否则字体文件放在那儿没被引用，页面照样静默回退系统字体。
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  const fontState = await page.evaluate(() => ({
    family: getComputedStyle(document.body).fontFamily,
    geistLoaded: document.fonts ? document.fonts.check('16px Geist') : null,
  }));
  if (!/Geist/.test(fontState.family)) problems.push(`字体：机构端 body 用的不是画布那套栈（实际 '${fontState.family}'）`);
  if (fontState.geistLoaded === false) problems.push('字体：Geist 没有真正加载（@font-face 未生效，会静默回退系统字体）');
  console.log(`✓ 后台字体：${fontState.family.slice(0, 60)}${fontState.family.length > 60 ? '…' : ''} · Geist 已加载=${fontState.geistLoaded}`);

  // ── 005-01 列表
  await page.goto(`${base}/classrooms`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('列表页', ['我的课堂列表', '待上课', '上课中', '已结束', '已解散', '课堂名称', '课包', '课程', '学生数', '创建时间', '实际开始', '实际结束', '状态与时间规则', '查询', '重置', '未来城市设计']);
  await expectText('列表页', ['共 3 条课堂记录', '个「待上课 / 上课中」课堂']);
  // 已解散那一行的「实际结束」列必须标明它是解散时刻（不能与「已解散不产生结束时间」的规则文案打架）
  await expectText('列表页', ['解散时间', '已解散的课堂不会记录实际开始时间']);
  await shot('01-list');

  // ── 005-02 创建课堂（被占用时按钮该是灰的，且顶部给红/橙提示）
  await page.goto(`${base}/classrooms/new`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('创建页', ['创建课堂', '父级：', '课堂基础信息', '课堂名称', '课包', '课程', '本页不包含', '所选课程摘要', '创建规则', '保存后的业务链', '添加学生', '满足条件后开始上课']);
  // 此刻账号上还有一个待上课课堂 → 必须是橙色「不能创建」，不能是一句写死的绿话
  await expectText('创建页（有占用时）', ['当前账号已有 1 个「待上课 / 上课中」课堂', '因此不能创建新的课堂']);
  if (!(await page.getByRole('button', { name: '保存课堂' }).isDisabled())) problems.push('创建页：有占用时「保存课堂」应该禁用');
  await shot('02-create-blocked');

  // ── 005-03 详情（待上课）
  await page.goto(`${base}/classrooms/${c.id}`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('详情页', ['课堂详情', '待上课', '课堂信息', '课堂操作', '编辑课堂名称', '查看课程资料', '开始上课', '解散课堂', '学生名单', '序号', '登录账号', '加入课堂时间', '添加学生', '阶段可操作', '页面边界']);
  await shot('03-detail-pending');

  // ── 005-03D 开始上课确认（校验清单必须来自服务端预检）
  await page.getByRole('button', { name: '开始上课' }).first().click();
  await page.waitForTimeout(700);
  await expectText('开始确认', ['开始上课确认', '开始前资格校验', '课堂状态 = 待上课', '教师账号可正常教学', '课包 / 课程当前可用', '课堂至少有 1 名学生', '3 名学生资格仍有效', '全部通过', '确认开始后的状态变化', '进入「上课中」后']);
  await shot('04-modal-start');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── 005-03A 编辑课堂名称
  await page.getByRole('button', { name: '编辑课堂名称' }).first().click();
  await page.waitForTimeout(500);
  await expectText('改名弹窗', ['编辑课堂名称', '当前课堂', '学生数', '保存后的影响', '保持不变', '仅更新课堂名称显示', '页面边界', '保存名称']);
  await shot('05-modal-rename');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── 005-03C 移除学生确认
  await page.getByRole('button', { name: '移除' }).first().click();
  await page.waitForTimeout(500);
  await expectText('移除弹窗', ['移除学生确认', '即将移除学生', '登录账号', '确认移除后的影响', '当前课堂关系', '课包授权', '作品 / 算力消耗', '课程状态回溯规则', '确认移除']);
  await shot('06-modal-remove');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── 005-03E 解散课堂确认
  await page.getByRole('button', { name: '解散课堂' }).first().click();
  await page.waitForTimeout(700);
  await expectText('解散弹窗', ['解散课堂确认', '解散前校验', '尚未记录实际开始时间', '课堂由当前教师账号创建', '允许解散', '确认解散后的状态变化', '不会发生的事情', '不创建补课课堂', '确认解散']);
  await shot('07-modal-dissolve');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── 005-04 添加学生
  await page.goto(`${base}/classrooms/${c.id}/students/new`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('添加学生页', ['添加学生', '候选池的前提条件', '添加规则', '原因优先级', '可添加学生', '不可添加学生', '当前课包授权', '当前课堂占用', '加入后课程状态', '不可添加判定说明', '已完成当前课堂对应课程', '不进入候选池']);
  await shot('08-add-students');
  // 「不可添加」默认不铺开，搜索之后才列人（2026-09-16 口径）
  await page.getByRole('button', { name: /不可添加学生/ }).click();
  await page.waitForTimeout(300);
  await expectText('不可添加页', ['本机构共有', '不列出姓名', '搜姓名或登录账号']);
  await shot('09-add-students-blocked-tab');

  // ── 改名（只有待上课能改）：改完列表要跟着变
  const renamed = await api(`/api/org/sessions/${c.id}`, { method: 'PUT', token, body: { title: '未来城市设计（已改名）' } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed));
  await page.goto(`${base}/classrooms`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('改名后的列表', ['未来城市设计（已改名）']);
  await shot('10-list-after-rename');

  // ── 真开课：详情应切到「上课中」，结束课堂入口出现
  const started = await api(`/api/org/sessions/${c.id}/start`, { method: 'POST', token, body: {} });
  assert.equal(started.status, 200, JSON.stringify(started));
  await page.goto(`${base}/classrooms/${c.id}`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('上课中详情', ['上课中', '结束课堂', '课堂进行中']);
  await shot('11-detail-active');

  // ── 结束课堂确认（线框图没覆盖这一步，但不能因为没画线框图就没人走过）
  await page.getByRole('button', { name: '结束课堂' }).first().click();
  await page.waitForTimeout(500);
  await expectText('结束弹窗', ['确认结束课堂', '确认结束']);
  await shot('12-modal-end');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── 把课堂结束掉、占用解除 → 创建页应该翻成绿色「可以创建」，按钮不再禁用
  const ended = await api(`/api/org/sessions/${c.id}/end`, { method: 'POST', token, body: {} });
  assert.equal(ended.status, 200, JSON.stringify(ended));
  await page.goto(`${base}/classrooms/new`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('创建页（无占用时）', ['当前账号无「待上课 / 上课中」课堂，可以创建新的课堂']);
  await shot('13-create-allowed');

  if (pageErrors.length) problems.push(`浏览器报错：${pageErrors.slice(0, 5).join(' | ')}`);
  // 任何 4xx/5xx 都算问题，**不留豁免**：这条曾经放着 /fonts/Geist-*.woff2 的一条例外
  // （机构端没打包字体，一直 404 回退系统字体）。2026-09-17 字体已补进 apps/org/public/fonts，
  // 所以把豁免撤掉 —— 留着它以后字体真回归了会被静默吞掉。
  const failures = [...new Set(badRequests)];
  if (failures.length) problems.push(`请求失败：${failures.slice(0, 6).join(' | ')}`);
  assert.ok(fs.readdirSync(shotDir).length >= 13, '截图没出全');
  await browser.close();
  console.log(`\n截图 ${fs.readdirSync(shotDir).length} 张 → ${shotDir}`);
  if (problems.length) { console.error('\n发现问题：'); for (const item of problems) console.error('  ✗ ' + item); process.exitCode = 1; }
  else console.log('UI CHECK PASSED');
} catch (error) {
  console.error(serverLog.slice(-2500));
  throw error;
} finally {
  if (web) web.kill('SIGTERM');
  server.kill('SIGTERM');
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
}
