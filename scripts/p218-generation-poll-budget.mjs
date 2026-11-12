/**
 * P218 生成热路径降载守卫（2026-11-12）。
 *
 * 钉住三件事：
 *   ① 画布详情轮询：页面隐藏时挂起、间隔按等待时长 2s → 3s → 5s 退避；
 *   ② 列表/课堂状态轮询：隐藏页面不发请求，回前台立即恢复；
 *   ③ 网关请求不再先跑 resolveAuth（只认 runtime key，路由里不读 ctx.auth）。
 *
 * 跑法：node scripts/p218-generation-poll-budget.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const read = (file) => stripComments(fs.readFileSync(path.join(root, file), 'utf8'));

const canvas = read('packages/shared/src/canvasWorkspace.jsx');
const index = read('apps/server/src/index.js');
const gateway = read('apps/server/src/routes/runtimeGateway.js');

/* ── ① 详情轮询：可见性 + 自适应间隔 ── */
check('详情轮询有可见性工具 pageHidden/waitForPageVisible',
  canvas.includes('function pageHidden()') && canvas.includes('function waitForPageVisible()'));
check('详情轮询按等待时长退避（2s/3s/5s）',
  /function generationPollDelayMs\(elapsedMs\) \{[\s\S]*?return 2000;[\s\S]*?return 3000;[\s\S]*?return 5000;/.test(canvas));
check('waitForGenerationJob 隐藏时挂起、不再用固定 2s',
  /while \(pageHidden\(\)\) await waitForPageVisible\(\);/.test(canvas)
  && !/setTimeout\(resolve, 2000\)/.test(canvas));
check('详情轮询只由 SUCCEEDED/FAILED 结束（语义未变）',
  /return job;/.test(canvas) && /'SUCCEEDED', 'FAILED'/.test(canvas));

/* ── ② 列表 / 课堂状态：隐藏页面不发请求 ── */
check('列表轮询跳过隐藏页面', /if \(!pageHidden\(\)\) generations\.refresh\(\)/.test(canvas));
check('回到前台立即 refresh 一次', /visibilitychange', onVisibility/.test(canvas));
check('课堂状态轮询跳过隐藏页面', /async function checkSession\(\) \{[\s\S]*?if \(pageHidden\(\)\) return;/.test(canvas));

/* ── ③ 网关跳过 resolveAuth ── */
check('index.js 对 /api/gateway/ 跳过 resolveAuth',
  /context\.pathname\.startsWith\('\/api\/gateway\/'\)[\s\S]*?\{ auth: null, error: null \}[\s\S]*?: await resolveAuth/.test(index));
check('runtimeGateway 仍然不依赖 ctx.auth（跳过鉴权是安全的）', !gateway.includes('ctx.auth'));

if (failures) {
  console.error(`P218 FAILED: ${failures} 项`);
  process.exit(1);
}
console.log('P218 passed: 生成轮询后台暂停/自适应退避，网关跳过无用 session 解析');
