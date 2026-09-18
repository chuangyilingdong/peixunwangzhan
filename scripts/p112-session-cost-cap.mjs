/**
 * P112 学生算力上限 —— **唯一保留的那一套，按钱的**（2026-09-18 用户口径）。
 *
 * 背景：这个平台里「学生的算力上限」被实现过 **6 遍**，其中只有 1 套真的会拦人
 * （而且它数的是**次数**不是钱）。用户 2026-09-18 定了：只留一套按钱的，删其余 5 套。
 * 本守卫钉住**留下的那一套**的全部口径（`services/sessionCostCap.js`）：
 *
 *   ① 额度内放行：已花的**已知上游成本** < 上限 → 正常调用（真的打到上游）；
 *   ② 超过后拦住：已花 ≥ 上限 → 调用前 403，错误码是**新的那套**、文案是学生看得懂的话；
 *   ③ 留空（不设上限）时不拦 —— 留空 = 不限制，**只记账**（绝不能因为没配额度就拦人）；
 *   ④ 有 UNKNOWN 成本时：**只计笔数、不按 0 计入金额**，且拦截提示里带笔数。
 *
 * 另外钉住三件"退休"的事（否则过一阵又会长回来）：
 *   · 次数上限那套（`SESSION_STUDENT_CALL_CAP` / `student_call_cap`）已退役，不许再加回来；
 *   · 课包 CU 额度那套（`services/courseCuLedger.js` + 两张 `student_course_cu_*` 表）已整体删除；
 *   · 机构端候选名单里的额度列读的是**新口径**（`poolUnlimited/poolCapYuan/poolUsedYuan`），
 *     而且"不限"只在上限**真的没配**时才出现。
 *
 * 真跑链路：建课堂（走 `POST /api/org/sessions`，上限就在 `capabilities.studentCostCapFen` 里）→
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

/* 造数（趁服务没起）：选同一个课包下的**两节**课时 ——
   ③「留空不拦」用第二节（没有上限），①②④ 用第一节（上限 200 分）。
   两节课都要声明 text 能力，否则生成前置先把请求拒了（那测的就不是额度了）。 */
const seeded = {};
{
  const db = new DatabaseSync(dbPath);
  const student = db.prepare("SELECT id, org_id FROM users WHERE login='student-2'").get();
  const grant = db.prepare('SELECT series_id FROM student_course_grants WHERE student_id=? AND revoked_at IS NULL').get(student.id);
  const lessons = db.prepare("SELECT id FROM course_lessons WHERE series_id=? AND status='PUBLISHED' ORDER BY sort").all(grant.series_id);
  assert.ok(lessons.length >= 2, '种子课包至少要有两节已发布课时才能同时验「有上限」与「留空」');
  seeded.studentId = student.id; seeded.orgId = student.org_id; seeded.seriesId = grant.series_id;
  seeded.lessonWithCapId = lessons[0].id;
  seeded.lessonNoCapId = lessons[1].id;
  for (const lesson of lessons) {
    db.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
  }
  db.close();
}

/* 假上游（OpenAI 形状）：`priced` 逐笔回 token 用量（→ 成本可折算），
   `unknown` 什么都不回（→ 成本 UNKNOWN，用来验「只计笔数、不按 0 计」）。 */
let upstreamMode = 'priced';
const upstream = { calls: 0 };
const upstreamServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  upstream.calls += 1;
  const body = { id: 'p112-payload', choices: [{ message: { role: 'assistant', content: 'P112 生成结果' } }] };
  // 100 万 input + 100 万 output × 50 分/百万 = 100 分/次（合同单价见下面的 UNIT_PRICES）
  if (upstreamMode === 'priced') body.usage = { prompt_tokens: 1000000, completion_tokens: 1000000 };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstreamServer.address().port;

const port = 19112;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
const sessionCapFen = (sessionId) => {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT student_cost_cap_fen FROM class_sessions WHERE id=?').get(sessionId);
  db.close();
  return row?.student_cost_cap_fen ?? null;
};

