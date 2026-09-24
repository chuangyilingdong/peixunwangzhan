/**
 * P134 三端「自助修改密码」（2026-09-23 用户口径）。
 *
 * 用户原话：「机构端/老师端/学生端创建了账号后，他们应该是有自行修改密码的按钮和操作」。
 * 这一版之前的状态：平台端早有（p19 钉着 admin/me/password、p37 钉着 student/account/password），
 * 但**机构端根本没有自助接口**（只有"管理员改本机构成员密码"那条，改的是别人），
 * 而且学生端虽然接口早就有、**界面上没有入口** —— 于是创建账号时发的临时口令三端都改不掉。
 *
 * 这个守卫钉两件事，缺一件这个需求就没真正满足：
 *   ① **接口真的能用**：三端各跑一遍完整流程（错口令被拒 → 太短被拒 → 与旧密码相同被拒 →
 *      改成功 → **旧会话立刻失效**（改密撤销所有会话）→ 新口令能登录、旧口令不能登录）；
 *   ② **界面上真有入口**：三端各自的页面都接了同一个 `PasswordChangeForm`
 *      （"接口有、界面没有入口"正是这一轮要修的那个 bug，所以必须一起钉住）。
 *
 * ⚠️ 三端的历史差异（**新写的机构端跟平台端对齐**，不去改另外两端的既有行为 —— p19/p37 钉着它们）：
 *   · 当前密码不对：平台端/机构端 = 403（forbidden），学生端 = 400 —— 错误码都是 CURRENT_PASSWORD_INVALID；
 *   · 新密码太短：平台端 = 400 USER_PASSWORD_REQUIRED，学生端/机构端 = 400 PASSWORD_TOO_SHORT。
 *   所以下面按"**被拒 + 密码没被改掉**"断言（这是真正要守的不变量），不逐端钉状态码。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p134-password-'));
const dbPath = path.join(temp, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const baseEnv = { ...process.env, PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || temp, PLATFORM_DB_PATH: process.env.PLATFORM_DB_PATH || dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err)) : resolve()));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readFile = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 19134;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, error: payload?.error || null };
}
const login = (login_, password) => api('/api/auth/login', { method: 'POST', body: { login: login_, password } });
/** 直接读库里的 password_hash —— "密码到底换没换"只有库说得准（接口只回"成功"，那可能骗人）。
 *  ⚠️ 别去打 /api/me：它返回的是规范化过的用户对象，**不包含**密码哈希（也不该包含）。 */
async function hashOf(loginName) {
  
  try { return (await arow('SELECT password_hash FROM users WHERE login=?', [loginName]))?.password_hash || ''; }
  finally {  }
}

