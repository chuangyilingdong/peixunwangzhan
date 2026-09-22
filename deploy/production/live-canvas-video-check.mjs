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
 *   node deploy/production/live-canvas-video-check.mjs --refs-from=<任务 id>   # 照抄那条任务的参考素材与提示词
 *     ↑ 2026-09-21 加：验「画布上连了音频，走队列跑出来到底听不听音频」——
 *       带参考音频时会额外量**产物音轨 vs 源音频的互相关**（>0.5 = 驱动生效）；
 *       `--prompt=` 可覆盖提示词，`--refs='[{...}]'` 可直接给一份参考素材。
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
// --refs-from=<任务 id>：照抄那条任务的**参考素材**（含音频）与提示词 —— 用来验「学生在画布上连了
// 音频/图，走队列跑出来到底听不听音频的」。--refs='[{...}]' 可以直接给一份。
// ⚠️ 2026-09-21 加这一路的原因：音频那条 bug 只有**走队列**（含 worker 第二次解析）才验得全；
//    直接调 provider 会漏掉 worker 那一层（坑 91 就是这么来的）。
// （这段要在挑框体**之前**：带不带参考决定"该挑哪种生成方式的框体"。）
const refsFrom = String(args['refs-from'] || '').trim();
const refsJob = refsFrom ? db.prepare('SELECT prompt, reference_asset_urls FROM generation_jobs WHERE id=?').get(refsFrom) : null;
if (refsFrom && !refsJob) { console.log(`找不到任务 ${refsFrom}`); process.exit(1); }
const refs = args.refs ? JSON.parse(args.refs) : (refsJob ? JSON.parse(refsJob.reference_asset_urls || '[]') : []);
const audioRef = refs.find((item) => String(item?.type || '').toUpperCase() === 'AUDIO') || null;

const boxes = db.prepare(`
  SELECT m.id, m.title, json_extract(m.snapshot,'$.box.model') model,
         json_extract(m.snapshot,'$.box.inputMode') live_mode,
         (SELECT COUNT(*) FROM generation_jobs j WHERE j.box_id=m.id) used
  FROM course_lesson_materials m
  WHERE m.material_type='GENERATION_BOX' AND json_extract(m.snapshot,'$.box.modality')='VIDEO'
    AND m.group_id IN (SELECT id FROM course_lesson_material_groups WHERE lesson_id=?)
  ORDER BY used, m.sort`).all(lessonId);
/* ⚠️⚠️ 2026-09-21 晚踩到的坑（自己把自己骗了三次）：**已发布的课，学生的框体读的是发布快照**
   （`course_lessons.published_content.materialGroups`，见口径 61/62），**不是**实时那一行。
   所以：① `--mode` 必须同时写进**发布快照**，只改实时行等于没改；
        ② 带参考素材跑时，得挑一个"发布快照里就是 OMNI_REFERENCE"的框体 ——
           否则服务端按快照算出 `inputModes:['TEXT']`，参考会被**依设计**丢掉（纯文生），
           上游收到 text-only，产物自然与音频无关，看着像产品坏了。 */
function publishedBoxes() {
  const row = db.prepare('SELECT published_content FROM course_lessons WHERE id=?').get(lessonId);
  const published = JSON.parse(row?.published_content || '{}');
  const out = [];
  for (const group of published.materialGroups || []) for (const material of group.materials || []) if (material?.snapshot?.box) out.push({ id: material.id, mode: String(material.snapshot.box.inputMode || '') });
  return out;
}
const publishedModes = publishedBoxes();
const modeOf = (id) => (publishedModes.find((item) => item.id === id)?.mode) || '';
const wantsRefs = Array.isArray(refs) && refs.length > 0;
const box = args.box
  ? boxes.find((item) => item.id === args.box)
  : (wantsRefs ? boxes.find((item) => modeOf(item.id) === 'OMNI_REFERENCE') : null)
    || boxes.find((item) => Number(item.used) === 0);
