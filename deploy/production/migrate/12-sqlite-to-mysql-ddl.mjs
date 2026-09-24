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
// 非索引文本列的**最窄** VARCHAR 宽度（默认 255 = 老行为）。
// ⚠️ 为什么需要它：尺寸是**按源库真实数据长度**定的，所以"种子数据小"的库会得到很窄的列 ——
//    验收夹具（scripts/）写进去的 JSON 比种子大得多，就会 Data too long for column
//    （实测：本机 Docker 里 platform_settings.ai_provider_policy 是 varchar(255)，
//     而**生产 RDS 同一列是 mediumtext** —— 因为生产是按真数据量的）。
//    测试环境用 --min-varchar=4000 就能与生产一样宽松；生产侧也建议给个下限（见交接 §九）。
const minVarchar = Math.max(255, Number(arg('--min-varchar', '255')) || 255);


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
/**
 * ⚠️ 线上 DDL 里有一处**漏了逗号**（generation_jobs 的 project_id 外键后面那个）：
 *    `… ON DELETE CASCADE\n  FOREIGN KEY (retry_of_job_id) …`
 *    SQLite 容忍这种写法（表一直在跑），MySQL 直接报语法错。
 *
 * 修法**不能**用全局正则补逗号 —— 我试过，它会把**列定义里的 CHECK** 也误伤
 * （`status TEXT NOT NULL DEFAULT 'X' CHECK (…)` 前面被插逗号，列定义就破了）。
 * 所以只在"这一部分**本身以表级约束关键字开头**"时才拆：按括号深度扫，顶层遇到下一个
 * 约束关键字就切一刀。列定义里的 CHECK 在括号里（depth>0）或压根不以关键字开头，都不会被动。
 */
const CONSTRAINT_RE = /^(?:FOREIGN\s+KEY|UNIQUE|CHECK|PRIMARY\s+KEY|CONSTRAINT)\b/i;
const NEXT_CONSTRAINT_RE = /^\s+(?=(?:FOREIGN\s+KEY|UNIQUE|CHECK|PRIMARY\s+KEY|CONSTRAINT)\b)/i;
function splitConstraintRuns(part) {
  const t = part.trim();
  if (!CONSTRAINT_RE.test(t)) return [t];
  // ⚠️ `CONSTRAINT <名字> CHECK (…)` **本身是一个整体**，里面的 CHECK 不是"下一个约束"。
  //    线上 course_series 就是这么写的（而且逗号在行首：`… CASCADE\n, CONSTRAINT chk_… CHECK (…)`），
  //    不排除这种情况就会把它拆成 `CONSTRAINT chk_difficulty` + `CHECK (…)` 两半 → MySQL 语法错。
  if (/^CONSTRAINT\b/i.test(t)) return [t];
  const out = []; let depth = 0; let cur = ''; let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && cur.trim()) {
      const hit = t.slice(i).match(NEXT_CONSTRAINT_RE);
      if (hit) { out.push(cur.trim()); cur = ''; i += hit[0].length; continue; }
    }
    cur += ch; i += 1;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const meta = [];
