/**
 * P145 课件预览「不吃本机带宽」守卫（2026-09-25）。
 *
 * 用户口径：平台**只剩两处**还在吃这台机那 5 Mbps 的公网出口（课件预览、导入的广场素材），
 * 都要搬到 OSS。这条守的是课件预览那一处。
 *
 * 搬之前的链路（每条都被生产实测过）：
 *   · OSS 行 → 先把对象**取回本机**（一份课件 106MB），Office 再交给 LibreOffice 转 PDF；
 *   · 转出来的 PDF **每次预览都从这台机流出去**（100MB 转出来是 100MB，5 Mbps 下要看三分钟）；
 *   · 而且 `materializeObject` 每次都重写一遍源文件，mtime 变新 → **转换缓存当场作废**，
 *     每点一次预览都重跑一次 LibreOffice。
 *
 * 搬之后：
 *   · 不需要转换的形态（图片/视频/音频/PDF）→ 直接 **302 到对象自己的签名地址**；
 *   · Office → 转一次，产物推到 OSS（键里带源文件字节数），之后每次预览都是 302；
 *   · 本地行、以及**把预览地址塞进 iframe 的那几处**（作品文件）—— 照旧由本机流式发：
 *     站点 CSP 的 `default-src 'self'` 会把跨域 iframe 挡成白屏，那不是能省的地方。
 *
 * 钉六件事（任一不成立 exit 1）：
 *   ① 源码口径：`ossOffload: true` **只**出现在机构端教学素材那条预览路由上；
 *   ② 真服务：OSS 行的图片预览是 302 到签名地址（带 OSSAccessKeyId/Expires/Signature，
 *      且签的是这一行自己的 storage_key）；
 *   ③ 真服务：本地行的预览**仍是 200 流式**，字节一模一样（没有为了"统一"把本地行也跳走）；
 *   ④ 票据口径不变：没票据 / 票据被篡改 → 401/403，拿不到 302（这是能给外人看的东西）；
 *   ⑤ OSS 够不着时是 **404 而不是 500**，且**绝不吐原始 Office 字节**（宁可说"暂不可预览"）；
 *   ⑥ 302 的临时地址**不带 response-content-disposition**（带了会出现"另存为"下载入口）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p145-preview-oss-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
// 票据是按 AUTH_PEPPER 签的：本进程签、服务进程验，两边必须是同一个（否则一律 401）
process.env.AUTH_PEPPER = 'p145-pepper';
const uploadRoot = path.join(temp, 'uploads');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  FILE_UPLOAD_ROOT: uploadRoot,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
  AUTH_PEPPER: 'p145-pepper',
  // 假凭据：签名是**纯计算**（不发请求），所以"302 到哪儿"这件事不需要真桶就能验。
  // 反过来，真要去 OSS 的调用（headObject / putObject）在离线机器上必然失败 ——
  // 那正好用来验 ⑤：够不着 OSS 时必须是 404，不是 500。
  FILE_STORAGE: 'oss',
  OSS_BUCKET: 'p145-test-bucket',
  OSS_REGION: 'cn-guangzhou',
  OSS_ENDPOINT: 'oss-cn-guangzhou.aliyuncs.com',
  OSS_ACCESS_KEY_ID: 'p145-test-ak',
  OSS_ACCESS_KEY_SECRET: 'p145-test-sk',
  OSS_PREFIX: 'p145',
};
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ① 源码口径：这条"允许跳转"的开关只开在教学素材那条预览路由上 */
console.log('① 源码：`ossOffload` 只开给机构端的教学素材预览');
const route = read('apps/server/src/routes/fileAssets.js');
const offloadCalls = [...route.matchAll(/prepareFilePreview\(ctx, file(, \{[^}]*\})?\)/g)].map((m) => m[0]);
check('① 恰有一处传 ossOffload: true', offloadCalls.filter((c) => /ossOffload: true/.test(c)).length === 1, offloadCalls.join(' | '));
check('① 其余的调用点都不传（作品文件走 <iframe>，跨域会被 CSP 挡成白屏）',
  offloadCalls.filter((c) => !/ossOffload/.test(c)).length === offloadCalls.length - 1, offloadCalls.join(' | '));
const otherCallers = read('apps/server/src/routes/orgAdmin.js') + read('apps/server/src/routes/admin/works.js');
check('① 机构端/平台端的作品文件预览（iframe 那条）确实没开', !/ossOffload/.test(otherCallers));

/* ② 真服务 */
console.log('② 真服务：OSS 行 302 / 本地行 200 / 票据照旧');
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const { aq } = await import('../packages/database/src/store.js');
const { signPreviewTicket } = await import('../apps/server/src/services/materialPreview.js');
const student = (await import('../packages/database/src/store.js')).arow;

