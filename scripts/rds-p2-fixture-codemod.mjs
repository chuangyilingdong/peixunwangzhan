// RDS 阶段 2 改造工具：把验收脚本里的**同步 SQLite 夹具**改成驱动无关的异步数据层 API。
//
// 为什么需要它：155 个验收脚本里有 76 个直接用 `new DatabaseSync(dbPath)` + `db.prepare(sql).run(...)`
// 造夹具（**同步**写法）。MySQL 驱动下这些夹具写进了一个没人看的 SQLite 文件，而应用读的是 MySQL
// → 脚本表现成"数据不存在"（p78 读到的 student 是 undefined）。要让"全量套件在 MySQL 上跑"成立，
// 这些夹具必须走**和应用同一个库**。
//
// 转换规则（全部按 AST 判定，不靠正则 —— Map.get / arr.run 这类同名方法必须区分开）：
//   const db = new DatabaseSync(path)        → 删掉（改用数据层连接；path 由 PLATFORM_DB_PATH / MYSQL_* 决定）
//   db.prepare(SQL).run(a, b)                → await aq(SQL, [a, b])      ← 变参要包成数组！
//   db.prepare(SQL).get(a)                   → await arow(SQL, [a])
//   db.prepare(SQL).all(a)                   → await arows(SQL, [a])
//   db.exec(SQL)                             → await aq(SQL)
//   db.exec('PRAGMA …') / db.prepare('PRAGMA …')  → 删掉（SQLite 专有调优，MySQL 用连接池参数）
//   db.close()                               → 删掉（进程退出由包装层关池）
// 另外：`node:sqlite` 的 import 与 `await` 引入的 async 传播（函数要变 async、调用者要 await）一起处理。
//
//
// ⚠️ **2026-09-24 状态：这个工具还没跑完最后一步**（实测记录，别重复踩）：
//    试运行 → 写盘 → SQLite 快速套件从 12/12 掉到 7/12。原因是**一个系统性缺口**：
//    `scripts/lib/classroomFixture.mjs` 的 `openDb()` 把句柄 **return 出去**，
//    而工具当时只认"`const x = new DatabaseSync(...)`"这一种来源 → 删掉了函数里的声明、
//    留下 `return db` → ReferenceError，一次打挂 5 个脚本（p78/p119/p112/p127/p52 都共用它）。
//    现已补上"返回句柄的助手"识别（会**显式报出来**要求人工确认，而不是静默改坏），
//    但**还没有重新跑过完整验证**。下一轮请：先 `--write`，再立刻跑
//    `node scripts/acceptance-suite.mjs --tag=before`（改前基线）+ `--compare`，
//    并且**先修 classroomFixture.mjs 那个助手本身**（它应当改成把 aq/arow/arows 交给调用方）。
//
// 用法：
//   node scripts/rds-p2-fixture-codemod.mjs              # 试运行（不写盘）
//   node scripts/rds-p2-fixture-codemod.mjs --write      # 写盘
//   node scripts/rds-p2-fixture-codemod.mjs --list       # 只列要改的地方
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel } from './rds-p1-codemod/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const LIST = process.argv.includes('--list');

const edits = new Map();     // file -> [{start,end,text,prio}]
const flags = [];
function add(file, start, end, text, prio = 5) {
  if (!edits.has(file)) edits.set(file, []);
  edits.get(file).push({ start, end, text, prio });
}
function applyAll(code, list) {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.prio - b.prio || a.end - b.end);
  const merged = [];
  for (const e of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.start === e.start && last.end === e.start && e.end === e.start && last.prio <= e.prio) { last.text += e.text; continue; }
    merged.push({ ...e });
  }
  for (let i = 1; i < merged.length; i += 1) {
    if (merged[i].start < merged[i - 1].end) throw new Error(`编辑重叠：${JSON.stringify(merged[i - 1])} vs ${JSON.stringify(merged[i])}`);
  }
  let out = code;
  for (let i = merged.length - 1; i >= 0; i -= 1) out = out.slice(0, merged[i].start) + merged[i].text + out.slice(merged[i].end);
  return out;
}

