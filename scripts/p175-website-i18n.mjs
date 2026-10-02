/**
 * P175 官网多语言守卫（2026-10-01 用户口径：「i18n 吧，需要简体中文/繁体中文/英文」，默认中文）。
 *
 * 钉五件事：
 *   ① 三份语言包的 **key 集合必须一致**（缺一条就是"英文站上少一句话"，而且要等到人肉发现）；
 *   ② 导航/页脚那几个 key 在三种语言里**都不为空**、且互不相同（防止复制粘贴时漏改）；
 *   ③ 真浏览器：`/en` 与 `/zh-TW` 的导航/页脚/首页主标题**真的换成对应语言**，
 *      不带前缀仍是简体中文（**默认中文**这条口径）；
 *   ④ `<html lang>` 跟着语言走（zh-Hant / en），且 hreflang 三条互链都在；
 *   ⑤ 语言切换器**保持当前页**（在 `/works` 切到英文 → `/en/works`，不是回首页）。
 *
 * 跑法：node scripts/p175-website-i18n.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p175-i18n-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;

const PORT = 18975;
const WEB_PORT = 6177;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p175-secret',
  PORT: String(PORT),
};
const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...baseEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ───────── ①② 静态：三份语言包 ───────── */
const readLocale = (code) => JSON.parse(fs.readFileSync(path.join('apps', 'website', 'src', 'locales', `${code}.json`), 'utf8'));
const flatten = (value, prefix = '', out = {}) => {
  for (const [key, item] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object') flatten(item, next, out);
    else out[next] = item;
  }
  return out;
};
const LOCALE_CODES = ['zh-CN', 'zh-TW', 'en'];
const tables = Object.fromEntries(LOCALE_CODES.map((code) => [code, flatten(readLocale(code))]));
const baseKeys = Object.keys(tables['zh-CN']).sort();
for (const code of ['zh-TW', 'en']) {
  const keys = Object.keys(tables[code]).sort();
  const missing = baseKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !baseKeys.includes(key));
  check(`① ${code} 的 key 集合与 zh-CN 一致`, !missing.length && !extra.length,
    `缺 ${JSON.stringify(missing).slice(0, 120)} 多 ${JSON.stringify(extra).slice(0, 120)}`);
}
const UI_KEYS = ['nav.home', 'nav.marketplace', 'nav.works', 'nav.faq', 'nav.download', 'auth.org', 'auth.student', 'footer.product', 'footer.usage', 'footer.link.download'];
for (const key of UI_KEYS) {
  const values = LOCALE_CODES.map((code) => String(tables[code][key] || ''));
  // ⚠️ 只要求"都非空 + **英文与中文不同**"：简繁同形字很正常（使用 / 使用 / Getting started），
  //    硬要求三者互不相同会把「使用」这种词判红（本守卫第一版就这么错过一次）。
  check(`② ${key} 三种语言都非空、且英文确实是译文`, values.every(Boolean) && values[2] !== values[0], JSON.stringify(values));
}

