/**
 * P112 学生算力额度 —— **只观测、不真拦**（2026-09-18 用户口径）。
 *
 * 用户原话：「**学生算力额度的设置目前都是不真拦，都是给我们内部看的。**」
 * 「学生的算力上限」历史上被实现过 **6 遍**：2026-09-18 先收敛成「只留一套按钱的」，
 * 同日更正为「这一套也**不拦人**」——本守卫钉住的是**最终口径**：
 *
 *   ⚠️ 这套额度**不是闸门**，是运营观测指标（与 `computePool.classroomBudgetStatus` 的
 *      `enforced: false` 同一性质）。所以本守卫**刻意不再断言"被拦住"**，
 *      而是反过来断言**超过观测上限也必须照旧放行**：
 *
 *   ① 超过观测上限照旧放行：已用金额越过观测上限之后，**下一次仍然 200**，
 *      而且**真的打到了上游**（不是被静默跳过、也不是缓存命中）——这是本轮最要紧的一条；
 *   ② 状态里 `exceeded === true` 而 `enforced === false`，且 `usedFen` / `unknownCalls`
 *      照实反映（超了必须**看得见**，否则观测就没意义）；
 *   ③ 留空（不设观测上限）时行为与配了的一样：**都放行**，只是状态 `configured: false`；
 *   ④ 有 `UNKNOWN` 成本时**只计笔数、不按 0 计入金额**（`costIncomplete: true`，笔数带在状态里）。
 *
 * 另外钉住「不许偷偷变回闸门」的六件事：
 *   · 全仓再也搜不到那个"按钱的额度"错误码（下面用拼接构造它的名字 —— 连守卫里都不留字面量，
 *     这样 `grep -rn <那个码>` 全仓为空才算真的清干净了）；
 *   · `BLOCKED_ERROR_CODES` 里没有任何额度码；
 *   · 生成链路与 `routes/ai.js` 里**不再有**任何额度断言；观测状态 `enforced` 恒 false；
 *   · **学生端负载里没有额度**（`/api/ai/center` 的 activeSessions 不带 costCap、
 *     能力不可用理由里没有额度文案）—— 学生看不到内部额度，也不会被它拦；
 *   · 机构端那个输入与列都**保留**（列/外键不删），标签已改成"观测"口径；
 *   · 老师端两处文案必须写着"不拦学生"，不许留下"还剩多少额度/已用尽"这种像闸门的话。
 *
 * 真跑链路：建课堂（走 `POST /api/org/sessions`，观测上限在 `capabilities.studentCostCapFen` 里）→
 * 加学员 → 开始上课 → 学生建项目 → 逐次生成（假上游返回真实 token 用量 → 成本按合同单价折算）。
 * 全部走真实接口，只通过 `DatabaseSync` **读**库复核落列（不插库绕门禁）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p112-session-cost-cap-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'development', AI_PROVIDER: 'local-mock', AI_PROVIDER_API_KEY: 'p112-direct-secret-key',
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
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

/* 造数（趁服务没起）：同一个课包下的**两节**课时 ——
   ①②④ 用第一节（配了观测上限 200 分），③ 用第二节（不设观测上限）。
   两节都要声明 text 能力，否则生成前置先把请求拒了（那测的就不是额度了）。 */
const seeded = {};
{
   
  const student = await arow("SELECT id, org_id FROM users WHERE login='student-2'");
  const grant = await arow('SELECT series_id FROM student_course_grants WHERE student_id=? AND revoked_at IS NULL', [student.id]);
  const lessons = await arows("SELECT id FROM course_lessons WHERE series_id=? AND status='PUBLISHED' ORDER BY sort", [grant.series_id]);
  assert.ok(lessons.length >= 2, '种子课包至少要有两节已发布课时才能同时验「配了观测上限」与「留空」');
  seeded.studentId = student.id; seeded.orgId = student.org_id; seeded.seriesId = grant.series_id;
  seeded.lessonWithCapId = lessons[0].id;
  seeded.lessonNoCapId = lessons[1].id;
  for (const lesson of lessons) {
    await aq("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))", [lesson.id]);
  }
  
}

