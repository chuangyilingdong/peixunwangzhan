#!/usr/bin/env node
/**
 * 一次性数据迁移：classroom_config 的 generationSlots（按模态计数 + 一套参数）
 * → generationBoxes（逐框体配置，2026-09-09 起的新结构）。
 *
 * 为什么需要：新代码不再读 generationSlots，不迁移的话，课时上已配好的生成框体
 * 会在学生端直接消失（生产「AI古诗词创意营 / 第1课」就是这种情况）。
 *
 * 幂等：已有 generationBoxes 的课时跳过；只改 course_lessons.classroom_config，不动其他字段。
 * 用法：
 *   node deploy/production/migrate-generation-boxes.mjs --db /srv/ai-kids-platform/production/data/platform.db --dry-run
 *   node deploy/production/migrate-generation-boxes.mjs --db /srv/ai-kids-platform/production/data/platform.db
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback;
}

const dbPath = path.resolve(arg('--db', process.env.PLATFORM_DB_PATH || '/srv/ai-kids-platform/production/data/platform.db'));
const dryRun = process.argv.includes('--dry-run');
if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);

const MODALITY_ORDER = [['text', 'TEXT'], ['image', 'IMAGE'], ['video', 'VIDEO']];

function boxId() {
  return `box_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

// 旧结构按模态存「数量 + 一套参数」，迁移时按 count 展开成等量的同参数框体。
function boxesFromSlots(slots) {
  const boxes = [];
  let index = 0;
  for (const [key, modality] of MODALITY_ORDER) {
    const slot = slots && typeof slots[key] === 'object' && slots[key] ? slots[key] : {};
    const count = Math.max(0, Math.min(20, Math.trunc(Number(slot.count) || 0)));
    for (let i = 0; i < count; i += 1) {
      index += 1;
      const box = {
        id: boxId(),
        title: `素材${index}`,
        modality,
        model: String(slot.model || '').trim().slice(0, 120),
        prompt: '',
        assetUrl: '',
      };
      if (modality !== 'TEXT') {
        box.aspectRatio = String(slot.aspectRatio || '').trim().slice(0, 24);
        box.resolution = String(slot.resolution || slot.size || '').trim().slice(0, 24);
      }
      if (modality === 'VIDEO') {
        box.durationSeconds = Number(slot.durationSeconds) || 5;
        box.audio = slot.audio === true;
      }
      boxes.push(box);
    }
  }
  return boxes;
}

const db = new DatabaseSync(dbPath);
const lessons = db.prepare('SELECT id,title,classroom_config FROM course_lessons ORDER BY sort, created_at').all();
const update = db.prepare('UPDATE course_lessons SET classroom_config=?, updated_at=? WHERE id=?');
const now = new Date().toISOString();
const migrated = [];
let skipped = 0;

db.exec('BEGIN');
try {
  for (const lesson of lessons) {
    let config = {};
    try { config = JSON.parse(lesson.classroom_config || '{}') || {}; } catch { config = {}; }
    const hasLegacy = config.generationSlots && typeof config.generationSlots === 'object';
    const hasBoxes = Array.isArray(config.generationBoxes) && config.generationBoxes.length > 0;
    if (!hasLegacy || hasBoxes) { skipped += 1; continue; }
    const { generationSlots, ...rest } = config;
    const generationBoxes = boxesFromSlots(generationSlots);
    const next = { ...rest, version: 2, generationBoxes };
    if (!dryRun) update.run(JSON.stringify(next), now, lesson.id);
    migrated.push({
      lesson: lesson.title,
      from: MODALITY_ORDER.map(([key, modality]) => `${modality}:${Number(generationSlots[key]?.count || 0)}`).join(' '),
      to: generationBoxes.length,
      boxes: generationBoxes.map((box) => `${box.title}(${box.modality}${box.aspectRatio ? ' ' + box.aspectRatio : ''}${box.resolution ? ' ' + box.resolution : ''}${box.durationSeconds ? ' ' + box.durationSeconds + 's' : ''}${box.model ? ' ' + box.model : ''})`),
    });
  }
  if (dryRun) db.exec('ROLLBACK'); else db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  throw error;
} finally {
  db.close();
}

console.log(`${dryRun ? '[dry-run] ' : ''}数据库：${dbPath}`);
console.log(`${dryRun ? '[dry-run] ' : ''}扫描课时 ${lessons.length} 个：迁移 ${migrated.length} 个，跳过（无旧结构/已有框体）${skipped} 个`);
for (const item of migrated) {
  console.log(`  - ${item.lesson}：${item.from} → ${item.to} 个框体`);
  for (const box of item.boxes) console.log(`      ${box}`);
}
