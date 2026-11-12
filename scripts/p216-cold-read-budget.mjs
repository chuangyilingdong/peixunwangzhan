/**
 * P216 冷读查询条数守卫（2026-11-12）。
 *
 * 覆盖 Dashboard 之外的三个相邻读路径，防止 N+1 回潮：
 *   ① `getStudentAccessibleCourses`（/api/student/courses?筛选、/learning/overview）：
 *      一次批量取课时、每请求一次 ai_provider_policy —— 查询数不随课时数增长；
 *   ② `getStudentCourseDetail`（/api/student/courses/:id）：不再重建整份 buildStudentContext；
 *      查询数有上限，且不随课时数增长；
 *   ③ `lessonStateMapForLessons`：只查一次参与记录；
 *   ④ `normalizeProject`：发布快照齐全且传入 providerPolicy 时，0 条查询（不碰实时画布）。
 *
 * 跑法：node scripts/p216-cold-read-budget.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p216-cold-read-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
process.env.PLATFORM_DATA_DIR = temp;
// 必须在 import 数据层之前设置（schema.js / mysql.js 加载时读取）。
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
const {
  getStudentAccessibleCourses, getStudentCourseDetail, lessonStateMapForLessons,
} = await import('../apps/server/src/services/studentContext.js');
const { normalizeProject, aiProviderPolicy } = await import('../apps/server/src/lib.js');

const student = await arow("SELECT * FROM users WHERE login='student-1'");
const grant = await arow('SELECT series_id FROM student_course_grants WHERE student_id=? AND revoked_at IS NULL', [student.id]);
assert.ok(grant?.series_id, '种子学生没有课包许可');
const seriesRow = await arow('SELECT * FROM course_series WHERE id=?', [grant.series_id]);
const seedLessons = await arows('SELECT * FROM course_lessons WHERE series_id=? ORDER BY sort', [seriesRow.id]);
assert.ok(seedLessons.length >= 3, `种子课包课时太少: ${seedLessons.length}`);

const now = new Date().toISOString();
function lessonSnapshot(lesson, extra = {}) {
  return JSON.stringify({
    title: lesson.title, summary: lesson.summary || '',
    durationMinutes: Number(lesson.duration_minutes || 45), lessonContent: lesson.lesson_content || '',
    deliveryMode: lesson.delivery_mode || 'CANVAS', deliveryModes: ['CANVAS'], platformBudgetFen: null,
    teachingGroups: [], classroomConfig: {}, canvasTemplateSnapshot: {},
    capabilities: ['text'], materialGroups: [], generationBoxes: [], status: 'PUBLISHED', ...extra,
  });
}
await aq('UPDATE course_series SET published_content=? WHERE id=?', [JSON.stringify({
  title: seriesRow.title, description: seriesRow.description || '', coverImageUrl: seriesRow.cover_image_url || null,
  coverAssetId: seriesRow.cover_asset_id || null, priceFen: 0, stockTotal: 0, difficultyLevel: null,
  visibility: 'PUBLIC', gradeRange: '', tags: [], seriesType: 'NORMAL',
}), seriesRow.id]);
for (const lesson of seedLessons) {
  await aq('UPDATE course_lessons SET published_content=? WHERE id=?', [lessonSnapshot(lesson), lesson.id]);
}

const measure = async (fn) => { resetDbQueryStats(); const value = await fn(); return { value, queries: dbQueryStats.count }; };

/* ① 可访问课程：查询数不随课时数增长 */
const accessible1 = await measure(() => getStudentAccessibleCourses(student));
check(`可访问课程查询数有上限（实测 ${accessible1.queries}，要求 <= 8）`, accessible1.queries <= 8, `queries=${accessible1.queries}`);
check('可访问课程带出课时与三键形状',
  (accessible1.value?.[0]?.lessons?.length || 0) === seedLessons.length
  && accessible1.value[0].lessons.every((lesson) => Array.isArray(lesson.capabilities) && Array.isArray(lesson.materialGroups) && Array.isArray(lesson.generationBoxes)));

for (let index = 0; index < 20; index += 1) {
  const lessonId = id('lesson');
  const title = `P216 批量课时 ${index + 1}`;
  await aq(`INSERT INTO course_lessons(id,series_id,title,summary,sort,status,duration_minutes,lesson_content,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [lessonId, seriesRow.id, title, '', 100 + index, 'PUBLISHED', 45, '', now, now]);
  await aq('UPDATE course_lessons SET published_content=? WHERE id=?', [lessonSnapshot({ title, summary: '', duration_minutes: 45, lesson_content: '' }), lessonId]);
}
const accessible2 = await measure(() => getStudentAccessibleCourses(student));
check(`加 20 节课后可访问课程查询数不增长（${accessible1.queries} -> ${accessible2.queries}，要求 <= +1）`,
  accessible2.queries - accessible1.queries <= 1, `${accessible1.queries} -> ${accessible2.queries}`);
check('加课后课时数确实增加', accessible2.value?.[0]?.lessons?.length === seedLessons.length + 20);

/* ② 课程详情：有上限且不随课时数增长 */
const detail1 = await measure(() => getStudentCourseDetail(student, seriesRow.id));
check(`课程详情查询数有上限（实测 ${detail1.queries}，要求 <= 12）`, detail1.queries <= 12, `queries=${detail1.queries}`);
const detail2 = await measure(() => getStudentCourseDetail(student, seriesRow.id));
check(`加 20 节课后详情查询数不增长（${detail1.queries} -> ${detail2.queries}，要求 <= +1）`,
  detail2.queries - detail1.queries <= 1, `${detail1.queries} -> ${detail2.queries}`);

/* ③ 详情页状态：只查一次参与记录，不重建整份 context */
const states = await measure(() => lessonStateMapForLessons(student, detail1.value.lessons));
check('lessonStateMapForLessons 只查 1 次参与记录', states.queries === 1, `queries=${states.queries}`);
check('详情课时都算出了状态', states.value.size === detail1.value.lessons.length, `${states.value.size} vs ${detail1.value.lessons.length}`);

/* ④ 项目列表：快照齐全 + 传入 policy 时 0 条查询 */
const providerPolicy = await aiProviderPolicy();
const lesson = seedLessons[0];
const project = {
  id: 'project_p216', student_id: student.id, org_id: student.org_id, course_lesson_id: lesson.id,
  lesson_title: lesson.title, lesson_published_content: lessonSnapshot(lesson),
  title: 'P216 项目', status: 'DRAFT', created_at: now, updated_at: now,
};
const projectNormalized = await measure(() => normalizeProject(project, { providerPolicy }));
check('normalizeProject 快照齐全时不查库', projectNormalized.queries === 0, `queries=${projectNormalized.queries}`);
check('normalizeProject 仍带出画布三键',
  Array.isArray(projectNormalized.value.capabilities)
  && Array.isArray(projectNormalized.value.materialGroups)
  && Array.isArray(projectNormalized.value.generationBoxes));

if (failures) {
  console.error(`P216 FAILED: ${failures} 项`);
  process.exit(1);
}
console.log(`P216 passed: 可访问课程 ${accessible1.queries} 条、详情 ${detail1.queries} 条，均不随课时数增长；项目快照 0 查询`);
