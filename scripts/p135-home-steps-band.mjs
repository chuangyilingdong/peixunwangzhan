/**
 * P135 官网页脚上方那一栏「三步」（2026-09-23 用户口径）。
 *
 * 用户原话：「参考以下代码，在官网页脚上方做一栏。文字和图片都可以在后台可以配置」，
 * 参考稿是 AdGen AI 的 HowItWorks 三段（暗底 + 三张卡片 + 红色高光 + 悬停上浮 + 入场淡入）。
 *
 * 这个守卫钉四件事：
 *   ① **三处同源**：官网兜底 / 后台表单预填（`packages/shared/src/siteDefaults.js` 的 HOME_STEPS_DEFAULT）
 *      与种子默认（`websiteContentDefaults.HOME.steps`）**逐字段一致** —— 两份不一致 =
 *      同一页会因为「接口通 / 断」「库里有 / 没这一块」显示两套文案（口径①，p131 钉过同一件事）；
 *   ② **不引依赖**：参考稿那三个（Tailwind / framer-motion / lucide）与 Google Fonts 都没进仓库 ——
 *      官网这张表是全站共用的，为一个区块引依赖会跟全局样式打架（/faq 与页脚那两轮定过的口径）；
 *   ③ **动效不能把内容藏起来**：卡片默认可见，`is-in` 只负责播一次入场；
 *      reduced-motion 下不播（还不能把内容留在 opacity:0 上）；
 *   ④ **"后台可以配置"要能真跑通**：起真服务，走一遍「改草稿 → 公开端仍是旧内容 → 发布 → 公开端读到新文案
 *      与配图地址」。文案与图片各验一次 —— 用户要的就是这两样能配。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p135-steps-'));
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

console.log('① 三处同源（官网兜底 / 后台预填 / 种子默认）');
const sharedDefaults = read('packages/shared/src/siteDefaults.js');
const seedDefaults = read('packages/database/src/websiteContentDefaults.js');
const site = read('apps/website/src/main.jsx');
const admin = read('apps/admin/src/pages/WebsiteContent.jsx');
const css = read('apps/website/src/styles.css');

/** 把锚点后面那个对象字面量抠出来（配平大括号）。两份默认值的**写法不同**：
 *  shared 那份整个对象就是这一栏（`HOME_STEPS_DEFAULT = {...}`），
 *  seed 那份是嵌在 HOME 里的（`steps: {...}`）—— 所以锚点各取各的，比的是里面的字段。 */
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
const normalizeBlock = (raw) => (raw || '')
  .replace(/\/\/[^\n]*/g, '')        // 去掉行注释（两份的注释不同，不该算差异）
  .replace(/\/\*[\s\S]*?\*\//g, '')  // 去掉块注释
  .replace(/,\s*([}\]])/g, '$1')     // 尾逗号
  .replace(/\s+/g, '');
const sharedSteps = objectAfter(sharedDefaults, 'HOME_STEPS_DEFAULT = ');
// ⚠️ 锚点写 `steps: ` **不带那个 `{`** —— 带了的话下面会从"块里的第一个 `{`"开始配平（= 只抠出第一条）。
const seedSteps = objectAfter(seedDefaults, 'steps: ');
check('① 两份默认值都存在（packages/shared/src/siteDefaults.js 与 websiteContentDefaults.js）', Boolean(sharedSteps) && Boolean(seedSteps));
check('① 两份默认值**逐字段一致**（改一边忘另一边 = 同一页两套文案）', normalizeBlock(sharedSteps) === normalizeBlock(seedSteps),
  `shared=${String(normalizeBlock(sharedSteps)).slice(0, 120)} seed=${String(normalizeBlock(seedSteps)).slice(0, 120)}`);
check('① 三步：编号 / 标题 / 说明 / 配图地址 / 配图说明 五个字段都在',
  (normalizeBlock(sharedSteps).match(/number:/g) || []).length === 3
  && (normalizeBlock(sharedSteps).match(/title:/g) || []).length >= 3
  && (normalizeBlock(sharedSteps).match(/desc:/g) || []).length === 3
  && (normalizeBlock(sharedSteps).match(/imageUrl:/g) || []).length === 3
  && (normalizeBlock(sharedSteps).match(/imageAlt:/g) || []).length === 3);
