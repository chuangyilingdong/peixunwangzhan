/**
 * P65 统计三层守卫（2026-09-12，板块四：固定指标看板）。
 *
 * 用户口径（梳理文档第 6 节）：统计 = **经营 / 算力 / 内容三层**，且「一个概念只在一个地方管」。
 * 这一条钉三件事：
 *   ① 算力层用**元**（不再是旧单位积分），且**四种模态都算进来**（含走不了网关的视频/音乐）；
 *   ② 算力层的数字与「算力网关」页**同源**（都来自算力池账本）；
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
  const other = db.prepare('SELECT id FROM users WHERE role=?').get('x');
  db.prepare('UPDATE course_series SET per_student_budget_fen=? WHERE id=?').run(20000, lessons[0].series_id);
  db.prepare('UPDATE course_series SET per_student_budget_fen=? WHERE id=?').run(100, lessons[1].series_id);
  const insert = db.prepare(`INSERT OR REPLACE INTO usage_records(
      id,org_id,user_id,modality,model,credits_charged,status,fail_code,pricing_snapshot,cost_fen,series_id,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`);
  const rows = [['TEXT', 100], ['IMAGE', 200], ['VIDEO', 500], ['MUSIC', 300]];
  rows.forEach(([modality, fen], index) => insert.run('p65_a' + index, student.org_id, student.id, modality, 'm', 1, 'SUCCESS', null, '{}', fen, lessons[0].series_id));
  insert.run('p65_exhausted', student.org_id, student.id, 'IMAGE', 'm', 1, 'SUCCESS', null, '{}', 500, lessons[1].series_id); // 另一个课包上限 1 元 → 已用尽
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
  check('① 算力层用「元」：两个池子合计 = 11 + 5 = 16.00 元', compute.totalYuan === 16, JSON.stringify({ totalYuan: compute.totalYuan }));
  check('① 按模态拆开了（含视频与音乐 —— 它们走不了网关，只有应用侧账本算得到）',
    ['TEXT', 'IMAGE', 'VIDEO', 'MUSIC'].every((m) => (compute.byModality || []).some((item) => item.modality === m)), JSON.stringify(compute.byModality));
  check('① 各模态金额正确（视频 5 元 / 音乐 3 元 / 图片 2+5=7 元）',
    compute.byModality.find((item) => item.modality === 'VIDEO')?.yuan === 5 &&
    compute.byModality.find((item) => item.modality === 'MUSIC')?.yuan === 3 &&
    compute.byModality.find((item) => item.modality === 'IMAGE')?.yuan === 7,
    JSON.stringify(compute.byModality));
  check('① 池子健康度：识别出「已用尽」的池子', compute.pools?.exhausted >= 1, JSON.stringify(compute.pools));
  check('① 池子健康度：两个课包 = 两个池子', compute.pools?.counted === 2, JSON.stringify(compute.pools));
  check('① 池子健康度：已用合计 16 元', compute.pools?.usedYuan === 16, JSON.stringify(compute.pools));
  check('① Top 学员消耗与算力网关页同源（同一份报表）', (compute.topStudents || []).some((item) => Number(item.usedYuan) >= 11), JSON.stringify(compute.topStudents));

  // 与「算力网关」页那份报表逐项对一遍，确认「同源」不是嘴上说说
  const pools = await api('/api/admin/compute-pools', { token: admin });
  const sameStudent = (pools.data?.items || []).filter((item) => item.userId === seeded.studentId);
  const reportUsed = sameStudent.reduce((total, item) => total + Number(item.usedYuan || 0), 0);
  check('② 与算力网关页的池子报表金额一致（同源）', Math.abs(reportUsed - (compute.pools?.usedYuan || 0)) < 0.001, `报表 ${reportUsed} vs 统计 ${compute.pools?.usedYuan}`);

  const content = stats.data?.content || {};
  check('③ 内容层：已发布课时数给了', Number(content.lessonsPublished) > 0, JSON.stringify(content.lessonsPublished));
  check('③ 内容层：作品发布情况（提交/在广场/精选/已下架）都是数字', ['submittedWorks', 'onPlaza', 'featured', 'unpublished'].every((key) => typeof content[key] === 'number'), JSON.stringify(content));
  check('③ 内容层：课时热度 Top 列表存在（哪怕为空数组）', Array.isArray(content.lessonHot), JSON.stringify(content.lessonHot));

  console.log(JSON.stringify({ name: 'statistics', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-2500));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
