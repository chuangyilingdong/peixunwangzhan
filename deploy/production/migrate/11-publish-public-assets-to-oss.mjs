#!/usr/bin/env node
/**
 * 11 · 把**公开内容**（广场媒体 + 客户端安装包）发布到 OSS 的公开前缀，并验证安全边界。
 *
 * 为什么搬这两样：它们是吃满这台 5 Mbps 出口的大头 ——
 *   · 广场媒体 1.79G，每个页面都要取图
 *   · 客户端安装包 392M，5 Mbps 下一个用户要下 10 分钟；修好客户端后会有一波**集中下载**，
 *     不搬的话那波下载会把整台机的出口堵死
 *
 * 为什么**不用改数据库、不用改客户端**：
 *   内容仍然以 https://aicyld.com/media/… 与 …/downloads/… 的形式对外（库里存的也是这个），
 *   只是 nginx 对这两条路径 **302 到 OSS**。客户端更新时用的是 fetch（会跟随跳转），
 *   而它那道"地址必须是平台域名、路径必须是 /downloads/"的校验**只作用在初始地址上** ——
 *   所以 302 出去它照样能跟到 OSS 下载，并继续校验 size/sha256。（这一点读过客户端源码确认过。）
 *
 * ⚠️ **安全边界**：只对 `public-media/*` 与 `downloads/*` 两个前缀开匿名只读，
 *   **绝不开**放上传所在的私有前缀（课件、学生素材在那下面）。本脚本最后会**实测验证**
 *   私有前缀仍然 403 —— 那一条不过就说明边界破了，必须立刻回滚策略。
 *
 * 用法（服务器上，root）：
 *   cd /srv/ai-kids-platform/source
 *   export $(grep -E '^(FILE_STORAGE|OSS_)' /etc/ai-kids-platform/production.env | xargs)
 *   node deploy/production/migrate/11-publish-public-assets-to-oss.mjs --dry-run
 *   node deploy/production/migrate/11-publish-public-assets-to-oss.mjs
 *   node deploy/production/migrate/11-publish-public-assets-to-oss.mjs --only downloads
 *   node deploy/production/migrate/11-publish-public-assets-to-oss.mjs --policy     # 只设策略+验证
 */
import fs from 'node:fs';
import path from 'node:path';
import { putObject, headObject, putBucketPolicy, getBucketPolicy, ossConfigured, ossInfo } from '../../../apps/server/src/services/objectStorage.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
};
const dryRun = process.argv.includes('--dry-run');
const only = String(arg('--only', '')).trim();
const policyOnly = process.argv.includes('--policy');

const MEDIA_ROOT = '/srv/ai-kids-platform/public-media';
const DOWNLOAD_ROOT = '/srv/ai-kids-platform/downloads';
const UPLOAD_ROOT = '/srv/ai-kids-platform/production/uploads';
const PREFIX = String(process.env.OSS_PREFIX || '').trim().replace(/^\/+|\/+$/g, '');
const BUCKET = String(process.env.OSS_BUCKET || '');
const ENDPOINT = String(process.env.OSS_ENDPOINT || '');
const PUBLIC_PREFIXES = ['public-media', 'downloads'];

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

