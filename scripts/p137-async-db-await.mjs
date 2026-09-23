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
const CALL_RE = new RegExp(`\\b(${DB_FUNCS.join('|')})\\s*\\(`, 'g');

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
      if (/\bawait\b/.test(code)) continue;
      // 声明式：`const row = …` / `function rows(` 等定义
      if (new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b`).test(code)) continue;
      findings.push({ file: rel, line: i + 1, text: trimmed.slice(0, 110) });
    }
  });
}

const byFile = new Map();
for (const f of findings) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);

console.log(`P137 数据访问 await 检查`);
console.log(`  扫描了 ${files.length} 个文件，**没 await 的数据访问调用：${findings.length} 处**\n`);
if (byFile.size) {
  console.log('  按文件（前 15）:');
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(n).padStart(4)}  ${f}`);
  }
  if (onlyFile || process.argv.includes('--list')) {
    console.log('\n  明细:');
    for (const f of findings.slice(0, 60)) console.log(`    ${f.file}:${f.line}  ${f.text}`);
  }
}
if (gate) {
  if (findings.length) { console.log(`\n门禁未过：还有 ${findings.length} 处没 await —— 改造没完成。`); process.exit(1); }
  console.log('\n门禁通过：所有数据访问都 await 了。');
}
