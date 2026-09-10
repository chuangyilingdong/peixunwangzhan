/**
 * P28 生成框体「框体也是素材」：框体存在素材表里（material_type=GENERATION_BOX），
 * 和图片/文字素材排在同一条顺序上，学生端逐条交叉点击。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：素材里混排框体 → 下发顺序 = 素材顺序（素材1 → 框体1 → 框体2 → …）→
 * 每个框体取自己的模型与参数（9:16 与 16:9、5 秒与 10 秒互不影响）→
 * 管理端保存时逐框体严格校验（非法值当场 400）→ 素材 id 保存后不变（学生节点/生成记录仍认得出）→
 * 同一框体只能生成一次 → 未知框体 / 缺框体 / 类型不符都被拦。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p28-boxes-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
// 本脚本也会直接调用服务端函数（generationOptionsFor），它们按 PLATFORM_DB_PATH 连库，
// 所以测试进程自己也要指向同一个临时库。
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

const port = 18912;
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

const PRESET_FIRST_FRAME = '/api/student/file-assets/asset-seed/download';
// 素材顺序刻意交叉：素材1组 = [图片素材, 框体]，素材2组 = [框体, 框体]，素材3组 = [框体]
const GROUPS = [
  {
    title: '素材1',
    materials: [
      { id: 'material-img-1', title: '参考图', materialType: 'IMAGE', assetUrl: '/api/student/file-assets/asset-ref/download', snapshot: {} },
      { id: 'box-image-vertical', title: '竖版主图', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'IMAGE', model: '', aspectRatio: '9:16', resolution: '2k' }, content: '画一只会飞的小猫' } },
    ],
  },
  {
    title: '素材2',
    materials: [
      { id: 'box-image-wide', title: '横版插图', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'IMAGE', model: '', aspectRatio: '16:9', resolution: '1k' }, content: '画一座云上的城堡' } },
      { id: 'box-video-short', title: '开场短片', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'VIDEO', model: '', aspectRatio: '16:9', resolution: '480p', durationSeconds: 5, audio: false }, content: '小猫从窗台飞向天空' } },
    ],
  },
  {
    title: '素材3',
    materials: [
      { id: 'box-video-long', title: '结尾短片', materialType: 'GENERATION_BOX', assetUrl: PRESET_FIRST_FRAME, snapshot: { box: { modality: 'VIDEO', model: 'hailuo-h3-i2v', aspectRatio: '9:16', resolution: '480p', durationSeconds: 10, audio: false }, content: '云上城堡缓缓降落' } },
    ],
  },
];
const BOX_IDS = ['box-image-vertical', 'box-image-wide', 'box-video-short', 'box-video-long'];

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const rootToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  assert.ok(rootToken, 'root 登录失败');
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(student, '学生登录失败');

  const { DatabaseSync } = await import('node:sqlite');
  const seedDb = new DatabaseSync(dbPath);
  const seedDb2 = seedDb;
  const lesson = seedDb.prepare('SELECT id FROM course_lessons ORDER BY sort LIMIT 1').get();
  assert.ok(lesson?.id, '种子数据应至少有一个课时');

  // 预置素材要能被解析成上游可抓的公开地址，所以库里得真有这条公开文件
  seedDb2.prepare("INSERT INTO file_assets(id,owner_type,storage_kind,file_name,mime_type,category,visibility,status,created_at,updated_at) VALUES ('asset-seed','PLATFORM','INTERNAL_PROXY','seed.png','image/png','MEDIA_ASSET','PUBLIC_PLATFORM','ACTIVE',?,?)").run(new Date().toISOString(), new Date().toISOString());

  // 1) 管理端保存：框体作为素材一起提交，顺序原样保留
  const saved = await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: { capabilities: ['text', 'image', 'video'], classroomConfig: { version: 3 }, materialGroups: GROUPS },
  });
  assert.equal(saved.status, 200, `框体素材应能保存: ${JSON.stringify(saved.data)}`);
  const savedLesson = saved.data.lessons.find((item) => item.id === lesson.id);
  assert.deepEqual(savedLesson.materialGroups.map((group) => group.title), ['素材1', '素材2', '素材3'], '素材组顺序应保留');
  assert.deepEqual(savedLesson.materialGroups[0].materials.map((material) => material.title), ['参考图', '竖版主图'], '素材与框体应在同一组内按顺序混排');
  assert.deepEqual(savedLesson.generationBoxes.map((box) => box.title), ['竖版主图', '横版插图', '开场短片', '结尾短片'], '框体摊平后的顺序 = 素材顺序');
  // 首次保存的素材是新插入的（id 由服务端生成）；后面要验证的是「再保存 id 不变」。
  const savedGroups = savedLesson.materialGroups.map((group) => ({ title: group.title, materials: group.materials.map((material) => ({ id: material.id, title: material.title, description: material.description, materialType: material.materialType, assetUrl: material.assetUrl, snapshot: material.snapshot })) }));
  const savedMaterialIds = savedLesson.materialGroups[0].materials.map((material) => material.id);
  const savedBoxIds = savedLesson.generationBoxes.map((box) => box.id);

  // 2) 非法取值当场 400（逐框体严格校验，不再静默丢弃）
  const badBox = await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: {
      capabilities: ['image', 'video'],
      materialGroups: [{ title: '素材1', materials: [{ title: '坏框体', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'IMAGE', aspectRatio: '16-9', resolution: '1k' } } }] }],
    },
  });
  assert.equal(badBox.status, 400, `非法比例应被拒，实际 ${badBox.status}`);
  assert.equal(badBox.data?.error?.code, 'INVALID_GENERATION_CONFIG', '错误码应为 INVALID_GENERATION_CONFIG');
  assert.ok(String(badBox.data.error.message).includes('16-9'), '错误信息应指出具体框体与非法值');

  // 3) 再存一次：素材 id 必须保持不变（学生画布节点和生成记录都按 id 指回来）
  const againSave = await api(`/api/admin/course-lessons/${lesson.id}`, {
    method: 'PUT', token: rootToken,
    body: { capabilities: ['text', 'image', 'video'], classroomConfig: { version: 3 }, materialGroups: savedGroups },
  });
  assert.equal(againSave.status, 200, '二次保存应成功');
  const againLesson = againSave.data.lessons.find((item) => item.id === lesson.id);
  assert.deepEqual(againLesson.materialGroups[0].materials.map((material) => material.id), savedMaterialIds, '二次保存后素材 id 不应变化');
  assert.deepEqual(againLesson.generationBoxes.map((box) => box.id), savedBoxIds, '二次保存后框体 id 不应变化');

  // 4) 学生项目按素材顺序下发框体（含预填提示词与预置素材）
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lesson.id, title: 'P28 框体即素材' } });
  assert.equal(project.status, 200, `项目创建失败: ${JSON.stringify(project.data)}`);
  const boxes = project.data.generationBoxes || [];
  assert.deepEqual(boxes.map((box) => box.title), ['竖版主图', '横版插图', '开场短片', '结尾短片'], '学生端应按素材顺序拿到 4 个框体');
  assert.deepEqual(boxes.map((box) => box.id), savedBoxIds, '学生端框体 id 应与管理端一致');
  assert.equal(boxes[0].prompt, '画一只会飞的小猫', '框体预填提示词应下发');
  assert.equal(boxes[3].assetUrl, PRESET_FIRST_FRAME, '框体预置素材应下发');
  assert.equal(boxes[2].durationSeconds, 5, '开场短片应为 5 秒');
  assert.equal(boxes[3].durationSeconds, 10, '结尾短片应为 10 秒');

  // 5) 每框体取自己的参数：两个图片框比例/清晰度互不影响，两个视频框时长互不影响
  const { generationOptionsFor, providerSelectionForModality } = await import('../apps/server/src/routes/aiGeneration.js');
  const context = { lesson: { generationBoxes: boxes } };
  const policy = { provider: 'local-mock', channels: [], modalityChannels: {} };
  // 服务端按「框体自己的模型」选渠道（没有渠道时回落全局默认 + 框体模型），这里照做。
  const optionsFor = (box) => generationOptionsFor({
    context, modality: box.modality, policy, box,
    selection: providerSelectionForModality(policy, box.modality, box.model || ''),
  });
  const vertical = optionsFor(boxes[0]);
  const wide = optionsFor(boxes[1]);
  assert.equal(vertical.aspectRatio, '9:16', `素材1 应为 9:16，实际 ${vertical.aspectRatio}`);
  assert.equal(vertical.resolution, '2k', `素材1 应为 2k，实际 ${vertical.resolution}`);
  assert.equal(wide.aspectRatio, '16:9', `素材2 应为 16:9，实际 ${wide.aspectRatio}`);
  assert.equal(wide.resolution, '1k', `素材2 应为 1k，实际 ${wide.resolution}`);
  const shortClip = optionsFor(boxes[2]);
  const longClip = optionsFor(boxes[3]);
  assert.equal(shortClip.durationSeconds, 5, `先 5 秒，实际 ${shortClip.durationSeconds}`);
  assert.equal(longClip.durationSeconds, 10, `再 10 秒，实际 ${longClip.durationSeconds}`);
  // 框体挂了预置素材且模型要首帧（i2v）时，直接用预置素材当首帧
  assert.ok(longClip.inputModes.includes('FIRST_FRAME'), `hailuo-h3-i2v 应支持首帧输入，实际 ${JSON.stringify(longClip.inputModes)}`);
  assert.ok(!longClip.inputModes.includes('TEXT'), 'hailuo-h3-i2v 不支持纯文生，应要求首帧');
  assert.ok(String(longClip.firstFrameUrl || '').includes('/api/public/file-assets/asset-seed/download'), `预置素材应升级成公开绝对地址当首帧，实际 ${longClip.firstFrameUrl}`);

  // 6) 逐个框体生成：素材1 的框体成功 → 再来被拒 → 素材2 的框体仍可生成
  const first = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: savedBoxIds[0], modality: 'IMAGE', prompt: '画一只会飞的小猫' } });
  assert.equal(first.status, 200, `竖版主图生成入队失败: ${JSON.stringify(first.data)}`);
  const firstJob = await waitForJob(student, first.data.job.id);
  assert.equal(firstJob.status, 'SUCCEEDED', `竖版主图应生成成功，实际 ${firstJob.status}（${firstJob.errorCode || ''}）`);
  assert.equal(firstJob.boxId, savedBoxIds[0], '任务应记录来源框体（素材 id）');

  const reused = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: savedBoxIds[0], modality: 'IMAGE', prompt: '再画一次' } });
  assert.equal(reused.status, 403, `同一框体不能生成第二次，实际 ${reused.status}`);
  assert.equal(reused.data?.error?.code, 'GENERATION_BOX_USED', `错误码应为 GENERATION_BOX_USED，实际 ${reused.data?.error?.code}`);

  const second = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: savedBoxIds[1], modality: 'IMAGE', prompt: '画一座云上的城堡' } });
  assert.equal(second.status, 200, `横版插图应能独立生成: ${JSON.stringify(second.data)}`);
  const secondJob = await waitForJob(student, second.data.job.id);
  assert.equal(secondJob.status, 'SUCCEEDED', `横版插图应生成成功，实际 ${secondJob.status}`);

  // 7) 未知框体 / 本课配了框体却没带框体 id / 类型不符，都要在入队前被拒
  const unknown = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: 'box-not-exist', modality: 'IMAGE', prompt: '未知框体' } });
  assert.equal(unknown.status, 400, `未知框体应被拒，实际 ${unknown.status}`);
  assert.equal(unknown.data?.error?.code, 'GENERATION_BOX_NOT_FOUND', `错误码应为 GENERATION_BOX_NOT_FOUND，实际 ${unknown.data?.error?.code}`);
  const missing = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, modality: 'IMAGE', prompt: '没带框体' } });
  assert.equal(missing.status, 403, `缺框体 id 应被拒，实际 ${missing.status}`);
  assert.equal(missing.data?.error?.code, 'GENERATION_BOX_REQUIRED', `错误码应为 GENERATION_BOX_REQUIRED，实际 ${missing.data?.error?.code}`);
  const mismatch = await api('/api/ai/generations/async', { method: 'POST', token: student, body: { projectId: project.data.id, boxId: savedBoxIds[1], modality: 'VIDEO', prompt: '类型不符' } });
  assert.equal(mismatch.status, 400, `框体类型不符应被拒，实际 ${mismatch.status}`);
  assert.equal(mismatch.data?.error?.code, 'GENERATION_BOX_MODALITY_MISMATCH', `错误码应为 GENERATION_BOX_MODALITY_MISMATCH，实际 ${mismatch.data?.error?.code}`);

  console.log(JSON.stringify({
    name: 'generation-boxes', pass: true,
    materialOrder: savedLesson.materialGroups.map((group) => `${group.title}[${group.materials.map((material) => material.title).join(' → ')}]`).join(' | '),
    flattenedBoxOrder: savedLesson.generationBoxes.map((box) => box.id),
    perBoxOptions: {
      '竖版主图': { aspectRatio: vertical.aspectRatio, resolution: vertical.resolution },
      '横版插图': { aspectRatio: wide.aspectRatio, resolution: wide.resolution },
      '开场短片': { durationSeconds: shortClip.durationSeconds },
      '结尾短片': { durationSeconds: longClip.durationSeconds, firstFrame: longClip.firstFrameUrl ? 'preset' : 'none' },
    },
    guards: { reused: reused.data?.error?.code, unknown: unknown.data?.error?.code, missing: missing.data?.error?.code, mismatch: mismatch.data?.error?.code },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
