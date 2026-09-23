// P137 数据访问必须 await（RDS/MySQL 改造的验收工具）
//
// 为什么需要它：把数据访问层从**同步**（node:sqlite 的 DatabaseSync）改成**异步**（MySQL）之后，
// 最容易犯、也最难发现的错就是**漏写 await**：
//   · `node --check` 抓不到 —— 语法完全合法；
//   · 运行时也不报错 —— 你拿到的是一个 Promise，代码会"拿 Promise 当数据用"：
//     `if (user)` 恒真、`user.id` 是 undefined、`[...rows]` 是空数组……表现成**各种莫名其妙的业务错**，
//     而日志里一行红都没有。
// 所以改造期间用它当**进度尺**，改造完用它当**门禁**。
//
// 用法：
//   node scripts/p137-async-db-await.mjs            # 报告：还有多少处没 await（进度尺）
//   node scripts/p137-async-db-await.mjs --gate     # 门禁：只要还有一处没 await 就退出码 1
//   node scripts/p137-async-db-await.mjs --file apps/server/src/routes/orgAdmin.js   # 只看一个文件
//
// 判据（刻意保守，宁可少报也不误报）：
//   命中 `\b(row|rows|q|one|count|transaction)\s*\(`，且满足全部：
//     · 前面不是 `.`（排除 obj.row( )）也不是 `function`（排除定义）
//     · 不是 import 语句里的名字
//     · 调用点之前**没有 await**（同一行往前看，允许 `await ` 隔着若干字符）
//     · 不是被引号/注释包住的文本（粗筛：跳过明显的注释行）
//   —— `rows(...).map(...)` 这种"查完再加工"是**合法**的：只要 rows( 前面有 await 就行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = process.argv.includes('--gate');
const onlyFile = (() => { const i = process.argv.indexOf('--file'); return i >= 0 ? process.argv[i + 1] : null; })();

const DB_FUNCS = ['row', 'rows', 'q', 'one', 'count', 'transaction'];

// **按设计保留**同步 API 的文件：schema.js 就是这套同步 API 的实现本体，里面还有导入期
// 建表/回填（它们是同步执行的）。门禁只判**应用代码**，这些文件单独列出来给人看。
const SYNC_BY_DESIGN = new Set(['packages/database/src/schema.js']);
const CALL_RE = new RegExp(`\\b(${DB_FUNCS.join('|')})\\s*\\(`, 'g');

// 异步 API 名：这些调用**必须** await。
// ⚠️ 为什么必须单独查它们（2026-09-23 实测踩到）：`\brow(` 匹配不到 `arow(`
//    （`a` 与 `r` 之间没有词边界），所以"有人把 `await arow(` 改回 `arow(`" 这种**最常见的回退**，
//    只查同步名的话门禁照样绿 —— 我插了一处漏 await 试验，门禁没拦住，才发现这个洞。
const ASYNC_FUNCS = ['arow', 'arows', 'aq', 'aone', 'acount', 'atransaction', 'amap'];
const ASYNC_CALL_RE = new RegExp(`\\b(${ASYNC_FUNCS.join('|')})\\s*\\(`, 'g');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(full, out); }
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = onlyFile
  ? [path.resolve(root, onlyFile)]
  : [...walk(path.join(root, 'apps/server/src')), ...walk(path.join(root, 'packages/database/src'))];