/** 参数列表 → 数组字面量文本（变参要包起来；单个数组字面量原样用） */
const paramsText = (code, args) => {
  if (args.length === 0) return null;
  if (args.length === 1 && args[0].type === 'ArrayExpression') return code.slice(args[0].start, args[0].end);
  return `[${args.map((a) => code.slice(a.start, a.end)).join(', ')}]`;
};
const sqlText = (code, arg) => code.slice(arg.start, arg.end);

const stats = { files: 0, prepareRun: 0, prepareGet: 0, prepareAll: 0, exec: 0, pragma: 0, close: 0, dbDecl: 0, asyncAdded: 0, awaitAdded: 0, importsFixed: 0, flagged: 0 };

const model = buildModel({ extraDirs: ['scripts'] });
const { mods, parents, fns, fnByNode, edges, mustAsync } = model;

// ⚠️ 排除 p80：它把服务器函数**从源码里切出来**、用**内存 SQLite** 喂假依赖做单测
//    （夹具是自己 CREATE TABLE/INSERT，不碰应用的库）。它的 in-memory 用法是"这套单测成立的前提"，
//    改成 MySQL 反而变成另一件事 —— 它已经单独注入过 arow/arows/aq/atransaction/amap（见文件内注释）。
const EXCLUDE = new Set([
  'scripts/p80-platform-works.mjs',
  // 本套工具自己也要排除：mysql-test-db.mjs **就是要**用只读 SQLite 句柄去读那张夹具库
  //   （它把"schema.js 导入期写的默认行"从 SQLite 搬进 MySQL）；被改成走数据层就没意义了。
  'scripts/mysql-test-db.mjs',
  'scripts/acceptance-suite.mjs',
  'scripts/acceptance-script-wrapper.mjs',
  'scripts/rds-p2-fixture-codemod.mjs',
]);

// ─────────────────── 跨文件预扫：谁会把 SQLite 句柄 **return** 出去（2026-09-24 补）───────────────────
// 这是实测踩到、并且一次打挂 5 个脚本的那个缺口：`scripts/lib/classroomFixture.mjs` 的 `openDb()`
// 把句柄 return 出去，而**调用方在别的文件**。只在单文件内找 producer 的话：
//   · 调用方 `const db = openDb(p); db.prepare(…)` 一个都不转换、声明也不删；
//   · 夹具那边 openDb 自己的 `const db = new DatabaseSync(…)` 被删掉 → 留下 `return db` → ReferenceError。
// 做法：先扫全量算出"返回句柄的函数名"，主循环里凡是**导入了这些名字**的文件都把它们当句柄来源。
const dbVarsOf = (mod) => {
  const vars = new Set();
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && node.init?.type === 'NewExpression'
      && node.init.callee?.type === 'Identifier' && node.init.callee.name === 'DatabaseSync'
      && node.id.type === 'Identifier') vars.add(node.id.name);
    for (const k of Object.keys(node)) {
      if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
      const c = node[k];
      if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') walk(x); }
      else if (c && typeof c.type === 'string') walk(c);
    }
  })(mod.ast);
  for (const [local, imp] of mod.imports) {
    if (local === 'db' && String(imp.source).includes('schema.js')) vars.add('db');
  }
  return vars;
};
const dbVarsByFile = new Map([...mods].map(([f, m]) => [f, dbVarsOf(m)]));
const handleProducersGlobal = new Map();   // 函数名 → 定义文件（跨文件用）
for (const fn of fns) {
  if (!fn.name || !fn.node?.body) continue;
  const vars = dbVarsByFile.get(fn.file);
  if (!vars?.size) continue;
  let returnsHandle = false;
  (function scan(node) {
    if (!node || typeof node.type !== 'string' || returnsHandle) return;
    if (node.type === 'ReturnStatement' && node.argument?.type === 'Identifier' && vars.has(node.argument.name)) { returnsHandle = true; return; }
    for (const k of Object.keys(node)) {
      if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
      const c = node[k];
      if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') scan(x); }
      else if (c && typeof c.type === 'string') scan(c);
    }
  })(fn.node.body);
  if (returnsHandle) handleProducersGlobal.set(fn.name, fn.file);
}
// 已知名单（扫描扫不到的）：夹具改造完之后 `openDb` 会变成一个**抛错的小壳**（不再 return 句柄），
// 于是扫不出来 —— 但它的历史调用点（`const db = openDb(p)`）仍然要能被识别并删掉声明。
for (const name of ['openDb']) if (!handleProducersGlobal.has(name)) handleProducersGlobal.set(name, 'scripts/lib/classroomFixture.mjs');
if (handleProducersGlobal.size) {
  console.log(`跨文件的"返回句柄"助手：${[...handleProducersGlobal].map(([n, f]) => `${n}@${f}`).join(', ')}`);
}

