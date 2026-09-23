#!/usr/bin/env node
/**
 * 10 · 把**已经在本地盘上的**文件回填到 OSS，并给它们打上 storageBackend='oss' 标记。
 *
 * 为什么需要它：打开 FILE_STORAGE=oss 只影响**新**上传；历史那 282 个上传（以及生成产物）
 * 仍指向本地盘。不回填的话，线上会长期处在"一半在 OSS、一半在本地"的混合状态
 * —— 不是不能用（读的时候按行分流），但媒体还是从这台 5 Mbps 的机器出去，收益只拿了一半。
 *
 * 安全设计（三条，缺一不可）：
 *   ① **默认保留本地文件**。回滚 = 把 metadata 里那个标记去掉（本地文件还在，读路径立刻恢复）；
 *      真要省磁盘得显式加 `--prune-local`，而且建议先跑一段时间观察再从本地删。
 *   ② **每个对象先传、再探、字节数对得上，才写标记**。任何一步不对就跳过这一行并记下来，
 *      绝不让"标记说在 OSS、其实没传上去"这种状态出现（那会让文件从可读变成 404）。
 *   ③ **幂等**。已经是 oss 的行直接跳过，可以反复跑、可以中途断。
 *
 * 用法（在服务器上，root）：
 *   cd /srv/ai-kids-platform/source
 *   export $(grep -E '^(FILE_STORAGE|OSS_)' /etc/ai-kids-platform/production.env | xargs)
 *   /srv/ai-kids-platform/runtime/node/bin/node deploy/production/migrate/10-backfill-uploads-to-oss.mjs --dry-run
 *   /srv/ai-kids-platform/runtime/node/bin/node deploy/production/migrate/10-backfill-uploads-to-oss.mjs
 *   # 可选： --limit 20（先拿 20 个试）  --prune-local（确认无误后删本地，慎用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { putObject, headObject, ossConfigured, ossInfo } from '../../../apps/server/src/services/objectStorage.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
};
const dbPath = arg('--db', '/srv/ai-kids-platform/production/data/platform.db');
const uploadRoot = path.resolve(arg('--root', '/srv/ai-kids-platform/production/uploads'));
const dryRun = process.argv.includes('--dry-run');
const pruneLocal = process.argv.includes('--prune-local');
const limit = Number(arg('--limit', '0')) || 0;

if (!ossConfigured() && !dryRun) {
  console.error('OSS 未配置齐 —— 先跑 09-verify-oss.mjs 把连通性验过。当前：', JSON.stringify(ossInfo()));
  process.exit(1);
}
if (!ossConfigured() && dryRun) {
  console.log('（密钥还没配，dry-run 只统计范围，不碰网络）\n');
}
if (!fs.existsSync(dbPath)) { console.error(`找不到库：${dbPath}`); process.exit(1); }

const db = new DatabaseSync(dbPath, { readOnly: dryRun });
const parseJson = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };

// 候选：自己的文件、且没有被标成 oss 的
const rows = db.prepare(
  `SELECT id, storage_key, file_name, mime_type, file_size, metadata
   FROM file_assets
   WHERE storage_kind='INTERNAL_PROXY' AND status <> 'REMOVED'
   ORDER BY created_at ASC`,
).all();

const todo = rows.filter((r) => {
  const meta = parseJson(r.metadata, {}) || {};
  return meta.storageBackend !== 'oss';
});

console.log(`OSS 回填${dryRun ? '（dry-run，不写任何东西）' : ''}`);
console.log(`  bucket=${ossInfo().bucket}  prefix=${ossInfo().prefix || '(无)'}`);
console.log(`  候选 ${todo.length} / 共 ${rows.length} 行${limit ? `（本次最多处理 ${limit} 个）` : ''}`);
console.log(`  本地文件：默认保留${pruneLocal ? ' —— ⚠️ 你开了 --prune-local，成功后会删本地文件' : '（回滚只要去掉标记）'}\n`);

let done = 0; let skipped = 0; const failures = [];
for (const r of (limit ? todo.slice(0, limit) : todo)) {
  const key = String(r.storage_key || '').replaceAll('\\', '/');
  if (!key || key.startsWith('/') || key.split('/').includes('..')) { failures.push([r.id, 'storage_key 不合法']); continue; }
  const absolute = path.resolve(uploadRoot, key);
  if (absolute !== uploadRoot && !absolute.startsWith(uploadRoot + path.sep)) { failures.push([r.id, 'storage_key 逃出 uploads']); continue; }
  let info;
  try { info = fs.statSync(absolute); } catch { failures.push([r.id, `本地文件不存在：${key}`]); continue; }
  if (!info.isFile()) { failures.push([r.id, '不是普通文件']); continue; }
  if (dryRun) { console.log(`  [dry] ${r.id}  ${key}  ${info.size} 字节`); done += 1; continue; }

  try {
    // ① 传
    await putObject(key, fs.readFileSync(absolute), r.mime_type || 'application/octet-stream');
    // ② 探（字节数必须与本地一致，否则不认账）
    const head = await headObject(key);
    if (!head.exists || head.size !== info.size) throw new Error(`回探不一致：exists=${head.exists} size=${head.size} 本地=${info.size}`);
    // ③ 才写标记（保留原有 metadata 的全部字段）
    const meta = parseJson(r.metadata, {}) || {};
    meta.storageBackend = 'oss';
    meta.ossBackfilledAt = new Date().toISOString();
    db.prepare('UPDATE file_assets SET metadata=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(meta), new Date().toISOString(), r.id);
    if (pruneLocal) { try { fs.unlinkSync(absolute); } catch { /* 删不掉就留着，不影响正确性 */ } }
    done += 1;
    if (done % 25 === 0) console.log(`  …已处理 ${done} 个`);
  } catch (error) {
    skipped += 1;
    failures.push([r.id, error.message]);
  }
}

console.log(`\n结果：成功 ${done}，失败 ${skipped}，总计候选 ${todo.length}`);
if (failures.length) {
  console.log('失败明细（**这些行仍是本地盘，读路径不受影响**，修完重跑即可）：');
  for (const [id, why] of failures.slice(0, 20)) console.log(`  ${id}  ${why}`);
  if (failures.length > 20) console.log(`  …还有 ${failures.length - 20} 条`);
}
if (!dryRun && done) {
  console.log('\n下一步：在 /etc/ai-kids-platform/production.env 里设 FILE_STORAGE=oss，然后');
  console.log('  systemctl restart learning-platform-production');
  console.log('之后新上传会直接进 OSS；已经回填好的行读的时候会 302 到签名地址。');
}
console.log('\n回滚：把 file_assets.metadata 里的 storageBackend 去掉即可（本地文件默认还在）——');
console.log('  或直接把 FILE_STORAGE 改回 local，新上传就回到本地盘，历史行不受影响。');
