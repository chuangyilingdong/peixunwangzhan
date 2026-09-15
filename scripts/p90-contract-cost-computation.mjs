// P90：合同单价 → 逐笔自动上游计费（2026-09-14）
//   ① 文本按上游 input/output tokens × 每千 token 合同价（分整数、四舍五入，断言精确值）；
//   ② 图片按张数(1) × 每次价或分辨率档；视频按请求参数秒数 × 每秒价（可分辨率 / 含音频档）；音乐按次（可时长）；
//   ③ 缺用量或缺单价 → null（UNKNOWN），**绝不按 0 计**；
//   ④ 来源优先级 REPORTED > COMPUTED > ESTIMATED > UNKNOWN；
//   ⑤ cost_rule_snapshot 记录所用价与用量快照（用量另有 usage_snapshot 单列），改价不追溯；
//   ⑥ 学生侧 usage_records.cost_fen / credits_charged 恒 0（creditUsage 语义不变）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p90-contract-cost-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'test.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_API_KEY = 'p90-secret';

const { getGenerationProvider } = await import('../apps/server/src/services/generationProvider.js');
const { recordAiUsage } = await import('../apps/server/src/services/creditUsage.js');
const {
  compareCostSources, costSourcePriority, normalizeModelUnitPrices, normalizeUpstreamUnitPrices, validateModelUnitPrices, validateUpstreamUnitPrices,
} = await import('../apps/server/src/services/upstreamCost.js');
const { normalizeAiProviderPolicy, getAiProviderPolicy, handleAdminBillingConfig } = await import('../apps/server/src/routes/billingConfig.js');
const { providerSelectionForModality } = await import('../apps/server/src/routes/aiGeneration.js');
const { q, row } = await import('../apps/server/src/lib.js');

const originalFetch = globalThis.fetch;
const jsonResponse = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const attemptOf = (provider) => row('SELECT * FROM compute_attempts WHERE call_id=? AND attempt=1', [provider.compute.callId]);
const serveText = (usage, text = 'ok') => { globalThis.fetch = async () => jsonResponse({ id: 'p90-payload', usage, choices: [{ message: { content: text } }] }); };
const serveMedia = (url) => { globalThis.fetch = async () => jsonResponse({ id: 'p90-task', data: [{ url }] }); };

// 合同单价：文本 2.50 元/千 input token、7.50 元/千 output token；图片 0.30 元/张；视频 0.10 元/秒；音乐 0.88 元/次
const UNIT_PRICES = {
  TEXT: { inputFenPer1kTokens: 250, outputFenPer1kTokens: 750 },
  IMAGE: { perImageFen: 30, byResolution: { '1K': 30, '2K': 60 } },
  VIDEO: { perSecondFen: 10, byResolution: { '720p': 20 }, audioExtraPerSecondFen: 5 },
  MUSIC: { perCallFen: 88, perSecondFen: 4 },
};
const selection = (extra = {}) => ({
  provider: 'custom', model: 'p90-model', endpoint: 'https://p90.test/v1', channelId: 'contract-a',
  apiKey: 'p90-secret', upstreamUnitPrices: UNIT_PRICES, ...extra,
});

/* ④ 来源优先级：REPORTED > COMPUTED > ESTIMATED > UNKNOWN */
assert.ok(compareCostSources('REPORTED', 'COMPUTED') > 0);
assert.ok(compareCostSources('COMPUTED', 'ESTIMATED') > 0);
assert.ok(compareCostSources('ESTIMATED', 'UNKNOWN') > 0);
assert.equal(costSourcePriority('COMPUTED'), 2);
assert.equal(costSourcePriority('随便写的'), -1);

/* 合同单价归一化：非法值丢弃（不当 0），全空为 null */
assert.equal(normalizeUpstreamUnitPrices({ TEXT: { inputFenPer1kTokens: -1, outputFenPer1kTokens: 'x' } }), null);
assert.deepEqual(normalizeUpstreamUnitPrices({ TEXT: { inputFenPer1kTokens: '250', outputFenPer1kTokens: 750, 别的: 9 } }), { TEXT: { inputFenPer1kTokens: 250, outputFenPer1kTokens: 750 } });
assert.equal(normalizeUpstreamUnitPrices(null), null);
assert.deepEqual(validateUpstreamUnitPrices({ TEXT: { inputFenPer1kTokens: 250 } }), []);
assert.ok(validateUpstreamUnitPrices({ TEXT: { inputFenPer1kTokens: -5 } }).length);
assert.ok(validateUpstreamUnitPrices({ NOT_A_MODALITY: { perCallFen: 1 } }).length);
assert.ok(validateUpstreamUnitPrices({ IMAGE: { byResolution: { '2K': -1 } } }).length);

