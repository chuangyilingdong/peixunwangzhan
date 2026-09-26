/**
 * P149 三端「带关键字搜索」的**真请求网**（2026-09-26）。
 *
 * 为什么要有它（图2 那个「服务器内部错误」）：
 *   `... LIKE ? ESCAPE '\'` 在 MySQL 上是**语法错误**（反斜杠把引号转义了，字符串没结束）→ 整条接口 500；
 *   SQLite 不把反斜杠当转义符，所以**本地全量套件一路绿** —— 生产上「只要带关键字搜索就 500」，
 *   机构端作品管理（图2）、平台端作品库/用量报表、学生端检索都中招（p13 那条"间歇飘"的 MySQL 侧就是它）。
 *
 * 为什么原来那些守卫没抓到（这是这条网存在的理由）：
 *   · 全仓只有 4 个脚本打过带关键字的搜索，**没有一个是机构端作品管理 / 学生端项目**这条路；
 *   · p13 打的是平台端用量报表那条 —— 但它在 MySQL 上前面的断言（启动期回填）就先红了，
 *     根本走不到"按关键字检索"那一条；
 *   · 于是"三端搜索"这件事在 MySQL 上**没有任何一条真请求**覆盖过。
 *
 * 这条网的做法：**每个搜索入口都真请求一次，三种输入各来一遍** ——
 *   ① 普通词：必须能命中（这条就是那个 500 的回归网，MySQL 上过不去就是 ER_PARSE_ERROR）；
 *   ② `%`：必须**搜不到东西**（通配符被转义掉了。不转义就是"搜 % 等于搜全部"）；
 *   ③ 把标题里的 `_` 换成别的字符再搜：必须**搜不到**（`_` 被转义了；不转义它会当"任意一个字符"误命中）。
 *   ②③ 才是"转义真写对了"的判据 —— `[%]` / `%${x}%` 这两种历史写法在**两种方言上都不转义**
 *   （`[%]` 在 LIKE 里只是三个普通字符），它们能过 ①、过不了 ②③。
 *
 * 覆盖的入口（三端各取用户真会用的检索）：
 *   · 机构端「作品管理」    GET /api/org/works?search=            （图2 那个 500 的现场）
 *   · 学生端「我的项目」    GET /api/student/projects?search=
 *   · 机构端「课堂总览」    GET /api/org/sessions?search=
 *   · 平台端「机构列表」    GET /api/admin/organizations?search=
 *
 * ⚠️ 务必在 **MySQL 侧**也跑（`--mysql`）：这正是那种"SQLite 容忍、MySQL 严格"的雷。
 * 跑法：node scripts/p149-search-dialect-mysql.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p149-search-'));
const dbPath = path.join(temp, 'platform.db');
// 硬设（不是 ||=）：脚本自己的库优先；MySQL 模式下这个键被忽略
process.env.PLATFORM_DB_PATH = dbPath;
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
const newId = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const EMPTY_CANVAS = '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}';
const now = () => new Date().toISOString();

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

// 夹具直接用数据层写（与分析无关，只为"有一个能被搜到的目标"）：
// 标题里刻意带一个下划线 —— ③ 那一步靠它分辨"_ 真的被转义了"还是"当通配符用了"。
const { aq, arow } = await import('../packages/database/src/store.js');
const student = await arow("SELECT * FROM users WHERE login='student-2'");
const teacher = await arow("SELECT * FROM users WHERE login='teacher-1'");
assert.ok(student && teacher, 'seed 里应有 student-2 / teacher-1');
const orgId = student.org_id;
const ORG_NAME = '示例创新学校';

const projectId = newId('project');
const workId = newId('work');
const sessionId = newId('csession');
// ⚠️ 标题里刻意放一个 `X`（不是下划线）：下面「③ 用 `_` 顶掉一个字符去搜」要靠它 ——
//    `_` 在 LIKE 里是"任意一个字符"，转义漏了的话 `P149_机构作品` 会**命中** `P149X机构作品`。
const PROJECT_TITLE = 'P149X学生项目';
const WORK_TITLE = 'P149X机构作品';
const SESSION_TITLE = 'P149X机构课堂';
await aq('INSERT INTO student_projects(id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  [projectId, student.id, orgId, PROJECT_TITLE, 'SUBMITTED', EMPTY_CANVAS, 1, now(), now(), now()]);
await aq('INSERT INTO works(id,project_id,student_id,org_id,title,canvas_snapshot,submitted_at) VALUES (?,?,?,?,?,?,?)',
  [workId, projectId, student.id, orgId, WORK_TITLE, EMPTY_CANVAS, now()]);
await aq('INSERT INTO class_sessions(id,title,org_id,teacher_id,status,delivery_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
  [sessionId, SESSION_TITLE, orgId, teacher.id, 'ENDED', 'CANVAS', now(), now()]);

const port = 19097;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { token } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, code: payload?.error?.code || null, message: payload?.error?.message || null };
};
const q = (pathname, keyword) => `${pathname}${pathname.includes('?') ? '&' : '?'}search=${encodeURIComponent(keyword)}`;
const titles = (data) => (Array.isArray(data?.items) ? data.items : []).map((item) => item.title || item.name || '');

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }

  const login = async (loginName, password) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: loginName, password }),
    });
    return (await response.json().catch(() => ({})))?.data?.token || null;
  };
  const rootToken = await login('root', 'admin123');
  const orgToken = await login('org-admin', 'org123');
  const studentToken = await login('student-2', 'study123');
  assert.ok(rootToken && orgToken && studentToken, '登录失败（root / org-admin / student-2）');

  // 每个入口三种输入：能命中的、`%`、以及"把一个字符换成 `_`"的。
  // ⚠️ 第三种必须是**搜索词里带 `_`**、而库里那行**在那个位置是别的字符** ——
  //    这样"`_` 被当成通配符"就会误命中（判据才有效）。反过来写成"搜索词里没有 `_`"是测不出东西的。
  const targets = [
    { label: '机构端「作品管理」', path: '/api/org/works', token: orgToken, hit: WORK_TITLE, underscore: 'P149_机构作品' },
    { label: '学生端「我的项目」', path: '/api/student/projects', token: studentToken, hit: PROJECT_TITLE, underscore: 'P149_学生项目' },
    { label: '机构端「课堂总览」', path: '/api/org/sessions', token: orgToken, hit: SESSION_TITLE, underscore: 'P149_机构课堂' },
    { label: '平台端「机构列表」', path: '/api/admin/organizations', token: rootToken, hit: ORG_NAME, underscore: '示_创新学校' },
  ];

  for (const target of targets) {
    const hit = await api(q(target.path, target.hit), { token: target.token });
    check(`${target.label}：普通关键字能搜到（带 ESCAPE 子句的 SQL 在本地真跑一遍）`,
      hit.status === 200 && titles(hit.data).some((title) => String(title).startsWith('P149X') || String(title).includes(target.hit)),
      `status=${hit.status} code=${hit.code} msg=${hit.message} 命中=${JSON.stringify(titles(hit.data))}`);

    const percent = await api(q(target.path, '%'), { token: target.token });
    check(`${target.label}：搜 % 必须搜不到（通配符要转义；不转就是"搜 % 等于搜全部"）`,
      percent.status === 200 && titles(percent.data).length === 0,
      `status=${percent.status} code=${percent.code} msg=${percent.message} 命中=${JSON.stringify(titles(percent.data)).slice(0, 160)}`);

    const underscore = await api(q(target.path, target.underscore), { token: target.token });
    check(`${target.label}：用 _ 顶掉一个字符去搜必须搜不到（_ 要当普通字符，不能当"任意一个字符"）`,
      underscore.status === 200 && titles(underscore.data).length === 0,
      `status=${underscore.status} code=${underscore.code} msg=${underscore.message} 命中=${JSON.stringify(titles(underscore.data)).slice(0, 160)}`);
  }

  // 反斜杠也是 LIKE 的转义符：搜一个孤零零的 `\` 不许 500、也不该命中（夹具标题里没有它）
  const backslash = await api(q('/api/org/works', '\\'), { token: orgToken });
  check('机构端「作品管理」：搜反斜杠不 500、也不命中（转义符本身也要能当普通字符）',
    backslash.status === 200 && titles(backslash.data).length === 0,
    `status=${backslash.status} code=${backslash.code} msg=${backslash.message}`);
} catch (error) {
  failures += 1;
  console.log(`  ✗ 运行中异常：${error.message}`);
  console.log(serverLog.split('\n').slice(-8).join('\n'));
} finally {
  server.kill('SIGKILL');
}

if (failures) {
  console.error(JSON.stringify({ name: 'p149-search-dialect-mysql', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p149-search-dialect-mysql', pass: true }));
