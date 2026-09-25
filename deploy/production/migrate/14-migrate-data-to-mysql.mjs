#!/usr/bin/env node
/**
 * 14 · 把 SQLite 的数据搬进 MySQL，并逐表比对（阶段 0 的后两步）
 *
 * 为什么用 mysql 命令行而不是给应用引驱动：阶段 0 只是"搬过去 + 证明搬对了"，
 * 应用此刻**还没接** RDS。用命令行能少一次 lockfile 变更与构建面（驱动等真接的时候再引）。
 * 凭据走 ~/.my.cnf（600），**不上命令行** —— 否则会出现在 ps 里。
 *
 * 两种模式：
 *   --out <file>   生成数据 SQL（INSERT，分批多行 VALUES），**不连库**
 *   --compare      逐表比对：所有表比行数；关键表**逐行比对内容**（把两边都读进内存算摘要）
 *   --load         直接把生成的 SQL 灌进 MySQL（走 mysql 命令行）
 *
 * 用法（服务器上）：
 *   export PATH=/srv/ai-kids-platform/runtime/node/bin:$PATH
 *   cd /srv/ai-kids-platform/source
 *   node deploy/production/migrate/14-migrate-data-to-mysql.mjs --out /tmp/data.mysql.sql
 *   node deploy/production/migrate/14-migrate-data-to-mysql.mjs --load /tmp/data.mysql.sql
 *   node deploy/production/migrate/14-migrate-data-to-mysql.mjs --compare
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
};
const mode = process.argv.includes('--compare') ? 'compare'
  : process.argv.includes('--load') ? 'load' : 'out';
const outPath = arg('--out', '/tmp/data.mysql.sql');
const loadPath = arg('--load', '/tmp/data.mysql.sql');
const dbPath = arg('--db', '/srv/ai-kids-platform/production/data/platform.db');
const BATCH = Number(arg('--batch', '200'));

// 目标库名：load 与 compare 都要用（两个模式各自都要显式带 -D，见下面的注释）
const MYDB = String(process.env.RDS_DATABASE || 'aild_admin').trim();
const loadDb = MYDB;

const db = new DatabaseSync(dbPath, { readOnly: true });
const q = (sql) => db.prepare(sql).all();
const bt = (n) => `\`${String(n).replaceAll('`', '``')}\``;

const tables = q(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
  .map((r) => r.name);

/** MySQL 字符串转义：反斜杠要先转（默认 NO_BACKSLASH_ESCAPES 关闭，反斜杠是转义符） */
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  return `'${String(v)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "''")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\0', '\\0')}'`;
};

// ─────────────────────────── 模式一：生成数据 SQL ───────────────────────────
if (mode === 'out') {
  const chunks = [];
  chunks.push('SET NAMES utf8mb4;');
  chunks.push('SET FOREIGN_KEY_CHECKS=0;');
  chunks.push('SET UNIQUE_CHECKS=0;');
  chunks.push('START TRANSACTION;');
  let rowsTotal = 0;
  for (const t of tables) {
    const cols = q(`SELECT * FROM pragma_table_info('${t.replaceAll("'", "''")}')`).map((c) => c.name);
    if (!cols.length) continue;
    const rows = db.prepare(`SELECT ${cols.map(bt).join(',')} FROM ${bt(t)}`).all();
    rowsTotal += rows.length;
    if (!rows.length) continue;
    const colList = cols.map(bt).join(',');
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const values = slice.map((r) => `(${cols.map((c) => lit(r[c])).join(',')})`).join(',');
      chunks.push(`INSERT INTO ${bt(t)} (${colList}) VALUES ${values};`);
    }
  }
  chunks.push('COMMIT;');
  chunks.push('SET UNIQUE_CHECKS=1;');
  chunks.push('SET FOREIGN_KEY_CHECKS=1;');
  fs.writeFileSync(outPath, chunks.join('\n'), 'utf8');
  console.error(`表 ${tables.length} 张、行 ${rowsTotal} 行 → ${outPath}（${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB）`);
  process.exit(0);
}

