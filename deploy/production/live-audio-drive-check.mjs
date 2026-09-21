#!/usr/bin/env node
/**
 * 真跑验收：**参考音频到底怎么发，画面/音轨才会跟着音频走**（**会花上游的钱，约 ¥0.75，只手工跑**）。
 *
 * 为什么需要它：2026-09-21 用户报「视频全能参考好像音频无法参考 —— 让他参考音频前 5 秒，
 * 结果做出来的视频跟音频完全不一样」。查下来是**角色用错了**：
 *   · 上游 MiniMax-H3 的内容项有两种音频角色（见上游文档 H3 专节「驱动音频与声音参考」）：
 *       `reference_audio` 提供**声音参考**（音色风格），**不驱动画面**；
 *       `drive_audio` 提供**目标音频驱动**（画面跟着音频动；默认 `lock_source` 保留这条音频）。
 *   · 我们 `{{referenceItems}}` 把音频一律发成 `reference_audio` → 画面与音轨都不会跟音频走。
 * 判据（**只用产物本身**，任务状态/日志看不出问题）：产物视频的**音轨**应该就是那条源音频
 * （drive 默认 lock_source）——脚本把两者解码成 16kHz 单声道，在 ±0.6 秒内找最大归一化互相关；
 * 参考音频那条会得到接近 0 的分数（实测 0.018），drive 那条应该明显高。
 *
 * 用法（服务器上）：
 *   export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH
 *   node deploy/production/live-audio-drive-check.mjs --role=drive        # 默认，约 ¥0.75
 *   node deploy/production/live-audio-drive-check.mjs --role=reference    # 复现旧行为（对照）
 *   node deploy/production/live-audio-drive-check.mjs --control=pin-native # 再叠上生产模板里那条 audio_control
 *   node deploy/production/live-audio-drive-check.mjs --dry                # 不花钱：只把素材传到上游看能不能成
 *   素材默认取**生产库里最近一条带音频参考的视频任务**（就是用户撞的那条），可用 --job=<id> 换。
 *
 * 它**直连上游**（不走我们的 provider），所以它验的是"上游的语义"；要验"用户在画布上走的那条路"，
 * 用 deploy/production/live-canvas-video-check.mjs（走队列、含 worker 那一层）——
 * 2026-09-21 踩过的坑就是"直接调 provider 验过了"却漏掉 worker（见第二十七轮交接 §六）。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';

const RELEASE = process.env.RELEASE_DIR || '/srv/ai-kids-platform/production/current';
const PROD_DATA = '/srv/ai-kids-platform/production/data';
const WORK = process.env.AUDIO_CHECK_DIR || '/tmp/audio-drive-check';
mkdirSync(WORK, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = String(item).replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const role = String(args.role || 'drive').toLowerCase() === 'reference' ? 'reference_audio' : 'drive_audio';
const pinNative = 'pin-native' in args;          // 复现生产模板里那条 audio_control
const dry = 'dry' in args;

/* ── 生产库副本（只读使用）──────────────────────────────────────────────── */
const COPY_DB = `${WORK}/platform.db`;
rmSync(COPY_DB, { force: true });
const { DatabaseSync } = await import('node:sqlite');
const prod = new DatabaseSync(`${PROD_DATA}/platform.db`, { readOnly: true });
prod.exec(`VACUUM INTO '${COPY_DB}'`);
prod.close();
const db = new DatabaseSync(COPY_DB, { readOnly: true });

