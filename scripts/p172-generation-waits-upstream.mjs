/**
 * P172 「上游没报错就一直等」守卫（2026-09-30 用户口径）。
 *
 * 用户口径原话：「图2是上游的耗时，图1出错，应该是除非上游真的报错，不然应该一直等到上游出结果。每个框体都一样。」
 * 现场实据：一条 15 秒的视频上游实际跑了 **425 秒**（耗时截图），而上游的耗时我们这边被当成"失败"——
 * 画布上写着「AI 服务响应超时」。根因是两处"到点判死"：
 *   ① 轮询循环里的 `const deadline = Date.now() + timeout`，且 `timeout` 被 `Math.min(300000,…)` 封在 5 分钟；
 *   ② 客户端 `canvasWorkspace.jsx` 的 `for (attempt < 150) { 等 2 秒 }` = 也是 5 分钟。
 *
 * 这条守卫钉四件事（前三条是"不再自己判死"，第四条是"别把判死的活儿弄丢"）：
 *   ① ⭐ **上游说还在跑就继续等**：夹具把单请求超时压到 **1 秒**、让上游 processing **3.6 秒**才给成品 ——
 *      必须**成功**（旧代码在 1 秒处就抛「AI 服务响应超时」，这条会红）；
 *   ② 上游**自己说失败** → 立刻抛，且带**上游给的原因**（不是笼统文案）、不继续等；
 *   ③ 上游**查不到这条任务**（404）→ 立刻抛，不按"瞬时错误"重试；4xx/内容安全同一条口径；
 *   ④ 瞬时抖动（502）→ 按退避重试，之后照样拿到成品（2026-09-21 那条口径没被这次改动弄丢）；
 *   ⑤ 兜底：上游**永远** processing 时，只由 `AI_PROVIDER_MAX_WAIT_MS` 收尾（默认 30 分钟，**不是** 5 分钟硬顶），
 *      且文案要说清"平台会继续按任务号找回"—— 任务号已在 compute_attempts.task_id，对账才是接盘的人；
 *   ⑥ 静态：客户端那两处 5 分钟上限已删、等待一律走 waitForGenerationJob。
 *
 * 跑法：node scripts/p172-generation-waits-upstream.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 临时数据目录：下面 import 服务端模块时，SQLite 驱动会在**导入期**建表 —— 不许碰仓库里的 data/platform.db。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p172-wait-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'test.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_API_KEY = 'test-only';
// 旧的"5 分钟硬顶"取的就是这个值（生产 300000）。这里压到 1 秒，用例①才好证明"到点了也不再走人"。
process.env.AI_PROVIDER_TIMEOUT_MS = '1000';
// 兜底（默认 30 分钟）按用例单独给：工厂参数 maxWaitMs 优先，这里给个不参与用例的值即可。
process.env.AI_PROVIDER_MAX_WAIT_MS = '1800000';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const load = (file) => import(pathToFileURL(path.resolve(file)).href);

const { openAiCompatibleProvider } = await load('apps/server/src/services/openaiCompatibleProvider.js');

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const TASK_ID = 'task_p172_wait';
const VIDEO_ASSET = 'https://p172.test/v1/files/p172.mp4';
const taskPayload = (status, extra = {}) => json({ id: TASK_ID, task: { status }, ...extra });
const succeeded = () => taskPayload('succeeded', { video_url: VIDEO_ASSET, mime_type: 'video/mp4' });

/** 假上游：POST 受理并回公共任务号；GET（查询）交给 `responder(pollNo)` 决定。 */
function fakeUpstream(responder) {
  const calls = [];
  return {
    calls,
    pollCount: () => calls.filter((call) => call.method === 'GET').length,
    fetch: async (url, init = {}) => {
      const method = String(init?.method || 'GET').toUpperCase();
      calls.push({ method, url: String(url) });
      if (method === 'POST') return json({ task_id: TASK_ID });
      return responder(calls.filter((call) => call.method === 'GET').length - 1);
    },
  };
}

/** 直接造适配器（不走 generationProvider 的选路）：这里要验的是**等待语义**，与渠道路由无关。 */
const makeProvider = (extra = {}) => openAiCompatibleProvider({
  name: 'p172', model: 'p172-model', endpoint: 'https://p172.test/v1', apiKey: 'test-only',
  timeoutMs: 1000, pollIntervalMs: 600, pollPaths: { VIDEO: '/v1/query/video_generation/{id}' }, ...extra,
});

