/**
 * P110 课堂素材面板与画幅档位的五条界面优化（2026-09-17，用户逐条提的）。
 *
 * 用户原话：
 *   ①「现在是一个大类叫：素材，点击素材后才显示…图片模块…大分组下面的一个个素材。
 *      现在需要取消大类素材，直接显示大分组…如果素材一多，滚动找某个素材都很麻烦」
 *   ②「生成框体、图片、视频、提示词，应该都要有不同的样式区分…很明显可以区分这个是生图框体，
 *      这个是生视频的框体，生音乐的框体」
 *   ③「提示词模块应该鼠标 hover 上去可以显示提示词的内容…不仅是 hover，下方那个描述
 *      也可以显示提示词的部分内容，超出部分就是…」
 *   ④「比例这里文字的上方可否有个小的缩略图来展示各种比例的大概样式」
 *   （用户编号 3/4 对应这里 ②/③，原文共五条）
 *
 * 说明：这是界面改动，能真跑的只有两个纯函数（materialVisual / ratioThumbSize），
 * 其余是源码与样式断言 —— 交互本身要在浏览器里看（本机出口封 HTTPS，够不着站点）。
 */
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

const { materialVisual } = await import('../packages/shared/src/materialTypes.js');
const { ratioThumbSize } = await import('../packages/canvas/src/ratioThumb.js');

/* ── ② 类型视觉：同一个类型名在三个地方要长得一样 ─────────────────────────── */
check('生图框体 / 生视频框体 / 生音乐框体按模态分开（不是笼统的「生成框体」）',
  materialVisual({ materialType: 'GENERATION_BOX', modality: 'IMAGE' }).label === '生图框体'
  && materialVisual({ materialType: 'GENERATION_BOX', modality: 'VIDEO' }).label === '生视频框体'
  && materialVisual({ materialType: 'GENERATION_BOX', modality: 'MUSIC' }).label === '生音乐框体'
  && materialVisual({ materialType: 'GENERATION_BOX', modality: 'TEXT' }).label === '生文字框体',
  JSON.stringify([materialVisual({ materialType: 'GENERATION_BOX', modality: 'VIDEO' })]));

check('三种模态拿到的色调各不相同（这就是「一眼能分开」的根据）',
  new Set(['IMAGE', 'VIDEO', 'MUSIC'].map((m) => materialVisual({ materialType: 'GENERATION_BOX', modality: m }).tone)).size === 3);

check('图片 / 视频 / 音频 / 提示词各自的名字与色调',
  materialVisual({ materialType: 'IMAGE' }).label === '图片'
  && materialVisual({ materialType: 'VIDEO' }).label === '视频'
  && materialVisual({ materialType: 'AUDIO' }).label === '音频'
  && materialVisual({ materialType: 'PROMPT' }).label === '提示词'
  && materialVisual({ materialType: 'PROMPT' }).tone === 'prompt');

check('没写类型的老素材有兜底（不抛错、也有图标）',
  Boolean(materialVisual({}).icon) && Boolean(materialVisual({ materialType: 'WHATEVER' }).icon));

const canvasCss = read('packages/canvas/src/styles.css');
const sharedCss = read('packages/shared/src/styles.css');
const adminCss = read('apps/admin/src/admin.css');
for (const tone of ['image', 'video', 'audio', 'prompt']) {
  check(`色调 ${tone} 的学生端 / 老师端样式都在`, sharedCss.includes(`.cv-item__icon.is-${tone}`) && adminCss.includes(`.lesson-material-kind.is-${tone}`));
}
check('学生端列表的图标用的是这套视觉（不再是写死的 ▧/▶/♫/✎）',
  /className=\{`cv-item__icon is-\$\{visual\.tone\}`\}/.test(read('packages/shared/src/canvasWorkspace.jsx')));
check('学生端列表副标题也用类型名（生视频框体 · …）', /<small>\{visual\.label\} · \{boxParamsLabel\(box\)\}/.test(read('packages/shared/src/canvasWorkspace.jsx')));
check('老师端每条素材带类型标记（扫列表时不用看下拉）',
  /lesson-material-kind is-\$\{materialVisual\(\{ materialType: currentType, modality \}\)\.tone\}/.test(read('apps/admin/src/components/CourseManagement.jsx')));
check('画布框体本来就有的类型色没被改坏', /\.learning-node--video \.learning-node__heading span/.test(canvasCss));

