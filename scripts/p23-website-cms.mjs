/**
 * P23 官网内容 CMS（草稿 → 发布 → 公开端生效）。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：公开端只读已发布版本 → 未知 key 400（含已删除的 COURSES）→ 管理端列表/详情 →
 * 保存草稿后公开端仍是旧内容 → 发布后读到新内容 → 越权 403 → 非法 key 400 → 审计落库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p23-website-cms-'));
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

const port = 18871;
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
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}
const login = (loginName, password) => api('/api/auth/login', { method: 'POST', body: { login: loginName, password } });

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  // 1) 公开端读已发布的 FAQ（seed 里就有）
  const publicFaq = await api('/api/public/website-content/FAQ');
  assert.equal(publicFaq.status, 200, `公开端应能读到 FAQ: ${JSON.stringify(publicFaq.data)}`);
  assert.ok(publicFaq.data.content.title, 'FAQ 应带标题');
  assert.ok(Array.isArray(publicFaq.data.content.items), 'FAQ 应带问题列表');

  // 2) 未知 key / 已删除的 COURSES 一律 400
  for (const key of ['NOT_A_KEY', 'COURSES']) {
    const rejected = await api(`/api/public/website-content/${key}`);
    assert.equal(rejected.status, 400, `${key} 应 400，实际 ${rejected.status}`);
    assert.equal(rejected.data?.error?.code, 'INVALID_WEBSITE_CONTENT_KEY', `${key} 错误码应为 INVALID_WEBSITE_CONTENT_KEY`);
  }

  // 3) 管理端列表与详情
  const rootToken = (await login('root', 'admin123')).data.token;
  assert.ok(rootToken, 'root 登录失败');
  const list = await api('/api/admin/website-content', { token: rootToken });
  assert.equal(list.status, 200, `官网内容列表失败: ${JSON.stringify(list.data)}`);
  assert.ok((list.data.items || []).some((item) => item.key === 'FAQ'), '列表应包含 FAQ');
  assert.ok(!(list.data.items || []).some((item) => item.key === 'COURSES'), '列表不应再出现已删除的 COURSES');
  const detail = await api('/api/admin/website-content/FAQ', { token: rootToken });
  assert.equal(detail.status, 200, `FAQ 详情失败: ${JSON.stringify(detail.data)}`);
  assert.ok(detail.data.content.title, '详情应带草稿内容');

  // 4) 保存草稿：公开端仍读旧内容；发布后才生效
  const draft = JSON.parse(JSON.stringify(detail.data.content));
  draft.title = '开课前，你可能想知道（测试）';
  const saved = await api('/api/admin/website-content/FAQ', { method: 'PUT', token: rootToken, body: { content: draft } });
  assert.equal(saved.status, 200, `保存草稿失败: ${JSON.stringify(saved.data)}`);
  assert.equal(saved.data.content.title, '开课前，你可能想知道（测试）', '草稿应保存成功');
  const stillOld = await api('/api/public/website-content/FAQ');
  assert.notEqual(stillOld.data.content.title, '开课前，你可能想知道（测试）', '未发布时公开端应仍是旧内容');
  const published = await api('/api/admin/website-content/FAQ/publish', { method: 'POST', token: rootToken, body: { reason: 'p23 冒烟发布' } });
  assert.equal(published.status, 200, `发布失败: ${JSON.stringify(published.data)}`);
  const afterPublish = await api('/api/public/website-content/FAQ');
  assert.equal(afterPublish.data.content.title, '开课前，你可能想知道（测试）', '发布后公开端应读到新内容');

  // 5) 越权与非法 key
  const orgToken = (await login('org-admin', 'org123')).data.token;
  const forbidden = await api('/api/admin/website-content', { token: orgToken });
  assert.equal(forbidden.status, 403, `机构管理员访问官网内容应 403，实际 ${forbidden.status}`);
  const badKey = await api('/api/admin/website-content/NOT_A_KEY', { method: 'PUT', token: rootToken, body: { content: {} } });
  assert.equal(badKey.status, 400, `非法 key 保存应 400，实际 ${badKey.status}`);

  // 6) 审计落库
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const audits = db.prepare("SELECT action, COUNT(*) n FROM audit_logs WHERE target_id='FAQ' AND action LIKE 'WEBSITE_CONTENT%' GROUP BY action").all();
  db.close();
  const auditMap = Object.fromEntries(audits.map((item) => [item.action, Number(item.n)]));
  assert.equal(auditMap.WEBSITE_CONTENT_DRAFT_UPDATE, 1, `应有 1 条草稿审计，实际 ${JSON.stringify(auditMap)}`);
  assert.equal(auditMap.WEBSITE_CONTENT_PUBLISH, 1, `应有 1 条发布审计，实际 ${JSON.stringify(auditMap)}`);

  console.log(JSON.stringify({
    name: 'website-cms', pass: true,
    publicRead: { key: 'FAQ', title: publicFaq.data.content.title, items: publicFaq.data.content.items.length },
    removedKeys: { COURSES: 400, NOT_A_KEY: 400 },
    draftVsPublish: { beforePublish: stillOld.data.content.title, afterPublish: afterPublish.data.content.title },
    guards: { orgAdmin403: true, badKey400: true },
    audits: auditMap,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
