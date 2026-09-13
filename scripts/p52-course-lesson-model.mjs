/**
 * P52 课包/课时新模型守卫（2026-09-11，平台侧重做梳理 P1）。
 *
 * 盯住三件容易「写进去但读不出来」的事（都是这一轮踩过的静默失败类型）：
 *   ① 课时**可多选**上课类型（画布 + VibeCoding 并列）——新列 delivery_modes（JSON 数组），
 *      老列 delivery_mode 必须同步成「第一种」，否则既有读取方（学生端门禁/公开接口）会失明；
 *   ② 每学生算力上限（分）与课包库存（次）能存能取；
 *   ③ 学生端**两个入口并列**：双类型课时进画布与进 VibeCoding 都放行；
 *      只开一种的课时，另一种入口必须被拦（不能因为改成数组就全放开）。
 * 另外断言老数据（只有单值 delivery_mode）读出来自动变成单元素数组。
 *
 * 使用临时 SQLite，不碰默认库/生产库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensureClassroom, switchClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p52-lesson-model-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
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

// ① 纯函数：老数据回退（不起服务就能钉住）
const { normalizeLesson } = await import(pathToFileURL(path.join(root, 'apps/server/src/lib.js')).href);
check('老数据（只有 delivery_mode）读出来是单元素数组', JSON.stringify(normalizeLesson({ id: 'x', delivery_mode: 'VIBECODING' }).deliveryModes) === '["VIBECODING"]');
check('坏 JSON 不会炸，回退到 delivery_mode', JSON.stringify(normalizeLesson({ id: 'x', delivery_mode: 'CANVAS', delivery_modes: '{oops' }).deliveryModes) === '["CANVAS"]');
check('双类型数组原样读出', JSON.stringify(normalizeLesson({ id: 'x', delivery_mode: 'CANVAS', delivery_modes: '["CANVAS","VIBECODING"]' }).deliveryModes) === '["CANVAS","VIBECODING"]');
check('非法类型被过滤后回退', JSON.stringify(normalizeLesson({ id: 'x', delivery_mode: 'CANVAS', delivery_modes: '["WECHAT"]' }).deliveryModes) === '["CANVAS"]');
check('每学生算力上限不填时为 null', normalizeLesson({ id: 'x' }).perStudentBudgetFen === null);

const port = 18898;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null };
}
const login = async (loginName, password) => (await api('/api/auth/login', { method: 'POST', body: { login: loginName, password } })).data;

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ } await sleep(100); }
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
  const rootAdmin = (await login('root', 'admin123')).token;
  const orgAdmin = await login('org-admin', 'org123');
  const student = await login('student-2', 'study123');
  assert.ok(rootAdmin && orgAdmin?.token && student?.token, '登录失败');

  const lesson = (title, extra) => ({ title, status: 'PUBLISHED', capabilities: ['text'], durationMinutes: 45, ...extra });

  // ② 建课包：库存 + 三种课时（双类型 / 只画布 / 只 Vibe）
  const created = await api('/api/admin/course-series', {
    method: 'POST', token: rootAdmin,
    body: {
      title: 'P52 新模型课包', description: '课包/课时新字段守卫', coverImageUrl: 'https://example.com/guard-cover.png', visibility: 'ALL_ORGS', stockTotal: 10000,
      lessons: [
        lesson('双入口课时', { deliveryModes: ['CANVAS', 'VIBECODING'], perStudentBudgetFen: 5000 }),
        lesson('只画布课时', { deliveryMode: 'CANVAS' }),
        lesson('只 Vibe 课时', { deliveryMode: 'VIBECODING' }),
        lesson('待改类型课时', { deliveryMode: 'CANVAS' }),
        // ⚠️ 只传 deliveryModes（数组）、不传老字段 —— 这正是平台端「新建课包向导」发的形状。
        //    以前这种形状会让老列 delivery_mode 停在默认的 CANVAS（向导建出来的 VibeCoding 课时
        //    在按老列读的地方会显示成画布课堂），2026-09-12 修掉并在这里钉住。
        lesson('只 Vibe 用数组课时', { deliveryModes: ['VIBECODING'] }),
      ],
    },
  });
  assert.equal(created.status, 200, `建课包失败: ${JSON.stringify(created.data).slice(0, 200)}`);
  const seriesId = created.data.id;
  check('课包库存能存能取（10000 次）', Number(created.data.stockTotal) === 10000, `stockTotal=${created.data.stockTotal}`);

  const byTitle = (list, title) => (list || []).find((item) => item.title === title) || {};
  const lessons = created.data.lessons || [];
  const dual = byTitle(lessons, '双入口课时');
  const canvasOnly = byTitle(lessons, '只画布课时');
  const vibeOnly = byTitle(lessons, '只 Vibe 课时');
  const toChange = byTitle(lessons, '待改类型课时');
  check('双类型课时读回两种类型', JSON.stringify(dual.deliveryModes) === '["CANVAS","VIBECODING"]', JSON.stringify(dual.deliveryModes));
  check('老字段 delivery_mode 同步成第一种（兼容既有读取方）', dual.deliveryMode === 'CANVAS', dual.deliveryMode);
  check('每学生算力上限能存能取（50 元 = 5000 分）', Number(dual.perStudentBudgetFen) === 5000, String(dual.perStudentBudgetFen));
  check('只画布课时读回单元素数组', JSON.stringify(canvasOnly.deliveryModes) === '["CANVAS"]', JSON.stringify(canvasOnly.deliveryModes));
  check('只 Vibe 课时读回单元素数组', JSON.stringify(vibeOnly.deliveryModes) === '["VIBECODING"]', JSON.stringify(vibeOnly.deliveryModes));
  check('没配预算的课时读回 null（不拦，只记账）', canvasOnly.perStudentBudgetFen === null, String(canvasOnly.perStudentBudgetFen));
  const arrayOnly = byTitle(lessons, '只 Vibe 用数组课时');
  check('只传数组也能读回单元素类型', JSON.stringify(arrayOnly.deliveryModes) === '["VIBECODING"]', JSON.stringify(arrayOnly.deliveryModes));
  check('★ 只传数组时老字段同步成数组第一种（向导发的就是这种形状）', arrayOnly.deliveryMode === 'VIBECODING', String(arrayOnly.deliveryMode));

  // ③ 编辑：把「只画布」改成两种都开
  const updated = await api(`/api/admin/course-lessons/${toChange.id}`, { method: 'PUT', token: rootAdmin, body: { deliveryModes: ['VIBECODING', 'CANVAS'] } });
  const updatedLesson = (updated.data?.lessons || []).find((item) => item.id === toChange.id) || {};
  check('编辑课时能改成两种类型', updated.status === 200 && JSON.stringify(updatedLesson.deliveryModes) === '["VIBECODING","CANVAS"]', JSON.stringify(updatedLesson.deliveryModes));
  check('老字段跟着变成数组第一种', updatedLesson.deliveryMode === 'VIBECODING', updatedLesson.deliveryMode);

  // ④ 发布课包 + 授权给机构 + 把三个课时排进学生所在班级
  const published = await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: rootAdmin, body: { action: 'publish' } });
  check('课包能发布（新字段不挡发布校验）', published.status === 200, JSON.stringify(published.data).slice(0, 160));
  const assigned = await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: rootAdmin, body: { orgIds: [orgAdmin.organization.id], validityDays: 365, quotaTotal: 10 } });
  check('课包能授权给机构', assigned.status === 200, JSON.stringify(assigned.data).slice(0, 160));
  // 授权给机构 ≠ 学员能上课：还要机构**把课包分给学员**（学生进课要求有效学员许可，叠加口径）。
  // 这里走机构端真实接口（与界面上「学员许可」页同一条链路），顺带把这一步也纳进覆盖。
  const studentId = student.user?.id || student.data?.user?.id;
  const granted = await api('/api/org/course-grants', { method: 'POST', token: orgAdmin.token, body: { seriesId, studentIds: [studentId] } });
  check('机构能把课包分给学员（学生进课的前提）', granted.status === 200, JSON.stringify(granted).slice(0, 200));
  // 批次 B：许可只是第①②步，进课还要「老师在某个**进行中的课堂**里把他加进名单」。
  // ⚠️ 必须在**发许可之后**再跑夹具 —— 它只对已有许可的课包建课堂，早跑等于没跑
  //    （启动时那次是给种子课包建的，覆盖不到这里刚建的课包）。
  ensureClassroom(dbPath);

  // 批次 D（班级退场）：原来这里「把三个课时排进班级课单」——课单已退场，
  // 「学生能进哪节课」现在只由**课堂名单**决定，所以这一步换成「确认夹具已经把他排进了课堂」。
  const classroomList = await api('/api/org/sessions?days=365', { token: orgAdmin.token });
  const myClassrooms = (classroomList.data?.items || []).filter((item) => Number(item.studentCount || 0) > 0);
  check('学生已被排进课堂（夹具搭好的前提）', myClassrooms.length > 0, JSON.stringify((classroomList.data?.items || []).slice(0, 2)));

  // ⑤ 学生端：两个入口并列（按**这节课的课堂**开放的类型给入口）
  const canvasEntry = await api('/api/student/projects', { method: 'POST', token: student.token, body: { courseLessonId: dual.id, title: 'P52 画布入口' } });
  check('双类型课时：画布入口可用', canvasEntry.status === 200, `${canvasEntry.status} ${canvasEntry.error?.code || ''}`);
  // 批次 B：一个课堂只带**一种**入口类型（既定设计），所以「双类型课时两个入口并列」现在的含义是
  // 「两个入口各自在对应类型的课堂下放行」。验第二半之前先把入口类型切成 VIBECODING。
  switchClassroom(dbPath, { deliveryMode: 'VIBECODING' });
  const vibeEntry = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student.token, body: { lessonId: dual.id, title: 'P52 Vibe 入口' } });
  check('双类型课时：VibeCoding 入口也可用（并列）', vibeEntry.status === 200, `${vibeEntry.status} ${vibeEntry.error?.code || ''}`);
  const vibeOnlyCanvas = await api('/api/student/projects', { method: 'POST', token: student.token, body: { courseLessonId: vibeOnly.id, title: '不该成功' } });
  check('只 Vibe 的课时：画布入口被拦', vibeOnlyCanvas.status === 403, `${vibeOnlyCanvas.status} ${vibeOnlyCanvas.error?.code || ''}`);
  const canvasOnlyVibe = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student.token, body: { lessonId: canvasOnly.id, title: '不该成功' } });
  check('只画布的课时：Vibe 入口被拦', canvasOnlyVibe.status === 403, `${canvasOnlyVibe.status} ${canvasOnlyVibe.error?.code || ''}`);

  console.log(JSON.stringify({ name: 'course-lesson-model', pass: failures === 0, seriesId, failures }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
