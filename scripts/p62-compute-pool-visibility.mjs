/**
 * P62 算力可见性守卫（2026-09-12）：**学生与老师也要能看到「还剩多少」**。
 *
 * 闸门只有「可被理解」才会被接受：学生被拦住时要知道自己还有多少、老师排课时要知道谁快用完了。
 * 这一条钉三件事：
 *   ① 学生端的**画布项目详情**与 **VibeCoding 会话详情**都带算力池摘要，且**与闸门同源**
 *      （不是另算一个数 —— 改一次账，两边一起变）；
 *   ② 机构端**排课候选**每个学员带他在该课包的剩余；
 *   ③ 课包没填预算 → `unlimited: true`（口径：留空 = 不限制，只记账），界面据此显示「不限」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ensureClassroom, switchClassroom } from './lib/classroomFixture.mjs';
import { createClassroom } from './lib/classroomApi.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p62-pool-visible-'));
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
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const seeded = { seriesId: '', lessonId: '', lessonSecondId: '', classId: '' };
{
  const db = new DatabaseSync(dbPath);
  const lesson = db.prepare('SELECT id, series_id FROM course_lessons ORDER BY sort LIMIT 1').get();
  seeded.lessonId = lesson.id; seeded.seriesId = lesson.series_id;
  // 候选池那条要用**另一节课**：夹具已经把这节课开成课堂了，同一节课上他会被判「已在别的课堂」。
  // 池子是**按课包**算的，所以换一节课不影响口径。
  seeded.lessonSecondId = db.prepare('SELECT id FROM course_lessons WHERE series_id=? AND id<>? ORDER BY sort LIMIT 1').get(lesson.series_id, lesson.id)?.id || lesson.id;
  seeded.classId = db.prepare('SELECT id FROM classes LIMIT 1').get()?.id || '';
  // 课时开 text 能力 + VibeCoding 类型（画布与对话两条路都要能进）
  db.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
  db.prepare("UPDATE course_lessons SET delivery_modes=? WHERE id=?").run('["CANVAS","VIBECODING"]', lesson.id);
  // 课包先**不填**预算（验证 unlimited），后面再填 200 元并制造 50 元消耗
  db.prepare('UPDATE course_series SET per_student_budget_fen=NULL').run();
  db.close();
}

const port = 18990;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
const setSeriesBudget = (fen) => { const db = new DatabaseSync(dbPath); db.prepare('UPDATE course_series SET per_student_budget_fen=? WHERE id=?').run(fen, seeded.seriesId); db.close(); };
const addSpend = (userId, orgId, costFen) => {
  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT OR REPLACE INTO usage_records(
      id,org_id,user_id,modality,model,credits_charged,status,fail_code,pricing_snapshot,cost_fen,series_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run('p62_spend_' + costFen, orgId, userId, 'TEXT', 'm', 1, 'SUCCESS', null, '{}', costFen, seeded.seriesId);
  db.close();
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  const org = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data.token;
  assert.ok(admin && student && org, '登录失败');
  const identity = (() => { const db = new DatabaseSync(dbPath); const r = db.prepare("SELECT id, org_id FROM users WHERE login='student-2'").get(); db.close(); return r; })();

  /* ① 课包没填预算 → 学生端看到「不限」（口径：留空 = 不限制，只记账） */
  const courses = await api('/api/student/courses', { token: student });
  const items = courses.data?.items || courses.data?.courses || [];
  const lessonId = items?.[0]?.currentLessonId || items?.[0]?.lessons?.[0]?.id || items?.[0]?.lesson?.id || items?.[0]?.id;
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title: 'P62 可见性' } });
  assert.ok(project.data?.id, '建项目失败：' + JSON.stringify(project).slice(0, 200));
  check('① 新建项目的返回里就带算力池摘要', Boolean(project.data?.computePool), JSON.stringify(project.data?.computePool));
  const projectDetail = await api(`/api/student/projects/${encodeURIComponent(project.data.id)}`, { token: student });
  check('① 课包没填预算 → 学生端读到的 computePool.unlimited = true（界面显示「不限」）',
    projectDetail.data?.computePool?.unlimited === true && projectDetail.data?.computePool?.capYuan === null,
    JSON.stringify(projectDetail.data?.computePool));

  /* ② 填 200 元 + 花掉 50 元 → 学生端与闸门同源（剩余 150 元 / 25%） */
  setSeriesBudget(20000);
  addSpend(identity.id, identity.org_id, 5000);
  const after = await api(`/api/student/projects/${encodeURIComponent(project.data.id)}`, { token: student });
  const pool = after.data?.computePool || {};
  check('② 学生端看到：上限 200 / 已用 50 / 剩余 150（元）',
    pool.capYuan === 200 && pool.usedYuan === 50 && pool.remainYuan === 150, JSON.stringify(pool));
  check('② 学生端看到使用率 25%', pool.usagePercent === 25, String(pool.usagePercent));
  check('② 带上课包名字（学生知道这是哪门课的额度）', Boolean(pool.seriesTitle), JSON.stringify({ seriesTitle: pool.seriesTitle }));

  /* ③ VibeCoding 会话详情也带同一份（学生另一个创作入口） */
  // 批次 B：一个课堂只带一种入口类型，VibeCoding 那条链需要 VIBECODING 课堂。
  // 种子课时是**只画布**的，所以这里要 `requireSupports:false` 强制切过去。
  // （③ 之后只读项目详情/排课候选，都不要求画布入口，所以不必切回来。）
  switchClassroom(dbPath, { deliveryMode: 'VIBECODING', requireSupports: false });
  const conversation = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId, title: 'P62 会话' } });
  check('③ 能开会话', conversation.status === 200 && Boolean(conversation.data?.id), JSON.stringify(conversation).slice(0, 200));
  const conversationDetail = await api(`/api/student/vibecoding/conversations/${encodeURIComponent(conversation.data.id)}`, { token: student });
  check('③ VibeCoding 会话详情带同一份算力池摘要（与画布同源）',
    conversationDetail.data?.computePool?.capYuan === 200 && conversationDetail.data?.computePool?.remainYuan === 150,
    JSON.stringify(conversationDetail.data?.computePool));

  /* ④ 机构端排课候选：每个学员带他在这个课包的剩余（老师能看出谁快用完了） */
  // 批次 D：排课候选从「班级 + 课时」换成**课堂候选人**（同一份算力池口径挂在可加名单上）
  const openSession = await createClassroom(api, org, { lessonId: seeded.lessonSecondId, title: 'P62 候选池课堂' });
  const candidates = await api(`/api/org/sessions/${encodeURIComponent(openSession)}/candidates`, { token: org });
  const me = candidates.data?.selectable?.concat(candidates.data?.blocked || [], candidates.data?.alreadyIn || []).find((item) => item.id === identity.id);
  check('④ 排课候选项带算力池字段', Boolean(me) && 'poolRemainYuan' in me && 'poolUnlimited' in me, JSON.stringify(me));
  check('④ 该学员剩余 150 元 / 已用 25%（与闸门、学生端三处一致）',
    me?.poolRemainYuan === 150 && me?.poolPercent === 25 && me?.poolCapYuan === 200, JSON.stringify(me));

  /* ⑤ 三处同源：把消耗改成 180 元，三处一起变（不是各自算各自的） */
  addSpend(identity.id, identity.org_id, 13000); // 再花 130 → 合计 180
  const studentAgain = await api(`/api/student/projects/${encodeURIComponent(project.data.id)}`, { token: student });
  const candidatesAgain = await api(`/api/org/sessions/${encodeURIComponent(openSession)}/candidates`, { token: org });
  const meAgain = candidatesAgain.data?.selectable?.concat(candidatesAgain.data?.blocked || [], candidatesAgain.data?.alreadyIn || []).find((item) => item.id === identity.id);
  check('⑤ 消耗更新后：学生端剩余 20 元 / 90%', studentAgain.data?.computePool?.remainYuan === 20 && studentAgain.data?.computePool?.usagePercent === 90, JSON.stringify(studentAgain.data?.computePool));
  check('⑤ 消耗更新后：老师端同一格也变成 20 元 / 90%（同源）', meAgain?.poolRemainYuan === 20 && meAgain?.poolPercent === 90, JSON.stringify(meAgain));

  console.log(JSON.stringify({ name: 'compute-pool-visibility', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
