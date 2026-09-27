/**
 * P146 后台「上传安装包 → 发布 → 触发更新」守卫（2026-09-25）。
 *
 * 用户口径：「图6 后台这里要支持我们自己上传更新，上传完成后要能触发更新。」
 *
 * 这条链路有两处**只有真发一遍才看得见**的东西：
 *   ① 安装包是 **377MB** 的二进制。通用上传管线是把整份请求体读进内存再解析的（硬顶 200MB，
 *      见 fileUploadSecurity 里那段"内存闸"——这台机以前被一次大上传打穿过）。所以这条路由
 *      必须在**读 body 之前**分流、走流式落盘。这条断言只能靠"源码里没有 readBodyBuffer/
 *      parseMultipartFormData + index.js 的挂载点在读 body 之前"来钉（静态部分），
 *      再用真请求验"字节完整落盘 + sha256 对得上"（动态部分）。
 *   ② 「触发更新」= 原子写 manifest.json。客户端启动就读它（`?t=` 绕缓存），
 *      所以发布必须**一次写全**：版本、文件名、字节数、sha256 四样缺一不可，
 *      而且后台配过的策略字段（enabled/mandatory/minVersion/note/channel）不能被这一写抹掉。
 *
 * 钉下来：
 *   ① 源码口径：流式（无 readBodyBuffer / 无 multipart 解析）、挂在读 body 之前、权限是 ADMIN_AUDIT；
 *   ② 文件名契约：客户端按 `lingdong-client-<版本>-win-x64.exe` 校验，不合规的**上传就拒**；
 *   ③ 真服务：传上去 → 文件字节与本地一致、清单四项齐全、sha256 与独立算的一致；
 *   ④ 策略字段（后台配的）在发布之后仍然在；
 *   ⑤ 没有平台管理权限的人传不了；超限的包会被拒（不是静默截断）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p146-installer-'));
const dbPath = path.join(temp, 'platform.db');
const downloads = path.join(temp, 'downloads');
fs.mkdirSync(downloads, { recursive: true });
const manifest = path.join(downloads, 'manifest.json');
process.env.PLATFORM_DB_PATH = dbPath;

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  FILE_UPLOAD_ROOT: path.join(temp, 'uploads'),
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
  CLIENT_UPDATE_MANIFEST: manifest,
  // 上限调小，好把"超限被拒"这条分支真跑到（下限 1MB）
  CLIENT_INSTALLER_MAX_BYTES: String(2 * 1024 * 1024),
};
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ① 源码口径 */
console.log('① 源码：流式、挂在读 body 之前、权限与客户端更新同档');
// ⚠️ 判"某段代码在不在"之前先剥注释：这个路由的**文件头注释正原样写着** readBodyBuffer /
//    parseMultipartFormData（说明"为什么不走通用管线"），不剥的话第一条断言永远红 ——
//    p132/p130 都在这一脚上踩过，别第三遍。
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const route = read('apps/server/src/routes/admin/clientInstallerUpload.js');
const routeCode = stripComments(route);
const index = read('apps/server/src/index.js');
check('① 不把请求体读进内存（没有 readBodyBuffer / parseMultipartFormData）',
  !/readBodyBuffer|parseMultipartFormData/.test(routeCode));
check('① 流式落盘：边写边算 sha256（createWriteStream + createHash）',
  /createWriteStream/.test(route) && /createHash\('sha256'\)/.test(route) && /hash\.update\(chunk\)/.test(route));
