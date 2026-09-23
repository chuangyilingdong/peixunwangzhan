#!/usr/bin/env node
/**
 * 11 · 把**公开内容**（广场媒体的图片视频 + 客户端安装包）搬进 OSS。
 *
 * 为什么搬这两样：它们是吃满这台 5 Mbps 出口的大头 ——
 *   · 广场媒体 1.7G（`ltai-works` 的图/视频），每个页面都要取
 *   · 客户端安装包 373M，5 Mbps 下一个用户要下 10 分钟；客户端修好后会有一波**集中下载**，
 *     不搬的话那波会把整台机出口堵死
 *
 * 【关键：**没有**给 bucket 开公开读】
 *   这个 bucket 里同时放着**私有课件**，所以它开着「阻止公共访问」—— 那是负责任的默认设置，
 *   任何公开读策略都会被拒（实测 AccessDenied + 「已开启阻止公共访问」提示）。
 *   于是改成：**bucket 全私有，由平台签发临时地址**（见 routes/publicAssets.js）。
 *   好处是私有课件更安全、也不用动控制台。
 *
 * 【哪些搬、哪些留】
 *   · 搬：`ltai-works/*`（519 png + 85 mp4 + 72 jpg + …，纯媒体，用 <img>/<video> 取，不需要 CORS）
 *   · 搬：`downloads/*`（安装包，下载，不需要 CORS）
 *   · **留本地**：`web-works/*`（21M）—— 那些页面在 null origin 的沙箱 iframe 里按 **CORS 模式**
 *     import ES module，而 OSS 不返回 Access-Control-Allow-Origin，搬过去会整片白屏
 *   · **留本地**：`downloads/manifest.json` —— 客户端更新清单必须"刚发布就读到新的"
 *
 * 用法（服务器上，root）：
 *   cd /srv/ai-kids-platform/source
 *   export $(grep -E '^(FILE_STORAGE|OSS_)' /etc/ai-kids-platform/production.env | xargs)
 *   node deploy/production/migrate/11-publish-public-assets-to-oss.mjs --dry-run
 *   node deploy/production/migrate/11-publish-public-assets-to-oss.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { putObject, headObject, ossConfigured, ossInfo } from '../../../apps/server/src/services/objectStorage.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
};
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force'); // 强制重传（例如类型传错了要刷一遍）
const only = String(arg('--only', '')).trim();

const MEDIA_ROOT = '/srv/ai-kids-platform/public-media';
const DOWNLOAD_ROOT = '/srv/ai-kids-platform/downloads';

if (!ossConfigured()) { console.error('OSS 未配置齐。', JSON.stringify(ossInfo())); process.exit(1); }

const walk = (root) => {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
};

/**
 * 按扩展名给 Content-Type。
 * ⚠️ **必须在传的时候给对**：阿里云不允许在签名 URL 上覆盖 content-type（会 400），
 * 所以对象存的是什么类型，浏览器拿到的就是什么类型。第一批我全按 octet-stream 传了，
 * 结果图片拿到 `application/octet-stream` —— 这就是为什么要能 --force 重传。
 */
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8', mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8',
};
const contentTypeFor = (name) => TYPES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

console.log(`公开内容 → OSS${dryRun ? '（dry-run，不写任何东西）' : ''}`);
console.log(`  bucket=${ossInfo().bucket}  prefix=${ossInfo().prefix || '(无)'}`);

const jobs = [];
if (!only || only === 'media') jobs.push({ name: '广场媒体', root: MEDIA_ROOT, keyBase: 'public-media', ttl: 'public, max-age=2592000' });
if (!only || only === 'downloads') jobs.push({ name: '客户端安装包', root: DOWNLOAD_ROOT, keyBase: 'downloads', ttl: 'public, max-age=86400' });

let uploaded = 0; let skipped = 0; const failed = [];
for (const job of jobs) {
  if (!fs.existsSync(job.root)) { console.log(`  （跳过 ${job.name}：目录不存在）`); continue; }
  const files = walk(job.root);
  let bytes = 0;
  console.log(`\n${job.name}：${files.length} 个文件`);
  for (const full of files) {
    const rel = path.relative(job.root, full).replaceAll('\\', '/');
    // 留本地的那两类（原因见文件头）
    if (job.keyBase === 'public-media' && rel.startsWith('web-works/')) { skipped += 1; continue; }
    if (job.keyBase === 'downloads' && rel === 'manifest.json') { skipped += 1; continue; }
    const info = fs.statSync(full);
    bytes += info.size;
    if (dryRun) { skipped += 1; continue; }
    const relKey = `${job.keyBase}/${rel}`;
    try {
      // 幂等：已在 OSS 且大小一致就跳过
      if (!force) {
        const head = await headObject(relKey);
        if (head.exists && head.size === info.size) { skipped += 1; continue; }
      }
      await putObject(relKey, fs.readFileSync(full), contentTypeFor(full), { cacheControl: job.ttl });
      uploaded += 1;
      if (uploaded % 50 === 0) console.log(`  …已传 ${uploaded}`);
    } catch (error) {
      failed.push([relKey, error.message]);
    }
  }
  console.log(`  合计 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

console.log(`\n结果：新上传 ${uploaded}，跳过（已一致或按规则留本地）${skipped}，失败 ${failed.length}`);
for (const [k, why] of failed.slice(0, 10)) console.log(`  ✗ ${k}  ${why}`);

if (dryRun) { console.log('\ndry-run 结束，未传任何东西。'); process.exit(0); }

console.log('\n下一步：nginx 已配置为「/media/ 与 /downloads/ 交给应用决定」+ 两个 internal 兜底 location。');
console.log('验收：');
console.log('  curl -sI https://aicyld.com/media/ltai-works/100/<某张图>   # 期望 302 到 oss-cn-guangzhou');
console.log('  curl -s  -L -o /dev/null -w \'%{http_code} %{size_download}\\n\' <同一个地址>  # 期望 200 且大小对');
console.log('  curl -sI https://aicyld.com/media/web-works/<某文件>       # 期望 200（走本地，带 CORS 头）');
process.exit(failed.length === 0 ? 0 : 1);
