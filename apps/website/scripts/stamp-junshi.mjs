/**
 * 给 `/junshi/` 的两个外链脚本打内容版本号（发布后置步骤，在 vite build 之后跑）。
 *
 * 为什么需要它：nginx 的 `location ^~ /assets/` 是 **expires 7d**（见 deploy/production/nginx-site.conf），
 * 而 `/junshi/` 的脚本是**手工维护的非哈希文件** —— 浏览器会把旧版缓存最多 7 天，
 * 表现是「服务器上明明是新的、页面还是旧行为」，极难自查（2026-10-15 实测踩到：
 * 接口全 200、脚本内容也是新的，只有页面不加载数据，因为浏览器用的是缓存里那份旧脚本）。
 * nginx 那段注释早就写了这条口径：「手工素材换了要改名」。这里用**内容哈希当查询参数**
 * 达成同一件事 —— 内容一变 URL 就变，等于自动改名，而且不用每次手工去改文件名。
 *
 * 做法：读 dist 里两个文件的 sha256 前 10 位，替换掉 HTML 里的 `__STAMP__` 占位符。
 * ⚠️ 只用 dist 里的产物算哈希，不改源码（源码里的占位符保持原样，免得构建把工作区弄脏）。
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(appRoot, 'dist', 'junshi');
const assets = path.join(appRoot, 'dist', 'assets', 'junshi');

const htmlPath = path.join(dist, 'index.html');
let html = await readFile(htmlPath, 'utf8');

if (!html.includes('__STAMP__')) {
  console.error('[junshi] dist/junshi/index.html 里没有 __STAMP__ 占位符 —— 脚本引用是不是被改过了？');
  process.exit(1);
}

async function stamp(file) {
  const buf = await readFile(path.join(assets, file));
  return createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

const stampValue = [
  await stamp('prototype.js'),
  await stamp('lucide-1.17.0.js'),
].join('');

// 两个脚本各带自己的哈希：改动 prototype.js 不必让 600KB 的图标库一起失效
const proto = await stamp('prototype.js');
const lucide = await stamp('lucide-1.17.0.js');
html = html
  .replace('/assets/junshi/lucide-1.17.0.js?v=__STAMP__', `/assets/junshi/lucide-1.17.0.js?v=${lucide}`)
  .replace('/assets/junshi/prototype.js?v=__STAMP__', `/assets/junshi/prototype.js?v=${proto}`);

await writeFile(htmlPath, html);
console.log(`[junshi] 已打版本号 prototype=${proto} lucide=${lucide}（合计 ${stampValue.length}）`);