check('① 有背压（写不动就 pause，否则内存还是会被撑起来）', /req\.pause\(\)/.test(route) && /out\.on\('drain'/.test(route));
check('① 同目录 rename 落定（客户端永远看不到半份包）', /await rename\(temp, target\)/.test(route));
const hookIndex = index.indexOf('await handleClientInstallerUpload(ctx, req, res)');
const bodyIndex = index.indexOf("if (bodyMethods.has(ctx.method))");
check('① ⭐ 挂载点在"读 body"之前（否则就白流式了）', hookIndex > 0 && bodyIndex > 0 && hookIndex < bodyIndex,
  `hook=${hookIndex} body=${bodyIndex}`);
check('① 权限用的是 ADMIN_AUDIT（能改更新策略的人才能发包）', /requirePlatformPermission\(ctx, 'ADMIN_AUDIT'\)/.test(route));
// 2026-09-28：客户端要发 macOS 的 DMG（500MB+）。上传上限必须覆盖得住 ——
// 生产上 nginx 那条 `client_max_body_size 800m` 是另一道闸，两边要一起看（见 §五十一）。
{
  const ceiling = /:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(routeCode);
  const mb = ceiling ? Number(ceiling[1]) : 0;
  check(`① ⭐ 安装包默认上限覆盖得住 500MB+ 的 DMG（当前 ${mb}MB；调小到 500 以下这条会红）`, mb >= 500, String(mb));
}

/* ② 文件名契约（纯函数，先离线钉） */
console.log('② 文件名契约');
const { parseClientInstallerName } = await import('../apps/server/src/services/clientUpdateManifest.js');
const good = [['lingdong-client-0.1.7-alpha.2.3-win-x64.exe', '0.1.7-alpha.2.3', 'win-x64'], ['lingdong-client-1.0.0-mac-arm64.dmg', '1.0.0', 'mac-arm64']];
for (const [name, version, platform] of good) {
  let parsed = null;
  try { parsed = parseClientInstallerName(name); } catch { /* 下面断言 */ }
  check(`② 认得出 ${name}`, parsed?.version === version && parsed?.platform === platform, JSON.stringify(parsed));
}
for (const name of ['客户端.exe', 'lingdong-client-win-x64.exe', 'lingdong-client-1.0.0-win-x64.exe.bak', 'lingdong-client-abc-win-x64.exe', 'lingdong-client-1.0.0-linux-x64.exe']) {
  let threw = false;
  try { parseClientInstallerName(name); } catch { threw = true; }
  check(`② 不合规的名字直接拒：${name}`, threw);
}

/* ③④⑤ 真服务 */
console.log('③ 真服务：上传 → 落盘 → 写清单');
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
// 先造一份"后台配过的策略"，验它不会被发布这一写抹掉
const { updateClientUpdateManifest } = await import('../apps/server/src/services/clientUpdateManifest.js');
const macEntry = { name: 'lingdong-client-0.1.6-alpha.2-mac-arm64.dmg', size: 42, sha256: 'd'.repeat(64) };
fs.writeFileSync(manifest, `${JSON.stringify({ version: '0.1.6-alpha.2', channel: 'stable', enabled: true, mandatory: false, minVersion: '', note: '', files: { 'win-x64': { name: 'lingdong-client-0.1.6-alpha.2-win-x64.exe', size: 100, sha256: 'c'.repeat(64) }, 'mac-arm64': macEntry } }, null, 2)}\n`);
updateClientUpdateManifest({ enabled: true, mandatory: true, minVersion: '0.1.6-alpha.2', note: 'P146 发布的说明', channel: 'beta' }, baseEnv);

const port = 19146;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 等起来 */ } await new Promise((r) => setTimeout(r, 100)); }
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'root', password: 'admin123', clientType: 'admin' }),
  });
  const token = (await login.json().catch(() => ({})))?.data?.token;
  assert.ok(token, '平台超管登录失败');

  // 2MB 以内的假安装包（内容不必是真 exe：这条链只看字节与哈希）
  const payload = Buffer.alloc(1536 * 1024);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) % 251;
  const digest = createHash('sha256').update(payload).digest('hex');
  const name = 'lingdong-client-9.9.9-win-x64.exe';
  const post = (fileName, body, headers = {}) => fetch(`${base}/api/admin/client-update/upload?name=${encodeURIComponent(fileName)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}`, ...headers },
    body,
  });

  const uploaded = await post(name, payload);
  const uploadedBody = await uploaded.json().catch(() => ({}));
  check('③ 上传返回 200', uploaded.status === 200, `HTTP ${uploaded.status} ${JSON.stringify(uploadedBody).slice(0, 160)}`);
  const onDisk = path.join(downloads, name);
  const diskBytes = fs.existsSync(onDisk) ? fs.readFileSync(onDisk) : null;
  check('③ 字节完整落盘（和发出去的一模一样）', Boolean(diskBytes) && diskBytes.equals(payload), diskBytes ? `${diskBytes.length} vs ${payload.length}` : '文件不在');
  check('③ 没有留下 .uploading-* 临时文件', fs.readdirSync(downloads).every((f) => !f.includes('.uploading-')), fs.readdirSync(downloads).join(','));
  const written = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  check('③ ⭐ 清单四项齐全（版本 / 文件名 / 字节数 / sha256）—— 少一样客户端就不认',
    written.version === '9.9.9' && written.files['win-x64'].name === name
    && written.files['win-x64'].size === payload.length && written.files['win-x64'].sha256 === digest,
    JSON.stringify(written.files?.['win-x64'] || {}).slice(0, 200));
  check('③ sha256 与独立算的一致', written.files['win-x64'].sha256 === digest);
  check('③ 发布时间写上了（客户端与后台都要看）', Boolean(written.publishedAt) && Boolean(written.updatedAt), String(written.publishedAt));
  check('④ ⭐ 后台配过的策略字段没被这一写抹掉（enabled/mandatory/minVersion/note/channel）',
    written.enabled === true && written.mandatory === true && written.minVersion === '0.1.6-alpha.2'
    && written.note === 'P146 发布的说明' && written.channel === 'beta',
    JSON.stringify({ enabled: written.enabled, mandatory: written.mandatory, minVersion: written.minVersion, note: written.note, channel: written.channel }));
  check('④ 清单里别的平台条目原样留着（这次发 win，原来的 mac 条目一个字节都不许动）',
    JSON.stringify(written.files['mac-arm64']) === JSON.stringify(macEntry), JSON.stringify(written.files['mac-arm64']));

  /* ⑥ 2026-09-28：Mac 包（.dmg）走同一条路 —— 这次发布就是它。 */
  const macPayload = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < macPayload.length; i += 1) macPayload[i] = (i * 17) % 249;
  const macDigest = createHash('sha256').update(macPayload).digest('hex');
  const macName = 'lingdong-client-9.9.9-mac-arm64.dmg';
  const macUpload = await post(macName, macPayload);
  const macBody = await macUpload.json().catch(() => ({}));
  check('⑥ 上传 macOS 的 .dmg → 200（同一条路，文件名契约认它）',
    macUpload.status === 200, `HTTP ${macUpload.status} ${JSON.stringify(macBody).slice(0, 160)}`);
  const afterMac = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  check('⑥ mac-arm64 条目四项齐全（版本 / 文件名 / 字节数 / sha256）',
    afterMac.files['mac-arm64'].name === macName && afterMac.files['mac-arm64'].size === macPayload.length
    && afterMac.files['mac-arm64'].sha256 === macDigest, JSON.stringify(afterMac.files['mac-arm64']).slice(0, 200));
  check('⑥ 这次反过来：win 的条目一个字节都不许动',
    afterMac.files['win-x64'].name === name && afterMac.files['win-x64'].sha256 === digest,
    JSON.stringify(afterMac.files['win-x64']).slice(0, 200));
  {
    const { readClientUpdateManifest } = await import('../apps/server/src/services/clientUpdateManifest.js');
    const view = readClientUpdateManifest(baseEnv);
    // ⚠️ 客户端团队 2026-09-28 的硬约束：双端必须同版本。后台页面就靠 `stale` 判"两边对齐了没有"。
    check('⑥ ⭐ 双端同版本发完之后 stale 为空（没对齐的话 Windows 会反复提示更新）',
      Array.isArray(view.stale) && view.stale.length === 0, JSON.stringify(view.stale));
    check('⑥ 后台读得到两个平台（同一份清单里 Win/Mac 的名字与 SHA256 都要有）',
      view.files?.['win-x64']?.sha256 === digest && view.files?.['mac-arm64']?.sha256 === macDigest,
      JSON.stringify(view.files || {}).slice(0, 200));
  }

  const badName = await post('lingdong-client-win-x64.exe', Buffer.from('x'));
  check('② 不合规的文件名 → 400（不是 500，也不是默默收下）', badName.status === 400, `HTTP ${badName.status}`);
  check('② 拒掉之后清单没变', JSON.parse(fs.readFileSync(manifest, 'utf8')).version === '9.9.9');

  const tooBig = await post('lingdong-client-9.9.10-win-x64.exe', Buffer.alloc(3 * 1024 * 1024));
  check('⑤ 超过上限的包被拒（上限调成了 2MB，发 3MB）', tooBig.status === 400 || tooBig.status === 413, `HTTP ${tooBig.status}`);
  check('⑤ 超限不留半份文件', !fs.existsSync(path.join(downloads, 'lingdong-client-9.9.10-win-x64.exe')));

  const anonymous = await fetch(`${base}/api/admin/client-update/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload,
  });
  check('⑤ 没登录 → 401/403（这条路由不能是敞开的）', anonymous.status === 401 || anonymous.status === 403, `HTTP ${anonymous.status}`);
} finally {
  server.kill();
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 上库文件可能还被占着 */ }
}

if (failures) { console.log(`\nP146 有 ${failures} 项未通过`); if (serverLog) console.log(serverLog.slice(-1500)); process.exitCode = 1; }
else console.log('P146 客户端安装包上传：流式落盘、sha256、清单四项齐全、策略不丢、名字与权限都拦住 通过');
