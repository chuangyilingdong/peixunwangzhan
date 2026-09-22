/**
 * P127 生成产物**归档到本机** + 作品读面不再靠会过期的外链（2026-09-22）。
 *
 * 起因（用户报的坏图，追下去是真的）：作品读面里的图/视频，`media_assets.asset_url` 存的都是
 * **上游返回的临时地址**。逐条 curl 生产库那 32 条：`getapib.org` 的 21 条里 **7 条已经 403**
 * （CloudFront 回 `application/xml` → 浏览器按 ORB 挡掉 → 一片破图占位）。
 * 「任务成功」不等于「这件东西以后还在」—— 与口径 71（交给外部的素材对方可能读不到）是同一族的另一半。
 *
 * 修法：生成成功时把产物下载回来、存成**学生本人的私有素材**（与「学生自己传的图」「PPT 插画」
 * 同一条路），读面认 fileId 就能转 data:（学生端/机构端）或走作品专属公开代理（广场）。
 *
 * 这个守卫**真跑**归档链路（注入 fetch，不联网），不是读源码猜。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p127-archive-'));
const dbPath = path.join(temp, 'platform.db');
const uploadRoot = path.join(temp, 'uploads');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;
process.env.FILE_UPLOAD_ROOT = uploadRoot;
process.env.DEPLOYMENT_MODE = 'local-mock';
process.env.AI_PROVIDER = 'local-mock';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// 用仓库自带的种子库（p78 同一套起法）：手写 INSERT 会撞上一堆必填列，而且种子一改就对不上。
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const { archiveOneGeneratedAsset, archiveGeneratedAssets, archivableMimeFor, studentAssetUrl, ARCHIVABLE_MIME_EXTENSION } = await import('../apps/server/src/services/generatedAssetArchive.js');
const { row } = await import('../apps/server/src/lib.js');

/* ── 夹具：拿种子里的学生，给他一个项目（media_assets/快照的外键要立得住）─────── */
let STUDENT = '';
let ORG = '';
{
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  const student = db.prepare("SELECT id, org_id FROM users WHERE login='student-1'").get();
  if (!student) throw new Error('种子库里没有 student-1 —— 先确认 packages/database/src/seed.js 还能跑');
  STUDENT = student.id;
  ORG = student.org_id;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO student_projects(id,student_id,org_id,title,status,last_saved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('project_p127', STUDENT, ORG, 'P127 项目', 'DRAFT', now, now, now);
  db.close();
}

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const UPSTREAM_IMAGE = 'https://getapib.org/f/image/example-dead-or-alive.png';
function bytesFetch({ status = 200, contentType = 'image/png', bytes = PNG_1PX } = {}) {
  return async () => ({ ok: status >= 200 && status < 300, status, headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : String(name).toLowerCase() === 'content-length' ? String(bytes.length) : null) }, arrayBuffer: async () => bytes });
}

/* ── ① 归档真的好使：下载 → 落盘 → 返回我们自己的私有地址 ─────────────────── */
const archived = await archiveOneGeneratedAsset({ assetUrl: UPSTREAM_IMAGE, modality: 'IMAGE', jobId: 'job_p127', ownerUserId: STUDENT, ownerOrgId: ORG, fetchImpl: bytesFetch() });
check('① 上游产物归档成功，地址换成本人私有素材（/api/student/file-assets/<id>/download）',
  archived.ok === true && /^\/api\/student\/file-assets\/file_[\w-]+\/download$/.test(archived.url || ''), JSON.stringify(archived));
const storedFileId = String(archived.url || '').match(/file_([\w-]+)\/download/)?.[1] || '';
const fileRow = storedFileId ? row('SELECT * FROM file_assets WHERE id=?', [`file_${storedFileId}`]) : null;
check('② 落盘的是 PRIVATE 私有素材、归这个学生（作品没发布之前不该有公网地址）',
  fileRow?.visibility === 'PRIVATE' && fileRow?.owner_user_id === STUDENT && fileRow?.storage_kind === 'INTERNAL_PROXY' && fileRow?.status === 'ACTIVE',
  JSON.stringify(fileRow && { visibility: fileRow.visibility, owner: fileRow.owner_user_id, kind: fileRow.storage_kind, status: fileRow.status }));
const onDisk = fileRow ? path.join(uploadRoot, String(fileRow.storage_key || '')) : '';
check('③ 字节真的写到了磁盘上（不是只插了一行）', Boolean(onDisk) && fs.existsSync(onDisk) && fs.readFileSync(onDisk).subarray(0, 4).toString('hex') === '89504e47',
  onDisk ? `${onDisk}（存在=${fs.existsSync(onDisk)}）` : '没有 storage_key');

