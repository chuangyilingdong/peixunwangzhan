/**
 * P152 招生军师十六期：原版「内容计划」方案卡（renderPlans）。
 *
 * 用户口径（2026-10-25 交接）：
 *   ① 聊天创作流能产出方案卡；
 *   ② 方案卡可查看 / 修改 / 复制 / 移除 / 导出文稿；
 *   ③ 确认制作前有预检（缺素材拦住、提示词可见、版本乐观锁）；
 *   ④ 确认制作创建视频任务并生成编导稿，不在这一步直接扣视频渲染费。
 *
 * ⚠️ 真起服务、真走 HTTP：方案表、消息挂 plan_id、聊天 SSE 的 plan 事件、
 *    预检/提交/导出、版本冲突，只看源码或只调函数都验不出来。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p152-plan-cards-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DB_DRIVER: 'sqlite',
  AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('① 源码口径（方案卡/预检/导出都在）');
{
  const schema = fs.readFileSync(path.join(root, 'packages/database/src/schema.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'apps/server/src/routes/junshiWorkbench.js'), 'utf8');
  const front = fs.readFileSync(path.join(root, 'apps/website/public/assets/junshi/workbench.js'), 'utf8');
  check('① 方案表 + 消息 plan_id 已进 schema', /junshi_workbench_plans/.test(schema) && /ADD COLUMN plan_id/.test(schema));
  check('① 后端有 /plans、preflight、submit、export、from-chat', ['/plans', "'preflight'", "'submit'", "'export'", '/plans/from-chat'].every((token) => route.includes(token)));
  check('① 前端有方案卡、编辑表单、预检、导出入口', ['创作方案', 'wb-plan-card', 'wb-plan-asset', 'openPlanPreflight', 'exportPlan'].every((token) => front.includes(token)));
  check('① 聊天消息能挂方案入口', /data-plan-open/.test(front) && /data-plan-from-chat/.test(front));
}

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const orgAdmin = await arow("SELECT id, org_id FROM users WHERE login='org-admin'");
assert.ok(orgAdmin, 'seed 里没有 org-admin');
const ownerKey = `org:${orgAdmin.org_id}`;
const at = new Date().toISOString();
await aq('INSERT INTO junshi_workbench_assets (id,owner_key,org_id,account_id,file_name,storage_key,storage_backend,mime_type,kind,file_size,folder,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ['jwa_p152_img', ownerKey, orgAdmin.org_id, 'default', '寒假班课堂照片.png', 'p152/test.png', 'local', 'image/png', 'image', 1, '测试素材', at]);

const port = 19092;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body, raw = false } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return response;
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null, code: payload?.error?.code || null };
}

try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ }
    await sleep(100);
  }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
  const token = login.data?.token;
  assert.ok(token, `登录失败：${JSON.stringify(login)}`);

  const basePlan = {
    title: '寒假班怎么选，家长最在意的三件事',
    objective: '让家长看完知道怎么选班，并愿意来问体验课',
    hook: '寒假班不是越贵越好，先看这三点。',
    script: '寒假班怎么选？第一看老师是否固定，第二看每天有没有练习反馈，第三看班级人数。想实地看看，评论区留「体验」。',
    prompt: '教培机构明亮的教室，老师面对镜头自然口播，镜头稳定，字幕跟随口播，画面干净。',
    duration: 15, resolution: '768P', ratio: '9:16', generateAudio: true,
    assetIds: ['jwa_p152_img'], missing: ['缺少学员出镜授权'], rationale: '家长选班时最怕信息不透明，用三条标准建立信任。',
    publishDate: '2026-11-01', accountId: 'default',
  };

  console.log('② 手动创建 + 列表 + 智能匹配素材');
  const created = await api('/api/junshi/workbench/plans', { method: 'POST', token, body: basePlan });
  const planId = created.data?.plan?.id;
  check('② 创建方案成功', created.status === 200 && Boolean(planId), JSON.stringify(created));
  check('② 初始版本 1、待确认、缺 1 项素材', created.data?.plan?.version === 1 && created.data?.plan?.status === 'draft' && created.data?.plan?.missing?.length === 1, JSON.stringify(created.data?.plan));
  let list = await api('/api/junshi/workbench/plans?accountId=default', { token });
  const listed = list.data?.items?.find((item) => item.id === planId);
  check('② 列表能读到方案', list.status === 200 && Boolean(listed), JSON.stringify(list.data?.items?.length));
  check('② 素材按标题关键词匹配出来（候选，不自动使用）', Boolean(listed?.materialRecommendations?.some((item) => item.assetId === 'jwa_p152_img')), JSON.stringify(listed?.materialRecommendations));

  console.log('③ 版本乐观锁');
  const stale = await api(`/api/junshi/workbench/plans/${planId}`, { method: 'PUT', token, body: { ...basePlan, version: 99 } });
  check('③ 旧版本保存被拒（WORKBENCH_PLAN_VERSION_CONFLICT）', stale.status === 400 && stale.code === 'WORKBENCH_PLAN_VERSION_CONFLICT', JSON.stringify(stale));
  const updated = await api(`/api/junshi/workbench/plans/${planId}`, { method: 'PUT', token, body: { ...basePlan, missing: [], version: 1 } });
  check('③ 正确版本保存成功，版本 +1', updated.status === 200 && updated.data?.plan?.version === 2 && updated.data?.plan?.missing?.length === 0, JSON.stringify(updated));

  console.log('④ 预检 + 缺素材拦截');
  const preflight = await api(`/api/junshi/workbench/plans/${planId}/preflight`, { token });
  check('④ 预检返回提示词和计费秒数', preflight.status === 200 && preflight.data?.outputSeconds === 15 && /口播：/.test(preflight.data?.prompt || ''), JSON.stringify({ status: preflight.status, prompt: preflight.data?.prompt }));
  check('④ 预检明确「这一步不扣视频渲染费」', /不会在这一步直接扣费/.test(preflight.data?.notice || ''), preflight.data?.notice);
  const blockedPlan = await api('/api/junshi/workbench/plans', { method: 'POST', token, body: { ...basePlan, title: '缺素材的方案', missing: ['缺少门店实拍'] } });
  const blockedId = blockedPlan.data?.plan?.id;
  const blocked = await api(`/api/junshi/workbench/plans/${blockedId}/submit`, { method: 'POST', token, body: { version: 1, confirm: true } });
  check('④ 缺素材时提交被拒（WORKBENCH_PLAN_MISSING_MATERIALS）', blocked.status === 400 && blocked.code === 'WORKBENCH_PLAN_MISSING_MATERIALS', JSON.stringify(blocked));

  console.log('⑤ 确认制作 → 创建视频任务 → 编导稿');
  const submitted = await api(`/api/junshi/workbench/plans/${planId}/submit`, { method: 'POST', token, body: { version: 2, confirm: true } });
  const workId = submitted.data?.work?.id;
  check('⑤ 提交成功并返回视频任务', submitted.status === 200 && submitted.data?.plan?.status === 'submitted' && Boolean(workId), JSON.stringify(submitted));
  let work = null;
  for (let i = 0; i < 80; i += 1) {
    const detail = await api(`/api/junshi/workbench/video/works/${workId}`, { token });
    work = detail.data?.work || null;
    if (work && ['draft', 'failed'].includes(work.status)) break;
    await sleep(150);
  }
  check('⑤ 编导稿生成完成（本地模拟）', work?.status === 'draft' && Array.isArray(work?.directorScript?.shots) && work.directorScript.shots.length > 0, JSON.stringify({ status: work?.status, error: work?.error }));
  check('⑤ 视频任务保留方案标题并记录 planId', work?.title === basePlan.title && work?.planId === planId, JSON.stringify({ title: work?.title, planId: work?.planId }));
  check('⑤ 视频任务保留了方案的参考素材', Array.isArray(work?.assetRefs) && work.assetRefs.some((item) => item.assetId === 'jwa_p152_img'), JSON.stringify(work?.assetRefs));
  const editSubmitted = await api(`/api/junshi/workbench/plans/${planId}`, { method: 'PUT', token, body: { ...basePlan, version: 2 } });
  check('⑤ 已提交方案不能再改（WORKBENCH_PLAN_SUBMITTED）', editSubmitted.status === 400 && editSubmitted.code === 'WORKBENCH_PLAN_SUBMITTED', JSON.stringify(editSubmitted));

  console.log('⑥ 导出文稿 / 移除');
  const exported = await api(`/api/junshi/workbench/plans/${planId}/export`, { token, raw: true });
  const markdown = await exported.text();
  check('⑥ 导出 Markdown 且带方案正文', exported.status === 200 && /text\/markdown/.test(exported.headers.get('content-type') || '') && markdown.includes('# 内容方案 · 寒假班怎么选') && markdown.includes('## 完整口播脚本'), markdown.slice(0, 120));
  const removed = await api(`/api/junshi/workbench/plans/${blockedId}`, { method: 'DELETE', token });
  const afterDelete = await api('/api/junshi/workbench/plans?accountId=default', { token });
  check('⑥ 移除方案成功且列表少一条', removed.status === 200 && afterDelete.data?.items?.length === 1, JSON.stringify({ removed, count: afterDelete.data?.items?.length }));

  console.log('⑦ 聊天自动提炼方案（SSE plan 事件）');
  const response = await fetch(`http://127.0.0.1:${port}/api/junshi/workbench/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: '帮我做一条 15 秒视频，讲寒假班怎么选', accountId: 'default', tier: 'fast', attachments: [] }),
  });
  const sse = await response.text();
  const events = sse.split('\n').filter((line) => line.startsWith('event: ')).map((line) => line.slice(7).trim());
  check('⑦ 聊天正常结束并发出 plan 事件', response.status === 200 && events.includes('done') && events.includes('plan'), JSON.stringify(events));
  const planPayloadLine = sse.split('\n\n').find((block) => block.startsWith('event: plan\n'));
  let chatPlan = null;
  try { chatPlan = JSON.parse((planPayloadLine || '').split('\ndata: ')[1] || 'null')?.plan || null; } catch { /* ignore */ }
  check('⑦ 自动生成的方案字段完整', chatPlan?.title && chatPlan?.script && chatPlan?.prompt && chatPlan?.source === 'chat', JSON.stringify(chatPlan));
  const chat = await api('/api/junshi/workbench/chat', { token });
  const assistantWithPlan = (chat.data?.messages || []).filter((item) => item.role === 'assistant' && item.plan).pop();
  check('⑦ 刷新聊天后消息仍带方案（plan_id 已落库）', Boolean(assistantWithPlan?.plan?.id), JSON.stringify(assistantWithPlan?.plan?.title));

  console.log('⑧ 手动「整理成制作方案」');
  const plain = await fetch(`http://127.0.0.1:${port}/api/junshi/workbench/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: '给我 3 个今天能拍的选题', accountId: 'default', tier: 'fast', attachments: [] }),
  });
  await plain.text();
  const chatAgain = await api('/api/junshi/workbench/chat', { token });
  const plainAssistant = (chatAgain.data?.messages || []).filter((item) => item.role === 'assistant' && !item.plan).pop();
  const manual = await api('/api/junshi/workbench/plans/from-chat', { method: 'POST', token, body: { messageId: plainAssistant?.id, accountId: 'default' } });
  check('⑧ 普通回答可一键整理成方案', manual.status === 200 && manual.data?.plan?.source === 'chat', JSON.stringify(manual));
  const manualAgain = await api('/api/junshi/workbench/plans/from-chat', { method: 'POST', token, body: { messageId: plainAssistant?.id, accountId: 'default' } });
  check('⑧ 同一回答重复整理不产生第二份', manualAgain.status === 200 && manualAgain.data?.plan?.id === manual.data?.plan?.id, JSON.stringify({ first: manual.data?.plan?.id, second: manualAgain.data?.plan?.id }));
} catch (error) {
  failures += 1;
  console.log(`  ✗ 验收异常 — ${error?.stack || error}`);
  if (serverLog) console.log(serverLog.slice(-3000));
} finally {
  server.kill();
  await sleep(300);
  if (failures) process.exitCode = 1;
  else console.log('\nP152 全部通过');
}