/* ── 生产 env / 密钥（密钥只在内存里，不打印）────────────────────────────── */
const env = {};
for (const line of readFileSync('/etc/ai-kids-platform/production.env', 'utf8').split('\n')) {
  const matched = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (matched) env[matched[1]] = matched[2].replace(/^["']|["']$/g, '');
}
// ⚠️ 必须真装进 process.env，且**库要指到副本**：镜像那一步会走"我们自己域名上的文件 → 直接从磁盘读"
//    那条路（私有素材在 /api/public 上是 403，走 HTTP 只会读到 403）——2026-09-21 第一版脚本就栽在这
//    （看着像"上游读不到"，其实是脚本环境不对）。FILE_UPLOAD_* 决定上传根在哪，少了就读不到盘。
for (const [name, value] of Object.entries(env)) {
  if (/^AI_PROVIDER_/.test(name) || /^FILE_UPLOAD_/.test(name) || name === 'PUBLIC_SITE_URL') process.env[name] = value;
}
process.env.PLATFORM_DATA_DIR = WORK;
process.env.PLATFORM_DB_PATH = COPY_DB;
process.env.DEPLOYMENT_MODE = 'public';
const SELF = String(env.PUBLIC_SITE_URL || 'https://iicili.cyou').replace(/\/+$/, '');
const pepper = createHash('sha256').update(String(env.AUTH_PEPPER || 'p0-local-pepper')).digest();
const store = JSON.parse(readFileSync(`${PROD_DATA}/provider-secrets/provider-secrets.json`, 'utf8'));
function apiKeyFor(channelId) {
  const item = store.secrets?.[channelId];
  if (!item) return '';
  const decipher = createDecipheriv('aes-256-gcm', pepper, Buffer.from(item.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(item.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(item.data, 'base64')), decipher.final()]).toString('utf8');
}
const policy = JSON.parse(db.prepare('SELECT ai_provider_policy FROM platform_settings WHERE id=1').get().ai_provider_policy || '{}');
const channel = (policy.channels || []).find((item) => item.id === policy.modalityChannels?.VIDEO) || {};
const apiKey = apiKeyFor(channel.id);
const origin = new URL(channel.endpoint).origin;
console.log(`上游 ${origin} / 模型 ${channel.model} / 音频角色 ${role}${pinNative ? '（+ audio_control 钉 native）' : ''}\n`);

/* ── 素材：最近一条带音频参考的视频任务（用户撞的那条）──────────────────── */
const job = args.job
  ? db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(args.job)
  : db.prepare(`SELECT * FROM generation_jobs WHERE modality='VIDEO' AND status='SUCCEEDED'
                AND reference_asset_urls LIKE '%"type":"AUDIO"%' ORDER BY created_at DESC LIMIT 1`).get();
if (!job) { console.log('生产库里没有带音频参考的视频任务，用 --job= 指定一条'); process.exit(1); }
const refs = JSON.parse(job.reference_asset_urls || '[]');
const audio = refs.find((item) => String(item.type).toUpperCase() === 'AUDIO');
const images = refs.filter((item) => String(item.type).toUpperCase() === 'IMAGE');
if (!audio) { console.log('这条任务里没有音频参考'); process.exit(1); }
// 提示词照抄用户那条（芯片已经在上游那侧被翻过，这里只把中文芯片换成上游写法，与 aiGeneration 同口径）
const prompt = String(job.prompt || '让画面跟着音频动起来').replace(/图片[ ]?(\d)/g, 'Image $1').replace(/音频[ ]?(\d)/g, 'Audio $1');
console.log(`任务 ${job.id}（${job.created_at}）\n提示词 ${prompt}\n音频 ${audio.url}\n图片 ${images.length} 张\n`);

/* ── 素材镜像：我们自己域名上的一定要先传到上游（对方读不到 iicili.cyou）── */
const { mirrorSelfHostedMedia } = await import(`${RELEASE}/apps/server/src/services/upstreamMediaMirror.js`);
const { defaultMediaUploadPath } = await import(`${RELEASE}/apps/server/src/services/openaiCompatibleProvider.js`);
const uploadPath = defaultMediaUploadPath(channel.endpoint);
const uploadUrl = uploadPath ? `${origin}${uploadPath}` : '';
const uploadTimeoutMs = Number(args.timeout || 150000);
// 逐素材传、失败重试：上游这个暂存接口是境外中继，大图经常几十秒才回、赶上 Cloudflare 就 520/524
// （2026-09-21 实测：3.9MB PNG 524/129 秒、2.2MB PNG 520/45~62 秒，1.6MB mp3 7 秒就过）。
// 这是**上游侧**的问题，不该让"音频到底怎么发"这个判据被它挡住 —— 所以这里跑不动的那张就明说、
// 继续用剩下的素材跑（生成链路里是**整条失败**，不会静默降级 —— 别把这里的容错当成产品行为）。
async function prepareOne(asset, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const out = await mirrorSelfHostedMedia({ referenceAssets: [asset] }, {
        selfOrigins: [SELF], uploadUrl, apiKey, timeoutMs: uploadTimeoutMs,
      });
      return out.referenceAssets[0];
    } catch (error) {
      console.log(`   ⚠️ ${asset.type} 第 ${attempt}/${tries} 次上传失败：${String(error?.message || error).slice(0, 120)}`);
    }
  }
  return null;
}
console.log('素材准备：');
const prepared = [];
// --order=audio-first：把音频排在**内容项的图片之前**（画布上学生先连音频时就是这个顺序）。
// 2026-09-21 晚加：走队列的真跑（音频在图片前）连续 3 次都没锁音轨，而直连探针（图片在前）2 次都锁上，
// 所以怀疑上游是**按内容项顺序/第一个非文本项**选模式的 —— 这个开关就是为分辨它。
const audioFirst = String(args.order || '') === 'audio-first';
const orderedAssets = audioFirst ? [audio, ...images] : [...images, audio];
for (const asset of orderedAssets) {
  const ready = await prepareOne(asset);
  if (!ready) { console.log(`   ❌ ${asset.type} 传不上去（上游暂存接口超时），这条不参与本次验证`); continue; }
  const unchanged = ready.url === asset.url;
  console.log(`   ${ready.type}${unchanged ? '（原样，上游自己的存储）' : '（已换成上游地址）'}: ${ready.url.slice(0, 110)}`);
  prepared.push(ready);
}
const sentAudio = prepared.find((item) => String(item.type).toUpperCase() === 'AUDIO');
const sentImages = prepared.filter((item) => String(item.type).toUpperCase() === 'IMAGE');
if (!sentAudio) { console.log('音频本身就没传上去，验不了，稍后再跑'); process.exit(1); }
if (!sentImages.length) console.log('⚠️ 一张图都没传上去：这次只能验证「音频能不能驱动画面/音轨」，图像参考那部分没验');
if (dry) { console.log('\n（--dry：只验素材能不能被上游拿到，不生成）'); writeFileSync(`${WORK}/prepared.json`, JSON.stringify(prepared, null, 1)); process.exit(0); }

