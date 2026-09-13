import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p6-classroom-tree-'));
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
const port = 18867;

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

// Keep one published platform course outside the class curriculum so the
// dashboard must prove that visible does not mean classroom-ready.
// 它必须对该机构有生效授权：平台课包「发布」只上课程广场，机构能看到的前提是授权
// （见交接说明第四节；否则这个课包在校端根本不会出现，就测不到「可见但未开课」了）。
{
  const db = new DatabaseSync(dbPath);
  const now = new Date().toISOString();
  const seriesId = `series_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const lessonId = `lesson_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  db.prepare(`INSERT INTO course_series(
    id,title,description,owner_type,visibility,version,sort,status,
    difficulty_level,age_range_min,age_range_max,tags,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    seriesId, '未配置体验课包', '用于验证未加入班级课单时保持置灰。',
    'PLATFORM', 'ALL_ORGS', '1.0', 99, 'PUBLISHED', 2, 8, 16, '[]', now, now,
  );
  db.prepare(`INSERT INTO course_lessons(
    id,series_id,title,summary,sort,status,duration_minutes,lesson_content,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    lessonId, seriesId, '第1课：未配置课时', '未加入学生班级课单的测试课时。',
    1, 'PUBLISHED', 45, '', now, now,
  );
  const studentOrg = db.prepare("SELECT org_id AS id FROM users WHERE login='student-1'").get();
  db.prepare(`INSERT INTO course_assignments(
    id,series_id,org_id,status,assigned_by,assigned_at,expires_at
  ) VALUES (?,?,?,?,?,?,?)`).run(
    `assign_${randomUUID().replaceAll('-', '').slice(0, 20)}`, seriesId, studentOrg.id, 'ACTIVE', null, now, null,
  );
  db.close();
}

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
  throw new Error(`课程树 E2E 服务启动失败: ${serverLog}`);
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

function allLessons(dashboard) {
  return (dashboard.data?.classroomCourses || []).flatMap((course) => course.lessons.map((lesson) => ({ course, lesson })));
}

function findLessonEntry(dashboard, lessonId) {
  return allLessons(dashboard).find(({ lesson }) => lesson.id === lessonId) || null;
}

try {
  await waitForServer();

  const teacher = await login('teacher-1', 'teach123');
  const student = await login('student-1', 'study123');

  const classes = await api('/api/org/classes', { token: teacher });
  assertStatus(classes, 200, '教师读取班级失败');
  const classItem = classes.data?.items?.find((item) => item.status === 'ACTIVE') || classes.data?.items?.[0];
  assert.ok(classItem?.id, `没有可用班级: ${JSON.stringify(classes.raw)}`);

  const curriculum = await api(`/api/org/classes/${classItem.id}/curriculum`, { token: teacher });
  assertStatus(curriculum, 200, '教师读取课单失败');
  const curriculumItems = curriculum.data?.items || [];
  assert.ok(curriculumItems.length >= 2, `班级课单少于两个课时: ${JSON.stringify(curriculum.raw)}`);

  const sameCourseItems = new Map();
  for (const item of curriculumItems) {
    const seriesId = item.sourceSeriesId || item.source_series_id || 'unknown';
    if (!sameCourseItems.has(seriesId)) sameCourseItems.set(seriesId, []);
    sameCourseItems.get(seriesId).push(item);
  }
  const [courseLessonItems] = [...sameCourseItems.values()].sort((a, b) => b.length - a.length);
  assert.ok(courseLessonItems.length >= 2, '没有找到同一课程包下至少两个课时');
  courseLessonItems.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
  const firstLessonId = courseLessonItems[0].lessonId;
  const targetLessonItem = courseLessonItems[1];
  const targetLessonId = targetLessonItem.lessonId;

  const before = await api('/api/student/dashboard', { token: student });
  assertStatus(before, 200, '学生读取未开课 dashboard 失败');
  assert.ok(Array.isArray(before.data?.classroomCourses), 'dashboard 缺少 classroomCourses');
  assert.ok(before.data.classroomCourses.length > 0, 'dashboard 没有课程包');
  for (const course of before.data.classroomCourses) {
    assert.ok(Array.isArray(course.lessons) && course.lessons.length > 0, `课程包缺少课时: ${course.id}`);
    const sorts = course.lessons.map((lesson) => Number(lesson.sort));
    assert.deepEqual(sorts, [...sorts].sort((a, b) => a - b), `课程包课时未按 sort 升序: ${course.id}`);
    assert.equal(course.canStart, false, `未开课课程包错误可进入: ${course.id}`);
    for (const lesson of course.lessons) assert.equal(lesson.canStart, false, `未开课课时错误可进入: ${lesson.id}`);
  }
  const unassigned = allLessons(before).find(({ lesson }) => lesson.assigned === false);
  assert.ok(unassigned, '未找到未加入学生班级课单的课程包课时');
  assert.equal(unassigned.lesson.blockReason, '老师尚未把本课时加入你的班级课程表');

  const canvasSession = await api(`/api/org/classes/${classItem.id}/sessions/start`, {
    method: 'POST',
    token: teacher,
    body: { lessonId: targetLessonId, deliveryMode: 'CANVAS' },
  });
  assertStatus(canvasSession, 200, '教师开启第 2 节 Canvas 课堂失败');
  assert.equal(canvasSession.data?.deliveryMode, 'CANVAS');

  const afterCanvas = await api('/api/student/dashboard', { token: student });
  assertStatus(afterCanvas, 200, '学生读取已开课 dashboard 失败');
  const targetEntry = findLessonEntry(afterCanvas, targetLessonId);
  const firstEntry = findLessonEntry(afterCanvas, firstLessonId);
  const target = targetEntry?.lesson || null;
  const first = firstEntry?.lesson || null;
  const targetCourseId = targetEntry?.course.id || null;
  assert.ok(target, 'dashboard 未找到已开课目标课时');
  assert.ok(first, 'dashboard 未找到同课程包其他课时');
  // 课时上的上下文由「班级」换成「课堂」：学生看得到的是这节节课的课堂
  assert.ok(target.sessionId || target.activeNow, '开课后课时应带课堂上下文');
  assert.equal(target.activeNow, true);
  assert.equal(target.canStart, true);
  assert.equal(target.deliveryMode, 'CANVAS');
  assert.equal(target.blockReason, null);
  assert.equal(first.canStart, false, '同课程包第 1 节被错误点亮');
  assert.equal(first.blockReason, '等待老师开始上课');
  for (const { course, lesson } of allLessons(afterCanvas)) {
    if (course.id !== targetCourseId) assert.equal(lesson.canStart, false, `其他课程包课时错误可进入: ${lesson.id}`);
  }

  const project = await api('/api/student/projects', {
    method: 'POST',
    token: student,
    body: {
      courseLessonId: targetLessonId,
      classId: classItem.id,
      title: '课程树 Canvas 课堂项目',
      canvasSnapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    },
  });
  assertStatus(project, 200, '学生进入已开启课时失败');
  assert.equal(project.data?.classSessionId, canvasSession.data.id);
  assert.equal(project.data?.courseLessonId, targetLessonId);

  const endCanvas = await api(`/api/org/classes/${classItem.id}/sessions/${canvasSession.data.id}/end`, {
    method: 'POST', token: teacher, body: { reason: 'COURSE_TREE_E2E_CANVAS_DONE' },
  });
  assertStatus(endCanvas, 200, '结束 Canvas 课堂失败');
  const afterEnd = await api('/api/student/projects', {
    method: 'POST', token: student, body: { courseLessonId: targetLessonId, classId: classItem.id, title: '结束课堂后应阻断' },
  });
  assertStatus(afterEnd, 403, '结束课堂后学生仍可创建项目');
  assert.equal(errorCode(afterEnd), 'NOT_IN_CLASSROOM');

  const vibeSession = await api(`/api/org/classes/${classItem.id}/sessions/start`, {
    method: 'POST', token: teacher, body: { lessonId: targetLessonId, deliveryMode: 'VIBECODING' },
  });
  assertStatus(vibeSession, 200, '教师开启 VibeCoding 课堂失败');
  const afterVibe = await api('/api/student/dashboard', { token: student });
  assertStatus(afterVibe, 200, '学生读取 VibeCoding 状态失败');
  const vibeLesson = findLessonEntry(afterVibe, targetLessonId)?.lesson;
  assert.equal(vibeLesson?.activeNow, true);
  assert.equal(vibeLesson?.canStart, false, 'VibeCoding 课堂里画布入口不应点亮');
  assert.equal(vibeLesson?.canStartVibeCoding, true, 'VibeCoding 入口应点亮');
  assert.equal(vibeLesson?.vibeCodingBlockReason, null);
  const vibeProject = await api('/api/student/projects', {
    method: 'POST', token: student, body: { courseLessonId: targetLessonId, classId: classItem.id, title: 'VibeCoding 应阻断' },
  });
  assertStatus(vibeProject, 403, 'VibeCoding 课堂错误创建 Canvas 项目');
  assert.equal(errorCode(vibeProject), 'VIBECODING_CLASSROOM_UNAVAILABLE');

  const endVibe = await api(`/api/org/classes/${classItem.id}/sessions/${vibeSession.data.id}/end`, {
    method: 'POST', token: teacher, body: { reason: 'COURSE_TREE_E2E_VIBE_DONE' },
  });
  assertStatus(endVibe, 200, '结束 VibeCoding 课堂失败');

  console.log(JSON.stringify({
    name: 'p6-classroom-course-tree-e2e',
    pass: true,
    classId: classItem.id,
    courseId: targetCourseId,
    firstLessonId,
    targetLessonId,
    courseCount: before.data.classroomCourses.length,
    lessonCount: allLessons(before).length,
    checks: 34,
  }));
} finally {
  server.kill('SIGTERM');
}
