#!/usr/bin/env node
/**
 * 一次性数据迁移（2026-09-19）：**机构手册（website_contents.HANDBOOK）整页换成设计稿的内容**。
 *
 * 为什么必须单独跑：`packages/database/src/seed.js` 的 `ensureWebsiteContent()` 是 **insert-only**
 * （库里已有那一行就再也不动它），所以改了 `websiteContentDefaults.HANDBOOK` 对生产库里那一行
 * **完全无效** —— 官网会读到老形状（`sections` / `compareRows`），新页面上的
 * `hero` / `about` / `poster` / `work` / `compare` / `cta` 全是 undefined，页面等于空壳。
 *
 * 用户口径（2026-09-19）：「机构手册页面按照压缩包改造下」，旧的 **8 个章节 + 7 行对比表**
 * 一起**彻底换成稿子的内容**。老内容已经留底在
 * `docs/operations/handbook-旧内容留底-20260919.md`；这个脚本在写入前**还会再 dump 一份 JSON**
 * 到数据库同级的 `backups/` 下（双保险，且带时间戳）。
 *
 * 幂等：库里已是新形状（六个键齐）就跳过并报「无需改动」。
 *
 * ⚠️ 这是**覆盖官网公开面内容**的操作。流程：先打印计划 →（`--dry-run` 只看）→ 事务内写入 → 复查。
 *    跑之前确认整库备份在（`production/backups/<stamp>/platform.db`）。
 *
 * 用法：
 *   node deploy/production/migrate-handbook-content-20260919.mjs --db <platform.db> --dry-run
 *   node deploy/production/migrate-handbook-content-20260919.mjs --db <platform.db>
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WEBSITE_CONTENT_DEFAULTS } from '../../packages/database/src/websiteContentDefaults.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback;
}
const dbPath = path.resolve(arg('--db', process.env.PLATFORM_DB_PATH || '/srv/ai-kids-platform/production/data/platform.db'));
const dryRun = process.argv.includes('--dry-run');
if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);

const KEY = 'HANDBOOK';
const NEXT = WEBSITE_CONTENT_DEFAULTS[KEY];
/** 新形状的六个分区 —— 齐了就算已经迁过（幂等判据）。 */
const SECTIONS = ['hero', 'about', 'poster', 'work', 'compare', 'cta'];
const isNewShape = (content) => Boolean(content) && SECTIONS.every((key) => content[key] && typeof content[key] === 'object');
const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

console.log(`数据库：${dbPath}`);
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 15000');
const rowData = db.prepare('SELECT content_key, draft_content, published_content, draft_version, published_version FROM website_contents WHERE content_key=?').get(KEY);

if (rowData) {
  let draft = null;
  try { draft = JSON.parse(rowData.draft_content || '{}'); } catch { /* 坏 JSON 当老形状处理 */ }
  console.log(`现有 HANDBOOK：draft v${rowData.draft_version} / published v${rowData.published_version}`);
  console.log(`  顶层键：${Object.keys(draft || {}).join(', ') || '（空）'}`);
  if (isNewShape(draft)) {
    console.log('结论：已经是设计稿的新形状（六个分区齐全），无需改动（幂等）。');
    db.close();
    process.exit(0);
  }
} else {
  console.log('现有 HANDBOOK：（库里没有这一行，将整行插入）');
}

console.log('将写入的新内容：');
console.log(`  主视觉：${NEXT.hero.line1} / ${NEXT.hero.line2}`);
console.log(`  关于：${NEXT.about.headingLines.join(' / ')}`);
console.log(`  海报：${NEXT.poster.title}（${NEXT.poster.imageUrl}）`);
console.log(`  横滑卡片：${NEXT.work.cards.length} 张 —— ${NEXT.work.cards.map((card) => card.title).join(' / ')}`);
console.log(`  对比：${NEXT.compare.headingLines.join(' / ')}`);
console.log(`  结尾行动：${NEXT.cta.headline}`);

if (dryRun) {
  console.log('结论：--dry-run，未写入。');
  db.close();
  process.exit(0);
}

// ── 写入 ────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const stamp = now.replace(/[:.]/g, '-');
const backupDir = path.join(path.dirname(dbPath), 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `handbook-before-${stamp}.json`);
if (rowData) {
  fs.writeFileSync(backupPath, JSON.stringify({ migratedAt: now, key: KEY, draft: JSON.parse(rowData.draft_content || '{}'), published: JSON.parse(rowData.published_content || '{}') }, null, 2));
  console.log(`老内容已留底：${backupPath}`);
}

const payload = JSON.stringify(NEXT);
db.exec('BEGIN');
try {
  if (rowData) {
    const nextDraft = Number(rowData.draft_version || 1) + 1;
    const nextPublished = Number(rowData.published_version || 0) + 1;
    db.prepare('UPDATE website_contents SET draft_content=?, published_content=?, draft_version=?, published_version=?, updated_at=?, published_at=? WHERE content_key=?')
      .run(payload, payload, nextDraft, nextPublished, now, now, KEY);
    db.prepare('INSERT INTO website_content_revisions(id,content_key,version,content,action,changed_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id('wrev'), KEY, nextPublished, payload, 'PUBLISH', null, 'migrate run: handbook redesigned per design zip', now);
    console.log(`已更新：draft v${nextDraft} / published v${nextPublished}`);
  } else {
    db.prepare('INSERT INTO website_contents(content_key,draft_content,published_content,draft_version,published_version,updated_by,published_by,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(KEY, payload, payload, 1, 1, null, null, now, now, now);
    db.prepare('INSERT INTO website_content_revisions(id,content_key,version,content,action,changed_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id('wrev'), KEY, 1, payload, 'PUBLISH', null, 'migrate run: seed handbook', now);
    console.log('已插入新行（draft v1 / published v1）');
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// ── 复查 ────────────────────────────────────────────────────────────────
const after = db.prepare('SELECT draft_content, published_content, draft_version, published_version FROM website_contents WHERE content_key=?').get(KEY);
const draftOk = isNewShape(JSON.parse(after.draft_content));
const publishedOk = isNewShape(JSON.parse(after.published_content));
const sameAsSeed = after.published_content === payload;
console.log(`复查：draft 新形状=${draftOk} / published 新形状=${publishedOk} / 与默认内容逐字一致=${sameAsSeed}`);
if (!draftOk || !publishedOk || !sameAsSeed) { console.error('!! 复查没过，请人工看一眼'); db.close(); process.exit(1); }
console.log('HANDBOOK_MIGRATED');
db.close();
