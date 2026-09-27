#!/usr/bin/env node
/**
 * 生产备份：整库 + release 树 + 配置 + 监控日志快照。
 *
 * ⚠️ 2026-09-27 修（交接文档 §〇「已知待办」第一条）：这个脚本**原来只认 SQLite**，
 *    所以切库到 RDS 之后，它每晚都在"成功地"备份那份**切库时就冻结了的** `platform.db` ——
 *    备份目录一天天涨、`state/last-backup-state.json` 一天天写 `ok`，
 *    而**切库后写进 RDS 的数据一份备份都没有**。SHA256 与 integrity_check 全绿，
 *    因为那确实是一份完好但过期的 SQLite：**绿灯骗人**。
 *
 * 现在它认驱动：
 *   · `sqlite` → 老路：`VACUUM INTO` 出一份 `platform.db`；
 *   · `mysql`  → `mysqldump --single-transaction` 出一份 `database.sql.gz`，
 *                再把「转储里的 `CREATE TABLE` 条数」与线上 `information_schema` **对账**
 *                （只看 mysqldump 的退出码不够 —— 磁盘写满这类截断也能退 0）。
 *
 * 驱动从哪来（优先级）：`--driver` > `DB_DRIVER` 环境变量 > 读 `--production-env` 指向的文件
 *   （默认 `/etc/ai-kids-platform/production.env`）。**三处都没有 → 直接报错，不默认**（见下面的注释）。
 *   ⚠️ 参数名是 `--production-env` 而不是 `--env-file`：后者是 **Node 自己的 CLI 标志**，
 *   写在脚本名后面会被 node 抢先吃掉、脚本根本起不来（2026-09-27 实测踩到）。
 *   ⚠️ ⭐ 为什么必须读那个 env 文件：定时器
 *   `ai-kids-platform-production-daily-backup.service` **没有 `EnvironmentFile`** ——
 *   到点跑起来的环境里**根本没有 `DB_DRIVER`**。只认环境变量的话，它还会静默退回 SQLite，
 *   老毛病原样重演（这正是这次为什么不靠"改一下 systemd"来修）。
 *
 * ⚠️ ⭐ 凭据一律不上命令行（会出现在 `ps` 里，本仓既有纪律，见 14-migrate-data-to-mysql.mjs 头注释）：
 *   优先 `--defaults-file`（默认 `/root/.my.cnf`，600），没有才退回 `MYSQL_*` / `RDS_*`
 *   环境变量 + **`MYSQL_PWD`**（同样是环境，不是 argv）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

// ⚠️ 两种写法都认：`--name value` 与 `--name=value`。
//    只认前者的话，报错里那句「请显式 --driver=sqlite」照着敲反而会被当成"没给参数"（2026-09-27 修）。
function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || fallback;
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}
// 流式算摘要：库会长（SQLite 那份已 23MB，MySQL 转储解压后几十 MB），别整个读进内存。
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1 << 20);
  const fd = fs.openSync(file, 'r');
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}
function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return false;
  fs.cpSync(source, destination, { recursive: true, dereference: true });
  return true;
}
function envFileValue(file, key) {
  try {
    const match = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=(.*)$`, 'm'));
    if (!match) return '';
    return match[1].trim().replace(/^["'](.*)["']$/, '$1');
  } catch {
    return '';
  }
}

const root = path.resolve(arg('--root', process.env.PRODUCTION_ROOT || '/srv/ai-kids-platform/production'));
const dbPath = path.resolve(arg('--db', process.env.PLATFORM_DB_PATH || path.join(root, 'data', 'platform.db')));
const outputRoot = path.resolve(arg('--output', process.env.PRODUCTION_BACKUP_ROOT || path.join(root, 'backups')));
const envFile = arg('--production-env', process.env.PRODUCTION_ENV_FILE || '/etc/ai-kids-platform/production.env');

const declaredDriver = arg('--driver', '') || process.env.DB_DRIVER || envFileValue(envFile, 'DB_DRIVER');
if (!declaredDriver) {
  // ⚠️ ⭐ 这里**故意不默认成 sqlite**：默认的代价就是 2026-09-25 那次事故 ——
  //    切库到 RDS 之后它每晚"成功"备份那份冻结的旧 SQLite，还把 state 写成 ok（绿灯骗人）。
  //    万一哪天 production.env 读不到（权限/改名），默认值会让同一个静默故障原样重演。
  //    要备 SQLite 就显式给 --driver=sqlite —— 猜错一次不值得，报错一次很便宜。
  throw new Error(
    `解析不出 DB_DRIVER：--driver / 环境变量 / ${envFile} 三处都没有。`
    + '要备 SQLite 请显式 --driver=sqlite；生产上应当是 mysql。',
  );
}
const driver = String(declaredDriver).trim().toLowerCase();
if (!['sqlite', 'mysql'].includes(driver)) {
  throw new Error(`不支持的 DB_DRIVER：${driver}（只认 sqlite / mysql）`);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const backupDir = path.join(outputRoot, stamp);
fs.mkdirSync(backupDir, { recursive: true });

const current = path.join(root, 'current');
const currentTarget = fs.existsSync(current) ? fs.realpathSync(current) : null;
if (currentTarget) {
  const releaseBackup = path.join(backupDir, 'release');
  fs.rmSync(releaseBackup, { recursive: true, force: true });
  copyIfExists(currentTarget, releaseBackup);
  if (!fs.existsSync(path.join(releaseBackup, 'BUILD-METADATA.txt')) ||
      !fs.existsSync(path.join(releaseBackup, 'apps/server/src/index.js'))) {
    throw new Error(`Release backup incomplete for ${currentTarget}`);
  }
}
copyIfExists(path.join(root, 'config'), path.join(backupDir, 'config'));
// Only copy a bounded monitoring log snapshot. Copying the whole logs directory would recursively
// include backup logs when a custom output root is placed under logs, and historical logs are rotated.
const logBackup = path.join(backupDir, 'logs');
fs.mkdirSync(logBackup, { recursive: true });
for (const name of ['monitoring-health.log', 'monitoring-alerts.log']) {
  const source = path.join(root, 'logs', name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(logBackup, name));
}

const manifest = {
  createdAt: new Date().toISOString(),
  environment: 'production',
  root,
  driver,
  currentTarget,
  releaseMetadata: currentTarget && fs.existsSync(path.join(currentTarget, 'BUILD-METADATA.txt'))
    ? fs.readFileSync(path.join(currentTarget, 'BUILD-METADATA.txt'), 'utf8')
    : null,
};

/** 连库参数：优先 defaults-file（凭据不进 argv），否则退回环境变量。 */
function resolveMysql() {
  const explicit = arg('--defaults-file', process.env.MYSQL_DEFAULTS_FILE || '');
  if (explicit && !fs.existsSync(explicit)) {
    throw new Error(`--defaults-file 指向的文件不存在：${explicit}`);
  }
  const defaultsFile = explicit || (fs.existsSync('/root/.my.cnf') ? '/root/.my.cnf' : '');
  const pick = (...names) => {
    for (const name of names) {
      const fromFile = name.startsWith('@');
      const value = fromFile ? envFileValue(envFile, name.slice(1)) : process.env[name];
      if (value) return value;
    }
    return '';
  };
  const database = pick('MYSQL_DATABASE', 'RDS_DATABASE', '@RDS_DATABASE');
  if (!database) {
    throw new Error(`mysql 驱动下必须知道库名：设 MYSQL_DATABASE 或 RDS_DATABASE（也读 ${envFile}）`);
  }
  return {
    defaultsFile,
    database,
    host: pick('MYSQL_HOST', 'RDS_HOST', '@RDS_HOST'),
    port: pick('MYSQL_PORT', 'RDS_PORT', '@RDS_PORT'),
    user: pick('MYSQL_USER', 'RDS_USER', '@RDS_USER'),
    password: pick('MYSQL_PASSWORD', 'RDS_PASSWORD', '@RDS_PASSWORD'),
  };
}

