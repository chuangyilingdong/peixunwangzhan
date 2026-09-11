// 图标名静态守卫：**写错名字不会报错，只会渲染成一个空按钮 / 空白**（`Icon` 与 `ConsoleIcon`
// 对未知名字都直接 `return null`）。2026-09-11 的实例：工作台的关闭键写的是 `icon="close"`，
// 而控制台图标集里只有 `x` —— 线上那个按钮就是个看不见的空圈，用户报「手动关闭按钮根本看不到」。
//
// 本仓有**两套互不相通**的图标集，混用是最容易犯的错：
//   · packages/shared/src/icons.jsx          → 画布在用（组件名 Icon）
//   · packages/shared/src/console/icons.jsx  → 控制台在用（组件名 ConsoleIcon / IconButton 的 icon）
// 这里按「组件名 + 引入路径」判断该查哪一套，只查字符串字面量（动态拼出来的查不了，也不该拼）。
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function iconNamesIn(file) {
  const source = readFileSync(file, 'utf8');
  const block = source.match(/const PATHS = \{([\s\S]*?)\n\};/);
  assert.ok(block, `${file}：没找到 PATHS 定义（图标集的形状变了？）`);
  return new Set([...block[1].matchAll(/^\s{2}([A-Za-z][\w-]*):/gm)].map((match) => match[1]));
}

const CANVAS_ICONS = iconNamesIn(path.join(root, 'packages/shared/src/icons.jsx'));
const CONSOLE_ICONS = iconNamesIn(path.join(root, 'packages/shared/src/console/icons.jsx'));
assert.ok(CANVAS_ICONS.size > 5, '画布图标集读出来是空的，守卫本身可能坏了');
assert.ok(CONSOLE_ICONS.size > 5, '控制台图标集读出来是空的，守卫本身可能坏了');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = [
  ...walk(path.join(root, 'packages/shared/src')),
  ...walk(path.join(root, 'apps/website/src')),
  ...walk(path.join(root, 'apps/admin/src')),
  ...walk(path.join(root, 'apps/org/src')),
];

/** 这个文件里的 ConsoleIcon / Icon 各自是谁（按 import 来源判断） */
function iconKinds(source) {
  const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)];
  const kinds = new Map();   // 组件名 → 图标集
  for (const [, names, from] of imports) {
    const isConsole = /console\//.test(from) || /console$/.test(from);
    for (const raw of names.split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (name === 'ConsoleIcon' || name === 'IconButton') kinds.set(raw.trim().split(/\s+as\s+/).pop().trim(), CONSOLE_ICONS);
      else if (name === 'Icon' && !isConsole) kinds.set('Icon', CANVAS_ICONS);
      else if (name === 'Icon' && isConsole) kinds.set('Icon', CONSOLE_ICONS);
    }
  }
  return kinds;
}

const problems = [];
let checked = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const kinds = iconKinds(source);
  if (!kinds.size) continue;
  const relative = path.relative(root, file).replaceAll('\\', '/');

  for (const [component, icons] of kinds) {
    // 只抓字符串字面量：name="x" / name='x'；动态表达式交给人工review（提示一次）
    const attribute = component === 'IconButton' ? 'icon' : 'name';
    const pattern = new RegExp(`<${component}\\b[^>]*?\\b${attribute}=["']([A-Za-z][\\w-]*)["']`, 'g');
    for (const match of source.matchAll(pattern)) {
      checked += 1;
      const used = match[1];
      if (!icons.has(used)) {
        const names = [...icons].join(' ');
        problems.push(`${relative}: <${component} ${attribute}="${used}"> 不在${icons === CONSOLE_ICONS ? '控制台' : '画布'}图标集里\n    可用：${names}`);
      }
    }
  }
}

assert.equal(problems.length, 0, `发现 ${problems.length} 处图标名不存在（会渲染成空白、不会报错）：\n  - ${problems.join('\n  - ')}`);
assert.ok(checked >= 20, `只扫到 ${checked} 处图标用法，太少了 —— 守卫的匹配规则可能失效了`);

console.log(`P48 icon name guard passed（扫了 ${files.length} 个文件、${checked} 处图标用法；画布 ${CANVAS_ICONS.size} 个图标 / 控制台 ${CONSOLE_ICONS.size} 个）`);
