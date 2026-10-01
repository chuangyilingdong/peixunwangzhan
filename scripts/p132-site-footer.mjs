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
import path from 'node:path';
import { stripComments } from './lib/sourceText.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const count = (haystack, needle) => haystack.split(needle).length - 1;

const site = read('apps/website/src/main.jsx');
const css = read('apps/website/src/styles.css');
const pkg = read('package.json');   // 官网没有自己的 package.json（依赖声明在仓库根那份）

/* ── ① 首页要有页脚 ─────────────────────────────────────────────────── */
check('① 首页也有页脚了（页脚由 !isFullPage 控制，不是「首页除外」）',
  site.includes('{!isFullPage && <Footer/>}'));
// ⚠️ 2026-09-28：这一条原来是"剥注释后的文本里不许出现 `loc.pathname !== '/'`" —— 那是**启发式**，
//    注释里提到它就够触发；而两个版本的剥器各有一个盲区（朴素的会被字符串里的 `/*`（`accept="image/*"`）
//    骗得吞掉几千字符；`lib/sourceText.mjs` 那个逐字符的不认识**正则字面量**、遇到带引号的正则就以为
//    进了字符串）。所以改成**直接钉真实条件**：页脚只由 `!isFullPage` 控制，而 `isFullPage`
//    只由画布路由决定 —— "把首页排除掉"这件事只可能以这两种形式回来，钉这两个比剥注释稳。
check('① 「首页除外」这件事回不来：isFullPage 只由 /learn/canvas 决定（没有 pathname 与 \'/\' 的比较）',
  /const isFullPage = loc\.pathname\.startsWith\('\/learn\/canvas'\)/.test(site));

/* ── ② 两列六个入口 + 品牌行只剩 logo 与版权 ──────────────────────────
   2026-09-25 用户口径：「条款与隐私下方那几项全部删除，其他的选型对比、机构方案、机构手册好多
   都是重复的，只需要留关键的 5-6 个入口」。所以从"四列同构"改成"两列、每组三条"，
   并把删掉的那几项钉死（免得过两天又被复制回来）。 */
// ⚠️ 2026-10-01 多语言：列头文案进了语言包（`footer.product` / `footer.usage`），源码里是 `t(key)` ——
//    所以这条从"找中文字面量"改成"找 key + 语言包里真有这两条"（文案不该再写死在页脚里）。
const titleKeys = ['footer.product', 'footer.usage'].filter((key) => site.includes(`t('${key}')`));
const localeHasTitles = ['zh-CN', 'zh-TW', 'en'].every((code) => {
  try {
    const table = JSON.parse(fs.readFileSync(path.join('apps', 'website', 'src', 'locales', `${code}.json`), 'utf8'));
    return Boolean(table['footer.product']) && Boolean(table['footer.usage']);
  } catch { return false; }
});
check('② 两列链接（footer.product / footer.usage），共 6 个入口', titleKeys.length === 2 && localeHasTitles,
  JSON.stringify({ titleKeys, localeHasTitles }));
// ⚠️ 先剥注释再判：页脚里刚加的那段注释**原样写着**被删掉的那几个路径（说明"页面还在、只是不列"），
//    不剥的话下面每一条"不再列 X"都会命中注释 —— 这个守卫的文件头就警告过这一脚。
const footerOnly = stripComments(site.slice(site.indexOf('function Footer('), site.indexOf('function Button(')));
const kept = ['/marketplace', '/org', '/works', '/download', '/faq'].filter((to) => footerOnly.includes(`to="${to}"`));
check('② 六个入口都在（灵动课程 / 机构方案 / 课堂作品 / 下载客户端 / 常见问题 / 机构后台）',
  kept.length === 5 && footerOnly.includes('href={ORG_APP_URL}'), JSON.stringify(kept));
for (const [to, label] of [['/compare', '选型对比'], ['/handbook', '机构手册'], ['/terms', '用户协议'], ['/privacy', '隐私政策'], ['/minors', '儿童 / 未成年人说明'], ['mailto:hello@aimagc.cn', '联系合作']]) {
  check(`② 页脚不再列「${label}」（页面本身还在，直达 URL 照样能开）`, !footerOnly.includes(to) && !footerOnly.includes(label));
}
check('② 品牌行那句「面向 8–16 岁 · 浏览器即用」已删（用户 2026-09-25）', !footerOnly.includes('浏览器即用'));
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

