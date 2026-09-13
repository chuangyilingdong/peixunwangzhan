/**
 * P32 课堂能力默认跟随课时：老师开课时不传的能力，按该课时开放的能力兜底。
 *
 * 背景：教师端开课曾把 capabilities 写死成 { allowImage, allowMusic }，
 * 于是所有新课堂的 allow_video 永远是 0——课时明明开了「AI 生视频」，
 * 学生一点生成就被 SESSION_CAPABILITY_DISABLED 拦下（界面提示「当前课堂未开放该 AI 能力」）。
 *
 * 覆盖：课时开放 image/video/music → 不传 capabilities 开课，三者默认都开，文字也默认开；
 * 显式传 false 仍然能关掉（老师保留控制权）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-session-caps-'));
const dbPath = path.join(temp, 'platform.db');
const baseEnv = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
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

const port = 18914;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  const rootToken = (await api('/api/auth/login', { method: 'POST', body: { login: 'root', password: 'admin123' } })).data.token;
  const teacher = (await api('/api/auth/login', { method: 'POST', body: { login: 'teacher-1', password: 'teach123' } })).data.token;
  assert.ok(rootToken && teacher, '登录失败');

  // 批次 D（班级退场）：搭场景从「建班级 → 配课单 → 班级开课」改成**直接建课堂**；
  // 能力默认值也在**建课堂**这一刻算（新接口没有单独改能力的端点）。
  const series = (await api('/api/org/course-series?limit=200', { token: teacher })).data.items;
  const lessonId = (series[0]?.lessons || [])[0]?.id;
  assert.ok(lessonId, `机构应有可开课的课时: ${JSON.stringify(series).slice(0, 200)}`);

  // 课时开放 image / video / music
  const saved = await api(`/api/admin/course-lessons/${lessonId}`, {
    method: 'PUT', token: rootToken,
    body: { capabilities: ['text', 'image', 'video', 'music'], materialGroups: [], classroomConfig: { version: 3 } },
  });
  assert.equal(saved.status, 200, `课时能力保存失败: ${JSON.stringify(saved.data)}`);

  // 1) 不传 capabilities 建课堂：默认跟随课时
  const started = await api('/api/org/sessions', { method: 'POST', token: teacher, body: { lessonId, capabilities: {} } });
  assert.equal(started.status, 200, `建课堂失败: ${JSON.stringify(started.data)}`);
  const caps = started.data.capabilities || {};
  assert.equal(caps.allowVideo, true, `课时开了生视频，课堂应默认开（实际 ${JSON.stringify(caps)}）`);
  assert.equal(caps.allowImage, true, '课时开了生图，课堂应默认开');
  assert.equal(caps.allowMusic, true, '课时开了生音乐，课堂应默认开');
  assert.equal(caps.allowText, true, '课时开了 AI 文字，课堂应默认开');

  // 2) 显式关掉仍然生效（老师保留控制权）
  const started2 = await api('/api/org/sessions', { method: 'POST', token: teacher, body: { lessonId, capabilities: { allowVideo: false } } });
  assert.equal(started2.status, 200, `二次建课堂失败: ${JSON.stringify(started2.data)}`);
  assert.equal(started2.data.capabilities.allowVideo, false, '显式传 false 时应关掉生视频');

  console.log(JSON.stringify({
    name: 'session-capability-defaults', pass: true,
    fromLesson: { text: caps.allowText, image: caps.allowImage, video: caps.allowVideo, music: caps.allowMusic },
    explicitOff: { video: started2.data.capabilities.allowVideo },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
