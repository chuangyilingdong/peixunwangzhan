/**
 * P152 全站审计（2026-09-26）改掉的那些「没有归属守卫」的口径。
 *
 * 这一轮的审计改了 60+ 处，大多数各有自己的守卫（作品链路 → p80/p139、发送计数 → p118、
 * 搜索防抖 → p151），但下面这些**没有天然的归属**，不钉住就会慢慢漂回去：
 *
 *   ① `expiresAt` 的解析顺序（先判无效再 toISOString —— 反了就是 500 而不是 400）；
 *   ② 机构端作品库要能按「已下架」筛（白名单漏了 UNPUBLISHED，而那个状态正是机构端自己写的）；
 *   ③ 学生端项目列表：非 ACTIVE 视图不许再带状态筛选（原来静默丢弃，返回全部）；
 *   ④ 画布拖拽落点不许再减一次容器坐标（xyflow 的 screenToFlowPosition 内部已经减过）；
 *   ⑤ workMedia：给了 resolveSrc 就只信它（不许回退学生域地址 —— 那条路必然 403）；
 *   ⑥ 音频是**三态**（null 学生自选 / true·false 课包定），兜底路径也不许写成 false；
 *   ⑦ 课包快照的 tags / gradeRange 走快照（草稿隔离在这两个字段上曾经静默失效）；
 *   ⑧ 席位判据两处一致（`>=`）、登录失败表有上限、精选计数里那半条恒 0 的子查询已删；
 *   ⑨ 前端的作品状态词表/色调走 shared（不再表格英文、筛选中文）；
 *   ⑩ 守卫网自己的安全：两个"会改真文件"的运维工具不入网、p113 有退出码、p137 默认就是门禁、
 *      并行套件的 HARNESS 与串行逐字一致；
 *   ⑪ 不再有"只出现一次的 import"（那份四件套 import 抄了 8 份、大部分名字没用）。
 *
 * 跑法：node scripts/p152-audit-cleanups.mjs（真请求那两条要起临时服务，约 5 秒）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p152-audit-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { arow } = await import('../packages/database/src/store.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

console.log('① expiresAt：先判无效再转换（否则 500 而不是 400）');
{
  const fileAssets = read('apps/server/src/routes/fileAssets.js');
  check('① fileAssets 里没有「先 toISOString 再判 NaN」的老写法',
    !/new Date\((?:fields|body)\.expiresAt\)\.toISOString\(\)/.test(fileAssets));
  check('① 六处都走 parseOptionalIsoDate', (fileAssets.match(/parseOptionalIsoDate\(/g) || []).length >= 6);
  const lib = await import('../apps/server/src/lib.js');
  assert.equal(lib.parseOptionalIsoDate(''), null);
  assert.equal(lib.parseOptionalIsoDate(undefined), null);
  let threw = null;
  try { lib.parseOptionalIsoDate('abc'); } catch (error) { threw = error; }
  check('① 非法时间抛的是 400（不是 RangeError/500）',
    Boolean(threw) && threw.status === 400 && threw.code === 'INVALID_EXPIRES_AT',
    JSON.stringify({ status: threw?.status, code: threw?.code, name: threw?.name }));
}

console.log('② 静态：本轮修掉的写法不许漂回去');
{
  const orgAdmin = read('apps/server/src/routes/orgAdmin.js');
  check('② 机构端作品状态筛选白名单含 UNPUBLISHED',
    /'PENDING', 'APPROVED', 'REJECTED', 'PUBLISHED', 'UNPUBLISHED'/.test(orgAdmin));
  check('② VibeCoding 行带上 unpublishReason（否则"已下架"看不到原因）',
    /unpublishReason: submission\.unpublish_reason/.test(orgAdmin));
  check('② 学生端项目：非 ACTIVE 视图的 status 一律 400（不再静默丢弃）',
    /if \(view !== 'ACTIVE' && status && status !== 'ARCHIVED'\) throw/.test(read('apps/server/src/routes/student.js')));
  check('② WORK_STATUS_RANK 覆盖状态字典里的 5 个值（含 UNPUBLISHED）',
    /const WORK_STATUS_RANK = \{ PUBLISHED: 4, APPROVED: 3, UNPUBLISHED: 2\.5, REJECTED: 2, PENDING: 1 \};/.test(read('apps/server/src/routes/student.js')));
  check('② 席位判据两处一致（>=）',
    /studentUsedSeats >= org\.studentSeats/.test(read('apps/server/src/routes/admin/helpers.js')));
  check('② 登录失败表有上限（原来只有登录成功才删条目）',
    /if \(loginAttempts\.size > 5000\) loginAttempts\.clear\(\);/.test(read('apps/server/src/routes/auth.js')));
  check('② 精选计数里那半条恒 0 的 VibeCoding 子查询已删',
    // 用 includes 而不是正则（这条 SQL 里全是正则元字符，转义层数容易出错）
    !read('apps/server/src/routes/admin/overview.js').includes('+ (SELECT COUNT(*) FROM vibecoding_submissions WHERE featured_at IS NOT NULL)'));
}

console.log('③ 静态：画布与前端的四条口径');
{
  const canvas = read('packages/canvas/src/index.jsx');
  check('③ 拖拽落点不再减容器坐标（xyflow 内部已经减过）',
    !/screenToFlowPosition\(\{ x: event\.clientX - bounds\.left/.test(canvas));
  check('③ 生成进度起点用 ref 固定（渲染期 Date.now() 会让进度条卡 1%）',
    /if \(startRef\.current === null\) startRef\.current = Number\(startedAt\) \|\| Date\.now\(\);/.test(canvas));
  const workMedia = read('packages/shared/src/workMedia.jsx');
  check('③ workMedia 给了 resolveSrc 就只信它（不回退学生域地址）',
    /typeof resolveSrc === 'function' \? String\(resolveSrc\(item\) \|\| ''\) : String\(item\.url/.test(workMedia));
  const workspace = read('packages/shared/src/canvasWorkspace.jsx');
  check('③ 音频三态在兜底路径也保留（不许把"没配"写成 false）',
    /audio: raw\.audio === true \? true : raw\.audio === false \? false : null,/.test(workspace));
  const lib = read('apps/server/src/lib.js');
  check('③ 课包快照的 tags / gradeRange 走 snapPick（草稿隔离）',
    /tags: snapPick\('tags', parseJson\(value\.tags, \[\]\)\),/.test(lib) && /gradeRange: snapPick\('gradeRange'/.test(lib));
}

console.log('④ 静态：前端词表与死代码');
{
  const orgMain = read('apps/org/src/main.jsx');
  check('④ 机构端作品列表用 shared 的 WorkPlazaStatus（不再是英文枚举 + 猜色）',
    /<WorkPlazaStatus item=\{item\} \/>/.test(orgMain));
  check('④ 学生端「我的作品」的下架原因不再只认旧枚举 REJECTED',
    /work\.unpublishReason && !work\.plazaPublished \?/.test(read('apps/website/src/pages/MyWorks.jsx')));
  check('④ 商机页不再猜消息里的字决定红绿',
    !/tone=\{\/失败\|不能\|无效\|不存在\|没有权限\//.test(read('apps/admin/src/pages/Leads.jsx')));
  check('④ 审核页不再自写一份 CSV 下载', !/new Blob\(\[result\.content\]/.test(read('apps/admin/src/pages/PlatformAudit.jsx')));
  check('④ 官网三个死常量已删',
    !/PL_TYPE_ORDER|PL_AUDIO_TYPES/.test(read('apps/website/src/main.jsx')));
  check('④lib.js 的 asBoolean / requirePermission 已下线（零引用）',
    !/function asBoolean\(/.test(read('apps/server/src/lib.js')) && !/function requirePermission\(/.test(read('apps/server/src/lib.js')));
}

console.log('⑤ 静态：守卫网自己的安全');
{
  const serial = read('scripts/acceptance-suite.mjs');
  const parallel = read('scripts/acceptance-suite-parallel.mjs');
  check('⑤ 两个套件都排除了"会改真文件"的运维工具（remux / randomize）',
    /remux-imported/.test(serial) && /randomize-import/.test(serial) && /remux-imported/.test(parallel) && /randomize-import/.test(parallel));
  check('⑤ 两个套件的 HARNESS 都登记了 rds-column-headroom',
    serial.includes('rds-column-headroom') && parallel.includes('rds-column-headroom'));
  check('⑤ 两个套件的 NOT_TESTS 逐字一致',
    serial.match(/const NOT_TESTS = ([^;]+);/)[1] === parallel.match(/const NOT_TESTS = ([^;]+);/)[1]);
  check('⑤ p113 会用退出码判红（原来 32 条断言都无法判红）', /if \(failures\) process\.exit\(1\);/.test(read('scripts/p113-upstream-wallet.mjs')));
  check('⑤ p137 默认就是门禁（原来套件里永远绿）', /const gate = !process\.argv\.includes\('--report'\);/.test(read('scripts/p137-async-db-await.mjs')));
  check('⑤ p10 不再把临时库写进仓库根目录', !/=\s*`\.\/\.tmp-p10-access-/.test(read('scripts/p10-file-access-matrix.mjs')));
}

console.log('⑥ 静态：schema 里的失效/重复迁移');
{
  const schema = read('packages/database/src/schema.js');
  check('⑥ 没有「course_series_versions.snapshot」那条永远抛错的迁移',
    !/UPDATE course_series_versions SET snapshot = REPLACE/.test(schema));
  check('⑥ 没有 SQLite 不支持的 ADD CONSTRAINT', !/ALTER TABLE [a-z_]+ ADD CONSTRAINT/.test(schema));
  check('⑥ 学生隐私那段迁移只留一份',
    (schema.match(/Lightweight forward-compatible migration for student account privacy/g) || []).length === 1);
}

console.log('⑦ 前端没有被复制粘贴的"只用一次"的 import');
{
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(rel); continue; }
      if (/\.jsx?$/.test(entry.name)) files.push(rel);
    }
  };
  ['apps/admin/src', 'apps/org/src', 'apps/website/src'].forEach(walk);
  const offenders = [];
  for (const file of files) {
    const source = read(file);
    for (const line of source.split(/\r?\n/)) {
      const m = line.match(/^import\s*\{([^}]*)\}\s*from\s*'[^']+';\s*$/);
      if (!m) continue;
      for (const name of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        if (/\bas\b/.test(name)) continue;                              // 别名条目跳过（使用处写别名）
        const hits = (source.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
        if (hits <= 1) offenders.push(`${file}: ${name}`);
      }
    }
  }
  check('⑦ 没有"只出现一次"的 import（= 导入未使用）', offenders.length === 0, offenders.slice(0, 6).join('、'));
}

console.log('⑧ 真请求：两条接口口径');
{
  const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'), DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (x) => { err += x; });
    child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await run(['packages/database/src/db.js', '--init']);
  await run(['packages/database/src/seed.js']);

  const port = 19093;
  const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (x) => { serverLog += x; });
  server.stderr.on('data', (x) => { serverLog += x; });
  const api = async (pathname, { token } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, data: payload?.data ?? payload, code: payload?.error?.code || null };
  };
  const login = async (name, password) => (await (await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: name, password }) })).json())?.data?.token || null;
  try {
    for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等起来 */ } await sleep(100); }
    await ensureClassroom(dbPath);
    const orgToken = await login('org-admin', 'org123');
    const studentToken = await login('student-2', 'study123');
    assert.ok(orgToken && studentToken, '登录失败');

    const published = await api('/api/org/works?status=UNPUBLISHED', { token: orgToken });
    check('⑧ 机构端作品库能按「已下架」筛（原来 400 INVALID_WORK_STATUS_FILTER）',
      published.status === 200 && Array.isArray(published.data?.items), `HTTP ${published.status} ${published.code}`);

    const badView = await api('/api/student/projects?view=ARCHIVED&status=DRAFT', { token: studentToken });
    check('⑧ 学生端「归档视图 + 非归档状态」→ 400（原来静默丢弃条件）',
      badView.status === 400 && badView.code === 'INVALID_PROJECT_FILTER', `HTTP ${badView.status} ${badView.code}`);

    const okView = await api('/api/student/projects?view=ARCHIVED&status=ARCHIVED', { token: studentToken });
    check('⑧ 归档视图 + ARCHIVED（幂等组合）仍然放行', okView.status === 200, `HTTP ${okView.status} ${okView.code}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ 真请求段异常：${error.message}`);
    console.log(serverLog.split('\n').slice(-6).join('\n'));
  } finally {
    server.kill('SIGKILL');
  }
}

if (failures) {
  console.error(JSON.stringify({ name: 'p152-audit-cleanups', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p152-audit-cleanups', pass: true }));
