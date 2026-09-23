// MySQL 验收夹具（RDS 阶段 2）：把一个临时 SQLite 库的结构搬成 MySQL 结构，用来跑验收套件
//
// 思路（**不新建一套建表脚本**，避免与代码走偏）：
//   ① 用应用自己的 CLI 造一个临时 SQLite 库（db.js --init + seed.js）——它就是"代码认为的结构"
//   ② 用阶段 0 那个工具（deploy/production/migrate/12-sqlite-to-mysql-ddl.mjs）把它翻成 MySQL DDL
//   ③ 把它灌进目标 MySQL 库；之后每个脚本跑之前只需"重灌一次"（表少、几秒）
//
// 为什么不用阶段 0 那份针对**线上库**生成的 DDL：线上库有历史迁移留下的表（89 张 vs 本地 76 张），
// 本地验证要的是"与当前代码一致的结构"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

export function mysqlEnvFromProcess() {
  return {
    DB_DRIVER: 'mysql',
    MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
    MYSQL_PORT: process.env.MYSQL_PORT || '13306',
    MYSQL_USER: process.env.MYSQL_USER || 'root',
    MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || '',
    MYSQL_DATABASE: process.env.MYSQL_DATABASE || 'aild_admin',
    // 测试用短空闲超时：脚本干完活要能自己退出（详见 mysql.js 里 idleTimeout 的注释）
    MYSQL_IDLE_TIMEOUT: process.env.MYSQL_IDLE_TIMEOUT || '1500',
  };
}

/** ① 造临时 SQLite 库（用应用自己的 CLI）→ 返回 db 路径 */
function buildSqliteFixture(tag = 'mysql-fixture') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  const dbPath = path.join(tmp, 'platform.db');
  const env = { ...process.env, PLATFORM_DATA_DIR: tmp, PLATFORM_DB_PATH: dbPath, DEPLOYMENT_MODE: 'internal-test' };
  for (const args of [['packages/database/src/db.js', '--init'], ['packages/database/src/seed.js']]) {
    const res = spawnSync(NODE, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
    if (res.status !== 0) throw new Error(`造 SQLite 夹具失败：${args[0]} → ${res.stderr?.slice(-400)}`);
  }
  return { tmp, dbPath };
}

/** ② 生成 MySQL DDL 文本 */
export function generateMysqlDdl(outFile = '') {
  const { tmp, dbPath } = buildSqliteFixture();
  const out = outFile || path.join(tmp, 'schema.mysql.sql');
  const res = spawnSync(NODE, ['deploy/production/migrate/12-sqlite-to-mysql-ddl.mjs', '--db', dbPath, '--out', out], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
  });
  if (res.status !== 0) throw new Error(`生成 MySQL DDL 失败：${res.stderr?.slice(-400)}`);
  return { sql: fs.readFileSync(out, 'utf8'), tmp };
}

/** ③ 把 DDL 灌进目标库（先 drop database 再建，保证干净） */
// mysql2 从**本仓自己的安装位置**加载：scripts/ 目录下 `import 'mysql2/promise'` 解析不到
// （pnpm 只把依赖链进 packages/database/node_modules），所以按路径 import。
async function loadMysql2() {
  const entry = path.join(ROOT, 'packages/database/node_modules/mysql2/promise.js');
  return (await import(pathToFileURL(entry).href)).default;
}

export async function resetMysqlDatabase({ silent = false } = {}) {
  const env = mysqlEnvFromProcess();
  const { sql, tmp } = generateMysqlDdl();
  const mysql = await loadMysql2();
  const conn = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    multipleStatements: true,       // 整份 DDL 一次执行（里面自带 SET FOREIGN_KEY_CHECKS）
    charset: 'utf8mb4_general_ci',
    dateStrings: true,
    decimalNumbers: true,
  });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${env.MYSQL_DATABASE}\``);
    await conn.query(`CREATE DATABASE \`${env.MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    await conn.query(`USE \`${env.MYSQL_DATABASE}\``);
    await conn.query(sql);
  } finally {
    await conn.end();
  }
  if (!silent) process.stdout.write('  [mysql] 库已重置（结构由代码现生成）\n');
  // 再把"由 schema.js 导入期写入的默认行"搬进来（平台模态开关、告警阈值…）——缺了它们，
  // 表现是"AI 能力全被平台关掉"（isModalityEnabled 读到空表 → 一律拦）。
  await copyBootstrapRows(path.join(tmp, 'platform.db'), env, silent);
}

/**
 * 把"由 schema.js 导入期写入的默认行"从 SQLite 夹具搬到 MySQL。
 *
 * 为什么要这一步：schema.js 在 import 时不仅建表，还会**插默认行**（平台模态开关、告警阈值、
 * platform_settings…）。生产 RDS 在阶段 0 已经从 SQLite 整库复制过去了，所以线上不缺；
 * 但**新建的 MySQL 库**缺这些行 —— 表现是"AI 能力全被平台关掉了"（isModalityEnabled 拿到空表 → 拦）。
 * 做法是**从刚建好的 SQLite 库里把这几张表原样读出来搬家**，而不是再抄一遍 SQL（抄一遍就会走偏）。
 */
const BOOTSTRAP_TABLES = ['platform_settings', 'platform_modality_settings', 'platform_alert_thresholds'];

async function copyBootstrapRows(sqliteDbPath, env, silent = false) {
  const { DatabaseSync } = await import('node:sqlite');
  const sqlite = new DatabaseSync(sqliteDbPath, { readOnly: true });
  const mysql = await loadMysql2();
  const conn = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, charset: 'utf8mb4_general_ci', dateStrings: true, decimalNumbers: true,
  });
  try {
    for (const table of BOOTSTRAP_TABLES) {
      let rows = [];
      try { rows = sqlite.prepare(`SELECT * FROM ${table}`).all(); } catch { continue; }   // 该库没有这张表就跳过
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => '?').join(',');
      await conn.query(`DELETE FROM \`${table}\``);
      for (const row of rows) {
        await conn.query(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${placeholders})`, cols.map((c) => row[c]));
      }
      if (!silent) process.stdout.write(`  [mysql] 默认行已搬：${table}（${rows.length} 行）
`);
    }
  } finally {
    sqlite.close();
    await conn.end();
  }
}

/** 重置 + 灌种子（很多脚本假定有基础数据） */
export async function resetAndSeed() {
  await resetMysqlDatabase({ silent: true });
  const env = mysqlEnvFromProcess();
  const res = spawnSync(NODE, ['packages/database/src/seed.js'], {
    cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000,
  });
  if (res.status !== 0) throw new Error(`MySQL 种子失败（status=${res.status}）：${(res.stderr || res.stdout || res.error?.message || "").slice(-600)}`);
}

if (process.argv.includes('--reset')) {
  const seedToo = process.argv.includes('--seed');
  await (seedToo ? resetAndSeed() : resetMysqlDatabase());
  const env = mysqlEnvFromProcess();
  console.log(`✔ MySQL 测试库已就绪：${env.MYSQL_HOST}:${env.MYSQL_PORT}/${env.MYSQL_DATABASE}${seedToo ? '（含种子）' : ''}`);
}
