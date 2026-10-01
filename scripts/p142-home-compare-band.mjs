/**
 * P142 官网首页「对比一栏」（2026-09-25 用户口径）。
 *
 * 用户原话：「参考以下代码，在官网首页页脚上面加一个以上代码的页面，后台可以配置」，
 * 参考稿是 Codecraft AI 的对比区（暗底 + **打字标题** + 高亮词 + 一正一反两张卡片 + 条目逐条淡入）。
 *
 * 这个守卫钉五件事（与「三步一栏」那条 p135 同一套思路，因为那是同一种需求）：
 *   ① **两处同源**：官网兜底 / 后台表单预填（`packages/shared/src/siteDefaults.js` 的 HOME_COMPARE_DEFAULT）
 *      与种子默认（`websiteContentDefaults.HOME.compare`）**逐字段一致** ——
 *      两份不一致 = 同一页会因为「接口通 / 断」「库里有 / 没这一块」显示两套文案（口径①）；
 *   ② **不引依赖**：参考稿那三个（Tailwind / framer-motion / lucide）与 Google Fonts 都没进仓库
 *      （为一个区块引依赖会跟全站共用的一份 styles.css 打架，/faq 与页脚那两轮定过口径）；
 *   ③ **底色接得上**：这一栏的首色 = 三步一栏的末色、末色 = 页脚的首色
 *      （p135 那条踩过：两段红之间会留一条深色缝）；
 *   ④ **动效不能把内容藏起来**：卡片默认可见，`is-in` 只负责播一次入场；
 *      打字只是"滚到才开始打"，观察器不可用 / reduced-motion 时**直接给完整标题**；
 *   ⑤ **"后台可以配置"要能真跑通**：起真服务走一遍「改草稿 → 公开端仍是旧内容 → 发布 → 公开端读到新文案」。
 *      卡片也要验（用户要的就是"整块文案能配"，不是只有大标题能配）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p142-compare-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** 把锚点后面那个对象字面量抠出来（配平大括号）——两份默认值的写法不同：
 *  shared 那份整个对象就是这一栏（`HOME_COMPARE_DEFAULT = {...}`），
 *  seed 那份是嵌在 HOME 里的（`compare: {...}`），所以锚点各取各的、比里面的字段。 */
