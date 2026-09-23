// RDS 阶段 1 改造 · 分析核心（AST + 作用域 + 跨文件调用图）
//
// 为什么不是正则：改造不是"把 row( 换成 await arow("这一件事，而是**顺着调用链传播 async** ——
// 把一个函数改成 async 之后，它的**调用者**也得 await，而调用者不是数据访问调用，静态 grep 抓不到。
// 而且有几类位置加 await 是**语法错误或语义错误**的（参数默认值、getter、sort 比较器、
// forEach 回调、`.map()` 的返回值），必须按 AST 的父节点精确判定，正则一定会错。
//
// 设计：
//   ① 解析全部目标文件（apps/server/src + packages/database/src）→ AST
//   ② 建模块图：import/export（含 lib.js 那种"转出去"的 re-export 链）
//   ③ 建作用域树：把每个 row/rows/q/... 的**身份**解析到 schema.js 的导出，
//      而不是靠名字匹配（库里真有叫 `rows` 的局部变量时，正则就会认错）
//   ④ 调用图：函数节点 → 被它调用的函数节点（跨文件），求不动点得到"必须 async"的集合
//   ⑤ 把每处调用按父节点分类（要括号 / 是回调 / 在参数默认值里 / 是 sort 比较器……）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 解析器不在仓库里（**故意不动 lockfile**）：先 `npm i acorn@8 --prefix .tmp/codemod-deps`，
// 或用环境变量 RDS_CODEMOD_ACORN 指向任意一份 acorn。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

// 解析器不在仓库里（**故意不动 lockfile**）：先 `npm i acorn@8 --prefix .tmp/codemod-deps`，
// 或用环境变量 RDS_CODEMOD_ACORN 指向任意一份 acorn。
const acorn = require(process.env.RDS_CODEMOD_ACORN || path.join(ROOT, '.tmp/codemod-deps/node_modules/acorn'));

export const TARGET_DIRS = ['apps/server/src', 'packages/database/src'];
export const SCHEMA_REL = 'packages/database/src/schema.js';

// schema.js 里这几个名字就是"数据访问原语"。**只有解析到这几个身份**才算数据访问调用。
export const DB_FUNC_NAMES = new Set(['q', 'rows', 'row', 'one', 'count', 'transaction']);

// 数组方法：回调变成 async 之后语义会坏的（forEach 静默不等待、filter/sort 拿到 Promise……）
export const SEQUENCING_METHODS = new Set(['forEach', 'map', 'filter', 'flatMap', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'sort']);

export const relOf = (abs) => path.relative(ROOT, abs).replaceAll('\\', '/');

