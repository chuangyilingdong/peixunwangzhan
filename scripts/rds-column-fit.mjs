// 「生产数据装不装得进目标结构」检查 —— **切 RDS 之前必须跑一次**。
//
// 为什么需要它（2026-09-25 实测发现）：目标库（本机 test 库 / 生产 RDS）里那些 varchar 的宽度
// 是**按当时的真实数据长度**定的（见 12-sqlite-to-mysql-ddl.mjs 的注释 + scripts/rds-schema-align.json），
// 而生产数据还在长 —— 实测 `vibecoding_submissions.files` 在生产里最长 **81,470** 字符，
// 目标结构却是 varchar(7680)：12 行里 7 行装不下。切库搬数据（14 号脚本）会直接失败 /
// 或者在非严格模式下**静默截断**（后者更坏：库里悄悄少一截代码）。
//
// 用法：
//   # 拿本机 test 库当"目标结构"，拿仓库/指定的 SQLite 当"生产数据"
//   node scripts/rds-column-fit.mjs --sqlite=/srv/.../data/platform.db \
//     MYSQL_HOST=127.0.0.1 MYSQL_PORT=13306 MYSQL_USER=root MYSQL_PASSWORD=… MYSQL_DATABASE=aild_admin
//   # 直连真 RDS 就换 MYSQL_* 那套（RDS_* 也认）
//   # 只看某一批列：--only=vibecoding
//   # 宽松阈值：--ratio=0.8（默认只报"塞不下"的；给阈值会把"快满了"的一起报出来）
//
// 退出码：有"塞不下"的列 → 1（适合塞进切库前的检查清单）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : true;
};

const sqlitePath = String(arg('sqlite', process.env.PLATFORM_DB_PATH || path.join(ROOT, 'data/platform.db')));
const only = String(arg('only', '')).trim();
const ratio = Number(arg('ratio', 0)) || 0;
if (!fs.existsSync(sqlitePath)) {
  console.error(`找不到源库：${sqlitePath}（用 --sqlite=<路径> 指定生产 SQLite）`);
  process.exit(2);
}

const env = {
  host: process.env.MYSQL_HOST || process.env.RDS_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || process.env.RDS_PORT || 3306),
  user: process.env.MYSQL_USER || process.env.RDS_USER || 'root',
  password: process.env.MYSQL_PASSWORD || process.env.RDS_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || process.env.RDS_DATABASE || 'aild_admin',
};
const mysqlEntry = path.join(ROOT, 'packages/database/node_modules/mysql2/promise.js');
const mysql = (await import(pathToFileURL(mysqlEntry).href)).default;

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

const conn = await mysql.createConnection({ host: env.host, port: env.port, user: env.user, password: env.password, database: env.database });
const [columns] = await conn.query(
  'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS len'
  + ' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND CHARACTER_MAXIMUM_LENGTH IS NOT NULL'
  + ' ORDER BY TABLE_NAME, COLUMN_NAME', [env.database]);
await conn.end();

const byTable = new Map();
for (const col of columns) {
  if (only && !`${col.t}.${col.c}`.includes(only)) continue;
  if (!byTable.has(col.t)) byTable.set(col.t, []);
  byTable.get(col.t).push(col);
}

const overflow = [];
const nearly = [];
const missing = [];
for (const [table, cols] of byTable) {
  if (!tables.includes(table)) { missing.push(table); continue; }
  // 一次拿到这一张表所有列的"最长值"（用 SQLite 的 MAX(LENGTH(col)) 逐列算，行数多也没关系）
  for (const col of cols) {
    let row;
    try {
      row = sqlite.prepare(`SELECT COUNT(*) n, MAX(LENGTH("${col.c}")) maxLen, SUM(CASE WHEN LENGTH("${col.c}") > ? THEN 1 ELSE 0 END) over FROM "${table}"`).get(Number(col.len));
    } catch { continue; }   // 列在源库里不存在（结构已漂移）→ 跳过
    const maxLen = Number(row?.maxLen || 0);
    const over = Number(row?.over || 0);
    if (!maxLen) continue;
    const item = { table, column: col.c, type: `${col.type}(${col.len})`, size: Number(col.len), maxLen, rows: Number(row.n || 0), over };
    if (over > 0) overflow.push(item);
    else if (ratio > 0 && maxLen >= Number(col.len) * ratio) nearly.push(item);
  }
}
sqlite.close();

const fmt = (item) => `  ${item.table}.${item.column}  ${item.type}  源库最长 ${item.maxLen}（${item.over}/${item.rows} 行塞不下）`;
console.log(`源库：${sqlitePath}`);
console.log(`目标结构：${env.host}:${env.port}/${env.database}\n`);
if (overflow.length) {
  console.log(`❌ **塞不下**的列 ${overflow.length} 个（切库搬数据会失败/静默截断）：`);
  for (const item of overflow.sort((a, b) => b.over - a.over)) console.log(fmt(item));
} else {
  console.log('✅ 没有塞不下的列');
}
if (nearly.length) {
  console.log(`\n⚠️ 快满了（≥${Math.round(ratio * 100)}%）的列 ${nearly.length} 个：`);
  for (const item of nearly.sort((a, b) => b.maxLen / b.size - a.maxLen / a.size)) console.log(fmt(item));
}
if (missing.length) console.log(`\nℹ️ 目标结构里没有 ${missing.length} 张源库的表（可能是本地夹具表）：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' 等' : ''}`);
process.exit(overflow.length ? 1 : 0);
