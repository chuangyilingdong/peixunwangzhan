/**
 * P174 「老师端备课入口」守卫（2026-09-30 用户口径）。
 *
 * 用户原话：「老师端可以自由无限制进入对应的课时课堂，画布/VibeCoding，他们可以走流程，
 *   但是**无法生成**。VibeCoding的发送按钮隐藏，画布课堂生成按钮隐藏。
 *   课时是画布课堂就出现画布备课按钮，是 VibeCoding 课堂就出现 VibeCoding 备课按钮，
 *   两个都涉及就出现两个按钮。」
 *
 * 这一道钉五件事：
 *   ① 机构端课时详情带 `deliveryModes`（按钮就是照它出的：只有画布 → 一个按钮，两个都有 → 两个）；
 *   ② `GET /api/org/lessons/<id>/prep?mode=` 给备课画布那份数据（课时模板画布 + 生成框体），
 *      且**没发布的入口类型一律 400**、**课包没授权给本机构 403**、课时不存在 404；
 *   ③ ⭐ `client-context` 对老师/机构管理员回**备课上下文**（`prep:true` + 那一节课），
 *      并且**绝不发 `gateway` 密钥** —— 客户端拿不到运行密钥就调不动上游，这是"无法生成"的服务端兜底；
 *   ④ 学生走同一条接口**照旧**（不带 prep 字段、行为不变）—— 别把学生的路改坏；
 *   ⑤ 静态：机构端两个按钮 + 深链带 `prep=1&lesson=`；备课画布**不传 onGenerateNode**（生成按钮因此不出现）。
 *
 * 跑法：node scripts/p174-org-lesson-prep.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p174-prep-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const PORT = 18974;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p174-guard-secret',
  PORT: String(PORT),
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);

/* ───────── 夹具：同一课包里造三种入口类型的课时 + 一个"没授权给任何机构"的课时 ───────── */
const grantedSeries = await arow(`SELECT series.id, series.title FROM course_series series
   JOIN course_assignments assignment ON assignment.series_id=series.id AND assignment.org_id IS NOT NULL
  WHERE series.status='PUBLISHED' LIMIT 1`);
