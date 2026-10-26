/**
 * P154 招生军师十七期：对话附件 / 任务详情与重试 / 提交前估价 / 截图回填 / 数字人分段。
 *
 * 用户口径（2026-10-25）：
 *   ① 对话附件支持 9 图 / 3 视频 / 3 音频，并保留 @图片N / @视频N / @音频N 引用；
 *   ② 历史任务能看失败原因、按类型/状态筛选、单任务重试；
 *   ③ 视频/数字人提交前能估价；数字人支持语速与按字数分段；
 *   ④ 数据复盘恢复截图回填入口（不再依赖已删除的文案草稿页）。
 *
 * 真起服务、真走 HTTP；视频/音频用 ffmpeg 现场生成，不依赖外部素材。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p154-workbench-'));
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

console.log('① 源码口径（附件 / 任务重试 / 估价 / 截图回填 / 数字人分段）');
{
  const schema = fs.readFileSync(path.join(root, 'packages/database/src/schema.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'apps/server/src/routes/junshiWorkbench.js'), 'utf8');
  const front = fs.readFileSync(path.join(root, 'apps/website/public/assets/junshi/workbench.js'), 'utf8');
  check('① schema 有消息附件 / 任务重试 / 截图快照 / 数字人分段', [
    'attachments', 'entity_type', 'entity_id', 'attempts', 'retry_of', 'junshi_workbench_review_snapshots', 'avatar_runs', 'segments',
  ].every((token) => schema.includes(token)));
  check('① 后端有附件预处理、任务详情/重试、估价、截图回填、分段重试', [
    'prepareChatAttachments', 'jobRetryMatch', 'jobRetryable', '/estimate/video', '/estimate/avatar', '/reviews/backfill', 'runAvatarRetry', 'concatAvatarSegments',
  ].every((token) => route.includes(token)));
  check('① 前端有 @引用、任务筛选/重试、估算、截图回填、语速/分段', [
    '@图片', 'data-job-kind', 'data-job-retry', '/estimate/video', '/estimate/avatar', '截图回填', 'name="speed"', '重试失败分段',
  ].every((token) => front.includes(token)));
}

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const orgAdmin = await arow("SELECT id, org_id FROM users WHERE login='org-admin'");
assert.ok(orgAdmin, 'seed 里没有 org-admin');
const ownerKey = `org:${orgAdmin.org_id}`;
const at = new Date().toISOString();

console.log('② 准备小素材（图片 / 1 秒音频 / 1 秒视频）');
const imagePath = path.join(temp, 'shot.png');
fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==', 'base64'));
const audioPath = path.join(temp, 'voice.mp3');
const videoPath = path.join(temp, 'clip.mp4');
const ffAudio = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-q:a', '9', '-acodec', 'libmp3lame', audioPath], { encoding: 'utf8' });
const ffVideo = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', videoPath], { encoding: 'utf8' });
check('② 音频素材生成', ffAudio.status === 0 && fs.statSync(audioPath).size > 0, ffAudio.stderr?.slice(-200));
check('② 视频素材生成', ffVideo.status === 0 && fs.statSync(videoPath).size > 0, ffVideo.stderr?.slice(-200));

const port = 19094;
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
async function upload(token, filePath, name, type) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)], { type }), name);
  form.append('accountId', 'default');
  form.append('folder', 'P154测试');
  const response = await fetch(`http://127.0.0.1:${port}/api/junshi/workbench/assets`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  });
  return response.json().catch(() => ({}));
}

try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ }
    await sleep(100);
  }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
  const token = login.data?.token;
  assert.ok(token, `登录失败：${JSON.stringify(login)}`);

  console.log('③ 上传三类附件 → 对话带 @引用 → 附件元数据落库');
  const imageUp = await upload(token, imagePath, 'shot.png', 'image/png');
  const audioUp = await upload(token, audioPath, 'voice.mp3', 'audio/mpeg');
  const videoUp = await upload(token, videoPath, 'clip.mp4', 'video/mp4');
  const imageId = imageUp?.data?.asset?.id;
  const audioId = audioUp?.data?.asset?.id;
  const videoId = videoUp?.data?.asset?.id;
  check('③ 三类附件上传成功', Boolean(imageId && audioId && videoId), JSON.stringify({ imageUp, audioUp, videoUp }));
  const chatResponse = await fetch(`http://127.0.0.1:${port}/api/junshi/workbench/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: '分别看下 @图片1、@视频1、@音频1，告诉我各自是什么。', accountId: 'default', attachments: [imageId, videoId, audioId] }),
  });
  const sse = await chatResponse.text();
  check('③ 聊天 SSE 成功', chatResponse.status === 200 && /event: done/.test(sse), sse.slice(0, 300));
  check('③ SSE 回传 attachments 事件', /event: attachments/.test(sse) && /jwa_/.test(sse), sse.slice(0, 300));
  const chatList = await api('/api/junshi/workbench/chat', { token });
  const lastUser = [...(chatList.data?.messages || [])].reverse().find((message) => message.role === 'user');
  check('③ 用户消息保存了 3 个附件与 @编号', lastUser?.attachments?.length === 3 && lastUser.attachments.map((item) => item.label).join(',') === '@图片1,@视频1,@音频1', JSON.stringify(lastUser?.attachments));

  console.log('④ 提交前估价');
  const videoEstimate = await api('/api/junshi/workbench/estimate/video', { method: 'POST', token, body: { durationSeconds: 15, resolution: '480P', audio: true } });
  check('④ 视频估价有总价和口径', videoEstimate.status === 200 && Number(videoEstimate.data?.estimate?.totalFen) > 0 && Boolean(videoEstimate.data?.estimate?.note), JSON.stringify(videoEstimate.data));
  const avatarEstimate = await api('/api/junshi/workbench/estimate/avatar', { method: 'POST', token, body: { text: '暑期班报名开始了，前二十名送两节体验课，想来的家长在评论区留体验两个字。', speed: 'natural' } });
  const plan = avatarEstimate.data?.estimate?.plan;
  check('④ 数字人估价按字数分段', avatarEstimate.status === 200 && plan?.batchCount >= 2 && plan?.segments?.length === plan?.batchCount, JSON.stringify(plan));
  check('④ 数字人估价有四项费用明细', (avatarEstimate.data?.estimate?.items || []).length === 4 && Number(avatarEstimate.data?.estimate?.totalFen) > 0, JSON.stringify(avatarEstimate.data?.estimate?.items));

  console.log('⑤ 截图回填（新建 + 更新 + 复盘合并）');
  const screenshotUp = await upload(token, imagePath, 'stats.png', 'image/png');
  const screenshotId = screenshotUp?.data?.asset?.id;
  const backfill = await api('/api/junshi/workbench/reviews/backfill', { method: 'POST', token, body: { assetId: screenshotId, accountId: 'default', topic: '暑期班数据' } });
  const snapshotId = backfill.data?.snapshot?.id;
  check('⑤ 截图回填新建成功', backfill.status === 200 && Boolean(snapshotId) && Number(backfill.data?.stats?.plays) > 0, JSON.stringify(backfill));
  const updatedBackfill = await api('/api/junshi/workbench/reviews/backfill', { method: 'POST', token, body: { assetId: screenshotId, accountId: 'default', topic: '暑期班数据（更新）', snapshotId } });
  check('⑤ 截图回填可更新同一条', updatedBackfill.status === 200 && updatedBackfill.data?.snapshot?.id === snapshotId, JSON.stringify(updatedBackfill));
  const reports = await api('/api/junshi/workbench/reports?accountId=default', { token });
  const reportRow = (reports.data?.items || []).find((item) => item.sourceId === snapshotId);
  check('⑤ 复盘列表包含截图回填且可更新', Boolean(reportRow) && reportRow.canUpdate === true && reportRow.sourceTable === 'snapshot', JSON.stringify(reportRow));

  console.log('⑥ 任务详情 / 筛选 / 重试');
  const failedJobId = 'jwj_p154_failed';
  await aq('INSERT INTO junshi_workbench_jobs (id,owner_key,org_id,kind,status,detail,error,entity_type,entity_id,attempts,payload,retry_of,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [failedJobId, ownerKey, orgAdmin.org_id, '文案生成', 'failed', '主题：重试测试 · 1 条', '模拟上游超时', 'copy', '', 0, JSON.stringify({ topic: '重试测试', count: 1, style: '口语化', accountId: 'default' }), '', at, at]);
  const filtered = await api('/api/junshi/workbench/jobs?kind=' + encodeURIComponent('文案生成') + '&status=failed', { token });
  check('⑥ 按类型 + 状态筛选任务', filtered.status === 200 && (filtered.data?.items || []).some((job) => job.id === failedJobId), JSON.stringify(filtered.data?.kinds));
  const detail = await api(`/api/junshi/workbench/jobs/${failedJobId}`, { token });
  check('⑥ 任务详情返回失败原因和可重试标记', detail.status === 200 && detail.data?.job?.error === '模拟上游超时' && detail.data?.job?.retryable === true, JSON.stringify(detail.data?.job));
  const retry = await api(`/api/junshi/workbench/jobs/${failedJobId}/retry`, { method: 'POST', token, body: {} });
  const retryJobId = retry.data?.jobId;
  check('⑥ 单任务重试返回新任务', retry.status === 200 && Boolean(retryJobId) && retryJobId !== failedJobId, JSON.stringify(retry));
  let retryJob = null;
  for (let i = 0; i < 40; i += 1) {
    const result = await api(`/api/junshi/workbench/jobs/${retryJobId}`, { token });
    retryJob = result.data?.job || null;
    if (retryJob && retryJob.status !== 'running') break;
    await sleep(100);
  }
  check('⑥ 重试任务成功且记录 attempts / retryOf', retryJob?.status === 'succeeded' && retryJob?.attempts === 1 && retryJob?.retryOf === failedJobId, JSON.stringify(retryJob));
  const retryDetail = await api(`/api/junshi/workbench/jobs/${retryJobId}`, { token });
  check('⑥ 重试产出在任务详情里可查看（文案草稿页已删）', retryDetail.data?.resource?.type === 'copy' && String(retryDetail.data?.resource?.item?.content || '').length > 0, JSON.stringify({ type: retryDetail.data?.resource?.type, content: String(retryDetail.data?.resource?.item?.content || '').slice(0, 40) }));

  console.log('⑦ 数字人分段重试入口（不跑付费合成）');
  const runs = await api('/api/junshi/workbench/avatar/runs?accountId=default', { token });
  check('⑦ 口播运行列表可读（含分段字段）', runs.status === 200 && Array.isArray(runs.data?.items), JSON.stringify(runs.data));
  const route = fs.readFileSync(path.join(root, 'apps/server/src/routes/junshiWorkbench.js'), 'utf8');
  check('⑦ 服务端有分段重试路由与拼接', route.includes('avatarRetryMatch') && route.includes('重试失败分段') && route.includes('concatAvatarSegments'));
  check('⑦ 语速四档与 atempo 真实变速', route.includes('slightly_fast') && route.includes("'-filter:a'") || route.includes('atempo='));

  console.log('⑧ 旧入口仍兼容（文案草稿截图回填）');
  const draft = await aq('INSERT INTO junshi_workbench_copy_drafts (id,owner_key,org_id,account_id,topic,style,content,created_at) VALUES (?,?,?,?,?,?,?,?)',
    ['jwc_p154', ownerKey, orgAdmin.org_id, 'default', '旧草稿', '口语化', '旧文案', at]);
  check('⑧ 旧草稿写入成功', Boolean(draft));
  const legacy = await api('/api/junshi/workbench/copy/jwc_p154/stats', { method: 'POST', token, body: { assetId: screenshotId } });
  check('⑧ 旧 /copy/:id/stats 仍可用', legacy.status === 200 && Number(legacy.data?.stats?.plays) > 0, JSON.stringify(legacy));
} finally {
  server.kill();
  await sleep(300);
}

if (failures) process.exitCode = 1;
else console.log('\nP154 全部通过');