if (!box) { console.log('这节课没有可用的空视频框体，退出（或用 --box= 指定）'); process.exit(1); }
if (wantsRefs && !args.mode && modeOf(box.id) !== 'OMNI_REFERENCE') {
  console.log(`⚠️ 这个框体在**发布快照**里的生成方式是「${modeOf(box.id) || '(没写)'}」——带参考素材跑会被服务端按设计丢掉（纯文生）。`);
  console.log('  要么换一个快照里就是 OMNI_REFERENCE 的框体，要么用 --mode=OMNI_REFERENCE 把方式写进发布快照。');
}
// 生产上"一个框体只能生成一次"（服务端会拒）；副本里清掉它的历史任务，模拟"这个框体还没用过"。
const cleared = db.prepare('DELETE FROM generation_jobs WHERE box_id=?').run(box.id);
if (cleared.changes) console.log(`（副本里清掉这个框体的历史任务 ${cleared.changes} 条）`);
// 素材：优先用参数给的；否则用这个项目里最近一条视频任务的首帧地址（就是生产上被丢掉的那条）
const previous = db.prepare("SELECT source_asset_url FROM generation_jobs WHERE project_id=? AND modality='VIDEO' AND source_asset_url IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(project.id);
const asset = String(args.asset || previous?.source_asset_url || '').trim();
if (!asset && !refs.length) { console.log('没有可用的素材地址，用 --asset= 指定一个公开素材的绝对地址（或 --refs-from=<任务 id>）'); process.exit(1); }

const policy = JSON.parse(db.prepare('SELECT ai_provider_policy FROM platform_settings WHERE id=1').get().ai_provider_policy || '{}');
const channelId = policy.modalityChannels?.VIDEO;
const channel = (policy.channels || []).find((item) => item.id === channelId) || {};
const prompt = String(args.prompt || refsJob?.prompt || '让图片动起来');
const ratio = String(args.ratio || 'auto');   // 「自动」= 客户端现在会送 'auto'（服务端翻成 adaptive）
const jobId = `generation_livecheck${Date.now().toString(16)}`;
const now = new Date().toISOString();
db.prepare(`INSERT INTO generation_jobs(id,org_id,user_id,project_id,modality,provider,model,prompt,status,created_at,box_id,source_asset_url,reference_asset_urls,request_options,credits_charged)
  VALUES (?,?,?,?,?,?,?,?,'QUEUED',?,?,?,?,?,0)`)
  .run(jobId, project.org_id, project.student_id, project.id, 'VIDEO', channel.provider || 'custom', channel.model || 'MiniMax-H3', prompt, now, box.id, asset || null, refs.length ? JSON.stringify(refs) : null, JSON.stringify({ aspectRatio: ratio }));
// 先在**副本**里保证这个学生在这节课上有一间进行中的课堂（生产上老师随时会结束课堂，
// 没有这一步，验收脚本会因为 NOT_IN_CLASSROOM 跑不起来）。形状照抄 p4-o12 守卫里的做法。
function ensureActiveSession() {
  const active = db.prepare("SELECT s.id FROM class_sessions s JOIN session_students ss ON ss.session_id=s.id WHERE s.lesson_id=? AND s.status='ACTIVE' AND ss.student_id=? AND ss.status='ACTIVE' LIMIT 1").get(project.course_lesson_id, project.student_id);
  if (active) return active.id;
  const nowIso = new Date().toISOString();
  const stale = db.prepare("SELECT ss.session_id id FROM session_students ss JOIN class_sessions s ON s.id=ss.session_id WHERE ss.student_id=? AND ss.status='ACTIVE' AND s.status IN ('PENDING','ACTIVE')").all(project.student_id);
  for (const item of stale) {
    db.prepare("UPDATE class_sessions SET status='ENDED', ended_at=? WHERE id=?").run(nowIso, item.id);
    db.prepare("UPDATE session_students SET status='INCOMPLETE' WHERE session_id=? AND student_id=?").run(item.id, project.student_id);
  }
  const previous = db.prepare('SELECT class_id FROM class_sessions WHERE lesson_id=? ORDER BY started_at DESC LIMIT 1').get(project.course_lesson_id);
  const klass = db.prepare('SELECT id, teacher_id FROM classes WHERE org_id=? LIMIT 1').get(project.org_id);
  const classId = previous?.class_id || klass?.id;
  if (!classId) throw new Error('副本里找不到可用班级，先在机构端建一个班');
  const sessionId = `csession_livecheck${Date.now().toString(16)}`;
  const series = db.prepare('SELECT series_id FROM course_lessons WHERE id=?').get(project.course_lesson_id);
  // ⚠️ `org_id` 与 `series_id` 必须一起写：门禁（services/studentContext.js 的 ④）是按
  //    `part.org_id=? AND session.org_id=?` 找参与记录的 —— 少了 session.org_id 就是
  //    「老师还没有把这节课的课堂安排给你」（NOT_IN_CLASSROOM），
  //    2026-09-21 走 --refs-from 这条路时真撞到（旧代码只在"生产上碰巧有进行中课堂"时不走这一支）。
  // `delivery_mode` 与四个 `allow_*` 也必须一起写（照抄一节真实课堂）：
  //   · allow_* 少了 → 生成被拦成 SESSION_CAPABILITY_DISABLED（「当前课堂未开放该 AI 能力」）；
  //   · delivery_mode 少了 → 入口类型对不上（⑥）。
  db.prepare(`INSERT INTO class_sessions(id,org_id,series_id,class_id,lesson_id,title,status,delivery_mode,
      allow_text,allow_image,allow_music,allow_video,started_by,started_at,created_at)
    VALUES (?,?,?,?,?,?,'ACTIVE','CANVAS',1,1,1,1,?,?,?)`)
    .run(sessionId, project.org_id, series?.series_id || null, classId, project.course_lesson_id, 'live-check 验收课堂', klass?.teacher_id || null, nowIso, nowIso);
  db.prepare("INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_at) VALUES (?,?,?,?,?,?,'ACTIVE',?)").run('ss_livecheck' + Date.now().toString(16), sessionId, project.student_id, project.org_id, project.course_lesson_id, series?.series_id || null, nowIso);
  // 项目也要指向这间课堂（服务端按它解析「这个学生在上的哪节课」；p11 夹具里同样这一步）
  db.prepare('UPDATE student_projects SET class_session_id=? WHERE id=?').run(sessionId, project.id);
  db.prepare('UPDATE classes SET current_session_id=? WHERE id=?').run(sessionId, classId);
  console.log(`（副本里补了一间进行中的课堂：${sessionId}）`);
  return sessionId;
}
ensureActiveSession();

// --mode=FIRST_FRAME / OMNI_REFERENCE / TEXT / FIRST_LAST_FRAME：只在**副本**里给这个框体锁上生成方式
// （验"课包锁定的方式赢过客户端推断"用；生产库不动）。
// ⚠️ **两处都要改**：实时那一行（老师编辑用的读面）+ **发布快照**（学生/判定真正读的那份，口径 61/62）。
//    只改实时行 = 没改（第一版就是这么把自己骗了三次：以为锁成 OMNI，实际按快照跑的是 TEXT）。
// ⚠️ 要改**三处**，而且判定读的是第三处（坑 103 的准确说法，2026-09-21 晚又踩了一次）：
//   · 实时素材表（老师编辑读面）
//   · 发布快照的 `materialGroups[].materials[].snapshot.box`（**学生画布读面**）
//   · 发布快照的 `generationBoxes[]`（**生成判定真正读的那份**：方框体 id → 配置、算 inputModes/audioRole）
// 只改前两处 = 画布显示新值、判定还用旧值（看着像产品没生效）。
function patchBoxInCopy(updates, label) {
  const row = db.prepare('SELECT snapshot FROM course_lesson_materials WHERE id=?').get(box.id);
  const snapshot = JSON.parse(row?.snapshot || '{}');
  snapshot.box = { ...(snapshot.box || {}), ...updates };
  db.prepare('UPDATE course_lesson_materials SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), box.id);
  const lessonRow = db.prepare('SELECT published_content FROM course_lessons WHERE id=?').get(project.course_lesson_id);
  if (!lessonRow?.published_content) { console.log(`已在副本里把这个框体改成：${label}（这节还没发布 → 只用实时配置）`); return; }
  const published = JSON.parse(lessonRow.published_content);
  let patched = 0;
  for (const group of published.materialGroups || []) {
    for (const material of group.materials || []) {
      if (material?.id !== box.id || !material.snapshot?.box) continue;
      material.snapshot.box = { ...material.snapshot.box, ...updates };
      patched += 1;
    }
  }
  for (const item of published.generationBoxes || []) {
    if (item?.id !== box.id) continue;
    Object.assign(item, updates);
    patched += 1;
  }
  db.prepare('UPDATE course_lessons SET published_content=? WHERE id=?').run(JSON.stringify(published), project.course_lesson_id);
  console.log(`已在副本里把这个框体改成：${label}（发布快照里改了 ${patched} 处、实时配置 1 处）`);
}
if (args.mode) patchBoxInCopy({ inputMode: String(args.mode).toUpperCase() }, `生成方式 ${String(args.mode).toUpperCase()}`);
// --audio-role=VOICE_REFERENCE：课包锁「音频怎么用」（口径：对口型 / 声音参考）
if (args['audio-role']) patchBoxInCopy({ audioRole: String(args['audio-role']).toUpperCase() }, `音频角色 ${String(args['audio-role']).toUpperCase()}`);
db.close();

console.log(`项目：${project.id}（${project.title}）`);
console.log(`框体：${box.id}「${box.title}」 模型 ${box.model}`);
console.log(`首帧：${asset || '(无 —— 这次只验参考素材)'}`);
if (refs.length) console.log(`参考：${refs.map((item) => item.type).join(' / ')}（照抄 ${refsFrom || '--refs'}）`);
console.log(`提示词：${prompt}`);
console.log(`（${ratio === 'auto' ? '画幅走「自动」→ 服务端翻成 adaptive，输出应跟着源图比例' : `画幅固定 ${ratio}`}）`);
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
    if (asset) {
      const ffmpeg = spawn('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', 'select=eq(n\\,0)', '-vframes', '1', png]);
      await new Promise((resolve) => ffmpeg.on('close', resolve));
      console.log(`第 0 帧：${png}   ← **打开它，应该就是源图那张画**（不是一段无关画面）`);
    }
    // 参考音频的判据（2026-09-21）：产物**音轨**应该就是那条源音频 —— 上游把音频当"驱动"用时
    // 缺省 `lock_source` 会把它留在产物里；只当"声音参考"（reference_audio）时音轨是重新生成的，
    // 与源音频的互相关接近 0（实测 0.018 vs 0.997）。人眼看不出这种差别，只能量。
    if (audioRef?.url) {
      const { execFileSync } = await import('node:child_process');
      const src = `${WORK}/ref-audio`;
      execFileSync('curl', ['-sS', '-o', src, audioRef.url]);
      const pcm = (file) => {
        const target = `${file}.pcm`;
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-t', '5', '-ac', '1', '-ar', '16000', '-f', 's16le', target]);
        const buf = readFileSync(target);
        const out = new Float32Array(buf.length / 2);
        let mean = 0;
        for (let i = 0; i < out.length; i += 1) { out[i] = buf.readInt16LE(i * 2); mean += out[i]; }
        mean /= out.length || 1;
        for (let i = 0; i < out.length; i += 1) out[i] -= mean;
        return out;
      };
      const correlate = (a, b, lag) => {
        const n = Math.min(a.length, b.length);
        let dot = 0; let na = 0; let nb = 0;
        for (let i = 0; i + lag < n; i += 1) { const x = a[i]; const y = b[i + lag]; dot += x * y; na += x * x; nb += y * y; }
        return na && nb ? dot / Math.sqrt(na * nb) : 0;
      };
      const a = pcm(mp4);
      const b = pcm(src);
      let best = { lag: 0, score: -2 };
      for (let lag = -9600; lag <= 9600; lag += 80) { const score = correlate(a, b, lag); if (score > best.score) best = { lag, score }; }
      for (let lag = best.lag - 80; lag <= best.lag + 80; lag += 1) { const score = correlate(a, b, lag); if (score > best.score) best = { lag, score }; }
      console.log(`参考音频：${audioRef.url}`);
      console.log(`音轨判据：产物音轨 vs 源音频前 5 秒 → 互相关 ${best.score.toFixed(3)}（lag ${(best.lag / 16).toFixed(2)}ms）`
        + ` ${best.score > 0.5 ? '✅ 就是这条音频（驱动生效）' : '❌ 不是这条音频（音频没被用上）'}`);
    }
  } catch (error) {
    console.log('下载/抽帧失败：', error?.message || error);
  }
}
if (row?.status !== 'SUCCEEDED') console.log('\n--- 临时实例日志尾部 ---\n' + serverLog.split('\n').slice(-15).join('\n'));