/** 设策略：**只给这两个前缀的 GetObject**，不给 ListObjects，也不碰私有前缀 */
async function ensurePolicy() {
  const resources = PUBLIC_PREFIXES.map((p) => `acs:oss:*:*:${BUCKET}/${PREFIX ? `${PREFIX}/` : ''}${p}/*`);
  const policy = { Version: '1', Statement: [{ Effect: 'Allow', Principal: ['*'], Action: ['oss:GetObject'], Resource: resources }] };
  console.log('设置 bucket 策略（只开这两个前缀的匿名读）:');
  for (const r of resources) console.log('   ', r);
  try {
    await putBucketPolicy(policy);
    console.log('  ✓ 已设置');
  } catch (error) {
    console.log('  ✗ 设置失败：', error.message);
    console.log('\n  这一步需要你在**阿里云 OSS 控制台**做一次（子账号没有改策略的权限，这是对的）：');
    console.log('    OSS 控制台 → 点进这个 bucket → 左侧「权限管理 → Bucket 授权策略」→ 编辑，粘贴：\n');
    console.log(JSON.stringify(policy, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
    console.log('\n  贴完再跑一次本脚本（带 --policy 即可，只验策略）。');
    return false;
  }
  return true;
}

/** 验证安全边界：公开前缀能匿名读，**私有前缀必须仍然 403** */
async function verifyBoundary() {
  const url = (key) => `https://${BUCKET}.${ENDPOINT}/${key}`;
  let ok = true;

  // 公开：放一个探针再匿名取
  const probeKey = `${PREFIX ? `${PREFIX}/` : ''}downloads/_perm-probe.txt`;
  await putObject('downloads/_perm-probe.txt', Buffer.from('probe'), 'text/plain; charset=utf-8');
  const pub = await fetch(url(probeKey));
  console.log(`  ① 公开前缀匿名读：HTTP ${pub.status} ${pub.ok ? '✓' : '✗ 策略没生效'}`);
  ok = ok && pub.ok;

  // 私有：拿一个真实的课件对象试（**这条是红线**）
  const today = new Date();
  const rel = `${today.getUTCFullYear()}/${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
  const uploadsDir = path.join(UPLOAD_ROOT, rel);
  const sample = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir)[0] : null;
  if (sample) {
    const privKey = `${PREFIX ? `${PREFIX}/` : ''}${rel}/${sample}`;
    const priv = await fetch(url(privKey));
    const good = priv.status === 403;
    console.log(`  ② 私有前缀（课件）匿名读：HTTP ${priv.status} ${good ? '✓ 仍然拒绝 —— 安全边界没破' : '✗✗ 被放开了，立刻回滚策略！'}`);
    ok = ok && good;
  } else {
    console.log('  ② 私有前缀：没找到可测的课件样本，跳过（下次有上传后请重跑）');
  }
  return ok;
}

if (policyOnly) {
  const ok = await ensurePolicy() && await verifyBoundary();
  process.exit(ok ? 0 : 1);
}

console.log(`公开内容发布到 OSS${dryRun ? '（dry-run，不写任何东西）' : ''}`);
console.log(`  bucket=${BUCKET}  prefix=${PREFIX}`);
if (!dryRun) {
  const hasPolicy = await getBucketPolicy();
  if (!hasPolicy) {
    console.log('\n⚠️  这个 bucket 还没有策略 —— 先确保策略装好，否则上传了也读不到：');
    await ensurePolicy();
  }
}

const jobs = [];
if (!only || only === 'media') jobs.push({ name: '广场媒体', root: MEDIA_ROOT, keyBase: 'public-media' });
if (!only || only === 'downloads') jobs.push({ name: '客户端安装包', root: DOWNLOAD_ROOT, keyBase: 'downloads' });

let uploaded = 0; let skipped = 0; const failed = [];
for (const job of jobs) {
  if (!fs.existsSync(job.root)) { console.log(`  （跳过 ${job.name}：目录不存在）`); continue; }
  const files = walk(job.root);
  let bytes = 0;
  console.log(`\n${job.name}：${files.length} 个文件`);
  for (const full of files) {
    const relKey = `${job.keyBase}/${path.relative(job.root, full).replaceAll('\\', '/')}`;
    const info = fs.statSync(full);
    bytes += info.size;
    if (dryRun) { skipped += 1; continue; }
    try {
      // 幂等：已在 OSS 且大小一致就跳过（省一次传输；内容变了大小一般也会变）
      const head = await headObject(relKey);
      if (head.exists && head.size === info.size) { skipped += 1; continue; }
      await putObject(relKey, fs.readFileSync(full), 'application/octet-stream');
      uploaded += 1;
      if (uploaded % 50 === 0) console.log(`  …已传 ${uploaded}`);
    } catch (error) {
      failed.push([relKey, error.message]);
    }
  }
  console.log(`  合计 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

if (dryRun) { console.log(`\ndry-run：共 ${skipped} 个文件待处理，未传任何东西。`); process.exit(0); }

console.log(`\n结果：新上传 ${uploaded}，跳过（已一致）${skipped}，失败 ${failed.length}`);
for (const [k, why] of failed.slice(0, 10)) console.log(`  ✗ ${k}  ${why}`);

console.log('\n安全边界复验：');
const boundaryOk = await verifyBoundary();

console.log('\n下一步（nginx 302，**不需要改数据库、不需要改客户端**）：');
console.log('  在站点配置里把 /media/ 与 /downloads/ 改成 302 到 OSS（见 docs/operations/OSS接入-步骤-20260923.md 的「公开内容」一节）');
process.exit(boundaryOk && failed.length === 0 ? 0 : 1);
