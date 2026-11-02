/**
 * 客户端问题反馈闭环：学生提交 -> 平台后台查看/处理 -> 客户端回显。
 * 同时钉住两条隔离边界：不写机构 help_feedback，机构端不能读取平台反馈。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-feedback-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18918;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (chunk) => { serverLog += chunk; });
server.stdout.on('data', (chunk) => { serverLog += chunk; });

async function api(pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const isForm = body instanceof FormData;
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(isForm ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
}

try {
  for (let index = 0; index < 100; index += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      // server is still booting
    }
    await sleep(100);
  }

  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data.token;
  const rootAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123', clientType: 'admin' } })).data.token;
  assert.ok(student && orgAdmin && rootAdmin, '登录失败');

  const createBody = {
    idempotencyKey: 'p-client-feedback-operation-1',
    title: 'VibeCoding 第一次运行很慢',
    description: '首次任务持续约 90 分钟，模型调用很多。',
    type: 'performance',
    severity: 'P1-高',
    module: '模型响应慢 / 额度',
    contact: 'qa@example.com',
    environment: {
      appVersion: '0.2.12',
      osPlatform: 'win32',
      osArch: 'x64',
      osVersion: '10.0.26100',
      deviceMid: 'test-device-mid',
      agentModel: 'deepseek-flash',
    },
  };
  const created = await api('/api/client-feedback', {
    method: 'POST',
    token: student,
    headers: { 'x-device-mid': 'test-device-mid' },
    body: createBody,
  });
  assert.equal(created.status, 200, JSON.stringify(created.raw));
  const feedbackId = created.data.id;
  assert.ok(feedbackId?.startsWith('cfb_'), '应返回客户端反馈 id');
  assert.equal(created.data.status, '已提交');
  assert.equal(created.data.device.osPlatform, 'win32');

  const duplicated = await api('/api/client-feedback', {
    method: 'POST',
    token: student,
    headers: { 'x-device-mid': 'test-device-mid' },
    body: createBody,
  });
  assert.equal(duplicated.status, 200);
  assert.equal(duplicated.data.id, feedbackId, '相同幂等键必须返回同一工单');

  const form = new FormData();
  form.set('category', 'MEDIA_ASSET');
  form.set('visibility', 'PRIVATE');
  form.set('file', new Blob([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])], { type: 'application/zip' }), 'diagnostics.zip');
  const uploaded = await api(`/api/client-feedback/${encodeURIComponent(feedbackId)}/attachments?kind=log`, {
    method: 'POST',
    token: student,
    body: form,
  });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.raw));
  assert.equal(uploaded.data.kind, 'log');
  assert.equal(uploaded.data.filename, 'diagnostics.zip');

  const mine = await api('/api/client-feedback?limit=20', { token: student });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.items.some((item) => item.id === feedbackId), '客户端应能读取自己的反馈');

  const adminList = await api('/api/admin/client-feedback?status=SUBMITTED', { token: rootAdmin });
  assert.equal(adminList.status, 200, JSON.stringify(adminList.raw));
  const adminItem = adminList.data.items.find((item) => item.id === feedbackId);
  assert.ok(adminItem, '平台后台应能看到客户端反馈');
  assert.equal(adminItem.attachmentCount, 1);

  const detail = await api(`/api/admin/client-feedback/${encodeURIComponent(feedbackId)}`, { token: rootAdmin });
  assert.equal(detail.status, 200, JSON.stringify(detail.raw));
  assert.equal(detail.data.attachments.length, 1);
  assert.equal(detail.data.device.osArch, 'x64');

  const download = await fetch(`http://127.0.0.1:${port}${detail.data.attachments[0].download_url}`, {
    headers: { authorization: `Bearer ${rootAdmin}` },
  });
  assert.equal(download.status, 200, '平台管理员应能下载日志附件');

  const replied = await api(`/api/admin/client-feedback/${encodeURIComponent(feedbackId)}/messages`, {
    method: 'POST',
    token: rootAdmin,
    body: { body: '已在平台侧复现，正在定位。' },
  });
  assert.equal(replied.status, 200, JSON.stringify(replied.raw));
  const detailAfterReply = await api(`/api/admin/client-feedback/${encodeURIComponent(feedbackId)}`, { token: rootAdmin });
  assert.equal(detailAfterReply.data.comments.length, 1);
  assert.equal(detailAfterReply.data.comments[0].is_staff, true);

  const forbiddenAdmin = await api('/api/admin/client-feedback', { token: orgAdmin });
  assert.equal(forbiddenAdmin.status, 403, '机构管理员不能读取平台反馈');
  const orgFeedback = await api('/api/org/help-feedback', { token: orgAdmin });
  assert.equal(orgFeedback.status, 200);
  assert.equal(orgFeedback.data.items.some((item) => item.id === feedbackId), false, '平台反馈不能进入机构反馈表');

  const handled = await api(`/api/admin/client-feedback/${encodeURIComponent(feedbackId)}`, {
    method: 'PUT',
    token: rootAdmin,
    body: { status: 'RESOLVED', resolution: '已定位并修复客户端反馈通道。' },
  });
  assert.equal(handled.status, 200, JSON.stringify(handled.raw));
  assert.equal(handled.data.raw_status, 'RESOLVED');

  const mineAfter = await api('/api/client-feedback?limit=20', { token: student });
  const mineAfterItem = mineAfter.data.items.find((item) => item.id === feedbackId);
  assert.equal(mineAfterItem.status, '已解决', '客户端应回显平台处理状态');

  console.log(JSON.stringify({
    name: 'client-feedback',
    pass: true,
    feedbackId,
    idempotent: duplicated.data.id === feedbackId,
    attachment: uploaded.data.filename,
    adminVisible: Boolean(adminItem),
    orgIsolated: true,
    clientStatus: mineAfterItem.status,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}

