/**
 * P155 官网首页「扫码访问」二维码（2026-09-27 用户口径）。
 *
 * 用户原话：「官网首页做个二维码出来，微信扫码可以打开官网首页」。
 *
 * 为什么值得一张网：二维码是**自己实现的**（仓库不引依赖、也不许把站址发给二维码服务，
 * 见 `p147` 那条同样的纪律）。自己写的编码器一旦改坏，肉眼完全看不出来 —— 页面照常显示一张
 * 黑白方阵，只是**扫不出来**。所以这张网钉三件事：
 *
 *   ① **编码器自检**（`qrSelfCheck`）：RS 码字能被生成多项式整除（纠错码的定义）、
 *      格式信息合法、三个定位图案与两条时序图案在位 —— 这些正是解码器用来判坏的性质；
 *   ② **指纹**：对 `https://aicyld.com/` 生成的矩阵做一个 FNV-1a 指纹并钉住。
 *      ⚠️ 这个指纹是**用 jsQR 真解码验证过**的（生成 → 铺成 RGBA → jsQR 解出来 = 原文，
 *      4 个字符串 × L/M 两档共 8 个用例全过，见 §四十二）。所以它不只是"没变"，而是"能扫"。
 *   ③ **别接线**：不许引二维码依赖（`qrcode` 之类）、不许调外站二维码服务（那等于把站址发给第三方）、
 *      首页那一栏要排在对比栏之后、页脚之前，且编的是**当前站点**（`window.location.origin`）而不是写死的域名。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { qrMatrix, qrSelfCheck, formatBits } from '../packages/shared/src/qr.js';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('① 编码器自检（RS / 格式信息 / 定位与时序图案）');
{
  const text = 'https://aicyld.com/';
  const self = qrSelfCheck(text, { ec: 'M' });
  check('RS 码字能被生成多项式整除 + 格式信息合法 + 定位/时序图案在位', self.ok, JSON.stringify(self));
  check('版本与尺寸自洽（v2 → 25×25；v1 → 21×21）',
    self.version === 2 && self.size === 25 && qrMatrix('aicyld.com').size === 21,
    `v${self.version} ${self.size}`);
  // 超长输入要**明确报错**：静默降级会生成一张扫不出内容的码，比报错更糟
  let threw = false;
  try { qrMatrix('x'.repeat(300)); } catch { threw = true; }
  check('超长输入明确抛错（不静默降级成一张扫不出来的码）', threw);
  // 格式信息：15 位、且随 (纠错等级, 掩码) 一一对应（32 个组合互不相同）。
  // 它算得对不对的**真凭据是 jsQR 真解码**（把码解开成原文，说明掩码与纠错等级都对上了）——
  // 这里只钉"没被我改坏"：位数、互异性、已知锚点 (M, 0) = 0x5412（就是那个异或常量本身）。
  check('格式信息是 15 位、32 个组合互不相同，且 (M,0) = 0x5412（标准锚点）',
    formatBits('M', 0) === 0x5412
    && [['L', 0], ['L', 1], ['M', 2], ['Q', 7], ['H', 3]].every(([ec, mask]) => (formatBits(ec, mask) & ~0x7FFF) === 0)
    && new Set(['L', 'M', 'Q', 'H'].flatMap((ec) => [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => formatBits(ec, mask)))).size === 32);
}

console.log('② 指纹（jsQR 真解码验证过的矩阵）');
{
  const text = 'https://aicyld.com/';
  const { modules, size, version, ecLevel, mask } = qrMatrix(text, { ec: 'M' });
  let hash = 0x811c9dc5;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    hash ^= modules[y][x] ? 1 : 0;
    hash = (hash * 0x01000193) >>> 0;
  }
  check('「https://aicyld.com/」的矩阵指纹没变（v2/M，指纹 1397339739）',
    version === 2 && ecLevel === 'M' && size === 25 && hash >>> 0 === 1397339739,
    `v${version}/${ecLevel} ${size}×${size} mask=${mask} 指纹=${hash >>> 0}`);
}

console.log('③ 别接线（不引依赖 / 不调外站 / 站点地址不写死）');
{
  const site = read('apps/website/src/main.jsx');
  const css = read('apps/website/src/styles.css');
  const pkg = read('package.json');
  const qrModule = read('packages/shared/src/qr.js');
  check('没有加二维码依赖（package.json 里不该出现 qrcode/jsqr 之类）',
    !/"(qrcode|qrcode-generator|jsqr|qr-image)"/i.test(pkg));
  // ⚠️ 只认"真去请求外站"的样子（带协议的 URL / 图片地址）；注释里提到服务名不算 ——
  //    第一版用裸词匹配，结果把我自己注释里的「qrserver 之类」也判成了调用。
  check('没有调用外站二维码服务（那等于把站址发给第三方）',
    !/https?:\/\/[a-z0-9.-]*(qrserver|chart\.googleapis|quickchart|qr-code-generator)/i.test(site + css + qrModule)
    && !/src=\{?["'`]https?:\/\/[^"'`]*qr/i.test(site));
  check('编码器不碰网络（只有纯函数，没有 fetch/import 外链）',
    !/\bfetch\(|XMLHttpRequest|import\s+.*from\s+'http/.test(qrModule));
  check('首页那一栏编的是**当前站点**（window.location.origin），不是写死的域名',
    /const url = typeof window === 'undefined' \? '' : `\$\{window\.location\.origin\}\/`;/.test(site)
    && !/QrCode value="https:\/\/aicyld\.com/.test(site));
  check('那一栏排在「对比栏」之后（= 页面最后一屏，不打扰首屏取景）',
    site.indexOf('<HomeCompare') < site.indexOf('<HomeQr />') && site.indexOf('<HomeQr />') > 0);
  check('用共享的 QrCode 组件渲染（不是自己画一张 img / 引外站图片）',
    /import \{[^}]*QrCode[^}]*\} from '@platform\/shared'/.test(site) && /<QrCode value=\{url\}/.test(site));
  check('二维码是 SVG（矢量、放大不糊），且带无障碍标签',
    /shapeRendering="crispEdges"/.test(read('packages/shared/src/qr.jsx'))
    && /role="img"/.test(read('packages/shared/src/qr.jsx')));
  check('本栏样式在（.hp-qr 系列，深色底与页脚/对比栏接得上）',
    /\.hp-qr\{/.test(css) && /\.hp-qr-code\{/.test(css));
}

if (failures) {
  console.error(JSON.stringify({ name: 'p155-home-qr-band', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p155-home-qr-band', pass: true }, null, 1));
