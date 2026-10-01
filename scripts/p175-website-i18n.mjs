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

  await browser.close();
} finally {
  server.kill();
  if (web) web.kill();
}

assert.equal(failures, 0, `P175 有 ${failures} 条断言没过`);
console.log('PASS: 官网三语言（简/繁/英）切换、默认中文、lang 与 hreflang、切换保持当前页');
