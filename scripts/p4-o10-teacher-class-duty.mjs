import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(process.cwd());
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-teacher-class-duty-'));
const env = { ...process.env, PLATFORM_DATA_DIR: tempDir, PLATFORM_DB_PATH: path.join(tempDir, 'platform.db'), PORT: '0' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${args.join(' ')} failed (${code}): ${stderr || stdout}`)));
});
await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const port = 18801;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk; });
server.stderr.on('data', (chunk) => { serverOutput += chunk; });
const base = `http://127.0.0.1:${port}/api`;
async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return; } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${serverOutput}`);
}
async function request(cookie, pathName, options = {}) {
  const response = await fetch(base + pathName, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
  const body = await response.json();
  return { status: response.status, body };
}
async function login(loginName, password) {
  const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: loginName, password }) });
  if (!response.ok) throw new Error(`login failed for ${loginName}`);
  return response.headers.get('set-cookie');
}
const checks = [];
function check(name, condition) { checks.push({ name, pass: Boolean(condition) }); if (!condition) throw new Error(`failed: ${name}`); }
try {
  await waitForServer();
  const admin = await login('org-admin', 'org123');
  const teacher = await login('teacher-1', 'teach123');
  const teacher2 = await login('teacher-2', 'teach123');
  const student = await login('student-1', 'study123');
  const createdTeacher = await request(admin, '/org/users', { method: 'POST', body: JSON.stringify({ role: 'TEACHER', login: 'teacher-duty-test', displayName: '职责测试教师', password: 'teach123', permissions: [] }) });
  check('机构管理员可创建无额外权限教师', createdTeacher.status === 200 && createdTeacher.body.data?.permissions?.length === 0);
  const dutyTeacher = await login('teacher-duty-test', 'teach123');
  const roster = await request(dutyTeacher, '/org/users?role=STUDENT');
  check('教师可读取本机构学生名册', roster.status === 200 && roster.body.data?.items?.some((item) => item.login === 'student-1'));
  const courses = await request(dutyTeacher, '/org/course-series');
  const lesson = courses.body.data.items[0].lessons[0];
  // 批次 D（班级退场）：这一组「教师职责」从**班级**搬到**课堂** ——
  // 原来验「教师能建班 / 加学生 / 配课时 / 不能动别人的班」，现在验同一套职责落在课堂接口上。
  const createdClass = await request(dutyTeacher, '/org/sessions', { method: 'POST', body: JSON.stringify({ lessonId: lesson.id, title: '教师职责测试课堂' }) });
  check('教师可创建课堂（挂在自己名下）', createdClass.status === 200 && Boolean(createdClass.body.data?.teacherId), JSON.stringify(createdClass.body.data).slice(0, 160));
  const classId = createdClass.body.data.id;
  const added = await request(dutyTeacher, `/org/sessions/${classId}/students`, { method: 'POST', body: JSON.stringify({ studentIds: [roster.body.data.items.find((item) => item.login === 'student-1').id] }) });
  check('教师可把本机构学生加进自己的课堂', added.status === 200 && (added.body.data?.added || []).length === 1, JSON.stringify(added.body.data).slice(0, 160));
  const started = await request(dutyTeacher, `/org/sessions/${classId}/start`, { method: 'POST', body: '{}' });
  check('教师可开始自己的课堂（名单非空）', started.status === 200, `${started.status} ${JSON.stringify(started.body.data || {}).slice(0, 120)}`);
  const adminClass = await request(admin, '/org/sessions', { method: 'POST', body: JSON.stringify({ lessonId: lesson.id, teacherId: 'user_missing' }) });
  check('非法教师分配被拒绝', adminClass.status === 400, `${adminClass.status}`);
  const teacherRoster = await request(admin, '/org/users?role=TEACHER');
  const teacher2Id = teacherRoster.body.data.items.find((item) => item.login === 'teacher-2').id;
  const classForTeacher2 = await request(admin, '/org/sessions', { method: 'POST', body: JSON.stringify({ lessonId: lesson.id, title: '李老师职责课堂', teacherId: teacher2Id }) });
  check('机构管理员可创建课堂并指定其他教师', classForTeacher2.status === 200, JSON.stringify(classForTeacher2.body.data).slice(0, 160));
  const foreign = await request(dutyTeacher, `/org/sessions/${classForTeacher2.body.data.id}`);
  check('教师不能读其他教师的课堂', foreign.status === 403 || foreign.status === 404, `${foreign.status}`);
  const forbiddenEnd = await request(dutyTeacher, `/org/sessions/${classForTeacher2.body.data.id}/end`, { method: 'POST', body: '{}' });
  check('教师不能结束其他教师的课堂', forbiddenEnd.status === 403 || forbiddenEnd.status === 404, `${forbiddenEnd.status}`);
  const studentClasses = await request(student, '/org/sessions');
  check('学生不能调用机构课堂接口', studentClasses.status === 403, `${studentClasses.status}`);
  console.log(JSON.stringify({ total: checks.length, passed: checks.filter((item) => item.pass).length, failed: checks.filter((item) => !item.pass).length, checks }, null, 2));
} finally {
  server.kill();
}
