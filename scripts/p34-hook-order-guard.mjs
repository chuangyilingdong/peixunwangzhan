/**
 * P34 hook 顺序守卫（静态扫描，不需要起服务）
 *
 * 背景：画布课堂整页白屏（React #310）——自动保存的 useState/useRef/useEffect 被写在了
 * `if (project.loading) return <Loading/>` 之后。加载态渲染的 hook 数少、数据到了变多，
 * React 直接抛错并卸载整棵树。这类问题三端构建能过、API 冒烟能过、只有真人打开页面才会炸，
 * 所以用一个静态检查把它挡在提交前。
 *
 * 判定：组件函数体（缩进 0 的 function/const）内，缩进 2 的提前 return 之后又出现缩进 2 的 hook 调用。
 * 命中即失败；同时打印文件名与行号，便于直接定位。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const roots = ['apps', 'packages'].map((dir) => join(process.cwd(), dir));
const files = [];
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (['.jsx', '.tsx', '.js', '.ts'].includes(extname(full)) && !full.endsWith('.config.mjs')) files.push(full);
  }
}
for (const root of roots) walk(root);

const hookRe = /^\s*(use[A-Z]\w*\s*\(|const\s+\[[^\]]*\]\s*=\s*use[A-Z]|const\s+\w+\s*=\s*useRef\()/;
const earlyReturnRe = /^  (if\s*\(.*\)\s*return\b|return\s)/;
const topLevelFnRe = /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?const\s+\w+\s*=\s*(\(|function|memo\()/;
const findings = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let returnedAt = null;
  lines.forEach((line, index) => {
    if (topLevelFnRe.test(line)) { returnedAt = null; return; }
    if (earlyReturnRe.test(line) && !hookRe.test(line)) { if (!returnedAt) returnedAt = index + 1; return; }
    if (returnedAt && hookRe.test(line)) findings.push({ file: relative(process.cwd(), file), returnLine: returnedAt, hookLine: index + 1, code: line.trim().slice(0, 80) });
  });
}

if (findings.length) {
  console.error('Hook 出现在提前 return 之后，会在客户端渲染时抛 React #310（整页白屏）：');
  for (const f of findings) console.error(`  ${f.file}:${f.hookLine}  [return 在第 ${f.returnLine} 行]  ${f.code}`);
  console.error('修法：把该 hook（及其依赖的衍生值）移到所有提前 return 之前。');
  process.exit(1);
}

console.log(JSON.stringify({ name: 'hook-order-guard', pass: true, scannedFiles: files.length, findings: 0 }, null, 2));
