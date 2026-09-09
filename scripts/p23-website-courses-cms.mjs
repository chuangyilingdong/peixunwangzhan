/**
 * P23 官网「课程体系」页 CMS 驱动。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：库里没有 COURSES 行时公开接口回落内置默认（11 门课包）→ 未知 key 400 →
 * 管理端列表/详情出现「内置默认」条目并可预填 → 保存草稿后公开端仍是旧内容 →
 * 发布后公开端读到新内容 → 越权（机构管理员）403 → 非法 key 400 → 审计落库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p23-website-courses-'));
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
const login = (login, password) => api('/api/auth/login', { method: 'POST', body: { login, password } });

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  // 1) 库里还没有 COURSES 行，公开接口应回落到内置默认内容
  const seedDb = await import('node:sqlite');
  const checkDb = new seedDb.DatabaseSync(dbPath);
  const before = checkDb.prepare("SELECT COUNT(*) n FROM website_contents WHERE content_key='COURSES'").get();
  checkDb.close();
  assert.equal(Number(before.n), 0, 'seed 后不应有 COURSES 行（走默认内容路径）');

  const publicDefault = await api('/api/public/website-content/COURSES');
  assert.equal(publicDefault.status, 200, `公开接口应返回默认内容: ${JSON.stringify(publicDefault.data)}`);
  assert.equal(publicDefault.data.status, 'DEFAULT', '默认内容状态应为 DEFAULT');
  assert.equal(publicDefault.data.content.courses.length, 11, `默认应有 11 门课包，实际 ${publicDefault.data.content.courses?.length}`);
  assert.equal(publicDefault.data.content.eyebrow, '课程体系', '默认眉题应为「课程体系」');
  assert.equal(publicDefault.data.content.courses[0].title, '小创作家养成计划', '第一门课包名应与官网一致');
  assert.equal(publicDefault.data.content.courses[0].lessons.length, 8, '14 节课时按内置课时名生成 8 条');

  // 2) 未知 key 一律 400
  const unknownKey = await api('/api/public/website-content/NOT_A_KEY');
  assert.equal(unknownKey.status, 400, `未知 key 应 400，实际 ${unknownKey.status}`);
  assert.equal(unknownKey.data?.error?.code, 'INVALID_WEBSITE_CONTENT_KEY', '错误码应为 INVALID_WEBSITE_CONTENT_KEY');

  // 3) 管理端：列表和详情都能看到「内置默认」的课程体系
  const rootLogin = await login('root', 'admin123');
  assert.equal(rootLogin.status, 200, `root 登录失败: ${JSON.stringify(rootLogin.data)}`);
  const rootToken = rootLogin.data.token;
  const list = await api('/api/admin/website-content', { token: rootToken });
  assert.equal(list.status, 200, `官网内容列表失败: ${JSON.stringify(list.data)}`);
  const coursesEntry = (list.data.items || []).find((item) => item.key === 'COURSES');
  assert.ok(coursesEntry, '列表应包含 COURSES（内置默认条目）');
  assert.equal(coursesEntry.status, 'DEFAULT', 'COURSES 条目状态应为 DEFAULT');
  assert.equal(coursesEntry.isDefault, true, 'COURSES 条目应标记 isDefault');
  const detail = await api('/api/admin/website-content/COURSES', { token: rootToken });
  assert.equal(detail.status, 200, `课程体系详情失败: ${JSON.stringify(detail.data)}`);
  assert.equal(detail.data.isDefault, true, '详情应标记 isDefault');
  assert.equal(detail.data.content.courses.length, 11, '详情应预填 11 门课包');
  assert.deepEqual(detail.data.revisions, [], '内置默认内容没有历史版本');

  // 4) 保存草稿：公开端仍读不到（未发布）
  const draftContent = JSON.parse(JSON.stringify(detail.data.content));
  draftContent.eyebrow = '课程体系（测试）';
  draftContent.courses[0].title = '小创作家养成计划（测试）';
  const saved = await api('/api/admin/website-content/COURSES', { method: 'PUT', token: rootToken, body: { content: draftContent } });
  assert.equal(saved.status, 200, `保存草稿失败: ${JSON.stringify(saved.data)}`);
  assert.equal(saved.data.content.eyebrow, '课程体系（测试）', '草稿应保存成功');
  assert.equal(saved.data.status, 'DRAFT', '保存后状态应为 DRAFT');
  const stillDefault = await api('/api/public/website-content/COURSES');
  assert.equal(stillDefault.data.content.eyebrow, '课程体系', `未发布时公开端应仍是默认内容，实际 ${stillDefault.data.content.eyebrow}`);

  // 5) 发布后公开端读到新内容
  const published = await api('/api/admin/website-content/COURSES/publish', { method: 'POST', token: rootToken, body: { reason: 'p23 冒烟发布' } });
  assert.equal(published.status, 200, `发布失败: ${JSON.stringify(published.data)}`);
  assert.equal(published.data.status, 'PUBLISHED', '发布后状态应为 PUBLISHED');
  const publicAfter = await api('/api/public/website-content/COURSES');
  assert.equal(publicAfter.status, 200, '发布后公开接口应可读');
  assert.equal(publicAfter.data.content.eyebrow, '课程体系（测试）', '公开端应读到已发布内容');
  assert.equal(publicAfter.data.content.courses[0].title, '小创作家养成计划（测试）', '公开端应读到修改后的课包名');

  // 6) 越权与非法 key
  const orgLogin = await login('org-admin', 'org123');
  assert.equal(orgLogin.status, 200, `机构管理员登录失败: ${JSON.stringify(orgLogin.data)}`);
  const forbidden = await api('/api/admin/website-content', { token: orgLogin.data.token });
  assert.equal(forbidden.status, 403, `机构管理员访问官网内容应 403，实际 ${forbidden.status}`);
  const badKey = await api('/api/admin/website-content/NOT_A_KEY', { method: 'PUT', token: rootToken, body: { content: {} } });
  assert.equal(badKey.status, 400, `非法 key 保存应 400，实际 ${badKey.status}`);
  assert.equal(badKey.data?.error?.code, 'INVALID_WEBSITE_CONTENT_KEY', '错误码应为 INVALID_WEBSITE_CONTENT_KEY');

  // 7) 审计落库
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const audit = db.prepare("SELECT action, COUNT(*) n FROM audit_logs WHERE target_id='COURSES' AND action LIKE 'WEBSITE_CONTENT%' GROUP BY action").all();
  const rowCount = db.prepare("SELECT COUNT(*) n FROM website_contents WHERE content_key='COURSES'").get();
  db.close();
  const auditMap = Object.fromEntries(audit.map((item) => [item.action, Number(item.n)]));
  assert.equal(auditMap.WEBSITE_CONTENT_DRAFT_UPDATE, 1, `应有 1 条草稿审计，实际 ${JSON.stringify(auditMap)}`);
  assert.equal(auditMap.WEBSITE_CONTENT_PUBLISH, 1, `应有 1 条发布审计，实际 ${JSON.stringify(auditMap)}`);
  assert.equal(Number(rowCount.n), 1, '发布后库里应存在 COURSES 行');

  console.log(JSON.stringify({
    name: 'website-courses-cms', pass: true,
    publicDefault: { status: publicDefault.data.status, courses: publicDefault.data.content.courses.length, firstLessonCount: publicDefault.data.content.courses[0].lessons.length },
    admin: { listHasCourses: true, isDefault: true, prefilledCourses: detail.data.content.courses.length },
    draftVsPublish: { beforePublishEyebrow: stillDefault.data.content.eyebrow, afterPublishEyebrow: publicAfter.data.content.eyebrow },
    guards: { unknownKey400: true, orgAdmin403: true },
    audits: auditMap,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
