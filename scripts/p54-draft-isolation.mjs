/**
 * P54 草稿隔离守卫（2026-09-12）：不点「更新发布」，机构端/学生端看不到改动。
 *
 * 机制：平台端编辑的是**实时数据**；「更新发布」（以及首次发布课包）时把内容定格进
 * `published_content` 快照；机构端 / 学生端 / 官网按快照读。老数据没有快照 → 回退实时数据。
 * 盯住三件事：① 改完没发布 → 机构端与学生端读到的还是旧内容；② 更新发布后立刻读到新内容；
 * ③ 平台端自己始终读实时数据（否则编辑界面会「改不动」）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openClassroom } from './lib/classroomApi.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p54-draft-'));
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
const port = 18901;
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
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', org123: 'x', password: 'org123' } })).data;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data;
  assert.ok(admin && orgAdmin?.token && student?.token, '登录失败');

  const created = await api('/api/admin/course-series', {
    method: 'POST', token: admin,
    body: { title: 'P54 草稿隔离课包', stockTotal: 1, description: '第一版简介', coverImageUrl: 'https://example.com/guard-cover.png', visibility: 'ALL_ORGS', priceFen: 9900, lessons: [{ title: '第1课 原始标题', status: 'PUBLISHED', capabilities: ['text'], deliveryModes: ['CANVAS'], lessonContent: '原始正文' }] },
  });
  assert.equal(created.status, 200, `建课包失败: ${JSON.stringify(created.data).slice(0, 160)}`);
  const seriesId = created.data.id;
  const lessonId = created.data.lessons[0].id;

  // 首次发布 + 授权 + **发许可 + 建课堂把学生排进去**（学生才能进这节课）
  // 批次 D：原来走「建班级 → 配课单」，班级退场后改成直接建课堂（scripts/lib/classroomApi.mjs）
  const initialPublish = await api(`/api/admin/course-series/${seriesId}/status`, { method: 'POST', token: admin, body: { action: 'publish' } });
  assert.equal(initialPublish.status, 200, JSON.stringify(initialPublish));
  const assigned = await api(`/api/admin/course-series/${seriesId}/assignments`, { method: 'POST', token: admin, body: { orgIds: [orgAdmin.organization.id], validityDays: 365, quotaTotal: 1, amountMinor: 100, currency: 'CNY', paymentStatus: 'PAID', orderNo: `P54-O-${seriesId}`, contractNo: `P54-C-${seriesId}`, idempotencyKey: `p54-purchase-${seriesId}` } });
  assert.equal(assigned.status, 200, JSON.stringify(assigned));
  const studentId = student.user?.id || student.data?.user?.id;
  const granted = await api('/api/org/course-grants', { method: 'POST', token: orgAdmin.token, body: { seriesId, studentIds: [studentId] } });
  assert.equal(granted.status, 200, JSON.stringify(granted));
  assert.equal(granted.data.granted, 1);
  await openClassroom(api, orgAdmin.token, { lessonId, title: 'P54 课堂', studentIds: [studentId] });

  const orgRead = async () => JSON.stringify((await api(`/api/org/course-series/${seriesId}`, { token: orgAdmin.token })).data);
  const studentRead = async () => {
    const response = await api('/api/student/projects', { method: 'POST', token: student.token, body: { courseLessonId: lessonId, title: 'P54' } });
    assert.equal(response.status, 200, JSON.stringify(response));
    return JSON.stringify(response.data);
  };

  check('发布后机构端读到原始内容', (await orgRead()).includes('第1课 原始标题'));
  check('发布后学生端也读得到（能进课时）', (await studentRead()).length > 10);

  // ① 改课时但**不发布** → 机构端/学生端仍读旧内容
  await sleep(1100);
  const edited = await api(`/api/admin/course-lessons/${lessonId}`, { method: 'PUT', token: admin, body: { title: '第1课 改过的标题', lessonContent: '改过的正文' } });
  assert.equal(edited.status, 200, `改课时失败: ${JSON.stringify(edited.data).slice(0, 160)}`);
  const adminRead = JSON.stringify((await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin })).data);
  check('平台端自己读到的是实时内容（编辑界面要能看到自己刚改的）', adminRead.includes('第1课 改过的标题'), adminRead.slice(0, 120));
  check('① 改完没发布：机构端仍读到旧标题', (await orgRead()).includes('第1课 原始标题'), (await orgRead()).slice(0, 160));
  const studentBefore = await studentRead();
  check('① 改完没发布：学生端仍读到旧标题', studentBefore.includes('第1课 原始标题') && !studentBefore.includes('第1课 改过的标题'), studentBefore.slice(0, 160));

  // ② 更新发布 → 机构端/学生端立刻读到新内容
  const published = await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.1', note: '改了第 1 课标题与正文' } });
  check('更新发布成功', published.status === 200, JSON.stringify(published.data).slice(0, 120));
  check('② 更新发布后：机构端读到新标题', (await orgRead()).includes('第1课 改过的标题'), (await orgRead()).slice(0, 160));
  const afterText = JSON.stringify((await api(`/api/admin/course-series/${seriesId}/detail`, { token: admin })).data);
  check('更新发布后不再提示「有未发布的改动」', afterText.includes('"hasUnpublishedChanges":false'), afterText.slice(0, 100));

  // ③ 课包资料层（标题/价格）同样隔离
  await api(`/api/admin/course-series/${seriesId}`, { method: 'PUT', token: admin, body: { title: 'P54 草稿隔离课包（改过）', description: '第二版简介', priceFen: 29900 } });
  const orgAfterSeriesEdit = await orgRead();
  check('③ 课包资料改了但没发布：机构端仍读到旧标题', orgAfterSeriesEdit.includes('P54 草稿隔离课包"'), orgAfterSeriesEdit.slice(0, 120));
  check('③ 课包资料改了但没发布：机构端仍读到旧价格', !orgAfterSeriesEdit.includes('"priceFen":29900'), orgAfterSeriesEdit.slice(0, 200));
  const seriesPublished = await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.2', note: '改了课包资料' } });
  assert.equal(seriesPublished.status, 200, JSON.stringify(seriesPublished));
  const orgAfterSeriesPublish = await orgRead();
  check('③ 更新发布后：机构端读到新课包标题与价格', orgAfterSeriesPublish.includes('改过') && orgAfterSeriesPublish.includes('29900'), orgAfterSeriesPublish.slice(0, 160));

  // ④ 框体 / 课堂素材也要隔离，而且**画布与「点生成」的判定必须是同一份**
  //
  // 2026-09-21 生产 bug：学生画布画的框体来自 normalizeProject（读**实时**），而生成接口校验 boxId
  // 用的是 studentContext（读**快照**）—— 两边指向两批不同的 id，学生「看得见新框体，点生成却报
  // 「生成框体不存在或已不属于本课」」。生产上 17 节课全中（带框体的课时全在内）。
  // ⚠️ p28 一直在绿，是因为它那节课**从来没发布过**（没有快照 → 两边都回退实时）—— 这条只能在这里钉。
  const boxMaterial = (title, content) => ({ title, materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'TEXT' }, content } });
  // 保存框体：PUT 的响应就是整个课包（含课时素材，走平台端=实时），直接从里面取新 id
  const saveBoxes = async (materials) => {
    const saved = await api(`/api/admin/course-lessons/${lessonId}`, { method: 'PUT', token: admin, body: { materialGroups: [{ title: '任务一', materials }] } });
    assert.equal(saved.status, 200, `保存框体失败: ${JSON.stringify(saved.data).slice(0, 200)}`);
    const groups = (saved.data?.lessons || []).find((item) => item.id === lessonId)?.materialGroups || [];
    return groups.flatMap((group) => group.materials || []).map((item) => item.id);
  };
  const studentLesson = async () => (await api(`/api/student/courses/${seriesId}`, { token: student.token })).data;
  const boxesOf = (payload) => (payload?.lessons || []).find((item) => item.id === lessonId)?.generationBoxes || [];
  const projectBoxes = async () => ((await api('/api/student/projects', { method: 'POST', token: student.token, body: { courseLessonId: lessonId, title: 'P54 框体' } })).data?.generationBoxes || []);

  const boxA = (await saveBoxes([boxMaterial('任务一：文本框体（A）', '你好，AI！请介绍一下哪吒。')]))[0];
  assert.ok(boxA, '框体 A 没保存成功');
  const publishA = await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.3', note: '发布框体 A' } });
  assert.equal(publishA.status, 200, JSON.stringify(publishA.data).slice(0, 160));
  check('④ 发布后：学生端课时读面拿到框体 A', JSON.stringify(boxesOf(await studentLesson())).includes(boxA), JSON.stringify(boxesOf(await studentLesson())).slice(0, 160));
  check('④ 发布后：学生画布（项目 payload）也是框体 A', (await projectBoxes()).some((box) => box.id === boxA));

  // 重建框体（新 id），**不发布** —— 学生那边必须整体还是 A，而且生成接口要认 A（两边同源）
  const boxB = (await saveBoxes([boxMaterial('任务一：文本框体（B）', '重建后的新框体。')]))[0];
  assert.ok(boxB && boxB !== boxA, `框体 B 应是一个新 id（A=${boxA} B=${boxB}）`);
  const readWhileDraft = JSON.stringify(boxesOf(await studentLesson()));
  check('④ 重建但没发布：学生端课时读面仍是框体 A（未发布不可见）', readWhileDraft.includes(boxA) && !readWhileDraft.includes(boxB), readWhileDraft.slice(0, 200));
  const draftProjectBoxes = await projectBoxes();
  check('④ 重建但没发布：学生画布（项目 payload）仍是框体 A —— 与判定同一份', draftProjectBoxes.some((box) => box.id === boxA) && !draftProjectBoxes.some((box) => box.id === boxB), JSON.stringify(draftProjectBoxes.map((box) => box.id)).slice(0, 200));
  const generateWithA = await api('/api/ai/generations/async', { method: 'POST', token: student.token, body: { projectId: (await api('/api/student/projects', { method: 'POST', token: student.token, body: { courseLessonId: lessonId, title: 'P54 框体生成' } })).data.id, boxId: boxA, modality: 'TEXT', prompt: boxA ? '你好，AI！请介绍一下哪吒。' : '' } });
  check('④ 重建但没发布：投递给接口的框体 id 属于快照（这一条只证明快照没被换掉）', generateWithA.data?.error?.code !== 'GENERATION_BOX_NOT_FOUND', JSON.stringify(generateWithA.data).slice(0, 200));
  // ⭐ 这条才是用户看到的症状：客户端提交的是**画布上那个框体**的 id（它从项目 payload 里拿）。
  //    画布读实时、判定读快照时，两边不是同一份 → 这里必红（GENERATION_BOX_NOT_FOUND）。
  const canvasBoxId = draftProjectBoxes[0]?.id;
  const generateFromCanvas = await api('/api/ai/generations/async', { method: 'POST', token: student.token, body: { projectId: (await api('/api/student/projects', { method: 'POST', token: student.token, body: { courseLessonId: lessonId, title: 'P54 画布框体生成' } })).data.id, boxId: canvasBoxId, modality: 'TEXT', prompt: '画布上那个框体点生成' } });
  check('④ 重建但没发布：拿**画布上那个框体**去生成，不会报「生成框体不存在或已不属于本课」', generateFromCanvas.data?.error?.code !== 'GENERATION_BOX_NOT_FOUND', `boxId=${canvasBoxId} ${JSON.stringify(generateFromCanvas.data).slice(0, 200)}`);

  // 发布 → 两边一起换成 B
  const publishB = await api(`/api/admin/course-series/${seriesId}/versions`, { method: 'POST', token: admin, body: { version: '1.4', note: '发布框体 B' } });
  assert.equal(publishB.status, 200, JSON.stringify(publishB.data).slice(0, 160));
  const readAfterPublish = JSON.stringify(boxesOf(await studentLesson()));
  check('④ 更新发布后：学生端课时读面换成框体 B', readAfterPublish.includes(boxB) && !readAfterPublish.includes(boxA), readAfterPublish.slice(0, 200));
  const publishedProjectBoxes = await projectBoxes();
  check('④ 更新发布后：学生画布也一起换成框体 B（全部同步）', publishedProjectBoxes.some((box) => box.id === boxB) && !publishedProjectBoxes.some((box) => box.id === boxA), JSON.stringify(publishedProjectBoxes.map((box) => box.id)).slice(0, 200));

  // ⑤「有未发布的改动」必须在**标签上**就看得见（用户口径 2026-09-21：
  //    「如果有修改未发布的，应该是在版本发布这里有明显的提示，而不是点进去才看得到」）。
  //    判据与面板里那个 status 同一处（detail.hasUnpublishedChanges），所以只要钉住：
  //    ① 标签按这个判据渲染 .tab__flag；② 角标有样式（含选中态，紫底上不能被吃掉）。
  const courseManagement = fs.readFileSync(path.join(root, 'apps/admin/src/components/CourseManagement.jsx'), 'utf8');
  const sharedStyles = fs.readFileSync(path.join(root, 'packages/shared/src/styles.css'), 'utf8');
  check('⑤ 课包详情：「版本发布」标签上有「有未发布」角标，判据与面板里那个 status 同一处',
    /key === 'publish' && detail\.data\.hasUnpublishedChanges/.test(courseManagement)
    && /className="tab__flag"/.test(courseManagement));
  check('⑤ 角标有样式（含选中态：紫底上换半透明白，别被吃掉）',
    /\.tab__flag \{/.test(sharedStyles) && /\.tab\.is-active \.tab__flag \{/.test(sharedStyles));

  console.log(JSON.stringify({ name: 'draft-isolation', pass: failures === 0, seriesId, failures }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
