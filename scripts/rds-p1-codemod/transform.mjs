// RDS 阶段 1 改造 · 转换器
//
// 两趟（各自重新解析，避免 offset 交叉）：
//   第 1 趟：数据访问改名 + 加 await + 补括号 + transaction→atransaction + 函数加 async + 调用点加 await + 补 import
//   第 2 趟：数组回调（forEach→for…of / map→await Promise.all）
//
// 安全设计：
//   · 所有编辑都是 {start,end,text}，**重叠即报错**（不猜），同一偏移的纯插入按优先级合并
//   · 从文件末尾往前应用，偏移不失效
//   · schema.js 整个跳过（它是异步层的**实现**，改了就是自己吃自己）
import fs from 'node:fs';
import path from 'node:path';
import { buildModel, SCHEMA_REL, SEQUENCING_METHODS } from './core.mjs';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const WITH_SCRIPTS = args.includes('--with-scripts');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const MODEL_OPTS = WITH_SCRIPTS ? { extraDirs: ['scripts'] } : {};

const ASYNC_OF = { q: 'aq', rows: 'arows', row: 'arow', one: 'aone', count: 'acount', transaction: 'atransaction' };
// amap 不是改名目标，而是 map→顺序 的落点（见 schema.js 里 amap 的注释）
const EXTRA_ASYNC = ['amap'];
const ASYNC_NAMES = [...Object.values(ASYNC_OF), ...EXTRA_ASYNC];
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

// ───────────────────────── 编辑收集 ─────────────────────────
const edits = new Map();   // file -> [{start,end,text,prio}]
function addEdit(file, start, end, text, prio = 5) {
  if (start > end) throw new Error(`非法编辑 ${file} ${start}>${end}`);
  if (!edits.has(file)) edits.set(file, []);
  edits.get(file).push({ start, end, text, prio });
}

const conflicts = [];
function applyEdits(code, list, file) {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.prio - b.prio || a.end - b.end);
  // 合并同一偏移的纯插入
  const merged = [];
  for (const e of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.start === e.start && last.end === e.start && e.end === e.start && last.prio <= e.prio) {
      last.text += e.text;
      continue;
    }
    merged.push({ ...e });
  }
  // 重叠检测
  for (let i = 1; i < merged.length; i += 1) {
    const prev = merged[i - 1], cur = merged[i];
    const prevEnd = prev.end, curStart = cur.start;
    if (curStart < prevEnd || (curStart === prevEnd && cur.end > cur.start && prev.end > prev.start)) {
      // 允许 [a,b) 紧跟 [b,c) 的相邻编辑
      if (curStart < prevEnd) conflicts.push({ file, prev, cur, code: code.slice(Math.max(0, prev.start - 40), cur.start + 40) });
    }
  }
  let out = code;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const e = merged[i];
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

