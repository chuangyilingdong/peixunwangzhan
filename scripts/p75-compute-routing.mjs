import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-routing-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'test.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_API_KEY = 'test-only';
const load = p => import(pathToFileURL(path.resolve(p)).href);
const { getGenerationProvider } = await load('apps/server/src/services/generationProvider.js');
const { rows } = await load('apps/server/src/lib.js');
const originalFetch = globalThis.fetch;
const primary = { provider: 'custom', model: 'primary', endpoint: 'https://primary.test/v1', channelId: 'primary', apiKey: 'test-only', backup: { provider: 'custom', model: 'backup', endpoint: 'https://backup.test/v1', channelId: 'backup', apiKey: 'test-only', estimatedCostFen: 12 } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
try {
  let calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return String(url).includes('primary')
      ? json({ error: 'rate limited' }, 429)
      : new Response(JSON.stringify({ id: 'backup-response', usage: { id: 'backup-usage' }, choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'backup-request' } });
  };
  let provider = getGenerationProvider(primary);
  await provider.generate({ modality: 'TEXT' });
  assert.equal(calls.length, 2); assert.equal(provider.model, 'backup');
  let attempts = rows('SELECT * FROM compute_attempts WHERE call_id=? ORDER BY attempt', [provider.compute.callId]);
  assert.deepEqual(attempts.map(x => x.status), ['FAILED', 'SUCCESS']);
  assert.equal(attempts[0].upstream_cost_fen, null); assert.equal(attempts[1].cost_source, 'ESTIMATED');
  assert.equal(attempts[1].upstream_cost_fen, 12);
  assert.ok(attempts.every(x => x.client_request_id?.startsWith('req_')));
  assert.equal(attempts[1].response_request_id, 'backup-request');
  assert.equal(attempts[1].response_payload_id, 'backup-response');
  assert.equal(attempts[1].usage_id, 'backup-usage');
  assert.equal(JSON.parse(attempts[1].cost_rule_snapshot).estimatedCostFen, 12);
  assert.equal(provider.compute.saleSnapshot.model, 'primary');
  calls = [];
  globalThis.fetch = async url => { calls.push(url); throw new Error('socket closed after request'); };
  provider = getGenerationProvider(primary);
  await assert.rejects(provider.generate({ modality: 'TEXT' })); assert.equal(calls.length, 1);
  calls = [];
  globalThis.fetch = async (url, opts) => { calls.push(url); return opts.method === 'POST' ? json({ task_id: 'accepted-task' }) : json({ error: 'rate limited' }, 429); };
  provider = getGenerationProvider(primary);
  await assert.rejects(provider.generate({ modality: 'VIDEO' })); assert.equal(calls.length, 2);
  assert.equal(rows('SELECT task_id FROM compute_attempts WHERE call_id=?', [provider.compute.callId])[0].task_id, 'accepted-task');
  calls = [];
  globalThis.fetch = async url => { calls.push(url); return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }); };
  provider = getGenerationProvider(primary);
  await assert.rejects(provider.generateStream({ onDelta() { throw Object.assign(new Error('consumer failed'), { safeToRetry: true }); } })); assert.equal(calls.length, 1);
  calls = [];
  globalThis.fetch = async url => { calls.push(url); return json({ error: 'rate limit' }, 429); };
  provider = getGenerationProvider({ ...primary, gateway: { endpoint: 'https://gateway.test', apiKey: 'test-only' } });
  await assert.rejects(provider.generate({ modality: 'TEXT' })); assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(rows('SELECT * FROM compute_attempts')).includes('test-only'));
  const { reportedCost } = await load('apps/server/src/services/openaiCompatibleProvider.js');
  // 网关风格：金额在 usage.cost
  assert.equal(reportedCost({usage:{cost:3}}),null);
  assert.equal(reportedCost({usage:{cost:{amount:2,currency:'USD'}}}),null);
  assert.equal(reportedCost({usage:{cost:{amount:0.25,currency:'CNY'}}}).fen,25);
  // Seedance 直连风格：金额就在 usage 本身，读取位置按协议分三种
  assert.equal(reportedCost({usage:{amount:8.75,currency:'CNY'}}).fen,875);
  assert.equal(reportedCost({code:true,data:{status:'succeeded',usage:{amount:0.54,currency:'CNY'}}}).fen,54);
  assert.equal(reportedCost({task:{status:'succeeded',usage:{amount:21.8,currency:'CNY'}}}).fen,2180);
  // 上游金额是小数：20.40 直接 ×100 会得到 2039.9999999999998，必须四舍五入成整数分
  assert.ok(Number.isInteger(reportedCost({data:{usage:{amount:20.4,currency:'CNY'}}}).fen));
  assert.equal(reportedCost({data:{usage:{amount:20.4,currency:'CNY'}}}).fen,2040);
  // 实测：上游回的币种写法是「¥」，**不是文档示例里的 CNY**
  // （api.seedance.nz 图片任务终态 data.usage = {amount: 0.040112, currency: "¥"}）。
  // 逐字比对 CNY 会让真实数据一条都读不到 —— 必须按人民币别名表认。
  assert.equal(reportedCost({code:true,message:'ok',data:{status:'SUCCESS',usage:{amount:0.040112,currency:'¥'}}}).fen,4);
  assert.equal(reportedCost({code:true,data:{usage:{amount:0.040112,currency:'¥'}}}).upstreamCurrency,'¥');
  assert.equal(reportedCost({data:{usage:{amount:1.5,currency:'RMB'}}}).fen,150);
  assert.equal(reportedCost({data:{usage:{amount:1.5,currency:'CNY'}}}).upstreamCurrency,'CNY');
  assert.equal(reportedCost({data:{usage:{amount:1.5,currency:'cn¥'}}}).fen,150);
  // 非 CNY（Midjourney / Suno 按上游 cost 报的 USD）一律不认，绝不冒充成 CNY
  assert.equal(reportedCost({usage:{amount:0.045,currency:'USD'}}),null);
  assert.equal(reportedCost({task:{usage:{amount:9,currency:'USD'}}}),null);
  assert.equal(reportedCost({data:{usage:{amount:5,currency:'JPY'}}}),null);
  assert.equal(reportedCost({data:{usage:{amount:5,currency:'$'}}}),null);
  // 缺 currency、缺金额、token 用量、网关 usage.id、负数、空 payload —— 都不认（不猜、不按 0）
  assert.equal(reportedCost({usage:{amount:3}}),null);
  assert.equal(reportedCost({usage:{id:'backup-usage'}}),null);
  assert.equal(reportedCost({data:{usage:{prompt_tokens:5,completion_tokens:6}}}),null);
  assert.equal(reportedCost({usage:{amount:-1,currency:'CNY'}}),null);
  assert.equal(reportedCost(null),null);
  const { providerSelectionForModality } = await load('apps/server/src/routes/aiGeneration.js');
  const { normalizeAiProviderPolicy } = await load('apps/server/src/routes/billingConfig.js');
  const policy = normalizeAiProviderPolicy(JSON.stringify({ channels: [
    { id:'a', provider:'custom', endpoint:'https://primary.test/v1', model:'one', models:['one','two'] },
    { id:'b', provider:'custom', endpoint:'https://backup.test/v1', model:'default-backup', models:['default-backup','mapped-backup'], modelCosts:{'mapped-backup':9} }
  ], modalityChannels:{TEXT:'a'}, modelRoutes:[{modality:'TEXT',channelId:'a',model:'two',backupChannelId:'b',backupModel:'mapped-backup'}] }));
  const selected = providerSelectionForModality(policy,'TEXT','two');
  assert.equal(selected.model,'two'); assert.equal(selected.backup.model,'mapped-backup'); assert.equal(selected.backup.estimatedCostFen,9);
  assert.equal(providerSelectionForModality(policy,'TEXT','one').backup,undefined);
  calls = [];
  globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body).model); return String(url).includes('primary') ? json({error:'limited'},429) : json({choices:[{message:{content:'mapped'}}]}); };
  provider = getGenerationProvider(selected); await provider.generate({modality:'TEXT'});
  assert.deepEqual(calls,['two','mapped-backup']);
  assert.equal(provider.compute.saleSnapshot.model,'two');
  console.log('PASS: per-model mapping normalization, distinct main models, mapped backup request and per-model cost');
  console.log('PASS: failover, model and sale snapshot, unknown/estimated cost, network ambiguity, submitted job, stream output, gateway isolation, secret exclusion');
} finally { globalThis.fetch = originalFetch; }
