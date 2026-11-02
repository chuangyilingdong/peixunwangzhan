/**
 * P178 客户端三平台（win-x64 / mac-arm64 / mac-x64）平台侧契约守卫。
 * 不启动服务，只验证清单读视图、严格文件名、单平台写入的保留语义和后台上传/官网入口接线。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIENT_PLATFORMS,
  parseClientInstallerName,
  publishClientInstaller,
  readClientUpdateManifest,
} from '../apps/server/src/services/clientUpdateManifest.js';

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'p178-client-three-platform-'));
const manifest = join(temp, 'manifest.json');
const env = { ...process.env, CLIENT_UPDATE_MANIFEST: manifest };
let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}${error?.message ? ` — ${error.message}` : ''}`);
  }
};
const entry = (version, target) => ({
  name: `lingdong-client-${version}-${target}.${target === 'win-x64' ? 'exe' : 'dmg'}`,
  size: target === 'mac-x64' ? 300 : target === 'mac-arm64' ? 200 : 100,
  sha256: target === 'win-x64' ? 'a'.repeat(64) : target === 'mac-arm64' ? 'b'.repeat(64) : 'c'.repeat(64),
  version,
});

try {
  check('三个平台顺序固定', () => {
    assert.deepEqual(CLIENT_PLATFORMS, ['win-x64', 'mac-arm64', 'mac-x64']);
  });

  check('严格文件名识别 Intel 与 Apple Silicon，扩展名不能交叉', () => {
    assert.deepEqual(parseClientInstallerName('lingdong-client-1.2.3-mac-arm64.dmg'), { version: '1.2.3', platform: 'mac-arm64' });
    assert.deepEqual(parseClientInstallerName('lingdong-client-1.2.3-mac-x64.dmg'), { version: '1.2.3', platform: 'mac-x64' });
    assert.throws(() => parseClientInstallerName('lingdong-client-1.2.3-mac-x64.exe'));
  });

  writeFileSync(manifest, JSON.stringify({
    version: '1.2.3',
    files: {
      'win-x64': entry('1.2.3', 'win-x64'),
      'mac-arm64': entry('1.2.3', 'mac-arm64'),
      'mac-x64': entry('1.2.3', 'mac-x64'),
    },
  }, null, 2));

  check('三平台同版本时后台读得到三条且 stale 为空', () => {
    const value = readClientUpdateManifest(env);
    assert.equal(value.files['win-x64'].name, 'lingdong-client-1.2.3-win-x64.exe');
    assert.equal(value.files['mac-arm64'].name, 'lingdong-client-1.2.3-mac-arm64.dmg');
    assert.equal(value.files['mac-x64'].name, 'lingdong-client-1.2.3-mac-x64.dmg');
    assert.equal(value.files['mac-x64'].version, '1.2.3');
    assert.deepEqual(value.stale, []);
  });

  check('任一 Mac 架构落后时 stale 精确指出该平台', () => {
    const staleManifest = JSON.parse(readFileSync(manifest, 'utf8'));
    staleManifest.files['mac-arm64'] = entry('1.2.2', 'mac-arm64');
    writeFileSync(manifest, JSON.stringify(staleManifest, null, 2));
    assert.deepEqual(readClientUpdateManifest(env).stale, ['mac-arm64']);
  });

  writeFileSync(manifest, JSON.stringify({
    version: '1.2.3',
    files: {
      'win-x64': entry('1.2.3', 'win-x64'),
      'mac-arm64': entry('1.2.3', 'mac-arm64'),
      'mac-x64': entry('1.2.3', 'mac-x64'),
    },
  }, null, 2));
  const before = JSON.parse(readFileSync(manifest, 'utf8'));
  const nextX64 = {
    name: 'lingdong-client-1.2.4-mac-x64.dmg',
    size: 333,
    sha256: 'd'.repeat(64),
  };

  publishClientInstaller({ fileName: nextX64.name, size: nextX64.size, sha256: nextX64.sha256, env, now: new Date('2026-11-02T00:00:00.000Z') });

  check('上传 Intel DMG 只替换 mac-x64 条目，另外两个平台保持逐字节不变', () => {
    const after = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(after.files['mac-x64'].name, nextX64.name);
    assert.equal(after.files['mac-x64'].sha256, nextX64.sha256);
    assert.deepEqual(after.files['win-x64'], before.files['win-x64']);
    assert.deepEqual(after.files['mac-arm64'], before.files['mac-arm64']);
  });

  check('后台页面展示三个平台和各自规范文件名', () => {
    const admin = readFileSync(join(root, 'apps/admin/src/pages/ClientUpdate.jsx'), 'utf8');
    assert.match(admin, /macOS（Intel 芯片）/);
    assert.match(admin, /lingdong-client-<版本>-mac-x64\.dmg/);
    assert.match(admin, /PLATFORM_ORDER = \['win-x64', 'mac-arm64', 'mac-x64'\]/);
  });

  check('官网下载页会读取 mac-arm64 / mac-x64 并提供 Intel 手动切换', () => {
    const website = readFileSync(join(root, 'apps/website/src/main.jsx'), 'utf8');
    assert.match(website, /macArchitecture === "arm64" \? "mac-arm64" : "mac-x64"/);
    assert.match(website, /download\.macIntel/);
    assert.doesNotMatch(website, /const mac = manifest\?\.files\?\.\["mac-arm64"\]/);
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nP178 有 ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\nP178 客户端三平台平台侧契约：通过');
}
