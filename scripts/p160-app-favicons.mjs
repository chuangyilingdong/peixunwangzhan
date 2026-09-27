/**
 * P160 三端都要有浏览器图标（favicon）—— 2026-09-28 用户报「浏览器的图标现在都没有logo」。
 *
 * 现场：三端 index.html **一条 icon 声明都没有**，public/ 里也没有图标文件；于是浏览器按默认规矩
 * 去要 `/favicon.ico`，而那条路径落进了 SPA 的兜底（`try_files … /index.html`）——
 * **返回的是 `Content-Type: text/html` 的 index.html（实测 2894 字节）**。
 * 浏览器拿到一坨 HTML 当图标，只能显示成缺省图标：这就是用户看到的"没有 logo"。
 *
 * 图标怎么来的：**用官方那张横排字标**（`apps/website/public/assets/lingdong-ai-logo.webp`）缩放到
 * 正方形画布里居中（透明留白），没有另造标志 —— 与 `deploy/dsh-student/rebrand.mjs` 给学生环境
 * 换 favicon 的做法同一路数。三个文件：
 *   · `favicon.png` —— 256×256，透明留白（标签页用；画布正方形，免得各家浏览器拉伸不一致）
 *   · `favicon.ico` —— 64×64 PNG 载荷（给那些不管声明、直接来要 `/favicon.ico` 的地方）
 *   · `apple-touch-icon.png` —— 180×180、**白底**（iOS 加桌面：透明底会被它铺成黑的）
 *
 * 这个守卫钉四件事：① 三端都声明了；② 三个文件真的在（且是真 PNG/ICO，不是 HTML 兜底）；
 * ③ favicon.png 画布是正方形；④ **三端的这三份文件逐字节一致**（改一处忘了另两处 = 三端图标不一样）。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file));
const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const APPS = ['website', 'admin', 'org'];
const ICONS = ['favicon.png', 'favicon.ico', 'apple-touch-icon.png'];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 读 PNG 的 IHDR 拿宽高（不引图片库：前 24 字节就够）。 */
function pngSize(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

console.log('① 三端 index.html 都声明了图标');
for (const app of APPS) {
  const html = readText(`apps/${app}/index.html`);
  check(`${app}：声明了 PNG 图标（<link rel="icon" type="image/png">）`,
    /<link[^>]+rel="icon"[^>]+type="image\/png"[^>]*>/.test(html), html.slice(0, 160));
  check(`${app}：声明了 apple-touch-icon（iOS 加桌面用）`, /rel="apple-touch-icon"/.test(html));
  check(`${app}：还给了 .ico 兜底（不管声明的老地方直接来要 /favicon.ico）`, /rel="icon"[^>]+\.ico/.test(html));
}

console.log('② 图标文件在（而且必须是真图，不能是 SPA 兜底返回的 HTML）');
for (const app of APPS) {
  for (const name of ICONS) {
    const file = path.join(root, `apps/${app}/public/${name}`);
    if (!fs.existsSync(file)) { check(`${app}/${name} 存在`, false, '文件不在'); continue; }
    const buffer = read(`apps/${app}/public/${name}`);
    const looksHtml = buffer.subarray(0, 15).toString('latin1').toLowerCase().includes('<!doctype');
    check(`${app}/${name} 是真图（${buffer.length} 字节）`, !looksHtml && buffer.length > 100);
  }
}

console.log('③ favicon.png 画布是正方形（非正方形各家浏览器拉伸不一致）');
{
  const size = pngSize(read('apps/website/public/favicon.png'));
  check('favicon.png 是合法 PNG 且宽高相等', Boolean(size) && size.width === size.height, JSON.stringify(size));
  const touch = pngSize(read('apps/website/public/apple-touch-icon.png'));
  check('apple-touch-icon.png 是合法 PNG 且宽高相等', Boolean(touch) && touch.width === touch.height, JSON.stringify(touch));
  const ico = read('apps/website/public/favicon.ico');
  check('favicon.ico 头是对的（00 00 01 00 = ICON 容器）',
    ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1, ico.subarray(0, 6).toString('hex'));
  check('favicon.ico 里嵌的是 PNG（现代浏览器与 Windows 都认）',
    ico.subarray(22, 30).equals(PNG_MAGIC), ico.subarray(22, 30).toString('hex'));
}

console.log('④ 三端这三份文件逐字节一致（改一处忘另两处 = 三端图标不一样）');
for (const name of ICONS) {
  const base = read(`apps/website/public/${name}`);
  for (const app of ['admin', 'org']) {
    const other = read(`apps/${app}/public/${name}`);
    check(`${app}/${name} 与 website 那份一致`, base.equals(other), `${base.length} vs ${other.length}`);
  }
}

if (failures) {
  console.error(JSON.stringify({ name: 'p160-app-favicons', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p160-app-favicons', pass: true }, null, 1));
