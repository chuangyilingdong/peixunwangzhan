/**
 * P131 官网首页数据区那四个图标（用户 2026-09-23 口径）。
 *
 * 用户原话：「用这些 logo，把官网首页图1这4个logo换一下」，并给了
 * https://github.com/topics/svg-icon —— 取那一页排第一的 **css.gg**（MIT）。
 *
 * 三件容易做漏的事，逐条钉住：
 *   ① **生产 CMS 里是有值的**（HOME.stats 存的就是 ◆ ◇ ✧ ⌘那几个字符），
 *      只改代码兜底的话线上一个图标都不会变 → 必须把老字符映射到新图标；
 *   ② 「三处来源必须是同一组」（代码兜底 / CMS 兜底 / 种子默认值）—— 数字与图标名都要一致；
 *   ③ 后台那个「图标」输入框原来是 `maxLength={4}`，**图标名会被截断**（package→pack）→
 *      认不出来就退回文字，运维在后台永远配不出图标。
 *
 * ⚠️ 真观感由 `.tmp/then-home-stats.mjs` 在真浏览器里核（见第二十八轮交接 §六）。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const site = read('apps/website/src/main.jsx');
const defaults = read('packages/database/src/websiteContentDefaults.js');
const css = read('apps/website/src/styles.css');
const admin = read('apps/admin/src/pages/WebsiteContent.jsx');

/* ── ① 图标本体 ─────────────────────────────────────────────────────── */
check('① 四个图标是**内联 SVG**（不引图标库依赖）', /const HOME_STAT_ICONS = \{/.test(site) && /<svg viewBox="0 0 24 24"/.test(site));
check('① 出处与许可写在代码里（css.gg / MIT —— 换图标时要一起换掉）',
  /css\.gg/.test(site) && /MIT/.test(site) && /topics\/svg-icon/.test(site));
check('① 尺寸与颜色跟着那一层走（1em / currentColor），不是写死的像素',
  /\.hp-stat i\.hp-stat-icon svg\{display:block;width:1em;height:1em;fill:currentColor\}/.test(css));
check('① 渲染用的是图标组件（不是把字符直接塞进 <i>）',
  /<HomeStatIcon name=\{item\.icon\} \/>/.test(site) && !/<i>\{item\.icon \|\| '✦'\}<\/i>/.test(site));

/* ── ② 老数据要能升级（生产 CMS 里存的是字符）──────────────────────── */
check('② 老字符（◆ ◇ ✧ ⌘）映射到新图标 —— **不改生产 CMS 数据**也能立刻换掉',
  /LEGACY_HOME_STAT_ICONS = \{ '◆': 'package', '◇': 'lessons', '✧': 'format', '⌘': 'console' \}/.test(site));
check('② 认不出来的（运维写了个 emoji）仍按文字渲染，不被吃掉',
  /if \(!key\) return <i>\{raw \|\| '✦'\}<\/i>;/.test(site));

/* ── ③ 三处来源同一组（图标名 + 数字都要一致）───────────────────────── */
const rowRe = /\{\s*icon:\s*'([^']+)',\s*value:\s*(\d+),\s*suffix:\s*'([^']*)',\s*label:\s*'([^']*)'\s*\}/g;
const rowsOf = (text) => [...text.matchAll(rowRe)].map((m) => `${m[1]}|${m[2]}|${m[3]}|${m[4]}`).slice(0, 4);
const codeRows = rowsOf(site);
const seedRows = rowsOf(defaults);
check('③ 代码兜底那四行是**图标名**（不是字符）',
  codeRows.length === 4 && codeRows.every((row) => /^(package|lessons|format|console)\|/.test(row)), JSON.stringify(codeRows));
check('③ 种子默认值与代码兜底**逐字段一致**（图标名 / 数字 / 后缀 / 名称）',
  seedRows.length === 4 && JSON.stringify(seedRows) === JSON.stringify(codeRows),
  `种子=${JSON.stringify(seedRows)} 代码=${JSON.stringify(codeRows)}`);

/* ── ④ 后台那个输入框别把图标名截断 ───────────────────────────────── */
// ⚠️ 别用 `<input[^>]*maxLength` 这种写法：那一段里有 `onChange={(event) => …}`，
//    箭头里的 `>` 会把 `[^>]*` 提前截断 → 永远匹配不上（第一版就是这么假红的）。
//    改成**把数值抓出来比**，顺带也挡住了"图标那格没改、却匹配到后面『名称』那格 maxLength=24"的假绿。
const iconMaxLength = Number((admin.match(/图标<input[\s\S]*?maxLength=\{(\d+)\}/) || [])[1] || 0);
check('④ 后台「图标」输入框的 maxLength 放得下图标名（原来 =4，package 会被截成 pack）',
  iconMaxLength >= 12, `实际 maxLength=${iconMaxLength}`);
check('④ 输入框给了可选值提示，新增项也默认一个真图标（不是 ✦ 字符）',
  /placeholder="package \/ lessons \/ format \/ console"/.test(admin)
  && /addList\('stats', \{ icon: 'package'/.test(admin));

console.log('');
if (failures) { console.log(`✗ p131 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p131 首页数据区图标：全部通过');