/* ── 提交 ──────────────────────────────────────────────────────────────── */
const imageItems = sentImages.map((item) => ({ type: 'image_url', image_url: { url: item.url }, role: 'reference_image' }));
const audioItem = { type: 'audio_url', audio_url: { url: sentAudio?.url || audio.url }, role };
const body = {
  model: channel.model || 'MiniMax-H3',
  content: [{ type: 'text', text: prompt }, ...(audioFirst ? [audioItem, ...imageItems] : [...imageItems, audioItem])],
  duration: 5,
  resolution: '480P',
  ratio: String(args.ratio || '3:4'),
};
if (pinNative) body.audio_control = { mode: 'native', add_drive_as_reference: false };
writeFileSync(`${WORK}/request-body.json`, JSON.stringify(body, null, 1));
console.log(`\n提交请求体（已存 ${WORK}/request-body.json）：\n${JSON.stringify(body, null, 1).slice(0, 900)}\n`);

const submit = await fetch(`${origin}/v2/video_generation`, {
  method: 'POST',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const submitted = await submit.json().catch(() => ({}));
const taskId = String(submitted?.task_id || submit.headers.get('x-task-id') || '');
if (!taskId) { console.log(`❌ 提交失败：HTTP ${submit.status} ${JSON.stringify(submitted).slice(0, 300)}`); process.exit(1); }
console.log(`✅ 已受理 task_id=${taskId}（HTTP ${submit.status}）`);

/* ── 轮询 ──────────────────────────────────────────────────────────────── */
const deadline = Date.now() + 9 * 60 * 1000;
let videoUrl = ''; let status = ''; let lastPayload = {};
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const response = await fetch(`${origin}/v2/query/video_generation/${taskId}`, { headers: { authorization: `Bearer ${apiKey}` } });
  const payload = await response.json().catch(() => ({}));
  lastPayload = payload;
  const task = payload?.task || {};
  status = String(task.status || '');
  if (status === 'succeeded') { videoUrl = String(task?.content?.url || ''); break; }
  if (status === 'failed' || status === 'cancelled') break;
  console.log(`   …${status || `HTTP ${response.status}`}`);
}
writeFileSync(`${WORK}/last-task.json`, JSON.stringify(lastPayload, null, 1));
if (!videoUrl) { console.log(`❌ 没有拿到产物（status=${status || '超时'}）：${JSON.stringify(lastPayload).slice(0, 400)}`); process.exit(1); }
console.log(`✅ 产物 ${videoUrl}`);

/* ── 判据：产物音轨 vs 源音频 ─────────────────────────────────────────── */
const outFile = `${WORK}/out.mp4`;
const srcFile = `${WORK}/src-audio`;
execFileSync('curl', ['-sS', '-o', outFile, videoUrl]);
execFileSync('curl', ['-sS', '-o', srcFile, audio.url]);
// 抽几帧出来（人眼看画面是不是从参考图开始、有没有按提示词动）
for (const [index, at] of [[0, 0], [1, 2.5], [2, 4.8]]) {
  try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', outFile, '-vframes', '1', `${WORK}/frame-${index}.png`]); } catch { /* 抽帧失败不影响判据 */ }
}

function pcm(file, seconds) {
  const target = `${WORK}/${file.replace(/[^a-z0-9.]/gi, '_')}.pcm`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-t', String(seconds), '-ac', '1', '-ar', '16000', '-f', 's16le', target]);
  const buf = readFileSync(target);
  const out = new Float32Array(buf.length / 2);
  let mean = 0;
  for (let i = 0; i < out.length; i += 1) { out[i] = buf.readInt16LE(i * 2); mean += out[i]; }
  mean /= out.length || 1;
  for (let i = 0; i < out.length; i += 1) out[i] -= mean;   // 去均值再算互相关
  return out;
}
function correlate(a, b, lag) {
  const n = Math.min(a.length, b.length);
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i + lag < n; i += 1) {
    const x = a[i]; const y = b[i + lag];
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
const a = pcm(outFile, 5);
const b = pcm(srcFile, 5);
let best = { lag: 0, score: -2 };
for (let lag = -9600; lag <= 9600; lag += 80) { const score = correlate(a, b, lag); if (score > best.score) best = { lag, score }; }
for (let lag = best.lag - 80; lag <= best.lag + 80; lag += 1) { const score = correlate(a, b, lag); if (score > best.score) best = { lag, score }; }
const verdict = {
  role, pinnedNative: pinNative, taskId, videoUrl,
  bestLagMs: Number((best.lag / 16).toFixed(2)),
  correlation: Number(best.score.toFixed(3)),
  locked: best.score > 0.5 ? true : false,
};
console.log(`\n判据：产物音轨 vs 源音频前 5 秒 → 互相关 ${verdict.correlation}（lag ${verdict.bestLagMs}ms）`);
console.log(verdict.locked
  ? '✅ 音轨就是那条源音频 → 上游确实把音频当**驱动**用了（drive_audio + 默认 lock_source）'
  : '❌ 音轨不是源音频 → 这条音频没被上游用起来（reference_audio 只当"声音参考"，不驱动画面）');
console.log(`产物与抽帧：${WORK}/out.mp4、${WORK}/frame-0.png、frame-1.png、frame-2.png`);
writeFileSync(`${WORK}/verdict.json`, JSON.stringify(verdict, null, 1));
