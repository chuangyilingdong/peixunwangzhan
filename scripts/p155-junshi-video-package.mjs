/**
 * P155 招生军师十九期：视频包装与发布包。
 *
 * 用户口径（2026-10-26）：
 *   视频渲染完成后，第 4 步要能补字幕、BGM、封面、标题/描述/标签，并导出可直接发布的 zip。
 *
 * 真起服务、真走 HTTP；视频/音频用 ffmpeg 现场生成，不依赖外部素材。
 * 不跑真实视频渲染：直接造一条已完成任务，只验证包装链路。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p155-workbench-'));
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

console.log('① 源码口径（包装表 / 路由 / 前端第 4 步）');
{
  const schema = fs.readFileSync(path.join(root, 'packages/database/src/schema.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'apps/server/src/routes/junshiWorkbench.js'), 'utf8');
  const front = fs.readFileSync(path.join(root, 'apps/website/public/assets/junshi/workbench.js'), 'utf8');
  const packaging = fs.readFileSync(path.join(root, 'apps/server/src/services/junshiWorkbenchPackaging.js'), 'utf8');
  const migration = path.join(root, 'deploy/production/migrate/45-junshi-workbench-video-packages-mysql.sql');
  check('① schema 有视频包装表', ['junshi_workbench_video_packages', 'zip_asset_id', 'cover_asset_id', 'srt_asset_id'].every((token) => schema.includes(token)));
  check('① 包装服务有字幕/封面/zip/BGM', ['buildDirectorSrt', 'srtToAss', 'renderCover', 'renderPackagedVideo', 'buildZip', 'buildPublishCopy'].every((token) => packaging.includes(token)));
  check('① 路由有包装创建/查询', ['/video/packages/', "sub1 === 'package'", 'runVideoPackage', 'video_package'].every((token) => route.includes(token)));
  check('① 前端第 4 步改成包装与发布', ['包装与发布', 'data-wb-v-pkg', '下载发布包', 'renderPackageForm'].every((token) => front.includes(token)));
  check('① 迁移 45 存在', fs.existsSync(migration));
  const { buildPublishCopy } = await import('../apps/server/src/services/junshiWorkbenchPackaging.js');
  const fallback = buildPublishCopy({
    work: { typeLabel: '电商带货', subtype: '口播带货', title: '' },
    script: { title: '家长总说课程贵，应该怎么解释', strategy: '用一个误区开场，再给一个动作。', shots: [{ voiceover: '先看孩子缺什么。' }] },
    profile: { product: '少儿美术体验课' },
  });
  check('① 默认发布文案兜底', Boolean(fallback.title && fallback.description && fallback.tags.length >= 3), JSON.stringify(fallback));
}

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const orgAdmin = await arow("SELECT id, org_id FROM users WHERE login='org-admin'");
assert.ok(orgAdmin, 'seed 里没有 org-admin');
const ownerKey = `org:${orgAdmin.org_id}`;

console.log('② 准备 3 秒 9:16 测试视频 + BGM');
const videoPath = path.join(temp, 'clip.mp4');
const bgmPath = path.join(temp, 'bgm.mp3');
const ffVideo = spawnSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'color=c=0x334155:s=1080x1920:d=3',
  '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath,
], { encoding: 'utf8' });
const ffBgm = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-q:a', '9', '-acodec', 'libmp3lame', bgmPath], { encoding: 'utf8' });
check('② 测试视频生成', ffVideo.status === 0 && fs.statSync(videoPath).size > 0, ffVideo.stderr?.slice(-200));
check('② BGM 生成', ffBgm.status === 0 && fs.statSync(bgmPath).size > 0, ffBgm.stderr?.slice(-200));

const port = 19095;
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
  return { status: response.status, type: response.headers.get('content-type') || '', buffer: Buffer.from(await response.arrayBuffer()) };
}

try {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ }
    await sleep(100);
  }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
  const token = login.data?.token;
  assert.ok(token, `登录失败：${JSON.stringify(login)}`);

  console.log('③ 上传成片与 BGM → 造一条已完成视频任务');
  const videoUp = await upload(token, videoPath, 'p155-clip.mp4', 'video/mp4', 'P155测试');
  const bgmUp = await upload(token, bgmPath, 'p155-bgm.mp3', 'audio/mpeg', 'P155测试');
  const videoAsset = videoUp?.data?.asset;
  const bgmAsset = bgmUp?.data?.asset;
  assert.ok(videoAsset?.id, `视频上传失败：${JSON.stringify(videoUp)}`);
  assert.ok(bgmAsset?.id, `BGM 上传失败：${JSON.stringify(bgmUp)}`);
  check('③ 成片素材入库', videoAsset.kind === 'video' && videoAsset.id.startsWith('jwa'));
  check('③ BGM 素材入库', bgmAsset.kind === 'audio' && bgmAsset.id.startsWith('jwa'));

  const created = await api('/api/junshi/workbench/video/works', {
    method: 'POST', token,
    body: {
      mode: 'generate', type: 'ecommerce', subtype: '口播带货', hookStrategy: 'auto',
      brief: 'P155 包装验收：家长总说课程贵，应该怎么解释', durationSeconds: 3,
      resolution: '480P', ratio: '9:16', accountId: 'default',
    },
  });
  const workId = created.data?.work?.id;
  assert.ok(workId, `创建视频任务失败：${JSON.stringify(created)}`);
  let work = null;
  for (let i = 0; i < 80; i += 1) {
    const detail = await api(`/api/junshi/workbench/video/works/${workId}`, { token });
    work = detail.data?.work;
    if (work && ['draft', 'failed'].includes(work.status)) break;
    await sleep(150);
  }
  assert.equal(work?.status, 'draft', `编导稿未生成：${JSON.stringify(work)}`);
  const script = work.directorScript;
  check('③ 编导稿含分镜', Array.isArray(script?.shots) && script.shots.length > 0);

  await aq('UPDATE junshi_workbench_video_works SET status=?, output_asset_id=?, message=?, updated_at=? WHERE id=? AND owner_key=?',
    ['succeeded', videoAsset.id, 'P155 已造完成', new Date().toISOString(), workId, ownerKey]);

  console.log('④ 生成发布包（字幕 + BGM + 封面 + zip）');
  const packageRes = await api(`/api/junshi/workbench/video/works/${workId}/package`, {
    method: 'POST', token,
    body: {
      subtitleStyle: 'white',
      bgmAssetId: bgmAsset.id,
      title: '家长总说课程贵，应该怎么解释',
      coverSubtitle: '3-8岁家长必看',
      description: '先看孩子缺什么，再决定要不要报。',
      tags: '教育 招生 家长必看',
    },
  });
  let pkg = packageRes.data?.package;
  check('④ 包装任务已创建', packageRes.status === 200 && pkg?.id && pkg.status === 'running', JSON.stringify(packageRes));
  for (let i = 0; i < 120; i += 1) {
    if (!pkg?.id) break;
    const detail = await api(`/api/junshi/workbench/video/packages/${pkg.id}`, { token });
    pkg = detail.data?.package;
    if (pkg && pkg.status !== 'running') break;
    await sleep(500);
  }
  check('④ 包装完成', pkg?.status === 'ready', pkg?.error || JSON.stringify(pkg));
  check('④ 标题按用户输入', pkg?.title === '家长总说课程贵，应该怎么解释');
  check('④ 描述按用户输入', pkg?.description === '先看孩子缺什么，再决定要不要报。');
  check('④ 标签已归一', Array.isArray(pkg?.tags) && pkg.tags.join(',') === '教育,招生,家长必看');
  check('④ 四类产物都入库', Boolean(pkg?.videoAssetId && pkg?.coverAssetId && pkg?.srtAssetId && pkg?.zipAssetId));

  console.log('⑤ 下载并校验产物');
  if (pkg?.videoAssetId) {
    const packaged = await download(token, pkg.videoAssetId);
    check('⑤ 包装视频 200', packaged.status === 200 && packaged.buffer.length > 1000, `${packaged.status} ${packaged.buffer.length}`);
    check('⑤ 包装视频是 mp4', packaged.buffer.subarray(4, 8).toString('ascii') === 'ftyp');
    const outVideo = path.join(temp, 'packaged.mp4');
    fs.writeFileSync(outVideo, packaged.buffer);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', outVideo], { encoding: 'utf8' });
    const meta = JSON.parse(probe.stdout || '{}');
    const duration = Number(meta?.format?.duration || 0);
    check('⑤ 包装视频时长约 3 秒', duration > 2.2 && duration < 4.2, String(duration));
    check('⑤ 包装视频保留音轨', (meta?.streams || []).some((stream) => stream.codec_type === 'audio'));
  }
  if (pkg?.coverAssetId) {
    const cover = await download(token, pkg.coverAssetId);
    check('⑤ 封面 200 + JPEG', cover.status === 200 && cover.buffer[0] === 0xFF && cover.buffer[1] === 0xD8, `${cover.status} ${cover.buffer.length}`);
  }
  if (pkg?.srtAssetId) {
    const srt = await download(token, pkg.srtAssetId);
    const text = srt.buffer.toString('utf8');
    check('⑤ 字幕有时间轴', srt.status === 200 && text.includes('-->'));
    check('⑤ 字幕含口播文字', text.includes('先') || text.includes('家长') || text.includes('课程'));
  }
  if (pkg?.zipAssetId) {
    const zip = await download(token, pkg.zipAssetId);
    check('⑤ 发布包 200 + ZIP', zip.status === 200 && zip.buffer.subarray(0, 2).toString('ascii') === 'PK', `${zip.status} ${zip.buffer.length}`);
    const names = ['video.mp4', 'cover.jpg', 'subtitles.srt', 'publish.md', 'manifest.json'];
    check('⑤ 发布包包含五类文件', names.every((name) => zip.buffer.includes(Buffer.from(name))), names.join(','));
    const outZip = path.join(temp, 'publish.zip');
    fs.writeFileSync(outZip, zip.buffer);
    const unzip = spawnSync('python', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print("\\n".join(z.namelist()))', outZip], { encoding: 'utf8' });
    check('⑤ 发布包可被标准工具打开', unzip.status === 0 && names.every((name) => unzip.stdout.includes(name)), unzip.stderr?.slice(-200));
  }

  console.log('⑥ 边界与任务流水');
  const latest = await api(`/api/junshi/workbench/video/works/${workId}/package`, { token });
  check('⑥ 任务详情能取到最新发布包', latest.data?.package?.id === pkg?.id);
  const badBgm = await api(`/api/junshi/workbench/video/works/${workId}/package`, {
    method: 'POST', token, body: { bgmAssetId: videoAsset.id, subtitleStyle: 'white' },
  });
  check('⑥ 非音频不能当 BGM', badBgm.status === 400 && String(badBgm.code || '').includes('VALIDATION'), JSON.stringify(badBgm));
  const jobs = await api('/api/junshi/workbench/jobs?limit=20', { token });
  const packageJob = (jobs.data?.items || []).find((job) => job.kind === '视频包装');
  check('⑥ 历史任务有「视频包装」且成功', Boolean(packageJob) && packageJob.status === 'succeeded', JSON.stringify(packageJob));
  const original = await api(`/api/junshi/workbench/assets/${encodeURIComponent(videoAsset.id)}/file`, { token, raw: true });
  check('⑥ 原片仍在', original.status === 200);
} catch (error) {
  failures += 1;
  console.error('P155 运行失败：', error?.stack || error);
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

console.log(failures ? `\nP155 失败 ${failures} 项` : '\nP155 全部通过');
process.exit(failures ? 1 : 0);
