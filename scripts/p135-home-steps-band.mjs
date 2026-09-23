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
