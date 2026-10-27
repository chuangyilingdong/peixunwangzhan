import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const executablePath = require('electron');
const appPath = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'junshi-app-smoke-'));
const app = await electron.launch({
  executablePath,
  args: [appPath, `--user-data-dir=${profile}`],
  cwd: appPath,
  env: {
    ...process.env,
    JUNSHI_TEST_SESSION_JSON: JSON.stringify({
      token: 'smoke-session-token',
      expiresAt: '2099-12-31T00:00:00.000Z',
      user: { login: 'smoke', displayName: '冒烟测试' },
      organization: { name: '冒烟机构' },
    }),
  },
});
try {
  const page = await app.firstWindow({ timeout: 30000 });
  await page.waitForSelector('.app-shell', { timeout: 20000 });
  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    nav: Array.from(document.querySelectorAll('.nav-item')).map((node) => node.textContent.trim()),
    hasBridge: Boolean(window.junshiApp),
    localPage: location.protocol === 'file:' && location.pathname.endsWith('/app.html'),
    hasView: Boolean(document.querySelector('#view')),
  }));
  if (!state.localPage || !state.hasBridge || !state.hasView || state.nav.join('|') !== '首页|做内容|同行采集|我的数据|设置') {
    throw new Error(`native app assertion failed: ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify({ name: 'junshi-desktop-native-app-smoke', pass: true, state }));
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
}


