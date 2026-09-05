#!/usr/bin/env node
import { chromium } from 'playwright-core';

const site = process.env.SITE_URL || 'https://iicili.cyou';
const modeArgIndex = process.argv.indexOf('--mode');
const mode = modeArgIndex >= 0 ? process.argv[modeArgIndex + 1] : (process.env.EXPECT_MODE || 'internal-test');
if (!['internal-test', 'public'].includes(mode)) {
  console.error(`Unsupported mode: ${mode}`);
  process.exit(2);
}
const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const httpOnly = process.argv.includes('--http') || process.env.VERIFY_HTTP_ONLY === 'true';
const cases = [
  { path: '/', title: /AI魔法学院/, requireLogin: false, rejectLogin: false },
  { path: '/admin/', title: /平台管理/, requireLogin: true, rejectLogin: false },
  { path: '/org/', title: /机构教务/, requireLogin: true, rejectLogin: false },
  { path: '/student/', title: /学生创作/, requireLogin: true, rejectLogin: false },
];
async function verifyHttp(item) {
  const response = await fetch(site + item.path, { redirect: 'manual' });
  const html = await response.text();
  const headers = Object.fromEntries(response.headers.entries());
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '';
  const assets = [...html.matchAll(/(?:src|href)=[\"'](\/(?:admin\/|org\/|student\/)?assets\/index-[^\"']+\.(?:js|css))[\"']/g)].map(m => m[1]);
  const assetText = (await Promise.all(assets.map(async asset => { try { return await (await fetch(site + asset)).text(); } catch { return ''; } }))).join('\\n');
  const robotsHeader = (headers['x-robots-tag'] || '').toLowerCase();
  const checked = {
    status: response.status, title, titleOk: item.title.test(title),
    loginOk: !item.requireLogin || body.includes('登录你的工作台') || assetText.includes('登录你的工作台'),
    websiteNavRejected: !item.requireLogin || (!body.includes('预约演示') && !assetText.includes('预约演示')),
    assetPrefixOk: item.path === '/' ? assets.every(x => x.startsWith('/assets/')) : assets.every(x => x.startsWith(item.path + 'assets/')),
    modeOk: mode === 'internal-test' ? headers['x-internal-test'] === 'true' : headers['x-internal-test'] === undefined,
    robotsOk: mode === 'internal-test' ? robotsHeader.includes('noindex') : (!robotsHeader || (!robotsHeader.includes('noindex') && !robotsHeader.includes('nofollow'))),
    bannerOk: mode === 'internal-test' ? body.includes('内部测试环境') : !body.includes('内部测试环境'),
    securityHeadersOk: mode === 'internal-test' || Boolean(headers['strict-transport-security'] && headers['content-security-policy'] && headers['x-content-type-options'] && headers['x-frame-options'] && headers['referrer-policy']),
    assets,
  };
  checked.pass = Object.entries(checked).filter(([k]) => k.endsWith('Ok') || k === 'status').every(([k, v]) => k === 'status' ? v === 200 : v === true);
  return { path: item.path, mode, ...checked };
}

const results = [];
if (httpOnly) {
  for (const item of cases) results.push(await verifyHttp(item));
  console.log(JSON.stringify(results, null, 2));
  if (results.some(x => !x.pass)) process.exit(1);
} else {
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const response = await page.goto(site + item.path, { waitUntil: 'networkidle', timeout: 45000 });
    const headers = await response.allHeaders();
    const html = await page.content();
    const assets = [...html.matchAll(/(?:src|href)=\"(\/(?:admin\/|org\/|student\/)?assets\/index-[^\"]+\.(?:js|css))\"/g)].map(m => m[1]);
    const body = await page.locator('body').innerText();
    const title = await page.title();
    const assetText = (await Promise.all(assets.map(async asset => { try { return await (await fetch(site + asset)).text(); } catch { return ''; } }))).join('\\n');
  const robotsHeader = (headers['x-robots-tag'] || '').toLowerCase();
    const checked = {
      status: response.status(),
      title,
      titleOk: item.title.test(title),
      loginOk: !item.requireLogin || body.includes('登录你的工作台') || assetText.includes('登录你的工作台'),
      websiteNavRejected: !item.requireLogin || (!body.includes('预约演示') && !assetText.includes('预约演示')),
      assetPrefixOk: item.path === '/' ? assets.every(x => x.startsWith('/assets/')) : assets.every(x => x.startsWith(item.path + 'assets/')),
      modeOk: mode === 'internal-test'
        ? headers['x-internal-test'] === 'true'
        : headers['x-internal-test'] === undefined,
      robotsOk: mode === 'internal-test'
        ? robotsHeader.includes('noindex')
        : (!robotsHeader || (!robotsHeader.includes('noindex') && !robotsHeader.includes('nofollow'))),
      bannerOk: mode === 'internal-test'
        ? body.includes('内部测试环境')
        : !body.includes('内部测试环境'),
      securityHeadersOk: mode === 'internal-test' || Boolean(
        headers['strict-transport-security'] &&
        headers['content-security-policy'] &&
        headers['x-content-type-options'] &&
        headers['x-frame-options'] &&
        headers['referrer-policy']
      ),
      assets,
    };
    checked.pass = Object.entries(checked)
      .filter(([k]) => k.endsWith('Ok') || k === 'status')
      .every(([k, v]) => k === 'status' ? v === 200 : v === true);
    results.push({ path: item.path, mode, ...checked });
    await page.close();
  }
} finally {
  await browser.close();
}
if (!httpOnly) {
console.log(JSON.stringify(results, null, 2));
if (results.some(x => !x.pass)) process.exit(1);
}

}
