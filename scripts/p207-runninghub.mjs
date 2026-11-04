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
const PORT = 18994;
const BASE = `http://127.0.0.1:${PORT}/openapi/v2`;
// 自站素材镜像会"先 GET 源图再上传"，所以把站点 origin 指到本地 mock：
// 测试里的 https://<SELF>/a.png 既算"我们自己的素材"，mock 也真能吐出字节。
const SELF = `http://127.0.0.1:${PORT}`;
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_SECRET_FILE = path.join(temp, 'secrets.json');
process.env.PUBLIC_SITE_URL = SELF;

const { runningHubProvider, runningHubSiteCurrency, reportedCostFromUsage } = await import('../apps/server/src/services/runningHubProvider.js');
const { providerSelectionForModality, imageModeForGeneration } = await import('../apps/server/src/routes/aiGeneration.js');
const { generationProviderInfo, getGenerationProvider, adaptOptionsToCandidate } = await import('../apps/server/src/services/generationProvider.js');
const { RUNNINGHUB_FAMILIES, runningHubFamilyModality, runningHubModelCatalog } = await import('../apps/server/src/services/runningHubProvider.js');
const submissions = new Map();
let seq = 0;
let uploadSeq = 0;
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
    // 自站素材（mock 充当"我们的站点"）：镜像会先 GET 它再上传，这里吐一点字节即可
    if (req.method === 'GET') {
      const ext = String(req.url || '').split('?')[0].split('.').pop().toLowerCase();
      const type = ext === 'mp4' ? 'video/mp4' : ext === 'mp3' ? 'audio/mpeg' : 'image/png';
      const bytes = ext === 'mp4' ? Buffer.from('mock-mp4-bytes') : ext === 'mp3' ? Buffer.from('mock-mp3-bytes') : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      res.writeHead(200, { 'content-type': type, 'content-length': bytes.length });
      res.end(bytes);
      return;
    }
    // 自站素材镜像：RunningHub 的素材暂存接口（真实响应是 data.download_url）
    if (req.url === '/openapi/v2/media/upload/binary') {
      return json(res, 200, { code: 0, msg: 'success', data: { type: 'image', download_url: `http://127.0.0.1:${PORT}/rh-uploaded/${++uploadSeq}.png` } });
    }
    if (req.url === '/openapi/v2/query') {
      if (state.queryStatus === 'FAILED') return json(res, 200, { status: 'FAILED', errorCode: '1000', errorMessage: 'mock failed' });
      if (state.queryStatus === 'RUNNING') return json(res, 200, { status: 'RUNNING', results: null });
      const sub = submissions.get(String(body.taskId)) || { outputType: 'jpg' };
      const usageUsd = sub.outputType === 'mp4' ? '0.4' : sub.outputType === 'mp3' ? '0.12' : '0.05';
      return json(res, 200, {
        taskId: body.taskId,
        status: 'SUCCESS',
        usage: {
          consumeMoney: null,
          consumeCoins: null,
          thirdPartyConsumeMoney: usageUsd,
          billingSeconds: sub.outputType === 'mp4' ? '5' : null,
        },
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
  assert.equal(sub.body.quality, undefined);
  assert.match(submitted, /^task_/);
  assert.equal(result.assets[0].mimeType, 'image/jpeg');
  assert.match(result.assets[0].assetUrl, /\/out\.jpg$/);
  assert.equal(result.assets[0].metadata.taskId, submitted);
});

await check('图片·图生图：有参考 → /rhart-image-g-2.5/flare/image-to-image + imageUrls', async () => {
  const provider = make('rhart-image-g-2.5');
  await provider.generate({
    modality: 'IMAGE', prompt: '改成夜景',
    options: { aspectRatio: '1:1', resolution: '2k', referenceAssets: [{ type: 'IMAGE', url: `${SELF}/ref.png` }] },
  });
  const sub = lastSubmission();
  assert.equal(sub.path, '/openapi/v2/rhart-image-g-2.5/flare/image-to-image');
  // 自站素材先传到上游暂存接口，body 里是 RunningHub 自己的 download_url
  assert.match(sub.body.imageUrls[0], /\/rh-uploaded\/\d+\.png$/);
});

await check('图片·备用 family：/rhart-image-g-2-official/*', async () => {
  const provider = make('rhart-image-g-2-official');
  await provider.generate({ modality: 'IMAGE', prompt: 'x', options: {} });
  assert.equal(lastSubmission().path, '/openapi/v2/rhart-image-g-2-official/text-to-image');
  // 官方 family 强制 quality（low/medium/high），不给自己就 1007「没有返回 taskId」。
  assert.equal(lastSubmission().body.quality, 'high');
  await provider.generate({ modality: 'IMAGE', prompt: 'x', options: { referenceAssets: [{ type: 'IMAGE', url: `${SELF}/r.png` }] } });
  assert.equal(lastSubmission().path, '/openapi/v2/rhart-image-g-2-official/image-to-image');
});

await check('图片·文生图主 family：g-2-official-t2i 也补 quality', async () => {
  const provider = make('rhart-image-g-2-official-t2i');
  await provider.generate({ modality: 'IMAGE', prompt: 'x', options: {} });
  assert.equal(lastSubmission().path, '/openapi/v2/rhart-image-g-2-official/text-to-image');
  assert.equal(lastSubmission().body.quality, 'high', '带 -t2i 后缀也要补 quality');
});

await check('图片·图生图主 family：g-2-official-i2i 补 quality 且走 image-to-image', async () => {
  const provider = make('rhart-image-g-2-official-i2i');
  await provider.generate({ modality: 'IMAGE', prompt: 'x', options: { referenceAssets: [{ type: 'IMAGE', url: `${SELF}/r.png` }] } });
  assert.equal(lastSubmission().path, '/openapi/v2/rhart-image-g-2-official/image-to-image');
  assert.equal(lastSubmission().body.quality, 'high');
});

await check('视频·主：seedance 路径 + 参考/时长/比例/generateAudio', async () => {
  const provider = make('bytedance/seedance-2.0-global-fast');
  const result = await provider.generate({
    modality: 'VIDEO', prompt: '小猫奔跑',
    options: {
      durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', audio: true,
      referenceAssets: [
        { type: 'IMAGE', url: `${SELF}/a.png` },
        { type: 'VIDEO', url: `${SELF}/b.mp4` },
        { type: 'AUDIO', url: `${SELF}/c.mp3` },
      ],
    },
  });
  const sub = lastSubmission();
  assert.equal(sub.path, '/openapi/v2/bytedance/seedance-2.0-global-fast/multimodal-video');
  assert.equal(sub.body.duration, 5);
  assert.equal(sub.body.resolution, '720p');
  assert.equal(sub.body.ratio, '16:9');
  assert.equal(sub.body.generateAudio, true);
  assert.match(sub.body.imageUrls[0], /\/rh-uploaded\/\d+\.png$/);
  assert.match(sub.body.videoUrls[0], /\/rh-uploaded\/\d+\.png$/);
  assert.match(sub.body.audioUrls[0], /\/rh-uploaded\/\d+\.png$/);
  assert.equal(result.assets[0].mimeType, 'video/mp4');
});

await check('视频·备：hailuo 路径；不带 generateAudio', async () => {
  const provider = make('minimax/hailuo-h3');
  await provider.generate({
    modality: 'VIDEO', prompt: 'x',
    options: { durationSeconds: 5, resolution: '2K', aspectRatio: 'auto', audio: true, referenceAssets: [{ type: 'IMAGE', url: `${SELF}/a.png` }] },
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

await check('参考素材：外站 URL 原样发送；data: 明确拒绝', async () => {
  const provider = make('rhart-image-g-2.5');
  const external = 'https://cdn.example.com/ref.png';
  await provider.generate({ modality: 'IMAGE', prompt: 'x', options: { referenceAssets: [{ type: 'IMAGE', url: external }] } });
  assert.deepEqual(lastSubmission().body.imageUrls, [external]);
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
  // 旧的双路径 family 只做兼容兜底，不在清单里展示。
  const legacy = new Set(['rhart-image-g-2.5', 'rhart-image-g-2-official']);
  const all = runningHubModelCatalog();
  assert.deepEqual(all.map((item) => item.id).sort(), Object.keys(RUNNINGHUB_FAMILIES).filter((id) => !legacy.has(id)).sort());
  assert.ok(all.every((item) => item.ownedBy === 'runninghub' && item.capabilities === null));
  assert.ok(all.every((item) => item.displayName.includes(item.id) && /（.+）/.test(item.displayName)));
  assert.deepEqual(runningHubModelCatalog('IMAGE').map((item) => item.id).sort(), [
    'rhart-image-g-2-official-i2i', 'rhart-image-g-2-official-t2i', 'rhart-image-g-2.5-i2i',
    'rhart-image-g-2.5-official-token-t2i', 'rhart-image-g-2.5-t2i',
  ]);
  assert.deepEqual(runningHubModelCatalog('VIDEO').map((item) => item.id).sort(), [
    'bytedance/seedance-2.0-global-fast', 'minimax/hailuo-h3', 'rhart-video/sparkvideo-2.0-mini',
  ]);
  assert.deepEqual(runningHubModelCatalog('MUSIC').map((item) => item.id), ['minimax/music-2.6']);
  assert.equal(runningHubModelCatalog('TEXT').length, 0);
});

await check('图片按生成方式拆 family：文生图渠道不接参考图、图生图渠道必须带图', async () => {
  // 文生图专用 family：没有参考图 → 走文生图路径
  await make('rhart-image-g-2.5-t2i').generate({ modality: 'IMAGE', prompt: 'x', options: {} });
  assert.equal(lastSubmission().path, '/openapi/v2/rhart-image-g-2.5/sunburst/text-to-image');
  // 同一条渠道被塞了参考图 → 当场报错，不发到别的路径（否则价格会记到另一条 API 上）
  await assert.rejects(
    () => make('rhart-image-g-2.5-t2i').generate({ modality: 'IMAGE', prompt: 'x', options: { referenceAssets: [{ type: 'IMAGE', url: `${SELF}/r.png` }] } }),
    (error) => error.code === 'GENERATION_PROVIDER_CONFIG_INVALID' && /图生图/.test(error.message),
  );
  // 图生图专用 family：有图 → 图生图路径；没图 → 报错（不回落文生图）
  await make('rhart-image-g-2.5-i2i').generate({ modality: 'IMAGE', prompt: 'x', options: { referenceAssets: [{ type: 'IMAGE', url: `${SELF}/r.png` }] } });
  assert.equal(lastSubmission().path, '/openapi/v2/rhart-image-g-2.5/flare/image-to-image');
  await assert.rejects(
    () => make('rhart-image-g-2.5-i2i').generate({ modality: 'IMAGE', prompt: 'x', options: {} }),
    (error) => error.code === 'GENERATION_PROVIDER_CONFIG_INVALID' && /文生图/.test(error.message),
  );
});

await check('图片按生成方式选路：文生图/图生图各走自己的渠道与备用', async () => {
  const policy = {
    provider: 'custom', model: '', endpoint: '',
    channels: [
      { id: 'img-t2i', name: '文生图主', provider: 'runninghub', endpoint: BASE, model: 'rhart-image-g-2.5-t2i', models: ['rhart-image-g-2.5-t2i'], requestPaths: {} },
      { id: 'img-t2i-bak', name: '文生图备', provider: 'runninghub', endpoint: BASE, model: 'rhart-image-g-2-official-t2i', models: ['rhart-image-g-2-official-t2i'], requestPaths: {} },
      { id: 'img-i2i', name: '图生图主', provider: 'runninghub', endpoint: BASE, model: 'rhart-image-g-2.5-i2i', models: ['rhart-image-g-2.5-i2i'], requestPaths: {} },
      { id: 'img-i2i-bak', name: '图生图备', provider: 'runninghub', endpoint: BASE, model: 'rhart-image-g-2-official-i2i', models: ['rhart-image-g-2-official-i2i'], requestPaths: {} },
    ],
    modalityChannels: { IMAGE: 'img-t2i' },
    modalityBackupChannels: { IMAGE: 'img-t2i-bak' },
    imageModeChannels: { TEXT: 'img-t2i', IMAGE_REFERENCE: 'img-i2i' },
    imageModeBackupChannels: { TEXT: 'img-t2i-bak', IMAGE_REFERENCE: 'img-i2i-bak' },
    modelRoutes: [],
  };
  const t2i = providerSelectionForModality(policy, 'IMAGE', '', { imageMode: 'TEXT' });
  assert.equal(t2i.channelId, 'img-t2i');
  assert.equal(t2i.model, 'rhart-image-g-2.5-t2i');
  assert.equal(t2i.backup.channelId, 'img-t2i-bak');
  const i2i = providerSelectionForModality(policy, 'IMAGE', '', { imageMode: 'IMAGE_REFERENCE' });
  assert.equal(i2i.channelId, 'img-i2i');
  assert.equal(i2i.model, 'rhart-image-g-2.5-i2i');
  assert.equal(i2i.backup.channelId, 'img-i2i-bak');
  // 没传 imageMode（老调用点）→ 仍是「图片」那条路由
  assert.equal(providerSelectionForModality(policy, 'IMAGE', '').channelId, 'img-t2i');
});

await check('图片·自动框体：按本次是否连参考图切文生图/图生图模型', async () => {
  const policy = {
    provider: 'custom', model: '', endpoint: '',
    channels: [
      { id: 'img-t2i', provider: 'runninghub', model: 'rhart-image-g-2.5-t2i', requestPaths: {} },
      { id: 'img-i2i', provider: 'runninghub', model: 'rhart-image-g-2.5-i2i', requestPaths: {} },
    ],
    modalityChannels: { IMAGE: 'img-t2i' },
    imageModeChannels: { TEXT: 'img-t2i', IMAGE_REFERENCE: 'img-i2i' },
    modelRoutes: [],
  };
  const autoBox = { modality: 'IMAGE', inputMode: '' };
  const ref = [{ type: 'IMAGE', url: 'https://cdn.example.com/a.png', nodeId: 'n1' }];
  // 没连线 → 文生图 → 文生图渠道
  assert.equal(imageModeForGeneration({ box: autoBox, referenceAssets: [] }), 'TEXT');
  assert.equal(providerSelectionForModality(policy, 'IMAGE', '', {
    imageMode: imageModeForGeneration({ box: autoBox, referenceAssets: [] }),
  }).channelId, 'img-t2i');
  // 连了图 → 图生图 → 图生图渠道
  assert.equal(imageModeForGeneration({ box: autoBox, referenceAssets: ref }), 'IMAGE_REFERENCE');
  assert.equal(providerSelectionForModality(policy, 'IMAGE', '', {
    imageMode: imageModeForGeneration({ box: autoBox, referenceAssets: ref }),
  }).channelId, 'img-i2i');
  // 空引用（连线但源框体还没出图）不算参考 → 仍走文生图
  assert.equal(imageModeForGeneration({ box: autoBox, referenceAssets: [{ type: 'IMAGE', url: '  ' }] }), 'TEXT');
  // 框体锁了生成方式 → 锁优先，不因连线改道
  assert.equal(imageModeForGeneration({ box: { inputMode: 'TEXT' }, referenceAssets: ref }), 'TEXT');
  assert.equal(imageModeForGeneration({ box: { inputMode: 'IMAGE_REFERENCE' }, referenceAssets: [] }), 'IMAGE_REFERENCE');
});

await check('family → 模态：未路由渠道的「试一次」不再落回 TEXT', async () => {
  assert.equal(runningHubFamilyModality('rhart-image-g-2.5'), 'IMAGE');
  assert.equal(runningHubFamilyModality('bytedance/seedance-2.0-global-fast'), 'VIDEO');
  assert.equal(runningHubFamilyModality('minimax/music-2.6'), 'MUSIC');
  assert.equal(runningHubFamilyModality('not-a-family'), '');
  assert.equal(runningHubFamilyModality(''), '');
});

await check('切备用时把分辨率收进备用渠道的枚举（视频主 480p → 备 768P）', async () => {
  // 主 seedance 支持 480p..4k，备 hailuo 只认 768P/2K —— 原样把 480p 发给备用会被 400 拒掉。
  const backup = { model: 'minimax/hailuo-h3', modelCapabilities: { 'minimax/hailuo-h3': { resolutions: ['768P', '2K'] } } };
  const args = (resolution) => ({ modality: 'VIDEO', options: { resolution, durationSeconds: 5, aspectRatio: '16:9' } });
  assert.equal(adaptOptionsToCandidate(args('480p'), backup).options.resolution, '768P');
  assert.equal(adaptOptionsToCandidate(args('720p'), backup).options.resolution, '768P');
  assert.equal(adaptOptionsToCandidate(args('1080p'), backup).options.resolution, '2K');
  assert.equal(adaptOptionsToCandidate(args('2k'), backup).options.resolution, '2K');
  assert.equal(adaptOptionsToCandidate(args('768P'), backup).options.resolution, '768P');
  // 没有声明能力 / 没给分辨率 → 原样，不猜
  assert.equal(adaptOptionsToCandidate(args('480p'), { model: 'x' }).options.resolution, '480p');
  assert.equal(adaptOptionsToCandidate({ modality: 'VIDEO', options: {} }, backup).options.resolution, undefined);
  // 其它参数一个都不动
  assert.equal(adaptOptionsToCandidate(args('480p'), backup).options.durationSeconds, 5);
  assert.equal(adaptOptionsToCandidate(args('480p'), backup).options.aspectRatio, '16:9');
});

await check('成本：query.usage.thirdPartyConsumeMoney 记 REPORTED（USD × 6.71749）', async () => {
  const image = await make('rhart-image-g-2.5').generate({ modality: 'IMAGE', prompt: '成本', options: {} });
  assert.equal(image.assets[0].metadata.reportedCost.upstreamAmount, 0.05);
  assert.equal(image.assets[0].metadata.reportedCost.fen, 34);
  const video = await make('bytedance/seedance-2.0-global-fast')
    .generate({ modality: 'VIDEO', prompt: '成本', options: { durationSeconds: 5, resolution: '480p' } });
  assert.equal(video.assets[0].metadata.reportedCost.upstreamAmount, 0.4);
  assert.equal(video.assets[0].metadata.reportedCost.fen, 269);
  assert.equal(video.assets[0].metadata.reportedCost.billingSeconds, 5);
});

await check('成本：站点币种 .ai=USD / .cn=CNY（CN 站实扣字段是人民币）', () => {
  assert.equal(runningHubSiteCurrency('https://www.runninghub.ai/openapi/v2'), 'USD');
  assert.equal(runningHubSiteCurrency('https://www.runninghub.cn/openapi/v2'), 'CNY');
  const cny = reportedCostFromUsage({ usage: { thirdPartyConsumeMoney: '1.5', billingSeconds: '5' } }, 'CNY');
  assert.equal(cny.fen, 150, 'CN 1.5 元 = 150 分');
  assert.equal(cny.upstreamCurrency, 'CNY');
  const usd = reportedCostFromUsage({ usage: { thirdPartyConsumeMoney: '0.4', billingSeconds: '5' } }, 'USD');
  assert.equal(usd.fen, 269, 'USD 0.4 × 6.71749 = 269 分');
  assert.equal(usd.upstreamCurrency, 'USD');
});

await check('对账：queryTask 能按 taskId 取回结果（重启/TIMEOUT 后补素材）', async () => {
  const provider = make('rhart-image-g-2.5-t2i');
  const ok = await provider.queryTask({ taskId: 'task_reconcile_1', modality: 'IMAGE', title: '对账' });
  assert.equal(ok.state, 'SUCCEEDED');
  assert.match(ok.asset.assetUrl, /\/out\.jpg$/);
  assert.equal(ok.asset.metadata.taskId, 'task_reconcile_1');
  assert.equal(ok.asset.metadata.reportedCost.fen, 34, '图片 $0.05 × 6.71749 = 34 分');
  state.queryStatus = 'RUNNING';
  try { assert.equal((await provider.queryTask({ taskId: 'task_reconcile_1', modality: 'IMAGE' })).state, 'PENDING'); }
  finally { state.queryStatus = 'SUCCESS'; }
  state.queryStatus = 'FAILED';
  try {
    const failed = await provider.queryTask({ taskId: 'task_reconcile_1', modality: 'IMAGE' });
    assert.equal(failed.state, 'FAILED');
    assert.match(failed.message, /mock failed/);
  } finally { state.queryStatus = 'SUCCESS'; }
});

mock.close();
const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.ok ? '' : `\n   ${item.message}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
