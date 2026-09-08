/**
 * P14 列表分页契约。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 背景：机构任务 / 课包 / 举报 / 积分流水 / 学员作品等列表此前全量返回（或硬编码 LIMIT），
 * 既可能拖慢接口，也会在第 N+1 条时静默丢数据。本轮统一改为 page/limit/total/totalPages。
 *
 * 覆盖：分页元数据正确、翻页不重复不遗漏、total 是筛选后的总数（不是本页条数）、
 *       超范围 limit / 非法 page 被拒。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p14-pagination-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18844;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });
server.stdout.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}

const results = {};
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const orgLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
  assert.equal(orgLogin.status, 200, `机构管理员登录失败: ${JSON.stringify(orgLogin.data)}`);
  const org = orgLogin.data.token;
  const studentLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } });
  assert.equal(studentLogin.status, 200, `学生登录失败: ${JSON.stringify(studentLogin.data)}`);
  const student = studentLogin.data.token;

  // 1) 机构任务：造 3 条，limit=2 应分两页且不重复
  const classes = await api('/api/org/classes', { token: org });
  const classId = classes.data.items[0].id;
  for (const title of ['P14 任务一', 'P14 任务二', 'P14 任务三']) {
    const created = await api('/api/org/teaching/tasks', { method: 'POST', token: org, body: { classId, title, description: '分页用例' } });
    assert.equal(created.status, 200, `创建任务失败: ${JSON.stringify(created.data)}`);
  }
  const tasksPage1 = await api('/api/org/teaching/tasks?limit=2&page=1', { token: org });
  const tasksPage2 = await api('/api/org/teaching/tasks?limit=2&page=2', { token: org });
  assert.equal(tasksPage1.data.items.length, 2, '第 1 页应返回 limit 条');
  assert.equal(tasksPage1.data.limit, 2, 'limit 应回显');
  assert.equal(tasksPage1.data.total >= 3, true, `total 应为筛选后总数，实际 ${tasksPage1.data.total}`);
  assert.equal(tasksPage1.data.totalPages, Math.ceil(tasksPage1.data.total / 2), 'totalPages 应与 total/limit 一致');
  assert.ok(tasksPage2.data.items.length >= 1, '第 2 页应有剩余数据');
  const taskIds = new Set([...tasksPage1.data.items, ...tasksPage2.data.items].map((item) => item.id));
  assert.equal(taskIds.size, tasksPage1.data.items.length + tasksPage2.data.items.length, '两页之间不应重复');
  results.teachingTasks = { total: tasksPage1.data.total, totalPages: tasksPage1.data.totalPages };

  // 2) 积分流水：3 条人工调整，limit=2 分两页
  for (let i = 0; i < 3; i += 1) {
    const adjusted = await api('/api/org/billing/credit-adjustments', { method: 'POST', token: org, body: { type: 'ORG_ADJUSTMENT_IN', credits: 1, reason: `P14 分页用例 ${i + 1}` } });
    assert.equal(adjusted.status, 200, `积分调整失败: ${JSON.stringify(adjusted.data)}`);
  }
  const entries = await api('/api/org/billing/credit-entries?limit=2&page=1', { token: org });
  assert.equal(entries.data.items.length, 2, '积分流水第 1 页应为 2 条');
  assert.equal(entries.data.total >= 3, true, `积分流水 total 应为总数，实际 ${entries.data.total}`);
  assert.equal(entries.data.totalPages, Math.ceil(entries.data.total / 2), '积分流水 totalPages 不正确');
  results.creditEntries = { total: entries.data.total, totalPages: entries.data.totalPages };

  // 3) 学员作品：提交 2 件，limit=1 分页；summary 跨页统计
  const courses = await api('/api/student/courses', { token: student });
  const courseItems = courses.data?.items || courses.data?.courses || [];
  const lessonId = courseItems?.[0]?.currentLessonId || courseItems?.[0]?.lessons?.[0]?.id || courseItems?.[0]?.lesson?.id || courseItems?.[0]?.id;
  assert.ok(lessonId, `未获取到课时 ID: ${JSON.stringify(courses.data)}`);
  for (const title of ['P14 作品一', 'P14 作品二']) {
    const created = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title } });
    assert.equal(created.status, 200, `学生项目创建失败: ${JSON.stringify(created.data)}`);
    const submitted = await api(`/api/student/projects/${created.data.id}/submit`, { method: 'POST', token: student, body: { copyrightConfirmed: true } });
    assert.equal(submitted.status, 200, `作品提交失败: ${JSON.stringify(submitted.data)}`);
  }
  const works = await api('/api/student/works?limit=1&page=1', { token: student });
  assert.equal(works.data.items.length, 1, '学员作品第 1 页应为 1 条');
  assert.equal(works.data.total >= 2, true, `学员作品 total 应为总数，实际 ${works.data.total}`);
  assert.equal(works.data.summary?.total, works.data.total, 'summary.total 应与分页 total 一致（跨页统计）');
  results.studentWorks = { total: works.data.total, totalPages: works.data.totalPages, summaryTotal: works.data.summary?.total };

  // 4) 非法分页参数被拒（limit 超过上限、page 非法）
  const tooLarge = await api('/api/org/teaching/tasks?limit=9999', { token: org });
  assert.equal(tooLarge.status, 400, 'limit 超过上限应 400');
  assert.equal(tooLarge.data?.error?.code, 'VALIDATION_ERROR', `应为 VALIDATION_ERROR，实际 ${tooLarge.data?.error?.code}`);
  const badPage = await api('/api/org/teaching/tasks?page=0', { token: org });
  assert.equal(badPage.status, 400, 'page=0 应 400');
  results.validation = { tooLarge: tooLarge.data?.error?.code, badPage: badPage.data?.error?.code };

  console.log(JSON.stringify({ name: 'list-pagination', pass: true, ...results }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
