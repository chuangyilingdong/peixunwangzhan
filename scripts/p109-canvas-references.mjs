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
  requestTemplateFor,
  normalizeAudioRole,
  audioRoleShortLabel,
  AUDIO_ROLES,
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
const viaDefault = await generationOptionsFor({ context: {}, modality: 'IMAGE', policy: noTemplatePolicy, selection: { channelId: 'ch-img', model: 'zhenzhen-image-g-v2-lowprice' }, box: {}, referenceAssets: refs });
check('没配模板的图片渠道（= 生产现状）走默认模板也能带上参考', viaDefault.referenceAssets?.length === 1,
  JSON.stringify(viaDefault.referenceAssets));

// 真正的门禁：管理员**显式**配了一份不带任何参考占位符的图片模板 → 上游必然收不到图。
// 这种情况必须当场拒绝：静默丢掉会出来一张跟参考无关的图，比报错糟得多。
const badTemplatePolicy = { channels: [{ id: 'ch-img', model: 'm', requestTemplates: { IMAGE: { model: '{{model}}', prompt: '{{prompt}}', n: 1 } } }] };
let refused = null;
try {
  await generationOptionsFor({ context: {}, modality: 'IMAGE', policy: badTemplatePolicy, selection: { channelId: 'ch-img', model: 'm' }, box: {}, referenceAssets: refs });
} catch (error) { refused = error; }
check('显式模板带不了参考图时 → 当场拒绝（不再静默出一张无关的图）',
  refused !== null && /GENERATION_REFERENCES_UNSUPPORTED|不能带参考图/.test(String(refused.message || refused.code || refused)),
  refused ? String(refused.code || refused.message) : '(没有报错，说明又被静默丢掉了)');

const carriesPolicy = { channels: [{ id: 'ch-img', model: 'm', requestTemplates: { IMAGE: { model: '{{model}}', prompt: '{{prompt}}', images: '{{referenceImageUrls}}' } } }] };
const carried = await generationOptionsFor({ context: {}, modality: 'IMAGE', policy: carriesPolicy, selection: { channelId: 'ch-img', model: 'm' }, box: {}, referenceAssets: refs });
check('模板能带参考时 → 参考进了 options.referenceAssets（这一层以前只有 VIDEO 分支设）',
  Array.isArray(carried.referenceAssets) && carried.referenceAssets.length === 1 && carried.referenceAssets[0].url === IMAGE_REF.url,
  JSON.stringify(carried.referenceAssets));

const noRefs = await generationOptionsFor({ context: {}, modality: 'IMAGE', policy: noTemplatePolicy, selection: { channelId: 'ch-img', model: 'zhenzhen-image-g-v2-lowprice' }, box: {}, referenceAssets: [] });
check('没连参考图时不做任何拦截（纯文生图照样能生成）', noRefs.referenceAssets === undefined);

// 另一条静默丢法：素材库预置图 / 过期临时链接 / data: 地址都解析不出可公开访问的地址，
// 那时上游同样一张图都收不到。这条要在**解析之后**拦（模板检查拦不到它）。
const generationSource = read('apps/server/src/routes/aiGeneration.js');
check('解析不出公开地址的参考图也明确拒绝（GENERATION_REFERENCE_UNRESOLVED）',
  /GENERATION_REFERENCE_UNRESOLVED/.test(generationSource) && /requested\.length && !resolvedReferences\.length/.test(generationSource));
check('这条拦截只对 IMAGE / VIDEO 生效（别把别的模态误伤）',
  /modalityKey === 'IMAGE' \|\| modalityKey === 'VIDEO'/.test(generationSource));
// 视频那套「输入画面」判据（首帧/尾帧/参考互斥）**不能套到图片上**：
// 图片现在也会带参考图，套上去会报「当前视频模型不支持多素材参考」（实测到过，403）。
check('视频那套输入画面判据限定为 VIDEO 模态（否则图片带参考图会被误拒）',
  /if \(frameCheck && String\(modality \|\| ''\)\.toUpperCase\(\) === 'VIDEO'\) assertVideoFrames\(frameCheck\)/.test(generationSource));

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

