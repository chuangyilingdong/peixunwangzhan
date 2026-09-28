/**
 * P130 作品读面改**卡片网格 + 点开放大**、音乐框体改**两行式播放器**（用户 2026-09-22 报的两条）。
 *
 *   第 1 条原话：「提交的作品，如果是画布的作品，一个画布课堂可能会产出很多图像和视频/音频，
 *   这里应该是一个卡片形式展示，点击后放大。而不是现在这样一个大图，还看不完比如下拉。」
 *   → 原来图片撑满一列、视频/音频整行铺开，一件作品出十来张图就是几屏长的瀑布。
 *
 *   第 2 条原话：「画布课堂音乐生成出来，这个播放器进度条被压缩很小了，有没有可能是两行，
 *   第一行是进度条，第二行才是操作按钮这些。」
 *   → 原生 `<audio controls>` 的内部布局改不了，窄框体里进度条就是会被压没；换成自己画的两行式。
 *
 * ⚠️ 这两条都是 `.jsx` / CSS 读面 —— 守卫钉形状，**真观感**由
 *    `.tmp/then-work-gallery.mjs` / `.tmp/then-audio-player.mjs` 在真浏览器里核（见第二十八轮交接 §六）。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const gallery = read('packages/shared/src/workMedia.jsx');
const sharedCss = read('packages/shared/src/styles.css');
const canvasIndex = read('packages/canvas/src/index.jsx');
const player = read('packages/canvas/src/AudioPlayer.jsx');
const canvasCss = read('packages/canvas/src/styles.css');

/* ── 第 1 条：卡片网格 + 点开放大 ───────────────────────────────────────── */
check('① 媒体项渲染成**卡片按钮**（点得开），不是直接铺一张大图',
  /className="work-media__card"/.test(gallery) && /onClick=\{\(\) => setOpened\(index\)\}/.test(gallery));
check('① 点开有浮层（大图），且能关（Esc + 关闭按钮 + 点背景）',
  /function MediaLightbox/.test(gallery)
  && /work-media__lightbox/.test(gallery)
  && /event\.key === 'Escape'/.test(gallery)
  && /work-media__lightbox-close/.test(gallery)
  && /onClick=\{onClose\}/.test(gallery));
