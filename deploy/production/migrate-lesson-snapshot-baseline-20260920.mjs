#!/usr/bin/env node
/**
 * 一次性数据迁移（2026-09-20）：给**已有的课时**补一份「基线快照」，只写 `status` 一个键。
 *
 * ## 为什么必须跑（不跑就是线上事故）
 *
 * 2026-09-20 修了一个用户报的 bug：「我在课包创建了新的课时，选择发布状态。但是课包还没发布，
 * 机构/老师端却已经能选了」。根因是读面判断「这节能不能被机构端/学生端/官网看到」时用的是
 * **实时列** `course_lessons.status`，而不是「更新发布」时定格的快照 —— 于是没发布的课时提前露面。
 *
 * 修法把判据换成了 `publishedLessonVisibilitySql`（见 `apps/server/src/lib.js`）：
 *   · 课包**一节课时都没定格过** → 回退实时（老数据口径）；
 *   · 课包定格过 → **只认快照里的 status**：没有快照的课时（本次发布之后新建的）一律不可见。
 *
 * ⚠️ 于是问题来了：线上有课包「定格过，但大部分课时没有快照」（S1 就是：9 节已发布里只有 1 节有），
 *    切换判据的瞬间它们会**当场从机构端掉掉**。所以必须先把「每个课时当前的 status」写成基线快照，
 *    让判据切换前后**可见集合完全一致**。
 *
 * ## 只写 status，不动别的
 *
 * - **不**动 `published_title`（读面是 `COALESCE(published_title, title)`，留空即沿用实时标题，
 *   行为与迁移前一致）；
 * - **不**动 `course_series.published_content` —— 那会把平台「改了但还没发布」的课包字段
 *   当成已发布内容定格下来，与草稿隔离的本意相反；
 * - 已有快照的课时**只补 status 键**，其余键原样保留（那些是真正发布过的内容，不能被冲掉）。
 *   没有快照的课时写成 `{"status":"<当前状态>"}` —— 内容继续回退实时，等下次「更新发布」再定格。
 *
 * ## 流程
 *
 * 打印计划 →（`--dry-run` 只看）→ 留底 JSON → 一个事务 → 复查（每个课包「新判据可见数」必须
 * 等于「迁移前实时已发布数」）。跑之前确认整库备份在（`production/backups/<stamp>/platform.db`）。
 *
 * 用法：
 *   node deploy/production/migrate-lesson-snapshot-baseline-20260920.mjs --db <platform.db> --dry-run
 *   node deploy/production/migrate-lesson-snapshot-baseline-20260920.mjs --db <platform.db>
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

/** 快照里的 status；没有快照 / 不是对象 / 坏 JSON 都返回 null（= 没定格过）。 */
function snapshotStatus(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && typeof parsed.status === 'string' ? parsed.status : null;
  } catch {
    return null;
  }
}
/** 与 `publishedLessonVisibilitySql` 同一套判据（那边的 SQL、这边的 JS，语义必须一致）。 */
function visibleToReadingFaces(lesson, seriesBaselined) {
  const snapped = snapshotStatus(lesson.published_content);
  if (!seriesBaselined) return lesson.status === 'PUBLISHED';
  return snapped === 'PUBLISHED';
}
/**
 * 模拟「迁移写完这一刻」的样子：把 status 键并进已有快照（其余键保留；坏 JSON / 没快照按空对象算）。
 * 与下面真正的写入用的是同一段逻辑 —— 写之前先用它算一遍，才能在不改变任何可见集合上做出承诺。
 */
function afterMigrationSnapshot(lesson) {
  let parsed = {};
  if (lesson.published_content) {
    try { const value = JSON.parse(lesson.published_content); if (value && typeof value === 'object') parsed = value; } catch { /* 坏 JSON 按没有快照处理 */ }
  }
  return JSON.stringify({ ...parsed, status: lesson.status });
}

console.log(`数据库：${dbPath}`);
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 15000');
const seriesRows = db.prepare('SELECT id, title, version, status FROM course_series ORDER BY title').all();
const lessonRows = db.prepare('SELECT id, series_id, status, published_content FROM course_lessons').all();
console.log(`课包 ${seriesRows.length} 个 / 课时 ${lessonRows.length} 节`);

const bySeries = new Map();
for (const lesson of lessonRows) {
  if (!bySeries.has(lesson.series_id)) bySeries.set(lesson.series_id, []);
  bySeries.get(lesson.series_id).push(lesson);
}

