/**
 * 给 `/junshi/` 的外链脚本打内容版本号（发布后置步骤，在 vite build 之后跑）。
 *
 * 为什么需要它：nginx 的 `location ^~ /assets/` 是 **expires 7d**（见 deploy/production/nginx-site.conf），
 * 而 `/junshi/` 的脚本是**手工维护的非哈希文件** —— 浏览器会把旧版缓存最多 7 天，
 * 表现是「服务器上明明是新的、页面还是旧行为」，极难自查（2026-10-15 实测踩到：
 * 接口全 200、脚本内容也是新的，只有页面不加载数据，因为浏览器用的是缓存里那份旧脚本）。
 * nginx 那段注释早就写了这条口径：「手工素材换了要改名」。这里用**内容哈希当查询参数**
 * 达成同一件事 —— 内容一变 URL 就变，等于自动改名，而且不用每次手工去改文件名。
 *
 * ⚠️ 只用 dist 里的产物算哈希，不改源码（源码里的占位符保持原样，免得构建把工作区弄脏）。
 * ⚠️ 2026-10-15 起页面只剩一个外链脚本：图标改成内联 SVG sprite 了
 *    （见 junshi/index.html 里的 sprite），600KB 的图标库 JS 已经删掉。
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(appRoot, 'dist', 'junshi', 'index.html');
// 需要打版本号的外链资源（都在 dist/assets/junshi/ 下）：脚本 + 字体声明。
// 字体 CSS 不常改，但同样躺在 /assets/ 的 7 天强缓存里，走同一套内容哈希最省心。
const assets = ['prototype.js', 'fonts.css'];

let html = await readFile(htmlPath, 'utf8');
if (!html.includes('__STAMP__')) {
  console.error('[junshi] dist/junshi/index.html 里没有 __STAMP__ 占位符 —— 脚本引用是不是被改过了？');
  process.exit(1);
}

const stamps = [];
for (const file of assets) {
  const buf = await readFile(path.join(appRoot, 'dist', 'assets', 'junshi', file));
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const from = `/assets/junshi/${file}?v=__STAMP__`;
  if (!html.includes(from)) {
    console.error(`[junshi] index.html 里找不到 ${from}`);
    process.exit(1);
  }
  html = html.replace(from, `/assets/junshi/${file}?v=${hash}`);
  stamps.push(`${file}=${hash}`);
}

// 兜底：不该再有别的 __STAMP__ 残留（残留会让那个文件永远拿旧缓存）
if (html.includes('__STAMP__')) {
  console.error('[junshi] index.html 里还有没替换的 __STAMP__ 占位符');
  process.exit(1);
}

await writeFile(htmlPath, html);
console.log(`[junshi] 已打版本号 ${stamps.join(' ')}`);
