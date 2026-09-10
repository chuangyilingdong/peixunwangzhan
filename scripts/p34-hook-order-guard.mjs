/**
 * P34 hook 顺序守卫（静态扫描，不需要起服务）
 *
 * 背景：这类 bug 会让整页白屏（React #300/#310），但三端构建能过、API 冒烟也全过，
 * 只有真人打开页面才炸。已经踩到两次：
 *  1) canvasWorkspace.jsx：自动保存的 hook 写在 `if (project.loading) return <Loading/>` 之后；
 *  2) website main.jsx：`const [showStudentMenu, ...] = useState(false)` 写在
 *     `if (pathname.startsWith('/learn') && !session) { return <Navigate .../> }` 之后
 *     ——学生会话过期时白屏，而不是跳登录页。
 *
 * 判定：组件函数体内（缩进 0 的 function/const 组件），
 *  - 缩进 2 的「单行提前 return」，或
 *  - 缩进 2 的 `if (...) {` 块里紧随其后的缩进 4+ return（跨行写法）
 * 之后，又出现缩进 2 的 hook 调用 → 命中即失败，并打印文件与行号。
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
const inlineReturnRe = /^  (if\s*\(.*\)\s*return\b|return\s)/;
const blockIfRe = /^  if\s*\(.*\{\s*$/;
const topLevelFnRe = /^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?const\s+\w+\s*=\s*(\(|function|memo\()/;
const findings = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let returnedAt = null;
  lines.forEach((line, index) => {
    if (topLevelFnRe.test(line)) { returnedAt = null; return; }
    if (!returnedAt && blockIfRe.test(line)) {
      // 跨行写法：if (...) { 之后、缩进 2 的 } 之前出现缩进 4+ 的 return
      for (let i = index + 1; i < lines.length; i += 1) {
        if (/^  \}/.test(lines[i])) break;
        if (/^    (if\s*\(.*\)\s*)?return\b/.test(lines[i])) { returnedAt = i + 1; break; }
      }
      return;
    }
    if (!returnedAt && inlineReturnRe.test(line) && !hookRe.test(line)) { returnedAt = index + 1; return; }
    if (returnedAt && hookRe.test(line)) findings.push({ file: relative(process.cwd(), file), returnLine: returnedAt, hookLine: index + 1, code: line.trim().slice(0, 80) });
  });
}

if (findings.length) {
  console.error('Hook 出现在提前 return 之后，会在客户端渲染时抛 React #300（整页白屏）：');
  for (const f of findings) console.error(`  ${f.file}:${f.hookLine}  [return 在第 ${f.returnLine} 行]  ${f.code}`);
  console.error('修法：把该 hook（及其依赖的衍生值）移到所有提前 return 之前。');
  process.exit(1);
}

console.log(JSON.stringify({ name: 'hook-order-guard', pass: true, scannedFiles: files.length, findings: 0 }, null, 2));
