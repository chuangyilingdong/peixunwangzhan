/**
 * P151 列表页「即时搜索」必须防抖（2026-09-26 用户报的卡顿）。
 *
 * 用户原话：「搜索交互有问题，每输入一个字符页面就要自动刷新一次，会有明显卡顿感」。
 * 现场（机构端「作品管理」）两个毛病叠在一起：
 *   ① 关键词**直接**拼进查询，而 `useData` 的依赖一变就重取 —— **每敲一个字发一次请求**
 *      （这条还带 `includeSnapshot=true`，响应本身就不小）；
 *   ② 那些页面在 `loading` 时会**整页换成 `<Loading />`** —— 于是每敲一个字"整页变 loading 再变回来"。
 * 实测（真 Chrome，敲 3 个字符、间隔 90ms）：改前 **3 次**请求 / 改后 **1 次**（见 §三十五）。
 *
 * 这一道把口径钉住（静态，不需要 Chrome）：
 *   ① 公共钩子 `useDebouncedValue` 存在、从 shared 入口导出；
 *   ② **把文本筛选接进查询**的那些页面文件必须用到它（判据：文件里同时出现
 *      `filters.search`/`Object.entries(filters)` 与 `useData(`，就必须出现 `useDebouncedValue`）——
 *      这样新写的列表页只要忘了防抖就会被这条扫出来；
 *   ③ 机构端「作品管理」重取时不许整页占位（`loading && !data` 才允许）。
 * 跑法：node scripts/p151-live-search-debounce.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('① 公共钩子');
const hookPath = path.join(root, 'packages/shared/src/useDebounced.js');
const hook = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : '';
check('① useDebounced.js 存在且导出 useDebouncedValue',
  /export function useDebouncedValue\(value, delay = \d+\)/.test(hook), hookPath);
check('① 从 shared 入口导出（页面才 import 得到）',
  /export \* from '\.\/useDebounced\.js';/.test(fs.readFileSync(path.join(root, 'packages/shared/src/index.js'), 'utf8')));
check('① 它是真的"延迟"而不是"透传"（有 setTimeout + cleanup）',
  /setTimeout\(\(\) => setDebounced\(value\)/.test(hook) && /clearTimeout\(timer\)/.test(hook));
check('① 默认延迟在"手感阈值"内（200–500ms）', (() => {
  const delay = Number((hook.match(/delay = (\d+)/) || [])[1] || 0);
  return delay >= 200 && delay <= 500;
})());

console.log('② 把文本筛选接进查询的页面必须防抖');
const roots = ['apps/org/src', 'apps/admin/src'];
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); continue; }
    if (/\.jsx?$/.test(entry.name)) files.push(rel);
  }
};
roots.forEach(walk);
check('② 扫到了前端源码（文件数为正，说明扫描根没写错）', files.length > 20, `files=${files.length}`);

const live = [];
const offenders = [];
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  // 判据：页面上有**输入控件绑在 filters 上**（`<input ... value={filters.字段}`）+ 用 useData 取数
  // —— 这种组合就是"改一下筛选条件就重取"。放宽到任意字段（不只 search）是因为审核页那类
  //    文本字段叫 action / targetId / requestPath，只认 search 会把它们漏掉（第一版就漏了）。
  const boundInput = /<input/.test(source) && /value=\{filters\.[A-Za-z]+\}/.test(source);
  if (!(boundInput && /useData\(/.test(source))) continue;
  live.push(file);
  if (!/useDebouncedValue\(/.test(source)) offenders.push(file);
}
check(`② 有「输入控件 + useData 取数」的页面共 ${live.length} 个，全部用了 useDebouncedValue`, offenders.length === 0,
  offenders.length ? `没防抖：${offenders.join('、')}` : '');

console.log('③ 机构端「作品管理」重取时不整页占位');
const orgMain = fs.readFileSync(path.join(root, 'apps/org/src/main.jsx'), 'utf8');
check('③ 只有首次加载才允许整页 <Loading />（重取时保留列表）',
  /if \(loading && !data\) return <Loading \/>;/.test(orgMain) && !/if \(loading\) return <Loading \/>;\n  if \(error\) return <ErrorState error=\{error\} onRetry=\{refresh\} \/>;\n  return <>\n    <PageHeader eyebrow="学习成果"/.test(orgMain));
check('③ 刷新中有轻提示（而不是把整页换掉）', /正在刷新…/.test(orgMain));

if (failures) {
  console.error(JSON.stringify({ name: 'p151-live-search-debounce', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p151-live-search-debounce', pass: true, livePages: live.length }));
