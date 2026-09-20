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
// 教学素材的「真文件」要落在服务端认的上传根下，预览才读得到（fileUploadSecurity.uploadRoot）
const uploadRoot = path.join(temp, 'uploads');
const env = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, FILE_UPLOAD_ROOT: uploadRoot, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'), DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  child.on('close', (code) => (code ? reject(new Error(output)) : resolve(output)));
});
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const db = new DatabaseSync(dbPath); db.exec('PRAGMA busy_timeout = 5000');
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
// 002-04 两条断言要用的值（2026-09-17 按线框图加的状态推导）：
//   · grantedSeriesTitle —— 学生已持有的课包标题，用来验 002-04A 的候选池**真的**排除了它；
//   · idleGrantName —— 有许可但没有任何课堂/调用的学生，用来验状态推导的**负例**（应当是「待激活」）。
//     students[4] = 林子涵：在 grantedIds 里（有许可），但 rosterIds（前 3 人）里没有它、也没有调用记录。
const grantedSeriesTitle = db.prepare('SELECT title FROM course_series WHERE id=?').get(lesson.series_id)?.title || '';
const idleGrantName = students[4]?.name || '';
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
/**
 * 写一份**多页**的示例 PDF 夹具。
 *
 * ⚠️ 为什么由守卫自己生成：这份夹具原来靠人手工往 `.tmp/test-sample.pdf` 塞了一个**最小单页** PDF，
 *    而下面「教学素材 → 工具栏翻页」那几步假设文档有多页 —— 单页时「下一页」本来就该是禁用的，
 *    守卫去点它必然超时崩掉，于是**它后面所有断言、以及最后那份 PASS/FAIL 汇总都再也不会打印**
 *    （整条守卫变成哑的：只看得见"红"，看不见"红在哪"）。
 *    现在夹具由守卫自产：页数必然对得上，也不再依赖一个没进仓库的文件（缺了会直接 ENOENT）。
 *
 * ⚠️ 这里刻意**不出现任何反斜杠转义**（换行一律用 nl 拼）：用脚本往这个文件里写转义序列
 *    很容易被中间某一层吃掉一层、在字符串里留下真换行，把守卫本身写成语法错误。
 */
function writeSamplePdf(file, pageCount = 3) {
  const nl = String.fromCharCode(10);
  const objects = ['<</Type/Catalog/Pages 2 0 R>>'];
  const kids = [];
  for (let index = 0; index < pageCount; index += 1) kids.push((3 + index * 2) + ' 0 R');
  objects.push('<</Type/Pages/Kids[' + kids.join(' ') + ']/Count ' + pageCount + '>>');
  const fontObject = 3 + pageCount * 2;
  for (let index = 0; index < pageCount; index += 1) {
    const contentObject = 4 + index * 2;
    objects.push('<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Resources<</Font<</F1 ' + fontObject + ' 0 R>>>>/Contents ' + contentObject + ' 0 R>>');
    const stream = 'BT /F1 24 Tf 60 150 Td (Page ' + (index + 1) + ') Tj ET';
    objects.push('<</Length ' + Buffer.byteLength(stream, 'latin1') + '>>' + nl + 'stream' + nl + stream + nl + 'endstream');
  }
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  const parts = ['%PDF-1.4'];
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(parts.join(nl) + nl, 'latin1'));
    parts.push((index + 1) + ' 0 obj', body, 'endobj');
  });
  const head = parts.join(nl) + nl;
  const xrefAt = Buffer.byteLength(head, 'latin1');
  const rows = ['xref', '0 ' + (objects.length + 1), '0000000000 65535 f '];
  for (const offset of offsets) rows.push(String(offset).padStart(10, '0') + ' 00000 n ');
  const tail = rows.join(nl) + nl + 'trailer' + nl + '<</Size ' + (objects.length + 1) + '/Root 1 0 R>>' + nl + 'startxref' + nl + xrefAt + nl + '%%EOF' + nl;
  fs.writeFileSync(file, Buffer.from(head + tail, 'latin1'));
}

// ── 教学素材夹具（2026-09-17）───────────────────────────────────────────────
// 目的是**端到端复现线上那个故障**：发布快照里冻着一张早已过期的预览票据。
// 修复前：课时抽屉把这张死链发给前端 → iframe 打不开 → 顺着「票据无效」的回落分支
//         用 cookie 兜底鉴权 → 报出「教学素材仅教师可见」（老师明明就是老师）。
// 修复后：previewUrl 现签，抽屉里那张永远新鲜；点开时还会再取一张。
// 所以这一节是「故意把快照写坏」，再断言浏览器里**真的能看到内容**。
{
  const now = new Date().toISOString();
  const seriesId = 'series-ui-materials';
  const materialLessonId = 'lesson-ui-materials';
  const fileId = 'file-ui-materials';
  // 真文件落到上传根下：预览要 stat/读它
  const relKey = 'teaching/ui-material.pdf';
  fs.mkdirSync(path.join(uploadRoot, 'teaching'), { recursive: true });
  const samplePdf = path.join(root, '.tmp', 'test-sample.pdf');
  fs.mkdirSync(path.dirname(samplePdf), { recursive: true });
  writeSamplePdf(samplePdf, 3);
  fs.writeFileSync(path.join(uploadRoot, relKey), fs.readFileSync(samplePdf));
  db.prepare(`INSERT INTO file_assets(id,owner_type,storage_kind,storage_key,file_name,mime_type,category,visibility,status,review_status,metadata,created_at,updated_at)
    VALUES(?,'PLATFORM','INTERNAL_PROXY',?,'ui-material.pdf','application/pdf','TEACHING_ASSET','PUBLIC_PLATFORM','ACTIVE','NOT_REQUIRED','{}',?,?)`)
    .run(fileId, relKey, now, now);
  db.prepare(`INSERT INTO course_series(id,title,description,owner_type,visibility,version,status,created_at,updated_at)
    VALUES(?,'P111 教学素材课包','用于验证教学素材预览','PLATFORM','PUBLIC','1.0','PUBLISHED',?,?)`).run(seriesId, now, now);
  // 快照里那张票据**故意写成早已过期**（1000000000000 = 2001 年）
  const deadPreviewUrl = `/api/org/file-assets/${fileId}/preview?t=1000000000000.deadbeef`;
  const snapshot = {
    capabilities: [], materialGroups: [], generationBoxes: [],
    teachingGroups: [{ id: 'tg-ui', title: '备课资料', sort: 1, assets: [{ id: 'ta-ui', title: 'P111 讲义', description: '端到端素材', assetType: 'FILE', fileAssetId: fileId, assetUrl: null, sort: 1, previewKind: 'PDF', previewUrl: deadPreviewUrl }] }],
  };
  db.prepare(`INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,delivery_mode,published_content,created_at,updated_at)
    VALUES(?,?,'第 1 课 · 教学素材验证','',1,'PUBLISHED',45,'CANVAS',?,?,?)`).run(materialLessonId, seriesId, JSON.stringify(snapshot), now, now);
  db.prepare("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_at) VALUES('assign-ui-materials',?,?,'ACTIVE',?)").run(seriesId, teacher.org_id, now);
  console.log('教学素材夹具：series=', seriesId, ' 快照里的票据已写死为过期');
}