// ───────────────────────── 第 1 趟 ─────────────────────────
function collectPass1(M) {
  const { mods, fns, mustAsync, fnByNode, parents } = M;
  const needImport = new Map();   // file -> Set(asyncName)
  const stats = { db: 0, txn: 0, asyncAdded: 0, awaitAdded: 0, parens: 0, txnFlagged: [], awaitBlocked: [] };

  const wantImport = (file, name) => {
    if (!needImport.has(file)) needImport.set(file, new Set());
    needImport.get(file).add(name);
  };

  for (const mod of mods.values()) {
    if (mod.file === SCHEMA_REL) continue;
    if (ONLY.length && !ONLY.includes(mod.file)) continue;

    // ① 函数加 async
    for (const fn of fns) {
      if (fn.file !== mod.file) continue;
      if (!mustAsync.has(fn.id) || fn.alreadyAsync) continue;
      addEdit(mod.file, fn.insertAt, fn.insertAt, 'async ', 4);
      stats.asyncAdded += 1;
    }

    // ② 数据访问调用：改名 + await + 括号
    for (const c of mod.dbCalls) {
      const name = c.name;
      const aName = ASYNC_OF[name];
      wantImport(mod.file, aName);
      const callee = c.node.callee;
      const needsParens = isInfixSensitive(parents, c.node);
      const prefix = `${needsParens ? '(' : ''}${c.awaited ? '' : 'await '}${aName}`;
      addEdit(mod.file, callee.start, callee.end, prefix, 2);
      if (needsParens) { addEdit(mod.file, c.node.end, c.node.end, ')', 6); stats.parens += 1; }
      stats.db += 1;
    }

    // ③ transaction → atransaction
    for (const t of mod.txnCalls) {
      const arg = t.node.arguments[0];
      const isFn = arg && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression');
      const isFnRef = arg && arg.type === 'Identifier' ? M.fnOfDecl(t.scope.lookup(arg.name), mod) : null;
      if (!isFn && !isFnRef) { stats.txnFlagged.push({ file: mod.file, line: lineOf(mod, t.node.start), text: mod.code.slice(t.node.start, t.node.start + 80) }); continue; }
      wantImport(mod.file, 'atransaction');
      const callee = t.node.callee;
      const needsParens = isInfixSensitive(parents, t.node);
      const prefix = `${needsParens ? '(' : ''}${t.awaited ? '' : 'await '}atransaction`;
      addEdit(mod.file, callee.start, callee.end, prefix, 2);
      if (needsParens) addEdit(mod.file, t.node.end, t.node.end, ')', 6);
      // ⚠️ 不在这里加 async：回调含数据访问 → 规则① 已加过。第一版两处都加，产出
      //    `async async () => {`，15 个文件全语法错。若回调本就不需要 async，
      //    `atransaction(fn)` 里是 `await fn()`，对同步函数同样成立，不加也是对的。
      stats.txn += 1;
    }

    // ④ 调用"必须 async 的函数"的地方补 await（数据访问/事务已在上面处理）
    const dbNodes = new Set([...mod.dbCalls, ...mod.txnCalls].map((c) => c.node));
    for (const site of mod.calls) {
      if (site.targetFnId == null) continue;
      if (!mustAsync.has(site.targetFnId)) continue;
      if (dbNodes.has(site.node)) continue;
      if (site.awaited) continue;
      const target = fns[site.targetFnId];
      if (target.file === SCHEMA_REL) continue;         // schema.js 的同步原语不 await
      if (target.alreadyAsync) continue;                 // 基线本来 async：原形态是有意的（见 core.mjs 同处注释）
      const pos = M.classifyPosition(site, parents);
      if (pos.blocked) { stats.awaitBlocked.push({ file: mod.file, line: lineOf(mod, site.node.start), why: pos.blocked, name: site.name }); continue; }
      const needsParens = isInfixSensitive(parents, site.node);
      addEdit(mod.file, site.node.start, site.node.start, `${needsParens ? '(' : ''}await `, 2);
      if (needsParens) addEdit(mod.file, site.node.end, site.node.end, ')', 6);
      stats.awaitAdded += 1;
    }

    // ⑤ `assert.throws(async () => …)` → `await assert.rejects(…)`
    //    assert.throws 只抓**同步**抛错：回调变 async 之后它抓不到 reject，
    //    表现是"Missing expected exception"（实测打挂 p76）。语义等价物是 assert.rejects。
    for (const cb of mod.callbackArgs) {
      if (cb.fnIdResolved == null || !mustAsync.has(cb.fnIdResolved)) continue;
      const call = mod.calls.find((s) => s.node === cb.node);
      if (!call?.member || call.methodName !== 'throws') continue;
      const obj = call.node.callee.object;
      if (!(obj.type === 'Identifier' && obj.name === 'assert')) continue;
      const prop = call.node.callee.property;
      addEdit(mod.file, prop.start, prop.end, 'rejects', 3);
      if (!call.awaited) {
        const needsParens = isInfixSensitive(parents, call.node);
        addEdit(mod.file, call.node.start, call.node.start, `${needsParens ? '(' : ''}await `, 2);
        if (needsParens) addEdit(mod.file, call.node.end, call.node.end, ')', 6);
      }
      stats.assertThrows = (stats.assertThrows || 0) + 1;
    }
  }
  return { stats, needImport };
}

