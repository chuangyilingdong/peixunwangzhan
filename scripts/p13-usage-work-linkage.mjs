/**
 * P13 用量记录与作品的关联闭环。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 背景：usage_records.work_id 此前从未写入过，机构端/平台端用量报表的「作品」列
 * 与按作品标题检索一直静默失效（works.project_id 唯一，一个项目对应一个作品）。
 *
 * 覆盖：
 *   ① 启动迁移把历史用量回填到对应作品
 *   ② 学生提交作品时实时回填该项目的用量记录
 *   ③ 平台端用量报表能按作品标题检索到该记录
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-usage-work-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const EMPTY_CANVAS = '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}';

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const { DatabaseSync } = await import('node:sqlite');

// ① 历史数据回填：造一条「项目已提交、用量未关联作品」的旧数据，再跑一次启动迁移
const seedDb = new DatabaseSync(dbPath);
const student = seedDb.prepare("SELECT * FROM users WHERE login='student-2'").get();
const klass = seedDb.prepare('SELECT * FROM classes WHERE org_id=? LIMIT 1').get(student.org_id);
const lesson = seedDb.prepare('SELECT lesson_id FROM class_curriculum_items WHERE class_id=? LIMIT 1').get(klass.id).lesson_id;
const legacyProjectId = newId('project');
const legacyWorkId = newId('work');
const legacyUsageId = newId('usage');
seedDb.prepare('INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(legacyProjectId, student.id, student.org_id, klass.id, lesson, '历史用量项目', 'SUBMITTED', EMPTY_CANVAS, 1, now(), now(), now());
seedDb.prepare('INSERT INTO works(id,project_id,student_id,org_id,class_id,course_lesson_id,title,canvas_snapshot,submitted_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(legacyWorkId, legacyProjectId, student.id, student.org_id, klass.id, lesson, '历史用量作品', EMPTY_CANVAS, now());
seedDb.prepare('INSERT INTO usage_records(id,org_id,user_id,project_id,modality,credits_charged,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(legacyUsageId, student.org_id, student.id, legacyProjectId, 'IMAGE', 1, 'SUCCESS', now());
seedDb.close();

await run(['packages/database/src/db.js', '--init']);

const afterMigration = new DatabaseSync(dbPath);
const backfilled = afterMigration.prepare('SELECT work_id FROM usage_records WHERE id=?').get(legacyUsageId);
afterMigration.close();
assert.equal(backfilled.work_id, legacyWorkId, '启动迁移应把历史用量回填到对应作品');

// ② 提交时实时回填 + ③ 报表按作品标题检索
const port = 18843;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });
server.stdout.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
    await sleep(100);
  }

  const studentLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } });
  assert.equal(studentLogin.status, 200, `学生登录失败: ${JSON.stringify(studentLogin.data)}`);
  const studentToken = studentLogin.data.token;

  const courses = await api('/api/student/courses', { token: studentToken });
  const courseItems = courses.data?.items || courses.data?.courses || [];
  const lessonId = courseItems?.[0]?.currentLessonId || courseItems?.[0]?.lessons?.[0]?.id || courseItems?.[0]?.lesson?.id || courseItems?.[0]?.id;
  assert.ok(lessonId, `未获取到课时 ID: ${JSON.stringify(courses.data)}`);

  const workTitle = 'P13 用量作品关联';
  const created = await api('/api/student/projects', { method: 'POST', token: studentToken, body: { courseLessonId: lessonId, title: workTitle } });
  assert.equal(created.status, 200, `学生项目创建失败: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;

  // 模拟该项目已产生的 AI 用量；真实生成链路由 p4-o12 / p6-a01 覆盖，这里只验证提交时的关联回填
  const liveUsageId = newId('usage');
  const liveDb = new DatabaseSync(dbPath);
  liveDb.prepare('INSERT INTO usage_records(id,org_id,user_id,project_id,modality,credits_charged,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(liveUsageId, student.org_id, student.id, projectId, 'IMAGE', 1, 'SUCCESS', now());
  liveDb.close();

  const submitted = await api(`/api/student/projects/${projectId}/submit`, { method: 'POST', token: studentToken, body: { copyrightConfirmed: true } });
  assert.equal(submitted.status, 200, `作品提交失败: ${JSON.stringify(submitted.data)}`);
  const workId = submitted.data.work.id;

  const linkedDb = new DatabaseSync(dbPath);
  const linked = linkedDb.prepare('SELECT work_id FROM usage_records WHERE id=?').get(liveUsageId);
  linkedDb.close();
  assert.equal(linked.work_id, workId, '提交作品后应把该项目的用量记录关联到作品');

  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } });
  assert.equal(adminLogin.status, 200, `管理员登录失败: ${JSON.stringify(adminLogin.data)}`);
  const adminToken = adminLogin.data.token;

  const report = await api('/api/admin/billing/usage-records?search=' + encodeURIComponent(workTitle), { token: adminToken });
  assert.equal(report.status, 200, `平台端用量报表读取失败: ${JSON.stringify(report.data)}`);
  const hit = (report.data.items || []).find((item) => item.id === liveUsageId);
  assert.ok(hit, '平台端用量报表应能按作品标题检索到该记录');
  assert.equal(hit.workId, workId, '报表应返回作品 id');
  assert.equal(hit.workTitle, workTitle, '报表应返回作品标题');
  // 2026-09-13（C3 前置）**推翻了这条旧断言**：当时上游从不返回 token 用量，字段恒为 0，
  // 显示出来只会误导，所以报表干脆不返回它。现在 provider 会把上游的 usage 采集进账本，
  // 字段不再恒为 0（多模态接口仍可能不返回 → 那种就是 0），所以报表改回透出，并语义明确：
  // 「上游返回过才有值」。
  assert.equal(Object.hasOwn(hit, 'inputTokens'), true, '报表应透出 token 用量字段（上游返回过才有值）');
  assert.equal(typeof hit.inputTokens, 'number');
  assert.equal(typeof hit.outputTokens, 'number');

  console.log(JSON.stringify({
    name: 'usage-work-linkage',
    pass: true,
    migrationBackfill: { usageId: legacyUsageId, workId: backfilled.work_id },
    submitBackfill: { usageId: liveUsageId, workId: linked.work_id },
    report: { workId: hit.workId, workTitle: hit.workTitle },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
