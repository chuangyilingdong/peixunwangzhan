/**
 * P205 「自动提交视为已同意展示」守卫（2026-11-03）。
 *
 * 用户口径：**学生作品不存在版权**。客户端课后自动补交固定带 `copyrightConfirmed: false`，
 * 平台不能因此把作品永远挡在广场外 —— `auto_submitted=1` 视为已同意展示。
 *
 * 这一道钉住：
 *   ① 画布：auto_submitted=1、版权未确认 → 平台可发布；公开列表/详情能看到；
 *      学生端「我的作品」canTogglePublic=true；
 *   ② 画布：auto_submitted=0 且版权未确认 → 仍然 409 WORK_COPYRIGHT_CONFIRMATION_REQUIRED（对照组）；
 *   ③ 手动重新提交会补上版权确认并清掉 auto_submitted（自动作品不会被永久标记）；
 *   ④ VibeCoding：auto_submitted=1、版权未确认 → 可发布，公开列表/详情能看到；
 *      对照组（auto_submitted=0）仍然 409。
 *
 * 跑法：node scripts/p205-auto-submit-display-consent.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { endActiveClassrooms, ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p205-display-consent-'));
const dbPath = path.join(temp, 'platform.db');
// 套件会给每个脚本设 PLATFORM_DB_PATH；这里硬设，保证夹具与服务子进程读同一个库。
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const PORT = 18991;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p205-guard-secret',
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

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);

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
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null };
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
  const student = await login('student-1', 'study123');
  const orgToken = await login('org-admin', 'org123');
  assert.ok(admin && student && orgToken, '登录失败');

  const courses = await api('/api/student/courses', { token: student });
  const courseItems = courses.data?.items || courses.data?.courses || [];
  const lessonId = courseItems?.[0]?.currentLessonId || courseItems?.[0]?.lessons?.[0]?.id || courseItems?.[0]?.lesson?.id || courseItems?.[0]?.id;
  assert.ok(lessonId, '拿不到学生可用的课时');

  const snapshot = (text) => ({ nodes: [{ id: `p205-${text}`, data: { generatedText: text } }], edges: [] });
  const createProject = async (title) => {
    const created = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title } });
    assert.equal(created.status, 200, JSON.stringify(created.data).slice(0, 300));
    return created.data.id;
  };
  const submitProject = async (projectId, text) => api(`/api/student/projects/${encodeURIComponent(projectId)}/submit`, {
    method: 'POST', token: student,
    body: { canvasSnapshot: snapshot(text), description: 'P205 展示授权', copyrightConfirmed: true },
  });
  const workIdOf = (submitted) => submitted.data?.work?.id || submitted.data?.id;

  /* ── ① 画布：手动提交 → 模拟自动提交 → 可发布 ── */
  const autoProjectId = await createProject('P205 自动提交作品');
  const firstSubmit = await submitProject(autoProjectId, 'p205-first');
  const autoWorkId = workIdOf(firstSubmit);
  assert.ok(autoWorkId, `首次提交失败：${JSON.stringify(firstSubmit).slice(0, 300)}`);
  // 模拟「课堂结束自动提交」：版权未确认、auto_submitted=1（与 sessionAutoSubmit 落库形状一致）。
  await aq('UPDATE works SET auto_submitted=1,copyright_confirmed_at=NULL,copyright_confirmed_by=NULL WHERE id=?', [autoWorkId]);

  /* ── ③ 手动重新提交：补上版权确认、清掉自动标记 ── */
  const resubmit = await submitProject(autoProjectId, 'p205-second');
  await check('手动重新提交自动作品 → 200，并补上展示授权、清掉 auto_submitted', async () => {
    assert.equal(resubmit.status, 200, JSON.stringify(resubmit.data).slice(0, 300));
    const row = await arow('SELECT auto_submitted,copyright_confirmed_at FROM works WHERE id=?', [autoWorkId]);
    assert.equal(Number(row.auto_submitted), 0);
    assert.ok(row.copyright_confirmed_at, '手动提交必须写入展示授权');
    const round = await arow('SELECT round FROM work_submissions WHERE work_id=? ORDER BY round DESC LIMIT 1', [autoWorkId]);
    assert.equal(Number(round?.round), 2);
  });
  // 再摆回自动提交形状，验证发布门禁。
  await aq('UPDATE works SET auto_submitted=1,copyright_confirmed_at=NULL,copyright_confirmed_by=NULL WHERE id=?', [autoWorkId]);

  /* ── ② 对照组：非自动提交且未确认 → 仍被挡 ──
     ⚠️ 学生的项目是「每节课一个」，不能靠再建一个项目造第二件作品；
     这里直接落一件独立作品（class_session_id 为空，避开"课堂进行中不许发布"那条闸）。 */
  const controlProjectId = 'p205_control_project';
  const controlWorkId = 'p205_control_work';
  {
    const studentRow = await arow("SELECT id,org_id FROM users WHERE login='student-1' LIMIT 1");
    const nowIso = new Date().toISOString();
    await aq(`INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,class_session_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at)
      VALUES (?,?,?,NULL,?,NULL,?,'SUBMITTED','{"nodes":[],"edges":[]}',1,?,?,?)`,
    [controlProjectId, studentRow.id, studentRow.org_id, lessonId, 'P205 未确认作品', nowIso, nowIso, nowIso]);
    await aq(`INSERT INTO works(id,project_id,student_id,org_id,class_id,class_session_id,course_lesson_id,title,description,canvas_snapshot,status,submitted_at,copyright_confirmed_at,copyright_confirmed_by,auto_submitted)
      VALUES (?,?,?,?,NULL,NULL,?,?, '', '{"nodes":[],"edges":[]}', 'PENDING', ?, NULL, NULL, 0)`,
    [controlWorkId, controlProjectId, studentRow.id, studentRow.org_id, lessonId, 'P205 未确认作品', nowIso]);
  }

  // 课堂还在进行中不许发布；按真实顺序先下课，再发布。
  await endActiveClassrooms({ api, orgToken });

  await check('画布：auto_submitted=1 且版权未确认 → 平台可发布到广场', async () => {
    const published = await api(`/api/admin/works/${encodeURIComponent(autoWorkId)}/plaza`, { method: 'PUT', token: admin, body: { published: true } });
    assert.equal(published.status, 200, JSON.stringify({ data: published.data, error: published.error }).slice(0, 400));
    const row = await arow('SELECT is_public,share_token FROM works WHERE id=?', [autoWorkId]);
    assert.equal(Number(row.is_public), 1);
    assert.ok(row.share_token, '发布后必须有分享码');
  });
  await check('画布：auto_submitted=0 且版权未确认 → 仍然 409', async () => {
    const blocked = await api(`/api/admin/works/${encodeURIComponent(controlWorkId)}/plaza`, { method: 'PUT', token: admin, body: { published: true } });
    assert.equal(blocked.status, 409, JSON.stringify({ data: blocked.data, error: blocked.error }).slice(0, 300));
    assert.equal(blocked.error?.code, 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
  });

  const autoWork = await arow('SELECT share_token FROM works WHERE id=?', [autoWorkId]);
  await check('画布：公开列表包含自动提交作品', async () => {
    const list = await api('/api/public/works?limit=500');
    assert.equal(list.status, 200);
    assert.ok((list.data?.items || []).some((item) => item.id === autoWorkId), '公开列表里没有自动提交作品');
  });
  await check('画布：公开详情按分享码可打开', async () => {
    const detail = await api(`/api/public/works/${encodeURIComponent(autoWork.share_token)}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.data).slice(0, 300));
    assert.equal(detail.data?.id, autoWorkId);
  });
  await check('学生端「我的作品」：自动提交作品 canTogglePublic=true', async () => {
    const mine = await api('/api/student/works?limit=100', { token: student });
    const item = (mine.data?.items || []).find((entry) => entry.id === autoWorkId);
    assert.ok(item, '学生作品列表里没有这件作品');
    assert.equal(item.actions?.canTogglePublic, true);
  });
  await check('平台作品列表回传 autoSubmitted=true（后台按钮据此放开）', async () => {
    const list = await api('/api/admin/works?limit=100&sort=submitted', { token: admin });
    const item = (list.data?.items || []).find((entry) => entry.id === autoWorkId);
    assert.ok(item, '平台作品列表里没有这件作品');
    assert.equal(item.autoSubmitted, true);
  });

  /* ── ④ VibeCoding 链路 ── */
  const studentRow = await arow("SELECT id,org_id FROM users WHERE login='student-1' LIMIT 1");
  assert.ok(studentRow, '种子学生缺失');
  const now = new Date().toISOString();
  const addSubmission = async (id, auto) => {
    await aq(`INSERT INTO vibecoding_conversations(id,org_id,student_id,class_id,lesson_id,class_session_id,title,status,created_at,updated_at)
      VALUES (?,?,?,NULL,?,NULL,?,'DRAFT',?,?)`,
    [`p205_conv_${id}`, studentRow.org_id, studentRow.id, lessonId, `P205 ${id}`, now, now]);
    await aq(`INSERT INTO vibecoding_submissions(id,conversation_id,client_task_id,auto_submitted,student_id,org_id,class_id,lesson_id,title,description,files,transcript,round,status,submitted_at,created_at,updated_at,entry_file,copyright_confirmed_at,is_public)
      VALUES (?,?,'',?,?,?,NULL,?,?, '', '{}', '[]', 1, 'PENDING', ?, ?, ?, 'index.html', NULL, 0)`,
    [id, `p205_conv_${id}`, auto ? 1 : 0, studentRow.id, studentRow.org_id, lessonId, `P205 ${id}`, now, now, now]);
  };
  await addSubmission('p205_vibe_auto', true);
  await addSubmission('p205_vibe_control', false);

  await check('VibeCoding：auto_submitted=1 且版权未确认 → 平台可发布', async () => {
    const published = await api('/api/admin/vibecoding-works/p205_vibe_auto/plaza', { method: 'PUT', token: admin, body: { published: true } });
    assert.equal(published.status, 200, JSON.stringify({ data: published.data, error: published.error }).slice(0, 400));
    const row = await arow('SELECT is_public,share_token FROM vibecoding_submissions WHERE id=?', ['p205_vibe_auto']);
    assert.equal(Number(row.is_public), 1);
    assert.ok(row.share_token);
  });
  await check('VibeCoding：auto_submitted=0 且版权未确认 → 仍然 409', async () => {
    const blocked = await api('/api/admin/vibecoding-works/p205_vibe_control/plaza', { method: 'PUT', token: admin, body: { published: true } });
    assert.equal(blocked.status, 409, JSON.stringify({ data: blocked.data, error: blocked.error }).slice(0, 300));
    assert.equal(blocked.error?.code, 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
  });
  const vibeAuto = await arow('SELECT share_token FROM vibecoding_submissions WHERE id=?', ['p205_vibe_auto']);
  await check('VibeCoding：公开列表/详情包含自动提交作品', async () => {
    const list = await api('/api/public/vibecoding-works?limit=500');
    assert.equal(list.status, 200);
    assert.ok((list.data?.items || []).some((item) => item.id === 'p205_vibe_auto'), '公开列表里没有自动提交的 VibeCoding 作品');
    const detail = await api(`/api/public/vibecoding-works/${encodeURIComponent(vibeAuto.share_token)}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.data).slice(0, 300));
  });
} finally {
  server.kill('SIGTERM');
  await sleep(300);
}

const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.ok ? '' : `\n   ${item.message}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) process.exitCode = 1;
