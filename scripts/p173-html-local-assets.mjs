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
  if (raw) return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') || '', disposition: response.headers.get('content-disposition') || '' };
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

  /* ───────── ①b 素材类型矩阵：哪些能带、哪些带不了（2026-10-01 用户问「图视频音频都可以上传了吗」）─────
     用**最小合法字节**把每种类型都塞进一次提交，逐条钉死"能带"的那批。
     ⚠️ 钉的是**平台侧收不收**（存储层白名单 + 魔术字节），不是客户端扫不扫得到。 */
  let matrixWorkId = '';
  {
    const CASES = [
      ['assets/case.png', PNG, 'image/png'],
      ['assets/case.webp', Buffer.concat([Buffer.from('52494646', 'hex'), Buffer.from('24000000', 'hex'), Buffer.from('57454250', 'hex'), Buffer.from('56503820', 'hex'), Buffer.alloc(16)]), 'image/webp'],
      ['assets/case.wav', Buffer.concat([Buffer.from('52494646', 'hex'), Buffer.from('24000000', 'hex'), Buffer.from('57415645', 'hex'), Buffer.from('666d7420', 'hex'), Buffer.alloc(24)]), 'audio/wav'],
      ['assets/case.ogg', Buffer.concat([Buffer.from('4f676753', 'hex'), Buffer.alloc(32, 0x44)]), 'audio/ogg'],
      ['assets/case.pdf', Buffer.concat([Buffer.from('255044462d312e340a', 'hex'), Buffer.alloc(16, 0x20)]), 'application/pdf'],
      // ⭐ 2026-10-01 用户口径：「字体 woff/woff2/ttf/otf/svg/PPT word 这些都要能上传呀。」
      ['assets/case.woff2', Buffer.concat([Buffer.from('774f4632', 'hex'), Buffer.alloc(32, 0x55)]), 'font/woff2'],
      ['assets/case.ttf', Buffer.concat([Buffer.from('00010000', 'hex'), Buffer.alloc(32, 0x66)]), 'font/ttf'],
      ['assets/case.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', 'utf8'), 'image/svg+xml'],
      ['assets/case.docx', Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(32, 0x77)]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ];
    const matrixHtml = ['<!doctype html><html><body>']
      .concat(CASES.map(([name]) => `<img src="${name}">`))
      // ⭐ 内联 <script> 里的引用（学生做的小游戏就长这样）：要能被识别 + 回写
      .concat(['<script>var a = new Audio("assets/case.wav");</script></body></html>'])
      .join('');
    const matrix = await upload({
      // ⚠️ 入口名**必须与第一件作品不同**：同一次创作 + 同入口文件是**幂等更新**（round+1），
      //    用 index.html 会把上面那件作品覆盖掉（本守卫第一版就这么把自己的夹具改写了）。
      name: 'matrix.html', title: 'P173 素材矩阵', copyrightConfirmed: true,
      files: [{ name: 'matrix.html', content: matrixHtml, binary: false }]
        .concat(CASES.map(([name, buf]) => ({ name, content: buf.toString('base64'), binary: true }))),
    });
    matrixWorkId = matrix.data?.id || '';
    check('①b 素材矩阵：png/webp/wav/ogg/pdf/字体/svg/docx 一次全收下（2026-10-01 放开的 wav/ogg/pdf/字体/svg/Office）',
      matrix.status === 200 && !(matrix.data?.warnings || []).length,
      JSON.stringify(matrix.data?.warnings || []).slice(0, 240));
    const matrixRow = matrix.data?.id ? await arow('SELECT files FROM vibecoding_submissions WHERE id=?', [matrix.data.id]) : null;
    const matrixFiles = JSON.parse(matrixRow?.files || '{}');
    const saved = String(matrixFiles['matrix.html'] || '');
    for (const [name] of CASES) {
      const id = (await arow('SELECT id FROM file_assets WHERE file_name=? ORDER BY created_at DESC LIMIT 1', [name.split('/').pop()]))?.id;
      check(`①b ${name} 在 HTML 里被改写成私有下载地址`,
        Boolean(id) && saved.includes(`/api/student/file-assets/${id}/download`), saved.slice(0, 200));
    }
    check('⭐ ①b 内联 <script> 里的 `new Audio("assets/case.wav")` 也被改写（只看 src/href/url() 会永远漏）',
      /new Audio\("\/api\/student\/file-assets\/[\w-]+\/download"\)/.test(saved), saved.slice(-160));
  }

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

  /* ───────── ①c svg 的读口必须带 attachment（存储型 XSS 的补偿控制）─────────────
     svg 能带脚本，而"直接在地址栏打开"会让它在**我们域**里渲染执行。两条读口（机构端 image 代理、
     学生域下载）都要 `Content-Disposition: attachment`；`<img src>` 不受影响（disposition 只作用于顶层导航）。 */
  {
    const svgRow = await arow("SELECT id FROM file_assets WHERE file_name='case.svg' ORDER BY created_at DESC LIMIT 1");
    // ⚠️ 必须用**矩阵那件作品**的 id：svg 是随那次提交交上来的，用第一件会被准入名单拒（404）
    const orgSvg = svgRow?.id && matrixWorkId ? await api(`/api/org/works/VIBECODING/${encodeURIComponent(matrixWorkId)}/images/${encodeURIComponent(svgRow.id)}`, { token: orgToken, raw: true }) : { status: 0 };
    check('①c 机构端取 svg：通过准入且带 attachment（不是 inline）',
      ![404, 403].includes(orgSvg.status) && /attachment/i.test(String(orgSvg.disposition || '')),
      `status=${orgSvg.status} disposition=${orgSvg.disposition}`);
    const ownSvg = svgRow?.id ? await api(`/api/student/file-assets/${encodeURIComponent(svgRow.id)}/download`, { token, raw: true }) : { status: 0 };
    // ⭐ 2026-10-01 用户口径：「老师预览不能走 OSS 吗？」—— 钉住"两端都优先用签名直链 + CSP 放行"：
  //    没有这条，"又变成全量 base64 内联"会被无声改回去（几十兆字符串、几段视频就卡）。
  for (const [label, file] of [['机构端', 'apps/org/src/pages/classroom/ClassroomWork.jsx'], ['平台端', 'apps/admin/src/components/WorkPreview.jsx']]) {
    const source = fs.readFileSync(path.join(file), 'utf8');
    check(`①d ${label}预览优先用 OSS 签名直链（ossUrls）`,
      /data\?\.ossUrls/.test(source) && /ossUrls\[id\]/.test(source), file);
    check(`①d ${label}沙箱 CSP 放行了直链来源（mediaSources）`,
      /img-src data: blob: \$\{mediaSources\}/.test(source) && /media-src data: blob: \$\{mediaSources\}/.test(source), file);
  }
  check('①d 服务端给老师端/平台端的作品详情都带 ossUrls（2 小时有效期）',
    /ossRedirectUrl\(row, \{ expires: 7200 \}\)/.test(fs.readFileSync(path.join('apps', 'server', 'src', 'routes', 'orgAdmin.js'), 'utf8'))
    && /ossRedirectUrl\(row, \{ expires: 7200 \}\)/.test(fs.readFileSync(path.join('apps', 'server', 'src', 'routes', 'admin', 'works.js'), 'utf8')));
  check('①c 学生域下载口也带 attachment',
      ![404, 403].includes(ownSvg.status) && /attachment/i.test(String(ownSvg.disposition || '')),
      `status=${ownSvg.status} disposition=${ownSvg.disposition}`);
  }

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
  /* ─── ⑪ 扫描器不许把"代码/数据"当成缺素材（2026-10-02 老师端那条假警报）────────────
     现场：一份「文件管理」作品让老师端弹出「这件作品引用了 7 个本地素材（`name`、
     `new Blob([b], { type: mimeOf(name, path)` 等）」—— 全是 JS 代码片段。
     两个真因：① `url(` 在 `URL.createObjectURL(` 里也被匹配；② JS/HTML 里**所有引号串**都被
     当成引用，于是内置演示清单 `{name:'萌宠角色.png'}`、zip 内部条目 `zip.text('word/document.xml')`、
     接口路由 `fetch('./api/upload?name='…)` 全都成了"缺素材"（那份作品实际报了 13 条，一条真的没有）。
     判据收紧成：**只认真正取文件的上下文 + 必须带已知资源扩展名**。 */
  const { missingLocalAssets } = await import('../apps/server/src/routes/vibecoding.js');
  const NO_FALSE_POSITIVE = [
    ["<script>const u = URL.createObjectURL(new Blob([b], { type: mimeOf(name, path) }))</script>", 'createObjectURL 里的 url('],
    ["<script>const BUILTIN=[{name:'萌宠角色.png', size:2990481}];</script>", '内置演示清单'],
    ["<script>await zip.text('word/document.xml')</script>", 'zip 内部条目'],
    ["<script>const r = await fetch('./api/upload?name=' + n)</script>", '接口路由'],
    ['<script>const t="image/png"; const s="text/css";</script>', 'MIME 类型'],
    ['<style>body{font-family:"Segoe UI","PingFang SC",sans-serif}</style>', '字体栈'],
    ["<script>const k='SESSION[i].url', g='d.name';</script>", 'JS 标识符'],
    ["<script>const m = { image: 'assets/x.png' };</script>", '数据里的路径串（不是 URL 上下文）'],
  ];
  for (const [html, label] of NO_FALSE_POSITIVE) {
    const found = missingLocalAssets({ 'index.html': html }, 'index.html');
    check(`⑪ 不误报：${label}`, found.length === 0, JSON.stringify(found));
  }
  // 反向：真引用一条都不能漏（否则素材既不被收进作品清单、也不被回写）
  const STILL_FOUND = [
    ['<img src="assets/hero.png">', 'assets/hero.png'],
    ['<img src="hero.png">', 'hero.png'],
    ['<link rel="stylesheet" href="styles/main.css">', 'styles/main.css'],
    ['<style>.a{background:url("bg.jpg")}</style>', 'bg.jpg'],
    ["<script>new Audio('assets/sfx.wav').play()</script>", 'assets/sfx.wav'],
    ["<script>img.src = 'assets/pic.png'</script>", 'assets/pic.png'],
  ];
  for (const [html, expected] of STILL_FOUND) {
    const found = missingLocalAssets({ 'index.html': html }, 'index.html');
    check(`⑪ 真引用仍认：${expected}`, found.includes(expected), JSON.stringify(found));
  }
} finally {
  server.kill();
}

