/**
 * 数据访问层 · MySQL 实现（RDS 阶段 2，2026-09-23）
 *
 * 这一层是**阶段 1 那套异步 API 的第二种实现**：`aq/arows/arow/aone/acount/atransaction`
 * 的名字、返回形状、异常语义都对齐 SQLite 那套，所以**业务代码一行都不用改**。
 *
 * 与 SQLite 版的三个关键差异（每条都对应一次实测教训）：
 *   ① **真异步**：每条语句都是一次网络往返，`await` 会让出事件循环 → 事务必须绑在**同一条连接**上
 *      （用 AsyncLocalStorage 记录"当前事务的连接"，模块级的 aq/arow/… 自动路由过去）。
 *      SQLite 那版因为共用一个连接、还有一把全局锁，才不需要路由。
 *   ② **返回形状要对齐**：`node:sqlite` 的 `.run()` 给 `{ changes, lastInsertRowid }`，
 *      而 mysql2 给的是 ResultSetHeader（`affectedRows` / `insertId`）——
 *      应用里有 12 处读 `.changes`，不映射就会变成 undefined（静默算错）。
 *   ③ **类型口径要对齐**：SQLite 里 SUM()/AVG() 回来是数字，MySQL 的 DECIMAL 默认回**字符串**；
 *      SQLite 的时间列存的是 ISO 字符串，MySQL 若建成了 DATETIME 会回 Date 对象。
 *      所以 pool 上开 `decimalNumbers: true` + `dateStrings: true`（阶段 0 建表时时间列本来就是
 *      按真实数据长度定的 VARCHAR，不是 DATETIME —— 这条是双保险）。
 */
import mysql from 'mysql2/promise';
import { dialect, json, parseJson, pendingResult, amap, txContext } from './shared.js';

if (dialect !== 'mysql') {
  // 只在 DB_DRIVER=mysql 时才会被 import（store.js 负责），这里再兜一次，避免误用
  throw new Error('[数据层] mysql.js 被 import 了，但 DB_DRIVER 不是 mysql');
}

const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));

const poolOptions = {
  host: process.env.MYSQL_HOST || process.env.RDS_HOST || '127.0.0.1',
  port: num(process.env.MYSQL_PORT || process.env.RDS_PORT, 3306),
  user: process.env.MYSQL_USER || process.env.RDS_USER || 'root',
  password: process.env.MYSQL_PASSWORD || process.env.RDS_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || process.env.RDS_DATABASE || 'aild_admin',
  charset: process.env.MYSQL_CHARSET || 'utf8mb4_general_ci',
  waitForConnections: true,
  connectionLimit: num(process.env.MYSQL_POOL_SIZE, 10),
  queueLimit: 0,
  // 空闲连接闲置多久后关掉（默认 60s；测试/CLI 场景设小一点，否则**进程永远不退出**）。
  // 为什么重要：mysql2 的连接池握着 TCP socket → 事件循环不空 → CLI 脚本干完活挂着不返回。
  // 实测表现极具误导性：验收脚本自己打印了"passed"，但进程不退出，被运行器判成"超时失败"。
  // 空闲超时只关"闲着"的连接，不会打断进行中的语句。
  idleTimeout: num(process.env.MYSQL_IDLE_TIMEOUT, 60000),
  // ① SUM/AVG 等 DECIMAL 回数字（SQLite 那边就是数字，别变成字符串）
  decimalNumbers: true,
  // ② 日期/时间列回字符串（SQLite 存的就是 ISO 字符串）
  dateStrings: true,
  // ③ 多语句关掉（与 node:sqlite 一致：一次只跑一条；DDL 走迁移脚本）
  multipleStatements: false,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
};

export const pool = mysql.createPool(poolOptions);

export const dbConfig = {
  host: poolOptions.host,
  port: poolOptions.port,
  user: poolOptions.user,
  database: poolOptions.database,
  connectionLimit: poolOptions.connectionLimit,
};

/** 事务内走事务连接，事务外走连接池 —— 这一步就是"业务代码一行都不用改"的全部秘密 */
function target() {
  return txContext.getStore()?.conn || pool;
}

/** 把 mysql2 的错误裹上 SQL 上下文（MySQL 的错误文案与 SQLite 完全不同，排障时没有 SQL 很难定位） */
function wrapError(error, sql, params) {
  const message = `[数据访问/MySQL] ${error?.code || ''} ${error?.message || error}`.trim();
  // 排障开关：`DB_DEBUG_ERRORS=1` 时把出错的 SQL 原样打出来。
  // MySQL 的错误文案与 SQLite 完全不同（例如 ER_SP_DOES_NOT_EXIST 这种看着毫不相干的码），
  // 没有 SQL 基本定位不了。
  if (process.env.DB_DEBUG_ERRORS) {
    console.error(`
[数据访问/MySQL 出错] ${error?.code}: ${error?.message}
  SQL: ${String(sql).replace(/\s+/g, ' ').slice(0, 400)}
  参数: ${JSON.stringify(params).slice(0, 200)}
`);
  }
  const wrapped = new Error(`${message} —— SQL: ${String(sql).replace(/\s+/g, ' ').slice(0, 160)}`);
  wrapped.code = error?.code;
  wrapped.sqlState = error?.sqlState;
  wrapped.cause = error;
  return wrapped;
}

