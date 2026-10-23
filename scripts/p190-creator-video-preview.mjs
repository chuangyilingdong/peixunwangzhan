/**
 * P190 学生个人主页里点开网页作品，**视频要能播**（2026-10-23 用户报）。
 *
 * 用户原话：「学生主页这里，点第一个作品 index.html，视频无法播放，但是是在老师端其他地方
 *          好像是正常的，只有这个路径点开，视频就无法播放。」
 *
 * 真因（与"老师端点开正常"对得上）：
 *   · 学生主页要列**全部**作品（含没公开的），那些作品**没有 share_token**；
 *   · 提交快照里引用的本地素材存的是学生域地址 `/api/student/file-assets/<id>/download`
 *     （见 studentRuntime 的 rewriteLocalReferences）；
 *   · 老师端/平台端预览会把这条地址换成 **OSS 签名直链**（admin/works.js 与 orgAdmin.js 的 ossUrls），
 *     所以那边能播；
 *   · 学生主页的网页作品直接把 `files` 丢进沙箱 iframe（opaque origin、不带 cookie），
 *     学生域地址必然 401 —— 视频、音频、图全取不到。
 *
 * 修法：`publicSnapshotFiles` 接受调用方给的 `mediaBase`；creator 作用域（`/api/public/creators/...`）
 * 把私有地址改写成 `${base}/images/<fileId>`（那条代理未登录可读、支持 Range）。
 * 已公开的作品仍走分享码那条代理 —— 这条守卫两边都钉。
 *
 * 跑法：
 *   node scripts/p190-creator-video-preview.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p190-creator-video-'));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('① 源码契约：creator 作用域也要改写私有素材地址');
{
  const vibecoding = read('apps/server/src/routes/vibecoding.js');
  const publicRoute = read('apps/server/src/routes/communication/public.js');
  check('`publicSnapshotFiles` 接受 `mediaBase`（未公开作品没有 share_token，只能靠它）',
    /export function publicSnapshotFiles\(submission, \{ mediaBase = '' \} = \{\}\)/.test(vibecoding));
  check('⭐ 拿到 mediaBase 就拼 `\${base}/images/<fileId>`（creator 代理那条路由的形状）',
    /`\$\{normalizedBase\}\/images\/\$\{encodeURIComponent\(fileId\)\}`/.test(vibecoding));
  check('没有 mediaBase 时**保留**分享码那条老路（已公开作品的响应形状不变）',
    /token \? `\/api\/public\/vibecoding-works\/\$\{encodeURIComponent\(token\)\}` : ''/.test(vibecoding));
  check('⭐ `publicVibeCodingWorkRow` 把 base 传下去（未公开才用 creator 作用域）',
    /publicSnapshotFiles\(row, \{ mediaBase: row\.share_token \? '' : base \}\)/.test(publicRoute));
  check('creator 媒体代理对音视频走 OSS 直链（`ossOffload`，与机构端/平台端同一条口径）',
    /prepareFilePreview\(ctx, file, \{ ossOffload: true \}\)/.test(publicRoute));
}

console.log('② 真请求：未公开作品里的视频 → creator 代理，真能取到字节');
{
  const baseEnv = {
    ...process.env,
    PLATFORM_DATA_DIR: temp,
    PLATFORM_DB_PATH: path.join(temp, 'platform.db'),
    FILE_UPLOAD_ROOT: path.join(temp, 'uploads'),
    DEPLOYMENT_MODE: 'local-mock',
  };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (x) => { err += x; });
    child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
  });
  const port = 19190;
  let server = null;
  let log = '';
  try {
    await run(['packages/database/src/db.js', '--init']);
    await run(['packages/database/src/seed.js']);

    const homeToken = 'ust_aaaabbbbccccddddeeeeffff';
    const videoId = 'file_p190_video';
    const foreignId = 'file_p190_foreign';
    const videoBytes = Buffer.alloc(64 * 1024, 0x47);
    const storageKey = 'p190/clip.mp4';
    const assetFile = path.join(temp, 'uploads', storageKey);
    fs.mkdirSync(path.dirname(assetFile), { recursive: true });
    fs.writeFileSync(assetFile, videoBytes);

    const now = new Date().toISOString();
    const db = new DatabaseSync(path.join(temp, 'platform.db'));
    const student = db.prepare("SELECT id, org_id FROM users WHERE login='student-2'").get();
    assert.ok(student, '夹具：需要种子里的 student-2');
    db.prepare('UPDATE users SET home_token=? WHERE id=?').run(homeToken, student.id);
    for (const [id, fileName] of [[videoId, 'clip.mp4'], [foreignId, 'other.mp4']]) {
      db.prepare('INSERT INTO file_assets(id,owner_type,owner_user_id,owner_org_id,storage_kind,storage_key,file_name,mime_type,file_size,category,visibility,status,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, 'USER', student.id, student.org_id, 'INTERNAL_PROXY', id === videoId ? storageKey : 'p190/other.mp4', fileName, 'video/mp4', videoBytes.length, 'MEDIA_ASSET', 'PRIVATE', 'ACTIVE', '{}', now, now);
    }
    // 入口 HTML：一条**真素材**引用（视频）+ 一条**不属于这份作品**的引用（不能被改写）
    const files = JSON.stringify({
      'index.html': `<!doctype html><html><body>
        <video id="demo" controls src="/api/student/file-assets/${videoId}/download"></video>
        <img src="/api/student/file-assets/${foreignId}/download">
      </body></html>`,
    });
    // 快照的产物清单：视频记在 `embeddedAssets`（studentRuntime 的 embeddedAssets 形状）
    const artifacts = JSON.stringify([{
      name: 'index.html', kind: 'html', bytes: 100, revision: 1, updatedAt: now, fileId: null,
      generatedImages: [], attachmentImages: [], embeddedImages: [], embeddedAssets: [{ fileId: videoId }],
      coverFileId: null,
    }]);
    db.prepare(`INSERT INTO vibecoding_conversations(id,org_id,student_id,title,model,files,entry_file,status,created_at,updated_at)
      VALUES ('p190_conv_private',?,?,'P190 会话（未公开）','local-mock',?,'index.html','DRAFT',?,?)`)
      .run(student.org_id, student.id, files, now, now);
    db.prepare(`INSERT INTO vibecoding_conversations(id,org_id,student_id,title,model,files,entry_file,status,created_at,updated_at)
      VALUES ('p190_conv_public',?,?,'P190 会话（已公开）','local-mock',?,'index.html','DRAFT',?,?)`)
      .run(student.org_id, student.id, files, now, now);
    // ⚠️ 每件提交要单独一个会话：`(conversation_id, entry_file)` 是唯一索引（同一会话里
    //    同一入口文件只能有一份提交）。
    const insertSubmission = (id, conversationId, title, shareToken) => db.prepare(`INSERT INTO vibecoding_submissions
      (id,conversation_id,student_id,org_id,title,files,round,status,submitted_at,created_at,updated_at,entry_file,artifacts,is_public,share_token,copyright_confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'PENDING', ?, ?, ?, 'index.html', ?, ?, ?, ?)`)
      .run(id, conversationId, student.id, student.org_id, title, files, now, now, now, artifacts, shareToken ? 1 : 0, shareToken, shareToken ? now : null);
    insertSubmission('p190_private', 'p190_conv_private', 'P190 未公开网页作品', null);
    insertSubmission('p190_public', 'p190_conv_public', 'P190 已公开网页作品', 'vbt_p190_public');
    db.close();

    server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (x) => { log += x; });
    server.stderr.on('data', (x) => { log += x; });
    for (let i = 0; i < 100; i += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ }
      await new Promise((r) => setTimeout(r, 100));
    }

    const get = async (pathname, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers, redirect: 'manual' });
      const text = await response.text().catch(() => '');
      let payload = {};
      try { payload = JSON.parse(text); } catch { /* 非 JSON（媒体字节） */ }
      return { status: response.status, headers: response.headers, data: payload?.data ?? payload, raw: text };
    };

    /* ②-1 未公开作品：详情里的视频地址必须是 creator 代理（不是学生域） */
    const privateBase = `/api/public/creators/${homeToken}/works/VIBECODING/p190_private`;
    const detail = await get(privateBase);
    const html = String(detail.data?.files?.['index.html'] || '');
    const creatorVideoUrl = `${privateBase}/images/${videoId}`;
    check('未公开作品的详情未登录可读', detail.status === 200, `HTTP ${detail.status}`);
    check('⭐ 视频地址已改写成 creator 代理（不再是学生域地址）',
      html.includes(creatorVideoUrl) && !html.includes(`/api/student/file-assets/${videoId}/download`),
      html.slice(0, 240));
    check('不属于这份作品的 fileId **不**被改写（准入名单只认快照里那几个）',
      html.includes(`/api/student/file-assets/${foreignId}/download`));

    /* ②-2 那个代理地址真能取到视频字节，并且支持 Range（浏览器播放要靠它拖动进度） */
    const ranged = await fetch(`http://127.0.0.1:${port}${creatorVideoUrl}`, { headers: { range: 'bytes=0-3' }, redirect: 'manual' });
    const rangedBytes = Buffer.from(await ranged.arrayBuffer());
    check('⭐ creator 代理取视频：206 + video/mp4 + 4 字节（`<video>` 真能播）',
      ranged.status === 206 && /^video\/mp4/i.test(ranged.headers.get('content-type') || '')
        && rangedBytes.length === 4 && /^bytes 0-3\//.test(ranged.headers.get('content-range') || ''),
      JSON.stringify({ status: ranged.status, type: ranged.headers.get('content-type'), bytes: rangedBytes.length, range: ranged.headers.get('content-range') }));
    const whole = await fetch(`http://127.0.0.1:${port}${creatorVideoUrl}`, { redirect: 'manual' });
    const wholeBytes = Buffer.from(await whole.arrayBuffer());
    check('完整取也能拿到全量字节（不是空播放器）',
      whole.status === 200 && wholeBytes.length === videoBytes.length, `HTTP ${whole.status} ${wholeBytes.length}B`);

    /* ②-3 不在快照里的 fileId 仍然被代理拒绝 */
    const foreign = await get(`${privateBase}/images/${foreignId}`);
    check('代理只放行快照里出现过的 fileId（拿别人的 id 换不出来）', foreign.status === 404, `HTTP ${foreign.status}`);

    /* ②-4 已公开作品：仍走分享码那条代理，响应形状不变 */
    const publicDetail = await get('/api/public/vibecoding-works/vbt_p190_public');
    const publicHtml = String(publicDetail.data?.files?.['index.html'] || '');
    const publicVideoUrl = '/api/public/vibecoding-works/vbt_p190_public/images/file_p190_video';
    check('已公开作品仍用分享码代理（没有因为这次改动换地址）',
      publicDetail.status === 200 && publicHtml.includes(publicVideoUrl), publicHtml.slice(0, 240));
    const publicVideo = await fetch(`http://127.0.0.1:${port}${publicVideoUrl}`, { headers: { range: 'bytes=0-3' }, redirect: 'manual' });
    check('分享码代理取视频：206 + video/mp4（老路径没被改坏）',
      publicVideo.status === 206 && /^video\/mp4/i.test(publicVideo.headers.get('content-type') || ''),
      JSON.stringify({ status: publicVideo.status, type: publicVideo.headers.get('content-type') }));

    /* ②-5 主页列表里这件作品指向 /u/<token>/w/...（未公开也能点开） */
    const home = await get(`/api/public/creators/${homeToken}`);
    const item = (home.data?.items || []).find((entry) => entry.id === 'p190_private');
    check('主页列表包含未公开的网页作品，且点开地址是 /u/<token>/w/VIBECODING/<id>',
      home.status === 200 && item?.publicUrl === `/u/${homeToken}/w/VIBECODING/p190_private`, String(item?.publicUrl));
  } catch (error) {
    failures += 1;
    console.error(log.slice(-1500));
    console.error('真请求段异常：', error.message);
  } finally {
    if (server) server.kill('SIGKILL');
  }
}

if (failures) {
  console.log(`\nP190 失败 ${failures} 项`);
  process.exit(1);
}
console.log('\nP190 全绿：学生主页里未公开作品的视频走 creator 代理，能播；已公开作品的分享码代理未被改坏。');
