#!/usr/bin/env node
/**
 * 17 · 删掉 uploads 里那些**已经在 OSS 上、字节也对得上**的历史副本（2026-09-25）。
 *
 * 背景：切 OSS 之前上传的课件/素材，回填（10 号脚本）时按"默认保留本地文件"设计 —— 本地那份
 * 是"去掉 metadata 标记就能立刻回滚"的保险。后来所有行都标了 oss（321 行 / 1039.8 MB），
 * 保险已经不需要了，可副本还占着盘（974 MB）。
 *
 * ⚠️ 这不是 `rm -rf uploads`。删除的**前提是逐个文件验证过**：
 *   ① 本地这份文件的 storage_key 能在 file_assets 里找到对应行，且该行标记为 oss；
 *   ② OSS 上那个对象**存在，且字节数与本地完全一致**。
 *   两条都成立才删。任何一条不成立 → 只报告、不动它（宁可留着，也不能删出 404）。
 *   另外：**没有对应行的孤儿文件一律不删**（那可能是人工放进去的东西，脚本不该替人决定）。
 *
 * 派生目录（`.preview` 转换缓存、`.oss-preview-cache` 取回来的源、`.mirror-cache`）默认只报不删：
 * 它们能重新生成，但删了之后第一次预览会重转一遍；要一起清就加 `--include-caches`。
 *
 * 用法（服务器上，root）：
 *   cd /srv/ai-kids-platform/source
 *   export $(grep -E '^(FILE_STORAGE|OSS_)' /etc/ai-kids-platform/production.env | xargs)
 *   # 库：直连本机 RDS 内网（用 /root/.my.cnf 的凭据，见 README）
 *   export MYSQL_HOST=… MYSQL_PORT=3306 MYSQL_USER=… MYSQL_PASSWORD=… MYSQL_DATABASE=aild_admin
 *   node deploy/production/migrate/17-prune-local-uploads.mjs            # 审计，不动文件
 *   node deploy/production/migrate/17-prune-local-uploads.mjs --apply    # 真删（先看审计输出）
 *
 * 回滚：删掉的本地副本**不再需要**（读路径走 OSS）。真要恢复某一份：
 *   node scripts/… 用 objectStorage.getObjectToFile 把它从 OSS 取回同一个 storage_key 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { headObject, ossConfigured, ossInfo } from '../../../apps/server/src/services/objectStorage.js';

const ROOT = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
};
const apply = process.argv.includes('--apply');
const includeCaches = process.argv.includes('--include-caches');
const uploadRoot = path.resolve(arg('--root', '/srv/ai-kids-platform/production/uploads'));
const CACHE_DIRS = new Set(['.preview', '.oss-preview-cache', '.mirror-cache']);

if (!ossConfigured()) { console.error('OSS 未配置齐。', JSON.stringify(ossInfo())); process.exit(1); }
if (!fs.existsSync(uploadRoot)) { console.error(`找不到 ${uploadRoot}`); process.exit(1); }

const mysqlEnv = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'aild_admin',
};
const mysql = (await import(pathToFileURL(path.join(ROOT, 'packages/database/node_modules/mysql2/promise.js')).href)).default;
const conn = await mysql.createConnection(mysqlEnv);

const [rows] = await conn.query(
  "SELECT id, storage_key, file_size, metadata FROM file_assets WHERE storage_kind='INTERNAL_PROXY' AND status <> 'REMOVED'");
await conn.end();

/** storage_key（去掉前缀的写法都认）→ 行 */
const byKey = new Map();
let ossRows = 0;
for (const row of rows) {
  const key = String(row.storage_key || '').replaceAll('\\', '/');
  if (!key) continue;
  const meta = (() => { try { return JSON.parse(row.metadata || '{}') || {}; } catch { return {}; } })();
  const isOss = meta.storageBackend === 'oss';
  if (isOss) ossRows += 1;
  byKey.set(key, { ...row, key, isOss });
}

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (CACHE_DIRS.has(entry.name)) { out.push({ full, cache: true }); continue; }
      walk(full, out);
    } else if (entry.isFile()) out.push({ full, cache: false });
  }
  return out;
};

