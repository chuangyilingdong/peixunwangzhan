/**
 * P14 列表分页契约。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 背景：机构任务 / 课包 / 举报 / 积分流水 / 学员作品等列表此前全量返回（或硬编码 LIMIT），
 * 既可能拖慢接口，也会在第 N+1 条时静默丢数据。本轮统一改为 page/limit/total/totalPages。
 *
 * 覆盖：分页元数据正确、翻页不重复不遗漏、total 是筛选后的总数（不是本页条数）、
 *       超范围 limit / 非法 page 被拒。
 *
 * ⚠️ 2026-09-11 机构端删掉「课堂任务」「积分流水」两个分页口（见交接说明第三节），
 * 原用例 1、2 改到**保留的**分页口上（机构课包列表由平台端现造数据），
 * 并顺带断言那两个接口已经不存在 —— 别把「删了功能但用例还绿」当成契约仍在。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

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
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
    await sleep(100);
  }

  const orgLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
  assert.equal(orgLogin.status, 200, `机构管理员登录失败: ${JSON.stringify(orgLogin.data)}`);
  const org = orgLogin.data.token;
  const studentLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } });
  assert.equal(studentLogin.status, 200, `学生登录失败: ${JSON.stringify(studentLogin.data)}`);
  const student = studentLogin.data.token;

  // 0) 被删掉的两个分页口必须已经不存在（课堂任务 / 积分流水，2026-09-11）
  const goneTasks = await api('/api/org/teaching/tasks?limit=2&page=1', { token: org });
  assert.equal(goneTasks.status, 404, `机构端课堂任务应当已删除，实际 ${goneTasks.status}`);
  const goneEntries = await api('/api/org/billing/credit-entries?limit=2&page=1', { token: org });
  assert.equal(goneEntries.status, 404, `机构端积分流水应当已删除，实际 ${goneEntries.status}`);

  // 1) 机构课包列表：平台端现造 2 门已发布课包（种子只有 1 门），limit=1 应分多页且不重复
  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } });
  assert.equal(adminLogin.status, 200, `平台管理员登录失败: ${JSON.stringify(adminLogin.data)}`);
  const rootAdmin = adminLogin.data.token;
  for (const title of ['P14 分页课包一', 'P14 分页课包二']) {
    // 发布要求至少一个未归档课时（seed 里那门课包也是这么建的）
    const created = await api('/api/admin/course-series', {
      method: 'POST', token: rootAdmin,
      body: { title, description: '分页用例', visibility: 'ALL_ORGS', lessons: [{ title: title + ' 第1课', status: 'PUBLISHED', capabilities: ['text'] }] },
    });
    assert.equal(created.status, 200, `创建课包失败: ${JSON.stringify(created.data)}`);
    const published = await api(`/api/admin/course-series/${created.data.id}/status`, { method: 'POST', token: rootAdmin, body: { action: 'publish' } });
    assert.equal(published.status, 200, `发布课包失败: ${JSON.stringify(published.data)}`);
    // 上架广场 ≠ 授权给机构（p40 那条口径）：机构端要看到，必须走授权
    const assigned = await api(`/api/admin/course-series/${created.data.id}/assignments`, { method: 'POST', token: rootAdmin, body: { orgIds: [orgLogin.data.organization.id], validityDays: 365 } });
    assert.equal(assigned.status, 200, `授权课包失败: ${JSON.stringify(assigned.data)}`);
  }
  const seriesPage1 = await api('/api/org/course-series?limit=1&page=1', { token: org });
  const seriesPage2 = await api('/api/org/course-series?limit=1&page=2', { token: org });
  assert.equal(seriesPage1.status, 200, `机构课包列表失败: ${JSON.stringify(seriesPage1.data)}`);
  assert.equal(seriesPage1.data.items.length, 1, '第 1 页应返回 limit 条');
  assert.equal(seriesPage1.data.limit, 1, 'limit 应回显');
  assert.equal(seriesPage1.data.total >= 2, true, `total 应为筛选后总数，实际 ${seriesPage1.data.total}`);
  assert.equal(seriesPage1.data.totalPages, Math.ceil(seriesPage1.data.total / 1), 'totalPages 应与 total/limit 一致');
  assert.ok(seriesPage2.data.items.length >= 1, '第 2 页应有剩余数据');
  const seriesIds = new Set([...seriesPage1.data.items, ...seriesPage2.data.items].map((item) => item.id));
  assert.equal(seriesIds.size, seriesPage1.data.items.length + seriesPage2.data.items.length, '两页之间不应重复');
  results.orgCourseSeries = { total: seriesPage1.data.total, totalPages: seriesPage1.data.totalPages };

  // 2) 机构举报列表（保留的另一处分页口）：同一套 page/limit/total 元数据
  const reports = await api('/api/org/work-reports?limit=1&page=1', { token: org });
  assert.equal(reports.status, 200, `机构举报列表失败: ${JSON.stringify(reports.data)}`);
  assert.equal(reports.data.limit, 1, '举报列表 limit 应回显');
  assert.equal(reports.data.page, 1, '举报列表 page 应回显');
  assert.equal(reports.data.totalPages, Math.ceil(Math.max(1, reports.data.total) / 1), '举报列表 totalPages 不正确');
  results.orgWorkReports = { total: reports.data.total, totalPages: reports.data.totalPages };

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

  // 4) 非法分页参数被拒（limit 超过上限、page 非法）—— 用保留的机构课包口
  const tooLarge = await api('/api/org/course-series?limit=9999', { token: org });
  assert.equal(tooLarge.status, 400, 'limit 超过上限应 400');
  assert.equal(tooLarge.data?.error?.code, 'VALIDATION_ERROR', `应为 VALIDATION_ERROR，实际 ${tooLarge.data?.error?.code}`);
  const badPage = await api('/api/org/course-series?page=0', { token: org });
  assert.equal(badPage.status, 400, 'page=0 应 400');
  results.validation = { tooLarge: tooLarge.data?.error?.code, badPage: badPage.data?.error?.code };

  console.log(JSON.stringify({ name: 'list-pagination', pass: true, ...results }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
