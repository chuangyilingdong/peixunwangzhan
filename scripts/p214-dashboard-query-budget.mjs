/**
 * P214 Dashboard 查询条数守卫（2026-11-12）。
 *
 * 背景：`GET /api/student/dashboard` 原来按生产 5 课包 / 50 课时估算约 240 条 SQL ——
 * 每个课时都重查「能力 / 素材组 / 素材 / 每个框体的 platform_settings」，每个课包再重查
 * 课时数与授权行，`session_students` 还被扫三遍。
 *
 * 这条守卫钉住改造后的两条硬指标：
 *   ① 已发布课时带完整 published_content 快照时，dashboard 查询数有上限（<= 30）；
 *   ② 同一课包再加 20 节带快照的课时，查询数**不增长**（<= +2）—— 也就是 N+1 真没了。
 * 另外钉住兼容路径：老快照只带 capabilities、缺 materialGroups/generationBoxes 时，
 * 仍要回退实时表，把素材组读出来（老数据不能因为优化丢内容）。
 *
 * 跑法：node scripts/p214-dashboard-query-budget.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p214-dashboard-budget-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
process.env.PLATFORM_DATA_DIR = temp;
// 必须在 import 数据层之前设置：schema.js / mysql.js 在加载时读取这个开关。
process.env.PLATFORM_DB_COUNT_QUERIES = '1';
process.env.AI_PROVIDER = 'local-mock';
process.env.AI_PROVIDER_API_KEY = '';

const baseEnv = { ...process.env };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const { aq, arow, arows, id, dbQueryStats, resetDbQueryStats } = await import('../packages/database/src/store.js');
const { buildStudentDashboard } = await import('../apps/server/src/services/studentContext.js');

const student = await arow("SELECT * FROM users WHERE login='student-1'");
const grant = await arow('SELECT series_id FROM student_course_grants WHERE student_id=? AND revoked_at IS NULL', [student.id]);
assert.ok(grant?.series_id, '种子学生没有课包许可');
const series = await arow('SELECT * FROM course_series WHERE id=?', [grant.series_id]);
const seedLessons = await arows('SELECT * FROM course_lessons WHERE series_id=? ORDER BY sort', [series.id]);
assert.ok(seedLessons.length >= 3, `种子课包课时太少: ${seedLessons.length}`);

/** 完整的发布快照（与 capturePublishedContent 写出的键一致）。 */
function lessonSnapshot(lesson, extra = {}) {
  return JSON.stringify({
    title: lesson.title,
    summary: lesson.summary || '',
    durationMinutes: Number(lesson.duration_minutes || 45),
    lessonContent: lesson.lesson_content || '',
    deliveryMode: lesson.delivery_mode || 'CANVAS',
    deliveryModes: ['CANVAS'],
    platformBudgetFen: null,
    teachingGroups: [],
    classroomConfig: {},
    canvasTemplateSnapshot: {},
    capabilities: ['text'],
    materialGroups: [],
    generationBoxes: [],
    status: 'PUBLISHED',
    ...extra,
  });
}

const now = new Date().toISOString();
// 种子课包与课时补上「更新发布」快照 —— 生产上绝大多数课时就是这个形态。
await aq('UPDATE course_series SET published_content=? WHERE id=?', [JSON.stringify({
  title: series.title, description: series.description || '', coverImageUrl: series.cover_image_url || null,
  coverAssetId: series.cover_asset_id || null, priceFen: 0, stockTotal: 0, difficultyLevel: null,
  visibility: 'PUBLIC', gradeRange: '', tags: [], seriesType: 'NORMAL',
}), series.id]);
for (const lesson of seedLessons) {
  await aq('UPDATE course_lessons SET published_content=? WHERE id=?', [lessonSnapshot(lesson), lesson.id]);
}

async function measure() {
  resetDbQueryStats();
  const dashboard = await buildStudentDashboard(student);
  return { dashboard, queries: dbQueryStats.count };
}