/* ── ④ 视频的「全能参考」：参考必须真的进请求体（2026-09-21 用户报的那条）──────────
   用户原话：「视频生成出来跟参考也不一样啊。完全是两种东西啊…现在还有视频/音乐这些参考」。
   根因：模型声明 OMNI_REFERENCE 时素材走 `options.referenceAssets`（不当首/尾帧），
   可**默认视频模板里没有 `{{referenceItems}}`** → 渲染请求体时参考被静默丢掉，
   出来的视频与参考毫无关系。（图片那条 2026-09-17 修过；视频这条两样都缺：
   默认模板 + "模板带不了就当场拒绝"。）
   音乐那条**不算丢**：客户端的音乐 payload 里根本没有参考，UI 也没那行 —— 这是有意的。 */
check('视频默认模板里有一条能放参考的位置（VIDEO_OMNI）',
  /\{\{referenceItems\}\}/.test(JSON.stringify(DEFAULT_REQUEST_TEMPLATES.VIDEO_OMNI || {})),
  JSON.stringify(Object.keys(DEFAULT_REQUEST_TEMPLATES)));

// 生产现状的形状：视频渠道只写了模型名 + **在渠道里声明了 H3 的四种输入方式**（没配任何模板 → 走默认）。
// ⚠️ 这一句声明就是 bug 的入口：声明了 OMNI_REFERENCE，客户端才会把连过来的素材当**参考**发。
const videoChannel = {
  id: 'ch-video',
  model: 'MiniMax-H3',
  modelCapabilities: {
    'MiniMax-H3': { aspectRatios: ['16:9', '9:16'], resolutions: ['480P'], durations: [5, 10, 15], audio: true, inputModes: ['TEXT', 'FIRST_FRAME', 'FIRST_LAST_FRAME', 'OMNI_REFERENCE'] },
  },
};
const videoOptions = await generationOptionsFor({
  context: {}, modality: 'VIDEO', policy: { channels: [videoChannel] },
  selection: { channelId: 'ch-video', model: 'MiniMax-H3' }, box: {}, referenceAssets: [IMAGE_REF],
});
check('① 服务端把参考放进 options.referenceAssets，且**不**设首帧（全能参考与首尾帧不混用）',
  videoOptions.referenceAssets?.length === 1 && videoOptions.referenceAssets[0].url === IMAGE_REF.url && !videoOptions.firstFrameUrl,
  JSON.stringify(videoOptions));

const chosenVideoTemplate = requestTemplateFor(videoChannel, 'VIDEO', { model: 'MiniMax-H3', withReferences: true });
check('② 带参考时选到的是全能参考那条模板（不是纯文生那条）',
  /\{\{referenceItems\}\}/.test(JSON.stringify(chosenVideoTemplate || {})), JSON.stringify(chosenVideoTemplate));

const renderedVideo = renderRequestTemplate(chosenVideoTemplate, {
  model: 'MiniMax-H3', prompt: '图片动起来', durationSeconds: 5, aspectRatio: '16:9', resolution: '480p', audio: true, referenceAssets: [IMAGE_REF],
});
check('③ 渲染出来的请求体里**真的带着那张参考图**（content[].image_url.url）',
  JSON.stringify(renderedVideo.content || []).includes(IMAGE_REF.url), JSON.stringify(renderedVideo).slice(0, 220));

check('④ 没连参考时不会选到全能参考模板（纯文生视频的形状不变）',
  !/\{\{referenceItems\}\}/.test(JSON.stringify(requestTemplateFor(videoChannel, 'VIDEO', { model: 'MiniMax-H3' }) || {})),
  JSON.stringify(requestTemplateFor(videoChannel, 'VIDEO', { model: 'MiniMax-H3' })));

// 另一个静默丢法：管理员**显式**配了一份带不了参考的视频模板 → 上游收不到图，必须当场拒绝
// （渠道仍要声明 OMNI_REFERENCE，否则根本走不到全能参考那一支）
const badVideoPolicy = {
  channels: [{
    id: 'ch-video', model: 'MiniMax-H3',
    modelCapabilities: videoChannel.modelCapabilities,
    requestTemplates: { VIDEO: { model: '{{model}}', prompt: '{{prompt}}' } },
  }],
};
let videoRefused = null;
try {
  await generationOptionsFor({ context: {}, modality: 'VIDEO', policy: badVideoPolicy, selection: { channelId: 'ch-video', model: 'MiniMax-H3' }, box: {}, referenceAssets: [IMAGE_REF] });
} catch (error) { videoRefused = error; }
check('⑤ 显式模板带不了参考时当场拒绝（不再静默出一段无关的视频）',
  videoRefused !== null && /GENERATION_REFERENCES_UNSUPPORTED|不能带参考素材/.test(String(videoRefused.message || videoRefused.code || videoRefused)),
  videoRefused ? String(videoRefused.code || videoRefused.message) : '(没有报错，说明又被静默丢掉了)');