/** 把假上游接成唯一的 TEXT 渠道（合同单价 50 分/百万 token，进出同价）。 */
const CAP_FEN = 200;         // 每学生上限 200 分 = ¥2.00
const PER_CALL_FEN = 100;    // 每次调用 100 分 = ¥1.00
const configureUpstream = async (token) => api('/api/admin/billing-config/ai-provider', {
  method: 'PUT', token,
  body: {
    provider: 'custom', displayName: 'P112 上游', model: 'p112-model', endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
    allowStudentExternalContent: true, reason: 'P112 学生算力上限守卫',
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
  // 机构管理员：教师同一时间只能有一个未终态课堂（TEACHER_SESSION_OCCUPIED），
  // 所以「非法额度 / 空串 / 换课清额度」这几条用他来建，才不会撞上占用规则。
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(admin && teacher && orgAdmin && student, '登录失败');
  check('⓪ 配置假上游（渠道带合同单价 → 成本可折算成 COMPUTED，不是 UNKNOWN）',
    (await configureUpstream(admin)).status === 200);

  const newProject = async (lessonId) => {
    const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title: 'P112 额度' } });
    assert.ok(project.data?.id, '学生项目创建失败：' + JSON.stringify(project).slice(0, 300));
    return project.data.id;
  };
  const generate = (projectId, prompt) => api('/api/ai/generations', { method: 'POST', token: student, body: { projectId, prompt, modality: 'TEXT' } });

  /* ============ ③「留空 = 不限制」先验（先占课堂，验完结束，腾出学位给①） ============
     口径：**不填就不管，只记账** —— 花超任何数都不能拦。这也保证「不上额度的老课堂」不会被误伤。 */
  const noCapSession = (await api('/api/org/sessions', { method: 'POST', token: teacher, body: { lessonId: seeded.lessonNoCapId, title: 'P112 没配上限的课堂' } })).data;
  assert.ok(noCapSession?.id, '建课堂失败');
  check('③ 建课堂时**不传**额度 → 列就是 NULL（留空 = 不限制，不是 0）',
    sessionCapFen(noCapSession.id) === null, String(sessionCapFen(noCapSession.id)));
  check('③ 没配上限时，机构端候选名单如实说「不限」',
    (await api(`/api/org/sessions/${noCapSession.id}/candidates`, { token: teacher })).data?.selectable
      ?.find((item) => item.id === seeded.studentId)?.poolUnlimited === true);
  check('③ 学员加得进去', (await api(`/api/org/sessions/${noCapSession.id}/students`, { method: 'POST', token: teacher, body: { studentIds: [seeded.studentId] } })).data?.added?.length === 1);
  check('③ 开始上课', (await api(`/api/org/sessions/${noCapSession.id}/start`, { method: 'POST', token: teacher })).data?.status === 'ACTIVE');
  const noCapProject = await newProject(seeded.lessonNoCapId);
  const noCapCalls = [];
  for (let i = 1; i <= 3; i += 1) noCapCalls.push(await generate(noCapProject, `没配上限的第 ${i} 次（累计 ${i * PER_CALL_FEN} 分，早就超过 ${CAP_FEN} 分了）`));
  check('③ 没配上限 → 连续 3 次（累计 300 分）全部放行，一次都不拦',
    noCapCalls.every((item) => item.status === 200), JSON.stringify(noCapCalls.map((item) => item.status)));
  check('③ 但账照记（成本真的进了 compute_attempts，不是"不限额=不记账"）',
    (await api(`/api/org/sessions/${noCapSession.id}`, { token: teacher })).data?.runtime?.costCap?.usedFen === 3 * PER_CALL_FEN,
    JSON.stringify((await api(`/api/org/sessions/${noCapSession.id}`, { token: teacher })).data?.runtime?.costCap));
  check('③ 没配上限时，老师端状态里 configured=false（界面显示「不限（只记账）」）',
    (await api(`/api/org/sessions/${noCapSession.id}`, { token: teacher })).data?.runtime?.costCap?.configured === false);
  check('③ 结束没上限的课堂（腾出学位给下一场）', (await api(`/api/org/sessions/${noCapSession.id}/end`, { method: 'POST', token: teacher })).data?.status === 'ENDED');
  const retiredColumnReads = (await api(`/api/org/sessions/${noCapSession.id}`, { token: teacher })).data;
  check('③ 回显里不再有已退役的 studentCallCap（次数上限）', retiredColumnReads.studentCallCap === undefined, JSON.stringify(Object.keys(retiredColumnReads).slice(0, 40)));

  /* ============ ①②④ 有上限的课堂：上限 200 分 / 每次 100 分 ============ */
  // 先验「非法额度不许悄悄写进去」—— 用**机构管理员**建（教师同一时间只能有一个未终态课堂，
  // 拿 teacher-1 再建会被 TEACHER_SESSION_OCCUPIED 挡住，那样测的就不是额度校验了）。
  // 0 分尤其危险：0 会让"已用 ≥ 上限"永远成立，等于把整堂课的学生全拦死。
  const invalidCaps = [];
  for (const bad of [0, -5, 'abc']) {
    const attempt = await api('/api/org/sessions', {
      method: 'POST', token: orgAdmin,
      body: { lessonId: seeded.lessonWithCapId, title: `P112 非法额度 ${String(bad)}`, capabilities: { studentCostCapFen: bad } },
    });
    invalidCaps.push({ status: attempt.status, code: attempt.error?.code || null });
  }
  check('① 额度校验：0 / 负数 / 非数一律 400（不能悄悄配出一个"0 分"把人全拦死）',
    invalidCaps.every((item) => item.status === 400 && item.code === 'VALIDATION_ERROR'), JSON.stringify(invalidCaps));

  // 空串也算「没填」→ 不限制（若被当成 0 会变成"谁都别用"）
  const blankCapSession = (await api('/api/org/sessions', {
    method: 'POST', token: orgAdmin,
    body: { lessonId: seeded.lessonWithCapId, title: 'P112 空串额度', capabilities: { studentCostCapFen: '' } },
  })).data;
  check('① 空串额度 = 没填 = NULL（不限制），不是 0',
    blankCapSession?.id && sessionCapFen(blankCapSession.id) === null, String(sessionCapFen(blankCapSession?.id)));
  // 换课 → 上限清空（口径：留空 = 不限制，绝不用老课的额度顶替新课堂）。
  // 换课只在**待上课**允许，所以这条用刚建的（PENDING）课堂验。
  const swapCapSession = (await api('/api/org/sessions', {
    method: 'POST', token: orgAdmin,
    body: { lessonId: seeded.lessonWithCapId, title: 'P112 换课清额度', capabilities: { studentCostCapFen: 300 } },
  })).data;
  check('① 换课清额度：先确认它真的写进去了', sessionCapFen(swapCapSession?.id) === 300, String(sessionCapFen(swapCapSession?.id)));
  check('① 换课时上限清成 NULL（不限制），绝不用老课的额度顶替新课堂',
    (await api(`/api/org/sessions/${swapCapSession.id}`, { method: 'PUT', token: orgAdmin, body: { lessonId: seeded.lessonNoCapId, confirmClearStudents: true } })).status === 200
      && sessionCapFen(swapCapSession.id) === null, String(sessionCapFen(swapCapSession.id)));

  const cappedSession = (await api('/api/org/sessions', {
    method: 'POST', token: teacher,
    body: { lessonId: seeded.lessonWithCapId, title: 'P112 有算力上限的课堂', capabilities: { studentCostCapFen: CAP_FEN } },
  })).data;
  assert.ok(cappedSession?.id, '建带额度的课堂失败');
  check('① 建课堂时 `capabilities.studentCostCapFen` 真的落到 `class_sessions.student_cost_cap_fen`（分）',
    sessionCapFen(cappedSession.id) === CAP_FEN, String(sessionCapFen(cappedSession.id)));
  const cappedCandidates = (await api(`/api/org/sessions/${cappedSession.id}/candidates`, { token: teacher })).data;
  const candidate = cappedCandidates?.selectable?.find((item) => item.id === seeded.studentId);
  check('① 机构端候选名单读的是**新口径**：上限 200 分 / 已用 0 / 还剩 200（不再恒说"不限"）',
    candidate?.poolUnlimited === false && candidate?.poolCapYuan === CAP_FEN && candidate?.poolUsedYuan === 0 && candidate?.poolRemainYuan === CAP_FEN,
    JSON.stringify(candidate));
  check('① 学员加得进去', (await api(`/api/org/sessions/${cappedSession.id}/students`, { method: 'POST', token: teacher, body: { studentIds: [seeded.studentId] } })).data?.added?.length === 1);
  check('① 开始上课', (await api(`/api/org/sessions/${cappedSession.id}/start`, { method: 'POST', token: teacher })).data?.status === 'ACTIVE');
  const cappedProject = await newProject(seeded.lessonWithCapId);

  const call1 = await generate(cappedProject, '第 1 次：已用 0 分，应当放行');
  check('① 已用 0 < 上限 200 → 第 1 次放行（真的打到上游）', call1.status === 200, JSON.stringify(call1).slice(0, 240));
  check('① 第 1 次确实花了 100 分（按合同单价折算，不是次数）',
    (await api(`/api/org/sessions/${cappedSession.id}`, { token: teacher })).data?.runtime?.costCap?.usedFen === PER_CALL_FEN);

  // ④ UNKNOWN：上游这一笔什么都不回 → 成本未知。它必须**只计笔数、不按 0 计入金额**。
  upstreamMode = 'unknown';
  const unknownCall = await generate(cappedProject, '第 2 次：上游不回用量 → 成本 UNKNOWN');
  upstreamMode = 'priced';
  check('④ 成本未知的那一笔仍然放行（不能因为"算不出钱"就把学生拦死）', unknownCall.status === 200, JSON.stringify(unknownCall).slice(0, 240));
  const afterUnknown = (await api(`/api/org/sessions/${cappedSession.id}`, { token: teacher })).data?.runtime?.costCap;
  check('④ 已用金额**不把 UNKNOWN 按 0 记账**：仍是 100 分（不是 100+0 的"两次"）',
    afterUnknown?.usedFen === PER_CALL_FEN, JSON.stringify(afterUnknown));
  check('④ 未知笔数如实统计：unknownCalls = 1，且 costIncomplete = true（金额只是下界）',
    afterUnknown?.unknownCalls === 1 && afterUnknown?.costIncomplete === true, JSON.stringify(afterUnknown));

  const call3 = await generate(cappedProject, '第 3 次：已用 100 < 200，应当放行');
  check('① 已用 100 < 上限 200 → 第 3 次放行', call3.status === 200, JSON.stringify(call3).slice(0, 240));
  check('① 已用正好 200 分（两次有价调用；UNKNOWN 那笔没被算成钱）',
    (await api(`/api/org/sessions/${cappedSession.id}`, { token: teacher })).data?.runtime?.costCap?.usedFen === CAP_FEN);

  const upstreamBeforeBlocked = upstream.calls;
  const blocked = await generate(cappedProject, '第 4 次：已用 200 ≥ 上限 200 → 应当被拦');
  check('② 已用 ≥ 上限 → 拦住（403）', blocked.status === 403, JSON.stringify(blocked).slice(0, 240));
  check('② 错误码是**新的那套**（按钱的），不是已退役的次数上限',
    blocked.error?.code === 'SESSION_STUDENT_COST_CAP_EXHAUSTED', String(blocked.error?.code));
  check('② 拦截发生在**调用前**：被拦的这一次没有打到上游（不白花渠道的钱）',
    upstream.calls === upstreamBeforeBlocked, `上游 ${upstreamBeforeBlocked} → ${upstream.calls}`);
  const message = String(blocked.error?.message || '');
  check('② 文案是学生看得懂的话：说清上限、已用、怎么处理',
    /本课堂/.test(message) && /上限/.test(message) && /已用/.test(message) && /老师/.test(message), message);
  check('② 文案里带"还有 1 笔成本未知"（不是把不知道说成没花钱）',
    /1 笔.*成本未知/.test(message), message);
  check('② 用的不是退役那套机器码（COURSE_CU_EXHAUSTED / SESSION_STUDENT_CALL_CAP）',
    !/COURSE_CU_EXHAUSTED|SESSION_STUDENT_CALL_CAP/.test(message), message);
  check('② 拦截发生在调用前：没有留下任何"失败的上游调用"（额度不是上游故障）',
    (() => { const db = new DatabaseSync(dbPath); const n = db.prepare('SELECT COUNT(*) n FROM compute_attempts WHERE class_session_id=?').get(cappedSession.id).n; db.close(); return n === 3; })(),
    '本课堂 attempt 行数应为 3（2 次有价 + 1 次未知）');
  check('② 被拦的这次按 **BLOCKED** 归类（不是上游故障）——两条入口的拦截码都在 BLOCKED_ERROR_CODES 里',
    /'SESSION_STUDENT_COST_CAP_EXHAUSTED'/.test(fs.readFileSync(path.join(root, 'apps/server/src/routes/aiGeneration.js'), 'utf8')));
  // 异步入口也必须拦住（同一个 assertGenerationPreflight，但不能只验一条入口）
  const asyncBlocked = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: cappedProject, prompt: '异步入口也该被拦', modality: 'TEXT' } });
  check('② 异步入口（排产前预检）同样拦住，错误码一致、且不建任务',
    asyncBlocked.status === 403 && asyncBlocked.error?.code === 'SESSION_STUDENT_COST_CAP_EXHAUSTED', JSON.stringify(asyncBlocked).slice(0, 200));
  check('② 被拦的异步请求没有生成 job（拦在入队前）',
    (() => { const db = new DatabaseSync(dbPath); const n = db.prepare("SELECT COUNT(*) n FROM generation_jobs WHERE project_id=? AND error_code='SESSION_STUDENT_COST_CAP_EXHAUSTED'").get(cappedProject).n; db.close(); return n === 0; })());

  /* 学生端 / 老师端都要能看到「这堂课还剩多少额度 / 已用多少」 */
  const center = (await api('/api/ai/center', { token: student })).data;
  const centerSession = (center?.activeSessions || []).find((item) => item.id === cappedSession.id);
  check('② 学生端 /api/ai/center 看到本课堂额度：已用 200 / 上限 200 / 还剩 0 / 1 笔未知',
    centerSession?.costCap?.configured === true && centerSession?.costCap?.usedFen === CAP_FEN
      && centerSession?.costCap?.capFen === CAP_FEN && centerSession?.costCap?.remainFen === 0 && centerSession?.costCap?.unknownCalls === 1,
    JSON.stringify(centerSession?.costCap));
  check('② 学生端能力列表把额度用尽如实标成不可用，理由就是那一句人话',
    (center?.capabilities || []).some((item) => item.available === false && /本课堂/.test(item.reasons.join(' '))),
    JSON.stringify((center?.capabilities || []).map((item) => item.reasons)));
  const detail = (await api(`/api/org/sessions/${cappedSession.id}`, { token: teacher })).data;
  check('② 老师端课堂详情：本课堂配置的上限 + 整场已花都看得到',
    detail?.runtime?.costCap?.configured === true && detail?.runtime?.costCap?.capFen === CAP_FEN && detail?.runtime?.costCap?.usedFen === CAP_FEN,
    JSON.stringify(detail?.runtime?.costCap));
  check('② 老师端名单里那个学生：已用 200 / 上限 200 / 还剩 0 / 1 笔未知',
    (() => { const mine = (detail?.students || []).find((item) => item.studentId === seeded.studentId)?.ai?.costCap;
      return mine?.usedFen === CAP_FEN && mine?.remainFen === 0 && mine?.unknownCalls === 1 && mine?.configured === true; })(),
    JSON.stringify((detail?.students || []).find((item) => item.studentId === seeded.studentId)?.ai?.costCap));

  // 换课清额度那条在 ① 段已经验过（只能在「待上课」换课，这里已 ACTIVE）

  /* 退休清单：不许悄悄长回来 */
  Object.assign(process.env, baseEnv);
  const capApi = await import('../apps/server/src/services/sessionCostCap.js');
  check('退休 ①：课包 CU 额度那套 service 已删除（services/courseCuLedger.js）',
    !fs.existsSync(path.join(root, 'apps/server/src/services/courseCuLedger.js')));
  check('退休 ①：两个 CU 导出（reserve/settle/release CourseCu）全仓零定义',
    [capApi.reserveCourseCu, capApi.settleCourseCu, capApi.releaseCourseCu].every((item) => item === undefined));
  const aiControls = fs.readFileSync(path.join(root, 'apps/server/src/services/aiControls.js'), 'utf8');
  const aiGeneration = fs.readFileSync(path.join(root, 'apps/server/src/routes/aiGeneration.js'), 'utf8');
  check('退休 ②：次数上限的**读写代码**不许加回来（注释里提"已退役"不算回退）',
    !/session\.studentCallCap/.test(aiControls) && !/'SESSION_STUDENT_CALL_CAP'/.test(aiGeneration)
      && !/session\.student_call_cap/.test(fs.readFileSync(path.join(root, 'apps/server/src/services/studentContext.js'), 'utf8')),
    'aiControls.js / aiGeneration.js / studentContext.js');
  const schema = fs.readFileSync(path.join(root, 'packages/database/src/schema.js'), 'utf8');
  check('退休 ③：两张 CU 表不再建（CREATE 已删），但也**不写 DROP**（老库数据保留）',
    !/CREATE TABLE IF NOT EXISTS student_course_cu_(quotas|ledger)/.test(schema) && !/DROP TABLE[^;]*student_course_cu/.test(schema));
  check('退休 ④：`student_call_cap` 列本身保留（老库有数据），只是在注释里标明已退役',
    /student_call_cap INTEGER/.test(schema) && /已退役/.test(schema));
  check('保留唯一来源：新列 `student_cost_cap_fen` 在 schema 里有建表与老库补列两处',
    /student_cost_cap_fen INTEGER/.test(schema) && /ALTER TABLE class_sessions ADD COLUMN student_cost_cap_fen/.test(schema));
} catch (error) {
  console.error(serverLog.slice(-4000));
  throw error;
} finally {
  server.kill('SIGTERM');
  upstreamServer.close();
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
