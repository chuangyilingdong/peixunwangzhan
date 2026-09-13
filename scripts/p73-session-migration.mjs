/**
 * P73 课堂表重建迁移的守卫（批次 B，2026-09-13）。
 *
 * 重建表最容易「静默丢数据」：DROP + RENAME 之间漏一个列/索引/回填规则，
 * 表面上服务照常启动、日志也不报错。所以这里在**有数据的库**上真跑一遍迁移并逐项核对。
 *
 * 做法：先按真实 schema + 种子建库，再把 class_sessions 换回**旧结构**并塞进两节课
 * （一节进行中、一节已结束）+ 两条用量记录（软引用），然后重新初始化触发迁移。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p73-session-migration-'));
const dbPath = path.join(temp, 'platform.db');
const env = { ...process.env, PLATFORM_DATA_DIR: temp, PLATFORM_DB_PATH: dbPath };
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  child.on('close', (code) => (code ? reject(new Error(err || out)) : resolve(out)));
});
let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

await run(['packages/database/src/db.js', '--init']);
await run(['packages/database/src/seed.js']);

// 把 class_sessions 退回**旧结构**（两态 + class_id/started_* 非空 + 旧唯一索引），并塞进真实数据
const fixture = {};
const dataSnapshot = (db) => Object.fromEntries(['class_sessions', 'session_students', 'usage_records'].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
let migratedSnapshot;
{
  const db = new DatabaseSync(dbPath);
  const teacher = db.prepare("SELECT id FROM users WHERE login='teacher-1'").get();
  const students = db.prepare("SELECT id FROM users WHERE role='STUDENT' ORDER BY login LIMIT 2").all();
  const lesson = db.prepare("SELECT id, series_id, title FROM course_lessons WHERE status='PUBLISHED' ORDER BY sort LIMIT 1").get();
  const orgId = db.prepare("SELECT org_id FROM users WHERE login='teacher-1'").get().org_id;
  const cls = db.prepare('SELECT id FROM classes WHERE org_id=? LIMIT 1').get(orgId);

  db.exec('DROP TABLE class_sessions');
  db.exec(`CREATE TABLE class_sessions (
    id TEXT PRIMARY KEY, class_id TEXT NOT NULL, lesson_id TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
    delivery_mode TEXT NOT NULL DEFAULT 'CANVAS', session_credit_cap INTEGER, consumed_credits_total INTEGER NOT NULL DEFAULT 0,
    ai_paused INTEGER NOT NULL DEFAULT 0, student_call_cap INTEGER,
    allow_text INTEGER NOT NULL DEFAULT 1, allow_image INTEGER NOT NULL DEFAULT 1, allow_music INTEGER NOT NULL DEFAULT 1,
    allow_video INTEGER NOT NULL DEFAULT 0, allow_podcast INTEGER NOT NULL DEFAULT 0, allow_dubbing INTEGER NOT NULL DEFAULT 0,
    started_by TEXT NOT NULL, started_at TEXT NOT NULL, ended_by TEXT, ended_at TEXT, ended_reason TEXT)`);
  db.exec("CREATE UNIQUE INDEX idx_class_sessions_active ON class_sessions(class_id) WHERE status = 'ACTIVE'");
  db.prepare(`INSERT INTO class_sessions(id,class_id,lesson_id,status,delivery_mode,started_by,started_at)
    VALUES ('p73_live',?,?, 'ACTIVE','CANVAS',?,?)`).run(cls.id, lesson.id, teacher.id, '2026-09-01T10:00:00.000Z');
  db.prepare(`INSERT INTO class_sessions(id,class_id,lesson_id,status,delivery_mode,allow_video,started_by,started_at,ended_by,ended_at,ended_reason)
    VALUES ('p73_done',?,?, 'ENDED','VIBECODING',0,?,?,?,?, 'MANUAL')`).run(cls.id, lesson.id, teacher.id, '2026-09-02T10:00:00.000Z', teacher.id, '2026-09-02T11:00:00.000Z');
  // 已扩展过的旧库也必须保留非默认课堂类型，不能重建后重置为 REGULAR。
  db.exec("ALTER TABLE class_sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'REGULAR'");
  db.exec("UPDATE class_sessions SET session_kind='TRIAL' WHERE id='p73_done'");
  fixture.legacyRows = db.prepare('SELECT * FROM class_sessions ORDER BY id').all();
  // 两名学员都有成功使用证据，金额分别为 100 和 0，均应完课。
  db.prepare(`INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,cost_fen,created_at)
    VALUES ('p73_u1',?,?,'p73_done','TEXT','m',0,'SUCCESS',100,'2026-09-02T10:30:00.000Z')`).run(orgId, students[0].id);
  db.prepare(`INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,cost_fen,created_at)
    VALUES ('p73_u2',?,?,'p73_done','TEXT','m',0,'SUCCESS',0,'2026-09-02T10:31:00.000Z')`).run(orgId, students[1].id);
  fixture.usageRows = db.prepare('SELECT * FROM usage_records ORDER BY id').all();
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='class_sessions'").get().sql;
  check('起点：老库只有 ACTIVE/ENDED 两态、class_id 非空', ddl.includes("'ACTIVE','ENDED'") && !ddl.includes("'PENDING'") && /class_id TEXT NOT NULL/.test(ddl));
  Object.assign(fixture, { teacherId: teacher.id, studentA: students[0].id, studentB: students[1].id, lessonId: lesson.id, seriesId: lesson.series_id, lessonTitle: lesson.title, orgId });
  db.close();
}

// 再初始化一次 → 触发重建迁移
await run(['packages/database/src/db.js', '--init']);

{
  const db = new DatabaseSync(dbPath);
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='class_sessions'").get().sql;
  check('迁移后：CHECK 含 PENDING 与 DISSOLVED', ddl.includes("'PENDING'") && ddl.includes("'DISSOLVED'"));
  check('迁移后：class_id 可空、started_* 可空、新列齐全',
    !/class_id TEXT NOT NULL/.test(ddl) && !/started_by TEXT NOT NULL/.test(ddl) && ['title', 'series_id', 'teacher_id', 'created_at', 'updated_at'].every((c) => ddl.includes(c)),
    ddl.slice(0, 140));
  const rows = db.prepare("SELECT * FROM class_sessions WHERE id LIKE 'p73_%' ORDER BY id").all();
  check('迁移后：两节老课堂都在（没丢数据）', rows.length === 2, `行数 ${rows.length}`);
  const done = rows.find((r) => r.id === 'p73_done');
  for (const legacy of fixture.legacyRows) {
    const migrated = rows.find((r) => r.id === legacy.id);
    assert.ok(migrated, `迁移丢失课堂 ${legacy.id}`);
    for (const [field, value] of Object.entries(legacy)) assert.equal(migrated[field], value, `${legacy.id}.${field} 迁移后应保留`);
  }
  assert.deepEqual(db.prepare('SELECT * FROM usage_records ORDER BY id').all(), fixture.usageRows, '首次迁移必须保留全部用量字段');
  check('首次迁移完整保留旧课堂字段（含非默认 session_kind）和用量', true);
  check('迁移后：老字段没串位（status/delivery_mode/allow_video/ended_reason 都对）',
    done?.status === 'ENDED' && done?.delivery_mode === 'VIBECODING' && Number(done?.allow_video) === 0 && done?.ended_reason === 'MANUAL',
    JSON.stringify(done));
  check('迁移后：series_id 从课时推出来', done?.series_id === fixture.seriesId, JSON.stringify({ series_id: done?.series_id, expect: fixture.seriesId }));
  check('迁移后：teacher_id 从 started_by 推出来', done?.teacher_id === fixture.teacherId, JSON.stringify({ teacher_id: done?.teacher_id }));
  check('迁移后：title 用课时标题、created_at 回填 started_at', done?.title === fixture.lessonTitle && done?.created_at === done?.started_at, JSON.stringify({ title: done?.title, created_at: done?.created_at }));
  check('迁移后：用量记录没被动（软引用还在）', Number(db.prepare("SELECT COUNT(*) n FROM usage_records WHERE id LIKE 'p73_%'").get().n) === 2);
  check('迁移后：旧的部分唯一索引（一班一活跃课堂）已移除', !db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_class_sessions_active'").all().length);

  const students = db.prepare("SELECT * FROM session_students WHERE session_id='p73_done'").all();
  check('历史学员回填：每条成功使用都算完课（金额可为 0）', students.length === 2 && students.every((s) => s.status === 'COMPLETED'), JSON.stringify(students.map((s) => ({ id: s.student_id, status: s.status }))));
  check('回填带上完成时间且保留实际金额', students.every((s) => Boolean(s.completed_at)) && students.some((s) => Number(s.completed_cost_fen) === 100), JSON.stringify(students));
  check('进行中的老课堂没有被回填（ACTIVE 不算完课）', Number(db.prepare("SELECT COUNT(*) n FROM session_students WHERE session_id='p73_live'").get().n) === 0);
  check('回填的学员行带上了 lesson/series（单表可查「这节课上过吗」）',
    students[0]?.lesson_id === fixture.lessonId && students[0]?.series_id === fixture.seriesId, JSON.stringify({ lesson: students[0]?.lesson_id, series: students[0]?.series_id }));

  // 新模型的写入路径能跑：待上课（started_* 为空）+ 学员六态
  let insertError = null;
  try {
    db.prepare("INSERT INTO class_sessions(id,title,org_id,series_id,lesson_id,teacher_id,status,delivery_mode,created_at,updated_at) VALUES ('p73_pending','新课堂',?,?,?,?,'PENDING','CANVAS',datetime('now'),datetime('now'))").run(fixture.orgId, fixture.seriesId, fixture.lessonId, fixture.teacherId);
    db.prepare("INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_at) VALUES ('p73_ss','p73_pending',?,?,?,?,'PENDING',datetime('now'))").run(fixture.studentB, fixture.orgId, fixture.lessonId, fixture.seriesId);
  } catch (error) { insertError = error; }
  check('迁移后：能建「待上课」课堂并加学员（新模型写入路径可用）', !insertError, String(insertError?.message || ''));
  let dupError = null;
  try {
    db.prepare("INSERT INTO session_students(id,session_id,student_id,org_id,status,added_at) VALUES ('p73_ss2','p73_pending',?,?,'PENDING',datetime('now'))").run(fixture.studentB, fixture.orgId);
  } catch (error) { dupError = error; }
  check('同一课堂同一学员不能重复加（部分唯一索引真的在挡）', Boolean(dupError), '重复插入竟然成功了');
  migratedSnapshot = dataSnapshot(db);
  db.close();
}

await run(['packages/database/src/db.js', '--init']);
{
  const db = new DatabaseSync(dbPath);
  const rerunSnapshot = dataSnapshot(db);
  check('再跑一次没有半截迁移表', !db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%migrated%'").all().length);
  assert.deepEqual(rerunSnapshot, migratedSnapshot, '再次初始化不得改变课堂、学员、用量任何字段');
  db.close();
}

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
