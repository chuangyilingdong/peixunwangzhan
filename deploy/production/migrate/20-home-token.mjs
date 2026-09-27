#!/usr/bin/env node
/**
 * 20 · 学生个人主页 token：给 `users` 加列 + 给存量学生回填（幂等）
 *
 * 为什么需要这个（2026-09-27 用户口径「学生创建了账号应该就有个主页的专属链接」）：
 *   · 建号路径（机构端 `POST /api/org/users` → `createMember`）现在当场生成 token；
 *   · 但**存量学生**（导入的、更早建的）不会经过那条路 —— `home_token` 是 NULL。
 *     应用侧有 `ensureHomeToken`（见到就补）兜底，但那是"访问过才生成"，
 *     链接会来回变。所以要在生产上**一次性回填**，让每个人的主页链接**立刻稳定**。
 *
 * ⚠️ 两件必须人工的事（本脚本就是干这个的，别再手抄 SQL）：
 *   ① 生产 RDS **不会自动长出这一列** —— schema.js 只影响本机与新建的库（固定动作 4）；
 *   ② 新增索引要进 `13-partial-indexes-mysql.sql` 吗？**不用**：那里放的是"没法直接用 SQL 表达的
 *      部分索引等价写法"，而这个索引在 schema.js 里就是**普通 UNIQUE**（不带 WHERE），
 *      两种引擎语义一致，12 号生成器能直接生成它。
 *
 * ⚠️ 列类型必须是 **VARCHAR(64)**，不能是 TEXT/MEDIUMTEXT：
 *    MySQL 的 TEXT 列做不了索引键（`BLOB/TEXT column used in key specification without a key length`）。
 *    `ust_` + 24 个十六进制 = 28 字符，VARCHAR(64) 富余得很。
 *    （`home_token` 在 SQLite 侧写的是 TEXT，那是 SQLite 的习惯写法；MySQL 侧由 12 号生成器按
 *     "被索引的列 → VARCHAR" 处理，所以本地/新建库本来就是 VARCHAR，这里对齐它。）
 *
 * 用法（服务器上；凭据走 ~/.my.cnf，**不上命令行**）：
 *   node deploy/production/migrate/20-home-token.mjs                 # 试运行，只打印要做什么
 *   node deploy/production/migrate/20-home-token.mjs --apply         # 真的执行
 * 本机对着 Docker 测试库试：
 *   node deploy/production/migrate/20-home-token.mjs --defaults-file=/tmp/test.cnf --database=aild_admin
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ⚠️ 两种写法都认：`--name value` 与 `--name=value`。
//    （只认前者的话，照着帮助里写的 `--defaults-file=/root/.my.cnf` 敲就会被当成"没给参数"。）
const arg = (name, fallback = '') => {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || fallback;
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
};
const apply = process.argv.includes('--apply');
const defaultsFile = arg('--defaults-file', process.env.MYSQL_DEFAULTS_FILE || '/root/.my.cnf');
const database = arg('--database', process.env.RDS_DATABASE || 'aild_admin');
if (!fs.existsSync(defaultsFile)) {
  console.error(`凭据文件不存在：${defaultsFile}（用 --defaults-file 指定；口令不许上命令行）`);
  process.exit(2);
}
const CONN = [`--defaults-file=${defaultsFile}`, '-D', database];

function query(sql) {
  return execFileSync('mysql', [...CONN, '-N', '-B', '-e', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function runSqlFile(file) {
  execFileSync('mysql', CONN, { input: fs.readFileSync(file), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const newToken = () => `ust_${randomUUID().replaceAll('-', '').slice(0, 24)}`;

console.log(`目标库：${database}（凭据 ${defaultsFile}）${apply ? '' : ' · 试运行（加 --apply 才真写）'}`);

// ── ① 列 ────────────────────────────────────────────────────────────────
// 个人主页这个功能要的两列（都是**加列**，不动已有数据）：
//   · home_token：主页 token，**要建唯一索引** → 类型必须能当索引键 → VARCHAR(64)。
//   · avatar_asset_id：学生自己上传的头像图（file_assets 的 id）。**不索引** ——
//     所以类型跟 12 号生成器的规则走（非索引 TEXT → MEDIUMTEXT），与 production 里
//     `billing_package_id` / `student_usage_scope` 那两个同类列保持一致（否则结构对齐会对不上）。
// ⚠️ 两列都必须**先于发版**加上：新代码的建号 INSERT 与 normalizeUser 会读它们。
const REQUIRED_COLUMNS = [
  { name: 'home_token', ddl: 'VARCHAR(64) NULL', why: '主页 token（建唯一索引，所以是 VARCHAR）' },
  { name: 'avatar_asset_id', ddl: 'MEDIUMTEXT NULL', why: '上传的头像图（不索引，跟随生成器规则的 MEDIUMTEXT）' },
];
let columnsReady = true;
for (const column of REQUIRED_COLUMNS) {
  const existing = query(`SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='${column.name}'`).trim();
  if (existing) {
    console.log(`① 列已存在：${existing}`);
    continue;
  }
  columnsReady = false;
  if (!apply) {
    console.log(`① 要加列：users.${column.name} ${column.ddl}（${column.why}）`);
    continue;
  }
  query(`ALTER TABLE users ADD COLUMN ${column.name} ${column.ddl}`);
  console.log(`① 已加列：users.${column.name} ${column.ddl}`);
}
// 试运行时上面只是"说要做什么"，后面几步依赖列真的存在 —— 用一个总闸判断
const columnReady = columnsReady || apply;

// ── ② 唯一索引 ──────────────────────────────────────────────────────────
const index = query("SELECT INDEX_NAME, NON_UNIQUE FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='users' AND index_name='idx_users_home_token'").trim();
if (index) {
  console.log(`② 索引已存在：${index}`);
} else if (!apply) {
  console.log('② 要建索引：UNIQUE idx_users_home_token(users.home_token)');
} else {
  query('CREATE UNIQUE INDEX idx_users_home_token ON users(home_token)');
  console.log('② 已建索引：UNIQUE idx_users_home_token(users.home_token)');
}

// ── ③ 回填存量学生 ──────────────────────────────────────────────────────
// ⚠️ 只回填**学生**：公开主页只认 role='STUDENT'（教师/管理员不该有对外主页），
//    给他们发 token 只会得到一个打不开的链接。
// ⚠️ 试运行时列还不存在（①② 只是"说要做什么"），这时**不能**去查它 —— 会撞
//    `Unknown column 'home_token'`（2026-09-27 试运行实测踩到）。所以下面两步都以 columnReady 为闸。
if (!columnReady) {
  console.log('③ 试运行：列还没有，这一步等真跑时执行（先加列 → 建索引 → 回填）；④ 同理');
} else {
  const pending = query("SELECT id FROM users WHERE role='STUDENT' AND home_token IS NULL AND deleted_at IS NULL ORDER BY created_at").split('\n').map((line) => line.trim()).filter(Boolean);
  const totals = query("SELECT COUNT(*) AS all_students, SUM(CASE WHEN home_token IS NOT NULL THEN 1 ELSE 0 END) AS with_token FROM users WHERE role='STUDENT' AND deleted_at IS NULL").split('\t');
  console.log(`③ 待回填的学生：${pending.length} 个（在读学生共 ${totals[0] ?? '?'}，其中已有 token ${totals[1] ?? '0'} 个）`);

  if (pending.length && apply) {
    // 每个 token 都先确认没被占用（撞了就重摇）；真撞了唯一索引也会拦下来。
    const lines = [];
    const used = new Set(query('SELECT home_token FROM users WHERE home_token IS NOT NULL').split('\n').map((line) => line.trim()).filter(Boolean));
    for (const id of pending) {
      let token = newToken();
      while (used.has(token)) token = newToken();
      used.add(token);
      lines.push(`UPDATE users SET home_token='${token}' WHERE id='${String(id).replaceAll("'", "''")}' AND home_token IS NULL;`);
    }
    const file = path.join(os.tmpdir(), `home-token-backfill-${Date.now()}.sql`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    try {
      runSqlFile(file);
      console.log(`③ 已回填 ${lines.length} 个学生的主页 token`);
    } finally {
      fs.rmSync(file, { force: true });
    }
  } else if (pending.length) {
    console.log(`③ 试运行：会回填 ${pending.length} 个学生的 token（内容每次随机，这里不打印）`);
  }

  // ── ④ 验后检查 ────────────────────────────────────────────────────────
  const after = query("SELECT COUNT(*) AS all_students, SUM(CASE WHEN home_token IS NOT NULL THEN 1 ELSE 0 END) AS with_token, COUNT(DISTINCT home_token) AS distinct_tokens FROM users WHERE role='STUDENT' AND deleted_at IS NULL").split('\t');
  const [all, withToken, distinct] = after.map((value) => Number(value || 0));
  console.log(`④ 验后：在读学生 ${all} · 有 token ${withToken} · 去重后 ${distinct}`);
  const ok = withToken === all && distinct === withToken;
  console.log(ok ? '✅ 每个在读学生都有且只有一个主页 token' : `⚠️ 对不上（${withToken}/${all}，去重 ${distinct}）`);
  process.exit(ok ? 0 : 1);
}
