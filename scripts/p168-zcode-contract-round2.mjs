/**
 * P168 「ZCode 客户端契约（2026-09-29 第二版）」的平台侧守卫 —— 2026-09-29。
 *
 * 客户端这一版契约把「平台侧待办」写成 7 条，其中 1 / 2 / 5 是**平台侧不许变**的东西，
 * 作品提交那一节另外点名要 `works`。p166 已经钉了网关那半边（真请求：一轮文本 + 两轮 tool call +
 * 缓存字段 + 耗时日志），p118 钉了发送次数的判据与 429，**这一道钉剩下这半边**：
 *
 *   ① **5 个接口路径逐字不变**（客户端按这些路径写死的）：不是"源码里写着"就算，而是**真打一遍** ——
 *      未登录时必须是 401、坏请求体时必须是 400，**不能是 404**（404 说明路径被改走了）。
 *   ② `client-context` 的形状：`gateway.baseUrl` **不含** `/chat/completions`（客户端自己拼）、
 *      `classroom{id,lessonId,title}`、`models[{id,displayName}]`、`defaultModel`、`presets[{title,text}]`、
 *      `sends{limit,used,remaining}`；并且**不带任何 DSH 字段**（契约第 7 条：客户端不许依赖
 *      session / profile / Cordis / patchFiles）。
 *   ③ `sends.limit` 的三档语义：不配 → `null`（不限）；配 **0 → 仍是 `null`**（平台口径：
 *      "不填或填 0 = 不限次"，见后台表单；**平台从不下发 0** —— 客户端的 `limit=0` 是它自己本机投影
 *      才有的取值，契约第 3 条要的是"别用 0 表示不限"，平台满足）；配 2 → `limit=2`、`remaining=2`。
 *      顺带把不变量钉住：`limit` 要么是 `null`，要么是**正整数**。
 *   ④ `submit-upload` 的响应里有 **`works`**（本轮补的，见 §六十六后的那一轮）：它是"这次交上来了哪几条"，
 *      客户端拿它直接回显。最关键的一条断言是**形状同源** —— `works[0]` 的键集合必须与
 *      `/api/student/works` 里同一条**完全相同**（两边各拼一份对象字面量的话，迟早只在一半上对上）。
 *   ⑤ 封面失败**不阻断**：带一张超限的封面 → `warnings` 里有封面提示，但 `works` 照常回。
 *
 * ⚠️ 客户端那句 `workspacePath`（契约里标"可选"）平台**不下发**：学生本机的工作区目录只有客户端知道，
 *    平台这边没有这个概念（客户端的 Main 自己算 identity）。这条断言把"平台不下发它"钉住 ——
 *    哪天要下发，先改契约再说（别悄悄加一个字段让客户端去猜）。
 *
 * 跑法：node scripts/p168-zcode-contract-round2.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p168-zcode-'));
const dbPath = path.join(temp, 'platform.db');
// ⚠️ 硬设（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const PORT = 18968;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p168-guard-secret',
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

const checks = [];
// ⚠️ 必须 await：断言里有 async（打接口、读库），同步的 check 抓不到 Promise 里的异常。
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);
let lessonId = '';
{
  await aq("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);
  // 课堂的 delivery_mode 也要跟着改：运行时接口只看 VIBECODING 课堂（否则这个守卫会被自己的门禁挡住）。
  await aq("UPDATE class_sessions SET delivery_mode='VIBECODING'");
  // 模型清单的夹具备料：`/client-context` 只下发 TEXT 渠道**实际启用**的模型，且 displayName
  // 优先取运营配的别名（客户端用 displayName 显示、用 id 发上游）。
  await aq('UPDATE platform_settings SET ai_provider_policy=? WHERE id=1', [JSON.stringify({
    provider: 'local-mock',
    channels: [{
      id: 'p168-text', provider: 'local-mock', model: 'p168-flash',
      models: ['p168-flash', 'p168-pro'],
      modelMappings: [
        { id: 'p168-flash', displayName: '上游名（有别名时不该赢）' },
        { id: 'p168-pro', displayName: '上游给的名字' },
      ],
    }],
    modalityChannels: { TEXT: 'p168-text' },
    modelDisplayNames: { 'p168-flash': '运营改的别名' },
  })]);
  // ⚠️ 课时**不在这里取**：`class_sessions` 里可能还有别的 ACTIVE 课堂，按"最近创建"抓一条会配到
  //    别的课时上 —— 配错时 ③ 的"配 0 → null"会因为 limit 一直是 null 而**假绿**（第一版就是这么错的，
  //    靠"配 2 → 2"这条正例才抓到）。这里只改数据面，课时等登录后按**这个学生自己的课堂**取。
}

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-800)}`);
    await sleep(150);
  }

  /* ── ① 5 个接口路径逐字不变（真打一遍，看是不是 404）────────────────── */
  console.log('\n① 契约点名的 5 个路径：都在、都不是 404');
  const paths = [
    ['/api/auth/login', { method: 'POST', body: {} }, [400, 401]],
    ['/api/auth/logout', { method: 'POST', body: {} }, [401, 403]],
    ['/api/student/runtime/client-context', {}, [401, 403]],
    ['/api/student/runtime/submit-upload', { method: 'POST', body: {} }, [401, 403]],
    ['/api/student/works?page=1&limit=20', {}, [401, 403]],
  ];
  for (const [pathname, options, expected] of paths) {
    const result = await api(pathname, options);
    await check(`① ${options.method || 'GET'} ${pathname} → ${result.status}（未登录必须是 ${expected.join('/')}，不是 404）`,
      () => assert.ok(expected.includes(result.status), `拿到 ${result.status}：${JSON.stringify(result.raw).slice(0, 160)}`));
  }

  // ⚠️ 必须照服务端 `resolveClassroomEntry` 自己的选择规则取（`ORDER BY session.started_at DESC,
  //    session.created_at DESC` 的第一条）：一个学生可能挂着一场以上的 ACTIVE 课堂，
  //    而**夹具按"最早的学生"抓一条**时，连"哪个学生"都可能不是我登录的那个 —— 第一版就这么配错了，
  //    配置落在另一节课上 → ③ 的"配 0 → null"整段**假绿**（靠"配 2 → 2"这条正例和下面那条同课断言才抓到）。
  const enrolled = await arow(`SELECT student.id AS student_id, student.login FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id AND session.status='ACTIVE'
       JOIN users student ON student.id = part.student_id
      WHERE part.status='ACTIVE' ORDER BY student.created_at LIMIT 1`);
  assert.ok(enrolled?.login, '夹具没把任何学生放进课堂');
  const login = await api('/api/auth/login', { method: 'POST', body: { login: enrolled.login, password: 'study123' } });
  const token = login.data?.token;
  assert.ok(token, JSON.stringify(login.raw).slice(0, 200));
  // ③ 要配的就是**这个学生的默认课堂**那节课：照服务端那条 SQL 独立算一遍（顺序也一样），
  //    下面的 ② 会断言 client-context 报的 lessonId 与它相同 —— 等于把"默认课堂 = 最近开始的那一节"钉住。
  const defaultSession = await arow(`SELECT session.lesson_id FROM class_sessions session
       JOIN session_students part ON part.session_id = session.id
      WHERE part.student_id = ? AND part.status = 'ACTIVE' AND session.status = 'ACTIVE'
      ORDER BY session.started_at DESC, session.created_at DESC LIMIT 1`, [enrolled.student_id]);
  lessonId = defaultSession?.lesson_id || '';
  assert.ok(lessonId, '这个学生的默认课堂没有课时');

  /* ── ② client-context 的形状 ─────────────────────────────────────── */
  console.log('\n② client-context：字段齐、baseUrl 不带 /chat/completions、无 DSH 字段');
  const context = await api('/api/student/runtime/client-context', { token });
  const ctx = context.data || {};
  await check('② 200 且是 {data: payload} 包装（客户端两种都能吃，这里钉住平台这一种）',
    () => { assert.equal(context.status, 200); assert.ok(context.raw?.data && context.raw.data.classroom !== undefined, JSON.stringify(context.raw).slice(0, 200)); });
  await check('② classroom 有 id / lessonId / title', () => {
    assert.ok(ctx.classroom, `classroom 为空：${JSON.stringify(ctx).slice(0, 200)}`);
    assert.ok(ctx.classroom.id && ctx.classroom.title, JSON.stringify(ctx.classroom));
    assert.equal(typeof ctx.classroom.lessonId, 'string');
  });
  await check('② classroom.lessonId 与夹具配的那节课**是同一节**（否则 ③ 的配置会落在别的课上，那几条会假绿）', () => {
    assert.equal(ctx.classroom.lessonId, lessonId, `client-context 报 ${ctx.classroom.lessonId}，夹具配的是 ${lessonId}`);
  });
  await check('② gateway.baseUrl **不含** /chat/completions（契约：平台不得下发完整路径）', () => {
    assert.ok(ctx.gateway?.baseUrl, '没有 gateway.baseUrl');
    assert.ok(!ctx.gateway.baseUrl.includes('/chat/completions'), ctx.gateway.baseUrl);
    assert.ok(ctx.gateway.key, '没有 gateway.key');
  });
  await check('② 裸 base 是 404、base + /chat/completions 才是网关那条路（未带密钥 → 401）', async () => {
    const bare = await fetch(`http://127.0.0.1:${PORT}${new URL(ctx.gateway.baseUrl).pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bare.status, 404, `裸 base 拿到 ${bare.status}（应当 404：它不是可用端点）`);
    const real = await fetch(`http://127.0.0.1:${PORT}${new URL(ctx.gateway.baseUrl).pathname}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x","messages":[]}' });
    assert.equal(real.status, 401, `网关端点拿到 ${real.status}`);
    const body = await real.json().catch(() => ({}));
    assert.equal(body?.error?.code, 'RUNTIME_KEY_INVALID', JSON.stringify(body).slice(0, 160));
  });
  await check('② models 每项都有 id + displayName，且 displayName 优先运营别名', () => {
    assert.ok(Array.isArray(ctx.models) && ctx.models.length >= 2, JSON.stringify(ctx.models));
    for (const model of ctx.models) assert.ok(model.id && model.displayName, JSON.stringify(model));
    assert.equal(ctx.models.find((item) => item.id === 'p168-flash')?.displayName, '运营改的别名', JSON.stringify(ctx.models));
  });
  await check('② defaultModel 有值，且指向 models 里的一个 id', () => {
    assert.ok(ctx.defaultModel, '没有 defaultModel');
    assert.ok(ctx.models.some((item) => item.id === ctx.defaultModel), `${ctx.defaultModel} 不在 models 里`);
  });
  await check('② presets 是数组（平台侧形状固定 [{title,text}]，空就空）', () => {
    assert.ok(Array.isArray(ctx.presets), JSON.stringify(ctx.presets));
    for (const preset of ctx.presets) assert.ok(typeof preset.title === 'string' && typeof preset.text === 'string', JSON.stringify(preset));
  });
  await check('② sends 有 limit / used / remaining 三个键', () => {
    assert.ok(ctx.sends && 'limit' in ctx.sends && 'used' in ctx.sends && 'remaining' in ctx.sends, JSON.stringify(ctx.sends));
  });
  await check('② **不带任何 DSH 字段**（契约第 7 条：客户端不许依赖 session/profile/Cordis/patchFiles）', () => {
    // 只扫**键名**（不扫 JSON 字符串 —— 那样 values 里出现一个 dsh 字样的模型名就会假红）。
    const keysOf = (value, acc = []) => {
      if (Array.isArray(value)) value.forEach((item) => keysOf(item, acc));
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { acc.push(key); keysOf(child, acc); }
      return acc;
    };
    const hits = keysOf(ctx).filter((key) => /dsh|profile|cordis|patch_?files/i.test(key));
    assert.deepEqual(hits, [], `client-context 里出现了不该有的字段：${hits.join(', ')}`);
  });
  await check('② 平台**不下发** workspacePath（学生本机工作区只有客户端知道）', () => {
    assert.ok(!('workspacePath' in ctx), 'platform 突然开始下发 workspacePath 了 —— 契约里它标着"可选"，改前先对齐');
  });

  /* ── ③ sends.limit 的三档语义 ───────────────────────────────────── */
  console.log('\n③ sends.limit：不配=null / 配 0 仍=null（平台从不发 0）/ 配 2 = 2');
  const readSends = async () => (await api('/api/student/runtime/client-context', { token })).data?.sends || {};
  const setSendLimit = async (value) => {
    const config = value === undefined ? {} : { vibeCoding: { sendLimit: value } };
    await aq('UPDATE course_lessons SET classroom_config=? WHERE id=?', [JSON.stringify(config), lessonId]);
  };
  await setSendLimit(undefined);
  const unset = await readSends();
  await check('③ 不配上限 → limit=null、remaining=null（不限）', () => {
    assert.equal(unset.limit, null, JSON.stringify(unset));
    assert.equal(unset.remaining, null, JSON.stringify(unset));
  });
  await setSendLimit(0);
  const zero = await readSends();
  await check('③ 配 0 → **仍是 null**（平台口径"填 0 = 不限"，从不下发 0；客户端不该把 0 当"没有次数"）', () => {
    assert.equal(zero.limit, null, `平台下发了 0：${JSON.stringify(zero)}`);
    assert.equal(zero.remaining, null, JSON.stringify(zero));
  });
  await setSendLimit(2);
  const two = await readSends();
  await check('③ 配 2 → limit=2、used=0、remaining=2', () => {
    assert.equal(two.limit, 2, JSON.stringify(two));
    assert.equal(two.used, 0, JSON.stringify(two));
    assert.equal(two.remaining, 2, JSON.stringify(two));
  });
  await check('③ 不变量：limit 要么 null，要么**正整数**（平台永不用 0 表示任何一档）', () => {
    for (const sends of [unset, zero, two]) {
      const ok = sends.limit === null || (Number.isInteger(sends.limit) && sends.limit > 0);
      assert.ok(ok, `limit 既不是 null 也不是正整数：${JSON.stringify(sends)}`);
    }
  });

  /* ── ④ submit-upload 的 works（本轮补的）────────────────────────── */
  console.log('\n④ submit-upload：warnings / missing / works，且 works 与列表同形');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
  const html = '<!doctype html><html><body><h1>契约验收的网页</h1><img src="cat.png"></body></html>';
  const upload = (body) => api('/api/student/runtime/submit-upload', { method: 'POST', token, body });
  const submitted = await upload({
    name: 'index.html', title: '契约验收的网页', copyrightConfirmed: true,
    files: [
      { name: 'index.html', content: html, binary: false },
      { name: 'cat.png', content: png.toString('base64'), binary: true },
    ],
  });
  await check('④ 提交成功（200）', () => assert.equal(submitted.status, 200, JSON.stringify(submitted.raw).slice(0, 300)));
  await check('④ 响应里有 warnings / missing / works 三个键', () => {
    assert.ok(Array.isArray(submitted.data?.warnings), JSON.stringify(submitted.data).slice(0, 200));
    assert.ok(Array.isArray(submitted.data?.missing), JSON.stringify(submitted.data).slice(0, 200));
    assert.ok(Array.isArray(submitted.data?.works), `works 不是数组：${JSON.stringify(submitted.data?.works)?.slice(0, 200)}`);
  });
  const work = submitted.data?.works?.[0];
  await check('④ works 恰好一条，且 id/artefact 与这次提交对得上（source=VIBECODING、status=PENDING）', () => {
    assert.equal(submitted.data.works.length, 1, JSON.stringify(submitted.data.works));
    assert.equal(work.id, submitted.data.id, 'works[0].id 与提交 id 不一致');
    assert.equal(work.source, 'VIBECODING');
    assert.equal(work.status, 'PENDING');
    assert.equal(work.entryFile, 'index.html');
    assert.equal(work.title, '契约验收的网页');
  });
  const listed = await api('/api/student/works?page=1&limit=20', { token });
  const listedItem = (listed.data?.items || []).find((item) => item.id === work?.id);
  await check('④ ⭐ works[0] 与 /api/student/works 里同一条**键集合完全一致**（形状同源，客户端可以直接复用渲染）', () => {
    assert.ok(listedItem, `列表里没找到 ${work?.id}：${JSON.stringify(listed.data?.items?.[0] || {}).slice(0, 200)}`);
    assert.deepEqual(Object.keys(work).sort(), Object.keys(listedItem).sort());
  });
  await check('④ ⭐ 逐字段一致（会话/课堂/课时/课包/轮次/提交时间/可见性/分享）', () => {
    const fields = ['id', 'studentId', 'orgId', 'classId', 'courseLessonId', 'courseLessonTitle', 'seriesTitle', 'classSessionId',
      'title', 'description', 'status', 'submittedAt', 'source', 'entryFile', 'submissionRound', 'plazaPublished', 'shareToken'];
    for (const field of fields) assert.deepEqual(work[field], listedItem[field], `字段 ${field} 不一致：${JSON.stringify(work[field])} vs ${JSON.stringify(listedItem[field])}`);
    assert.deepEqual(work.sharing, listedItem.sharing);
  });

  /* ── ⑤ 封面失败不阻断（works 照常回）────────────────────────────── */
  console.log('\n⑤ 封面失败不阻断：超限封面只记 warning，作品照交、works 照回');
  const bigCover = Buffer.alloc(1.6 * 1024 * 1024, 7).toString('base64');
  const withBadCover = await upload({
    name: 'index.html', title: '封面超限的那一份', copyrightConfirmed: true,
    cover: { content: bigCover },
    files: [{ name: 'index.html', content: html, binary: false }],
  });
  await check('⑤ 提交仍然成功（200）', () => assert.equal(withBadCover.status, 200, JSON.stringify(withBadCover.raw).slice(0, 200)));
  await check('⑤ warnings 里说清了封面没带上', () => {
    assert.ok((withBadCover.data?.warnings || []).some((text) => text.includes('封面')), JSON.stringify(withBadCover.data?.warnings));
  });
  await check('⑤ works 照常回（长度 1、标题是这一份）', () => {
    assert.equal(withBadCover.data?.works?.length, 1, JSON.stringify(withBadCover.data?.works).slice(0, 200));
    assert.equal(withBadCover.data.works[0].title, '封面超限的那一份');
  });

  /* ── ⑥ 老入口没被 `works` 这一改带坏 ──────────────────────────── */
  console.log('\n⑥ /submit（服务器去学生盒子取产物那条老路）不受影响');
  await check('⑥ 未登录 → 401（不是 500、不是 404）',
    async () => { const result = await api('/api/student/runtime/submit', { method: 'POST', body: {} }); assert.equal(result.status, 401, String(result.status)); });
} catch (error) {
  console.error('P168 抛错：', error?.message || error);
  console.error(serverLog.split('\n').slice(-15).join('\n'));
  checks.push({ name: 'P168 未捕获异常', ok: false, message: error?.message || String(error) });
} finally {
  server.kill('SIGTERM');
}

const failed = checks.filter((item) => !item.ok);
console.log('');
for (const item of checks) if (!item.ok) console.log(`  ✗ ${item.name} —— ${item.message}`);
console.log(failed.length
  ? `✗ p168 有 ${failed.length} / ${checks.length} 项不符合预期`
  : `✓ p168 ZCode 客户端契约（第二版，平台侧）：${checks.length} 项全部通过`);
process.exitCode = failed.length ? 1 : 0;
