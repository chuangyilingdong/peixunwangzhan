import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p84-compute-feedback-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'test.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_SECRET_FILE = path.join(temp, 'secrets.json');

const computePanels = fs.readFileSync(new URL('../apps/admin/src/components/ComputePanels.jsx', import.meta.url), 'utf8');
const billingPanels = fs.readFileSync(new URL('../apps/admin/src/components/BillingPanels.jsx', import.meta.url), 'utf8');
const modelCompute = fs.readFileSync(new URL('../apps/admin/src/pages/ModelCompute.jsx', import.meta.url), 'utf8');

assert.match(computePanels, /title="new-api 网关（可选）"/);
assert.match(computePanels, /未部署或未配置时请保持关闭/);
assert.match(computePanels, /平台会继续使用上面的直接渠道，不影响正常生成/);
assert.match(computePanels, /当前网关不接管视频和音乐/);
assert.match(computePanels, /真实结算金额未知/);
assert.match(computePanels, /expanded \? <>[\s\S]*new-api 地址/);
assert.doesNotMatch(computePanels, /admin\/compute-gateway\/(channels|tokens)/);
assert.doesNotMatch(modelCompute, /令牌管理|令牌分发/);

assert.match(billingPanels, /<summary>平台路由策略<\/summary>/);
assert.doesNotMatch(billingPanels, /逐模型主备路由/);
assert.match(billingPanels, /搜索渠道或模型/);
assert.match(billingPanels, /用户可选模型/);
assert.match(billingPanels, /视频和音乐仍按这里的直接渠道执行/);
assert.match(billingPanels, /<details className="top-gap"><summary>高级配置<\/summary>[\s\S]*接口协议[\s\S]*手动添加模型 ID/);

const { applyGatewayRoute, resolveGenerationRoute, saveComputeGatewayConfig } = await import('../apps/server/src/services/computeGateway.js');
saveComputeGatewayConfig({ baseUrl: '', enabled: false });
const direct = await resolveGenerationRoute({ orgId: 'org-p84', studentId: 'student-p84', modality: 'TEXT' });
assert.deepEqual(direct, { mode: 'direct', reason: 'GATEWAY_DISABLED' });
const providerSelection = { provider: 'custom', channelId: 'direct-a', model: 'model-a', endpoint: 'https://upstream.test/v1' };
assert.deepEqual(await applyGatewayRoute(providerSelection, { studentId: 'student-p84', modality: 'TEXT' }), providerSelection);

console.log('p84 passed: compute UI wording/collapse/search guards and disabled gateway keeps direct provider routing.');