const originalFetch = globalThis.fetch;
try {
  /* ───────── ① 上游还在跑 → 一直等（旧的"到点就走人"必须已经不存在） ───────── */
  {
    const started = Date.now();
    // 前 6 次查询都说 processing（≈3.6 秒，**远超** 1 秒的单请求超时），第 7 次给成品。
    const up = fakeUpstream((pollNo) => (pollNo < 6 ? taskPayload('processing') : succeeded()));
    globalThis.fetch = up.fetch;
    const result = await makeProvider({ maxWaitMs: 0 }).generate({ modality: 'VIDEO', prompt: '机甲 15 秒科幻动画' });
    const elapsed = Date.now() - started;
    check('① 上游跑了 3.6 秒才出片：拿到素材（旧的 1 秒硬顶下这条必红）',
      result.assets?.[0]?.assetUrl === VIDEO_ASSET, JSON.stringify(result.assets?.[0] || {}));
    check('① 确实等过了单请求超时（不是"第一次查询就成功"）', elapsed >= 3000, `elapsed=${elapsed}ms`);
    check('① 期间问了 7 次（提交 1 次 + 查询 7 次）', up.pollCount() === 7, `polls=${up.pollCount()}`);
  }

  /* ───────── ② 上游自己说失败 → 立刻抛，带上游原因 ───────── */
  {
    const up = fakeUpstream(() => json({ id: TASK_ID, task: { status: 'failed', fail_reason: '内容未通过安全策略' } }));
    globalThis.fetch = up.fetch;
    const error = await makeProvider({ maxWaitMs: 30000 }).generate({ modality: 'VIDEO', prompt: 'x' }).then(() => null, (e) => e);
    check('② 上游判失败 → 抛错（不假装成功）', Boolean(error), '没有抛错');
    check('② 错误里带上游给的原因', String(error?.message || '').includes('内容未通过安全策略'), String(error?.message || ''));
    check('② 只问了一次（"上游报错"不是"还没好"，不该继续等）', up.pollCount() === 1, `polls=${up.pollCount()}`);
  }

  /* ───────── ③ 查不到这条任务（404）→ 立刻抛，不按瞬时错误重试 ───────── */
  {
    const up = fakeUpstream(() => json({ message: 'task not found' }, 404));
    globalThis.fetch = up.fetch;
    const error = await makeProvider({ maxWaitMs: 30000 }).generate({ modality: 'VIDEO', prompt: 'x' }).then(() => null, (e) => e);
    check('③ 4xx（查不到任务）立刻抛，不当"瞬时抖动"重试', Boolean(error) && up.pollCount() === 1, `polls=${up.pollCount()} err=${error?.message || '无'}`);
  }

  /* ───────── ④ 瞬时抖动（502）→ 按退避重试，之后照样出片 ───────── */
  {
    const up = fakeUpstream((pollNo) => (pollNo < 2 ? json({ message: 'bad gateway' }, 502) : succeeded()));
    globalThis.fetch = up.fetch;
    const result = await makeProvider({ maxWaitMs: 30000 }).generate({ modality: 'VIDEO', prompt: 'x' });
    check('④ 两次 502 之后重试拿到素材（瞬时错误不判死）', result.assets?.[0]?.assetUrl === VIDEO_ASSET, JSON.stringify(result.assets?.[0] || {}));
    check('④ 一共查了 3 次（2 次失败 + 1 次成功）', up.pollCount() === 3, `polls=${up.pollCount()}`);
  }

  /* ───────── ⑤ 兜底：上游永远 processing ───────── */
  {
    const up = fakeUpstream(() => taskPayload('processing'));
    globalThis.fetch = up.fetch;
    const started = Date.now();
    const error = await makeProvider({ maxWaitMs: 1200, pollIntervalMs: 200 }).generate({ modality: 'VIDEO', prompt: 'x' }).then(() => null, (e) => e);
    const elapsed = Date.now() - started;
    check('⑤ 上游一直 processing → 到兜底上限才收（错误码 GENERATION_PROVIDER_TIMEOUT）',
      error?.code === 'GENERATION_PROVIDER_TIMEOUT', `${error?.code || '无错'} / ${error?.message || ''}`);
    check('⑤ 文案说清「平台会继续按任务号找回结果」', /任务号/.test(String(error?.message || '')), String(error?.message || ''));
    check('⑤ 兜底到点就收，不是傻等（1.2 秒起、5 秒内）', elapsed >= 1200 && elapsed < 5000, `elapsed=${elapsed}ms`);
  }

  /* ───────── ⑥ 静态：客户端那两处 5 分钟上限已删 ───────── */
  {
    const client = fs.readFileSync(path.join('packages', 'shared', 'src', 'canvasWorkspace.jsx'), 'utf8');
    // 只匹配**真实代码**（注释里还写着这段历史，见 waitForGenerationJob 的文档注释）。
    check('⑥ 客户端不再有「等 150 次 × 2 秒」的循环（5 分钟上限）', !/for \(let attempt = 0; attempt < 150/.test(client));
    check('⑥ 客户端等待走同一个 waitForGenerationJob（定义 1 处 + 调用 2 处）',
      (client.match(/waitForGenerationJob\(/g) || []).length >= 3, String((client.match(/waitForGenerationJob\(/g) || []).length));
    const config = fs.readFileSync(path.join('apps', 'server', 'src', 'config.js'), 'utf8');
    check('⑥ 兜底上限是环境变量可调的 AI_PROVIDER_MAX_WAIT_MS', /export const AI_PROVIDER_MAX_WAIT_MS/.test(config));
  }
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(failures, 0, `P172 有 ${failures} 条断言没过`);
console.log('PASS: 上游没报错就一直等（服务端轮询 + 客户端等待），只有上游真报错 / 兜底到点才收');
