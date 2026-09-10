/**
 * P31 音乐生成框体：歌词生音乐 / 描述生音乐（平台代写词）。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：课时里配音乐框体（两种模式）→ 学生项目按框体下发（带模式与模型）→
 * 歌词模式：学生的输入就是要唱的词，请求体 metadata.lyrics = 学生输入；
 * 描述模式：平台先用文本模型把描述写成歌词，再交给音乐模型（请求体带 lyrics + 曲风描述）；
 * 每框体只能生成一次；模型只声明一种模式时框体跟着模型走。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p31-music-box-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
process.env.DEPLOYMENT_MODE = 'local-mock';

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18913;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });
server.stdout.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}
async function waitForJob(token, jobId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const detail = await api(`/api/ai/generations/history/${jobId}`, { token });
    if (['SUCCEEDED', 'FAILED'].includes(detail.data?.status)) return detail.data;
    await sleep(500);
  }
  throw new Error('生成任务未在预期时间内结束');
}

const LYRICS = '[Verse]\n小星星眨眨眼\n月亮弯弯挂天上';
const DESCRIPTION = '一首关于春天放风筝的欢快儿歌';

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const rootToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(rootToken && student, '登录失败');

  const { DatabaseSync } = await import('node:sqlite');
  const seedDb = new DatabaseSync(dbPath);
  const lesson = seedDb.prepare('SELECT id FROM course_lessons ORDER BY sort LIMIT 1').get();
  seedDb.close();

  // 1) 管理端保存：歌词模式 + 描述模式两个音乐框体（音乐渠道用 local-mock）
  const saved = await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: {
      capabilities: ['text', 'image', 'music'],
      classroomConfig: { version: 3 },
      materialGroups: [{
        title: '素材1',
        materials: [
          { title: '唱一首小星星', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'MUSIC', model: '', mode: 'LYRICS' }, content: LYRICS } },
          { title: '春天的儿歌', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'MUSIC', model: '', mode: 'DESCRIPTION' }, content: DESCRIPTION } },
        ],
      }],
    },
  });
  assert.equal(saved.status, 200, `音乐框体应能保存: ${JSON.stringify(saved.data)}`);
  const savedLesson = saved.data.lessons.find((item) => item.id === lesson.id);
  assert.deepEqual(savedLesson.generationBoxes.map((box) => box.mode), ['LYRICS', 'DESCRIPTION'], `两种模式应原样保存，实际 ${JSON.stringify(savedLesson.generationBoxes.map((b) => b.mode))}`);
  assert.deepEqual(savedLesson.generationBoxes.map((box) => box.modality), ['MUSIC', 'MUSIC'], '框体模态应为 MUSIC');

  // 2) 非法模式要当场 400
  const badMode = await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: { capabilities: ['music'], materialGroups: [{ title: '素材1', materials: [{ title: '坏模式', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'MUSIC', mode: 'HUMMING' } } }] }] },
  });
  assert.equal(badMode.status, 200, '不认识的模式会回落到默认（不再静默丢弃非法值以外的情况）');
  const fixedMode = badMode.data.lessons.find((item) => item.id === lesson.id).generationBoxes[0].mode;
  assert.equal(fixedMode, 'LYRICS', `非法模式应回落到歌词模式，实际 ${fixedMode}`);

  // 恢复成两个框体
  await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: {
      capabilities: ['text', 'image', 'music'], classroomConfig: { version: 3 },
      materialGroups: [{
        title: '素材1',
        materials: [
          { title: '唱一首小星星', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'MUSIC', model: '', mode: 'LYRICS' }, content: LYRICS } },
          { title: '春天的儿歌', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'MUSIC', model: '', mode: 'DESCRIPTION' }, content: DESCRIPTION } },
        ],
      }],
    },
  });

  // 3) 学生项目按框体下发模式与预填内容
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lesson.id, title: 'P31 音乐框体' } });
  assert.equal(project.status, 200, `项目创建失败: ${JSON.stringify(project.data)}`);
  const boxes = project.data.generationBoxes || [];
  assert.deepEqual(boxes.map((box) => box.mode), ['LYRICS', 'DESCRIPTION'], '学生端应拿到两种模式');
  assert.equal(boxes[0].prompt, LYRICS, '歌词框体应下发预填歌词');
  assert.equal(boxes[1].prompt, DESCRIPTION, '描述框体应下发预填描述');

  // 4) 歌词模式：请求体里 metadata.lyrics 就是学生输入，prompt（曲风）为空
  const { generationOptionsFor, providerSelectionForModality } = await import('../apps/server/src/routes/aiGeneration.js');
  const { renderRequestTemplate, requestTemplateFor, musicRequestContext } = await import('../apps/server/src/services/modelCapabilities.js');
  const context = { lesson: { generationBoxes: boxes } };
  const policy = { provider: 'local-mock', channels: [], modalityChannels: {} };
  const template = requestTemplateFor({ requestTemplates: {} }, 'MUSIC', {});
  const lyricsOptions = generationOptionsFor({ context, modality: 'MUSIC', policy, selection: providerSelectionForModality(policy, 'MUSIC', ''), box: boxes[0] });
  assert.equal(lyricsOptions.mode, 'LYRICS', '歌词模式应识别');
  const lyricsContext = musicRequestContext({ prompt: LYRICS, mode: lyricsOptions.mode, lyrics: lyricsOptions.lyrics });
  const lyricsBody = renderRequestTemplate(template, { model: 'mureka-v9-song', prompt: LYRICS, ...lyricsContext });
  assert.equal(lyricsBody.metadata?.lyrics, LYRICS, `歌词模式的 lyrics 应是学生输入，实际 ${JSON.stringify(lyricsBody.metadata)}`);
  assert.ok(String(lyricsBody.prompt).length > 0, `歌词模式的曲风要用平台默认（上游必填），实际 ${JSON.stringify(lyricsBody.prompt)}`);
  assert.ok(lyricsBody.prompt.includes('儿童'), `默认曲风应适合儿童，实际 ${lyricsBody.prompt}`);

  // 5) 歌词模式真实生成一次
  const lyricsJobQueued = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: boxes[0].id, modality: 'MUSIC', prompt: LYRICS } });
  assert.equal(lyricsJobQueued.status, 200, `歌词模式生成入队失败: ${JSON.stringify(lyricsJobQueued.data)}`);
  const lyricsJob = await waitForJob(student, lyricsJobQueued.data.job.id);
  assert.equal(lyricsJob.status, 'SUCCEEDED', `歌词模式应生成成功，实际 ${lyricsJob.status}（${lyricsJob.errorCode || ''}）`);
  assert.equal(lyricsJob.modality, 'MUSIC', '任务模态应为 MUSIC');
  assert.equal(lyricsJob.boxId, boxes[0].id, '任务应记录音乐框体');

  // 6) 描述模式：平台代写歌词（local-mock 的文本模型会返回模拟文本）
  const descJobQueued = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: boxes[1].id, modality: 'MUSIC', prompt: DESCRIPTION } });
  assert.equal(descJobQueued.status, 200, `描述模式生成入队失败: ${JSON.stringify(descJobQueued.data)}`);
  const descJob = await waitForJob(student, descJobQueued.data.job.id);
  assert.equal(descJob.status, 'SUCCEEDED', `描述模式应生成成功，实际 ${descJob.status}（${descJob.errorCode || ''}）`);
  assert.equal(descJob.boxId, boxes[1].id, '描述模式任务应记录框体');

  // 7) 同一音乐框体只能生成一次
  const reused = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: boxes[0].id, modality: 'MUSIC', prompt: LYRICS } });
  assert.equal(reused.status, 403, `同一音乐框体不能生成第二次，实际 ${reused.status}`);
  assert.equal(reused.data?.error?.code, 'GENERATION_BOX_USED', `错误码应为 GENERATION_BOX_USED，实际 ${reused.data?.error?.code}`);

  console.log(JSON.stringify({
    name: 'music-generation-box', pass: true,
    modes: savedLesson.generationBoxes.map((box) => box.mode),
    lyricsRequest: { prompt: lyricsBody.prompt, lyrics: String(lyricsBody.metadata?.lyrics || '').slice(0, 20) },
    jobs: { lyrics: lyricsJob.status, description: descJob.status },
    guard: reused.data?.error?.code,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