console.log(`OSS 回填后的本地副本清理${apply ? '（--apply，会删文件）' : '（审计，不动任何文件）'}`);
console.log(`  目录：${uploadRoot}`);
console.log(`  库里的课件/素材行：${rows.length}（其中标了 oss 的 ${ossRows}）`);
console.log(`  缓存目录：${includeCaches ? '连同一起清' : '只报不删（--include-caches 才清）'}\n`);

const files = walk(uploadRoot);
const caches = files.filter((f) => f.cache);
const regulars = files.filter((f) => !f.cache);
let bytes = 0;

const deletable = [];
const keep = [];
for (const file of regulars) {
  const rel = path.relative(uploadRoot, file.full).replaceAll('\\', '/');
  const row = byKey.get(rel) || byKey.get(`${ossInfo().prefix}/${rel}`);
  if (!row) { keep.push([rel, '没有对应的 file_assets 行（孤儿文件，脚本不替人决定）']); continue; }
  if (!row.isOss) { keep.push([rel, '这一行仍标记为本地存储']); continue; }
  const stat = fs.statSync(file.full);
  const head = await headObject(row.key).catch(() => ({ exists: false, size: 0 }));
  if (!head.exists) { keep.push([rel, 'OSS 上没有这个对象']); continue; }
  if (Number(head.size) !== stat.size) { keep.push([rel, `字节数不一致（本地 ${stat.size} / OSS ${head.size}）`]); continue; }
  bytes += stat.size;
  deletable.push({ ...file, size: stat.size, rel });
}

for (const cache of caches) {
  const dirBytes = (function dirSize(d) {
    let total = 0;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
    return total;
  })(cache.full);
  cache.size = dirBytes;
}

console.log(`可删（已在 OSS 且字节一致）：${deletable.length} 个文件，${(bytes / 1048576).toFixed(1)} MB`);
for (const item of deletable.slice(0, 5)) console.log(`  · ${item.rel}  ${(item.size / 1048576).toFixed(2)} MB`);
if (deletable.length > 5) console.log(`  …还有 ${deletable.length - 5} 个`);
console.log(`\n缓存目录：${caches.length} 个，${(caches.reduce((sum, c) => sum + c.size, 0) / 1048576).toFixed(1)} MB`);
for (const cache of caches) console.log(`  · ${path.relative(uploadRoot, cache.full)}  ${(cache.size / 1048576).toFixed(1)} MB`);
if (keep.length) {
  console.log(`\n⚠️ 保留（${keep.length} 个，**没有删**）：`);
  for (const [rel, why] of keep.slice(0, 20)) console.log(`  · ${rel} — ${why}`);
  if (keep.length > 20) console.log(`  …还有 ${keep.length - 20} 个`);
}

if (!apply) { console.log('\n（审计结束，没动任何文件。要真删加 --apply）'); process.exit(0); }

let removed = 0;
for (const item of deletable) {
  try { fs.unlinkSync(item.full); removed += 1; } catch (error) { console.log(`  ✗ 删不掉 ${item.rel}：${error.message}`); }
}
console.log(`\n已删除 ${removed}/${deletable.length} 个文件，回收 ${(bytes / 1048576).toFixed(1)} MB`);
if (includeCaches) {
  for (const cache of caches) { try { fs.rmSync(cache.full, { recursive: true, force: true }); console.log(`  · 缓存目录已清：${path.relative(uploadRoot, cache.full)}`); } catch (error) { console.log(`  ✗ 缓存清不掉：${error.message}`); } }
}
// 删空的日期目录（不留一堆空壳）
const pruneEmpty = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmpty(path.join(dir, entry.name));
  }
  if (dir !== uploadRoot && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
};
try { pruneEmpty(uploadRoot); } catch { /* 空目录清不掉不影响什么 */ }
console.log('完成。回滚要看旧文件的话，它们都在 OSS 上（用同一个 storage_key 取回来即可）。');
