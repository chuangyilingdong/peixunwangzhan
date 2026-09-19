#!/usr/bin/env node
/**
 * P121 作品广场后台「编辑 / 彻底删除 / 分类映射」守卫（2026-09-19）
 *
 * 为什么需要它：这三个动作是这一轮新加的后台能力，其中**彻底删除不可恢复** ——
 * 一旦把"删错了"或"媒体目录被误删"这类事放进生产，就没有第二次机会了。所以下面每条口径
 * 都在**临时库 + 真服务**上跑一遍真接口，而不是只看代码：
 *
 *   · 「编辑」只能改展示文案（标题/描述）—— 发布状态、授权、精选不许被顺手改掉；
 *   · 「彻底删除」必须显式 `confirm:true` + 一句原因；作品连着的子表要**跟着走**（5 张表 ON DELETE CASCADE）；
 *   · 导入件的媒体目录要挪进 `_trash/`，但**还有别的作品引用同一份媒体时不许挪**；
 *     挪不动也不能让整次删除失败（库里已经决定删了，留下文件只是多占空间）。
 *   · 分类映射改完要**真的影响广场**（公开接口吐的 `plazaCategory` 跟着变）——
 *     这正是"分类由服务端算"那条口径的落点：映射只在后台改，前端不自己判。
 *
 * 做法（照 p111 的架子）：临时目录建库 + init + seed → 造夹具 → 真起 apps/server →
 * 用 fetch 打真接口断言 → 关服务、删临时目录。不需要浏览器（这一道守的是**服务端口径**；
 * 后台页面的外观由 p111/人眼那道流程看）。
 *
 * 跑法（需 node ≥ 20）：node scripts/p121-plaza-admin-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plaza-admin-'));
const dbPath = path.join(temp, 'platform.db');
const mediaRoot = path.join(temp, 'public-media');
const PORT = Number(process.env.P121_PORT || 8796);
const env = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  // 「彻底删除」要挪导入件的媒体目录 —— 指到临时目录里，绝不许碰生产的 public-media
  PLAZA_MEDIA_ROOT: mediaRoot,
  AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
  PORT: String(PORT),
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => (code ? reject(new Error(`$ node ${args.join(' ')}\n${output}`)) : resolve(output)));
});
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 打真接口；非 2xx 时**不抛**，把状态码和错误码返回来给断言用。 */
async function call(pathname, { method = 'GET', body, token } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, code: payload?.error?.code || null, data: payload?.data ?? payload };
}

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

// ── 夹具：一件普通画布作品（带一条举报，用来验级联）＋ 两件共用同一份媒体的导入件 ──────────────
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
const now = new Date().toISOString();
const admin = db.prepare("SELECT id FROM users WHERE login='root'").get();
const org = db.prepare("SELECT id FROM organizations LIMIT 1").get();
const student = db.prepare("SELECT id, org_id FROM users WHERE role='STUDENT' LIMIT 1").get();
assert.ok(admin && org && student, 'fixture: seed 里应该有 root / 机构 / 学生');

function seedWork({ id, title, imported }) {
  const snapshot = JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, ...(imported ? { imported } : {}) });
  db.prepare(`INSERT INTO student_projects(id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at)
    VALUES(?,?,?,?, 'SUBMITTED', '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}', 1, ?, ?, ?)`).run(`p_${id}`, student.id, org.id, title, now, now, now);
  db.prepare(`INSERT INTO works(id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at)
    VALUES(?,?,?,?,?, '原描述', ?, 'PUBLISHED', ?, 1, ?, ?)`).run(id, `p_${id}`, student.id, org.id, title, snapshot, now, `tok_${id}`, now);
}
seedWork({ id: 'work_p121_canvas', title: 'P121 画布作品' });
seedWork({ id: 'work_p121_import_a', title: 'P121 导入件 A', imported: { source: 'webworks', sourceId: 'p121shared', workType: 'webpage', workTypeLabel: '网页', entryUrl: 'https://example.test/a' } });
seedWork({ id: 'work_p121_import_b', title: 'P121 导入件 B', imported: { source: 'webworks', sourceId: 'p121shared', workType: 'webpage', workTypeLabel: '网页', entryUrl: 'https://example.test/b' } });
seedWork({ id: 'work_p121_solo', title: 'P121 独占导入件', imported: { source: 'webworks', sourceId: 'p121solo', workType: 'webpage', workTypeLabel: '网页', entryUrl: 'https://example.test/c' } });
db.prepare(`INSERT INTO work_reports(id,work_id,org_id,reporter_id,category,details,status,created_at)
  VALUES('rep_p121','work_p121_canvas',?,?,'OTHER','夹具', 'PENDING', ?)`).run(org.id, student.id, now);