/* ── ② 失败一律**保留原地址**、绝不抛错（与「素材传上游」正好相反）────────────── */
check('④ 上游 403 → 跳过并说明原因（那些地址已经失效了，留着也没用，但绝不能因此判生成失败）',
  (await archiveOneGeneratedAsset({ assetUrl: UPSTREAM_IMAGE, modality: 'IMAGE', jobId: 'j', fetchImpl: bytesFetch({ status: 403 }) })).reason?.includes('HTTP 403') === true);
// ⚠️ 这一条**翻过一次面，别再改回去**：上游给的一批视频是 `.mp4` 后缀、
//    major brand 却是 `qt  `（QuickTime）。我第一版按品牌把它们当"浏览器播不了"全拦了
//    → **10 条生产视频一条都收不进来**。拿到真 Chromium 里实测才发现：
//    那些文件**能播**（play() 之后 currentTime 真的在走、有画幅 1038x576、无报错）
//    —— 容器品牌不等于播不动，**不能拿它当判据**。
//    判据只能是**上游声明的 MIME**：声明 video/mp4 就收；
//    声明 video/quicktime（真的 .mov，就是 README 里"浏览器播不了"那种）就不收。
const qtBrandedMp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypqt  ', 'ascii'), Buffer.alloc(16)]);
const qt = await archiveOneGeneratedAsset({ assetUrl: UPSTREAM_IMAGE, modality: 'VIDEO', jobId: 'j', fetchImpl: bytesFetch({ contentType: 'video/mp4', bytes: qtBrandedMp4 }) });
check('⑤ qt 品牌的 mp4 照样归档（实测能播 —— 容器品牌不是判据）',
  qt.ok === true && qt.mimeType === 'video/mp4', JSON.stringify(qt));
const realMov = await archiveOneGeneratedAsset({ assetUrl: UPSTREAM_IMAGE, modality: 'VIDEO', jobId: 'j', fetchImpl: bytesFetch({ contentType: 'video/quicktime', bytes: qtBrandedMp4 }) });
check('⑤b 但上游**声明** video/quicktime（真 .mov）不收 —— 判据是声明的 MIME，不是字节',
  realMov.ok === false && realMov.reason?.includes('声明') === true, JSON.stringify(realMov));