/**
 * SQLite → MySQL 的**方言翻译**（只做"可证明等价"的四条，逐条写明依据）。
 *
 * 为什么集中在这里翻译、而不是逐个改调用点：改调用点要动 11 处字符串字面量（还得把单引号换成模板串），
 * 风险比翻译层大得多；而这几条差异是**语义等价**的，翻译层还自带"依据可审查"的好处。
 *
 *   ① `COLLATE NOCASE` → 去掉
 *      MySQL 的列默认排序规则就是 utf8mb4_general_ci（**不区分大小写**），SQLite 的默认则是区分大小写，
 *      所以 SQLite 侧要显式写 NOCASE、MySQL 侧什么都不写才是同一个语义。
 *   ② `INSERT OR IGNORE INTO` → `INSERT IGNORE INTO`
 *      ⚠️ 不是完全等价：MySQL 的 INSERT IGNORE 还会把**数据截断/外键**这类错降级成警告（SQLite 只忽略约束冲突）。
 *      本仓只有 2 处用它，且都是"不存在才插一条"的语义（主键/唯一键冲突）→ 安全。**新代码不要再依赖它。**
 *   ③ `INSERT OR REPLACE INTO` → `REPLACE INTO`
 *      两者都是"冲突时先删后插"，语义一致（连带后果也一样：都触发级联删除/触发器）。
 *   ⑤ `ORDER BY … DESC NULLS LAST` → 去掉子句（MySQL 无此语法，而它的默认就是 NULL 排最后）
 *   ④ `json_extract`：**不能靠翻译层**（实测踩到）—— 它需要配对地补一个右括号，正则做不到。
 *      改成调用点用 shared.js 的 `jsonText(expr, path)`，它按驱动给出 `json_extract(...)` 或
 *      `JSON_UNQUOTE(JSON_EXTRACT(...))`（MySQL 对字符串会返回带引号的 JSON，不 unquote 会让 `= 'x'` 静默失效）。
 */
function translateSqlite(sql) {
  let out = sql;
  // ⑤ `ORDER BY x DESC NULLS LAST` / `ORDER BY x ASC NULLS FIRST` → 去掉子句
  //    MySQL **没有** NULLS FIRST/LAST 语法（那是 PostgreSQL/SQLite 3.30+ 的），直接语法错。
  //    而 MySQL 的默认正好就是这两种：**NULL 视为最小值** —— ASC 时排最前、DESC 时排最后。
  //    所以这两种组合去掉子句后语义**完全相同**。
  //    ⚠️ 另外两种组合（ASC NULLS LAST / DESC NULLS FIRST）与 MySQL 默认相反，**不在这里翻译** ——
  //       那需要 `ORDER BY (x IS NULL), x` 的写法，留给调用点显式处理；不翻译会当场语法错，
  //       总好过"悄悄换了个排序"。
  if (/(?:^|[\s,)])(DESC|ASC|desc|asc)\s+NULLS\s+LAST/i.test(out)) out = out.replace(/\s+NULLS\s+LAST/gi, '');
  if (/(?:^|[\s,)])(DESC|ASC|desc|asc)\s+NULLS\s+FIRST/i.test(out)) out = out.replace(/\s+NULLS\s+FIRST/gi, '');
  if (out.includes('COLLATE NOCASE')) out = out.replace(/\s+COLLATE\s+NOCASE/gi, '');
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(out)) out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT IGNORE INTO');
  if (/INSERT\s+OR\s+REPLACE\s+INTO/i.test(out)) out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'REPLACE INTO');
  // ⑥ `datetime('now')` / `date('now')` → `UTC_TIMESTAMP()` / `UTC_DATE()`（2026-09-24 加）
  //    为什么能翻译（**可证明等价**，与 ④ 的 json_extract 不同）：两边都是 **UTC**、
  //    产出的字符串形式也都是 `YYYY-MM-DD HH:MM:SS`。
  //    ⚠️ 一定要用 `UTC_*` 而不是 `NOW()` / `CURDATE()`：后者是**会话时区**（这台机 +08:00），
  //       与 SQLite 的 UTC 差 8 小时 —— 那正是这个仓库最怕的"不报错只算错"。
  //    为什么必须在翻译层做：验收脚本（scripts/）里有 21 个夹具用它写时间戳，
  //    逐个改调用点既多又容易漏；而这是一个**固定字面量**，正则替换是安全的。
  if (/datetime\s*\(\s*'now'\s*\)/i.test(out)) out = out.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'UTC_TIMESTAMP()');
  if (/date\s*\(\s*'now'\s*\)/i.test(out)) out = out.replace(/date\s*\(\s*'now'\s*\)/gi, 'UTC_DATE()');
  // ⑦ `IS ?`（拿**参数**做 NULL 安全比较）→ `<=> ?`（2026-09-24 加）
  //    SQLite 的 `x IS ?` 与 MySQL 的 `x <=> ?` 都是"NULL 安全相等"（NULL 与 NULL 算相等）——
  //    可证明等价。实测：账号查重（admin/helpers）与动态筛选（lib.js）都是这个写法，
  //    不翻译在 MySQL 上直接 ER_PARSE_ERROR。
  //    只吃 `IS ?`（`IS NULL` / `IS NOT NULL` / `IS NOT ?` 都不碰 —— 后者的语义不同）。
  if (/\bIS\s+\?/i.test(out)) out = out.replace(/\bIS\s+\?/gi, '<=> ?');
  return out;
}

