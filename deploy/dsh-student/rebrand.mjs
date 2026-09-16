/**
 * 构建期：把 dsh 自带的品牌痕迹换成「灵动ai」（学生只看得到灵动ai）。
 *
 * 换三处：
 *   ① 客户端 bundle 里写死的品牌串（页面标题、关于面板、内测公告文案…）；
 *   ② 前端的 index.html（<title>）与 manifest（装到桌面时的名字）；
 *   ③ favicon：换成我们的品牌图（用 SVG 内嵌 PNG，保持官方那一行 link 不用改）。
 *
 * 只替换**品牌串**，不动 dsh 的包名/路径/标识符 —— 那些是代码，不是给学生看的东西。
 * 用法：node rebrand.mjs <品牌图.png>
 */
import fs from 'node:fs';
import path from 'node:path';

const BRAND = process.env.BRAND_NAME || '灵动ai';
const logoPath = process.argv[2];
if (!logoPath || !fs.existsSync(logoPath)) {
  console.error('[rebrand] 需要品牌图路径：node rebrand.mjs <logo.png>');
  process.exit(1);
}
const logoBytes = fs.readFileSync(logoPath);
const logoDataUrl = `data:image/png;base64,${logoBytes.toString('base64')}`;

// 要改的文件根：dsh 自带的、以及 profile 里第三方插件的客户端 bundle（它们也可能带品牌串）
const DSH_ROOT = '/opt/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const PROFILE_ROOT = `${process.env.DSH_HOME || '/home/student/.dsh'}/profiles/web/node_modules`;

// 品牌串 → 灵动ai。只列**会出现在界面上**的写法，
// 「DeepSeek Harness」是官方产品名，出现在标题/关于/公告里。
const REPLACEMENTS = [
  ['DeepSeek Harness', BRAND],
  ['Deepseek Harness', BRAND],
  ['deepseek harness', BRAND],
];

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, out);
    } else if (/\.(js|mjs|cjs|html|webmanifest|json|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

let changed = 0;
for (const file of [...walk(DSH_ROOT), ...walk(PROFILE_ROOT)]) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (!REPLACEMENTS.some(([from]) => source.includes(from))) continue;
  let next = source;
  for (const [from, to] of REPLACEMENTS) next = next.split(from).join(to);
  if (next !== source) {
    fs.writeFileSync(file, next);
    changed += 1;
  }
}
console.log(`[rebrand] 品牌串：改了 ${changed} 个文件`);

// 「DSH」这三个字母还会出现在**发给模型的运行环境说明**里（"Current DSH file policy: …"），
// 模型偶尔会把它原样复述给学生看。这里只替换这些**散文短语**（后面跟的是小写单词的那些），
// 不碰 DSH_HOME 这类标识符与路径 —— 那才是会被改坏的地方。
const DSH_PHRASES = /\bDSH (home|file|tool|session|process|restart|plugin|objects|itself|has|sandbox)\b/g;
let dshTouched = 0;
for (const file of [...walk(DSH_ROOT), ...walk(PROFILE_ROOT)]) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (!DSH_PHRASES.test(source)) continue;
  DSH_PHRASES.lastIndex = 0;
  const next = source.replace(DSH_PHRASES, `${BRAND} $1`);
  if (next !== source) {
    fs.writeFileSync(file, next);
    dshTouched += 1;
  }
}
console.log(`[rebrand] 运行环境说明里的 DSH 字样：改了 ${dshTouched} 个文件`);

// 欢迎页那两句（用户 2026-09-16 口径：**并成一句**「小灵ai陪你VibeCoding」）：
//   · hero.headline 是原来那句标语，换成我们自己的；
//   · hero.preview 是「预览版」角标，**内容清空 + 用 CSS 把它藏掉**（角标是装饰，留着空胶囊难看）。
// 用正则按**键名**替换而不是写死原文：dsh 升级改了文案也不会漏改。
const HERO_COPY = [
  [/("hero\.headline"\s*:\s*)"[^"]*"/g, '$1"小灵ai陪你VibeCoding"'],
  [/("hero\.preview"\s*:\s*)"[^"]*"/g, '$1""'],
];
// 角标那个 class 的哈希名不同版本会变，所以按「_previewBadge{」这个后缀匹配 CSS 规则
const BADGE_CSS = /(\.[A-Za-z0-9_-]*_previewBadge\s*\{)/g;
let heroTouched = 0;
for (const file of [...walk(DSH_ROOT), ...walk(PROFILE_ROOT)]) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
  let next = source;
  for (const [pattern, replacement] of HERO_COPY) next = next.replace(pattern, replacement);
  next = next.replace(BADGE_CSS, '$1display:none;');
  if (next !== source) {
    fs.writeFileSync(file, next);
    heroTouched += 1;
  }
}
console.log(`[rebrand] 欢迎页文案与角标：改了 ${heroTouched} 个文件`);

// 启动画面那个字标：boot card 的 `wordmark` 默认值是**独立的 "HARNESS"**，
// 不在 "DeepSeek Harness" 整串里，所以按整串替换抓不到它（实测：加载页露出 HARNESS）。
const BOOT_WORDMARK = [/wordmark\s*,\s*"HARNESS"/g, `wordmark,"${BRAND}"`];
let bootTouched = 0;
for (const file of [...walk(DSH_ROOT), ...walk(PROFILE_ROOT)]) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (!source.includes('"HARNESS"')) continue;
  const next = source.replace(BOOT_WORDMARK[0], BOOT_WORDMARK[1]);
  if (next !== source) { fs.writeFileSync(file, next); bootTouched += 1; }
}
console.log(`[rebrand] 启动画面的字标：改了 ${bootTouched} 个文件`);

// 前端入口与 favicon
const dist = path.join(DSH_ROOT, 'dsh-web-frontend', 'dist');
if (fs.existsSync(dist)) {
  const indexPath = path.join(dist, 'index.html');
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    fs.writeFileSync(indexPath, html.replace(/<title>[^<]*<\/title>/, `<title>${BRAND}</title>`));
    console.log('[rebrand] index.html 标题已改');
  }
  const manifestPath = path.join(dist, 'manifest.webmanifest');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.name = BRAND;
    manifest.short_name = BRAND;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('[rebrand] manifest 名称已改');
  }
  // favicon：内嵌我们的品牌图（保持 image/svg+xml 的类型，link 不用改）
  const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 240" width="480" height="240">`
    + `<image href="${logoDataUrl}" width="480" height="240"/></svg>\n`;
  fs.writeFileSync(path.join(dist, 'favicon.svg'), favicon);
  console.log('[rebrand] favicon 已换成品牌图');
}

// 内测公告：官方那段面向 Harness 开发者的公告，镜像里已经预置成「已读」（见 Dockerfile），
// 这里顺手把文案本身也换掉，万一以后有人把版本号改回去也不会露出官方名字。
const settingsModels = path.join(DSH_ROOT, 'dsh-client-ui-settings-models', 'lib', 'client.js');
if (fs.existsSync(settingsModels)) {
  const source = fs.readFileSync(settingsModels, 'utf8');
  const next = source.split('Harness developers').join('灵动ai 开发者').split('DSH').join(BRAND);
  if (next !== source) {
    fs.writeFileSync(settingsModels, next);
    console.log('[rebrand] 内测公告文案已改');
  }
}