/** 客户端参数：`--defaults-file` 必须是第一个（mysql 的规矩）。 */
function mysqlClientArgs(conn) {
  const args = [];
  if (conn.defaultsFile) {
    args.push(`--defaults-file=${conn.defaultsFile}`);
  } else {
    if (conn.host) args.push('-h', conn.host);
    if (conn.port) args.push('-P', String(conn.port));
    if (conn.user) args.push('-u', conn.user);
  }
  return args;
}
/** 交给客户端的密码：走环境变量，绝不进 argv。 */
function mysqlClientEnv(conn) {
  const env = { ...process.env };
  if (conn.defaultsFile) delete env.MYSQL_PWD;
  else if (conn.password) env.MYSQL_PWD = conn.password;
  return env;
}

async function dumpMysql(conn, target) {
  const args = [
    ...mysqlClientArgs(conn),
    // InnoDB 一致性快照、不锁表（生产上跑，这条是重点）
    '--single-transaction',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    // RDS 上 gtid_mode=ON：不关掉的话恢复时报 GTID 冲突
    '--set-gtid-purged=OFF',
    // RDS 账号没有 PROCESS 权限，不带这条 mysqldump 会去读表空间
    '--no-tablespaces',
    '--default-character-set=utf8mb4',
    conn.database,
  ];
  const child = spawn('mysqldump', args, { env: mysqlClientEnv(conn), stdio: ['ignore', 'pipe', 'pipe'] });
  // spawn 失败（没装客户端）不会走 'close'、只发 'error' —— 不接住就是一个 node 栈，运维看不懂。
  const spawnFailure = await new Promise((resolve) => {
    child.once('spawn', () => resolve(null));
    child.once('error', (error) => resolve(error));
  });
  if (spawnFailure) {
    throw new Error(`起不了 mysqldump：${spawnFailure.message} —— 先装 MySQL 客户端（Ubuntu: mysql-client）`);
  }
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  try {
    await pipeline(child.stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(target));
    const code = await exited;
    if (code !== 0) {
      throw new Error(`mysqldump 失败（退出码 ${code}）：${stderr.trim().slice(-800)}`);
    }
  } catch (error) {
    // ⚠️ 半份转储**不能留在备份目录里**：它会骗过"文件在不在"的检查。
    try { fs.rmSync(target, { force: true }); } catch { /* 尽力而为 */ }
    throw error;
  }
  if (stderr.trim()) console.error(`mysqldump 警告：${stderr.trim().slice(-800)}`);
}

