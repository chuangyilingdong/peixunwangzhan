/**
 * P60 算力池守卫（2026-09-12，用户拍板：**按学生 × 课包**，四种模态共用一个池子）。
 *
 * 这一版把闸门从「网关令牌额度」搬到**应用侧**，原因是用户口径要求「视频 / 音乐 / 对话 / 图像
 * 都算进这一个上限」，而视频与音乐走不了网关（异步任务要写 new-api 任务插件，见梳理文档 7.2.3）——
 * **只有应用侧能同时看见四种模态**。网关的令牌额度退化成宽松兜底。
 *
 * 要钉住的四件事（都是用户口径的直接推论）：
 *   ① 池子按「学生 × 课包」记账：同一个学生、同一个课包，四种模态**累加**到同一个上限；
 *   ② 池子填了上限 → 用尽就拦（COMPUTE_POOL_EXHAUSTED，文案给学生看）；留空 → 不拦，只记账；
 *   ③ 失败的调用**不花学生的钱**（cost_fen 记 0，池子不变），但仍留一条记录；
 *   ④ 单价可配（默认有值，改价立即生效），拦的时候与记的时候用**同一套单价**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p60-compute-pool-'));
const dbPath = path.join(temp, 'platform.db');
const secretFile = path.join(temp, 'provider-secrets.json');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: secretFile,
  DEPLOYMENT_MODE: 'development', AI_PROVIDER: 'local-mock', AI_PROVIDER_API_KEY: 'direct-secret-key',
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

/* 造数（趁服务没起）：
   · 给课时开 text 能力（否则生成前置就拦了，测不到池子）；
   · 课包预算先留空（第 ① 段验证「留空不拦」），之后按段设置。 */
const seeded = { seriesId: '', lessonId: '' };
{
  const db = new DatabaseSync(dbPath);
  const lesson = db.prepare('SELECT id, series_id FROM course_lessons ORDER BY sort LIMIT 1').get();
  seeded.lessonId = lesson.id; seeded.seriesId = lesson.series_id;
  db.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
  db.prepare('UPDATE course_series SET per_student_budget_fen=NULL').run();
  db.close();
}

/* 假上游（OpenAI 形状）：成功那条路用它；「失败不计费」那段把供应商指向一个死端口 */
const UP_PORT = 18970;
const upstream = { calls: 0 };
const upstreamServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  upstream.calls += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '池子验收返回' } }] }));
});
await new Promise((resolve) => upstreamServer.listen(UP_PORT, '127.0.0.1', resolve));