/** 守卫用：把一条 SQLite 写法的 SQL 翻成 MySQL 会发出去的形状（不连库、纯函数）。 */
export { translateSqlite };

async function exec(sql, params = []) {
  const conn = target();
  const translated = translateSqlite(sql);
  try {
    // execute() = 预处理语句（二进制协议）：与 node:sqlite 的 prepare().run/all/get 语义最接近，
    // 参数按类型发送（不会把数字当字符串比）。⚠️ 不能用它跑多语句。
    const [result] = await conn.execute(translated, params);
    return result;
  } catch (error) {
    // 有些语句 MySQL 不支持预处理（个别 DDL / 管理语句）→ 退回文本协议，仍带参数转义
    if (error?.code === 'ER_UNSUPPORTED_PS' || error?.code === 'ER_PARSE_ERROR') {
      try {
        const [result] = await conn.query(translated, params);
        return result;
      } catch (retryError) { throw wrapError(retryError, sql, params); }
    }
    throw wrapError(error, sql, params);
  }
}

/** 与 node:sqlite 的 `db.prepare(sql).all(...)` 同形：回**普通对象**数组（不是 RowDataPacket） */
const plain = (rows) => (Array.isArray(rows) ? rows.map((row) => ({ ...row })) : []);

export function aq(sql, params = []) {
  return pendingResult((async () => {
    const result = await exec(sql, params);
    // 对齐 node:sqlite 的 .run() 形状（应用里有 12 处读 .changes）
    return { changes: Number(result?.affectedRows ?? 0), lastInsertRowid: Number(result?.insertId ?? 0) };
  })(), sql);
}

export function arows(sql, params = []) {
  return pendingResult((async () => {
    const result = await exec(sql, params);
    return plain(result);
  })(), sql);
}

export function arow(sql, params = []) {
  return pendingResult((async () => {
    const result = await exec(sql, params);
    return plain(result)[0];
  })(), sql);
}

export function aone(sql, params = []) { return arow(sql, params); }

export function acount(sql, params = []) {
  return pendingResult((async () => {
    const result = await exec(sql, params);
    return Number(plain(result)[0]?.n || 0);
  })(), sql);
}

/**
 * 异步事务：占用**一条专用连接**，BEGIN/COMMIT/ROLLBACK 都在它上面；
 * fn 里（同一个异步上下文，含它 await 出去的每一步）的 aq/arow/… 会自动路由到这条连接。
 *
 * ⚠️ 不支持嵌套事务：SQLite 那版也不支持（`cannot start a transaction within a transaction`），
 *    这里给一句自己的错，比让 MySQL 报 1064 更好定位。
 */
export async function atransaction(fn) {
  if (txContext.getStore()?.conn) throw new Error('[事务] 不支持嵌套事务');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await txContext.run({ conn }, fn);
    await conn.commit();
    return result;
  } catch (error) {
    try { await conn.rollback(); } catch { /* 回滚失败不掩盖原错误 */ }
    throw error;
  } finally {
    conn.release();
  }
}

/** 测试夹具/迁移脚本用的裸执行（不做形状映射、不走事务路由）：一次一条语句 */
export async function rawExec(sql, params = []) {
  // 也过一遍方言翻译：测试夹具/迁移脚本里的 SQL 往往是从 SQLite 侧抄来的（COLLATE NOCASE / INSERT OR IGNORE…）
  const [result] = await pool.query(translateSqlite(sql), params);
  return result;
}

/**
 * 关掉连接池。
 * ⚠️ 为什么必须有：mysql2 的连接池会**保持事件循环**（SQLite 的 DatabaseSync 不会），
 *    CLI 脚本（seed.js、迁移脚本）干完活如果不关池，进程就一直挂着不退出 ——
 *    实测表现是"日志打印了 Seed complete，但脚本再也不返回"。
 *    常驻服务不需要调它（服务本来就该一直活着）。
 */
export async function closePool() {
  try { await pool.end(); } catch { /* 关不掉就算了，进程本来就要退 */ }
}

export async function ping() {
  const [rows] = await pool.query('SELECT VERSION() AS version');
  return rows[0]?.version;
}

export { json, parseJson, amap };
