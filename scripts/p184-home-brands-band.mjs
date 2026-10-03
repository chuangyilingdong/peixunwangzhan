/**
 * P184 官网首页「合作品牌」一屏（2026-10-03 用户口径）。
 *
 * 用户原话：「首页官网，在灵动AI，让每个少年都成为创造者**下方一屏插入**以下代码……
 * **这个是合作品牌的一屏，可以后台配置**」。参考稿是别家产品（ImgenAI）的社交证明一屏：
 * 暗底 + 左标题 + 右「大数字（滚动计数）+ 头像堆叠 + 4.8 评分」+ 底部品牌 logo 无缝走马灯。
 *
 * 钉六件事（与「三步一栏」p135 / 「对比一栏」p142 / 「视频屏」p147 同一套思路）：
 *   ① **两处同源**：官网兜底与后台表单预填（`packages/shared/src/siteDefaults.js` 的 HOME_BRANDS_DEFAULT）
 *      与种子默认（`websiteContentDefaults.HOME.brands`）**逐字段一致**；
 *   ② **默认是空的**：合作品牌与那些数字是**运营自己的事实**，平台不替它编（参考稿里 Spotify/Stripe 那些
 *      是别家的，照抄上线＝谎称合作方）——所以一条品牌都没有时官网**整屏不显示**；
 *      后台给「填入示例品牌」（HOME_BRANDS_SAMPLE）先看排版；
 *   ③ **位置**：在 `.hp-first`（第一屏 hero + 数据区）**外面**、`<HomeVideos>`（视频屏）**之前** ——
 *      加这一屏不许改变第一屏的取景（p135 钉着）；
 *   ④ **不引依赖 / 不引外域素材**：参考稿的 framer-motion / lucide / Tailwind / Google Fonts 都没进仓库，
 *      动效只用 CSS keyframes + IntersectionObserver；品牌 logo 走后台自己传（站内 file-asset）；
 *   ⑤ **走马灯无缝**：三段完全一样的品牌 + `translateX(-33.3333%)`（只有一两个品牌也不抽搐）；
 *      悬停暂停；数字从 0 滚上去，`prefers-reduced-motion` 的机器直接给终值；
 *   ⑥ **"后台可以配置"要能真跑通**：起真服务走一遍「改草稿 → 公开端仍是旧内容 → 发布 → 公开端读到新的品牌与数字」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p184-brands-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** 抠出锚点后面那个对象字面量（配平大括号）——两份默认值写法不同：shared 是 `HOME_BRANDS_DEFAULT = {…}`，
 *  种子那份嵌在 HOME 里是 `brands: {…}`，所以锚点各取各的、比里面的字段。 */
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
const squash = (value) => String(value || '').replace(/\s+/g, '');

const sharedSrc = read('packages/shared/src/siteDefaults.js');
const seedSrc = read('packages/database/src/websiteContentDefaults.js');
const site = read('apps/website/src/main.jsx');
const css = read('apps/website/src/styles.css');
const adminPage = read('apps/admin/src/pages/WebsiteContent.jsx');

console.log('① 两处同源（shared 的 HOME_BRANDS_DEFAULT 与种子里的 HOME.brands）');
const sharedBlock = objectAfter(sharedSrc, 'export const HOME_BRANDS_DEFAULT');
// ⚠️ 锚点里**不要带 `{`**：objectAfter 是从 `at + anchor.length` 往后找第一个 `{`，
//    带了大括号就会落到**里面**那个（第一次跑抓到的是 metric: {...}，于是"两份不一致"假红）。
const seedBlock = objectAfter(seedSrc, 'brands:');
check('① 两份默认值都在', Boolean(sharedBlock) && Boolean(seedBlock));
check('① 两份**逐字段一致**（只改一边 = 官网兜底与后台预填两套内容）',
  Boolean(sharedBlock) && squash(sharedBlock) === squash(seedBlock),
  `shared=${squash(sharedBlock).slice(0, 90)} / seed=${squash(seedBlock).slice(0, 90)}`);
check('① 默认是空的（title 空、logos 空 —— 合作品牌不许预置）',
  /title:\s*''/.test(sharedBlock || '') && /logos:\s*\[\]/.test(sharedBlock || ''));
check('① 有「示例品牌」那一组（后台点按钮先看排版），且它**不在**默认值里',
  /export const HOME_BRANDS_SAMPLE/.test(sharedSrc) && /示例品牌/.test(sharedSrc) && !/示例品牌/.test(sharedBlock || ''));

