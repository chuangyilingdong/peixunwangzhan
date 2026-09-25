/**
 * P144 作品预览里的站内素材必须走**同源代理地址**（2026-09-25 用户报「作品预览还是失效状态」）。
 *
 * 那次的现象：机构端「我的课堂 → 作品预览」的**作品内容**那一排，缩略图整片失效
 * （前几张写「图片已失效」、后面几张是黑块 —— 黑块就是缩略图没加载出来时露出的底色）。
 *
 * 链路（生产日志能对上）：
 *   ① 快照里存的是**学生域**地址 `/api/student/file-assets/<id>/download`；
 *   ② 前端第一帧拿不到"转好的 data: 地址"，就退回这个原始地址 —— 而机构端拿它请求必然 403
 *      （那条路只认学生角色），缩略图于是被标成「已失效」；
 *   ③ 真正的同源代理地址（`/api/org/works/CANVAS/<作品>/images/<素材>`）要等每张图
 *      **fetch 完 + base64 成 data:** 才到位 —— 2.4MB × 7 张走 5Mbps 出口要几十秒，
 *      那几十秒里用户看到的就是"整片失效"。
 *
 * 这个守卫钉住修法（别再退回"先失败一次再补救"）：
 *   ① 解析器 `resolveWorkMediaUrl`：学生域地址**只**映射到服务端给的 `imageUrls`，拿不到就返回 null，
 *      **绝不原样返回学生域地址**；外链/data:/站内相对地址原样放行；
 *   ② 两个机构端界面（课堂里的只读作品弹窗、学生学习结果与作品弹窗）都用它，
 *      且**不再**为了作品预览去 `fetchDataUrl` 转 data:；
 *   ③ 真服务实测：机构详情给的 `imageUrls` 是同源 `/api/org/...`，**带 cookie（不是 Bearer）**
 *      GET 那个地址是 200 + 图片字节（这就是 `<img>` 的取法）；同一条链路拿学生域地址去取是 403
 *      （证明"回退到学生域地址"这条路本来就走不通）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p144-work-media-'));
const dbPath = path.join(temp, 'platform.db');
// 硬设（不是 ||=）：脚本自己的库优先；MySQL 模式下这个键被忽略
process.env.PLATFORM_DB_PATH = dbPath;
const uploadRoot = path.join(temp, 'uploads');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  FILE_UPLOAD_ROOT: uploadRoot,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
  // ⭐ 2026-09-25：给一组**假的 OSS 凭据**，好把"OSS 行必须 302 到签名地址"这条钉住 ——
  //    签发只算签名（不发网络请求），所以不需要真桶。真实上传路径这个守卫不碰（它直接插库）。
  FILE_STORAGE: 'oss',
  OSS_BUCKET: 'p144-test-bucket',
  OSS_REGION: 'cn-guangzhou',
  OSS_ENDPOINT: 'oss-cn-guangzhou.aliyuncs.com',
  OSS_ACCESS_KEY_ID: 'p144-test-ak',
  OSS_ACCESS_KEY_SECRET: 'p144-test-sk',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('① 解析器：学生域地址只认服务端给的代理地址，拿不到就返回 null');
const workMedia = read('packages/shared/src/workMedia.jsx');
const classroom = read('apps/org/src/pages/classroom/ClassroomWork.jsx');
const orgMain = read('apps/org/src/main.jsx');
check('① 有导出的 resolveWorkMediaUrl', /export function resolveWorkMediaUrl\(/.test(workMedia));
check('① 学生域地址 → 只取 imageUrls 里那一条（`return String(imageUrls?.[fileId] || \'\') || null`）',
  /const fileId = raw\.match\(\/\^\\\/api\\\/student\\\/file-assets\\\/\(\[\\w-\]\+\)\\\/download/ .test(workMedia)
  && /if \(fileId\) return String\(imageUrls\?\.\[fileId\] \|\| ''\) \|\| null;/.test(workMedia));
check('① ★ 拿不到代理地址时**不许**原样返回学生域地址（原来的回退就是它）',
  !/return raw;/.test(workMedia.replace(/if \(\/\^data:\/i\.test\(raw\) \|\| \/\^https:\\\/\\\/\/i\.test\(raw\)\) return raw;\n  if \(\/\^\\\/\(\?!\\\/\)\/\.test\(raw\)\) return raw;/, ''))
  || /if \(\/\^\\\/\(\?!\\\/\)\/\.test\(raw\)\) return raw;\n  return null;/.test(workMedia));
check('① 外链 / data: / 站内相对地址原样放行',
  /\^data:\/i\.test\(raw\)/.test(workMedia) && /\^https:\\\/\\\/\/i\.test\(raw\)/.test(workMedia) && /\^\\\/\(\?!\\\/\)\//.test(workMedia));

console.log('② 两个机构端界面都改用它（不再为预览做 fetchDataUrl → data:）');
check('② 课堂「只读作品」弹窗：快照解析与作品内容画廊都走 resolveWorkMediaUrl',
  /const snapshotImage = \(value\) => resolveWorkMediaUrl\(value, data\?\.imageUrls\);/.test(classroom)
  && /resolveSrc=\{\(item\) => snapshotImage\(item\?\.url\) \|\| ''\}/.test(classroom));
check('② 「学生学习结果与作品」弹窗：同上，且 workImageData 那套 data: 转换已移除',
  /const snapshotImage = \(value\) => resolveWorkMediaUrl\(value, selectedWork\?\.imageUrls\);/.test(orgMain)
  && /resolveSrc=\{\(item\) => resolveWorkMediaUrl\(item\?\.url, selectedWork\?\.imageUrls\) \|\| ''\}/.test(orgMain)
  && !/workImageData/.test(orgMain));
check('② 沙箱文档那条（VibeCoding HTML 在 opaque origin 里跑）仍保留 data: 内联（它拿不到 cookie）',
  /api\.fetchDataUrl\(path\)/.test(classroom) && /buildPreviewDocument\(files, entry\)/.test(classroom));

console.log('③ 真服务：同源代理地址带 cookie 能取到图（<img> 的取法）；学生域地址取不到');
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const { aq, arow } = await import('../packages/database/src/store.js');
const student = await arow("SELECT id, org_id FROM users WHERE login='student-2'");
assert.ok(student?.id, '种子学生缺失');
const fileId = `file_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const storageKey = `${new Date().toISOString().slice(0, 7).replace('-', '/')}/${randomUUID()}.png`;
const studentUrl = `/api/student/file-assets/${fileId}/download`;
const now = new Date().toISOString();
await aq('INSERT INTO file_assets(id,owner_type,owner_user_id,owner_org_id,storage_kind,storage_key,file_name,mime_type,file_size,category,visibility,status,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  [fileId, 'USER', student.id, student.org_id, 'INTERNAL_PROXY', storageKey, 'p144.png', 'image/png', 68, 'MEDIA_ASSET', 'PRIVATE', 'ACTIVE', '{}', now, now]);
const assetFile = path.join(uploadRoot, storageKey);
fs.mkdirSync(path.dirname(assetFile), { recursive: true });
// 1×1 PNG（真字节：缩略图这条路最后就是"把图读出来"，空文件会掩盖断言）
fs.writeFileSync(assetFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
const projectId = `project_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const workId = `work_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
await aq('INSERT INTO student_projects(id,student_id,org_id,title,status,canvas_snapshot,latest_version,last_saved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  [projectId, student.id, student.org_id, 'P144 作品', 'SUBMITTED', '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}', 1, now, now, now]);
await aq('INSERT INTO works(id,project_id,student_id,org_id,title,canvas_snapshot,status,submitted_at) VALUES(?,?,?,?,?,?,?,?)',
  [workId, projectId, student.id, student.org_id, 'P144 作品', JSON.stringify({ nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { title: '一个大桃子', caption: '一个大桃子', assetUrl: studentUrl, previewUrl: studentUrl } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), 'PENDING', now]);

const port = 19144;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 等起来 */ } await new Promise((r) => setTimeout(r, 100)); }
  // 机构管理员登录：**带上 clientType**（cookie 会按端签署，见 p141），两种凭据都要留着
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'org-admin', password: 'org123', clientType: 'org' }),
  });
  const loginBody = await login.json().catch(() => ({}));
  const token = loginBody?.data?.token;
  const cookies = (login.headers.getSetCookie?.() || []).map((item) => item.split(';')[0]).join('; ');
  assert.ok(token, '机构管理员登录失败');
  check('③ 机构端 cookie 是按端签的（`platform_token_org`，这次修的那条链路）', /platform_token_org=/.test(cookies), cookies.split(';').map((c) => c.split('=')[0]).join(','));

  const detail = await fetch(`${base}/api/org/works/CANVAS/${workId}`, { headers: { authorization: `Bearer ${token}` } });
  const detailBody = await detail.json().catch(() => ({}));
  const payload = detailBody?.data || {};
  check('③ 机构端作品详情读得到', detail.status === 200 && payload.id === workId, `HTTP ${detail.status}`);
  check('③ ★ 详情里的 imageUrls 是**同源** `/api/org/...` 地址（不是学生域地址）',
    String(payload.imageUrls?.[fileId] || '') === `/api/org/works/CANVAS/${workId}/images/${fileId}`,
    JSON.stringify(payload.imageUrls || {}).slice(0, 200));
  check('③ 作品内容那一排媒体带着 fileId 与 caption（画廊靠它解析地址）',
    (payload.media || []).some((item) => item.fileId === fileId && item.caption === '一个大桃子'),
    JSON.stringify(payload.media || []).slice(0, 200));

  // ⭐ 正面断言：`<img>` 的取法 —— 只带 cookie、不带 Authorization
  const viaCookie = await fetch(`${base}${payload.imageUrls[fileId]}`, { headers: { cookie: cookies } });
  check('③ ★ 带 cookie GET 同源代理地址 → 200 + 图片（这就是 <img> 能显示的原因）',
    viaCookie.status === 200 && String(viaCookie.headers.get('content-type') || '').startsWith('image/'),
    `HTTP ${viaCookie.status} ${viaCookie.headers.get('content-type')}`);

  // 反面：老代码回退用的那个学生域地址，机构端照样取不到 —— 所以"回退"这条路本来就不成立
  const viaStudentUrl = await fetch(`${base}${studentUrl}`, { headers: { cookie: cookies } });
  check('③ 反向证明：同一个 cookie 去取**学生域**地址是 403（旧回退必然显示"已失效"）',
    viaStudentUrl.status === 403, `HTTP ${viaStudentUrl.status}`);

  // ⭐ 2026-09-25（用户那条第 3 项）：**OSS 上的行不许把字节搬过这台机**（公网出口只有 5 Mbps）。
  //    判据：插一行同一件作品的 OSS 素材 → 取那张图应该是 **302 到带签名的 OSS 地址**，
  //    而不是 200 流式（流式就是"经过服务器那 5M 带宽"）。
  const ossFileId = `file_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const ossKey = `lingdong/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${randomUUID()}.png`;
  await aq('INSERT INTO file_assets(id,owner_type,owner_user_id,owner_org_id,storage_kind,storage_key,file_name,mime_type,file_size,category,visibility,status,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [ossFileId, 'USER', student.id, student.org_id, 'INTERNAL_PROXY', ossKey, 'p144-oss.png', 'image/png', 2048, 'MEDIA_ASSET', 'PRIVATE', 'ACTIVE', '{"storageBackend":"oss"}', now, now]);
  const canvas = JSON.parse((await arow('SELECT canvas_snapshot FROM works WHERE id=?', [workId])).canvas_snapshot);
  canvas.nodes.push({ id: 'n2', type: 'image', position: { x: 300, y: 0 }, data: { title: 'OSS 图', caption: 'OSS 图', assetUrl: `/api/student/file-assets/${ossFileId}/download`, previewUrl: `/api/student/file-assets/${ossFileId}/download` } });
  await aq('UPDATE works SET canvas_snapshot=? WHERE id=?', [JSON.stringify(canvas), workId]);
  const detail2 = await fetch(`${base}/api/org/works/CANVAS/${workId}`, { headers: { authorization: `Bearer ${token}` } });
  const payload2 = (await detail2.json().catch(() => ({})))?.data || {};
  const ossImagePath = String(payload2.imageUrls?.[ossFileId] || '');
  check('③ OSS 素材也出现在作品详情的 imageUrls 里', ossImagePath.endsWith(`/images/${ossFileId}`), ossImagePath);
  const ossImage = await fetch(`${base}${ossImagePath}`, { headers: { cookie: cookies }, redirect: 'manual' });
  const location = String(ossImage.headers.get('location') || '');
  check('③ ★ OSS 行取图是 **302 到 OSS 签名地址**（字节不经服务器，不占那 5M 带宽）',
    ossImage.status === 302 && /oss-cn-guangzhou\.aliyuncs\.com/.test(location) && /OSSAccessKeyId=/.test(location),
    `HTTP ${ossImage.status} location=${location.slice(0, 90)}`);
} finally {
  server.kill();
}

if (failures) {
  console.error(JSON.stringify({ name: 'p144-work-preview-media-urls', pass: false, failed: failures, serverLog: serverLog.slice(-600) }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p144-work-preview-media-urls', pass: true, checks: 11 }));
