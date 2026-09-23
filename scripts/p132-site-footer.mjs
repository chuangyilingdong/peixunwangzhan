/**
 * P132 页脚按参考稿重做 + **首页也要有页脚**（用户 2026-09-23，两轮口径都钉在这里）。
 *
 * 第一轮原话：「页脚根据这个来改造下，官网下方也要有页脚」，给了参考稿 Footer03Luma
 * （Tailwind + framer-motion + lucide 的深色页脚：四列链接 + 三团漂移光晕 + 品牌行 + 社交图标）。
 * 第二轮（看过实际页面之后）：「① 图1图2这部分删除（那一排图标按钮 + 那句描述）
 * ② 页脚现在是纯黑，可以跟首页那样渐变红就行」。
 *
 * 三条不能照抄的地方：
 *   ① 参考稿的三个依赖（Tailwind / framer-motion / lucide）官网**一个都没引** ——
 *      /faq 那次已定口径：不为一张页面引依赖进来跟全局 styles.css 打架。
 *      所以布局用 Grid、光晕用 @keyframes、↗ 用 ::after。
 *   ② 参考稿那一排是**社交账号**，我们一个都没有 —— 中途换成过四个真入口，
 *      用户看图后让**整排删掉**了。**别再放**：我们没那些账号，放假链接比不放更糟。
 *   ③ **首页原来把页脚排除了**（`loc.pathname !== '/'`），这一条正是用户要的。
 *
 * ⚠️ 真观感由 `.tmp/then-footer.mjs` 在真浏览器里核（首页 / 内页 / 390 窄屏），见第二十八轮交接 §六。
 * ⚠️ 这个守卫尽量用 includes 钉**字面子串**、少用正则，并且**判"某段代码在不在"之前先剥注释**
 *    （注释里常原样引用被删的代码，直接 includes 会永远命中 —— 这一轮 p130/p132 各踩过一次）。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const count = (haystack, needle) => haystack.split(needle).length - 1;
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const site = read('apps/website/src/main.jsx');
const css = read('apps/website/src/styles.css');
const pkg = read('package.json');   // 官网没有自己的 package.json（依赖声明在仓库根那份）

/* ── ① 首页要有页脚 ─────────────────────────────────────────────────── */
check('① 首页也有页脚了（原来那句把首页排除了 —— 用户报的正是这个）',
  site.includes('{!isFullPage && <Footer/>}') && !stripComments(site).includes("loc.pathname !== '/'"));

/* ── ② 四列真链接 + 品牌行只剩 logo 与版权 ──────────────────────────── */
const titles = ['产品', '合作', '了解更多', '条款与隐私'].filter((name) => site.includes(`<strong>${name}</strong>`));
check('② 四列链接（与参考稿的四列同构，内容仍是我们自己的）', titles.length === 4, JSON.stringify(titles));
// 注意：那句「面向教培机构与学校的…」在 **/org 页面文案**里也有一处（正常文案，不该删）——
// 所以这里只裁**页脚那一段**来判，别拿整个文件去 includes（那样会被别处的同款文案带偏）。
const footerJsx = site.slice(site.indexOf('function Footer('), site.indexOf('function Button('));
check('② 品牌行只剩「logo + 版权」—— 用户让把那一排图标与那句描述都删掉',
  footerJsx.includes('className="ft-brand"') && !footerJsx.includes('className="ft-actions"')
  && !footerJsx.includes('ft-brand__id') && !footerJsx.includes('面向教培机构与学校的'));

/* ── ③ 那一排图标按钮：删了，且不许再加回来 ────────────────────────── */
const code = stripComments(site);
check('③ 那一排图标按钮已经删干净（组件里不再有 ft-action / 图标表）',
  !code.includes('ft-action') && !code.includes('FOOTER_ICONS') && !code.includes('FOOTER_ACTIONS'));
check('③ **别再放社交图标**：页脚里不许出现 href="#" 这种假链接（我们一个社交账号都没有）',
  !code.includes('href="#"'));

/* ── ④ 动效纯 CSS（不引依赖）+ 底色是渐变红 ────────────────────────── */
check('④ 三团光晕 + @keyframes 复刻参考稿的漂移（**没有**引入 framer-motion）',
  count(css, '.site-footer .ft-glow--') >= 3 && css.includes('@keyframes ft-drift-a') && css.includes('@keyframes ft-pulse'));
check('④ reduced-motion 下不飘（站内其它动效同一条口径）',
  css.includes('@media(prefers-reduced-motion:reduce){.site-footer .ft-glow{animation:none}}'));
check('④ 链接悬停露出的 ↗ 是 ::after（不额外加 DOM）',
  css.includes('.site-footer .foot a:after{content:"↗"'));
check('④ 没有为一个页脚引依赖（参考稿那三个都没进 package.json）',
  !/framer-motion|tailwindcss|lucide-react/.test(pkg));
check('④ 底色是**渐变红**（用户：「页脚现在是纯黑，可以跟首页那样渐变红就行」）—— 不是一块纯黑',
  css.includes('background:radial-gradient(120% 80% at 50% 0%')
  && css.includes('linear-gradient(180deg,#17060a'));

/* ── ⑤ 页脚样式不许漏到别处 ─────────────────────────────────────────── */
check('⑤ 页脚样式一律带 `.site-footer` 前缀（这张表全站共用，漏出去会打到别人的页面上）',
  count(css, '.site-footer') >= 16, `带前缀的出现 ${count(css, '.site-footer')} 次`);

console.log('');
if (failures) { console.log(`✗ p132 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p132 页脚（含首页）：全部通过');
