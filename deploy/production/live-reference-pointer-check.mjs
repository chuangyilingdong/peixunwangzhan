#!/usr/bin/env node
/**
 * 真跑对照：提示词里**指代"第几张参考图"**该用哪种写法（**会花上游的钱，约 ¥0.75/次，只手工跑**）。
 *
 * 为什么要它：上游文档里两种写法**不是一个地方写的**，H3 专节只写了音频的 `<Audio 1>`：
 *   · `@Image 1` / `@Video 1`：出自"多模态参考"那一节的原文（"多模态场景可用 @Image 1、@Video 1
 *     指代第几个参考素材"），我们 2026-09-21 按它翻的芯片；
 *   · `<Audio 1>`：H3 专节「驱动音频与声音参考」的示例原文（`口型跟随 <Audio 1>，说：<d>[中文] …</d>`），
 *     没有 `@`。
 * H3 到底认哪种"图片指代"写法，文档没写 —— 这个脚本就是拿**同一条提示词、同一组参考图、只换写法**
 * 各跑一次，用**客观判据**分：两张源图的平均亮度差得很开（实测 ≈119 / ≈39），所以
 * "先出现第 1 张、再转场到第 2 张"这种要求，若模型真看得懂指代，产物的前/后两段亮度就应该跟
 * 对应源图对上（脚本把两侧亮度都打出来，谁更像谁一目了然）。
 *
 * 用法（服务器上）：
 *   export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH
 *   node deploy/production/live-reference-pointer-check.mjs --form=at      # @Image N   （hailuo 那节的写法）
 *   node deploy/production/live-reference-pointer-check.mjs --form=angle   # <Image N>  （按 H3 音频那套类比）
 *   可选：--asset1=<file_assets id 或站内地址> --asset2=… --prompt='…{P1}…{P2}…' --resolution=480P --duration=5
 *   --dry：只把两张图传到上游看能不能成（免费）
 *
 * ⚠️ 它是**直连上游**的对照（不走我们的 provider），只回答"上游认哪种写法"；
 *    产品侧的芯片翻译在 apps/server/src/routes/aiGeneration.js（`upstreamPromptWithReferences`）。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';

const RELEASE = process.env.RELEASE_DIR || '/srv/ai-kids-platform/production/current';
const WORK = process.env.POINTER_CHECK_DIR || '/tmp/pointer-check';
mkdirSync(WORK, { recursive: true });
const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = String(item).replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const form = String(args.form || 'at').toLowerCase() === 'angle' ? 'angle' : 'at';
const dry = 'dry' in args;
const chip = (n) => (form === 'angle' ? `<Image ${n}>` : `@Image ${n}`);
// 判据用：两张源图亮度差得开。提示词**不写任何"亮/暗"的字眼**（否则文字自己就能驱动结果、
// 判不出指代有没有生效）——只要求"先呈现 P1、两秒后转场到 P2"。
const promptTemplate = String(args.prompt || '画面先呈现 {P1} 里的东西，两秒后自然转场到 {P2} 里的东西。');
const prompt = promptTemplate.replace('{P1}', chip(1)).replace('{P2}', chip(2));
const resolution = String(args.resolution || '480P');
const duration = Number(args.duration || 5);

/* ── 生产 env / 密钥 / 渠道（密钥只在内存里）─────────────────────────────── */
const env = {};
for (const line of readFileSync('/etc/ai-kids-platform/production.env', 'utf8').split('\n')) {
  const matched = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (matched) env[matched[1]] = matched[2].replace(/^["']|["']$/g, '');
}
const SELF = String(env.PUBLIC_SITE_URL || 'https://iicili.cyou').replace(/\/+$/, '');
const pepper = createHash('sha256').update(String(env.AUTH_PEPPER || 'p0-local-pepper')).digest();
const store = JSON.parse(readFileSync('/srv/ai-kids-platform/production/data/provider-secrets/provider-secrets.json', 'utf8'));
const decipher = createDecipheriv('aes-256-gcm', pepper, Buffer.from(store.secrets['channel-mtpzt0c8'].iv, 'hex'));
decipher.setAuthTag(Buffer.from(store.secrets['channel-mtpzt0c8'].tag, 'hex'));
const apiKey = Buffer.concat([decipher.update(Buffer.from(store.secrets['channel-mtpzt0c8'].data, 'base64')), decipher.final()]).toString('utf8');
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('/srv/ai-kids-platform/production/data/platform.db', { readOnly: true });
const policy = JSON.parse(db.prepare('SELECT ai_provider_policy FROM platform_settings WHERE id=1').get().ai_provider_policy || '{}');
// 两张参考图：默认拿用户那条任务里的两张（一张亮 ≈119、一张暗 ≈39，判据就是它们的差）
const defaultIds = ['file_cb98c29c70224b3abb0c', 'file_78fbb5ccd38e4fc9b6bd'];
const assetIds = [String(args.asset1 || defaultIds[0]), String(args.asset2 || defaultIds[1])];
const urls = assetIds.map((value) => (/^https?:\/\//i.test(value) ? value : `${SELF}/api/public/file-assets/${value}/download`));
const channel = (policy.channels || []).find((item) => item.id === policy.modalityChannels?.VIDEO) || {};
const origin = new URL(channel.endpoint).origin;
const uploadPath = `${origin}/v1/files/upload`;
console.log(`上游 ${origin} / 模型 ${channel.model} / 写法 ${form === 'angle' ? '<Image N>' : '@Image N'}\n提示词：${prompt}\n`);

/* ── 素材镜像（自站地址要先换成上游自己的 URL）──────────────────────────── */
// ⚠️ 镜像那一步会走"我们自己的文件 → **直接从磁盘读**"（私有素材走 /api/public 是 403，
//    见坑 99）：所以必须把**库指到副本**、并装上生产那套 `FILE_UPLOAD_ROOT`，
//    否则它读不到盘、回落 HTTP 就只会拿到 403（第一版就栽在这，看着像上游在拒）。
rmSync(`${WORK}/platform.db`, { force: true });
const prod = new DatabaseSync('/srv/ai-kids-platform/production/data/platform.db', { readOnly: true });
prod.exec(`VACUUM INTO '${WORK}/platform.db'`);
prod.close();
for (const [name, value] of Object.entries(env)) {
  if (/^FILE_UPLOAD_/.test(name) || name === 'PUBLIC_SITE_URL') process.env[name] = value;
}
process.env.PLATFORM_DB_PATH = `${WORK}/platform.db`;
process.env.PLATFORM_DATA_DIR = WORK;
const { mirrorMediaUrl } = await import(`${RELEASE}/apps/server/src/services/upstreamMediaMirror.js`);
async function prepare(url, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try { return await mirrorMediaUrl(url, { uploadUrl: uploadPath, apiKey, timeoutMs: 150000 }); }
    catch (error) { console.log(`   ⚠️ 第 ${attempt}/${tries} 次上传失败：${String(error?.message || error).slice(0, 120)}`); }
  }
  return '';
}
const sent = [];
for (const url of urls) {
  const mirrored = await prepare(url);
  if (!mirrored) { console.log('❌ 有图传不上去，这条验不了（上游暂存接口在抖），稍后再跑'); process.exit(1); }
  console.log(`   ${mirrored === url ? '（原样）' : '（已换成上游地址）'} ${mirrored.slice(0, 100)}`);
  sent.push(mirrored);
}
if (dry) { console.log('\n（--dry：只验素材能不能被上游拿到，不生成）'); process.exit(0); }

/* ── 提交 + 轮询 ─────────────────────────────────────────────────────────── */
const body = {
  model: channel.model || 'MiniMax-H3',
  content: [{ type: 'text', text: prompt }, ...sent.map((url) => ({ type: 'image_url', image_url: { url }, role: 'reference_image' }))],
  duration, resolution, ratio: '16:9',
};
const submit = await fetch(`${origin}/v2/video_generation`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const submitted = await submit.json().catch(() => ({}));
const taskId = String(submitted?.task_id || submit.headers.get('x-task-id') || '');
if (!taskId) { console.log(`❌ 提交失败：HTTP ${submit.status} ${JSON.stringify(submitted).slice(0, 200)}`); process.exit(1); }
console.log(`✅ 已受理 task_id=${taskId}`);
const deadline = Date.now() + 9 * 60 * 1000;
let videoUrl = '';
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const response = await fetch(`${origin}/v2/query/video_generation/${taskId}`, { headers: { authorization: `Bearer ${apiKey}` } });
  const payload = await response.json().catch(() => ({}));
  const task = payload?.task || {};
  if (task.status === 'succeeded') { videoUrl = String(task.content?.url || ''); break; }
  if (task.status === 'failed' || task.status === 'cancelled') { console.log(`❌ 任务失败：${JSON.stringify(task.error || {}).slice(0, 200)}`); process.exit(1); }
  console.log(`   …${task.status || `HTTP ${response.status}`}`);
}
if (!videoUrl) { console.log('❌ 没等到产物'); process.exit(1); }
console.log(`✅ 产物 ${videoUrl}`);

/* ── 判据：两侧亮度 vs 两张源图 ─────────────────────────────────────────── */
// 缩到 1×1 的灰度图 = 全图平均亮度（0–255）。⚠️ 返回的是 **Buffer**，取第 0 个字节就是那个数
// （别用 String(buf)，那会把它当成 UTF-8 文本、得到 NaN）。
const meanLuma = (file) => {
  const bytes = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
  return bytes[0];
};
const outFile = `${WORK}/out-${form}.mp4`;
execFileSync('curl', ['-sS', '-o', outFile, videoUrl]);
const frames = [];
for (const [label, at] of [['前半段(1.0s)', '1.0'], ['后半段(4.5s)', '4.5']]) {
  const png = `${WORK}/frame-${form}-${at}.png`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', at, '-i', outFile, '-vframes', '1', png]);
  frames.push({ label, at, luma: meanLuma(png), png });
}
const source = {};
for (const [index, value] of assetIds.entries()) {
  const file = `${WORK}/src-${index + 1}.png`;
  execFileSync('curl', ['-sS', '-o', file, /^https?:\/\//i.test(value) ? value : `${SELF}/api/public/file-assets/${value}/download`]);
  source[index + 1] = meanLuma(file);
}
const closer = (luma) => (Math.abs(luma - source[1]) <= Math.abs(luma - source[2]) ? `更像图片 1（亮 ${source[1]}）` : `更像图片 2（暗 ${source[2]}）`);
const verdict = { form: form === 'angle' ? '<Image N>' : '@Image N', prompt, sourceLuma: source, frames: frames.map((item) => ({ ...item, closer: closer(item.luma) })), videoUrl };
console.log(`\n源图亮度：图片 1 = ${source[1]}（亮）  图片 2 = ${source[2]}（暗）`);
for (const item of verdict.frames) console.log(`  ${item.label}：产物这一帧亮度 ${item.luma} → ${item.closer}`);
console.log('\n判据：**前半段更像图片 1、后半段更像图片 2** = 指代写法生效（顺序对上了）。');
writeFileSync(`${WORK}/verdict-${form}.json`, JSON.stringify(verdict, null, 1));
console.log(`产物与抽帧：${outFile}、${frames.map((item) => item.png).join('、')}`);
