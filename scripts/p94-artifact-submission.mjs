/**
 * P94 「按产物提交」守卫（2026-09-15）。
 *
 * 用户口径：**不需要提交整个作品，而是针对能展示出来的作品来提交** ——
 * 学生做完一个游戏、一份 PPT，各自有提交按钮；平台后台才能把每一份都发到官网展示。
 *
 * 所以唯一性从「一个对话一条」变成「(对话, 产物) 一条」，老库要重建表才能改（SQLite 改不了列级 UNIQUE）。
 * 这里钉住改完之后的三条不变量：
 *   ① 复合唯一索引存在（否则重复提交会悄悄多出一堆条目）；
 *   ② 同一对话的**两份不同产物**都能存 → 这正是本次改动的目的；
 *   ③ 同一份产物**重复插入被挡住** → 重复提交走覆盖（round+1），不是新增。
 * 另外钉住提交接口确实按 entryFile 作用域（源码断言），以及多提交时下发的是**列表**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p94-artifact-submit-'));
const dbPath = path.join(temp, 'platform.db');
const env = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'local-mock', AI_PROVIDER: 'local-mock' };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
await run(['packages/database/src/db.js', '--init']);
// 必须跑种子：不然没有学生/机构，下面的插入验证会被静默跳过 —— 那就是一条**假绿**的守卫。
await run(['packages/database/src/seed.js']);

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

const db = new DatabaseSync(dbPath); db.exec('PRAGMA busy_timeout = 5000');
const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_vibe_submission_conversation_entry'").get();
check('① 复合唯一索引 (conversation_id, entry_file) 已建', Boolean(index));
const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='vibecoding_submissions'").get()?.sql || '');
check('旧约束 conversation_id 单列 UNIQUE 已去掉', !ddl.includes('conversation_id TEXT NOT NULL UNIQUE'));

// 造一个对话（其余字段用最小可用值）
const now = new Date().toISOString();
const student = db.prepare("SELECT id, org_id FROM users WHERE role='STUDENT' LIMIT 1").get();
const orgId = student?.org_id || db.prepare("SELECT id FROM organizations LIMIT 1").get()?.id;
if (student && orgId) {
  const convId = 'conv_p94';
  db.prepare('INSERT INTO vibecoding_conversations(id,student_id,org_id,title,status,entry_file,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(convId, student.id, orgId, 'P94 测试作品', 'DRAFT', 'index.html', now, now);
  const insert = (id, entryFile) => db.prepare(`INSERT INTO vibecoding_submissions(id,conversation_id,student_id,org_id,title,entry_file,submitted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, convId, student.id, orgId, 'P94', entryFile, now, now, now);

  let two = true; let detail = '';
  try { insert('sub_p94_a', 'index.html'); insert('sub_p94_b', '演示文稿.pptx'); } catch (error) { two = false; detail = error.message; }
  check('② 同一对话的两份不同产物都能提交（本次改动的目的）', two, detail);

  let blocked = false;
  try { insert('sub_p94_c', 'index.html'); } catch { blocked = true; }
  check('③ 同一份产物重复插入被唯一性挡住（重复提交走覆盖，不是新增）', blocked);

  const rows = db.prepare('SELECT entry_file FROM vibecoding_submissions WHERE conversation_id=? ORDER BY entry_file').all(convId);
  check('④ 该对话最终是 2 条提交（各对应一份产物）', rows.length === 2, JSON.stringify(rows));
  db.prepare('DELETE FROM vibecoding_submissions WHERE conversation_id=?').run(convId);
  db.prepare('DELETE FROM vibecoding_conversations WHERE id=?').run(convId);
} else {
  console.log('  · 种子数据里没有学生/机构，跳过插入验证');
}
db.close();

// 接口层：提交必须按 entryFile 作用域，并且多提交时下发列表（源码断言，端到端在服务器上真机验证）
const route = fs.readFileSync(path.join(root, 'apps/server/src/routes/vibecoding.js'), 'utf8');
check('⑤ 提交接口按 (conversation_id, entry_file) 查已有提交', /WHERE conversation_id = \? AND entry_file = \?/.test(route));
check('⑥ 提交接口会拒绝不在作品里的产物名', route.includes('VIBECODING_ARTIFACT_NOT_FOUND'));
check('⑦ 会话详情下发已提交产物列表（界面才能准确标「已提交」）', route.includes('submittedEntries: submissions.map'));

fs.rmSync(temp, { recursive: true, force: true });
if (failures) { console.log(`\nP94 有 ${failures} 项未通过`); process.exitCode = 1; }
else console.log('P94 按产物提交：复合唯一性、不同产物各成一条、重复提交被挡、接口按产物作用域 通过');
