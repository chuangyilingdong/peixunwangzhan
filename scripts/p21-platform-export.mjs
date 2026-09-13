/**
 * P21 平台列表导出（机构 / 平台用户 / 作品）。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：三个导出接口返回带 BOM 的 CSV、表头与行数正确、筛选条件与列表一致、
 * 导出写审计，以及权限域校验（没有对应业务域权限的平台管理员被拒）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensureClassroom } from './lib/classroomFixture.mjs';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p21-platform-export-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'local-mock',
  AI_PROVIDER: 'local-mock',
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18853;
const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (x) => { serverLog += x; });
server.stdout.on('data', (x) => { serverLog += x; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload };
}
const csvLines = (content) => content.replace(/^\ufeff/, '').trim().split('\r\n');

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
  // 批次 B：门禁要求「许可 + 课堂名单」，先把这个学生放进一个进行中的课堂
  ensureClassroom(dbPath);
    await sleep(100);
  }

  // 造一件作品，让作品导出有数据
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  const courses = await api('/api/student/courses', { token: student });
  const courseItems = courses.data?.items || courses.data?.courses || [];
  const lessonId = courseItems?.[0]?.currentLessonId || courseItems?.[0]?.lessons?.[0]?.id || courseItems?.[0]?.lesson?.id || courseItems?.[0]?.id;
  const project = await api('/api/student/projects', { method: 'POST', token: student, body: { courseLessonId: lessonId, title: 'P21 导出用例作品' } });
  assert.equal(project.status, 200, `项目创建失败: ${JSON.stringify(project.data)}`);
  const submitted = await api(`/api/student/projects/${project.data.id}/submit`, { method: 'POST', token: student, body: { copyrightConfirmed: true } });
  assert.equal(submitted.status, 200, `作品提交失败: ${JSON.stringify(submitted.data)}`);

  const admin = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  assert.ok(admin, '管理员登录失败');

  // 1) 机构导出
  const orgList = await api('/api/admin/organizations?limit=1', { token: admin });
  const orgExport = await api('/api/admin/organizations/export', { token: admin });
  assert.equal(orgExport.status, 200, `机构导出失败: ${JSON.stringify(orgExport.data)}`);
  const orgLines = csvLines(orgExport.data.content);
  assert.ok(orgExport.data.content.startsWith('\ufeff'), 'CSV 应带 BOM（Excel 中文不乱码）');
  assert.equal(orgLines[0], '机构名称,机构ID,状态,试用,合同开始,合同到期,基础教师席位,购买教师席位,创建时间', `机构表头不符: ${orgLines[0]}`);
  assert.equal(orgExport.data.count, orgLines.length - 1, 'count 应与数据行数一致');
  assert.equal(orgExport.data.count, orgList.data.total, '导出条数应与列表 total 一致');
  assert.match(orgExport.data.filename, /^organizations-.*\.csv$/, `文件名不符: ${orgExport.data.filename}`);

  // 2) 平台用户导出 + 筛选一致
  const userList = await api('/api/admin/platform-users?role=STUDENT&limit=1', { token: admin });
  const userExport = await api('/api/admin/platform-users/export?role=STUDENT', { token: admin });
  assert.equal(userExport.status, 200, `用户导出失败: ${JSON.stringify(userExport.data)}`);
  const userLines = csvLines(userExport.data.content);
  assert.equal(userLines[0], '登录名,姓名,角色,机构,状态,手机号,套餐,有效期至,创建时间', `用户表头不符: ${userLines[0]}`);
  assert.equal(userExport.data.count, userList.data.total, `按角色筛选的导出条数应与列表一致（${userExport.data.count} vs ${userList.data.total}）`);
  assert.ok(userLines.slice(1).every((line) => line.includes('STUDENT')), '导出行应都是 STUDENT');

  // 3) 作品导出
  const workExport = await api('/api/admin/works/export', { token: admin });
  assert.equal(workExport.status, 200, `作品导出失败: ${JSON.stringify(workExport.data)}`);
  const workLines = csvLines(workExport.data.content);
  assert.equal(workLines[0], '作品标题,学员,机构,班级,课时,状态,已上作品广场,精选,提交时间', `作品表头不符: ${workLines[0]}`);
  assert.ok(workExport.data.count >= 1, `作品导出应至少 1 条，实际 ${workExport.data.count}`);
  assert.ok(workLines.some((line) => line.includes('P21 导出用例作品')), '导出内容应包含刚提交的作品');

  // 5) 权限域：无对应业务域权限的平台管理员被拒
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const auditCount = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action IN ('PLATFORM_ORG_EXPORT','PLATFORM_USER_EXPORT','PLATFORM_WORK_EXPORT')").get().n;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,login,display_name,role,permissions,password_hash,status,created_at,updated_at) VALUES ('admin_limited','limited','受限管理员','SUPER_ADMIN','[\"ADMIN_CONTENT\"]','placeholder','ACTIVE',?,?)").run(now, now);
  db.close();
  assert.equal(auditCount, 3, `三次导出应写 3 条审计，实际 ${auditCount}`);
  await run(['-e', `
    const { DatabaseSync } = await import('node:sqlite');
    const { hashPassword } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'packages/database/src/schema.js')).href)});
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.prepare("UPDATE users SET password_hash=? WHERE id='admin_limited'").run(hashPassword('limited123'));
    db.close();
  `]);
  const limitedLogin = await api('/api/auth/login', { method: 'POST', body: { login: 'limited', password: 'limited123' } });
  assert.equal(limitedLogin.status, 200, `受限管理员登录失败: ${JSON.stringify(limitedLogin.data)}`);
  const limitedToken = limitedLogin.data.token;
  for (const [label, pathname] of [['机构导出', '/api/admin/organizations/export'], ['用户导出', '/api/admin/platform-users/export'], ['作品导出', '/api/admin/works/export']]) {
    const denied = await api(pathname, { token: limitedToken });
    assert.equal(denied.status, 403, `${label}：无业务域权限应 403，实际 ${denied.status}`);
    assert.equal(denied.data?.error?.code, 'PERMISSION_DENIED', `${label}：错误码应为 PERMISSION_DENIED，实际 ${denied.data?.error?.code}`);
  }

  console.log(JSON.stringify({
    name: 'platform-export', pass: true,
    organizations: { count: orgExport.data.count, file: orgExport.data.filename },
    users: { count: userExport.data.count, filtered: true },
    works: { count: workExport.data.count },
    audits: auditCount,
    permissionDenied: true,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
