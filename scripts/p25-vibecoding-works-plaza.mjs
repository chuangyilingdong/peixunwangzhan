/**
 * P25 VibeCoding 作品全链路：学生对话创作 → 提交 → 老师点评 → 平台发布到作品广场 → 官网可玩。
 * 使用临时 SQLite，不读取或修改默认 / 生产数据库。
 *
 * 覆盖：提交必须带版权确认（否则 400）→ 老师通过 → 平台列表可见 →
 * 未通过/无授权时发布被拒 → 发布生成 vbt_ 分享码 → 公开列表/详情可读 →
 * 预览文档把学生 JS 内联（官网详情页据此在 sandbox iframe 里直接跑）→
 * 下架后公开端消失、直链 404 → 审计落库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-vibecoding-plaza-'));
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

const { buildPreviewDocument } = await import(pathToFileURL(path.join(root, 'packages/shared/src/vibecodingProject.js')).href);

const { DatabaseSync } = await import('node:sqlite');
const seedDb = new DatabaseSync(dbPath);
const lesson = seedDb.prepare('SELECT id, title FROM course_lessons ORDER BY sort LIMIT 1').get();
seedDb.prepare("UPDATE course_lessons SET delivery_mode='VIBECODING' WHERE id=?").run(lesson.id);
seedDb.prepare("INSERT OR IGNORE INTO course_lesson_capabilities(lesson_id, capability, created_at) VALUES (?,'text',datetime('now'))").run(lesson.id);
seedDb.close();

const port = 18891;
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
const login = (loginName, password) => api('/api/auth/login', { method: 'POST', body: { login: loginName, password } });

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }

  const student = (await login('student-2', 'study123')).data.token;
  const teacher = (await login('teacher-1', 'teach123')).data.token;
  const rootAdmin = (await login('root', 'admin123')).data.token;
  assert.ok(student && teacher && rootAdmin, '登录失败');

  // 1) 学生创作：新建会话 → 与 AI 对话 → 写入小游戏代码
  const created = await api('/api/student/vibecoding/conversations', { method: 'POST', token: student, body: { lessonId: lesson.id, title: 'P25 打地鼠小游戏' } });
  assert.equal(created.status, 200, `新建会话失败: ${JSON.stringify(created.data)}`);
  const conversationId = created.data.id;

  const chat = await fetch(`http://127.0.0.1:${port}/api/student/vibecoding/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${student}` },
    body: JSON.stringify({ content: '帮我做一个打地鼠小游戏' }),
  });
  assert.equal(chat.status, 200, `AI 对话应 200，实际 ${chat.status}`);
  assert.match(chat.headers.get('content-type') || '', /text\/event-stream/, 'AI 对话应为 SSE 流式');

  const gameScript = "console.log('P25-GAME-MARKER');\ndocument.title = '打地鼠';\n";
  const gameHtml = '<!doctype html><html><head><title>打地鼠</title></head><body><h1>打地鼠</h1><script src="game.js"></script></body></html>';
  // 学生不能手写代码了，所以这里直接写产物表来准备作品内容；
  // 本脚本验的是「提交→点评→发布→公开可玩」这条链路，不是产物怎么来的。
  {
    const driver = new DatabaseSync(dbPath);
    const now = new Date().toISOString();
    driver.prepare('DELETE FROM vibecoding_artifacts WHERE conversation_id=?').run(conversationId);
    for (const [name, kind, content] of [['index.html', 'html', gameHtml], ['game.js', 'js', gameScript]]) {
      driver.prepare('INSERT INTO vibecoding_artifacts(id,conversation_id,message_id,name,kind,content,bytes,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(`vibeart_p25_${kind}`, conversationId, null, name, kind, content, Buffer.byteLength(content), 1, now, now);
    }
    driver.prepare('UPDATE vibecoding_conversations SET entry_file=? WHERE id=?').run('index.html', conversationId);
    driver.close();
  }

  // 2) 提交必须带版权确认
  const noConsent = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: {} });
  assert.equal(noConsent.status, 400, `缺版权确认应 400，实际 ${noConsent.status}`);
  assert.equal(noConsent.data?.error?.code, 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED', '错误码应为 WORK_COPYRIGHT_CONFIRMATION_REQUIRED');
  const submitted = await api(`/api/student/vibecoding/conversations/${conversationId}/submit`, { method: 'POST', token: student, body: { copyrightConfirmed: true, description: '课堂做的小游戏' } });
  assert.equal(submitted.status, 200, `提交失败: ${JSON.stringify(submitted.data)}`);
  const submissionId = submitted.data.id;
  assert.equal(submitted.data.status, 'PENDING', '提交后状态应为 PENDING');
  assert.ok(submitted.data.copyrightConfirmedAt, '提交应记录版权确认时间');

  // 3) 未点评通过时不能发布到作品广场
  const earlyPublish = await api(`/api/admin/vibecoding-works/${submissionId}/plaza`, { method: 'PUT', token: rootAdmin, body: { published: true } });
  assert.equal(earlyPublish.status, 409, `未通过时应 409，实际 ${earlyPublish.status}`);
  assert.equal(earlyPublish.data?.error?.code, 'VIBECODING_WORK_NOT_APPROVED', '错误码应为 VIBECODING_WORK_NOT_APPROVED');

  // 4) 老师点评通过
  const approved = await api(`/api/org/vibecoding/submissions/${submissionId}`, { method: 'PUT', token: teacher, body: { status: 'APPROVED', comment: '玩法完整，可以展示' } });
  assert.equal(approved.status, 200, `老师点评失败: ${JSON.stringify(approved.data)}`);
  assert.equal(approved.data.status, 'APPROVED', '点评后状态应为 APPROVED');

  // 5) 平台作品库能看到，并发布到作品广场
  const list = await api('/api/admin/vibecoding-works?status=APPROVED', { token: rootAdmin });
  assert.equal(list.status, 200, `平台列表失败: ${JSON.stringify(list.data)}`);
  const listed = (list.data.items || []).find((item) => item.id === submissionId);
  assert.ok(listed, '平台列表应包含刚通过的作品');
  assert.equal(listed.isPublic, false, '发布前 isPublic 应为 false');
  assert.ok(listed.copyrightConfirmedAt, '平台列表应带版权确认时间');

  const published = await api(`/api/admin/vibecoding-works/${submissionId}/plaza`, { method: 'PUT', token: rootAdmin, body: { published: true } });
  assert.equal(published.status, 200, `发布失败: ${JSON.stringify(published.data)}`);
  assert.equal(published.data.isPublic, true, '发布后 isPublic 应为 true');
  assert.match(String(published.data.shareToken), /^vbt_/, '分享码应以 vbt_ 开头');
  const shareToken = published.data.shareToken;

  // 6) 公开端：列表有卡片，详情能拿到代码，预览文档可运行
  const publicList = await api('/api/public/vibecoding-works');
  assert.equal(publicList.status, 200, `公开列表失败: ${JSON.stringify(publicList.data)}`);
  const card = (publicList.data.items || []).find((item) => item.publicUrl === `/works/${shareToken}`);
  assert.ok(card, '公开列表应包含刚发布的作品');
  assert.equal(card.type, 'VIBECODING', '公开作品类型应为 VIBECODING');
  assert.equal(card.title, 'P25 打地鼠小游戏', '公开卡片应带标题');
  assert.ok(card.studentName, '公开卡片应带作者（脱敏后）');
  assert.equal(card.fileCount, 2, '公开卡片应带文件数');

  const publicDetail = await api(`/api/public/vibecoding-works/${shareToken}`);
  assert.equal(publicDetail.status, 200, `公开详情失败: ${JSON.stringify(publicDetail.data)}`);
  assert.equal(publicDetail.data.entryFile, 'index.html', '详情应带入口文件');
  assert.equal(publicDetail.data.files['game.js'], gameScript, '详情应带完整代码');
  const previewDoc = buildPreviewDocument(publicDetail.data.files, publicDetail.data.entryFile);
  assert.ok(previewDoc.includes('P25-GAME-MARKER'), '官网详情页用的预览文档应内联学生代码（可玩）');

  // 7) 下架后公开端消失、直链 404
  const unpublished = await api(`/api/admin/vibecoding-works/${submissionId}/plaza`, { method: 'PUT', token: rootAdmin, body: { published: false } });
  assert.equal(unpublished.status, 200, `下架失败: ${JSON.stringify(unpublished.data)}`);
  assert.equal(unpublished.data.isPublic, false, '下架后 isPublic 应为 false');
  const afterList = await api('/api/public/vibecoding-works');
  assert.equal((afterList.data.items || []).some((item) => item.publicUrl === `/works/${shareToken}`), false, '下架后公开列表不应再出现');
  const afterDetail = await api(`/api/public/vibecoding-works/${shareToken}`);
  assert.equal(afterDetail.status, 404, `下架后直链应 404，实际 ${afterDetail.status}`);

  // 8) 审计落库
  const db = new DatabaseSync(dbPath);
  const audits = db.prepare("SELECT action, COUNT(*) n FROM audit_logs WHERE action IN ('VIBECODING_SUBMIT','PLATFORM_VIBECODING_WORK_PUBLISH','PLATFORM_VIBECODING_WORK_UNPUBLISH') GROUP BY action").all();
  db.close();
  const auditMap = Object.fromEntries(audits.map((item) => [item.action, Number(item.n)]));
  assert.equal(auditMap.VIBECODING_SUBMIT, 1, `应有 1 条提交审计，实际 ${JSON.stringify(auditMap)}`);
  assert.equal(auditMap.PLATFORM_VIBECODING_WORK_PUBLISH, 1, '应有 1 条发布审计');
  assert.equal(auditMap.PLATFORM_VIBECODING_WORK_UNPUBLISH, 1, '应有 1 条下架审计');

  console.log(JSON.stringify({
    name: 'vibecoding-works-plaza', pass: true,
    student: { chat: 'sse', consentRequired: true, submitted: true },
    review: { approved: true },
    platform: { listed: true, published: true, shareToken: shareToken.slice(0, 8) + '…' },
    public: { card: true, detailFiles: Object.keys(publicDetail.data.files).length, playable: true },
    unpublish: { hiddenFromList: true, detail404: true },
    audits: auditMap,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill('SIGTERM');
}
