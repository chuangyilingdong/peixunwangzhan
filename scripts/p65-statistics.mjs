/**
 * P65 统计三层守卫（2026-09-12，板块四：固定指标看板）。
 *
 * 用户口径（梳理文档第 6 节）：统计 = **经营 / 算力 / 内容三层**，且「一个概念只在一个地方管」。
 * 这一条钉三件事：
 *   ① 算力层用**元**（不再是旧单位积分），且**四种模态都算进来**（含走不了网关的视频/音乐）；
 *   ② 算力层的数字与「算力网关」页**同源**（都来自上游尝试账本）；
 *   ③ 内容层给出课包/课时使用热度与作品发布情况（两条链路合并计数）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p65-statistics-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(code)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

/* 造数：一个学员在一个课包上花掉 4 种模态的钱（对话 1 元 / 图片 2 元 / 视频 5 元 / 音乐 3 元），
   课包预算 200 元；另造一个「用尽」的池子（同一学员第二个课包，花掉超过上限）。 */
const seeded = (() => {
  const db = new DatabaseSync(dbPath);
  // ⚠️ 需要**两个不同课包**才测得到「两个池子」：种子库只有一个课包（我还第一次写成
  //    取前两节课 —— 它们同属一个课包，两段造数会落进同一个池子）。所以自己造第二个，确定性更好。
  db.prepare(`INSERT OR REPLACE INTO course_series(id,title,description,owner_type,visibility,version,sort,status,delivery_mode,stock_total,created_at,updated_at)
    VALUES('p65_series_b','P65 第二个课包','守卫用','PLATFORM','PRIVATE','1.0',9,'PUBLISHED','CANVAS',0,datetime('now'),datetime('now'))`).run();
  db.prepare(`INSERT OR REPLACE INTO course_lessons(id,series_id,title,sort,status,delivery_mode,created_at,updated_at)
    VALUES('p65_lesson_b','p65_series_b','P65 课时 B',1,'PUBLISHED','CANVAS',datetime('now'),datetime('now'))`).run();
  const lessons = [db.prepare('SELECT id, series_id FROM course_lessons WHERE id<>? ORDER BY sort LIMIT 1').get('p65_lesson_b') || db.prepare('SELECT id, series_id FROM course_lessons ORDER BY sort LIMIT 1').get(), { id: 'p65_lesson_b', series_id: 'p65_series_b' }];
  const student = db.prepare("SELECT id, org_id FROM users WHERE role='STUDENT' LIMIT 1").get();
  const teacher = db.prepare("SELECT id FROM users WHERE role='TEACHER' LIMIT 1").get();
  for (const [index, lesson] of lessons.entries()) {
    db.prepare(`INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,platform_budget_fen,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'ACTIVE',?,datetime('now'),datetime('now'))`).run('p65_session_' + index, 'P65 平台预算课堂', student.org_id, lesson.series_id, lesson.id, teacher.id, index ? 100 : 20000);
  }
  db.prepare('UPDATE course_series SET per_student_budget_fen=? WHERE id=?').run(20000, lessons[0].series_id);
  db.prepare('UPDATE course_series SET per_student_budget_fen=? WHERE id=?').run(100, lessons[1].series_id);
  const insert = (id, modality, fen, index, source = 'REPORTED') => {
    const lesson = lessons[index];
    db.prepare(`INSERT INTO usage_records(id,org_id,user_id,modality,model,credits_charged,status,pricing_snapshot,cost_fen,series_id,compute_call_id,class_session_id,created_at)
      VALUES (?,?,?,?,'m',0,'SUCCESS','{}',999999,?,?,?,?)`).run(id, student.org_id, student.id, modality, lesson.series_id, id + '_call', 'p65_session_' + index, new Date().toISOString());
    db.prepare(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,modality,status,cost_source,upstream_cost_fen,sale_snapshot,class_session_id,lesson_id,created_at)
      VALUES (?,?,1,?,?,?,'SUCCESS',?,?,'{}',?,?,?)`).run(id + '_attempt', id + '_call', student.org_id, student.id, modality, source, fen, 'p65_session_' + index, lesson.id, new Date().toISOString());
  };
  [['TEXT', 100], ['IMAGE', 200], ['VIDEO', 500], ['MUSIC', 300]].forEach(([modality, fen], index) => insert('p65_a' + index, modality, fen, 0, index === 0 ? 'ESTIMATED' : 'REPORTED'));
  insert('p65_over_budget', 'IMAGE', 500, 1);
  insert('p65_unknown', 'TEXT', null, 0, 'UNKNOWN');
  db.close();
  return { seriesId: lessons[0].series_id, lessonId: lessons[0].id, studentId: student.id };
})();

const port = 18999;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  assert.ok(admin, '登录失败');

  const stats = await api('/api/admin/dashboard/overview', { token: admin });
  check('① 统计接口可用（经营层还在）', stats.status === 200 && Number(stats.data?.metrics?.organizations) > 0, JSON.stringify(stats).slice(0, 200));
  const compute = stats.data?.compute || {};
  // 池子 A：对话 1 + 图片 2 + 视频 5 + 音乐 3 = 11 元；池子 B（另一个课包）：图片 5 元 → 合计 16 元
  check('① 已知上游成本为16元，不取旧售价；未知不伪装成总成本', compute.knownCostYuan === 16 && compute.totalYuan === null && compute.costBasis === 'KNOWN_UPSTREAM_ONLY', JSON.stringify(compute));
  check('① 未知成本单列且计入调用次数', compute.unknownCalls === 1 && compute.calls === 6, JSON.stringify(compute));
  check('① 按模态拆开了（含视频与音乐 —— 它们走不了网关，只有应用侧账本算得到）',
    ['TEXT', 'IMAGE', 'VIDEO', 'MUSIC'].every((m) => (compute.byModality || []).some((item) => item.modality === m)), JSON.stringify(compute.byModality));
  check('① 各模态金额正确（视频 5 元 / 音乐 3 元 / 图片 2+5=7 元）',
    compute.byModality.find((item) => item.modality === 'VIDEO')?.yuan === 5 &&
    compute.byModality.find((item) => item.modality === 'MUSIC')?.yuan === 3 &&
    compute.byModality.find((item) => item.modality === 'IMAGE')?.yuan === 7,
    JSON.stringify(compute.byModality));
  check('① 课堂预算识别超预算预警', compute.pools?.exhausted >= 1, JSON.stringify(compute.pools));
  check('① 两个课堂分别计入平台预算', compute.pools?.counted === 2, JSON.stringify(compute.pools));
  check('① 课堂已知成本16元，总成本保持未知', compute.pools?.knownCostYuan === 16 && compute.pools?.usedYuan === null && compute.pools?.unknown === 1, JSON.stringify(compute.pools));
  // 与平台课堂预算报表逐项对齐；不再把课堂成本显示为学生余额。
  const pools = await api('/api/admin/compute-pools', { token: admin });
  const classrooms = (pools.data?.items || []).filter(item => item.sessionId.startsWith('p65_session_'));
  check('② 课堂报表与统计已知成本同源', classrooms.length === 2 && classrooms.reduce((sum, item) => sum + item.knownCostFen, 0) === compute.pools.knownCostYuan * 100, JSON.stringify(classrooms));
  check('② 未知课堂与超预算课堂隔离，均只预警', classrooms.every(item => item.enforced === false) && classrooms.find(item => item.sessionId === 'p65_session_0')?.usedFen === null && classrooms.find(item => item.sessionId === 'p65_session_1')?.budgetState === 'OVER_BUDGET', JSON.stringify(classrooms));

  const content = stats.data?.content || {};
  check('③ 内容层：已发布课时数给了', Number(content.lessonsPublished) > 0, JSON.stringify(content.lessonsPublished));
  check('③ 内容层：作品发布情况（提交/在广场/精选/已下架）都是数字', ['submittedWorks', 'onPlaza', 'featured', 'unpublished'].every((key) => typeof content[key] === 'number'), JSON.stringify(content));
  check('③ 内容层：课时热度 Top 列表存在（哪怕为空数组）', Array.isArray(content.lessonHot), JSON.stringify(content.lessonHot));
  /* ④ B4（2026-09-13）：统计指标细化 —— 新增三个经营指标，口径要在接口里能对上 */
  check('④ 新增学生数给了（数字）', typeof stats.data?.metrics?.newStudents === 'number', JSON.stringify(stats.data?.metrics?.newStudents));
  check('④ 活跃学生数给了（数字）', typeof stats.data?.metrics?.activeStudents === 'number', JSON.stringify(stats.data?.metrics?.activeStudents));
  check('④ 完成课时数给了（数字）', typeof stats.data?.metrics?.lessonCompletions === 'number', JSON.stringify(stats.data?.metrics?.lessonCompletions));
  check('④ 新增指标都有口径说明（免得说不清数从哪来）',
    ['newStudents', 'activeStudents', 'lessonCompletions'].every((key) => Boolean(stats.data?.meta?.metricDefinitions?.[key])),
    JSON.stringify(Object.keys(stats.data?.meta?.metricDefinitions || {})));

  /* ⑤ B5（2026-09-13）：官网转化漏斗并入统计板块，且与「转化分析」同源 */
  const site = stats.data?.site || {};
  check('⑤ 统计接口里带上了官网漏斗（四步）', Array.isArray(site.funnel) && site.funnel.length === 4, JSON.stringify(site.funnel));
  check('⑤ 漏斗步骤名与「转化分析」一致（同一份实现）',
    ['page_view', 'marketplace_view', 'marketplace_detail_view', 'demo_submitted'].every((name) => (site.funnel || []).some((item) => item.eventName === name)),
    JSON.stringify((site.funnel || []).map((item) => item.eventName)));
  check('⑤ 漏斗口径在口径表里写明（含「与统计板块同一个实现」）', Boolean(stats.data?.meta?.metricDefinitions?.['site.funnel']));

  /* ⑥ 2026-09-13：机构 → 学员 消耗下钻（用户要的「平台能看到所有机构和下面学生的消耗」） */
  const drill = await api('/api/admin/billing/org-student-usage?days=30', { token: admin });
  check('⑥ 下钻接口可用，且给出机构清单（含零消耗的机构）', drill.status === 200 && Array.isArray(drill.data?.orgs) && drill.data.orgs.length > 0, JSON.stringify(drill).slice(0, 200));
  const seededOrg = (drill.data?.orgs || []).find((item) => item.calls > 0);
  check('⑥ 机构行带上「消耗 / 调用 / 学员数」三个数', Boolean(seededOrg) && typeof seededOrg.costFen === 'number' && typeof seededOrg.calls === 'number' && typeof seededOrg.studentCount === 'number', JSON.stringify(seededOrg));
  const studentsOfOrg = await api(`/api/admin/billing/org-student-usage?days=30&orgId=${seededOrg.id}`, { token: admin });
  const seededStudent = (studentsOfOrg.data?.students || [])[0];
  check('⑥ 选中机构后能看到它下面每个学员的消耗（含涉及课包数与最近一次）', Boolean(seededStudent) && Number(seededStudent.costFen) === 1600 && Number(seededStudent.seriesCount) >= 1 && Boolean(seededStudent.lastAt), JSON.stringify(seededStudent));
  check('⑥ 该机构的学员消耗之和 = 机构行上的消耗（同一份账本，不是两套算法）',
    (studentsOfOrg.data?.students || []).reduce((sum, item) => sum + Number(item.costFen || 0), 0) === Number(seededOrg.costFen),
    JSON.stringify({ orgFen: seededOrg.costFen, studentsFen: (studentsOfOrg.data?.students || []).map((item) => item.costFen) }));
  const exportCsv = await api('/api/admin/billing/org-student-usage/export?days=30', { token: admin });
  check('⑥ 导出台账可用（CSV 带机构与学员两列，含调用次数与消耗元）',
    exportCsv.status === 200 && typeof exportCsv.data?.content === 'string' && exportCsv.data.content.includes('机构') && exportCsv.data.content.includes('学员') && Number(exportCsv.data?.count) >= 1,
    JSON.stringify({ count: exportCsv.data?.count, head: String(exportCsv.data?.content || '').split(String.fromCharCode(10))[0] }).slice(0, 200));
  const foreignOrg = await api('/api/admin/billing/org-student-usage?days=30&orgId=org_does_not_exist', { token: admin });
  check('⑥ 不存在的机构被拒（不会静默返回空表）', foreignOrg.status === 400, `实际 ${foreignOrg.status}`);
  const studentToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-1', password: 'study123' } })).data.token;
  const studentForbidden = await api('/api/admin/billing/org-student-usage?days=30', { token: studentToken });
  check('⑥ 学生不能看全平台机构的消耗（403）', studentForbidden.status === 403, `实际 ${studentForbidden.status}`);

  const funnelEndpoint = await api('/api/admin/analytics/overview', { token: admin });
  check('⑤ 转化分析接口仍可用，且与统计看板同一批步骤',
    funnelEndpoint.status === 200 && JSON.stringify(funnelEndpoint.data?.funnel?.map((item) => item.eventName)) === JSON.stringify((site.funnel || []).map((item) => item.eventName)),
    JSON.stringify(funnelEndpoint.data?.funnel?.map((item) => item.eventName)));

  console.log(JSON.stringify({ name: 'statistics', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-2500));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
