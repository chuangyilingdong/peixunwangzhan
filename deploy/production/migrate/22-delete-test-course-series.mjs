#!/usr/bin/env node
/**
 * 22 · **物理硬删**两个测试课包：《体验课测试1》与《测试》（2026-09-28 用户口径）。
 *
 * 用户原话：「把体验课测试1课包和测试课包全部删除」；问过一轮，明确选了
 * **物理硬删（不可逆）**，并且知道会带走：10 场课堂历史、4 笔已付款许可（共 202 元测试单）、
 * 241 条用量/调用凭证、7 条学生许可 —— 它们全是测试数据（学生账号都是 xueshengceshi 之类，
 * `sum(cost_fen)=0`、`sum(credits_charged)=0`，没有真实计费损失）。
 *
 * ⚠️ 为什么不能走后台那个「删除」接口（`DELETE /api/admin/course-series/:id`）：
 *    它有一条**故意的护栏** —— 只要还有课堂引用就直接 400 `COURSE_SERIES_IN_USE`
 *    （提示"请改用下架"）。这两个课包各有课堂（3 / 7 场），所以接口必然拒绝。
 *    要走"物理消失"就只能自己级联，**这个脚本就是那份级联**。
 *
 * ⚠️ 两条必须记住的坑（都是这次实测出来的）：
 *   ① `class_sessions.lesson_id` 是 **ON DELETE SET NULL** —— 直接删 `course_lessons` 会留下
 *      **10 场"有课包、没课时"的幽灵课堂**（老师端会看到一节课都没有的课堂）。所以课堂必须先删。
 *   ② `license_purchase_batches` ← `license_revenue_allocations` 是 **RESTRICT** ——
 *      分账没删干净就删批次会直接被外键挡住。
 *
 * 脚本自己会**三查**（这是它比手写 SQL 值得信任的地方）：
 *    ① 删前：按标题断言两个课包的身份（id 漂移就停机，绝不"按 id 盲删"）；
 *    ② 删前：把"将要删掉的每一行的 id"收集起来，扫**全库所有文本列**看还有谁引用它们 ——
 *       扫到计划外的表就**拒绝执行**（宁可不动，也不留孤儿）；
 *    ③ 删后：再扫一遍（课包/课时/课堂三组 id），除 `audit_logs`（审计留痕，故意不动）外必须全 0。
 *
 * 用法（服务器上；先备份）：
 *   bash deploy/production/daily-backup.sh
 *   cd /srv/ai-kids-platform/source
 *   export PATH=/srv/ai-kids-platform/runtime/node-v24.19.0-linux-x64/bin:$PATH
 *   set -a; . /etc/ai-kids-platform/production.env; set +a
 *   node deploy/production/migrate/22-delete-test-course-series.mjs              # 试运行（只读）
 *   node deploy/production/migrate/22-delete-test-course-series.mjs --apply      # 真删（一个事务）
 * 回滚：不可逆。恢复只能靠当天那份 `database.sql.gz`（见 RUNBOOK 的恢复流程）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const arg = (name, fallback = '') => {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || fallback;
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
};
const apply = process.argv.includes('--apply');
const archiveDir = arg('--archive-dir', path.join(process.env.PRODUCTION_ROOT || '/srv/ai-kids-platform/production', 'logs'));

const { aq, arow, arows, atransaction } = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib.js')).href);
const q = (sql, params = []) => arows(sql, params);
const one = (sql, params = []) => arow(sql, params);

// ── 0. 身份断言：标题 + 类型 + 平台自有（id 漂移 / 名字被人改过都要停机）────────────────
const TARGETS = [
  { title: '体验课测试1', seriesType: 'EXPERIENCE' },
  { title: '测试', seriesType: 'NORMAL' },
];
const series = [];
for (const target of TARGETS) {
  const row = await one('SELECT id,title,series_type,status,owner_type,org_id FROM course_series WHERE title=?', [target.title]);
  if (!row) { console.error(`✗ 找不到标题为《${target.title}》的课包 —— 停机（不猜 id）`); process.exit(2); }
  if (row.series_type !== target.seriesType || row.owner_type !== 'PLATFORM' || row.org_id) {
    console.error(`✗ 《${target.title}》与预期不符：${JSON.stringify(row)} —— 停机`); process.exit(2);
  }
  series.push(row);
}
const seriesIds = series.map((s) => s.id);
console.log('== 目标课包（已按标题+类型断言）==');
for (const s of series) console.log(`  ${s.id}  《${s.title}》 type=${s.series_type} status=${s.status}`);

// ── 1. 二级实体（课时 / 课堂 / 授权 / 批次）─────────────────────────────────────────
const lessons = await q('SELECT id,series_id,title FROM course_lessons WHERE series_id IN (?)', [seriesIds]);
const sessions = await q('SELECT id,series_id,lesson_id,title FROM class_sessions WHERE series_id IN (?)', [seriesIds]);
const batches = await q('SELECT id,series_id FROM license_purchase_batches WHERE series_id IN (?)', [seriesIds]);
const lessonIds = lessons.map((x) => x.id);
const sessionIds = sessions.map((x) => x.id);
const batchIds = batches.map((x) => x.id);
console.log(`\n== 连带实体 ==\n  课时 ${lessonIds.length} · 课堂 ${sessionIds.length} · 许可批次 ${batchIds.length}`);
if (!lessonIds.length) console.log('  ⚠ 没有课时（不该发生，先别删，看看是不是 id 弄错了）');

// ── 2. 级联计划：删哪些表、按什么条件（顺序就是执行顺序，外键敏感的写在前面）──────────────
// ⚠️ 顺序不能随意改：分配（RESTRICT）→ 批次；课堂 → 课时（课堂的 lesson_id 是 SET NULL，先删课时会变幽灵）。
const inSeries = (col) => ({ sql: `${col} IN (?)`, params: [seriesIds] });
const inLessons = (col) => ({ sql: `${col} IN (?)`, params: [lessonIds] });
const inSessions = (col) => ({ sql: `${col} IN (?)`, params: [sessionIds] });
const inBatches = (col) => ({ sql: `${col} IN (?)`, params: [batchIds] });
const or = (label, parts) => ({ label, sql: parts.map((p) => p.sql).join(' OR '), params: parts.flatMap((p) => p.params) });

const PLAN = [
  { table: 'license_revenue_allocations', cond: inBatches('purchase_batch_id'), note: 'RESTRICT：必须在批次之前' },
  { table: 'license_revenue_events', cond: or('series_id', [inSeries('series_id')]) },
  { table: 'license_purchase_batches', cond: or('series_id', [inSeries('series_id')]) },
  { table: 'course_quota_changes', cond: or('series_id', [inSeries('series_id')]) },
  { table: 'student_course_grant_consumptions', cond: or('系列/课堂/课时', [inSeries('series_id'), inSessions('session_id'), inLessons('lesson_id')]) },
  { table: 'session_students', cond: or('系列/课堂/课时', [inSeries('series_id'), inSessions('session_id'), inLessons('lesson_id')]) },
  { table: 'compute_attempts', cond: or('课堂/课时', [inSessions('class_session_id'), inLessons('lesson_id')]) },
  { table: 'usage_records', cond: or('系列/课堂/课时', [inSeries('series_id'), inSessions('class_session_id'), inLessons('lesson_id')]) },
  { table: 'vibecoding_submissions', cond: or('课时', [inLessons('lesson_id')]) },
  { table: 'vibecoding_conversations', cond: or('课堂/课时', [inSessions('class_session_id'), inLessons('lesson_id')]) },
  { table: 'student_projects', cond: or('课堂/课时', [inSessions('class_session_id'), inLessons('course_lesson_id')]) },
  { table: 'class_sessions', cond: or('系列/课时', [inSeries('series_id'), inLessons('lesson_id')]) },
  { table: 'course_lesson_teaching_groups', cond: or('课时', [inLessons('lesson_id')]) },
  { table: 'course_lesson_material_groups', cond: or('课时', [inLessons('lesson_id')]) },
  { table: 'course_lesson_capabilities', cond: or('课时', [inLessons('lesson_id')]) },
  { table: 'student_course_cu_quotas', cond: or('课时', [inLessons('lesson_id')]) },
  { table: 'student_lesson_progress', cond: or('课时', [inLessons('lesson_id')]) },
  { table: 'class_curriculum_items', cond: or('课时', [inLessons('lesson_id')]) },
  { table: 'learning_tasks', cond: or('课时', [inLessons('lesson_id')]) },
  { table: 'course_assignments', cond: or('系列', [inSeries('series_id')]) },
  { table: 'student_course_grants', cond: or('系列', [inSeries('series_id')]) },
  { table: 'course_lessons', cond: or('系列', [inSeries('series_id')]) },
  { table: 'course_series_versions', cond: or('系列', [inSeries('series_id')]) },
  { table: 'course_series', cond: or('id', [{ sql: 'id IN (?)', params: [seriesIds] }]) },
];
const PLAN_TABLES = new Set(PLAN.map((item) => item.table));

// ── 3. 逐表点人数 + 收集"将要消失的 id"（供第三查用）──────────────────────────────
console.log('\n== 将要删除的行（试运行就是这份清单）==');
const doomedIds = new Set([...seriesIds, ...lessonIds, ...sessionIds, ...batchIds]);
const counts = [];
for (const item of PLAN) {
  const row = await one(`SELECT COUNT(*) AS n FROM \`${item.table}\` WHERE ${item.cond.sql}`, item.cond.params);
  counts.push({ ...item, n: Number(row.n) });
  console.log(`  ${item.table.padEnd(38)} ${String(row.n).padStart(5)}${item.note ? `   ⚠ ${item.note}` : ''}`);
  const ids = await q(`SELECT id FROM \`${item.table}\` WHERE ${item.cond.sql}`, item.cond.params).catch(() => []);
  for (const entry of ids) if (entry?.id) doomedIds.add(entry.id);
}
const doomed = [...doomedIds];
console.log(`  合计计划删除 ${counts.reduce((sum, item) => sum + item.n, 0)} 行；连带实体 id ${doomed.length} 个`);

// ── 4. 第三查：全库扫一遍，看**计划外**还有谁引用这些 id ─────────────────────────────
const textColumns = await q(`
  SELECT table_name AS t, column_name AS c FROM information_schema.columns
  WHERE table_schema = DATABASE() AND data_type IN ('varchar','text','mediumtext','longtext','char')
  ORDER BY table_name, column_name`);
const placeholders = doomed.map(() => '?').join(',');
const strays = [];
for (const { t: table, c: column } of textColumns) {
  if (table === 'audit_logs' || PLAN_TABLES.has(table)) continue;
  try {
    const row = await one(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` IN (${placeholders})`, doomed);
    if (Number(row.n) > 0) strays.push(`${table}.${column} = ${row.n} 行`);
  } catch { /* 列类型/权限查不动就跳过（下面汇总里会说明扫了多少列） */ }
}
console.log(`\n== 第三查：计划外引用（扫了 ${textColumns.length} 个文本列）==`);
if (strays.length) {
  console.log('  ⚠ 这些表也引用了将要删除的 id，但**不在计划里**：');
  for (const line of strays) console.log(`    · ${line}`);
  console.log('  → 拒绝执行：要么把它们加进 PLAN，要么先人工确认它们可以留成孤儿。');
} else {
  console.log('  ✓ 没有计划外引用');
}