/* 模型级覆盖归一化与校验：非法值拒绝（不静默），整条覆盖可以为空 */
assert.deepEqual(normalizeModelUnitPrices({ 'qwen-max': { TEXT: { inputFenPer1kTokens: 200 } }, 空的: {} }), { 'qwen-max': { TEXT: { inputFenPer1kTokens: 200 } } });
assert.equal(normalizeModelUnitPrices(null), null);
assert.deepEqual(validateModelUnitPrices({ 'qwen-max': { TEXT: { inputFenPer1kTokens: 200, outputFenPer1kTokens: 600 } } }), []);
assert.ok(validateModelUnitPrices({ 'qwen-max': { TEXT: { inputFenPer1kTokens: -1 } } }).length);
assert.ok(validateModelUnitPrices({ 'qwen-max': '不是对象' }).length);
assert.ok(validateModelUnitPrices({ '': { TEXT: { inputFenPer1kTokens: 1 } } }).length);
assert.ok(validateModelUnitPrices({ 'qwen-max': { NOT_A_MODALITY: { perCallFen: 1 } } }).length);

try {
  /* ① 文本：input/output tokens × 每千 token 价，四舍五入后相加（精确值） */
  serveText({ prompt_tokens: 800, completion_tokens: 333 });
  let provider = getGenerationProvider(selection());
  const textResult = await provider.generate({ modality: 'TEXT', prompt: '合同单价折算' });
  // 800 × 250 / 1000 = 200；333 × 750 / 1000 = 249.75 → 250；合计 450
  let attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'COMPUTED');
  assert.equal(attempt.upstream_cost_fen, 450);
  assert.equal(textResult.compute.costSource, 'COMPUTED');
  assert.equal(textResult.compute.upstreamCostFen, 450);
  const usageSnapshot = JSON.parse(attempt.usage_snapshot);
  assert.equal(usageSnapshot.evidence, 'UPSTREAM_USAGE');
  assert.equal(usageSnapshot.inputTokens, 800);
  assert.equal(usageSnapshot.outputTokens, 333);
  const ruleSnapshot = JSON.parse(attempt.cost_rule_snapshot);
  assert.equal(ruleSnapshot.basis, 'CONTRACT_UNIT_PRICE');
  assert.equal(ruleSnapshot.source, 'COMPUTED');
  assert.equal(ruleSnapshot.computedFen, 450);
  assert.deepEqual(ruleSnapshot.unitPrice, { inputFenPer1kTokens: 250, outputFenPer1kTokens: 750 });
  assert.deepEqual(ruleSnapshot.usage, { inputTokens: 800, outputTokens: 333, inputFen: 200, outputFen: 250 });
  assert.equal(ruleSnapshot.channelId, 'contract-a');
  assert.equal(ruleSnapshot.model, 'p90-model');
  assert.equal(ruleSnapshot.priceLevel, 'MODALITY', '只配了素材类型价 → 命中 MODALITY 层级');
  assert.deepEqual(ruleSnapshot.priceLayers, ['MODALITY']);

  /* 模型级覆盖：同一素材类型下两个模型合同价差十倍，各算各的（优先级 model > modality） */
  const MODEL_PRICES = {
    // 渠道级 TEXT 是 250/750（前面 UNIT_PRICES），模型级故意配成十倍差，证明模型级确实生效
    'qwen-turbo': { TEXT: { inputFenPer1kTokens: 20, outputFenPer1kTokens: 60 } },
    'qwen-max': { TEXT: { inputFenPer1kTokens: 200, outputFenPer1kTokens: 600 } },
  };
  const modelPriced = (model, extra = {}) => selection({ model, modelUnitPrices: MODEL_PRICES, ...extra });

  serveText({ prompt_tokens: 1000, completion_tokens: 500 });
  provider = getGenerationProvider(modelPriced('qwen-turbo'));
  await provider.generate({ modality: 'TEXT', prompt: '小模型' });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'COMPUTED');
  assert.equal(attempt.upstream_cost_fen, 50, 'qwen-turbo：1000 × 20/1000 + 500 × 60/1000 = 20 + 30');
  let modelRule = JSON.parse(attempt.cost_rule_snapshot);
  assert.equal(modelRule.priceLevel, 'MODEL');
  assert.deepEqual(modelRule.priceLayers, ['MODEL']);
  assert.deepEqual(modelRule.unitPrice, { inputFenPer1kTokens: 20, outputFenPer1kTokens: 60 });
  assert.equal(modelRule.model, 'qwen-turbo');

  serveText({ prompt_tokens: 1000, completion_tokens: 500 });
  provider = getGenerationProvider(modelPriced('qwen-max'));
  await provider.generate({ modality: 'TEXT', prompt: '大模型' });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 500, 'qwen-max：1000 × 200/1000 + 500 × 600/1000 = 200 + 300');
  modelRule = JSON.parse(attempt.cost_rule_snapshot);
  assert.equal(modelRule.priceLevel, 'MODEL');
  assert.deepEqual(modelRule.unitPrice, { inputFenPer1kTokens: 200, outputFenPer1kTokens: 600 });
  assert.notEqual(attempt.upstream_cost_fen, 50, '同一素材类型下两个模型必须各算各的');

  // 模型级缺字段 → 该字段回退素材类型价（只写了 output，input 用渠道级的 250）
  serveText({ prompt_tokens: 1000, completion_tokens: 500 });
  provider = getGenerationProvider(selection({ model: 'qwen-partial', modelUnitPrices: { 'qwen-partial': { TEXT: { outputFenPer1kTokens: 600 } } } }));
  await provider.generate({ modality: 'TEXT', prompt: '模型级只写了输出价' });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 550, 'input 回退渠道级 250（1000 → 250）+ 模型级 output 600（500 → 300）');
  modelRule = JSON.parse(attempt.cost_rule_snapshot);
  assert.equal(modelRule.priceLevel, 'MODEL');
  assert.deepEqual(modelRule.priceLayers, ['MODEL', 'MODALITY'], '混合层级如实记录');
  assert.deepEqual(modelRule.unitPrice, { inputFenPer1kTokens: 250, outputFenPer1kTokens: 600 });

  // 模型级没有这个素材类型 → 整层回退素材类型价（qwen-plus 不在 MODEL_PRICES 里）
  serveText({ prompt_tokens: 800, completion_tokens: 333 });
  provider = getGenerationProvider(modelPriced('qwen-plus'));
  await provider.generate({ modality: 'TEXT', prompt: '没配模型价 → 回退' });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 450, '回退渠道级 250/750：800/333 → 200 + 250');
  modelRule = JSON.parse(attempt.cost_rule_snapshot);
  assert.equal(modelRule.priceLevel, 'MODALITY');
  assert.deepEqual(modelRule.priceLayers, ['MODALITY']);

  // 模型级配了 TEXT 的价格、但请求的是 IMAGE → 该素材类型两层都没有 → UNKNOWN，不按 0
  serveMedia('https://p90.test/model-fallback.png');
  provider = getGenerationProvider(selection({ model: 'qwen-max', modelUnitPrices: MODEL_PRICES, upstreamUnitPrices: { VIDEO: { perSecondFen: 10 } } }));
  await provider.generate({ modality: 'IMAGE', prompt: '两层都没有形象单价', options: { resolution: '2K' } });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'UNKNOWN');
  assert.equal(attempt.upstream_cost_fen, null, '两层都缺 → null（不是 0）');

  // 模型级覆盖对图片同样生效
  provider = getGenerationProvider(selection({ model: 'p90-model', modelUnitPrices: { 'p90-model': { IMAGE: { perImageFen: 99 } } } }));
  await provider.generate({ modality: 'IMAGE', prompt: '模型级图片价', options: { resolution: '2K' } });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 99, '模型级每次价 0.99 元/张，压过渠道级档位价');
  assert.equal(JSON.parse(attempt.cost_rule_snapshot).priceLevel, 'MODEL');

  // 模型级覆盖对视频（每秒价）与音乐（按次价）同样生效
  serveMedia('https://p90.test/model-clip.mp4');
  provider = getGenerationProvider(selection({ model: 'video-max', modelUnitPrices: { 'video-max': { VIDEO: { perSecondFen: 30 } } } }));
  await provider.generate({ modality: 'VIDEO', prompt: '模型级每秒价', options: { durationSeconds: 2, resolution: '1080p' } });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 60, '模型级 2 秒 × 0.30 元/秒（渠道级档位/每秒价都不再参与）');
  assert.deepEqual(JSON.parse(attempt.cost_rule_snapshot).unitPrice, { perSecondFen: 30 });

  serveMedia('https://p90.test/model-song.mp3');
  provider = getGenerationProvider(selection({ model: 'music-max', modelUnitPrices: { 'music-max': { MUSIC: { perCallFen: 5 } } } }));
  await provider.generate({ modality: 'MUSIC', prompt: '模型级按次价', options: { durationSeconds: 10 } });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 5, '模型级按次价 0.05 元/次，压过渠道级的每秒价');
  assert.deepEqual(JSON.parse(attempt.cost_rule_snapshot).unitPrice, { perCallFen: 5 });

  /* ④ 上游明确给了成本 → REPORTED 优先于 COMPUTED（金额取上报值，不折算） */
  serveText({ prompt_tokens: 800, completion_tokens: 333, cost: { amount: 3.5, currency: 'CNY' } });
  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'TEXT', prompt: '上报成本优先' });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'REPORTED');
  assert.equal(attempt.upstream_cost_fen, 350);
  assert.deepEqual(JSON.parse(attempt.usage_snapshot), { modality: 'TEXT', evidence: 'UPSTREAM_USAGE', inputTokens: 800, outputTokens: 333, images: null, seconds: null, resolution: null, audio: null });

  /* ③ 缺用量：配了单价但上游没给 token → UNKNOWN + null（不是 0） */
  serveText(undefined);
  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'TEXT', prompt: '没有用量回执' });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'UNKNOWN');
  assert.equal(attempt.upstream_cost_fen, null);
  assert.equal(attempt.usage_snapshot, null);
  assert.equal(attempt.cost_rule_snapshot !== null, true, 'ESTIMATED/CONFIGURED 快照仍在，只是没有折算');

  /* ③ 缺单价：有用量但渠道没配合同价 → UNKNOWN + null */
  serveText({ prompt_tokens: 800, completion_tokens: 333 });
  provider = getGenerationProvider(selection({ upstreamUnitPrices: null }));
  await provider.generate({ modality: 'TEXT', prompt: '没有合同单价' });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'UNKNOWN');
  assert.equal(attempt.upstream_cost_fen, null);
  assert.equal(JSON.parse(attempt.usage_snapshot).inputTokens, 800, '用量证据照记，只是折算不出来');

  /* 兜底：没单价但有配置估算 → ESTIMATED；快照形状保持原样（向后兼容） */
  provider = getGenerationProvider(selection({ upstreamUnitPrices: null, estimatedCostFen: 17 }));
  await provider.generate({ modality: 'TEXT', prompt: '估算兜底' });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'ESTIMATED');
  assert.equal(attempt.upstream_cost_fen, 17);
  assert.deepEqual(Object.keys(JSON.parse(attempt.cost_rule_snapshot)).sort(), ['basis', 'capturedAt', 'channelId', 'estimatedCostFen', 'model', 'provider']);

  /* ② 图片：张数(1) × 每次价；给了分辨率档位就按档位价 */
  serveMedia('https://p90.test/cover.png');
  provider = getGenerationProvider(selection({ upstreamUnitPrices: { IMAGE: { perImageFen: 30 } } }));
  await provider.generate({ modality: 'IMAGE', prompt: '一张图', options: { resolution: '2K' } });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'COMPUTED');
  assert.equal(attempt.upstream_cost_fen, 30, '没有档位价就走每次价');
  assert.deepEqual(JSON.parse(attempt.usage_snapshot), { modality: 'IMAGE', evidence: 'REQUEST_PARAMS', inputTokens: null, outputTokens: null, images: 1, seconds: null, resolution: '2K', audio: null });

  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'IMAGE', prompt: '一张图', options: { resolution: '2K' } });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 60, '2K 档位价 0.60 元/张');
  assert.equal(JSON.parse(attempt.cost_rule_snapshot).unitPrice.matchedResolution, '2K');

  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'IMAGE', prompt: '一张图', options: { resolution: '4K' } });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 30, '档位没配这一档时回落到每次价');

  /* ② 视频：请求参数秒数 × 每秒价（分辨率档位 + 含音频档各自单独取整后相加） */
  serveMedia('https://p90.test/clip.mp4');
  provider = getGenerationProvider(selection({ upstreamUnitPrices: { VIDEO: { perSecondFen: 10 } } }));
  await provider.generate({ modality: 'VIDEO', prompt: '6 秒', options: { durationSeconds: 6 } });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 60, '6 秒 × 0.10 元/秒');
  assert.equal(JSON.parse(attempt.usage_snapshot).seconds, 6);

  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'VIDEO', prompt: '6 秒含音频', options: { durationSeconds: 6, resolution: '720p', audio: true } });
  attempt = attemptOf(provider);
  // 6 × 20（720p 档）= 120；6 × 5（含音频档）= 30；合计 150
  assert.equal(attempt.upstream_cost_fen, 150);
  const videoUsage = JSON.parse(attempt.usage_snapshot);
  assert.equal(videoUsage.seconds, 6);
  assert.equal(videoUsage.audio, true);
  assert.equal(videoUsage.resolution, '720p');
  assert.deepEqual(JSON.parse(attempt.cost_rule_snapshot).unitPrice, { perSecondFen: 20, matchedResolution: '720p', audioExtraPerSecondFen: 5 });

  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'VIDEO', prompt: '3 秒无声', options: { durationSeconds: 3, resolution: '480p' } });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 30, '3 秒 × 0.10 元/秒（1080p 档没配 → 回落每秒价）');

  // 缺秒数（拿不到请求参数）→ UNKNOWN，不按 0
  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'VIDEO', prompt: '没给时长', options: {} });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'UNKNOWN');
  assert.equal(attempt.upstream_cost_fen, null);

  /* ② 音乐：按次（配了每秒价且拿得到时长时按时长） */
  serveMedia('https://p90.test/song.mp3');
  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'MUSIC', prompt: '一首歌' });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'COMPUTED');
  assert.equal(attempt.upstream_cost_fen, 88, '按次价 0.88 元/次');
  assert.deepEqual(JSON.parse(attempt.cost_rule_snapshot).unitPrice, { perCallFen: 88 });

  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'MUSIC', prompt: '10 秒的歌', options: { durationSeconds: 10 } });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 40, '拿得到时长 → 10 秒 × 0.04 元/秒');

  provider = getGenerationProvider(selection({ upstreamUnitPrices: { MUSIC: { perSecondFen: 4 } } }));
  await provider.generate({ modality: 'MUSIC', prompt: '没给时长' });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'UNKNOWN');
  assert.equal(attempt.upstream_cost_fen, null, '只有每秒价却拿不到时长 → 折不出来，不按 0 计');

  /* ⑤ 改价不追溯：老 attempt 的价与快照不动，新调用才用新价 */
  serveText({ prompt_tokens: 1000, completion_tokens: 0 });
  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'TEXT', prompt: '改价前' });
  const before = attemptOf(provider);
  assert.equal(before.upstream_cost_fen, 250);
  provider = getGenerationProvider(selection({ upstreamUnitPrices: { TEXT: { inputFenPer1kTokens: 400, outputFenPer1kTokens: 750 } } }));
  await provider.generate({ modality: 'TEXT', prompt: '改价后' });
  const after = attemptOf(provider);
  assert.equal(after.upstream_cost_fen, 400, '新调用用新价');
  assert.equal(row('SELECT upstream_cost_fen FROM compute_attempts WHERE id=?', [before.id]).upstream_cost_fen, 250, '老 attempt 金额不被改价追溯');
  assert.deepEqual(JSON.parse(row('SELECT cost_rule_snapshot FROM compute_attempts WHERE id=?', [before.id]).cost_rule_snapshot).unitPrice, { inputFenPer1kTokens: 250, outputFenPer1kTokens: 750 });

  /* ⑥ 学生侧恒 0：用了 usage 也只是留证，cost_fen / credits_charged 不受影响 */
  const nowIso = new Date().toISOString();
  q('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ['org-p90', 'P90 Org', 'ACTIVE', nowIso, new Date(Date.now() + 86400000).toISOString(), 0, nowIso, nowIso]);
  serveText({ prompt_tokens: 800, completion_tokens: 333 });
  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'TEXT', prompt: '学生侧账本' });
  recordAiUsage({
    orgId: 'org-p90', userId: 'student-p90', modality: 'TEXT', model: 'p90-model', status: 'SUCCESS',
    usage: { inputTokens: 800, outputTokens: 333 }, pricing: { compute: provider.compute, source: 'generation', charged: false },
  });
  const usageRecord = row('SELECT * FROM usage_records WHERE generation_job_id IS NULL ORDER BY created_at DESC LIMIT 1');
  assert.equal(usageRecord.cost_fen, 0, '学生侧 cost_fen 恒 0');
  assert.equal(usageRecord.credits_charged, 0, '学生侧 credits_charged 恒 0');
  assert.equal(usageRecord.input_tokens, 800);
  assert.equal(usageRecord.output_tokens, 333);
  assert.equal(usageRecord.compute_call_id, provider.compute.callId);
  // 记账这一步不覆盖 provider 侧写下的整份用量证据（形状仍是用量快照那份）
  const linkedAttempt = row('SELECT usage_snapshot FROM compute_attempts WHERE call_id=?', [provider.compute.callId]);
  assert.deepEqual(JSON.parse(linkedAttempt.usage_snapshot), {
    modality: 'TEXT', evidence: 'UPSTREAM_USAGE', inputTokens: 800, outputTokens: 333, images: null, seconds: null, resolution: null, audio: null,
  });

  /* 渠道配置读写：normalizeAiProviderPolicy 读得到，PUT 存得下，非法值当场拒绝 */
  const readPolicy = normalizeAiProviderPolicy(JSON.stringify({
    provider: 'custom', model: 'p90-model', endpoint: 'https://p90.test/v1',
    channels: [{ id: 'contract-a', provider: 'custom', model: 'p90-model', models: ['p90-model'], endpoint: 'https://p90.test/v1', upstreamUnitPrices: UNIT_PRICES }],
    modalityChannels: { TEXT: 'contract-a' },
  }));
  assert.deepEqual(readPolicy.channels[0].upstreamUnitPrices.TEXT, { inputFenPer1kTokens: 250, outputFenPer1kTokens: 750 });
  assert.equal(readPolicy.channels[0].upstreamUnitPrices.VIDEO.audioExtraPerSecondFen, 5);
  assert.equal(readPolicy.channels[0].modelUnitPrices, null, '没配模型级覆盖时读回来是 null（不是空壳）');

  const adminAuth = { user: { id: 'root', login: 'root', role: 'SUPER_ADMIN', permissions: [] }, rawUser: { permissions: '[]' } };
  const put = (body) => handleAdminBillingConfig({ pathname: '/api/admin/billing-config/ai-provider', method: 'PUT', body, auth: adminAuth, req: { socket: { remoteAddress: '127.0.0.1' } } });
  const putBody = {
    provider: 'custom', model: 'p90-model', endpoint: 'https://p90.test/v1', displayName: 'P90 渠道',
    channels: [{
      id: 'contract-a', name: '合同渠道 A', provider: 'custom', model: 'p90-model', models: ['p90-model', 'qwen-turbo'], endpoint: 'https://p90.test/v1',
      upstreamUnitPrices: { TEXT: { inputFenPer1kTokens: 100, outputFenPer1kTokens: 200 } },
      modelUnitPrices: { 'qwen-turbo': { TEXT: { inputFenPer1kTokens: 10, outputFenPer1kTokens: 20 } } },
    }],
    modalityChannels: { TEXT: 'contract-a' },
  };
  const putResult = await put(putBody);
  assert.deepEqual(putResult.policy.channels[0].upstreamUnitPrices, { TEXT: { inputFenPer1kTokens: 100, outputFenPer1kTokens: 200 } });
  assert.deepEqual(putResult.policy.channels[0].modelUnitPrices, { 'qwen-turbo': { TEXT: { inputFenPer1kTokens: 10, outputFenPer1kTokens: 20 } } });
  assert.deepEqual(getAiProviderPolicy().channels[0].upstreamUnitPrices.TEXT, { inputFenPer1kTokens: 100, outputFenPer1kTokens: 200 }, '落库后读回来一致');
  assert.deepEqual(getAiProviderPolicy().channels[0].modelUnitPrices['qwen-turbo'].TEXT, { inputFenPer1kTokens: 10, outputFenPer1kTokens: 20 }, '模型级覆盖落库后读回来一致');
  await assert.rejects(
    () => put({ ...putBody, channels: [{ ...putBody.channels[0], upstreamUnitPrices: { TEXT: { inputFenPer1kTokens: -1 } } }] }),
    (error) => error?.code === 'AI_PROVIDER_COST_INVALID',
  );
  await assert.rejects(
    () => put({ ...putBody, channels: [{ ...putBody.channels[0], upstreamUnitPrices: { TEXT: { inputFenPer1kTokens: '不是金额' } } }] }),
    (error) => error?.code === 'AI_PROVIDER_COST_INVALID',
  );
  // 模型级非法值同样当场拒绝（否则会悄悄回退渠道价，把成本算错）
  for (const bad of [
    { 'qwen-turbo': { TEXT: { inputFenPer1kTokens: -1 } } },
    { 'qwen-turbo': { TEXT: { outputFenPer1kTokens: '不是金额' } } },
    { 'qwen-turbo': { NOT_A_MODALITY: { perCallFen: 1 } } },
    { 'qwen-turbo': '不是对象' },
    { '': { TEXT: { inputFenPer1kTokens: 1 } } },
  ]) {
    await assert.rejects(
      () => put({ ...putBody, channels: [{ ...putBody.channels[0], modelUnitPrices: bad }] }),
      (error) => error?.code === 'AI_PROVIDER_COST_INVALID',
    );
  }

  /* 端到端：渠道配置（合同价）→ providerSelectionForModality → 逐笔 COMPUTED */
  const selectionFromPolicy = providerSelectionForModality(getAiProviderPolicy(), 'TEXT', 'p90-model');
  assert.deepEqual(selectionFromPolicy.upstreamUnitPrices, { TEXT: { inputFenPer1kTokens: 100, outputFenPer1kTokens: 200 } });
  assert.deepEqual(selectionFromPolicy.modelUnitPrices, { 'qwen-turbo': { TEXT: { inputFenPer1kTokens: 10, outputFenPer1kTokens: 20 } } });
  serveText({ prompt_tokens: 1000, completion_tokens: 500 });
  provider = getGenerationProvider({ ...selectionFromPolicy, apiKey: 'p90-secret' });
  await provider.generate({ modality: 'TEXT', prompt: '走渠道配置' });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'COMPUTED');
  assert.equal(attempt.upstream_cost_fen, 200, '1000 × 100/1000 + 500 × 200/1000 = 100 + 100');
  assert.equal(attempt.channel_id, 'contract-a');
  assert.equal(JSON.parse(attempt.cost_rule_snapshot).priceLevel, 'MODALITY', '模型级没有 p90-model → 用渠道价');

  // 同一渠道里的另一个模型走模型级覆盖价（同一条渠道配置，两张不同的对账金额）
  const turboSelection = providerSelectionForModality(getAiProviderPolicy(), 'TEXT', 'qwen-turbo');
  assert.equal(turboSelection.model, 'qwen-turbo');
  serveText({ prompt_tokens: 1000, completion_tokens: 500 });
  provider = getGenerationProvider({ ...turboSelection, apiKey: 'p90-secret' });
  await provider.generate({ modality: 'TEXT', prompt: '同渠道的小模型' });
  attempt = attemptOf(provider);
  assert.equal(attempt.upstream_cost_fen, 20, 'qwen-turbo 模型级价：1000 × 10/1000 + 500 × 20/1000 = 10 + 10');
  assert.equal(JSON.parse(attempt.cost_rule_snapshot).priceLevel, 'MODEL');
  assert.equal(JSON.parse(attempt.cost_rule_snapshot).model, 'qwen-turbo');

  /* ⑦ Seedance 直连实扣（2026-09-15）：异步任务终态回执里的 usage.amount 就是**本次实际扣减**，
       按协议从 data.usage / task.usage / 顶层 usage 读出 → 来源 REPORTED，金额取上报值、不折算合同价。 */
  // 图片：通用任务查询把 usage 放在 data.usage（code/data 信封）。
  // 币种用实测值「¥」——上游真回的是它，不是文档示例里的 CNY。
  let imagePolls = 0;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === 'POST') return jsonResponse({ code: true, data: { task_id: 'sd-image-1' } });
    imagePolls += 1;
    return jsonResponse({ code: true, data: { task_id: 'sd-image-1', status: 'SUCCESS', data: [{ url: 'https://p90.test/sd-cover.png' }], usage: { amount: 0.040112, currency: '¥' } } });
  };
  provider = getGenerationProvider(selection({ requestPaths: { IMAGE: '/v1/image/generations' } }));
  await provider.generate({ modality: 'IMAGE', prompt: 'seedance 一张图', options: { resolution: '2K' } });
  attempt = attemptOf(provider);
  assert.equal(imagePolls, 1, '提交一次 + 轮询一次');
  assert.equal(attempt.cost_source, 'REPORTED', '上游给了实扣金额就不再用合同价折算');
  assert.equal(attempt.upstream_cost_fen, 4, '¥0.040112 → 4 分（小数元四舍五入成整数分）');
  const imageRule = JSON.parse(attempt.cost_rule_snapshot);
  assert.equal(imageRule.basis, 'UPSTREAM_REPORTED', 'REPORTED 也留成本规则快照，basis 标明是上游上报');
  assert.equal(imageRule.upstreamCurrency, '¥', '留下上游原样回传的币种写法作为证据');
  assert.equal(imageRule.upstreamAmount, 0.040112, '留下未取整的原始金额');
  assert.equal(imageRule.reportedFen, 4);

  // 视频（MiniMax-H3 协议）：提交 /v2/video_generation、轮询 /v2/query/video_generation/{id}，
  // 实扣在 task.usage，视频直链在 task.content.url
  let videoPolls = 0;
  const videoUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    videoUrls.push(String(url));
    if (options.method === 'POST') return jsonResponse({ task_id: 'sd-video-1' });
    videoPolls += 1;
    return jsonResponse({ task: { id: 'sd-video-1', status: 'succeeded', content: { url: 'https://p90.test/sd-clip.mp4' }, usage: { amount: 21.8, currency: 'CNY' } } });
  };
  provider = getGenerationProvider(selection({ requestPaths: { VIDEO: '/v2/video_generation' }, pollPaths: { VIDEO: '/v2/query/video_generation/{id}' } }));
  await provider.generate({ modality: 'VIDEO', prompt: 'seedance 一段视频', options: { durationSeconds: 5, resolution: '1080p' } });
  attempt = attemptOf(provider);
  assert.equal(videoPolls, 1);
  assert.equal(videoUrls[0], 'https://p90.test/v2/video_generation', '按渠道 requestPaths 提交');
  assert.equal(videoUrls[1], 'https://p90.test/v2/query/video_generation/sd-video-1', '按渠道 pollPaths 轮询');
  assert.equal(attempt.cost_source, 'REPORTED');
  assert.equal(attempt.upstream_cost_fen, 2180, '¥21.80 → 2180 分');
  assert.equal(attempt.task_id, 'sd-video-1');

  // 浮点陷阱：Seedance 官方示例的 ¥20.40，直接 ×100 = 2039.9999999999998 —— 落库必须是整数分
  globalThis.fetch = async () => jsonResponse({ code: true, data: { task_id: 'sd-music-1', status: 'succeeded', data: [{ url: 'https://p90.test/sd-song.mp3' }], usage: { amount: 20.4, currency: 'CNY' } } });
  provider = getGenerationProvider(selection());
  await provider.generate({ modality: 'MUSIC', prompt: 'seedance 一首歌', options: { durationSeconds: 10 } });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'REPORTED');
  assert.ok(Number.isInteger(attempt.upstream_cost_fen), '必须是整数分，不能是 2039.9999999999998');
  assert.equal(attempt.upstream_cost_fen, 2040);

  // 非 CNY 实扣（Midjourney / Suno 按上游 cost 报 USD）不认 → 回落合同价折算，绝不把美元当人民币
  globalThis.fetch = async () => jsonResponse({ code: true, data: { task_id: 'sd-usd-1', status: 'succeeded', data: [{ url: 'https://p90.test/mj.png' }], usage: { amount: 0.045, currency: 'USD' } } });
  provider = getGenerationProvider(selection({ upstreamUnitPrices: { IMAGE: { perImageFen: 30 } } }));
  await provider.generate({ modality: 'IMAGE', prompt: '美元结算的图' });
  attempt = attemptOf(provider);
  assert.equal(attempt.cost_source, 'COMPUTED', 'USD 实扣不认，改用合同价折算');
  assert.equal(attempt.upstream_cost_fen, 30);

  console.log('P90 合同单价折算：文本 token × 每千 token 价、图片按张/档、视频按秒/档、音乐按次，金额分整数精确断言通过');
  console.log('P90 缺用量与缺单价一律 null（UNKNOWN）不按 0、来源优先级 REPORTED>COMPUTED>ESTIMATED>UNKNOWN、改价不追溯、学生侧恒 0、渠道读写与非法值拒绝通过');
  console.log('P90 Seedance 直连实扣：data.usage / task.usage / 顶层 usage 三处读取位置、实测币种「¥」认成人民币、');
  console.log('      ¥20.40 与 ¥0.040112 这类小数换算成整数分、USD 不当人民币、REPORTED 也留 upstreamCurrency/upstreamAmount 证据 通过');
} finally {
  globalThis.fetch = originalFetch;
}
