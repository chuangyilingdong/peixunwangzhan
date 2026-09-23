/**
 * P132 页脚按参考稿重做 + **首页也要有页脚**（用户 2026-09-23）。
 *
 * 用户原话：「页脚根据这个来改造下，官网下方也要有页脚」，并给了参考稿 Footer03Luma
 * （Tailwind + framer-motion + lucide 的一套深色页脚：四列链接 + 三团漂移光晕 + 品牌行 + 社交图标）。
 *
 * 三条不能照抄的地方，逐条钉住：
 *   ① 参考稿的三个依赖（Tailwind / framer-motion / lucide）官网**一个都没引** ——
 *      /faq 那次已经定过口径：不为一张页面引依赖进来跟全局 styles.css 打架。
 *      所以布局用 Grid、光晕用 @keyframes、图标内联 svg（css.gg，MIT，与首页数据区那四个同源）。
 *   ② 参考稿那一排是**社交账号**，我们一个都没有 —— **不放假链接**（既有口径：点了没用的比不放更糟），
 *      换成四个真能点的入口（邮箱 / 联系我们 / 下载客户端 / 机构后台）。
 *   ③ **首页原来把页脚排除了**（`loc.pathname !== '/'`），这一条正是用户要的。
 *
 * ⚠️ 真观感由 `.tmp/then-footer.mjs` 在真浏览器里核（首页 / 内页 / 390 窄屏三档），见第二十八轮交接 §六。
 * ⚠️ 这个守卫尽量用 includes 钉**字面子串**、少用正则：写正则时转义一层写错就变成"提前闭合/匹配不上"，
 *    而后者会安安静静地给出假红或假绿（这一轮在 p131/p132 上各踩过一次）。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const count = (haystack, needle) => haystack.split(needle).length - 1;
// note: assert-before-comment-strip — check the CODE, not the comment.
// The comment above that removed line quotes the old code verbatim, so a plain includes()
// would always hit it (same trap as p130). Strip comments first.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const site = read('apps/website/src/main.jsx');
const css = read('apps/website/src/styles.css');
// ⚠️ 官网没有自己的 package.json（依赖声明在**仓库根**那份）—— 读它才看得到 ogl 之类
const pkg = read('package.json');

/* ── ① 首页要有页脚 ─────────────────────────────────────────────────── */
check('① 首页也有页脚了（原来那句 `loc.pathname !== \'/\'` 把首页排除了 —— 用户报的正是这个）',
  site.includes('{!isFullPage && <Footer/>}') && !stripComments(site).includes("loc.pathname !== '/'"));

/* ── ② 四列真链接 ───────────────────────────────────────────────────── */
const titles = ['产品', '合作', '了解更多', '条款与隐私'].filter((name) => site.includes(`<strong>${name}</strong>`));
check('② 四列链接（与参考稿的四列同构，内容仍是我们自己的）', titles.length === 4, JSON.stringify(titles));
check('② 老页脚那两个类没人用了（新页脚换成 .ft-*）',
  !site.includes('className="copyright"') && site.includes('className="ft-brand"'));

/* ── ③ 不放假链接 ───────────────────────────────────────────────────── */
check('③ 那一排图标按钮**全指向真地址**（参考稿是 href="#" 的社交链接，我们不放假的）',
  !site.includes('href="#"') && site.includes('mailto:hello@aimagc.cn') && site.includes('to="/download"'));
check('③ 图标是内联 svg（css.gg，MIT）—— 出处与许可写在注释里，换图标时一起换',
  site.includes('const FOOTER_ICONS = {') && site.includes('css.gg') && site.includes('MIT')
  && site.includes('<svg viewBox="0 0 24 24"'));

/* ── ④ 动效纯 CSS（不引依赖）────────────────────────────────────────── */
check('④ 三团光晕 + @keyframes 复刻参考稿的漂移（**没有**引入 framer-motion）',
  count(css, '.site-footer .ft-glow--') >= 3 && css.includes('@keyframes ft-drift-a') && css.includes('@keyframes ft-pulse'));
check('④ reduced-motion 下不飘（站内其它动效同一条口径）',
  css.includes('@media(prefers-reduced-motion:reduce){.site-footer .ft-glow{animation:none}}'));
check('④ 链接悬停露出的 ↗ 是 ::after（不额外加 DOM）',
  css.includes('.site-footer .foot a:after{content:"↗"'));
check('④ 没有为一个页脚引依赖（参考稿那三个都没进 package.json）',
  !/framer-motion|tailwindcss|lucide-react/.test(pkg));

/* ── ⑤ 页脚样式不许漏到别处 ─────────────────────────────────────────── */
check('⑤ 页脚样式一律带 `.site-footer` 前缀（这张表全站共用，漏出去会打到别人的页面上）',
  count(css, '.site-footer') >= 20, `带前缀的出现 ${count(css, '.site-footer')} 次`);
check('⑤ 新页脚是深色的（全局 `footer{}` 那条浅底规则被它盖过）',
  css.includes('footer.site-footer{') && css.includes('background:#0b0a0e'));

console.log('');
if (failures) { console.log(`✗ p132 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p132 页脚（含首页）：全部通过');
