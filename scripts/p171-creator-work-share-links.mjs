/**
 * P171 「学生主页侧的作品分享」（2026-09-30 用户口径）守卫。
 *
 * 用户口径原话：「这个分享只针对于学生的主页」「比如这节课有 1 个图片和 1 个视频，每个都可以独立去分享」
 * 「不要跟作品广场混淆」「不存在重做的说法，提交了作品就是最新的」「机构名分享」。
 *
 * 这一道钉的六件事（前两条是口径，后面是行为）：
 *   ① ⭐ **与作品广场解耦**：码是从 `work_share_links` 发的，**不看 is_public / share_token** ——
 *      给一件**未公开**的作品发码要能成功，而且发码前后 `is_public` 与 `share_token` **一个字节都不变**
 *      （广场那套审核/上下架的口径完全不受影响）；
 *   ② ⭐ **逐件独立**：同一件作品里的两件产出物 → 两枚**不同**的码，各自解析到**各自那一件**
 *      （一节课出 1 张图 + 1 段视频，就是两件）；
 *   ③ **幂等**：同一件重复点分享 → 同一枚码（QR 不会满天飞）；
 *   ④ **越权/无效**：别人的作品发码 404；不存在的码 404；码里**不含主页 token**；
 *   ⑤ **媒体**：那一件的字节能取到（与上传逐字一致）；**不属于那一件的 fileId** 必须 404；
 *   ⑥ **卡面数据**：学生名 / **机构名** / **课时标题** / 那一件的渲染类型齐。
 *
 * 跑法：node scripts/p171-creator-work-share-links.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureClassroom } from './lib/classroomFixture.mjs';
import { stripComments } from './lib/sourceText.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p171-share-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { aq, arow } = await import('../packages/database/src/store.js');

const PORT = 18971;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
  RUNTIME_GATEWAY_SECRET: 'p171-secret',
  PORT: String(PORT),
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
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
await ensureClassroom(dbPath);
{
  // 运行时接口只认 VIBECODING 课堂
  await aq("UPDATE class_sessions SET delivery_mode='VIBECODING'");
  await aq("UPDATE course_lessons SET delivery_mode='VIBECODING', delivery_modes=?", [JSON.stringify(['VIBECODING'])]);
}
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
};
const login = async (name) => (await api('/api/auth/login', { method: 'POST', body: { login: name, password: 'study123' } })).data?.token;

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-600)}`);
    await sleep(150);
  }
  const studentToken = await login('student-1');
  const otherToken = await login('student-2');
  check('① 两个学生都能登录（越权那条要用第二个）', Boolean(studentToken && otherToken));

  /* ── 夹具：交一件 VibeCoding 作品（入口是 pptx → 有真字节；另有两件文本产出物）── */
  const pptxBytes = Buffer.from('PK\u0003\u0004 p171 假的 pptx 字节（只为验字节一致）', 'utf8');
  const submitted = await api('/api/student/runtime/submit-upload', {
    method: 'POST', token: studentToken,
    body: {
      name: 'deck.pptx', title: 'P171 一件作品三件产出物', copyrightConfirmed: true,
      files: [
        { name: 'deck.pptx', content: pptxBytes.toString('base64'), binary: true },
        { name: 'index.html', content: '<!doctype html><html><body>P171</body></html>', binary: false },
        { name: 'notes.txt', content: 'P171 说明文本', binary: false },
      ],
    },
  });
  const workId = submitted.data?.id;
  check('夹具：VibeCoding 作品提交成功', submitted.status === 200 && Boolean(workId), JSON.stringify(submitted.raw).slice(0, 200));

  /* ── ① 与广场解耦：发码前后 is_public / share_token 一个字节都不变 ── */
  const before = await arow('SELECT is_public, share_token FROM vibecoding_submissions WHERE id=?', [workId]);
  check('① 这件作品**没有**公开到广场（is_public=0、无 share_token）',
    Number(before?.is_public || 0) === 0 && !before?.share_token, JSON.stringify(before));

  const deck = await api('/api/student/share-links', { method: 'POST', token: studentToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:deck.pptx' } });
  const deckCode = deck.data?.code;
  check('① ⭐ **未公开的作品也能发分享码**（这是与广场解耦的核心）',
    deck.status === 200 && Boolean(deckCode) && String(deck.data?.url || '').startsWith('/s/'),
    JSON.stringify(deck.raw).slice(0, 200));
  const after = await arow('SELECT is_public, share_token FROM vibecoding_submissions WHERE id=?', [workId]);
  check('① ⭐ 发码前后 `is_public` / `share_token` **一个字节都没变**（没动广场那套）',
    Number(after?.is_public || 0) === Number(before?.is_public || 0) && String(after?.share_token || '') === String(before?.share_token || ''),
    JSON.stringify({ before, after }));

  /* ── ② 逐件独立 ── */
  const html = await api('/api/student/share-links', { method: 'POST', token: studentToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:index.html' } });
  check('② 同一件作品的另一件产出物 → **另一枚码**',
    html.status === 200 && Boolean(html.data?.code) && html.data.code !== deckCode,
    JSON.stringify({ deck: deckCode, html: html.data?.code }));
  check('② 主页要知道"哪几件已分享"：列表里两枚码、键各不相同',
    (await (async () => {
      const listed = await api(`/api/student/share-links?workId=${encodeURIComponent(workId)}`, { token: studentToken });
      const keys = new Set((listed.data?.items || []).map((item) => item.pieceKey));
      return listed.status === 200 && keys.size === 2 && keys.has('artifact:deck.pptx') && keys.has('artifact:index.html');
    })()));

  /* ── ③ 幂等 ── */
  const again = await api('/api/student/share-links', { method: 'POST', token: studentToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:deck.pptx' } });
  check('③ 同一件重复发码 → **同一枚码**、created=false',
    again.data?.code === deckCode && again.data?.created === false, JSON.stringify(again.data).slice(0, 160));

  /* ── ④ 越权 / 无效 / 码里没有主页 token ── */
  const steal = await api('/api/student/share-links', { method: 'POST', token: otherToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:deck.pptx' } });
  check('④ 别人给我的作品发码 → 404（不泄露"存在但不是你的"）', steal.status === 404, `status=${steal.status}`);
  const wrongPiece = await api('/api/student/share-links', { method: 'POST', token: studentToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:不存在.png' } });
  check('④ 给一件不存在的产出物发码 → 400 SHARE_PIECE_NOT_FOUND',
    wrongPiece.status === 400 && wrongPiece.raw?.error?.code === 'SHARE_PIECE_NOT_FOUND', JSON.stringify(wrongPiece.raw).slice(0, 160));
  // 主页 token 种子不预生成（学生第一次进主页时才发）—— 这里先给它一枚，才验得了'码里不含主页 token'
  const STUDENT_HOME_TOKEN = 'hometoken_p171_fixture';
  await aq('UPDATE users SET home_token=? WHERE login=?', [STUDENT_HOME_TOKEN, 'student-1']);
  const homeToken = STUDENT_HOME_TOKEN;
  check('④ ⭐ 码是**不透明**的：不含学生主页 token（分享一件 ≠ 交出整个主页）',
    Boolean(deckCode) && Boolean(homeToken) && !deckCode.includes(homeToken), `code=${deckCode} home=${homeToken ? '有' : '无'}`);
  const bogus = await api('/api/public/share-links/shs_0000000000000000000000000');
  check('④ 不存在的码 → 404', bogus.status === 404, `status=${bogus.status}`);

  /* ── ⑤⑥ 公开卡面 + 媒体（访客不带任何凭据）── */
  const card = await api(`/api/public/share-links/${deckCode}`);
  check('⑥ 分享卡数据齐：学生名 / **机构名** / **课时标题** / 那一件',
    card.status === 200
    && Boolean(card.data?.student?.name) && Boolean(card.data?.org?.name) && Boolean(card.data?.lessonTitle)
    && card.data?.piece?.render === 'DOC' && Boolean(card.data?.piece?.fileId),
    JSON.stringify(card.data).slice(0, 260));
  const htmlCard = await api(`/api/public/share-links/${html.data.code}`);
  check('⑥ 另一枚码解析到**另一件**（render=HTML、fileId 为空、各是各的）',
    htmlCard.status === 200 && htmlCard.data?.piece?.render === 'HTML' && !htmlCard.data?.piece?.fileId,
    JSON.stringify(htmlCard.data?.piece || {}).slice(0, 200));

  const fileId = card.data?.piece?.fileId;
  const media = await fetch(`http://127.0.0.1:${PORT}/api/public/share-links/${deckCode}/media/${fileId}`);
  const mediaBytes = Buffer.from(await media.arrayBuffer());
  check('⑤ 那一件的字节能取到、与上传**逐字一致**（访客不带任何凭据）',
    media.status === 200 && mediaBytes.equals(pptxBytes), `status=${media.status} 字节=${mediaBytes.length}/${pptxBytes.length}`);
  const crossPiece = await fetch(`http://127.0.0.1:${PORT}/api/public/share-links/${html.data.code}/media/${fileId}`);
  check('⑤ ⚠️ 拿**这一件**的码去取**别件**的文件 → 404（准入按"件"卡）', crossPiece.status === 404, `status=${crossPiece.status}`);

  /* ── ② 画布侧：一节课出 1 图 + 1 视频 → 各自独立 ── */
  const now = new Date().toISOString();
  const student = await arow("SELECT id, org_id FROM users WHERE login='student-1'");
  // ⚠️ works.project_id 是外键（NOT NULL）—— 先插一条项目行，照 p13 那套列（少一列就 FOREIGN KEY failed）
  const lessonId = (await arow("SELECT lesson_id FROM class_sessions WHERE status='ACTIVE' LIMIT 1"))?.lesson_id || null;
  await aq('INSERT INTO student_projects(id,student_id,org_id,class_id,course_lesson_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['project_p171', student.id, student.org_id, null, lessonId, 'P171 画布项目', 'SUBMITTED', JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), 1, now, now, now]);
  const canvasWorkId = 'work_p171_canvas';
  await aq('INSERT INTO works(id,project_id,student_id,org_id,class_id,course_lesson_id,title,canvas_snapshot,submitted_at,status) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [canvasWorkId, 'project_p171', student.id, student.org_id, null, lessonId, 'P171 画布作品',
      JSON.stringify({ nodes: [
        { id: 'n-img', type: 'image', position: { x: 0, y: 0 }, data: { slotType: 'image', assetUrl: '/api/student/file-assets/file_p171_img/download', caption: 'P171 图片' } },
        { id: 'n-vid', type: 'video', position: { x: 0, y: 0 }, data: { slotType: 'video', assetUrl: '/api/student/file-assets/file_p171_vid/download', caption: 'P171 视频' } },
      ], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), now, 'PENDING']);
  const imageCode = await api('/api/student/share-links', { method: 'POST', token: studentToken, body: { source: 'CANVAS', workId: canvasWorkId, pieceKey: 'media:file_p171_img' } });
  const videoCode = await api('/api/student/share-links', { method: 'POST', token: studentToken, body: { source: 'CANVAS', workId: canvasWorkId, pieceKey: 'media:file_p171_vid' } });
  const imageCard = await api(`/api/public/share-links/${imageCode.data?.code}`);
  const videoCard = await api(`/api/public/share-links/${videoCode.data?.code}`);
  check('② 画布侧：一节课的 1 图 + 1 视频 → 两枚码，各自解析成 IMAGE / VIDEO',
    imageCode.status === 200 && videoCode.status === 200 && imageCode.data.code !== videoCode.data.code
    && imageCard.data?.piece?.render === 'IMAGE' && videoCard.data?.piece?.render === 'VIDEO',
    JSON.stringify({ image: imageCard.data?.piece, video: videoCard.data?.piece }).slice(0, 240));
  check('⑥ 画布侧卡面也带课时标题（作品简介就取它）', Boolean(imageCard.data?.lessonTitle), JSON.stringify(imageCard.data?.lessonTitle));

  /* ── ⑦ 主页清单与分享码**同一套键**（各枚举一套 → "主页上看得见却分享不了"）── */
  const creatorPayload = await api(`/api/public/creators/${STUDENT_HOME_TOKEN}`);
  const vibeItem = (creatorPayload.data?.items || []).find((item) => item.id === workId);
  const vibeKeys = (vibeItem?.artifacts || []).map((item) => item.pieceKey).filter(Boolean);
  check('⑦ 主页的作品清单里每件产物都带 pieceKey（含**二进制那份 .pptx** —— 它不在 files 里）',
    vibeKeys.includes('artifact:deck.pptx') && vibeKeys.includes('artifact:index.html') && vibeKeys.includes('artifact:notes.txt'),
    JSON.stringify(vibeItem?.artifacts || []).slice(0, 260));
  const notesShare = await api('/api/student/share-links', { method: 'POST', token: studentToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:notes.txt' } });
  check('⑦ ⭐ 主页给的那个键，发码接口**照单接受**（两边同一套规则，不是各枚举一套）',
    notesShare.status === 200, JSON.stringify(notesShare.raw).slice(0, 160));

  /* ── ⑦b 文本件：分享卡要**直接显示内容**（2026-09-30 用户口径）────────────
     用户原话：「图3 打开体验，应该不能这样展示，应该就**直接展示**」——他截的那一件是
     `notes.txt`，卡片上只有一颗「打开体验」按钮。现在服务端把**人读得懂**的正文一起给出去。 */
  {
    const card = await api(`/api/public/share-links/${encodeURIComponent(notesShare.data.code)}`);
    const piece = card.data?.piece || {};
    check('⑦b ⭐ 文本件的分享卡带正文（卡面直接铺开显示，不再只给按钮）',
      piece.textContent === 'P171 说明文本' && piece.textTruncated === false,
      JSON.stringify({ render: piece.render, textContent: piece.textContent, truncated: piece.textTruncated }));
    const htmlCard = await api(`/api/public/share-links/${encodeURIComponent(html.data.code)}`);
    check('⑦b 网页件不吃这一套（它的正文走 document，textContent 为空）',
      !htmlCard.data?.piece?.textContent, JSON.stringify(htmlCard.data?.piece).slice(0, 160));
    // 静态：删掉的那两句"多余文案"不许回来（用户：「分享按钮这些多余的文案全部删除」）
    const cardPage = fs.readFileSync(path.join('apps', 'website', 'src', 'pages', 'WorkShare.jsx'), 'utf8');
    const panel = fs.readFileSync(path.join('packages', 'shared', 'src', 'workShare.jsx'), 'utf8');
    // ⚠️ 用 stripComments 剥掉注释再判：这两处**注释里**写着"这两句已删"，直接匹配会自己骗自己
    //    （本守卫第一版就这么假红过一次）。
    for (const [file, source] of [['WorkShare.jsx', stripComments(cardPage)], ['workShare.jsx', stripComments(panel)]]) {
      check(`⑦b ${file} 不再有"在微信里打开时…"那类引导文案`, !/在微信里打开时/.test(source));
      check(`⑦b ${file} 不再有「看 TA 的主页」跳转`, !/看 TA 的主页/.test(source));
    }
    check('⑦b 分享卡里文本件走 share-piece__text（就地铺开）', /share-piece__text/.test(cardPage));

    /* ── ⑦c 真文件类产物：分享卡**就地 iframe 预览**（服务端转 PDF，与作品广场同一条路）────
       用户 2026-09-30 口径：「应该就**直接展示**就像图4那样」——PPT/Word/Excel 的 .pptx 浏览器渲染不了，
       卡片上只给「打开体验」等于没展示。这一条钉三件事：载荷带 previewUrl、授权边界仍然只认作品里的文件、
       URL 形状是分享码专属的那条（不误用广场那条）。 */
    const deckCard = await api(`/api/public/share-links/${encodeURIComponent(deckCode)}`);
    const deckPiece = deckCard.data?.piece || {};
    check('⑦c ⭐ 真文件产物（deck.pptx）的分享卡带 previewUrl（就地 iframe 预览）',
      typeof deckPiece.previewUrl === 'string' && deckPiece.previewUrl.includes('/files/') && deckPiece.previewUrl.endsWith('/preview'),
      JSON.stringify(deckPiece).slice(0, 220));
    check('⑦c previewUrl 走的是**分享码专属**那条口（不是广场的 vibecoding-works）',
      String(deckPiece.previewUrl || '').startsWith(`/api/public/share-links/${deckCode}/files/`),
      String(deckPiece.previewUrl || ''));
    // 授权边界：作品快照里没有的文件名 → 404（别拿它当万能文件代理）
    const foreignDoc = await api(`/api/public/share-links/${encodeURIComponent(deckCode)}/files/not-in-work.pptx/preview`);
    check('⑦c 作品里没有的文件名 → 404（预览口不是文件代理）',
      foreignDoc.status === 404, `status=${foreignDoc.status}`);
    // 形状对的那种：**授权过了**（本地没装 LibreOffice 时转换会失败，所以只钉"不是 404/403"）
    const realDoc = await api(deckPiece.previewUrl);
    check('⑦c 作品里真有的那份文件：通过授权（不是 404 / 403）—— 转换本身要服务器上的 LibreOffice',
      ![404, 403].includes(realDoc.status), `status=${realDoc.status}`);
    check('⑦c 分享卡里真文件走 share-piece__doc（就地 PDF）', /share-piece__doc/.test(cardPage));
  }
  const canvasItem = (creatorPayload.data?.items || []).find((item) => item.id === canvasWorkId);
  const canvasKeys = (canvasItem?.media || []).map((item) => item.pieceKey).filter(Boolean);
  check('⑦ 画布侧主页清单也带 pieceKey（1 图 + 1 视频两件）',
    canvasKeys.includes('media:file_p171_img') && canvasKeys.includes('media:file_p171_vid'), JSON.stringify(canvasKeys));

  /* ── ⑧ 机构/老师端（用户口径：「机构端/老师端也需要有」）────────────────────
     范围要与「学生学习结果与作品」那张表**同一套**：本机构 + （老师）只限自己课堂。
     码归**作品的作者（学生）** → 老师与学生拿到的必须是**同一枚码**（幂等跨端一致）。 */
  const loginAs = async (name, password) => (await api('/api/auth/login', { method: 'POST', body: { login: name, password } })).data?.token;
  const orgSession = await arow("SELECT id, teacher_id, org_id FROM class_sessions WHERE status='ACTIVE' LIMIT 1");
  const ownerTeacher = orgSession?.teacher_id ? await arow('SELECT login FROM users WHERE id=?', [orgSession.teacher_id]) : null;
  const otherTeacher = await arow("SELECT login FROM users WHERE role='TEACHER' AND org_id=? AND id<>? LIMIT 1", [orgSession?.org_id || '', orgSession?.teacher_id || 'teacher-none']);
  const adminOrgToken = await loginAs('org-admin', 'org123');
  const ownerTeacherToken = ownerTeacher?.login ? await loginAs(ownerTeacher.login, 'teach123') : '';
  const otherTeacherToken = otherTeacher?.login ? await loginAs(otherTeacher.login, 'teach123') : '';
  check('⑧ 机构管理员 / 这间课堂的老师 / 同机构另一个老师，都能登录',
    Boolean(adminOrgToken && ownerTeacherToken && otherTeacherToken), JSON.stringify({ org: Boolean(adminOrgToken), owning: Boolean(ownerTeacherToken), other: Boolean(otherTeacherToken) }));

  const orgShare = await api('/api/org/share-links', { method: 'POST', token: adminOrgToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:index.html' } });
  check('⑧ ⭐ 机构管理员能替学生分享，拿到的**与学生自己那枚是同一枚**（幂等跨端一致）',
    orgShare.status === 200 && orgShare.data?.code === html.data?.code,
    JSON.stringify({ org: orgShare.data?.code, student: html.data?.code }));
  const teacherShare = await api('/api/org/share-links', { method: 'POST', token: ownerTeacherToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:notes.txt' } });
  check('⑧ 老师（这间课堂是他的）也能发码', teacherShare.status === 200 && Boolean(teacherShare.data?.code), JSON.stringify(teacherShare.raw).slice(0, 160));
  const foreign = await api('/api/org/share-links', { method: 'POST', token: otherTeacherToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:notes.txt' } });
  check('⑧ ⚠️ **不是他课堂的**老师 → 404（范围卡住，与作品表同一套判据）', foreign.status === 404, `status=${foreign.status}`);
  const teacherCard = await api(`/api/public/share-links/${teacherShare.data?.code}`);
  check('⑧ 老师分享出去的卡面上仍是**学生与他的机构**（码归作者，不归分享者）',
    teacherCard.status === 200 && Boolean(teacherCard.data?.student?.name) && Boolean(teacherCard.data?.org?.name),
    JSON.stringify(teacherCard.data).slice(0, 200));

  /* ── ⑨ 机构端的载荷也要带 pieceKey（老师那条路同样要"选哪一件"）────────────── */
  const orgWorks = await api('/api/org/works?includeSnapshot=true', { token: adminOrgToken });
  const orgItem = (orgWorks.data?.items || []).find((item) => item.id === canvasWorkId);
  const orgKeys = (orgItem?.media || []).map((item) => item.pieceKey).filter(Boolean);
  check('⑨ 机构端作品**列表**里每件带 pieceKey（画布 1 图 + 1 视频）',
    orgKeys.includes('media:file_p171_img') && orgKeys.includes('media:file_p171_vid'), JSON.stringify(orgKeys));
  const orgDetail = await api(`/api/org/works/VIBECODING/${encodeURIComponent(workId)}`, { token: adminOrgToken });
  const orgArtifactKeys = (orgDetail.data?.artifacts || []).map((item) => item.pieceKey).filter(Boolean);
  check('⑨ 机构端作品**详情**（老师点开的那一屏）也带 pieceKey',
    orgArtifactKeys.includes('artifact:deck.pptx') && orgArtifactKeys.includes('artifact:index.html'),
    JSON.stringify(orgArtifactKeys).slice(0, 200));
  const orgFromDetail = await api('/api/org/share-links', { method: 'POST', token: adminOrgToken, body: { source: 'VIBECODING', workId, pieceKey: 'artifact:deck.pptx' } });
  check('⑨ 机构端详情给的键，机构端发码接口**照单接受**', orgFromDetail.status === 200, JSON.stringify(orgFromDetail.raw).slice(0, 160));
} catch (error) {
  failures += 1;
  console.error('P171 抛错：', error?.message || error);
  console.error(serverLog.split('\n').slice(-12).join('\n'));
} finally {
  server.kill('SIGTERM');
}

// ⑩ 静态：三处「分享」入口的**位置**必须同款（用户 2026-09-30 点名要"右上角"）。
//    ⚠️ 2026-10-01：机构端**课堂**里那份原来落在弹窗底部按钮行（当时那个弹窗没有页眉插槽）——
//    已经给弹窗加了 `headerAction` 并挪到右上角；这条钉住别再掉回去。
console.log('⑩ 三处「分享」入口都在右上角（面板/弹窗页眉），没有掉到底部按钮行');
{
  const readFile = (file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  const classroom = readFile('apps/org/src/pages/classroom/ClassroomWork.jsx');
  check('⑩ 机构端课堂弹窗：分享按钮在 `headerAction`（页眉右上角）',
    /headerAction=\{[^}]*data-testid="work-share"|headerAction=[\s\S]{0,200}data-testid="work-share"/.test(classroom));
  const footerChunk = classroom.slice(classroom.indexOf('footer={<'), classroom.indexOf('footer={<') + 400);
  check('⑩ 机构端课堂弹窗：底部按钮行里**不再**有分享入口', !/work-share/.test(footerChunk), footerChunk.slice(0, 120));
  const modal = readFile('apps/org/src/pages/classroom/ui.jsx');
  check('⑩ 弹窗组件真的支持 headerAction（页眉右侧那格）',
    /headerAction/.test(modal) && /classroom-dialog-head/.test(modal));
  const orgList = readFile('apps/org/src/main.jsx');
  check('⑩ 机构端作品库：分享入口在面板 `actions`（详情右上角）',
    /actions=\{<div className="row-actions">[\s\S]{0,400}data-testid="work-share"/.test(orgList));
  const websiteModal = readFile('apps/website/src/components/WorkPreviewModal.jsx');
  check('⑩ 网站端预览弹窗：分享入口在 `pl-viewer-head__actions`（弹窗右上角）',
    /pl-viewer-head__actions[\s\S]{0,300}data-testid="work-share"/.test(websiteModal));
  // ⚠️ 2026-10-02（用户报「为什么没有分享按钮呢」）：**每个** <ClassroomWork 调用点都要传
  //    `canShare` + `shareCreate` —— 组件默认 canShare=false，漏一个就是那条路上没有分享入口
  //    （机构端课堂那处就漏了：作品库有、我的课堂没有）。这条静态断言把这一类钉死。
  const callSites = [];
  for (const file of ['apps/org/src/main.jsx', 'apps/org/src/pages/classroom/ClassroomDetail.jsx']) {
    const source = readFile(file);
    for (const match of source.matchAll(/<ClassroomWork[\s\S]{0,500}?\/>/g)) callSites.push([file, match[0]]);
  }
  const missingProps = callSites.filter(([, jsx]) => !/canShare/.test(jsx) || !/shareCreate=/.test(jsx));
  check('⑩ 每个 <ClassroomWork 调用点都传了 canShare + shareCreate（漏一个就没分享）',
    callSites.length >= 2 && missingProps.length === 0,
    `共 ${callSites.length} 处，缺 props：${missingProps.map(([file]) => file).join('、')}`);
}

console.log('');
if (failures) { console.log(`✗ p171 有 ${failures} 处不符合预期`); process.exit(1); }
assert.equal(failures, 0);
console.log('✓ p171 学生主页侧的作品分享（解耦 / 逐件 / 幂等 / 越权 / 媒体）：全部通过');
