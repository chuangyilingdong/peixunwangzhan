#!/usr/bin/env node
/**
 * 12 · 把**线上 SQLite 库的真实建表语句**翻成 MySQL 8 的 DDL（阶段 0 的第一步）
 *
 * 为什么不从代码里的 schema.js 翻：那份是"应该是什么样"，而**线上库才是"实际是什么样"**
 *   （89 张表 / 162 个索引，比代码里的 87/128 多 —— 迁移过程会留下痕迹）。
 *   以线上库为准，才能保证搬过去的数据有地方放。
 *
 * 三条必须做对的事：
 *   ① 类型映射（SQLite 只有 text/integer/real 三种，实测 1003/161/3）：
 *        integer → BIGINT（SQLite 的 INTEGER 本来就是 64 位）；real → DOUBLE
 *        text → **按真实数据长度决定**：
 *          · 被索引/是主键 → VARCHAR(255)（MySQL 的索引长度限制）
 *          · 其余 → 数据装得下就用按长度取的 VARCHAR(n)（**能保留 DEFAULT**），装不下才 MEDIUMTEXT
 *        ⚠️ 第一版我按"有没有默认值"拍脑袋定，结果 `metadata`（JSON 远超 255 字符）与
 *          `canvas_snapshot`（实测最长 4122 字符）都被判成 VARCHAR(255) —— **会静默截断数据**。
 *          改成量真实长度之后才安全。
 *   ② 标识符全部加反引号（列名里有 status/type/role 这类常用词）
 *   ③ **报告 MySQL 装不下的东西** —— 主要是"部分索引"（`CREATE INDEX … WHERE …`，实测 20 个）。
 *      MySQL 没有部分索引，而这些**大多不是性能索引、是业务约束**（例如
 *      `idx_class_members_unique WHERE removed_at IS NULL` = 同一个学生在未移除的前提下只能有一条）。
 *      必须明确列出来让人决定，**不能悄悄丢掉**。
 *
 * 用法：
 *   node deploy/production/migrate/12-sqlite-to-mysql-ddl.mjs --db <platform.db> [--out schema.mysql.sql]
 *
 * ⚠️ 只读 SQLite、**不连** MySQL —— 生成出来先看报告，确认无误再灌。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
};
const dbPath = arg('--db', '/srv/ai-kids-platform/production/data/platform.db');
const outPath = arg('--out', '');

const db = new DatabaseSync(dbPath, { readOnly: true });
const q = (sql) => db.prepare(sql).all();
const esc = (s) => String(s).replaceAll("'", "''");

/** 顶层逗号切分（跟踪括号，否则 CHECK(a IN ('x','y')) 会被切坏） */
function splitTopLevel(body) {
  const parts = []; let depth = 0; let cur = ''; let quote = null;
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
const bt = (n) => `\`${String(n).replaceAll('`', '``')}\``;
const unq = (n) => String(n).replace(/^["'`]|["'`]$/g, '').trim();

const tables = q(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
const indexes = q(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name`);

// ── 第一遍：读所有表的列 ──
const meta = [];
for (const t of tables) {
  const cols = q(`SELECT * FROM pragma_table_info('${esc(t.name)}')`);
  meta.push({
    table: t.name,
    cols,
    body: splitTopLevel(String(t.sql).replace(/^CREATE TABLE[^(]*\(/i, '').replace(/\)\s*$/, '')),
  });
}

// 哪些列被索引/是主键
const indexedCols = new Map();
const addIndexed = (t, c) => { if (!indexedCols.has(t)) indexedCols.set(t, new Set()); indexedCols.get(t).add(c); };
for (const m of meta) for (const c of m.cols) if (Number(c.pk) > 0) addIndexed(m.table, c.name);
const partialIndexes = [];
for (const ix of indexes) {
  const sql = String(ix.sql || '');
  if (/\bWHERE\b/i.test(sql)) { partialIndexes.push(ix); continue; }
  const mm = sql.match(/\((.*)\)/s);
  if (mm) for (const raw of mm[1].split(',')) {
    const col = raw.trim().split(/\s+/)[0].replace(/["'`]/g, '');
    if (col && !col.includes('(')) addIndexed(ix.tbl_name, col);
  }
}

// ── 第二遍：量每个 text 列的真实最大长度（类型选择的唯一依据） ──
const maxLen = new Map();
for (const m of meta) {
  for (const c of m.cols) {
    if (c.type && !/TEXT/i.test(String(c.type))) continue;
    try {
      const r = db.prepare(`SELECT MAX(LENGTH(${bt(c.name)})) AS n FROM ${bt(m.table)}`).get();
      maxLen.set(`${m.table}.${c.name}`, Number(r?.n || 0));
    } catch { maxLen.set(`${m.table}.${c.name}`, 0); }
  }
}

const notes = [];
const out = [];
out.push('-- 由 deploy/production/migrate/12-sqlite-to-mysql-ddl.mjs 从**线上 SQLite 库**生成');
out.push('-- 类型选择基于各列的真实数据长度；灌库前请先看 stderr 上的报告');
out.push('SET NAMES utf8mb4;');
out.push('SET FOREIGN_KEY_CHECKS=0;   -- 灌数据期间关掉（避免表顺序问题），灌完再打开');
out.push('');

const stats = {};
let colCount = 0;

for (const m of meta) {
  const lines = [];
  for (const c of m.cols) {
    colCount += 1;
    const indexed = (indexedCols.get(m.table) || new Set()).has(c.name);
    const hasDefault = c.dflt_value !== null && c.dflt_value !== undefined;
    const len = maxLen.get(`${m.table}.${c.name}`) ?? 0;
    const isText = !c.type || /TEXT/i.test(String(c.type));

    let mysqlType;
    if (!isText) {
      const t = String(c.type || '').toUpperCase();
      mysqlType = t.startsWith('INT') ? 'BIGINT'
        : (t.startsWith('REAL') || t.startsWith('DOUB') || t.startsWith('FLOA')) ? 'DOUBLE'
          : t.startsWith('BLOB') ? 'LONGBLOB' : 'BIGINT';
    } else if (indexed) {
      mysqlType = 'VARCHAR(255)';
      if (len > 255) notes.push(`⚠️ ${m.table}.${c.name} 是索引列但真实数据最长 ${len} 字符 > 255 —— **必须人工决定**（前缀索引？换做法？）`);
    } else {
      // 按真实长度挑：装得下就用 VARCHAR（能保留 DEFAULT），装不下才 MEDIUMTEXT。
      // ⚠️ 不要给这里加"上限截断"（我第一版 Math.min(16383,…) 就把 4 个列判成了 VARCHAR(16383)，
      //    而它们真实有 7 万～15 万字符 —— 会静默截断）。宁可 MEDIUMTEXT。
      const size = len === 0 ? 255 : Math.max(255, Math.ceil((len * 1.2) / 64) * 64);
      mysqlType = size <= 16383 ? `VARCHAR(${size})` : 'MEDIUMTEXT';
    }
    // MySQL 不允许 TEXT/MEDIUMTEXT 有默认值 —— 真要用大类型时，默认值只能丢
    const dropDefault = mysqlType === 'MEDIUMTEXT' && hasDefault;
    if (dropDefault) notes.push(`⚠️ ${m.table}.${c.name}：数据最长 ${len} 字符，只能用 MEDIUMTEXT，**默认值被丢掉** —— 确认插入时都会显式给值`);
    stats[mysqlType] = (stats[mysqlType] || 0) + 1;

    const raw = m.body.find((p) => unq(p.split(/\s+/)[0]) === c.name) || '';
    let rest = raw ? raw.slice(raw.indexOf(c.name) + c.name.length).trim().replace(/^[A-Za-z]+(\s*\([^)]*\))?/i, '').trim() : '';
    if (Number(c.notnull) === 1 && !/\bNOT\s+NULL\b/i.test(rest)) rest = `NOT NULL ${rest}`.trim();
    if (dropDefault) rest = rest.replace(/\s*DEFAULT\s+('(?:[^']|'')*'|\S+)/i, '').replace(/\s+/g, ' ').trim();
    lines.push(`  ${bt(c.name)} ${mysqlType}${rest ? ` ${rest}` : ''}`.replace(/\s+$/, ''));
    if (!raw) notes.push(`⚠️ ${m.table}.${c.name} 在原始 DDL 里没找到对应片段（约束可能没搬全）`);
  }
  for (const p of m.body) {
    const head = p.split(/\s+/)[0].toUpperCase();
    if (['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT'].includes(head)) {
      lines.push(`  ${p.replace(/"([^"]+)"/g, (_x, n) => bt(n))}`);
    }
  }
  out.push(`CREATE TABLE IF NOT EXISTS ${bt(m.table)} (`);
  out.push(lines.join(',\n'));
  out.push(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;');
  out.push('');
}

for (const ix of indexes) {
  if (/\bWHERE\b/i.test(String(ix.sql))) continue;
  out.push(`${String(ix.sql)
    .replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+["`]?([^"`\s]+)["`]?\s+ON\s+["`]?([^"`\s(]+)["`]?\s*/i,
      (_x, uniq, name, tbl) => `CREATE ${uniq ? 'UNIQUE ' : ''}INDEX ${bt(name)} ON ${bt(tbl)} `)
    .replace(/"([^"]+)"/g, (_x, n) => bt(n))};`);
}
out.push('');
out.push('SET FOREIGN_KEY_CHECKS=1;');

const ddl = out.join('\n');
if (outPath) fs.writeFileSync(outPath, ddl, 'utf8'); else process.stdout.write(ddl);

const rep = [];
rep.push(`表 ${tables.length} 张，列 ${colCount} 列，索引 ${indexes.length} 个（其中部分索引 ${partialIndexes.length} 个）`);
rep.push(`类型分布：${Object.entries(stats).sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);
const big = [...maxLen.entries()].filter(([, v]) => v > 16000).length;
rep.push(`数据长度 >16000 字符的列：${big} 个`);
if (partialIndexes.length) {
  rep.push('');
  rep.push(`⚠️ **${partialIndexes.length} 个"部分索引"（带 WHERE）MySQL 装不下** —— 必须人工决定，不能悄悄丢：`);
  for (const ix of partialIndexes) {
    const w = String(ix.sql).match(/WHERE\s+(.*)$/is);
    rep.push(`   · ${ix.tbl_name}.${ix.name}   WHERE ${String(w ? w[1] : '').trim().slice(0, 90)}`);
  }
}
if (notes.length) { rep.push(''); rep.push(`⚠️ ${notes.length} 处需要复核：`); for (const n of notes.slice(0, 30)) rep.push(`   · ${n}`); }
console.error(rep.join('\n'));
if (outPath) console.error(`\nDDL 已写到 ${outPath}（${ddl.split('\n').length} 行）`);
