// P103 工具调用标记（DSML）过滤守卫 —— 2026-09-16
//
// 用户报的「跟 AI 对话乱码」：学生创作环境里的 agent 走我们的 OpenAI 兼容网关，
// 网关请求侧丢了 tools、响应侧只认 content，模型就把工具调用当正文吐出来
// （<|DSML|_|calls> <|DSML|_|invoke name="run_code"> ... </|DSML|_|calls>）。
//
// 这个守卫钉四件事：
//   ① 正常文本原样通过；
//   ② **绝不误伤学生写的 HTML/JS**（这套环境就是拿来做网页的，正文里满是 <div>、</script>、
//      `<` 与 `>` 的比较运算）—— 这条比「能过滤掉标记」更重要，所以单独列用例；
//   ③ DSML 整块被摘掉，块**前后**的正常正文都保留；
//   ④ 跨 SSE 分片的半截标记也要认（逐字符喂进去必须和整段一次喂结果一致）。

import assert from 'node:assert/strict';
import { createDsmlStripper, stripDsml } from '../apps/server/src/services/dsmlFilter.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const run = (chunks) => {
  const stripper = createDsmlStripper();
  return chunks.map((chunk) => stripper.push(chunk)).join('') + stripper.flush();
};

/* ① 正常文本原样通过 */
const plain = '好的，我们先做一个会动的标题。\n下一步你想加什么？';
check('正常文本原样通过', run([plain]) === plain);
check('空串与 null 不炸', run(['', null, undefined]) === '');

/* ② 绝不误伤学生的 HTML / JS —— 这条最重要 */
const html = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN"><head><style>body{margin:0}</style></head>',
  '<body><div class="card">你好</div><script>const a = 1 < 2 && 3 > 2;</script></body>',
  '</html>',
].join('\n');
check('学生写的 HTML/JS 原样通过（含 <div> / </script> / 小于号比较）', run([html]) === html);
check('含尖括号的代码被逐字符喂进去也不变形', run([...html]) === html);
check('Markdown 里的行内标签原样通过', run(['用 `<div>` 包一层就行']) === '用 `<div>` 包一层就行');

/* ③ 整块摘掉，前后正文保留 */
const block = '<|DSML|_|calls>\n<|DSML|_|invoke name="run_code">\n<|DSML|_|parameter name="code" string="true">const x = 1;</|DSML|_|parameter>\n</|DSML|_|invoke>\n</|DSML|_|calls>';
check('整块标记被摘掉', stripDsml(block) === '', JSON.stringify(stripDsml(block)));
const wrapped = `我先看一下模板。\n${block}\n模板有三个，你想用哪个？`;
const cleaned = run([wrapped]);
check('块之前的正文保留', cleaned.includes('我先看一下模板。'));
check('块之后的正文保留', cleaned.includes('模板有三个，你想用哪个？'));
check('块本身没有残留标记', !/DSML/i.test(cleaned), cleaned);
check('摘掉后不留大片空行', !/\n{3,}/.test(cleaned));

/* ④ 跨分片：逐字符喂，结果必须与整段一次喂一致 */
const charByChar = run([...wrapped]);
check('逐字符分片与整段一次喂结果一致', charByChar === cleaned, JSON.stringify({ charByChar, cleaned }));
// 在上游常见的位置切断（正好切在标记中间）
const cutAt = wrapped.indexOf('<|DSML|_|invoke') + 3;
const splitRun = run([wrapped.slice(0, cutAt), wrapped.slice(cutAt)]);
check('正好切在标记中间也不漏', splitRun === cleaned, JSON.stringify(splitRun));

/* ⑤ 边界：未收尾的块（上游被截断）不能当正文发出去 */
const unterminated = `开头的话\n<|DSML|_|calls>\n<|DSML|_|invoke name="run_code">`;
const tailOut = run([unterminated]);
check('未收尾的块不吐给学生', !/DSML/i.test(tailOut), tailOut);
check('未收尾的块之前那句话还在', tailOut.includes('开头的话'));

/* ⑥ 全角竖线 / 下划线的变体也认 */
const fullwidth = '<｜DSML｜_｜calls> <｜DSML｜_｜invoke name="x"> </｜DSML｜_｜invoke> </｜DSML｜_｜calls>';
check('全角竖线的标记同样被摘掉', stripDsml(fullwidth) === '', JSON.stringify(stripDsml(fullwidth)));

assert.ok(typeof createDsmlStripper === 'function' && typeof stripDsml === 'function');

if (failures) { console.log(`\nP103 有 ${failures} 项未通过`); process.exitCode = 1; }
else console.log('P103 工具调用标记过滤：正常文本与学生的 HTML/JS 不受影响、DSML 整块摘除（含逐字符分片）、未收尾不吃正文 通过');