try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 等服务起来 */ } await sleep(100); }

  console.log('① 三端「自助改密」接口（真服务 / 真 HTTP）');
  // 每端：端点 / 登录名 / 原密码 / 新密码 / 用来验"会话是否真的失效"的接口
  const targets = [
    { name: '学生端', endpoint: '/api/student/account/password', login: 'student-1', old: 'study123', next: 'study456', probe: '/api/student/dashboard' },
    { name: '机构端（机构管理员）', endpoint: '/api/org/me/password', login: 'org-admin', old: 'org123', next: 'org456', probe: '/api/org/overview' },
    { name: '机构端（授课教师）', endpoint: '/api/org/me/password', login: 'teacher-1', old: 'teach123', next: 'teach456', probe: '/api/org/overview' },
    { name: '平台端（对照，p19 已有）', endpoint: '/api/admin/me/password', login: 'root', old: 'admin123', next: 'root456', probe: '/api/admin/me/mfa' },
  ];
  for (const target of targets) {
    const before = await login(target.login, target.old);
    assert.equal(before.status, 200, `${target.name}：原密码登录失败`);
    const token = before.data?.token;
    check(`${target.name}：老口令能登录（前置条件）`, Boolean(token));
    const hashBefore = await hashOf(target.login);

    const wrong = await api(target.endpoint, { method: 'PUT', token, body: { currentPassword: 'definitely-wrong', newPassword: target.next } });
    check(`${target.name}：当前密码不对 → 被拒（${wrong.status}）`, wrong.status >= 400 && wrong.error?.code === 'CURRENT_PASSWORD_INVALID', JSON.stringify(wrong.error));
    const short = await api(target.endpoint, { method: 'PUT', token, body: { currentPassword: target.old, newPassword: '123' } });
    check(`${target.name}：新密码太短 → 被拒（400）`, short.status === 400, JSON.stringify(short.error));
    const same = await api(target.endpoint, { method: 'PUT', token, body: { currentPassword: target.old, newPassword: target.old } });
    check(`${target.name}：新密码与当前相同 → 被拒（${same.status}）`, same.status >= 400 && same.error?.code === 'PASSWORD_UNCHANGED', JSON.stringify(same.error));
    // 三次被拒之后，原口令必须仍然能用（别把账号改坏）
    check(`${target.name}：被拒三次后原口令仍可登录（没被改坏）`, (await login(target.login, target.old)).status === 200);

    const changed = await api(target.endpoint, { method: 'PUT', token, body: { currentPassword: target.old, newPassword: target.next } });
    check(`${target.name}：改密成功（${changed.status}）`, changed.status === 200 && changed.data?.passwordChanged === true, JSON.stringify(changed.data || changed.error));
    check(`${target.name}：撤销了会话（sessionsRevoked ≥ 1）`, Number(changed.data?.sessionsRevoked || 0) >= 1, JSON.stringify(changed.data));
    // 「要求重新登录」这个标志三端叫法不同（历史原因，两边都被守卫钉着，不去改名）：
    // 平台端 = reauthRequired（p19 钉着），机构端/学生端 = reloginRequired。界面按 sessionsRevoked 说话，所以只断言"有一个"。
    check(`${target.name}：明确要求重新登录`, changed.data?.reauthRequired === true || changed.data?.reloginRequired === true);
    // ★ 这一条是"改密真的生效"的硬判据：改密前那个 token 现在必须打不动了
    check(`${target.name}：★ 改密前那个会话立刻失效（旧 token 被拒）`, (await api(target.probe, { token })).status === 401);
    check(`${target.name}：新口令能登录`, (await login(target.login, target.next)).status === 200);
    check(`${target.name}：旧口令不能登录`, (await login(target.login, target.old)).status >= 400);
    // 密码真的换了：直接比库里的哈希（接口说"成功"不算数，库说了才算）
    const hashAfter = await hashOf(target.login);
    check(`${target.name}：库里的密码哈希确实变了`, Boolean(hashAfter) && hashAfter !== hashBefore, `before=${String(hashBefore).slice(0, 12)} after=${String(hashAfter).slice(0, 12)}`);
  }

  console.log('② 反向自检（越权与缺参）');
  const studentToken = (await login('student-1', 'study456')).data?.token;
  const orgToken = (await login('org-admin', 'org456')).data?.token;
  const studentOnOrg = await api('/api/org/me/password', { method: 'PUT', token: studentToken, body: { currentPassword: 'study456', newPassword: 'whatever123' } });
  check('反向：学生 token 打机构端的自助改密 → 被拒（不是"任何登录用户都能改"）', studentOnOrg.status >= 400, JSON.stringify(studentOnOrg.error));
  const orgOnStudent = await api('/api/student/account/password', { method: 'PUT', token: orgToken, body: { currentPassword: 'org456', newPassword: 'whatever123' } });
  check('反向：机构 token 打学生端的自助改密 → 被拒', orgOnStudent.status >= 400, JSON.stringify(orgOnStudent.error));
  const noCurrent = await api('/api/org/me/password', { method: 'PUT', token: orgToken, body: { newPassword: 'whatever123' } });
  check('反向：机构端不带当前密码 → 400 CURRENT_PASSWORD_REQUIRED', noCurrent.status === 400 && noCurrent.error?.code === 'CURRENT_PASSWORD_REQUIRED', JSON.stringify(noCurrent.error));
  const anon = await api('/api/org/me/password', { method: 'PUT', body: { currentPassword: 'org456', newPassword: 'whatever123' } });
  check('反向：未登录 → 401', anon.status === 401, JSON.stringify(anon.error));

  console.log('③ 界面入口（"接口有、界面没有入口"是这一轮要修的 bug，必须一起钉住）');
  const shared = readFile('packages/shared/src/account.jsx');
  check('① 三端共用一个表单组件（packages/shared/src/account.jsx 的 PasswordChangeForm）',
    /export function PasswordChangeForm/.test(shared) && /currentPassword/.test(shared) && /newPassword/.test(shared));
  check('① 表单自己先拦一次：≥6 位 / 两次一致 / 不与当前相同',
    /newPassword\.length < 6/.test(shared) && /新密码不能与当前密码相同/.test(shared) && /两次输入的新密码不一致/.test(shared));
  check('② 成功之后不假装还在登录：只提示 + 「去重新登录」', /密码已修改/.test(shared) && /去重新登录/.test(shared) && !/window\.alert/.test(shared));
  const admin = readFile('apps/admin/src/pages/Security.jsx');
  check('平台端：账号安全页用同一个组件、端点是 admin/me/password',
    /PasswordChangeForm/.test(admin) && /admin\/me\/password/.test(admin));
  const org = readFile('apps/org/src/pages/AccountSecurity.jsx');
  const orgMain = readFile('apps/org/src/main.jsx');
  check('机构端：新增「账号安全」页，端点 org/me/password',
    /PasswordChangeForm/.test(org) && /org\/me\/password/.test(org));
  check('机构端：侧栏有入口（🔑 onChangePassword）+ 导航里有「账号安全」',
    /onChangePassword=\{\(\) => navigate\('\/account'\)\}/.test(orgMain) && /to: '\/account'/.test(orgMain));
  // 老师那一套导航是另写的一份 —— 只加一份的话机构管理员看得到、老师看不到
  check('机构端：机构管理员与老师**两份导航**都加了「账号安全」', (orgMain.match(/to: '\/account', icon: '🔑', label: '账号安全'/g) || []).length === 2,
    `匹配到 ${(orgMain.match(/to: '\/account', icon: '🔑', label: '账号安全'/g) || []).length} 处`);
  const site = readFile('apps/website/src/main.jsx');
  const studentPage = readFile('apps/website/src/pages/AccountSecurity.jsx');
  check('学生端：新增 /account 页，端点 student/account/password',
    /PasswordChangeForm/.test(studentPage) && /student\/account\/password/.test(studentPage));
  check('学生端：右上角下拉里有「账号安全」入口，且 /account 未登录会被带去学生登录',
    /to: '\/account', label: '账号安全'/.test(site) && /pathname === '\/account'/.test(site) && /path='\/account'/.test(site));

} finally {
  server.kill();
}

console.log('');
if (failures) { console.log(`✗ p134 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p134 三端自助改密：全部通过');
