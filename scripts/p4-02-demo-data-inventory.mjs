import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.cwd());
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p4-02-inventory-'));
const dbPath = path.join(tempDir, 'platform.db');
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
    // 把脚本自己那份 dbPath 写进 env —— 数据层（夹具）必须跟着**脚本自己的那个库**走：
    // 验收套件会给每个脚本设一份 PLATFORM_DB_PATH（套件的临时目录），而脚本的**服务子进程**用的是
    // 它自己 mkdtemp 出来的那份 —— 两边不是一个库，夹具写进套件那份、服务读脚本那份 → 守卫表现成
    // "数据不存在"（实测：p119 单跑过、在套件里红；p52 报 403 NOT_IN_CLASSROOM）。
    // 所以这里**硬设**（不是 ||=）：脚本自己的路径优先；MySQL 模式下这个键被忽略，无所谓。
process.env.PLATFORM_DB_PATH = dbPath;
// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import
const { aq, arow, arows } = await import('../packages/database/src/store.js');

const env = { ...process.env, PLATFORM_DATA_DIR: tempDir, PLATFORM_DB_PATH: dbPath };

const init = spawnSync(process.execPath, ['packages/database/src/db.js', '--init'], { cwd: root, env, encoding: 'utf8' });
if (init.status !== 0) throw new Error(`db init failed: ${init.stderr}`);
const seed = spawnSync(process.execPath, ['packages/database/src/seed.js'], { cwd: root, env, encoding: 'utf8' });
if (seed.status !== 0) throw new Error(`db seed failed: ${seed.stderr}`);

 
const seedLogins = ['root', 'org-admin', 'teacher-1', 'teacher-2', 'student-1', 'student-2'];
const seedOrgNames = ['示例创新学校'];

const tables = (await arows(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).map((x) => x.name);
const counts = {};
for (const table of tables) {
  counts[table] = Number((await arow(`SELECT COUNT(*) AS n FROM "${table}"`)).n);
}

const users = await arows(`SELECT id, login, display_name, role, org_id, status, deleted_at FROM users ORDER BY login`);
const orgs = await arows(`SELECT id, name, status FROM organizations ORDER BY name`);
const seedUsers = users.filter((u) => seedLogins.includes(u.login));
const realUsers = users.filter((u) => !seedLogins.includes(u.login));
const seedOrgIds = orgs.filter((o) => seedOrgNames.includes(o.name)).map((o) => o.id);
const seedUserIds = seedUsers.map((u) => u.id);

const inList = (values) => `(${values.map((x) => `'${String(x).replaceAll(`'`, `''`)}'`).join(',') || 'NULL'})`;
const scopedQueries = [
  ['sessions', `SELECT COUNT(*) n FROM sessions WHERE user_id IN ${inList(seedUserIds)}`],
  ['student_enrollments', `SELECT COUNT(*) n FROM student_enrollments WHERE student_id IN ${inList(seedUserIds)}`],
  ['student_projects', `SELECT COUNT(*) n FROM student_projects WHERE student_id IN ${inList(seedUserIds)}`],
  ['project_snapshots', `SELECT COUNT(*) n FROM project_snapshots WHERE project_id IN (SELECT id FROM student_projects WHERE student_id IN ${inList(seedUserIds)})`],
  ['works', `SELECT COUNT(*) n FROM works WHERE student_id IN ${inList(seedUserIds)}`],
  ['work_submissions', `SELECT COUNT(*) n FROM work_submissions WHERE student_id IN ${inList(seedUserIds)}`],
  ['usage_records', `SELECT COUNT(*) n FROM usage_records WHERE user_id IN ${inList(seedUserIds)}`],
  ['generation_jobs', `SELECT COUNT(*) n FROM generation_jobs WHERE user_id IN ${inList(seedUserIds)}`],
  ['media_assets', `SELECT COUNT(*) n FROM media_assets WHERE user_id IN ${inList(seedUserIds)}`],
  ['notifications_recipients_seed_user', `SELECT COUNT(*) n FROM notification_recipients WHERE user_id IN ${inList(seedUserIds)}`],
  ['account_requests_seed_user', `SELECT COUNT(*) n FROM account_requests WHERE user_id IN ${inList(seedUserIds)}`],
  ['legal_consents_seed_user', `SELECT COUNT(*) n FROM legal_consents WHERE user_id IN ${inList(seedUserIds)}`],
  ['org_scoped_credit_entries', `SELECT COUNT(*) n FROM credit_entries WHERE org_id IN ${inList(seedOrgIds)}`],
  ['org_scoped_billing_packages', `SELECT COUNT(*) n FROM billing_packages WHERE org_id IN ${inList(seedOrgIds)}`],
  ['org_scoped_classes', `SELECT COUNT(*) n FROM classes WHERE org_id IN ${inList(seedOrgIds)}`],
  ['org_scoped_class_members', `SELECT COUNT(*) n FROM class_members WHERE class_id IN (SELECT id FROM classes WHERE org_id IN ${inList(seedOrgIds)})`],
  ['org_scoped_works', `SELECT COUNT(*) n FROM works WHERE org_id IN ${inList(seedOrgIds)}`],
];
const scoped = {};
for (const [key, sql] of scopedQueries) scoped[key] = Number((await arow(sql)).n);

const foreignKeys = {};
for (const table of tables) {
  const cols = await arows(`PRAGMA table_info("${table}")`);
  const userRefs = cols.filter((c) => /^(user_id|student_id|teacher_id|actor_id|assigned_by|requested_by|processed_by|owner_user_id|created_by|updated_by|published_by|changed_by)$/.test(c.name)).map((c) => c.name);
  const orgRefs = cols.filter((c) => /^org_id$/.test(c.name)).map((c) => c.name);
  const rules = [...userRefs.map(async (name) => ({ column: name, seedMatches: Number((await arow(`SELECT COUNT(*) n FROM "${table}" WHERE "${name}" IN ${inList(seedUserIds)}`)).n) })), ...orgRefs.map(async (name) => ({ column: name, seedMatches: Number((await arow(`SELECT COUNT(*) n FROM "${table}" WHERE "${name}" IN ${inList(seedOrgIds)}`)).n) }))];
  if (rules.length) foreignKeys[table] = rules;
}

const report = {
  generatedAt: new Date().toISOString(),
  scope: 'temporary seeded SQLite only; production database was not opened',
  tempDirectory: tempDir,
  databasePath: dbPath,
  seedAnchors: {
    logins: seedLogins,
    organizationNames: seedOrgNames,
    className: '三年级AI创作一班',
    courseSeriesTitle: 'AI创作启蒙课',
  },
  users: {
    total: users.length,
    seed: seedUsers.map((u) => ({ login: u.login, role: u.role, status: u.status, orgName: orgs.find((o) => o.id === u.org_id)?.name ?? null })),
    nonSeed: realUsers.map((u) => ({ login: u.login, role: u.role, status: u.status })),
  },
  organizations: orgs.map((o) => ({ name: o.name, status: o.status, isSeed: seedOrgIds.includes(o.id) })),
  tableCounts: counts,
  seedScopedCounts: scoped,
  seedReferenceMatches: foreignKeys,
};

console.log(JSON.stringify(report, null, 2));
// 生产执行前的状态核对由 --verify-production 模式完成；本地脚本仅验证临时 seed 结构。
if (report.users.seed.length !== 6) throw new Error('expected 6 seed users');
if (seedOrgIds.length !== 1) throw new Error('expected 1 seed organization');
// 临时目录保留用于复验；由统一 .tmp 清理流程处理。