function isInfixSensitive(parents, node) {
  const p = parents.get(node);
  if (!p) return false;
  if (p.type === 'MemberExpression' && p.object === node) return true;
  if (p.type === 'CallExpression' && p.callee === node) return true;
  if (p.type === 'NewExpression' && p.callee === node) return true;
  if (p.type === 'TaggedTemplateExpression' && p.tag === node) return true;
  return false;
}

function lineOf(mod, pos) { return mod.code.slice(0, pos).split('\n').length; }

// ───────────────────────── 第 2 趟：数组回调 ─────────────────────────
//
// 一律用"包住整段调用"的**整体替换**（而不是在被调用者身上插一段），因为：
//   · `(group.materials || []).forEach(…)` 这种**被括号包住**的数组，插入点会落到括号里面
//     → 产出 `(for (const …`（第一版就是这么错的）
//   · 整体替换后再把数组原文填回去，括号跟着原文一起走，不用猜
// 代价是**嵌套时必须最内层优先**（外层整段替换会盖掉内层），所以每趟只处理"内部再没有候选"的那些，
// 外层留给下一趟（重新解析后内层已经是 for…of 了）。
function hullParens(code, start, end) {
  for (;;) {
    let i = start - 1;
    while (i >= 0 && /\s/.test(code[i])) i -= 1;
    if (i < 0 || code[i] !== '(') return { start, end };
    const close = matchParen(code, i);
    let j = end;
    while (j < code.length && /\s/.test(code[j])) j += 1;
    if (close !== j) return { start, end };
    start = i; end = close + 1;
  }
}

// 这条 map 链**被显式 Promise.all 包着**吗？（有意的并发，不许改顺序）
function insidePromiseAll(parents, node) {
  let outer = node;
  for (;;) {
    const p = parents.get(outer);
    if (p && p.type === 'MemberExpression' && p.object === outer) {
      const gp = parents.get(p);
      outer = gp && gp.type === 'CallExpression' && gp.callee === p ? gp : p;
      continue;
    }
    break;
  }
  const call = parents.get(outer);
  if (!call || call.type !== 'CallExpression') return false;
  const callee = call.callee;
  if (!(callee.type === 'MemberExpression' && callee.object?.name === 'Promise' && callee.property?.name === 'all')) return false;
  return call.arguments.some((a) => a === outer);
}

// 已经是 `await Promise.all(<这条 map 链>)` 了吗？
function alreadyWrapped(parents, mod, mapCall) {
  let outer = mapCall;
  for (;;) {
    const p = parents.get(outer);
    if (p && p.type === 'MemberExpression' && p.object === outer) {
      const gp = parents.get(p);
      outer = gp && gp.type === 'CallExpression' && gp.callee === p ? gp : p;
      continue;
    }
    break;
  }
  const call = parents.get(outer);
  if (!call || call.type !== 'CallExpression') return false;
  const callee = call.callee;
  const wrapper = (callee.type === 'MemberExpression' && callee.object?.name === 'Promise' && callee.property?.name === 'all')
    || (callee.type === 'Identifier' && callee.name === 'amap');
  if (!wrapper) return false;
  if (call.arguments[0] !== outer) return false;
  return parents.get(call)?.type === 'AwaitExpression';
}

function matchParen(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return i; }
    else if (c === "'" || c === '"' || c === '`') {
      const q = c; i += 1;
      while (i < code.length && code[i] !== q) { if (code[i] === '\\') i += 1; i += 1; }
    } else if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i += 1; }
    else if (c === '/' && code[i + 1] === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1; i += 1; }
  }
  return -1;
}

