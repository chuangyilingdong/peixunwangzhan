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

console.log(`验收套件：${files.length} 个脚本（node ${process.version}，每脚本超时 ${Math.round(timeout / 1000)}s）\n`);

for (let i = 0; i < files.length; i += 1) {
  const rel = files[i];
  if (useMysql) {
    try { await resetMysqlDatabase({ silent: true }); }
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
      ...(useMysql ? mysqlEnvFromProcess() : {}),
      PLATFORM_DATA_DIR: tmp,
      PLATFORM_DB_PATH: path.join(tmp, 'platform.db'),
      DEPLOYMENT_MODE: process.env.DEPLOYMENT_MODE || 'internal-test',
    },
  });
  fs.closeSync(fd);
  let out = '';
  try { out = fs.readFileSync(logPath, 'utf8'); } catch { /* 没输出就算了 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 交给系统清理 */ }

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
  console.log(`[${String(i + 1).padStart(3)}/${files.length}] ${rec.ok ? 'PASS' : 'FAIL'}${rec.timedOut ? '(超时)' : ''} ${String(Math.round(ms / 1000)).padStart(3)}s ${rel}${rec.ok ? '' : `  ← ${tail.slice(0, 110)}`}`);
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
