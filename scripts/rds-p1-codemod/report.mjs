// 打印分析结果：先量，再下手改
import { buildModel, relOf, ROOT, DB_FUNC_NAMES, SEQUENCING_METHODS, SCHEMA_REL } from './core.mjs';

const M = buildModel();
const { mods, fns, mustAsync, awaitSites, flagged } = M;

const lineOf = (mod, pos) => mod.code.slice(0, pos).split('\n').length;
const loc = (mod, node) => `${mod.file}:${lineOf(mod, node.start)}`;

// ── 总量 ──
const allDbCalls = [...mods.values()].flatMap((m) => m.dbCalls);
const allTxn = [...mods.values()].flatMap((m) => m.txnCalls);
console.log(`文件 ${mods.size} · 函数 ${fns.length}`);
console.log(`AST 认定的**数据访问调用**（排除 transaction）：${allDbCalls.length}`);
console.log(`  · 其中已 awaited：${allDbCalls.filter((c) => c.awaited).length}`);
console.log(`AST 认定的 transaction 调用：${allTxn.length}`);
console.log(`必须 async 的函数：${mustAsync.size}（其中本来就是 async 的：${fns.filter((f) => mustAsync.has(f.id) && f.alreadyAsync).length}）`);
console.log(`需要补 await 的调用点（目标是必须 async 的函数）：${awaitSites.length}`);
console.log('');

