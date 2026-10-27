import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const executablePath = require('electron');
const appPath = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'junshi-desktop-smoke-'));
const testSession = process.env.JUNSHI_TEST_SESSION_JSON || '';
const env = { ...process.env };
if (testSession) env.JUNSHI_TEST_SESSION_JSON = testSession;

const app = await electron.launch({
  executablePath,
  args: [appPath, `--user-data-dir=${profile}`],
  cwd: appPath,
  env,
});
try {
  const page = await app.firstWindow({ timeout: 30000 });
  if (testSession) {
    await page.waitForURL(/\/junshi\/index\.html/, { timeout: 45000 });
    await page.waitForSelector('#scr-workbench:not([hidden])', { timeout: 30000 });
    await page.waitForFunction(
      () => !document.querySelector('#wb-view')?.innerText?.includes('正在打开内容工作台'),
      null,
      { timeout: 30000 },
    );
    const state = await page.evaluate(() => ({
      workbenchVisible: document.querySelector('#scr-workbench')?.hidden === false,
      sessionTokenPresent: Boolean(JSON.parse(localStorage.getItem('ai-kids-platform.session.v1.org') || '{}')?.token),
      desktopVersion: window.__JUNSHI_DESKTOP__?.version || '',
    }));
    if (!state.workbenchVisible || !state.sessionTokenPresent || !state.desktopVersion) {
      throw new Error(`workbench assertion failed: ${JSON.stringify(state)}`);
    }
    console.log(JSON.stringify({ name: 'junshi-desktop-smoke', pass: true, mode: 'workbench', state }));
  } else {
    await page.waitForSelector('#login-form', { timeout: 15000 });
    const state = await page.evaluate(() => ({
      title: document.title,
      brand: document.querySelector('.brand b')?.textContent || '',
      hasAccount: Boolean(document.querySelector('#login')),
      hasPassword: Boolean(document.querySelector('#password')),
      hasMfa: Boolean(document.querySelector('#mfa-field')),
    }));
    if (!state.title.includes('客户端登录') || state.brand !== '招生军师' || !state.hasAccount || !state.hasPassword || !state.hasMfa) {
      throw new Error(`login assertion failed: ${JSON.stringify(state)}`);
    }
    console.log(JSON.stringify({ name: 'junshi-desktop-smoke', pass: true, mode: 'login', state }));
  }
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
