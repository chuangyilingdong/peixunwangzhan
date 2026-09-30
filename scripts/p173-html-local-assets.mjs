/**
 * P173 「网页作品里的本地素材」全链路守卫（2026-09-30 用户报的两件事）。
 *
 * 用户口径（原话）：「网页作品提交之后 **教师后台的看作品里面图片/视频显示不出来**」+
 *   「图3作品分享，手机扫码能否……**直接显示作品**，点击后立马可以在线看游玩，而不是跳转」。
 *
 * 生产实据（`vibesub_cf3f389300224c448b06`，09-30 14:01 提交）：
 *   作品快照里只有 `index.html` 一个文本文件，而它的 HTML 引用了
 *   `assets/character_mecha.png` 与 `assets/transform.mp4` —— **两个字节都没上来**。
 *   三层原因，这一道全钉住：
 *     ① `safeArtifactName` 拒收带 `/` 的名字 → 客户端根本没把这些文件放进提交（放了就 400）；
 *     ② `normalizeLocalReference` 只认**平铺名** → 这类引用既不被收集、也不被回写；
 *     ③ `parseSnapshotArtifacts` 把 `coverFileId` 整个丢掉 + 准入名单只认图片 →
 *        封面恒 null、视频在老师端/分享页取不到。
 *
 * 钉的十条（正面 7 / 负面 3）：
 *   ① 带子目录的名字能提交（`assets/x.png` / `assets/x.mp4`），字节真进 file_assets；
 *   ② 入口 HTML 里的相对引用被改写成私有下载地址（`/api/student/file-assets/<id>/download`）；
 *   ③ 快照产物带 `embeddedAssets`（图 + 视频都在）与 `embeddedImages`（只有图）；
 *   ④ ⭐ `coverFileId` 活着：机构端详情/分享接口都能拿到它（这条是"归一化漏字段"的正面钉子）；
 *   ⑤ 机构端详情 `imageUrls` 覆盖图 + 视频，且两个代理地址**真能取到字节**（老师端才有图可显示）；
 *   ⑥ ⭐ 分享接口给网页件带可运行的 `document`（files + entry），素材地址换成**免登录**的分享域代理；
 *   ⑦ 那个免登录代理真能取到字节；`piece.coverUrl` 不再恒 null；
 *   ⑧ **负面**：`../index.html`、`assets/../../etc/passwd` 一律 400 INVALID_ARTIFACT_NAME（白名单没松）；
 *   ⑨ **负面**：不带 cookie 取别人的素材仍 404（准入还是"作品里引用过才放行"）；
 *   ⑩ 旧作品（引用了但没交素材）→ `missingAssets` 如实列出来（老师端据此说人话）。
 *
 * 跑法：node scripts/p173-html-local-assets.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p173-assets-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const PORT = 18973;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p173-guard-secret',
  PORT: String(PORT),
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);
await aq("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);
await aq("UPDATE class_sessions SET delivery_mode='VIBECODING'");

const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body, raw = false } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') || '' };
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
};

// 素材字节：一张 1×1 PNG + 一个最小 mp4（`ftyp` 开头，过得了服务端的魔术字节嗅探）
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
const MP4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.from('0000000066726565', 'hex'), Buffer.from('000000006d646174', 'hex'), Buffer.alloc(64, 0x11)]);
const ENTRY = [
  '<!doctype html><html><head><meta charset="utf-8"><title>星光战甲兽</title></head><body>',
  '<h1>我的星光战甲兽</h1>',
  '<img src="assets/character_mecha.png" alt="立绘">',
  '<video id="tfVideo" controls><source src="assets/transform.mp4" type="video/mp4"></video>',
  '</body></html>',
].join('');

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-800)}`);
    await sleep(150);
  }
  await sleep(300);

  const login = async (name, password) => (await api('/api/auth/login', { method: 'POST', body: { login: name, password } })).data?.token;
  const enrolled = await arow(`SELECT student.login FROM session_students part
       JOIN class_sessions session ON session.id = part.session_id AND session.status='ACTIVE'
       JOIN users student ON student.id = part.student_id
      WHERE part.status='ACTIVE' ORDER BY student.created_at LIMIT 1`);
  assert.ok(enrolled?.login, '夹具没把任何学生放进课堂');
  const token = await login(enrolled.login, 'study123');
  const upload = (body) => api('/api/student/runtime/submit-upload', { method: 'POST', token, body });

  /* ───────── ① 带子目录的素材提交 ───────── */
  const submitted = await upload({
    name: 'index.html', title: '星光战甲兽', copyrightConfirmed: true,
    cover: { content: PNG.toString('base64') },
    files: [
      { name: 'index.html', content: ENTRY, binary: false },
      { name: 'assets/character_mecha.png', content: PNG.toString('base64'), binary: true },
      { name: 'assets/transform.mp4', content: MP4.toString('base64'), binary: true },
    ],
  });
  check('① 带子目录的素材能随作品提交（assets/*.png + assets/*.mp4）',
    submitted.status === 200, JSON.stringify(submitted.data).slice(0, 300));
  const workId = submitted.data?.id || '';

  const filesRow = workId ? await arow('SELECT files, artifacts, entry_file FROM vibecoding_submissions WHERE id=?', [workId]) : null;
  const files = JSON.parse(filesRow?.files || '{}');
  const artifacts = JSON.parse(filesRow?.artifacts || '[]');
  const entryArtifact = artifacts.find((item) => item.name === 'index.html') || {};

  // ⭐⭐ 2026-09-30（生产 P1：老师端预览一张图都取不到、分享卡同样 —— 用户报「为什么视频这些还是不展示」）：
  //    字节在本地盘还是 OSS 的**唯一判据**是 `metadata.storageBackend`（缺省一律当本地盘）。
  //    `storeStudentArtifactAsset`（学生工作区素材 = 客户端随作品交上来的本地图/视频）原来**漏写了它**：
  //    字节进了 OSS、读面却 stat 本地盘 → `404 FILE_STORAGE_NOT_FOUND`。这一条把它钉住。
  await (async () => {
    const row = await arow("SELECT metadata FROM file_assets WHERE file_name='character_mecha.png'");
    let meta = {};
    try { meta = JSON.parse(row?.metadata || '{}') || {}; } catch { meta = {}; }
    check('① ⭐ 素材行必须记下 storageBackend（漏了读面按本地盘找 → 线上就是取不到字节）',
      meta.storageBackend === 'local' || meta.storageBackend === 'oss', JSON.stringify(meta).slice(0, 200));
  })();
  check('① 二进制的字节真进了 file_assets（文件名只留 basename，路径不落盘名）', await (async () => {
    const image = await arow("SELECT id, file_name, mime_type, file_size FROM file_assets WHERE mime_type='image/png' AND file_name='character_mecha.png'");
    const video = await arow("SELECT id, file_name, mime_type, file_size FROM file_assets WHERE mime_type='video/mp4' AND file_name='transform.mp4'");
    return Boolean(image && Number(image.file_size) === PNG.length && video && Number(video.file_size) === MP4.length);
  })());

  /* ───────── ② 引用被改写成私有下载地址 ───────── */
  const html = String(files['index.html'] || '');
  check('② 入口 HTML 里的相对引用被改写成私有下载地址（图 + 视频都改到）',
    (html.match(/\/api\/student\/file-assets\/[\w-]+\/download/g) || []).length === 2 && !/assets\/character_mecha\.png|assets\/transform\.mp4/.test(html),
    html.slice(0, 400));

  /* ───────── ③ 快照的准入名单 ───────── */
  const embeddedAssets = Array.isArray(entryArtifact.embeddedAssets) ? entryArtifact.embeddedAssets : [];
  const embeddedImages = Array.isArray(entryArtifact.embeddedImages) ? entryArtifact.embeddedImages : [];
  check('③ 入口产物带 embeddedAssets（图 + 视频各一条）', embeddedAssets.length === 2, JSON.stringify(entryArtifact).slice(0, 300));
  check('③ embeddedImages 只收图片那一半（PPT 那套按图读，别混进视频）', embeddedImages.length === 1, JSON.stringify(embeddedImages));
  check('④ coverFileId 在快照里活着（客户端截的封面）', Boolean(entryArtifact.coverFileId), JSON.stringify(entryArtifact).slice(0, 200));

  /* ───────── ④/⑤ 机构端（老师后台）详情 + 取图/取视频 ───────── */
  const orgToken = await login('org-admin', 'org123');
  const detail = await api(`/api/org/works/VIBECODING/${encodeURIComponent(workId)}`, { token: orgToken });
  const imageUrls = detail.data?.imageUrls || {};
  check('⑤ 机构端详情把图与视频都列进 imageUrls（老师端才拿得到字节）',
    Object.keys(imageUrls).length >= 2 && Object.values(imageUrls).every((url) => String(url).includes('/api/org/works/')),
    JSON.stringify(Object.keys(imageUrls)));
  check('⑤ 机构端详情带 missingAssets 且为空（素材都上来了）',
    Array.isArray(detail.data?.missingAssets) && detail.data.missingAssets.length === 0,
    JSON.stringify(detail.data?.missingAssets));
  // ⚠️ 按 mime 找 id，**不能按 imageUrls 的键顺序**取：那一组里还有客户端截的封面（也是 png），
  //    顺序由服务端拼装顺序决定 —— 按顺序取会把封面当成"视频"来断言（本守卫第一版就这么错过一次）。
  const imageAsset = await arow("SELECT id FROM file_assets WHERE mime_type='image/png' AND file_name='character_mecha.png'");
  const videoAsset = await arow("SELECT id FROM file_assets WHERE mime_type='video/mp4' AND file_name='transform.mp4'");
  check('⑤ imageUrls 里同时有那张立绘和那段变身视频',
    Boolean(imageUrls[imageAsset?.id]) && Boolean(imageUrls[videoAsset?.id]), JSON.stringify(Object.keys(imageUrls)));
  const imageBytes = imageUrls[imageAsset?.id] ? await api(imageUrls[imageAsset.id], { token: orgToken, raw: true }) : { status: 0 };
  const videoBytes = imageUrls[videoAsset?.id] ? await api(imageUrls[videoAsset.id], { token: orgToken, raw: true }) : { status: 0 };
  check('⑤ 机构端真取到图的字节（与上传逐字一致）',
    imageBytes.status === 200 && Buffer.compare(imageBytes.buffer, PNG) === 0, `status=${imageBytes.status} bytes=${imageBytes.buffer?.length}`);
  check('⑤ 机构端真取到视频的字节',
    videoBytes.status === 200 && Buffer.compare(videoBytes.buffer, MP4) === 0, `status=${videoBytes.status} bytes=${videoBytes.buffer?.length}`);

  /* ───────── ⑥/⑦ 分享页：网页件就地可玩 ───────── */
  const shared = await api('/api/student/share-links', { method: 'POST', token, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:index.html' } });
  const code = shared.data?.code || '';
  check('⑥ 能发一枚网页件的分享码', Boolean(code), JSON.stringify(shared.data).slice(0, 200));
  const card = code ? await api(`/api/public/share-links/${encodeURIComponent(code)}`) : { data: null };
  const doc = card.data?.document;
  check('⑥ ⭐ 分享接口给网页件带可运行的文档（files + entry）',
    Boolean(doc?.files?.['index.html']) && doc?.entry === 'index.html', JSON.stringify(Object.keys(doc || {})).slice(0, 200));
  const docHtml = String(doc?.files?.['index.html'] || '');
  check('⑥ 文档里的素材地址换成了**免登录**的分享域代理',
    docHtml.includes(`/api/public/share-links/${code}/media/`) && !docHtml.includes('/api/student/file-assets/'),
    docHtml.slice(0, 400));
  check('⑦ piece.coverUrl 不再是 null（封面链路修好）', Boolean(card.data?.piece?.coverUrl), JSON.stringify(card.data?.piece));
  const publicMedia = docHtml.match(/\/api\/public\/share-links\/[\w-]+\/media\/([\w-]+)/)?.[1] || '';
  const publicBytes = publicMedia ? await api(`/api/public/share-links/${encodeURIComponent(code)}/media/${publicMedia}`, { raw: true }) : { status: 0 };
  check('⑦ 不带 cookie 也能取到那一件的素材字节（沙箱里没有 cookie）',
    publicBytes.status === 200 && Buffer.compare(publicBytes.buffer, PNG) === 0, `status=${publicBytes.status} bytes=${publicBytes.buffer?.length}`);
  check('⑩ 分享卡也带 missingAssets（空 = 素材齐）',
    Array.isArray(card.data?.missingAssets) && card.data.missingAssets.length === 0, JSON.stringify(card.data?.missingAssets));

  /* ───────── ⑧ 负面：路径白名单没松 ───────── */
  const escapeOne = await upload({ name: '../index.html', copyrightConfirmed: true, files: [{ name: '../index.html', content: ENTRY }] });
  check('⑧ ../index.html → 400 INVALID_ARTIFACT_NAME',
    escapeOne.data?.error?.code === 'INVALID_ARTIFACT_NAME', JSON.stringify(escapeOne.data).slice(0, 200));
  const escapeTwo = await upload({ name: 'index.html', copyrightConfirmed: true, files: [{ name: 'index.html', content: ENTRY }, { name: 'assets/../../etc/passwd', content: 'x' }] });
  check('⑧ assets/../../etc/passwd → 400 INVALID_ARTIFACT_NAME',
    escapeTwo.data?.error?.code === 'INVALID_ARTIFACT_NAME', JSON.stringify(escapeTwo.data).slice(0, 200));

  /* ───────── ⑨ 负面：别人的素材还是取不到 ───────── */
  const stranger = await api(`/api/public/share-links/${encodeURIComponent(code)}/media/file_00000000000000000000`, { raw: true });
  check('⑨ 拿一个不属于这一件的 fileId 去取 → 404（准入没被放宽）', stranger.status === 404, `status=${stranger.status}`);

  /* ───────── ⑩ 旧作品：素材没交上来时如实列出来 ───────── */
  const legacy = await upload({
    name: 'index.html', title: '旧客户端交的作品', copyrightConfirmed: true,
    files: [{ name: 'index.html', content: ENTRY, binary: false }],
  });
  const legacyDetail = legacy.data?.id ? await api(`/api/org/works/VIBECODING/${encodeURIComponent(legacy.data.id)}`, { token: orgToken }) : { data: null };
  const missing = Array.isArray(legacyDetail.data?.missingAssets) ? legacyDetail.data.missingAssets : [];
  check('⑩ 旧作品（只有 index.html）→ missingAssets 如实列出两个本地素材',
    missing.includes('assets/character_mecha.png') && missing.includes('assets/transform.mp4'), JSON.stringify(missing));
} finally {
  server.kill();
}

assert.equal(failures, 0, `P173 有 ${failures} 条断言没过`);
console.log('PASS: 网页作品的本地素材（子目录/图/视频/封面）全链路可提交、可预览、可分享，路径白名单未放松');
