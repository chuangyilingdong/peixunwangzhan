/**
 * P36 问题反馈闭环：学生提交 → 机构端列表 / 详情 / 处理。
 *
 * 背景：`helpFeedbackRows` / `normalizeHelpFeedback` 原先是 student.js 内部未导出的函数，
 * 机构端（org.js）直接调用 → ReferenceError，机构端「问题反馈」三个接口全部 500
 * （生产日志：`[API INTERNAL ERROR] ReferenceError: helpFeedbackRows is not defined`）。
 * 现在两个函数放在 communication/helpers.js 里共享，这个冒烟把闭环钉住。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p36-help-feedback-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
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

const port = 18917;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });
server.stdout.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data.token;
  assert.ok(student && orgAdmin, '登录失败');

  // 1) 学生提交反馈
  const submitted = await api('/api/student/help/feedback', {
    method: 'POST', token: student,
    body: { category: 'CANVAS', subject: '画布打不开', body: '点进画布是空白页。' },
  });
  assert.equal(submitted.status, 200, `提交反馈失败: ${JSON.stringify(submitted.data)}`);
  const feedbackId = submitted.data.feedback?.id;
  assert.ok(feedbackId, '提交后应返回反馈 id');
  assert.equal(submitted.data.feedback.status, 'SUBMITTED', '新反馈状态应为 SUBMITTED');

  // 2) 机构端列表（此前 500 的就是这里）
  const list = await api('/api/org/help-feedback?status=SUBMITTED', { token: orgAdmin });
  assert.equal(list.status, 200, `机构端反馈列表失败: ${JSON.stringify(list.data)}`);
  const item = (list.data.items || []).find((row) => row.id === feedbackId);
  assert.ok(item, '机构端列表里应能看到学生刚提交的反馈');
  assert.equal(item.subject, '画布打不开', '列表字段应正常下发');
  assert.ok(item.userName, '列表应带提交人姓名（JOIN users）');
  assert.equal(list.data.submitted, 1, '待处理计数应为 1');

  // 3) 机构端详情
  const detail = await api(`/api/org/help-feedback/${encodeURIComponent(feedbackId)}`, { token: orgAdmin });
  assert.equal(detail.status, 200, `机构端反馈详情失败: ${JSON.stringify(detail.data)}`);
  assert.equal(detail.data.id, feedbackId, '详情应返回同一条反馈');

  // 4) 机构端处理
  const handled = await api(`/api/org/help-feedback/${encodeURIComponent(feedbackId)}`, {
    method: 'PUT', token: orgAdmin,
    body: { status: 'RESOLVED', resolution: '已修复画布白屏问题' },
  });
  assert.equal(handled.status, 200, `机构端处理反馈失败: ${JSON.stringify(handled.data)}`);
  assert.equal(handled.data.status, 'RESOLVED', '处理后状态应变为 RESOLVED');
  assert.equal(handled.data.resolution, '已修复画布白屏问题', '处理结果应回写');

  // 5) 学生端自己的反馈列表（同一套 helpFeedbackRows）
  const mine = await api('/api/student/help', { token: student });
  assert.equal(mine.status, 200, '学生端帮助中心应可访问');
  const mineItem = (mine.data.myFeedback?.items || []).find((row) => row.id === feedbackId);
  assert.ok(mineItem, '学生端应能看到自己提交的反馈');
  assert.equal(mineItem.status, 'RESOLVED', '学生端也应看到最新处理状态');

  console.log(JSON.stringify({
    name: 'org-help-feedback', pass: true,
    submitted: { id: feedbackId, status: 'SUBMITTED' },
    orgList: { total: list.data.items.length, submitted: list.data.submitted, userName: item.userName },
    handled: { status: handled.data.status, resolution: handled.data.resolution },
    studentSees: mineItem.status,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
