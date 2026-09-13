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
  // 用量：s1 花了 100 分（=有证据上过），s2 花了 0 分（=没消耗）
  db.prepare(`INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,cost_fen,created_at)
    VALUES ('p73_u1',?,?,'p73_done','TEXT','m',0,'SUCCESS',100,'2026-09-02T10:30:00.000Z')`).run(orgId, students[0].id);
  db.prepare(`INSERT INTO usage_records(id,org_id,user_id,class_session_id,modality,model,credits_charged,status,cost_fen,created_at)
    VALUES ('p73_u2',?,?,'p73_done','TEXT','m',0,'SUCCESS',0,'2026-09-02T10:31:00.000Z')`).run(orgId, students[1].id);
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
  check('迁移后：老字段没串位（status/delivery_mode/allow_video/ended_reason 都对）',
    done?.status === 'ENDED' && done?.delivery_mode === 'VIBECODING' && Number(done?.allow_video) === 0 && done?.ended_reason === 'MANUAL',
    JSON.stringify(done));
  check('迁移后：series_id 从课时推出来', done?.series_id === fixture.seriesId, JSON.stringify({ series_id: done?.series_id, expect: fixture.seriesId }));
  check('迁移后：teacher_id 从 started_by 推出来', done?.teacher_id === fixture.teacherId, JSON.stringify({ teacher_id: done?.teacher_id }));
  check('迁移后：title 用课时标题、created_at 回填 started_at', done?.title === fixture.lessonTitle && done?.created_at === done?.started_at, JSON.stringify({ title: done?.title, created_at: done?.created_at }));
  check('迁移后：用量记录没被动（软引用还在）', Number(db.prepare("SELECT COUNT(*) n FROM usage_records WHERE id LIKE 'p73_%'").get().n) === 2);
  check('迁移后：旧的部分唯一索引（一班一活跃课堂）已移除', !db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_class_sessions_active'").all().length);

  const students = db.prepare("SELECT * FROM session_students WHERE session_id='p73_done'").all();
  check('历史学员回填：只认消耗过算力的人（A 有、B 没有）',
    students.length === 1 && students[0].student_id === fixture.studentA && students[0].status === 'COMPLETED',
    JSON.stringify(students.map((s) => ({ id: s.student_id, status: s.status }))));
  check('回填带上了消耗金额（100 分）与完成时间', Number(students[0]?.completed_cost_fen) === 100 && Boolean(students[0]?.completed_at), JSON.stringify(students[0]));
  check('进行中的老课堂没有被回填（ACTIVE 不算完课）', Number(db.prepare("SELECT COUNT(*) n FROM session_students WHERE session_id='p73_live'").get().n) === 0);
  check('回填的学员行带上了 lesson/series（单表可查「这节课上过吗」）',
    students[0]?.lesson_id === fixture.lessonId && students[0]?.series_id === fixture.seriesId, JSON.stringify({ lesson: students[0]?.lesson_id, series: students[0]?.series_id }));

  // 新模型的写入路径能跑：待上课（started_* 为空）+ 学员六态
  let insertError = null;
  try {
    db.prepare("INSERT INTO class_sessions(id,title,series_id,lesson_id,teacher_id,status,delivery_mode,created_at,updated_at) VALUES ('p73_pending','新课堂',?,?,?,'PENDING','CANVAS',datetime('now'),datetime('now'))").run(fixture.seriesId, fixture.lessonId, fixture.teacherId);
    db.prepare("INSERT INTO session_students(id,session_id,student_id,org_id,lesson_id,series_id,status,added_at) VALUES ('p73_ss','p73_pending',?,?,?,?,'PENDING',datetime('now'))").run(fixture.studentB, fixture.orgId, fixture.lessonId, fixture.seriesId);
  } catch (error) { insertError = error; }
  check('迁移后：能建「待上课」课堂并加学员（新模型写入路径可用）', !insertError, String(insertError?.message || ''));
  let dupError = null;
  try {
    db.prepare("INSERT INTO session_students(id,session_id,student_id,org_id,status,added_at) VALUES ('p73_ss2','p73_pending',?,?,'PENDING',datetime('now'))").run(fixture.studentB, fixture.orgId);
  } catch (error) { dupError = error; }
  check('同一课堂同一学员不能重复加（部分唯一索引真的在挡）', Boolean(dupError), '重复插入竟然成功了');
  db.close();
}

// 幂等：再跑一次
await run(['packages/database/src/db.js', '--init']);
{
  const db = new DatabaseSync(dbPath);
  check('再跑一次幂等：课堂行数不变（3）', Number(db.prepare("SELECT COUNT(*) n FROM class_sessions WHERE id LIKE 'p73_%'").get().n) === 3);
  check('再跑一次没有半截表（不该有 _migrated）', !db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%migrated%'").all().length);
  check('再跑一次没有重复回填学员', Number(db.prepare("SELECT COUNT(*) n FROM session_students WHERE session_id='p73_done'").get().n) === 1);
  db.close();
}

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
