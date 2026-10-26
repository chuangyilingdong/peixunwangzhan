/**
 * P193 招生军师 · 移动端聊天输入区回归（2026-10-26）
 *
 * 背景：390px 窄屏下 `.wb-composer-foot` 不换行，附件按钮和「标准/深度」
 * 被压成竖排，输入区高度也被挤坏。这里同时钉住三件事：
 *   ① 源码里保留短 placeholder + 完整 title/aria-label，以及模型选项分组；
 *   ② 390px / 320px 下工具栏换行，附件按钮和模型 chip 保持横排；
 *   ③ 1440px 桌面端仍在同一行，右对齐，不把桌面布局一起改坏。
 *
 * 跑法：node scripts/p193-junshi-mobile-composer.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const shotDir = path.join(root, '.tmp', 'p193-mobile-composer');
fs.mkdirSync(shotDir, { recursive: true });

const sourceCss = fs.readFileSync(path.join(root, 'apps/website/public/assets/junshi/workbench.css'), 'utf8');
const sourceJs = fs.readFileSync(path.join(root, 'apps/website/public/assets/junshi/workbench.js'), 'utf8');
const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error.message }); }
};

check('① 工具栏有窄屏换行规则', () => {
  assert.match(sourceCss, /@media \(max-width: 820px\) \{[\s\S]*?\.wb-composer-foot \{ flex-wrap: wrap;/);
  assert.match(sourceCss, /#wb-chat-attach-btn \{ flex: 0 0 auto; white-space: nowrap;/);
});
check('① 模型选项被包成独立分组', () => {
  assert.match(sourceJs, /wb-composer-model/);
  assert.match(sourceJs, /模型：<\/span>[\s\S]*?data-tier="fast"[\s\S]*?data-tier="deep"[\s\S]*?<\/span>/);
});
check('① 移动端 placeholder 缩短，完整说明保留在 title/aria-label', () => {
  assert.match(sourceJs, /placeholder="说说你今天想做什么，或贴一段同行口播…"/);
  assert.match(sourceJs, /title="可发图片\/视频\/音频，用 @图片1 \/ @视频1 \/ @音频1 指定"/);
  assert.match(sourceJs, /aria-label="输入内容，可发图片、视频或音频，用 @图片1 \/ @视频1 \/ @音频1 指定"/);
});

const getFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

const port = await getFreePort();
const base = `http://127.0.0.1:${port}/junshi/index.html`;
const vite = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js', 'apps/website',
  '--config', 'apps/website/vite.config.mjs',
  '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], {
  cwd: root,
  env: { ...process.env, VITE_DEV_API_TARGET: 'http://127.0.0.1:1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (chunk) => { viteLog += chunk; });
vite.stderr.on('data', (chunk) => { viteLog += chunk; });

let browser;
try {
  let ready = false;
  for (let i = 0; i < 120 && !ready; i += 1) {
    try { ready = (await fetch(base)).ok; } catch { /* Vite 还在启动 */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Vite 未启动：\n${viteLog.slice(-1200)}`);

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error?.stack || error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  await page.addInitScript((session) => {
    window.localStorage.setItem('ai-kids-platform.session.v1.org', JSON.stringify(session));
  }, {
    token: 'p193-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
    user: { id: 'u-p193', orgId: 'o-p193', login: 'p193', displayName: '移动端回归', role: 'ORG_ADMIN' },
    organization: { id: 'o-p193', name: '移动端回归机构' },
  });

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let data = {};
    if (pathname.endsWith('/api/junshi/experts')) data = { experts: [] };
    else if (pathname.endsWith('/api/junshi/overview')) data = { signedIn: true, orgName: '移动端回归机构', today: '2026-10-26', month: 10, calendar: { '10': { launch: '移动端回归主线' } }, profile: {}, completion: {}, stats: {} };
    else if (pathname.endsWith('/api/junshi/conversations')) data = { conversations: [] };
    else if (pathname.endsWith('/workbench/bootstrap')) data = { profile: null, accounts: [{ id: 'default', name: '默认账号', platform: '抖音', note: '' }] };
    else if (pathname.endsWith('/workbench/chat')) data = { messages: [] };
    else if (pathname.endsWith('/workbench/assets')) data = { items: [], folders: [] };
    else if (pathname.endsWith('/workbench/workflows')) data = { items: [], styles: [], angles: [], strengths: [] };
    else if (pathname.endsWith('/workbench/profile')) data = { profile: null };
    else data = { items: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
  });

  await page.goto(base, { waitUntil: 'networkidle', timeout: 45000 });
  await page.locator('[data-screen="workbench"]').click();
  await page.locator('#wb-input').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(400);

  const measure = () => page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const foot = document.querySelector('.wb-composer-foot');
    const attach = document.querySelector('#wb-chat-attach-btn');
    const model = document.querySelector('.wb-composer-model');
    const input = document.querySelector('#wb-input');
    const chips = [...document.querySelectorAll('.wb-composer-model .chip')];
    return {
      viewport: innerWidth,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      foot: rect(foot),
      footWrap: getComputedStyle(foot).flexWrap,
      attach: rect(attach),
      attachWhiteSpace: getComputedStyle(attach).whiteSpace,
      model: rect(model),
      chips: chips.map((chip) => ({ ...rect(chip), whiteSpace: getComputedStyle(chip).whiteSpace })),
      input: rect(input),
      inputScrollHeight: input.scrollHeight,
      inputClientHeight: input.clientHeight,
      placeholder: input.placeholder,
      title: input.title,
    };
  });

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(250);
    const m = await measure();
    check(`② ${width}px：页面无横向溢出`, () => assert.equal(m.docOverflow, false));
    check(`② ${width}px：工具栏换行`, () => assert.equal(m.footWrap, 'wrap'));
    check(`② ${width}px：附件按钮保持横排，不再被压成竖条`, () => {
      assert.equal(m.attachWhiteSpace, 'nowrap');
      assert.ok(m.attach.width > m.attach.height * 1.5, JSON.stringify(m.attach));
      assert.ok(m.attach.height < 56, JSON.stringify(m.attach));
    });
    check(`② ${width}px：模型选项独占下一行并靠右`, () => {
      assert.ok(m.model.y >= m.attach.bottom - 1, `attachBottom=${m.attach.bottom} modelY=${m.model.y}`);
      assert.ok(m.model.right <= m.foot.right + 1, `modelRight=${m.model.right} footRight=${m.foot.right}`);
    });
    check(`② ${width}px：标准/深度均保持横排`, () => {
      assert.equal(m.chips.length, 2);
      for (const chip of m.chips) {
        assert.equal(chip.whiteSpace, 'nowrap');
        assert.ok(chip.width > chip.height, JSON.stringify(chip));
      }
    });
    check(`② ${width}px：输入框有足够高度且短 placeholder 不溢出`, () => {
      assert.ok(m.input.height >= 60, JSON.stringify(m.input));
      assert.ok(m.inputScrollHeight <= m.inputClientHeight + 2, `scroll=${m.inputScrollHeight} client=${m.inputClientHeight}`);
      assert.ok(m.placeholder.length < 40, m.placeholder);
      assert.match(m.title, /@图片1/);
    });
    await page.screenshot({ path: path.join(shotDir, `composer-${width}.png`), fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(250);
  const desktop = await measure();
  check('③ 1440px：桌面端仍为单行工具栏', () => {
    assert.equal(desktop.footWrap, 'nowrap');
    assert.ok(Math.abs(desktop.model.y - desktop.attach.y) < 20, `attachY=${desktop.attach.y} modelY=${desktop.model.y}`);
    assert.ok(desktop.model.right <= desktop.foot.right + 1);
  });
  await page.screenshot({ path: path.join(shotDir, 'composer-1440.png'), fullPage: true });

  check('② 浏览器零 JS / console 报错', () => assert.deepEqual(errors, []));
} finally {
  if (browser) await browser.close();
  vite.kill();
}

const failed = checks.filter((item) => !item.ok);
const result = { name: 'p193-junshi-mobile-composer', pass: failed.length === 0, checks: checks.length, failed };
if (failed.length) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result));
