/**
 * P72 机构端「课包概览」守卫（2026-09-13，用户要求：机构要看已授权课包的
 * 可授权次数 / 已分配 / 剩余 / 明细，以及每个课包多少学员、多少老师、多少课堂）。
 *
 * 这一页最怕的是「数跟明细对不上」——所以本守卫的核心是**交叉核对**：
 *   ① `series-overview` 的每一列都能从别的接口/库里复算出来（同源，不是两套算法）；
 *   ② 课包范围只能是自己机构被授权的那些（不会串机构）；
 *   ③ 剩余次数 = 可授权 − 已分配（不为负）；
 *   ④ 课堂计数按「课时属于哪个课包」归集，与直接查库一致；
 *   ⑤ 权限边界：教师不能看机构课包分配概览，也不能分配（分配是机构管理员的事）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p72-series-overview-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18972;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(pathname, { method = 'GET', token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data ?? j, error: j?.error || null };
}
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

try {
  for (let i = 0; i < 80; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  const login = async (name, password) => {
    const r = await api('/api/auth/login', { method: 'POST', body: { login: name, password } });
    assert.ok(r.data?.token, `登录失败：${name} ${JSON.stringify(r).slice(0, 160)}`);
    return r.data.token;
  };
  const admin = await login('org-admin', 'org123');
  const teacher = await login('teacher-1', 'teach123');

  // 给机构一个「有次数」的课包：直接改库设可授权次数（平台侧接口要绕平台账号，这里只测机构视角）
  const seedDb = new DatabaseSync(dbPath);
  const series = seedDb.prepare("SELECT id, title FROM course_series WHERE status='PUBLISHED' LIMIT 1").get();
  const orgId = seedDb.prepare("SELECT org_id FROM users WHERE login='org-admin'").get().org_id;
  const students = seedDb.prepare("SELECT id FROM users WHERE role='STUDENT' AND org_id=? LIMIT 3").all(orgId);
  // 种子里已经给 2 名学生发过许可（那是直接插库、没走「分配」计数器）——先清掉，起点才干净，
  // 否则会出现「已分配 0 / 可授权 5，但已分配学员 2」这种看着矛盾的数据（本守卫第一版就是这样）
  seedDb.prepare('DELETE FROM student_course_grants WHERE series_id=? AND org_id=?').run(series.id, orgId);
  seedDb.prepare("DELETE FROM course_assignments WHERE series_id=? AND org_id=?").run(series.id, orgId);
  seedDb.prepare("INSERT INTO course_assignments(id,series_id,org_id,status,assigned_by,assigned_at,quota_total,quota_used) VALUES ('assign_p72',?,?,'ACTIVE','user_p72',datetime('now'),5,0)").run(series.id, orgId);
  seedDb.close();

  /* ① 概览可用，且课包范围 = 我被授权的课包（同源） */
  const overview = await api('/api/org/series-overview?days=30', { token: admin });
  check('① 概览接口可用', overview.status === 200 && Array.isArray(overview.data?.items), JSON.stringify(overview).slice(0, 200));
  const courseList = await api('/api/org/course-series?limit=100', { token: admin });
  const expectedSeries = (courseList.data?.items || []).map((item) => item.id).sort();
  const gotSeries = (overview.data?.items || []).map((item) => item.seriesId).sort();
  check('① 课包范围与「课程中心」完全一致（不串机构、不漏）', JSON.stringify(expectedSeries) === JSON.stringify(gotSeries), JSON.stringify({ expectedSeries, gotSeries }));
  const row = (overview.data?.items || []).find((item) => item.seriesId === series.id);
  check('① 目标课包在列表里', Boolean(row), JSON.stringify(overview.data?.items || []).slice(0, 200));
  check('① 可授权次数读的是授权单上的 quota_total（5）', Number(row?.quotaTotal) === 5, JSON.stringify(row));

  /* ② 分配 2 个学员后：已分配 2、剩余 3、明细 2 条（三处同源） */
  const granted = await api('/api/org/course-grants', { method: 'POST', token: admin, body: { seriesId: series.id, studentIds: students.slice(0, 2).map((item) => item.id) } });
  check('② 分配 2 名学员成功', granted.status === 200 && Number(granted.data?.granted) === 2, JSON.stringify(granted).slice(0, 200));
  const after = (await api('/api/org/series-overview?days=30', { token: admin })).data.items.find((item) => item.seriesId === series.id);
  check('② 已分配次数 = 2（跟着授权单的 quota_used 走）', Number(after?.quotaUsed) === 2, JSON.stringify(after));
  check('② 剩余 = 可授权 − 已分配 = 3', Number(after?.remaining) === 3, JSON.stringify({ total: after?.quotaTotal, used: after?.quotaUsed, remaining: after?.remaining }));
  check('② 已分配学员数 = 2、人次 = 2', Number(after?.grantedStudents) === 2 && Number(after?.grantedCount) === 2, JSON.stringify(after));
  const detail = await api(`/api/org/course-grants?seriesId=${encodeURIComponent(series.id)}`, { token: admin });
  const activeGrants = (detail.data?.items || []).filter((item) => !item.revokedAt);
  check('② 「已分配学员」与明细细表对得上（同一份许可数据）', activeGrants.length === Number(after?.grantedStudents), JSON.stringify({ detailActive: activeGrants.length, students: after?.grantedStudents }));

  /* ③ 课堂计数：按「课时属于哪个课包」归集，与直接查库一致 */
  const db = new DatabaseSync(dbPath);
  const lessonIds = db.prepare('SELECT id FROM course_lessons WHERE series_id=?').all(series.id).map((item) => item.id);
  const placeholders = lessonIds.map(() => '?').join(',') || "''";
  const liveCount = (status) => Number(db.prepare(`SELECT COUNT(*) n FROM class_sessions WHERE status=? AND lesson_id IN (${placeholders})`).get(status, ...lessonIds)?.n || 0);
  const pendingInDb = liveCount('PENDING');
  const activeInDb = liveCount('ACTIVE');
  db.close();
  check('③ 待上课课堂数与库里一致', Number(after?.pendingSessions) === pendingInDb, JSON.stringify({ api: after?.pendingSessions, db: pendingInDb }));
  check('③ 上课中课堂数与库里一致', Number(after?.activeSessions) === activeInDb, JSON.stringify({ api: after?.activeSessions, db: activeInDb }));

  /* ④ 汇总 = 逐项之和 */
  const totals = (await api('/api/org/series-overview?days=30', { token: admin })).data.totals;
  const items = (await api('/api/org/series-overview?days=30', { token: admin })).data.items;
  const sumOf = (key) => items.reduce((total, item) => total + Number(item[key] || 0), 0);
  check('④ 汇总的「已分配 / 可授权 / 剩余 / 学员」都等于逐项之和',
    Number(totals.quotaUsed) === sumOf('quotaUsed') && Number(totals.quotaTotal) === sumOf('quotaTotal')
    && Number(totals.remaining) === sumOf('remaining') && Number(totals.grantedStudents) === sumOf('grantedStudents'),
    JSON.stringify({ totals, sum: { quotaUsed: sumOf('quotaUsed'), quotaTotal: sumOf('quotaTotal'), remaining: sumOf('remaining'), grantedStudents: sumOf('grantedStudents') } }));
  check('④ 课包数 = 逐项条数', Number(totals.seriesCount) === items.length, JSON.stringify({ seriesCount: totals.seriesCount, items: items.length }));

  /* ⑤ 权限边界：机构分配概览与分配操作仅管理员可用 */
  const teacherView = await api('/api/org/series-overview?days=30', { token: teacher });
  check('⑤ 教师不能查看机构课包分配概览', teacherView.status === 403 && teacherView.error?.code === 'ORG_ADMIN_REQUIRED', JSON.stringify(teacherView).slice(0, 160));
  const teacherGrant = await api('/api/org/course-grants', { method: 'POST', token: teacher, body: { seriesId: series.id, studentIds: [students[2]?.id].filter(Boolean) } });
  check('⑤ 教师不能把课包分给学员（分配是机构管理员的事）', teacherGrant.status === 403, `实际 ${teacherGrant.status}`);

  /* ⑥ 参数校验：天数越界会被拒（不静默按默认值跑） */
  const badDays = await api('/api/org/series-overview?days=9999', { token: admin });
  check('⑥ 天数越界返回 400（参数校验真的生效）', badDays.status === 400, `实际 ${badDays.status}`);

  console.log(JSON.stringify({ name: 'org-series-overview', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
