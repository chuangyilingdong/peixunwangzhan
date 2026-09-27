/**
 * P154 作品封面与公开预览（2026-09-27 用户口径，这一轮的其中三条落在这张网）。
 *
 * 用户原话：
 *   · 「图1 课堂作品这里为什么还会出现图片失效的状况」；
 *   · 「图2 平台端看不到学生的作品预览」；
 *   · 「图3 课堂作品页面和我的作品应该自动会有实际的封面，而不是这种填充的」。
 *
 * 钉住这些（都是"真请求 + 静态契约"两半）：
 *   ① 公开广场列表：站内画布作品带**自动算出的封面**（指向这份作品专属的公开图片口），
 *      而且那个地址真能取到字节 —— 不是学生域地址（访客拿它必 403）；
 *   ② 公开详情：媒体清单里站内素材一律是公开口地址；
 *      ⭐ 这条正是「图片已失效」的根因：详情页前端原来只认 `imageUrls` 映射，而公开接口不返回它。
 *   ③ 学生「我的作品」：每条带 `coverUrl`（同源学生口）；
 *   ④ 平台端作品列表带 `coverUrl`、详情带 `media` + `imageUrls`，且平台口取图能拿到字节；
 *   ⑤ 静态：公开详情页用共享的 `resolveWorkMediaUrl`（不许再退回"只认 fileId 映射"那种写法），
 *      并且「它是怎么写出来的」那段**源码清单**已按用户口径删除；
 *   ⑥ 静态：平台端的预览面板真的渲染 `WorkMediaGallery` + 只读 `CanvasEditor`（不再只有一段 JSON 快照）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p154-work-cover-'));
const dbPath = path.join(temp, 'platform.db');
// 硬设（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略。
process.env.PLATFORM_DB_PATH = dbPath;
// 夹具走数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import。
const { aq, arow } = await import('../packages/database/src/store.js');

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  // ⚠️ 上传根目录必须一起指到临时目录（与 p144 同一条）：file_assets 的 storage_key 是相对它的，
  //    少这一句 → 图片口报 `FILE_STORAGE_NOT_FOUND`（服务去默认根目录找，那儿当然没有）。
  FILE_UPLOAD_ROOT: path.join(temp, 'uploads'),
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
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const seeded = {};
const fileId = 'file_p154_cover';
const shareToken = 'wst_p154_cover_token';
{
  const student = await arow("SELECT id, org_id FROM users WHERE login='student-2'");
  assert.ok(student, '夹具：种子里应当有 student-2');
  Object.assign(seeded, { studentId: student.id, orgId: student.org_id });

  // 一张**真的** 1×1 PNG（与 p144 同一份 base64）：封面要能取到字节才说明这条链路是通的
  const storageKey = 'p154/cover.png';
  const assetFile = path.join(temp, 'uploads', storageKey);
  fs.mkdirSync(path.dirname(assetFile), { recursive: true });
  fs.writeFileSync(assetFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
  const now = new Date().toISOString();
  await aq('INSERT INTO file_assets(id,owner_type,owner_user_id,owner_org_id,storage_kind,storage_key,file_name,mime_type,file_size,category,visibility,status,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [fileId, 'USER', seeded.studentId, seeded.orgId, 'INTERNAL_PROXY', storageKey, 'cover.png', 'image/png', 68, 'MEDIA_ASSET', 'PRIVATE', 'ACTIVE', '{}', now, now]);

  // 画布快照：一个图片框体挂着**站内素材**（学生域地址），外加一个上游外链（应当原样放行）
  const canvas = {
    nodes: [
      { id: 'p154-img', type: 'image', position: { x: 40, y: 40 }, data: { assetUrl: `/api/student/file-assets/${fileId}/download`, caption: 'P154 封面图' } },
      { id: 'p154-ext', type: 'image', position: { x: 240, y: 40 }, data: { previewUrl: 'https://example.com/p154-external.png', caption: '外链图' } },
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  };
  await aq('INSERT INTO student_projects(id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ['project_p154', seeded.studentId, seeded.orgId, 'P154 封面作品', 'SUBMITTED', JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), 1, now, now, now]);
  // ⚠️ 状态必须是 PUBLISHED（广场列表的准入：is_public=1 + status=PUBLISHED + 有 token + 已确认展示授权）
  await aq('INSERT INTO works(id,project_id,student_id,org_id,title,description,canvas_snapshot,status,submitted_at,is_public,share_token,copyright_confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ['work_p154_cover', 'project_p154', seeded.studentId, seeded.orgId, 'P154 封面作品', '封面与预览的守卫夹具', JSON.stringify(canvas), 'PUBLISHED', now, 1, shareToken, now]);
}

const port = 19084;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null, code: payload?.error?.code || null, headers: response.headers };
}
// 取一张图：只看"有没有字节"（302 到 OSS 也算通 —— 守卫里跟随跳转没有意义，看状态码就够）
async function probeImage(pathname, { cookie } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return { status: response.status, type: response.headers.get('content-type') || '', location: response.headers.get('location') || '' };
}

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }
  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data?.token;
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data?.token;
  assert.ok(admin && student, '登录失败');

  /* ① ⭐ 用户口径「应该自动会有实际的封面」：公开广场列表的封面 = 快照第一张真图的公开口地址 */
  const plazaCover = await api('/api/public/works?limit=60');
  const plazaItem = (plazaCover.data?.items || []).find((item) => item.id === 'work_p154_cover');
  const expectPublicUrl = `/api/public/works/${shareToken}/images/${fileId}`;
  check('① 公开广场：站内画布作品带**自动封面**（指向这份作品的公开图片口）',
    plazaItem?.coverUrl === expectPublicUrl, `实际 coverUrl=${plazaItem?.coverUrl}`);
  check('① 那个封面地址真能取到字节（不是学生域、不是 403）',
    await (async () => { const r = await probeImage(expectPublicUrl); return [200, 302].includes(r.status); })(),
    JSON.stringify(await probeImage(expectPublicUrl)));

  /* ② ⭐ 用户口径「课堂作品这里为什么还会出现图片失效」：公开详情的媒体地址必须是公开口 */
  const detail = await api(`/api/public/works/${shareToken}`);
  const stationItem = (detail.data?.media || []).find((item) => item.fileId === fileId);
  check('② 公开详情：站内素材的 url 是**公开口**地址（不是学生域地址）',
    stationItem?.url === expectPublicUrl, `实际 ${stationItem?.url}`);
  check('② 详情里那个地址取图是 200/302（前端 `<img>` 这一下才是通的）',
    await (async () => { const r = await probeImage(expectPublicUrl); return [200, 302].includes(r.status); })(),
    JSON.stringify(await probeImage(expectPublicUrl)));
  check('② 上游外链原样放行（不能被我改坏）',
    (detail.data?.media || []).some((item) => String(item.url || '').startsWith('https://example.com/')),
    JSON.stringify((detail.data?.media || []).map((item) => item.url)));

  /* ③ 学生「我的作品」：每条带 coverUrl（同源学生口） */
  const myWorks = await api('/api/student/works?page=1', { token: student });
  const mine = (myWorks.data?.items || []).find((item) => item.id === 'work_p154_cover');
  check('③ 我的作品：画布作品带 coverUrl（学生口，`<img>` 带 cookie 能取）',
    mine?.coverUrl === `/api/student/file-assets/${fileId}/download`, `实际 ${mine?.coverUrl}`);

  /* ④ 平台端：列表缩略图 + 详情媒体/图片口（用户口径「平台端看不到学生的作品预览」） */
  const adminList = await api('/api/admin/works?limit=20&sort=submitted', { token: admin });
  const adminItem = (adminList.data?.items || []).find((item) => item.id === 'work_p154_cover');
  const expectAdminUrl = `/api/admin/works/work_p154_cover/images/${fileId}`;
  check('④ 平台端列表带 coverUrl（缩略图用它）', adminItem?.coverUrl === expectAdminUrl, `实际 ${adminItem?.coverUrl}`);
  const adminDetail = await api('/api/admin/works/work_p154_cover/detail', { token: admin });
  check('④ 平台端详情带 media + imageUrls（预览面板靠它渲染）',
    Array.isArray(adminDetail.data?.media) && adminDetail.data?.imageUrls?.[fileId] === expectAdminUrl,
    JSON.stringify({ media: (adminDetail.data?.media || []).length, imageUrls: adminDetail.data?.imageUrls }));
  const adminImage = await probeImage(expectAdminUrl, { cookie: `platform_token_admin=${admin}` });
  check('④ 平台口取图能拿到字节（403 就是权限判据写窄了）', [200, 302].includes(adminImage.status), JSON.stringify(adminImage));
  check('④ 越权取图被拒：拿一个不属于这份作品的 fileId 去取 → 404',
    (await probeImage(`/api/admin/works/work_p154_cover/images/file_does_not_exist`, { cookie: `platform_token_admin=${admin}` })).status === 404);
} catch (error) {
  failures += 1;
  console.error(serverLog.slice(-1500));
  console.error('真请求段异常：', error.message);
} finally {
  server.kill('SIGKILL');
}