const notWhitelisted = await archiveOneGeneratedAsset({ assetUrl: UPSTREAM_IMAGE, modality: 'VIDEO', jobId: 'j', fetchImpl: bytesFetch({ contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 hello') }) });
check('⑤c 落盘白名单外的类型同样跳过（pdf 不是作品媒体）', notWhitelisted.ok === false && notWhitelisted.reason?.includes('白名单') === true, JSON.stringify(notWhitelisted));
check('⑥ data: / mock: 这类内联产物不动（它们本来就在我们库里）',
  (await archiveOneGeneratedAsset({ assetUrl: 'data:image/png;base64,AAAA', modality: 'IMAGE', jobId: 'j' })).ok === false);

const list = await archiveGeneratedAssets([
  { assetUrl: UPSTREAM_IMAGE, previewUrl: UPSTREAM_IMAGE, label: '图一' },
  { assetUrl: 'https://getapib.org/f/image/gone.png', label: '已失效' },
], { modality: 'IMAGE', jobId: 'job_p127', ownerUserId: STUDENT, ownerOrgId: ORG, fetchImpl: async (url) => (String(url).includes('gone') ? (await bytesFetch({ status: 403 }))() : (await bytesFetch())()) });
check('⑦ 批量归档：成功的换成我们的地址（assetUrl 与同一个 previewUrl 一起换），失败的保留原地址并记 mirrored:false',
  /^\/api\/student\/file-assets\//.test(list[0].assetUrl) && list[0].previewUrl === list[0].assetUrl && list[0].metadata.archive.mirrored === true
  && list[1].assetUrl === 'https://getapib.org/f/image/gone.png' && list[1].metadata.archive.mirrored === false,
  JSON.stringify(list.map((item) => ({ url: String(item.assetUrl).slice(0, 46), archive: item.metadata.archive.mirrored }))));

check('⑧ 私有地址形状与读面约定一致（canvasMediaFrom 只认这个前缀才提得出 fileId）',
  studentAssetUrl('file_abc') === '/api/student/file-assets/file_abc/download'
  && !('video/quicktime' in ARCHIVABLE_MIME_EXTENSION) && archivableMimeFor('video/mp4') === 'video/mp4');

/* ── ③ 接线：生成链路两处都要在结算前归档 ─────────────────────────────────── */
const generation = read('apps/server/src/routes/aiGeneration.js');
const archiveCalls = generation.match(/assetPayloads: archivedAssets/g) || [];
check('⑨ 两条生成链路（同步 + worker）都在结算前归档，并把**归档后**的清单交给结算（不是原来那份）',
  archiveCalls.length === 2 && (generation.match(/const archivedAssets = await archiveGeneratedAssets\(/g) || []).length === 2,
  `结算处收到归档结果的次数=${archiveCalls.length}`);

/* ── ④ 广场读面：私有地址换成作品专属公开代理 ─────────────────────────────── */
const publicRoutes = read('apps/server/src/routes/communication/public.js');
check('⑩ 新增画布作品的公开图片代理（访客未登录，拿不动 /api/student/...）',
  /const publicCanvasWorkImageMatch = pathname\.match\(/.test(publicRoutes)
  && /PUBLIC_WORK_IMAGE_NOT_FOUND/.test(publicRoutes)
  && /canvasMediaFrom\(parseJson\(work\.canvas_snapshot/.test(publicRoutes));
check('⑪ 那条代理的准入与作品详情**逐字同一条件**（`share_token=? AND is_public=1`）—— 宽一格就是"看得到作品页、图却 403"',
  /const work = row\('SELECT id, canvas_snapshot FROM works WHERE share_token=\? AND is_public=1'/.test(publicRoutes));
check('⑫ publicWorkRow 把 fileId 形式的媒体换成作品专属代理地址（前端 srcOf 直接用 item.url 就能显示）',
  /url: `\/api\/public\/works\/\$\{encodeURIComponent\(row\.share_token\)\}\/images\//.test(publicRoutes));

/* ── ⑤ 机构端读面：准入要算上归档件、列表给 fileId→地址、前端要解析 ─────────── */
const org = read('apps/server/src/routes/orgAdmin.js');
check('⑬ 机构端作品详情的准入清单把**归档件**也算上（否则老师看到地址、点开 404）',
  /...canvasMediaFrom\(canvasSnapshot\)\.map\(\(item\) => item\.fileId\)\.filter\(Boolean\),/.test(org)
  && /FROM media_assets WHERE project_id=\?/.test(org));
check('⑭ 机构端作品列表下发 imageUrls（批量查一次 media_assets，别每行一个查询）',
  /item\.imageUrls = Object\.fromEntries\(\[\.\.\.fileIds\]\.map\(\(fileId\) => \[fileId, `\/api\/org\/works\/CANVAS\//.test(org)
  && /SELECT project_id, asset_url FROM media_assets WHERE project_id IN/.test(org));
const orgApp = read('apps/org/src/main.jsx');
check('⑮ 机构端预览传了 resolveSrc（<img> 发不出 Authorization 头，要转 data:）',
  /<WorkMediaGallery media=\{selectedWork\.media\} assets=\{selectedWork\.assets\} resolveSrc=/.test(orgApp)
  && /api\.fetchDataUrl\(path\)/.test(orgApp));

/* ── ⑥ 读面：失效的媒体说人话，不再是浏览器的破图图标 ───────────────────────── */
const gallery = read('packages/shared/src/workMedia.jsx');
check('⑯ 加载失败时给一句人话（"图片已失效，读不出来了"），而不是只留一个破图占位',
  /已失效，读不出来了/.test(gallery) && /onError=\{\(\) => setFailed\(true\)\}/.test(gallery));

/* ── ⑦ 存量回填脚本：三处一起改、可续跑、干跑优先 ─────────────────────────── */
const backfill = read('deploy/production/backfill-generated-media.mjs');
check('⑰ 回填脚本默认**干跑**（要 --apply 才写库），并且三处都改：media_assets 两个地址列 + 两张表的 canvas_snapshot',
  /const apply = process\.argv\.includes\('--apply'\)/.test(backfill)
  && /UPDATE media_assets SET asset_url=/.test(backfill)
  && /rewriteSnapshot\('student_projects', 'canvas_snapshot'\)/.test(backfill)
  && /rewriteSnapshot\('works', 'canvas_snapshot'\)/.test(backfill));
check('⑱ 替换表**从库里推**（不是用本次跑出来的内存清单）—— 中途被杀也能续跑，否则那批快照永远漏改',
  /SELECT asset_url, metadata FROM media_assets WHERE metadata LIKE/.test(backfill));

await assert.doesNotReject(async () => {});

console.log('');
if (failures) {
  console.log(`✗ p127 有 ${failures} 处不符合预期`);
  process.exit(1);
}
console.log('✓ p127 生成产物归档与读面接线：全部通过');
