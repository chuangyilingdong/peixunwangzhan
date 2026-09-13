#!/usr/bin/env node
/**
 * 一次性数据迁移：官网 CMS 里已落库的营销文案，把「魔法石」改成「灵动值」。
 *
 * 为什么需要它：`packages/database/src/seed.js` 的 ensureWebsiteContent() 是 **insert-only**
 * （库里没有那一行才写种子），所以改种子只对全新库生效。生产库在 2026-09-03 就已经把
 * HOME / FAQ / BRAND 三行种下去了，改代码不动它们 —— 官网文案不会变。
 *
 * 改哪些：
 *   website_contents.draft_content / published_content（JSON 文本，整串替换）
 *   website_content_revisions.content（历史版本，一起改，免得回滚又滚回旧词）
 *
 * 幂等：只替换含「魔法石」的串；跑第二遍会报「无需改动」。
 *
 * 用法：
 *   node deploy/production/migrate-marketing-terms.mjs --db /path/platform.db --dry-run
 *   node deploy/production/migrate-marketing-terms.mjs --db /path/platform.db
 */
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

const FROM = '魔法石';
const TO = '灵动值';

const countOccurrences = (value) => (String(value || '').split(FROM).length - 1);

const db = new DatabaseSync(dbPath);

// 先盘点，再决定要不要写 —— 输出必须能让人一眼看出「改了几行、几处」。
const contentRows = db.prepare('SELECT content_key, draft_content, published_content FROM website_contents').all();
const revisionRows = db.prepare('SELECT id, content_key, version, content FROM website_content_revisions').all();

const contentPlan = contentRows
  .map((row) => ({
    key: row.content_key,
    draft: countOccurrences(row.draft_content),
    published: countOccurrences(row.published_content),
  }))
  .filter((item) => item.draft || item.published);
const revisionPlan = revisionRows
  .map((row) => ({ id: row.id, key: row.content_key, version: row.version, hits: countOccurrences(row.content) }))
  .filter((item) => item.hits);

console.log(`数据库：${dbPath}`);
console.log(`替换：${FROM} → ${TO}`);
console.log(`website_contents 待改：${contentPlan.length} 行 ${JSON.stringify(contentPlan)}`);
console.log(`website_content_revisions 待改：${revisionPlan.length} 行 ${JSON.stringify(revisionPlan)}`);

if (!contentPlan.length && !revisionPlan.length) {
  console.log('结论：无需改动（幂等，已迁移过）。');
  db.close();
  process.exit(0);
}

if (dryRun) {
  console.log('结论：--dry-run，未写入。');
  db.close();
  process.exit(0);
}

const replaceAll = (value) => String(value || '').replaceAll(FROM, TO);

db.exec('BEGIN');
try {
  const updateContent = db.prepare('UPDATE website_contents SET draft_content=?, published_content=? WHERE content_key=?');
  for (const row of contentRows) {
    if (!countOccurrences(row.draft_content) && !countOccurrences(row.published_content)) continue;
    updateContent.run(replaceAll(row.draft_content), replaceAll(row.published_content), row.content_key);
  }
  const updateRevision = db.prepare('UPDATE website_content_revisions SET content=? WHERE id=?');
  for (const row of revisionRows) {
    if (!countOccurrences(row.content)) continue;
    updateRevision.run(replaceAll(row.content), row.id);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// 复查：库里不该再有任何「魔法石」。
const leftovers = db.prepare('SELECT COUNT(*) AS n FROM website_contents WHERE draft_content LIKE ? OR published_content LIKE ?').get(`%${FROM}%`, `%${FROM}%`);
const revisionLeftovers = db.prepare('SELECT COUNT(*) AS n FROM website_content_revisions WHERE content LIKE ?').get(`%${FROM}%`);
console.log(`已写入。复查残留：website_contents ${leftovers.n} 行 / revisions ${revisionLeftovers.n} 行（都应为 0）。`);
db.close();