// ─────────────────────────── 模式二：灌进 MySQL ───────────────────────────
if (mode === 'load') {
  if (!fs.existsSync(loadPath)) { console.error(`找不到 ${loadPath}`); process.exit(1); }
  const sql = fs.readFileSync(loadPath, 'utf8');
  try {
    // ⚠️ 必须带 -D <库名>：生成的数据 SQL 里没有 USE，mysql 不带库名会报
    //    'ERROR 1046 (3D000) No database selected'（2026-09-25 切库时实测踩到，
    //    compare 那步早就修过、load 这步漏了）。
    execFileSync('mysql', ['-D', loadDb], { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
    console.log('灌库完成');
  } catch (error) {
    console.error('灌库失败：', error.message);
    process.exit(1);
  }
  process.exit(0);
}

// ─────────────────────────── 模式三：逐表比对 ───────────────────────────
// ⚠️ 必须显式带 -D <库名>：不带的话 mysql 会报 "No database selected"（我第一版就漏了，
//    结果 89 张表全被误报成"查不到"）。
const my = (sql) => execFileSync('mysql', ['-D', MYDB, '--batch', '--raw', '--skip-column-names', '-e', sql], { encoding: 'utf8' })
  .trim().split('\n').filter((x) => x !== '');
const digestOf = (rows, cols) => {
  const h = createHash('sha256');
  for (const r of rows) {
    for (const c of cols) {
      const v = r[c];
      // ⚠️ 两边必须**归一到同一种表示**再比：SQLite 侧拿到的整数是真 number，
      //    而 MySQL 侧经 XML 拿回来的是字符串 —— 不归一就会出现"内容不一致"的**假警报**
      //    （第一版就是这么误报的）。NULL 用一个不可能与数据撞的标记表示。
      h.update(v === null || v === undefined ? '\u0000NULL' : (Buffer.isBuffer(v) ? `buf:${v.toString('hex')}` : String(v)));
      h.update('\u0001');
    }
    h.update('\u0002');
  }
  return h.digest('hex').slice(0, 16);
};

// 关键表逐行比对（其余只比行数；这些是业务上最要紧的）
const CRITICAL = ['users', 'organizations', 'class_sessions', 'session_students', 'works', 'file_assets', 'credit_entries', 'classes'];

let bad = 0; let checked = 0; let deep = 0;
for (const t of tables) {
  const cols = q(`SELECT * FROM pragma_table_info('${t.replaceAll("'", "''")}')`).map((c) => c.name);
  if (!cols.length) continue;
  const nS = Number(db.prepare(`SELECT COUNT(*) n FROM ${bt(t)}`).get()?.n || 0);
  let nM;
  try { nM = Number(my(`SELECT COUNT(*) FROM ${bt(t)};`)[0] || 0); }
  catch (e) { console.log(`  ✗ ${t}: MySQL 查不到（表可能没建）—— ${String(e.message).split('\n')[0]}`); bad += 1; continue; }
  checked += 1;
  if (nS !== nM) { console.log(`  ✗ ${t}: 行数不一致 SQLite=${nS} MySQL=${nM}`); bad += 1; continue; }
  if (CRITICAL.includes(t) && nS > 0) {
    const order = cols.includes('id') ? 'id' : cols[0];
    const rowsS = db.prepare(`SELECT ${cols.map(bt).join(',')} FROM ${bt(t)} ORDER BY ${bt(order)}`).all();
    // MySQL 侧逐行取回来比对：用 XML 输出（数据里可能有制表符/换行，TSV 会切坏）
    const xml = execFileSync('mysql', ['-D', MYDB, '--xml', '-e', `SELECT ${cols.map(bt).join(',')} FROM ${bt(t)} ORDER BY ${bt(order)};`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const rowsM = [...xml.matchAll(/<row>([\s\S]*?)<\/row>/g)].map((m) => {
      const o = {};
      // ⚠️ 必须识别 `xsi:nil="true"`：MySQL 的 XML 把 NULL 输出成自闭合的空 field，
      //    不识别就会读成**空字符串** —— 于是"NULL vs ''"被判成内容不一致（第一版就是这么误报的）。
      for (const f of m[1].matchAll(/<field([^>]*?)(?:\/>|>([\s\S]*?)<\/field>)/g)) {
        const [, attrs, raw] = f;
        const name = (attrs.match(/name="([^"]+)"/) || [])[1];
        if (!name) continue;
        if (/xsi:nil="true"/.test(attrs)) { o[name] = null; continue; }
        o[name] = String(raw ?? '')
          .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
          .replaceAll('&amp;', '&').replaceAll('&apos;', "'");
      }
      return o;
    });
    const ds = digestOf(rowsS, cols);
    const dm = digestOf(rowsM.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))), cols);
    deep += 1;
    if (ds !== dm) console.log(`  ✗ ${t}: **内容摘要不一致**（行数都是 ${nS}，但内容有差异）SQLite=${ds} MySQL=${dm}`);
  }
}
console.log(`\n比对完成：${checked} 张表比了行数（其中 ${deep} 张关键表**逐行比了内容**），不一致 ${bad} 张`);
process.exit(bad ? 1 : 0);