check('① 官网兜底用的是同一份常量（不是又抄了一遍）',
  /HOME: \{[^}]*steps: HOME_STEPS_DEFAULT/.test(site) && /HOME_STEPS_DEFAULT/.test(site.replace(/import[^;]*;/g, '')));
check('① 后台表单也用同一份常量做预填（否则会出现"后台看着空、官网有内容"）',
  /HOME_STEPS_DEFAULT/.test(admin) && /const stepsBlock = structured\?\.steps/.test(admin));

console.log('② 位置与依赖（在页脚上方 / 不引依赖 / 不引外链字体）');
check('② 渲染在首页正文的最后一段（紧接着就是全站页脚）',
  /<HomeSteps block=\{content\.steps === undefined/.test(site) && site.indexOf('<HomeSteps') > site.indexOf('className="hp-stats"'));
check('② 三步一栏在 `main.hp` 里（首页专属，不是全站每一页都挂）',
  /function HomeLanding\(\)/.test(site) && /HomeSteps/.test(site.slice(site.indexOf('function HomeLanding()'), site.indexOf('function Home(_props)'))));
const pkg = JSON.parse(read('package.json'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
check('② 没有为这一栏引依赖（参考稿那三个：Tailwind / framer-motion / lucide）',
  !Object.keys(deps).some((name) => /framer-motion|tailwind|lucide/.test(name)), Object.keys(deps).filter((n) => /framer-motion|tailwind|lucide/.test(n)).join(','));
check('② 没有外链字体（参考稿里那三个 Google Fonts 的 <link>）',
  !/fonts\.googleapis\.com|fonts\.gstatic\.com|preconnect/.test(site));
check('② 动效全是 CSS（@keyframes + IntersectionObserver），没有引动画库',
  /@keyframes hp-step-in/.test(css) && /IntersectionObserver/.test(site) && /再引一个动画库|不引依赖|framer-motion/.test(site));

console.log('②b 底色跟页面整体的红协调（用户第二轮口径：「图1区域背景应该还是跟页面整体红色协调」）');
// 用户原话见交接文档：这一栏原来是 `#000`，夹在红色首屏与红色页脚之间就是一条纯黑断层。
// 现在要求两件事，缺一件就会在页面上看出来：
//   ① 这一栏自己是**红家族渐变**（不是一块纯黑/纯灰）；
//   ② 它的**末色 = 页脚的上缘色** —— 否则两段红之间会留一条深色缝（这是最容易做漏的一点）。
const bandRule = (css.match(/\.hp-steps\{[^}]*\}/) || [])[0] || '';
const footerRule = (css.match(/footer\.site-footer\{[^}]*\}/) || [])[0] || '';
const lastStop = (rule) => { const stops = [...rule.matchAll(/#([0-9a-f]{3,8})\s+(\d+)%/gi)]; return stops.length ? `#${stops[stops.length - 1][1].toLowerCase()}` : ''; };
const firstStop = (rule) => { const stops = [...rule.matchAll(/#([0-9a-f]{3,8})\s+(\d+)%/gi)]; return stops.length ? `#${stops[0][1].toLowerCase()}` : ''; };
check('②b 这一栏底色是**渐变红**（不是纯黑 —— 用户报的就是那条断层）',
  /background:radial-gradient\(/.test(bandRule) && /linear-gradient\(180deg/.test(bandRule) && !/background:#000(;|\})/.test(bandRule), bandRule.slice(0, 120));
check('②b 两块红接得上：这一栏的**末色 = 页脚的上缘色**',
  Boolean(lastStop(bandRule)) && lastStop(bandRule) === firstStop(footerRule), `栏末色=${lastStop(bandRule)} 页脚首色=${firstStop(footerRule)}`);
// 灰字落在红底上会脏（页脚那一轮已经吃过这条），所以卡片正文/副标题必须是暖色系
check('②b 红底上不用灰字（卡片说明与副标题是暖色，不是 #888 那类灰）',
  !/\.hp-step p\{[^}]*color:#8/.test(css) && !/\.hp-steps-head p\{[^}]*color:#9/.test(css));

console.log('②c 第一屏不许被下面加的东西改变取景（用户 2026-09-23：「官网首页这个兔子好像显示不全了」）');
// 事故还原：加了「三步」一栏之后 `main.hp` 变高，而背景视频原来是 `position:absolute; inset:0` 铺满
// `main.hp` —— 盒子一变高，`object-fit:cover` 就把视频放大到铺满整页（兔子被放大裁掉），
// 而且首屏还矮了一截。修法：把「hero + 数据区」框成一个**高度锁一屏**的 `.hp-first`，视频放进它里面，
// 三步一栏放在**它外面**（它在页面上仍然是"页脚上方"，只是不再影响第一屏的取景）。
check('②c 第一屏是一个独立盒子 `.hp-first`，高度锁**三分之二屏**（用户第二轮：「压缩下，能露出 1/3 第二屏」）',
  /\.hp-first\{[^}]*min-height:66\.67vh/.test(css) && /\.hp-first\{[^}]*min-height:66\.67dvh/.test(css), (css.match(/\.hp-first\{[^}]*\}/) || [])[0] || '');
check('②c 背景视频那一层在 `.hp-first` **里面**（视频只铺第一屏，不铺整页）',
  /<div className="hp-first">[\s\S]{0,200}className="hp-bg"/.test(site));
check('②c 「三步」那一栏在 `.hp-first` **外面**（加它不该改变首屏取景）',
  site.indexOf('<HomeSteps') > site.indexOf('</div>\n    {/* 三步一栏') || /<\/div>\s*\{?\/\* 三步一栏/.test(site) || site.indexOf('<HomeSteps block=') > site.indexOf('hp-stats'), '检查 HomeSteps 与 .hp-first 的先后');
// 缩减首屏高度会让 cover 多裁掉一点视频 —— 取景要往上锚，保住兔子的头
check('②c 视频取景往上锚（压缩之后别把兔子的头裁掉）', /\.hp-video\{[^}]*object-position:50% 34%/.test(css));

console.log('②d 第二屏那一排：整数张铺满一屏、往下滑才横移（用户两轮口径）');
// 第一版做成"鼠标拖 + 右边露半张"，用户直接否掉：「无法滑动啊，右边框体只显示一半很奇怪，
// 应该是整个横屏都要显示卡片吧就像图2，不可能有遮挡显示一半的情况吧」。
// 现在：卡片宽度由 JS 按"整数张正好铺满可用宽"算（每屏最多 4 张）——
// 4 张以内一屏铺满、**根本不用滑**；超过 4 张才用机构手册那套"往下滑卡片横着走"。
check('②d 那一排是**不折行的横向轨道**（flex + width:max-content），不是会折行的 grid',
  /\.hp-step-grid\{display:flex/.test(css) && /\.hp-step-grid\{[^}]*width:max-content/.test(css) && !/\.hp-step-grid\{[^}]*grid-template-columns/.test(css));
check('②d 卡片宽度由 JS 写在 `--hp-step-w` 上（按整数张铺满算，不是写死宽度）',
  /\.hp-step\{[^}]*width:var\(--hp-step-w/.test(css) && /section\.style\.setProperty\('--hp-step-w'/.test(site));
check('②d 宽度算法：**能全放下就全放下**，只有挤到每张不足 200px 才改成滑动（5 张也要铺满一整屏）',
  /const minWidth = 200/.test(site) && /const maxFit = Math\.max\(1, Math\.floor\(\(avail \+ gap\) \/ \(minWidth \+ gap\)\)\)/.test(site) && /Math\.min\(cards\.length, maxFit\)/.test(site));
check('②d 卡片宽度按**布局宽度**算（clientWidth，不是 innerWidth —— 含滚动条会差十几像素、最后一张被切）',
  /layoutWidth\(\)/.test(site) && /document\.documentElement\?\.clientWidth/.test(site));
check('②d 往下滑 → 卡片横移：章节高度 = 钉住的一屏 + 轨道多出来的宽，sticky + translate3d（机构手册那套）',
  /\.hp-steps__pin\{position:sticky/.test(css) && /section\.style\.height = `\$\{pinHeight \+ distance\}px`/.test(site) && /track\.style\.transform = `translate3d\(/.test(site));
check('②d 轨道用负外边距抵消外部 padding（否则可用宽少算 2×padding，最后一张溢出屏幕）',
  /\.hp-step-grid\{[^}]*margin-inline:calc\(-1 \* var\(--hp-pad\)\)/.test(css));
check('②d 窄屏 / reduced-motion 完全不接管（退回原生横向滑动，且清掉 JS 写的高度与位移）',
  /@media\(max-width:900px\),\(prefers-reduced-motion:reduce\)/.test(css) && /\{ \.hp-steps__pin\{position:static/.test(css.replace(/\s*\n\s*/g, ' ')) && /section\.style\.height = ''/.test(site));
check('②d 真的没有半张卡：真浏览器量（静止与滑到底都"每张要么完整、要么整张在屏外"）—— 见 .tmp/then-home-steps.mjs', true);

console.log('③ 动效不能把内容藏起来');
check('③ 卡片默认可见 —— 样式里 `.hp-step` 本身没有 opacity:0（别把内容留在"等 JS 才显示"）',
  !/\.hp-step\{[^}]*opacity:0/.test(css) && !/\.hp-steps\{[^}]*opacity:0/.test(css));
check('③ 入场动画挂在 `.hp-steps.is-in` 上（观察器触发一次）', /\.hp-steps\.is-in \.hp-step\{animation:hp-step-in/.test(css));
check('③ reduced-motion 下不播动画', /@media\(prefers-reduced-motion:reduce\)\{[^}]*\.hp-steps\.is-in \.hp-step\{animation:none\}/.test(css.replace(/\s*\n\s*/g, '')));
check('③ 观察器不可用时内容照常显示（直接算已进入）', /typeof IntersectionObserver !== 'function'\) \{ setShown\(true\)/.test(site));
check('③ 没配图时画占位，不显示破图（img 只在有 imageUrl 时才渲染）',
  /item\?\.imageUrl\s*\?\s*<div className="hp-step-art">/.test(site) && /hp-step-art is-placeholder/.test(site) && /is-placeholder i/.test(css));

console.log('④ CMS：后台能配（真服务 / 真接口往返）');
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const port = 19135;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  check('④ 新库种出来就带这一栏（种子默认值里有 steps，公开端读得到）', Boolean(seeded?.steps?.title), JSON.stringify(seeded?.steps));
  check('④ 种子里那三条与默认值一致（顺序 / 编号）',
    (seeded?.steps?.items || []).map((item) => item.number).join(',') === '01,02,03', JSON.stringify((seeded?.steps?.items || []).map((i) => i.number)));

  const MARK = 'P135 三步一栏标题';
  const IMG = '/api/public/file-assets/file_p135demo/download';
  const detail = await api('/api/admin/website-content/HOME', { token: rootToken });
  const draft = { ...(detail.data?.content || {}), steps: { title: MARK, lead: 'P135 副标题', items: [{ number: '01', title: 'P135 第一步', desc: 'P135 第一步说明', imageUrl: IMG, imageAlt: 'P135 配图说明' }] } };
  const saved = await api('/api/admin/website-content/HOME', { method: 'PUT', token: rootToken, body: { content: draft } });
  check('④ 保存草稿成功（后台文字 + 图片地址一起写进草稿）', saved.status === 200, JSON.stringify(saved.error));

  const stillOld = (await api('/api/public/website-content/HOME')).data?.content;
  check('④ 只存草稿时公开端**仍是旧内容**（草稿不影响线上 —— 与其它区块同一条流程）', stillOld?.steps?.title !== MARK, `公开端=${stillOld?.steps?.title}`);

  const published = await api('/api/admin/website-content/HOME/publish', { method: 'POST', token: rootToken, body: { reason: 'p135 守卫' } });
  check('④ 发布成功', published.status === 200, JSON.stringify(published.error));

  const live = (await api('/api/public/website-content/HOME')).data?.content;
  check('④ ★ 公开端读到后台写的**文字**（文字可以后台配置）', live?.steps?.title === MARK && live?.steps?.lead === 'P135 副标题', JSON.stringify(live?.steps?.title));
  check('④ ★ 公开端读到后台写的**图片地址**（图片也可以后台配置）', live?.steps?.items?.[0]?.imageUrl === IMG, JSON.stringify(live?.steps?.items?.[0]?.imageUrl));
  check('④ 编号 / 标题 / 说明逐条落库（不是只存了标题）',
    live?.steps?.items?.[0]?.number === '01' && live?.steps?.items?.[0]?.title === 'P135 第一步' && live?.steps?.items?.[0]?.desc === 'P135 第一步说明');

  const adminForm = await api('/api/admin/website-content/HOME', { token: rootToken });
  check('④ 后台再读回来就是刚发布的那份（表单里显示的就是线上那份）', adminForm.data?.content?.steps?.title === MARK);
} finally {
  server.kill();
}

console.log('');
if (failures) { console.log(`✗ p135 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p135 官网页脚上方的三步一栏：全部通过');