for (const sourceId of ['p121shared', 'p121solo']) {
  fs.mkdirSync(path.join(mediaRoot, 'web-works', sourceId), { recursive: true });
  fs.writeFileSync(path.join(mediaRoot, 'web-works', sourceId, 'index.html'), '<!doctype html><p>fixture</p>');
}
db.close();
console.log('夹具就绪：1 件画布（带举报）+ 3 件导入件（其中两件共用媒体 p121shared）');

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });
async function shutdown(code) {
  server.kill();
  await sleep(300);
  fs.rmSync(temp, { recursive: true, force: true });
  if (code) console.error(serverLog.slice(-2000));
  process.exit(code);
}
for (let attempt = 0; attempt < 60; attempt += 1) {
  // ⚠️ 应用自己暴露的是 `/health`；`/api/health` 是 **nginx** 那条 `location = /api/health`
  //    代理过去的（见 deploy/production/nginx.conf.example）—— 直连应用时要打前者。
  try { const probe = await fetch(`${base}/health`); if (probe.ok) break; } catch { /* 还没起来 */ }
  await sleep(500);
  if (attempt === 59) { console.error('服务没起来'); await shutdown(1); }
}

const problems = [];
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '✅' : '❌'} ${label}${condition ? '' : ` —— ${detail}`}`);
  if (!condition) problems.push(`${label}：${detail}`);
};

const login = await call('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123', clientType: 'admin' } });
assert.equal(login.status, 200, `登录失败：${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);
const token = login.data.token;

// ① 分类映射：改一个**真的能让广场变**的类型，并从公开接口确认生效
const before = await call('/api/admin/plaza-category-map', { token });
check('① 读分类映射', before.status === 200 && Array.isArray(before.data?.types) && before.data.types.includes('webpage'), `status=${before.status}`);
const plazaBefore = await call('/api/public/works?limit=500');
const categoryBefore = plazaBefore.data.items.find((item) => item.id === 'work_p121_solo')?.plazaCategory;
const flipped = categoryBefore === 'CANVAS' ? 'VIBECODING' : 'CANVAS';
const saveMap = await call('/api/admin/plaza-category-map', { method: 'PUT', token, body: { map: { webpage: flipped } } });
const plazaAfter = await call('/api/public/works?limit=500');
const categoryAfter = plazaAfter.data.items.find((item) => item.id === 'work_p121_solo')?.plazaCategory;
check('① 改映射后广场跟着变（前端不自己判分类）', saveMap.status === 200 && categoryAfter === flipped && categoryAfter !== categoryBefore,
  `保存 status=${saveMap.status}，广场里 ${categoryBefore} → ${categoryAfter}（期望 ${flipped}）`);
await call('/api/admin/plaza-category-map', { method: 'PUT', token, body: { map: {} } });

// ② 编辑：只改标题/描述，且状态类字段不动
const edited = await call('/api/admin/works/work_p121_canvas', { method: 'PUT', token, body: { title: 'P121 改过的标题', description: '改过的描述' } });
check('② 编辑标题与描述', edited.status === 200 && edited.data?.title === 'P121 改过的标题' && edited.data?.description === '改过的描述', `status=${edited.status}`);
const reloaded = dbSafeRead("SELECT title,description,status,is_public,featured_at FROM works WHERE id='work_p121_canvas'");
check('② 编辑没有碰到发布状态 / 公开 / 精选', reloaded.status === 'PUBLISHED' && Number(reloaded.is_public) === 1 && reloaded.featured_at === null, JSON.stringify(reloaded));
const blank = await call('/api/admin/works/work_p121_canvas', { method: 'PUT', token, body: { title: '   ' } });
check('② 空标题被拒', blank.status === 400, `status=${blank.status}`);