const findings = [];
const awaitedUses = [];
const unawaitedAsync = [];
for (const file of files) {
  const rel = path.relative(root, file).replaceAll('\\', '/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // 跳过整行注释 / 明显的注释文本
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const m of line.matchAll(CALL_RE)) {
      const name = m[1];
      const before = line.slice(0, m.index);
      // 排除：定义（`function q(` / `export function row(`）、属性访问（`.row(`）、import 里的名字
      if (/\bfunction\s+$/.test(before)) continue;
      if (/\.\s*$/.test(before)) continue;
      if (/\bimport\b|^\s*\}?\s*from\b/.test(before)) continue;
      // 去掉行内注释后再判断有没有 await（`… row(…) // 注释` 里注释里的 await 不算）
      const code = before.split('//')[0];
      const awaited = /\bawait\b/.test(code);
      // 声明式：`const row = …` / `function rows(` 等定义
      if (new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b`).test(code)) continue;
      // 两类都记：① 没 await 的（最危险）② 还在用**同步 API** 的（哪怕 await 了，也该用异步名）
      (awaited ? awaitedUses : findings).push({ file: rel, line: i + 1, text: trimmed.slice(0, 110) });
    }
    // ⚠️ 异步 API 名（arow/arows/aq/…）也必须查：`\brow(` 匹配不到 `arow(`，
    //    所以"有人把 await arow( 改成 arow("这种最常见的回退，只查同步名的话**完全看不见**
    //    （2026-09-23 实测发现：插一处漏 await，门禁照样绿）。
    for (const m of line.matchAll(ASYNC_CALL_RE)) {
      const name = m[1];
      const before = line.slice(0, m.index);
      if (/\bfunction\s+$/.test(before)) continue;
      if (/\.\s*$/.test(before)) continue;
      if (/\bimport\b|^\s*\}?\s*from\b/.test(before)) continue;
      const code = before.split('//')[0];
      if (/\bawait\b/.test(code)) continue;
      if (new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b`).test(code)) continue;
      // `return arow(…)` 是**合法且必需**的委托写法：数据层自己的 aone 就这么写 ——
      // 关键是这类函数**不能**声明成 async（async 返回原生 Promise，会把"漏 await 当场炸"的
      // 检测器吞掉）。返回的就是那个 Proxy，漏 await 依旧会在**调用方**被抓住，
      // 所以这里放行；调用方那一侧由本门禁的另外两类检查兜。
      if (/\breturn\s*$/.test(code)) continue;
      unawaitedAsync.push({ file: rel, line: i + 1, text: trimmed.slice(0, 110) });
    }
  });
}

const byFile = new Map();
for (const f of findings) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
const awaitedByFile = new Map();
for (const f of awaitedUses) awaitedByFile.set(f.file, (awaitedByFile.get(f.file) || 0) + 1);

console.log(`P137 数据访问 await 检查`);
console.log(`  扫描了 ${files.length} 个文件`);
console.log(`  · **没 await 的数据访问调用：${findings.length} 处**`);
console.log(`  · 还在用同步 API 名（row/rows/q/…）的调用：${awaitedUses.length} 处`);
console.log(`  · **异步 API 名（arow/aq/…）没 await 的调用：${unawaitedAsync.length} 处**（最像"有人改回退了"的那一类）`);
if (findings.length || awaitedUses.length) {
  const all = new Map();
  for (const [f, n] of byFile) all.set(f, n);
  for (const [f, n] of awaitedByFile) all.set(f, `${all.get(f) ?? 0}(+${n} 同步名)`);
  console.log('\n  按文件（前 15）:');
  for (const [f, n] of [...all.entries()].sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 15)) {
    const designed = SYNC_BY_DESIGN.has(f) ? '   ← 按设计保留（同步 API 的实现 + 导入期迁移）' : '';
    console.log(`    ${String(n).padStart(4)}  ${f}${designed}`);
  }
  if (onlyFile || process.argv.includes('--list')) {
    console.log('\n  明细:');
    for (const f of [...findings, ...awaitedUses].slice(0, 60)) console.log(`    ${f.file}:${f.line}  ${f.text}`);
  }
}
if (gate) {
  // 门禁只看**应用代码**：schema.js 是这套同步 API 的实现本体（还有导入期建表/回填），
  // 它里面的同步调用是设计的一部分，改了就是自己吃自己。
  const bad = [...findings, ...awaitedUses, ...unawaitedAsync].filter((f) => !SYNC_BY_DESIGN.has(f.file));
  if (bad.length) {
    console.log(`\n❌ 门禁未过：应用代码里还有 ${bad.length} 处同步数据访问（没 await 或还在用同步 API 名）—— 改造被回退了？`);
    for (const f of bad.slice(0, 20)) console.log(`    ${f.file}:${f.line}  ${f.text}`);
    process.exit(1);
  }
  console.log(`\n✅ 门禁通过：应用代码里同步数据访问 0 处、异步 API 漏 await 0 处（schema.js 里 ${findings.length + awaitedUses.length} 处按设计保留）。`);
}
