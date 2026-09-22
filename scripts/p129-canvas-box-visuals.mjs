/**
 * P129 画布框体的四条观感/交互（用户 2026-09-22 报的图1/图2/图4/图5）。
 *
 *   图1「图像框体有了预览图像…但是其他框体都没有（比如视频框体还是原始图）」
 *        → 引导插画要**四类框体一致**（图片/视频/动画/音乐/文字）。
 *   图2「选择不同的尺寸，框体应该也要跟着变」
 *        → 画幅选取器写的是 `studentParams.aspectRatio`，而框体尺寸读的是 `data.aspectRatio` ——
 *          两边不是一个字段，学生选了 9:16 框体纹丝不动。
 *   图4「右边的滚轮目前只能用鼠标手动拉，用滚轮就是画布缩放」
 *        → 文本区要能滚、文字要能选中；**修法必须是 xyflow 的 `nowheel`**，见下面那条反向自检。
 *   图5「全能参考的模式，为什么画面那还显示首帧尾帧」
 *        → 面板显示哪一行跟着**模式**走（这一条的主体在 p109，这里只钉"四类框体一致"那一半）。
 *
 * ⚠️ 这四条都是 `.jsx` 里的读面，node 里导不进来 —— 所以守卫只能读源码钉形状；
 *    **真观感**由 `.tmp/fixture-canvas-omni.mjs` + `.tmp/then-canvas-ui.mjs` 在真浏览器里核
 *    （脚本见第二十八轮交接 §六），那两条是"人不在时也能重跑"的证据。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const canvas = read('packages/canvas/src/index.jsx');
const boxRules = read('packages/canvas/src/boxRules.js');

/* ── 图1：四类框体都要有引导插画，老占位不能留 ─────────────────────────────── */
const illustrationSites = (canvas.match(/learning-node__art--illustration/g) || []).length;
check('① 引导插画用在**四类框体 + 文字框体**上（五处：图片/视频/动画/音乐/文字）',
  illustrationSites >= 5, `实际 ${illustrationSites} 处`);
check('① 老的 emoji 占位文案不能再留（用户报的"视频框体还是原始图"就是它）',
  !/在底部面板写提示词，生成短片</.test(canvas)
  && !/在底部面板写提示词，生成动画</.test(canvas)
  && !/在底部面板写歌词或描述，生成音乐</.test(canvas)
  && !/在底部面板写提示词，生成文字</.test(canvas));
check('① 插画地址仍走 boxRules 的常量（换图只改一处，别在 JSX 里写死路径）',
  /import \{ BOX_EMPTY_ART/.test(canvas) && /BOX_EMPTY_ART = '/.test(boxRules));

/* ── 图2：框体尺寸跟学生选的画幅走 ────────────────────────────────────────── */
check('② 框体显示比例优先"学生选的"，其次课包定的（没选＝空串，交给 CSS 默认）',
  /function boxDisplayRatio\(data\) \{/.test(canvas)
  && /const picked = String\(data\?\.studentParams\?\.aspectRatio \|\| ''\)\.trim\(\);/.test(canvas)
  && /return picked \|\| String\(data\?\.aspectRatio \|\| ''\);/.test(canvas));
const nodeFrameSites = (canvas.match(/aspectRatio=\{boxDisplayRatio\(data\)\}/g) || []).length;
check('② 所有 NodeFrame 都改读它（少一处就是"那一类框体还是不变形"）',
  nodeFrameSites >= 8, `实际 ${nodeFrameSites} 处`);
check('② 画幅选取器写的仍是 studentParams（两处桥在一起才对得上）',
  /updateNode\(id, \{ studentParams: \{ \.\.\.student, \[key\]: value \} \}\)/.test(canvas));

/* ── 图4：滚轮滚文本用 xyflow 的 nowheel ─────────────────────────────────── */
check('④ 文本区挂的是 xyflow 认的 `nowheel` 类（不是 React 的 onWheel）',
  /export const NO_WHEEL_ZOOM_CLASS = 'nowheel';/.test(canvas)
  && /learning-node__text-wrap nodrag \$\{NO_WHEEL_ZOOM_CLASS\}/.test(canvas)
  && /learning-node__prompt nodrag \$\{NO_WHEEL_ZOOM_CLASS\}/.test(canvas));
// 【反向自检】这一条最容易"改回去"：React 的合成 onWheel 比 xyflow 的原生监听器晚跑，
// 写成 stopPropagation 看着对、实测没用（第一版就是那样，真浏览器里画布照样缩放）。
check('【反向自检】不能退回 React 的 onWheel 截滚轮（xyflow 的原生监听器比它先跑，拦不住）',
  !/onWheel=\{keepWheelForScroll\}/.test(canvas) && !/function keepWheelForScroll/.test(canvas));
check('④ 文本仍可选中（画布是拖拽面，节点里的文字默认选不中）',
  /user-select: text/.test(read('packages/canvas/src/styles.css')));

/* ── 图5：这一半在 p109，这里只钉"别把两个量又合并回去" ───────────────────── */
check('⑤ 面板那一行（omniRow）与发给上游的素材（useOmni）是两个量，且都出自同一个 plan',
  /const omniRow = lockedMode \? lockedMode === 'OMNI_REFERENCE' : useOmni;/.test(canvas)
  && /omni=\{videoInputPlan\.omniRow\}/.test(canvas)
  && /referenceAssets: useOmni \? allRefs : \[\]/.test(canvas));

console.log('');
if (failures) { console.log(`✗ p129 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p129 画布框体四条观感/交互：全部通过');
