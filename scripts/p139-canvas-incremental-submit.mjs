/**
 * P139 画布「增量提交」（2026-09-24 用户口径，交接文档 §十二.A）。
 *
 * 用户口径（逐条钉住，别按自己的理解改）：
 *   ① 画布内**没有任何可提交内容**时，「提交作品」置灰不可点 → 服务端也拒（NO_NEW_OUTPUT）；
 *   ② 出现**任意可提交内容**后按钮激活 → 能提交成功；
 *   ③ 点击后作品提交到后台，**学生仍可继续编辑尚未操作的任务**（画布不再变只读）；
 *   ④ 直到**新的可提交内容**出现，按钮重新激活；提交时只提交**尚未提交的那部分产出**；
 *   ⑤ 这一套持续到**课堂结束**（课堂结束由 session-state 轮询把学生带回课程中心）。
 *
 * 「可提交内容」的判定（用户已确认）：只算**新生成结果 / 新上传成品**
 *   ✅ 生成出来的文字（generatedText）、图片/视频/音乐（assetUrl / previewUrl）、上传完成的成品；
 *   ❌ 不算：改提示词、移动框体、连线变化、普通占位框体、正在生成中、上传未完成。
 * 前后端**同一套算法**：packages/shared/src/canvasOutput.js（服务端直接 import 这个文件）。
 *
 * ⚠️ 这个守卫**起真服务、发真请求**（p128 那套起法）：改提示词不动产出、提交幂等、
 *    提交后还能不能存/能不能生成 —— 只看源码或只调处理函数都验不出来。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p139-incremental-submit-'));
const dbPath = path.join(temp, 'platform.db');
// 硬设（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略。
process.env.PLATFORM_DB_PATH = dbPath;
// 夹具走数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import。
const { aq, arow, arows } = await import('../packages/database/src/store.js');
const { canvasOutputSignature, createSaveGate, hasUnsubmittedOutput } = await import('../packages/shared/src/canvasOutput.js');

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const seeded = {};
{
  const student = await arow("SELECT id, org_id FROM users WHERE login='student-2'");
  const grant = await arow('SELECT series_id FROM student_course_grants WHERE student_id=?', [student.id]);
  const lesson = await arow('SELECT id FROM course_lessons WHERE series_id=? ORDER BY sort LIMIT 1', [grant.series_id]);
  await aq("UPDATE course_lessons SET status='PUBLISHED', delivery_modes='[\"CANVAS\"]' WHERE id=?", [lesson.id]);
  Object.assign(seeded, { studentId: student.id, orgId: student.org_id, seriesId: grant.series_id, lessonId: lesson.id });
}

const port = 19079;
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
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null, code: payload?.error?.code || null };
}
const snapshotOf = (...nodes) => ({ nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
const outputNode = (id, url) => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { title: id, assetUrl: url, previewUrl: url } });

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }

  const rootToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data?.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data?.token;
  const orgAdmin = (await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } })).data?.token;
  assert.ok(rootToken && student && orgAdmin, '登录失败');

  /* ⓪ 纯算法口径（前后端共用这一份）：空画布 / 占位框体 / 未完成的上传都不算产出 */
  {
    const empty = snapshotOf();
    check('⓪ 空画布没有产出指纹（提交按钮就该是灰的）', canvasOutputSignature(empty) === '', canvasOutputSignature(empty));
    const placeholder = snapshotOf({ id: 'box-1', type: 'image', data: { boxId: 'box-1', caption: '一只小猫' } });
    check('⓪ 只有占位框体（提示词）不算产出', !hasUnsubmittedOutput(placeholder, ''), canvasOutputSignature(placeholder));
    const generating = snapshotOf({ id: 'box-1', type: 'image', data: { boxId: 'box-1', generationStatus: 'PENDING' } });
    check('⓪ 正在生成中不算产出', !hasUnsubmittedOutput(generating, ''), canvasOutputSignature(generating));
    const uploading = snapshotOf({ id: 'up-1', type: 'image', data: { uploading: true } });
    check('⓪ 上传未完成不算产出（插话：占位框体也不能单独激活按钮）', !hasUnsubmittedOutput(uploading, ''));
    const produced = snapshotOf(outputNode('a', '/api/student/file-assets/x/download'));
    check('⓪ 有生成结果就是可提交产出', hasUnsubmittedOutput(produced, ''), canvasOutputSignature(produced));
    check('⓪ 相对「已提交过这份产出」不再算新的', !hasUnsubmittedOutput(produced, canvasOutputSignature(produced)));
    const moved = snapshotOf({ ...outputNode('a', '/api/student/file-assets/x/download'), position: { x: 999, y: 999 } });
    check('⓪ 只挪框体位置不算新产出', !hasUnsubmittedOutput(moved, canvasOutputSignature(produced)));
    // 提交期间冻结保存 + 在途旧响应失效（§十二 要求的那条竞态）
    const gate = createSaveGate();
    const inFlight = gate.currentToken();
    gate.beginSubmit();
    check('⓪ 提交期间：新保存被冻结、在途旧保存的响应一律失效', gate.frozen === true && gate.isCurrent(inFlight) === false);
    gate.endSubmit();
    check('⓪ 提交结束后放行（下一轮保存用新 token）', gate.frozen === false && gate.isCurrent(gate.currentToken()) === true);
  }

  // 课时里配一个生图框体（后面用它真生成一次，拿"新产出"）
  const saved = await api(`/api/admin/course-lessons/${seeded.lessonId}`, {
    method: 'PUT', token: rootToken,
    body: {
      capabilities: ['text', 'image'], classroomConfig: { version: 3 },
      materialGroups: [{ title: '素材1', materials: [{ title: '主图', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'IMAGE', model: '', aspectRatio: '9:16', resolution: '1k' }, content: '一只小猫' } }] }],
    },
  });
  assert.equal(saved.status, 200, `课时保存失败: ${JSON.stringify(saved.data)}`);
  const box = saved.data.lessons.find((item) => item.id === seeded.lessonId).generationBoxes[0];

  // 真开一间课堂（没有正在进行的课堂，学生不能创作 —— 那条门禁本身是对的，也是 ⑤ 的判据）
  const session = await api('/api/org/sessions', { method: 'POST', token: orgAdmin, body: { lessonId: seeded.lessonId, deliveryMode: 'CANVAS', title: 'P139 增量提交' } });
  const sessionId = session.data?.id;
  await api(`/api/org/sessions/${sessionId}/students`, { method: 'POST', token: orgAdmin, body: { studentIds: [seeded.studentId] } });
  const started = await api(`/api/org/sessions/${sessionId}/start`, { method: 'POST', token: orgAdmin });
  check('⓪ 夹具：课堂开起来了', Boolean(sessionId) && started.status === 200, JSON.stringify(session).slice(0, 200));

  const created = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: seeded.lessonId, title: 'P139 增量提交', sessionId } });
  const projectId = created.data?.id;
  check('① 建项目成功', Boolean(projectId), JSON.stringify(created).slice(0, 220));
  if (!projectId) throw new Error('建项目失败，后面验不了');
  const submit = (snapshot) => api(`/api/student/projects/${projectId}/submit`, { method: 'POST', token: student, body: { canvasSnapshot: snapshot, description: 'P139', copyrightConfirmed: true } });

  /* ① 空画布不能提交
     -----------------
     产品口径是「没有可提交内容时按钮置灰」（判据见 ⓪ 的算法断言）。服务端这一侧**只在"重复提交"
     这一档上兜底**：第一次提交保留放行 —— 老客户端（桌面端）不带快照也能提交，仓库里还有一批
     验收脚本走的是同一条路（p13/p14/p56/p63/p74/p78…），一刀切会把它们全打红，
     而"空提交"本来就是按钮该挡住的事。第二次起：产出指纹没变过，一律拒。 */
  const emptyFirst = await submit(snapshotOf());
  check('① 第一次提交放行（老客户端兼容；按钮侧已由 ⓪ 的算法挡住空画布）',
    emptyFirst.status === 200 && Number(emptyFirst.data?.work?.submissionRound) === 1,
    `HTTP ${emptyFirst.status} ${JSON.stringify(emptyFirst.error).slice(0, 160)}`);
  const emptyAgain = await submit(snapshotOf());
  check('① 空画布（没有任何产出）再提交：被拒 NO_NEW_OUTPUT ★', emptyAgain.status === 409 && emptyAgain.code === 'NO_NEW_OUTPUT',
    `HTTP ${emptyAgain.status} ${JSON.stringify(emptyAgain.error).slice(0, 160)}`);
  const placeholderSubmit = await submit(snapshotOf({ id: `box-${box.id}`, type: 'image', data: { boxId: box.id, caption: '一只小猫' } }));
  check('① 只有占位框体（还没生成）也算"没有产出"', placeholderSubmit.status === 409 && placeholderSubmit.code === 'NO_NEW_OUTPUT',
    `HTTP ${placeholderSubmit.status} ${JSON.stringify(placeholderSubmit.error).slice(0, 160)}`);

  /* ② 有产出之后能提交 */
  const firstAsset = '/api/student/file-assets/p139-first/download';
  const firstSubmit = await submit(snapshotOf(outputNode('a', firstAsset)));
  const firstSignature = canvasOutputSignature(snapshotOf(outputNode('a', firstAsset)));
  check('② 有产出后提交成功（第 2 轮）', firstSubmit.status === 200 && Number(firstSubmit.data?.work?.submissionRound) === 2,
    `HTTP ${firstSubmit.status} ${JSON.stringify(firstSubmit.error).slice(0, 160)}`);
  const workId = firstSubmit.data?.work?.id;
  check('② 服务端记下了这次提交的产出指纹', firstSubmit.data?.project?.lastSubmittedOutputSignature === firstSignature,
    JSON.stringify({ got: firstSubmit.data?.project?.lastSubmittedOutputSignature, want: firstSignature }).slice(0, 240));
  const storedProject = await arow('SELECT status, last_submitted_output_signature FROM student_projects WHERE id=?', [projectId]);
  check('② 指纹真的落库了（且项目状态是已提交）', storedProject?.last_submitted_output_signature === firstSignature && storedProject?.status === 'SUBMITTED',
    JSON.stringify(storedProject));

  /* ③ 提交之后画布**不锁**：还能自动保存、还能继续生成 */
  const movedSnapshot = snapshotOf({ ...outputNode('a', firstAsset), position: { x: 40, y: 60 } });
  const autoSave = await api(`/api/student/projects/${projectId}`, { method: 'PUT', token: student, body: { canvasSnapshot: movedSnapshot, autoSave: true } });
  check('③ 提交之后自动保存仍然通（画布没被锁死）★', autoSave.status === 200 && autoSave.data?.status === 'SUBMITTED',
    `HTTP ${autoSave.status} ${JSON.stringify(autoSave.error).slice(0, 200)}`);
  const queued = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId, boxId: box.id, modality: 'IMAGE', prompt: '一只小猫' } });
  check('③ 提交之后还能继续生成（生成链路不再以「项目已提交」拒绝）★',
    queued.status === 200 && queued.code !== 'PROJECT_NOT_EDITABLE',
    `HTTP ${queued.status} ${JSON.stringify(queued.error || queued.data).slice(0, 200)}`);
  let asset = null;
  let jobState = { status: 'NOT_QUEUED', errorMessage: null };
  if (queued.status === 200) {
    const jobId = queued.data?.job?.id;
    for (let i = 0; i < 60; i += 1) {
      const detail = await api(`/api/ai/generations/history/${encodeURIComponent(jobId)}`, { token: student });
      jobState = { status: detail.data?.status || null, errorMessage: detail.data?.errorMessage || null, assets: (detail.data?.assets || []).length };
      if (['SUCCEEDED', 'FAILED'].includes(detail.data?.status)) { asset = detail.data?.assets?.[0] || null; break; }
      await sleep(300);
    }
  }
  // 失败时要把"为什么没有产出"打出来（status / errorMessage）—— 只打印 null 等于没说
  check('③ 生成真的做出了新产出（拿它当"新生成的结果"）', Boolean(asset?.assetUrl),
    JSON.stringify({ job: jobState, asset: asset ? { assetUrl: asset.assetUrl } : null }).slice(0, 300));

  /* ④ 有**新的**产出才能再提交一次；没有新产出（含只是删掉一个产出）一律拒 */
  const unchanged = await submit(movedSnapshot);
  check('④ 产出没变就再提交：被拒（幂等，不是"每次点都算一轮"）', unchanged.status === 409 && unchanged.code === 'NO_NEW_OUTPUT',
    `HTTP ${unchanged.status} ${JSON.stringify(unchanged.error).slice(0, 160)}`);
  const deletedOnly = await submit(snapshotOf());
  check('④ 只是把产出删掉（没有新产出）也不能再提交', deletedOnly.status === 409 && deletedOnly.code === 'NO_NEW_OUTPUT',
    `HTTP ${deletedOnly.status} ${JSON.stringify(deletedOnly.error).slice(0, 160)}`);

  const withNewOutput = snapshotOf(outputNode('a', firstAsset), outputNode('b', asset?.assetUrl || '/api/student/file-assets/p139-second/download'));
  const secondSubmit = await submit(withNewOutput);
  check('④ 出现新产出后可以再提交（第 3 轮）★', secondSubmit.status === 200 && Number(secondSubmit.data?.work?.submissionRound) === 3,
    `HTTP ${secondSubmit.status} round=${secondSubmit.data?.work?.submissionRound} ${JSON.stringify(secondSubmit.error).slice(0, 200)}`);
  const submissions = await api(`/api/student/works/${encodeURIComponent(workId)}/submissions`, { token: student });
  check('④ 每轮都留了快照（works 还是同一条、round 递增到 3）',
    (submissions.data?.items || []).length === 3 && Number(submissions.data?.submissionRound) === 3,
    JSON.stringify({ rounds: (submissions.data?.items || []).map((row) => row.round), current: submissions.data?.submissionRound }).slice(0, 200));
  const worksRows = Number((await arow('SELECT COUNT(*) n FROM works WHERE project_id=?', [projectId]))?.n || 0);
  check('④ 反复提交始终是同一条作品记录（不新开作品）', worksRows === 1, `works 行数=${worksRows}`);

  /* ⑤ 课堂结束 → 这一套立刻结束（提交 / 保存 / 生成都被课堂门禁拦住） */
  await api(`/api/org/sessions/${sessionId}/end`, { method: 'POST', token: orgAdmin, body: {} });
  const afterEnd = await submit(snapshotOf(outputNode('a', firstAsset), outputNode('b', '/api/student/file-assets/p139-third/download')));
  check('⑤ 课堂结束后提交被**课堂门禁**拒绝（不是"没有新产出"那一档）★',
    afterEnd.status === 403 && afterEnd.code !== 'NO_NEW_OUTPUT',
    `HTTP ${afterEnd.status} code=${afterEnd.code} ${JSON.stringify(afterEnd.error).slice(0, 200)}`);
  const saveAfterEnd = await api(`/api/student/projects/${projectId}`, { method: 'PUT', token: student, body: { canvasSnapshot: movedSnapshot, autoSave: true } });
  check('⑤ 课堂结束后画布也不能再保存', saveAfterEnd.status !== 200, `HTTP ${saveAfterEnd.status} ${JSON.stringify(saveAfterEnd.error).slice(0, 160)}`);
  const state = await api(`/api/student/projects/${projectId}/session-state`, { token: student });
  check('⑤ 学生端能从 session-state 知道"老师已结束"（据此回课程中心）', state.data?.active === false, JSON.stringify(state.data).slice(0, 160));

  console.log(JSON.stringify({ name: 'canvas-incremental-submit', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(serverLog.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
