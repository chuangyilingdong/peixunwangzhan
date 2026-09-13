/**
 * P63 下架原因学生可见（2026-09-12，梳理文档第 5 节待办：板块三的一小刀）。
 *
 * 两条作品链路以前对学生都「不给说法」：
 *   · 画布作品：下架原因写进 works.teacher_comment，但**学生端界面不显示**；
 *   · VibeCoding 作品：下架只是把 is_public 置 0，**一个字都不记** → 学生只看到作品从广场消失。
 * 用户口径：下架原因要学生可见。这一条钉两件事：
 *   ① 画布链路：平台下架必须填原因，且**学生拉自己的作品列表能拿到**（unpublishReason）；
 *   ② VibeCoding 链路：不填原因就拒绝下架；填了要落库、并且在**学生的提交负载里能拿到**；
 *      重新发布要把旧原因清掉（否则学生看到过期说明）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p63-unpublish-reason-'));
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

// 环境准备：种子库的课时默认只开画布，而这条守卫要同时跑「画布提交」与「VibeCoding 提交」两条链路
// → 把所有课时开成双入口并开放 text 能力（趁服务没起，避免并发写锁）
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE course_lessons SET delivery_modes='[\"CANVAS\",\"VIBECODING\"]'").run();
  db.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) SELECT id, 'text', datetime('now') FROM course_lessons").run();
  db.close();
}

const port = 18995;
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
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(admin && student, '登录失败');

  /* ── 画布链路 ── */
  const courses = await api('/api/student/courses', { token: student });
  const items = courses.data?.items || courses.data?.courses || [];
  const lessonId = items?.[0]?.currentLessonId || items?.[0]?.lessons?.[0]?.id || items?.[0]?.lesson?.id || items?.[0]?.id;
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title: 'P63 画布作品' } });
  assert.ok(project.data?.id, '建项目失败：' + JSON.stringify(project).slice(0, 200));
  const submitted = await api(`/api/student/projects/${encodeURIComponent(project.data.id)}/submit`, { method: 'POST', token: student, body: { title: 'P63 画布作品', description: '下架原因可见性', copyrightConfirmed: true } });
  const workId = submitted.data?.id || submitted.data?.work?.id;
  check('① 学生提交画布作品成功', Boolean(workId), JSON.stringify(submitted).slice(0, 240));

  const publish = await api(`/api/admin/works/${encodeURIComponent(workId)}/plaza`, { method: 'PUT', token: admin, body: { published: true } });
  check('① 平台把它发布到作品广场', publish.status === 200, JSON.stringify(publish).slice(0, 200));
  const noReason = await api(`/api/admin/works/${encodeURIComponent(workId)}/unpublish`, { method: 'PUT', token: admin, body: {} });
  check('① 画布链路：不填原因不许下架', noReason.status === 400 && noReason.error?.code === 'WORK_UNPUBLISH_REASON_REQUIRED', JSON.stringify(noReason).slice(0, 200));
  const reasonText = '画面里有联系方式，按规范撤下，可以改完再交。';
  const un = await api(`/api/admin/works/${encodeURIComponent(workId)}/unpublish`, { method: 'PUT', token: admin, body: { reason: reasonText } });
  check('① 画布链路：填了原因能下架', un.status === 200, JSON.stringify(un).slice(0, 200));
  const myWorks = await api('/api/student/works?limit=20', { token: student });
  const mine = (myWorks.data?.items || []).find((item) => item.id === workId);
  check('① 画布链路：**学生拉自己的作品就能看到下架原因**', mine?.unpublishReason === reasonText, JSON.stringify({ status: mine?.status, unpublishReason: mine?.unpublishReason }));

  /* 2026-09-13（C2）存储层：下架要有**自己的状态和原因列**，不再复用 REJECTED / teacher_comment */
  const { DatabaseSync } = await import('node:sqlite');
  const afterUnpublish = new DatabaseSync(dbPath);
  const rowAfter = afterUnpublish.prepare('SELECT status, unpublish_reason, unpublished_at, is_public, teacher_comment FROM works WHERE id=?').get(workId);
  afterUnpublish.close();
  check('① 存储层：下架写的是 UNPUBLISHED，不再是 REJECTED',
    rowAfter?.status === 'UNPUBLISHED', JSON.stringify({ status: rowAfter?.status }));
  check('① 存储层：下架原因写进**独立列** unpublish_reason（不再占用 teacher_comment）',
    rowAfter?.unpublish_reason === reasonText && !rowAfter?.teacher_comment, JSON.stringify({ unpublish_reason: rowAfter?.unpublish_reason, teacher_comment: rowAfter?.teacher_comment }));
  check('① 存储层：记了下架时间，并且同步撤出广场（is_public=0）',
    Boolean(rowAfter?.unpublished_at) && Number(rowAfter?.is_public) === 0, JSON.stringify({ unpublished_at: rowAfter?.unpublished_at, is_public: rowAfter?.is_public }));
  check('① 平台列表按新状态能筛到这条作品（口径真的落到查询上）',
    ((await api('/api/admin/works?status=UNPUBLISHED&limit=50', { token: admin })).data?.items || []).some((item) => item.id === workId));
  check('① 旧状态 REJECTED 已经筛不到它（两个状态不再混）',
    !((await api('/api/admin/works?status=REJECTED&limit=50', { token: admin })).data?.items || []).some((item) => item.id === workId));

  /* 重新上架：状态回到 PUBLISHED，且**旧的下架原因被清掉**（不给学生过期说明） */
  const republished = await api(`/api/admin/works/${encodeURIComponent(workId)}/plaza`, { method: 'PUT', token: admin, body: { published: true } });
  check('① 重新上架成功（UNPUBLISHED → PUBLISHED 这条路是通的）', republished.status === 200, JSON.stringify(republished).slice(0, 200));
  const recheck = new DatabaseSync(dbPath);
  const rowRepublished = recheck.prepare('SELECT status, unpublish_reason, is_public FROM works WHERE id=?').get(workId);
  recheck.close();
  check('① 重新上架后：旧下架原因清空、状态回到 PUBLISHED',
    rowRepublished?.status === 'PUBLISHED' && !rowRepublished?.unpublish_reason && Number(rowRepublished?.is_public) === 1,
    JSON.stringify(rowRepublished));

  /* 历史行兜底：C2 之前的行是 REJECTED + teacher_comment，读取时仍要能给学生一句下架说明 */
  const legacy = new DatabaseSync(dbPath);
  legacy.prepare("UPDATE works SET status='REJECTED', unpublish_reason=NULL, teacher_comment=?, is_public=0 WHERE id=?").run('C2 之前的下架原因', workId);
  legacy.close();
  const legacyMine = ((await api('/api/student/works?limit=20', { token: student })).data?.items || []).find((item) => item.id === workId);
  check('① 历史行兜底：REJECTED + teacher_comment（老数据）仍能看到下架原因',
    legacyMine?.unpublishReason === 'C2 之前的下架原因', JSON.stringify({ status: legacyMine?.status, unpublishReason: legacyMine?.unpublishReason }));

  /* ── VibeCoding 链路 ── */
  const lessonAll = await api('/api/student/courses', { token: student });
  const lessonIds = (lessonAll.data?.items || []).flatMap((item) => [item.currentLessonId, ...(item.lessons || []).map((l) => l.id), item.lesson?.id, item.id]).filter(Boolean);
  let conversation = null;
  for (const candidate of [...new Set(lessonIds)]) {
    const created = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: candidate, title: 'P63 会话' } });
    if (created.status === 200 && created.data?.id) { conversation = created.data; break; }
  }
  assert.ok(conversation?.id, '开 VibeCoding 会话失败（该账号没有可用的 VibeCoding 课时？）');
  const vibeSubmit = await api(`/api/student/vibecoding/conversations/${encodeURIComponent(conversation.id)}/submit`, { method: 'POST', token: student, body: { title: 'P63 VibeCoding 作品', description: '下架原因可见性', copyrightConfirmed: true } });
  const submissionId = vibeSubmit.data?.id || vibeSubmit.data?.submission?.id;
  check('② 学生提交 VibeCoding 作品成功', Boolean(submissionId), JSON.stringify(vibeSubmit).slice(0, 240));

  const vibePublish = await api(`/api/admin/vibecoding-works/${encodeURIComponent(submissionId)}/plaza`, { method: 'PUT', token: admin, body: { published: true } });
  check('② 平台把它发布到作品广场', vibePublish.status === 200 && vibePublish.data?.isPublic === true, JSON.stringify(vibePublish).slice(0, 200));
  const vibeNoReason = await api(`/api/admin/vibecoding-works/${encodeURIComponent(submissionId)}/plaza`, { method: 'PUT', token: admin, body: { published: false } });
  check('② VibeCoding 链路：不填原因不许下架', vibeNoReason.status === 400 && vibeNoReason.error?.code === 'WORK_UNPUBLISH_REASON_REQUIRED', JSON.stringify(vibeNoReason).slice(0, 200));
  const vibeReason = '作品里用了未授权的音乐，先撤下来换一首。';
  const vibeUn = await api(`/api/admin/vibecoding-works/${encodeURIComponent(submissionId)}/plaza`, { method: 'PUT', token: admin, body: { published: false, reason: vibeReason } });
  check('② VibeCoding 链路：填了原因能下架', vibeUn.status === 200 && vibeUn.data?.isPublic === false, JSON.stringify(vibeUn).slice(0, 240));
  const conversationDetail = await api(`/api/student/vibecoding/conversations/${encodeURIComponent(conversation.id)}`, { token: student });
  check('② VibeCoding 链路：**学生打开自己的会话就能看到下架原因**', conversationDetail.data?.submission?.unpublishReason === vibeReason, JSON.stringify(conversationDetail.data?.submission?.unpublishReason));

  /* 重新发布要清掉旧原因（否则学生看到过期说明） */
  const republish = await api(`/api/admin/vibecoding-works/${encodeURIComponent(submissionId)}/plaza`, { method: 'PUT', token: admin, body: { published: true } });
  const afterRepublish = await api(`/api/student/vibecoding/conversations/${encodeURIComponent(conversation.id)}`, { token: student });
  check('② 重新发布后旧的下架原因被清掉（不给学生过期说明）',
    republish.status === 200 && afterRepublish.data?.submission?.unpublishReason === null,
    JSON.stringify({ republished: republish.data?.isPublic, reason: afterRepublish.data?.submission?.unpublishReason }));

  console.log(JSON.stringify({ name: 'unpublish-reason-visible', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