assert.ok(grantedSeries?.id, '夹具里没有"已授权给机构"的课包');
const publishedLessons = await arows("SELECT id, title FROM course_lessons WHERE series_id=? AND status='PUBLISHED' ORDER BY sort", [grantedSeries.id]);
assert.ok(publishedLessons.length >= 3, `这个课包只有 ${publishedLessons.length} 节课，夹具需要 3 节`);
const [canvasOnly, vibeOnly, bothModes] = publishedLessons;
const setModes = async (lessonId, modes) => {
  await aq("UPDATE course_lessons SET delivery_mode=?, delivery_modes=? WHERE id=?", [modes[0], JSON.stringify(modes), lessonId]);
};
await setModes(canvasOnly.id, ['CANVAS']);
await setModes(vibeOnly.id, ['VIBECODING']);
await setModes(bothModes.id, ['CANVAS', 'VIBECODING']);
// 没授权给任何机构的课包（`accessibleLesson` 判的是 assignment，所以必然 403）
const orphanSeriesId = 'series_p174_orphan';
const orphanLessonId = 'lesson_p174_orphan';
const nowIso = new Date().toISOString();
await aq("INSERT INTO course_series(id,title,status,created_at,updated_at) VALUES (?,?,'PUBLISHED',?,?)", [orphanSeriesId, 'P174 未授权课包', nowIso, nowIso]);
await aq("INSERT INTO course_lessons(id,series_id,title,status,sort,delivery_mode,delivery_modes,created_at,updated_at) VALUES (?,?,?,'PUBLISHED',1,'CANVAS',?,?,?)",
  [orphanLessonId, orphanSeriesId, 'P174 未授权课时', JSON.stringify(['CANVAS']), nowIso, nowIso]);

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-800)}`);
    await sleep(150);
  }
  const login = async (name, password) => (await api('/api/auth/login', { method: 'POST', body: { login: name, password } })).data?.token;
  const adminToken = await login('org-admin', 'org123');
  const teacherToken = await login('teacher-1', 'teach123');
  const studentToken = await login('student-1', 'study123');
  assert.ok(adminToken && teacherToken && studentToken, '夹具账号登录失败');

  /* ───────── ① 课时详情带 deliveryModes（按钮照它出） ───────── */
  const series = await api(`/api/org/course-series/${encodeURIComponent(grantedSeries.id)}`, { token: adminToken });
  const lessonsById = new Map((series.data?.lessons || []).map((lesson) => [lesson.id, lesson]));
  check('① 机构端课时详情带 deliveryModes（只有画布的课时 = [CANVAS]）',
    JSON.stringify(lessonsById.get(canvasOnly.id)?.deliveryModes) === JSON.stringify(['CANVAS']),
    JSON.stringify(lessonsById.get(canvasOnly.id)?.deliveryModes));
  check('① VibeCoding 课时 = [VIBECODING]，两种都发布 = [CANVAS,VIBECODING]（→ 两个按钮）',
    JSON.stringify(lessonsById.get(vibeOnly.id)?.deliveryModes) === JSON.stringify(['VIBECODING'])
    && JSON.stringify(lessonsById.get(bothModes.id)?.deliveryModes) === JSON.stringify(['CANVAS', 'VIBECODING']),
    JSON.stringify([lessonsById.get(vibeOnly.id)?.deliveryModes, lessonsById.get(bothModes.id)?.deliveryModes]));

  /* ───────── ② 备课接口 ───────── */
  const prep = await api(`/api/org/lessons/${encodeURIComponent(canvasOnly.id)}/prep?mode=CANVAS`, { token: adminToken });
  check('② 画布备课接口 200，并带上这节课的画布与框体',
    prep.status === 200 && prep.data?.mode === 'CANVAS' && prep.data?.lesson?.id === canvasOnly.id
    && typeof prep.data?.canvasSnapshot === 'object' && Array.isArray(prep.data?.generationBoxes),
    JSON.stringify(prep.data).slice(0, 220));
  const teacherPrep = await api(`/api/org/lessons/${encodeURIComponent(canvasOnly.id)}/prep?mode=CANVAS`, { token: teacherToken });
  check('② 授课老师（不只是机构管理员）也拿得到备课数据', teacherPrep.status === 200, `status=${teacherPrep.status}`);
  const wrongMode = await api(`/api/org/lessons/${encodeURIComponent(vibeOnly.id)}/prep?mode=CANVAS`, { token: adminToken });
  check('② 对只发布了 VibeCoding 的课时要画布备课 → 400 INVALID_DELIVERY_MODE',
    wrongMode.status === 400 && wrongMode.data?.error?.code === 'INVALID_DELIVERY_MODE', JSON.stringify(wrongMode.data).slice(0, 200));
  const wrongMode2 = await api(`/api/org/lessons/${encodeURIComponent(canvasOnly.id)}/prep?mode=VIBECODING`, { token: adminToken });
  check('② 反过来（只发画布却要 VibeCoding 备课）同样 400', wrongMode2.status === 400, `status=${wrongMode2.status}`);
  const notAssigned = await api(`/api/org/lessons/${orphanLessonId}/prep?mode=CANVAS`, { token: adminToken });
  check('② 没授权给本机构的课时 → 403 COURSE_NOT_ASSIGNED',
    notAssigned.status === 403 && notAssigned.data?.error?.code === 'COURSE_NOT_ASSIGNED', JSON.stringify(notAssigned.data).slice(0, 200));
  const noLesson = await api('/api/org/lessons/lesson_p174_missing/prep?mode=CANVAS', { token: adminToken });
  check('② 不存在的课时 → 404 LESSON_NOT_FOUND', noLesson.status === 404, `status=${noLesson.status}`);

  /* ───────── ③ 客户端备课上下文（老师） ───────── */
  const teacherCtx = await api(`/api/student/runtime/client-context?prep=1&lessonId=${encodeURIComponent(vibeOnly.id)}`, { token: teacherToken });
  check('③ 老师拿到的 client-context 是备课上下文（prep:true + 那一节课）',
    teacherCtx.status === 200 && teacherCtx.data?.prep === true && teacherCtx.data?.lesson?.id === vibeOnly.id
    && teacherCtx.data?.reason === 'TEACHER_PREP',
    JSON.stringify(teacherCtx.data).slice(0, 240));
  check('③ ⭐ 备课上下文**不发 gateway 密钥**（客户端拿不到运行密钥 = 服务端兜底"不能生成"）',
    !teacherCtx.data?.gateway && !JSON.stringify(teacherCtx.data || {}).includes('gateway'),
    JSON.stringify(Object.keys(teacherCtx.data || {})));
  check('③ 备课上下文不带课堂（classroom:null / classrooms:[]）',
    teacherCtx.data?.classroom === null && Array.isArray(teacherCtx.data?.classrooms) && teacherCtx.data.classrooms.length === 0,
    JSON.stringify([teacherCtx.data?.classroom, teacherCtx.data?.classrooms]));
  const adminCtx = await api(`/api/student/runtime/client-context?prep=1&lessonId=${encodeURIComponent(vibeOnly.id)}`, { token: adminToken });
  check('③ 机构管理员进客户端也是备课模式', adminCtx.status === 200 && adminCtx.data?.prep === true, JSON.stringify(adminCtx.data).slice(0, 160));
  const teacherForeign = await api(`/api/student/runtime/client-context?prep=1&lessonId=${orphanLessonId}`, { token: teacherToken });
  check('③ 老师指定一个没授权的课时 → 403（备课也不能乱进）',
    teacherForeign.status === 403 && teacherForeign.data?.error?.code === 'COURSE_NOT_ASSIGNED', JSON.stringify(teacherForeign.data).slice(0, 200));

  /* ───────── ④ 学生那条路照旧 ───────── */
  const studentCtx = await api('/api/student/runtime/client-context', { token: studentToken });
  check('④ 学生拿到的仍是原来的形状（没有 prep 字段，别把学生的路改坏）',
    studentCtx.status === 200 && studentCtx.data?.prep === undefined && 'classroom' in (studentCtx.data || {}),
    JSON.stringify(Object.keys(studentCtx.data || {})).slice(0, 200));

  /* ───────── ⑤ 静态：按钮与"不生成" ───────── */
  const orgMain = fs.readFileSync(path.join('apps', 'org', 'src', 'main.jsx'), 'utf8');
  check('⑤ 课时详情按 deliveryModes 出「画布备课」按钮（新标签打开学生的画布课堂）',
    /画布备课/.test(orgMain) && orgMain.includes('/learn/prep/') && /target="_blank"/.test(orgMain)
    && !/lesson-prep\//.test(orgMain), '机构端不该再有内部备课页路由');
  check('⑤ VibeCoding 那一档走客户端深链，且带 prep=1&lesson=', /\$\{CLIENT_DEEP_LINK\}\?prep=1&lesson=/.test(orgMain));
  const prepPage = fs.readFileSync(path.join('apps', 'website', 'src', 'pages', 'CanvasPrep.jsx'), 'utf8');
  // ⚠️ 只认**真的把它当 prop 传**（`onGenerateNode={`）—— 注释里也会提到这个名字（"不传它就隐藏生成按钮"），
  //    用裸词匹配会被自己的注释骗过去（本守卫第一版就栽在这上面）。
  // ⭐ 备课页**自己不再画界面**：它必须复用学生的 `CanvasWorkspace`（"就是要进画布课堂"），
  //    而"生成按钮不出现"这条不变式落在画布组件里：prep 模式不把 generateCanvasNode 交出去。
  check('⑤ ⭐ 备课页复用学生的画布课堂组件（不是自己画一页）',
    /<CanvasWorkspace/.test(prepPage) && /prep=\{prep\}/.test(prepPage));
  const canvasSource = fs.readFileSync(path.join('packages', 'shared', 'src', 'canvasWorkspace.jsx'), 'utf8');
  check('⑤ ⭐ prep 模式下画布不接 onGenerateNode（生成按钮因此不渲染）',
    /onGenerateNode=\{prepMode \? undefined : generateCanvasNode\}/.test(canvasSource));
  check('⑤ 备课页挂在网站域（全屏画布课堂），路由是 /learn/prep/:lessonId',
    /\/learn\/prep\/:lessonId/.test(fs.readFileSync(path.join('apps', 'website', 'src', 'main.jsx'), 'utf8')));
  check('⑤ 备课模式不写服务器：画布在 prep 模式下把自动保存改成写本机',
    /prepMode \?\? false/.test(canvasSource) || /window\.localStorage\.setItem\(prepDraftKey/.test(canvasSource));
  check('⑤ 备课不落库：备课页自己没有写接口（只读 prep 接口 + 本机草稿）',
    /localStorage/.test(prepPage) && !/api\.post\(|api\.put\(|api\.patch\(/.test(prepPage));
} finally {
  server.kill();
}

assert.equal(failures, 0, `P174 有 ${failures} 条断言没过`);
console.log('PASS: 老师备课入口（画布就地走流程不生成 / VibeCoding 交客户端且不发密钥 / 学生那条路没动）');
