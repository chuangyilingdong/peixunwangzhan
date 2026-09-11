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
 * 判定一：组件函数体内（缩进 0 的 function/const 组件），
 *  - 缩进 2 的「单行提前 return」，或
 *  - 缩进 2 的 `if (...) {` 块里紧随其后的缩进 4+ return（跨行写法）
 * 之后，又出现缩进 2 的 hook 调用 → 命中即失败，并打印文件与行号。
 *
 * 判定二（2026-09-11 第十六轮加）：组件里用了 `setXxx` 却在同一个组件里没有声明。
 * 真实事故：website main.jsx 的 InnerCircleHeader 用了 `showStudentMenu` / `setShowStudentMenu`，
 * 但那段代码所在组件只声明了 `menuOpen` —— 学生登录状态打开官网首页直接
 * `ReferenceError: showStudentMenu is not defined` 整页白屏。
 * 这个 bug 在仓库里躺了很久（只有「已登录学生看首页」这一条渲染路径会炸），而且**同名 state 在
 * 同文件的另一个组件里声明过**，所以任何「按文件查未定义标识符」的检查都发现不了，必须按组件分段看。
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

// ── 判定二：组件里用了 setXxx，但同一个组件（或模块作用域）里没有声明它 ──
// 只做「明显错误」的判定：把 setXxx 当成普通标识符看，声明来源包括
//   const/let/var（含数组/对象解构）、函数参数（含解构与默认值）、模块作用域（缩进 0）、
// 以及本文件里的 import。取不到就报 —— 误报方向是「多报」还是「少报」很关键：
// 这里的参数/解构解析只会让「声明集合」变大（少报），所以不会挡住正常代码。
// 前面不能是 `.`：`localStorage.setItem` / `video.setAttribute` / `input.setSelectionRange`
// 这类是方法调用，不是 state setter。也不吃 `setTimeout` / `setInterval` 这类全局定时器。
const setterUseRe = /(?<![.\w$])set[A-Z][\w$]*/g;
// 后面直接跟 `:` 的是对象字面量的键（`{ setCookie: null }`），不是调用。
// 不能写进正则的负向断言：`[\w$]*` 会回溯成 `setCooki` 这种被截断的名字（踩过）。
const isObjectKey = (text, match) => /^\s*:/.test(text.slice(match.index + match[0].length));
const setterIgnoreRe = /^set(Timeout|Interval|Immediate)$/;
const moduleScopeRe = /^(?:export\s+)?(?:const|let|var|async\s+function|function)\s+/;

function addBindings(target, raw) {
  String(raw || '').split(',').forEach((part) => {
    const cleaned = part.replace(/^\.\.\./, '').split('=')[0].split(':').pop().replace(/\bas\b/g, ' ').trim();
    const name = cleaned.match(/[A-Za-z_$][\w$]*/g);
    if (name) name.forEach((item) => target.add(item));
  });
}
function collectDeclared(text, into) {
  for (const match of text.matchAll(/\b(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)/g)) {
    const decl = match[1];
    if (decl.startsWith('[') || decl.startsWith('{')) addBindings(into, decl.slice(1, -1));
    else into.add(decl);
  }
  // 具名函数声明（含组件内部的小函数）也会引入名字
  for (const match of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) into.add(match[1]);
  for (const match of text.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) addBindings(into, match[1]);
  for (const match of text.matchAll(/\(([^)]*)\)\s*=>/g)) addBindings(into, match[1]);
  for (const match of text.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=>/gm)) into.add(match[1]);
  return into;
}

const undeclaredFindings = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  // 模块作用域：缩进 0 的声明 + import 进来的名字（跨组件共用得很正常，不算未声明）
  const moduleScope = new Set();
  lines.forEach((line) => { if (moduleScopeRe.test(line)) collectDeclared(line, moduleScope); });
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    addBindings(moduleScope, match[1].replace(/[{}]/g, ''));
  }
  // `export { a, b } from './x.js'` 的再导出清单也是「这个名字在本文件出现过」，不是调用
  for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}/g)) addBindings(moduleScope, match[1]);
  // 按「缩进 0 的函数/组件」分段
  const segments = [];
  lines.forEach((line, index) => {
    if (topLevelFnRe.test(line)) segments.push({ start: index, lines: [] });
    if (segments.length) segments[segments.length - 1].lines.push(line);
  });
  segments.forEach((segment) => {
    const text = segment.lines.join('\n');
    const declared = collectDeclared(text, new Set());
    const used = new Set([...text.matchAll(setterUseRe)].filter((match) => !isObjectKey(text, match)).map((match) => match[0]));
    used.forEach((name) => {
      if (setterIgnoreRe.test(name) || declared.has(name) || moduleScope.has(name)) return;
      const lineNumber = segment.start + segment.lines.findIndex((line) => new RegExp(`\\b${name}\\b`).test(line)) + 1;
      undeclaredFindings.push({ file: relative(process.cwd(), file), line: lineNumber, name, component: (segment.lines[0] || '').trim().slice(0, 60) });
    });
  });
}

if (findings.length) {
  console.error('Hook 出现在提前 return 之后，会在客户端渲染时抛 React #300（整页白屏）：');
  for (const f of findings) console.error(`  ${f.file}:${f.hookLine}  [return 在第 ${f.returnLine} 行]  ${f.code}`);
  console.error('修法：把该 hook（及其依赖的衍生值）移到所有提前 return 之前。');
  process.exit(1);
}

if (undeclaredFindings.length) {
  console.error('组件用了 setXxx 却没在同一个组件里声明 —— 渲染到那段 JSX 时抛 ReferenceError、整页白屏：');
  for (const f of undeclaredFindings) console.error(`  ${f.file}:${f.line}  ${f.name}  （组件：${f.component}）`);
  console.error('修法：在该组件里补 `const [xxx, setXxx] = useState(...)`（或确认它其实应该来自 props）。');
  process.exit(1);
}

console.log(JSON.stringify({ name: 'hook-order-guard', pass: true, scannedFiles: files.length, findings: 0, undeclaredSetters: 0 }, null, 2));
