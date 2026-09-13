/**
 * P71 works 表重建迁移的守卫（C2，2026-09-13）。
 *
 * 重建表是最容易「静默丢数据」的迁移：DROP + RENAME 之间漏一个列/索引/子表外键，
 * 表面上服务照常启动、日志也不报错。所以这条守卫在**有数据的库**上真跑一遍迁移并逐项核对。
 *
 * 重建表是最容易「静默丢数据」的迁移类型，所以不能只看「服务起没起来」：
 *   ① 老库（旧 CHECK，无 UNPUBLISHED）→ 跑迁移 → 约束更新了；
 *   ② 作品行还在，**子表（work_reports，外键 ON DELETE CASCADE）也没被连带清空**；
 *   ③ 迁移后能写入 UNPUBLISHED；④ 再跑一次是幂等的（不重建、不报错、行数不变）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'works-migration-'));
const dbPath = path.join(temp, 'platform.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = dbPath;

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ✓ ${label}`); else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); } };

// ── 造一个「老库」：works 用**旧 CHECK**（四个状态），并塞进一条作品 + 一条子表记录 ──
{
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE works (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, student_id TEXT NOT NULL, org_id TEXT, class_id TEXT,
    course_lesson_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', canvas_snapshot TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','PUBLISHED')),
    teacher_comment TEXT, reviewed_by TEXT, reviewed_at TEXT, copyright_confirmed_at TEXT, copyright_confirmed_by TEXT,
    featured_at TEXT, featured_by TEXT, featured_reason TEXT, submitted_at TEXT NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 0, share_token TEXT
  )`);
  db.exec("CREATE TABLE work_reports (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, org_id TEXT NOT NULL, reporter_id TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL, FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE)");
  // 外键是 ON 的，所以先建一条真的项目行（上一版测试就是被 FK 挡住的，不是 CHECK 的问题）
  db.exec("CREATE TABLE student_projects (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, org_id TEXT, class_id TEXT, course_lesson_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT', canvas_snapshot TEXT NOT NULL DEFAULT '{}', latest_version INTEGER NOT NULL DEFAULT 1, last_saved_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT)");
  db.prepare("INSERT INTO student_projects(id,student_id,title,last_saved_at,created_at,updated_at) VALUES ('proj_1','user_1','老项目','2026-09-01','2026-09-01','2026-09-01')").run();
  db.prepare("INSERT INTO student_projects(id,student_id,title,last_saved_at,created_at,updated_at) VALUES ('proj_2','user_1','新项目','2026-09-13','2026-09-13','2026-09-13')").run();
  db.prepare("INSERT INTO works(id,project_id,student_id,org_id,title,canvas_snapshot,status,teacher_comment,submitted_at,is_public,share_token) VALUES ('work_old','proj_1','user_1','org_1','老作品','{}','REJECTED','老的驳回/下架说明','2026-09-01',0,'wst_old')").run();
  db.prepare("INSERT INTO work_reports(id,work_id,org_id,reporter_id,reason,status,created_at) VALUES ('report_old','work_old','org_1','user_2','举报原因','PENDING','2026-09-02')").run();
  const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='works'").get()?.sql || '');
  check('起点：老库的 works 约束里**没有** UNPUBLISHED', ddl.includes("'REJECTED'") && !ddl.includes("'UNPUBLISHED'"));
  db.close();
}

// ── 跑真实迁移（导入 schema.js 即执行全部幂等迁移）──
await import('./../packages/database/src/schema.js');

{
  const db = new DatabaseSync(dbPath);
  const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='works'").get()?.sql || '');
  check('迁移后：works 的 CHECK 含 UNPUBLISHED', ddl.includes("'UNPUBLISHED'"), ddl.slice(0, 200));
  check('迁移后：新列 unpublish_reason / unpublished_at 都在', ddl.includes('unpublish_reason') && ddl.includes('unpublished_at'));
  const work = db.prepare("SELECT * FROM works WHERE id='work_old'").get();
  check('迁移后：作品行还在，字段没串位', work?.title === '老作品' && work?.status === 'REJECTED' && work?.teacher_comment === '老的驳回/下架说明' && work?.share_token === 'wst_old', JSON.stringify(work));
  const reports = db.prepare('SELECT COUNT(*) n FROM work_reports').get().n;
  check('迁移后：子表 work_reports 没被 ON DELETE CASCADE 连带清空', Number(reports) === 1, `子表行数 ${reports}`);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='works'").all().map((item) => item.name);
  check('迁移后：索引都重建了（含唯一索引与 share_token 部分索引）',
    ['idx_works_org_submitted', 'idx_works_work_data_scope', 'idx_works_project_unique', 'idx_works_org_featured', 'idx_works_share_token'].every((name) => indexes.includes(name)),
    indexes.join(','));
  // 新状态可写入
  let insertError = null;
  try {
    db.prepare("INSERT INTO works(id,project_id,student_id,title,canvas_snapshot,status,submitted_at,is_public,unpublish_reason) VALUES ('work_new','proj_2','user_1','新作品','{}','UNPUBLISHED','2026-09-13',0,'涉及版权')").run();
  } catch (error) { insertError = error; }
  check('迁移后：真的能写入 UNPUBLISHED（CHECK 不再挡）', !insertError, String(insertError?.message || ''));
  db.close();
}

// ── 幂等：再跑一次，行数不变、不重建、不报错 ──
await import(`../packages/database/src/schema.js?v=2`);
{
  const db = new DatabaseSync(dbPath);
  const total = db.prepare('SELECT COUNT(*) n FROM works').get().n;
  check('再跑一次是幂等的：作品行数与迁移后一致', Number(total) === Number(process.env.EXPECTED_WORKS || 2), `行数 ${total}`);
  const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='works'").get()?.sql || '');
  check('再跑一次没有把表改名成 works_migrated（没有半截状态）', !ddl.includes('works_migrated'));
  db.close();
}

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
