/**
 * P143 MySQL 强制、SQLite 容忍的写法：**派生表必须有别名**（2026-09-25 生产事故）。
 *
 * 事故：机构端「学生授权中心」整页 500，红框里写着「服务器内部错误」。
 *   日志原文：`ER_DERIVED_MUST_HAVE_ALIAS` / errno 1248 / "Every derived table must have its own alias"，
 *   SQL 是 `SELECT COUNT(*) n FROM (SELECT student.id FROM users student LEFT JOIN …)` —— `FROM (…)` 后面没别名。
 *   SQLite 无所谓，MySQL 直接拒 —— 所以本地全量套件（跑在 SQLite 上）一路绿，切到 RDS 才炸：
 *   3 天里这条 SQL 打了 33 次 500（同一页每次进都报）。
 *
 * 为什么要有这个静态守卫（而不是只靠 MySQL 侧那套验收网）：
 *   · 验收网只覆盖**脚本走到过**的接口 —— 这条 SQL 在 `p111` 里走到过（所以补上别名后 p111 在 MySQL 上立刻转绿），
 *     但同一个仓里还有另一处（对账页的币种下拉）**没有任何脚本走到**，它是直接被这次扫描抓出来的；
 *   · 这类方言差异**在 SQLite 上永远看不见**，等发现的时候已经是线上的 500。
 *
 * 判据（只扫生产代码：`apps/server/src` + `packages/<pkg>/src`）：
 *   每处 `FROM (` / `JOIN (` 都要在**配对的那个右括号**后面跟一个别名；
 *   后面直接是 `)` `,` `;` 结尾、或跟着 SQL 关键字（ORDER/GROUP/WHERE/LIMIT/UNION/HAVING/ON/…）＝ 没别名。
 *   ⚠️ 只扫生产代码是**故意**的：本文件自己就写着 `FROM (` 这些字面量，
 *      把 scripts/ 也纳进来会自我误报（这类"守卫把自己扫红"的坑，p142 那条注释里记过同款）。
 * 跑法：node scripts/p143-derived-table-alias.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** SQL 关键字：派生表右括号后面跟着这些，说明那是"没有别名"而不是"别名恰好叫这个" */
const SQL_KEYWORDS = new Set([
  'order', 'group', 'where', 'limit', 'union', 'having', 'on', 'set', 'window', 'into', 'values',
  'select', 'from', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'and', 'or', 'as', 'using',
]);