const plan = [];
for (const series of seriesRows) {
  const lessons = bySeries.get(series.id) || [];
  const baselined = lessons.some((lesson) => lesson.published_content !== null && lesson.published_content !== undefined);
  const livePublished = lessons.filter((lesson) => lesson.status === 'PUBLISHED').length;
  // 迁移**之后**的可见数：按写入后的快照算（课包一律算已定格），必须与迁移前的实时已发布数相等
  // —— 这就是这次迁移要守住的不变量：**不改变任何机构能看到的课时**。
  const visibleAfter = lessons.filter((lesson) => visibleToReadingFaces({ ...lesson, published_content: afterMigrationSnapshot(lesson) }, true)).length;
  // 迁移**之前**、但判据已经切到新版时的可见数（用来演示"不迁移会掉多少"）
  const visibleIfSkipped = lessons.filter((lesson) => visibleToReadingFaces(lesson, baselined)).length;
  const needStatus = lessons.filter((lesson) => snapshotStatus(lesson.published_content) !== lesson.status);
  plan.push({ series, lessons, baselined, livePublished, visibleAfter, visibleIfSkipped, needStatus });
}

let touched = 0;
for (const item of plan) {
  if (!item.lessons.length && !item.needStatus.length) continue;
  const flag = item.visibleIfSkipped !== item.livePublished ? `   ⚠️ 不迁移会从 ${item.livePublished} 节掉到 ${item.visibleIfSkipped} 节` : '';
  console.log(`  · ${item.series.title}（v${item.series.version} / ${item.series.status}）课时 ${item.lessons.length} 节`
    + `，可见 ${item.livePublished} 节，需补 status 的 ${item.needStatus.length} 节${flag}`);
  touched += item.needStatus.length;
}
console.log(`合计需要补 status 的课时：${touched} 节`);
const broken = plan.filter((item) => item.visibleAfter !== item.livePublished);
if (broken.length) {
  console.error(`!! 有 ${broken.length} 个课包「迁移后可见数」与「迁移前实时已发布数」不一致，停下来人工看：${broken.map((item) => item.series.title).join('、')}`);
  db.close();
  process.exit(1);
}
console.log('不变量检查通过：每个课包迁移后的可见课时数 == 迁移前的实时已发布课时数（迁移不改变任何机构能看到的课时）。');

if (!touched) {
  console.log('结论：没有需要补的课时（幂等），未写入。');
  db.close();
  process.exit(0);
}
if (dryRun) {
  console.log('结论：--dry-run，未写入。');
  db.close();
  process.exit(0);
}

// ── 留底 ────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const stamp = now.replace(/[:.]/g, '-');
const backupDir = path.join(path.dirname(dbPath), 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `lessons-published-content-before-20260920-${stamp}.json`);
fs.writeFileSync(backupPath, JSON.stringify({
  migratedAt: now,
  note: '迁移前每个受影响课时的 published_content 原值（只补 status 键，其余键不变）',
  lessons: plan.flatMap((item) => item.needStatus.map((lesson) => ({
    series: item.series.title, id: lesson.id, status: lesson.status, published_content: lesson.published_content,
  }))),
}, null, 2));
console.log(`迁移前的内容已留底：${backupPath}`);

// ── 写入（一个事务）─────────────────────────────────────────────────────
const update = db.prepare('UPDATE course_lessons SET published_content=? WHERE id=?');
db.exec('BEGIN');
try {
  for (const item of plan) {
    for (const lesson of item.needStatus) {
      let parsed = {};
      if (lesson.published_content) { try { const value = JSON.parse(lesson.published_content); if (value && typeof value === 'object') parsed = value; } catch { /* 坏 JSON 按没有快照处理 */ } }
      update.run(JSON.stringify({ ...parsed, status: lesson.status }), lesson.id);
    }
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
console.log(`已写入 ${touched} 节课时。`);

// ── 复查 ────────────────────────────────────────────────────────────────
const after = db.prepare('SELECT id, series_id, status, published_content FROM course_lessons').all();
const afterBySeries = new Map();
for (const lesson of after) {
  if (!afterBySeries.has(lesson.series_id)) afterBySeries.set(lesson.series_id, []);
  afterBySeries.get(lesson.series_id).push(lesson);
}
let problems = 0;
const stillMissing = after.filter((lesson) => snapshotStatus(lesson.published_content) !== lesson.status);
if (stillMissing.length) { problems += 1; console.error(`!! 还有 ${stillMissing.length} 节课时的快照 status 与实时不一致`); }
for (const series of seriesRows) {
  const lessons = afterBySeries.get(series.id) || [];
  const baselined = lessons.some((lesson) => lesson.published_content != null);
  const visible = lessons.filter((lesson) => visibleToReadingFaces(lesson, baselined)).length;
  const livePublished = lessons.filter((lesson) => lesson.status === 'PUBLISHED').length;
  if (visible !== livePublished) { problems += 1; console.error(`!! ${series.title}：迁移后可见 ${visible} 节，迁移前是 ${livePublished} 节`); }
}
if (problems) { console.error('!! 复查没过，请人工看一眼（留底 JSON 里有原值）'); db.close(); process.exit(1); }
console.log('复查通过：每节课时的快照 status 与实时一致；每个课包的可见课时数与迁移前一致。');
console.log('LESSON_SNAPSHOT_BASELINE_MIGRATED');
db.close();
