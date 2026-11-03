/**
 * P206 「作品调用模型」守卫（2026-11-03）。
 *
 * 用户口径：学生作品运行时可以调**平台的 Key**（默认智谱 GLM-4-Flash），
 * 学生端 / 客户端 / 老师端 / 作品广场 / 学生主页都要能用；Key 绝不下发。
 *
 * 这一道钉住：
 *   ① 后台专用配置：GET/PUT/试一次；Key 只写不读（GET 只回 keyConfigured）；
 *   ② 课堂授予：client-context 拿到 worksLlm.grant；课堂内可调用；老师结束课堂后立即 403；
 *   ③ 预览/公开授予：admin/org 作品详情、公开作品详情都带 grant，且能调通；
 *   ④ 配额：studentDaily 用尽后返回 WORK_LLM_QUOTA_EXCEEDED；总开关关掉返回 WORK_LLM_DISABLED；
 *   ⑤ CORS：Origin: null 的 preflight 与 POST 都回 ACAO: null（沙箱是 opaque origin）；
 *   ⑥ 桥：buildPreviewDocument 注入 grant、不注入 Key；没有 worksLlm 时完全不注入。
 *
 * 跑法：node scripts/p206-works-llm.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p206-works-llm-'));
const dbPath = path.join(temp, 'platform.db');
const secretFile = path.join(temp, 'provider-secrets.json');
process.env.PLATFORM_DB_PATH = dbPath;
process.env.AI_PROVIDER_SECRET_FILE = secretFile;
process.env.WORK_LLM_GRANT_SECRET = 'p206-grant-secret';
const { aq, arow, arows } = await import('../packages/database/src/store.js');
const { issueWorksLlmGrant } = await import('../apps/server/src/services/workLlm.js');

const PORT = 18992;
const MOCK_PORT = 18993;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: dbPath,
  AI_PROVIDER_SECRET_FILE: secretFile,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p206-guard-secret',
  WORK_LLM_GRANT_SECRET: 'p206-grant-secret',
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
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

// 假上游：只认 Bearer test-key，回一个可辨认的正文 + usage。
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer test-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
    const last = [...(payload.messages || [])].reverse().find((item) => item.role === 'user');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: payload.model || 'mock-model',
      choices: [{ message: { role: 'assistant', content: `MOCK: ${String(last?.content || '')}` } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }));
  });
});
await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);
await aq("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);
await aq("UPDATE class_sessions SET delivery_mode='VIBECODING'");

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body, headers = {} } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null, headers: response.headers };
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-800)}`);
    await sleep(150);
  }

  const login = async (l, p) => (await api('/api/auth/login', { method: 'POST', body: { login: l, password: p } })).data.token;
  const admin = await login('root', 'admin123');
  const orgToken = await login('org-admin', 'org123');
  const classroom = await arow("SELECT * FROM class_sessions WHERE status='ACTIVE' ORDER BY created_at LIMIT 1");
  const student = await arow(`SELECT student.id, student.login FROM session_students part
       JOIN users student ON student.id=part.student_id
      WHERE part.session_id=? AND part.status='ACTIVE' ORDER BY student.created_at LIMIT 1`, [classroom.id]);
  assert.ok(admin && orgToken && student?.login, '登录或夹具失败');
  const studentToken = await login(student.login, 'study123');

  const configBody = {
    config: {
      enabled: true,
      endpoint: `http://127.0.0.1:${MOCK_PORT}/chat/completions`,
      model: 'mock-model',
      maxTokens: 128,
      temperature: 0.2,
      timeoutMs: 10000,
      scopes: { classroom: true, preview: true, public: true },
      quotas: { studentDaily: 200, workDaily: 200, ipDaily: 200, globalDaily: 5000, qps: 50 },
    },
    apiKey: 'test-key',
  };

  await check('后台保存配置 + Key → GET 只回 keyConfigured，不回 Key', async () => {
    const saved = await api('/api/admin/works-llm', { method: 'PUT', token: admin, body: configBody });
    assert.equal(saved.status, 200, JSON.stringify(saved.error || saved.data).slice(0, 300));
    assert.equal(saved.data?.keyConfigured, true);
    const read = await api('/api/admin/works-llm', { token: admin });
    assert.equal(read.status, 200);
    assert.equal(read.data?.keyConfigured, true);
    assert.equal(JSON.stringify(read.data).includes('test-key'), false, 'GET 不能把 Key 回出来');
    assert.equal(read.data?.config?.model, 'mock-model');
  });
  await check('后台「试一次」→ 上游返回 MOCK 正文', async () => {
    const tested = await api('/api/admin/works-llm/test', { method: 'POST', token: admin, body: {} });
    assert.equal(tested.status, 200, JSON.stringify(tested.error || tested.data).slice(0, 300));
    assert.equal(tested.data?.ok, true, JSON.stringify(tested.data).slice(0, 300));
    assert.match(String(tested.data?.content || ''), /MOCK/);
  });

  // 一件 VibeCoding 作品（公开，auto_submitted=1 走 2026-11-03 的展示授权口径）
  const now = new Date().toISOString();
  await aq(`INSERT INTO vibecoding_conversations(id,org_id,student_id,class_id,lesson_id,class_session_id,title,status,created_at,updated_at)
    VALUES (?,?,?,NULL,?,?, 'P206 作品', 'DRAFT', ?, ?)`,
  ['p206_conv', classroom.org_id, student.id, classroom.lesson_id, classroom.id, now, now]);
  await aq(`INSERT INTO vibecoding_submissions(id,conversation_id,client_task_id,auto_submitted,student_id,org_id,class_id,lesson_id,title,description,files,transcript,artifacts,round,status,submitted_at,created_at,updated_at,entry_file,copyright_confirmed_at,is_public,share_token)
    VALUES (?,?,'',1,?,?,NULL,?,?, '', '{}', '[]', '[]', 1, 'PENDING', ?, ?, ?, 'index.html', NULL, 1, 'vbt_p206')`,
  ['p206_submission', 'p206_conv', student.id, classroom.org_id, classroom.lesson_id, 'P206 作品', now, now, now]);

  const classroomGrant = issueWorksLlmGrant({ scope: 'classroom', subject: student.id, userId: student.id, classroomId: classroom.id });
  const previewGrant = issueWorksLlmGrant({ scope: 'preview', subject: 'p206_submission', userId: 'root', workId: 'p206_submission' });
  const publicGrant = issueWorksLlmGrant({ scope: 'public', subject: 'p206_submission', workId: 'p206_submission' });
  const chat = (grant, content = '你好') => api('/api/works-llm/chat', {
    method: 'POST', headers: { origin: 'null' },
    body: { grant, messages: [{ role: 'user', content }] },
  });

  await check('课堂内：grant 可调用，上游返回 MOCK', async () => {
    const result = await chat(classroomGrant, '课堂问题');
    assert.equal(result.status, 200, JSON.stringify(result.error || result.data).slice(0, 300));
    assert.equal(result.data?.ok, true, JSON.stringify(result.data).slice(0, 300));
    assert.match(String(result.data?.content || ''), /MOCK: 课堂问题/);
    assert.equal(result.data?.usage?.prompt_tokens, 7);
  });
  await check('CORS：Origin: null 的 POST 回 ACAO: null', async () => {
    const result = await chat(classroomGrant, 'cors');
    assert.equal(result.headers.get('access-control-allow-origin'), 'null');
  });
  await check('CORS：preflight（OPTIONS）回 204 + ACAO: null', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/works-llm/chat`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  });
  await check('client-context：课堂内下发 worksLlm.grant', async () => {
    const context = await api('/api/student/runtime/client-context', { token: studentToken });
    assert.equal(context.status, 200, JSON.stringify(context.error).slice(0, 200));
    assert.equal(typeof context.data?.worksLlm?.grant, 'string');
  });

  await check('配额：studentDaily=1 用尽后拒绝，返回 WORK_LLM_QUOTA_EXCEEDED', async () => {
    const saved = await api('/api/admin/works-llm', {
      method: 'PUT', token: admin,
      body: { config: { ...configBody.config, quotas: { ...configBody.config.quotas, studentDaily: 1 } } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.error).slice(0, 200));
    const blocked = await chat(classroomGrant, 'second');
    assert.equal(blocked.status, 200);
    assert.equal(blocked.data?.ok, false, JSON.stringify(blocked.data).slice(0, 300));
    assert.equal(blocked.data?.code, 'WORK_LLM_QUOTA_EXCEEDED');
    await api('/api/admin/works-llm', { method: 'PUT', token: admin, body: { config: configBody.config } });
  });

  await check('老师端/平台端/公开作品详情都带 worksLlm.grant', async () => {
    const adminDetail = await api('/api/admin/vibecoding-works/p206_submission', { token: admin });
    assert.equal(adminDetail.status, 200, JSON.stringify(adminDetail.error).slice(0, 200));
    assert.equal(typeof adminDetail.data?.worksLlm?.grant, 'string');
    const orgDetail = await api('/api/org/works/VIBECODING/p206_submission', { token: orgToken });
    assert.equal(orgDetail.status, 200, JSON.stringify(orgDetail.error).slice(0, 200));
    assert.equal(typeof orgDetail.data?.worksLlm?.grant, 'string');
    const publicDetail = await api('/api/public/vibecoding-works/vbt_p206');
    assert.equal(publicDetail.status, 200, JSON.stringify(publicDetail.error).slice(0, 200));
    assert.equal(typeof publicDetail.data?.worksLlm?.grant, 'string');
  });

  await check('无效 grant → 403 WORK_LLM_GRANT_INVALID', async () => {
    const result = await chat('not-a-grant', 'x');
    assert.equal(result.status, 403);
    assert.equal(result.error?.code, 'WORK_LLM_GRANT_INVALID');
  });

  await check('老师结束课堂 → 课堂 grant 立即 403 WORK_LLM_CLASSROOM_CLOSED', async () => {
    const ended = await api(`/api/org/sessions/${encodeURIComponent(classroom.id)}/end`, { method: 'POST', token: orgToken, body: {} });
    assert.equal(ended.status, 200, JSON.stringify(ended.error || ended.data).slice(0, 300));
    const result = await chat(classroomGrant, 'after class');
    assert.equal(result.status, 403);
    assert.equal(result.error?.code, 'WORK_LLM_CLASSROOM_CLOSED');
  });

  await check('预览 grant / 公开 grant 都能调用', async () => {
    const preview = await chat(previewGrant, '预览');
    assert.equal(preview.status, 200, JSON.stringify(preview.error || preview.data).slice(0, 300));
    assert.equal(preview.data?.ok, true);
    const publicResult = await chat(publicGrant, '广场');
    assert.equal(publicResult.status, 200, JSON.stringify(publicResult.error || publicResult.data).slice(0, 300));
    assert.equal(publicResult.data?.ok, true);
  });

  await check('总开关关闭 → WORK_LLM_DISABLED；重新打开恢复', async () => {
    await api('/api/admin/works-llm', { method: 'PUT', token: admin, body: { config: { ...configBody.config, enabled: false } } });
    const off = await chat(previewGrant, 'off');
    assert.equal(off.data?.ok, false);
    assert.equal(off.data?.code, 'WORK_LLM_DISABLED');
    await api('/api/admin/works-llm', { method: 'PUT', token: admin, body: { config: configBody.config } });
    const on = await chat(previewGrant, 'on');
    assert.equal(on.data?.ok, true);
  });

  await check('桥：buildPreviewDocument 注入 grant、不注入 Key；无 worksLlm 时不注入', async () => {
    const { buildPreviewDocument, LLM_BRIDGE } = await import('../packages/shared/src/vibecodingProject.js');
    // 平台路径必须在「没填 Key」的分支之前判：填了 Key 的作品仍然走 BYO-Key 直连。
    assert.match(LLM_BRIDGE, /PLATFORM_LLM_PATH='\/api\/works-llm\/chat'/);
    const platformCheck = LLM_BRIDGE.indexOf('callPlatform(platform,body,init)');
    const keyCheck = LLM_BRIDGE.indexOf('if(!key)');
    assert.ok(platformCheck >= 0 && keyCheck > platformCheck, '平台分支必须排在 "if(!key)" 之前');
    const files = { 'index.html': '<!doctype html><html><body>hi</body></html>' };
    const withGrant = buildPreviewDocument(files, 'index.html', { worksLlm: { grant: 'GRANT_ABC' } });
    assert.match(withGrant, /window\.__PLATFORM_WORK_LLM__=/);
    assert.match(withGrant, /GRANT_ABC/);
    assert.equal(withGrant.includes('test-key'), false, '文档里不能出现 Key');
    const without = buildPreviewDocument(files, 'index.html');
    assert.equal(/window\.__PLATFORM_WORK_LLM__=/.test(without), false);
  });
} finally {
  server.kill('SIGTERM');
  mock.close();
  await sleep(300);
}

const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.ok ? '' : `\n   ${item.message}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) process.exitCode = 1;
