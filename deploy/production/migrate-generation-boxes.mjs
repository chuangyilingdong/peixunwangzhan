#!/usr/bin/env node
/**
 * 一次性数据迁移：把课时里的生成框体配置搬到素材表（框体就是一种素材）。
 *
 * 两跳，幂等：
 *   A. classroom_config.generationSlots（按模态计数 + 一套参数）→ 等价框体列表（内存里完成）
 *   B. 框体列表 → course_lesson_material_groups / course_lesson_materials
 *      （新建「生成框体」素材组，每个框体一条 material_type=GENERATION_BOX 的素材）
 *   之后 classroom_config 只保留 {version:3, ...其他键}。
 *
 * 为什么要 B：2026-09-09 起「框体也是素材的一部分」，顺序跟素材走，学生端才能做到
 * 「素材1 → 框体1 → 素材2 → 框体2」这样逐条交叉。
 *
 * 用法：
 *   node deploy/production/migrate-generation-boxes.mjs --db /path/platform.db --dry-run
 *   node deploy/production/migrate-generation-boxes.mjs --db /path/platform.db
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
const BOX_GROUP_TITLE = '生成框体';

const newId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;

// 跳 A：旧结构按模态存「数量 + 一套参数」，展开成等量的同参数框体。
function boxesFromSlots(slots) {
  const boxes = [];
  let index = 0;
  for (const [key, modality] of MODALITY_ORDER) {
    const slot = slots && typeof slots[key] === 'object' && slots[key] ? slots[key] : {};
    const count = Math.max(0, Math.min(20, Math.trunc(Number(slot.count) || 0)));
    for (let i = 0; i < count; i += 1) {
      index += 1;
      const box = {
        id: newId('box'),
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

function boxSnapshot(box) {
  const snapshot = { box: { modality: String(box.modality || '').toUpperCase(), model: String(box.model || '') } };
  if (snapshot.box.modality !== 'TEXT') {
    snapshot.box.aspectRatio = String(box.aspectRatio || '');
    snapshot.box.resolution = String(box.resolution || '');
  }
  if (snapshot.box.modality === 'VIDEO') {
    snapshot.box.durationSeconds = Number(box.durationSeconds) || 5;
    snapshot.box.audio = box.audio === true;
  }
  snapshot.content = String(box.prompt || '');
  return snapshot;
}

const db = new DatabaseSync(dbPath);
const lessons = db.prepare('SELECT id,title,classroom_config FROM course_lessons ORDER BY sort, created_at').all();
const boxMaterialCount = db.prepare("SELECT COUNT(*) n FROM course_lesson_materials material JOIN course_lesson_material_groups grp ON grp.id=material.group_id WHERE grp.lesson_id=? AND material.material_type='GENERATION_BOX'");
const maxGroupSort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM course_lesson_material_groups WHERE lesson_id=?');
const insertGroup = db.prepare('INSERT INTO course_lesson_material_groups(id,lesson_id,title,sort,created_at,updated_at) VALUES (?,?,?,?,?,?)');
const insertMaterial = db.prepare('INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
const updateLesson = db.prepare('UPDATE course_lessons SET classroom_config=?, updated_at=? WHERE id=?');
const now = new Date().toISOString();
const migrated = [];
let skipped = 0;

db.exec('BEGIN');
try {
  for (const lesson of lessons) {
    let config = {};
    try { config = JSON.parse(lesson.classroom_config || '{}') || {}; } catch { config = {}; }
    const hasSlots = config.generationSlots && typeof config.generationSlots === 'object';
    const legacyBoxes = Array.isArray(config.generationBoxes) ? config.generationBoxes : [];
    const existingBoxMaterials = Number(boxMaterialCount.get(lesson.id)?.n || 0);
    if (!hasSlots && !legacyBoxes.length && !existingBoxMaterials) { skipped += 1; continue; }
    if (!hasSlots && !legacyBoxes.length) { skipped += 1; continue; }

    const boxes = legacyBoxes.length ? legacyBoxes : boxesFromSlots(config.generationSlots);
    const { generationSlots, generationBoxes, ...rest } = config;
    const nextConfig = { ...rest, version: 3 };

    if (boxes.length) {
      const groupId = newId('material-group');
      const groupSort = Number(maxGroupSort.get(lesson.id)?.m || 0) + 1;
      if (!dryRun) {
        insertGroup.run(groupId, lesson.id, BOX_GROUP_TITLE, groupSort, now, now);
        boxes.forEach((box, index) => {
          insertMaterial.run(
            newId('material'), groupId,
            String(box.title || `素材${index + 1}`).trim().slice(0, 160), '',
            'GENERATION_BOX',
            box.assetUrl ? String(box.assetUrl).slice(0, 2000) : null,
            JSON.stringify(boxSnapshot(box)),
            index + 1, now, now,
          );
        });
      }
    }
    if (!dryRun) updateLesson.run(JSON.stringify(nextConfig), now, lesson.id);
    migrated.push({
      lesson: lesson.title,
      from: hasSlots
        ? MODALITY_ORDER.map(([key, modality]) => `${modality}:${Number(config.generationSlots[key]?.count || 0)}`).join(' ')
        : `旧 generationBoxes:${legacyBoxes.length}`,
      to: boxes.length,
      boxes: boxes.map((box) => `${box.title}(${box.modality}${box.aspectRatio ? ' ' + box.aspectRatio : ''}${box.resolution ? ' ' + box.resolution : ''}${box.durationSeconds ? ' ' + box.durationSeconds + 's' : ''}${box.model ? ' ' + box.model : ''})`),
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
console.log(`${dryRun ? '[dry-run] ' : ''}扫描课时 ${lessons.length} 个：迁移 ${migrated.length} 个，跳过（已迁移/无框体）${skipped} 个`);
for (const item of migrated) {
  console.log(`  - ${item.lesson}：${item.from} → 「${BOX_GROUP_TITLE}」组 ${item.to} 条框体素材`);
  for (const box of item.boxes) console.log(`      ${box}`);
}