// ── 002-06 采购 / 增购 / 开通记录夹具（2026-09-17）─────────────────────────
// 批次表里**没有**「初次开通 / 增购 / 平台调整」这三列，002-06 是按**批次在同一张授权单里的
// 序号**推出来的。所以这里刻意造出三种：同一张授权单的两条 PURCHASE（第一条=初次开通、
// 第二条=增购）+ 一条 LEGACY_OPENING_BALANCE（=平台调整）。
// 守卫要能证明这个分类**是算出来的**，而不是页面上写死的文案。
{
  // 挂在上面那个素材课包的授权单上（seriesId 是那个块的局部变量，这里用同一个字面量并核对它真在）
  const batchSeriesId = 'series-ui-materials';
  assert.ok(db.prepare('SELECT id FROM course_series WHERE id=?').get(batchSeriesId), 'fixture: 素材课包不在，批次夹具挂不上');
  const insertBatch = db.prepare(`INSERT INTO license_purchase_batches(id,assignment_id,org_id,series_id,purchase_type,quantity,amount_minor,currency,payment_status,status,order_no,contract_no,idempotency_key,purchased_by,purchased_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?,?,?)`);
  // ⚠️ 表上的 CHECK：LEGACY_OPENING_BALANCE 必须金额与币种都为 NULL；PURCHASE 必须两者都有值
  insertBatch.run('batch-ui-1', 'assign-ui-materials', teacher.org_id, batchSeriesId, 'PURCHASE', 10, 100000, 'CNY', 'PAID', 'P111-ORDER-1', null, 'p111-batch-1', teacher.id, '2026-09-01T02:00:00.000Z', '2026-09-01T02:00:00.000Z');
  insertBatch.run('batch-ui-2', 'assign-ui-materials', teacher.org_id, batchSeriesId, 'PURCHASE', 5, 50000, 'CNY', 'PAID', null, 'P111-CONTRACT-2', 'p111-batch-2', teacher.id, '2026-09-10T02:00:00.000Z', '2026-09-10T02:00:00.000Z');
  insertBatch.run('batch-ui-3', 'assign-ui-materials', teacher.org_id, batchSeriesId, 'LEGACY_OPENING_BALANCE', 3, null, null, 'PAID', null, null, 'p111-batch-3', null, '2026-08-01T02:00:00.000Z', '2026-08-01T02:00:00.000Z');
  console.log('002-06 夹具：3 条批次（初次开通 / 增购 / 平台调整各一条）');
}

// ── 002-04「正式学习记录」的正例夹具（2026-09-17）───────────────────────────
// 只造「未产生」是不够的：那段判定 SQL 就算坏成**永远返回空**，守卫照样绿 ——
// 正面分支根本没被验到。所以这里造一个真产生了正式学习记录的样本
// （口径见交接文档 4.6「守卫要反向自检才可信」）。
// 判定条件是「该学生在属于这个课包的课堂上，有过成功且非 mock 的 AI 调用」，
// 于是这里造：一节该课包的课堂 + 一条 SUCCESS 且模型名不含 MOCK 的调用记录。
{
  const learnedAt = new Date().toISOString();
  // ⚠️ 必须用这个课包下**另一节**课时：如果复用了待上课堂那节课，
  // 「已完成当前课堂对应课程」的判定会让学生从候选池掉出去，
  // 把「共 3 条课堂记录」「3 名学生资格仍有效」这些别的断言一起带红（第一版就踩了）。
  const learnedLessonId = 'lesson-ui-learned';
  db.prepare(`INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,delivery_mode,published_content,created_at,updated_at)
    VALUES(?,?,'第 2 课 · 学习记录样本','',99,'PUBLISHED',45,'CANVAS','{}',?,?)`).run(learnedLessonId, lesson.series_id, learnedAt, learnedAt);
  // teacher_id 特意留空：这节课只是「学习记录」的容器，不该出现在教师自己的课堂列表里
  // （挂了 teacher.id 就会把「共 3 条课堂记录」变成 4，污染教师视角的断言）。
  db.prepare(`INSERT INTO class_sessions(id,title,org_id,lesson_id,series_id,teacher_id,status,delivery_mode,started_at,created_at,updated_at)
    VALUES(?,'002-04 学习记录样本',?,?,?,NULL,'ENDED','CANVAS',?,?,?)`)
    .run('csession-ui-learned', teacher.org_id, learnedLessonId, lesson.series_id, learnedAt, learnedAt, learnedAt);
  db.prepare("INSERT INTO usage_records(id,org_id,user_id,class_session_id,project_id,modality,model,credits_charged,status,cost_fen,created_at) VALUES (?,?,?,?,NULL,'TEXT','gpt-4o-mini',0,'SUCCESS',100,?)")
    .run('usage-ui-learned', teacher.org_id, students[0].id, 'csession-ui-learned', learnedAt);
  console.log('002-04 学习记录夹具：', students[0].name, '在', lesson.series_id, '的第 2 课上有一条成功调用（正面分支）');
}