function collectPass2(M) {
  const { mods, mustAsync, parents } = M;
  const stats = { forEach: 0, map: 0, flagged: [], skippedNested: 0 };
  const needImport = new Map();
  const wantImport = (file, name) => {
    if (!needImport.has(file)) needImport.set(file, new Set());
    needImport.get(file).add(name);
  };

  // 先收集全部候选，再只处理"内部没有别的候选"的那些（嵌套由外层下一趟处理）。
  // ⚠️ 已包过 Promise.all 的 map **不算候选**：`.map(` 还在，它永远"看着像候选"，
  //    既会被 alreadyWrapped 跳过、又会被当成挡住内层的祖先 → 内层永远轮不到（实测 12 处卡死）。
  const cands = [];
  for (const mod of mods.values()) {
    if (mod.file === SCHEMA_REL) continue;
    if (ONLY.length && !ONLY.includes(mod.file)) continue;
    for (const cb of mod.arrayCbs) {
      // ⚠️ 判据是**回调自己是不是 async**，不是"它访不访问数据库"：
      //    第 1 趟已经把 `row(...)` 改成了 `await arow(...)`，模型眼里"这里有数据访问"的信号就没了
      //    → 用 mustAsync 判会漏掉一大批（实测 74 处只剩 33 处被改编，p119 就是这么坏的）。
      const cbNode = cb.cbNode;
      const cbAsync = FUNCTION_TYPES.has(cbNode.type) ? Boolean(cbNode.async) : Boolean(cb.fnRec?.node?.async);
      const needs = cbAsync || (cb.fnIdResolved != null && mustAsync.has(cb.fnIdResolved));
      if (!needs) continue;
      // 已经被**显式** `Promise.all(…map(…))` 包住的：那是"有意并发"，不许改成顺序
      if (cb.method === 'map' && insidePromiseAll(M.parents, cb.node)) continue;
      cands.push({ mod, cb });
    }
  }
  const inner = (a, b) => a.start > b.start && a.end < b.end;
  const ready = cands.filter((c) => !cands.some((o) => o !== c && o.cb.node !== c.cb.node && inner(c.cb.node, o.cb.node)));
  stats.skippedNested = cands.length - ready.length;

  for (const { mod, cb } of ready) {
    const code = mod.code;
    if (cb.argIndex !== 0) { stats.flagged.push({ file: mod.file, line: lineOf(mod, cb.node.start), why: '回调不是第一个参数' }); continue; }
    if (cb.node.arguments.length > 1) { stats.flagged.push({ file: mod.file, line: lineOf(mod, cb.node.start), why: '有额外的 thisArg 参数' }); continue; }
    const cbNode = cb.cbNode;
    const fnNode = cb.fnRec.node;
    const body = fnNode.body;

    if (cb.method === 'forEach') {
      const p = parents.get(cb.node);
      if (!(p && p.type === 'ExpressionStatement' && p.expression === cb.node)) {
        stats.flagged.push({ file: mod.file, line: lineOf(mod, cb.node.start), why: 'forEach 不是独立语句，不能直接改成 for…of' });
        continue;
      }
      const arr = cb.node.callee.object;
      const hull = hullParens(code, arr.start, arr.end);
      const arrText = code.slice(hull.start, hull.end);

      // A. 传的是**函数引用**（`list.forEach(validate)`）：调用点没有函数体可搬 → 循环里调用它
      if (!FUNCTION_TYPES.has(cbNode.type)) {
        const refName = code.slice(cbNode.start, cbNode.end);
        const arity = fnNode.params.length;
        if (arity > 2) { stats.flagged.push({ file: mod.file, line: lineOf(mod, cb.node.start), why: `forEach 引用函数有 ${arity} 个参数` }); continue; }
        const args = arity === 2 ? '_item, _index' : arity === 1 ? '_item' : '';
        const pat = arity === 2 ? '[_index, _item]' : '_item';
        addEdit(mod.file, cb.node.start, cb.node.end, `for (const ${pat} of ${arrText}) await ${refName}(${args});`, 5);
        stats.forEach += 1;
        continue;
      }

      const params = fnNode.params.map((x) => code.slice(x.start, x.end));
      if (params.length > 2) { stats.flagged.push({ file: mod.file, line: lineOf(mod, cb.node.start), why: `forEach 回调有 ${params.length} 个参数` }); continue; }
      // ⚠️ 两个参数时是 (item, index)，而 `entries()` 给的是 **[index, value]** → 必须倒过来写。
      //    第一版写成 `[item, index]`：语法没错、运行不报错，但两个变量对调（静默算错）。
      const pat = params.length === 0 ? '_item' : params.length === 1 ? params[0] : `[${params[1]}, ${params[0]}]`;
      const iter = params.length === 2 ? `${arrText}.entries()` : arrText;
      const bodyText = code.slice(body.start, body.end);
      // 表达式体（`x.forEach(async (v) => await q(…))`）也要收：forEach 不会等它 → 悬空 Promise
      const tail = body.type === 'BlockStatement' ? bodyText : `{ ${bodyText}; }`;
      addEdit(mod.file, cb.node.start, cb.node.end, `for (const ${pat} of ${iter}) ${tail}`, 5);
      stats.forEach += 1;
      continue;
    }

    if (cb.method === 'map') {
      if (cb.node.arguments.length !== 1) { stats.flagged.push({ file: mod.file, line: lineOf(mod, cb.node.start), why: 'map 带了额外参数' }); continue; }
      const arr = cb.node.callee.object;
      const hull = hullParens(code, arr.start, arr.end);
      const arrText = code.slice(hull.start, hull.end);
      const cbText = code.slice(cbNode.start, cbNode.end);
      // 后缀链（`X.map(cb).filter(Boolean)`）：`.map(cb)` 那一段被换掉之后，链上的 .filter 要挂到
      // `amap(...)` 的结果上 —— 所以有尾巴时给 amap 的结果加一对括号。
      let outer = cb.node;
      for (;;) {
        const p = parents.get(outer);
        if (p && p.type === 'MemberExpression' && p.object === outer) {
          const gp = parents.get(p);
          if (gp && gp.type === 'CallExpression' && gp.callee === p) { outer = gp; continue; }
          outer = p; continue;
        }
        break;
      }
      const tail = code.slice(cb.node.end, outer.end);
      // 用**顺序版** amap，不用 await Promise.all(...)：后者让回调并发起跑，
      // 把「同步 map 本来是一个接一个」的顺序语义改掉（实测打挂 p101 的批次内重复检测）。
      // ⚠️ 是**替换** `.map(cb)`，不是包住 `.map(cb)` —— 第一版写成包住，等于给 amap 传了个数组
      //    却没传函数（`fn is not a function`，实测打挂 p9-r04 等 8 个脚本）。
      wantImport(mod.file, 'amap');
      const replaced = tail ? `(await amap(${arrText}, ${cbText}))${tail}` : `await amap(${arrText}, ${cbText})`;
      addEdit(mod.file, hull.start, outer.end, replaced, 5);
      stats.map += 1;
      continue;
    }
    stats.flagged.push({ file: mod.file, line: lineOf(mod, cb.node.start), why: `未处理的数组方法 ${cb.method}` });
  }
  return { stats, needImport };
}

