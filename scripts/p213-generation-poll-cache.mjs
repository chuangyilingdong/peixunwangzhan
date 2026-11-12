/**
 * P213 控制面缓存 · 生成轮询汇总（2026-11-12）。
 *
 * 画布列表每 5 秒轮询一次，`summary.{succeeded,failed,costFen}` 现在按 userId+orgId 缓存 30 秒。
 * 这条守卫钉住：
 *   ① 命中缓存时 loader 只跑一次；single-flight 合并并发未命中；
 *   ② 任务收尾会**按学生**失效 —— 第二次生成后立刻能看到 succeeded+1（不用等 30 秒）；
 *   ③ 失效只影响该学生，别的学生的汇总还在缓存里；
 *   ④ provider 信息缓存可被配置变更清掉；
 *   ⑤ 静态接线：创建/成功/失败/取消/对账/sync 的主要写入点都还挂着失效调用。
 *
 * 跑法：node scripts/p213-generation-poll-cache.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p213-gen-poll-cache-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
process.env.PLATFORM_DATA_DIR = temp;

const { aq, arow, arows } = await import('../packages/database/src/store.js');
const pollCache = await import('../apps/server/src/services/generationPollCache.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ───────────── 单元：汇总缓存 / single-flight / 按用户失效 ───────────── */
{
  pollCache.resetGenerationPollCache();
  let u1Calls = 0;
  const u1Loader = async () => { u1Calls += 1; return { succeeded: u1Calls, failed: 0, costFen: 10 }; };
  await pollCache.generationSummaryFor('u1', 'o1', u1Loader);
  const u1Second = await pollCache.generationSummaryFor('u1', 'o1', u1Loader);
  check('同学生命中缓存：loader 只跑一次', u1Calls === 1 && u1Second.succeeded === 1, `calls=${u1Calls}`);

  let u2Calls = 0;
  const u2Loader = async () => { u2Calls += 1; return { succeeded: 7, failed: 1, costFen: 70 }; };
  await pollCache.generationSummaryFor('u2', 'o1', u2Loader);
  pollCache.invalidateGenerationSummaryFor('u1');
  const u1Third = await pollCache.generationSummaryFor('u1', 'o1', u1Loader);
  await pollCache.generationSummaryFor('u2', 'o1', u2Loader);
  check('按学生失效：目标学生重算、别的学生仍命中',
    u1Calls === 2 && u1Third.succeeded === 2 && u2Calls === 1, `u1=${u1Calls} u2=${u2Calls}`);

  let slowCalls = 0;
  const slowLoader = async () => { slowCalls += 1; await sleep(30); return { succeeded: 3, failed: 0, costFen: 0 }; };
  await Promise.all([
    pollCache.generationSummaryFor('u3', 'o1', slowLoader),
    pollCache.generationSummaryFor('u3', 'o1', slowLoader),
  ]);
  check('并发未命中由 single-flight 合并', slowCalls === 1, `calls=${slowCalls}`);

  let providerCalls = 0;
  const providerLoader = async () => { providerCalls += 1; return { provider: 'local-mock', mode: 'mock' }; };
  await pollCache.generationProviderInfoFor(providerLoader);
  await pollCache.generationProviderInfoFor(providerLoader);
  check('provider 信息命中缓存', providerCalls === 1, `calls=${providerCalls}`);
  pollCache.invalidateGenerationProviderInfo();
  await pollCache.generationProviderInfoFor(providerLoader);
  check('provider 配置变更可清缓存', providerCalls === 2, `calls=${providerCalls}`);
}

