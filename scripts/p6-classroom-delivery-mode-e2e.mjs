import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p6-delivery-mode-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp,
  PLATFORM_DB_PATH: dbPath,
  DEPLOYMENT_MODE: 'development',
  AI_PROVIDER: 'local-mock',
  AI_PROVIDER_API_KEY: '',
};

const run = (args, env = baseEnv) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => {
    if (code) reject(new Error(err || out));
    else resolve(out);
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = 18866;

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const server = spawn(process.execPath, ['apps/server/src/index.js'], {
  cwd: root,
  env: { ...baseEnv, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload?.data ?? payload, raw: payload };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`课堂入口 E2E 服务启动失败: ${serverLog}`);
}

async function login(loginName, password) {
  const result = await api('/api/auth/login', {
    method: 'POST',
    body: { login: loginName, password },
  });
  assert.equal(result.status, 200, `${loginName} 登录失败: ${JSON.stringify(result.raw)}`);
  assert.ok(result.data?.token, `${loginName} 登录响应缺少 token`);
  return result.data.token;
}

function errorCode(result) {
  return result.data?.error?.code || result.raw?.error?.code || null;
}

function assertStatus(result, status, message) {
  assert.equal(result.status, status, `${message}: ${JSON.stringify(result.raw)}`);
}

function readDeliveryMode(sessionId) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT delivery_mode FROM class_sessions WHERE id=?').get(sessionId)?.delivery_mode;
  } finally {
    db.close();
  }
}