// ───────────────────────── import 补名 ─────────────────────────
function addImportsNeeded(M, needImport) {
  const { mods } = M;
  const stats = { files: 0, flagged: [] };
  const libMods = new Set(['apps/server/src/lib.js', SCHEMA_REL]);
  for (const [file, names] of needImport) {
    const mod = mods.get(file);
    if (!mod) continue;
    // lib.js 交给 ensureLibExports 统一处理（它要 import + re-export 全部 6 个异步名）。
    // 两边都插会产出重复的 import 名 → `Identifier 'aq' has already been declared`。
    if (file === 'apps/server/src/lib.js') continue;
    // 找 source 解析到 lib.js / schema.js 的 import 声明（同步原语就是从那里来的）
    const candidates = [];
    for (const stmt of mod.ast.body) {
      if (stmt.type !== 'ImportDeclaration') continue;
      const src = stmt.source.value;
      let resolved = null;
      if (src === '@platform/database') resolved = SCHEMA_REL;
      else if (src.startsWith('.')) resolved = path.relative(process.cwd(), path.resolve(path.dirname(mod.abs), src)).replaceAll('\\', '/');
      if (resolved && libMods.has(resolved)) candidates.push(stmt);
    }
    if (!candidates.length) {
      // 脚本大量用**解构式动态 import**：`const { q, row } = await import('../apps/server/src/lib.js')`。
      // 这种没有静态 import 声明可补，要把异步名加进那个解构模式里（否则跑起来 `aq is not defined`）。
      const patterns = [];
      (function find(node) {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'VariableDeclarator') {
          const init = node.init;
          const importArg = (() => {
            const arg = init?.type === 'AwaitExpression' ? init.argument : null;
            if (!arg) return null;
            if (arg.type === 'ImportExpression') return arg.source;
            if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier' && M.mods.get(mod.file)?.loaders?.has(arg.callee.name)) return arg.arguments[0] ?? null;
            return null;
          })();
          if (importArg && node.id.type === 'ObjectPattern') {
            const srcNode = importArg;
            // 脚本里还有"算出来的路径"：pathToFileURL(path.join(root, 'apps/server/src/lib.js')).href
            const src = srcNode?.type === 'Literal' ? String(srcNode.value) : M.repoPathFromExpr(srcNode);
            let resolved = null;
            if (src === '@platform/database') resolved = SCHEMA_REL;
            else if (src?.startsWith('.')) resolved = path.relative(process.cwd(), path.resolve(path.dirname(mod.abs), src)).replaceAll('\\', '/');
            else if (src) resolved = src.replaceAll('\\', '/');
            if (resolved && libMods.has(resolved)) patterns.push(node.id);
          }
        }
        for (const k of Object.keys(node)) {
          if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
          const c = node[k];
          if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') find(x); }
          else if (c && typeof c.type === 'string') find(c);
        }
      })(mod.ast);
      if (!patterns.length) { stats.flagged.push({ file, names: [...names], why: '找不到 lib.js / schema.js 的 import（静态与解构动态都没有）' }); continue; }
      const pat = patterns[0];
      const existing = new Set(pat.properties.map((p) => (p.key?.type === 'Identifier' ? p.key.name : p.key?.value)));
      const missing = [...names].filter((n) => !existing.has(n));
      if (!missing.length) continue;
      const last = pat.properties[pat.properties.length - 1];
      addEdit(file, last.end, last.end, `, ${missing.join(', ')}`, 7);
      stats.files += 1;
      continue;
    }
    const stmt = candidates[0];
    const existing = new Set();
    for (const s of stmt.specifiers) if (s.type === 'ImportSpecifier') existing.add(s.imported.name);
    const missing = [...names].filter((n) => !existing.has(n));
    if (!missing.length) continue;
    const named = stmt.specifiers.filter((s) => s.type === 'ImportSpecifier');
    if (!named.length) { stats.flagged.push({ file, names: missing, why: '该 import 没有具名部分' }); continue; }
    const last = named[named.length - 1];
    addEdit(file, last.end, last.end, `, ${missing.join(', ')}`, 7);
    stats.files += 1;
  }
  return stats;
}

