#!/usr/bin/env node
/**
 * P122 画布框体的两条口径（2026-09-19，用户点名要的「优化微调」）。
 *
 * 用户原话：
 *   ③「画布里学生点击了框体，如果在还没有生成的时候可以删除，然后又可以点击显示出来。
 *      但是一旦生成了，这个框体就无法删除了。等于这个框体次数已经使用了。要优化微调一下。」
 *   ④「图5还没生成时，有这个预览图，现在换成图4。」
 *
 * 钉两件事：
 *   ① **框体能不能删**：判据是 `packages/canvas/src/boxRules.js` 的纯函数，
 *      这里**直接拿状态矩阵跑它**（不是读源码猜）—— 没生成过可删、正在生成/已生成不给删、
 *      普通素材节点照常可删。另外断言 `index.jsx` 真的在用它（防止有人把判据再抄一份回去、
 *      抄漏一个状态）。
 *   ② **未生成时的占位图**：必须是那张引导插画（绝对路径 `/assets/...`，
 *      画布同时跑在官网与机构端，两边同一个地址都要取得到），而且文件真的在、
 *      而且没被换成一张几 MB 的大图。
 *
 * ⚠️ 为什么用纯函数 + 源码断言（而不是真浏览器）：画布是 JSX，在 node 里导不进来 ——
 *    这是本项目既有的约定（见 `packages/canvas/src/ratioThumb.js` 的注释与 p109）。
 *
 * 跑法（需 node ≥ 20）：node scripts/p122-canvas-box-rules.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOX_EMPTY_ART, isProtectedBoxNode } from '../packages/canvas/src/boxRules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failures = 0;
const check = (label, run) => {
  try { run(); console.log(`  ✓ ${label}`); }
  catch (error) { failures += 1; console.log(`  ✗ ${label}\n      ${String(error.message).split('\n')[0]}`); }
};

console.log('① 框体删除规则（真跑纯函数）');
const box = (data) => ({ id: 'n1', data });
check('没生成过的框体 → 可删（学生误加的能清掉）', () => {
  assert.equal(isProtectedBoxNode(box({ slotType: 'image' })), false);
  assert.equal(isProtectedBoxNode(box({ slotType: 'video', caption: '写了一半' })), false);
  assert.equal(isProtectedBoxNode(box({ slotType: 'music', text: '歌词' })), false);
});
check('正在生成的框体 → 不给删（这次配额已经在用）', () => {
  assert.equal(isProtectedBoxNode(box({ slotType: 'image', generationStatus: 'PENDING' })), true);
});
check('已生成的框体 → 不给删（配额已经用掉了）', () => {
  assert.equal(isProtectedBoxNode(box({ slotType: 'image', assetUrl: '/api/x.png' })), true);
  assert.equal(isProtectedBoxNode(box({ slotType: 'text', generatedText: '生成出来的文字' })), true);
  assert.equal(isProtectedBoxNode(box({ slotType: 'video', uploaded: true })), true);
});
check('生成失败 → 可删（失败那次不该锁住画布）', () => {
  assert.equal(isProtectedBoxNode(box({ slotType: 'image', generationStatus: 'FAILED', generationError: '上游超时' })), false);
});
check('不是框体的节点 → 照常可删', () => {
  assert.equal(isProtectedBoxNode(box({ title: '素材 1', assetUrl: '/api/y.png' })), false);
  assert.equal(isProtectedBoxNode({ id: 'n2' }), false);
  assert.equal(isProtectedBoxNode(null), false);
});

console.log('② index.jsx 确实在用这个判据（别再把规则抄一份回去）');
check('onBeforeDelete 用的是 isProtectedBoxNode', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /filter\(isProtectedBoxNode\)/, 'onBeforeDelete 里应当 filter(isProtectedBoxNode)');
});
check('index.jsx 里没有第二份「保护框体」的判据', () => {
  const source = read('packages/canvas/src/index.jsx');
  // 旧写法是按 slotType 直接拉黑整类节点；那正是这次要修掉的行为
  assert.doesNotMatch(source, /filter\(\(node\) => node\.data\?\.slotType\)/, '还留着「凡 slotType 一律禁删」的旧判据');
});

console.log('③ 未生成时的占位图（引导插画）');
check('插画用绝对路径（官网与机构端同一个地址都能取到）', () => {
  assert.equal(BOX_EMPTY_ART, '/assets/learning/box-empty-art.webp');
});
check('图片框体的空状态接的是这张插画', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /learning-node__art--illustration/);
  assert.match(source, /src=\{BOX_EMPTY_ART\}/);
});
check('样式里定义了插图撑满占位区的规则', () => {
  const css = read('packages/canvas/src/styles.css');
  assert.match(css, /\.learning-node__art--illustration\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.learning-node__art--illustration img\s*\{[^}]*object-fit:\s*cover/);
});
check('插画文件真的在，而且没有几 MB（首屏之外的占位图不该拖慢画布）', () => {
  const file = path.join(root, 'apps/website/public/assets/learning/box-empty-art.webp');
  assert.ok(fs.existsSync(file), `插画不在：${file}`);
  const size = fs.statSync(file).size;
  assert.ok(size > 5 * 1024, `插画太小（${size}B），像是占位空文件`);
  assert.ok(size < 400 * 1024, `插画太大（${(size / 1024).toFixed(0)}KB），先压一下再进仓库`);
});

if (failures) { console.log(`\n❌ P122 不通过：${failures} 项`); process.exit(1); }
console.log('\nP122 PASSED：框体删除规则与未生成占位图都成立');