/* 假上游（OpenAI 形状）：`priced` 逐笔回 token 用量（→ 成本可折算），
   `unknown` 什么都不回（→ 成本 UNKNOWN，用来验「只计笔数、不按 0 计」）。 */
let upstreamMode = 'priced';
const upstream = { calls: 0 };
const upstreamServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  upstream.calls += 1;
  const body = { id: 'p112-payload', choices: [{ message: { role: 'assistant', content: 'P112 生成结果' } }] };
  // 100 万 input + 100 万 output × 50 分/百万 = 100 分/次（合同单价见下面的配置）
  if (upstreamMode === 'priced') body.usage = { prompt_tokens: 1000000, completion_tokens: 1000000 };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstreamServer.address().port;

const port = 19114;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
const sessionCapFen = async (sessionId) => {
   
  const row = await arow('SELECT student_cost_cap_fen FROM class_sessions WHERE id=?', [sessionId]);
  
  return row?.student_cost_cap_fen ?? null;
};
const attemptsOf = async (sessionId) => {
   
  const n = (await arow('SELECT COUNT(*) n FROM compute_attempts WHERE class_session_id=?', [sessionId])).n;
  
  return Number(n);
};
/** 这场课堂在老师端看到的观测状态（每个学生一份 + 整场一份都从接口拿，不自己算）。 */
const capStatusOf = async (token, sessionId) => (await api(`/api/org/sessions/${sessionId}`, { token })).data?.runtime?.costCap;

