#!/usr/bin/env node
/**
 * 列宽余量体检：**逐列比「最长值 vs 列宽」**，找出快撑爆的长文本列。
 *
 * 为什么要有它（2026-09-25 生产事故）：12 号生成器原来按"当时真实数据长度 × 1.2"给非索引 TEXT 列
 * 定 varchar —— 内容一长就 `ER_DATA_TOO_LONG` 500。那是**静默**长出来的：
 *   · 官网内容 CMS 保存不了（`website_contents.draft_content` varchar(1728)，草稿 1392 → 一编辑就炸）；
 *   · 全站一量才发现 80+ 列已用掉 70%+ 宽度（`media_assets.asset_url` 86.3%）。
 * 生成器已改成"非索引 TEXT 一律 MEDIUMTEXT"，但**存量库**要有人盯着 —— 就是这个脚本。
 *
 * 用法（在能连到目标库的机器上）：
 *   MYSQL_HOST=… MYSQL_PORT=… MYSQL_USER=… MYSQL_PASSWORD=… MYSQL_DATABASE=aild_admin \
 *     node scripts/rds-column-headroom.mjs            # 只报数（阈值 50%）
 *   … node scripts/rds-column-headroom.mjs --min=20   # 看更低的余量
 * 退出码：有列超过阈值 → 1（可以塞进巡检/切库清单）。
 * ⚠️ 只读：只跑 `SELECT MAX(CHAR_LENGTH(col))`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
};
const MIN_PCT = Number(arg('--min', process.env.HEADROOM_MIN_PCT || 50)) || 50;

const mysqlEnv = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'aild_admin',
};
// mysql2 只链在 packages/database 下（仓库约定），按路径 import
const mysql = (await import(pathToFileURL(path.join(ROOT, 'packages/database/node_modules/mysql2/promise.js')).href)).default;
const conn = await mysql.createConnection(mysqlEnv);

const [cols] = await conn.query(
  `SELECT table_name AS t, column_name AS c, character_maximum_length AS w
     FROM information_schema.COLUMNS
    WHERE table_schema=? AND data_type IN ('varchar','char') AND character_maximum_length >= 64
    ORDER BY table_name, column_name`, [mysqlEnv.database]);

const rows = [];
for (const col of cols) {
  const [r] = await conn.query(`SELECT COALESCE(MAX(CHAR_LENGTH(\`${col.c}\`)),0) AS mx FROM \`${mysqlEnv.database}\`.\`${col.t}\``);
  const mx = Number(r[0]?.mx || 0);
  const pct = col.w ? (mx / Number(col.w)) * 100 : 0;
  if (pct >= MIN_PCT) rows.push({ key: `${col.t}.${col.c}`, width: Number(col.w), mx, pct: Number(pct.toFixed(1)) });
}
await conn.end();

rows.sort((a, b) => b.pct - a.pct);
console.log(`列宽余量体检（阈值 ${MIN_PCT}%）：窄列 ${cols.length} 个，超阈值 ${rows.length} 个\n`);
for (const row of rows.slice(0, 40)) {
  console.log(`  ${String(row.pct).padStart(5)}%  ${String(row.mx).padStart(8)}/${row.width}  ${row.key}`);
}
if (rows.length) {
  console.log('\n⚠️ 这些列快撑爆了。修法：非索引列改 MEDIUMTEXT（表达式默认值能保住 DEFAULT）；');
  console.log('   索引/外键列不能改 TEXT（MySQL 要索引键长度），只能加宽 VARCHAR 或改设计。');
  console.log('   生成器见 deploy/production/migrate/12-sqlite-to-mysql-ddl.mjs（非索引 TEXT 已统一 MEDIUMTEXT）。');
}
process.exit(rows.length ? 1 : 0);
