#!/usr/bin/env node
import { chromium } from 'playwright-core';

const site = process.env.SITE_URL || 'https://iicili.cyou';
const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const cases = [
  { path: '/', title: /AI魔法学院/, requireLogin: false, rejectLogin: false },
  { path: '/admin/', title: /平台管理/, requireLogin: true, rejectLogin: false },
  { path: '/org/', title: /机构教务/, requireLogin: true, rejectLogin: false },
  { path: '/student/', title: /学生创作/, requireLogin: true, rejectLogin: false },
];
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
try {
  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const response = await page.goto(site + item.path, { waitUntil: 'networkidle', timeout: 45000 });
    const headers = await response.allHeaders();
    const html = await page.content();
    const assets = [...html.matchAll(/(?:src|href)=\"(\/(?:admin\/|org\/|student\/)?assets\/index-[^\"]+\.(?:js|css))\"/g)].map(m => m[1]);
    const body = await page.locator('body').innerText();
    const title = await page.title();
    const checked = {
      status: response.status(),
      title,
      titleOk: item.title.test(title),
      loginOk: !item.requireLogin || body.includes('登录你的工作台'),
      websiteNavRejected: item.requireLogin && !body.includes('预约演示'),
      assetPrefixOk: item.path === '/' ? assets.every(x => x.startsWith('/assets/')) : assets.every(x => x.startsWith(item.path + 'assets/')),
      noindexOk: (headers['x-robots-tag'] || '').includes('noindex'),
      internalTestOk: headers['x-internal-test'] === 'true',
      assets,
    };
    checked.pass = Object.entries(checked)
      .filter(([k]) => k.endsWith('Ok') || k === 'status')
      .every(([k, v]) => k === 'status' ? v === 200 : v === true);
    results.push({ path: item.path, ...checked });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (results.some(x => !x.pass)) process.exit(1);
