/**
 * P156 「联系我们」页改成联系方式展示（2026-09-27 用户口径）。
 *
 * 用户原话：「图2 联系我们的页面重做，直接显示姓名电话微信二维码。后台可配置。」
 *
 * 钉住四件事：
 *   ① **CMS 区块真的注册了**（`CONTACT` 在 `WEBSITE_CONTENT_KEYS` 里）—— 没注册的话后台存不进、
 *      公开端也读不到（会静默退回兜底，运营会以为"改了没生效"）；
 *   ② **三处默认值逐字一致**：`packages/shared/src/siteDefaults.js` 的 `CONTACT_DEFAULT`、
 *      `packages/database/src/websiteContentDefaults.js` 的 `CONTACT`、
 *      官网 `CMS_FALLBACK.CONTACT` —— 不一致就会"后台看着空、官网却有内容"（p135/p142/p147 同一条纪律）；
 *   ③ **页面是展示而不是表单**：读 `useWebsiteContent('CONTACT')`、电话走 `tel:`、二维码是 `<img>`、
 *      而且**没有 `<form>`**（用户明确要"直接显示"）；
 *   ④ **后台能配**：`官网内容` 里有「联系我们」这一档，并且能直接**上传二维码图片**（写回 wechatQrUrl）。
 *
 * 另外一条真请求：公开端 `GET /api/public/website-content/CONTACT` 必须能返回这一块
 * （没行时返回内置默认）—— 这是"后台改完官网真能读到"的最小证据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p156-contact-'));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('① CMS 区块注册与三处默认值');
{
  const keys = read('apps/server/src/services/websiteContentKeys.js');
  check('CONTACT 是注册过的官网内容区块（否则后台存不进、公开端读不到）', /'CONTACT'/.test(keys));
  const shared = read('packages/shared/src/siteDefaults.js');
  const seed = read('packages/database/src/websiteContentDefaults.js');
  const site = read('apps/website/src/main.jsx');
  const pick = (source, name) => {
    const start = source.indexOf(name);
    if (start < 0) return null;
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(open, i + 1); }
    }
    return null;
  };
  const a = pick(shared, 'CONTACT_DEFAULT');
  const b = pick(seed, 'CONTACT:');
  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  check('shared 的 CONTACT_DEFAULT 与种子默认 CONTACT 逐字一致', Boolean(a) && norm(a) === norm(b), `${norm(a)} vs ${norm(b)}`);
  check('官网 CMS_FALLBACK.CONTACT 与同一份默认值同源', /CONTACT: CONTACT_DEFAULT,/.test(site));
  check('默认值里三件事齐了（name / phone / wechatQrUrl）', ['name', 'phone', 'wechatQrUrl'].every((key) => new RegExp(`${key}:`).test(String(a))));
}

console.log('② 页面是「展示」不是「表单」');
{
  const site = read('apps/website/src/main.jsx');
  const start = site.indexOf('function Demo(){');
  const block = start < 0 ? '' : site.slice(start, site.indexOf('---- Marketplace ----', start));
  check('读的是 CONTACT 这一块 CMS 内容', /useWebsiteContent\('CONTACT'\)/.test(block));
  check('联系电话是 tel: 可点（手机上一点就拨）', /href=\{`tel:\$\{phone\}`\}/.test(block));
  check('二维码是 <img>（可长按/扫码保存），空时给「待上传」占位', /<img src=\{qr\}/.test(block) && /微信二维码待上传/.test(block));
  check('⭐ 页面上**没有表单**了（用户口径：直接显示，不是让访客填表）', !/<form/.test(block) && !/onSubmit/.test(block));
  check('官方数字不再写死「11 门 / 87 节」（那条对外数字自相矛盾的待办里点过名）', !/11 门|87 节/.test(block));
  const css = read('apps/website/src/styles.css');
  check('联系卡的样式在（.contact-card / .contact-qr）', /\.contact-card\{/.test(css) && /\.contact-qr\{/.test(css));
}

console.log('③ 后台可配（含二维码上传）');
{
  const shared = read('apps/admin/src/shared.jsx');
  const editor = read('apps/admin/src/pages/WebsiteContent.jsx');
  check('后台侧栏/内容区块里有「联系我们」这一档', /CONTACT: '联系我们'/.test(shared));
  check('后台有 CONTACT 的表单块（姓名 / 电话 / 二维码 / 说明）',
    /selectedKey === 'CONTACT' &&/.test(editor)
    && /updateStructured\(\{ name: event\.target\.value \}\)/.test(editor)
    && /updateStructured\(\{ phone: event\.target\.value \}\)/.test(editor)
    && /updateStructured\(\{ wechatQrUrl: url \}\)/.test(editor));
  check('二维码能直接上传（走与机构手册同一条 uploadImage 路）', /uploadImage\(file, \(url\) => updateStructured\(\{ wechatQrUrl: url \}\), 'contact-qr'\)/.test(editor));
}

console.log('④ 真请求：公开端能读到这一块');
{
  const baseEnv = {
    ...process.env,
    PLATFORM_DATA_DIR: temp,
    PLATFORM_DB_PATH: path.join(temp, 'platform.db'),
    DEPLOYMENT_MODE: 'local-mock',
  };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (x) => { err += x; });
    child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
  });
  const port = 19156;
  const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (x) => { log += x; });
  server.stderr.on('data', (x) => { log += x; });
  try {
    await run(['packages/database/src/db.js', '--init']);
    await run(['packages/database/src/seed.js']);
    for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await new Promise((r) => setTimeout(r, 100)); }
    const response = await fetch(`http://127.0.0.1:${port}/api/public/website-content/CONTACT`);
    const payload = await response.json().catch(() => ({}));
    const content = payload?.data?.content ?? payload?.data ?? null;
    check('GET /api/public/website-content/CONTACT 返回 200 且带这一块的字段',
      response.status === 200 && content && Object.hasOwn(content, 'wechatQrUrl'),
      `HTTP ${response.status} ${JSON.stringify(content).slice(0, 160)}`);
    const missing = await fetch(`http://127.0.0.1:${port}/api/public/website-content/NOT_A_KEY`);
    check('没注册的键取不到（说明这是白名单，不是任意读）', ![200].includes(missing.status), `HTTP ${missing.status}`);
  } catch (error) {
    failures += 1;
    console.error(log.slice(-1200));
    console.error('真请求段异常：', error.message);
  } finally {
    server.kill('SIGKILL');
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 交给系统清理 */ }
  }
}

if (failures) {
  console.error(JSON.stringify({ name: 'p156-contact-us-page', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p156-contact-us-page', pass: true }, null, 1));
