/**
 * P109 画布「引用（连线素材）真的生效了吗」+ 缩放上限（2026-09-17，用户报的三个问题）。
 *
 * 用户原话：
 *   ①「引用没有真实生效，你看左边的图，右边的图，完全是 2 个图。」
 *   ②「画布放大最多就放大这么多了」（对照平台能放大到 800%）
 *   ③「如果连线了是有缩略图的，现在我们图 1 没有了，我记得以前是有的」
 *
 * ①的根因是**三层都在丢参考图**（这条守卫每层都钉）：
 *   前端：生图 payload 里没有 referenceAssets（只有视频分支有）；
 *   服务端：generationOptionsFor 只在 VIDEO 分支设 options.referenceAssets；
 *   请求模板：图片默认模板里没有能放参考图的位置（上游要的是顶层 `images` 数组）。
 * 而且**全程静默** —— 学生连着参考图、界面写着「引用中」，出来的是另一张画。
 *
 * ③的根因：那次「@ 引用改成内联芯片」的改动顺手把面板里的参考缩略图条删了，
 *   理由写的是「下面『参考』那行也写了连接情况」—— 可那行**只在视频/动画节点渲染**，
 *   生图框体压根没有，于是连了参考图也看不见。
 *
 * 这个守卫的逻辑部分**真跑纯函数与生成选项拼装**（不是读源码猜），
 * 前端那几条是源码断言（JSX 没法在 node 里跑）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const {
  DEFAULT_REQUEST_TEMPLATES,
  TEMPLATE_PLACEHOLDERS,
  renderRequestTemplate,
} = await import('../apps/server/src/services/modelCapabilities.js');
const { generationOptionsFor } = await import('../apps/server/src/routes/aiGeneration.js');

const IMAGE_REF = { type: 'IMAGE', url: 'https://example.test/monkey.png' };
const VIDEO_REF = { type: 'VIDEO', url: 'https://example.test/clip.mp4' };
const baseContext = { model: 'm', prompt: '把手里的火枪变成金箍棒', aspectRatio: '16:9', resolution: '1k' };

/* ── ① 请求体：参考图必须真的进去，且纯文生图的形状不变 ──────────────────── */
check('图片默认模板里有能放参考图的位置', /\{\{referenceImageUrls\}\}/.test(JSON.stringify(DEFAULT_REQUEST_TEMPLATES.IMAGE)));
check('referenceImageUrls 是合法占位符（管理员模板里也能用）', TEMPLATE_PLACEHOLDERS.includes('referenceImageUrls'));

const withRef = renderRequestTemplate(DEFAULT_REQUEST_TEMPLATES.IMAGE, { ...baseContext, referenceAssets: [IMAGE_REF, VIDEO_REF] });
check('连了参考图 → 顶层 images 里就是那张图（且只收图片，视频不进 images）',
  JSON.stringify(withRef.images) === JSON.stringify([IMAGE_REF.url]), JSON.stringify(withRef.images));
check('原来那些字段一个没丢（比例/清晰度/张数还在）',
  withRef.model === 'm' && withRef.prompt === baseContext.prompt && withRef.n === 1
  && withRef.size === '16:9' && withRef.metadata?.resolution === '1k');

const plain = renderRequestTemplate(DEFAULT_REQUEST_TEMPLATES.IMAGE, baseContext);
// ⚠️ 断言的是**序列化之后**的形状：渲染器会把 images 建成 undefined，JSON.stringify 再把它丢掉。
//    也就是说「没连参考图」发出去的请求体与改造前逐字一致 —— 这是不加 images 就得保证的事。
const plainSent = JSON.parse(JSON.stringify(plain));
check('没连参考图 → 发出去的请求体里连 images 这个键都没有（纯文生图形状不变）',
  !('images' in plainSent), JSON.stringify(Object.keys(plainSent)));
check('没连参考图时的字段集合与改造前一致',
  JSON.stringify(Object.keys(plainSent)) === JSON.stringify(['model', 'prompt', 'n', 'size', 'metadata']), JSON.stringify(Object.keys(plainSent)));

