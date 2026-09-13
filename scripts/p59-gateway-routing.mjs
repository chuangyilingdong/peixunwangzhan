/**
 * P59 算力网关「路由」守卫（2026-09-12，P5 最后一公里）。
 *
 * P57/P58 解决的是「配得上、看得见」；这一步解决的是**拦得住**：
 * 学生的 AI 调用真的带着**他自己的令牌**打到网关，令牌额度用尽网关就拒服务 ——
 * 于是「1 个学生在这节课 50 元」是网关给出来的硬闸，而不是我们自己算出来的一个数。
 *
 * 令牌名（多段）约定：机构:<id>/学生:<id>/课时:<id>，解析顺序**最具体优先**：
 *   机构+学生+课时  →  学生+课时  →  机构+学生  →  学生
 * 所以平台管理员手动发的令牌（老约定）和按课时预算自动发的令牌都能被用上。
 *
 * 两个方向都要自证（这是本轮的教训：别只测「配好了能用」）：
 *   ① 网关启用 → 请求打到网关（带该学生的令牌 key），**直连上游一个请求都收不到**；
 *   ② 网关关闭 → 请求打到直连上游（行为与接网关之前完全一致）；
 *   ③ 网关说「额度用尽」→ 明确报 COMPUTE_QUOTA_EXHAUSTED，**绝不静默回退直连**（否则闸门形同虚设）。
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p59-gateway-routing-'));
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

// 给所有课时填上「每学生算力上限」= 50 元（5000 分）→ 这节课的令牌额度就该是 50 元。
// 同时把课时开成**双入口**（画布 + VibeCoding）并开放 text/image 能力：
// 这样同一个环境既能跑画布那条（同步/异步），也能跑 VibeCoding 对话那条（SSE）。
// 直接改库（趁服务还没起，避免并发写锁），因为平台端传课时预算要绕好几个接口。
{
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE course_lessons SET per_student_budget_fen=?').run(5000);
  db.prepare("UPDATE course_lessons SET delivery_modes=?").run('["CANVAS","VIBECODING"]');
  for (const capability of ['text', 'image']) {
    db.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) SELECT id, ?, datetime('now') FROM course_lessons").run(capability);
  }
  db.close();
}

/* ────────────────────────── 假网关（管理接口 + 中继） ────────────────────────── */
const GW_PORT = 18940;
const gateway = { tokens: [], tokenPosts: [], relays: [], logins: 0 };
let nextTokenId = 1;
const quotaExhausted = { on: false };
const openAiReply = (text) => ({ choices: [{ message: { role: 'assistant', content: text } }] });

const gatewayServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: status < 400, data })); };
  if (req.url.startsWith('/api/user/login')) { gateway.logins += 1; return json({ access_token: 'mock-jwt', user: { id: 1, username: 'root' } }); }
  if (req.url.startsWith('/api/user/self')) return json({ username: 'root' });
  if (req.url.startsWith('/api/token/') && req.method === 'GET') return json({ items: gateway.tokens });
  if (req.url.startsWith('/api/token/') && req.method === 'POST') {
    gateway.tokenPosts.push(body || {});
    const token = {
      id: nextTokenId++, name: String(body?.name || ''), key: `sk-token-${nextTokenId}`,
      remain_quota: Number(body?.remain_quota || 0), used_quota: 0,
      unlimited_quota: body?.unlimited_quota === true, status: 1, model_limits: body?.model_limits || '',
    };
    gateway.tokens.push(token);
    return json({});
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    gateway.relays.push({ url: req.url, auth: String(req.headers.authorization || ''), body });
    if (quotaExhausted.on) {
      // 真实 new-api 额度耗尽的形状：HTTP 403 + error.message 里带 insufficient quota
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'insufficient quota', type: 'new_api_error' } }));
      return;
    }
    // ⚠️ 中继返回的是**裸的 OpenAI 响应体**，不能像管理接口那样包 { success, data }（包了客户端就解析不出 choices）
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(openAiReply('网关返回的文本')));
    return;
  }
  if (req.url.startsWith('/api/log/')) return json({ items: [] });
  res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'not found' }));
});
await new Promise((resolve) => gatewayServer.listen(GW_PORT, '127.0.0.1', resolve));

