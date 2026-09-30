/**
 * 26 · 给**漏标 `storageBackend` 的行**补上标记（只读探测 + 可写回；默认干跑）。
 *
 * 为什么需要它（2026-09-30 生产 P1，用户报「图片/视频还是不展示」）：
 *   字节到底在本地盘还是 OSS，**唯一判据**是 `file_assets.metadata.storageBackend`
 *   （见 `services/fileStorage.js` 的 `rowStorageBackend`：缺省一律当**本地盘**）。
 *   而 `storeStudentArtifactAsset`（学生工作区素材 = 客户端交作品随带的本地图/视频）
 *   原来**漏写了这个字段**：字节被 `persistUploadBytes` 写进了 OSS，读面却按"本地盘"去找 →
 *   `stat` 找不到 → `404 FILE_STORAGE_NOT_FOUND`（老师端预览一张图都取不到、分享卡同样）。
 *   代码已修（`routes/fileAssets.js`），这一支负责把**已经落进去的那批行**补上标记：
 *   逐行 `headObject(storage_key)`，**对象真在 OSS 上**才打标（打错了会让读面去 OSS 取一个不存在的键）。
 *
 * 用法（在服务器上跑，先干跑看清单）：
 *   export $(grep -E '^(FILE_STORAGE|OSS_|RDS_)' /etc/ai-kids-platform/production.env | xargs)
 *   node deploy/production/migrate/26-refresh-storage-flags.mjs            # 干跑：只报告
 *   node deploy/production/migrate/26-refresh-storage-flags.mjs --apply    # 真写（逐行 UPDATE，可回滚成 delete 那个字段）
 */
import { headObject, ossConfigured, ossInfo } from '../../../apps/server/src/services/objectStorage.js';

const apply = process.argv.includes('--apply');
const limit = Number(process.env.REFRESH_LIMIT || 500);

const { arows, aq } = await import('../../../packages/database/src/store.js');

if (!ossConfigured() && apply) {
  console.error('OSS 没配（FILE_STORAGE / OSS_* 不全）—— 拒绝对着错误的后端打标记。先 export 那几项。');
  process.exit(1);
}
console.log(`[26] 后端=${JSON.stringify(ossInfo?.() ?? null)} · 模式=${apply ? '★ APPLY（真写）' : '干跑'}`);

// 候选：内部代理行、metadata 里**没有** storageBackend 的
const candidates = await arows(
  `SELECT id, storage_key, file_name, mime_type, file_size, metadata, created_at
     FROM file_assets
    WHERE storage_kind='INTERNAL_PROXY'
      AND status='ACTIVE'
      AND (metadata IS NULL OR metadata NOT LIKE '%storageBackend%')
    ORDER BY created_at DESC
    LIMIT ${Math.max(1, Math.min(5000, limit))}`,
  [],
);
console.log(`[26] 候选 ${candidates.length} 行（INTERNAL_PROXY + 没标 storageBackend）`);

let existsInOss = 0;
let patched = 0;
let missing = 0;
for (const row of candidates) {
  const key = String(row.storage_key || '').replaceAll('\\', '/');
  if (!key) { missing += 1; continue; }
  let probe = { exists: false, size: 0 };
  try { probe = await headObject(key); } catch { probe = { exists: false, size: 0 }; }
  if (!probe?.exists) {
    missing += 1;
    console.log(`  · ${row.id}  ${row.file_name}  对象不在 OSS（key=${key}）—— 跳过`);
    continue;
  }
  existsInOss += 1;
  const sizeNote = row.file_size != null && probe.size && Number(row.file_size) !== Number(probe.size)
    ? `  ⚠️ 大小不一致（库里 ${row.file_size} / OSS ${probe.size}）` : '';
  console.log(`  ✓ ${row.id}  ${row.file_name}  ${probe.size} 字节${sizeNote}`);
  if (!apply) continue;
  let meta = {};
  try { meta = JSON.parse(row.metadata || '{}') || {}; } catch { meta = {}; }
  meta.storageBackend = 'oss';
  await aq('UPDATE file_assets SET metadata=? WHERE id=?', [JSON.stringify(meta), row.id]);
  patched += 1;
}

console.log(`\n[26] 小结：候选 ${candidates.length} 行 → OSS 上真有对象 ${existsInOss} 行、对象不在 ${missing} 行、`
  + `${apply ? `已写回 ${patched} 行` : '（干跑，没写）'}`);
if (!apply && existsInOss) console.log('[26] 确认上面这些行就是"漏标"的，加 --apply 写回。');

// ⚠️ MySQL 驱动会**吊住事件循环**（连接池不关）—— 不显式退出，脚本跑完会一直挂着，
//    调用方（ssh / 运维脚本）只能等超时、还看不到输出。
process.exit(0);