console.log('② 官网：组件、位置、空即隐藏、不引依赖');
check('② 组件在（HomeBrands + 数字滚动 hook）', /function HomeBrands\(\{ block \}\)/.test(site) && /function useHomeCountUp\(/.test(site));
check('② 位置：第一屏（hp-stats 那块）之后、视频屏之前',
  site.indexOf('<HomeBrands') > site.indexOf('className="hp-stats"') && site.indexOf('<HomeBrands') < site.indexOf('<HomeVideos'));
check('② 位置：`.hp-first` 外面（加它不许改变第一屏的取景）',
  site.indexOf('<HomeBrands') > site.indexOf('{ready && stats.length ? <section className="hp-stats"'));
check('② 空即隐藏：一条品牌都没有（且标题/数字/评分/头像都空）时 return null',
  /if \(!title && !metric && !rating && !avatars\.length && !logos\.length\) return null;/.test(site));
check('② 默认值接进首页（content.brands 缺省用 HOME_BRANDS_DEFAULT）',
  /content\.brands === undefined \|\| content\.brands === null \? HOME_BRANDS_DEFAULT : content\.brands/.test(site));
// ⚠️ 只看 import 段与组件体 —— **别整文件扫**：组件上方的注释里正解释着"不引 framer-motion / lucide"，
//    整文件扫会把说明文字当成违规（本仓库第四次踩这个坑：p173 两次、p77 一次）。
const siteImports = site.split('\n').filter((line) => line.trim().startsWith('import')).join('\n');
// 组件体 = HomeBrands + 紧跟其后的 useHomeCountUp（数字滚动就写在那个 hook 里）。
const brandBody = site.split('function HomeBrands')[1]?.split('function HomeVideos')[0] || '';
check('② 不引第三方依赖（import 段里没有 framer-motion / lucide-react）',
  !/framer-motion|lucide-react/.test(siteImports));
check('② 组件体里没有 Tailwind 的任意值类写法（参考稿那套 text-[28px] 没搬进来）',
  !/className="[^"]*\btext-\[/.test(brandBody) && !/className="[^"]*\bw-\[/.test(brandBody));
check('② 动效只用 CSS + IntersectionObserver + requestAnimationFrame（没有 motion./useInView 这类调用）',
  !/\bmotion\./.test(brandBody) && !/useInView\(/.test(brandBody)
  && /requestAnimationFrame/.test(brandBody) && /useRevealOnce\(\)/.test(brandBody));
check('② 品牌没有 logo 图时按**文字商标**渲染（先只填名字也能看到走马灯）',
  /hp-brands-wordmark/.test(site) && /hp-brands-wordmark/.test(css));
check('② 数字：滚进视野才滚、点一下再滚一次、reduced-motion 直接给终值',
  /useHomeCountUp\(metric \? metric\.value : 0, shown \? replay \+ 1 : 0\)/.test(site)
  && /prefers-reduced-motion: reduce/.test(site) && /prefers-reduced-motion:reduce/.test(css));
check('② 走马灯：三段完全一样 + translateX(-33.3333%) ⇒ 无缝；悬停暂停',
  /const track = \[\.\.\.set, \.\.\.set, \.\.\.set\];/.test(site)
  && /@keyframes hp-brands-marquee\{0%\{transform:translateX\(0\)\}100%\{transform:translateX\(-33\.3333%\)\}\}/.test(css)
  && /\.hp-brands-marquee:hover \.hp-brands-track/.test(css));
check('② 每段至少铺 7 条（只有一两个品牌时不会出现"一段比一屏还窄"的抽搐）',
  /Math\.max\(1, Math\.ceil\(7 \/ logos\.length\)\)/.test(site));
check('② 品牌图只允许后台传的地址（没有外域写死；站点 CSP 也是 self）',
  !/https?:\/\/(?!schema|www\.w3)/.test(site.split('function HomeBrands')[1]?.split('function useHomeCountUp')[0] || ''));

console.log('③ 后台：能配（面板 + 一键示例 + 预览）');
check('③ 面板在（标题 / 数字 / 评分 / 头像 / 品牌 logo 都在）',
  /合作品牌（首页第一屏下方/.test(adminPage)
  && /updateBrandMetric\(\{ value: event\.target\.value \}\)/.test(adminPage)
  && /updateBrandRating\(\{ score: event\.target\.value \}\)/.test(adminPage)
  && /addSectionList\('brands', 'avatars'/.test(adminPage)
  && /addSectionList\('brands', 'logos'/.test(adminPage));
check('③ 「填入示例品牌」按钮接的是 HOME_BRANDS_SAMPLE',
  /function fillBrandsSample\(\) \{ updateBrands\(JSON\.parse\(JSON\.stringify\(HOME_BRANDS_SAMPLE\)\)\); \}/.test(adminPage)
  && /onClick=\{fillBrandsSample\}/.test(adminPage));
check('③ logo 与头像都能上传（走平台文件资产口）+ 品牌可上下移、可删',
  /hp-brand-logo-\$\{index\}/.test(adminPage) && /uploadImage\(file, \(url2\) => updateSectionList\('brands', 'logos', index, \{ imageUrl: url2 \}\)/.test(adminPage)
  && /moveSectionList\('brands', 'logos', index, -1\)/.test(adminPage));
check('③ 空的时候后台**明说**官网上不显示这一屏（与视频屏同一条口径）',
  /这一屏现在是空的，<strong>官网上不会显示<\/strong>/.test(adminPage));
check('③ 草稿预览里也按"官网的真实结果"给（空 → 明说不显示）',
  /还是空的 —— 官网不显示这一屏/.test(adminPage));

console.log('④ CMS：真服务 / 真接口往返（改草稿 → 发布 → 公开端）');
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const port = 19184;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null; try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, payload };
};
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等起来 */ } await new Promise((r) => setTimeout(r, 100)); }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123', clientType: 'admin' } });
  const token = login.payload?.data?.token;
  assert.ok(token, '平台超管登录失败');
  const before = (await api('/api/public/website-content/HOME')).payload?.data;
  check('④ 新库种出来就带这一块（公开端读得到 brands）', Boolean(before?.content?.brands), JSON.stringify(before?.content?.brands || {}).slice(0, 80));

  const nextBrands = {
    title: 'P184 合作品牌标题',
    metric: { value: 73, suffix: 'M+', label: 'P184 数字说明' },
    rating: { score: '4.8', count: '(728k 条评价)', note: 'P184 评分说明' },
    avatars: ['/api/public/file-assets/file_p184a/download'],
    logos: [
      { name: 'P184 品牌一', imageUrl: '/api/public/file-assets/file_p184b/download', linkUrl: 'https://example.com/one' },
      { name: 'P184 品牌二', imageUrl: '', linkUrl: '' },
    ],
  };
  const content = { ...(before?.content || {}), brands: nextBrands };
  const saved = await api('/api/admin/website-content/HOME', { method: 'PUT', token, body: { content } });
  check('④ 保存草稿成功（品牌与数字一起写进去）', saved.status === 200, `HTTP ${saved.status} ${JSON.stringify(saved.payload).slice(0, 120)}`);
  const publicAfterDraft = (await api('/api/public/website-content/HOME')).payload?.data;
  check('④ 只存草稿时公开端**仍是旧内容**（草稿不影响线上）',
    JSON.stringify(publicAfterDraft?.content?.brands) !== JSON.stringify(nextBrands));
  const published = await api('/api/admin/website-content/HOME/publish', { method: 'POST', token, body: {} });
  check('④ 发布成功', published.status === 200, `HTTP ${published.status}`);
  const publicAfterPublish = (await api('/api/public/website-content/HOME')).payload?.data;
  const live = publicAfterPublish?.content?.brands;
  check('④ ★ 公开端读到标题 / 数字 / 评分', live?.title === nextBrands.title && Number(live?.metric?.value) === 73 && live?.rating?.score === '4.8', String(JSON.stringify(live)).slice(0, 140));
  check('④ ★ 公开端读到**两条品牌**（名称 / logo 图 / 跳转链接逐条落库）+ 一张头像',
    Array.isArray(live?.logos) && live.logos.length === 2
    && live.logos[0].imageUrl === nextBrands.logos[0].imageUrl && live.logos[0].linkUrl === 'https://example.com/one'
    && live.logos[1].name === 'P184 品牌二' && live.logos[1].imageUrl === ''
    && Array.isArray(live?.avatars) && live.avatars.length === 1,
    String(JSON.stringify(live?.logos || [])).slice(0, 200));
} finally {
  server.kill();
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 上库文件可能还被占着 */ }
}

if (failures) { console.log(`\nP184 有 ${failures} 项未通过`); if (serverLog) console.log(serverLog.slice(-1200)); process.exitCode = 1; }
else console.log('P184 首页「合作品牌」一屏：两处默认值一致且默认空、位置与动效口径对、后台可配（含一键示例）、改稿→发布→公开端生效 通过');