/** 边解压边数：既对账，也顺带证明这份 gzip 是完整的（坏档会在这里抛）。 */
async function scanDump(file) {
  let tables = 0;
  let inserts = 0;
  let tail = '';
  const scanner = new Transform({
    transform(chunk, _encoding, done) {
      const lines = (tail + chunk.toString('utf8')).split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('CREATE TABLE')) tables += 1;
        else if (line.startsWith('INSERT INTO')) inserts += 1;
      }
      done();
    },
    flush(done) {
      if (tail.startsWith('CREATE TABLE')) tables += 1;
      else if (tail.startsWith('INSERT INTO')) inserts += 1;
      done();
    },
  });
  await pipeline(fs.createReadStream(file), zlib.createGunzip(), scanner);
  return { tables, inserts };
}

function mysqlScalar(conn, sql) {
  const result = spawnSync('mysql', [...mysqlClientArgs(conn), '-N', '-B', '-e', sql], {
    env: mysqlClientEnv(conn), encoding: 'utf8',
  });
  if (result.error) throw new Error(`调 mysql 客户端失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`mysql 查询失败：${String(result.stderr || '').trim().slice(-400)}`);
  return result.stdout.trim();
}

if (driver === 'sqlite') {
  if (dbPath.toLowerCase().includes(`${path.sep}packages${path.sep}data${path.sep}`)) {
    throw new Error(`Refusing to back up the repository default database: ${dbPath}`);
  }
  if (!fs.existsSync(dbPath)) throw new Error(`Database does not exist: ${dbPath}`);
  const backupDb = path.join(backupDir, 'platform.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const escaped = backupDb.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  db.close();
  manifest.database = dbPath;
  manifest.databaseFile = 'platform.db';
  manifest.databaseSha256 = sha256(backupDb);
  manifest.databaseBytes = fs.statSync(backupDb).size;
} else {
  const conn = resolveMysql();
  const dumpFile = path.join(backupDir, 'database.sql.gz');
  await dumpMysql(conn, dumpFile);
  const scanned = await scanDump(dumpFile);
  const inDatabase = Number(mysqlScalar(
    conn,
    `select count(*) from information_schema.tables where table_schema='${conn.database}' and table_type='BASE TABLE'`,
  ));
  if (!Number.isFinite(inDatabase)) throw new Error(`线上表数读不出来：${inDatabase}`);
  if (scanned.tables !== inDatabase) {
    throw new Error(
      `转储与线上对不上：转储里 ${scanned.tables} 张表，线上 ${inDatabase} 张 —— 这份转储是截断的，不能算备份`,
    );
  }
  if (!scanned.inserts) throw new Error('转储里一条 INSERT 都没有 —— 这份转储不能算备份');
  // 只记连接形状，**不记口令**
  manifest.database = `mysql://${conn.host || 'defaults-file'}:${conn.port || 'default'}/${conn.database}`;
  manifest.databaseFile = 'database.sql.gz';
  manifest.databaseSha256 = sha256(dumpFile);
  manifest.databaseBytes = fs.statSync(dumpFile).size;
  manifest.tableCount = { inDump: scanned.tables, inDatabase };
  manifest.tablesWithRows = scanned.inserts;
  manifest.restoreHint = 'zcat database.sql.gz | mysql <目标库>（换库名即可，转储里不带 CREATE DATABASE / USE）';
}

fs.writeFileSync(path.join(backupDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  backupDir,
  driver,
  database: manifest.database,
  databaseFile: manifest.databaseFile,
  currentTarget,
}, null, 2));