try {
  await waitForServer();

  const teacher = await login('teacher-1', 'teach123');
  const student = await login('student-1', 'study123');
  const studentId = (await api('/api/me', { token: student })).data?.user?.id || (await api('/api/me', { token: student })).data?.id;

  // 批次 D（班级退场）：课时来源从「班级课单」换成**机构已授权的课包**（课单已退场）
  const courses = await api('/api/org/course-series?limit=200', { token: teacher });
  assertStatus(courses, 200, '教师读取课包失败');
  const studentCourses = await api('/api/student/courses', { token: student });
  const grantedCourse = (studentCourses.data?.items || []).find((course) => course.hasGrant !== false);
  const lessonId = (grantedCourse?.lessons || []).find((lesson) => lesson.status === 'PUBLISHED')?.id;
  assert.ok(lessonId, `没有可用课时: ${JSON.stringify(courses.raw).slice(0, 200)}`);

  const beforeClass = await api('/api/student/projects', {
    method: 'POST',
    token: student,
    body: { courseLessonId: lessonId, title: '未开课应阻断' },
  });
  assertStatus(beforeClass, 403, '未开课时学生创建项目未被阻断');
  // 2026-09-13（批次 B）：取消免课堂通道后，未开课时学生是「还没被加进课堂」而不是「课堂没开始」
  assert.equal(errorCode(beforeClass), 'NOT_IN_CLASSROOM');

  const canvasSession = await api(`/api/org/sessions`, {
    method: 'POST',
    token: teacher,
    body: { lessonId },
  });
  assertStatus(canvasSession, 200, '默认 Canvas 课堂开课失败');
  assert.equal(canvasSession.data?.deliveryMode, 'CANVAS');
  assert.equal(readDeliveryMode(canvasSession.data.id), 'CANVAS');
  // 批次 B：有许可 ≠ 能进 —— 还得被老师排进这节课的课堂，并且老师点了开始上课
  const roster = await api(`/api/org/sessions/${canvasSession.data.id}/students`, { method: 'POST', token: teacher, body: { studentIds: [studentId] } });
  assertStatus(roster, 200, '把学生排进 Canvas 课堂失败');
  const startedCanvas = await api(`/api/org/sessions/${canvasSession.data.id}/start`, { method: 'POST', token: teacher, body: {} });
  assertStatus(startedCanvas, 200, '开始 Canvas 课堂失败');

  const canvasProject = await api('/api/student/projects', {
    method: 'POST',
    token: student,
    body: { courseLessonId: lessonId, title: 'Canvas 课堂项目' },
  });
  assertStatus(canvasProject, 200, 'Canvas 活动课堂下学生创建项目失败');
  // 2026-09-13（批次 B）：项目归属记「课堂」而不是班级（班级已退场）
  assert.equal(canvasProject.data?.classSessionId, canvasSession.data.id);
  assert.equal(canvasProject.data?.courseLessonId, lessonId);

  const endCanvas = await api(`/api/org/sessions/${canvasSession.data.id}/end`, {
    method: 'POST',
    token: teacher,
    body: { reason: 'DELIVERY_MODE_E2E_CANVAS_DONE' },
  });
  assertStatus(endCanvas, 200, '结束 Canvas 课堂失败');
  assert.equal(endCanvas.data?.status, 'ENDED');

  const afterCanvas = await api('/api/student/projects', {
    method: 'POST',
    token: student,
    body: { courseLessonId: lessonId, title: '结束后应阻断' },
  });
  assertStatus(afterCanvas, 403, '结束课堂后学生仍可创建项目');
  assert.equal(errorCode(afterCanvas), 'NOT_IN_CLASSROOM');

  const vibeSession = await api(`/api/org/sessions`, {
    method: 'POST',
    token: teacher,
    body: { lessonId, deliveryMode: 'VIBECODING' },
  });
  assertStatus(vibeSession, 200, 'VibeCoding 课堂开课失败');
  assert.equal(vibeSession.data?.deliveryMode, 'VIBECODING');
  assert.equal(readDeliveryMode(vibeSession.data.id), 'VIBECODING');
  const vibeRoster = await api(`/api/org/sessions/${vibeSession.data.id}/students`, { method: 'POST', token: teacher, body: { studentIds: [studentId] } });
  assertStatus(vibeRoster, 200, '把学生排进 VibeCoding 课堂失败');
  const startedVibe = await api(`/api/org/sessions/${vibeSession.data.id}/start`, { method: 'POST', token: teacher, body: {} });
  assertStatus(startedVibe, 200, '开始 VibeCoding 课堂失败');

  const dashboard = await api('/api/student/dashboard', { token: student });
  assertStatus(dashboard, 200, '学生 dashboard 读取失败');
  const vibeTask = dashboard.data?.learningTasks?.find((task) => task.lessonId === lessonId)
    || dashboard.data?.tasks?.find((task) => task.lessonId === lessonId);
  assert.ok(vibeTask, `dashboard 未找到活动 VibeCoding 课时任务: ${JSON.stringify(dashboard.raw)}`);
  assert.equal(vibeTask.deliveryMode, 'VIBECODING');
  assert.equal(vibeTask.canStart, false, 'VibeCoding 课堂里画布入口不应点亮');
  assert.equal(vibeTask.canStartVibeCoding, true, 'VibeCoding 课堂已开启，VibeCoding 入口应点亮');
  assert.equal(vibeTask.vibeCodingBlockReason, null);
  assert.equal(vibeTask.activeNow, true);

  // 画布与 VibeCoding 互斥：VibeCoding 课堂里不能创建画布项目（入口走 /learn/vibecoding）
  const vibeProject = await api('/api/student/projects', {
    method: 'POST',
    token: student,
    body: { courseLessonId: lessonId, title: 'VibeCoding 不应伪装为 Canvas' },
  });
  assertStatus(vibeProject, 403, 'VibeCoding 活动课堂错误地创建了 Canvas 项目');
  assert.equal(errorCode(vibeProject), 'VIBECODING_CLASSROOM_UNAVAILABLE');

  const endVibe = await api(`/api/org/sessions/${vibeSession.data.id}/end`, {
    method: 'POST',
    token: teacher,
    body: { reason: 'DELIVERY_MODE_E2E_VIBECODING_DONE' },
  });
  assertStatus(endVibe, 200, '结束 VibeCoding 课堂失败');
  assert.equal(endVibe.data?.status, 'ENDED');

  const invalidMode = await api(`/api/org/sessions`, {
    method: 'POST',
    token: teacher,
    body: { lessonId, deliveryMode: 'NOT_A_CLASSROOM' },
  });
  assertStatus(invalidMode, 400, '非法课堂入口类型未被拒绝');
  assert.equal(errorCode(invalidMode), 'INVALID_DELIVERY_MODE');

  console.log(JSON.stringify({
    name: 'p6-classroom-delivery-mode-e2e',
    pass: true,
    
    lessonId,
    canvasSessionId: canvasSession.data.id,
    vibeSessionId: vibeSession.data.id,
    checks: 19,
  }));
} finally {
  server.kill('SIGTERM');
}
