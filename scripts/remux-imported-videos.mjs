#!/usr/bin/env node
/**
 * 把导入来的 `.mov` 就地转成真 mp4（2026-09-19）。
 *
 * 为什么必须转：这些视频的容器品牌是 `ftypqt`（QuickTime），Chrome 对 qt 品牌支持很差 ——
 * 实测在我们站上 `<video>` 一直 readyState=0（加载不出来），而同一份文件在源站能播。
 * 光改 nginx 的 content-type 不解决问题（内容品牌摆在那儿），
 * 正解是转成标准 mp4（`isom/avc1`）：`-c copy` **不重新编码**（几秒一个），`+faststart`
 * 把 moov 挪到文件头，浏览器不用先拉文件尾就能起播。
 *
 * 跑法（服务器上）：node scripts/remux-imported-videos.mjs [--dry-run] [--keep-mov]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const DRY_RUN = process.argv.includes('--dry-run');
const KEEP_MOV = process.argv.includes('--keep-mov');
const MEDIA_ROOT = process.env.PLAZA_MEDIA_ROOT || '/srv/ai-kids-platform/public-media';
const DB_PATH = process.env.PLATFORM_DB_PATH || '/srv/ai-kids-platform/production/data/platform.db';
const log = (...rest) => console.log(...rest);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.toLowerCase().endsWith('.mov')) out.push(full);
  }
  return out;
}
function probe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration', '-of', 'default=noprint_wrappers=1', file], { encoding: 'utf8' });
    return { ok: true, detail: out.trim().split('\n').join(' ') };
  } catch (error) { return { ok: false, detail: String(error.message).slice(0, 120) }; }
}

const moved = [];
const movFiles = walk(MEDIA_ROOT);
log(`[remux] 找到 ${movFiles.length} 个 .mov`);
for (const file of movFiles) {
  const target = file.replace(/\.mov$/i, '.mp4');
  if (fs.existsSync(target) && fs.statSync(target).size > 0) { log(`  跳过（已有 mp4）：${path.basename(path.dirname(file))}`); moved.push([file, target]); continue; }
  if (DRY_RUN) { log(`  （dry-run）会转：${file}`); moved.push([file, target]); continue; }
  let how = 'copy';
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c', 'copy', '-movflags', '+faststart', target], { stdio: 'pipe' });
  } catch {
    // copy 不进去（容器/编码不兼容）就重编码 —— 慢，但比留一个播不了的文件强
    how = 're-encode';
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', target], { stdio: 'pipe' });
  }
  const check = probe(target);
  if (!check.ok) { log(`  !! 转失败：${file}（${check.detail}）`); fs.rmSync(target, { force: true }); continue; }
  log(`  ✓ ${path.basename(path.dirname(file))} · ${how} · ${check.detail} · ${(fs.statSync(target).size / 1024 / 1024).toFixed(1)}MB`);
  moved.push([file, target]);
}

// 库里把 .mov 地址换成 .mp4（JSON 感知地改，不做文本替换）
if (!DRY_RUN && moved.length) {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 15000');
  const rows = db.prepare("SELECT id, canvas_snapshot FROM works WHERE id LIKE 'work_ltai_%'").all();
  let updated = 0;
  for (const row of rows) {
    const snapshot = JSON.parse(row.canvas_snapshot);
    const imported = snapshot.imported;
    if (!imported) continue;
    const before = JSON.stringify(imported.contentUrls || []);
    const next = (imported.contentUrls || []).map((url) => url.replace(/\.mov$/i, '.mp4'));
    if (JSON.stringify(next) === before) continue;
    imported.contentUrls = next;
    db.prepare('UPDATE works SET canvas_snapshot=? WHERE id=?').run(JSON.stringify(snapshot), row.id);
    updated += 1;
  }
  log(`[remux] 库里更新了 ${updated} 条作品的本体地址`);
  db.close();
}

// 删掉 .mov（默认删：转完留着只是占地方；--keep-mov 时保留做对照）
if (!DRY_RUN && !KEEP_MOV) {
  for (const [file, target] of moved) if (fs.existsSync(target) && fs.statSync(target).size > 0) fs.rmSync(file, { force: true });
  log('[remux] 已删除原 .mov');
}
log('[remux] 完成');
