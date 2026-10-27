import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const executablePath = require('electron');
const appPath = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'junshi-collector-smoke-'));
const env = {
  ...process.env,
  JUNSHI_TEST_SESSION_JSON: JSON.stringify({
    token: 'smoke-session-token',
    expiresAt: '2099-12-31T00:00:00.000Z',
    user: { login: 'smoke', displayName: '冒烟测试' },
    organization: { name: '冒烟机构' },
  }),
  JUNSHI_TEST_OPEN_COLLECTOR: '1',
};
const app = await electron.launch({ executablePath, args: [appPath, `--user-data-dir=${profile}`], cwd: appPath, env });
try {
  let page = null;
  for (let index = 0; index < 20; index += 1) {
    const windows = app.windows();
    page = windows.find((candidate) => candidate.url().includes('collector.html')) || null;
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page) throw new Error('collector window did not open');
  await page.waitForSelector('#douyin-browser', { timeout: 15000 });
  await page.waitForSelector('#collect-peer', { timeout: 15000 });
  const status = await page.evaluate(async () => {
    const current = await window.junshiCollector.getStatus();
    await window.junshiCollector.updateSettings({ notificationsEnabled: false, intervalHours: 12 });
    const updated = await window.junshiCollector.getStatus();
    const unsafeSelf = await window.junshiCollector.collect('self');
    return {
      title: document.title,
      hasCollectorApi: Boolean(window.junshiCollector),
      hasOpenSelf: typeof window.junshiCollector.openSelf === 'function',
      hasWebview: document.querySelector('#douyin-browser')?.tagName?.toLowerCase() === 'webview',
      hasOpenSelfButton: Boolean(document.querySelector('#open-self')),
      version: current.version,
      signedIn: current.signedIn,
      settingApplied: updated.settings.notificationsEnabled === false && updated.settings.intervalHours === 12,
      unsafeSelfBlocked: unsafeSelf.ok === false,
    };
  });
  if (!status.hasCollectorApi || !status.hasOpenSelf || !status.hasWebview || !status.hasOpenSelfButton || !status.signedIn || !status.settingApplied || !status.unsafeSelfBlocked) {
    throw new Error(`collector assertion failed: ${JSON.stringify(status)}`);
  }
  console.log(JSON.stringify({ name: 'junshi-desktop-collector-smoke', pass: true, status }));
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
}