/* ── ① 取消「素材」大类：导航就是大分组 ──────────────────────────────────── */
const workspace = read('packages/shared/src/canvasWorkspace.jsx');
check('导航按大分组渲染（一个分组一项）', /materialGroups\.map\(\(group, index\) => \{/.test(workspace) && /const key = `group:\$\{group\.id \|\| index\}`/.test(workspace));
check('不再有「素材」这个大类导航项', !/\['materials', 'grid', '素材'\]/.test(workspace));
check('面板只渲染当前选中的那一组', /const activeGroup = activeGroupIndex >= 0 \? materialGroups\[activeGroupIndex\] : null;/.test(workspace));
check('本地素材单列一项（并进大分组里会又变成混着看）', /toolPanel === 'local' \?/.test(workspace) && /<span>本地素材<\/span>/.test(workspace));
check('一组都没有时仍给一句明确的空态（不让学生看到白面板）',
  /老师还没有为本节课配置素材/.test(workspace) && /toolPanel === 'materials' \?/.test(workspace));
check('画布面板那个配置芯片点进来会打开有生成框体的那一组（不再指向已取消的「素材」面板）',
  /const openMaterialsPanel = \(\) => \{/.test(workspace) && /onRequestMaterials=\{openMaterialsPanel\}/.test(workspace));

/* ── ③ 提示词要看得出内容 ────────────────────────────────────────────────── */
check('提示词素材的副标题是内容摘要（截断加省略号），不是干巴巴的「点击后…」',
  /promptText\.length > 18 \? `\$\{promptText\.slice\(0, 18\)\}…`/.test(workspace));
check('鼠标悬停给出提示词全文', /title=\{hover\}/.test(workspace) && /const hover = material\.materialType === 'PROMPT' && promptText/.test(workspace));
check('内容取的是真正会被插进框体的那个字段（snapshot.content）',
  /material\.snapshot\?\.content \|\| material\.description/.test(workspace));

/* ── ④ 画幅档位的小示意图 ────────────────────────────────────────────────── */
const port = ratioThumbSize('16:9');
const land = ratioThumbSize('9:16');
const square = ratioThumbSize('1:1');
check('16:9 画成横的长方形（宽 > 高）', port && port.width > port.height, JSON.stringify(port));
check('9:16 画成竖的长方形（高 > 宽）', land && land.height > land.width, JSON.stringify(land));
check('1:1 画成正方形', square && square.width === square.height, JSON.stringify(square));
check('最长边统一 18px（各档之间能横向比较）', port.width === 18 && land.height === 18 && square.width === 18);
check('细长比例不会缩成一条线（21:9 的短边也有下限）', ratioThumbSize('21:9').height >= 6, JSON.stringify(ratioThumbSize('21:9')));
check('不是比例的值（「自动」这种）返回 null，不画错东西', ratioThumbSize('自动') === null && ratioThumbSize('') === null && ratioThumbSize(undefined) === null);
const canvasJsx = read('packages/canvas/src/index.jsx');
check('画幅那一行才画示意图（清晰度 / 时长不画）', /row\.ratio \? ratioThumbSize\(item\.value\) : null/.test(canvasJsx) && /is-ratio/.test(canvasJsx));
check('「自动」也有一个示意（虚线，表示跟随课程默认）', /learning-node__seg-thumb is-auto/.test(canvasJsx) && /\.learning-node__seg-thumb\.is-auto \{/.test(canvasCss));
// 用户 2026-09-17 追加：「比例这里现在布局很乱，应该要保证底部对齐吧」——
// 各档比例不一样高，缩略图必须装在一个固定尺寸的框里，否则文字会被顶到不同高度。
check('缩略图装在固定 18×18 的框里（每档都是「框 + 文字」，标签才能同一水平线）',
  /\.learning-node__seg-thumb-box \{ display: grid; place-items: center; flex: 0 0 auto; width: 18px; height: 18px; \}/.test(canvasCss)
  && (canvasJsx.match(/className="learning-node__seg-thumb-box"/g) || []).length === 2);
// 选中态是 font-weight:700 —— 字重一变行高也变，**选中那一档的文字会比别档低几像素**。
// 实际渲染出来量过：不写死 line-height 时其余在 277、选中的在 280；写死之后六档全在同一条线。
check('选中态的字重变化不会把文字顶下去（line-height 写死）',
  /\.learning-node__seg-row\.is-ratio \.learning-node__seg button \{[^}]*line-height: 16px/.test(canvasCss));
check('任何比例画出来都不超过那个 18px 的框（超了就会把框撑开、又对不齐）',
  ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21', '5:4', '2:3'].every((value) => {
    const size = ratioThumbSize(value);
    return size && size.width <= 18 && size.height <= 18;
  }));

/* ── 反向自检 ────────────────────────────────────────────────────────────── */
check('【反向自检】素材面板没有把「大分组」又嵌回列表里（那就是回到用户要取消的那一层）',
  !/<div className="cv-group" key=\{group\.id \|\| group\.title\}><h4>\{group\.title\}<\/h4>/.test(workspace));
check('【反向自检】类型色三处同源（学生端与老师端都从 materialVisual 拿，不各写一份）',
  /import \{ materialVisual \} from '\.\/materialTypes\.js';/.test(workspace)
  && /materialVisual, useData,/.test(read('apps/admin/src/components/CourseManagement.jsx')));

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
