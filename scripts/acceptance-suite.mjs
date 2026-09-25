// 验收脚本批量运行器 —— 把"全量跑 + 与基线对跑"变成一条命令
//
// 为什么需要它：仓库里 150+ 个验收脚本是**唯一的真回归网**，但 CI 只跑 3 个。
// 2026-09-23 那次数据访问异步化改造就是靠"全量跑 + 与改造前基线逐一对跑"才抓出 7 个回归
// （其中 4 个是"语法全过、静态检查全 0、但行为悄悄变了"的那种）。
// 只跑其中几个的做法会漏掉这类回归。
//
// 用法：
//   node scripts/acceptance-suite.mjs                     # 跑全部（自动排除非测试脚本）
//   node scripts/acceptance-suite.mjs --fast              # 跑精选（CI 用，几十秒）
//   node scripts/acceptance-suite.mjs --tag=before        # 结果另存 .tmp/acceptance-before.json
//   node scripts/acceptance-suite.mjs --compare=.tmp/acceptance-before.json
//                                                         # 与基线对比：**出现"基线绿→现在红"就退出码 1**
//   node scripts/acceptance-suite.mjs scripts/p52-course-lesson-model.mjs   # 只跑指定的
//
// 注意：每个脚本都在**独立的临时数据目录**里跑（PLATFORM_DATA_DIR/PLATFORM_DB_PATH 指向 mkdtemp），
// 互不污染，也不碰仓库里的 data/platform.db。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mysqlEnvFromProcess, resetMysqlDatabase } from './mysql-test-db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : true;
};

// 不是测试的脚本：基准/截图/导入/上线后检查/夹具 —— 跑它们要么超时要么需要外部依赖
const NOT_TESTS = /^scripts\/(dev-bench|page-shot|import-|live-|verify-production|classroom-detail-qa-fixture)/;
// 本套件自己的工具/夹具也不算测试（否则它会把自己再跑一遍 → 递归超时）
const HARNESS = new Set([
  'scripts/acceptance-suite.mjs',
  'scripts/acceptance-script-wrapper.mjs',
  'scripts/mysql-test-db.mjs',
  'scripts/rds-p1-codemod',
  // 阶段 2 的夹具 codemod：同样是**工具**（默认试运行、--write 才写盘），不是测试。
  // 漏在名单外时它会被当成一个测试跑（2026-09-24 那次全量里就跑了，虽然通过但计数被撑大一项，
  // 而且哪天默认行为变了、真去改验收脚本，就是"套件在改套件自己"）。
  'scripts/rds-p2-fixture-codemod.mjs',
  // 切库前的「装得下」检查：**工具**（要显式给 --sqlite= 与 MYSQL_* 才会跑）——
  // 不登记的话会被套件当成一个测试跑，然后因为没有源库而失败。
  'scripts/rds-column-fit.mjs',
  // 并行跑法（MySQL 侧专用）：它是**调度器**，会自己再起套件进程 —— 漏在名单外会被当成一个测试跑
  // （表现是"套件里再套一层套件"、超时）。
  'scripts/acceptance-suite-parallel.mjs',
]);

// CI 用精选：四条主流程（教师开课 / 学生进课堂 / 上传素材 / 广场浏览）+ 几个核心守卫
const FAST = [
  'scripts/p78-classroom-student-flow.mjs',
  'scripts/p76-course-package-guards.mjs',
  'scripts/p52-course-lesson-model.mjs',
  'scripts/p10-file-upload-security.mjs',
  'scripts/p43-multipart-filename-encoding.mjs',
  'scripts/p64-works-plaza-unified.mjs',
  'scripts/p101-account-uniqueness.mjs',
  'scripts/p119-runtime-upload-submit.mjs',
  'scripts/p112-session-cost-cap.mjs',
  'scripts/p127-generated-asset-archive.mjs',
  'scripts/p4-o09-reminders.mjs',
  'scripts/p9-r04-ai-lesson-capability-guards.mjs',
  // 2026-09-24 加：超限拒绝之后那条连接不能再被复用（实测挂 304 秒）。它就是 p119 长期
  // "偶发超时失败"的真凶 —— 断言全过、却被那条毒连接拖过 120s 超时线。
  'scripts/p138-oversized-body-keepalive.mjs',  // 2026-09-24 加：上游素材镜像的门禁 —— 相对地址（/api/…，画布快照里的形状）也必须算"自站素材"，
  // 否则图生图的参考图会被原样发出去，上游回「images must contain public HTTP(S) URLs」。
  'scripts/p125-upstream-media-mirror.mjs',
  // 2026-09-24 加：OSS 对象键的幂等（写进去的是带前缀的完整键，读的时候不能再叠一层）。
  // 这条错了**不会报错**：下载接口照常 302，404 发生在 OSS 那边 —— 生产上烧了一天多。
  'scripts/p136-oss-signature.mjs',
  // 2026-09-24 加：画布「增量提交」（提交后画布不锁、有新产出才能再提交一次）。
  // 这条走真 HTTP：空画布能不能提交、提交后还能不能存/能不能生成、重复提交幂等、
  // 课堂结束立刻收口 —— 只看源码或只调处理函数都验不出来。
  'scripts/p139-canvas-incremental-submit.mjs',
];

