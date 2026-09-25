/**
 * P140 会话 cookie 的**分端隔离**（2026-09-25 新增，来自一次真实故障）。
 *
 * 那次故障：学生画布上 9 张图全部 403、整屏图裂。链路是 ——
 *   ① 画布画面是 `<img>` 子资源请求，带不了 Authorization，只能靠 cookie 认证；
 *   ② cookie 以前只有一个名字 `platform_token` + `Path=/`（浏览器级）→ 同一个浏览器里
 *      **后台/机构端一登录就把学生会话顶掉**（生产实测：9-24 20:18 登了 /admin）；
 *   ③ 于是学生域素材口 `/api/student/file-assets/**` 拿到的是管理员的会话 →
 *      `requireRole(['STUDENT'])` → 403「当前角色无权访问此资源」。
 *
 * 修法（本脚本钉住的四条，别退回成"一个 cookie 走天下"）：
 *   · 学生端/官网：`platform_token` + `Path=/`（**沿用老名字**，学生浏览器里的 cookie 不用变）；
 *   · 机构端：`platform_token_org` + `Path=/api/org`；
 *   · 平台端：`platform_token_admin` + `Path=/api/admin`；
 *   · 退出登录把三个名字**一起清**。
 * 读的时候按**请求路径**挑这一端的名字（老名字兜底），所以机构/平台端的 cookie 不会被
 * 误当成学生会话 —— 也不会反过来。
 *
 * ⚠️ 权限**没有因此放宽**：拿机构端的 cookie 直接打学生域素材口，仍然是 403（最后一条断言）。
 * ⚠️ 起真服务、发真请求（p139 那套起法）：cookie 的名字/路径/读取顺序只有走 HTTP 才验得出来。
 * 跑法：node scripts/p141-session-cookie-scope.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p141-cookie-scope-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DB_PATH = dbPath;

const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp,
  PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath,
  // 素材字节落盘的位置（uploadRoot() 读它）：不指到临时目录的话，服务会去仓库的 var/uploads 找，
  // 于是断言拿到的是 404「文件存储对象不存在」——那验的就不是鉴权了。
  FILE_UPLOAD_ROOT: process.env.FILE_UPLOAD_ROOT || path.join(temp, 'uploads'),
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

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 19080;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (x) => { serverLog += x; });
server.stderr.on('data', (x) => { serverLog += x; });
const base = `http://127.0.0.1:${port}`;

try {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /** 登录一次，拿**全部** Set-Cookie（Node 的 fetch 用 getSetCookie() 逐条取）。 */
  async function loginAs(login, password, clientType) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password, ...(clientType ? { clientType } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, cookies: response.headers.getSetCookie?.() || [], token: body?.data?.token || null };
  }
  const cookieOf = (cookies, name) => cookies.find((item) => item.startsWith(`${name}=`)) || '';
  const attr = (cookie, key) => new RegExp(`${key}=([^;]+)`, 'i').exec(cookie)?.[1] || '';

  const student = await loginAs('student-1', 'study123');
  const org = await loginAs('org-admin', 'org123', 'org');
  const admin = await loginAs('root', 'admin123', 'admin');

  check('学生端登录成功', student.status === 200 && Boolean(student.token), `status=${student.status}`);
  check('机构端/平台端登录成功', org.status === 200 && admin.status === 200, `org=${org.status} admin=${admin.status}`);

  // ① 学生端：名字与路径**一个字节都没变**（老浏览器里的 cookie 继续有效，不用重新登录）
  const studentCookie = cookieOf(student.cookies, 'platform_token');
  check('学生端 cookie 仍是 platform_token + Path=/',
    studentCookie.startsWith('platform_token=') && attr(studentCookie, 'Path') === '/',
    studentCookie || '(没有 platform_token)');
  check('学生端 cookie 没被拆成新名字（platform_token_org/_admin 都不该出现）',
    !studentCookie.includes('platform_token_'));

  // ② 机构端 / 平台端：各自的名字 + 各自的路径（子资源都在 /api/<scope>/** 下）
  const orgCookie = cookieOf(org.cookies, 'platform_token_org');
  const adminCookie = cookieOf(admin.cookies, 'platform_token_admin');
  check('机构端 cookie = platform_token_org + Path=/api/org',
    orgCookie.startsWith('platform_token_org=') && attr(orgCookie, 'Path') === '/api/org',
    orgCookie || '(没有 platform_token_org)');
  check('平台端 cookie = platform_token_admin + Path=/api/admin',
    adminCookie.startsWith('platform_token_admin=') && attr(adminCookie, 'Path') === '/api/admin',
    adminCookie || '(没有 platform_token_admin)');
  check('机构/平台端登录**不碰**老名字那一个（否则又要把学生顶掉）',
    cookieOf(org.cookies, 'platform_token') === '' && cookieOf(admin.cookies, 'platform_token') === '');
  check('cookie 该有的属性还在（HttpOnly / SameSite=Lax）',
    /HttpOnly/i.test(adminCookie) && /SameSite=Lax/i.test(adminCookie));

  // ③ 三个端各自的身份**互不串味**：浏览器发给 /api/student/** 的只有 Path=/ 那一个
  async function me(cookie) {
    const response = await fetch(`${base}/api/me`, { headers: { cookie } });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, login: body?.data?.login || null, role: body?.data?.role || null };
  }
  const asStudent = await me(studentCookie);
  const asOrg = await me(orgCookie);
  const asAdmin = await me(adminCookie);
  check('学生 cookie → 学生身份', asStudent.status === 200 && asStudent.role === 'STUDENT', JSON.stringify(asStudent));
  check('机构 cookie → 机构身份', asOrg.status === 200 && asOrg.role === 'ORG_ADMIN', JSON.stringify(asOrg));
  check('平台 cookie → 平台身份', asAdmin.status === 200 && asAdmin.role === 'SUPER_ADMIN', JSON.stringify(asAdmin));

  // ④ 故障那条链路本身：学生 cookie 在**机构/平台端登录之后**依然能认证学生域素材口。
  //    这里先造一份学生私有素材（生成产物归档就是这类），再按浏览器的实际行为发请求。
  const { aq, arow } = await import('../packages/database/src/store.js');
  const { randomUUID } = await import('node:crypto');
  const studentRow = await arow("SELECT id, org_id FROM users WHERE login='student-1'");
  const fileId = `file_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const storageKey = `${new Date().toISOString().slice(0, 7).replace('-', '/')}/${randomUUID()}.png`;
  const now = new Date().toISOString();
  await aq('INSERT INTO file_assets(id,owner_type,owner_user_id,owner_org_id,storage_kind,storage_key,file_name,mime_type,file_size,category,visibility,status,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [fileId, 'USER', studentRow.id, studentRow.org_id, 'INTERNAL_PROXY', storageKey, 'x.png', 'image/png', 4, 'MEDIA_ASSET', 'PRIVATE', 'ACTIVE', '{}', now, now]);
  // 字节也真放一份：这条路最后是"读文件流"，文件不在就是 404（与鉴权无关，会掩盖真断言）
  const assetFile = path.join(baseEnv.FILE_UPLOAD_ROOT, storageKey);
  fs.mkdirSync(path.dirname(assetFile), { recursive: true });
  fs.writeFileSync(assetFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const assetPath = `/api/student/file-assets/${fileId}/download`;
  // 浏览器发给这个路径的 cookie：只有 Path=/ 的那一个（platform_token_admin 的 Path 不匹配、不带）
  const withStudentCookie = await fetch(`${base}${assetPath}`, { headers: { cookie: studentCookie } });
  check('⭐ 后台/机构端登录之后，学生 cookie 仍能取到自己的素材（这次故障的正面断言）',
    withStudentCookie.status === 200, `status=${withStudentCookie.status}`);
  const withWrongCookie = await fetch(`${base}${assetPath}`, { headers: { cookie: adminCookie } });
  check('权限没放宽：拿平台端的 cookie 打学生域素材口照样 403',
    withWrongCookie.status === 403, `status=${withWrongCookie.status}`);

  // ⑤ 退出登录：三个名字一起清
  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: studentCookie, 'content-type': 'application/json' } });
  const cleared = (logout.headers.getSetCookie?.() || []).map((item) => item.split('=')[0]);
  check('退出登录把三个名字都清了',
    ['platform_token', 'platform_token_org', 'platform_token_admin'].every((name) => cleared.includes(name)),
    cleared.join(' , ') || '(没清任何 cookie)');
} finally {
  server.kill();
}

if (failures) {
  console.error(JSON.stringify({ name: 'p141-session-cookie-scope', pass: false, failed: failures, serverLog: serverLog.slice(-800) }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p141-session-cookie-scope', pass: true, checks: 12 }));