for (const t of tables) {
  const cols = q(`SELECT * FROM pragma_table_info('${esc(t.name)}')`);
  const body = splitTopLevel(String(t.sql).replace(/^CREATE TABLE[^(]*\(/i, '').replace(/\)\s*$/, ''))
    .flatMap(splitConstraintRuns);
  meta.push({ table: t.name, cols, body });
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

// MySQL 的单行固定宽度上限是 65535 字节（**不算** TEXT/BLOB）。
// utf8mb4 下每个 VARCHAR(n) 占 n×4 字节 —— 一张有 16 个宽 JSON 列的表很容易爆。
// 踩过：course_lessons(88308) / student_projects(71636) / vibecoding_submissions(66228) 三张表
// 直接建不出来（ERROR 1118 Row size too large）。所以**按表算总宽度**，超了就把非索引列降级。
const MAX_ROW_BYTES = 64000;
const MEDIUMTEXT_COST = 20; // TEXT 系在行里只占一个指针 + 长度

for (const m of meta) {
  // ── 第一趟：定初选类型、算固定宽度 ──
  const plans = m.cols.map((c) => {
    const indexed = (indexedCols.get(m.table) || new Set()).has(c.name);
    const hasDefault = c.dflt_value !== null && c.dflt_value !== undefined;
    const len = maxLen.get(`${m.table}.${c.name}`) ?? 0;
    const isText = !c.type || /TEXT/i.test(String(c.type));
    let mysqlType; let fixedWidth;
    if (!isText) {
      const t = String(c.type || '').toUpperCase();
      mysqlType = t.startsWith('INT') ? 'BIGINT'
        : (t.startsWith('REAL') || t.startsWith('DOUB') || t.startsWith('FLOA')) ? 'DOUBLE'
          : t.startsWith('BLOB') ? 'LONGBLOB' : 'BIGINT';
      fixedWidth = mysqlType === 'BIGINT' || mysqlType === 'DOUBLE' ? 8 : MEDIUMTEXT_COST;
    } else if (indexed) {
      // 索引列也**按真实数据长度**定尺寸（下限 64、上限 255）。
      // ⚠️ 不能一律 VARCHAR(255)：MySQL 的单条索引键上限是 3072 字节，utf8mb4 下
      //    4 列 × 255 字符 = 4080 字节 → `ERROR 1071 Specified key was too long`。
      //    id 这类列真实只有 25 字符左右，给 64 完全够，键长一下就下来了。
      const size = Math.min(255, Math.max(64, Math.ceil((len * 1.2) / 16) * 16));
      mysqlType = `VARCHAR(${size})`;
      fixedWidth = size * 4;
      if (len > 255) notes.push(`⚠️ ${m.table}.${c.name} 是索引列但真实数据最长 ${len} 字符 > 255 —— **必须人工决定**（前缀索引？换做法？）`);
    } else {
      const size = len === 0 ? minVarchar : Math.max(minVarchar, Math.ceil((len * 1.2) / 64) * 64);
      mysqlType = size <= 16383 ? `VARCHAR(${size})` : 'MEDIUMTEXT';
      fixedWidth = mysqlType === 'MEDIUMTEXT' ? MEDIUMTEXT_COST : size * 4;
    }
    return { c, indexed, hasDefault, len, mysqlType, fixedWidth, dropDefault: false };
  });

  // ── 降级：超行上限时，把**非索引**的 VARCHAR 从大到小改成 MEDIUMTEXT（默认值随之丢掉） ──
  let total = plans.reduce((s, p) => s + p.fixedWidth, 0);
  if (total > MAX_ROW_BYTES) {
    const cands = plans.filter((p) => !p.indexed && /^VARCHAR/.test(p.mysqlType)).sort((a, b) => b.fixedWidth - a.fixedWidth);
    for (const p of cands) {
      if (total <= MAX_ROW_BYTES) break;
      total -= p.fixedWidth - MEDIUMTEXT_COST;
      p.mysqlType = 'MEDIUMTEXT';
      p.fixedWidth = MEDIUMTEXT_COST;
      p.dropDefault = p.hasDefault;
      notes.push(`ℹ️ ${m.table}.${p.c.name} 因整行超 MySQL 上限被降级为 MEDIUMTEXT${p.hasDefault ? '（默认值随之丢掉）' : ''}`);
    }
  }
  if (total > MAX_ROW_BYTES) notes.push(`⚠️ ${m.table}：降级后整行仍有 ${total} 字节 > ${MAX_ROW_BYTES} —— **必须人工处理**`);

  const lines = [];
  for (const p of plans) {
    colCount += 1;
    const { c, mysqlType } = p;
    stats[mysqlType] = (stats[mysqlType] || 0) + 1;
    const raw = m.body.find((x) => unq(x.split(/\s+/)[0]) === c.name) || '';
    let rest = raw ? raw.slice(raw.indexOf(c.name) + c.name.length).trim().replace(/^[A-Za-z]+(\s*\([^)]*\))?/i, '').trim() : '';
    if (Number(c.notnull) === 1 && !/\bNOT\s+NULL\b/i.test(rest)) rest = `NOT NULL ${rest}`.trim();
    if (mysqlType === 'MEDIUMTEXT' && (p.hasDefault || p.dropDefault)) rest = rest.replace(/\s*DEFAULT\s+('(?:[^']|'')*'|\S+)/i, '').replace(/\s+/g, ' ').trim();
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