const explicit = args.filter((a) => a.startsWith('scripts/'));
const files = explicit.length
  ? explicit
  : flag('fast', false)
    ? FAST
    : fs.readdirSync(path.join(ROOT, 'scripts'))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => `scripts/${f}`)
      .filter((f) => !NOT_TESTS.test(f) && !HARNESS.has(f))
      .sort();

const tag = String(flag('tag', 'run'));
// --mysql：每个脚本跑之前**重置 MySQL 库**（结构由代码现生成），并把 mysql 环境传给脚本。
// 为什么必须每脚本重置：SQLite 那边每个脚本都拿到一个全新的临时库，MySQL 这边要等价对待；
// 否则脚本之间会互相污染（上一个脚本建的数据被下一个脚本当成"本来就有"）。
const useMysql = Boolean(flag('mysql', false));
const timeout = Number(flag('timeout', 120000));
const nodeBin = process.env.SUITE_NODE || process.execPath;
const started = Date.now();
const results = [];
// 库名前缀：**并行跑多份套件**时用它错开（见 scripts/acceptance-suite-parallel.mjs）。
// 🚨 包括下面那个"能不能建库"的探针库名 —— 探针也用固定名的话，两份套件同时探测会互相 DROP
//    掉对方的探针库 → `DROP` 报 Unknown database → 两份都判成"没建库权限" →
//    退回**共享库** MYSQL_DATABASE → 互相清库 → 满屏假失败（2026-09-24 实测踩过这一脚）。
// 默认值 `aild_test` 保持不变，串行跑的库名与以前完全一致。
const dbPrefix = String(process.env.SUITE_DB_PREFIX || 'aild_test').replace(/[^0-9a-zA-Z_]/g, '');

// 探测一次"能不能建库"（决定用每脚本一库、还是就地清表）
let canCreateDatabases = false;
if (useMysql) {
  try {
    const env = mysqlEnvFromProcess();
    const { pathToFileURL } = await import('node:url');
    const path = await import('node:path');
    const mysql = (await import(pathToFileURL(path.join(ROOT, 'packages/database/node_modules/mysql2/promise.js')).href)).default;
    const conn = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD });
    try {
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbPrefix}_perm_probe\``);
      await conn.query(`DROP DATABASE \`${dbPrefix}_perm_probe\``);
      canCreateDatabases = true;
    } catch { canCreateDatabases = false; }
    await conn.end();
    console.log(canCreateDatabases
      ? '（能建库：每脚本一个独立库）'
      : '（无建库权限：固定库 + 每脚本就地清表）');
  } catch { canCreateDatabases = false; }
}

console.log(`验收套件：${files.length} 个脚本（node ${process.version}，每脚本超时 ${Math.round(timeout / 1000)}s）\n`);

