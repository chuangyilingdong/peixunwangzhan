#!/usr/bin/env node
/**
 * 18 · 预热课件预览：把 Office 课件的转换产物**先转好、推上 OSS**（2026-09-25）。
 *
 * 为什么要有这一步：预览改成"转出来就推 OSS、之后每次 302"之后，**第一份**要现场转
 * （LibreOffice 几十秒：生产上最大的那份课件 106MB，转出来是 100MB 的 PDF）。
 * 现在全班有 758MB 的课件，谁先点开谁承担那一次转换 + 上传。这个脚本就是替他们先做掉，
 * 一条命令、幂等、随时可重跑（已经推上去的直接跳过）。
 *
 * 前提：服务器上有 soffice（真机转换只在这里做，开发机没有）。
 *
 * 用法（服务器上，root）：
 *   cd /srv/ai-kids-platform/source
 *   export $(grep -E '^(FILE_STORAGE|OSS_|RDS_)' /etc/ai-kids-platform/production.env | xargs)
 *   node deploy/production/migrate/18-warm-preview-pdfs.mjs --dry-run     # 只列要转哪些
 *   node deploy/production/migrate/18-warm-preview-pdfs.mjs               # 真跑（建议 tmux/nohup）
 *   node deploy/production/migrate/18-warm-preview-pdfs.mjs --limit=5     # 先拿 5 份试
 *
 * 失败不阻塞：某一份转不出来就记下来继续下一份（它仍然能"按需转"，只是那一次慢）。
 * 跑完之后可以清本地副本：`17-prune-local-uploads.mjs --apply --include-caches`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensurePreviewPdf, previewPdfInOss, publishPreviewPdf, needsConversion, previewKindFor, PREVIEW_CACHE_DIR } from '../../../apps/server/src/services/materialPreview.js';
import { materializeObject } from '../../../apps/server/src/services/fileStorage.js';
import { ossConfigured, ossInfo } from '../../../apps/server/src/services/objectStorage.js';

const ROOT = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
};
const dryRun = process.argv.includes('--dry-run');
const limit = Number(arg('--limit', '0')) || 0;
const uploadRoot = path.resolve(arg('--root', '/srv/ai-kids-platform/production/uploads'));

if (!ossConfigured()) { console.error('OSS 未配置齐。', JSON.stringify(ossInfo())); process.exit(1); }

// 连接的键两套名字都认：RDS_* 是生产 /etc/ai-kids-platform/production.env 里的原名，
// MYSQL_* 是仓库里其余运维脚本（rds-column-headroom 等）用的那套。
const mysqlEnv = {
  host: process.env.MYSQL_HOST || process.env.RDS_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || process.env.RDS_PORT || 3306),
  user: process.env.MYSQL_USER || process.env.RDS_USER || 'root',
  password: process.env.MYSQL_PASSWORD || process.env.RDS_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || process.env.RDS_DATABASE || 'aild_admin',
};
const mysql = (await import(pathToFileURL(path.join(ROOT, 'packages/database/node_modules/mysql2/promise.js')).href)).default;
const conn = await mysql.createConnection(mysqlEnv);
const [rows] = await conn.query(
  `SELECT id, storage_key, file_name, mime_type, file_size, metadata
     FROM file_assets
    WHERE storage_kind='INTERNAL_PROXY' AND status <> 'REMOVED'
    ORDER BY file_size DESC`);
await conn.end();

const todo = [];
for (const row of rows) {
  if (!needsConversion(previewKindFor({ mimeType: row.mime_type, fileName: row.file_name }))) continue;
  const meta = (() => { try { return JSON.parse(row.metadata || '{}') || {}; } catch { return {}; } })();
  if (meta.storageBackend !== 'oss') { console.log(`  · 跳过（不在 OSS 上）：${row.file_name}`); continue; }
  todo.push(row);
}

console.log(`课件预览预热${dryRun ? '（--dry-run，只列不转）' : ''}`);
console.log(`  桶 ${ossInfo().bucket}  待处理 ${todo.length} 份${limit ? `（本次最多 ${limit} 份）` : ''}\n`);

let done = 0; let skipped = 0; const failed = [];
for (const row of (limit ? todo.slice(0, limit) : todo)) {
  const size = row.file_size == null ? null : Number(row.file_size);
  const head = `${String(row.file_name || row.id).slice(0, 40)}  ${(Number(row.file_size || 0) / 1048576).toFixed(1)}MB`;
  const published = await previewPdfInOss(row.id, size);
  if (published) { skipped += 1; console.log(`  = 已在 OSS：${head}`); continue; }
  if (dryRun) { console.log(`  [dry] 要转：${head}`); continue; }
  const storageKey = String(row.storage_key || '').replaceAll('\\', '/');
  const scratch = path.resolve(uploadRoot, '.oss-preview-cache', `${row.id}${path.extname(storageKey) || ''}`);
  const started = Date.now();
  try {
    const source = await materializeObject(row, scratch);
    const pdf = await ensurePreviewPdf({ sourcePath: source, cacheKey: row.id });
    if (!pdf) throw new Error('转换没有产出 PDF');
    const key = await publishPreviewPdf({ fileId: row.id, pdfPath: pdf, sourceSize: size });
    if (!key) throw new Error('推到 OSS 失败');
    done += 1;
    console.log(`  ✓ ${head}  ${((Date.now() - started) / 1000).toFixed(1)}s  → ${key}  ${(fs.statSync(pdf).size / 1048576).toFixed(1)}MB`);
  } catch (error) {
    failed.push([row.id, row.file_name, error.message]);
    console.log(`  ✗ ${head}  ${error.message}`);
  }
}

console.log(`\n结果：新推 ${done}，本来就有 ${skipped}，失败 ${failed.length}`);
if (failed.length) for (const [id, name, why] of failed.slice(0, 10)) console.log(`  ${id}  ${name}  ${why}`);
if (done) console.log(`\n下一步：可以清本地副本了 —— 17-prune-local-uploads.mjs --apply --include-caches（会连 .preview 转换缓存一起清）。`);
console.log(`提示：${PREVIEW_CACHE_DIR} 与 .oss-preview-cache 都是派生缓存，删了会重生成，不影响正确性。`);
