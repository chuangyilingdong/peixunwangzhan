/**
 * 数据访问层 · 两个驱动共用的零件（RDS 阶段 2，2026-09-23）
 *
 * 这里只放**与驱动无关**的东西：漏 await 检测器、顺序版 map、JSON helpers、方言标记。
 * 具体实现分两处：
 *   · schema.js —— SQLite（node:sqlite 同步驱动）+ **导入期建表/迁移**（阶段 0/1 的现状）
 *   · mysql.js  —— MySQL（mysql2 异步驱动，阶段 2 新加）
 *   · store.js  —— 按 DB_DRIVER 选一个，业务代码只认 store.js
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';

/** `sqlite`（默认）| `mysql` —— 应用代码要靠它分支的地方（方言差异）从这里取 */
export const dialect = String(process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql' ? 'mysql' : 'sqlite';
export const isMysql = dialect === 'mysql';

/**
 * SQL 里"取两个值的较大/较小者"的方言：
 *   SQLite 的 `max(a,b)` / `min(a,b)` 是**标量**函数；
 *   MySQL 的 `MAX/MIN` 是**聚合**函数（只吃一个参数），两参形式叫 `GREATEST/LEAST`。
 * ⚠️ 写 `MAX(a,b)` 在 MySQL 上直接是语法错（实测：seed 与"撤销课包授权"那条 UPDATE 都踩了）。
 * 用法：模板串里写 `${SQL_MAX}(a, b)`。
 */
export const SQL_MAX = isMysql ? 'GREATEST' : 'MAX';
export const SQL_MIN = isMysql ? 'LEAST' : 'MIN';

/**
 * 取 JSON 列里某个键的**值**（SQLite / MySQL 同形）。
 * ⚠️ MySQL 的 JSON_EXTRACT 对字符串返回**带引号**的 JSON（`"x"` 而不是 `x`），
 *    不 unquote 的话 `= 'x'` / 与状态常量比较这类会**静默不匹配**。
 */
export const jsonText = (expr, path) => (isMysql
  ? `JSON_UNQUOTE(JSON_EXTRACT(${expr}, '${path}'))`
  : `json_extract(${expr}, '${path}')`);

export function json(value) { return JSON.stringify(value ?? null); }
export function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;   // mysql2 的 JSON 列会直接给对象
  try { return JSON.parse(value); } catch { return fallback; }
}

// 下面几个是**与驱动无关**的纯函数（从 schema.js 挪过来的）：mysql 驱动下也要能用，
// 否则调用方会被迫 import schema.js —— 而 schema.js 在被 import 那一刻就会跑 2600 行建表。
const PEPPER = process.env.AUTH_PEPPER || 'p0-local-pepper';
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(`${PEPPER}:${password}`, salt, 64).toString('hex')}`;
}
export function id(prefix) { return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`; }
export function nowIso() { return new Date().toISOString(); }
export function formatOrgCode(sequence) {
  const value = Math.max(1, Number(sequence) || 1);
  return 'ORG' + String(value).padStart(4, '0');
}

/** 从"已占用的编码清单"算出下一个可用机构编码（纯计算，两种驱动共用） */
export function nextOrgCodeFrom(list) {
  const used = new Set((list || []).map((code) => String(code)));
  let max = 0;
  for (const code of used) {
    const matched = /^ORG(\d+)$/.exec(code);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  let sequence = max;
  let candidate = formatOrgCode(sequence + 1);
  while (used.has(candidate)) { sequence += 1; candidate = formatOrgCode(sequence + 1); }
  return candidate;
}

/**
 * 漏 await 检测器：数据访问返回的不是裸 Promise，而是一个 Proxy ——
 * 除 then/catch/finally 以外，**访问任何属性都直接抛错**，错误信息就是"你漏了 await（SQL: …）"。
 *
 * ⚠️ 它能兜住的是**属性访问**（`user.id`）、**JSON 序列化**、**迭代**（`[...rows]`）；
 *    兜不住 `if (leaked)` / `!leaked` —— JS 的 ToBoolean 对对象没有可拦截的钩子（Proxy 的 get 不触发）。
 *    那一类靠静态门禁 `scripts/p137-async-db-await.mjs --gate`（它现在也查异步 API 名）。
 *
 * ⚠️ 调用方**不能**把它包在 `async function` 里：async 函数返回的是原生 Promise，
 *    会把 Proxy 吞掉，漏 await 就又变成静默的了。
 */
export function pendingResult(value, sql) {
  const promise = Promise.resolve(value);
  return new Proxy(promise, {
    get(target, prop) {
      // ⚠️ 必须返回**绑定到 target 的函数**：`await proxy` 是"在 proxy 上调用 then"，
      //    调用时的 this 会是 Proxy —— 直接返回 target 上的方法会报
      //    "Method Promise.prototype.then called on incompatible receiver"（踩了两次）。
      if (prop === 'then' || prop === 'catch' || prop === 'finally'
        || prop === Symbol.toStringTag
        || (typeof prop === 'symbol' && String(prop).includes('inspect'))) {
        const fn = Reflect.get(target, prop, target);
        return typeof fn === 'function' ? fn.bind(target) : fn;
      }
      throw new Error(
        `[数据访问] 这里漏了 await —— 拿到的是 Promise，不是数据。SQL: ${String(sql).slice(0, 100)}`,
      );
    },
  });
}

/**
 * 顺序版 map：`await amap(list, async (x, i) => …)`。
 *
 * 为什么不能用 `Promise.all(list.map(async …))`（2026-09-23 实测踩到）：
 * 同步代码里 `list.map(fn)` 是**一个接一个**跑的，fn 对外层状态的写入是有序的；
 * 换成 `Promise.all` 之后回调并发起跑 → 依赖顺序的逻辑静默出错
 * （实例：previewImport 用 seenLogins 这个 Set 累积判"本批次登录名重复"，并发后一条都查不出来）。
 * 想要并发应当**显式**写 Promise.all，而不是由这次改造顺手改掉语义。
 */
export async function amap(list, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += 1) out.push(await fn(list[i], i, list));
  return out;
}

/** 事务上下文的认领标记（两个驱动各自的实现用它避免嵌套/自锁） */
export const txContext = new AsyncLocalStorage();