/* ── ③b 客户端「连过来的素材怎么用」的判定（2026-09-21 修的那条语义）────────────
   学生连一张图 + 写「图片动起来」→ 要的是**这张图动起来**（首帧），不是"再画一段像它的"。
   原逻辑只要模型声明了全能参考就一律当参考发 → 出来的画面与参考毫无关系。 */
check('没锁生成方式时：能当帧就当帧（全是图片、1~2 张、模型支持帧 → 走首帧）',
  // 2026-09-21 晚：这条判定多了"课包锁定的生成方式"这一层（锁定赢过推断，见 p122 ⑦）——
  // 但**没锁**时的默认行为必须还是原来那套，别把默认情形改了。
  /const useFrames = lockedMode/.test(canvas)
  && /supportsFirstFrame && frameUrls\.length > 0 && frameUrls\.length <= frameCapacity && frameUrls\.length === allRefs\.length/.test(canvas)
  && /sourceAssetUrl: useFrames \? \(frameUrls\[0\]/.test(canvas));
check('没锁生成方式时：够不着帧的（多张图 / 视频 / 音频混合）才走全能参考',
  /: \(!useFrames && omni && allRefs\.length > 0\)/.test(canvas));
check('尾帧判定用 FIRST_LAST_FRAME（原来写的 LAST_FRAME，尾帧永远不亮）',
  /const supportsLastFrame = modes\.includes\('FIRST_LAST_FRAME'\)/.test(canvas) && !/\.includes\('LAST_FRAME'\)/.test(canvas));
// ⚠️ 2026-09-22 改判据（**不是把断言删掉**）：用户报「图5是全能参考的模式，为什么画面那还显示首帧尾帧」
//    —— 面板显示哪一行原来跟着 `useOmni`，而它要求"已经连了东西"才为真；锁成全能参考但还没连线时
//    就退回「画面/首帧未连接」那一行（那两种画面在这个模式下根本不存在）。
//    现在拆成两个量，**都从同一个 videoInputPlan 出来**：
//      · 面板那一行跟着**模式**走（omniRow：锁了就按锁的，没锁＝useOmni）；
//      · 发给上游的素材跟着**实际连线**走（useOmni + allRefs）。
//    两者只在"一件都没连"时不同，而那时 payload 本来就是空的 —— 所以"显示一套、生成另一套"仍然不成立。
check('面板那行与生成 payload 读**同一处**判定（不会生成一套、显示另一套）—— 锁定时面板按模式、payload 按连线',
  /omni=\{videoInputPlan\.omniRow\}/.test(canvas)
  && /referenceAssets=\{videoInputPlan\.allRefs\}/.test(canvas)
  && /const omniRow = lockedMode \? lockedMode === 'OMNI_REFERENCE' : useOmni;/.test(canvas)
  && /referenceAssets: useOmni \? allRefs : \[\]/.test(canvas));

/* ── ⑤ 按模型的内置模板：2.5 **低价扩展版**一个不支持的字都不能带（2026-09-21 用户报）─────────
   用户原话：「为什么使用 2.5 这个模型会报错…2.0 的模型好像是可以正常的」，
   上游原话：「AI 供应商调用失败（上游：output_format is not supported by this model）」。
   ⚠️ **第一版修错了**（别再按那个思路改回去）：以为是"字段放错了位置"，给 2.5 系换成顶层
   output_format —— 线上照样报同一个错。上游文档（api.seedance.nz/docs/llms.txt）写着 2.5 有**两款**：
     · Flare / Sunburst：收 output_format / quality / background（放**顶层**）；
     · 低价扩展版（线上在用的 `zhenzhen-image-g-v2.5-lowprice`）：文档原话
       「此扩展版不提供质量档位、输出格式、透明背景或流式选项」→ 传了就是 400。
   完整断言（含渲染出来的请求体逐字段核对、缓存/镜像那条）在 p125。 */
const template25 = requestTemplateFor({ id: 'ch-image', model: 'zhenzhen-image-g-v2.5-lowprice' }, 'IMAGE', { model: 'zhenzhen-image-g-v2.5-lowprice' });
check('① 2.5 低价版模板里**没有** output_format（上游对这款明确不支持）',
  !/output_format/.test(JSON.stringify(template25 || {})) && !template25?.metadata, JSON.stringify(template25));
check('② 2.0 / 其他模型仍是原来那份（metadata 里带 resolution 与 output_format）—— 线上没坏就别动',
  requestTemplateFor({ id: 'ch', model: 'zhenzhen-image-g-v2-lowprice' }, 'IMAGE', { model: 'zhenzhen-image-g-v2-lowprice' })?.metadata?.output_format === 'png');
check('③ 2.5 的模板仍然带得动参考图（顶层 images → {{referenceImageUrls}}）—— 否则图片那条门禁会当场拒绝',
  /\{\{referenceImageUrls\}\}/.test(JSON.stringify(template25)));
check('④ 管理员在渠道/模型上配过的模板**优先**于内置默认（内置只是兜底）',
  // ⚠️ 形状：`modelRequestTemplates[模型名]` 就是**那份模板对象**（不是按模态再分一层 ——
  //    生产里 MiniMax-H3 那条就是这么存的）。
  JSON.stringify(requestTemplateFor({ modelRequestTemplates: { 'zhenzhen-image-g-v2.5-lowprice': { model: 'x' } } }, 'IMAGE', { model: 'zhenzhen-image-g-v2.5-lowprice' })) === JSON.stringify({ model: 'x' }));
const body25 = renderRequestTemplate(template25, { ...baseContext, aspectRatio: '16:9', resolution: '2k', referenceAssets: [IMAGE_REF] });
check('⑤ 渲染出来的 2.5 请求体：resolution / size 在顶层、images 是那张参考图，且没有 output_format / metadata',
  !('output_format' in body25) && body25.resolution === '2k' && body25.size === '16:9'
  && JSON.stringify(body25.images) === JSON.stringify([IMAGE_REF.url]) && !('metadata' in body25),
  JSON.stringify(body25));

/* ── ⑥ 参考素材超上限：当场报错，不静默截断（2026-09-21 用户给的上游口径：图片 9 / 视频 3 / 音频 3）──
   以前超过上限的那几个是**悄悄丢掉**的：学生连了 10 张图、我们只发 9 张，出来的是"少了点什么"
   的结果，而他完全不知道为什么。上限就是上游文档里那几个数（服务端 REFERENCE_LIMITS 同源）。 */
const { resolveReferenceAssets } = await import('../apps/server/src/routes/aiGeneration.js');
const manyImages = Array.from({ length: 10 }, (_, index) => ({ type: 'IMAGE', url: `https://example.test/i${index}.png` }));
let tooMany = null;
try { await resolveReferenceAssets('proj-none', manyImages); } catch (error) { tooMany = error; }
check('连了 10 张图片参考 → 明确报错（上限 9），不静默只发 9 张',
  tooMany?.code === 'GENERATION_REFERENCES_TOO_MANY' && /最多 9 张图片/.test(String(tooMany?.message || '')),
  String(tooMany?.message || '(没报错)'));
const tooManyVideos = Array.from({ length: 4 }, (_, index) => ({ type: 'VIDEO', url: `https://example.test/v${index}.mp4` }));
let tooManyVideo = null;
try { await resolveReferenceAssets('proj-none', tooManyVideos); } catch (error) { tooManyVideo = error; }
check('连了 4 段视频参考 → 明确报错（上限 3）',
  tooManyVideo?.code === 'GENERATION_REFERENCES_TOO_MANY' && /最多 3 段视频/.test(String(tooManyVideo?.message || '')),
  String(tooManyVideo?.message || '(没报错)'));
// 9 张（没超上限）但一个都解析不出来 → 现在**当场报错**（口径：静默丢掉 = 出来一段与参考无关的作品）
let allDropped = null;
try { await resolveReferenceAssets('proj-none', manyImages.slice(0, 9)); } catch (error) { allDropped = error; }
check('9 张都在但一张都留不住 → 报 GENERATION_MEDIA_UNUSABLE（不再静默变成"没有输入"）',
  allDropped?.code === 'GENERATION_MEDIA_UNUSABLE' && /都不能发给 AI/.test(String(allDropped?.message || '')),
  String(allDropped?.message || '(没报错)'));

/* ── ⑦ 全能参考里的**音频**：第一条必须当「驱动音频」发（2026-09-21 用户报「音频无法参考」）──────
   用户原话：「视频全能参考好像音频无法参考，刚才我生成了个让他参考音频前5秒，结果做出来的视频
   跟音频完全不一样」。根因：`{{referenceItems}}` 把音频一律发成 `reference_audio` —— 上游文档
   （H3 专节「驱动音频与声音参考」）写明它只是**声音参考**（音色风格），**不驱动画面**；
   要画面跟着音频动、并把这条音频留在产物里，得发 `drive_audio`（上游缺省 `lock_source`）。
   实测判据：发 reference_audio 时产物音轨与源音频互相关 0.018（= 没用上）——
   对照脚本 deploy/production/live-audio-drive-check.mjs（直连上游，¥0.75 一跑）。 */
const AUDIO_REF = { type: 'AUDIO', url: 'https://example.test/beat.mp3' };
const AUDIO_REF_2 = { type: 'AUDIO', url: 'https://example.test/voice.wav' };
const omniItems = renderRequestTemplate({ content: [{ type: 'text', text: '{{prompt}}' }, '{{referenceItems}}'] }, {
  ...baseContext, referenceAssets: [IMAGE_REF, AUDIO_REF, AUDIO_REF_2, VIDEO_REF],
}).content.filter((item) => item.type !== 'text');
const roleOf = (items, url) => items.find((item) => JSON.stringify(item).includes(url))?.role || '';
check('① 第一条音频发成 drive_audio（画面跟着音频动 + 默认 lock_source 把这条音频留在产物里）',
  roleOf(omniItems, AUDIO_REF.url) === 'drive_audio', JSON.stringify(omniItems));
check('② 其余音频仍是 reference_audio（上游：3 条参考音频 + 1 条驱动音频，分开计数）',
  roleOf(omniItems, AUDIO_REF_2.url) === 'reference_audio');
check('③ 图片/视频的角色没被带歪',
  roleOf(omniItems, IMAGE_REF.url) === 'reference_image' && roleOf(omniItems, VIDEO_REF.url) === 'reference_video');

// 音频角色由**课包锁**（用户 2026-09-21 口径：只要两档 —— 对口型 / 声音参考）。
//   LIP_SYNC（对口型，默认）：第一条当驱动；VOICE_REFERENCE（声音参考）：全部只当音色、**一条驱动都不发**。
const voiceRefItems = renderRequestTemplate({ content: [{ type: 'text', text: '{{prompt}}' }, '{{referenceItems}}'] }, {
  ...baseContext, audioRole: 'VOICE_REFERENCE', referenceAssets: [IMAGE_REF, AUDIO_REF, AUDIO_REF_2],
}).content.filter((item) => item.type !== 'text');
check('④ 课包锁成「声音参考」→ 所有音频都发 reference_audio，一条 drive_audio 都没有',
  roleOf(voiceRefItems, AUDIO_REF.url) === 'reference_audio' && roleOf(voiceRefItems, AUDIO_REF_2.url) === 'reference_audio'
  && !JSON.stringify(voiceRefItems).includes('drive_audio'), JSON.stringify(voiceRefItems));
check('⑤ 课包锁成「对口型」/留空/不认识的值 → 都按对口型（第一条驱动）—— 旧课包行为不变',
  ['LIP_SYNC', '', undefined, 'WHATEVER'].every((value) => roleOf(renderRequestTemplate({ content: ['{{referenceItems}}'] }, {
    ...baseContext, audioRole: value, referenceAssets: [AUDIO_REF],
  }).content, AUDIO_REF.url) === 'drive_audio')
  && normalizeAudioRole('') === 'LIP_SYNC' && normalizeAudioRole('voice_reference') === 'VOICE_REFERENCE' && normalizeAudioRole('garbage') === 'LIP_SYNC');
check('⑥ 两个短标签就是老师/学生看到的那两个词（面板与后台共用同一处）',
  audioRoleShortLabel('LIP_SYNC') === '对口型' && audioRoleShortLabel('VOICE_REFERENCE') === '声音参考');

// 配置那一半：模板里钉 `audio_control: {mode: native}` 会把驱动音频**彻底中和**（native 不锁驱动音频，
// 且 `add_drive_as_reference` 在 native 下默认 false）= 这条音频对产物一点作用都没有。
// 这种组合必须**当场拒绝**（静默中和比报错糟得多），而不是照发一段与音频无关的视频。
const pinnedAudioChannel = {
  id: 'ch-video-pinned', model: 'MiniMax-H3',
  modelCapabilities: videoChannel.modelCapabilities,
  modelRequestTemplates: {
    'MiniMax-H3': { model: '{{model}}', content: [{ type: 'text', text: '{{prompt}}' }, '{{referenceItems}}'], duration: '{{durationSecondsNumber}}', resolution: '{{resolution}}', ratio: '{{aspectRatio}}', audio_control: { mode: 'native', add_drive_as_reference: false } },
  },
};
let pinnedRefused = null;
try {
  await generationOptionsFor({ context: {}, modality: 'VIDEO', policy: { channels: [pinnedAudioChannel] }, selection: { channelId: 'ch-video-pinned', model: 'MiniMax-H3' }, box: {}, referenceAssets: [AUDIO_REF] });
} catch (error) { pinnedRefused = error; }
check('④ 模板把音轨钉成 native（且不当声音参考）+ 连了音频 → 当场拒绝并说清怎么改',
  pinnedRefused?.code === 'GENERATION_AUDIO_DRIVE_BLOCKED' && /audio_control/.test(String(pinnedRefused?.message || '')),
  String(pinnedRefused?.code || '(没报错，说明音频会被静默中和)'));
// 反向：同一份模板，但**没连音频** → 不许拦（钉 native 的课不至于整节课生成不了）
let pinnedNoAudio = null;
try {
  pinnedNoAudio = await generationOptionsFor({ context: {}, modality: 'VIDEO', policy: { channels: [pinnedAudioChannel] }, selection: { channelId: 'ch-video-pinned', model: 'MiniMax-H3' }, box: {}, referenceAssets: [IMAGE_REF] });
} catch (error) { pinnedNoAudio = error; }
check('【反向自检】没连音频时那条拦截不生效（别把钉 native 的课整个拦住）',
  pinnedNoAudio !== null && !pinnedNoAudio.code && pinnedNoAudio.referenceAssets?.length === 1,
  String(pinnedNoAudio?.code || JSON.stringify(pinnedNoAudio || {}).slice(0, 120)));
// 反向：模板本来就对（没有 audio_control = 迁移后的生产配置）→ 不许误拦
let plainAudio = null;
try {
  plainAudio = await generationOptionsFor({ context: {}, modality: 'VIDEO', policy: { channels: [videoChannel] }, selection: { channelId: 'ch-video', model: 'MiniMax-H3' }, box: {}, referenceAssets: [AUDIO_REF] });
} catch (error) { plainAudio = error; }
check('【反向自检】模板里没有 audio_control（迁移后的生产配置）→ 音频参考照常放行',
  plainAudio !== null && !plainAudio.code && plainAudio.referenceAssets?.[0]?.url === AUDIO_REF.url,
  String(plainAudio?.code || '(被误拦了)'));
// 反向：课包锁成「声音参考」时**不发 drive_audio** → 钉 native 不会中和任何东西，不许拦
// （拦了就是把"只想借音色"的课整节挡住 —— 那是误伤，不是保护）
let voiceRefPinned = null;
try {
  voiceRefPinned = await generationOptionsFor({
    context: {}, modality: 'VIDEO', policy: { channels: [pinnedAudioChannel] }, selection: { channelId: 'ch-video-pinned', model: 'MiniMax-H3' },
    box: { audioRole: 'VOICE_REFERENCE' }, referenceAssets: [AUDIO_REF],
  });
} catch (error) { voiceRefPinned = error; }
check('【反向自检】锁成「声音参考」时那条拦截不生效（不发驱动音频，native 没东西可中和）',
  voiceRefPinned !== null && !voiceRefPinned.code && voiceRefPinned.audioRole === 'VOICE_REFERENCE',
  String(voiceRefPinned?.code || JSON.stringify(voiceRefPinned || {}).slice(0, 120)));
// 正面：锁成「对口型」时 options.audioRole 要真的带上（模板渲染靠它决定 role）
let lipSyncOption = null;
try {
  lipSyncOption = await generationOptionsFor({ context: {}, modality: 'VIDEO', policy: { channels: [videoChannel] }, selection: { channelId: 'ch-video', model: 'MiniMax-H3' }, box: { audioRole: 'LIP_SYNC' }, referenceAssets: [AUDIO_REF] });
} catch (error) { lipSyncOption = error; }
check('① 对口型：options.audioRole 传到渲染层（默认/留空也算对口型）',
  lipSyncOption?.audioRole === 'LIP_SYNC' && AUDIO_ROLES.includes('LIP_SYNC') && AUDIO_ROLES.includes('VOICE_REFERENCE'),
  String(lipSyncOption?.audioRole || lipSyncOption?.code || '(没带上)'));

assert.ok(true);
console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
