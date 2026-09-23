/**
 * 数据访问层 · 驱动选择（RDS 阶段 2，2026-09-23）
 *
 * 业务代码**只认这个文件**（经 lib.js 转出）。它按 `DB_DRIVER` 决定底下是谁：
 *
 *   DB_DRIVER=sqlite（默认）→ schema.js：node:sqlite 同步驱动 + **导入期建表/迁移**
 *   DB_DRIVER=mysql         → mysql.js ：mysql2 异步驱动（表结构由迁移脚本建，不在应用里跑 DDL）
 *
 * ⚠️ 为什么用**动态 import** 而不是静态：schema.js 在被 import 的那一刻就会跑完
 *    2600 行建表/迁移（PRAGMA、CREATE TABLE、ALTER、回填…），这些在 MySQL 上跑不了。
 *    所以走 mysql 时必须**根本不加载它**。
 *
 * 同步 API（q/rows/row/count/transaction）在 mysql 驱动下**没有等价物**（真异步驱动做不出同步接口）。
 * 阶段 1 已把应用与验收脚本全部改成异步 API（门禁 p137 保证应用侧 0 处），所以这里给一组
 * "用了就报错"的桩：谁要是回退去用同步 API，会在**第一次调用**时看到明确的错。
 */
import { dialect, isMysql, json, parseJson, jsonText, amap, hashPassword, id, nowIso, formatOrgCode, nextOrgCodeFrom, SQL_MAX, SQL_MIN } from './shared.js';

export { dialect, isMysql, json, parseJson, jsonText, amap, hashPassword, id, nowIso, formatOrgCode, SQL_MAX, SQL_MIN };

const impl = isMysql ? await import('./mysql.js') : await import('./schema.js');

/**
 * 下一个可用机构编码：取现有编码里最大的 `ORG<数字>` 再 +1，跳过已占用的。
 * 传入 codes 时用调用方给的快照（同一事务里连开多家机构），不传就现查库。
 *
 * ⚠️ "现查库"分支在 mysql 下必须异步 → 这里返回 Promise、sqlite 下同步返回，
 *    **调用方一律 `await`**（await 非 Promise 是空操作，两边写法一致）。
 */
export function nextOrgCode(codes = null) {
  if (codes) return nextOrgCodeFrom(codes);
  const SQL = "SELECT org_code FROM organizations WHERE org_code IS NOT NULL AND TRIM(org_code) <> ''";
  if (isMysql) return impl.arows(SQL).then((list) => nextOrgCodeFrom(list.map((item) => item.org_code)));
  return nextOrgCodeFrom(impl.rows(SQL).map((item) => item.org_code));
}

export const aq = impl.aq;
export const arows = impl.arows;
export const arow = impl.arow;
export const aone = impl.aone;
export const acount = impl.acount;
export const atransaction = impl.atransaction;

/** 测试夹具/迁移可用的裸执行（只有 mysql 驱动提供；sqlite 侧直接用 schema.js 的 db 句柄） */
export const rawExec = impl.rawExec || null;
export const dbConfig = impl.dbConfig || null;
export const ping = impl.ping || null;
export const closePool = impl.closePool || (async () => {});

function syncUnavailable(name) {
  return (..._args) => {
    throw new Error(
      `[数据层] 同步 API \`${name}()\` 在 DB_DRIVER=${dialect} 下不可用 —— 数据访问必须走异步 API`
      + '（aq/arows/arow/aone/acount/atransaction + await）。'
      + '阶段 1 已把应用与脚本全部改完；若这里是新写的代码，请直接用异步 API。',
    );
  };
}

/** sqlite 驱动下的同步 API 与裸句柄（脚本造夹具、schema.js 自己迁移都要用） */
export const db = isMysql ? null : impl.db;
export const q = isMysql ? syncUnavailable('q') : impl.q;
export const rows = isMysql ? syncUnavailable('rows') : impl.rows;
export const row = isMysql ? syncUnavailable('row') : impl.row;
export const one = isMysql ? syncUnavailable('one') : impl.one;
export const count = isMysql ? syncUnavailable('count') : impl.count;
export const transaction = isMysql ? syncUnavailable('transaction') : impl.transaction;

/** 启动时打一行，避免"以为连了 MySQL 其实还在用 SQLite"这种最常见的误判 */
if (isMysql) {
  console.log(`[数据层] 驱动 = mysql（${dbConfig?.host}:${dbConfig?.port}/${dbConfig?.database}，连接池 ${dbConfig?.connectionLimit}）`);
} else {
  console.log('[数据层] 驱动 = sqlite（转换期默认；设 DB_DRIVER=mysql 走 RDS）');
}
