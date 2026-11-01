#!/usr/bin/env node
/**
 * 把**当前清单引用的**客户端安装包补传到 OSS（2026-11-01）。
 *
 * 为什么要它：`/downloads/**` 的设计是"OSS 有就 302、没有才回本地发"（见 routes/publicAssets.js）。
 * 但 0.2.10 这两个包不在 OSS 上 —— 实测 `/downloads/lingdong-client-0.2.10-win-x64.exe` 返回
 * **200 且没有跳转**，说明每个学生的 151-186MB 下载都在走服务器出口。
 * 换成按流量计费之后这就是真金白银（一个包约 0.3 元/次）。
 *
 * 只传**清单里引用的**那几个：清单之外的旧版本不该有公开可下载地址
 * （nginx 里还专门 404 了几条老包路径，传上去等于把它们又放出来）。
 *
 * 跑法（在生产机上，读 production.env 拿 OSS 凭据）：
 *   node deploy/production/backfill-downloads-to-oss.mjs                  # 干跑，只报要传什么
 *   node deploy/production/backfill-downloads-to-oss.mjs --apply         # 真传
 *   node deploy/production/backfill-downloads-to-oss.mjs --apply --env-file /etc/ai-kids-platform/production.env
 *
 * ⚠️ 传完之后**进程里的"OSS 上有没有"探测缓存还有最多 10 分钟**（PROBE_TTL_MS）——
 *    在那之前请求仍会走本地。等 10 分钟，或下次发布重启后自然生效。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const envFileArg = args.indexOf('--env-file');
const envFile = envFileArg >= 0 ? args[envFileArg + 1] : '';

const DOWNLOAD_DIR = process.env.CLIENT_DOWNLOAD_DIR || '/srv/ai-kids-platform/downloads';
const MANIFEST = process.env.CLIENT_UPDATE_MANIFEST || path.join(DOWNLOAD_DIR, 'manifest.json');

/** 极简 dotenv：只认 KEY=VALUE，忽略注释与空行。够读我们自己的 env 文件。 */
function loadEnv(file) {
  if (!file) return;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { console.error(`读不到 env 文件：${file}`); process.exit(2); }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function human(bytes) {
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
}

loadEnv(envFile);

const { ossConfigured, ossInfo, putObjectFromFile, headObject } = await import('../../apps/server/src/services/objectStorage.js');

if (!ossConfigured()) {
  console.error('OSS 没配齐（OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / 区域或端点）——先把 env 备好');
  process.exit(2);
}
const info = ossInfo();
console.log(`OSS: bucket=${info.bucket} region=${info.region} prefix=${info.prefix || '(无)'}`);
console.log(`清单位置: ${MANIFEST}`);
console.log(`下载目录: ${DOWNLOAD_DIR}`);
console.log(apply ? '模式: **真传**\n' : '模式: 干跑（加 --apply 才真传）\n');

let manifest;
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
catch (error) { console.error(`清单读不出来：${String(error?.message || error)}`); process.exit(2); }

const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
const targets = Object.values(files)
  .map((item) => String(item?.name || '').trim())
  .filter(Boolean);

if (!targets.length) { console.error('清单里没有任何安装包'); process.exit(2); }

let uploaded = 0;
let skipped = 0;
let failed = 0;
let bytesTotal = 0;

for (const name of [...new Set(targets)]) {
  if (name.includes('/') || name.includes('..')) { console.error(`跳过可疑文件名：${name}`); failed += 1; continue; }
  const localPath = path.join(DOWNLOAD_DIR, name);
  let size = 0;
  try { size = fs.statSync(localPath).size; } catch { console.error(`✗ 本地没有这个文件：${name}`); failed += 1; continue; }
  const key = `downloads/${name}`;
  console.log(`· ${name}（${human(size)}）`);

  // 已经在 OSS 上的就跳过：这个脚本可能被反复跑
  let existing = { exists: false, size: 0 };
  try { existing = await headObject(key); } catch { existing = { exists: false, size: 0 }; }
  if (existing.exists && Number(existing.size) === size) {
    console.log(`  = OSS 上已有同大小对象，跳过`);
    skipped += 1;
    continue;
  }

  if (!apply) { console.log(`  → 会传到 OSS：${key}`); continue; }
  try {
    const startedAt = Date.now();
    const result = await putObjectFromFile(key, localPath, 'application/octet-stream', { cacheControl: 'public, max-age=86400', size });
    const cost = Date.now() - startedAt;
    console.log(`  ✓ 已传到 OSS：${result.key}（${human(Number(result.size) || size)}，${cost}ms）`);
    uploaded += 1;
    bytesTotal += Number(result.size) || size;
  } catch (error) {
    console.error(`  ✗ 传失败：${String(error?.message || error).slice(0, 200)}`);
    failed += 1;
  }
}

console.log('');
console.log(`汇总：已传 ${uploaded} 个（${human(bytesTotal)}）· 跳过 ${skipped} 个 · 失败 ${failed} 个`);
if (apply && uploaded > 0) {
  console.log('');
  console.log('⚠️ 进程里的探测缓存还有最多 10 分钟：在那之前 /downloads/ 仍会回本地。');
  console.log('   等 10 分钟，或下次发布重启后生效。验证方法：');
  console.log('   curl -s -o /dev/null -w "%{http_code} %{redirect_url}\\n" https://aicyld.com/downloads/<文件名>');
  console.log('   期望：302，且跳转到 oss-...aliyuncs.com');
}
process.exit(failed > 0 ? 1 : 0);