// 视频那套（MiniMax 的 content[]）不能被这条改动带坏：仍然按对象进 content
const videoBody = renderRequestTemplate({ content: [{ type: 'text', text: '{{prompt}}' }, '{{referenceItems}}'] }, { ...baseContext, referenceAssets: [IMAGE_REF, VIDEO_REF] });
check('视频的 referenceItems 没被改坏（仍然是 content 项对象、按类型带 role）',
  Array.isArray(videoBody.content) && videoBody.content.length === 3
  && videoBody.content[1].image_url?.url === IMAGE_REF.url && videoBody.content[1].role === 'reference_image'
  && videoBody.content[2].video_url?.url === VIDEO_REF.url && videoBody.content[2].role === 'reference_video',
  JSON.stringify(videoBody.content));

/* ── ① 服务端拼装：图片的参考进 options；模板带不了就明确报错，不静默 ──────── */
const refs = [IMAGE_REF];
// box 传个空对象：避开 resolveLessonGenerationBox 的库查询，其余逻辑都是真的
const noTemplatePolicy = { channels: [{ id: 'ch-img', model: 'zhenzhen-image-g-v2-lowprice', modelCapabilities: {} }] };
// 没配模板的渠道 = **生产里那个图片渠道的实际情形**：它会落到默认图片模板，
// 而默认模板现在带得动参考图 —— 所以这一条不能靠「没模板」来验，它必须能带上。
const viaDefault = generationOptionsFor({ context: {}, modality: 'IMAGE', policy: noTemplatePolicy, selection: { channelId: 'ch-img', model: 'zhenzhen-image-g-v2-lowprice' }, box: {}, referenceAssets: refs });
check('没配模板的图片渠道（= 生产现状）走默认模板也能带上参考', viaDefault.referenceAssets?.length === 1,
  JSON.stringify(viaDefault.referenceAssets));

// 真正的门禁：管理员**显式**配了一份不带任何参考占位符的图片模板 → 上游必然收不到图。
// 这种情况必须当场拒绝：静默丢掉会出来一张跟参考无关的图，比报错糟得多。
const badTemplatePolicy = { channels: [{ id: 'ch-img', model: 'm', requestTemplates: { IMAGE: { model: '{{model}}', prompt: '{{prompt}}', n: 1 } } }] };
let refused = null;
try {
  generationOptionsFor({ context: {}, modality: 'IMAGE', policy: badTemplatePolicy, selection: { channelId: 'ch-img', model: 'm' }, box: {}, referenceAssets: refs });
} catch (error) { refused = error; }
check('显式模板带不了参考图时 → 当场拒绝（不再静默出一张无关的图）',
  refused !== null && /GENERATION_REFERENCES_UNSUPPORTED|不能带参考图/.test(String(refused.message || refused.code || refused)),
  refused ? String(refused.code || refused.message) : '(没有报错，说明又被静默丢掉了)');

const carriesPolicy = { channels: [{ id: 'ch-img', model: 'm', requestTemplates: { IMAGE: { model: '{{model}}', prompt: '{{prompt}}', images: '{{referenceImageUrls}}' } } }] };
const carried = generationOptionsFor({ context: {}, modality: 'IMAGE', policy: carriesPolicy, selection: { channelId: 'ch-img', model: 'm' }, box: {}, referenceAssets: refs });
check('模板能带参考时 → 参考进了 options.referenceAssets（这一层以前只有 VIDEO 分支设）',
  Array.isArray(carried.referenceAssets) && carried.referenceAssets.length === 1 && carried.referenceAssets[0].url === IMAGE_REF.url,
  JSON.stringify(carried.referenceAssets));

const noRefs = generationOptionsFor({ context: {}, modality: 'IMAGE', policy: noTemplatePolicy, selection: { channelId: 'ch-img', model: 'zhenzhen-image-g-v2-lowprice' }, box: {}, referenceAssets: [] });
check('没连参考图时不做任何拦截（纯文生图照样能生成）', noRefs.referenceAssets === undefined);

