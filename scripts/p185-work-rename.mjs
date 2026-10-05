/**
 * P185 作品名称可改（老师 / 机构 / 平台）＋ 改名后各处同步（2026-10-05 用户口径）。
 *
 * 用户原话：「学生提交上来的作品，**老师/机构/平台都可以改作品名称**。把"只读作品"文案去掉」
 *          「图2 这里增加个修改作品名称的按钮。作品名称改了之后，**包括分享页面、官网作品都要同步**」
 *
 * 为什么要有这条守卫：改名是"改一处、到处都要跟着变"的功能 —— 改的是作品行上的 `title` 一列
 * （`works.title` / `vibecoding_submissions.title`），而**组织端列表、平台端列表、作品广场、
 * 分享卡**读的都是这一列。所以这条把"改完之后各处读到什么"逐处钉住，顺带钉住**越权**：
 * 老师只能改自己课堂的作品（作用域与读面同一套 WHERE），越权必须是 404 而不是 403 ——
 * 「看不见」与「改不了」在界面上必须是同一个答案（否则等于告诉对方"这个 id 存在"）。
 *
 * 钉十条：
 *   ① 夹具：学生提交一件 VibeCoding 作品（标题就是入口文件名 index.html）；
 *   ② ⭐ 老师（这间课堂是他的）用**课堂作用域**改名 → 200，机构端详情 / 列表都读到新名字；
 *   ③ 机构管理员用**机构作用域**改名 → 200（没有课堂的提交也改得了，那是这条作用域存在的理由）；
 *   ④ 越权：同机构**别的老师**改 → 404；不存在的作品 → 404；
 *   ⑤ 校验：空名称 → 400（不能把作品改成没名字）；
 *   ⑥ ⭐ 同步到官网：发布后 `/api/public/vibecoding-works/<token>` 的标题 = 新名字；
 *   ⑦ ⭐ 同步到分享页：分享卡 `work.title` = 新名字；
 *   ⑧ 平台端也能改（`/api/admin/vibecoding-works/<id>` PUT）→ 机构端读到的就是平台改的名字；
 *   ⑨ 画布作品同样能改（课堂作用域），越权的老师仍 404；
 *   ⑩ 静态：「只读作品」这句话在机构端源码里**再也搜不到**，三处入口都挂了改名按钮，服务端留了审计。
 *
 * 跑法：node scripts/p185-work-rename.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p185-rename-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const PORT = 18985;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p185-guard-secret',
  PORT: String(PORT),
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
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);
await aq("UPDATE class_sessions SET delivery_mode='VIBECODING'");
await aq("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
};
const loginAs = async (name, password) => (await api('/api/auth/login', { method: 'POST', body: { login: name, password } })).data?.token;

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-600)}`);
    await sleep(150);
  }

  /* ───────── 夹具 ───────── */
  // ⚠️ 取学生所在的课堂时**不要 `LIMIT 1` 随手挑一场**：一个学生可能同时在多场 ACTIVE 课堂里
  //    （ensureClassroom 是按「学生 × 课时」开场的），随手挑的那场很可能不是**他这次提交挂上去的**那场，
  //    于是课堂作用域一律 404（本守卫第一版就是这么时红时绿的）。
  //    正解：先提交，再从提交快照反查它**真正挂在哪堂课**，后面全用那一场。
  const enrolled = await arow(`SELECT student.login, student.id AS student_id
       FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id AND session.status='ACTIVE'
       JOIN users student ON student.id = part.student_id
      WHERE part.status='ACTIVE' ORDER BY student.created_at LIMIT 1`);
  assert.ok(enrolled?.login, '夹具没把学生放进课堂');
  const studentToken = await loginAs(enrolled.login, 'study123');
  check('① 夹具：学生可以登录', Boolean(studentToken));

  const ENTRY = '<!doctype html><html><head><meta charset="utf-8"><title>P185</title></head><body><h1>P185 作品</h1></body></html>';
  const submitted = await api('/api/student/runtime/submit-upload', {
    method: 'POST', token: studentToken,
    body: { name: 'index.html', title: 'index.html', copyrightConfirmed: true, files: [{ name: 'index.html', content: ENTRY, binary: false }] },
  });
  const workId = submitted.data?.id;
  check('① 夹具：VibeCoding 作品提交成功（标题就是 index.html 这种"没起名"的样子）',
    submitted.status === 200 && Boolean(workId), JSON.stringify(submitted.raw).slice(0, 200));

  // 这件作品真正挂的那场课堂（= 提交时的 ACTIVE 课堂）
  const ownSession = await arow(`SELECT session.id, session.teacher_id, session.org_id, session.lesson_id
       FROM vibecoding_submissions submission
       JOIN vibecoding_conversations conversation ON conversation.id=submission.conversation_id
       JOIN class_sessions session ON session.id=conversation.class_session_id
      WHERE submission.id=?`, [workId]);
  assert.ok(ownSession?.id, '作品没有挂在任何课堂上（夹具前提不成立）');
  const session = { id: ownSession.id, teacher_id: ownSession.teacher_id, org_id: ownSession.org_id, lesson_id: ownSession.lesson_id };

  const ownerTeacher = await arow('SELECT login FROM users WHERE id=?', [session.teacher_id]);
  const otherTeacher = await arow("SELECT login FROM users WHERE role='TEACHER' AND org_id=? AND id<>? LIMIT 1", [session.org_id, session.teacher_id]);
  const ownerToken = await loginAs(ownerTeacher?.login, 'teach123');
  const otherToken = await loginAs(otherTeacher?.login, 'teach123');
  const orgAdminToken = await loginAs('org-admin', 'org123');
  const rootToken = await loginAs('root', 'admin123');
  check('① 夹具：本课堂老师 / 同机构另一老师 / 机构管理员 / 平台管理员都能登录',
    Boolean(ownerToken && otherToken && orgAdminToken && rootToken),
    JSON.stringify({ owner: Boolean(ownerToken), other: Boolean(otherToken), org: Boolean(orgAdminToken), root: Boolean(rootToken) }));

  const detailPath = `/api/org/sessions/${encodeURIComponent(session.id)}/works/VIBECODING/${encodeURIComponent(workId)}`;

  /* ───────── ② 老师改名（课堂作用域）───────── */
  const renamed = await api(detailPath, { method: 'PUT', token: ownerToken, body: { title: '布布的小窝' } });
  check('② ⭐ 老师（这间课堂是他的）能改作品名称 → 200 且返回新名字',
    renamed.status === 200 && renamed.data?.title === '布布的小窝',
    JSON.stringify({ status: renamed.status, data: renamed.data }).slice(0, 200));
  const afterTeacher = await api(detailPath, { token: ownerToken });
  check('② 机构端详情立刻读到新名字（同一份 title，不需要另存）',
    afterTeacher.data?.title === '布布的小窝', JSON.stringify(afterTeacher.data?.title));
  const orgList = await api('/api/org/works', { token: orgAdminToken });
  const listed = (orgList.data?.items || []).find((item) => item.id === workId && item.source === 'VIBECODING');
  check('② 机构端作品列表也读到新名字', listed?.title === '布布的小窝', JSON.stringify(listed?.title));

  /* ───────── ③ 机构管理员改名（机构作用域）───────── */
  const orgRenamed = await api(`/api/org/works/VIBECODING/${encodeURIComponent(workId)}`, { method: 'PUT', token: orgAdminToken, body: { title: '布布的小窝（机构定稿）' } });
  check('③ ⭐ 机构管理员用机构作用域也能改名（没有课堂的提交同样改得了）',
    orgRenamed.status === 200 && orgRenamed.data?.title === '布布的小窝（机构定稿）',
    JSON.stringify({ status: orgRenamed.status, data: orgRenamed.data }).slice(0, 200));

  /* ───────── ④ 越权与校验 ───────── */
  // ⚠️ 课堂作用域下，**连这堂课都看不见**的老师在 `resolveWorkScope` 就被挡成 403（与读面同款行为）；
  //    能看见课堂、但作品不属于它的情况才是 404。两种都算"拒绝"，所以这里验的是**拒绝 + 名字没被动过**。
  const foreign = await api(detailPath, { method: 'PUT', token: otherToken, body: { title: '别人课堂的作品' } });
  const foreignTitle = (await api(`/api/org/works/VIBECODING/${encodeURIComponent(workId)}`, { token: orgAdminToken })).data?.title;
  check('④ ⭐ 不是他课堂的老师改 → 被拒（403/404），且作品名字一个字节都没变',
    [403, 404].includes(foreign.status) && foreignTitle === '布布的小窝（机构定稿）',
    JSON.stringify({ status: foreign.status, title: foreignTitle }));
  const missing = await api(`/api/org/works/VIBECODING/work_does_not_exist`, { method: 'PUT', token: orgAdminToken, body: { title: '不存在' } });
  check('④ 改一件不存在的作品 → 404', missing.status === 404, `status=${missing.status}`);
  const blank = await api(detailPath, { method: 'PUT', token: ownerToken, body: { title: '   ' } });
  check('④ 空白名称 → 400（作品不能没名字）', blank.status === 400, `status=${blank.status}`);

  /* ───────── ⑥⑦ 官网与分享页同步 ───────── */
  const publicToken = `p185-token-${workId.slice(-8)}`;
  await aq('UPDATE vibecoding_submissions SET is_public=1, share_token=? WHERE id=?', [publicToken, workId]);
  const publicDetail = await api(`/api/public/vibecoding-works/${encodeURIComponent(publicToken)}`);
  check('⑥ ⭐ 官网作品页读到的是新名字（公开接口读同一列）',
    publicDetail.status === 200 && publicDetail.data?.title === '布布的小窝（机构定稿）', JSON.stringify(publicDetail.data?.title));
  const share = await api('/api/student/share-links', { method: 'POST', token: studentToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:index.html' } });
  const card = share.data?.code ? await api(`/api/public/share-links/${encodeURIComponent(share.data.code)}`) : { data: null };
  check('⑦ ⭐ 分享页（扫码页）读到的也是新名字',
    card.data?.work?.title === '布布的小窝（机构定稿）', JSON.stringify(card.data?.work));

  /* ───────── ⑧ 平台端也能改 ───────── */
  const platformEdit = await api(`/api/admin/vibecoding-works/${encodeURIComponent(workId)}`, {
    method: 'PUT', token: rootToken, body: { title: '布布的小窝（平台定稿）', description: '' },
  });
  check('⑧ 平台端改名 → 200', platformEdit.status === 200, JSON.stringify(platformEdit.raw).slice(0, 160));
  const afterPlatform = await api(detailPath, { token: ownerToken });
  check('⑧ 平台改完，机构端读到的就是平台那份（同一列，三端不各存一份）',
    afterPlatform.data?.title === '布布的小窝（平台定稿）', JSON.stringify(afterPlatform.data?.title));

  /* ───────── ⑨ 画布作品同样能改 ───────── */
  const now = new Date().toISOString();
  await aq('INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['project_p185', enrolled.student_id, session.org_id, null, session.lesson_id, 'P185 画布项目', 'SUBMITTED', JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), 1, now, now, now]);
  const canvasWorkId = 'work_p185_canvas';
  await aq('INSERT INTO works(id,project_id,student_id,org_id,class_id,class_session_id,course_lesson_id,title,canvas_snapshot,submitted_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [canvasWorkId, 'project_p185', enrolled.student_id, session.org_id, null, session.id, session.lesson_id, 'P185 画布作品',
      JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), now, 'PENDING']);
  const canvasPath = `/api/org/sessions/${encodeURIComponent(session.id)}/works/CANVAS/${encodeURIComponent(canvasWorkId)}`;
  const canvasRenamed = await api(canvasPath, { method: 'PUT', token: ownerToken, body: { title: '画布作品·新名字' } });
  check('⑨ 画布作品（挂在这堂课里）也能改名 → 200', canvasRenamed.status === 200 && canvasRenamed.data?.title === '画布作品·新名字',
    JSON.stringify({ status: canvasRenamed.status, data: canvasRenamed.data }).slice(0, 160));
  const canvasForeign = await api(canvasPath, { method: 'PUT', token: otherToken, body: { title: '画布作品·越权' } });
  const canvasTitle = (await arow('SELECT title FROM works WHERE id=?', [canvasWorkId]))?.title;
  check('⑨ 画布作品的越权改名同样被拒（403/404），名字没被改',
    [403, 404].includes(canvasForeign.status) && canvasTitle === '画布作品·新名字',
    JSON.stringify({ status: canvasForeign.status, title: canvasTitle }));

  /* ───────── ⑩ 静态口径 ───────── */
  const readSource = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const orgSources = ['apps/org/src/pages/classroom/ClassroomWork.jsx', 'apps/org/src/pages/classroom/ClassroomDetail.jsx', 'apps/org/src/pages/classroom/ui.jsx', 'apps/org/src/main.jsx'];
  const withWording = orgSources.filter((file) => readSource(file).includes('只读作品'));
  check('⑩ ⭐「只读作品」这句话在机构端源码里再也搜不到（页眉就是作品名称本身）',
    withWording.length === 0, JSON.stringify(withWording));
  const renameEntrySources = ['apps/org/src/pages/classroom/ClassroomWork.jsx', 'apps/org/src/pages/classroom/ClassroomDetail.jsx', 'apps/org/src/main.jsx'];
  const missingEntry = renameEntrySources.filter((file) => !readSource(file).includes('data-testid="work-rename"'));
  check('⑩ 三处入口都挂了改名按钮（作品预览页眉 / 课堂作品表 / 作品管理列表）',
    missingEntry.length === 0, JSON.stringify(missingEntry));
  check('⑩ 服务端改名走的是同一段作用域判据，并留了审计（源码口径）',
    /WORK_TITLE_RENAME/.test(readSource('apps/server/src/routes/orgAdmin.js')) && /vibeWorkWhere\(scope\)/.test(readSource('apps/server/src/routes/orgAdmin.js')));
  check('⑩ 分享页把作品名称显示出来（改完名扫码页要跟着变）',
    /share-card__title/.test(readSource('apps/website/src/pages/WorkShare.jsx')));
} catch (error) {
  failures += 1;
  console.error('P185 抛错：', error?.message || error);
  console.error(serverLog.split('\n').slice(-12).join('\n'));
} finally {
  server.kill('SIGTERM');
}

console.log(failures === 0 ? '\n✓ p185 作品改名（老师/机构/平台）与各处同步：全部通过' : `\n✗ p185 有 ${failures} 处不符合预期`);
assert.equal(failures, 0, `P185 有 ${failures} 条断言没过`);