// ── 002-04A 候选池夹具（2026-09-17）────────────────────────────────────────
// 为什么要它：种子里的授权单配额全是 0，而 0 次**真的不能授权**
// （POST /api/org/course-grants 里 quotaTotal <= 0 直接拒），所以「剩余人次 > 0」的候选池必然是空的 ——
// 第一版就是这么空的。这里给两张授权单补上可用人次，候选规则才有东西可验：
//   · 素材课包（学生没持有）→ 应当出现在候选里；
//   · 学生已持有的那个课包 → 有余额也必须**被排除**，这正是 002-04A 候选规则要证的。
{
  const upsertQuota = (seriesId, total, used) => {
    const changed = db.prepare("UPDATE course_assignments SET quota_total=?, quota_used=? WHERE series_id=? AND org_id=? AND status='ACTIVE'")
      .run(total, used, seriesId, teacher.org_id).changes;
    if (!changed) {
      db.prepare("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_at,quota_total,quota_used) VALUES(?,?,?,'ACTIVE',?,?,?)")
        .run(`assign-ui-quota-${seriesId}`, seriesId, teacher.org_id, new Date().toISOString(), total, used);
    }
  };
  // 素材课包**故意给少一点**：后面「勾选要授权的学员」那一屏要验「按剩余人次封顶」
  // （可授权学员比剩余人次多 → 「全选本页」必须只选到剩余人次，并说明是按上限选的）。
  upsertQuota('series-ui-materials', 5, 0);
  upsertQuota(lesson.series_id, 10, grantedIds.length);
  console.log(`002-04A 夹具：素材课包 5 人次（候选 + 后面验封顶用）、学生已持有的课包 10 人次其中 ${grantedIds.length} 已分配（应被候选池排除）`);
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

  // ── 001-02 教师工作台（教师登录后的落地页；p70 用超管身份跑不到它，只能这里验）
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('教师工作台', [
    '教师工作台', '我的教学执行中心',
    '我的待上课课堂', '我的上课中课堂', '最近已结束课堂', '最近学生作品',
    '当前教学', '创建课堂', '常用入口',
  ]);
  await shot('17-teacher-dashboard');

  // ── 005-01 列表
  await page.goto(`${base}/classrooms`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('列表页', ['我的课堂列表', '待上课', '上课中', '已结束', '已解散', '课堂名称', '课包', '课程', '学生数', '创建时间', '实际开始', '实际结束', '查询', '重置', '未来城市设计']);
  await expectText('列表页', ['共 3 条课堂记录', '个「待上课 / 上课中」课堂']);
  // 已解散那一行的「实际结束」列必须标明它是解散时刻
  // （原来还断言规则面板里那句「已解散的课堂不会记录实际开始时间」，那块 2026-09-20 已按用户口径删除）
  await expectText('列表页', ['解散时间']);
  await shot('01-list');

  // ── 005-02 创建课堂（被占用时按钮该是灰的，且顶部给红/橙提示）
  await page.goto(`${base}/classrooms/new`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('创建页', ['创建课堂', '父级：', '课堂基础信息', '课堂名称', '课包', '课程', '所选课程摘要', '保存后的业务链', '添加学生', '满足条件后开始上课']);
  // 此刻账号上还有一个待上课课堂 → 必须是橙色「不能创建」，不能是一句写死的绿话
  await expectText('创建页（有占用时）', ['当前账号已有 1 个「待上课 / 上课中」课堂', '因此不能创建新的课堂']);
  if (!(await page.getByRole('button', { name: '保存课堂' }).isDisabled())) problems.push('创建页：有占用时「保存课堂」应该禁用');
  await shot('02-create-blocked');

  // ── 005-03 详情（待上课）
  await page.goto(`${base}/classrooms/${c.id}`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('详情页', ['课堂详情', '待上课', '课堂信息', '课堂操作', '编辑课堂名称', '查看课程资料', '开始上课', '解散课堂', '学生名单', '序号', '登录账号', '加入课堂时间', '添加学生', '课堂作品', '课堂事件']);
  // ⚠️ 这里原来还断言「阶段可操作」「页面边界」两块说明面板 —— 2026-09-20 用户口径已整块删除
  //    （连同「课堂 AI 使用 / 本课堂每学生算力 / 最近活动」那几行、以及名单里的「AI 使用」列）。
  //    别再钉它们了；改钉仍在的「课堂作品」「课堂事件」，保证这页确实渲染到底。
  await shot('03-detail-pending');

  // ── 005-03D 开始上课确认（校验清单必须来自服务端预检）
  await page.getByRole('button', { name: '开始上课' }).first().click();
  await page.waitForTimeout(700);
  await expectText('开始确认', ['开始上课确认', '开始前资格校验', '课堂状态 = 待上课', '教师账号可正常教学', '课包 / 课程当前可用', '课堂至少有 1 名学生', '3 名学生资格仍有效', '全部通过', '确认开始后的状态变化', '不可移除已加入学生']);
  await shot('04-modal-start');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ── 005-03A 编辑课堂名称
  await page.getByRole('button', { name: '编辑课堂名称' }).first().click();
  await page.waitForTimeout(500);
  // ⚠️ 原来这里钉的「页面边界」来自**背后那页**的说明面板（弹窗自己那个 BoundaryNote 没有标题），
  //    面板 2026-09-20 已删 —— 改成钉弹窗自己那条说明，别再去背景页里找。
  await expectText('改名弹窗', ['编辑课堂名称', '当前课堂', '学生数', '保存后的影响', '保持不变', '仅更新课堂名称显示', '不在此页更换课包', '保存名称']);
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
  await expectText('添加学生页', ['添加学生', '可添加学生', '不可添加学生', '当前课包授权', '当前课堂占用', '加入后课程状态', '不可添加判定说明', '已完成当前课堂对应课程', '不进入候选池']);
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

  // ── 教学素材预览（端到端）：快照里那张**写死的过期票据**不能影响老师看素材。
  // 这一节在修复前必然红：抽屉会拿着死链去开 iframe，iframe 又带不了鉴权头，
  // 于是回落到 cookie 鉴权并报出「教学素材仅教师可见」。
  await page.goto(`${base}/courses/series-ui-materials`, { waitUntil: 'domcontentloaded' });
  await settle();
  await expectText('课包详情', ['P111 教学素材课包', '第 1 课 · 教学素材验证']);
  await page.getByRole('button', { name: '查看' }).first().click();
  await settle();
  await expectText('课时抽屉', ['教学素材', 'P111 讲义']);
  await page.getByRole('button', { name: '在线预览' }).first().click();
  await page.waitForTimeout(2500);
  await expectText('素材查看器', ['在线预览（不提供下载）', 'P111 讲义', '全屏观看', '上一页', '下一页', '适应宽度']);

  // ① 必须**不再有 iframe**：那等于把渲染交回浏览器内置阅读器，那一排下载/打印按钮就回来了，
  //    而且 Ctrl+P / Ctrl+S / 右键都不过我们的页面，拦不住。现在应当是自己画的 canvas。
  const hasIframe = await page.locator('iframe.preview-frame').count();
  if (hasIframe) problems.push('素材预览：还在用 iframe（浏览器内置阅读器），下载/打印的口子堵不住');
  const geometry = await page.evaluate(() => ({ wrap: document.querySelector(".ta-scroll")?.clientWidth, stage: document.querySelector(".preview-stage")?.clientWidth, panel: document.querySelector(".ta-panel")?.clientWidth, slots: document.querySelectorAll(".ta-page-slot").length, firstSlot: Math.round(document.querySelector(".ta-page-slot")?.getBoundingClientRect().width || 0), canvases: document.querySelectorAll("canvas.ta-canvas").length }));
  console.log("查看器几何:", JSON.stringify(geometry));
  const canvasBox = await page.locator('canvas.ta-canvas').first().boundingBox().catch(() => null);
  if (!canvasBox || canvasBox.width < 100 || canvasBox.height < 100) problems.push('素材预览：canvas 没有真正画出页面内容');

  // ② 快捷键必须被拦下（capture 阶段 preventDefault；dispatchEvent 返回 false 表示已 preventDefault）
  const shortcutBlocked = await page.evaluate(() => {
    const result = {};
    for (const key of ['p', 's', 'u']) {
      result[key] = document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })) === false;
    }
    return result;
  });
  for (const [key, blocked] of Object.entries(shortcutBlocked)) {
    if (!blocked) problems.push(`素材预览：Ctrl+${key.toUpperCase()} 没有被拦下（打印/保存/查看源码还能用）`);
  }

  // ③ 右键菜单必须被吃掉（canvas 上不给「图片另存为」）
  const contextBlocked = await page.evaluate(() => document.querySelector('.ta-panel')
    ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) === false);
  if (!contextBlocked) problems.push('素材预览：右键菜单没有被拦下（可以「图片另存为」）');

  // ④ 滚轮：文档要能**连续往下滑**（用户原话「应该是有那种慢慢滑下去的感觉」），页码跟着滚动走。
  //    早先做成「一次只画一页、只能点按钮翻」，手感和阅读器完全不一样。
  const scrollBox = await page.locator('.ta-scroll').boundingBox();
  if (!scrollBox) problems.push('素材预览：找不到滚动容器');
  else {
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(1300);
    const toolbarText = await page.locator('.ta-toolbar').innerText();
    if (!/第 [2-9]/.test(toolbarText)) problems.push(`素材预览：滚轮下滑后页码没跟着走（工具栏首行：${toolbarText.split('\n')[0]}）`);
    const scrollTop = await page.evaluate(() => document.querySelector('.ta-scroll')?.scrollTop || 0);
    if (!(scrollTop > 200)) problems.push(`素材预览：滚轮没有真的滚下去（scrollTop=${Math.round(scrollTop)}）`);
    await shot('16-material-scrolled');
    await page.evaluate(() => { const node = document.querySelector('.ta-scroll'); if (node) node.scrollTop = 0; });
    await page.waitForTimeout(600);
  }

  // ⑤ 工具栏翻页也得能翻（跳页）
  await page.getByRole('button', { name: '下一页' }).click();
  await page.waitForTimeout(1200);
  await expectText('素材翻页', ['第 2']);
  await page.getByRole('button', { name: '‹ 上一页' }).click();
  await page.waitForTimeout(900);
  await expectText('素材翻回首页', ['第 1']);
  await shot('14-material-viewer');

  // 全屏：画布必须**按新尺寸重画**（用户报过「全屏还是这么小」——
  // 进全屏后 stage 变宽了却没重画，画面就停在进全屏前的像素尺寸、缩在中间），
  // 而且**内容不能变**（用户又报过「全屏之后画面倒着的、图也对不上」——
  // 那是同一块画布上并存了两个 pdf.js 渲染任务、缓冲区被写花）。
  // 所以这里对画布做 4×4 平均亮度指纹：内容只是被放大，指纹应当基本一致；
  // 一旦翻转 / 错位 / 写花，指纹立刻对不上。
  const fingerprint = () => page.evaluate(() => {
    const canvas = document.querySelector('canvas.ta-canvas');
    if (!canvas || !canvas.width) return null;
    const context = canvas.getContext('2d');
    const cells = [];
    const cellW = Math.max(1, Math.floor(canvas.width / 4));
    const cellH = Math.max(1, Math.floor(canvas.height / 4));
    for (let gy = 0; gy < 4; gy += 1) {
      for (let gx = 0; gx < 4; gx += 1) {
        const data = context.getImageData(gx * cellW, gy * cellH, cellW, cellH).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
        cells.push(Math.round(sum / (data.length / 4)));
      }
    }
    return cells;
  });
  const beforeShot = await fingerprint();
  const canvasBefore = await page.locator('canvas.ta-canvas').first().boundingBox();
  await page.getByRole('button', { name: '全屏观看' }).click();
  await page.waitForTimeout(1600);
  const fullscreen = await page.evaluate(() => Boolean(document.fullscreenElement));
  if (!fullscreen) problems.push('素材查看器：点「全屏观看」没有真的进入全屏');
  const canvasAfter = await page.locator('canvas.ta-canvas').first().boundingBox();
  if (!canvasBefore || !canvasAfter) problems.push('素材查看器：量不到画布尺寸');
  else if (!(canvasAfter.width > canvasBefore.width * 1.2)) problems.push(`全屏后画布没有按新尺寸重画（${Math.round(canvasBefore.width)}px → ${Math.round(canvasAfter.width)}px）`);
  const afterShot = await fingerprint();
  if (!beforeShot || !afterShot) problems.push('素材查看器：读不到画布像素');
  else {
    const worst = Math.max(...beforeShot.map((value, index) => Math.abs(value - afterShot[index])));
    if (worst > 40) problems.push(`全屏后画面内容变了（指纹最大偏差 ${worst}）—— 像是渲染被写花或翻转：${JSON.stringify(beforeShot)} → ${JSON.stringify(afterShot)}`);
  }
  await shot('15-material-viewer-fullscreen');
  await page.evaluate(() => document.exitFullscreen?.());
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '关闭预览' }).click().catch(() => {});
  await page.waitForTimeout(400);

  // ══════════════════════════════════════════════════════════════════════════
  // 002-03 / 002-04 / 002-04B / 002-06：**机构管理员**视角（2026-09-17 补）
  //
  // 在这之前 p111 只有教师身份，机构端那几屏只能手点 —— 所以它们没有守卫。
  // 这里用**独立的浏览器上下文**跑机构管理员（不与教师会话抢 storage），
  // 让 002 这一套进自动验收。
  // ══════════════════════════════════════════════════════════════════════════
  const orgContext = await browser.newContext({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 1 });
  const orgPage = await orgContext.newPage();
  orgPage.on('pageerror', (error) => pageErrors.push(`pageerror(org): ${String(error.message).slice(0, 300)}`));
  orgPage.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource/.test(message.text())) return;
    pageErrors.push(`console(org): ${message.text().slice(0, 200)}`);
  });
  orgPage.on('response', (response) => { if (response.status() >= 400) badRequests.push(`${response.status()} ${response.url()}`); });
  const orgExpect = async (label, texts) => {
    const body = await orgPage.locator('body').innerText();
    for (const text of texts) { if (!body.includes(text)) problems.push(`${label}：页面上找不到「${text}」`); }
  };
  const orgShot = async (name) => { await orgPage.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true }); };
  const orgSettle = async () => { await orgPage.waitForLoadState('networkidle').catch(() => {}); await orgPage.waitForTimeout(350); };
  // 读一张指标卡的数字：卡片的 DOM 是「标签\n数值\n说明」，所以取夹在两个换行之间的整数。
  // 用它来断言「卡片是按真实数据算的」——只断言标签存在的话，写死的数字也能过。
  const cardValue = async (label) => {
    const text = await orgPage.locator('.metric-card', { hasText: label }).first().innerText();
    const match = text.match(/\n(-?\d+)\n/);
    return match ? Number(match[1]) : null;
  };

  await orgPage.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await orgSettle();
  await orgPage.getByRole('button', { name: /机构管理员/ }).click();
  await orgPage.getByRole('button', { name: /进入工作台/ }).click();
  await orgPage.waitForURL(/\/dashboard/, { timeout: 20000 }).catch(() => {});
  await orgSettle();

  // ── 002-01：四个页签都在（机构管理员能看到入口）
  await orgPage.goto(`${base}/series-overview`, { waitUntil: 'domcontentloaded' });
  await orgSettle();
  await orgExpect('002-01 库存列表', ['机构课包库存', '课包库存', '学生授权中心', '采购与开通记录', '为学生添加课包']);
  await orgShot('20-org-series-overview');

  // ── 002-03 学生授权中心：4 张卡必须**按真实数据算**
  // 夹具里正好 5 名学生有许可（grantedIds），所以「已有课包学生」必须等于 5。
  await orgPage.locator('.tab', { hasText: '学生授权中心' }).click();
  await orgSettle();
  await orgExpect('002-03 学生授权中心', [
    '学生总数', '已有课包学生', '暂无课包学生', '本月新增授权',
    '账号状态', '授权情况', '授权概览', '查看授权',
    '学生', '登录账号', '已授权课包数', '最近授权时间',
  ]);
  const totalStudents = await cardValue('学生总数');
  const withGrants = await cardValue('已有课包学生');
  const withoutGrants = await cardValue('暂无课包学生');
  if (withGrants !== grantedIds.length) problems.push(`002-03：「已有课包学生」期望 ${grantedIds.length}（夹具里正好这么多人有许可），实际 ${withGrants} —— 卡片像是写死的`);
  if (typeof totalStudents === 'number' && withGrants + withoutGrants !== totalStudents) problems.push(`002-03：卡片算术对不上（总数 ${totalStudents} ≠ 已有 ${withGrants} + 暂无 ${withoutGrants}）`);
  await orgShot('21-org-student-grant-center');

  // ── 002-04 学生授权详情（按线框图第 1 张重排）：从有许可的学生那一行下钻。
  // 入口做在**课包名**上（线框图表只有 4 列、没有「操作」列），所以这里点行内那个 text-button。
  const grantedName = students[0].name;
  await orgPage.locator('tr', { hasText: grantedName }).first().getByRole('button', { name: '查看授权' }).click();
  await orgSettle();
  await orgExpect('002-04 学生授权详情', [
    '学生授权详情', '学生授权中心',
    '当前授权课包', '已产生正式学习记录', '当前课包授权', '当前未取消授权',
    '当前版本', '授权时间', '授权状态',
  ]);
  // 正面分支必须被验到：夹具给这名学生造了一条「成功且非 mock」的调用，
  // 所以「已产生正式学习记录」该是 1、该行该是「学习中」。
  // 只断言「待激活」等于没验 —— 判定 SQL 坏成永远返回空，守卫也照样是绿的。
  const learnedCount = await cardValue('已产生正式学习记录');
  if (learnedCount !== 1) problems.push(`002-04：「已产生正式学习记录」期望 1（夹具给 ${grantedName} 造了一条成功调用），实际 ${learnedCount} —— 判定 SQL 可能永远返回空`);
  if (!(await orgPage.locator('table tbody tr', { hasText: '学习中' }).count())) {
    problems.push('002-04：课包授权表里没有任何一行是「学习中」—— 状态推导（学习中 = 已进入正式课堂或已产生有效 AI 记录）没走通');
  }
  // 机构端**没有取消授权权限**（用户 2026-09-17 口径）：这一页不能出现取消类的可点入口。
  // 注意：文案里出现「撤销授权只有平台端有权限」是说明，不算违规 —— 所以这里断言的是**按钮**。
  if (await orgPage.getByRole('button', { name: /取消授权|取消资格|撤销授权/ }).count()) {
    problems.push('002-04：出现了「取消授权 / 取消资格」按钮 —— 机构端没有取消权限（用户口径），不该给机构这个入口');
  }
  await orgShot('22-org-student-grant-detail');

  // ── 002-04A「添加课包」抽屉（线框图右栏）：候选规则、仅单选、授权后预览。
  // ⚠️ 只打开 + 选中 + 关掉，**绝不点「确认授权」** —— 那会写库，把后面 002-03 / 002-06 的数字改掉。
  // ⚠️ 必须 exact —— getByRole 的 name 默认是**子串**匹配，「添加课包」会命中页签「为学生添加课包」，
  //    于是点去了学员许可页、抽屉压根没开（第一版就这么踩的，截图拍到的是错页面）。
  await orgPage.getByRole('button', { name: '添加课包', exact: true }).first().click();
  await orgPage.waitForTimeout(700);
  await orgExpect('002-04A 添加课包', ['002-04A', '添加课包', '当前学生', '候选课包规则', '可授权课包', '搜索课包', '总人次', '已分配', '剩余']);
  const candidate = orgPage.locator('.drawer-panel input[type=radio]').first();
  if (await candidate.count()) {
    await candidate.click();
    await orgPage.waitForTimeout(500);
    await orgExpect('002-04A 授权预览', ['本次授权预览', '授权后状态', '待激活', '剩余人次', '总人次', '确认授权后', '页面边界', '取消', '确认授权']);
    if (await orgPage.locator('.drawer-panel').getByRole('button', { name: /取消授权|取消资格|撤销授权/ }).count()) {
      problems.push('002-04A：抽屉里出现了取消类按钮（机构端没有取消权限）');
    }
    // 候选池规则要**真的生效**：这名学生已经持有的课包不能出现在候选里
    const candidateTitles = (await orgPage.locator('.drawer-panel .item-card label').allInnerTexts()).map((text) => text.trim().replace(/\s+/g, ' '));
    if (grantedSeriesTitle && candidateTitles.some((title) => title.includes(grantedSeriesTitle))) {
      problems.push(`002-04A：候选里出现了该学生已持有的课包「${grantedSeriesTitle}」——候选规则没生效（候选：${candidateTitles.join('、')}）`);
    }
    console.log(`002-04A 候选课包（${candidateTitles.length} 个）：${candidateTitles.join('、')}`);
  } else {
    problems.push('002-04A：一个候选课包都没有 —— 夹具里有可授权的课包，候选池不该是空的');
  }
  await orgShot('26-org-add-grant-drawer');
  await orgPage.locator('.drawer-panel').getByRole('button', { name: '取消', exact: true }).click();
  await orgPage.waitForTimeout(400);

  // ── 002-04B 单授权详情抽屉（入口是行内的课包名按钮）
  await orgPage.locator('table tbody tr').first().getByRole('button').first().click();
  await orgPage.waitForTimeout(600);
  await orgExpect('002-04B 单授权详情', ['单授权详情', '授权对象', '授权信息', '操作账号', '来源', '占用人次', '授权状态', '正式学习记录', '页面边界', '关闭']);
  if (await orgPage.locator('.drawer-panel').getByRole('button', { name: /取消授权|取消资格|撤销授权/ }).count()) {
    problems.push('002-04B：抽屉里出现了取消类按钮 —— 机构端没有取消权限（用户口径）');
  }
  await orgShot('23-org-grant-drawer');
  await orgPage.locator('.drawer-close').click().catch(() => {});
  await orgPage.waitForTimeout(300);

  // ── 002-04 的负例：换一个「有授权但没有任何学习活动」的学生 —— 状态必须是「待激活」。
  // 没有这一条，「待激活/学习中」的推导只被正面验过（全算成学习中也不会红）。
  await orgPage.getByRole('button', { name: '← 返回学生授权中心' }).click();
  await orgSettle();
  await orgPage.locator('form.filter-form input').first().fill(idleGrantName);
  await orgPage.getByRole('button', { name: '查询' }).first().click();
  await orgSettle();
  const idleRow = orgPage.locator('table tbody tr', { hasText: idleGrantName }).first();
  if (await idleRow.count()) {
    await idleRow.getByRole('button', { name: '查看授权' }).click();
    await orgSettle();
    await orgExpect('002-04 待激活分支', ['待激活']);
    const idleLearned = await cardValue('已产生正式学习记录');
    if (idleLearned !== 0) problems.push(`002-04：${idleGrantName} 没有任何课堂与调用，「已产生正式学习记录」应为 0，实际 ${idleLearned}`);
    if (await orgPage.locator('table tbody tr', { hasText: '学习中' }).count()) {
      problems.push(`002-04：${idleGrantName} 的授权不该是「学习中」（既没进过课堂也没有 AI 调用）`);
    }
    await orgShot('27-org-grant-pending-state');
  } else {
    problems.push(`002-03：搜索「${idleGrantName}」没找到那一行`);
  }

  // ── 002-04 空分支：筛出「暂无课包」的学生，详情页要给空态而不是崩掉
  await orgPage.getByRole('button', { name: '← 返回学生授权中心' }).click();
  await orgSettle();
  await orgPage.locator('form.filter-form select').nth(1).selectOption('WITHOUT');
  await orgPage.getByRole('button', { name: '查询' }).first().click();
  await orgSettle();
  const noGrantRow = orgPage.locator('table tbody tr').first();
  if (await noGrantRow.count()) {
    await noGrantRow.getByRole('button', { name: '查看授权' }).click();
    await orgSettle();
    await orgExpect('002-04 暂无课包的详情', ['该学生还没有任何课包授权']);
    await orgShot('24-org-student-grant-empty');
  } else {
    problems.push('002-03：「授权情况 = 暂无课包」筛选后一行都没有 —— 夹具里应有 2 名没课包的学生');
  }

  // ── 002-06 采购 / 增购 / 开通记录：三分类是**按批次序号算出来的**，不是写死的文案
  await orgPage.locator('.tab', { hasText: '采购与开通记录' }).click();
  await orgSettle();
  await orgExpect('002-06 采购与开通记录', [
    '采购 / 增购 / 开通记录', '业务记录', '初次开通', '增购', '平台调整',
    '业务时间', '业务类型', '人次数量', '业务来源', '经办', '备注', '页面边界',
  ]);
  const firstOpening = await cardValue('初次开通');
  const additional = await cardValue('增购');
  const adjustment = await cardValue('平台调整');
  const batchTotal = await cardValue('业务记录');
  // 卡片之间必须自洽（合计 = 三类之和）。**不写死总数** —— 种子库里本来就可能有别的批次（实测有），
  // 写死会让守卫因为夹具之外的数据变红，那种红是噪音。
  if (batchTotal !== firstOpening + additional + adjustment) {
    problems.push(`002-06：卡片加起来对不上（合计 ${batchTotal} ≠ 初次开通 ${firstOpening} + 增购 ${additional} + 平台调整 ${adjustment}）`);
  }
  if (!(firstOpening >= 1 && additional >= 1 && adjustment >= 1)) {
    problems.push(`002-06：三类里至少一类是 0（初次开通 ${firstOpening} / 增购 ${additional} / 平台调整 ${adjustment}）—— 夹具造了三类，分类逻辑没算出来`);
  }
  // 分类必须**落在正确的行上**：按备注里的订单号 / 期初文案定位那一行，再断言它的「业务类型」。
  // 只断言「三个数字都 > 0」是不够的 —— 数字对、行错也是错的。
  for (const [noteText, expectedType] of [['P111-ORDER-1', '初次开通'], ['P111-CONTRACT-2', '增购'], ['期初人次', '平台调整']]) {
    const row = orgPage.locator('table tbody tr', { hasText: noteText });
    if (!(await row.count())) { problems.push(`002-06：表里找不到备注含「${noteText}」的那一行`); continue; }
    const text = await row.first().innerText();
    if (!text.includes(expectedType)) problems.push(`002-06：「${noteText}」那一行的业务类型不是「${expectedType}」（实际：${text.replace(/\n/g, ' | ')}）`);
  }
  await orgShot('25-org-license-batches');
  // ── 002-05 学生授权记录：这里**故意走一次真实授权**（不是只读夹具）——
  // 顺便把这一版新加的「来源」端到端验掉：机构授权时带 source，审计里要能原样读回来。
  // ⚠️ 放在最后：它会多产生一条授权，若跑在前面会把 002-03 的「已有课包学生」等数字改掉。
  const orgToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data?.token;
  assert.ok(orgToken, 'fixture: org-admin 登录失败（002-05 需要它来造一条真实授权记录）');
  const noGrantStudent = students[5];   // 孙雨桐：前面「暂无课包」筛选里用的就是这类学生
  // 再搭一个**保持授权不撤销**的学生：这样「勾选要授权的学员」那一屏才有「已授权」行可验
  // （不然所有行都是「可授权」，那个分支就是没验过的）。
  const keepGrantStudent = students[6];
  const grantResp = await api('/api/org/course-grants', { method: 'POST', token: orgToken, body: { seriesId: 'series-ui-materials', studentIds: [noGrantStudent.id, keepGrantStudent.id], source: 'STUDENT_CENTER' } });
  assert.equal(grantResp.status, 200, `002-05 夹具：真实授权失败 ${JSON.stringify(grantResp).slice(0, 200)}`);
  console.log('002-05 夹具：给', noGrantStudent.name, '/', keepGrantStudent.name, '授了素材课包（source=STUDENT_CENTER）；后者不撤销，留给「勾选学员」验已授权行');

  await orgPage.locator('.tab', { hasText: '学生授权记录' }).click();
  await orgSettle();
  await orgExpect('002-05 学生授权记录', [
    '学生授权记录', '本月授权', '本月取消', '今日授权', '记录总数',
    '学生', '课包', '操作类型', '操作结果', '操作账号', '来源',
  ]);
  const recordRow = orgPage.locator('table tbody tr', { hasText: noGrantStudent.name });
  if (!(await recordRow.count())) {
    problems.push(`002-05：刚授权出去的「${noGrantStudent.name}」没有出现在授权记录里 —— 审计没写进去，或接口没读出来`);
  } else {
    const text = await recordRow.first().innerText();
    // 「来源」是本版新加的字段（老记录没有），这里必须显示成 学生授权中心 才算真的记下来了
    for (const needle of ['P111 教学素材课包', '授权', '成功', '学生授权中心']) {
      if (!text.includes(needle)) problems.push(`002-05：记录行里缺「${needle}」（实际：${text.replace(/\n/g, ' | ')}）`);
    }
  }
  const grantedToday = await cardValue('今日授权');
  if (!(grantedToday >= 1)) problems.push(`002-05：「今日授权」至少该是 1（刚发生了一次授权），实际 ${grantedToday}`);
  const recordTotal = await cardValue('记录总数');
  if (!(recordTotal >= 1)) problems.push(`002-05：「记录总数」至少该是 1，实际 ${recordTotal}`);
  await orgShot('28-org-grant-records');

  // ── 002-05 的**取消授权**那一行也要端到端验到（图2 的核心行之一，光验授权只是半条）。
  // 用平台超管真撤销一次：这也是「机构端没有取消权限」的实证 —— 撤销只能由平台账号发起。
  const adminToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data?.token;
  assert.ok(adminToken, '002-05 夹具：平台超管登录失败（撤销只能由平台发起）');
  const grantedList = await api('/api/org/course-grants?seriesId=series-ui-materials', { token: orgToken });
  const createdGrant = (grantedList.data?.items || []).find((item) => item.studentId === noGrantStudent.id);
  assert.ok(createdGrant, '002-05 夹具：找不到刚建的那条授权');
  const revokedResp = await api(`/api/admin/course-grants/${createdGrant.id}/revoke`, { method: 'POST', token: adminToken, body: { reason: 'P111 守卫：验证取消授权记录' } });
  assert.equal(revokedResp.status, 200, `002-05 夹具：平台撤销失败 ${JSON.stringify(revokedResp).slice(0, 200)}`);
  // 筛成「取消授权」再查一次（换筛选会让 queryString 变 → useData 真的重新拉）
  await orgPage.locator('form.filter-form select').nth(1).selectOption('REVOKE');
  await orgPage.getByRole('button', { name: '查询' }).first().click();
  await orgSettle();
  const revokeRow = orgPage.locator('table tbody tr', { hasText: noGrantStudent.name }).first();
  if (!(await revokeRow.count())) {
    problems.push('002-05：平台撤销之后，「取消授权」记录里没有这一行 —— 撤销没有落审计，或接口没读出来');
  } else {
    const revokeText = await revokeRow.innerText();
    // 「平台」两字是关键：取消授权那一行的操作账号必须是**平台侧**（机构端没有这个权限）
    for (const needle of ['取消授权', '成功', '平台']) {
      if (!revokeText.includes(needle)) problems.push(`002-05：取消授权记录行里缺「${needle}」（实际：${revokeText.replace(/\n/g, ' | ')}）`);
    }
  }
  const revokedThisMonth = await cardValue('本月取消');
  if (!(revokedThisMonth >= 1)) problems.push(`002-05：「本月取消」至少该是 1（刚撤销过一次），实际 ${revokedThisMonth}`);
  await orgShot('29-org-grant-records-revoke');

  // ── 「为学生添加课包」里「勾选要授权的学员」这一块（2026-09-18 用户反馈「布局和逻辑很不舒服」后重做）。
  // 这一屏以前**没有守卫**，所以它烂在那儿没人发现：`checkbox-option` 这个类**只在平台端 admin.css 里有定义**
  // （`.admin-console .checkbox-option`），机构端引不到它 → 落到全局 `label{display:grid;gap:6px;margin:12px 0}`
  // 上：姓名和复选框被拆成两行、每行还撑到上百像素高（用户截图里复选框飘在名字右边很远处）。
  await orgPage.locator('.tab', { hasText: '为学生添加课包' }).click();
  await orgSettle();
  await orgExpect('学员许可（选课包前）', ['① 选课包', '课包', '可用次数']);
  await orgPage.locator('.form-grid select').first().selectOption('series-ui-materials');
  await orgSettle();
  await orgExpect('勾选学员', [
    '② 勾选要授权的学员', '③ 本次授权',
    '本页可授权', '全选本页可授权', '清空选择', '已选',
    '选', '学员', '登录账号', '手机号', '授权情况', '已授权',
    '本次将用掉', '授权后本课包剩',
  ]);
  // 「已授权」那一行必须真的显示出来（夹具特意留了一个不撤销的授权）：
  // 既要有徽标，也要出现在表头计数里 —— 不然这一屏就只剩「可授权」一种行，分支没验过。
  if (!(await orgPage.locator('.student-pick-row', { hasText: '已授权' }).count())) {
    problems.push('勾选学员：没有任何一行显示「已授权」—— 夹具留了一个有效授权，这一行必须出现');
  }
  await orgExpect('已授权计数', ['已授权 1 人']);
  // 布局硬指标：复选框必须**紧挨**姓名（同一行、横向离得近）—— 老版本它飘在名字右边几百像素外，
  // 这一条就是防它回归的（光断言表格存在，把复选框塞到最后一个单元格里也照样过）。
  const pickGeometry = await orgPage.evaluate(() => {
    const row = document.querySelector('.student-pick-row');
    if (!row) return null;
    const box = row.querySelector('input[type=checkbox]');
    const name = row.querySelector('strong');
    if (!box || !name) return null;
    const a = box.getBoundingClientRect();
    const b = name.getBoundingClientRect();
    return { gap: Math.round(b.left - a.right), sameLine: Math.abs(a.top - b.top) < 12 };
  });
  if (!pickGeometry) problems.push('勾选学员：量不到复选框与姓名的位置（表格没渲染出来？）');
  else {
    if (!pickGeometry.sameLine) problems.push('勾选学员：复选框与姓名不在同一行（纵向差 > 12px）');
    if (pickGeometry.gap > 40) problems.push(`勾选学员：复选框离姓名太远（横向间距 ${pickGeometry.gap}px）—— 就是用户说的「布局不舒服」`);
  }
  // 逻辑：按剩余人次封顶。**期望值从页面上读**（可授权人数、剩余次数），不写死 ——
  // 夹具人数或人次一改，这里不用跟着改，而且读出来算才能证明"封顶"是按这两个数算的。
  const addableLabel = await orgPage.getByRole('button', { name: '全选本页可授权' }).innerText();
  const addableCount = Number((addableLabel.match(/（(\d+)）/) || [])[1]);
  const quotaInput = await orgPage.locator('.form-grid input').first().inputValue();
  const remainCount = Number((quotaInput.match(/剩 (\d+) 次/) || [])[1]);
  if (!(addableCount > remainCount)) {
    problems.push(`勾选学员：夹具没造出「可授权人数 > 剩余人次」的局面（可授权 ${addableCount} / 剩余 ${remainCount}），封顶逻辑就验不到`);
  }
  const expectPicked = Math.min(addableCount, remainCount);
  await orgPage.getByRole('button', { name: '全选本页可授权' }).click();
  await orgPage.waitForTimeout(500);
  const pickBar = await orgPage.locator('.pick-bar').innerText();
  if (!pickBar.includes(`已选 ${expectPicked} 人`)) {
    problems.push(`勾选学员：可授权 ${addableCount} 人而只剩 ${remainCount} 次时，「全选本页」应当按上限只选 ${expectPicked} 人（实际：${pickBar.replace(/\n/g, ' ')}）`);
  }
  await orgExpect('封顶提示', [`已按上限只选了 ${expectPicked} 人`]);
  const submitLabel = await orgPage.locator('button.primary-button').last().innerText();
  if (!submitLabel.includes(`授权给 ${expectPicked} 名学员`)) problems.push(`勾选学员：提交按钮应当写「授权给 ${expectPicked} 名学员」（实际：${submitLabel}）`);
  const pickerText = await orgPage.locator('body').innerText();
  if (pickerText.includes('剩余人次不足')) problems.push('勾选学员：按上限封顶之后不该再出现「剩余人次不足」—— 那是没封顶才会有的状态');
  await orgShot('30-org-student-picker');
  await orgPage.getByRole('button', { name: '清空选择' }).click();
  await orgPage.waitForTimeout(400);
  const cleared = await orgPage.locator('.pick-bar').innerText();
  if (!cleared.includes('已选 0 人')) problems.push(`勾选学员：「清空选择」之后应当回到 已选 0 人（实际：${cleared.replace(/\n/g, ' ')}）`);
  await orgContext.close();

  if (pageErrors.length) problems.push(`浏览器报错：${pageErrors.slice(0, 5).join(' | ')}`);
  // 任何 4xx/5xx 都算问题，**不留豁免**：这条曾经放着 /fonts/Geist-*.woff2 的一条例外
  // （机构端没打包字体，一直 404 回退系统字体）。2026-09-17 字体已补进 apps/org/public/fonts，
  // 所以把豁免撤掉 —— 留着它以后字体真回归了会被静默吞掉。
  const failures = [...new Set(badRequests)];
  if (failures.length) problems.push(`请求失败：${failures.slice(0, 6).join(' | ')}`);
  assert.ok(fs.readdirSync(shotDir).length >= 17, '截图没出全');
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
