/**
 * P179 官网 Mac 架构下载选择守卫。
 * 用真实 Vite 页面 + 拦截 manifest，验证默认 Apple 芯片、手动切 Intel、手动切回，
 * 以及选中架构缺包时不会回退下载另一架构。
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const port = 19179;
const base = `http://127.0.0.1:${port}`;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const manifest = {
  version: '1.2.3',
  files: {
    'win-x64': { name: 'lingdong-client-1.2.3-win-x64.exe', size: 100, sha256: 'a'.repeat(64), version: '1.2.3' },
    'mac-arm64': { name: 'lingdong-client-1.2.3-mac-arm64.dmg', size: 200, sha256: 'b'.repeat(64), version: '1.2.3' },
    'mac-x64': { name: 'lingdong-client-1.2.3-mac-x64.dmg', size: 300, sha256: 'c'.repeat(64), version: '1.2.3' },
  },
};
let failures = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}${error?.message ? ` — ${error.message}` : ''}`);
  }
};
const server = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js', 'apps/website',
  '--config', 'apps/website/vite.config.mjs',
  '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${base}/download`)).ok) { ready = true; break; }
    } catch { /* 等 Vite 启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Vite 未在 30 秒内启动');

  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.route('**/downloads/manifest.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) }));
  const page = await context.newPage();
  await page.goto(`${base}/download`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dl-arch');
  const macCard = page.locator('.dl-card').nth(1);

  await check('Windows 浏览器默认展示 Apple 芯片包，不误判为 Intel', async () => {
    const href = await macCard.locator('a.button').getAttribute('href');
    if (href !== '/downloads/lingdong-client-1.2.3-mac-arm64.dmg') throw new Error(`实际链接：${href}`);
  });

  await page.getByRole('button', { name: 'Intel 芯片' }).click();
  await check('手动切到 Intel 后下载链接指向 mac-x64', async () => {
    const href = await macCard.locator('a.button').getAttribute('href');
    if (href !== '/downloads/lingdong-client-1.2.3-mac-x64.dmg') throw new Error(`实际链接：${href}`);
  });

  await page.getByRole('button', { name: 'Apple 芯片' }).click();
  await check('手动切回 Apple 芯片后下载链接恢复 mac-arm64', async () => {
    const href = await macCard.locator('a.button').getAttribute('href');
    if (href !== '/downloads/lingdong-client-1.2.3-mac-arm64.dmg') throw new Error(`实际链接：${href}`);
  });

  for (const [architecture, expectedFile] of [["arm", "lingdong-client-1.2.3-mac-arm64.dmg"], ["x86", "lingdong-client-1.2.3-mac-x64.dmg"]]) {
    const macContext = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36" });
    await macContext.addInitScript((arch) => {
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        get: () => ({ architecture: arch, getHighEntropyValues: async () => ({ architecture: arch }) }),
      });
    }, architecture);
    await macContext.route("**/downloads/manifest.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(manifest) }));
    const macPage = await macContext.newPage();
    await macPage.goto(`${base}/download`, { waitUntil: "domcontentloaded" });
    await macPage.waitForSelector(".dl-arch");
    await check(`Mac 浏览器自动识别 ${architecture} 时链接指向 ${expectedFile}`, async () => {
      const href = await macPage.locator(".dl-card").nth(1).locator("a.button").getAttribute("href");
      if (href !== `/downloads/${expectedFile}`) throw new Error(`实际链接：${href}`);
    });
    await macContext.close();
  }

  const missingManifest = structuredClone(manifest);
  delete missingManifest.files['mac-x64'];
  const missingContext = await browser.newContext();
  await missingContext.route('**/downloads/manifest.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(missingManifest) }));
  const missingPage = await missingContext.newPage();
  await missingPage.goto(`${base}/download`, { waitUntil: 'domcontentloaded' });
  await missingPage.waitForSelector('.dl-arch');
  await missingPage.getByRole('button', { name: 'Intel 芯片' }).click();
  const missingCard = missingPage.locator('.dl-card').nth(1);
  await check('选中 Intel 但清单缺 mac-x64 时显示准备中，不回退 Apple 包', async () => {
    const linkCount = await missingCard.locator('a.button').count();
    const text = await missingCard.innerText();
    if (linkCount !== 0 || !text.includes('正在准备中')) throw new Error(`链接数 ${linkCount}，内容：${text}`);
  });
  await missingContext.close();
  await context.close();
} catch (error) {
  failures += 1;
  console.error('P179 抛错：', error?.message || error);
  if (serverLog) console.error(serverLog.split('\n').slice(-20).join('\n'));
} finally {
  if (browser) await browser.close();
  server.kill();
}

if (failures > 0) {
  console.log(`\nP179 有 ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\nP179 官网 Mac 双架构下载选择：通过');
}
