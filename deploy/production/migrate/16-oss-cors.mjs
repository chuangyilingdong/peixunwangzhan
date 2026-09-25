#!/usr/bin/env node
/**
 * 16 · 把桶的 CORS 规则补齐（2026-09-25）。
 *
 * 为什么这是一步**功能**而不是调优：平台从 2026-09-25 起把课件预览也搬到了 OSS
 * （转出来的 PDF 302 到签名地址，见 apps/server/src/routes/fileAssets.js），
 * 而预览是 pdf.js 在浏览器里 `fetch` 回来的 —— 那是**跨域 + CORS 模式**的请求：
 *
 *   · `Accept-Ranges`  → pdf.js 靠它决定"只取需要的页"（一份 106MB 的课件转出来是 100MB 的
 *     PDF，整份下完才出画面 vs 先出第一页，差别就是它）；
 *   · `Content-Range`  → 一旦按段取（206），pdf.js 解析时必须读这个头；读不到直接
 *     `Missing or invalid "Content-Range" header` 并让**整个文档**失败。
 *
 * 原来那条规则只 ExposeHeader 了 ETag / Content-Length（那时候 302 只用于下载与 <img>），
 * 于是这两条都得补上。`AllowedOrigin` 保持**只列我们自己的域名**（桶是私有的，
 * 访问一律要签名；CORS 只是让浏览器肯把响应体交给页面）。
 *
 * 用法（服务器上，root）：
 *   cd /srv/ai-kids-platform/source
 *   export $(grep -E '^(FILE_STORAGE|OSS_)' /etc/ai-kids-platform/production.env | xargs)
 *   node deploy/production/migrate/16-oss-cors.mjs            # 看现状 + 要不要改
 *   node deploy/production/migrate/16-oss-cors.mjs --apply    # 真的写上去
 *   node deploy/production/migrate/16-oss-cors.mjs --apply --origins=https://aicyld.com,https://www.aicyld.com
 *
 * 回滚：把 --rollback-save 存下来的旧 XML 用 `--apply-from=<文件>` 装回去（本脚本默认会在
 *       覆盖前把旧规则存到同目录的 .oss-cors-before-<时间戳>.xml）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getBucketCors, putBucketCors, ossConfigured, ossInfo } from '../../../apps/server/src/services/objectStorage.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
};
const apply = process.argv.includes('--apply');
const applyFrom = arg('--apply-from', '');
const origins = String(arg('--origins', 'https://aicyld.com')).split(',').map((s) => s.trim()).filter(Boolean);
const EXPOSE = ['ETag', 'Content-Length', 'Accept-Ranges', 'Content-Range'];

if (!ossConfigured()) { console.error('OSS 未配置齐。', JSON.stringify(ossInfo())); process.exit(1); }

if (applyFrom) {
  const xml = fs.readFileSync(applyFrom, 'utf8');
  if (!apply) { console.log('（--apply-from 需要同时给 --apply）'); process.exit(1); }
  await putBucketCors(xml);
  console.log(`已把 ${applyFrom} 装回桶上。`);
  process.exit(0);
}

const buildXml = () => `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
${origins.map((o) => `    <AllowedOrigin>${o}</AllowedOrigin>`).join('\n')}
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
${EXPOSE.map((h) => `    <ExposeHeader>${h}</ExposeHeader>`).join('\n')}
    <MaxAgeSeconds>600</MaxAgeSeconds>
  </CORSRule>
  <ResponseVary>true</ResponseVary>
</CORSConfiguration>
`;

console.log(`桶 ${ossInfo().bucket} 的 CORS${apply ? '（--apply，会写入）' : '（只看现状）'}`);
const current = await getBucketCors();
console.log('现状：', current ? JSON.stringify(current.rules) : '(没有规则)');

const missing = EXPOSE.filter((h) => !(current?.rules || []).some((r) => r.exposeHeaders.includes(h)));
if (!current || missing.length) {
  console.log(missing.length ? `缺：${missing.join(', ')}` : '没有规则，需要新建');
  console.log('将写入：\n' + buildXml());
  if (!apply) { console.log('（dry-run：要真的写就加 --apply）'); process.exit(0); }
  if (current) {
    const backup = path.join(process.cwd(), `.oss-cors-before-${new Date().toISOString().replace(/[:.]/g, '')}.xml`);
    fs.writeFileSync(backup, current.xml);
    console.log(`旧规则已存：${backup}（回滚：--apply --apply-from=${backup}）`);
  }
  await putBucketCors(buildXml());
  const after = await getBucketCors();
  console.log('写入后：', JSON.stringify(after.rules));
  process.exit(0);
}
console.log('已经齐了，不动。');
