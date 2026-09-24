/**
 * P118 VibeCoding「发送次数上限」的判据与拦截守卫（2026-09-19 新增）。
 *
 * 为什么补这一道：这套机制上一轮**做完了但只被 `.tmp` 里的临时脚本验过**（没进 scripts/），
 * 于是本轮在**真客户端**上立刻发现它数错了 —— 学生按一次发送被记成 3 次。
 * 根因不在机制本身，在**判据**：`agent-instructions` 插件把工作区指令当**普通 user 消息**
 * 投进历史（整条裹在 `<system-reminder>…</system-reminder>` 里，基线一次 + 刷新若干次），
 * 而当时的 `countUserMessages` 把这些也算成"学生按了发送"。
 *
 * 这一道把判据钉死，跑法：node scripts/p118-vibecoding-send-limit.mjs
 *   · 数谁：dsh 注入的 `<system-reminder>` 块与工具回填**都不算**，只数学生自己打的；
 *   · 只增不减：历史被压缩（条数变少）后不倒退 —— 否则"压缩一下就刷新额度"；
 *   · 超限的**这一次**必须被拦在上游之前：429 + 中文原因，且**不新增 usage_records**；
 *   · **不填 = 不拦**（没人配置时现状一字不改）；
 *   · 对外报的 `used` 封顶到上限（`used ≤ limit` 是个不变量），`client-context` 与库里一致。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p118-send-limit-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const port = 18918;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p118-secret',
  DSH_RUNTIME_GATEWAY_URL: `http://127.0.0.1:${port}/api/gateway/v1`,
  PORT: String(port),
};
const api = (suffix, init = {}) => fetch(`http://127.0.0.1:${port}${suffix}`, init);

const run = (args, label) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => { if (code) reject(new Error(`${label} 失败：\n${err || out}`)); else resolve(out); });
});

const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

const readRow = async (sql, params = []) => {
  
  
  const value = await arow(sql, [...params]);
  
  return value;
};
const write = async (sql, params = []) => {
  
  
  await aq(sql, [...params]);
  
};
/** 一次模型请求（走真网关）。`messages` 就是 dsh 那条链路发过来的历史。 */
const callGateway = (key, messages) => api('/api/gateway/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'deepseek-flash', stream: false, messages }),
});
const sends = async (sessionId, studentId) => Number((await readRow(
  'SELECT vibecoding_sends FROM session_students WHERE session_id=? AND student_id=?', [sessionId, studentId],
))?.vibecoding_sends || 0);
const usageCount = async () => Number((await readRow('SELECT COUNT(*) AS n FROM usage_records'))?.n || 0);