// lib.js 自己要 import 并 re-export 异步 API
function ensureLibExports(M) {
  const lib = M.mods.get('apps/server/src/lib.js');
  if (!lib) return { ok: false };
  const importStmt = lib.ast.body.find((s) => s.type === 'ImportDeclaration' && s.source.value.includes('packages/database/src/schema.js'));
  const exportStmt = lib.ast.body.find((s) => s.type === 'ExportNamedDeclaration' && !s.declaration && s.specifiers?.some((x) => x.local.name === 'transaction'));
  const res = { importFound: !!importStmt, exportFound: !!exportStmt };
  if (importStmt) {
    const have = new Set(importStmt.specifiers.filter((s) => s.type === 'ImportSpecifier').map((s) => s.imported.name));
    const missing = ASYNC_NAMES.filter((n) => !have.has(n));
    if (missing.length) {
      const named = importStmt.specifiers.filter((s) => s.type === 'ImportSpecifier');
      addEdit(lib.file, named[named.length - 1].end, named[named.length - 1].end, `, ${missing.join(', ')}`, 7);
      res.importAdded = missing;
    }
  }
  if (exportStmt) {
    const have = new Set(exportStmt.specifiers.map((s) => s.local.name));
    const missing = ASYNC_NAMES.filter((n) => !have.has(n));
    if (missing.length) {
      const last = exportStmt.specifiers[exportStmt.specifiers.length - 1];
      addEdit(lib.file, last.end, last.end, `, ${missing.join(', ')}`, 7);
      res.exportAdded = missing;
    }
  }
  return res;
}