if (!apply) { console.log('\n（试运行结束，什么都没动。要真删加 --apply）'); process.exit(strays.length ? 3 : 0); }
if (strays.length) { console.error('\n✗ 有计划外引用，拒绝执行（先处理上面那几行）'); process.exit(3); }

// ── 5. 留档（删之前把"要删的行"导成 JSON；回滚靠备份，这份是给人看的现场）─────────────
fs.mkdirSync(archiveDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const archiveFile = path.join(archiveDir, `deleted-test-course-series-${stamp}.json`);
const archive = { deletedAt: new Date().toISOString(), reason: '用户口径：删除体验课测试1 + 测试（物理硬删）', targets: series, lessons, sessions, batches, counts: counts.map(({ table, n, note }) => ({ table, n, note })) };
for (const item of PLAN) {
  const key = item.table;
  try { archive[`rows:${key}`] = await q(`SELECT * FROM \`${key}\` WHERE ${item.cond.sql}`, item.cond.params); } catch { archive[`rows:${key}`] = '（导出失败，行数见 counts）'; }
}
fs.writeFileSync(archiveFile, JSON.stringify(archive, null, 1));
console.log(`\n· 现场已留档：${archiveFile}`);

// ── 6. 一个事务里删干净 ───────────────────────────────────────────────────────────
console.log('\n== 开始删除（一个事务，出错整体回滚）==');
const affected = [];
await atransaction(async () => {
  for (const item of PLAN) {
    const result = await aq(`DELETE FROM \`${item.table}\` WHERE ${item.cond.sql}`, item.cond.params);
    const n = Number(result?.affectedRows ?? 0);
    affected.push({ table: item.table, n });
    console.log(`  删 ${item.table.padEnd(38)} ${String(n).padStart(5)} 行`);
  }
});

// ── 7. 删后复查：三组 id 必须扫不到（audit_logs 除外）──────────────────────────────
console.log('\n== 删后复查 ==');
const groups = [
  { label: '课包 id', keys: seriesIds },
  { label: '课时 id', keys: lessonIds },
  { label: '课堂 id', keys: sessionIds },
  { label: '批次 id', keys: batchIds },
];
let leftover = 0;
for (const { t: table, c: column } of textColumns) {
  if (table === 'audit_logs') continue;
  for (const { label, keys } of groups) {
    if (!keys.length) continue;
    const marks = keys.map(() => '?').join(',');
    try {
      const row = await one(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` IN (${marks})`, keys);
      if (Number(row.n) > 0) { leftover += Number(row.n); console.log(`  ✗ 还剩 ${table}.${column} = ${row.n} 行（${label}）`); }
    } catch { /* 同上，查不动就跳过 */ }
  }
}
console.log(leftover ? `✗ 还有 ${leftover} 行残留（见上）` : '✓ 全库再无这两个课包（及它们的课时/课堂/批次）的引用，audit_logs 留痕未动');
console.log(`\n完成。留档：${archiveFile}`);
process.exit(leftover ? 1 : 0);
