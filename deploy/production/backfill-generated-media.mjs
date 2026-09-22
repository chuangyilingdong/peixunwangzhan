#!/usr/bin/env node
/**
 * 一次性数据迁移：把**已经产出、但地址留在上游**的生成产物收回我们自己这儿存。
 *
 * 为什么需要它（2026-09-22 实测）：上游给的是**临时地址**，过一阵就 403 ——
 * `getapib.org` 那批 21 条里 7 条已经失效（CloudFront 回 `application/xml`），
 * 浏览器按 ORB 挡掉，作品读面里就是一片坏图占位。代码那边已经改成"生成成功时顺手归档"
 * （见 services/generatedAssetArchive.js），但**这以前产出的东西不会自己变好**。
 *
 * ⚠️ 三处都要改，少一处就等于没改（这是本脚本最容易被做漏的地方）：
 *   ① `media_assets.asset_url` / `preview_url` —— 作品读面「做出来的东西」那一栏的来源；
 *   ② `student_projects.canvas_snapshot` —— **画布本身就存着那个地址**（改前一直如此）；
 *   ③ `works.canvas_snapshot` —— 提交时抄了一份，广场的媒体清单正是从它提的
 *      （`canvasMediaFrom`）。只改 ①② 的话，广场依旧显示那个会过期的外链。
 *
 * 幂等：只认 `^https?://` 且不是我们域名的地址；已经是 `/api/student/file-assets/...` 的行跳过，
 * 跑第二遍报「无需改动」。原始地址保留在 `metadata.archive.sourceUrl`，要回退有据可查。
 *
 * 用法（在服务器上，**先 --dry-run**）：
 *   export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH
 *   set -a; . /etc/ai-kids-platform/production.env; set +a
 *   node deploy/production/backfill-generated-media.mjs --dry-run
 *   node deploy/production/backfill-generated-media.mjs --apply
 *   # 先在副本上试：--db /tmp/platform.db --uploads /tmp/uploads
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback;
}
const apply = process.argv.includes('--apply');
const dbPath = path.resolve(arg('--db', process.env.PLATFORM_DB_PATH || '/srv/ai-kids-platform/production/data/platform.db'));
const uploads = path.resolve(arg('--uploads', process.env.FILE_UPLOAD_ROOT || '/srv/ai-kids-platform/production/uploads'));
if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);

// lib.js 在 import 时会跑一遍迁移 —— 所以必须先把环境指到**这次要改的那个库**，
// 否则会一边改 A 库、一边在 B 库上跑迁移（.tmp 那批诊断脚本栽过同一个坑）。
process.env.PLATFORM_DB_PATH = dbPath;
process.env.PLATFORM_DATA_DIR = path.dirname(dbPath);
process.env.FILE_UPLOAD_ROOT = uploads;
process.env.DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'local-mock';
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'local-mock';
const { archiveOneGeneratedAsset } = await import('../../apps/server/src/services/generatedAssetArchive.js');

const upstream = (url) => /^https?:\/\//i.test(String(url || '')) && !/iicili\.cyou/i.test(String(url));

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000');
db.exec('PRAGMA foreign_keys = ON');

const targets = db.prepare('SELECT id, project_id, modality, asset_url, preview_url FROM media_assets').all()
  .filter((row) => upstream(row.asset_url) || upstream(row.preview_url));

console.log(`库：${dbPath}`);
console.log(`上传根：${uploads}`);
console.log(`模式：${apply ? '**APPLY（会写库、会落盘）**' : 'dry-run（只看，不动任何东西）'}`);
console.log(`media_assets 里地址还在上游的行：${targets.length} 条\n`);
for (const row of targets) {
  console.log(`  ${row.id} [${row.modality}] ${String(row.asset_url || '').slice(0, 78)}`);
}
if (!targets.length) {
  console.log('\n无需改动（都已经是我们自己的地址了）。');
  process.exit(0);
}
if (!apply) {
  console.log('\n（dry-run 结束。要真做加 --apply —— 它会下载这些产物、落盘、并改写上面三处地址。）');
  process.exit(0);
}

let done = 0;
let failed = 0;
const replacements = [];   // 上游地址 → 我们自己的地址（后面用来改快照）

for (const row of targets) {
  const source = String(row.asset_url || row.preview_url);
  const result = await archiveOneGeneratedAsset({
    assetUrl: source,
    modality: row.modality,
    jobId: `backfill-${row.id}`,
    ownerUserId: db.prepare('SELECT user_id FROM media_assets WHERE id=?').get(row.id)?.user_id || null,
    ownerOrgId: db.prepare('SELECT org_id FROM media_assets WHERE id=?').get(row.id)?.org_id || null,
  });
  if (!result.ok) {
    failed += 1;
    console.log(`  ✗ ${row.id}：${result.reason}（保留原地址）`);
    continue;
  }
  const metadata = JSON.parse(row.metadata || '{}');
  db.prepare('UPDATE media_assets SET asset_url=?, preview_url=CASE WHEN preview_url=? THEN ? ELSE preview_url END, mime_type=COALESCE(mime_type,?), metadata=? WHERE id=?')
    .run(result.url, source, result.url, result.mimeType, JSON.stringify({ ...metadata, archive: { mirrored: true, sourceUrl: source, mimeType: result.mimeType, bytes: result.bytes, backfilledAt: new Date().toISOString() } }), row.id);
  replacements.push([source, result.url]);
  done += 1;
  console.log(`  ✓ ${row.id} → ${result.url}（${(result.bytes / 1024).toFixed(0)}KB）`);
}

// ②③ 快照：字符串替换（快照里存的就是那个上游地址）。
// ⚠️ 只替换**确实归档成功**的那些地址：没归档成功的留着，它至少还有可能活着，换成一个不存在的地址更糟。
function rewriteSnapshot(table, idColumn) {
  let touched = 0;
  for (const record of db.prepare(`SELECT id, ${idColumn} AS snapshot FROM ${table} WHERE ${idColumn} LIKE '%http%'`).all()) {
    let text = String(record.snapshot || '');
    const before = text;
    for (const [from, to] of replacements) {
      if (from && text.includes(from)) text = text.split(from).join(to);
    }
    if (text === before) continue;
    db.prepare(`UPDATE ${table} SET ${idColumn}=? WHERE id=?`).run(text, record.id);
    touched += 1;
  }
  return touched;
}
const projectsTouched = rewriteSnapshot('student_projects', 'canvas_snapshot');
const worksTouched = rewriteSnapshot('works', 'canvas_snapshot');

console.log(`\n结果：归档成功 ${done} 条、失败 ${failed} 条`);
console.log(`快照改写：student_projects ${projectsTouched} 行、works ${worksTouched} 行`);
console.log('复查：SELECT COUNT(*) FROM media_assets WHERE asset_url LIKE \'http%\' —— 剩下的应该都是归档失败的那几条。');
