/**
 * P97 运行时网关（学生端 VibeCoding 改用 dsh 之后，模型调用从这里走）。
 *
 * 为什么必须钉住这条链路：dsh 容器里只有一把我们签发的运行时密钥，密钥里带着
 * 机构 / 学生 / 课时 / 课堂；每次调用都要**重新过门禁**（课堂仍在进行 + 学生仍在名单里），
 * 并且每次调用都要落进我们的算力账（usage_records）。这三条任意一条漏了，后果分别是
 * 「别人用我们的算力」、「课堂结束后还在烧钱」、「成本从账本里消失」。
 *
 * 用例：
 *   ① 没有密钥 → 401；伪造/篡改的密钥 → 401；过期密钥 → 401
 *   ② 密钥有效但课堂已结束 → 403（不用等容器回收）
 *   ③ 密钥有效但学生被移出名单 → 403
 *   ④ 正常调用 → 200，返回 OpenAI 形状的回复，且**落了 usage_records**
 *   ⑤ 调用方改不动归属：即使请求里塞别的机构/学生字段，账也记在密钥里的那个学生/课堂上
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { issueRuntimeKey } from '../apps/server/src/routes/runtimeGateway.js';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p97-runtime-gateway-'));
const dbPath = path.join(temp, 'platform.db');
const SECRET = 'p97-runtime-secret';
// 签发密钥这一步跑在本进程里，所以本进程也要有同一把密钥（baseEnv 只传给被拉起的服务）
process.env.RUNTIME_GATEWAY_SECRET = SECRET;
const baseEnv = {
  ...process.env,
  PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, AI_PROVIDER_SECRET_FILE: path.join(temp, 'secrets.json'),
  DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock', RUNTIME_GATEWAY_SECRET: SECRET,
};
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(code)));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

const db = new DatabaseSync(dbPath);
const teacher = db.prepare("SELECT * FROM users WHERE login='teacher-1'").get();
const student = db.prepare("SELECT * FROM users WHERE login='student-1'").get();
const lesson = db.prepare("SELECT * FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1").get();
const now = new Date().toISOString();
db.prepare('INSERT OR IGNORE INTO student_course_grants(id,org_id,student_id,series_id,granted_at) VALUES (?,?,?,?,?)')
  .run('p97_grant', student.org_id, student.id, lesson.series_id, now);
const sessionId = 'csession_p97';
db.prepare(`INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,created_at,updated_at,started_at)
  VALUES (?,?,?,?,?,?,'ACTIVE','VIBECODING',?,?,?)`).run(sessionId, 'P97 运行时网关', student.org_id, lesson.series_id, lesson.id, teacher.id, now, now, now);
db.prepare(`INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_by,added_at,updated_at)
  VALUES (?,?,?,?,?,?,'ACTIVE',?,?,?)`).run('p97_part', sessionId, student.id, student.org_id, lesson.id, lesson.series_id, teacher.id, now, now);
db.close();

const port = 19397;
const server = spawn(process.execPath, ['apps/server/src/index.js'], { cwd: root, env: { ...baseEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', (x) => { logs += x; });
server.stderr.on('data', (x) => { logs += x; });

const call = async (token, body) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/gateway/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null; try { payload = JSON.parse(text); } catch { payload = null; }
  return { status: response.status, payload, text };
};
const messages = [{ role: 'user', content: '用一句话做个自我介绍' }];

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(ready, logs);

  const key = issueRuntimeKey({ orgId: student.org_id, userId: student.id, sessionId, lessonId: lesson.id });

  const noKey = await call('', { messages });
  check('① 没有密钥 → 401', noKey.status === 401, `实际 ${noKey.status} ${noKey.text.slice(0, 120)}`);
  const tampered = await call(key.replace(/.$/, key.endsWith('A') ? 'B' : 'A'), { messages });
  check('① 篡改过的密钥 → 401', tampered.status === 401, `实际 ${tampered.status}`);
  const expired = issueRuntimeKey({ orgId: student.org_id, userId: student.id, sessionId, lessonId: lesson.id, ttlMs: -1000 });
  const expiredCall = await call(expired, { messages });
  check('① 过期密钥 → 401', expiredCall.status === 401, `实际 ${expiredCall.status} ${expiredCall.text.slice(0, 120)}`);

  const ok = await call(key, { messages });
  check('④ 正常调用 → 200，OpenAI 形状回复', ok.status === 200 && typeof ok.payload?.choices?.[0]?.message?.content === 'string', `实际 ${ok.status} ${ok.text.slice(0, 200)}`);
  check('④ 回复带 model 与 usage 字段', Boolean(ok.payload?.model) && typeof ok.payload?.usage?.total_tokens === 'number', JSON.stringify(ok.payload?.usage));

  {
    const probe = new DatabaseSync(dbPath);
    const usage = probe.prepare("SELECT * FROM usage_records WHERE class_session_id=? AND user_id=? AND modality='TEXT'").all(sessionId, student.id);
    check('④ 这次调用落了 usage_records（成本进我们的账）', usage.length >= 1, JSON.stringify(usage.slice(0, 1)));
    probe.prepare("UPDATE session_students SET status='ACTIVE' WHERE id='p97_part'").run();
    probe.close();
  }

  {
    // ⑤ 归属只看密钥：请求里塞别的机构/学生也不影响记账对象
    const spoof = await call(key, { messages, orgId: 'org_hacker', userId: 'user_hacker', studentId: 'user_hacker' });
    check('⑤ 请求里塞别的归属不影响结果', spoof.status === 200, `实际 ${spoof.status}`);
    const probe = new DatabaseSync(dbPath);
    const rows = probe.prepare("SELECT DISTINCT user_id,org_id FROM usage_records WHERE class_session_id=?").all(sessionId);
    check('⑤ 账只记在密钥里的学生与机构上', rows.every((r) => r.user_id === student.id && r.org_id === student.org_id), JSON.stringify(rows));
    probe.close();
  }

  {
    const probe = new DatabaseSync(dbPath);
    probe.prepare("UPDATE class_sessions SET status='ENDED', ended_at=? WHERE id=?").run(now, sessionId);
    probe.close();
    const ended = await call(key, { messages });
    check('② 课堂已结束 → 403（不用等容器回收）', ended.status === 403, `实际 ${ended.status} ${ended.text.slice(0, 120)}`);
  }

  {
    const probe = new DatabaseSync(dbPath);
    probe.prepare("UPDATE class_sessions SET status='ACTIVE' WHERE id=?").run(sessionId);
    probe.prepare("UPDATE session_students SET status='REMOVED', removed_reason='P97' WHERE id='p97_part'").run();
    probe.close();
    const removed = await call(key, { messages });
    check('③ 学生被移出名单 → 403', removed.status === 403, `实际 ${removed.status} ${removed.text.slice(0, 120)}`);
  }

  console.log(JSON.stringify({ name: 'runtime-gateway', pass: failures === 0, failures }, null, 2));
} catch (error) {
  console.error(logs.slice(-3000));
  throw error;
} finally {
  server.kill('SIGTERM');
  await sleep(200);
}
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