/** 把假上游接成唯一的 TEXT 渠道（合同单价 50 分/百万 token，进出同价）。 */
const CAP_FEN = 200;         // 观测上限 200 分 = ¥2.00（**只是分母，不拦人**）
const PER_CALL_FEN = 100;    // 每次调用 100 分 = ¥1.00
const configureUpstream = async (token) => api('/api/admin/billing-config/ai-provider', {
  method: 'PUT', token,
  body: {
    provider: 'custom', displayName: 'P112 上游', model: 'p112-model', endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
    allowStudentExternalContent: true, reason: 'P112 学生算力观测守卫',
    channels: [{
      id: 'p112-main', name: 'P112 渠道', provider: 'custom', model: 'p112-model',
      models: ['p112-model'], endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
      upstreamUnitPrices: { TEXT: { inputFenPer1MTokens: 50, outputFenPer1MTokens: 50 } },
    }],
    modalityChannels: { TEXT: 'p112-main' },
  },
});

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const teacher = (await api('/api/auth/login', { method: 'POST', body: { login: 'teacher-1', password: 'teach123' } })).data.token;
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(admin && teacher && orgAdmin && student, '登录失败');
  check('⓪ 配置假上游（渠道带合同单价 → 成本可折算成 COMPUTED，不是 UNKNOWN）',
    (await configureUpstream(admin)).status === 200);

  const newProject = async (lessonId) => {
    const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title: 'P112 观测' } });
    assert.ok(project.data?.id, '学生项目创建失败：' + JSON.stringify(project).slice(0, 300));
    return project.data.id;
  };
  const generate = (projectId, prompt) => api('/api/ai/generations', { method: 'POST', token: student, body: { projectId, prompt, modality: 'TEXT' } });

  /* ================== 配了观测上限的课堂：①②④ ================== */
  // 非法值仍拒绝：不是"拦学生"，而是不许写进一个假分母（0 分会让"已超"永远为真）。
  const invalidCaps = [];
  for (const bad of [0, -5, 'abc']) {
    const attempt = await api('/api/org/sessions', {
      method: 'POST', token: orgAdmin,
      body: { lessonId: seeded.lessonWithCapId, title: `P112 非法数字 ${String(bad)}`, capabilities: { studentCostCapFen: bad } },
    });
    invalidCaps.push({ status: attempt.status, code: attempt.error?.code || null });
  }
  check('⓪ 观测上限只接受正整数：0 / 负数 / 非数一律 400（不许写进一个假分母）',
    invalidCaps.every((item) => item.status === 400 && item.code === 'VALIDATION_ERROR'), JSON.stringify(invalidCaps));

  const cappedSession = (await api('/api/org/sessions', {
    method: 'POST', token: teacher,
    body: { lessonId: seeded.lessonWithCapId, title: 'P112 配了数字的课堂', capabilities: { studentCostCapFen: CAP_FEN } },
  })).data;
  assert.ok(cappedSession?.id, '建带观测上限的课堂失败');
  check('⓪ 建课堂时 `capabilities.studentCostCapFen` 落到 `class_sessions.student_cost_cap_fen`（分，观测口径）',
    await sessionCapFen(cappedSession.id) === CAP_FEN, String(await sessionCapFen(cappedSession.id)));
  const candidates = (await api(`/api/org/sessions/${cappedSession.id}/candidates`, { token: teacher })).data;
  const candidate = candidates?.selectable?.find((item) => item.id === seeded.studentId);
  check('⓪ 机构端候选名单带观测数字（已用 0 / 观测上限 200）且明写不拦人（poolEnforced=false）',
    candidate?.poolCapYuan === CAP_FEN && candidate?.poolUsedYuan === 0 && candidate?.poolEnforced === false,
    JSON.stringify(candidate));
  check('⓪ 学员加得进去', (await api(`/api/org/sessions/${cappedSession.id}/students`, { method: 'POST', token: teacher, body: { studentIds: [seeded.studentId] } })).data?.added?.length === 1);
  check('⓪ 开始上课', (await api(`/api/org/sessions/${cappedSession.id}/start`, { method: 'POST', token: teacher })).data?.status === 'ACTIVE');
  const cappedProject = await newProject(seeded.lessonWithCapId);

  const call1 = await generate(cappedProject, '第 1 次：已用 0 分');
  check('① 第 1 次放行且真的打到上游', call1.status === 200 && await attemptsOf(cappedSession.id) === 1, JSON.stringify(call1).slice(0, 200));
  check('① 第 1 次确实记了 100 分（按合同单价折算，不是次数）',
    (await capStatusOf(teacher, cappedSession.id))?.usedFen === PER_CALL_FEN);

  // ④ UNKNOWN：这一笔上游什么都不回 → 成本未知，必须只计笔数、不按 0 计入金额
  upstreamMode = 'unknown';
  const unknownCall = await generate(cappedProject, '第 2 次：上游不回用量 → 成本 UNKNOWN');
  upstreamMode = 'priced';
  const afterUnknown = await capStatusOf(teacher, cappedSession.id);
  check('④ 成本未知的那一笔照常放行（观测口径下更没有任何理由挡它）', unknownCall.status === 200, JSON.stringify(unknownCall).slice(0, 200));
  check('④ 已用金额**不把 UNKNOWN 按 0 记账**：仍是 100 分（不是 100+0 的"两次"）',
    afterUnknown?.usedFen === PER_CALL_FEN, JSON.stringify(afterUnknown));
  check('④ 未知笔数如实统计：unknownCalls = 1 且 costIncomplete = true（金额只是下界）',
    afterUnknown?.unknownCalls === 1 && afterUnknown?.costIncomplete === true, JSON.stringify(afterUnknown));

  const call3 = await generate(cappedProject, '第 3 次：已用 100 < 200');
  check('① 第 3 次放行（此时已用 100，还没到观测上限）', call3.status === 200, JSON.stringify(call3).slice(0, 200));
  const atCap = await capStatusOf(teacher, cappedSession.id);
  check('② 已用正好 200 分 = 观测上限 → `exceeded: true` 但 `enforced: false`（超了看得见，但不拦）',
    atCap?.usedFen === CAP_FEN && atCap?.exceeded === true && atCap?.enforced === false, JSON.stringify(atCap));

  /* ★ 本轮最要紧的一条：**超过观测上限照旧放行，并且真的打到上游** ★ */
  const upstreamBeforeOver = upstream.calls;
  const overCap = await generate(cappedProject, '第 4 次：已用 200 ≥ 观测上限 200 —— 观测口径下必须照旧放行');
  const overAtt = await attemptsOf(cappedSession.id);
  check('①★ 已用 ≥ 观测上限之后**仍然 200**（额度只观测、不真拦）',
    overCap.status === 200, JSON.stringify(overCap).slice(0, 240));
  check('①★ 这一次**真的打到了上游**（不是被静默跳过/缓存命中）',
    upstream.calls === upstreamBeforeOver + 1, `上游 ${upstreamBeforeOver} → ${upstream.calls}`);
  check('①★ compute_attempts 也如实多了一行（这次调用留下了成本证据）', overAtt === 4, String(overAtt));
  const afterOver = await capStatusOf(teacher, cappedSession.id);
  check('② 超限之后数字继续往上走（300 分 / 150%）——超了要看得见，且不改变任何准入结果',
    afterOver?.usedFen === 3 * PER_CALL_FEN && afterOver?.usagePercent === 150 && afterOver?.exceeded === true && afterOver?.enforced === false,
    JSON.stringify(afterOver));
  const overCapAgain = await generate(cappedProject, '第 5 次：继续超，继续必须放行');
  check('①★ 再超一次也照旧放行（不是"只放行一次"的假动作）',
    overCapAgain.status === 200 && await attemptsOf(cappedSession.id) === 5, JSON.stringify(overCapAgain).slice(0, 200));

  /* 学生端：不该知道内部额度，更不该因为额度被标成"不可用" */
  const center = (await api('/api/ai/center', { token: student })).data;
  const centerSession = (center?.activeSessions || []).find((item) => item.id === cappedSession.id);
  check('⓪ 学生端 activeSessions **不带** costCap（额度是内部看的，学生看不到）',
    centerSession !== undefined && centerSession.costCap === undefined && !('student_cost_cap_fen' in centerSession),
    JSON.stringify(centerSession));
  check('⓪ 学生端能力列表里没有额度类文案（既没"上限"也没"额度已用完"），且可用性不受额度影响',
    (center?.capabilities || []).every((item) => !/额度|上限|用尽|用完/.test(item.reasons.join(' ')))
      && (center?.capabilities || []).some((item) => item.available === true),
    JSON.stringify((center?.capabilities || []).map((item) => ({ available: item.available, reasons: item.reasons }))));
  const centerJson = JSON.stringify(center);
  const centerHit = centerJson.match(/studentCostCapFen|costCap|观测上限|student_call_cap/);
  check('⓪ 学生端 /api/ai/center 整个负载里搜不到内部额度字眼',
    centerHit === null && !/costCap/.test(centerJson), `命中：${centerHit?.[0]}`);

  /* 老师端：数字保留，并且明写"不拦人" */
  const detail = (await api(`/api/org/sessions/${cappedSession.id}`, { token: teacher })).data;
  // 到这一刻：有价调用 4 次（第 1/3/4/5 次）× 100 分 = 400 分；UNKNOWN 那次不计金额、只计笔数。
  check('② 老师端课堂详情：本课堂的观测数字都在（配置/已用/超限标记/不拦人）',
    detail?.runtime?.costCap?.configured === true && detail?.runtime?.costCap?.capFen === CAP_FEN
      && detail?.runtime?.costCap?.usedFen === 4 * PER_CALL_FEN && detail?.runtime?.costCap?.usagePercent === 200
      && detail?.runtime?.costCap?.exceeded === true && detail?.runtime?.costCap?.enforced === false,
    JSON.stringify(detail?.runtime?.costCap));
  const mine = (detail?.students || []).find((item) => item.studentId === seeded.studentId)?.ai?.costCap;
  check('② 老师端名单里那个学生：已用 400 / 观测上限 200 / 1 笔未知 / enforced=false',
    mine?.usedFen === 4 * PER_CALL_FEN && mine?.capFen === CAP_FEN && mine?.unknownCalls === 1 && mine?.enforced === false,
    JSON.stringify(mine));

  check('⓪ 结束这堂课（腾出学位给「留空」那一段）', (await api(`/api/org/sessions/${cappedSession.id}/end`, { method: 'POST', token: teacher })).data?.status === 'ENDED');

  /* ================== ③ 不设观测上限的课堂：行为与配了一样，都放行 ================== */
  const noCapSession = (await api('/api/org/sessions', { method: 'POST', token: teacher, body: { lessonId: seeded.lessonNoCapId, title: 'P112 没配数字的课堂' } })).data;
  assert.ok(noCapSession?.id, '建"不设观测上限"的课堂失败');
  check('③ 不传观测上限 → 列就是 NULL（不设上限，不是 0）',
    await sessionCapFen(noCapSession.id) === null, String(await sessionCapFen(noCapSession.id)));
  check('③ 学员加得进去', (await api(`/api/org/sessions/${noCapSession.id}/students`, { method: 'POST', token: teacher, body: { studentIds: [seeded.studentId] } })).data?.added?.length === 1);
  check('③ 开始上课', (await api(`/api/org/sessions/${noCapSession.id}/start`, { method: 'POST', token: teacher })).data?.status === 'ACTIVE');
  const noCapProject = await newProject(seeded.lessonNoCapId);
  const noCapCalls = [];
  for (let i = 1; i <= 3; i += 1) noCapCalls.push(await generate(noCapProject, `不设观测上限的第 ${i} 次`));
  check('③ 不设观测上限 → 连续 3 次全部放行（与配了上限的课堂**行为完全一样**：都不拦）',
    noCapCalls.every((item) => item.status === 200), JSON.stringify(noCapCalls.map((item) => item.status)));
  const noCapStatus = await capStatusOf(teacher, noCapSession.id);
  check('③ 只是状态显示 `configured: false`（没有分母），已用金额照记、enforced 恒 false',
    noCapStatus?.configured === false && noCapStatus?.capFen === null && noCapStatus?.usedFen === 3 * PER_CALL_FEN
      && noCapStatus?.enforced === false,
    JSON.stringify(noCapStatus));

  /* ================== 不许偷偷变回闸门 ================== */
  Object.assign(process.env, baseEnv);
  const aiGeneration = fs.readFileSync(path.join(root, 'apps/server/src/routes/aiGeneration.js'), 'utf8');
  const aiRoute = fs.readFileSync(path.join(root, 'apps/server/src/routes/ai.js'), 'utf8');
  const sessionCostCap = fs.readFileSync(path.join(root, 'apps/server/src/services/sessionCostCap.js'), 'utf8');
  const orgAdminSource = fs.readFileSync(path.join(root, 'apps/server/src/routes/orgAdmin.js'), 'utf8');
  // 拼接构造这个错误码的名字：**故意不写字面量**，这样 `grep -rn <那个码>` 全仓为空，
  // 才算真的"清干净了"（守卫自己也不该是唯一还留着它的地方）。
  const RETIRED_CAP_CODE = ['SESSION', 'STUDENT', 'COST', 'CAP', 'EXHAUSTED'].join('_');
  check('退休 ①：额度类错误码全仓已清空（生成链路 / ai 路由 / 本 service 都没有它）',
    ![aiGeneration, aiRoute, sessionCostCap].some((source) => source.includes(RETIRED_CAP_CODE)));
  // 全仓（apps/server/src 下的所有 .js，递归）都不该再出现这个码
  const sourceFilesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
  const offenders = sourceFilesUnder(path.join(root, 'apps/server/src')).filter((file) => fs.readFileSync(file, 'utf8').includes(RETIRED_CAP_CODE));
  check("退休 ①'：这个错误码在 apps/server/src 全量源码里都不出现（守卫用拼接的名字去搜）",
    offenders.length === 0, offenders.join('、'));
  check('退休 ②：BLOCKED_ERROR_CODES 里没有任何额度码（额度不再是拦截理由）',
    (() => {
      const line = aiGeneration.split('\n').find((item) => item.includes('const BLOCKED_ERROR_CODES')) || '';
      return !/COST_CAP|CALL_CAP|QUOTA/.test(line);
    })(),
    aiGeneration.split('\n').find((item) => item.includes('const BLOCKED_ERROR_CODES')) || '（没找到这行！）');
  check('退休 ③：生成链路与 ai 路由都**不再调用**额度断言，service 里也没有 assert 导出',
    !/assertSessionCostCap/.test(aiGeneration) && !/assertSessionCostCap/.test(aiRoute)
      && !/export function assertSessionCostCap/.test(sessionCostCap));
  check('退休 ④：观测状态里 `enforced` 恒为 false（这就是"不拦人"的机器可读承诺）',
    /enforced: false/.test(sessionCostCap));
  const capApi = await import('../apps/server/src/services/sessionCostCap.js');
  const pureStatus = await capApi.sessionCostCapStatus({ sessionId: cappedSession.id, studentId: seeded.studentId });
  check('退休 ④：读状态是个纯读函数（调用它不抛错、不改任何东西），且 enforced 恒 false',
    pureStatus?.enforced === false && pureStatus?.exceeded === true, JSON.stringify(pureStatus));
  check('退休 ⑤：机构端那个输入还在（列不删、入口不删），标签已改成"观测"口径',
    /student_cost_cap_fen/.test(orgAdminSource) && /算力观测上限/.test(orgAdminSource));
  const schema = fs.readFileSync(path.join(root, 'packages/database/src/schema.js'), 'utf8');
  check('退休 ⑤：列与外键都没删（student_cost_cap_fen 的建表 + 老库补列两处都在）',
    /student_cost_cap_fen INTEGER/.test(schema) && /ALTER TABLE class_sessions ADD COLUMN student_cost_cap_fen/.test(schema));
  const orgDetail = fs.readFileSync(path.join(root, 'apps/org/src/pages/classroom/ClassroomDetail.jsx'), 'utf8');
  const orgAdd = fs.readFileSync(path.join(root, 'apps/org/src/pages/classroom/AddClassroomStudents.jsx'), 'utf8');
  // ⎠ 2026-09-20 用户口径：老师端那套观测文案（“已用 / 观测上限 / 不拦学生”）
  //    已**整块删除**（课堂详情的「本课堂每学生算力」、加学生页的算力列都没了）。
  //    所以这条断言反过来：老师端**不出现任何观测类字样**，当然更不能出现像闸门的话。
  //    （旧断言要求两处必须写明“不拦学生”—— 文案都删了，那句话反而会把回到旧样子的改动放过去）
  const gateWords = /额度已经用完|已用尽|请找老师/;
  const observWords = /不拦学生|未设观测上限|观测上限|还剩|poolText|poolUsedYuan/;
  check('退休 ⑥：老师端不再展示这套算力观测（也没有像闸门的话）',
    !observWords.test(orgDetail) && !observWords.test(orgAdd)
      && !gateWords.test(orgDetail) && !gateWords.test(orgAdd));
} catch (error) {
  console.error(serverLog.slice(-4000));
  throw error;
} finally {
  server.kill('SIGTERM');
  upstreamServer.close();
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
