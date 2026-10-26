/**
 * P192 招生军师二十一期：视频一键托管。
 *
 * 用户口径（2026-10-26）：
 *   只填一个主题，系统自动跑免费步骤（口播稿/编导稿、音色形象校验、分段和费用），
 *   停在确认页；只有点确认才提交渲染/数字人合成（计费）；成功后自动生成默认发布包。
 *
 * 真起服务、真走 HTTP；不跑真实付费渲染/合成：
 *   - 托管创建后确认 status=planning、auto_host=preparing、无 render/avatar 行；
 *   - 免费准备完成后 auto_host=awaiting_confirmation，确认因渠道未配置被拒绝且仍不建任务；
 *   - 模拟成片成功后，列表/详情拉取会补跑自动打包，并验证真实 zip。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p192-auto-host-'));
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

console.log('① 源码口径（schema / 迁移 47 / 托管服务 / 路由 / 前端）');
{
  const schema = fs.readFileSync(path.join(root, 'packages/database/src/schema.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'apps/server/src/routes/junshiWorkbench.js'), 'utf8');
  const front = fs.readFileSync(path.join(root, 'apps/website/public/assets/junshi/workbench.js'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'apps/server/src/services/junshiWorkbenchHosting.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'apps/server/src/services/junshiWorkbenchContent.js'), 'utf8');
  const migration = path.join(root, 'deploy/production/migrate/47-junshi-workbench-auto-host-mysql.sql');
  check('① schema 有 auto_host', schema.includes('auto_host'));
  check('① 迁移 47 存在', fs.existsSync(migration));
  check('① 托管状态服务可解析/更新', ['parseAutoHost', 'patchAutoHost', 'newAutoHost', 'awaiting_confirmation'].every((token) => service.includes(token)));
  check('① 口播稿自动生成提示词与兜底', ['buildTalkingHeadCopyPrompt', 'demoTalkingHeadCopy'].every((token) => content.includes(token)));
  check('① 路由接上免费准备/确认/自动打包', [
    'autoHostRequested', 'runHostedTalkingHeadScript', 'maybeAutoPackageHosted', 'reconcileHostedPackages', '托管已准备好',
  ].every((token) => route.includes(token)));
  check('① 前端有一键托管入口与状态', ['一键托管', 'renderHostedDraftCard', 'hostedBannerHtml', 'autoHost', '确认前检查口播稿', '确认前检查编导稿'].every((token) => front.includes(token)));
}

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const orgAdmin = await arow("SELECT id, org_id FROM users WHERE login='org-admin'");
assert.ok(orgAdmin, 'seed 里没有 org-admin');
const ownerKey = `org:${orgAdmin.org_id}`;

console.log('② 准备形象照 / 音色 / 测试成片');
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

const port = 19098;
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
async function waitFor(fn, { timeout = 15000, interval = 250 } = {}) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    last = await fn();
    if (last?.ok) return last;
    await sleep(interval);
  }
  return last || { ok: false };
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
  const imageUp = await upload(token, imagePath, 'p192-face.png', 'image/png', 'P192测试');
  const audioUp = await upload(token, audioPath, 'p192-voice.mp3', 'audio/mpeg', 'P192测试');
  const videoUp = await upload(token, videoPath, 'p192-clip.mp4', 'video/mp4', 'P192测试');
  const imageId = imageUp?.data?.asset?.id;
  const audioId = audioUp?.data?.asset?.id;
  const videoId = videoUp?.data?.asset?.id;
  check('③ 三类素材上传成功', Boolean(imageId && audioId && videoId), JSON.stringify({ imageUp, audioUp, videoUp }));
  const voiceId = 'jwv2_p192_reference';
  const at = new Date().toISOString();
  await aq(
    'INSERT INTO junshi_workbench_voices (id,owner_key,org_id,account_id,name,speaker_id,status,error,sample_asset_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [voiceId, ownerKey, orgAdmin.org_id, 'default', 'P192 参考直出音色', 'reference', 'ready', '', audioId, at, at],
  );

  console.log('④ 托管口播：只给主题，免费写稿并停在确认');
  const topic = '暑假班体验课怎么跟家长讲清楚';
  const createdTh = await api('/api/junshi/workbench/video/works', {
    method: 'POST', token,
    body: {
      productionMode: 'talking_head', autoHost: true, topic,
      voiceId, imageAssetId: imageId, speed: 'natural',
      type: 'ecommerce', subtype: '口播带货', accountId: 'default',
    },
  });
  const thWorkId = createdTh.data?.work?.id;
  check('④ 托管口播创建进入 planning', createdTh.status === 200 && createdTh.data?.work?.status === 'planning', JSON.stringify(createdTh));
  check('④ 创建响应带托管状态', createdTh.data?.work?.autoHost?.enabled === true && createdTh.data?.work?.autoHost?.stage === 'preparing', JSON.stringify(createdTh.data?.work?.autoHost));
  check('④ 创建阶段没有生成口播稿', !createdTh.data?.work?.talkingHead?.text, JSON.stringify(createdTh.data?.work?.talkingHead));
  assert.ok(thWorkId, `托管口播创建失败：${JSON.stringify(createdTh)}`);
  const noAvatarAtCreate = await arow('SELECT COUNT(*) AS n FROM junshi_workbench_avatar_runs WHERE owner_key=?', [ownerKey]);
  check('④ 创建阶段没有建数字人任务（不扣费）', Number(noAvatarAtCreate?.n || 0) === 0, JSON.stringify(noAvatarAtCreate));

  const thReady = await waitFor(async () => {
    const detail = await api(`/api/junshi/workbench/video/works/${thWorkId}`, { token });
    const work = detail.data?.work;
    return { ok: work && work.status !== 'planning', work, detail };
  });
  const thWork = thReady.work;
  check('④ 免费写稿完成并回到 draft', thWork?.status === 'draft' && Boolean(thWork?.talkingHead?.text), JSON.stringify({ status: thWork?.status, text: thWork?.talkingHead?.text, error: thWork?.error }));
  check('④ 已自动分段且带费用口径', Number(thWork?.talkingHead?.plan?.batchCount || 0) >= 2 && Boolean(thWork?.talkingHead?.plan?.maxSegments), JSON.stringify(thWork?.talkingHead?.plan));
  check('④ 托管停在确认页', thWork?.autoHost?.stage === 'awaiting_confirmation' && !thWork?.autoHost?.confirmedAt, JSON.stringify(thWork?.autoHost));
  check('④ 免费准备阶段没有 avatar_run', thWork?.avatarRunId === '' && !thWork?.avatarRun, JSON.stringify({ run: thWork?.avatarRunId }));
  check('④ 托管写稿没有生成编导稿分镜', !thWork?.directorScript, JSON.stringify(thWork?.directorScript));

  const thConfirm = await api(`/api/junshi/workbench/video/works/${thWorkId}/confirm`, { method: 'POST', token, body: {} });
  check('④ 渠道未配置时确认被拒绝', thConfirm.status === 400 && thConfirm.code === 'WORKBENCH_AVATAR_NOT_CONFIGURED', JSON.stringify(thConfirm));
  const thAfter = await api(`/api/junshi/workbench/video/works/${thWorkId}`, { token });
  check('④ 拒绝后仍停在确认页、未扣费', thAfter.data?.work?.status === 'draft' && thAfter.data?.work?.autoHost?.stage === 'awaiting_confirmation' && !thAfter.data?.work?.avatarRunId, JSON.stringify({ status: thAfter.data?.work?.status, host: thAfter.data?.work?.autoHost, run: thAfter.data?.work?.avatarRunId }));
  const noAvatarAfterConfirm = await arow('SELECT COUNT(*) AS n FROM junshi_workbench_avatar_runs WHERE owner_key=?', [ownerKey]);
  check('④ 确认失败没有创建数字人任务', Number(noAvatarAfterConfirm?.n || 0) === 0, JSON.stringify(noAvatarAfterConfirm));

  console.log('⑤ 托管分镜：只给需求，免费写编导稿并停在确认');
  const hostedBrief = '给暑期体验课写一条 15 秒分镜，开场用家长常见误区，结尾引导评论区领评估表。';
  const createdSb = await api('/api/junshi/workbench/video/works', {
    method: 'POST', token,
    body: {
      mode: 'generate', autoHost: true, brief: hostedBrief, durationSeconds: 15, resolution: '768P', ratio: '9:16',
      type: 'ecommerce', subtype: '口播带货', accountId: 'default',
    },
  });
  const sbWorkId = createdSb.data?.work?.id;
  assert.ok(sbWorkId, `托管分镜创建失败：${JSON.stringify(createdSb)}`);
  check('⑤ 托管分镜创建进入 planning', createdSb.data?.work?.status === 'planning' && createdSb.data?.work?.autoHost?.enabled === true, JSON.stringify(createdSb.data?.work));
  const sbReady = await waitFor(async () => {
    const detail = await api(`/api/junshi/workbench/video/works/${sbWorkId}`, { token });
    const work = detail.data?.work;
    return { ok: work && work.status !== 'planning', work, detail };
  });
  const sbWork = sbReady.work;
  check('⑤ 免费编导稿完成并回到 draft', sbWork?.status === 'draft' && Array.isArray(sbWork?.directorScript?.shots) && sbWork.directorScript.shots.length >= 2, JSON.stringify({ status: sbWork?.status, shots: sbWork?.directorScript?.shots?.length, error: sbWork?.error }));
  check('⑤ 托管停在渲染确认页', sbWork?.autoHost?.stage === 'awaiting_confirmation' && !sbWork?.autoHost?.confirmedAt, JSON.stringify(sbWork?.autoHost));
  const sbConfirm = await api(`/api/junshi/workbench/video/works/${sbWorkId}/confirm`, { method: 'POST', token, body: {} });
  check('⑤ 视频渠道未配置时确认被拒绝', sbConfirm.status === 400 && sbConfirm.code === 'WORKBENCH_VIDEO_CHANNEL_NOT_CONFIGURED', JSON.stringify(sbConfirm));
  const sbAfter = await api(`/api/junshi/workbench/video/works/${sbWorkId}`, { token });
  check('⑤ 拒绝后仍停在确认页、无渲染行', sbAfter.data?.work?.status === 'draft' && sbAfter.data?.work?.autoHost?.stage === 'awaiting_confirmation', JSON.stringify({ status: sbAfter.data?.work?.status, host: sbAfter.data?.work?.autoHost }));
  const renderRows = await arow('SELECT COUNT(*) AS n FROM junshi_workbench_video_renders WHERE owner_key=? AND work_id=?', [ownerKey, sbWorkId]);
  check('⑤ 确认失败没有创建渲染任务', Number(renderRows?.n || 0) === 0, JSON.stringify(renderRows));

  console.log('⑥ 模拟成片成功 → 自动打包（无需再点生成发布包）');
  const hostRow = await arow('SELECT auto_host FROM junshi_workbench_video_works WHERE id=? AND owner_key=?', [sbWorkId, ownerKey]);
  const hostState = JSON.parse(hostRow.auto_host || '{}');
  hostState.confirmedAt = new Date().toISOString();
  hostState.stage = 'submitted';
  await aq("UPDATE junshi_workbench_video_works SET status='succeeded', output_asset_id=?, auto_host=?, message='模拟成片完成', updated_at=? WHERE id=? AND owner_key=?",
    [videoId, JSON.stringify(hostState), new Date().toISOString(), sbWorkId, ownerKey]);
  const detailAfterSuccess = await api(`/api/junshi/workbench/video/works/${sbWorkId}`, { token });
  check('⑥ 任务详情可读且仍托管', detailAfterSuccess.data?.work?.status === 'succeeded' && detailAfterSuccess.data?.work?.autoHost?.confirmedAt, JSON.stringify({ status: detailAfterSuccess.data?.work?.status, host: detailAfterSuccess.data?.work?.autoHost }));
  let pkg = null;
  const pkgReady = await waitFor(async () => {
    const packageRes = await api(`/api/junshi/workbench/video/works/${sbWorkId}/package`, { token });
    pkg = packageRes.data?.package;
    return { ok: pkg && pkg.status !== 'running', package: pkg, packageRes };
  }, { timeout: 30000 });
  pkg = pkgReady.package;
  check('⑥ 自动打包已创建并完成', pkg?.status === 'ready', pkg?.error || JSON.stringify(pkgReady.packageRes));
  check('⑥ 四类产物齐全', Boolean(pkg?.videoAssetId && pkg?.coverAssetId && pkg?.srtAssetId && pkg?.zipAssetId), JSON.stringify(pkg));
  check('⑥ 托管状态标记 ready', pkgReady.package?.status === 'ready');
  const hostAfter = await api(`/api/junshi/workbench/video/works/${sbWorkId}`, { token });
  check('⑥ 托管详情标记 ready', hostAfter.data?.work?.autoHost?.stage === 'ready' && Boolean(hostAfter.data?.work?.autoHost?.packagedAt), JSON.stringify(hostAfter.data?.work?.autoHost));
  if (pkg?.srtAssetId) {
    const srt = await download(token, pkg.srtAssetId);
    check('⑥ 自动字幕可下载', srt.status === 200 && srt.buffer.toString('utf8').includes('-->'), srt.buffer.toString('utf8').slice(0, 120));
  }
  if (pkg?.zipAssetId) {
    const zip = await download(token, pkg.zipAssetId);
    const names = ['video.mp4', 'cover.jpg', 'subtitles.srt', 'publish.md', 'manifest.json'];
    check('⑥ 自动发布包 ZIP 内容齐全', zip.status === 200 && zip.buffer.subarray(0, 2).toString('ascii') === 'PK' && names.every((name) => zip.buffer.includes(Buffer.from(name))), names.join(','));
  }

  console.log('⑦ 手动任务不受托管影响');
  const manual = await api('/api/junshi/workbench/video/works', {
    method: 'POST', token,
    body: { mode: 'generate', type: 'ecommerce', subtype: '口播带货', brief: 'P192 回归：普通任务不应自动打包', accountId: 'default' },
  });
  check('⑦ 普通任务仍走 planning', manual.status === 200 && manual.data?.work?.status === 'planning', JSON.stringify(manual.data?.work));
  check('⑦ 普通任务 autoHost 关闭', manual.data?.work?.autoHost?.enabled === false && manual.data?.work?.autoHost?.stage === 'idle', JSON.stringify(manual.data?.work?.autoHost));
} catch (error) {
  failures += 1;
  console.error('P192 运行失败：', error?.stack || error);
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

console.log(failures ? `\nP192 失败 ${failures} 项` : '\nP192 全部通过');
process.exit(failures ? 1 : 0);