for (let i = 0; i < files.length; i += 1) {
  const rel = files[i];
  // 每个脚本一个**全新的库名**：脚本 spawn 出来的服务器如果没被杀干净，它连的是**上一个库**，
  // 不会污染这一轮（否则会看到"同一个脚本单独跑能过、在套件里时好时坏"这种最浪费时间的假失败）。
  // ⚠️ 但**只有真的能建库时**才能这么做：RDS 上那个账号只被授予了 `aild_admin`.*，
  //    建不了新库 —— 这种情况下退回"固定库 + 就地清表"（库名 = MYSQL_DATABASE 环境变量）。
  const dbName = useMysql && canCreateDatabases ? `${dbPrefix}_${i + 1}` : null;
  if (useMysql) {
    try { await resetMysqlDatabase({ silent: true, database: dbName, dropToo: i > 0 ? [`${dbPrefix}_${i}`] : [] }); }
    catch (error) { console.log(`  [mysql] 重置失败，跳过 ${rel}：${error.message}`); results.push({ script: rel, ok: false, status: -1, timedOut: false, ms: 0, tail: `mysql 重置失败：${error.message}` }); continue; }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-'));
  const logPath = path.join(tmp, 'log.txt');
  const fd = fs.openSync(logPath, 'w');
  const t0 = Date.now();
  // 输出写**文件**而不是管道：脚本里常起服务器，孙进程会握着管道不放，spawnSync 会一直等
  // mysql 驱动下用包装层跑：脚本结束后由包装层显式关连接池，
  // 否则 mysql2 的池会握着事件循环 → 脚本跑完不退出 → 全被判成"超时"（假失败）。
  const argv = useMysql ? [path.join(ROOT, 'scripts/acceptance-script-wrapper.mjs'), rel] : [rel];
  const res = spawnSync(nodeBin, argv, {
    cwd: ROOT,
    timeout,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      // ⚠️ 只有真给了库名才覆盖（否则会写进字符串 "null"，应用连到一个不存在的库）
      ...(useMysql ? { ...mysqlEnvFromProcess(), ...(dbName ? { MYSQL_DATABASE: dbName } : {}) } : {}),
      PLATFORM_DATA_DIR: tmp,
      PLATFORM_DB_PATH: path.join(tmp, 'platform.db'),
      DEPLOYMENT_MODE: process.env.DEPLOYMENT_MODE || 'internal-test',
    },
  });
  fs.closeSync(fd);
  let out = '';
  try { out = fs.readFileSync(logPath, 'utf8'); } catch { /* 没输出就算了 */ }
  // 想看"红在哪一条"就带上 SUITE_KEEP_LOGS=1：这时保留临时目录（里面有每个脚本的完整输出），
  // 并在结果行里带上路径。默认仍然清理（不然跑一晚全量会攒下几百个目录）。
  if (process.env.SUITE_KEEP_LOGS) {
    try { fs.writeFileSync(path.join(tmp, `${path.basename(rel, '.mjs')}.status`), String(res.status)); } catch { /* 无所谓 */ }
  } else {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 交给系统清理 */ }
  }

  const ms = Date.now() - t0;
  const tail = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  const rec = {
    script: rel,
    ok: res.status === 0,
    status: res.status,
    timedOut: res.error?.code === 'ETIMEDOUT' || Boolean(res.signal),
    ms,
    tail: tail.slice(0, 300),
  };
  results.push(rec);
  console.log(`[${String(i + 1).padStart(3)}/${files.length}] ${rec.ok ? 'PASS' : 'FAIL'}${rec.timedOut ? '(超时)' : ''} ${String(Math.round(ms / 1000)).padStart(3)}s ${rel}${rec.ok ? '' : `  ← ${tail.slice(0, 110)}`}${!rec.ok && process.env.SUITE_KEEP_LOGS ? `  [完整输出: ${logPath}]` : ''}`);
}

const secs = Math.round((Date.now() - started) / 1000);
const pass = results.filter((r) => r.ok).length;
console.log(`\n合计 ${results.length}：通过 ${pass} / 失败 ${results.length - pass}（${secs}s）`);

fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const outPath = path.join(ROOT, `.tmp/acceptance-${tag}.json`);
fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 1));
console.log(`结果已写入 ${path.relative(ROOT, outPath).replaceAll('\\', '/')}`);

const compareWith = flag('compare', null);
if (compareWith) {
  const base = JSON.parse(fs.readFileSync(path.isAbsolute(String(compareWith)) ? String(compareWith) : path.join(ROOT, String(compareWith)), 'utf8'));
  const before = new Map(base.results.map((r) => [r.script, r.ok]));
  const regressions = results.filter((r) => before.get(r.script) === true && !r.ok);
  const fixed = results.filter((r) => before.get(r.script) === false && r.ok);
  const newly = results.filter((r) => !before.has(r.script));
  console.log(`\n对比基线（${base.at}）：回归 ${regressions.length} · 修好 ${fixed.length} · 新增 ${newly.length}`);
  for (const r of regressions) console.log(`  ⚠️ 回归 ${r.script}  ← ${r.tail.slice(0, 120)}`);
  for (const r of fixed) console.log(`  ✅ 修好 ${r.script}`);
  if (regressions.length) {
    console.log('\n**出现回归，退出码 1**');
    process.exit(1);
  }
}
if (pass !== results.length) process.exitCode = 1;
