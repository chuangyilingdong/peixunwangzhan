#!/usr/bin/env node
/**
 * 一次性数据迁移（2026-09-19）：**机构手册（website_contents.HANDBOOK）整页换成设计稿的内容**，
 * 之后兼作「**新字段补齐**」的小工具。
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
 * 两种模式（按库里现状自动判断，都幂等）：
 *   ① **换形状**：还是老的 `sections/compareRows` → 整块写成默认内容；
 *   ② **补字段**：形状已经是新的，但**缺了后来新加的子字段**（例如 2026-09-19 晚加的
 *      `hero.loaderWord`）→ **只补缺的那些键**，运营改过的值一律不动。
 *      ⚠️ 为什么非得补：官网渲染是「存储 + 默认」逐字段合并，所以缺字段时**线上有字**；
 *      而后台表单直接绑存储，缺字段时**输入框是空的** —— 两边对不上，运营会以为没保存上。
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
/** 新形状的六个分区 —— 齐了就算形状已迁过。 */
const SECTIONS = ['hero', 'about', 'poster', 'work', 'compare', 'cta'];
const isNewShape = (content) => Boolean(content) && SECTIONS.every((key) => content[key] && typeof content[key] === 'object');

/** 缺的键拿默认值补上；**已有的值一律不动**（运营改过的文案不能被默认值盖掉）。递归进对象，不进数组。 */
function fillMissing(stored, fallback) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return fallback;
  const out = { ...stored };
  for (const [key, value] of Object.entries(fallback)) {
    if (out[key] === undefined) out[key] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = fillMissing(out[key], value);
  }
  return out;
}
/** 列出被补上的键路径（给人看的）。 */
function missingPaths(stored, fallback, prefix = '') {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
  const out = [];
  for (const [key, value] of Object.entries(fallback)) {
    const where = prefix ? `${prefix}.${key}` : key;
    if (stored[key] === undefined) out.push(where);
    else if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...missingPaths(stored[key], value, where));
  }
  return out;
}

console.log(`数据库：${dbPath}`);
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 15000');
const rowData = db.prepare('SELECT content_key, draft_content, published_content, draft_version, published_version FROM website_contents WHERE content_key=?').get(KEY);

let mode = 'insert';
let payload = JSON.stringify(NEXT);
if (rowData) {
  let draft = null;
  try { draft = JSON.parse(rowData.draft_content || '{}'); } catch { /* 坏 JSON 当老形状处理 */ }
  console.log(`现有 HANDBOOK：draft v${rowData.draft_version} / published v${rowData.published_version}`);
  console.log(`  顶层键：${Object.keys(draft || {}).join(', ') || '（空）'}`);
  if (!isNewShape(draft)) {
    mode = 'reshape';
    console.log('模式：**换形状** —— 还是老的 sections/compareRows，整块写成设计稿的内容。');
    console.log('将写入的新内容：');
    console.log(`  主视觉：${NEXT.hero.line1} / ${NEXT.hero.line2}（幕布：${NEXT.hero.loaderWord}）`);
    console.log(`  关于：${NEXT.about.headingLines.join(' / ')}`);
    console.log(`  海报：${NEXT.poster.title}（${NEXT.poster.imageUrl}）`);
    console.log(`  横滑卡片：${NEXT.work.cards.length} 张 —— ${NEXT.work.cards.map((card) => card.title).join(' / ')}`);
    console.log(`  对比：${NEXT.compare.headingLines.join(' / ')}`);
    console.log(`  结尾行动：${NEXT.cta.headline}`);
  } else {
    const missing = missingPaths(draft, NEXT);
    if (!missing.length) {
      console.log('结论：形状是新的、字段也齐，无需改动（幂等）。');
      db.close();
      process.exit(0);
    }
    mode = 'fill';
    console.log(`模式：**补字段** —— 缺 ${missing.length} 个键，只补这些（已有的值不动）：`);
    console.log(`  ${missing.join('、')}`);
    payload = JSON.stringify(fillMissing(draft, NEXT));
  }
} else {
  console.log('现有 HANDBOOK：（库里没有这一行，将整行插入）');
}

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
if (rowData) {
  const backupPath = path.join(backupDir, `handbook-before-${mode}-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ migratedAt: now, mode, key: KEY, draft: JSON.parse(rowData.draft_content || '{}'), published: JSON.parse(rowData.published_content || '{}') }, null, 2));
  console.log(`写入前的旧内容已留底：${backupPath}`);
}

const reason = mode === 'fill' ? 'migrate run: handbook fill new fields' : 'migrate run: handbook redesigned per design zip';
db.exec('BEGIN');
try {
  if (rowData) {
    const nextDraft = Number(rowData.draft_version || 1) + 1;
    const nextPublished = Number(rowData.published_version || 0) + 1;
    // 补字段时 draft 与 published 都按各自现状补 —— 别把草稿里没发布的改动冲掉
    const draftPayload = mode === 'fill' ? JSON.stringify(fillMissing(JSON.parse(rowData.draft_content || '{}'), NEXT)) : payload;
    db.prepare('UPDATE website_contents SET draft_content=?, published_content=?, draft_version=?, published_version=?, updated_at=?, published_at=? WHERE content_key=?')
      .run(draftPayload, payload, nextDraft, nextPublished, now, now, KEY);
    db.prepare('INSERT INTO website_content_revisions(id,content_key,version,content,action,changed_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id('wrev'), KEY, nextPublished, payload, 'PUBLISH', null, reason, now);
    console.log(`已更新：draft v${nextDraft} / published v${nextPublished}`);
  } else {
    db.prepare('INSERT INTO website_contents(content_key,draft_content,published_content,draft_version,published_version,updated_by,published_by,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(KEY, payload, payload, 1, 1, null, null, now, now, now);
    db.prepare('INSERT INTO website_content_revisions(id,content_key,version,content,action,changed_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id('wrev'), KEY, 1, payload, 'PUBLISH', null, reason, now);
    console.log('已插入新行（draft v1 / published v1）');
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// ── 复查 ────────────────────────────────────────────────────────────────
const after = db.prepare('SELECT draft_content, published_content, draft_version, published_version FROM website_contents WHERE content_key=?').get(KEY);
const published = JSON.parse(after.published_content);
const draftOk = isNewShape(JSON.parse(after.draft_content));
const publishedOk = isNewShape(published);
const stillMissing = missingPaths(published, NEXT);
console.log(`复查：draft 新形状=${draftOk} / published 新形状=${publishedOk} / 还缺的键=${stillMissing.length ? stillMissing.join('、') : '无'}`);
if (!draftOk || !publishedOk || stillMissing.length) { console.error('!! 复查没过，请人工看一眼'); db.close(); process.exit(1); }
console.log('HANDBOOK_MIGRATED');
db.close();