// ③ 彻底删除：两道门槛
const noConfirm = await call('/api/admin/works/work_p121_canvas', { method: 'DELETE', token, body: { reason: '忘了确认' } });
check('③ 不带 confirm 被拒', noConfirm.status === 400 && noConfirm.code === 'WORK_DELETE_CONFIRM_REQUIRED', `status=${noConfirm.status} code=${noConfirm.code}`);
const noReason = await call('/api/admin/works/work_p121_canvas', { method: 'DELETE', token, body: { confirm: true, reason: '  ' } });
check('③ 不带原因被拒', noReason.status === 400, `status=${noReason.status} code=${noReason.code}`);

// ④ 删画布作品：行没了，级联的子表（举报）跟着没
const purge = await call('/api/admin/works/work_p121_canvas', { method: 'DELETE', token, body: { confirm: true, reason: 'P121 夹具清理' } });
check('④ 彻底删除成功', purge.status === 200 && purge.data?.deleted === true, `status=${purge.status} ${JSON.stringify(purge.data).slice(0, 160)}`);
const gone = dbSafeRead("SELECT (SELECT COUNT(*) FROM works WHERE id='work_p121_canvas') work, (SELECT COUNT(*) FROM work_reports WHERE work_id='work_p121_canvas') reports");
check('④ 作品与级联子表都删掉了', Number(gone.work) === 0 && Number(gone.reports) === 0, JSON.stringify(gone));
const audited = dbSafeRead("SELECT COUNT(*) n FROM audit_logs WHERE action='PLATFORM_WORK_DELETE'");
check('④ 删除进了审计日志', Number(audited.n) === 1, JSON.stringify(audited));

// ⑤ 删导入件：媒体挪进 _trash；但**共用同一份媒体**的不挪
const sharedPurge = await call('/api/admin/works/work_p121_import_a', { method: 'DELETE', token, body: { confirm: true, reason: 'P121 夹具清理' } });
check('⑤ 共用媒体的目录不挪', sharedPurge.data?.media?.action === 'kept' && fs.existsSync(path.join(mediaRoot, 'web-works', 'p121shared')),
  JSON.stringify(sharedPurge.data?.media));
const soloPurge = await call('/api/admin/works/work_p121_import_b', { method: 'DELETE', token, body: { confirm: true, reason: 'P121 夹具清理（最后一个引用者）' } });
check('⑤ 最后一个引用者被删后，媒体挪进 _trash', soloPurge.data?.media?.action === 'quarantined'
  && !fs.existsSync(path.join(mediaRoot, 'web-works', 'p121shared'))
  && fs.existsSync(path.join(mediaRoot, soloPurge.data.media.trash)), JSON.stringify(soloPurge.data?.media));

// ⑥ VibeCoding 那两条路由也在（没有夹具，用不存在的 id 断言它认得这条路由）
// ⚠️ 判据要**认错误码**，不能只认 404：路由没注册时也是 404（ROUTE_NOT_FOUND），
//    那样"路由根本不存在"会被当成通过 —— 这一版守卫第一跑就是这么放过一版的。
const vibeEdit = await call('/api/admin/vibecoding-works/nope', { method: 'PUT', token, body: { title: 'x' } });
const vibeDelete = await call('/api/admin/vibecoding-works/nope', { method: 'DELETE', token, body: { confirm: true, reason: 'x' } });
check('⑥ VibeCoding 编辑/删除路由存在且按 id 报错', vibeEdit.code === 'VIBECODING_SUBMISSION_NOT_FOUND' && vibeDelete.code === 'VIBECODING_SUBMISSION_NOT_FOUND',
  `PUT code=${vibeEdit.code} / DELETE code=${vibeDelete.code}`);

// ⑦ 列表还正常（新的 PUT/DELETE 路由别把 GET /works 顶掉）
const list = await call('/api/admin/works?limit=5', { token });
check('⑦ 作品列表仍然正常', list.status === 200 && Array.isArray(list.data?.items), `status=${list.status}`);

/** 直接读库（夹具库就在临时目录里）。 */
function dbSafeRead(sql) {
  const handle = new DatabaseSync(dbPath);
  try { return handle.prepare(sql).get(); } finally { handle.close(); }
}

if (problems.length) {
  console.log(`\n❌ P121 不通过，共 ${problems.length} 个问题：`);
  for (const problem of problems) console.log(`   · ${problem}`);
  await shutdown(1);
}
console.log('\nP121 PASSED：编辑 / 彻底删除（含级联与媒体隔离区）/ 分类映射即时生效，全部成立');
await shutdown(0);