for (const [file, mod] of mods) {
  if (!file.startsWith('scripts/')) continue;
  if (EXCLUDE.has(file)) continue;
  const code = mod.code;
  if (!/new DatabaseSync|node:sqlite/.test(code)) continue;

  // ① 找出"就是 SQLite 句柄"的那些变量名（`const db = new DatabaseSync(…)`）
  const dbVars = new Set();
  const dbDecls = [];
  (function walk(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && node.init?.type === 'NewExpression'
      && node.init.callee?.type === 'Identifier' && node.init.callee.name === 'DatabaseSync'
      && node.id.type === 'Identifier') {
      dbVars.add(node.id.name);
      dbDecls.push({ declarator: node, parent });   // 记下父节点：模型里没给声明符记父节点
    }
    for (const k of Object.keys(node)) {
      if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
      const c = node[k];
      if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') walk(x, node); }
      else if (c && typeof c.type === 'string') walk(c, node);
    }
  })(mod.ast, null);

  // 也认从应用里拿到的 `db`（import { db } from '../../packages/database/src/schema.js'）
  for (const [local, imp] of mod.imports) {
    if (local === 'db' && String(imp.source).includes('schema.js')) dbVars.add('db');
  }

  // ①a **由函数返回的句柄**：`function openDb(p) { const h = new DatabaseSync(p); return h; }`
  //     这是实测踩到的缺口 —— 只认 `const x = new DatabaseSync(...)` 的话，
  //     `const db = openDb(p)` 这种就漏了（删掉了函数里的声明、留下 `return h` → ReferenceError，
  //     一次打挂 5 个脚本：p78/p119/p112/p127/p52 都共用 scripts/lib/classroomFixture.mjs 的 openDb）。
  //     做法：先找出"返回句柄"的函数，再把这些函数的调用结果也算作句柄（含跨文件、含再传一层）。
  const handleProducers = new Set();   // 返回句柄的函数名（本文件内）
  for (const fn of fns) {
    if (fn.file !== file || !fn.name) continue;
    let returnsHandle = false;
    (function scan(node) {
      if (!node || typeof node.type !== 'string' || returnsHandle) return;
      if (node.type === 'ReturnStatement' && node.argument?.type === 'Identifier' && dbVars.has(node.argument.name)) { returnsHandle = true; return; }
      for (const k of Object.keys(node)) {
        if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
        const c = node[k];
        if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') scan(x); }
        else if (c && typeof c.type === 'string') scan(c);
      }
    })(fn.node.body);
    if (returnsHandle) handleProducers.add(fn.name);
  }
  // 再把**导入来的**句柄助手算进去（跨文件预扫的结果）——`const db = openDb(p)` 就靠这一步
  for (const [local] of mod.imports) if (handleProducersGlobal.has(local)) handleProducers.add(local);
  if (handleProducers.size) {
    // 传递：`const db = openDb(p)` / `const db = helper(openDb(p))` 里的名字都算句柄
    let grew = true;
    while (grew) {
      grew = false;
      (function scan(node, parent) {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
          const src = code.slice(node.init.start, node.init.end);
          for (const prod of handleProducers) {
            if (new RegExp(`\\b${prod}\\s*\\(`).test(src) && !dbVars.has(node.id.name)) {
              dbVars.add(node.id.name);
              // 这个声明也要删（`const db = openDb(p);`）——它的用法会被逐个转成数据层调用，
              // 句柄本身不再需要；留着反而会引用一个已经不存在的函数/坏句柄。
              dbDecls.push({ declarator: node, parent });
              grew = true;
            }
          }
        }
        for (const k of Object.keys(node)) {
          if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
          const c = node[k];
          if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') scan(x, node); }
          else if (c && typeof c.type === 'string') scan(c, node);
        }
      })(mod.ast, null);
    }
  }
  if (handleProducers.size) flags.push(`${file} 有"返回句柄"的助手（${[...handleProducers].join(',')}）—— 请人工确认它的调用方是否都已改成数据层 API`);

  if (!dbVars.size) continue;
  stats.files += 1;

  // ①b `const stmt = db.prepare(SQL)` 这种先存变量、之后用变量 `.run()` 的形态
  //     （实测 p111/p119/p58/p61 —— 光认链式写法会漏掉它们）
  const stmtVars = new Map();   // 变量名 -> { sqlNode, declParent }
  (function scan(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'CallExpression'
      && node.init.callee?.type === 'MemberExpression' && node.init.callee.object?.type === 'Identifier'
      && dbVars.has(node.init.callee.object.name) && node.init.callee.property?.name === 'prepare' && node.init.arguments[0]) {
      stmtVars.set(node.id.name, { sqlNode: node.init.arguments[0], declParent: parent });
    }
    for (const k of Object.keys(node)) {
      if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
      const c = node[k];
      if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') scan(x, node); }
      else if (c && typeof c.type === 'string') scan(c, node);
    }
  })(mod.ast, null);

  // ② 收集要改的调用点
  const replacements = [];
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.type === 'Identifier' && dbVars.has(node.callee.object.name)) {
      const method = node.callee.property?.name;
      const recv = node.callee.object;

      // `const stmt = db.prepare(SQL)` 里的那一处：已登记为变量形态（见 ①b），这里不该报未处理
      const isStmtInit = (() => {
        for (const [, info] of stmtVars) if (info.sqlNode === node.arguments[0]) return true;
        return false;
      })();
      if (isStmtInit && method === 'prepare') return;

      // db.prepare(SQL).run/get/all(…)
      if (method === 'prepare' && node.arguments[0]) {
        const p = parents.get(node);
        if (p?.type === 'MemberExpression' && p.object === node && !p.computed
          && ['run', 'get', 'all'].includes(p.property?.name)) {
          const outer = parents.get(p);
          if (outer?.type === 'CallExpression' && outer.callee === p) {
            const fn = { run: 'aq', get: 'arow', all: 'arows' }[p.property.name];
            const params = paramsText(code, outer.arguments);
            const replacement = `await ${fn}(${sqlText(code, node.arguments[0])}${params ? `, ${params}` : ''})`;
            replacements.push({ start: node.start, end: outer.end, text: replacement });
            if (p.property.name === 'run') stats.prepareRun += 1;
            else if (p.property.name === 'get') stats.prepareGet += 1;
            else stats.prepareAll += 1;
            return;   // 不再往里走
          }
        }
      }
      // db.exec(SQL) → await aq(SQL)；PRAGMA 直接删
      if (method === 'exec' && node.arguments[0]) {
        const text = sqlText(code, node.arguments[0]);
        if (/PRAGMA/i.test(text)) {
          // 删掉整条语句（含分号）
          const stmt = parents.get(node);
          const end = stmt?.type === 'ExpressionStatement' ? stmt.end : node.end;
          replacements.push({ start: stmt?.type === 'ExpressionStatement' ? stmt.start : node.start, end, text: '', kind: 'pragma' });
          stats.pragma += 1;
        } else {
          replacements.push({ start: node.start, end: node.end, text: `await aq(${text})` });
          stats.exec += 1;
          if (/;\s*\S/.test(text.replace(/;\s*$/, ''))) flags.push(`${file}:${code.slice(0, node.start).split('\n').length} exec 里像是有多条语句 —— MySQL 预处理只跑一条，请人工确认`);
        }
        return;
      }
      // db.close() → 删
      if (method === 'close') {
        const stmt = parents.get(node);
        replacements.push({ start: stmt?.type === 'ExpressionStatement' ? stmt.start : node.start, end: stmt?.type === 'ExpressionStatement' ? stmt.end : node.end, text: '' });
        stats.close += 1;
        return;
      }
      flags.push(`${file}:${code.slice(0, node.start).split('\n').length} 未处理的 sqlite 句柄用法：${method}(…)`);
      return;
    }
    // 变量形态：`stmt.run(…)` / `stmt.get(…)` / `stmt.all(…)`
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.type === 'Identifier' && stmtVars.has(node.callee.object.name)) {
      const method = node.callee.property?.name;
      if (['run', 'get', 'all'].includes(method)) {
        const { sqlNode } = stmtVars.get(node.callee.object.name);
        const fn = { run: 'aq', get: 'arow', all: 'arows' }[method];
        const params = paramsText(code, node.arguments);
        replacements.push({ start: node.start, end: node.end, text: `await ${fn}(${sqlText(code, sqlNode)}${params ? `, ${params}` : ''})` });
        if (method === 'run') stats.prepareRun += 1; else if (method === 'get') stats.prepareGet += 1; else stats.prepareAll += 1;
        return;
      }
    }
    for (const k of Object.keys(node)) {
      if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
      const c = node[k];
      if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') walk(x); }
      else if (c && typeof c.type === 'string') walk(c);
    }
  })(mod.ast);

  // 变量形态：把 `const stmt = db.prepare(SQL);` 声明本身删掉（SQL 已内联进每个调用点）
  for (const [, info] of stmtVars) {
    const stmt = info.declParent?.type === 'VariableDeclaration' ? info.declParent : null;
    if (!stmt) { flags.push(`${file} 变量形态的 prepare 声明删不掉，请人工看`); continue; }
    replacements.push({ start: stmt.start, end: stmt.end, text: '' });
  }

  // ②b 补数据层 import（**必须是"设好 env 之后"的顶层 await import**，不能是静态 import：
  //     ESM 的静态 import 会被提升到最前面 → 数据层会在 PLATFORM_DB_PATH 还没设好时加载
  //     → 走到仓库的 data/platform.db 上去，那是事故）。
  const needsStore = /aq\(|arow\(|arows\(/.test(replacements.map((r) => r.text).join(' '));
  if (needsStore) {
    const hasStoreImport = /import\([^)]*store\.js/.test(code);
    if (!hasStoreImport) {
      // 插入点：最后一个顶层 `process.env.PLATFORM_*` 赋值之后；没有就放在最后一个 import 之后
      let insertAt = 0;
      for (const stmt of mod.ast.body) {
        const text = code.slice(stmt.start, stmt.end);
        if (/^(import|const .*await import)/.test(text.trim())) insertAt = Math.max(insertAt, stmt.end);
        if (/^process\.env\.PLATFORM_(DB_PATH|DATA_DIR)\s*=/.test(text.trim())) insertAt = Math.max(insertAt, stmt.end);
      }
      add(file, insertAt, insertAt, [
        '',
        '// RDS 阶段 2：夹具改用数据层（同一个库、驱动无关）。必须是设好 PLATFORM_DB_PATH 之后的**动态** import',
        "const { aq, arow, arows } = await import('../packages/database/src/store.js');",
        '',
      ].join('\n'), 1);
      stats.importsFixed += 1;
    }
    // 把脚本自己那份 dbPath 回填进 env（standalone 跑时不会误动仓库里的库；harness 已设则不动它）
    const dbPathAssign = code.match(/(?:const|let|var)\s+(\w*[Pp]ath\w*)\s*=\s*[^;]*platform\.db[^;]*;/);
    if (dbPathAssign && !/PLATFORM_DB_PATH\s*\|\|=/.test(code)) {
      const stmt = mod.ast.body.find((x) => code.slice(x.start, x.end).includes(dbPathAssign[0]));
      if (stmt) add(file, stmt.end, stmt.end, `
process.env.PLATFORM_DB_PATH ||= ${dbPathAssign[1]};`, 1);
    }
  }

  // ③ 删掉 `const db = new DatabaseSync(path);` 整条声明
  for (const { declarator: d, parent } of dbDecls) {
    const stmt = parent;
    if (stmt?.type === 'VariableDeclaration') {
      const outer = parents.get(stmt);
      replacements.push({ start: outer?.type === 'ExpressionStatement' ? outer.start : stmt.start, end: outer?.type === 'ExpressionStatement' ? outer.end : stmt.end, text: '' });
      stats.dbDecl += 1;
    } else {
      flags.push(`${file} 无法安全删除 new DatabaseSync 声明（不是独立语句）`);
    }
  }

  if (LIST) {
    for (const r of replacements) console.log(`${file}:${code.slice(0, r.start).split('\n').length}  ${code.slice(r.start, Math.min(r.end, r.start + 60)).replace(/\s+/g, ' ')}  →  ${r.text.slice(0, 60) || '(删)'}`);
    continue;
  }
  // ⚠️ 嵌套要**最内层优先**：`db.prepare(…).run(…, db.prepare(…).get().id, …)` 里内层在外层实参里，
  //    同一轮都改会重叠（实测 p124 就是这样）。这里只处理"内部没有别的替换"的那些，外层留给下一轮。
  const inner = (a, b) => a.start > b.start && a.end < b.end;
  const todo = replacements.filter((r) => !replacements.some((o) => o !== r && o.kind !== 'pragma' && inner(r, o)));
  for (const r of todo) add(file, r.start, r.end, r.text, r.kind === 'pragma' ? 1 : 5);
}

// ④ async 传播（**关键一步，漏了它夹具会静默算错**）：夹具改完后，
//    "直接含 await 的函数"必须变 async，而**调用它们的每一个地方都要补 await** ——
//    否则 `Number(readRow(…))` 这种就会拿 Promise 去算（= NaN），语法不报错、运行也不报错。
//    与阶段 1 同一套机制：先用调用图求不动点（含跨文件：脚本会 import scripts/lib/*.mjs 里的夹具助手），
//    再给函数加 async、给调用点加 await。
if (!LIST) {
  // ④a 种子：包含被改写调用的函数
  const seed = new Set();
  for (const [file, list] of edits) {
    for (const e of list) {
      let best = null;
      for (const fn of fns) {
        if (fn.file !== file) continue;
        if (fn.node.start <= e.start && e.start <= fn.node.end) {
          if (!best || (fn.node.end - fn.node.start) < (best.node.end - best.node.start)) best = fn;
        }
      }
      if (best) seed.add(best.id);   // 顶层（不在任何函数里）不需要 async：ESM 顶层 await 合法
    }
  }
  // ④a′ **手改过的夹具助手**：`scripts/lib/classroomFixture.mjs` 的 ensureClassroom / switchClassroom
  //     现在是 async（内部 await 数据层），但**模型认不出**它们里面的数据层调用 ——
  //     那里用的是 `const { aq } = await store()` 这种**动态 import 解构**（必须动态：静态 import
  //     会被提升到最前面 → 数据层在 env 设好之前加载 → 走到仓库里的 data/platform.db，那是事故）。
  //     模型认不出 → mustAsync 里没有它们 → 调用点不补 await → **夹具写库与服务启动抢跑**（不报错）。
  //     所以按名字把这两个函数并进种子，④c/④d 就会给它们的调用点补 async / await。
  //     ⚠️ 只认这一个夹具文件，别把 add() 的范围放大到 apps/ 或 packages/ 的生产源码上。
  const FIXTURE_HELPERS = new Set(['ensureClassroom', 'switchClassroom']);
  let helperSeeded = 0;
  for (const fn of fns) {
    if (fn.file === 'scripts/lib/classroomFixture.mjs' && FIXTURE_HELPERS.has(fn.name)) { seed.add(fn.id); helperSeeded += 1; }
  }
  if (helperSeeded) flags.push(`已把夹具助手 ${[...FIXTURE_HELPERS].join('/')} 并进 async 种子（${helperSeeded} 个）——它们的调用点会补上 await`);
  // ④b 不动点：谁调用了（直接或间接）这些函数，谁也要 async
  const rev = new Map();
  for (const [from, tos] of edges) for (const to of tos) { if (!rev.has(to)) rev.set(to, new Set()); rev.get(to).add(from); }
  const willBeAsync = new Set(seed);
  const work = [...seed];
  while (work.length) {
    const id = work.pop();
    for (const caller of rev.get(id) || []) if (!willBeAsync.has(caller)) { willBeAsync.add(caller); work.push(caller); }
  }
  // ④c 加 async
  for (const id of willBeAsync) {
    const fn = fns[id];
    if (!fn || fn.alreadyAsync) continue;
    add(fn.file, fn.insertAt, fn.insertAt, 'async ', 4);
    stats.asyncAdded += 1;
  }
  // ④d 给"调用这些函数"的调用点补 await（带括号规则：被当成对象/被调用时才加括号）
  const needsParens = (node) => {
    const p = parents.get(node);
    if (!p) return false;
    if (p.type === 'MemberExpression' && p.object === node) return true;
    if (p.type === 'CallExpression' && p.callee === node) return true;
    if (p.type === 'NewExpression' && p.callee === node) return true;
    if (p.type === 'TaggedTemplateExpression' && p.tag === node) return true;
    return false;
  };
  for (const [file, mod] of mods) {
    if (!file.startsWith('scripts/')) continue;
    for (const site of mod.calls) {
      if (site.targetFnId == null || !willBeAsync.has(site.targetFnId)) continue;
      if (site.awaited) continue;
      const paren = needsParens(site.node);
      add(file, site.node.start, site.node.start, `${paren ? '(' : ''}await `, 2);
      if (paren) add(file, site.node.end, site.node.end, ')', 6);
      stats.awaitAdded += 1;
    }
  }
}

let changed = 0;
for (const [file, list] of edits) {
  const mod = mods.get(file);
  let out;
  try { out = applyAll(mod.code, list); }
  catch (error) { console.log(`❌ ${file}: ${error.message}`); continue; }
  if (out !== mod.code) { changed += 1; if (WRITE) fs.writeFileSync(mod.abs, out, 'utf8'); }
}
if (changed && !LIST) {
  // 嵌套那些留给下一轮（只处理最内层）→ 外层在下一轮（重新解析后内层已经改完）才处理
  const again = process.env.RDS_P2_ROUND === '2' ? null : '1';
  if (again) console.log('（有嵌套待下一轮：设 RDS_P2_ROUND=2 再跑一次即可）');
}

console.log(`阶段 2 夹具改造${WRITE ? '（已写盘）' : '（试运行）'}`);
console.log(`  文件 ${stats.files} 个（改动 ${changed}）`);
console.log(`  prepare().run ${stats.prepareRun} · .get ${stats.prepareGet} · .all ${stats.prepareAll} · exec ${stats.exec}`);
console.log(`  删 PRAGMA ${stats.pragma} · 删 close ${stats.close} · 删句柄声明 ${stats.dbDecl}`);
console.log(`  加 async 函数 ${stats.asyncAdded}`);
if (flags.length) {
  console.log(`\n⚠️ 需人工看 ${flags.length} 处：`);
  for (const f of flags.slice(0, 25)) console.log('   ' + f);
}
