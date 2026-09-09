/**
 * P24 VibeCoding 多文件工程导入 / 导出。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：工程包导出→导入往返一致 → 入口文件缺失时回落到第一个文件 → 兼容裸 {文件名:内容} 写法 →
 * 各类非法包被拒（非 JSON / 非对象 / 无 files / 空文件 / 超过 12 个 / 文件名非法含 .. / 单文件超 64KB /
 * 总量超 256KB）→ 导入结果经 API 保存后能读回 → 服务端同样拒绝超限文件（前后端限制一致）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p24-vibecoding-project-'));
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

// 直接测前端用的纯函数（导出/导入两侧共用同一份实现）
const { buildProjectBundle, parseProjectBundle, projectFileBase, PROJECT_LIMITS } = await import(pathToFileURL(path.join(root, 'packages/shared/src/vibecodingProject.js')).href);
const expectReject = (text, label) => {
  assert.throws(() => parseProjectBundle(text), undefined, `${label} 应该被拒绝`);
};

const { DatabaseSync } = await import('node:sqlite');
const seedDb = new DatabaseSync(dbPath);
const lesson = seedDb.prepare('SELECT id FROM course_lessons ORDER BY sort LIMIT 1').get();
seedDb.prepare("UPDATE course_lessons SET delivery_mode='VIBECODING' WHERE id=?").run(lesson.id);
seedDb.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
seedDb.close();

const port = 18881;
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

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  // 1) 导出 → 导入往返一致
  const files = {
    'index.html': '<!doctype html><html><body><h1>我的作品</h1><script src="script.js"></script></body></html>',
    'style.css': 'h1 { color: #7058d5; }',
    'script.js': "console.log('你好，VibeCoding！');\n",
  };
  const bundleText = JSON.stringify(buildProjectBundle({ title: '我的第一个网页', entryFile: 'script.js', files }));
  const roundTrip = parseProjectBundle(bundleText);
  assert.deepEqual(roundTrip.files, files, '往返后文件内容应完全一致');
  assert.equal(roundTrip.entryFile, 'script.js', '往返后入口文件应保留');

  // 2) 入口文件不存在 → 回落第一个文件；裸 {文件名:内容} 也接受
  const noEntry = parseProjectBundle(JSON.stringify({ format: 'x', files: { 'a.html': 'A', 'b.js': 'B' }, entryFile: 'missing.js' }));
  assert.equal(noEntry.entryFile, 'a.html', '入口文件缺失时应回落到第一个文件');
  const bare = parseProjectBundle(JSON.stringify({ 'main.js': 'console.log(1);' }));
  assert.deepEqual(bare.files, { 'main.js': 'console.log(1);' }, '裸对象写法应被接受');
  assert.equal(bare.entryFile, 'main.js', '裸对象写法入口文件应为第一个文件');

  // 3) 非法包一律拒绝
  expectReject('not json at all', '非 JSON');
  expectReject(JSON.stringify([1, 2, 3]), '数组');
  expectReject(JSON.stringify({ format: 'x' }), '没有 files');
  expectReject(JSON.stringify({ files: {} }), '空文件集合');
  expectReject(JSON.stringify({ files: Object.fromEntries(Array.from({ length: PROJECT_LIMITS.maxFiles + 1 }, (_, index) => [`f${index}.js`, ''])) }), `超过 ${PROJECT_LIMITS.maxFiles} 个文件`);
  expectReject(JSON.stringify({ files: { '../escape.js': 'x' } }), '路径穿越');
  expectReject(JSON.stringify({ files: { '/abs.js': 'x' } }), '绝对路径');
  expectReject(JSON.stringify({ files: { 'bad name.js': 'x' } }), '文件名含空格');
  expectReject(JSON.stringify({ files: { 'big.js': 'x'.repeat(PROJECT_LIMITS.maxFileBytes + 1) } }), '单文件超 64KB');
  expectReject(JSON.stringify({ files: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`f${index}.js`, 'y'.repeat(60 * 1024)])) }), '总量超 256KB');

  // 4) 文件名兜底
  assert.equal(projectFileBase('我的 第一个/网页'), '我的-第一个-网页', '导出文件名应去掉路径与空格');
  assert.equal(projectFileBase(''), 'vibecoding-project', '空标题应有兜底文件名');

  // 5) 导入结果经 API 保存后能读回；服务端对超限文件的限制与前端一致
  const student = (await api('/api/auth/login', { method: 'POST', body: { login: 'student-2', password: 'study123' } })).data.token;
  assert.ok(student, '学生登录失败');
  const created = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: lesson.id, title: 'P24 导入导出用例' } });
  assert.equal(created.status, 200, `新建会话失败: ${JSON.stringify(created.data)}`);
  const conversationId = created.data.id;
  const saved = await api(`/api/student/vibecoding/conversations/${conversationId}`, { method: 'PUT', token: student, body: { files: roundTrip.files, entryFile: roundTrip.entryFile } });
  assert.equal(saved.status, 200, `保存导入的工程失败: ${JSON.stringify(saved.data)}`);
  const detail = await api(`/api/student/vibecoding/conversations/${conversationId}`, { token: student });
  assert.equal(detail.data.entryFile, 'script.js', '读回后入口文件应为 script.js');
  assert.deepEqual(detail.data.files, files, '读回后文件应与导入内容一致');

  const oversize = await api(`/api/student/vibecoding/conversations/${conversationId}`, { method: 'PUT', token: student, body: { files: { 'big.js': 'x'.repeat(PROJECT_LIMITS.maxFileBytes + 1) }, entryFile: 'big.js' } });
  assert.equal(oversize.status, 400, `服务端应拒绝超限文件，实际 ${oversize.status}`);
  assert.equal(oversize.data?.error?.code, 'VIBECODING_FILE_TOO_LARGE', '错误码应为 VIBECODING_FILE_TOO_LARGE');
  const tooMany = await api(`/api/student/vibecoding/conversations/${conversationId}`, { method: 'PUT', token: student, body: { files: Object.fromEntries(Array.from({ length: PROJECT_LIMITS.maxFiles + 1 }, (_, index) => [`f${index}.js`, ''])) } });
  assert.equal(tooMany.status, 400, `服务端应拒绝过多文件，实际 ${tooMany.status}`);
  assert.equal(tooMany.data?.error?.code, 'VIBECODING_TOO_MANY_FILES', '错误码应为 VIBECODING_TOO_MANY_FILES');

  console.log(JSON.stringify({
    name: 'vibecoding-project-io', pass: true,
    roundTrip: { files: Object.keys(roundTrip.files).length, entryFile: roundTrip.entryFile },
    lenient: { entryFileFallback: noEntry.entryFile, bareShape: bare.entryFile },
    rejected: 10,
    persisted: { entryFile: detail.data.entryFile, fileCount: Object.keys(detail.data.files || {}).length },
    serverLimits: { oversizeFile: oversize.data.error.code, tooManyFiles: tooMany.data.error.code },
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
