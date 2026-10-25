/**
 * P150 招生军师：视频工作台「分镜原帧」管线（storyboard_replication 的基础）。
 *
 * 用户口径（2026-10-25，交接文档「视频工作台补强」）：
 *   ① 复刻任务的参考视频能被抽成每一镜的原帧；
 *   ② 原帧存进素材库「分镜原帧」，并写回编导稿每镜的 referenceFrameAssetId；
 *   ③ 单镜渲染时优先拿这张原帧当首帧/参考图（本次先验抽帧与回写；真实视频渲染按条计费，不在这里跑）；
 *   ④ 没有参考视频时给明确错误，不许静默跳过。
 *
 * ⚠️ 真起服务、真传视频、真跑 ffmpeg/ffprobe：只查源码或只调函数验不出这条链路。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
if (!hasFfmpeg) {
  console.log('SKIP：本机没有 ffmpeg/ffprobe，跳过分镜原帧验收。');
  process.exit(0);
}

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p150-storyboard-frames-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;

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

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 19090;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body, raw = false } = {}) {
  const isForm = body instanceof FormData;
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(isForm ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
  });
  if (raw) return response;
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null, code: payload?.error?.code || null };
}

async function waitWorkReady(workId, token) {
  for (let i = 0; i < 80; i += 1) {
    const current = await api(`/api/junshi/workbench/video/works/${encodeURIComponent(workId)}`, { token });
    if (current.data?.work && current.data.work.status !== 'planning') return current.data.work;
    await sleep(100);
  }
  return null;
}

const videoPath = path.join(temp, 'reference.mp4');
const makeVideo = spawnSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '12',
  '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', videoPath,
], { stdio: 'ignore' });
if (makeVideo.status !== 0) {
  server.kill();
  fs.rmSync(temp, { recursive: true, force: true });
  console.log('SKIP：本机 ffmpeg 不能生成测试视频。');
  process.exit(0);
}

try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* wait */ }
    await sleep(100);
  }
  const login = await api('/api/auth/login', { method: 'POST', body: { login: 'org-admin', password: 'org123' } });
  const token = login.data?.token;
  assert.ok(token, `登录失败：${JSON.stringify(login)}`);

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(videoPath)], { type: 'video/mp4' }), 'reference.mp4');
  form.append('accountId', 'default');
  form.append('folder', '测试参考');
  const upload = await api('/api/junshi/workbench/assets', { method: 'POST', token, body: form });
  const videoAssetId = upload.data?.asset?.id;
  check('① 参考视频进素材库', upload.status === 200 && Boolean(videoAssetId), JSON.stringify(upload));

  const created = await api('/api/junshi/workbench/video/works', {
    method: 'POST', token,
    body: {
      mode: 'replicate', type: 'ecommerce', subtype: '口播带货', hookStrategy: 'auto',
      durationSeconds: 12, resolution: '480P', ratio: '9:16',
      brief: '复刻测试', reference: '用这段参考视频抽原帧',
      assetRefs: [{ assetId: videoAssetId, role: '场景', label: '参考视频', notes: 'p150' }],
      accountId: 'default',
    },
  });
  const workId = created.data?.work?.id;
  check('① 复刻任务创建', created.status === 200 && Boolean(workId), JSON.stringify(created));
  const readyWork = workId ? await waitWorkReady(workId, token) : null;
  check('① 首轮编导稿结束（再写测试稿，避免异步覆盖）', Boolean(readyWork), JSON.stringify(readyWork?.status || null));

  const script = {
    title: '原帧测试', strategy: '测试三分镜', notes: '',
    shots: [
      { index: 1, seconds: 4, role: 'hook', scene: '开场', voiceover: '第一句', overlay: '', renderPrompt: '开场画面' },
      { index: 2, seconds: 4, role: 'pain', scene: '痛点', voiceover: '第二句', overlay: '', renderPrompt: '痛点画面' },
      { index: 3, seconds: 4, role: 'cta', scene: '收尾', voiceover: '第三句', overlay: '', renderPrompt: '收尾画面' },
    ],
  };
  const saved = await api(`/api/junshi/workbench/video/works/${encodeURIComponent(workId)}`, {
    method: 'PUT', token, body: { directorScript: script, scriptEdited: true },
  });
  check('① 编导稿保存三分镜', saved.status === 200 && saved.data?.work?.directorScript?.shots?.length === 3, JSON.stringify(saved));

  const extracted = await api(`/api/junshi/workbench/video/works/${encodeURIComponent(workId)}/extract-frames`, {
    method: 'POST', token, body: {},
  });
  const frames = extracted.data?.frames || [];
  const shots = extracted.data?.work?.directorScript?.shots || [];
  check('② 三镜各抽一帧', extracted.status === 200 && frames.length === 3 && shots.length === 3, JSON.stringify({ status: extracted.status, frames: frames.length }));
  check('② 帧时间按分镜起点错开', frames.map((item) => Math.round(item.time)).join(',') === '1,5,9', JSON.stringify(frames));
  check('② 原帧写回每镜（含可访问地址）',
    shots.every((shot) => shot.referenceFrameAssetId && shot.referenceFrameUrl)
    && shots.map((shot) => shot.referenceFrameAssetId).join(',') === frames.map((item) => item.assetId).join(','),
    JSON.stringify(shots.map((shot) => ({ id: shot.referenceFrameAssetId, url: shot.referenceFrameUrl }))));

  const firstFrame = frames[0];
  const frameResponse = await api(`/api/junshi/workbench/assets/${encodeURIComponent(firstFrame.assetId)}/file`, { token, raw: true });
  const frameBuffer = Buffer.from(await frameResponse.arrayBuffer());
  check('③ 原帧文件能从素材库读回（JPEG）',
    frameResponse.status === 200
    && String(frameResponse.headers.get('content-type') || '').startsWith('image/jpeg')
    && frameBuffer.length > 1000
    && frameBuffer[0] === 0xff && frameBuffer[1] === 0xd8,
    JSON.stringify({ status: frameResponse.status, type: frameResponse.headers.get('content-type'), bytes: frameBuffer.length }));

  const secondExtract = await api(`/api/junshi/workbench/video/works/${encodeURIComponent(workId)}/extract-frames`, {
    method: 'POST', token, body: {},
  });
  check('③ 重复抽帧不报错、仍然三镜各一帧',
    secondExtract.status === 200 && (secondExtract.data?.frames || []).length === 3,
    JSON.stringify({ status: secondExtract.status }));

  const noVideo = await api('/api/junshi/workbench/video/works', {
    method: 'POST', token,
    body: { mode: 'generate', type: 'ecommerce', subtype: '口播带货', durationSeconds: 5, brief: '没有参考视频', accountId: 'default' },
  });
  const noVideoId = noVideo.data?.work?.id;
  if (noVideoId) await waitWorkReady(noVideoId, token);
  await api(`/api/junshi/workbench/video/works/${encodeURIComponent(noVideoId)}`, { method: 'PUT', token, body: { directorScript: script, scriptEdited: true } });
  const noVideoFrames = await api(`/api/junshi/workbench/video/works/${encodeURIComponent(noVideoId)}/extract-frames`, { method: 'POST', token, body: {} });
  check('④ 没有参考视频时明确报错', noVideoFrames.status === 400 && noVideoFrames.code === 'WORKBENCH_VIDEO_NO_REFERENCE_VIDEO', JSON.stringify({ status: noVideoFrames.status, code: noVideoFrames.code }));
} finally {
  server.kill();
  await sleep(800);
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
}

console.log(`\n结论：${failures ? `${failures} 项失败` : '全部通过'}`);
if (failures) {
  console.log(serverLog.slice(-4000));
  process.exit(1);
}