/* ─── ⑫ 预览沙箱的 CSP 口径（2026-10-02 客户端报「PDF/Word 内嵌预览被拦」）──────────────
   客户端原话：作品里 `iframe.src = URL.createObjectURL(pdfBlob)` 被 `frame-src 'none'` 拦成
   「已阻止此内容」，建议放行 `blob: data:`。平台侧确实该放（沙箱仍然 opaque-origin + 不联网），
   而且**两层都要放**：① 注入到学生文档的 meta；② 预览壳 `/vibe-preview.html` 的 nginx CSP
   （srcdoc 会继承壳的 CSP，只改一层等于没改）。
   ⚠️ 已知边界（受控实验，见 §九十三）：沙箱里 **blob HTML 子框架能显示**，
   而 Chrome 的**内置 PDF 查看器在沙箱框架里不工作**（同一份 PDF 不套沙箱能渲染、套上就只剩占位图标）
   —— PDF 要显示得走 pdf.js 之类渲染到 canvas 的路线，那时 `connect-src blob:` 正好够用。 */
console.log('⑫ 预览沙箱 CSP：放行 blob/data 子框架（两层都要放）');
{
  const readSource = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  for (const file of ['apps/org/src/pages/classroom/ClassroomWork.jsx', 'apps/admin/src/components/WorkPreview.jsx']) {
    const source = readSource(file);
    check(`⑫ ${file}：注入的 meta CSP 放行 frame-src blob: data:`, /frame-src blob: data:;/.test(source));
    check(`⑫ ${file}：放行 connect-src blob:（pdf.js 之类要 fetch(blob:)）`, /connect-src blob:;/.test(source));
    check(`⑫ ${file}：仍然不联网、不许表单、不许 base（收紧的部分一条都没松）`,
      /connect-src blob:;[^"]*form-action 'none'/.test(source) && !/connect-src [^;]*https?:/.test(source));
  }
  const nginx = readSource('deploy/production/nginx-site.conf');
  check('⑫ 预览壳（nginx /vibe-preview.html）的 frame-src 也放行了 blob:/data:',
    /media-src data: https: blob:; connect-src https: wss:; frame-src 'self' blob: data:/.test(nginx));
  // ⚠️ 2026-10-02 生产实测抓到的真 bug（P1）：`${mediaSources}` 被多写在 `style-src …;` 之后，
  //    于是作品**只要有任一 OSS 素材**（哪怕只是封面），CSP 就变成
  //    `style-src 'unsafe-inline'; https://…oss… img-src data: blob: …` —— 浏览器把
  //    「https://… img-src data: blob: …」当成一条**名字非法的指令**整条丢掉 ⇒ 真 img-src 不存在
  //    ⇒ 回落 `default-src 'none'` ⇒ 老师端预览里**所有图片被拦**（连 data:/blob: 一起）。
  //    没有 OSS 素材的作品那串是空的、CSP 恰好合法 —— 所以本地怎么都复现不出来。
  //    这条断言：**把占位符替换成一个假 OSS 源**再逐条检查指令名 —— 任何"值出现在指令名位置"
  //    的写法都会被它抓住（比"看某个字面量在不在"强得多）。
  const KNOWN_DIRECTIVES = new Set(['default-src', 'script-src', 'style-src', 'img-src', 'media-src', 'font-src',
    'connect-src', 'frame-src', 'form-action', 'base-uri', 'object-src', 'worker-src', 'manifest-src', 'child-src']);
  for (const file of ['apps/org/src/pages/classroom/ClassroomWork.jsx', 'apps/admin/src/components/WorkPreview.jsx']) {
    const source = readSource(file);
    const template = (source.match(/content="(default-src[^"]+)"/) || [])[1] || '';
    const filled = template.replaceAll('${mediaSources}', 'https://bucket.example.com ');
    const directives = filled.split(';').map((part) => part.trim()).filter(Boolean);
    const badNames = directives.map((part) => part.split(/\s+/)[0]).filter((name) => !KNOWN_DIRECTIVES.has(name));
    check(`⑫ ${file}：CSP 拼上 OSS 源之后每条指令名都合法（占位符没跑到指令名位置）`,
      Boolean(template) && badNames.length === 0, `非法指令名：${JSON.stringify(badNames)}`);
    const img = directives.find((part) => part.startsWith('img-src ')) || '';
    check(`⑫ ${file}：img-src 里 data:/blob:/OSS 源三样都在`, /data:/.test(img) && /blob:/.test(img) && /bucket\.example\.com/.test(img), img);
  }
  // PDF 桥的两条腿都要在（2026-10-03：第一版只写了"请求转上去"，结果学生在"正在渲染…"停住 ——
  // 请求上去了、结果回不来。回程那条同样是"必须的"，钉住它。）
  const shell = readSource('apps/website/public/vibe-preview.html');
  check('⑫ 预览壳把 PDF 渲染请求转给应用（上行）', /payload\.source === 'vibecoding-pdf-render'[\s\S]{0,120}parent\.postMessage/.test(shell));
  check('⑫ 预览壳把渲染结果转进 stage（下行 —— 少这条学生侧会永远停在"正在渲染…"）',
    /payload\.source === 'vibecoding-pdf-rendered'[\s\S]{0,140}stage\.contentWindow\.postMessage/.test(shell));
  const project = readSource('packages/shared/src/vibecodingProject.js');
  check('⑫ 学生侧注入了 PDF 桥（接管 iframe.src = createObjectURL(pdfBlob)）',
    /PDF_BRIDGE/.test(project) && /vibecoding-pdf-render/.test(project) && /HTMLIFrameElement\.prototype,\s*'src'/.test(project));
  check('⑫ PDF 桥装在学生脚本之前（preamble 里排在最后）',
    /\$\{PREVIEW_HEIGHT_BRIDGE\}\$\{PDF_BRIDGE\}/.test(project));
  const frame = readSource('packages/shared/src/console/PreviewFrame.jsx');
  check('⑫ 应用侧真的用 pdf.js 渲染（legacy 构建，老浏览器才有 Iterator）',
    /pdfjs-dist\/legacy\/build\/pdf\.mjs/.test(frame) && /renderPdfImages/.test(frame));
  // ⭐ 2026-10-03 第二类写法：学生页直接给**地址**（客户端的"文件管理"就是 `iframe.src = f.src`）。
  //    桥要认它，而且**白名单必须在应用侧**（学生递上来的 url 不能变成"让平台去打任意地址"的口子）。
  check('⑫ 学生侧也拦"指向 PDF 的地址"（不只 blob）',
    /looksLikePdfUrl/.test(project) && /requestUrl\(this,/.test(project));
  check('⑫ 应用侧对地址做白名单：本站路径 / 同源 / OSS 桶 / data:（别的统统拒）',
    /function safePdfUrl/.test(frame) && /OSS_HOST\.test\(parsed\.hostname\)/.test(frame)
    && /parsed\.origin === window\.location\.origin/.test(frame) && /data:application\\\/pdf/i.test(frame));
  check('⑫ 注释里不许在模板字符串内出现反引号（会把 PDF_BRIDGE 模板提前闭合 —— 本探针踩过一次）',
    !/`[^`]*\n[^`]*`/.test(project.split('export const PDF_BRIDGE = `')[1]?.split('`;\n')[0] || ''));
  // ⚠️ 只看**那个 iframe 标签**：文件顶上的注释里正解释着"内层不带 allow-same-origin"，
  //    整文件扫会把说明文字当成违规（写这条时当场踩到）。
  const stageTag = (shell.match(/<iframe id="stage"[^>]*>/) || [''])[0];
  check('⑫ 预览壳的内层 iframe 仍然**不带 allow-same-origin**（学生代码碰不到主站）',
    /sandbox="allow-scripts allow-modals allow-forms allow-popups"/.test(stageTag) && !/allow-same-origin/.test(stageTag),
    stageTag.slice(0, 120));
}

assert.equal(failures, 0, `P173 有 ${failures} 条断言没过`);
console.log('PASS: 网页作品的本地素材（子目录/图/视频/封面）全链路可提交、可预览、可分享，路径白名单未放松');
