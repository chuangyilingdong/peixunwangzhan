/**
 * P207 RunningHub 异步适配器守卫（2026-11-04）。
 *
 * RunningHub 不是 OpenAI 兼容：提交 → taskId → POST /query → results[].url。
 * 这一道钉住：
 *   ① 图片：无参考走文生图路径、有参考走图生图路径，body 字段正确；
 *   ② 视频主/备、音乐：各自路径与请求体；视频备用不带 generateAudio；
 *   ③ taskId 驼峰解析、onSubmitted 回调、results[].url + outputType → MIME；
 *   ④ 401/429/FAILED/超时的错误码与 safeToRetry；
 *   ⑤ 渠道 selection：RunningHub 用渠道 family，课时旧模型 ID 不覆盖；
 *   ⑥ 私有/data: 参考素材的处理（相对地址补公网、data: 明确拒绝）。
 *
 * 跑法：node scripts/p207-runninghub.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p207-runninghub-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_SECRET_FILE = path.join(temp, 'secrets.json');
process.env.PUBLIC_SITE_URL = 'https://aicyld.com';

const { runningHubProvider } = await import('../apps/server/src/services/runningHubProvider.js');
const { providerSelectionForModality } = await import('../apps/server/src/routes/aiGeneration.js');
const { generationProviderInfo, getGenerationProvider } = await import('../apps/server/src/services/generationProvider.js');
const { RUNNINGHUB_FAMILIES, runningHubFamilyModality, runningHubModelCatalog } = await import('../apps/server/src/services/runningHubProvider.js');

const PORT = 18994;
const BASE = `http://127.0.0.1:${PORT}/openapi/v2`;
const submissions = new Map();
let seq = 0;
const state = { submitStatus: 200, queryStatus: 'SUCCESS' };

const json = (res, status, payload) => {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    if (req.url === '/openapi/v2/query') {
      if (state.queryStatus === 'FAILED') return json(res, 200, { status: 'FAILED', errorCode: '1000', errorMessage: 'mock failed' });
      if (state.queryStatus === 'RUNNING') return json(res, 200, { status: 'RUNNING', results: null });
      const sub = submissions.get(String(body.taskId)) || { outputType: 'jpg' };
      return json(res, 200, {
        taskId: body.taskId,
        status: 'SUCCESS',
        results: [{ url: `http://127.0.0.1:${PORT}/out.${sub.outputType}`, outputType: sub.outputType }],
      });
    }
    if (state.submitStatus !== 200) return json(res, state.submitStatus, { errorMessage: 'mock submit error' });
    const taskId = `task_${++seq}`;
    const outputType = req.url.includes('/music-') ? 'mp3'
      : (req.url.includes('video') || req.url.includes('/multimodal')) ? 'mp4' : 'jpg';
    submissions.set(taskId, { path: req.url, body, outputType });
    return json(res, 200, { taskId });
  });
});
await new Promise((resolve) => mock.listen(PORT, '127.0.0.1', resolve));

const checks = [];
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, message: error?.message || String(error) }); }
};
const make = (family, extra = {}) => runningHubProvider({
  name: 'runninghub', model: family, family, endpoint: BASE, apiKey: 'test-key',
  timeoutMs: 5000, maxWaitMs: 5000, pollIntervalMs: 50, ...extra,
});
const lastSubmission = () => [...submissions.values()].at(-1);

await check('图片·文生图：无参考 → /rhart-image-g-2.5/sunburst/text-to-image', async () => {
  const provider = make('rhart-image-g-2.5');
  let submitted = '';
  const result = await provider.generate({
    modality: 'IMAGE', prompt: '一只猫', title: 'P207',
    options: { aspectRatio: '16:9', resolution: '1k' },
    onSubmitted: (taskId) => { submitted = taskId; },
  });
  const sub = lastSubmission();
  assert.equal(sub.path, '/openapi/v2/rhart-image-g-2.5/sunburst/text-to-image');
  assert.equal(sub.body.prompt, '一只猫');
  assert.equal(sub.body.aspectRatio, '16:9');
  assert.equal(sub.body.resolution, '1k');
  assert.equal(sub.body.imageUrls, undefined);
  assert.match(submitted, /^task_/);
  assert.equal(result.assets[0].mimeType, 'image/jpeg');
  assert.match(result.assets[0].assetUrl, /\/out\.jpg$/);
  assert.equal(result.assets[0].metadata.taskId, submitted);
});

await check('图片·图生图：有参考 → /rhart-image-g-2.5/flare/image-to-image + imageUrls', async () => {
  const provider = make('rhart-image-g-2.5');
  await provider.generate({
    modality: 'IMAGE', prompt: '改成夜景',
    options: { aspectRatio: '1:1', resolution: '2k', referenceAssets: [{ type: 'IMAGE', url: 'https://aicyld.com/ref.png' }] },
  });
  const sub = lastSubmission();
  assert.equal(sub.path, '/openapi/v2/rhart-image-g-2.5/flare/image-to-image');
  assert.deepEqual(sub.body.imageUrls, ['https://aicyld.com/ref.png']);
});

await check('图片·备用 family：/rhart-image-g-2-official/*', async () => {
  const provider = make('rhart-image-g-2-official');
  await provider.generate({ modality: 'IMAGE', prompt: 'x', options: {} });
  assert.equal(lastSubmission().path, '/openapi/v2/rhart-image-g-2-official/text-to-image');
  await provider.generate({ modality: 'IMAGE', prompt: 'x', options: { referenceAssets: [{ type: 'IMAGE', url: 'https://aicyld.com/r.png' }] } });
  assert.equal(lastSubmission().path, '/openapi/v2/rhart-image-g-2-official/image-to-image');
});

await check('视频·主：seedance 路径 + 参考/时长/比例/generateAudio', async () => {
  const provider = make('bytedance/seedance-2.0-global-fast');
  const result = await provider.generate({
    modality: 'VIDEO', prompt: '小猫奔跑',
    options: {
      durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', audio: true,
      referenceAssets: [
        { type: 'IMAGE', url: 'https://aicyld.com/a.png' },
        { type: 'VIDEO', url: 'https://aicyld.com/b.mp4' },
        { type: 'AUDIO', url: 'https://aicyld.com/c.mp3' },
      ],
    },
  });
  const sub = lastSubmission();
  assert.equal(sub.path, '/openapi/v2/bytedance/seedance-2.0-global-fast/multimodal-video');
  assert.equal(sub.body.duration, 5);
  assert.equal(sub.body.resolution, '720p');
  assert.equal(sub.body.ratio, '16:9');
  assert.equal(sub.body.generateAudio, true);
  assert.deepEqual(sub.body.imageUrls, ['https://aicyld.com/a.png']);
  assert.deepEqual(sub.body.videoUrls, ['https://aicyld.com/b.mp4']);
  assert.deepEqual(sub.body.audioUrls, ['https://aicyld.com/c.mp3']);
  assert.equal(result.assets[0].mimeType, 'video/mp4');
});

await check('视频·备：hailuo 路径；不带 generateAudio', async () => {
  const provider = make('minimax/hailuo-h3');
  await provider.generate({
    modality: 'VIDEO', prompt: 'x',
    options: { durationSeconds: 5, resolution: '2K', aspectRatio: 'auto', audio: true, referenceAssets: [{ type: 'IMAGE', url: 'https://aicyld.com/a.png' }] },
  });
  const sub = lastSubmission();
  assert.equal(sub.path, '/openapi/v2/minimax/hailuo-h3/multimodal-to-video');
  assert.equal(sub.body.ratio, 'adaptive');
  assert.equal(sub.body.generateAudio, undefined);
});

await check('音乐：/minimax/music-2.6 + 歌词模式', async () => {
  const provider = make('minimax/music-2.6');
  const result = await provider.generate({
    modality: 'MUSIC', prompt: '小小少年慢慢走',
    options: { mode: 'LYRICS', defaultStyle: '轻快儿童音乐' },
  });
  const sub = lastSubmission();
  assert.equal(sub.path, '/openapi/v2/minimax/music-2.6');
  assert.equal(sub.body.prompt, '轻快儿童音乐');
  assert.equal(sub.body.lyrics, '小小少年慢慢走');
  assert.equal(sub.body.format, 'mp3');
  assert.equal(sub.body.isInstrumental, false);
  assert.equal(sub.body.lyricsOptimizer, false);
  assert.equal(result.assets[0].mimeType, 'audio/mpeg');
});

await check('音乐·无歌词 → isInstrumental=true 且不带 lyrics（空串会被上游判「模型响应异常」）', async () => {
  const provider = make('minimax/music-2.6');
  await provider.generate({ modality: 'MUSIC', prompt: '轻快的儿童电子音乐', options: {} });
  const sub = lastSubmission();
  assert.equal(sub.body.isInstrumental, true);
  assert.equal('lyrics' in sub.body, false);
  assert.equal('lyricsOptimizer' in sub.body, false);
  assert.equal(sub.body.prompt, '轻快的儿童电子音乐');
});

await check('参考素材：相对地址补公网；data: 明确拒绝', async () => {
  const provider = make('rhart-image-g-2.5');
  await provider.generate({
    modality: 'IMAGE', prompt: 'x',
    options: { referenceAssets: [{ type: 'IMAGE', url: '/api/student/file-assets/f1/download' }] },
  });
  assert.deepEqual(lastSubmission().body.imageUrls, ['https://aicyld.com/api/student/file-assets/f1/download']);
  await assert.rejects(
    () => provider.generate({ modality: 'IMAGE', prompt: 'x', options: { referenceAssets: [{ type: 'IMAGE', url: 'data:image/png;base64,AAAA' }] } }),
    (error) => error.code === 'GENERATION_PROVIDER_CONFIG_INVALID' && /data:/.test(error.message),
  );
});

await check('错误：401 → AUTH_FAILED（可切备用）', async () => {
  state.submitStatus = 401;
  try {
    await assert.rejects(() => make('rhart-image-g-2.5').generate({ modality: 'IMAGE', prompt: 'x', options: {} }), (error) => error.code === 'GENERATION_PROVIDER_AUTH_FAILED' && error.safeToRetry === true);
  } finally { state.submitStatus = 200; }
});
await check('错误：429 → RATE_LIMITED（可切备用）', async () => {
  state.submitStatus = 429;
  try {
    await assert.rejects(() => make('rhart-image-g-2.5').generate({ modality: 'IMAGE', prompt: 'x', options: {} }), (error) => error.code === 'GENERATION_PROVIDER_RATE_LIMITED' && error.safeToRetry === true);
  } finally { state.submitStatus = 200; }
});
await check('错误：任务 FAILED → UPSTREAM', async () => {
  state.queryStatus = 'FAILED';
  try {
    await assert.rejects(() => make('rhart-image-g-2.5').generate({ modality: 'IMAGE', prompt: 'x', options: {} }), (error) => error.code === 'GENERATION_PROVIDER_UPSTREAM_ERROR' && /mock failed/.test(error.message));
  } finally { state.queryStatus = 'SUCCESS'; }
});
await check('错误：一直 RUNNING → TIMEOUT（带 taskId）', async () => {
  state.queryStatus = 'RUNNING';
  try {
    await assert.rejects(
      () => make('rhart-image-g-2.5', { maxWaitMs: 400 }).generate({ modality: 'IMAGE', prompt: 'x', options: {} }),
      (error) => error.code === 'GENERATION_PROVIDER_TIMEOUT' && /task_/.test(error.message),
    );
  } finally { state.queryStatus = 'SUCCESS'; }
});

await check('渠道 selection：RunningHub 用渠道 family，课时旧模型不覆盖；备用 family 正确', async () => {
  const policy = {
    provider: 'custom', model: '', endpoint: '',
    channels: [
      { id: 'rh-main', name: 'RH 主', provider: 'runninghub', endpoint: BASE, model: 'rhart-image-g-2.5', models: ['rhart-image-g-2.5'], requestPaths: {} },
      { id: 'rh-backup', name: 'RH 备', provider: 'runninghub', endpoint: BASE, model: 'rhart-image-g-2-official', models: ['rhart-image-g-2-official'], requestPaths: {} },
    ],
    modalityChannels: { IMAGE: 'rh-main' },
    modalityBackupChannels: { IMAGE: 'rh-backup' },
    modelRoutes: [],
  };
  const selection = providerSelectionForModality(policy, 'IMAGE', 'zhenzhen-image-g-v2.5-lowprice');
  assert.equal(selection.model, 'rhart-image-g-2.5');
  assert.equal(selection.channelModel, 'rhart-image-g-2.5');
  assert.equal(selection.backup.model, 'rhart-image-g-2-official');
  assert.equal(selection.backup.channelModel, 'rhart-image-g-2-official');
  selection.apiKey = 'test-key';
  const provider = getGenerationProvider(selection);
  assert.equal(provider.name, 'runninghub');
  assert.ok(provider.capabilities.includes('IMAGE'));
  assert.ok(!provider.capabilities.includes('TEXT'));
  assert.equal(generationProviderInfo(selection).adapterAvailable, true);
});

await check('后台「读取模型」：RunningHub 列本地 family 清单（上游没有 /models）', async () => {
  // 上游对 GET /openapi/v2/models 一律回 200 + PARAMS_INVALID，所以后台只能列适配器这张表。
  const all = runningHubModelCatalog();
  assert.deepEqual(all.map((item) => item.id).sort(), Object.keys(RUNNINGHUB_FAMILIES).sort());
  assert.ok(all.every((item) => item.ownedBy === 'runninghub' && item.capabilities === null));
  assert.ok(all.every((item) => item.displayName.includes(item.id) && /（.+）/.test(item.displayName)));
  assert.deepEqual(runningHubModelCatalog('IMAGE').map((item) => item.id).sort(), ['rhart-image-g-2-official', 'rhart-image-g-2.5']);
  assert.deepEqual(runningHubModelCatalog('VIDEO').map((item) => item.id).sort(), ['bytedance/seedance-2.0-global-fast', 'minimax/hailuo-h3']);
  assert.deepEqual(runningHubModelCatalog('MUSIC').map((item) => item.id), ['minimax/music-2.6']);
  assert.equal(runningHubModelCatalog('TEXT').length, 0);
});

await check('family → 模态：未路由渠道的「试一次」不再落回 TEXT', async () => {
  assert.equal(runningHubFamilyModality('rhart-image-g-2.5'), 'IMAGE');
  assert.equal(runningHubFamilyModality('bytedance/seedance-2.0-global-fast'), 'VIDEO');
  assert.equal(runningHubFamilyModality('minimax/music-2.6'), 'MUSIC');
  assert.equal(runningHubFamilyModality('not-a-family'), '');
  assert.equal(runningHubFamilyModality(''), '');
});

mock.close();
const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.ok ? '' : `\n   ${item.message}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
