#!/usr/bin/env node
/**
 * 一次性数据迁移（2026-09-18）：官网 CMS 内容随「品牌改名 + 去掉积分口径」一起升级。
 *
 * 为什么必须单独跑一次：`packages/database/src/seed.js` 的 ensureWebsiteContent() 是 **insert-only**
 * （库里已有那一行就再也不动它），所以改种子只对全新库生效 —— 生产库里 2026-09-03 种下的
 * HOME / FAQ / BRAND 三行会原地不变，官网继续显示「AI魔法学院」和「灵动值计费」。
 *
 * 这个脚本做四件事，全部是「精确匹配」或「缺了就补」，不覆盖运营已经改过的文案：
 *   ① 品牌改名：website_contents 与 website_content_revisions 里的
 *      「AI魔法学院」/「AI 魔法学院」→「灵动ai学院」。
 *      （两种旧写法都要换：同一个站点里曾经并存；画布页还是第三种「灵动ai」，那个不动。）
 *   ② 去掉积分口径：HOME 描述里的「灵动值计费」→「授权次数」。
 *      只替换这个确切串，不做通配 —— 免得把别的句子改坏。
 *   ③ 补种新键：INTRO（灵动介绍）、HANDBOOK（机构手册）两行整行插入（含已发布版本，
 *      否则公开接口返回 NOT_FOUND，官网只能退回前端 fallback）。
 *   ④ 补新字段：HOME.stats（首页数据区）缺失时补上；FAQ 里「授权次数用完会怎样」那条缺失时追加。
 *
 * ⚠️ 这里改的是**官网公开面真正显示的内容**。所以流程是：先打印计划 →（--dry-run 只看）→
 *    事务内写入 → 复查残留必须为 0。改动前确认整库备份在（production/backups/<stamp>/platform.db）。
 *
 * 用法：
 *   node deploy/production/migrate-website-content-20260918.mjs --db <platform.db> --dry-run
 *   node deploy/production/migrate-website-content-20260918.mjs --db <platform.db>
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

const BRAND_FROM = ['AI魔法学院', 'AI 魔法学院'];
const BRAND_TO = '灵动ai学院';
// ⚠️ 改文案的替换也要列在这里（而不是只改种子）：否则「新旧两条都在」——
// 比如 FAQ 那条问题从「Windows 机房和 Mac 教室都能用吗？」改成「机房和教室的电脑都能用吗？」，
// 只按问题文字判缺失的话，迁移会把新问法**追加**进去，官网上就出现两条重复问答。
const TERMS = [
  ['灵动值计费', '授权次数'],
  ['Windows 机房和 Mac 教室都能用吗？', '机房和教室的电脑都能用吗？'],
];
const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

const replaceBrand = (value) => BRAND_FROM.reduce((text, from) => String(text || '').replaceAll(from, BRAND_TO), String(value || ''));
const countBrand = (value) => BRAND_FROM.reduce((n, from) => n + (String(value || '').split(from).length - 1), 0);
const countTerms = (value) => TERMS.reduce((n, [from]) => n + (String(value || '').split(from).length - 1), 0);
const applyTerms = (value) => TERMS.reduce((text, [from, to]) => text.replaceAll(from, to), String(value || ''));
// 文本字段一律先过这一道：品牌改名 + 口径/文案替换，两者都不做通配。
const patchText = (value) => applyTerms(replaceBrand(value));

const db = new DatabaseSync(dbPath);
const contentRows = db.prepare('SELECT * FROM website_contents').all();
const revisionRows = db.prepare('SELECT id, content_key, version, content FROM website_content_revisions').all();
const byKey = Object.fromEntries(contentRows.map((row) => [row.content_key, row]));

// ── 计划 ────────────────────────────────────────────────────────────────
const textPlan = contentRows
  .map((row) => ({ key: row.content_key, brand: countBrand(row.draft_content) + countBrand(row.published_content), terms: countTerms(row.draft_content) + countTerms(row.published_content) }))
  .filter((item) => item.brand || item.terms);
const revisionPlan = revisionRows
  .map((row) => ({ id: row.id, key: row.content_key, version: row.version, brand: countBrand(row.content), terms: countTerms(row.content) }))
  .filter((item) => item.brand || item.terms);

const missingKeys = ['INTRO', 'HANDBOOK'].filter((key) => !byKey[key]);
const homeRow = byKey.HOME;
const homeStats = homeRow ? (JSON.parse(homeRow.published_content || homeRow.draft_content || '{}').stats || null) : null;
const needStats = Boolean(homeRow) && !Array.isArray(homeStats);
const faqRow = byKey.FAQ;
// 缺失判断必须**在替换之后**做：替换会把旧问法改成新问法，之后再比对才不会重复追加。
const faqItems = faqRow ? (JSON.parse(patchText(faqRow.published_content || faqRow.draft_content) || '{}').items || []) : [];
const missingFaq = (WEBSITE_CONTENT_DEFAULTS.FAQ.items || []).filter((item) => !faqItems.some((existing) => existing.question === item.question));

console.log(`数据库：${dbPath}`);
console.log(`① 品牌改名 ${BRAND_FROM.join(' / ')} → ${BRAND_TO}`);
console.log(`   website_contents 待改 ${textPlan.length} 行 ${JSON.stringify(textPlan)}`);
console.log(`   website_content_revisions 待改 ${revisionPlan.length} 行 ${JSON.stringify(revisionPlan)}`);
console.log(`② 口径替换 ${JSON.stringify(TERMS)}`);
console.log(`③ 补种新键：${missingKeys.length ? missingKeys.join(', ') : '（无，已存在）'}`);
console.log(`④ 补字段：HOME.stats ${needStats ? '缺失→补' : '（已有）'}；FAQ 缺 ${missingFaq.length} 条${missingFaq.length ? '：' + missingFaq.map((item) => item.question).join(' / ') : ''}`);

const nothingToDo = !textPlan.length && !revisionPlan.length && !missingKeys.length && !needStats && !missingFaq.length;
if (nothingToDo) {
  console.log('结论：无需改动（幂等，已迁移过）。');
  db.close();
  process.exit(0);
}
if (dryRun) {
  console.log('结论：--dry-run，未写入。');
  db.close();
  process.exit(0);
}

// ── 写入 ────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
db.exec('BEGIN');
try {
  const updateContent = db.prepare('UPDATE website_contents SET draft_content=?, published_content=?, updated_at=? WHERE content_key=?');
  const updateRevision = db.prepare('UPDATE website_content_revisions SET content=? WHERE id=?');
  const insertContent = db.prepare('INSERT INTO website_contents(content_key,draft_content,published_content,draft_version,published_version,updated_by,published_by,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insertRevision = db.prepare('INSERT INTO website_content_revisions(id,content_key,version,content,action,changed_by,reason,created_at) VALUES (?,?,?,?,?,?,?,?)');

  for (const row of contentRows) {
    if (!countBrand(row.draft_content) && !countBrand(row.published_content) && !countTerms(row.draft_content) && !countTerms(row.published_content)) continue;
    updateContent.run(patchText(row.draft_content), patchText(row.published_content), now, row.content_key);
  }
  for (const row of revisionRows) {
    if (!countBrand(row.content) && !countTerms(row.content)) continue;
    updateRevision.run(patchText(row.content), row.id);
  }
  // HOME.stats：只补字段，不动已有文案
  if (needStats) {
    const content = JSON.parse(patchText(homeRow.published_content || homeRow.draft_content));
    content.stats = WEBSITE_CONTENT_DEFAULTS.HOME.stats;
    updateContent.run(JSON.stringify(content), JSON.stringify(content), now, 'HOME');
  }
  // FAQ：只追加缺失的问题，不覆盖已有条目
  if (missingFaq.length) {
    const content = JSON.parse(patchText(faqRow.published_content || faqRow.draft_content));
    content.items = [...(content.items || []), ...missingFaq];
    updateContent.run(JSON.stringify(content), JSON.stringify(content), now, 'FAQ');
  }
  // 新键：整行插入（含发布版本，否则公开接口返回 NOT_FOUND）
  for (const key of missingKeys) {
    const value = JSON.stringify(WEBSITE_CONTENT_DEFAULTS[key]);
    insertContent.run(key, value, value, 1, 1, null, null, now, now, now);
    insertRevision.run(id('wrev'), key, 1, value, 'PUBLISH', null, 'migrate run: seed new key', now);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// ── 复查 ────────────────────────────────────────────────────────────────
const leftovers = db.prepare("SELECT content_key FROM website_contents WHERE draft_content LIKE '%AI魔法学院%' OR published_content LIKE '%AI魔法学院%' OR draft_content LIKE '%AI 魔法学院%' OR published_content LIKE '%AI 魔法学院%' OR draft_content LIKE '%灵动值%' OR published_content LIKE '%灵动值%'").all();
const revisionLeftovers = db.prepare("SELECT COUNT(*) AS n FROM website_content_revisions WHERE content LIKE '%AI魔法学院%' OR content LIKE '%AI 魔法学院%' OR content LIKE '%灵动值%'").get();
const finalKeys = db.prepare('SELECT content_key FROM website_contents ORDER BY content_key').all().map((row) => row.content_key);
console.log(`已写入。复查残留：website_contents ${leftovers.length} 行 ${JSON.stringify(leftovers.map((row) => row.content_key))} / revisions ${revisionLeftovers.n} 行（都应为 0）。`);
console.log(`现有键：${finalKeys.join(', ')}`);
db.close();
