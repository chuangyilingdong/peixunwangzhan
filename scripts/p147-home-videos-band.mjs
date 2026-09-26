/**
 * P147 官网首页第二屏「视频展示」（2026-09-26 用户口径）。
 *
 * 用户原话：「现在要做个官网的第二屏，放在第一屏下方，后台可配置视频，我要上传多个视频来展示，
 * 文案也要可配置。」参考稿是一个卡片横向轮播（大标题 + 激活卡放大 + 左右箭头 + 圆点）。
 *
 * 钉六件事（与「三步一栏」p135、「对比一栏」p142 同一套思路 —— 同一种需求）：
 *   ① **两处同源**：官网兜底 / 后台表单预填（`packages/shared/src/siteDefaults.js` 的 HOME_VIDEOS_DEFAULT）
 *      与种子默认（`websiteContentDefaults.HOME.videos`）**逐字段一致**；
 *   ② **不引依赖 / 不引外域素材**：参考稿那三个依赖与 Google Fonts 都没进仓库；
 *      视频与封面一律走**自家的 file-asset 公开口**（不许写死外站地址，也不许把视频塞进 CMS JSON）；
 *   ③ **位置**：在第一屏 `.hp-first` **外面**、三步一栏**之前**（"第二屏"就是第一屏下面那一段）；
 *      底色接得上（这一栏末色 = 三步一栏首色，否则两段红之间会留一条深色缝 —— p135 踩过）；
 *   ④ ⭐ **性能**（这台机公网出口只有 5 Mbps，一屏 6 个视频同时拉等于把官网堵死）：
 *      卡片 `preload="none"`、**只有当前那张** play、其余 pause、离开视口一律停；
 *      封面若是站内 file-asset 自动加 `?w=960` 取缩略图；
 *   ⑤ **空即隐藏**：items 删空 = 官网不显示这一屏（与 stats/steps/compare 同一条口径）；
 *   ⑥ **"后台可以配置"要能真跑通**：起真服务走一遍「改草稿 → 公开端仍是旧内容 → 发布 → 公开端读到新的
 *      视频与文案」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p147-videos-'));
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

/** 抠出锚点后面那个对象字面量（配平大括号）——两份默认值写法不同：shared 是 `HOME_VIDEOS_DEFAULT = {…}`，
 *  种子那份嵌在 HOME 里是 `videos: {…}`，所以锚点各取各的、比里面的字段。 */
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

console.log('① 两处同源（shared 的 HOME_VIDEOS_DEFAULT 与种子里的 HOME.videos）');
const sharedSrc = read('packages/shared/src/siteDefaults.js');
const seedSrc = read('packages/database/src/websiteContentDefaults.js');
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const sharedLiteral = objectAfter(sharedSrc, 'HOME_VIDEOS_DEFAULT =');
const seedLiteral = objectAfter(seedSrc, 'videos:');
check('① 两份默认值逐字一致（去空白后比较整块）',
  Boolean(sharedLiteral) && Boolean(seedLiteral) && normalize(sharedLiteral) === normalize(seedLiteral),
  `shared=${String(sharedLiteral).slice(0, 50)}… seed=${String(seedLiteral).slice(0, 50)}…`);
check('① 两份都带 title / lead / items 三个字段', ['title', 'lead', 'items'].every((key) => sharedSrc.includes(`${key}:`) && seedSrc.includes(`${key}:`)));
check('① 默认 items 是**空数组**（视频由运营自己传，仓库不预置素材）', /items: \[\]/.test(String(sharedLiteral)));

console.log('② 不引依赖 / 不引外域素材');
const site = read('apps/website/src/main.jsx');
const css = read('apps/website/src/styles.css');
const admin = read('apps/admin/src/pages/WebsiteContent.jsx');
const pkg = read('package.json');
const siteCode = site.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
check('② 没有 framer-motion / lucide / tailwind / Google Fonts（代码行与依赖清单都没有）',
  !/framer-motion|lucide|tailwind/i.test(siteCode) && !/fonts\.googleapis|fonts\.gstatic/.test(siteCode)
  && !/framer-motion|lucide-react|tailwind/i.test(pkg));
check('② 箭头是自绘 SVG（不引图标库）', /\.hp-vid-arrow[\s\S]{0,400}<svg viewBox="0 0 24 24"/.test(site) || /<button type="button" className="hp-vid-arrow is-prev"[\s\S]{0,300}<svg/.test(site));
check('② 视频只从自家公开口取（组件里没有写死的外站地址）',
  !/https?:\/\/(?!www\.w3\.org)[a-z0-9.-]+\.(mp4|webm|mov)/i.test(siteCode));
check('② 后台的空状态写明白了（空 = 官网不显示，且必须点发布）—— 运营第一眼就不会以为"没做出来"', admin.includes('这一屏现在是空的') && admin.includes('只保存草稿官网看不到'));
check('② 视频与封面**不进 CMS JSON**（后台表单里只存 URL；服务端 CMS 有 200KB 上限，塞不下视频）',
  /videoUrl/.test(admin) && /posterUrl/.test(admin) && !/base64/i.test(admin));

