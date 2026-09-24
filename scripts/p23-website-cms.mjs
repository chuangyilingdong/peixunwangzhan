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
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
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
  //    ⚠️ 2026-09-18 晚 FAQ **改成按端三档**（student / teacher / org，用户口径「学生端、老师端、机构端，
  //    可以配置3个端的不同的问题」），所以老的 `content.title` / `content.items` 断言已经不成立：
  //    现在要保证的是**三档都下发成数组**（档位名由官网写死，内容按档位分别配置）。
  const publicFaq = await api('/api/public/website-content/FAQ');
  assert.equal(publicFaq.status, 200, `公开端应能读到 FAQ: ${JSON.stringify(publicFaq.data)}`);
  for (const audience of ['student', 'teacher', 'org']) {
    assert.ok(Array.isArray(publicFaq.data.content[audience]), `FAQ 应带 ${audience} 档的问题列表`);
  }

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
  assert.ok(Array.isArray(detail.data.content.student), '详情应带草稿内容（按端三档后看 student 档）');

  // 4) 保存草稿：公开端仍读旧内容；发布后才生效
  //    标记放在 teacher 档（老版本是改 title，形状变了之后那条改不动了）
  const draft = JSON.parse(JSON.stringify(detail.data.content));
  const MARK = 'p23 草稿标记问题';
  draft.teacher = [...(Array.isArray(draft.teacher) ? draft.teacher : []), { question: MARK, answer: '只应出现在发布之后' }];
  const hasMark = (content) => (Array.isArray(content?.teacher) ? content.teacher : []).some((item) => item.question === MARK);
  const saved = await api('/api/admin/website-content/FAQ', { method: 'PUT', token: rootToken, body: { content: draft } });
  assert.equal(saved.status, 200, `保存草稿失败: ${JSON.stringify(saved.data)}`);
  assert.ok(hasMark(saved.data.content), '草稿应保存成功');
  const stillOld = await api('/api/public/website-content/FAQ');
  assert.ok(!hasMark(stillOld.data.content), '未发布时公开端应仍是旧内容');
  const published = await api('/api/admin/website-content/FAQ/publish', { method: 'POST', token: rootToken, body: { reason: 'p23 冒烟发布' } });
  assert.equal(published.status, 200, `发布失败: ${JSON.stringify(published.data)}`);
  const afterPublish = await api('/api/public/website-content/FAQ');
  assert.ok(hasMark(afterPublish.data.content), '发布后公开端应读到新内容');

  // 5) 越权与非法 key
  const orgToken = (await login('org-admin', 'org123')).data.token;
  const forbidden = await api('/api/admin/website-content', { token: orgToken });
  assert.equal(forbidden.status, 403, `机构管理员访问官网内容应 403，实际 ${forbidden.status}`);
  const badKey = await api('/api/admin/website-content/NOT_A_KEY', { method: 'PUT', token: rootToken, body: { content: {} } });
  assert.equal(badKey.status, 400, `非法 key 保存应 400，实际 ${badKey.status}`);

  // 6) 审计落库
  const { DatabaseSync } = await import('node:sqlite');
   
  const audits = await arows("SELECT action, COUNT(*) n FROM audit_logs WHERE target_id='FAQ' AND action LIKE 'WEBSITE_CONTENT%' GROUP BY action");
  
  const auditMap = Object.fromEntries(audits.map((item) => [item.action, Number(item.n)]));
  assert.equal(auditMap.WEBSITE_CONTENT_DRAFT_UPDATE, 1, `应有 1 条草稿审计，实际 ${JSON.stringify(auditMap)}`);
  assert.equal(auditMap.WEBSITE_CONTENT_PUBLISH, 1, `应有 1 条发布审计，实际 ${JSON.stringify(auditMap)}`);

  console.log(JSON.stringify({
    name: 'website-cms', pass: true,
    publicRead: { key: 'FAQ', audiences: Object.fromEntries(['student', 'teacher', 'org'].map((audience) => [audience, publicFaq.data.content[audience].length])) },
    removedKeys: { COURSES: 400, NOT_A_KEY: 400 },
    draftVsPublish: { beforePublishHasMark: hasMark(stillOld.data.content), afterPublishHasMark: hasMark(afterPublish.data.content) },
    guards: { orgAdmin403: true, badKey400: true },
    audits: auditMap,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