// ── 数据访问调用按名字 ──
const byName = {};
for (const c of allDbCalls) byName[c.name] = (byName[c.name] || 0) + 1;
console.log('数据访问调用按名字：', JSON.stringify(byName));
const byFile = new Map();
for (const c of allDbCalls) byFile.set(c.mod?.file ?? '', 0);
const perFile = {};
for (const m of mods.values()) perFile[m.file] = m.dbCalls.length + m.txnCalls.length;
console.log('前 12 个文件：');
for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${String(n).padStart(4)}  ${f}`);
console.log('');

// ── 需要括号的位置 ──
const parens = awaitSites.filter((s) => s.pos.needsParens);
console.log(`需要补括号的调用点（如 q(...).changes / rows(...).map(...)）：${parens.length}`);
for (const s of parens.slice(0, 8)) console.log(`   ${loc(s.mod, s.node)}  →  ${s.mod.code.slice(s.node.start, Math.min(s.node.end, s.node.start + 70)).replace(/\s+/g, ' ')}`);
console.log('');

// ── 被挡住的位置（不能直接加 await）──
console.log(`⚠️ 不能直接加 await 的位置：${flagged.length}`);
const flagKinds = {};
for (const f of flagged) { flagKinds[f.kind] = (flagKinds[f.kind] || 0) + 1; }
console.log('   分类：', JSON.stringify(flagKinds));
for (const f of flagged.slice(0, 25)) console.log(`   [${f.kind}] ${loc(f.mod, f.site.node)}  →  ${f.site.name || '(member)'}`);
console.log('');

// ── 数组方法回调 ──
const cbs = [...mods.values()].flatMap((m) => m.arrayCbs);
const cbNeed = cbs.filter((c) => c.fnIdResolved != null && mustAsync.has(c.fnIdResolved));
console.log(`数组方法回调总数：${cbs.length}；其中回调**必须变 async**的：${cbNeed.length}`);
const cbByMethod = {};
for (const c of cbNeed) cbByMethod[c.method] = (cbByMethod[c.method] || 0) + 1;
console.log('   按方法：', JSON.stringify(cbByMethod));
for (const c of cbNeed.slice(0, 30)) {
  const cbNode = c.cbNode;
  const arity = cbNode.params ? cbNode.params.length : '?';
  console.log(`   [${c.method}] arity=${arity} ${loc(c.mod ?? modOf(c), c.node)}`);
}
console.log('');
function modOf(c) { for (const m of mods.values()) if (m.arrayCbs.includes(c)) return m; return null; }

// ── 作为回调传出去、接收方**不是**本仓函数（无法自动传播）──
const risky = [];
for (const m of mods.values()) {
  for (const cb of m.callbackArgs) {
    if (cb.fnIdResolved == null || !mustAsync.has(cb.fnIdResolved)) continue;
    const call = m.calls.find((s) => s.node === cb.node);
    const known = call && (call.targetFnId != null || (call.member && SEQUENCING_METHODS.has(call.methodName)));
    if (!known) risky.push({ m, cb, call });
  }
}
console.log(`⚠️ 回调必须 async 但**接收方不认识**（无法自动传播）：${risky.length}`);
for (const r of risky.slice(0, 40)) {
  const nm = r.call ? (r.call.calleeName || r.call.methodName || '(匿名)') : '(?)';
  console.log(`   ${loc(r.m, r.cb.node)}  接收方=${nm}  argIndex=${r.cb.argIndex}`);
}
console.log('');

// ── 函数被当值传递（不是调用）──
const refRisky = [];
for (const m of mods.values()) {
  for (const r of m.refUses) {
    const rec = r.decl.node ? M.fnByNode.get(r.decl.node) : null;
    if (rec && mustAsync.has(rec.id)) refRisky.push({ m, r, rec });
  }
}
console.log(`⚠️ 必须 async 的函数被**当值传递**（如 arr.map(fn) / 传引用）：${refRisky.length}`);
for (const r of refRisky.slice(0, 30)) console.log(`   ${loc(r.m, r.r.node)}  ${r.r.name}`);
console.log('');

// ── transaction 调用形状 ──
console.log(`transaction 调用形状：`);
const txnShapes = {};
for (const t of allTxn) {
  const arg = t.node.arguments[0];
  const shape = !arg ? 'no-arg' : arg.type === 'ArrowFunctionExpression' ? `arrow(${arg.params.length})` : arg.type === 'FunctionExpression' ? `func(${arg.params.length})` : arg.type;
  const used = t.parent && !(t.parent.type === 'ExpressionStatement');
  txnShapes[`${shape}${used ? ' /结果被用' : ' /结果丢弃'}`] = (txnShapes[`${shape}${used ? ' /结果被用' : ' /结果丢弃'}`] || 0) + 1;
}
console.log('   ', JSON.stringify(txnShapes, null, 0));
console.log('');

// ── 模块顶层（不在任何函数里）的数据访问 ──
const topLevel = allDbCalls.filter((c) => c.fnId == null);
console.log(`模块顶层的数据访问（不在函数里）：${topLevel.length}`);
for (const c of topLevel.slice(0, 10)) console.log(`   ${loc(c.mod ?? modOfDb(c), c.node)}`);
function modOfDb(c) { for (const m of mods.values()) if (m.dbCalls.includes(c)) return m; return null; }
console.log('');

// ── schema.js 自己 ──
const schemaMod = mods.get(SCHEMA_REL);
console.log(`schema.js：数据访问调用 ${schemaMod.dbCalls.length}，transaction ${schemaMod.txnCalls.length}，必须 async 的函数 ${fns.filter((f) => f.file === SCHEMA_REL && mustAsync.has(f.id)).length}`);
console.log('');

// ── 外部调用者：scripts/ 等直接 import 我们的模块并调用被改 async 的函数 ──
const external = [];
for (const abs of ['scripts']) {
  const dir = `${ROOT}/${abs}`;
  let entries = [];
  try { entries = (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js')); } catch { continue; }
  for (const name of entries) {
    const full = `${dir}/${name}`;
    const code = (await import('node:fs')).readFileSync(full, 'utf8');
    for (const m of mods.values()) {
      // 粗略：脚本里 import 了某个被改的文件
      const spec = m.file.replace(/^apps\/server\/src\//, '../apps/server/src/').replace(/^packages\/database\/src\//, '../packages/database/src/');
      if (code.includes(`'${spec}'`) || code.includes(`"${spec}"`)) external.push({ script: `scripts/${name}`, module: m.file, changed: fns.filter((f) => f.file === m.file && mustAsync.has(f.id)).length });
    }
  }
}
console.log(`⚠️ scripts/ 里直接 import 了会被改的模块：${external.length}`);
for (const e of external) console.log(`   ${e.script}  →  ${e.module}（该文件有 ${e.changed} 个函数要变 async）`);