/* ─────────────────── 假上游（直连路径用；用来证明「没打到它」） ─────────────────── */
const UP_PORT = 18941;
const upstream = { requests: [] };
const upstreamServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  upstream.requests.push({ url: req.url, auth: String(req.headers.authorization || ''), body });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(openAiReply('直连上游返回的文本')));
});
await new Promise((resolve) => upstreamServer.listen(UP_PORT, '127.0.0.1', resolve));

const port = 18942;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
const setGateway = (token, body) => api('/api/admin/compute-gateway', { method: 'PUT', token, body });

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(admin && student, '管理员或学生登录失败');

  // 平台把供应商配成「自定义 + 指向我们的假上游」，并允许学生内容外发（否则生成前置就拦掉了）
  const policy = await api('/api/admin/billing-config/ai-provider', {
    method: 'PUT', token: admin,
    body: { provider: 'custom', displayName: 'P59 直连上游', model: 'p59-model', endpoint: `http://127.0.0.1:${UP_PORT}/v1`, platformPerCallBudget: 0, platformDailyBudget: 0, allowStudentExternalContent: true, reason: 'P59 路由守卫' },
  });
  check('平台供应商配置成功（自定义 + 允许外发）', policy.status === 200, JSON.stringify(policy).slice(0, 200));

  const courses = await api('/api/student/courses', { token: student });
  const items = courses.data?.items || courses.data?.courses || [];
  const lessonId = items?.[0]?.currentLessonId || items?.[0]?.lessons?.[0]?.id || items?.[0]?.lesson?.id || items?.[0]?.id;
  assert.ok(lessonId, '未取到课时 ID：' + JSON.stringify(courses.data).slice(0, 200));
  const identity = (() => { const db = new DatabaseSync(dbPath); const r = db.prepare("SELECT id, org_id FROM users WHERE login='student-2'").get(); db.close(); return r; })();
  const studentName = `学生:${identity.id}`;
  const orgName = `机构:${identity.org_id}`;
  const lessonName = `课时:${lessonId}`;
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title: 'P59 网关路由' } });
  assert.ok(project.data?.id, '学生项目创建失败：' + JSON.stringify(project).slice(0, 200));
  const generate = (prompt) => api('/api/ai/generations', { method: 'POST', token: student, body: { projectId: project.data.id, prompt, modality: 'TEXT' } });

  /* ① 网关没启用 → 行为与接网关之前完全一致：打到直连上游，网关一个中继请求都没有 */
  const upstreamBefore = upstream.requests.length;
  const directRun = await generate('网关未启用时应当直连');
  check('① 网关未启用：生成成功', directRun.status === 200, JSON.stringify(directRun).slice(0, 200));
  check('① 网关未启用：请求打到直连上游', upstream.requests.length === upstreamBefore + 1, `上游收到 ${upstream.requests.length - upstreamBefore} 次`);
  check('① 网关未启用：网关没有收到任何中继请求', gateway.relays.length === 0, `网关中继 ${gateway.relays.length} 次`);

  /* ② 启用网关 → 自动按课时预算发令牌 → 请求带该学生的令牌打到网关，直连上游零请求 */
  const enabled = await setGateway(admin, { baseUrl: `http://127.0.0.1:${GW_PORT}`, username: 'root', password: 'p59-password', enabled: true });
  check('② 网关配置保存成功', enabled.status === 200 && enabled.data.config.enabled === true, JSON.stringify(enabled).slice(0, 200));
  const expectedTokenName = [orgName, studentName, lessonName].join('/');
  const upstreamBeforeGateway = upstream.requests.length;
  const routedRun = await generate('启用网关后应当走网关');
  check('② 启用网关：生成成功', routedRun.status === 200, JSON.stringify(routedRun).slice(0, 300));
  const created = gateway.tokenPosts.find((item) => item.name === expectedTokenName);
  check('② 按「每学生算力上限」自动发了令牌并按多段规范命名', Boolean(created), `TokenPosts=${JSON.stringify(gateway.tokenPosts)} 期望=${expectedTokenName}`);
  check('② 令牌额度 = 50 元（5000 分 → 50 × 500000 = 25000000 quota）', Number(created?.remain_quota) === 25000000, String(created?.remain_quota));
  const relay = gateway.relays.at(-1);
  const issuedKey = gateway.tokens.find((item) => item.name === expectedTokenName)?.key;
  check('② 网关中继收到请求', gateway.relays.length === 1, `relays=${gateway.relays.length}`);
  check('② 中继请求带的是该学生的令牌 key', Boolean(issuedKey) && relay?.auth === `Bearer ${issuedKey}`, `${relay?.auth} vs ${issuedKey}`);
  check('② 中继请求是 OpenAI 形状（messages + model）', Array.isArray(relay?.body?.messages) && relay?.body?.model === 'p59-model', JSON.stringify(relay?.body).slice(0, 200));
  check('② 走网关时直连上游一个请求都没收到', upstream.requests.length === upstreamBeforeGateway, `上游多收到 ${upstream.requests.length - upstreamBeforeGateway} 次`);

  /* ③ 已有令牌要复用，不重复发 */
  const beforeReuse = gateway.tokenPosts.length;
  const reuseRun = await generate('第二次调用应当复用令牌');
  check('③ 第二次调用复用已有令牌（没有再发一张）', gateway.tokenPosts.length === beforeReuse, `tokenPosts=${gateway.tokenPosts.length}`);
  check('③ 第二次调用仍走网关', reuseRun.status === 200 && gateway.relays.length === 2, `relays=${gateway.relays.length}`);

  /* ④ 解析顺序「最具体优先」：把细粒度令牌撤掉，只留 机构+学生 / 学生 两级 */
  gateway.tokens = gateway.tokens.filter((item) => item.name !== expectedTokenName);
  gateway.tokens.push({ id: nextTokenId++, name: [orgName, studentName].join('/'), key: 'sk-org-student', remain_quota: 1000000, used_quota: 0, unlimited_quota: false, status: 1 });
  gateway.tokens.push({ id: nextTokenId++, name: studentName, key: 'sk-student-only', remain_quota: 1000000, used_quota: 0, unlimited_quota: false, status: 1 });
  // 课时预算还在，所以「自动发牌」也可能抢先 —— 先把预算清掉，才测得到「用现有的令牌」
  { const db = new DatabaseSync(dbPath); db.prepare('UPDATE course_lessons SET per_student_budget_fen=NULL').run(); db.close(); }
  await setGateway(admin, { baseUrl: `http://127.0.0.1:${GW_PORT}`, username: 'root', password: 'p59-password', enabled: true }); // 顺手清路由缓存
  await generate('应当用机构+学生那张令牌');
  check('④ 最具体优先：用「机构+学生」而不是只有「学生」的令牌', gateway.relays.at(-1)?.auth === 'Bearer sk-org-student', String(gateway.relays.at(-1)?.auth));

  /* ⑤ 只剩单段令牌时用它，且——没有课时预算就不自动发牌 */
  gateway.tokens = gateway.tokens.filter((item) => item.name !== [orgName, studentName].join('/'));
  await setGateway(admin, { baseUrl: `http://127.0.0.1:${GW_PORT}`, username: 'root', password: 'p59-password', enabled: true });
  const beforePosts = gateway.tokenPosts.length;
  await generate('应当用只有学生那段的令牌');
  check('⑤ 单段令牌（老约定）也能用上', gateway.relays.at(-1)?.auth === 'Bearer sk-student-only', String(gateway.relays.at(-1)?.auth));
  check('⑤ 没有课时预算时不自动发牌（只记账，不拦）', gateway.tokenPosts.length === beforePosts, `tokenPosts=${gateway.tokenPosts.length}`);

  /* ⑥ 网关说「额度用尽」：明确报错，且**绝不**回退直连（否则闸门形同虚设） */
  const upstreamBeforeQuota = upstream.requests.length;
  quotaExhausted.on = true;
  const quotaRun = await generate('额度用尽应当被拦住');
  check('⑥ 额度用尽：接口报 COMPUTE_QUOTA_EXHAUSTED', quotaRun.error?.code === 'COMPUTE_QUOTA_EXHAUSTED', JSON.stringify(quotaRun).slice(0, 300));
  check('⑥ 额度用尽：提示是给学生看的（不是让管理员重填 key）', /算力额度已用尽/.test(String(quotaRun.error?.message || '')), String(quotaRun.error?.message));
  check('⑥ 额度用尽：没有静默回退直连', upstream.requests.length === upstreamBeforeQuota, `上游多收到 ${upstream.requests.length - upstreamBeforeQuota} 次`);

  /* ⑥b VibeCoding 对话（SSE，另一条代码路径）也要把「额度用尽」讲成学生听得懂的话 ——
        不归一化的话这里透出去的是「AI渠道认证失败…请在管理后台重新填写并保存该渠道 API Key」，
        那是给运维看的，而真正的原因是这个学生这节课的钱花完了。 */
  const conversation = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId, title: 'P59 额度耗尽' } });
  check('⑥ 能开一个 VibeCoding 会话', conversation.status === 200 && Boolean(conversation.data?.id), JSON.stringify(conversation).slice(0, 200));
  const chatResponse = await fetch(`http://127.0.0.1:${port}/api/student/vibecoding/conversations/${encodeURIComponent(conversation.data.id)}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${student}` }, body: JSON.stringify({ content: '额度用尽时我该看到什么' }),
  });
  const chatStream = await chatResponse.text();
  check('⑥ 额度耗尽时 VibeCoding 给学生看的是「算力额度已用尽」', /算力额度已用尽/.test(chatStream), chatStream.slice(-400));
  check('⑥ VibeCoding 的失败码是 COMPUTE_QUOTA_EXHAUSTED', chatStream.includes('COMPUTE_QUOTA_EXHAUSTED'), chatStream.slice(-400));
  check('⑥ VibeCoding 没把运维文案（重填 API Key）甩给学生', !/重新填写并保存该渠道 API Key/.test(chatStream), chatStream.slice(-400));
  quotaExhausted.on = false;

  /* ⑦ 异步任务（worker 是**另一条代码路径**：任务先入队、稍后才在 worker 里真正打上游，
        所以网关出口必须在 worker 里重新解析一遍 —— 靠创建任务时的 selection 是不够的。
        这里把网关上的令牌清空，只有 worker 真的解析过才会又出现一张令牌） */
  { const db = new DatabaseSync(dbPath); db.prepare('UPDATE course_lessons SET per_student_budget_fen=?').run(5000); db.close(); }
  gateway.tokens = [];
  await setGateway(admin, { baseUrl: `http://127.0.0.1:${GW_PORT}`, username: 'root', password: 'p59-password', enabled: true });
  const postsBeforeAsync = gateway.tokenPosts.length;
  const relaysBeforeAsync = gateway.relays.length;
  const queued = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, prompt: '异步任务也应当走网关', modality: 'TEXT' } });
  check('⑦ 异步任务入队成功', queued.status === 200 && queued.data?.job?.id, JSON.stringify(queued).slice(0, 200));
  let asyncJob = null;
  for (let i = 0; i < 60; i += 1) {
    const detail = await api(`/api/ai/generations/history/${encodeURIComponent(queued.data.job.id)}`, { token: student });
    asyncJob = detail.data;
    if (asyncJob && ['SUCCEEDED', 'FAILED'].includes(asyncJob.status)) break;
    await sleep(250);
  }
  check('⑦ 异步任务跑完（成功）', asyncJob?.status === 'SUCCEEDED', JSON.stringify(asyncJob).slice(0, 300));
  const asyncKey = gateway.tokens.find((item) => item.name === expectedTokenName)?.key;
  check('⑦ 异步任务在 worker 里重新解析了令牌（按课时预算发了一张多段令牌）', gateway.tokenPosts.length === postsBeforeAsync + 1 && Boolean(asyncKey), JSON.stringify(gateway.tokenPosts.at(-1)));
  check('⑦ 异步任务的请求也确实打到了网关', gateway.relays.length === relaysBeforeAsync + 1, `relays=${gateway.relays.length}`);
  check('⑦ 异步任务用的是该学生的令牌 key', Boolean(asyncKey) && gateway.relays.at(-1)?.auth === `Bearer ${asyncKey}`, String(gateway.relays.at(-1)?.auth));

  /* ⑧ 模态闸：视频/音乐是异步任务，走的是我们自己的出口（网关不管这两类） */
  Object.assign(process.env, { PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: secretFile, DEPLOYMENT_MODE: 'development', AI_PROVIDER: 'local-mock', AI_PROVIDER_API_KEY: 'direct-secret-key' });
  const routing = await import('../apps/server/src/services/computeGateway.js');
  const videoRoute = await routing.resolveGenerationRoute({ orgId: identity.org_id, studentId: identity.id, lessonId, modality: 'VIDEO' });
  const textRoute = await routing.resolveGenerationRoute({ orgId: identity.org_id, studentId: identity.id, lessonId, modality: 'TEXT' });
  check('⑧ 视频不在网关模态白名单内（回退我们自己的出口）', videoRoute.mode === 'direct' && videoRoute.reason === 'MODALITY_NOT_ON_GATEWAY', JSON.stringify(videoRoute));
  check('⑧ 对话在网关模态白名单内且解析到令牌', textRoute.mode === 'gateway' && textRoute.tokenName === expectedTokenName, JSON.stringify({ mode: textRoute.mode, tokenName: textRoute.tokenName }));

  /* ⑨ 走网关时的请求形状：不带我们自己上游的私有模板/路径，图片路径必须是 new-api 的复数形态 */
  const providerModule = await import('../apps/server/src/services/generationProvider.js');
  const shapeCalls = [];
  const shapeServer = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
    shapeCalls.push({ url: req.url, auth: String(req.headers.authorization || ''), body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: 'https://media.example/sheep.png' }] }));
  });
  await new Promise((resolve) => shapeServer.listen(18951, '127.0.0.1', resolve));
  try {
    const provider = providerModule.getGenerationProvider({
      provider: 'custom', model: 'p59-model', endpoint: 'https://direct.invalid/v1',
      gateway: { endpoint: 'http://127.0.0.1:18951', apiKey: 'sk-gateway-key', tokenName: expectedTokenName },
    });
    const image = await provider.generate({ modality: 'IMAGE', prompt: '一只羊', options: {} });
    check('⑨ 走网关的图片请求用 new-api 的复数路径 /v1/images/generations', shapeCalls[0]?.url === '/v1/images/generations', String(shapeCalls[0]?.url));
    check('⑨ 走网关的图片请求带的是令牌 key（不是上游 key）', shapeCalls[0]?.auth === 'Bearer sk-gateway-key', String(shapeCalls[0]?.auth));
    check('⑨ 图片还能正常解析出素材', /^https:\/\/media\.example\/sheep\.png$/.test(String(image?.assets?.[0]?.assetUrl || '')), JSON.stringify(image).slice(0, 160));
  } finally {
    await new Promise((resolve) => shapeServer.close(resolve));
  }

  console.log(JSON.stringify({ name: 'gateway-routing', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-4000));
  throw error;
} finally {
  server.kill('SIGTERM');
  gatewayServer.close();
  upstreamServer.close();
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