const now = new Date().toISOString();
const mkRow = async ({ oss, mime, name, key, bytes, size }) => {
  const id = `file_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const metadata = oss ? '{"storageBackend":"oss"}' : '{}';
  await aq('INSERT INTO file_assets(id,owner_type,owner_user_id,owner_org_id,storage_kind,storage_key,file_name,mime_type,file_size,category,visibility,status,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, 'USER', null, null, 'INTERNAL_PROXY', key, name, mime, size, 'TEACHING_ASSET', 'PUBLIC_PLATFORM', 'ACTIVE', metadata, now, now]);
  if (bytes) {
    const full = path.join(uploadRoot, key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
  }
  return id;
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const ossPngKey = '2026/09/p145-oss.png';
const ossPngId = await mkRow({ oss: true, mime: 'image/png', name: 'p145-oss.png', key: ossPngKey, bytes: PNG, size: PNG.length });
// OSS 行故意**没有本地文件**：一旦代码还走"取回本机再发"，这里就会 404 —— 正好证明它真的跳走了
const localPngKey = '2026/09/p145-local.png';
const localPngId = await mkRow({ oss: false, mime: 'image/png', name: 'p145-local.png', key: localPngKey, bytes: PNG, size: PNG.length });
// 一份"够不着 OSS"的 Office 行：用来验 ⑤（404 而不是 500，且不吐原始字节）
const pptxBytes = Buffer.concat([Buffer.from('PK\u0003\u0004', 'binary'), Buffer.alloc(64, 7)]);
const ossPptxId = await mkRow({ oss: true, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', name: 'p145-课件.pptx', key: '2026/09/p145.pptx', bytes: pptxBytes, size: pptxBytes.length });

const port = 19145;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 等起来 */ } await new Promise((r) => setTimeout(r, 100)); }
  const preview = (fileId, ticket) => fetch(`${base}/api/org/file-assets/${fileId}/preview?t=${encodeURIComponent(ticket)}`, { redirect: 'manual' });

  /* ①-b 原生渲染的入口（2026-09-25 用户口径「我需要的原生渲染效果」）：
     只有 .pptx 才给「取原始文件」的地址（前端拿它做原生解析），其它格式一律不给 ——
     否则等于把"原始文件下载口"开给了所有课件。 */
  console.log('①-b 原生渲染入口：.pptx 才给「取原始文件」的地址');
  const { previewInfoFor } = await import('../apps/server/src/lib.js');
  const nativeRows = [
    ['file_ppt_native', '应用/slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', true],
    ['file_ppt_legacy', '老课件.ppt', 'application/vnd.ms-powerpoint', false],
    ['file_doc_native', '教案.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', false],
    ['file_pdf_native', '讲义.pdf', 'application/pdf', false],
  ];
  for (const [id, name, mime, expected] of nativeRows) {
    await aq(`INSERT INTO file_assets(id,owner_type,storage_kind,storage_key,file_name,mime_type,category,visibility,status,review_status,metadata,created_at,updated_at)
      VALUES(?,'PLATFORM','INTERNAL_PROXY',?,?,?,'TEACHING_ASSET','PUBLIC_PLATFORM','ACTIVE','NOT_REQUIRED','{}',?,?)`, [id, `teaching/${id}`, name, mime, now, now]);
    const info = await previewInfoFor(id);
    check(`①-b ${name} → sourceUrl ${expected ? '有' : '没有'}`, Boolean(info.sourceUrl) === expected, JSON.stringify(info));
    if (expected) check('①-b sourceUrl 走的是 preview-source 且带票据', /\/preview-source\?t=/.test(info.sourceUrl), info.sourceUrl);
  }
  // 真取一次：把 .pptx 的字节原样拿回来（本地行，走流式那条），并把 .docx 那条路的门关上
  const nativeBytes = Buffer.concat([Buffer.from('PK\u0003\u0004', 'binary'), Buffer.from('p145-native-fixture')]);
  const nativeKey = 'teaching/p145-native.pptx';
  fs.mkdirSync(path.dirname(path.join(uploadRoot, nativeKey)), { recursive: true });
  fs.writeFileSync(path.join(uploadRoot, nativeKey), nativeBytes);
  const localPptxId = await mkRow({ oss: false, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', name: '真夹具.pptx', key: nativeKey, bytes: nativeBytes, size: nativeBytes.length });
  const sourceUrl = (await previewInfoFor(localPptxId)).sourceUrl;
  const sourceRes = await fetch(`${base}${sourceUrl}`, { redirect: 'manual' });
  const sourceBytes = Buffer.from(await sourceRes.arrayBuffer());
  check('①-b 带票据取原始 .pptx：拿到的是**原始字节**（不是转出来的 PDF）',
    sourceRes.status === 200 && sourceBytes.equals(nativeBytes), `HTTP ${sourceRes.status} ${sourceBytes.length}B`);
  check('①-b content-type 是 pptx（浏览器按它当 zip 解析）', /presentationml/.test(String(sourceRes.headers.get('content-type') || '')), String(sourceRes.headers.get('content-type')));
  const docSource = await fetch(`${base}/api/org/file-assets/file_doc_native/preview-source?t=${encodeURIComponent(signPreviewTicket('file_doc_native').ticket)}`, { redirect: 'manual' });
  check('①-b docx 那条路是关着的（400，不是"什么都能取的原文件口"）', docSource.status === 400, `HTTP ${docSource.status}`);
  const noTicket = await fetch(`${base}/api/org/file-assets/${localPptxId}/preview-source`, { redirect: 'manual' });
  check('①-b 没有票据也不给（401/403）', noTicket.status === 401 || noTicket.status === 403, `HTTP ${noTicket.status}`);

  const ossTicket = signPreviewTicket(ossPngId).ticket;
  const ossRes = await preview(ossPngId, ossTicket);
  const location = String(ossRes.headers.get('location') || '');
  check('② ★ OSS 行的预览是 302（字节不再过这台机）', ossRes.status === 302, `HTTP ${ossRes.status}`);
  check('② 跳的是桶的签名地址', /^https:\/\/p145-test-bucket\.oss-cn-guangzhou\.aliyuncs\.com\//.test(location), location.slice(0, 120));
  check('② 带 OSSAccessKeyId / Expires / Signature', /OSSAccessKeyId=/.test(location) && /Expires=\d+/.test(location) && /Signature=/.test(location));
  check('② ★ 签的是这一行自己的 storage_key（带上 OSS_PREFIX）', location.includes('/p145/2026/09/p145-oss.png'), location.slice(0, 140));
  check('⑥ 不带 response-content-disposition（带了就有"另存为"的口子）', !/response-content-disposition/i.test(location));
  check('② 302 让浏览器短时缓存（重复打开不再回源）', /max-age=\d+/.test(String(ossRes.headers.get('cache-control') || '')), String(ossRes.headers.get('cache-control')));

  const localTicket = signPreviewTicket(localPngId).ticket;
  const localRes = await preview(localPngId, localTicket);
  const localBytes = Buffer.from(await localRes.arrayBuffer());
  check('③ 本地行的预览仍是 200 流式（没有一刀切全跳走）', localRes.status === 200, `HTTP ${localRes.status}`);
  check('③ 字节与落盘的一模一样', localBytes.equals(PNG) && String(localRes.headers.get('content-type')).startsWith('image/png'));
  check('③ 本地行预览仍是 inline（不给另存为入口）', String(localRes.headers.get('content-disposition') || '') === 'inline');

  const pptxRes = await preview(ossPptxId, signPreviewTicket(ossPptxId).ticket);
  const pptxBody = Buffer.from(await pptxRes.arrayBuffer());
  check('⑤ ★ OSS 够不着时是 404 而不是 500', pptxRes.status === 404, `HTTP ${pptxRes.status}`);
  check('⑤ ★ 也绝不把原始 .pptx 字节吐出去（响应是 JSON 报错，不是文件）',
    String(pptxRes.headers.get('content-type') || '').includes('application/json')
    && !pptxBody.includes(Buffer.from('PK\u0003\u0004', 'binary')),
    `HTTP ${pptxRes.status} ${String(pptxRes.headers.get('content-type'))} ${pptxBody.length} 字节`);

  const badRes = await preview(ossPngId, 'not-a-ticket');
  check('④ 票据无效 → 不是 302（回落到会话鉴权，未登录就是 401/403）', badRes.status === 401 || badRes.status === 403, `HTTP ${badRes.status}`);
  const expired = signPreviewTicket(ossPngId, { now: Date.now() - 3 * 60 * 60 * 1000, ttlMs: 60 * 60 * 1000 }).ticket;
  const expiredRes = await preview(ossPngId, expired);
  check('④ 过期票据 → 同样不是 302', expiredRes.status === 401 || expiredRes.status === 403, `HTTP ${expiredRes.status}`);
} finally {
  server.kill();
  // Windows 上服务进程可能还攥着库文件，删不掉就算了（临时目录，系统会清）
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures) { console.log(`\nP145 有 ${failures} 项未通过`); if (serverLog) console.log(serverLog.slice(-1500)); process.exitCode = 1; }
else console.log('P145 课件预览改走 OSS：OSS 行 302 签名地址（本机不再搬字节）、本地行照旧流式、票据照旧拦、够不着 OSS 时 404 不吐原始文件 通过');