/* ───────── ③④⑤ 真浏览器 ───────── */
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (x) => { serverLog += x; }); server.stderr.on('data', (x) => { serverLog += x; });
let web = null; let webLog = '';
try {
  await run(['packages/database/src/db.js', '--init']);
  await run(['packages/database/src/seed.js']);
  // ⭐ 2026-10-02：把夹具库的 HOME 改成**生产形状**（运营在 CMS 配好的那份：4 步带真图、
  //    视频区 2 条、对比栏新文案）。默认种子里是旧形状（3 步无图、视频无条目），那样
  //    第七组的"步骤真图/视频卡片/三语结构一致"根本无从断言 —— 这组要验的是
  //    「非中文跟着 CMS 结构走」（overlayCmsText），夹具就必须像运营真的配过的样子。
  //    图片地址用仓库自带的静态素材（打包产物里有），不需要真服务端文件。
  {
    const { aq } = await import('../packages/database/src/store.js');
    const fixtureHome = {
      heroKicker: '夹具 · 眉题', heroTitle: '培养青少年Ai思维', heroAccent: '掌握Ai时代的创造方式',
      heroDescription: 'AI 画布创作 + VibeCoding 对话编程，从兴趣到独立创作',
      trustTitle: '', trustDescription: '',
      stats: [
        { icon: '◆', value: '3', suffix: ' 门', label: '标准课包' },
        { icon: '◇', value: '48', suffix: ' 节', label: '课时总量' },
        { icon: '✧', value: 2, suffix: ' 类', label: '课堂形式' },
        { icon: '⌘', value: 1, suffix: ' 套', label: '机构工作台' },
      ],
      steps: {
        title: '三步，把 AI 创作课开进课堂', lead: '从开通机构到学生交出作品',
        items: [1, 2, 3, 4].map((n) => ({
          number: `0${n}.自研`, title: `步骤${n}标题`, desc: `第 ${n} 步的描述文字。`,
          imageUrl: `/assets/handbook/card-${n}.webp`, imageAlt: '',
        })),
      },
      compare: {
        title: '同样都是Ai课程', highlight: '为什么选择灵动ai课程', lead: '工具、环境、账号、作品都交给平台，老师只负责教。',
        cards: [
          { tone: 'without', title: '其他ai平台', items: ['条目一', '条目二', '条目三'] },
          { tone: 'with', title: '灵动ai平台', items: ['条目甲', '条目乙', '条目丙'] },
        ],
      },
      videos: {
        title: '视频区标题（夹具）', lead: '',
        items: [
          { tag: '', title: '宣传视频', desc: '自研系统演示', videoUrl: '/assets/hero-rabbit.mp4', posterUrl: '/assets/hero-rabbit-poster.webp' },
          { tag: '', title: '功能演示', desc: '三端完整流程', videoUrl: '/assets/hero-rabbit.mp4', posterUrl: '/assets/hero-rabbit-poster.webp' },
        ],
      },
    };
    const patch = JSON.stringify(fixtureHome);
    await aq("UPDATE website_contents SET draft_content=?, published_content=?, updated_at=? WHERE content_key='HOME'", [patch, patch, new Date().toISOString()]);
  }
  let apiUp = false;
  for (let i = 0; i < 120; i += 1) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { apiUp = true; break; } } catch { /* 等 */ } await sleep(150); }
  assert.ok(apiUp, `后端没起来：${serverLog.slice(-600)}`);
  await run(['node_modules/vite/bin/vite.js', 'build', 'apps/website', '--config', 'apps/website/vite.config.mjs']);
  web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', 'apps/website', '--config', 'apps/website/vite.config.mjs', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: root, env: { ...baseEnv, VITE_DEV_API_TARGET: `http://127.0.0.1:${PORT}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stdout.on('data', (x) => { webLog += x; }); web.stderr.on('data', (x) => { webLog += x; });
  const base = `http://localhost:${WEB_PORT}`;
  let up = false;
  for (let i = 0; i < 100; i += 1) { try { const res = await fetch(base); if (res.ok) { up = true; break; } } catch { /* 等 */ } await sleep(200); }
  assert.ok(up, `vite preview 没起来：${webLog.slice(-600)}`);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const snapshot = async () => page.evaluate(() => ({
    lang: document.documentElement.getAttribute('lang'),
    nav: Array.from(document.querySelectorAll('.site-topbar nav a')).map((a) => a.textContent.trim()),
    footerHead: Array.from(document.querySelectorAll('.site-footer .foot strong')).map((el) => el.textContent.trim()),
    hero: (document.querySelector('.hp-title')?.innerText || '').replace(/\n+/g, ' ').trim(),
    alternates: Array.from(document.querySelectorAll('link[data-i18n-alt]')).map((l) => l.getAttribute('hreflang')),
    switcher: document.querySelectorAll('.lang-pick').length,
    // 第六组（第二波）：作品广场的筛选胶囊 / 搜索框 / 顶栏那颗切换器
    worksAll: (document.querySelector('.pl-types .pl-type')?.textContent || '').replace(/\d+$/, '').trim(),
    worksSearch: document.querySelector('#works-search')?.getAttribute('placeholder') || '',
  }));

  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const zh = await snapshot();
  check('③ 不带前缀 = 简体中文（默认口径）', zh.nav[0] === '首页' && zh.footerHead[0] === '产品', JSON.stringify(zh.nav.slice(0, 3)));
  check('③ 中文也在 hreflang 里（三条互链）', ['zh-Hans', 'zh-Hant', 'en'].every((tag) => zh.alternates.includes(tag)), JSON.stringify(zh.alternates));
  check('⑤ 顶栏有语言切换器', zh.switcher >= 1, String(zh.switcher));

  await page.goto(base + '/en/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const en = await snapshot();
  check('③ /en 的导航是英文', en.nav[0] === 'Home' && en.nav.includes('Courses'), JSON.stringify(en.nav.slice(0, 3)));
  check('③ /en 的页脚列头是英文', en.footerHead[0] === 'Product', JSON.stringify(en.footerHead));
  check('④ /en 的 <html lang> = en', en.lang === 'en', String(en.lang));

  await page.goto(base + '/zh-TW/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const tw = await snapshot();
  check('③ /zh-TW 的导航是繁體', tw.nav[0] === '首頁' && tw.nav.includes('靈動課程'), JSON.stringify(tw.nav.slice(0, 3)));
  check('④ /zh-TW 的 <html lang> = zh-Hant（繁体用 Hant，搜索引擎认这个）', tw.lang === 'zh-Hant', String(tw.lang));

  // ⑤ 切换器保持当前页：在 /works 切到英文 → /en/works
  await page.goto(base + '/works', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const before = page.url();
  await page.locator('.lang-pick__btn').first().click();
  await page.waitForTimeout(300);
  await page.getByRole('option', { name: 'English' }).click();
  await page.waitForTimeout(2500);
  const after = page.url();
  check('⑤ 在 /works 切到英文 → /en/works（保持当前页，不回首页）',
    new URL(after).pathname === '/en/works' && new URL(before).pathname === '/works', `${before} → ${after}`);
  const enWorks = await snapshot();
  check('⑤ 切过去之后导航仍是英文（前缀被路由器接住了）', enWorks.nav[0] === 'Home', JSON.stringify(enWorks.nav.slice(0, 2)));
  check('⑥ /en/works 的类型胶囊与搜索框是英文',
    enWorks.worksAll === 'All' && /Search/.test(enWorks.worksSearch),
    JSON.stringify([enWorks.worksAll, enWorks.worksSearch]));

  /* ───────── 第六组（2026-10-01 第二波）：浏览器标签、其余页面、切换器位置 ─────────
     ⚠️ 这一组是把用户报的 bug 直接转成断言（图3：标签上显示的是 `cms.home.heroTitle` 这个 **key**）。 */
  const pageSnapshot = async (path) => {
    await page.goto(base + path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    return page.evaluate(() => ({
      title: document.title,
      // ⚠️ 手册的 hero 是**逐字动画**：它把词间空格换成了 `&nbsp;`（U+00A0，防换行）——
      //    断言前统一归一化，否则"看得见的那句话"在 DOM 里其实匹配不上。
      text: document.body.innerText.replace(/\u00a0/g, ' ').replace(/\n+/g, ' | ').slice(0, 1500),
      pickBtn: (document.querySelector('.head-actions .lang-pick__btn')?.textContent || '').trim(),
    }));
  };
  const enFaq = await pageSnapshot('/en/faq');
  check('⑥ /en/faq 的标签是英文标题（既不是 key 也不是中文）',
    enFaq.title.startsWith('FAQ') && !enFaq.title.includes('cms.'), enFaq.title);
  check('⑥ /en/faq 的档位与问答是英文',
    /Organizations/.test(enFaq.text) && /API key/.test(enFaq.text), enFaq.text.slice(0, 160));
  check('⑥ 顶栏切换器写着**当前语言的全称**、且落在右上角按钮组里',
    enFaq.pickBtn === 'English', JSON.stringify(enFaq.pickBtn));

  const twHandbook = await pageSnapshot('/zh-TW/handbook');
  // ⚠️ 只做**正向**断言：手册的「政策」那一栏是各地政府文件的原题（本来就是中文，不该翻），
  //    所以"整页不含简体字"这种负向断言在这页上永远不成立。
  check('⑥ /zh-TW/handbook 的正文是繁體',
    /讓 AI 創作課/.test(twHandbook.text) && /從試點走向普及/.test(twHandbook.text), twHandbook.text.slice(0, 160));
  check('⑥ /zh-TW 的标签是繁體标题（不是 key）',
    twHandbook.title.includes('機構手冊') && !twHandbook.title.includes('cms.'), twHandbook.title);

  const enDownload = await pageSnapshot('/en/download');
  check('⑥ /en/download 两张安装卡片是英文',
    /Windows/.test(enDownload.text) && /Mac \(Apple silicon\)/.test(enDownload.text), enDownload.text.slice(0, 160));

  const enHome = await pageSnapshot('/en/');
  // 品牌名（灵动ai学院）是专有名词，**不翻**——所以这里只要求"是英文主标题 + 不含 key"。
  check('⑥ /en 首页的标签是英文主标题（图3 那个 bug 的口径）',
    !enHome.title.includes('cms.') && /Cultivate AI thinking/.test(enHome.title), enHome.title);

  /* ── 第七组（2026-10-02）：非中文首页必须**跟着 CMS 的结构走**（用户报「其他语言这些页面
     跟中文显示不一样」）——根因是"整块读语言包"把 CMS 的结构字段丢了（步骤图/视频条目）。
     修法是"CMS 当底 + 语言包盖文字"（overlayCmsText）；这里钉住三件肉眼看得见的事：
     步骤卡要有**真图**（不是占位条）、视频区要有**卡片**、步骤条数与中文一致。 */
  const homeStructure = async (path) => {
    await page.goto(base + path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    // 对比栏标题是**打字机**（进视口才逐字亮，55ms/字）——滚过去等它打完再量，
    // 否则 innerText 里 opacity:0 的字不算数，断言会量到半句话（⑧ 那个 bug 就是这么被量出来的）。
    await page.evaluate(() => document.querySelector('.hp-cmp')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(4500);
    return page.evaluate(() => ({
      steps: document.querySelectorAll('.hp-step').length,
      stepImages: document.querySelectorAll('.hp-step-art img').length,
      stepPlaceholders: document.querySelectorAll('.hp-step-art.is-placeholder').length,
      videoCards: document.querySelectorAll('.hp-vid-card').length,
      compareCards: document.querySelectorAll('.hp-cmp-card').length,
      compareTitle: (document.querySelector('.hp-cmp-title')?.innerText || '').replace(/\s+/g, ' ').trim(),
    }));
  };
  const enHomeStruct = await homeStructure('/en/');
  // ⚠️ 这里**不能**用 '/' 当"中文页"：第 ⑤ 组测过"切英文"之后本机记住了 en，
  //    首页那条「本机记忆纠正一次」的规则会把 '/' 重定向到 /en/（量到的还是英文页）。
  //    显式带前缀的 /zh-TW/ 没有歧义 —— URL 前缀优先于本机记忆。
  const zhHomeStruct = await homeStructure('/zh-TW/');
  check('⑦ /en 步骤卡带**真图**（不是占位条 —— 运营在 CMS 配的图必须三语都显示）',
    enHomeStruct.stepImages >= enHomeStruct.steps && enHomeStruct.steps >= 1 && enHomeStruct.stepPlaceholders === 0,
    JSON.stringify(enHomeStruct));
  check('⑦ /en 视频区有卡片（此前语言包丢了 videos.items，整段是空的）',
    enHomeStruct.videoCards >= 1, JSON.stringify(enHomeStruct));
  check('⑦ 非中文与中文的首页结构一致（步骤/视频/对比条数）',
    enHomeStruct.steps === zhHomeStruct.steps && enHomeStruct.videoCards === zhHomeStruct.videoCards
      && enHomeStruct.compareCards === zhHomeStruct.compareCards,
    `en=${JSON.stringify(enHomeStruct)} zh=${JSON.stringify(zhHomeStruct)}`);
  // ⑧ 对比栏标题的**两段都在**：英文标题以句号结尾 + 高亮以字母开头时，分词器会把
  //   "similar.why" 合成一个跨边界单元、被正文段和高亮段的 range 过滤同时丢掉（线上实测丢字）。
  //   修法是拉丁句读结尾时补一个空格再接高亮；这里钉住「标题前段 + 高亮段」都出现在最终文本里。
  check('⑧ /en 对比栏标题正文段与高亮段都渲染（跨边界词单元不再丢字）',
    /similar\.? ?$/.test(enHomeStruct.compareTitle.split('why choose')[0].trim() + '') || /similar/.test(enHomeStruct.compareTitle),
    JSON.stringify(enHomeStruct.compareTitle));
  check('⑧ /en 对比栏高亮段完整（why choose Lingdong AI 三个词都在）',
    enHomeStruct.compareTitle.includes('why choose Lingdong AI'), JSON.stringify(enHomeStruct.compareTitle));
  check('⑧ /zh-TW 对比栏两段同样齐全（语言包的繁體文案盖在 CMS 结构上）',
    zhHomeStruct.compareTitle.includes('同樣都是 AI 課程') && zhHomeStruct.compareTitle.includes('為什麼選擇靈動 AI 課程'),
    JSON.stringify(zhHomeStruct.compareTitle));

  await browser.close();
} finally {
  server.kill();
  if (web) web.kill();
}

assert.equal(failures, 0, `P175 有 ${failures} 条断言没过`);
console.log('PASS: 官网三语言（简/繁/英）切换、默认中文、lang 与 hreflang、切换保持当前页');