/** 找 `FROM (` / `JOIN (` 配对的那个右括号之后有没有别名。返回问题片段，没问题返回 null。 */
function unaliasedDerivedTable(sql) {
  // ⚠️ 关键词前面不能是 `.`：`list.join(',')`、`Buffer.from(x)` 是 JS，不是 SQL 的 FROM/JOIN
  //    （第一版就栽在这儿：满屏假报警，全是 Array.prototype.join 与 Buffer.from）。
  const pattern = /(?<![\w.$])(?:from|join)\s*\(/gi;
  for (const match of sql.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < sql.length; i += 1) {
      if (sql[i] === '(') depth += 1;
      else if (sql[i] === ')') { depth -= 1; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) continue; // 括号没配平（多半是拼出来的 SQL）——不在这里判
    const after = sql.slice(close + 1);
    const token = (after.match(/^\s*(?:as\s+)?([A-Za-z_][\w]*)/i) || [])[1] || '';
    if (!token || SQL_KEYWORDS.has(token.toLowerCase())) {
      return sql.slice(match.index, Math.min(sql.length, close + 40)).replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

console.log('① 判据自检（先把"检测器本身对不对"钉住，免得它静默放过真问题）');
check('① 没别名 → 判为问题',
  unaliasedDerivedTable('SELECT COUNT(*) n FROM (SELECT id FROM users)') !== null
  && unaliasedDerivedTable('SELECT 1 FROM (SELECT id FROM users) ORDER BY id') !== null);
check('① 有别名（裸别名 / AS 别名）→ 判为没问题',
  unaliasedDerivedTable('SELECT COUNT(*) n FROM (SELECT id FROM users) s') === null
  && unaliasedDerivedTable('SELECT COUNT(*) n FROM (SELECT id FROM users) AS s') === null
  && unaliasedDerivedTable('SELECT c FROM (SELECT a AS c FROM t UNION SELECT b FROM u) currencies ORDER BY c') === null);
check('① JS 里那些 "join(" / "from(" 不许误报（Array.join / Buffer.from 满仓都是）',
  unaliasedDerivedTable("const s = list.join(','); const b = Buffer.from(x, 'utf8');") === null
  && unaliasedDerivedTable("values.map((v) => v).join(' AND ')") === null);
check('① 嵌套与 JOIN 形式也认（内层括号不能把配对搞错）',
  unaliasedDerivedTable('SELECT 1 FROM (SELECT id, (SELECT 1 FROM x) AS y FROM users) s') === null
  && unaliasedDerivedTable('SELECT 1 FROM t JOIN (SELECT id FROM users) ON 1=1') !== null);

console.log('② MySQL 的另两类硬约束（2026-09-25 生产各炸过一次，一起钉住）');
const gen = fs.readFileSync(path.join(root, 'deploy/production/migrate/12-sqlite-to-mysql-ddl.mjs'), 'utf8');
// (a) 非索引 TEXT 列必须 MEDIUMTEXT：按"当时真实数据长度 × 1.2"定 varchar 是定时炸弹 ——
//     内容一长就 ER_DATA_TOO_LONG（生产：website_contents.draft_content varchar(1728) 把官网 CMS 保存打挂；
//     全站排查还发现 80+ 列已用掉 70%+ 宽度）。TEXT 系不能有**字面量**默认值，但 8.0.13+ 的
//     **表达式默认值** `DEFAULT ('{}')` 可以 —— 所以不能再"顺手把默认值丢掉"。
check('②a 非索引 TEXT 列一律 MEDIUMTEXT（不再按数据长度定 varchar）',
  /mysqlType = 'MEDIUMTEXT';/.test(gen) && /fixedWidth = MEDIUMTEXT_COST;/.test(gen)
  && !/const size = len === 0 \? minVarchar/.test(gen));
check('②a TEXT 列的默认值用**表达式**保住（不许丢）',
  /DEFAULT \(\$\{value\}\)/.test(gen) && !/dropDefault\)\) rest = rest\.replace/.test(gen));
// (b) 索引/外键列必须留在 VARCHAR，而且要在生成器里就认出来：漏一处，生成的 DDL 直接建不出来
//     （实测：`BLOB/TEXT column 'resolved_by' used in key specification without a key length`）。
check('②b 生成器把外键列算进"被索引"（MySQL 会自动为外键建索引）',
  /FOREIGN\\s\+KEY/.test(gen) && /addIndexed\(m\.table, col\)/.test(gen));
check('②b 生成器把隐式唯一索引（sqlite_autoindex_*）也算进"被索引"',
  /sqlite_master WHERE type='index' AND sql IS NULL/.test(gen) && /pragma_index_info/.test(gen));

console.log('② 扫生产代码');
const roots = ['apps/server/src', ...fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, 'packages', entry.name, 'src')))
  .map((entry) => path.join('packages', entry.name, 'src'))];
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); continue; }
    if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(rel);
  }
};
roots.forEach(walk);
check('② 扫到了生产代码（文件数为正，说明扫描根没写错）', files.length > 50, `files=${files.length}`);

const problems = [];
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  // 先剥掉行注释与块注释：注释里写 SQL 示例不该被当成真查询
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const issue = unaliasedDerivedTable(code);
  if (issue) {
    const line = code.slice(0, code.indexOf(issue)).split('\n').length;
    problems.push(`${file}:${line} → ${issue.slice(0, 110)}`);
  }
}
check('② 生产代码里没有"派生表没别名"（MySQL 会 500，SQLite 不会）',
  problems.length === 0, problems.join(' ｜ '));

if (failures) {
  console.error(JSON.stringify({ name: 'p143-derived-table-alias', pass: false, failed: failures }, null, 1));
  process.exit(1);
}
console.log(JSON.stringify({ name: 'p143-derived-table-alias', pass: true, scanned: files.length }));
