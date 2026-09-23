// 验收：语法 + 静态不变量（不依赖 p137 的正则，用 AST 自己判）
import { buildModel, SCHEMA_REL } from './core.mjs';
import fs from 'node:fs';

const M = buildModel({ extraDirs: ['scripts'] });
const { mods, fns, mustAsync, awaitSites, flagged } = M;

let bad = 0;
// ① 语法：buildModel 解析时就抛错了，能走到这说明全部通过
console.log(`✅ 语法：${mods.size} 个文件全部解析通过`);

// ② 必须 async 的同步函数还剩几个
const notAsync = fns.filter((f) => mustAsync.has(f.id) && !f.alreadyAsync && !isAsyncNow(M, f));
function isAsyncNow(M, f) {
  if (f.file === SCHEMA_REL) return true;      // schema.js 按设计保持同步
  return false;                                 // 其余靠下面文本检查
}
const stillSync = [];
for (const f of fns) {
  if (!mustAsync.has(f.id)) continue;
  if (f.alreadyAsync) continue;
  if (f.file === SCHEMA_REL) continue;
  const mod = mods.get(f.file);
  const head = mod.code.slice(f.insertAt, f.insertAt + 8);
  if (!head.startsWith('async ')) stillSync.push(`${f.file}:${lineOf(mod, f.insertAt)} ${f.name || '(匿名)'}`);
}
function lineOf(mod, pos) { return mod.code.slice(0, pos).split('\n').length; }
console.log(`\n② 含数据访问但**没加 async** 的函数：${stillSync.length}`);
for (const s of stillSync.slice(0, 20)) console.log('   ' + s);

// ③ 还没 await 的数据访问调用（AST 判，不看正则）
const unawaited = [];
for (const mod of mods.values()) {
  if (mod.file === SCHEMA_REL) continue;
  for (const c of mod.dbCalls) {
    const txt = mod.code.slice(c.node.start, c.node.start + 6);
    if (!txt.includes('await')) unawaited.push(`${mod.file}:${lineOf(mod, c.node.start)} ${txt}`);
  }
  for (const t of mod.txnCalls) {
    const txt = mod.code.slice(t.node.start, t.node.start + 6);
    if (!txt.includes('await')) unawaited.push(`${mod.file}:${lineOf(mod, t.node.start)} txn ${txt}`);
  }
}
console.log(`\n③ 没带 await 的数据访问/事务调用：${unawaited.length}`);
for (const s of unawaited.slice(0, 20)) console.log('   ' + s);

// ④ 还是"同步调用一个已变 async 的函数"的地方（漏 await = 运行时检测器会炸）
const missed = [];
for (const mod of mods.values()) {
  if (mod.file === SCHEMA_REL) continue;
  for (const site of mod.calls) {
    if (site.targetFnId == null || !mustAsync.has(site.targetFnId)) continue;
    const target = fns[site.targetFnId];
    if (target.file === SCHEMA_REL) continue;
    if (target.alreadyAsync) continue;   // 基线本来 async：不 await 是有意形态
    const before = mod.code.slice(Math.max(0, site.node.start - 24), site.node.start);
    const isAwaited = /await\s*\(?$/.test(before) || /await\s+$/.test(before);
    if (!isAwaited) missed.push(`${mod.file}:${lineOf(mod, site.node.start)} → ${site.name}(…)  目标 ${target.file}:${target.name || '(匿名)'}`);
  }
}
console.log(`\n④ 调用了 async 函数但**没 await** 的调用点：${missed.length}`);
for (const s of missed.slice(0, 25)) console.log('   ' + s);

// ⑤ 数组回调：**回调自己是 async，却还在用 .map(/.forEach(/.filter(** —— 这些会静默出错
//    （map 返回一串 Promise、forEach 直接不等、filter 恒真）。
//    ⚠️ 判据必须用"回调自己是不是 async"，**不能**用 mustAsync —— 第 1 趟把 `row(` 改成 `await arow(` 之后，
//    模型眼里"这里有数据访问"的信号就没了，用 mustAsync 判会漏掉 41 处（p119 就是这么坏的）。
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
function insidePromiseAll(node) {
  let outer = node;
  for (;;) {
    const p = M.parents.get(outer);
    if (p && p.type === 'MemberExpression' && p.object === outer) {
      const gp = M.parents.get(p);
      outer = gp && gp.type === 'CallExpression' && gp.callee === p ? gp : p;
      continue;
    }
    break;
  }
  const call = M.parents.get(outer);
  if (!call || call.type !== 'CallExpression') return false;
  const callee = call.callee;
  if (!(callee.type === 'MemberExpression' && callee.object?.name === 'Promise' && callee.property?.name === 'all')) return false;
  return call.arguments.some((a) => a === outer);
}
const left = [];
for (const mod of mods.values()) {
  if (mod.file === SCHEMA_REL) continue;
  for (const cb of mod.arrayCbs) {
    const cbNode = cb.cbNode;
    const cbAsync = FUNCTION_TYPES.has(cbNode.type) ? Boolean(cbNode.async) : Boolean(cb.fnRec?.node?.async);
    if (!cbAsync) continue;
    if (cb.method === 'map' && insidePromiseAll(cb.node)) continue;   // 显式并发，允许
    left.push(`${mod.file}:${lineOf(mod, cb.node.start)} [${cb.method}] 回调是 async 却没改编`);
  }
}
console.log(`\n⑤ 回调是 async、却还在 .map(/.forEach( 的地方：${left.length}`);
for (const s of left.slice(0, 30)) console.log('   ' + s);

console.log(`\n汇总：语法✅  ${stillSync.length} 未加async  ${unawaited.length} 未await  ${missed.length} 漏await  ${left.length} 未改编回调`);