let server;
try {
  await run(['packages/database/src/db.js', '--init'], 'db --init');
  await run(['packages/database/src/seed.js'], 'seed');
  await ensureClassroom(dbPath);
  // ⚠️ 2026-09-21：运行时接口（client-context / submit-upload / …）现在**只认 VIBECODING 课堂**
  //    （客户端项目报的门禁缺口：画布课堂原来也会被下发 classroom + 网关密钥）。
  //    夹具是按"课时的 delivery_mode"建课堂的，而种子里那几节默认是画布课 →
  //    这条守卫验的是 VibeCoding 的发送次数，那它要的教室就该是一间 VibeCoding 课堂。
  await write("UPDATE class_sessions SET delivery_mode='VIBECODING'");
  await write("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);
  const student = await readRow("SELECT id, org_id FROM users WHERE login='student-1'");

  server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await api('/api/health')).ok) break; } catch { /* 还没起 */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const login = await (await api('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'student-1', password: 'study123' }) })).json();
  const token = login?.data?.token;
  assert.ok(token, '学生登录没拿到 token');

  /** 每次 GET client-context 都签发一把新密钥（里面有课堂与学生），用它调网关。 */
  const context = async () => (await (await api('/api/student/runtime/client-context', { headers: { authorization: `Bearer ${token}` } })).json()).data;
  const key = async () => (await context()).gateway.key;

  // ⚠️ 夹具给**每节已发布课时**都开了一个 ACTIVE 课堂，而这个学生同时挂在好几个名单里。
  //    `/client-context` 取的是"最近开始的那个"，所以这里必须**用它解析出来的那一节课/那一场**
  //    来做配置与断言 —— 自己挑 `LIMIT 1` 会挑到另一节课，于是"上限"设了个寂寞（第一版就这么错的）。
  const resolved = await context();
  assert.ok(resolved?.classroom, 'client-context 没给出课堂（夹具没生效？）');
  const sessionId = resolved.classroom.id;
  const lessonId = resolved.classroom.lessonId;
  // ①a 这节课"叫什么"：课包 / 课时 / 老师要与库里一致
  //    （用户口径 2026-09-20：学生要在客户端上看得见自己进的是哪节课 —— 预设与次数上限都是按课时配的）。
  //    ⚠️ 这条抓的是 **JOIN 写错**那类静默 bug：课包挂错 series 时接口照样 200、字段也在，只是名字指错了课。
  //    所以拿库里的真值对，不只看字段在不在。
  const lessonRow = await readRow(
    `SELECT COALESCE(lesson.published_title, lesson.title) AS lesson_title, series.title AS series_title,
            teacher.display_name AS teacher_name
       FROM class_sessions session
       LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
       LEFT JOIN course_series series ON series.id = lesson.series_id
       LEFT JOIN users teacher ON teacher.id = session.teacher_id
      WHERE session.id = ?`,
    [sessionId],
  );
  await check('client-context 报的课包 / 课时 / 老师与库里一致', () => {
    for (const key of ['seriesTitle', 'lessonTitle', 'teacherName']) {
      assert.ok(Object.hasOwn(resolved.classroom, key), `classroom 缺字段 ${key}`);
    }
    assert.equal(resolved.classroom.lessonTitle, lessonRow?.lesson_title || null);
    assert.equal(resolved.classroom.seriesTitle, lessonRow?.series_title || null);
    assert.equal(resolved.classroom.teacherName, lessonRow?.teacher_name || null);
  });
  // ⚠️ classroom_config 是 NOT NULL：清空配置要写 '{}'，不能写 null。
  const setLimit = async (value) => await write('UPDATE course_lessons SET classroom_config=? WHERE id=?', [
    value === null ? '{}' : JSON.stringify({ vibeCoding: { sendLimit: value } }), lessonId,
  ]);

  // ① 不填 = 不拦
  await setLimit(null);
  let current = await context();
  await check('不填上限时报告为 null，且已用 0', () => {
    assert.equal(current.sends.limit, null);
    assert.equal(current.sends.remaining, null);
  });
  await check('不填上限时第一次发送放行（现状一字不改）', async () => {
    const response = await callGateway(await key(), [{ role: 'user', content: '第一句' }]);
    assert.equal(response.status, 200, `期望 200，实际 ${response.status}`);
  });
  await check('数到了 1 次（只数学生自己打的）', async () => assert.equal(await sends(sessionId, student.id), 1));

  // ② 本轮修的 bug：dsh 注入的 <system-reminder> 不算
  await check('dsh 注入的 <system-reminder> 块**不算**学生发送（本轮的真回归）', async () => {
    const reminder = '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>';
    const response = await callGateway(await key(), [
      { role: 'user', content: reminder },
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: reminder },
      { role: 'user', content: '第二句' },
    ]);
    assert.equal(response.status, 200);
    assert.equal(await sends(sessionId, student.id), 2, '注入块被算成发送了（一次发送会吃掉好几次额度）');
  });
  await check('注入块排在最后也一样不算（dsh 的新鲜上下文是后追加的）', async () => {
    const reminder = '<system-reminder>context</system-reminder>';
    await callGateway(await key(), [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
      { role: 'user', content: reminder },
    ]);
    assert.equal(await sends(sessionId, student.id), 2);
  });
  // 真客户端上抓到的第二个注入源（@deepseek-ai/dsh-system-prompt 的运行时上下文快照）：
  // 它**不带 `<system-reminder>` 包裹**，只有那句英文打头 —— 只认方括号的话一次发送仍会多记 1 次。
  await check('运行时上下文快照（不带方括号包裹）也不算（第二个注入源）', async () => {
    const snapshot = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: workspace-write.';
    await callGateway(await key(), [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
      { role: 'user', content: snapshot },
    ]);
    assert.equal(await sends(sessionId, student.id), 2, '运行时上下文快照被算成发送了');
  });
  await check('跟着 dsh 真实顺序走一遍：学生消息 + 两个注入块 = 只算 1 次', async () => {
    // 实测顺序（apps/cli 的 fixture 与真客户端一致）：旧学生消息 → 运行时快照 → skills 块 → 新学生消息
    const snapshot = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.';
    const skills = '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>';
    await callGateway(await key(), [
      { role: 'user', content: '第一句' },
      { role: 'user', content: snapshot },
      { role: 'user', content: skills },
      { role: 'user', content: '第二句' },
    ]);
    assert.equal(await sends(sessionId, student.id), 2, '一次发送被多记了（注入块没排干净）');
  });
  await check('工具回填（带 tool_call_id）不算', async () => {
    await callGateway(await key(), [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
      { role: 'user', tool_call_id: 'call_1', content: '工具结果' },
    ]);
    assert.equal(await sends(sessionId, student.id), 2);
  });
  await check('多模态 content 数组里的注入块也认得出', async () => {
    await callGateway(await key(), [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }] },
    ]);
    assert.equal(await sends(sessionId, student.id), 2);
  });

  // ③ 压缩历史不刷新额度（只增不减）
  await check('历史被压缩（条数变少）后不倒退 —— 否则压缩一下就能继续发', async () => {
    await callGateway(await key(), [{ role: 'user', content: '只剩一句了' }]);
    assert.equal(await sends(sessionId, student.id), 2);
  });

  // ④ 上限与拦截
  await setLimit(2);
  current = await context();
  await check('client-context 报的已用次数与库里一致，且 remaining=0', () => {
    assert.equal(current.sends.limit, 2);
    assert.equal(current.sends.used, 2);
    assert.equal(current.sends.remaining, 0);
  });
  const usageBefore = await usageCount();
  let blocked;
  await check('超限：429 + 中文原因（dsh 只认 OpenAI 方言，所以挂在 error.message 上）', async () => {
    blocked = await callGateway(await key(), [
      { role: 'user', content: '第一句' },
      { role: 'user', content: '第二句' },
      { role: 'user', content: '第三次' },
    ]);
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error.code, 'SEND_LIMIT_EXCEEDED');
    assert.match(body.error.message, /发送次数用完/);
  });
  await check('⭐ 被拦下的这一次**不新增 usage_records**（门禁在上游之前，既不花算力也不进账）', async () => {
    assert.equal(await usageCount(), usageBefore, '超限的请求打到了上游（会白花平台的钱）');
  });
  // ⚠️ 被拦下的那一次**会**推进"观察到的最大值"（→ 3），但**不会**改变"对外报的已用"（封顶 = 2）。
  //    这是有意为之：判据（seen）靠这个最大值，不落库的话历史一压缩就漏放；而 used 是给学生/老师
  //    看的数字，必须 used ≤ limit。第一版守卫把这条写反了（以为库里也不该动）。
  await check('被拦下的那一次推进「观察到的最大值」、但不改变「对外报的已用」（两个口径分开）', async () => {
    assert.equal(await sends(sessionId, student.id), 3, '观察到的最大值要落库（含被拦下的那几次，否则压缩历史就能漏放）');
    const after = await context();
    assert.equal(after.sends.used, 2, '对外报的 used 必须封顶到 limit');
  });
  await check('对外报的 used 封顶到上限（不会出现「按了 37 次」这种脏数字）', async () => {
    const after = await context();
    assert.ok(after.sends.used <= after.sends.limit, `used=${after.sends.used} > limit=${after.sends.limit}`);
  });

  // ⑤ 放开上限后立刻又能发（老师改配置即生效，不需要重开课堂）
  await setLimit(null);
  await check('把上限去掉之后又能发（不填=不拦，改配置即生效）', async () => {
    const response = await callGateway(await key(), [
      { role: 'user', content: '第一句' }, { role: 'user', content: '第二句' }, { role: 'user', content: '第三次' },
    ]);
    assert.equal(response.status, 200);
    assert.equal(await sends(sessionId, student.id), 3);
  });

  // ⑦ 选课：多于一节时，学生指定哪节就**按哪节**走（预设 / 次数上限 / 密钥都跟着）
  //    ⭐ 这正是用户口径要的那件事：以前只取"最近开始的那一场"，学生做 A 课作业却拿到 B 课的上限。
  //    夹具正好给了这个学生的**多场** ACTIVE 课堂（它直写库，绕开了"一个人只能在一个未终态课堂"那条校验）。
  const others = resolved.classrooms.filter((item) => item.id !== sessionId);
  await check('client-context 列出「你现在能进的课」，不传 sessionId 时默认仍是最近一场', () => {
    assert.ok(Array.isArray(resolved.classrooms), 'client-context 没给 classrooms 字段');
    assert.ok(resolved.classrooms.length >= 2, `夹具本该有多场 ACTIVE 课堂，实际 ${resolved.classrooms.length} 场`);
    assert.equal(resolved.classroom.id, resolved.classrooms[0].id, '默认应当是最近开始的那一场');
    for (const key of ['seriesTitle', 'lessonTitle', 'teacherName']) {
      assert.ok(Object.hasOwn(resolved.classrooms[0], key), `候选缺字段 ${key}`);
    }
  });
  await check('⭐ 带 sessionId 时，次数上限跟着**选的那一节**走（不再默默用别节的）', async () => {
    const target = others[0];
    await write('UPDATE course_lessons SET classroom_config=? WHERE id=?', [JSON.stringify({ vibeCoding: { sendLimit: 7 } }), target.lessonId]);
    const picked = (await (await api(`/api/student/runtime/client-context?sessionId=${encodeURIComponent(target.id)}`, {
      headers: { authorization: `Bearer ${token}` },
    })).json()).data;
    assert.equal(picked.classroom.id, target.id, '指定了哪一节就该报哪一节');
    assert.equal(picked.classroom.lessonTitle, target.lessonTitle, '课时名应当是选中那节的');
    assert.equal(picked.sends.limit, 7, '次数上限没跟着选中的那节课走');
    const fallback = await context();
    assert.equal(fallback.classroom.id, resolved.classroom.id, '不传 sessionId 时应当仍按最近一场（老客户端不变）');
  });
  await check('选一节不可用的课（不属于自己 / 已结束）：明确报不可用，且**不发网关密钥**', async () => {
    const bogus = (await (await api('/api/student/runtime/client-context?sessionId=csession_not_mine', {
      headers: { authorization: `Bearer ${token}` },
    })).json()).data;
    assert.equal(bogus.classroom, null);
    assert.equal(bogus.gateway, undefined, '选了一节不可用的课却发了网关密钥');
    assert.equal(bogus.reason, 'CLASSROOM_NOT_AVAILABLE');
  });

  // ⑥ 课堂没开始（老师还没点「立即上课」）：不发密钥，但要把「接下来是哪节课」告诉客户端。
  //    ⚠️ 这条钉的是**闸门**：没有 ACTIVE 课堂时必须没有 `gateway` —— 学生拿不到密钥就调不动网关，
  //    「点了立即上课才能进」是服务端兜底的，不靠客户端自觉（见 studentRuntime.js 该处注释）。
  //    ⚠️ 夹具给这个学生挂了**不止一场** ACTIVE 课堂（它直接写库，绕开了"一个人只能在一个未终态课堂"
  //    那道校验），所以这里必须**把他名下所有在上的课堂一起翻成 PENDING** ——
  //    只翻一场的话 `resolveActiveClassroom` 会解析到另一场，断言就白写了（第一版就是这么错的）。
  await write("UPDATE class_sessions SET status='PENDING' WHERE status='ACTIVE' AND id IN (SELECT session_id FROM session_students WHERE student_id=?)", [student.id]);
  await check('课堂未开始时：classroom 为 null、不发网关密钥、upcoming 报出那节待上课的课', async () => {
    const paused = await context();
    assert.equal(paused.classroom, null);
    assert.equal(paused.gateway, undefined, '没有在上的课堂却发了网关密钥 —— 闸门漏了');
    assert.ok(paused.upcoming?.id, '没有报出 upcoming');
    const owned = await readRow(
      `SELECT session.id FROM class_sessions session
         JOIN session_students part ON part.session_id = session.id
        WHERE session.id = ? AND part.student_id = ? AND part.status = 'ACTIVE' AND session.status = 'PENDING'`,
      [paused.upcoming.id, student.id],
    );
    assert.ok(owned, 'upcoming 指向的不是这个学生名下的待上课课堂');
    assert.ok(paused.upcoming.lessonTitle, 'upcoming 没带课时名');
    assert.ok(paused.upcoming.seriesTitle, 'upcoming 没带课包名');
  });

  if (checks.some((item) => !item.ok)) console.error(serverLog.slice(-1500));
} finally {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const failed = checks.filter((item) => !item.ok);
const out = { name: 'p118-vibecoding-send-limit', pass: failed.length === 0, checks: checks.length, failed };
if (failed.length) { console.error(JSON.stringify(out, null, 1)); process.exit(1); }
console.log(JSON.stringify(out));