const first = await measure();
check(`带完整快照时 dashboard 查询数有上限（实测 ${first.queries}，要求 <= 30）`, first.queries <= 30, `queries=${first.queries}`);

const firstCourse = first.dashboard.classroomCourses.find((course) => course.id === series.id);
check('classroomCourses 里能找到种子课包', Boolean(firstCourse));
check('课时数与种子一致', firstCourse?.lessons?.length === seedLessons.length, `${firstCourse?.lessons?.length} vs ${seedLessons.length}`);
check('capabilities / materialGroups / generationBoxes 形状保持',
  Boolean(firstCourse?.lessons?.length) && firstCourse.lessons.every((lesson) => (
    Array.isArray(lesson.capabilities) && Array.isArray(lesson.materialGroups) && Array.isArray(lesson.generationBoxes)
  )));

// 同一课包再加 20 节带快照的已发布课时：查询数不允许跟着涨。
for (let index = 0; index < 20; index += 1) {
  const lessonId = id('lesson');
  const sort = 100 + index;
  const title = `P214 批量课时 ${index + 1}`;
  await aq(`INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [lessonId, series.id, title, '', sort, 'PUBLISHED', 45, '', now, now]);
  await aq('UPDATE course_lessons SET published_content=? WHERE id=?', [lessonSnapshot({ title, summary: '', duration_minutes: 45, lesson_content: '' }), lessonId]);
}

const second = await measure();
const secondCourse = second.dashboard.classroomCourses.find((course) => course.id === series.id);
check('加 20 节课后课时数确实增加', secondCourse?.lessons?.length === seedLessons.length + 20, String(secondCourse?.lessons?.length));
check(`加 20 节课后查询数不增长（${first.queries} -> ${second.queries}，要求 <= +2）`,
  second.queries - first.queries <= 2, `${first.queries} -> ${second.queries}`);

// 老快照兼容：只写 capabilities，缺 materialGroups / generationBoxes → 必须回退实时表。
const legacyLessonId = id('lesson');
const legacyGroupId = id('lesson_group');
const legacyMaterialId = id('lesson_material');
const legacyTitle = 'P214 老快照课时';
await aq(`INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`, [legacyLessonId, series.id, legacyTitle, '', 999, 'PUBLISHED', 45, '', now, now]);
await aq('UPDATE course_lessons SET published_content=? WHERE id=?', [JSON.stringify({
  title: legacyTitle, status: 'PUBLISHED', capabilities: ['text'],
}), legacyLessonId]);
await aq(`INSERT INTO course_lesson_material_groups(id,lesson_id,title,sort,created_at,updated_at)
  VALUES (?,?,?,?,?,?)`, [legacyGroupId, legacyLessonId, '老快照素材组', 1, now, now]);
await aq(`INSERT INTO course_lesson_materials(id,group_id,title,description,material_type,asset_url,snapshot,sort,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`, [legacyMaterialId, legacyGroupId, '老快照素材', '', 'NOTE', null, '{}', 1, now, now]);

const third = await measure();
const legacyLesson = third.dashboard.classroomCourses
  .find((course) => course.id === series.id)?.lessons?.find((lesson) => lesson.id === legacyLessonId);
check('老快照课时仍从实时表回退拿到素材组',
  legacyLesson?.materialGroups?.length === 1 && legacyLesson.materialGroups[0]?.materials?.length === 1,
  JSON.stringify(legacyLesson?.materialGroups || null));
check('老快照课时的 capabilities 仍取快照值', JSON.stringify(legacyLesson?.capabilities) === JSON.stringify(['text']), JSON.stringify(legacyLesson?.capabilities));

if (failures) {
  console.error(`P214 FAILED: ${failures} 项`);
  process.exit(1);
}
console.log(`P214 passed: Dashboard 查询数 ${first.queries}（+20 节课后 ${second.queries}），老快照回退正常`);
