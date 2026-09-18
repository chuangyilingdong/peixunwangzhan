import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p79-soft-budget-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'test.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_SECRET_FILE = path.join(temp, 'secrets.json');
const { q, row, rows } = await import('../apps/server/src/lib.js');
const { getGenerationProvider } = await import('../apps/server/src/services/generationProvider.js');
// 2026-09-18：原先把 `assertComputePoolBudget`（恒不抛错的兼容桩）当"闸门"用 —— 那个桩在上一轮
// 「Phase 1 减法」里已删（它从没拦过任何人），本守卫因此从那时起就是红的。这是**口径变更，不是测试漂移**：
// 课堂平台预算（platform_budget_fen）本来就是**只预警、不拦人**，判定统一走 classroomBudgetStatus。
const { classroomBudgetStatus, lessonPlatformBudgetOverview } = await import('../apps/server/src/services/computePool.js');
const { recordAiUsage } = await import('../apps/server/src/services/creditUsage.js');
const { resolveGenerationRoute, saveComputeGatewayConfig, clearGatewayRouteCache, listGatewayTokens } = await import('../apps/server/src/services/computeGateway.js');
const originalFetch = globalThis.fetch;
const response = data => new Response(JSON.stringify(data), {headers:{'content-type':'application/json'}});
try {
  // Real adapter and upstream-shaped response, not the local-mock provider.
  q("INSERT INTO organizations(id,name,contract_start_at,contract_expires_at,created_at,updated_at) VALUES ('org-soft','Soft','2026-01-01','2030-01-01','2026-01-01','2026-01-01')");
  q("INSERT INTO users(id,org_id,login,display_name,role,password_hash,created_at,updated_at) VALUES ('student-soft','org-soft','soft','Soft','STUDENT','x','2026-01-01','2026-01-01')");
  q("INSERT INTO class_sessions(id,org_id,status,platform_budget_fen,created_at) VALUES ('soft-session','org-soft','ACTIVE',50,'2026-01-01')");
  let calls = 0;
  // 2026-09-18（口径变更）：成本只能来自「上游逐笔实扣(REPORTED)」或「合同单价×用量(COMPUTED)」，
  // 手填的 estimatedCostFen 那档已随 Phase 3 退役 —— 所以这里改成**合同单价 × 上游回传用量**，
  // 每次 100 万 input + 100 万 output × 30 分/百万 = 60 分/次（与旧断言里的 60 分/次同值）。
  globalThis.fetch = async () => { calls++; return response({choices:[{message:{content:'real adapter result'}}],usage:{prompt_tokens:1000000,completion_tokens:1000000}}); };
  const UNIT_PRICES = {TEXT:{inputFenPer1MTokens:30,outputFenPer1MTokens:30}};
  const selection = {provider:'custom',model:'soft-model',endpoint:'https://upstream.test/v1',apiKey:'private-only',upstreamUnitPrices:UNIT_PRICES};
  for (let n = 0; n < 2; n++) {
    const budget = classroomBudgetStatus('soft-session');
    assert.equal(budget.enforced,false);
    if(n) assert.equal(budget.budgetState,'OVER_BUDGET');
    const provider = getGenerationProvider(selection);
    await provider.generate({modality:'TEXT',computeContext:{sessionId:'soft-session',orgId:'forged-org',userId:'student-soft'}});
    recordAiUsage({orgId:'forged-org',userId:'student-soft',sessionId:'soft-session',modality:'TEXT',model:'soft-model',status:'SUCCESS',costFen:999999,pricing:{compute:provider.compute}});
  }
  assert.equal(calls,2, 'second call must reach upstream after 60 exceeds budget 50');
  assert.equal(classroomBudgetStatus('soft-session').knownCostFen,120);
  assert.equal(classroomBudgetStatus('soft-session').budgetState,'OVER_BUDGET');
  assert.ok(rows('SELECT * FROM usage_records').every(r=>r.org_id==='org-soft' && r.cost_fen===0 && r.credits_charged===0));
  assert.ok(rows('SELECT * FROM compute_attempts').every(r=>r.org_id==='org-soft' && r.class_session_id==='soft-session'));
  q("UPDATE class_sessions SET platform_budget_fen=500 WHERE id='soft-session'");
  // 没有合同单价 → 折不出成本 → UNKNOWN（**绝不按 0 计**）
  const unknown = getGenerationProvider({...selection,upstreamUnitPrices:null});
  await unknown.generate({modality:'TEXT',computeContext:{sessionId:'soft-session',userId:'student-soft'}});
  const status = classroomBudgetStatus('soft-session');
  assert.equal(status.budgetState,'UNKNOWN'); assert.equal(status.usedFen,null); assert.equal(status.knownCostFen,120);
  assert.equal(status.unknownCalls,1);
  assert.ok(!JSON.stringify(rows('SELECT * FROM compute_attempts')).includes('private-only'));
  const tokens = [{id:1,name:'学生:student-soft',key:'old-exhausted',unlimited_quota:false,remain_quota:0,status:1}];
  globalThis.fetch = async (url,options={}) => {
    if(String(url).endsWith('/api/user/login')) return response({data:{access_token:'admin-secret'}});
    if(options.method==='POST') {const body=JSON.parse(options.body);tokens.push({...body,id:2,key:'internal-secret',status:1});return response({success:true});}
    return response({data:{items:tokens}});
  };
  saveComputeGatewayConfig({enabled:true,baseUrl:'https://gateway.test'},{password:'admin-password'});
  const route = await resolveGenerationRoute({orgId:'org-soft',studentId:'student-soft',modality:'TEXT'});
  assert.equal(route.apiKey,'internal-secret'); assert.equal(tokens[1].unlimited_quota,true);
  assert.equal(tokens[1].model_limits_enabled,false);
  assert.ok(!JSON.stringify(await listGatewayTokens()).includes('internal-secret'));
  clearGatewayRouteCache();
  globalThis.fetch=async()=>{throw new Error('offline');};
  await assert.rejects(resolveGenerationRoute({orgId:'org-soft',studentId:'student-soft',modality:'TEXT'}),e=>e.code==='COMPUTE_GATEWAY_UNAVAILABLE');
  assert.ok(Array.isArray(lessonPlatformBudgetOverview()));
  console.log('PASS p79: over-budget still calls real adapter; no student debit; session attribution; unknown is not green; internal unlimited identity; no browser key; gateway failure never bypasses');
} finally {globalThis.fetch=originalFetch;}
