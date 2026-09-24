// 验收套件**并行跑法**（MySQL 侧专用）—— 把"1 小时的串行全量"压到十几分钟。
//
// 为什么需要它（2026-09-24 实测）：`--mysql` 时套件**每个脚本都要重建一次库**
// （结构由代码现生成，实测一次重置约 24 秒）。151 个脚本串行 ≈ 1 小时以上，
// 而脚本本身的运行时间往往只有 0~5 秒 —— 时间全花在"造库"上。
//
// 做法：按**端口不冲突**把脚本分成 N 片，每片起一个 acceptance-suite 进程（同一台 MySQL 上并行）。
//   · 库名用 SUITE_DB_PREFIX 错开（`aild_p1_7` 这种），否则两份套件的第 i 个脚本会互相清库；
//   · 端口冲突的脚本（同一个 `const port`）一定分到不同的片；
//   · 每片的结果落在 `.tmp/acceptance-<tag>-s<i>.json`，最后合并成 `.tmp/acceptance-<tag>.json`
//     —— 格式与单进程跑出来的一致，所以 `--compare=` 照样能用。
//
// 用法：
//   MYSQL_HOST=127.0.0.1 MYSQL_PORT=13306 MYSQL_USER=root MYSQL_PASSWORD=… MYSQL_DATABASE=aild_admin \
//     node scripts/acceptance-suite-parallel.mjs --shards=6 --mysql --tag=mysql-after
//   … 再对比基线：
//     node scripts/acceptance-suite-parallel.mjs --shards=6 --mysql --tag=mysql-after --compare=.tmp/acceptance-mysql-before.json
//
// ⚠️ 只对 **MySQL 侧**有意义：SQLite 侧每个脚本本来就只有几十毫秒的启动成本，串行跑就够了
//    （并行反而会抢 CPU、把 Chrome 类脚本跑飘）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : true;
};

const NOT_TESTS = /^scripts\/(dev-bench|page-shot|import-|live-|verify-production|classroom-detail-qa-fixture)/;
const HARNESS = new Set([
  'scripts/acceptance-suite.mjs',
  'scripts/acceptance-script-wrapper.mjs',
  'scripts/mysql-test-db.mjs',
  'scripts/rds-p1-codemod',
  'scripts/rds-p2-fixture-codemod.mjs',
  'scripts/acceptance-suite-parallel.mjs',
]);

const shards = Math.max(1, Number(flag('shards', 6)) || 6);
const tag = String(flag('tag', 'parallel'));
const timeout = Number(flag('timeout', 120000));
const nodeBin = process.env.SUITE_NODE || process.execPath;

// ── 选脚本 + 按端口分片（同一片里不许有两个脚本抢同一个端口） ─────────────────────
const explicit = args.filter((a) => a.startsWith('scripts/'));
const files = explicit.length
  ? explicit
  : fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => `scripts/${f}`)
    .filter((f) => !NOT_TESTS.test(f) && !HARNESS.has(f))
    .sort();

const portOf = (file) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const hit = /const port\s*=\s*(\d{4,5})/.exec(src)
    || /\bPORT\s*:\s*String\((\d{4,5})\)/.exec(src)
    || /\bPORT\s*:\s*'(\d{4,5})'/.exec(src)
    || /\bPORT\s*:\s*(\d{4,5})/.exec(src);
  return hit ? hit[1] : null;
};