check('① 网格是**多列**的（原来 auto-fit + 视频/音频 grid-column:1/-1 → 一件大图铺满）',
  /\.work-media \{ display: grid; gap: 12px; grid-template-columns: repeat\(auto-fill, minmax\(150px, 1fr\)\)/.test(sharedCss)
  && !/\.work-media__item\.is-video, \.work-media__item\.is-audio \{ grid-column: 1 \/ -1; \}/.test(sharedCss));
check('① 缩略图有**固定比例**（4:3）—— 不然一行行高矮不齐、对不齐',
  /\.work-media__thumb-img, \.work-media__thumb-video \{[^}]*aspect-ratio: 4 \/ 3/.test(sharedCss));
check('① 深浅两套主题都有（网站是浅底、画布/课堂是深底）',
  /\.c-replay \.work-media__card, \.cv-shell \.work-media__card/.test(sharedCss)
  && /\.c-replay \.work-media__player/.test(sharedCss));

/* ── 第 2 条：两行式播放器 ─────────────────────────────────────────────── */
check('② 新增播放器组件：**进度条自己一行、操作按钮另一行**',
  /function AudioPlayer/.test(player)
  && /cv-audio__progress/.test(player)
  && /cv-audio__row/.test(player));
check('② 进度条是原生 input[range]（键盘左右键也能调），不是只画了个条',
  /type="range"/.test(player));
check('② 组件从画布包导出（作品读面与音乐框体**共用同一个**，别各写一份）',
  /export \{ AudioPlayer \} from '\.\/AudioPlayer\.jsx'/.test(canvasIndex)
  && /import \{ AudioPlayer \} from '@platform\/canvas'/.test(gallery));
check('② 音乐框体用上了它（不再是原生 <audio controls>）',
  /<AudioPlayer className="learning-node__audio"/.test(canvasIndex)
  && !/<audio className="learning-node__audio" controls/.test(canvasIndex));
// 【反向自检】这条最容易退回去：原生控件"看着也能用"，但它在窄框体里就是把进度条压没 ——
// 用户报的就是这个现象。作品读面那边同理（卡片里更是塞不下原生控件）。
// ⚠️ 判之前要**去掉注释**：这两份文件里恰好都写了「原生 `<audio controls>` 做不到…」这句说明，
//    直接 grep 会命中注释、报一条假红（第一版就是这么栽的）。
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('【反向自检】两处都不许再用原生 `<audio controls>`（它在窄容器里就是把进度条压没的那个原因）',
  !/<audio[^>]*controls/.test(stripComments(gallery)) && !/<audio[^>]*controls/.test(stripComments(canvasIndex)));
check('② 播放器样式：纵向两行（.cv-audio 是 flex column），进度条占满整行',
  /\.cv-audio \{ display: flex; flex-direction: column;/.test(canvasCss)
  && /\.cv-audio__progress \{ display: block; width: 100%/.test(canvasCss));

/* ── 第 3 条：音乐框体要能**下载到本地**（用户 2026-09-28）───────────────────
   原话：「画布的音乐框体不能下载音乐到本地，右键也没有，可否像视频框体那样可以有个下载按钮」。
   真因记在 `AudioPlayer.jsx`：视频框体用的是原生 `<video controls>`，浏览器右键自带「视频另存为」；
   而音乐框体在 **2026-09-22 按第 ② 条换成了自绘的两行式**（`<audio>` 是 hidden 的）——
   原生右键菜单跟着一起没了。所以这条网盯四件事（**判之前同样先剥注释**）：
     ① 播放器里**真有**「下载到本地」的入口；
     ② 画布的音乐框体**真的接上了**（组件有、入口不显示 = 学生还是看不到，白改）；
     ③ 它必须是带 `download` 的 `<a>`（`<button>` + `window.open` 那种存不成文件、还可能直接播放）；
     ④ 地址与文件名的口径（同源 `/api/` 优先、blob 兜底、名字带扩展名）。 */
const playerCode = stripComments(player);
const canvasCode = stripComments(canvasIndex);
check('③ 播放器里有「下载到本地」入口，且是带 download 的 <a>（不是 button / window.open）',
  /cv-audio__btn--download/.test(playerCode)
  && /<a[\s\S]{0,500}?download=\{downloadFileName\(/.test(playerCode)
  && !/window\.open\([^)]*download/i.test(playerCode));
check('③ 画布的音乐框体接上了下载地址（组件有、入口不显示 = 白改）',
  /<AudioPlayer[^>]*downloadHref=\{downloadHrefFor\(rawAudioUrl, audioUrl\)\}/.test(canvasCode));
check('③ 下载地址优先用**原始 /api/ 地址**（同源才认 download 属性；服务端那条口带 attachment）',
  /function downloadHrefFor/.test(canvasCode)
  && /rawUrl\.startsWith\('\/api\/'\)\) return rawUrl;/.test(canvasCode));
check('③ 已取回内存的 blob: 走 blob（跨域签名地址那条路），别退回原地址',
  /shown\.startsWith\('blob:'\)\) return shown;/.test(canvasCode));
check('③ 下载的文件名：从地址里认扩展名（认不出按 mp3），并去掉不能进文件名的字符',
  /function downloadFileName/.test(playerCode)
  && /\.\(mp3\|wav\|m4a\|aac\|ogg\|opus\|flac\|mp4\)/.test(playerCode)
  && /replace\([^)]*,\s*'_'\)/.test(playerCode));
check('③ 下载按钮补了 <a> 需要的 text-decoration:none（不然是个带下划线的圆钮）',
  /\.cv-audio__btn--download \{ text-decoration: none; \}/.test(canvasCss));

/* ── 第 4 条：音量**可调**（用户 2026-09-28）────────────────────────────────
   原话：「画布音乐框体鼠标移动到音量这里，目前只有开关音量，应该可以调整音量大小的」。
   所以音量按钮旁边要挂一条滑杆，且**必须是内联展开**（画布节点 `overflow:hidden`，
   绝对定位的弹层会被切一半）。另外盯一条容易漏的：音量拖到 0 之后再点"取消静音"，
   必须把音量抬回来，否则 unmute 了还是没声音、学生会以为播放器坏了。 */
check('④ 播放器有音量滑杆（type=range），并且真的写到 <audio> 的 volume 上',
  /cv-audio__vol-slider/.test(playerCode) && /type="range"/.test(playerCode)
  && /element\.volume = value/.test(playerCode));
check('④ 音量拖到 0 = 静音；再点「取消静音」要把音量**抬回来**（否则没声音像坏了）',
  /element\.muted = value === 0/.test(playerCode)
  && /volume === 0 \? 1 : volume/.test(playerCode));
check('④ 滑杆平时不占地方、鼠标移到音量这一带（或键盘聚焦）才展开',
  /\.cv-audio__vol-slider \{ width: 0; opacity: 0;/.test(canvasCss)
  && /\.cv-audio__vol:hover \.cv-audio__vol-slider, \.cv-audio__vol:focus-within \.cv-audio__vol-slider \{ width: 56px; opacity: 1; \}/.test(canvasCss));
check('④ 滑杆是**内联展开**、不是绝对定位弹层（节点 overflow:hidden 会把弹层切一半）',
  !/\.cv-audio__vol[^{]*\{[^}]*position: absolute/.test(canvasCss));
check('④ 操作行允许折行（窄框体里滑杆展开时，宁可折一行也别把下载按钮挤出可视区）',
  /\.cv-audio__row \{[^}]*flex-wrap: wrap/.test(canvasCss));

console.log('');
if (failures) { console.log(`✗ p130 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p130 作品读面卡片化 + 两行式播放器：全部通过');
