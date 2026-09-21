#!/usr/bin/env node
/**
 * 真跑验收 · 走**完整队列链路**（画布视频框体）：生产库副本 + 临时实例 + 真上游（**会花钱，约 ¥0.75**）。
 *
 * 为什么必须是"走队列"：2026-09-21 那一轮我直接在进程里调 provider 验过"首帧生效"，
 * 结论是对的 —— 但漏掉了**worker 会拿 job 记录里的素材地址再解析一次**这一步：
 * 入队写的是绝对地址、worker 那次解析只认站内相对地址 → 首帧被悄悄丢掉 → 上游收到纯文生请求。
 * 于是"我这边验过"和"用户在画布上看到的"差了整整一层。**验收要走用户真正走的那条路。**
 *
 * 它做的事：
 *   ① VACUUM 一份生产库副本（**不碰生产库**）
 *   ② 在副本里挑一个**没人用过的视频框体**，插一条 QUEUED 任务（素材用生产上那条被丢过的真实地址）
 *   ③ 起一个临时实例（不同端口、指向副本），让**它自己的 worker** 去跑这条任务
 *   ④ 等终态；把产物视频下载下来、抽出第 0 帧 → 应等于源图（打印路径，人看一眼即可）
 *
 * 用法（服务器上）：
 *   export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH
 *   node deploy/production/live-canvas-video-check.mjs                 # 自动挑课程/项目/框体
 *   node deploy/production/live-canvas-video-check.mjs --project=<id> --box=<boxId>
 *   node deploy/production/live-canvas-video-check.mjs --asset=<公开素材的绝对地址>
 */
import { mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const REPO = process.env.LIVE_CHECK_REPO
  || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const WORK = process.env.LIVE_CHECK_DIR || '/tmp/live-canvas-video-check';
const PORT = Number(process.env.LIVE_CHECK_PORT || 18877);
const PROD_DB = '/srv/ai-kids-platform/production/data/platform.db';
const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = String(item).replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const DB = `${WORK}/platform.db`;

const { DatabaseSync } = await import('node:sqlite');
const prod = new DatabaseSync(PROD_DB, { readOnly: true });
prod.exec(`VACUUM INTO '${DB}'`);
prod.close();
const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 8000');

/* ── 挑一个能跑的（项目 + 没人用过的视频框体 + 那条被丢过的素材）───────────────── */
const project = args.project
  ? db.prepare('SELECT * FROM student_projects WHERE id=?').get(args.project)
  : db.prepare("SELECT * FROM student_projects WHERE status='DRAFT' ORDER BY updated_at DESC LIMIT 1").get();
if (!project) { console.log('找到不项目，退出'); process.exit(1); }
const lessonId = project.course_lesson_id;
const boxes = db.prepare(`
  SELECT m.id, m.title, json_extract(m.snapshot,'$.box.model') model,
         (SELECT COUNT(*) FROM generation_jobs j WHERE j.box_id=m.id) used
  FROM course_lesson_materials m
  WHERE m.material_type='GENERATION_BOX' AND json_extract(m.snapshot,'$.box.modality')='VIDEO'
    AND m.group_id IN (SELECT id FROM course_lesson_material_groups WHERE lesson_id=?)
  ORDER BY used, m.sort`).all(lessonId);
const box = args.box ? boxes.find((item) => item.id === args.box) : boxes.find((item) => Number(item.used) === 0);
if (!box) { console.log('这节课没有可用的空视频框体，退出（或用 --box= 指定）'); process.exit(1); }
// 素材：优先用参数给的；否则用这个项目里最近一条视频任务的首帧地址（就是生产上被丢掉的那条）
const previous = db.prepare("SELECT source_asset_url FROM generation_jobs WHERE project_id=? AND modality='VIDEO' AND source_asset_url IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(project.id);
const asset = String(args.asset || previous?.source_asset_url || '').trim();
if (!asset) { console.log('没有可用的素材地址，用 --asset= 指定一个公开素材的绝对地址'); process.exit(1); }

const policy = JSON.parse(db.prepare('SELECT ai_provider_policy FROM platform_settings WHERE id=1').get().ai_provider_policy || '{}');
const channelId = policy.modalityChannels?.VIDEO;
const channel = (policy.channels || []).find((item) => item.id === channelId) || {};
const prompt = '让图片动起来';
const ratio = String(args.ratio || 'auto');   // 「自动」= 客户端现在会送 'auto'（服务端翻成 adaptive）
const jobId = `generation_livecheck${Date.now().toString(16)}`;
const now = new Date().toISOString();
db.prepare(`INSERT INTO generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,created_at,box_id,source_asset_url,request_options,credits_charged)
  VALUES (?,?,?,?,?,?,?,?,'QUEUED',?,?,?,?,0)`)
  .run(jobId, project.org_id, project.student_id, project.id, 'VIDEO', channel.provider || 'custom', channel.model || 'MiniMax-H3', prompt, now, box.id, asset, JSON.stringify({ aspectRatio: ratio }));
// --mode=FIRST_FRAME / OMNI_REFERENCE / TEXT / FIRST_LAST_FRAME：只在**副本**里给这个框体锁上生成方式
// （验"课包锁定的方式赢过客户端推断"用；生产库不动）。
if (args.mode) {
  const row = db.prepare('SELECT snapshot FROM course_lesson_materials WHERE id=?').get(box.id);
  const snapshot = JSON.parse(row?.snapshot || '{}');
  snapshot.box = { ...(snapshot.box || {}), inputMode: String(args.mode).toUpperCase() };
  db.prepare('UPDATE course_lesson_materials SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), box.id);
  console.log(`已在副本里把这个框体锁成：${String(args.mode).toUpperCase()}`);
}
db.close();

console.log(`项目：${project.id}（${project.title}）`);
console.log(`框体：${box.id}「${box.title}」 模型 ${box.model}`);
console.log(`素材：${asset}（${ratio === 'auto' ? '画幅走「自动」→ 服务端翻成 adaptive，输出应跟着源图比例' : `画幅固定 ${ratio}`}）`);
console.log(`任务：${jobId}\n`);
console.log('⚠️ 这会真花上游的钱（480P/5s ≈ ¥0.75），且是一次真实生成。\n');

/* ── 起临时实例（用生产那套 env，但库是副本）────────────────────────────────── */
const env = { ...process.env };
for (const line of readFileSync('/etc/ai-kids-platform/production.env', 'utf8').split('\n')) {
  const matched = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (matched) env[matched[1]] = matched[2].replace(/^["']|["']$/g, '');
}
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: REPO,
  env: { ...env, PORT: String(PORT), PLATFORM_DATA_DIR: WORK, PLATFORM_DB_PATH: DB, DEPLOYMENT_MODE: 'public' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 60; i += 1) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 还没起来 */ }
  await sleep(500);
}

/* ── 等终态 ──────────────────────────────────────────────────────────────── */
const watch = new DatabaseSync(DB);
watch.exec('PRAGMA busy_timeout = 8000');
let row = null;
for (let i = 0; i < 90; i += 1) {
  await sleep(5000);
  row = watch.prepare('SELECT status,error_code,error_message,worker_id,substr(coalesce(compute_snapshot,\'\'),1,0) s FROM generation_jobs WHERE id=?').get(jobId);
  if (['SUCCEEDED', 'FAILED'].includes(row?.status)) break;
  process.stdout.write(row?.status === 'RUNNING' ? '.' : 'o');
}
console.log('');
const assetRow = watch.prepare('SELECT asset_url FROM media_assets WHERE job_id=?').get(jobId);
watch.close();
server.kill('SIGTERM');

console.log(`任务终态：${row?.status}${row?.error_code ? `（${row.error_code}）` : ''} ${row?.error_message || ''}`);
const videoUrl = assetRow?.asset_url || '';
console.log(`产物：${videoUrl || '(没有产物)'}`);

if (videoUrl) {
  const mp4 = `${WORK}/result.mp4`;
  const png = `${WORK}/result-f0.png`;
  try {
    const bytes = new Uint8Array(await (await fetch(videoUrl)).arrayBuffer());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(mp4, bytes);
    console.log(`已下载：${mp4}`);
    const ffmpeg = spawn('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', 'select=eq(n\\,0)', '-vframes', '1', png]);
    await new Promise((resolve) => ffmpeg.on('close', resolve));
    console.log(`第 0 帧：${png}   ← **打开它，应该就是源图那张画**（不是一段无关画面）`);
  } catch (error) {
    console.log('下载/抽帧失败：', error?.message || error);
  }
}
if (row?.status !== 'SUCCEEDED') console.log('\n--- 临时实例日志尾部 ---\n' + serverLog.split('\n').slice(-15).join('\n'));