const port = 18971;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
const setProvider = (token, endpoint) => api('/api/admin/billing-config/ai-provider', {
  method: 'PUT', token,
  body: { provider: 'custom', displayName: 'P60 上游', model: 'p60-model', endpoint, platformPerCallBudget: 0, platformDailyBudget: 0, allowStudentExternalContent: true, reason: 'P60 算力池守卫' },
});
const setSeriesBudget = (fen) => {
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE course_series SET per_student_budget_fen=? WHERE id=?').run(fen, seeded.seriesId);
  db.close();
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(admin && student, '登录失败');

  /* ① 单价：默认有值、可改、模型级覆盖模态级，且读回一致 */
  const pricing0 = await api('/api/admin/compute-pricing', { token: admin });
  check('单价默认就有值（不会因为平台没配价把调用全拦死）',
    Number(pricing0.data.pricing.perCall.TEXT) > 0 && Number(pricing0.data.pricing.perCall.VIDEO) > 0,
    JSON.stringify(pricing0.data.pricing.perCall));
  const pricing1 = await api('/api/admin/compute-pricing', { method: 'PUT', token: admin, body: { perCall: { TEXT: 60, IMAGE: 100, VIDEO: 500, MUSIC: 200 }, models: { 'p60-model': 60, 'p60-pricey-model': 250 } } });
  check('能改单价并读回（TEXT 60 分/次）', pricing1.status === 200 && Number(pricing1.data.pricing.perCall.TEXT) === 60, JSON.stringify(pricing1.data.pricing.perCall));

  const courses = await api('/api/student/courses', { token: student });
  const items = courses.data?.items || courses.data?.courses || [];
  const lessonId = items?.[0]?.currentLessonId || items?.[0]?.lessons?.[0]?.id || items?.[0]?.lesson?.id || items?.[0]?.id;
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title: 'P60 池子' } });
  assert.ok(project.data?.id, '学生项目创建失败：' + JSON.stringify(project).slice(0, 200));
  const generate = (prompt) => api('/api/ai/generations', { method: 'POST', token: student, body: { projectId: project.data.id, prompt, modality: 'TEXT' } });
  const poolRows = async () => (await api('/api/admin/compute-pools', { token: admin })).data.items;
  const usedOf = async () => Number((await poolRows()).find((item) => item.seriesId === seeded.seriesId)?.usedFen ?? 0);

  /* ② 课包没填预算 → 不拦，只记账 */
  await setProvider(admin, `http://127.0.0.1:${UP_PORT}/v1`);
  const noCap = await generate('没填预算时不拦');
  check('② 课包没填「每学生算力上限」→ 不拦（留空 = 不限制，只记账）', noCap.status === 200, JSON.stringify(noCap).slice(0, 200));
  check('② 但仍然记了账（池子报表里能看到已用 60 分）', await usedOf() === 60, `usedFen=${await usedOf()}`);

  /* ③ 失败的调用不花学生的钱 */
  const usedBeforeFail = await usedOf();
  await setProvider(admin, 'http://127.0.0.1:18999/v1'); // 死端口 → 一定失败
  const failed = await generate('这次一定失败');
  check('③ 上游不可用 → 调用失败', failed.status >= 400, JSON.stringify(failed).slice(0, 200));
  check('③ 失败不扣钱：池子已用没有变化', await usedOf() === usedBeforeFail, `usedFen=${await usedOf()}（失败前 ${usedBeforeFail}）`);
  check('③ 但留了一条失败记录（能看出有哪些白花的调用）', (await poolRows()).find((item) => item.seriesId === seeded.seriesId)?.failedCalls >= 1,
    JSON.stringify((await poolRows()).find((item) => item.seriesId === seeded.seriesId)));

  /* ④ 填上预算（180 分 = 1.8 元）→ 用尽即拦 */
  await setProvider(admin, `http://127.0.0.1:${UP_PORT}/v1`);
  setSeriesBudget(180);
  const before = await usedOf();
  for (let i = 1; i <= 2; i += 1) {
    const ok = await generate(`第 ${i} 次应当成功`);
    check(`④ 还有额度时第 ${i} 次成功（每次 60 分）`, ok.status === 200, JSON.stringify(ok).slice(0, 160));
  }
  check('④ 三次调用累计到 180 分（= 上限）', await usedOf() === before + 120, `usedFen=${await usedOf()}`);
  const upstreamBeforeBlocked = upstream.calls;
  const blocked = await generate('这次应当被池子拦住');
  check('④ 池子用尽 → 拦下（COMPUTE_POOL_EXHAUSTED）', blocked.error?.code === 'COMPUTE_POOL_EXHAUSTED', JSON.stringify(blocked).slice(0, 240));
  check('④ 拦下来的文案是给学生看的（含上限与已用）', /算力额度已用完/.test(String(blocked.error?.message || '')) && /1\.80/.test(String(blocked.error?.message || '')), String(blocked.error?.message));
  check('④ 拦在调用前：被拦的这一次没有打上游（不白花渠道的钱）', upstream.calls === upstreamBeforeBlocked, `上游 ${upstreamBeforeBlocked} → ${upstream.calls}`);

  const row = (await poolRows()).find((item) => item.seriesId === seeded.seriesId);
  check('④ 池子报表：上限 180 分 / 已用 180 分 / 使用率 100%',
    row?.capFen === 180 && row?.usedFen === 180 && row?.usagePercent === 100, JSON.stringify(row));

  /* ⑤ 四种模态都在同一个闸门里：同一个池子耗尽 → 另外三类也一样被拦 */
  Object.assign(process.env, baseEnv);
  const { assertComputePoolBudget } = await import('../apps/server/src/services/computePool.js');
  const identity = (() => { const db = new DatabaseSync(dbPath); const r = db.prepare("SELECT id FROM users WHERE login='student-2'").get(); db.close(); return r; })();
  const blockedModalities = [];
  for (const modality of ['TEXT', 'IMAGE', 'VIDEO', 'MUSIC']) {
    try { assertComputePoolBudget({ userId: identity.id, seriesId: seeded.seriesId, modality, model: 'p60-model' }); blockedModalities.push(`${modality}:未拦`); }
    catch (error) { blockedModalities.push(`${modality}:${error.code}`); }
  }
  check('⑤ 池子耗尽后，对话/图片/视频/音乐四类都被同一个闸门拦住（都报 COMPUTE_POOL_EXHAUSTED）',
    blockedModalities.length === 4 && blockedModalities.every((item) => item.endsWith(':COMPUTE_POOL_EXHAUSTED')),
    JSON.stringify(blockedModalities));
  check('⑤ 价格按模态区分（视频单价 > 对话单价，说明不是一口价）',
    (await api('/api/admin/compute-pricing', { token: admin })).data.pricing.perCall.VIDEO > (await api('/api/admin/compute-pricing', { token: admin })).data.pricing.perCall.TEXT,
    'VIDEO vs TEXT');

  /* ⑥ 模型级单价（2026-09-13）：界面上「按模型单独定价」承诺的行为 ——
       填了模型价就以模型价为准，没填的模型仍用模态价。这条规则以前只有后端实现、没人钉住。 */
  const pool = await import('../apps/server/src/services/computePool.js');
  check('⑥ 填了模型价 → 按模型价算（250 分，而不是模态的 60 分）', pool.priceFenFor({ modality: 'TEXT', model: 'p60-pricey-model' }) === 250,
    String(pool.priceFenFor({ modality: 'TEXT', model: 'p60-pricey-model' })));
  check('⑥ 另一个填了模型价的模型按自己的价算（60 分）', pool.priceFenFor({ modality: 'TEXT', model: 'p60-model' }) === 60);
  check('⑥ 没填模型价的模型 → 回落到模态价（60 分）', pool.priceFenFor({ modality: 'TEXT', model: 'p60-unlisted-model' }) === 60);
  check('⑥ 不带模型时也回落到模态价（视频 500 分）', pool.priceFenFor({ modality: 'VIDEO' }) === 500, String(pool.priceFenFor({ modality: 'VIDEO' })));

  // Corrupt historical failed charges must never inflate the student pool or admin summaries.
  {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE usage_records SET cost_fen=99999 WHERE status='FAILED'").run();
    db.close();
    check('⑦ FAILED历史非零金额不计入池子', pool.poolUsedFen({ userId: identity.id, seriesId: seeded.seriesId }) === 180);
    const report = (await poolRows()).find(item => item.seriesId === seeded.seriesId);
    check('⑦ FAILED历史非零金额不计入池子报表', report?.usedFen === 180);
    const summary = await api('/api/admin/billing/usage-overview?status=FAILED', { token: admin });
    check('⑦ 失败筛选汇总金额为0且保留失败调用数', summary.data.totalFen === 0 && summary.data.calls > 0, JSON.stringify(summary.data));
    const list = await api('/api/admin/billing/usage-records?status=FAILED', { token: admin });
    check('⑦ 同筛选汇总与明细调用数一致', list.data.total === summary.data.calls && list.data.items.every(item => item.costFen === 0));
  }

  {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE compute_attempts SET cost_source='ESTIMATED',upstream_cost_fen=20 WHERE status='SUCCESS'").run();
    const summary = (await api('/api/admin/compute-attempts?days=30', { token: admin })).data.summary;
    check('⑧ 已知成本与对应扣费计算估算价差', summary.comparableCalls > 0 && summary.estimatedDifferenceFen === summary.comparableSaleFen - summary.comparableCostFen && summary.estimatedDifferenceRate === summary.estimatedDifferenceFen / summary.comparableSaleFen * 100, JSON.stringify(summary));
    db.prepare("UPDATE compute_attempts SET cost_source='UNKNOWN',upstream_cost_fen=NULL").run();
    const unknown = (await api('/api/admin/compute-attempts?days=30', { token: admin })).data.summary;
    check('⑧ 全部未知时价差和率为null而非0', unknown.comparableCalls === 0 && unknown.estimatedDifferenceFen === null && unknown.estimatedDifferenceRate === null && unknown.unknownLogicalCalls > 0, JSON.stringify(unknown));
    db.close();
    const policy = (await api('/api/admin/billing-config/ai-provider', { token: admin })).data.policy;
    const channels = [{id:'route-main',name:'main',provider:'custom',model:'m1',models:['m1','m2'],endpoint:'http://127.0.0.1:18970/v1'},{id:'route-backup',name:'backup',provider:'custom',model:'b1',models:['b1','b2'],endpoint:'http://127.0.0.1:18970/v1'}];
    const modelRoutes = [{modality:'TEXT',channelId:'route-main',model:'m2',backupChannelId:'route-backup',backupModel:'b2'}];
    const saved = await api('/api/admin/billing-config/ai-provider', { method:'PUT',token:admin,body:{...policy,channels,modelRoutes} });
    check('⑨ 模型映射保存并读回', saved.status === 200 && saved.data.policy.modelRoutes[0].backupModel === 'b2', JSON.stringify(saved));
    const invalid = await api('/api/admin/billing-config/ai-provider', { method:'PUT',token:admin,body:{...policy,channels,modelRoutes:[{...modelRoutes[0],backupModel:'not-enabled'}]} });
    check('⑨ 备用模型不属于渠道时拒绝保存', invalid.error?.code === 'AI_PROVIDER_ROUTE_INVALID', JSON.stringify(invalid));
  }

  console.log(JSON.stringify({ name: 'compute-pool', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-4000));
  throw error;
} finally {
  server.kill('SIGTERM');
  upstreamServer.close();
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