/* ───────────── 静态：写入点接线 ───────────── */
{
  const read = (file) => stripComments(fs.readFileSync(path.join(root, file), 'utf8'));
  const ai = read('apps/server/src/routes/aiGeneration.js');
  check('列表用 generationSummaryFor 包聚合', ai.includes('generationSummaryFor(auth.user.id, orgId'));
  check('列表 provider 走缓存', ai.includes('generationProviderInfoFor(() => generationProviderInfo())'));
  check('失败路径按学生失效', ai.includes('invalidateGenerationSummaryFor(userId)'));
  check('成功 / 取消按学生失效', (ai.match(/invalidateGenerationSummaryFor\(auth\.user\.id\)/g) || []).length >= 2);
  check('对账成功按学生失效', ai.includes('invalidateGenerationSummaryFor(candidate.user_id)'));
  check('attempt 补账会清全量汇总', ai.includes('invalidateGenerationSummaries()'));

  const lib = read('apps/server/src/lib.js');
  check('resolveAuth 先读用户缓存', lib.includes('getCachedAuthUser(session.user_id)'));
  check('resolveAuth 命中缓存仍跑账号可用性断言', lib.includes('assertUserAccountAvailable(user, org)'));
  check('sessions 仍然实时查', lib.includes("SELECT * FROM sessions WHERE token_hash = ?"));

  for (const [file, label] of [
    ['apps/server/src/routes/orgAdmin.js', '机构端成员写入'],
    ['apps/server/src/routes/admin/users.js', '平台用户写入'],
    ['apps/server/src/routes/admin/organizations.js', '机构写入'],
    ['apps/server/src/routes/student.js', '学生自助写入'],
  ]) {
    check(`${label}挂着 invalidateAuthUser/invalidateAuthOrg`, /invalidateAuth(User|Org)\(/.test(read(file)));
  }
}

/* ───────────── 真服务：两次生成后汇总立刻更新 ───────────── */
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const student = await arow("SELECT id, org_id FROM users WHERE login='student-2'");
const grant = await arow('SELECT id, series_id FROM student_course_grants WHERE student_id=? AND revoked_at IS NULL', [student.id]);
assert.ok(grant?.series_id, '种子学生没有可用课包');
await aq('UPDATE student_course_grants SET granted_units=50 WHERE id=?', [grant.id]);
const lesson = (await arows("SELECT id FROM course_lessons WHERE series_id=? AND status='PUBLISHED' ORDER BY sort LIMIT 1", [grant.series_id]))[0];
assert.ok(lesson?.id, '种子课包没有已发布课时');
await aq("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))", [lesson.id]);

const port = 19121;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
}

async function login(loginName, password) {
  const result = await api('/api/auth/login', { method: 'POST', body: { login: loginName, password } });
  assert.equal(result.status, 200, `${loginName} 登录失败: ${JSON.stringify(result.raw).slice(0, 300)}`);
  return result.data.token;
}

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ }
    await sleep(100);
  }
  const teacher = await login('teacher-1', 'teach123');
  const studentToken = await login('student-2', 'study123');

  const session = (await api('/api/org/sessions', { method: 'POST', token: teacher, body: { lessonId: lesson.id, title: 'P213 汇总缓存' } })).data;
  assert.ok(session?.id, `建课堂失败: ${serverLog.slice(-500)}`);
  check('学员加得进去', (await api(`/api/org/sessions/${session.id}/students`, { method: 'POST', token: teacher, body: { studentIds: [student.id] } })).data?.added?.length === 1);
  check('开始上课', (await api(`/api/org/sessions/${session.id}/start`, { method: 'POST', token: teacher })).data?.status === 'ACTIVE');

  const project = (await api('/api/student/projects', { method: 'POST', token: studentToken, body: { courseLessonId: lesson.id, title: 'P213 汇总缓存' } })).data;
  assert.ok(project?.id, `建项目失败: ${serverLog.slice(-500)}`);
  const generate = (prompt) => api('/api/ai/generations', { method: 'POST', token: studentToken, body: { projectId: project.id, prompt, modality: 'TEXT' } });
  const list = () => api(`/api/ai/generations?projectId=${project.id}`, { token: studentToken });

  const first = await generate('P213 第一次');
  check('第一次生成 200', first.status === 200, JSON.stringify(first.raw).slice(0, 400));
  const firstList = await list();
  check('列表第一次汇总 succeeded=1（写入缓存）', firstList.data?.summary?.succeeded === 1, JSON.stringify(firstList.data?.summary));
  check('列表 provider 信息可用', firstList.data?.provider?.provider === 'local-mock', JSON.stringify(firstList.data?.provider));

  const second = await generate('P213 第二次');
  check('第二次生成 200', second.status === 200, JSON.stringify(second.raw).slice(0, 400));
  const secondList = await list();
  check('第二次生成后立刻看到 succeeded=2（按学生失效，不等 30 秒）',
    secondList.data?.summary?.succeeded === 2, JSON.stringify(secondList.data?.summary));
  check('total 实时跟上（不缓存）', secondList.data?.total === 2, String(secondList.data?.total));

  const thirdList = await list();
  check('再轮询一次仍然正确（缓存命中路径）', thirdList.data?.summary?.succeeded === 2, JSON.stringify(thirdList.data?.summary));
} finally {
  server.kill('SIGTERM');
}

if (failures) {
  console.error(`P213 FAILED: ${failures} 项`);
  process.exit(1);
}
console.log('P213 passed: 生成轮询汇总缓存（命中/按学生失效/single-flight/写入点接线）');