const groups = Array.from({ length: shards }, () => []);
const used = Array.from({ length: shards }, () => new Set());
const byPort = new Map();
for (const file of files) {
  const port = portOf(file);
  const key = port === null ? `__none_${file}` : port;
  if (!byPort.has(key)) byPort.set(key, []);
  byPort.get(key).push(file);
}
for (const [key, list] of [...byPort.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const port = key.startsWith('__none_') ? null : key;
  for (const file of list) {
    const candidates = groups.map((group, i) => i).filter((i) => port === null || !used[i].has(port));
    const index = candidates.reduce((best, i) => (groups[i].length < groups[best].length ? i : best), candidates[0]);
    if (port !== null) used[index].add(port);
    groups[index].push(file);
  }
}

console.log(`并行跑法：${files.length} 个脚本分 ${shards} 片 → ${groups.map((g) => g.length).join(' / ')}`);
console.log('（每片一个 acceptance-suite 进程；MySQL 模式下每片有自己的库名前缀）\n');

// ── 起分片进程 ────────────────────────────────────────────────────────────────
const started = Date.now();
const children = groups.map((group, index) => new Promise((resolve) => {
  if (!group.length) { resolve({ index, code: 0, tail: '(空片)' }); return; }
  const shardTag = `${tag}-s${index + 1}`;
  const prefix = `aild_p${index + 1}`;
  const child = spawn(nodeBin, [
    path.join(ROOT, 'scripts/acceptance-suite.mjs'),
    ...(flag('mysql', false) ? ['--mysql'] : []),
    `--tag=${shardTag}`,
    `--timeout=${timeout}`,
    ...group,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      // ⚠️ 两处都要错开：
      //  · SUITE_DB_PREFIX → 每脚本一库的库名 + **探针库名**（探针共享会互相 DROP → 两份都判成
      //    "没建库权限" → 退回共享库 → 互相清库，实测踩过）；
      //  · MYSQL_DATABASE → **兜底分支**（就地清表）用的那个库名。漏了它就是所有分片共用
      //    调用方给的那个库（一般叫 aild_admin）→ 六份套件在同一库里互相删表。
      SUITE_DB_PREFIX: prefix,
      ...(flag('mysql', false) ? { MYSQL_DATABASE: `${prefix}_fallback` } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  // 分片的完整输出**也落一份盘**：套件自己会把每个脚本的输出写进临时目录再删掉，
  // 只留最后一行 —— 真红的时候"红在哪一条"就查不到了（2026-09-24 实测需要）。
  const logPath = path.join(ROOT, `.tmp/acceptance-${shardTag}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'w');
  child.stdout.on('data', (x) => { out += x; fs.writeSync(logFd, x); });
  child.stderr.on('data', (x) => { out += x; fs.writeSync(logFd, x); });
  child.on('close', (code) => { try { fs.closeSync(logFd); } catch { /* 关过了就算了 */ } resolve({ index, code, tail: out.trim().split('\n').slice(-1)[0] || '' }); });
}));

const finished = await Promise.all(children);
const secs = Math.round((Date.now() - started) / 1000);

// ── 合并各片结果（格式与单进程一致，--compare 直接可用） ────────────────────────
const results = [];
for (let index = 0; index < groups.length; index += 1) {
  const file = path.join(ROOT, `.tmp/acceptance-${tag}-s${index + 1}.json`);
  if (!fs.existsSync(file)) {
    for (const script of groups[index]) results.push({ script, ok: false, status: -1, timedOut: false, ms: 0, tail: `分片 ${index + 1} 没有产出结果文件（${finished[index].tail}）` });
    continue;
  }
  results.push(...JSON.parse(fs.readFileSync(file, 'utf8')).results);
}
results.sort((a, b) => a.script.localeCompare(b.script));
const pass = results.filter((r) => r.ok).length;
console.log(`\n合计 ${results.length}：通过 ${pass} / 失败 ${results.length - pass}（${secs}s）`);
for (const rec of results.filter((r) => !r.ok)) console.log(`  ✗ ${rec.script}  ← ${String(rec.tail || '').slice(0, 120)}`);

fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const outPath = path.join(ROOT, `.tmp/acceptance-${tag}.json`);
fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 1));
console.log(`结果已写入 ${path.relative(ROOT, outPath).replaceAll('\\', '/')}`);

const compareWith = flag('compare', null);
if (compareWith) {
  const basePath = path.isAbsolute(String(compareWith)) ? String(compareWith) : path.join(ROOT, String(compareWith));
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const before = new Map(base.results.map((r) => [r.script, r.ok]));
  const regressions = results.filter((r) => before.get(r.script) === true && !r.ok);
  const fixed = results.filter((r) => before.get(r.script) === false && r.ok);
  const newly = results.filter((r) => !before.has(r.script));
  console.log(`\n对比基线（${base.at}）：回归 ${regressions.length} · 修好 ${fixed.length} · 新增 ${newly.length}`);
  for (const r of regressions) console.log(`  ⚠️ 回归 ${r.script}  ← ${String(r.tail).slice(0, 120)}`);
  for (const r of fixed) console.log(`  ✅ 修好 ${r.script}`);
  if (regressions.length) {
    console.log('\n**出现回归，退出码 1**');
    process.exit(1);
  }
}
if (pass !== results.length) process.exitCode = 1;