function objectAfter(text, anchor) {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const start = text.indexOf('{', at + anchor.length);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

console.log('① 两处同源（shared 的 HOME_COMPARE_DEFAULT 与种子里的 HOME.compare）');
const sharedSrc = read('packages/shared/src/siteDefaults.js');
const seedSrc = read('packages/database/src/websiteContentDefaults.js');
const sharedLiteral = objectAfter(sharedSrc, 'HOME_COMPARE_DEFAULT =');
const seedLiteral = objectAfter(seedSrc, 'compare:');
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
check('① 两份默认值逐字一致（去空白后比较整块）',
  Boolean(sharedLiteral) && Boolean(seedLiteral) && normalize(sharedLiteral) === normalize(seedLiteral),
  `shared=${String(sharedLiteral).slice(0, 60)}… seed=${String(seedLiteral).slice(0, 60)}…`);
check('① 两份都带 title / highlight / lead / cards 四个字段',
  ['title', 'highlight', 'lead', 'cards'].every((key) => sharedSrc.includes(`${key}:`) && seedSrc.includes(`${key}:`)));

console.log('② 不引依赖（参考稿那三个 + 字体外链都不许进仓库）');
const site = read('apps/website/src/main.jsx');
const css = read('apps/website/src/styles.css');
const admin = read('apps/admin/src/pages/WebsiteContent.jsx');
const pkg = read('package.json');
// ⚠️ 只判**代码行**：这些名字在注释里出现是**好事**（"参考稿那三个依赖官网一个都没引"就是注释里写的），
//    拿整份文件去正则会把那些说明也判成违规（p108 那条守卫踩过同一个坑）。
const siteCode = site.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
check('② 没有 framer-motion / lucide / tailwind（代码行与依赖清单都没有）',
  !/framer-motion|framer_motion/.test(siteCode) && !/lucide/.test(siteCode) && !/framer-motion|lucide-react|tailwind/i.test(pkg),
  `代码行命中=${(siteCode.match(/framer-motion|lucide|tailwind/gi) || []).join(',') || '无'}；package.json 命中=${(pkg.match(/framer-motion|lucide-react|tailwind/gi) || []).join(',') || '无'}`);
check('② 没有 Google Fonts / 外域素材（参考稿那段 <link> 与外链 SVG 都没抄进来）',
  !/fonts\.googleapis|fonts\.gstatic/.test(siteCode) && !/r2\.motionsites\.dev/.test(siteCode),
  `代码行命中=${(siteCode.match(/fonts\.googleapis|fonts\.gstatic|r2\.motionsites\.dev/gi) || []).join(',') || '无'}`);
check('② 图标用的是站内那套：正面 <Icon name="spark">，负面是内联 SVG（不引图标库）',
  /<Icon name="spark"/.test(site) && /<svg viewBox="0 0 24 24"[\s\S]{0,200}circle cx="12" cy="12" r="9"/.test(site));

console.log('③ 底色接得上（三步一栏 → 这一栏 → 页脚）');
const ruleOf = (selector) => (css.match(new RegExp(`\\${selector}\\{[^}]*\\}`)) || [])[0] || '';
const stopsOf = (rule) => [...String(rule).matchAll(/#([0-9a-f]{3,8})\s+(\d+)%/gi)].map((match) => `#${match[1].toLowerCase()}`);
const cmpRule = ruleOf('.hp-cmp');
const stepsRule = ruleOf('.hp-steps');
const footerRule = (css.match(/footer\.site-footer\{[^}]*\}/) || [])[0] || '';
const cmpStops = stopsOf(cmpRule); const stepsStops = stopsOf(stepsRule); const footerStops = stopsOf(footerRule);
check('③ 这一栏底色是**渐变**（不是一块纯黑/纯灰 —— 夹在红首屏与红页脚之间会成断层）',
  /linear-gradient\(180deg/.test(cmpRule) && cmpStops.length >= 3, cmpRule.slice(0, 120));
check('③ 首色 = 三步一栏的末色（上行接得住）',
  cmpStops[0] === stepsStops[stepsStops.length - 1], `栏首色=${cmpStops[0]} 三步末色=${stepsStops[stepsStops.length - 1]}`);
check('③ 末色 = 页脚的首色（下行接得住，不许留深色缝）',
  cmpStops[cmpStops.length - 1] === footerStops[0], `栏末色=${cmpStops[cmpStops.length - 1]} 页脚首色=${footerStops[0]}`);
// 「它是页面最后一段」改成**数版块**（比"到 </main> 不超过 200 字"稳：中间可以有注释）。
// 2026-09-28：中间曾短暂加过一栏「扫码访问」二维码（用户当天就撤了），现在只允许有它自己。
{
  const afterCompare = site.slice(site.indexOf('<HomeCompare'));
  const sectionsAfter = [...afterCompare.matchAll(/<Home(Steps|Compare|Videos|Qr)\b/g)].map((match) => match[1]);
  check('③ 这一栏排在「三步一栏」之后、页脚之前（= 页面最后一段）',
    site.indexOf('<HomeCompare') > site.indexOf('<HomeSteps')
    && sectionsAfter.length === 1 && sectionsAfter[0] === 'Compare',
    `它之后出现的版块：${sectionsAfter.join(' → ') || '（无）'}`);
}
check('③ 它在 `.hp-first` 外面（加它不许改变第一屏含背景视频的取景）', site.indexOf('<HomeCompare') > site.indexOf('</div>\n    {/* 三步一栏'), '检查 HomeCompare 与 .hp-first 的先后');

console.log('④ 动效不能把内容藏起来');
check('④ 卡片默认可见 —— 样式里 `.hp-cmp-card` 本身没有 opacity:0',
  !/\.hp-cmp-card\{[^}]*opacity:0/.test(css) && !/\.hp-cmp\{[^}]*opacity:0/.test(css));
check('④ 入场动画挂在 `.hp-cmp.is-in` 上（观察器触发一次）',
  /\.hp-cmp\.is-in \.hp-cmp-card\{animation:hp-cmp-in/.test(css) && /\.hp-cmp\.is-in \.hp-cmp-item\{animation:hp-cmp-in/.test(css));
check('④ reduced-motion 下不播任何动画',
  /@media\(prefers-reduced-motion:reduce\)\{\.hp-cmp\.is-in \.hp-cmp-card,\.hp-cmp\.is-in \.hp-cmp-item\{animation:none\}/.test(css.replace(/\s*\n\s*/g, '')));
// ⚠️ 2026-10-01：HomeCompare 里多了一行 `const t = useT();`（多语言），所以这里**不锚在第一行**，
//    只要求"这个组件里确实用了 useRevealOnce"（这才是"复用三步一栏那套"的意思）。
check('④ 观察器不可用时内容照常显示（直接算已进入 —— 复用三步一栏那个 useRevealOnce）',
  /function HomeCompare\(\{ block \}\) \{[\s\S]{0,200}?const \[ref, shown\] = useRevealOnce\(\)/.test(site));
check('④ ★ 打字只是"到了才开始打"：观察器不可用 / reduced-motion 时**直接给完整标题**（不许停在 0 字）',
  /if \(!active \|\| reduced\) \{ setCount\(active \? full : 0\); return undefined; \}/.test(site));
check('④ 逐字显示不重排：每个单元是 opacity 过渡（不是"一个字一个字往 DOM 里塞"）',
  /\.hp-cmp-unit\{display:inline;transition:opacity/.test(css) && /\{ value, start: match\.index, end: match\.index \+ value\.length \}/.test(site));
check('④ 高亮段是**整段**包裹（下划线才盖得住整段，不是只盖一个字）',
  /<span className="hp-cmp-hl">[\s\S]{0,200}renderUnits\(hlFrom, hlTo\)/.test(site) && /\.hp-cmp-swash\{position:absolute/.test(css));
// ⚠️ 2026-09-25 口径变更（不是测试漂移）：用户把标题改短、高亮词留在原处，结果高亮词**整段不显示**了。
//    现在三种情形都有明确行为：① 高亮词在标题里 → 高亮那一段；② **不在标题里 → 当作后半段追加**
//    （标题以标点结尾就不补逗号）；③ 留空 → 整句高亮。缺一种运营就会看到"字不见了"。
check('④ 高亮词不在标题里时当作**后半段追加**（用户 2026-09-25 报的就是这条）',
  /return \{ before: title \+ \(PUNCT_END\.test\(title\) \? '' : '，'\), mid: highlight, after: '' \};/.test(site));
check('④ 标题以标点结尾不补逗号 / 高亮留空则整句高亮',
  /const PUNCT_END = \/\[/.test(site) && /if \(!highlight\) return \{ before: '', mid: title, after: '' \};/.test(site));

console.log('⑤ CMS：后台能配（真服务 / 真接口往返）');
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const port = 19142;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null };
}
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }
  const rootToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data?.token;
  assert.ok(rootToken, '平台管理员登录失败');

  const seeded = (await api('/api/public/website-content/HOME')).data?.content;
  check('⑤ 新库种出来就带这一栏（公开端读得到 compare）', Boolean(seeded?.compare?.title), JSON.stringify(seeded?.compare)?.slice(0, 160));
  check('⑤ 种子里就是一正一反两张卡（tone=without / with），条目都非空',
    (seeded?.compare?.cards || []).map((card) => card.tone).join(',') === 'without,with'
    && (seeded?.compare?.cards || []).every((card) => Array.isArray(card.items) && card.items.length >= 3),
    JSON.stringify((seeded?.compare?.cards || []).map((card) => `${card.tone}:${(card.items || []).length}`)));

  const MARK_TITLE = 'P142 两种上法（新标题）';
  const MARK_ITEM = 'P142 卡片里新加的一条';
  const MARK_LEAD = 'P142 副标题也换了';
  const draft = await api('/api/admin/website-content/HOME', {
    method: 'PUT', token: rootToken,
    body: {
      content: {
        ...seeded,
        heroTitle: seeded?.heroTitle || '',
        compare: {
          title: MARK_TITLE,
          highlight: '两种上法',
          lead: MARK_LEAD,
          cards: [
            { tone: 'without', title: '旧做法', items: ['老办法第一条', MARK_ITEM] },
            { tone: 'with', title: '新做法', items: ['新办法第一条'] },
          ],
        },
      },
    },
  });
  check('⑤ 平台端能保存草稿（compare 整块写进草稿）', draft.status === 200, `HTTP ${draft.status} ${JSON.stringify(draft.error).slice(0, 200)}`);

  const beforePublish = (await api('/api/public/website-content/HOME')).data?.content;
  check('⑤ 发布前公开端**还是旧内容**（草稿不外泄）',
    beforePublish?.compare?.title !== MARK_TITLE, String(beforePublish?.compare?.title));

  const published = await api('/api/admin/website-content/HOME/publish', { method: 'POST', token: rootToken, body: {} });
  check('⑤ 能发布', published.status === 200, `HTTP ${published.status} ${JSON.stringify(published.error).slice(0, 200)}`);

  const after = (await api('/api/public/website-content/HOME')).data?.content;
  check('⑤ ★ 发布后公开端读到**新标题**（后台改这一栏对官网生效）', after?.compare?.title === MARK_TITLE, String(after?.compare?.title));
  check('⑤ ★ 卡片与条目也一起生效（不是只有大标题能配）',
    after?.compare?.cards?.[0]?.title === '旧做法' && (after?.compare?.cards?.[0]?.items || []).includes(MARK_ITEM) && after?.compare?.lead === MARK_LEAD,
    JSON.stringify(after?.compare?.cards?.[0] || {}).slice(0, 160));

  // 整块删空 = 官网不显示这一栏（官网那一侧的判据：cards 为空就 return null）
  const cleared = await api('/api/admin/website-content/HOME', { method: 'PUT', token: rootToken, body: { content: { ...after, compare: { ...after.compare, cards: [] } } } });
  await api('/api/admin/website-content/HOME/publish', { method: 'POST', token: rootToken, body: {} });
  const emptied = (await api('/api/public/website-content/HOME')).data?.content;
  check('⑤ 把 cards 删空是有效操作（官网据此整栏不显示，与 stats/steps 同一条口径）',
    cleared.status === 200 && Array.isArray(emptied?.compare?.cards) && emptied.compare.cards.length === 0,
    JSON.stringify(emptied?.compare || {}).slice(0, 120));
  // ⚠️ 不卡"两个语句相邻"的窗口：打字机的 hook 必须在提前 return **之前**调用（React 的 hooks 规则，
  //    p34 钉着这条），所以 `if (!cards.length) return null;` 与 `const cards = …` 之间隔着一段代码。
  check('⑤ 官网那侧确实按 cards 判空（空数组 → 整栏不渲染）',
    /const cards = Array\.isArray\(block\?\.cards\)/.test(site) && /if \(!cards\.length\) return null;/.test(site));
} finally {
  server.kill();
}

if (failures) {
  console.error(JSON.stringify({ name: 'p142-home-compare-band', pass: false, failed: failures, serverLog: serverLog.slice(-600) }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p142-home-compare-band', pass: true, checks: 22 }));
