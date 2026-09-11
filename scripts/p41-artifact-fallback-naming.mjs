/**
 * P41 VibeCoding 产物的兜底命名（纯逻辑，不起服务）。
 *
 * 背景：2026-09-11 用户要求删掉注入给模型的「产物约定」，模型于是经常只写 ```html 不带文件名，
 * 生产实测「AI 说做好了网页、但右侧预览没更新」。服务端不能依赖模型遵守一条它没被告知的格式，
 * 所以改成自己认：没写文件名的围栏，只要**看起来像完整文件**就按语言落到 index.html / style.css / script.js。
 *
 * 这个脚本盯住四件事：
 *   ① 真实生产消息（```html 不带文件名）能被认成 index.html
 *   ② 解释用的片段（<h1>示例</h1>）**不能**被认——错认会把学生的页面覆盖坏
 *   ③ 显式文件名优先，不受兜底影响
 *   ④ 流式期间未闭合的围栏不产出（不会写出半截文件）
 */
import { extractArtifacts, createArtifactScanner } from '../apps/server/src/services/vibecodingArtifacts.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

// 生产消息 vibemsg_e21310a1ca4d4515840d 的围栏是 ```html 不带文件名
const REAL_MESSAGE = [
  '这是为您制作的三星堆青铜神树解说网页的HTML代码，打开就能看到高清神树图和语音介绍，手机屏幕也能用。',
  '',
  '```html',
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
  '<title>三星堆青铜神树</title>',
  '<style>body{margin:0;font-family:sans-serif}</style>',
  '</head>',
  '<body>',
  '<h1>青铜神树</h1>',
  '<script>console.log("hi")</script>',
  '</body>',
  '</html>',
  '```',
].join('\n');

// 反例：解释用法时给的片段（不该被认成文件）
const FRAGMENT = [
  '你可以这样写标题：',
  '',
  '```html',
  '<h1>我的标题</h1>',
  '```',
  '',
  '样式这样写：',
  '',
  '```css',
  'h1 { color: red; }',
  '```',
  '',
  '脚本很短：',
  '',
  '```js',
  "console.log('hi');",
  '```',
].join('\n');

// 显式文件名仍然优先
const EXPLICIT = [
  '```html index.html',
  '<!doctype html><html><body><h1>显式</h1></body></html>',
  '```',
  '',
  '```js app.js',
  'const a = 1;',
  '```',
].join('\n');

const checks = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push(ok);
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
};

console.log('\n一、真实生产消息（```html 不带文件名）→ 应该产出 index.html');
{
  const found = extractArtifacts(REAL_MESSAGE);
  check('产物名字', found.map((a) => a.name), ['index.html']);
  check('类型', found.map((a) => a.kind), ['html']);
  check('内容完整（含 </html>）', found[0]?.content.includes('</html>'), true);
  check('体积合理（> 200 字节）', found[0]?.bytes > 200, true);
}

console.log('\n二、解释用的片段 → 一个都不该认（错认会覆盖学生的页面）');
{
  const found = extractArtifacts(FRAGMENT);
  check('产物数量', found.length, 0);
}

console.log('\n三、显式文件名仍然优先（不受兜底影响）');
{
  const found = extractArtifacts(EXPLICIT);
  check('产物名字', found.map((a) => a.name), ['index.html', 'app.js']);
}

console.log('\n四、流式增量：文件写一半时不能提前产出');
{
  const scanner = (await import('../apps/server/src/services/vibecodingArtifacts.js')).createArtifactScanner();
  const half = REAL_MESSAGE.slice(0, REAL_MESSAGE.indexOf('</html>'));
  const first = scanner.push(half);
  check('未闭合时不产出', first.length, 0);
  const second = scanner.push(REAL_MESSAGE.slice(REAL_MESSAGE.indexOf('</html>')));
  check('闭合后产出', second.map((a) => a.name), ['index.html']);
}

console.log(checks.every(Boolean) ? '\n结果：全部通过\n' : `\n结果：${checks.filter((c) => !c).length} 项失败\n`);
process.exit(checks.every(Boolean) ? 0 : 1);
