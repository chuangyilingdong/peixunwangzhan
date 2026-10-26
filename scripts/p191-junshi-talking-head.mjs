/**
 * P191 招生军师二十期：口播成片简易模式。
 *
 * 用户口径（2026-10-26）：
 *   视频四步里直接“写口播稿 → 选音色/形象照 → 合成 → 包装发布”，
 *   不再经过编导稿分镜；底层复用既有数字人分段对口型链路。
 *
 * 真起服务、真走 HTTP；不跑付费合成：
 *   - 创建/改稿/确认前检查走真实路由；
 *   - 合成结果用 syncTalkingHeadWork 造一条已完成记录，再验证第 4 步真实打包。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p191-talking-head-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');
const { syncTalkingHeadWork, buildTalkingHeadDirectorScript } = await import('../apps/server/src/services/junshiTalkingHead.js');

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

console.log('① 源码口径（表 / 路由 / 四步口播 / 迁移 46）');
{
  const schema = fs.readFileSync(path.join(root, 'packages/database/src/schema.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'apps/server/src/routes/junshiWorkbench.js'), 'utf8');
  const front = fs.readFileSync(path.join(root, 'apps/website/public/assets/junshi/workbench.js'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'apps/server/src/services/junshiTalkingHead.js'), 'utf8');
  const migration = path.join(root, 'deploy/production/migrate/46-junshi-workbench-talking-head-mysql.sql');
  check('① schema 有口播模式三列', ['production_mode', 'talking_head', 'avatar_run_id'].every((token) => schema.includes(token)));
  check('① 迁移 46 存在', fs.existsSync(migration));
  check('① 路由支持口播创建/改稿/确认回写', [
    "productionMode === 'talking_head'", 'resolveTalkingHeadDraft', 'prepareAvatarRun', 'createAvatarRun', 'syncTalkingHeadWork', '口播成片',
  ].every((token) => route.includes(token)));
  check('① 口播服务负责回写编导稿与成片', ['buildTalkingHeadDirectorScript', 'syncTalkingHeadWork', '数字人口播'].every((token) => service.includes(token)));
  check('① 前端有四步口播与分段预览', [
    'TALKING_HEAD_STEPS', 'renderTalkingHeadDraftCard', 'renderTalkingHeadScriptStep', 'renderTalkingHeadRenderStep',
    'data-wb-th-segments', 'save-talking-head', '口播稿与分段', '确认与合成',
  ].every((token) => front.includes(token)));
  const thScript = front.slice(front.indexOf('function renderTalkingHeadScriptStep'), front.indexOf('function renderTalkingHeadRenderStep'));
  check('① 口播稿步骤不渲染分镜卡', !thScript.includes('wbShotCard') && thScript.includes('不需要写分镜'));
  const built = buildTalkingHeadDirectorScript({
    title: '测试', text: '', segments: [{ status: 'done', text: '第一句', audioSeconds: 1.2 }], durationSeconds: 1.2,
  });
  check('① 分段可转包装字幕稿（时长=音频+0.12s）', built.shots.length === 1 && Math.abs(built.shots[0].seconds - 1.32) < 0.001, JSON.stringify(built));
}

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const orgAdmin = await arow("SELECT id, org_id FROM users WHERE login='org-admin'");
assert.ok(orgAdmin, 'seed 里没有 org-admin');
const ownerKey = `org:${orgAdmin.org_id}`;

console.log('② 准备形象照 / 音色样本 / 测试成片');
const imagePath = path.join(temp, 'face.png');
const audioPath = path.join(temp, 'voice.mp3');
const videoPath = path.join(temp, 'clip.mp4');
const ffImage = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x334155:s=512x512:d=1', '-frames:v', '1', imagePath], { encoding: 'utf8' });
const ffAudio = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-q:a', '9', '-acodec', 'libmp3lame', audioPath], { encoding: 'utf8' });
const ffVideo = spawnSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'color=c=0x1d4ed8:s=1080x1920:d=3',
  '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath,
], { encoding: 'utf8' });
check('② 形象照生成', ffImage.status === 0 && fs.statSync(imagePath).size > 0, ffImage.stderr?.slice(-200));
check('② 音色样本生成', ffAudio.status === 0 && fs.statSync(audioPath).size > 0, ffAudio.stderr?.slice(-200));
check('② 测试成片生成', ffVideo.status === 0 && fs.statSync(videoPath).size > 0, ffVideo.stderr?.slice(-200));

const port = 19097;
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
async function upload(token, filePath, name, type, folder) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)], { type }), name);
  form.append('accountId', 'default');
  form.append('folder', folder);
  const response = await fetch(`http://127.0.0.1:${port}/api/junshi/workbench/assets`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  });
  return response.json().catch(() => ({}));
}
async function download(token, assetId) {
  const response = await fetch(`http://127.0.0.1:${port}/api/junshi/workbench/assets/${encodeURIComponent(assetId)}/file`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
}

try {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ }
    await sleep(100);
  }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
  const token = login.data?.token;
  assert.ok(token, `登录失败：${JSON.stringify(login)}`);

  console.log('③ 上传素材 → 登记参考直出音色');
  const imageUp = await upload(token, imagePath, 'p191-face.png', 'image/png', 'P191测试');
  const audioUp = await upload(token, audioPath, 'p191-voice.mp3', 'audio/mpeg', 'P191测试');
  const videoUp = await upload(token, videoPath, 'p191-clip.mp4', 'video/mp4', 'P191测试');
  const imageId = imageUp?.data?.asset?.id;
  const audioId = audioUp?.data?.asset?.id;
  const videoId = videoUp?.data?.asset?.id;
  check('③ 三类素材上传成功', Boolean(imageId && audioId && videoId), JSON.stringify({ imageUp, audioUp, videoUp }));
  const voiceId = 'jwv2_p191_reference';
  const at = new Date().toISOString();
  await aq(
    'INSERT INTO junshi_workbench_voices (id,owner_key,org_id,account_id,name,speaker_id,status,error,sample_asset_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [voiceId, ownerKey, orgAdmin.org_id, 'default', 'P191 参考直出音色', 'reference', 'ready', '', audioId, at, at],
  );

  console.log('④ 创建口播任务 → 第 2 步改稿 → 确认前检查');
  const speech = '家长总说课程贵，先别急着解释价格。带孩子来上一节体验课，看他愿不愿意主动坐下来。';
  const created = await api('/api/junshi/workbench/video/works', {
    method: 'POST', token,
    body: {
      productionMode: 'talking_head', speech, voiceId, imageAssetId: imageId, speed: 'natural',
      type: 'ecommerce', subtype: '口播带货', accountId: 'default',
    },
  });
  const work = created.data?.work;
  const workId = work?.id;
  check('④ 创建成功且直接进入口播稿', created.status === 200 && work?.productionMode === 'talking_head' && work?.status === 'draft', JSON.stringify(created));
  assert.ok(workId, `口播任务创建失败，后续无法继续：${JSON.stringify(created)}`);
  check('④ 口播配置与分段计划返回', work?.talkingHead?.text === speech && work?.talkingHead?.plan?.batchCount >= 2, JSON.stringify(work?.talkingHead));
  check('④ 创建阶段没有生成编导稿分镜', !work?.directorScript, JSON.stringify(work?.directorScript));
  const list = await api('/api/junshi/workbench/video/works?accountId=default', { token });
  const listItem = (list.data?.items || []).find((item) => item.id === workId);
  check('④ 列表也带口播模式', listItem?.productionMode === 'talking_head' && listItem?.talkingHead?.plan?.batchCount >= 2, JSON.stringify(listItem?.productionMode));

  const newSpeech = '课程贵不贵，先看孩子愿不愿意来。体验课结束后，再一起决定要不要报名。';
  const updated = await api(`/api/junshi/workbench/video/works/${workId}`, {
    method: 'PUT', token, body: { talkingHead: { text: newSpeech } },
  });
  check('④ 改稿保存并重算分段', updated.status === 200 && updated.data?.work?.talkingHead?.text === newSpeech && updated.data?.work?.status === 'draft', JSON.stringify(updated));
  const emptyUpdate = await api(`/api/junshi/workbench/video/works/${workId}`, {
    method: 'PUT', token, body: { talkingHead: { text: '   ' } },
  });
  check('④ 空口播稿被拒绝', emptyUpdate.status === 400 && String(emptyUpdate.code || '').includes('VALIDATION'), JSON.stringify(emptyUpdate));

  const confirm = await api(`/api/junshi/workbench/video/works/${workId}/confirm`, { method: 'POST', token, body: {} });
  check('④ 渠道未配置时明确拒绝，不进入合成', confirm.status === 400 && confirm.code === 'WORKBENCH_AVATAR_NOT_CONFIGURED', JSON.stringify(confirm));
  const afterConfirm = await api(`/api/junshi/workbench/video/works/${workId}`, { token });
  check('④ 前置检查失败后任务仍是 draft', afterConfirm.data?.work?.status === 'draft' && !afterConfirm.data?.work?.avatarRunId, JSON.stringify({ status: afterConfirm.data?.work?.status, run: afterConfirm.data?.work?.avatarRunId }));
  const noRun = await arow('SELECT COUNT(*) AS n FROM junshi_workbench_avatar_runs WHERE owner_key=? AND text=?', [ownerKey, newSpeech]);
  check('④ 未创建数字人任务（不扣费）', Number(noRun?.n || 0) === 0, JSON.stringify(noRun));

  console.log('⑤ 合成成功回写 → 第 4 步真实生成发布包');
  const runId = 'jwav_p191_ok';
  const segments = [
    { index: 1, text: '课程贵不贵，先看孩子愿不愿意来。', status: 'done', error: '', note: '', audioSeconds: 1.4, durationSeconds: 1.4 },
    { index: 2, text: '体验课结束后，再一起决定要不要报名。', status: 'done', error: '', note: '', audioSeconds: 1.4, durationSeconds: 1.4 },
  ];
  await aq('INSERT INTO junshi_workbench_avatar_runs (id,owner_key,org_id,account_id,voice_id,speaker_id,image_asset_id,text,status,error,steps,segments,meta,speed,duration_seconds,video_asset_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [runId, ownerKey, orgAdmin.org_id, 'default', voiceId, 'reference', imageId, newSpeech, 'running', '', '[]', JSON.stringify(segments), '{}', 'natural', 0, null, at, at]);
  await aq("UPDATE junshi_workbench_video_works SET avatar_run_id=?, status='rendering', message='合成中', updated_at=? WHERE id=? AND owner_key=?", [runId, at, workId, ownerKey]);
  await aq("UPDATE junshi_workbench_avatar_runs SET status='succeeded', video_asset_id=?, duration_seconds=?, segments=?, updated_at=? WHERE id=? AND owner_key=?",
    [videoId, 2.8, JSON.stringify(segments), at, runId, ownerKey]);
  const synced = await syncTalkingHeadWork({ key: ownerKey, orgId: orgAdmin.org_id }, runId, {
    status: 'succeeded', assetId: videoId, durationSeconds: 2.8, segments, text: newSpeech,
  });
  check('⑤ 回写服务找到关联视频任务', synced?.workId === workId && synced?.status === 'succeeded', JSON.stringify(synced));
  const detail = await api(`/api/junshi/workbench/video/works/${workId}`, { token });
  const succeededWork = detail.data?.work;
  check('⑤ 任务详情可读', detail.status === 200 && Boolean(succeededWork), JSON.stringify(detail).slice(0, 1200));
  check('⑤ 视频任务已成功且挂上成片', succeededWork?.status === 'succeeded' && succeededWork?.outputAssetId === videoId, JSON.stringify({ status: succeededWork?.status, output: succeededWork?.outputAssetId }));
  check('⑤ 关联口播任务可读', succeededWork?.avatarRun?.id === runId && succeededWork?.avatarRun?.status === 'succeeded', JSON.stringify(succeededWork?.avatarRun));
  check('⑤ 生成只读字幕稿（真实分段时长）', succeededWork?.directorScript?.shots?.length === 2 && Math.abs(Number(succeededWork.directorScript.shots[0].seconds) - 1.52) < 0.001, JSON.stringify(succeededWork?.directorScript));
  check('⑤ 包装页仍读得到口播模式', succeededWork?.productionMode === 'talking_head');
  const retryDone = await api(`/api/junshi/workbench/avatar/runs/${runId}/retry`, { method: 'POST', token, body: {} });
  check('⑤ 已完成的口播不能从独立工具误重试', retryDone.status === 400 && retryDone.code === 'WORKBENCH_VIDEO_DONE', JSON.stringify(retryDone));

  const packageRes = await api(`/api/junshi/workbench/video/works/${workId}/package`, {
    method: 'POST', token,
    body: { subtitleStyle: 'white', title: '课程贵不贵，先看孩子愿不愿意来', tags: '教育 招生' },
  });
  let pkg = packageRes.data?.package;
  check('⑤ 发布包任务已创建', packageRes.status === 200 && pkg?.id && pkg.status === 'running', JSON.stringify(packageRes));
  for (let i = 0; i < 120; i += 1) {
    if (!pkg?.id) break;
    const pkgDetail = await api(`/api/junshi/workbench/video/packages/${pkg.id}`, { token });
    pkg = pkgDetail.data?.package;
    if (pkg && pkg.status !== 'running') break;
    await sleep(500);
  }
  check('⑤ 发布包完成', pkg?.status === 'ready', pkg?.error || JSON.stringify(pkg));
  check('⑤ 四类产物入库', Boolean(pkg?.videoAssetId && pkg?.coverAssetId && pkg?.srtAssetId && pkg?.zipAssetId));
  if (pkg?.srtAssetId) {
    const srt = await download(token, pkg.srtAssetId);
    const text = srt.buffer.toString('utf8');
    check('⑤ 字幕来自口播分段', srt.status === 200 && text.includes('体验课') && text.includes('-->'), text.slice(0, 200));
  }
  if (pkg?.zipAssetId) {
    const zip = await download(token, pkg.zipAssetId);
    check('⑤ 发布包 ZIP 可下载', zip.status === 200 && zip.buffer.subarray(0, 2).toString('ascii') === 'PK');
    const names = ['video.mp4', 'cover.jpg', 'subtitles.srt', 'publish.md', 'manifest.json'];
    check('⑤ 发布包内容齐全', names.every((name) => zip.buffer.includes(Buffer.from(name))), names.join(','));
  }

  console.log('⑥ 合成失败回写（仍可重试）');
  const failSpeech = '这条用于验证失败回写，不会真的提交上游。';
  const failCreated = await api('/api/junshi/workbench/video/works', {
    method: 'POST', token,
    body: { productionMode: 'talking_head', speech: failSpeech, voiceId, imageAssetId: imageId, speed: 'slightly_fast', accountId: 'default' },
  });
  const failWorkId = failCreated.data?.work?.id;
  assert.ok(failWorkId, `创建失败用例任务失败：${JSON.stringify(failCreated)}`);
  const failRunId = 'jwav_p191_fail';
  await aq("UPDATE junshi_workbench_video_works SET avatar_run_id=?, status='rendering', updated_at=? WHERE id=? AND owner_key=?", [failRunId, at, failWorkId, ownerKey]);
  const failSync = await syncTalkingHeadWork({ key: ownerKey, orgId: orgAdmin.org_id }, failRunId, {
    status: 'failed', error: '模拟上游超时', text: failSpeech,
  });
  check('⑥ 失败回写命中关联任务', failSync?.workId === failWorkId && failSync?.status === 'failed', JSON.stringify(failSync));
  const failDetail = await api(`/api/junshi/workbench/video/works/${failWorkId}`, { token });
  check('⑥ 失败原因与状态保留', failDetail.data?.work?.status === 'failed' && /模拟上游超时/.test(failDetail.data?.work?.error || '') && !failDetail.data?.work?.outputAssetId, JSON.stringify({ status: failDetail.data?.work?.status, error: failDetail.data?.work?.error }));
  check('⑥ 失败任务仍在第 3 步可重试', failDetail.data?.work?.avatarRunId === failRunId);

  console.log('⑦ 旧编导稿任务不受影响');
  const normal = await api('/api/junshi/workbench/video/works', {
    method: 'POST', token,
    body: { mode: 'generate', type: 'ecommerce', subtype: '口播带货', brief: 'P191 回归：写一条普通分镜任务', accountId: 'default' },
  });
  check('⑦ 普通任务仍走编导稿管线', normal.status === 200 && normal.data?.work?.productionMode === 'storyboard' && normal.data?.work?.status === 'planning', JSON.stringify(normal.data?.work));
} catch (error) {
  failures += 1;
  console.error('P191 运行失败：', error?.stack || error);
  if (serverLog) console.error('server log tail：\n', serverLog.slice(-3000));
} finally {
  server.kill('SIGKILL');
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once('close', resolve);
    setTimeout(resolve, 3000);
  });
  await sleep(500);
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 文件句柄释放慢 */ }
}

console.log(failures ? `\nP191 失败 ${failures} 项` : '\nP191 全部通过');
process.exit(failures ? 1 : 0);
