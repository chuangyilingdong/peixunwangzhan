/**
 * P170 课件/素材「下载入口」的边界守卫（2026-09-30 用户口径）。
 *
 * 用户口径：「给平台管理员一个下载入口就行。有个下载按钮。在课时编排那」。
 * 背景：平台一直是「机构/老师**只能在线看、不提供下载**」（2026-09-15 用户口径 A，
 * 界面上那条"已由平台转换成 PDF 后展示（不提供下载入口）"就是它）。这次只给**平台管理员**开一个口，
 * 所以这一道要同时钉住两件事：
 *   ① **管理员下得到**：课时编排里那个「下载」按钮指向 `/api/admin/file-assets/<id>/download`，
 *      真请求要能拿到**原件字节**（与上传时一致）；
 *   ② ⚠️ **别人下不到**：同一个（非公开的）素材，机构口 / 学生口 / 公开口都必须被拒 ——
 *      这是那条口径的边界，**比 ① 更要紧**：口径破在这里通常是"顺手把链接抄到了机构端"。
 *
 * 跑法：node scripts/p170-asset-download-entry.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';


const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p170-download-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;
const { arow } = await import('../packages/database/src/store.js');

const PORT = 18970;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
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

/* ── ① 源码：课时编排那个「下载」按钮 ─────────────────────────────── */
// ⚠️ 这一段**故意不剥注释**：这次新加的那行里有个正则字面量（`replace(/^\/api\/[^/]+\//, …)`），
//    里面有 `\//` —— `lib/sourceText.mjs` 的已知盲区（它不认识正则字面量）会把 `//` 当行注释，
//    **从那里把这行截断**，于是断言假红（第一次跑就是这么红的）。它的文件头写得很清楚：
//    **遇到这种文件，别把断言建在剥注释上，直接钉真实结构。**
console.log('\n① 源码口径：素材预览组件里有指向 `/file-assets/<id>/download` 的下载链接');
const forms = fs.readFileSync(path.join(root, 'apps/admin/src/components/CourseForms.jsx'), 'utf8');
const downloadLine = forms.split('\n').find((line) => line.includes('const downloadUrl = isPlatformAsset')) || '';
check('① `MaterialPreview` 里算出了下载地址（downloadUrl 指向 admin 口）',
  downloadLine.includes("'/api/admin/'"), downloadLine.trim().slice(0, 160));
check('① 只有平台文件资产才给按钮（isPlatformAsset 判定 + 外链不拼 /download）',
  forms.includes('const isPlatformAsset =') && forms.includes('/download$/'));
check('① 按钮渲染出来了（href={downloadUrl}、文案「下载」）',
  forms.includes('href={downloadUrl}') && forms.includes('下载原件（仅平台管理员）'));

/* ── ② 行为：管理员下得到、别人下不到 ─────────────────────────────── */
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });

const login = async (login_, password) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: login_, password }),
  });
  return (await response.json().catch(() => ({})))?.data?.token || '';
};
const download = async (scope, fileId, token) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/${scope}/file-assets/${fileId}/download`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    redirect: 'manual',
  });
  // 本机没配 OSS → 走本地流（200 + 字节）；生产上对象在 OSS → 302 到签名地址。两种都算"下得到"。
  const body = response.status === 200 ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  return { status: response.status, body, location: response.headers.get('location') || '' };
};

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* 等 */ }
    if (Date.now() > deadline) throw new Error(`后端没起来：${serverLog.slice(-600)}`);
    await sleep(150);
  }
  const adminToken = await login('root', 'admin123');
  const orgToken = await login('org-admin', 'org123');
  const studentToken = await login('student-1', 'study123');
  check('② 三个身份都能登录（平台管理员 / 机构管理员 / 学生）', Boolean(adminToken && orgToken && studentToken));

  // 管理员上传一个**非公开**素材（默认 PRIVATE —— 正是"机构不能下"的那一类）
  const bytes = Buffer.from('P170 下载口边界测试：这是一份不该让机构/学生下到的素材。', 'utf8');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'text/plain' }), 'p170-material.txt');
  form.append('category', 'TEACHING_ASSET');
  form.append('visibility', 'PRIVATE');
  const uploaded = await (await fetch(`http://127.0.0.1:${PORT}/api/admin/file-assets/upload`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: form,
  })).json().catch(() => ({}));
  const fileId = uploaded?.data?.id || '';
  check('② 平台管理员能上传素材（拿到 fileId）', Boolean(fileId), JSON.stringify(uploaded).slice(0, 200));
  const row = await arow('SELECT owner_type, visibility FROM file_assets WHERE id=?', [fileId]);
  check('② 这份素材是"平台自有 + 非公开"（下面反向那几条才有意义）',
    row?.owner_type === 'PLATFORM' && row?.visibility !== 'PUBLIC_PLATFORM', JSON.stringify(row));

  const asAdmin = await download('admin', fileId, adminToken);
  check('② ⭐ 平台管理员能下到**原件字节**（200 带字节 / 302 到签名地址都算）',
    (asAdmin.status === 200 && asAdmin.body.equals(bytes)) || (asAdmin.status === 302 && Boolean(asAdmin.location)),
    `status=${asAdmin.status} 字节=${asAdmin.body.length}`);
  if (asAdmin.status === 200) {
    check('② 而且字节与上传的一模一样', asAdmin.body.equals(bytes), `${asAdmin.body.length} vs ${bytes.length}`);
  }

  const asOrg = await download('org', fileId, orgToken);
  check('② ⚠️ 机构口下不到（这就是"机构只能在线看"那条口径）', asOrg.status === 403 || asOrg.status === 404, `status=${asOrg.status}`);
  const asStudent = await download('student', fileId, studentToken);
  check('② ⚠️ 学生口下不到', asStudent.status === 403 || asStudent.status === 404, `status=${asStudent.status}`);
  const asPublic = await download('public', fileId, '');
  check('② ⚠️ 公开口下不到（`FILE_NOT_PUBLIC`）', asPublic.status === 403 || asPublic.status === 404, `status=${asPublic.status}`);
} catch (error) {
  failures += 1;
  console.error('P170 抛错：', error?.message || error);
  console.error(serverLog.split('\n').slice(-12).join('\n'));
} finally {
  server.kill('SIGTERM');
}

console.log('');
if (failures) { console.log(`✗ p170 有 ${failures} 处不符合预期`); process.exit(1); }
assert.equal(failures, 0);
console.log('✓ p170 素材下载入口（管理员能下 / 机构与学生下不到）：全部通过');