// ───────────────────────── 主流程 ─────────────────────────
function runPass(n) {
  edits.clear();
  conflicts.length = 0;
  const M = buildModel(MODEL_OPTS);
  let stats;
  if (n === 1) {
    const dbNodes = new Set();
    const r1 = collectPass1(M);
    stats = r1.stats;
    const im = addImportsNeeded(M, r1.needImport);
    stats.importFiles = im.files;
    stats.importFlagged = im.flagged;
    stats.lib = ensureLibExports(M);
  } else {
    const r2 = collectPass2(M);
    stats = r2.stats;
    const im = addImportsNeeded(M, r2.needImport);
    stats.importFiles = im.files;
    stats.importFlagged = im.flagged;
  }

  if (conflicts.length) {
    console.log(`\n❌ 编辑范围重叠 ${conflicts.length} 处（不写盘）：`);
    for (const c of conflicts.slice(0, 10)) console.log(`   ${c.file} [${c.prev.start},${c.prev.end}) vs [${c.cur.start},${c.cur.end})  …${c.code.replace(/\s+/g, ' ')}…`);
    return { ok: false, stats };
  }

  let changed = 0;
  for (const [file, list] of edits) {
    const mod = M.mods.get(file);
    if (!mod) continue;
    const out = applyEdits(mod.code, list, file);
    if (out !== mod.code) { changed += 1; if (WRITE) fs.writeFileSync(mod.abs, out, 'utf8'); }
  }
  return { ok: true, stats, changed, files: edits.size };
}

const mode = WRITE ? '写入' : '试运行（不写盘）';
console.log(`=== 第 1 趟（${mode}）===`);
const p1 = runPass(1);
console.log(JSON.stringify(p1.stats, null, 1));
console.log(`改动文件数：${p1.changed ?? 0}`);
if (!p1.ok) process.exit(1);

if (WRITE) {
  // 第 2 趟要**反复跑**：嵌套的 map/forEach 每趟只处理最内层（外层整段替换会盖掉内层），
  // 每趟重新解析，直到没有候选为止。收敛靠"候选数单调下降"，跑飞了会在这里暴露。
  for (let round = 1; round <= 8; round += 1) {
    console.log(`\n=== 第 2 趟（第 ${round} 轮，${mode}）===`);
    const p2 = runPass(2);
    const s = p2.stats;
    console.log(`  forEach ${s.forEach ?? 0} · map ${s.map ?? 0} · 本轮跳过（嵌套，留给下一轮）${s.skippedNested ?? 0} · 改动文件 ${p2.changed ?? 0}`);
    if (s.flagged?.length) {
      console.log(`  ⚠️ 需人工：${s.flagged.length}`);
      for (const f of s.flagged) console.log(`     ${f.file}:${f.line}  ${f.why}`);
    }
    if (!p2.ok) process.exit(1);
    if ((s.forEach ?? 0) + (s.map ?? 0) === 0) break;
  }
}