export function walkJsFiles(absDir, out = [], exts = new Set(['.js'])) {
  for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
    const full = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walkJsFiles(full, out, exts);
    } else if ([...exts].some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

// ─────────────────────────── 作用域 ───────────────────────────
class Scope {
  constructor(type, parent, node) {
    this.type = type;            // 'module' | 'function' | 'block'
    this.parent = parent;
    this.node = node;
    this.decls = new Map();      // name -> { kind, node, source?, imported?, file? }
    this.fnId = null;
  }
  declare(name, decl) { if (name && !this.decls.has(name)) this.decls.set(name, decl); }
  lookup(name) {
    for (let s = this; s; s = s.parent) { const d = s.decls.get(name); if (d) return d; }
    return null;
  }
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const BLOCK_SCOPE_TYPES = new Set(['BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'CatchClause', 'StaticBlock']);

function nearestFunctionScope(scope) {
  for (let s = scope; s; s = s.parent) if (s.type === 'function' || s.type === 'module') return s;
  return scope;
}

function declarePattern(pat, kind, scope, file) {
  if (!pat) return;
  switch (pat.type) {
    case 'Identifier': scope.declare(pat.name, { kind, node: pat, file }); break;
    case 'ObjectPattern': for (const p of pat.properties) declarePattern(p.type === 'RestElement' ? p.argument : p.value, kind, scope, file); break;
    case 'ArrayPattern': for (const el of pat.elements) declarePattern(el, kind, scope, file); break;
    case 'AssignmentPattern': declarePattern(pat.left, kind, scope, file); break;
    case 'RestElement': declarePattern(pat.argument, kind, scope, file); break;
    default: break;
  }
}

// ─────────────────────────── 单文件解析 + 遍历 ───────────────────────────
function parseOne(abs) {
  const code = fs.readFileSync(abs, 'utf8');
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    // 允许顶层 await：ESM 里合法，而且我们要能在模块顶层加 await（若有）
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
  });
  return { code, ast };
}

export function buildModel(opts = {}) {
  const dirs = [...TARGET_DIRS, ...(opts.extraDirs || [])];
  const mods = new Map();     // relPath -> module
  const fns = [];             // 函数记录（含箭头/表达式）
  const fnByNode = new Map();
  const parents = new Map();  // node -> parent
  const allNodes = new Map(); // 供 parent 反查

  for (const abs of dirs.flatMap((d) => walkJsFiles(path.join(ROOT, d), [], new Set(['.js', '.mjs'])))) {
    const rel = relOf(abs);
    const { code, ast } = parseOne(abs);
    const mod = {
      file: rel, abs, code, ast,
      imports: new Map(),      // localName -> { source, imported }
      exports: new Map(),      // exportName -> { kind, node?|source+imported+local? }
      scope: null,
      calls: [],               // { node, name, kind, scope, fnId, targetFnId, resolved }
      dbCalls: [],             // { node, name, fnId, awaited, fnRec }
      txnCalls: [],
      arrayCbs: [],            // { node, method, cbNode, fnId, argIndex, resultUsed }
      callbackArgs: [],        // { node, calleeName, calleeFnId, cbNode, fnId, argIndex, calleeResolved }
      refUses: [],             // 函数被当作**值**传递（不是调用）的地方
    };
    mods.set(rel, mod);
  }

  // ── 第一趟：遍历，建作用域 / 函数表 / 调用点 ──
  for (const mod of mods.values()) {
    const moduleScope = new Scope('module', null, mod.ast);
    mod.scope = moduleScope;
    collectTopLevelDecls(mod, moduleScope);
    const ctx = { mod, scope: moduleScope, fnId: null };
    for (const stmt of mod.ast.body) visit(stmt, ctx, null);
  }

  function recordParents(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    parents.set(node, parent);
  }

  function visitChildren(node, ctx, parent) {
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) { if (c && typeof c.type === 'string') { recordParents(c, node); visit(c, ctx, node); } }
      } else if (child && typeof child.type === 'string') { recordParents(child, node); visit(child, ctx, node); }
    }
  }

  function visit(node, ctx, parent) {
    if (!node || typeof node.type !== 'string') return;
    if (parent) recordParents(node, parent);
    const type = node.type;

    if (type === 'ImportDeclaration' || type === 'ExportNamedDeclaration' || type === 'ExportDefaultDeclaration' || type === 'ExportAllDeclaration') {
      if (node.declaration) { recordParents(node.declaration, node); visit(node.declaration, ctx, node); }
      return;
    }

    if (type === 'FunctionDeclaration') {
      // ⚠️ ESM 是严格模式：块里的函数声明**绑定在块作用域**，不是整个函数作用域
      ctx.scope.declare(node.id?.name, { kind: 'function', node, file: ctx.mod.file });
      enterFunction(node, ctx);
      return;
    }
    if (type === 'FunctionExpression' || type === 'ArrowFunctionExpression') { enterFunction(node, ctx); return; }

    if (type === 'ClassDeclaration' || type === 'ClassExpression') {
      if (node.id) ctx.scope.declare(node.id.name, { kind: 'class', node, file: ctx.mod.file });
      if (node.superClass) { recordParents(node.superClass, node); visit(node.superClass, ctx, node); }
      recordParents(node.body, node); visit(node.body, ctx, node);
      return;
    }

    if (type === 'VariableDeclaration') {
      const target = node.kind === 'var' ? nearestFunctionScope(ctx.scope) : ctx.scope;
      for (const d of node.declarations) {
        declarePattern(d.id, node.kind, target, ctx.mod.file);
        // `const write = () => {…}`：这个名字**绑定的是那个函数**，要能解析到函数节点
        if (d.init && FUNCTION_TYPES.has(d.init.type) && d.id.type === 'Identifier') {
          target.decls.set(d.id.name, { kind: 'fnvar', node: d.id, init: d.init, file: ctx.mod.file });
        }
        // 动态 import 的绑定：`const { q } = await import('…')` / `const seed = await import('…')`
        // （验收脚本大量用这种写法；不认的话 `seed.seedDatabase()` 这种调用会漏 await）
        const importArg = (() => {
          const arg = d.init?.type === 'AwaitExpression' ? d.init.argument : null;
          if (!arg) return null;
          if (arg.type === 'ImportExpression') return arg.source;
          // `await load('apps/server/src/x.js')`：加载器是 import 的包装，取它那个路径字面量
          if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier' && ctx.mod.loaders?.has(arg.callee.name)) return arg.arguments[0] ?? null;
          return null;
        })();
        if (importArg) {
          const srcNode = importArg;
          const source = srcNode?.type === 'Literal' ? String(srcNode.value) : repoPathFromExpr(srcNode);
          if (source) {
            if (d.id.type === 'ObjectPattern') {
              for (const p of d.id.properties) {
                const key = p.key?.type === 'Identifier' ? p.key.name : (p.key?.value ?? null);
                if (key && p.value?.type === 'Identifier') target.decls.set(p.value.name, { kind: 'import', source, imported: key, file: ctx.mod.file });
              }
            } else if (d.id.type === 'Identifier') {
              target.decls.set(d.id.name, { kind: 'namespace', source, file: ctx.mod.file });
            }
          }
        }
        if (d.init) { recordParents(d.init, d); visit(d.init, ctx, d); }
      }
      return;
    }

    if (BLOCK_SCOPE_TYPES.has(type)) {
      const scope = new Scope('block', ctx.scope, node);
      if (type === 'CatchClause') declarePattern(node.param, 'let', scope, ctx.mod.file);
      visitChildren(node, { ...ctx, scope }, node);
      return;
    }

    if (type === 'CallExpression') recordCall(node, ctx);
    else if (type === 'Identifier') recordRefUse(node, ctx);
    else if (type === 'Property' && node.method === true) {
      // 对象字面量的简写方法 `{ foo() {} }`：value 是 FunctionExpression，但 async 要插在 key 前面
      enterFunction(node.value, ctx, { insertAt: node.key.start });
    }

    visitChildren(node, ctx, node);
  }

  function enterFunction(node, ctx, extra = {}) {
    const rec = {
      id: fns.length,
      node,
      file: ctx.mod.file,
      parentFnId: ctx.fnId,
      name: node.id?.name ?? null,
      isArrow: node.type === 'ArrowFunctionExpression',
      alreadyAsync: !!node.async,
      insertAt: extra.insertAt ?? node.start,
      asyncInsertable: true,
      scope: null,
    };
    fns.push(rec);
    fnByNode.set(node, rec);
    const scope = new Scope('function', ctx.scope, node);
    scope.fnId = rec.id;
    rec.scope = scope;
    if (node.id && node.type === 'FunctionExpression') scope.declare(node.id.name, { kind: 'function', node, file: ctx.mod.file });
    for (const p of node.params) declarePattern(p, 'param', scope, ctx.mod.file);
    const inner = { ...ctx, scope, fnId: rec.id };
    if (node.body) { recordParents(node.body, node); visit(node.body, inner, node); }
    return rec;
  }

  function recordRefUse(node, ctx) {
    const p = parents.get(node);
    if (p && (p.type === 'CallExpression' && p.callee === node)) return;      // 是调用，不是引用
    if (p && ((p.type === 'MemberExpression' && p.property === node && !p.computed))) return; // 属性名
    if (p && ((p.type === 'Property' && p.key === node && !p.computed))) return;
    if (p && ((p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && p.key === node)) return;
    if (p && p.type === 'ImportSpecifier') return;
    if (p && p.type === 'ExportSpecifier') return;
    // 与 recordCall 同理：声明要等遍历结束才齐，这里只记下"名字 + 作用域"，留给消费方解析
    ctx.mod.refUses.push({ node, name: node.name, scope: ctx.scope, fnId: ctx.fnId });
  }

  function recordCall(node, ctx) {
    const callee = node.callee;
    const site = { node, fnId: ctx.fnId, scope: ctx.scope, awaited: false, parent: parents.get(node) };
    // 已经 awaited？
    const par = parents.get(node);
    if (par && par.type === 'AwaitExpression' && par.argument === node) site.awaited = true;

    if (callee.type === 'Identifier') {
      const name = callee.name;
      site.name = name;
      site.calleeName = name;
      site.calleeNode = callee;
      // ⚠️ 这里**不能**就地 lookup：遍历到此处时，文件后面才声明的函数还没登记进作用域。
      //    而 JS 的函数声明会提升 —— lib.js 的 `normalizeLesson`(596 行) 调用 816 行才定义的
      //    lessonCanvasConfig 就是这种；就地查找得到 null → 漏 await、漏 async 传播
      //    （实测把 p9-r04 打挂了，而且我自己那版验收脚本用了同一个字段，所以它也是瞎的）。
      //    解析统一推迟到第三趟（遍历全部结束、所有声明都登记完）再做。
      ctx.mod.calls.push(site);
    } else if (FUNCTION_TYPES.has(callee.type)) {
      site.iife = true;
      site.calleeFnNode = callee;
      ctx.mod.calls.push(site);
    } else if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
      site.member = true;
      site.methodName = callee.property.name;
      site.objectNode = callee.object;
      // 数组方法回调
      if (SEQUENCING_METHODS.has(callee.property.name)) {
        node.arguments.forEach((arg, i) => {
          if (FUNCTION_TYPES.has(arg.type) || (arg.type === 'Identifier' && ctx.scope.lookup(arg.name))) {
            // ⚠️ 必须记下**调用点所在作用域**：回调常常是"函数内局部声明的"（如 resolveClassroomEntry 里的
            //    publicOf），用模块作用域去查会查不到 → 该 map 不改编 → 返回一串 Promise（实测打挂 p119）。
            ctx.mod.arrayCbs.push({ node, method: callee.property.name, cbNode: arg, argIndex: i, fnId: ctx.fnId, awaitedOuter: site.awaited, scope: ctx.scope });
          }
        });
      }
      ctx.mod.calls.push(site);
    } else {
      site.name = null;
      ctx.mod.calls.push(site);
    }

    // 把函数表达式当实参传出去（回调），记下来
    node.arguments.forEach((arg, i) => {
      if (FUNCTION_TYPES.has(arg.type)) {
        ctx.mod.callbackArgs.push({ node, cbNode: arg, argIndex: i, fnId: ctx.fnId, calleeName: site.calleeName || site.methodName || null, scope: ctx.scope });
      } else if (arg.type === 'Identifier') {
        const d = ctx.scope.lookup(arg.name);
        if (d && (d.kind === 'function' || fnByNode.has(d.node))) {
          ctx.mod.callbackArgs.push({ node, cbNode: arg, argIndex: i, fnId: ctx.fnId, calleeName: site.calleeName || site.methodName || null, byRef: true, refName: arg.name, scope: ctx.scope });
        }
      }
    });
  }

  function collectTopLevelDecls(mod, moduleScope) {
    mod.loaders = new Set();
    for (const stmt of mod.ast.body) {
      // 加载器：`const load = p => import(<表达式>)`（脚本里常见；不认的话
      // `const { fn } = await load('apps/server/src/x.js')` 之后的调用全都解析不到 → 漏 await，打挂过 p89）
      const decls = stmt.type === 'VariableDeclaration' ? stmt.declarations : [];
      for (const d of decls) {
        const init = d.init;
        const body = init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') ? init.body : null;
        if (d.id.type === 'Identifier' && body?.type === 'ImportExpression') mod.loaders.add(d.id.name);
      }
      if (stmt.type === 'ImportDeclaration') {
        for (const spec of stmt.specifiers) {
          const imported = spec.type === 'ImportDefaultSpecifier' ? 'default'
            : spec.type === 'ImportNamespaceSpecifier' ? '*' : spec.imported.name;
          mod.imports.set(spec.local.name, { source: stmt.source.value, imported });
          moduleScope.declare(spec.local.name, { kind: 'import', source: stmt.source.value, imported, file: mod.file });
        }
      } else if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.declaration) {
          const d = stmt.declaration;
          if (d.type === 'FunctionDeclaration' && d.id) mod.exports.set(d.id.name, { kind: 'node', node: d });
          else if (d.type === 'ClassDeclaration' && d.id) mod.exports.set(d.id.name, { kind: 'node', node: d });
          else if (d.type === 'VariableDeclaration') {
            for (const vd of d.declarations) if (vd.id.type === 'Identifier') mod.exports.set(vd.id.name, { kind: 'local', local: vd.id.name });
          }
        }
        for (const spec of stmt.specifiers) {
          const exported = spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value;
          if (stmt.source) mod.exports.set(exported, { kind: 'from', source: stmt.source.value, imported: spec.local.name });
          else mod.exports.set(exported, { kind: 'local', local: spec.local.name });
        }
      } else if (stmt.type === 'ExportDefaultDeclaration') {
        mod.exports.set('default', { kind: 'node', node: stmt.declaration });
      } else if (stmt.type === 'ExportAllDeclaration') {
        mod.exports.set('*', { kind: 'all', source: stmt.source.value });
      }
    }
  }

  // ── 第二趟：解析 import 目标 → 跨文件调用边 ──
  function resolveSpecifier(fromMod, source) {
    if (source === '@platform/database') return mods.get(SCHEMA_REL) || null;
    if (source.startsWith('.')) return mods.get(relOf(path.resolve(path.dirname(fromMod.abs), source))) || null;
    // **仓库相对**路径：脚本里常见 `await import(pathToFileURL(path.join(root, 'apps/server/src/lib.js')).href)`，
    // 抽出来的就是 'apps/server/src/lib.js' 这种。不认的话整个脚本的调用都解析不到 → 漏 await（打挂过 p52）。
    if (/^(apps|packages)\//.test(source)) return mods.get(relOf(path.resolve(ROOT, source))) || null;
    return null;               // node: 内置 / 外部包
  }

  /** 从任意表达式里捞出"看起来是仓库路径"的字符串字面量（用于算出来的动态 import 路径） */
  function repoPathFromExpr(node) {
    let found = null;
    (function w(n) {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'Literal' && typeof n.value === 'string' && /^(apps|packages)\//.test(n.value)) found = n.value;
      for (const k of Object.keys(n)) {
        if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
        const c = n[k];
        if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') w(x); }
        else if (c && typeof c.type === 'string') w(c);
      }
    })(node);
    return found;
  }

  function resolveExport(mod, name, seen = new Set()) {
    const key = `${mod.file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const e = mod.exports.get(name);
    if (!e) {
      const star = mod.exports.get('*');
      if (star) { const t = resolveSpecifier(mod, star.source); if (t) { const r = resolveExport(t, name, seen); if (r) return r; } }
      return null;
    }
    if (e.kind === 'node') return { node: e.node, file: mod.file, mod };
    if (e.kind === 'from') { const t = resolveSpecifier(mod, e.source); return t ? resolveExport(t, e.imported, seen) : null; }
    if (e.kind === 'local') {
      const d = mod.scope.lookup(e.local);
      if (!d) return null;
      if (d.kind === 'import') { const t = resolveSpecifier(mod, d.source); return t ? resolveExport(t, d.imported, seen) : null; }
      if (d.node) return { node: d.node, file: mod.file, mod, decl: d };
      return null;
    }
    return null;
  }

  // 把"声明"解析成函数记录
  function fnOfDecl(decl, mod, seen = new Set()) {
    if (!decl) return null;
    if (decl.kind === 'function') return fnByNode.get(decl.node) || null;
    if (decl.init && fnByNode.has(decl.init)) return fnByNode.get(decl.init);
    if (decl.node && fnByNode.has(decl.node)) return fnByNode.get(decl.node);
    if (decl.kind === 'import') {
      const t = resolveSpecifier(mod, decl.source);
      if (!t) return null;
      const r = resolveExport(t, decl.imported, seen);
      return r ? (fnByNode.get(r.node) || null) : null;
    }
    return null;
  }

  // 解析对象字面量方法：`const obj = { list() {…} }`（成员调用 obj.list()）
  const objectLiterals = new WeakMap(); // 变量声明节点 -> Map(methodName -> fnNode)
  for (const mod of mods.values()) {
    for (const stmt of mod.ast.body) {
      const decls = stmt.type === 'VariableDeclaration' ? stmt.declarations
        : stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'VariableDeclaration' ? stmt.declaration.declarations : [];
      for (const d of decls) {
        if (d.id.type === 'Identifier' && d.init?.type === 'ObjectExpression') {
          const map = new Map();
          for (const p of d.init.properties) {
            if (p.type !== 'Property') continue;
            const key = p.key.type === 'Identifier' ? p.key.name : (p.value?.value ?? null);
            const val = p.method ? p.value : p.value;
            if (key && val && FUNCTION_TYPES.has(val.type)) map.set(key, val);
          }
          objectLiterals.set(d.id, map);
        }
      }
    }
  }
  function fnOfMemberCall(mod, site) {
    const objNode = site.objectNode;
    if (!objNode || objNode.type !== 'Identifier') return null;
    const decl = site.scope.lookup(objNode.name);
    if (!decl) return null;
    // `const seed = await import('…')` 之后再 `seed.seedDatabase()`：按命名空间解析到那个模块的导出
    if (decl.kind === 'namespace') {
      const t = resolveSpecifier(mod, decl.source);
      if (!t) return null;
      const r = resolveExport(t, site.methodName);
      // ⚠️ 本函数的约定是返回**节点**（对象字面量分支返回的是 value 节点），调用方还会 fnByNode.get 一次。
      //    这里返回记录的话，调用方那一步就 get 成 undefined（踩过：seed.seedDatabase() 一直解析不到）。
      return r ? r.node : null;
    }
    if (decl.node?.type !== 'Identifier') return null;
    const map = objectLiterals.get(decl.node);
    if (!map) return null;
    return map.get(site.methodName) || null;
  }

  // ── 第三趟：把每个调用点连到函数，求"必须 async" ──
  for (const mod of mods.values()) {
    for (const site of mod.calls) {
      let target = null;
      if (site.iife) target = fnByNode.get(site.calleeFnNode) || null;
      else if (site.calleeName) {
        // 第三趟才做标识符解析：此时全部声明都已登记（含"调用点写在声明之前"的）
        if (!site.decl) site.decl = site.scope.lookup(site.calleeName);
        target = fnOfDecl(site.decl, mod);
      } else if (site.member) { const n = fnOfMemberCall(mod, site); if (n) target = fnByNode.get(n) || null; }
      site.targetFnId = target ? target.id : null;
      site.targetFn = target;
      if (site.name === null && site.member) site.name = site.methodName;
      // 数据访问调用：解析到 schema.js 的那几个名字才算
      if (site.calleeName && target && target.file === SCHEMA_REL && DB_FUNC_NAMES.has(site.calleeName)) {
        (site.calleeName === 'transaction' ? mod.txnCalls : mod.dbCalls).push({ ...site, name: site.calleeName });
      }
    }
    for (const cb of mod.arrayCbs) {
      cb.fnNode = FUNCTION_TYPES.has(cb.cbNode.type) ? cb.cbNode : null;
      cb.fnRec = cb.fnNode ? (fnByNode.get(cb.fnNode) || null) : fnOfDecl((cb.scope || mod.scope).lookup(cb.cbNode.name), mod);
      cb.fnIdResolved = cb.fnRec ? cb.fnRec.id : null;
    }
    for (const cb of mod.callbackArgs) {
      cb.fnRec = FUNCTION_TYPES.has(cb.cbNode.type) ? (fnByNode.get(cb.cbNode) || null) : fnOfDecl((cb.scope || mod.scope).lookup(cb.cbNode.name), mod);
      cb.fnIdResolved = cb.fnRec ? cb.fnRec.id : null;
    }
  }

  // 收集每个函数的"直接数据访问"
  const directDb = new Map();   // fnId -> [dbCall|txnCall]
  const directTxn = new Map();
  for (const mod of mods.values()) {
    for (const c of mod.dbCalls) {
      if (c.name === 'transaction') continue;
      if (c.fnId == null) continue;
      if (!directDb.has(c.fnId)) directDb.set(c.fnId, []);
      directDb.get(c.fnId).push(c);
    }
    for (const c of mod.txnCalls) {
      if (c.fnId == null) continue;
      if (!directTxn.has(c.fnId)) directTxn.set(c.fnId, []);
      directTxn.get(c.fnId).push(c);
    }
  }

  // 边：函数 → 它调用的函数（含回调被调用的情况）
  const edges = new Map();      // fnId -> Set(fnId)
  const addEdge = (from, to) => { if (from == null || to == null) return; if (!edges.has(from)) edges.set(from, new Set()); edges.get(from).add(to); };
  for (const mod of mods.values()) {
    for (const site of mod.calls) {
      if (site.targetFnId == null) continue;
      // ⚠️ 基线里**本来就是 async** 的函数：调用方不 await 是**有意的**形态
      //    （靠更外层 await handleX() 收口 / 显式 fire-and-forget / Promise 链 .then/.catch/.finally）。
      //    给这种调用点加 await 会改变行为：实测打挂 p105（预热必须不等）、p11（.finally 挂到了解析值上）。
      //    所以这里连"传播 async"都不由它触发。
      if (fns[site.targetFnId].alreadyAsync) continue;
      addEdge(site.fnId, site.targetFnId);
    }
    // ⚠️ 数组回调：`arr.map(cb)` / `arr.forEach(cb)` 里的 cb 变 async 之后，
    //    **await 落在外层函数身上**（map 包 Promise.all、forEach 内联成 for…of）。
    //    少了这条边，`transaction(() => { arr.forEach(cb) })` 这种"DB 调用全在回调里"的外层
    //    就判不出要 async —— 实测 4 个文件产出 `await` 在非 async 函数里的语法错。
    for (const cb of mod.arrayCbs) addEdge(cb.fnId, cb.fnIdResolved);
    for (const cb of mod.callbackArgs) {
      const cbFn = cb.fnRec;
      const cbFnId = cb.fnIdResolved;
      if (cbFnId == null) continue;
      // 接收方是否"调用了它的回调参数"？只有调用了才需要 await
      const recv = site2Receiver(mod, cb);
      if (recv && recv.fnRec && paramInvoked(recv.fnRec, cb.argIndex)) addEdge(recv.fnRec.id, cbFnId);
    }
  }
  function site2Receiver(mod, cb) {
    // 找到 cb 所属的调用点，看被调用者是不是本仓函数
    const call = mod.calls.find((s) => s.node === cb.node);
    if (!call) return null;
    if (call.targetFn) return { fnRec: call.targetFn };
    return null;
  }
  function paramInvoked(fnRec, argIndex) {
    const p = fnRec.node.params[argIndex];
    const name = p && p.type === 'Identifier' ? p.name : null;
    if (!name) return false;
    let found = false;
    (function walk(node) {
      if (!node || typeof node.type !== 'string' || found) return;
      if (FUNCTION_TYPES.has(node.type) && node !== fnRec.node) {
        for (const pp of node.params) if (pp.type === 'Identifier' && pp.name === name) return; // 被内层遮蔽
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === name) { found = true; return; }
      for (const k of Object.keys(node)) {
        if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
        const c = node[k];
        if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') walk(x); }
        else if (c && typeof c.type === 'string') walk(c);
      }
    })(fnRec.node.body);
    return found;
  }

  // 不动点：必须 async 的函数集合
  const mustAsync = new Set();
  const work = [];
  for (const fn of fns) if (directDb.has(fn.id) || directTxn.has(fn.id)) { mustAsync.add(fn.id); work.push(fn.id); }
  // 反向边，便于向上传播
  const rev = new Map();
  for (const [from, tos] of edges) for (const to of tos) { if (!rev.has(to)) rev.set(to, new Set()); rev.get(to).add(from); }
  while (work.length) {
    const id = work.pop();
    for (const caller of rev.get(id) || []) if (!mustAsync.has(caller)) { mustAsync.add(caller); work.push(caller); }
  }

  // 调用点分类：需要加 await 的（目标是 mustAsync 的函数）
  const awaitSites = [];
  const flagged = [];
  for (const mod of mods.values()) {
    for (const site of mod.calls) {
      if (site.targetFnId == null) continue;
      if (!mustAsync.has(site.targetFnId)) continue;
      const needAwait = !site.awaited;
      const pos = classifyPosition(site, parents);
      if (pos.blocked) { flagged.push({ kind: `call-in-${pos.blocked}`, mod, site, target: fns[site.targetFnId] }); continue; }
      if (needAwait) awaitSites.push({ ...site, pos, mod, target: fns[site.targetFnId] });
    }
  }

  function classifyPosition(site, parentsMap) {
    const node = site.node;
    let cur = node, p = parentsMap.get(cur);
    const out = { needsParens: false, blocked: null, inParams: false };
    // 括号：只有"被当成对象/被调用/被 new/被标记模板"时才需要
    if (p) {
      if (p.type === 'MemberExpression' && p.object === node) out.needsParens = true;
      else if (p.type === 'CallExpression' && p.callee === node) out.needsParens = true;
      else if (p.type === 'NewExpression' && p.callee === node) out.needsParens = true;
      else if (p.type === 'TaggedTemplateExpression' && p.tag === node) out.needsParens = true;
    }
    // 往上走，看是否位于"不能 await"的位置
    for (let q = p, child = node; q; child = q, q = parentsMap.get(q)) {
      if (q.type === 'FunctionDeclaration' || q.type === 'FunctionExpression' || q.type === 'ArrowFunctionExpression') {
        if (q.params.some((pp) => child === pp || containsNode(pp, child))) out.blocked = 'param-default';
        break;
      }
      if (q.type === 'Property' && q.kind === 'get') { out.blocked = 'getter'; break; }
      if (q.type === 'PropertyDefinition' || q.type === 'ClassProperty') { out.blocked = 'class-field'; break; }
      if (q.type === 'MethodDefinition' && q.kind === 'constructor') { out.blocked = 'constructor'; break; }
    }
    return out;
  }

  const nodeToFn = new Map();
  for (const fn of fns) nodeToFn.set(fn.node, fn);

  function containsNode(root, target) {
    if (root === target) return true;
    let found = false;
    (function w(n) {
      if (!n || typeof n.type !== 'string' || found) return;
      if (n === target) { found = true; return; }
      for (const k of Object.keys(n)) {
        if (['type', 'start', 'end', 'loc', 'range'].includes(k)) continue;
        const c = n[k];
        if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') w(x); }
        else if (c && typeof c.type === 'string') w(c);
      }
    })(root);
    return found;
  }

  return { mods, fns, fnByNode, parents, mustAsync, directDb, directTxn, edges, awaitSites, flagged, objectLiterals, resolveExport, resolveSpecifier, fnOfDecl, nodeToFn, classifyPosition, repoPathFromExpr };
}