/* ── ⑥ 页脚最底部的两条**备案**（用户 2026-09-28 给的号码与链接）─────────────────
   这不是普通文案，是**监管要求对外展示**的信息：号码、链接、以及"在页脚最底部且居中"都得钉住。
   ⚠️ 号与链接**逐字**照用户给的抄（公安那条的 `code=` 查询参数弄丢就查不到备案）。
   ⚠️ 判之前先剥注释 —— 这个文件头就警告过：注释里常原样引用刚写进去的东西。 */
const ICP_NO = '鄂ICP备2025162545号-2';
const POLICE_NO = '鄂公网安备42011102006378号';
const POLICE_HREF = 'https://beian.mps.gov.cn/#/query/webSearch?code=42011102006378';
const footerCode = stripComments(footerJsx);
check('⑥ 域名备案（ICP）在页脚里，且是指向工信部查询站的链接',
  footerCode.includes('href="https://beian.miit.gov.cn/"') && footerCode.includes(`>${ICP_NO}</a>`));
check('⑥ 公安备案的文案与链接与用户给的逐字一致（含 code= 查询参数）',
  footerCode.includes(`href="${POLICE_HREF}"`) && footerCode.includes(`>${POLICE_NO}</a>`));
check('⑥ 两条外链都带 target="_blank" 与 rel="noreferrer"',
  count(footerCode, 'target="_blank" rel="noreferrer"') >= 2,
  `实际 ${count(footerCode, 'target="_blank" rel="noreferrer"')} 处`);
check('⑥ 备案行在**页脚最底部**（排在品牌行 .ft-brand 之后）',
  footerCode.indexOf('className="ft-filings"') > footerCode.indexOf('className="ft-brand"'));
check('⑥ 备案行是**居中**的（CSS 里 justify-content:center）',
  /\.site-footer \.ft-filings\{[^}]*justify-content:center/.test(css));
// ⚠️ 2026-09-28 口径变更：这一条原来断的是"备案行不许放图标"（那时没有徽标素材），
//    用户当天把**公安备案徽标**发过来了 → 现在反过来：公安那条**必须**带徽标，
//    而且必须是**本站静态资源**（站点 CSP 是 `default-src 'self'`，外链图片会被直接挡成空白；
//    这类图标也不该依赖第三方的可用性）。ICP 那条仍然**不配**图标（用户只给了公安的）。
const iconPath = 'apps/website/public/assets/beian-gongan.png';
const iconCode = /<img[^>]*className="ft-filings__icon"[^>]*src="\/assets\/[^"]+"/.test(footerCode);
check('⑥ 公安备案那条带徽标，且 src 是本站 /assets/ 下的资源', iconCode);
check('⑥ 徽标**不许**外链或内联（外链会被 CSP 挡成空白）',
  !/<img[^>]*ft-filings__icon[^>]*src="(https?:)?\/\//.test(footerCode) && !/ft-filings__icon[^>]*src="data:/.test(footerCode));
const icpHrefAt = footerCode.indexOf('href="https://beian.miit.gov.cn/"');
check('⑥ ICP 那条不配图标（用户只给了公安的徽标，别自己补一个）',
  icpHrefAt >= 0 && !footerCode.slice(icpHrefAt, footerCode.indexOf('</a>', icpHrefAt)).includes('<img'));
// 徽标文件要**真的在仓库里、真的是 PNG**（同 p160 那条口径：别让"路径写对了但文件是 HTML 兜底"蒙过去）
check(`⑥ 徽标文件在仓库里（${iconPath}）`, fs.existsSync(new URL(`../${iconPath}`, import.meta.url)));
const iconBytes = fs.readFileSync(new URL(`../${iconPath}`, import.meta.url));
check('⑥ 徽标是真 PNG（不是 HTML/空文件）',
  iconBytes.length > 200 && iconBytes.slice(1, 4).toString() === 'PNG',
  `前 8 字节 ${iconBytes.slice(0, 8).toString('hex')}，${iconBytes.length} 字节`);

console.log('');
if (failures) { console.log(`✗ p132 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p132 页脚（含首页）：全部通过');
