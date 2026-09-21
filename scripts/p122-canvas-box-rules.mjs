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

console.log('④ 生成按钮该不该出现（2026-09-21 用户：「本来就不能生成就不要显示这个按钮了」）');
check('不能生成的节点（本课该模态配了框体、而节点不是框体）不显示生成按钮', () => {
  const source = read('packages/canvas/src/index.jsx');
  // 判据必须只有一处：服务端就是这么判的（本课有该模态框体 + 节点没有 boxId → 403）
  assert.match(source, /const needsBox = Boolean\(boxModality\) && boxModalities\.includes\(boxModality\)/);
  assert.match(source, /const canGenerateHere = !needsBox \|\| Boolean\(data\.boxId\)/);
  assert.match(source, /canGenerate && canGenerateHere && generate/, '按钮条件里必须带上 canGenerateHere');
});
check('已生成过的节点不再显示「重新生成」（平台规则：每个框体只能成功生成一次）', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /const alreadyProduced = state === 'done' \|\| state === 'asset'/);
  assert.match(source, /!alreadyProduced/, '按钮条件里必须带上 alreadyProduced');
});
check('不能生成的节点不再挂着上一次那条误导报错（状态胶囊回到「未生成」）', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /const statusState = !canGenerateHere && state === 'failed' \? 'empty' : state/);
  assert.match(source, /\$\{statusState === 'running'/, '状态胶囊要读 statusState');
});
check('本课配了哪些模态的框体：父层算好传下来（画布自己拿不到 generationBoxes）', () => {
  const workspace = read('packages/shared/src/canvasWorkspace.jsx');
  assert.match(workspace, /const boxModalities = \[\.\.\.new Set\(generationBoxes\.map/);
  assert.match(workspace, /boxModalities=\{boxModalities\}/, '要把 boxModalities 传给画布');
});

console.log('⑤ 复制框体（2026-09-21 用户：「我现在可以用快捷键复制框体，这个应该要禁用掉」）');
check('学生画布（allowNodeCreation=false）整段不给复制/粘贴', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /if \(!allowNodeCreation\) return;/);
  // 这条 return 必须在复制/粘贴两段之前、在撤销/重做两行之后 —— 学生要能撤销
  const handler = source.slice(source.indexOf('const handleKeyDown = (event) => {'));
  const undoAt = handler.indexOf("key.toLowerCase() === 'z'");
  const gateAt = handler.indexOf('if (!allowNodeCreation) return;');
  const copyAt = handler.indexOf("key.toLowerCase() === 'c'");
  assert.ok(undoAt > 0 && gateAt > undoAt && copyAt > gateAt, '复制闸门的位置不对：撤销/重做必须仍然可用');
});
check('框体节点压根不参与复制（两个节点共用同一个 boxId 没有意义）', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /const copyable = \(node\) => !node\.data\?\.boxId/);
  assert.match(source, /node\.selected && copyable\(node\)/);
});
check('快捷键 effect 的依赖里有 allowNodeCreation（否则改开关不生效）', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /\}, \[allowNodeCreation, edges, nodes, pushHistory, readOnly, redo, setNodes, undo, viewport\]\);/);
});

console.log('⑥ 「自动」画幅不能在客户端就折成第一个比例（2026-09-21 用户：「生成出来是扁的画面」）');
check('视频那条的「自动」原样送 auto 上去，由服务端按上游语义翻译', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /const autoRatio = data\.slotType === 'video' \? 'auto'/);
  assert.match(source, /aspectRatio: data\.aspectRatio \|\| student\.aspectRatio \|\| autoRatio/);
});

