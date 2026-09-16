/**
 * P101 账号唯一性与登录名格式（2026-09-16 用户口径）。
 *
 * 口径原话：「给机构或者机构给老师给学生创建账号时，要做唯一性校验，因为不同的用户可能是同登录名
 * 或者同名字。而且登录名现在可以填中文，应该是只能英文、数字的。」
 *
 * 这条守卫钉住四件事：
 *   ① 登录名只允许英文/数字（可带 . _ -）：中文、空格、@ 一律拒；
 *   ② 登录名**全局唯一且忽略大小写**（Zhang 与 zhang 不能并存）；
 *   ③ 姓名**同机构同角色**不能重名；不同机构、或同机构的老师与学员同名是允许的；
 *   ④ 批量导入的预览里就要把这两类问题逐行标出来（而不是提交时才炸）。
 *
 * 用临时 SQLite，不碰默认库与生产库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p101-accounts-'));
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
process.env.DEPLOYMENT_MODE = 'local-mock';
process.env.AI_PROVIDER = 'local-mock';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const rejects = async (fn, code, label) => {
  try { await fn(); check(label, false, '竟然成功了（应当被拒）'); return null; }
  catch (error) { check(label, error.code === code, `期望 ${code}，实际 ${error.code}：${error.message}`); return error; }
};

const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { handleOrg } = await import('../apps/server/src/routes/orgAdmin.js');
const { row } = await import('../apps/server/src/lib.js');

// ⚠️ 查询串要**拆到 ctx.search**：处理器读的是 ctx.search.get(...)，而路由层负责把 '?a=b' 拆开。
// 直接把带查询串的路径当 pathname 传，处理器会因为 part 不匹配而返回 null（踩过一次）。
function splitQuery(pathname) {
  const index = pathname.indexOf('?');
  if (index < 0) return { pathname, search: new URLSearchParams() };
  return { pathname: pathname.slice(0, index), search: new URLSearchParams(pathname.slice(index + 1)) };
}
const adminCtx = (pathname, method = 'GET', body = null) => ({
  ...splitQuery(pathname), method, body,
  pathname: '/api/admin' + splitQuery(pathname).pathname,
  req: { socket: { remoteAddress: '127.0.0.1' } },
  auth: { user: { id: 'root', login: 'root', role: 'SUPER_ADMIN', orgId: null, permissions: [] }, rawUser: { permissions: '[]' } },
});
const admin = (pathname, method, body) => handleAdmin(adminCtx(pathname, method, body));
const org = (orgId, pathname, method = 'GET', body = null) => handleOrg({
  ...splitQuery(pathname), method, body,
  pathname: '/api/org' + splitQuery(pathname).pathname,
  req: { socket: { remoteAddress: '127.0.0.1' } },
  auth: { user: { id: `org-admin-${orgId}`, login: `org-admin-${orgId}`, role: 'ORG_ADMIN', orgId, permissions: [] }, rawUser: { permissions: '[]' } },
});

// ── 夹具：两家机构，各自的第一个管理员 ─────────────────────────────────
const orgA = await admin('/organizations', 'POST', {
  name: 'P101 甲机构', contractStartAt: '2026-09-01', contractExpiresAt: '2027-08-31',
  teacherSeats: 10, studentSeats: 50, adminLogin: 'p101-admin-a', adminDisplayName: '甲管理员', adminPassword: 'secret123',
});
const orgB = await admin('/organizations', 'POST', {
  name: 'P101 乙机构', contractStartAt: '2026-09-01', contractExpiresAt: '2027-08-31',
  teacherSeats: 10, studentSeats: 50, adminLogin: 'p101-admin-b', adminDisplayName: '乙管理员', adminPassword: 'secret123',
});
check('两家机构建好（各带一个管理员）', Boolean(orgA?.id && orgB?.id));

console.log('\n【一】登录名格式：只允许英文与数字（可带 . _ -）');
for (const [label, login] of [['中文', '学生甲'], ['空格', 'stu 01'], ['@ 符号', 'stu@example'], ['短横线开头', '-stu']]) {
  await rejects(() => org(orgA.id, '/users', 'POST', { role: 'STUDENT', login, displayName: `格式${label}`, password: 'secret123' }), 'INVALID_LOGIN_FORMAT', `登录名带${label}要被拒`);
}
const okFormats = ['stu01', 'stu.01', 'stu_01', 'Student-01'];
for (const login of okFormats) {
  const created = await org(orgA.id, '/users', 'POST', { role: 'STUDENT', login, displayName: `合法${login}`, password: 'secret123' });
  check(`合法登录名可用：${login}`, Boolean(created?.id));
}

console.log('\n【二】登录名唯一（忽略大小写）');
await rejects(() => org(orgA.id, '/users', 'POST', { role: 'STUDENT', login: 'stu01', displayName: '重名登录名', password: 'secret123' }), 'LOGIN_EXISTS', '同机构不能再建同登录名');
await rejects(() => org(orgB.id, '/users', 'POST', { role: 'STUDENT', login: 'STU01', displayName: '跨机构同登录名', password: 'secret123' }), 'LOGIN_EXISTS', '别的机构也不能用同一登录名（大小写不同也算）');

console.log('\n【三】姓名唯一：同机构同角色');
await rejects(() => org(orgA.id, '/users', 'POST', { role: 'STUDENT', login: 'stu02', displayName: '合法stu01', password: 'secret123' }), 'DISPLAY_NAME_EXISTS', '同机构同角色重名要被拒');
const teacherSameName = await org(orgA.id, '/users', 'POST', { role: 'TEACHER', login: 'tea01', displayName: '合法stu01', password: 'secret123' });
check('同机构的老师与学员可以同名（角色不同）', Boolean(teacherSameName?.id));
const otherOrgSameName = await org(orgB.id, '/users', 'POST', { role: 'STUDENT', login: 'stu02', displayName: '合法stu01', password: 'secret123' });
check('不同机构可以同名', Boolean(otherOrgSameName?.id));

console.log('\n【四】改名也要过唯一性');
const target = row("SELECT id FROM users WHERE login='stu.01'");
await rejects(() => org(orgA.id, `/users/${target.id}`, 'PUT', { displayName: '合法stu01' }), 'DISPLAY_NAME_EXISTS', '改名撞上同机构同名要被拒');
const renamed = await org(orgA.id, `/users/${target.id}`, 'PUT', { displayName: '换了个名字' });
check('改成不冲突的名字可以', renamed?.displayName === '换了个名字');

console.log('\n【五】批量导入：预览阶段逐行标出格式错与重名');
const preview = await org(orgA.id, '/users/import/preview', 'POST', {
  items: [
    { login: 'imp01', displayName: '导入甲', role: 'STUDENT', password: 'secret123' },
    { login: '导入中文', displayName: '导入乙', role: 'STUDENT', password: 'secret123' },
    { login: 'imp01', displayName: '导入丙', role: 'STUDENT', password: 'secret123' },
    { login: 'imp02', displayName: '导入甲', role: 'STUDENT', password: 'secret123' },
    { login: 'stu01', displayName: '导入戊', role: 'STUDENT', password: 'secret123' },
  ],
});
const errorsOf = (index) => (preview.items.find((item) => item.index === index)?.errors || []);
check('第 1 行合法', errorsOf(1).length === 0, JSON.stringify(errorsOf(1)));
check('第 2 行：中文登录名被标出', errorsOf(2).some((text) => text.includes('英文和数字')), JSON.stringify(errorsOf(2)));
check('第 3 行：本批次登录名重复被标出', errorsOf(3).some((text) => text.includes('本批次登录名重复')), JSON.stringify(errorsOf(3)));
check('第 4 行：本批次姓名重复被标出', errorsOf(4).some((text) => text.includes('同名')), JSON.stringify(errorsOf(4)));
check('第 5 行：与库里已有登录名冲突被标出', errorsOf(5).some((text) => text.includes('登录名已存在')), JSON.stringify(errorsOf(5)));

console.log('\n【六】学员名单分页：最新添加的在最前，total 是真的');
{
  // 造 25 个学员，看分页是不是真的（原来是 LIMIT 500 + 假 total，分页组件算不出页数）
  for (let index = 1; index <= 25; index += 1) {
    await org(orgA.id, '/users', 'POST', {
      role: 'STUDENT',
      login: `pager${String(index).padStart(2, '0')}`,
      displayName: `分页学员${index}`,
      password: 'secret123',
    });
  }
  const firstPage = await org(orgA.id, '/users?role=STUDENT&limit=20&page=1');
  const secondPage = await org(orgA.id, '/users?role=STUDENT&limit=20&page=2');
  check('第一页给 20 条', firstPage.items.length === 20, `实际 ${firstPage.items.length}`);
  check('total 是真的（大于一页）', firstPage.total > 20, `实际 ${firstPage.total}`);
  check('totalPages 按 total 算得出来', firstPage.totalPages === Math.ceil(firstPage.total / 20), `${firstPage.totalPages} vs ${firstPage.total}`);
  check('第二页有内容且与第一页不重叠', secondPage.items.length > 0 && !secondPage.items.some((item) => firstPage.items.some((other) => other.id === item.id)));
  check('最新的排最前面（刚建的 pager25 在第一条）', firstPage.items[0]?.login === 'pager25', firstPage.items[0]?.login);
  const searched = await org(orgA.id, '/users?role=STUDENT&limit=20&page=1&search=pager1');
  check('搜索能筛出目标（pager1x 系列）', searched.items.length > 0 && searched.items.every((item) => String(item.login).includes('pager1')), JSON.stringify(searched.items.map((item) => item.login)));
}

console.log(JSON.stringify({ name: 'account-uniqueness', pass: failures === 0, failures }, null, 2));
process.exit(failures === 0 ? 0 : 1);
