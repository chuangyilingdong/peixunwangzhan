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

console.log('');
if (failures) { console.log(`✗ p130 有 ${failures} 处不符合预期`); process.exit(1); }
console.log('✓ p130 作品读面卡片化 + 两行式播放器：全部通过');