console.log('⑦ 生成方式（课包锁定）→ 画布上的连线闸门 + 看得见的标签（2026-09-21 用户口径）');
check('连线闸门按「生成方式」限制：文生视频不给连、图生视频只连 1 张、首尾帧 2 张、全能参考 9/3/3', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /const canConnect = useCallback\(\(connection\) => \{/);
  assert.match(source, /const mode = String\(target\?\.data\?\.inputMode \|\| ''\)\.toUpperCase\(\)/);
  assert.match(source, /if \(!mode\) return true;/, '没锁方式的框体必须维持原样（旧课包没配过这个字段）');
  assert.match(source, /FIRST_FRAME: \{ IMAGE: 1, VIDEO: 0, AUDIO: 0 \}/);
  assert.match(source, /FIRST_LAST_FRAME: \{ IMAGE: 2, VIDEO: 0, AUDIO: 0 \}/);
  assert.match(source, /OMNI_REFERENCE: \{ IMAGE: 9, VIDEO: 3, AUDIO: 3 \}/);
  assert.match(source, /TEXT: \{ IMAGE: 0, VIDEO: 0, AUDIO: 0 \}/, '文生视频的框体不许有连线');
  assert.match(source, /isValidConnection=\{readOnly \? undefined : canConnect\}/, '闸门要真的挂到 ReactFlow 上');
});
check('锁定的生成方式赢过"连了几条线"的推断（连 2 张图也可能要全能参考）', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /const lockedMode = String\(data\.inputMode \|\| ''\)\.toUpperCase\(\)/);
  assert.match(source, /lockedMode === 'OMNI_REFERENCE' && allRefs\.length > 0/, '锁成全能参考时一张图也要走参考');
  assert.match(source, /lockedFrames = lockedMode === 'FIRST_FRAME' \|\| lockedMode === 'FIRST_LAST_FRAME'/);
});
check('锁成文生视频的面板明说「不用连线」（别留一行"首帧未连接"让人误会）', () => {
  const source = read('packages/canvas/src/index.jsx');
  assert.match(source, /if \(lockedMode === 'TEXT'\) \{/);
  assert.match(source, /不用连线，直接写提示词/);
});
check('生成方式要显示出来：配置胶囊带中文标签、素材面板副标题也带', () => {
  const canvas = read('packages/canvas/src/index.jsx');
  assert.match(canvas, /const modeChip = String\(data\.inputModeLabel \|\| ''\)/);
  assert.match(canvas, /if \(modeChip\) params\.push\(modeChip\)/);
  const workspace = read('packages/shared/src/canvasWorkspace.jsx');
  assert.match(workspace, /const modeLabel = box\.inputModeLabel \|\| ''/);
  assert.match(workspace, /if \(modeLabel\) params\.unshift\(modeLabel\)/);
  assert.match(workspace, /inputModeLabel: box\.inputModeLabel \|\| ''/, '节点 data 也要带上标签');
});
check('标签由服务端算（客户端不抄一份标签表）', () => {
  const lib = read('apps/server/src/lib.js');
  assert.match(lib, /box\.inputModeLabel = inputModeShortLabel\(box\.inputMode, modality\)/);
  const workspace = read('packages/shared/src/canvasWorkspace.jsx');
  assert.doesNotMatch(workspace, /INPUT_MODE_LABELS|INPUT_MODE_SHORT_LABELS/, '客户端不该有第二份标签表');
});

console.log('⑧ 后台「生成方式」下拉只留两种（用户 2026-09-21 口径：视频只留文生/全能参考、图片只留文生图/图生图）');
check('视频只有 文生视频 + 全能参考；图生视频/首尾帧不再列进选项，但历史值仍要看得见', () => {
  const admin = read('apps/admin/src/components/CourseManagement.jsx');
  const start = admin.indexOf('const VIDEO_MODE_LABELS = {');
  assert.ok(start > 0, '视频标签表要在');
  const table = admin.slice(start, admin.indexOf('};', start));
  assert.match(table, /TEXT: '文生视频/);
  assert.match(table, /OMNI_REFERENCE: '全能参考/);
  assert.doesNotMatch(table, /FIRST_FRAME:|FIRST_LAST_FRAME:/, '首帧/首尾帧不该再列进选项');
  assert.match(admin, /GENERATION_MODE_LEGACY_LABELS[\s\S]{0,300}FIRST_LAST_FRAME/, '历史值要有标签（否则老课包打开是一片空白）');
  assert.match(admin, /generationModeSelectOptions\(caps, modality, box\.inputMode\)/, '下拉要走"含历史值"的那个函数');
});
check('图片只有 文生图 + 图生图', () => {
  const admin = read('apps/admin/src/components/CourseManagement.jsx');
  assert.match(admin, /const IMAGE_MODE_LABELS = \{ TEXT: '文生图[^}]*IMAGE_REFERENCE: '图生图/);
});

if (failures) { console.log(`\n❌ P122 不通过：${failures} 项`); process.exit(1); }
console.log('\nP122 PASSED：框体删除规则与未生成占位图都成立');
