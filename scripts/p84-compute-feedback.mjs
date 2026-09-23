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

// 2026-09-18：算力网关（new-api）的 UI 整块下线（用户口径：生产未启用，留在页面上只会让人以为要配）。
// 原先这里断言 GatewayPanel 的文案与折叠结构（title="new-api 网关（可选）" / 未部署或未配置时请保持关闭 /
// 平台会继续使用上面的直接渠道 / 当前网关不接管视频和音乐 / 真实结算金额未知 / expanded ? <> new-api 地址），
// 随界面删除一并下线 —— 这是口径变更，不是测试漂移。网关**后端**的行为断言（本文件下半部分）一条没动。
assert.doesNotMatch(computePanels, /new-api 网关（可选）/, '算力网关 UI 已下线，不许加回来');
assert.doesNotMatch(modelCompute, /令牌管理|令牌分发/);

assert.match(billingPanels, /<summary>按模型指定渠道（可选/, '平台路由策略收在「③ 路由与开关」里（折叠）');
assert.doesNotMatch(billingPanels, /逐模型主备路由/);
assert.match(billingPanels, /搜索渠道或模型/);
assert.match(billingPanels, /用户可选模型/);
// 2026-09-18：原断言「视频和音乐仍按这里的直接渠道执行」是网关时代的说明（网关只管 TEXT/IMAGE），
// 网关 UI 下线后这句话没有指代对象了；换成同一块里真正要人记住的选路优先级。
assert.match(billingPanels, /精确路由（按模型）&gt; 模态主渠道 &gt; 默认渠道/, '必须写明选渠道的优先级');
assert.match(billingPanels, /<details className="top-gap"><summary>高级配置<\/summary>[\s\S]*接口协议[\s\S]*手动添加模型 ID/);

const { applyGatewayRoute, resolveGenerationRoute, saveComputeGatewayConfig } = await import('../apps/server/src/services/computeGateway.js');
await saveComputeGatewayConfig({ baseUrl: '', enabled: false });
const direct = await resolveGenerationRoute({ orgId: 'org-p84', studentId: 'student-p84', modality: 'TEXT' });
assert.deepEqual(direct, { mode: 'direct', reason: 'GATEWAY_DISABLED' });
const providerSelection = { provider: 'custom', channelId: 'direct-a', model: 'model-a', endpoint: 'https://upstream.test/v1' };
assert.deepEqual(await applyGatewayRoute(providerSelection, { studentId: 'student-p84', modality: 'TEXT' }), providerSelection);

console.log('p84 passed: compute UI wording/collapse/search guards and disabled gateway keeps direct provider routing.');