// 另一条静默丢法：素材库预置图 / 过期临时链接 / data: 地址都解析不出可公开访问的地址，
// 那时上游同样一张图都收不到。这条要在**解析之后**拦（模板检查拦不到它）。
const generationSource = read('apps/server/src/routes/aiGeneration.js');
check('解析不出公开地址的参考图也明确拒绝（GENERATION_REFERENCE_UNRESOLVED）',
  /GENERATION_REFERENCE_UNRESOLVED/.test(generationSource) && /requested\.length && !resolvedReferences\.length/.test(generationSource));
check('这条拦截只对 IMAGE / VIDEO 生效（别把别的模态误伤）',
  /modalityKey === 'IMAGE' \|\| modalityKey === 'VIDEO'/.test(generationSource));

/* ── ② 缩放：上限必须是 800%，而且学生找得到 ────────────────────────────── */
const canvas = read('packages/canvas/src/index.jsx');
check('缩放上限是 8（800%，对照平台同档）', /const CANVAS_MAX_ZOOM = 8;/.test(canvas) && /maxZoom=\{CANVAS_MAX_ZOOM\}/.test(canvas));
check('不再写死 1.8', !/maxZoom=\{1\.8\}/.test(canvas));
check('有 50% / 100% / 800% 三档快捷值', /const CANVAS_ZOOM_STEPS = \[0\.5, 1, 8\];/.test(canvas));
check('工具栏有缩放控件（− 百分比 ＋）与档位菜单',
  /className="learning-canvas__zoom"/.test(canvas) && /is-zoom-readout/.test(canvas) && /learning-canvas__zoom-menu/.test(canvas));
check('百分比读数是实时的（订阅 store，不是只在 onMoveEnd 更新）', /useStore\(\(state\) => state\.transform\[2\]\)/.test(canvas));
check('菜单点外面会关掉（否则一直挂在那儿）', /document\.addEventListener\('mousedown', close\)/.test(canvas));
const canvasCss = read('packages/canvas/src/styles.css');
check('缩放控件的样式在（菜单要能浮在工具栏下面）',
  /\.learning-canvas__zoom-menu \{/.test(canvasCss) && /\.learning-canvas__toolbar-btn\.is-zoom-readout \{/.test(canvasCss));

/* ── ③ 连线之后要看得见缩略图；①的前端那层也在这一段 ─────────────────────── */
check('生图 payload 带上了连线过来的参考（以前只有视频分支带）',
  /if \(slotType === 'image'\) return \{ modality: 'IMAGE'[^;]*referenceAssets: getIncomingAssetRefs\(id\)/.test(canvas));
check('生图框体在**有连线时**渲染参考缩略图行（没连线就不占高度）',
  /slotType === 'image' && getIncomingAssetRefs\(id\)\.length \? <FrameRefRows/.test(canvas));
check('缩略图那行复用的是视频那套（同一组件：序号角标 + 悬停大图 + × 断线）',
  /omni\s*\n\s*referenceAssets=\{getIncomingAssetRefs\(id\)\}/.test(canvas));
check('缩略图仍然是「受鉴权地址先解析再显示」（不能直接塞 /api 地址，会 401）',
  /const shown = useDisplayUrl\(url\);/.test(canvas));

/* ── 反向自检：别把「引用」做成了「凡生成必带参考」 ────────────────────────── */
check('【反向自检】没有任何一处把参考图塞给不带参考的模态（TEXT/MUSIC）',
  !/key === 'TEXT'[\s\S]{0,200}referenceAssets/.test(read('apps/server/src/routes/aiGeneration.js')));
check('【反向自检】视频那套门禁还在（图生视频与全能参考不能混用）',
  /GENERATION_MIXED_INPUT_MODES/.test(read('apps/server/src/routes/aiGeneration.js'))
  && /GENERATION_REFERENCES_UNSUPPORTED/.test(read('apps/server/src/routes/aiGeneration.js')));

assert.ok(true);
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
