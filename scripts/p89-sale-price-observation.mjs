// P89：对外售价观测（2026-09-13）
//   ① 配置可存可读（服务 + admin PUT），audit 明确标注 OBSERVATION_ONLY；
//   ② 调用时把「按当时公告价算出的售价」写进 compute_attempts.sale_price_fen / sale_snapshot；
//   ③ 改价不追溯：已落库的售价保持写入时的值，只有新调用用新价；
//   ④ 学生扣费恒 0：usage_records.cost_fen / credits_charged 与售价无关，永远为 0。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p89-sale-price-observation-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_API_KEY = 'p89-test-only';

const load = (p) => import(pathToFileURL(path.resolve(root, p)).href);
const { row, rows, q } = await load('apps/server/src/lib.js');
const { getComputePricing, saveComputePricing, priceFenFor } = await load('apps/server/src/services/computePool.js');
const { getGenerationProvider } = await load('apps/server/src/services/generationProvider.js');
const { recordAiUsage } = await load('apps/server/src/services/creditUsage.js');
const { handleOverview } = await load('apps/server/src/routes/admin/overview.js');

const nowIso = new Date().toISOString();
q('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ['org-p89', 'P89 Org', 'ACTIVE', nowIso, new Date(Date.now() + 86400000).toISOString(), 0, nowIso, nowIso]);

/* ① 配置可存可读（服务层） */
saveComputePricing({ perCall: { TEXT: 37, IMAGE: 137 }, models: { 'p89-model': 250 } });
const pricing = getComputePricing();
assert.equal(pricing.perCall.TEXT, 37, 'saved TEXT base price reads back');
assert.equal(pricing.perCall.IMAGE, 137, 'saved IMAGE base price reads back');
assert.equal(pricing.perCall.VIDEO, 500, '未填的模态保留默认价，不被清零');
assert.equal(pricing.models['p89-model'], 250, 'model override reads back');

/* ① 配置可存可读（admin PUT 路由）+ audit 标注 OBSERVATION_ONLY */
const adminAuth = { user: { id: 'p89-admin', login: 'root', role: 'SUPER_ADMIN', permissions: ['ADMIN_CONTENT'] }, rawUser: { permissions: '["ADMIN_CONTENT"]' }, session: null };
const put = (body) => handleOverview({ pathname: '/api/admin/compute-pricing', method: 'PUT', search: new URLSearchParams(''), body, auth: adminAuth, req: { socket: { remoteAddress: '127.0.0.1' } } }, '/compute-pricing', 'PUT');
const saved = await put({ perCall: { TEXT: 40 }, models: { 'p89-model': 300 } });
assert.equal(saved.baseline, 'OBSERVATION_ONLY', 'PUT response declares observation-only baseline');
assert.equal(saved.pricing.models['p89-model'], 300, 'PUT persists model override');
assert.equal(saved.pricing.perCall.TEXT, 40, 'PUT persists modality base price');
const auditRow = row("SELECT after_data FROM audit_logs WHERE action='COMPUTE_PRICING_UPDATE' ORDER BY created_at DESC LIMIT 1");
assert.match(String(auditRow?.after_data || ''), /OBSERVATION_ONLY/, 'audit marks COMPUTE_PRICING_UPDATE as OBSERVATION_ONLY');

/* ② 调用写入对外售价快照：sale_price_fen = 当时售价，sale_snapshot 观测口径 */
const originalFetch = globalThis.fetch;
const selection = { provider: 'custom', model: 'p89-model', endpoint: 'https://p89.test/v1', channelId: 'p89-channel', apiKey: 'p89-test-only' };
const calls = [];
try {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ id: 'p89-response', usage: { id: 'p89-usage' }, choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const first = getGenerationProvider(selection);
  await first.generate({ modality: 'TEXT' });
  const attempt1 = rows('SELECT * FROM compute_attempts WHERE call_id=?', [first.compute.callId])[0];
  assert.equal(attempt1.sale_price_fen, 300, 'sale_price_fen records the announced price at call time');
  const snapshot1 = JSON.parse(attempt1.sale_snapshot);
  assert.equal(snapshot1.unitFen, 300, 'sale_snapshot.unitFen mirrors the observed price');
  assert.equal(snapshot1.charged, false, 'sale_snapshot must never mark a student charge');
  assert.equal(snapshot1.baseline, 'OBSERVATION_ONLY', 'sale_snapshot declares observation-only baseline');

  /* ③ 改价不追溯：旧尝试保留写入时的价，新调用才用新价 */
  saveComputePricing({ perCall: { TEXT: 40 }, models: { 'p89-model': 999 } });
  const second = getGenerationProvider(selection);
  await second.generate({ modality: 'TEXT' });
  const attempt2 = rows('SELECT * FROM compute_attempts WHERE call_id=?', [second.compute.callId])[0];
  const attempt1After = rows('SELECT * FROM compute_attempts WHERE call_id=?', [first.compute.callId])[0];
  assert.equal(attempt1After.sale_price_fen, 300, 'changing the price must not rewrite historical sale_price_fen');
  assert.equal(JSON.parse(attempt1After.sale_snapshot).unitFen, 300, 'historical sale_snapshot is untouched');
  assert.equal(attempt2.sale_price_fen, 999, 'new calls use the new announced price');

  /* ④ 学生扣费恒 0：售价与上游成本都不进入学生账本 */
  recordAiUsage({
    orgId: 'org-p89', userId: 'student-p89', modality: 'TEXT', model: 'p89-model',
    status: 'SUCCESS', costFen: 999, pricing: { compute: first.compute, costFen: 999, charged: false },
  });
  const usage = row('SELECT * FROM usage_records ORDER BY created_at DESC LIMIT 1');
  assert.equal(Number(usage.cost_fen), 0, 'usage_records.cost_fen stays 0 regardless of the announced price');
  assert.equal(Number(usage.credits_charged), 0, 'usage_records.credits_charged stays 0');
  assert.equal(rows('SELECT COUNT(*) n FROM usage_records WHERE cost_fen<>0 OR credits_charged<>0')[0].n, 0, 'no student charge row may exist');
} finally {
  globalThis.fetch = originalFetch;
}

/* 价格函数口径：模型价优先，否则模态价 */
assert.equal(priceFenFor({ modality: 'TEXT', model: 'p89-model' }), 999);
assert.equal(priceFenFor({ modality: 'TEXT', model: 'p89-unlisted' }), 40);
assert.equal(priceFenFor({ modality: 'VIDEO' }), 500);

/* 界面：PricingPanel 必须可编辑、按渠道分组、并写清「对外价，不扣学生，不是上游成本」 */
const panelSource = fs.readFileSync(path.join(root, 'apps/admin/src/components/ComputePanels.jsx'), 'utf8');
assert.match(panelSource, /不扣学生/, 'PricingPanel must state the price does not charge students');
assert.match(panelSource, /不是上游成本/, 'PricingPanel must state the price is not upstream cost');
assert.match(panelSource, /api\.put\('admin\/compute-pricing'/, 'PricingPanel must PUT the pricing config');
assert.match(panelSource, /perCall/, 'PricingPanel must edit the modality base price');
assert.match(panelSource, /models/, 'PricingPanel must edit the per-model overrides');
assert.match(panelSource, /channels\.map/, 'PricingPanel must group overrides by channel');
assert.doesNotMatch(panelSource, /学生售价与积分限额已停用/, 'retired pricing notice must be gone');

console.log(JSON.stringify({
  name: 'sale-price-observation',
  checks: ['config-save-read', 'audit-observation-only', 'snapshot-write', 'price-not-retroactive', 'student-charge-always-zero', 'panel-copy'],
  upstreamCalls: calls.length,
}, null, 2));
console.log('P89 passed: 对外售价可存可读、audit 标注 OBSERVATION_ONLY、调用写入 sale_price_fen/sale_snapshot、改价不追溯、学生扣费恒 0、PricingPanel 可编辑并写清口径。');
