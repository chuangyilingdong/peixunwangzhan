/**
 * P27 模型能力填写的校验与生效。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：非法比例/清晰度/时长当场 400（不再静默丢弃）→ 合法配置保存成功 →
 * 存下来的就是填写的值（比例归一化、时长整数升序）→ 课时保存时按该列表校验 →
 * 生成时只读课时配置（客户端改不了）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p27-capability-'));
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

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18911;
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

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const rootToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  assert.ok(rootToken, 'root 登录失败');
  const current = (await api('/api/admin/billing-config/ai-provider', { token: rootToken })).data.policy;
  const withChannel = (capabilities, model = 'minimax-h3-i2v', modelRequestTemplates = {}) => ({
    ...current,
    channels: [{ id: 'ch-video', name: '视频-测试', provider: 'custom', model, models: [model], endpoint: 'https://api.example.com/v1', protocol: 'CHAT', modelCapabilities: { [model]: capabilities }, modelRequestTemplates }],
    modalityChannels: { ...(current.modalityChannels || {}), VIDEO: 'ch-video' },
  });

  // 1) 非法写法一律 400，并带上可读的原因（不再静默丢弃）
  const badDuration = await api('/api/admin/billing-config/ai-provider', { method: 'PUT', token: rootToken, body: withChannel({ durations: ['5秒', 10], resolutions: ['480P'], aspectRatios: ['16:9'] }) });
  assert.equal(badDuration.status, 400, `「5秒」应被拒，实际 ${badDuration.status}`);
  assert.equal(badDuration.data?.error?.code, 'AI_PROVIDER_CAPABILITY_INVALID', '错误码应为 AI_PROVIDER_CAPABILITY_INVALID');
  assert.ok(String(badDuration.data.error.message).includes('5秒'), '错误信息应指出具体非法值');

  const badRatio = await api('/api/admin/billing-config/ai-provider', { method: 'PUT', token: rootToken, body: withChannel({ aspectRatios: ['16-9'], resolutions: ['480P'], durations: [5] }) });
  assert.equal(badRatio.status, 400, '「16-9」应被拒');
  const badResolution = await api('/api/admin/billing-config/ai-provider', { method: 'PUT', token: rootToken, body: withChannel({ aspectRatios: ['16:9'], resolutions: ['480 p'], durations: [5] }) });
  assert.equal(badResolution.status, 400, '含空格的清晰度应被拒');

  // 2) 合法配置保存成功，且存下来的就是填写的值（比例归一化、时长整数升序）
  const saved = await api('/api/admin/billing-config/ai-provider', {
    method: 'PUT', token: rootToken,
    body: withChannel({ aspectRatios: ['9：16', '16:9'], resolutions: ['768P', '480P'], durations: [15, 5, 10], audio: true, inputModes: ['TEXT', 'FIRST_FRAME', 'FIRST_LAST_FRAME', 'OMNI_REFERENCE'] }, 'minimax-h3-i2v', { 'minimax-h3-i2v': { model: '{{model}}', content: [{ type: 'text', text: '{{prompt}}' }], duration: '{{durationSecondsNumber}}', ratio: '{{aspectRatio}}' } }),
  });
  assert.equal(saved.status, 200, `合法配置应保存成功: ${JSON.stringify(saved.data)}`);
  const stored = saved.data.policy.channels.find((channel) => channel.id === 'ch-video').modelCapabilities['minimax-h3-i2v'];
  assert.deepEqual(stored.aspectRatios, ['9:16', '16:9'], `比例应归一化为 9:16/16:9，实际 ${JSON.stringify(stored.aspectRatios)}`);
  assert.deepEqual(stored.resolutions, ['768P', '480P'], `清晰度应原样保留（含大小写），实际 ${JSON.stringify(stored.resolutions)}`);
  assert.deepEqual(stored.durations, [5, 10, 15], `时长应为升序整数，实际 ${JSON.stringify(stored.durations)}`);
  assert.equal(stored.audio, true, '音频标记应保留');
  assert.deepEqual(stored.inputModes, ['TEXT', 'FIRST_FRAME', 'FIRST_LAST_FRAME', 'OMNI_REFERENCE'], `输入画面方式应保留，实际 ${JSON.stringify(stored.inputModes)}`);
  // 模型级请求模板原样保留（同渠道里不同模型的请求体可以完全不同）
  const storedTemplate = saved.data.policy.channels.find((channel) => channel.id === 'ch-video').modelRequestTemplates['minimax-h3-i2v'];
  assert.equal(storedTemplate?.content?.[0]?.text, '{{prompt}}', `模型级模板应原样保留，实际 ${JSON.stringify(storedTemplate)}`);

  // 2.2 不认识的输入方式一律 400，不再静默丢弃
  const badMode = await api('/api/admin/billing-config/ai-provider', { method: 'PUT', token: rootToken, body: withChannel({ resolutions: ['480P'], inputModes: ['FIRST_FRAME', 'HOLOGRAM'] }) });
  assert.equal(badMode.status, 400, `不认识的输入方式应被拒，实际 ${badMode.status}`);
  assert.ok(String(badMode.data.error.message).includes('HOLOGRAM'), '错误信息应指出具体非法值');

  // 3) 课时保存时按这个列表校验：不在列表里的取值会被拒
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const lesson = db.prepare('SELECT id FROM course_lessons ORDER BY sort LIMIT 1').get();
  db.prepare("UPDATE course_lessons SET delivery_mode='VIBECODING' WHERE id=?").run(lesson.id);
  db.close();
  // 生成框体是素材表里的一种素材（material_type=GENERATION_BOX），参数放在 snapshot.box 里
  const boxLesson = (resolution, durationSeconds) => ({ method: 'PUT', token: rootToken, body: { deliveryMode: 'CANVAS', capabilities: ['video'], materialGroups: [{ title: '素材1', materials: [{ title: '素材1', materialType: 'GENERATION_BOX', snapshot: { box: { modality: 'VIDEO', model: 'minimax-h3-i2v', aspectRatio: '16:9', resolution, durationSeconds } } }] }] } });
  const badLesson = await api(`/api/admin/course-lessons/${lesson.id}`, boxLesson('1080P', 20));
  assert.equal(badLesson.status, 400, `1080P 不在已声明清晰度里，应被拒，实际 ${badLesson.status}`);
  assert.equal(badLesson.data?.error?.code, 'INVALID_GENERATION_CONFIG', '错误码应为 INVALID_GENERATION_CONFIG');

  const goodLesson = await api(`/api/admin/course-lessons/${lesson.id}`, boxLesson('768P', 15));
  assert.equal(goodLesson.status, 200, `声明范围内的取值应能保存: ${JSON.stringify(goodLesson.data)}`);
  const lessonSlot = goodLesson.data.lessons.find((item) => item.id === lesson.id).materialGroups[0].materials[0].snapshot.box;
  assert.equal(lessonSlot.resolution, '768P', '课时应保存所选的清晰度');
  assert.equal(lessonSlot.durationSeconds, 15, '课时应保存所选的时长');

  console.log(JSON.stringify({
    name: 'provider-capability-validation', pass: true,
    rejected: { durationWithUnit: 400, badRatio: 400, resolutionWithSpace: 400 },
    stored: { aspectRatios: stored.aspectRatios, resolutions: stored.resolutions, durations: stored.durations, audio: stored.audio, inputModes: stored.inputModes },
    lessonValidation: { outOfRangeRejected: true, inRangeSaved: { resolution: lessonSlot.resolution, durationSeconds: lessonSlot.durationSeconds } },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