/* ⑤ 静态契约：公开详情页的取图写法 + 源码清单已删 */
{
  const publicDetail = read('apps/website/src/pages/WorkDetail.jsx');
  check('⑤ 公开详情页用共享的 resolveWorkMediaUrl（不再"只认 fileId 映射"→ 那就是失效的根因）',
    /resolveWorkMediaUrl\(item\?\.url, mediaImageUrls\)/.test(publicDetail) && !/imageData\[item\.fileId\] \|\| work\.imageUrls\?\.\[item\.fileId\]/.test(publicDetail));
  check('⑤ 「它是怎么写出来的」源码清单已删（用户 2026-09-27：「无限延长的，很难看，这块直接删除」）',
    !/<summary>它是怎么写出来的/.test(publicDetail) && !/<ReplayFiles/.test(publicDetail));
  check('⑤ 公开详情页的媒体地址表把 media 里的公开地址也算进去（不是只看 imageUrls）',
    /for \(const item of work\?\.media \|\| \[\]\) if \(item\?\.fileId && item\.url\) map\[item\.fileId\] = item\.url;/.test(publicDetail));
}

/* ⑥ 静态契约：平台端预览（弹窗 + 走 token 取图）+ 服务端的封面口径 + 「给机构加次数」的入口归并 */
{
  const adminWorks = read('apps/admin/src/pages/PlatformWorks.jsx');
  const workPreview = read('apps/admin/src/components/WorkPreview.jsx');
  // ⚠️ 2026-09-27 用户口径变更（**不是测试漂移**）：
  //   「图2图3 平台侧学生作品都失效，而且不要拉到下面才能看，只有操作那给个预览按钮，弹窗查看就行了」。
  //   平台端的 `<img>` 请求拿不到会话 cookie（会话在 localStorage / Bearer），生产实测全是 401 ——
  //   所以改成：列表**不放图**（操作列一枚「预览」）→ 弹窗，弹窗里的图经 `api.fetchDataUrl` 取成 data:。
  check('⑥ 平台端：操作列有「预览」按钮，且**不再**在列表里放缩略图（用户 2026-09-27 口径）',
    /onClick=\{\(\) => setPreviewItem\(item\)\}>预览</.test(adminWorks) && !/work-cell__thumb/.test(adminWorks));
  check('⑥ 平台端：预览是**弹窗**（原生 dialog + showModal），不再渲染在表格下面',
    /function PreviewDialog/.test(workPreview) && /showModal\(\)/.test(workPreview) && /className="admin-confirm admin-work-preview"/.test(workPreview)
    && !/<Panel title=\{`作品预览/.test(adminWorks));
  check('⑥ 平台端：弹窗里的图走**带 token 的接口**（fetchDataUrl → data:），不依赖 cookie',
    /api\.fetchDataUrl\(path\)/.test(workPreview) && /\/api\/admin\/works\/\$\{encodeURIComponent\(workId\)\}\/images\//.test(workPreview));
  check('⑥ 平台端：画布作品也有「作品内容 / 创作画布」两档（真预览，不是一段 JSON）',
    /<WorkMediaGallery media=\{data\.media\}/.test(workPreview)
    && /<CanvasEditor key=\{workId\} initialSnapshot=\{data\.canvasSnapshot\} readOnly/.test(workPreview));
  const lib = read('apps/server/src/lib.js');
  check('⑥ 服务端有统一的"从快照自动取封面"助手（三端共用一处口径）',
    /export function workCoverFromSnapshot\(canvasSnapshot, urlFor\)/.test(lib));
  check('⑥ 三端列表都接了这个助手（公开 / 学生 / 平台）',
    /workCoverFromSnapshot\(canvas,/.test(read('apps/server/src/routes/communication/public.js'))
    && /workCoverFromSnapshot\(parseJson\(work\.canvas_snapshot/.test(read('apps/server/src/routes/student.js'))
    && /workCoverFromSnapshot\(parseJson\(work\.canvas_snapshot/.test(read('apps/server/src/routes/admin/works.js')));
  check('⑥ 封面只认"我们自己的下载口"（外链会过期 → 不能当封面）',
    /const pick = media\.find\(\(item\) => item\.modality === 'IMAGE' && item\.fileId\)/.test(lib));
  check('⑥ VibeCoding 作品也用页面里的真图当封面（没有图才回落到自动插图）',
    /coverUrl: \(\(\) => \{[\s\S]{0,400}snapshotImageFileIds\(row\)/.test(read('apps/server/src/routes/communication/public.js')));
  check('⑥ ⭐ 学生端自己的作品详情页也不再铺源码清单（用户 2026-09-27：「也要删」）',
    !/<summary>它是怎么写出来的/.test(read('apps/website/src/pages/MyWorkDetail.jsx')));
  // ⭐ 「给机构加次数」只会有一个入口（用户 2026-09-27：「很多重复的逻辑和操作，能合并就合并」）：
  //    课包页（授权与人次流水）不再有追加/开通表单；采购字段在机构页的「调整授权次数」抽屉里。
  const authorizations = read('apps/admin/src/pages/Organizations.jsx');
  const quotaPage = read('apps/admin/src/pages/OrganizationQuota.jsx');
  check('⑥ 课包页不再有「追加次数 / 首次授权」表单（那条路已合并到机构页）',
    !/license-purchases\/append/.test(authorizations) && !/Panel title="追加次数"/.test(authorizations));
  check('⑥ 机构页的「调整授权次数」抽屉同时支持平台调整与机构采购（同一抽屉二选一，各记各的账）',
    /admin\/license-purchases\/append/.test(quotaPage)
    && /course-quotas\/\$\{encodeURIComponent\(current\.seriesId\)\}\/adjust/.test(quotaPage)
    && /机构采购（记成交与收款）/.test(quotaPage) && /平台调整（不记钱）/.test(quotaPage));
}

if (failures) {
  console.error(JSON.stringify({ name: 'p154-work-cover-and-public-preview', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p154-work-cover-and-public-preview', pass: true }, null, 1));