console.log('③ 位置与底色');
const ruleOf = (selector) => (css.match(new RegExp(`\\${selector}\\{[^}]*\\}`)) || [])[0] || '';
const stopsOf = (rule) => [...String(rule).matchAll(/#([0-9a-f]{3,8})\s+(\d+)%/gi)].map((match) => `#${match[1].toLowerCase()}`);
check('③ 它在 `.hp-first` **外面**（加它不许改变第一屏含背景视频的取景）',
  site.indexOf('<HomeVideos') > site.indexOf('</div>\n    {/* 第二屏'), '检查 HomeVideos 与 .hp-first 的先后');
check('③ 它排在**第一屏之后、三步一栏之前**（"第二屏"就是这个位置）',
  site.indexOf('<HomeVideos') > site.indexOf('className="hp-stats"') && site.indexOf('<HomeVideos') < site.indexOf('<HomeSteps'));
check('③ 底色是渐变（不是一块纯黑，夹在两段红之间会成断层）',
  /\.hp-vid\{[^}]*linear-gradient\(180deg/.test(css), ruleOf('.hp-vid').slice(0, 100));
const vidStops = stopsOf(ruleOf('.hp-vid'));
const stepsStops = stopsOf(ruleOf('.hp-steps'));
check('③ 这一栏末色 = 三步一栏首色（下行接得住，不留缝）',
  vidStops[vidStops.length - 1] === stepsStops[0], `栏末色=${vidStops[vidStops.length - 1]} 三步首色=${stepsStops[0]}`);
check('③ 空即隐藏：items 为空时组件直接不渲染（return null）', /if \(!items\.length\) return null;/.test(site));

console.log('④ 性能（这台机 5 Mbps，一屏不能同时拉多个视频）');
check('④ 卡片 <video> 一律 preload="none"（不点开不下载）', /preload="none"/.test(site));
check('④ ⭐ 只有**当前那张**在播、其余暂停，离开视口全停',
  /if \(shown && index === activeIndex\) video\.play\?\.\(\)\.catch\(\(\) => \{\}\);\s*\n\s*else \{ video\.pause\?\.\(\); \}/.test(site));
check('④ 卡片视频是 muted + loop + playsInline（浏览器才允许自动播）', /muted loop playsInline/.test(site));
check('④ 封面若是站内 file-asset 自动加 ?w=960（运营传的原图常有几 MB）',
  /function coverThumb\(url\)/.test(site) && /return `\$\{value\}\?w=960`;/.test(site));
check('④ 滚到哪张激活哪张（scroll-snap + 中心距离判定），箭头/圆点共用同一个 scrollToIndex',
  /scroll-snap-type:x mandatory/.test(css) && /const distance = Math\.abs\(card\.offsetLeft \+ card\.clientWidth \/ 2 - center\)/.test(site));

console.log('⑤ CMS：后台能配（真服务 / 真接口往返）');
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const port = 19147;
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
  check('⑤ 新库种出来就带这一块（公开端读得到 videos）', Boolean(before?.content?.videos), JSON.stringify(before?.content?.videos || {}).slice(0, 80));

  const nextVideos = {
    title: 'P147 视频屏标题',
    lead: 'P147 视频屏副标题',
    items: [
      { tag: '第 1 课', title: 'P147 第一个视频', desc: '说明一', videoUrl: '/api/public/file-assets/file_p147a/download', posterUrl: '/api/public/file-assets/file_p147b/download' },
      { tag: '第 2 课', title: 'P147 第二个视频', desc: '说明二', videoUrl: '/api/public/file-assets/file_p147c/download', posterUrl: '' },
    ],
  };
  const content = { ...(before?.content || {}), videos: nextVideos };
  const saved = await api('/api/admin/website-content/HOME', { method: 'PUT', token, body: { content } });
  check('⑤ 保存草稿成功（视频与文案一起写进去）', saved.status === 200, `HTTP ${saved.status} ${JSON.stringify(saved.payload).slice(0, 120)}`);
  const publicAfterDraft = (await api('/api/public/website-content/HOME')).payload?.data;
  check('⑤ 只存草稿时公开端**仍是旧内容**（草稿不影响线上）',
    JSON.stringify(publicAfterDraft?.content?.videos) !== JSON.stringify(nextVideos));
  const published = await api('/api/admin/website-content/HOME/publish', { method: 'POST', token, body: {} });
  check('⑤ 发布成功', published.status === 200, `HTTP ${published.status}`);
  const publicAfterPublish = (await api('/api/public/website-content/HOME')).payload?.data;
  const live = publicAfterPublish?.content?.videos;
  check('⑤ ★ 公开端读到后台写的标题与副标题', live?.title === nextVideos.title && live?.lead === nextVideos.lead, String(JSON.stringify(live)).slice(0, 140));
  check('⑤ ★ 公开端读到**两个视频**（标签 / 标题 / 说明 / 视频地址 / 封面都逐条落库）',
    Array.isArray(live?.items) && live.items.length === 2
    && live.items[0].videoUrl === nextVideos.items[0].videoUrl && live.items[1].tag === '第 2 课' && live.items[0].desc === '说明一',
    String(JSON.stringify(live?.items || [])).slice(0, 200));
} finally {
  server.kill();
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 上库文件可能还被占着 */ }
}

if (failures) { console.log(`\nP147 有 ${failures} 项未通过`); if (serverLog) console.log(serverLog.slice(-1200)); process.exitCode = 1; }
else console.log('P147 首页第二屏视频展示：两处默认值一致、不引依赖、位置与底色接得上、只有激活那张播、后台改稿→发布→公开端生效 通过');
