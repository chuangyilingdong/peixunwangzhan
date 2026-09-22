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
import { stripComments } from './lib/sourceText.mjs';

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
const classroom = read('packages/shared/src/classroom.jsx');
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

/* ── 学生画布页头与提示（2026-09-17 追加的四条）───────────────────────────
   用户的四条：① 那句「「素材1」已经在画布上了，已为你定位」删掉；
   ② 「我的课堂画布」与底部提示条两处文案删掉；③ 「已保存」挪到顶部，给画布留空间；
   ④ 左上角换成品牌 logo + 下面显示学生账号名。 */
const sharedCssNow = read('packages/shared/src/styles.css');
// ⚠️ 判「某段代码还在不在」之前必须先剥注释 —— 这几处的注释里**故意写着**原来的文案
// （说明「以前是什么、为什么删」），不剥的话断言会被自己的注释绊倒（真绊倒过一次）。
// 剥注释用 scripts/lib/sourceText.mjs：**别退回正则**，注释里出现注释符号时正则会把真代码吞掉。
const workspaceCode = stripComments(workspace);
const canvasCode = stripComments(canvasJsx);
const sharedCssCode = stripComments(sharedCssNow);
check('①「已经在画布上了，已为你定位」那句提示没了（定位本身就是反馈）',
  !/已经在画布上了/.test(workspaceCode));
check('② 底部提示条学生侧不再渲染（那句话还写着已取消的「素材」面板，留着也是错的）',
  /\{allowNodeCreation \? <div className="learning-canvas__tip">/.test(canvasCode)
  && !/从左侧「素材」面板添加框体/.test(canvasCode));
check('②+③ 那条「标题 + 作品名 + 已保存」的横条整条去掉了（腾出一行给画布）',
  !/cv-heading/.test(workspaceCode) && !/\.cv-heading/.test(sharedCssCode));
check('③「已保存」挪进顶栏（保存状态仍在，只是位置变了）',
  /className="cv-actions">\s*<span\s+className=\{`cv-save-state/.test(workspaceCode));
check('④ 左上角换成品牌 logo + 下面显示学生账号名',
  /className="cv-brand__logo" src=\{brandLogo\}/.test(workspaceCode)
  && /className="cv-brand__name"/.test(workspaceCode)
  && /readSession\(\)/.test(workspaceCode)
  && !/AI 魔法学院/.test(workspaceCode));
check('④ logo 是打进产物的静态资源（不是运行时拼的路径）',
  /import brandLogo from '\.\/assets\/lingdong-ai-logo\.png';/.test(workspace)
  && fs.existsSync(path.join(root, 'packages/shared/src/assets/lingdong-ai-logo.png')));
check('④ 学生名读的是登录会话（读不到时退回占位，不能让顶栏空着）',
  /session\?\.user\?\.displayName \|\| session\?\.user\?\.login/.test(workspace) && /'同学'/.test(workspace));

/* ── 画布交互（2026-09-17 再追加的三条）──────────────────────────────────── */
check('① 点空白处 = 取消选择（react-flow 自己会清高亮，但底部编辑面板是我们的状态，得一起收）',
  /onPaneClick=\{\(\) => \{ setContextMenu\(null\); setActiveNodeId\(null\); \}\}/.test(canvasCode));
check('③ 取消连线后引用**直接消失**（不再只是标「已失效」还要学生自己点 ×）',
  /chip\.remove\(\);/.test(canvasCode) && /if \(removed\) sync\(\);/.test(canvasCode)
  && !/classList\.toggle\('is-stale', !known\)/.test(canvasCode));
check('② 名字在 logo 右边、白色、格式「同学：xxx」',
  /cv-brand__name" title="当前登录的账号">\{studentName \? `同学：\$\{studentName\}` : '同学'\}/.test(workspaceCode)
  && /\.cv-brand \{ display: flex; align-items: center; gap: 10px/.test(sharedCssCode)
  && /\.cv-brand__name \{[^}]*color: #fff/.test(sharedCssCode)
  && !/\.cv-brand \{ display: flex; flex-direction: column/.test(sharedCssCode));

/* ── 反向自检 ────────────────────────────────────────────────────────────── */
check('【反向自检】素材面板没有把「大分组」又嵌回列表里（那就是回到用户要取消的那一层）',
  !/<div className="cv-group" key=\{group\.id \|\| group\.title\}><h4>\{group\.title\}<\/h4>/.test(workspace));
check('【反向自检】类型色三处同源（学生端与老师端都从 materialVisual 拿，不各写一份）',
  /import \{ materialVisual \} from '\.\/materialTypes\.js';/.test(workspace)
  && /materialVisual, useData,/.test(read('apps/admin/src/components/CourseManagement.jsx')));

/* ── 文字框体的复制（2026-09-18 晚用户提的三条里的两条）──────────────────────
   用户原话：②「图2 画布课堂右下角这个提示必须要移除，很挡视野」
             ③「图3 文本生成这里的框应该是可以选中里面的文字进行复制的，同时在右上角提供复制按钮一键复制」
   （①「灵动学习页面这里的提示要删除」在 p115 里按真浏览器断言：/learn 页不得再出现那条横幅） */
check('③ 生成结果能选中复制：结果块显式 user-select:text（画布是拖拽面，默认选不中文字）',
  /\.learning-node__text-result \{ margin: 0; user-select: text; -webkit-user-select: text; cursor: text; \}/.test(canvasCss));
/* ⚠️ 2026-09-21 用户复验：「复制按钮还是错位的，应该放在右上角」—— 前两版都把它**绝对定位在结果块上**
   （第一版压住结果块边框，第二版压住滚动条），所以判据改成钉"它属于卡片标题行"：
   按钮从 `NodeFrame` 的 `headingExtra` 进标题行、由 CSS 靠 `margin-left:auto` 贴到卡片右上角。 */
check('③ 「复制」在**卡片右上角**：按钮走标题行的 headingExtra，靠 margin-left:auto 贴右',
  /headingExtra=\{generated \? <CopyTextButton text=\{generated\} \/> : null\}/.test(canvasJsx)
  && /\{titleNode\}\s*\{headingExtra\}/.test(canvasJsx)
  && /\.learning-node__heading \.learning-node__copy \{ flex: 0 0 auto; margin-left: auto; \}/.test(canvasCss));
check('【反向自检】复制按钮不许再回到结果块里（绝对定位 / 给按钮让位的 padding-right 都不许留）',
  !/\.learning-node__copy \{ position: absolute/.test(canvasCss)
  && !/padding-right: 62px/.test(canvasCss));
check('③ 复制按钮本身可用：带 nodrag（挂在标题行里，不带会被当成拖框体）+ 剪贴板 API + execCommand 兜底',
  /className="learning-node__copy nodrag"/.test(canvasJsx)
  && /navigator\.clipboard\?\.writeText/.test(canvasJsx)
  && /document\.execCommand\('copy'\)/.test(canvasJsx));
// ⚠️ 判据在 2026-09-22（第二十七轮 §二.T / p126）换过一次：原来靠**猜消息里的字**
//    （`message.includes('失败')`）决定红绿与留不留，错误文案里没那几个词就会被当成成功；
//    现在统一走 `errorText()` 打的前缀标记（`isErrorText`）。断言要跟着口径走 ——
//    否则这条**每跑必红**，真出问题时反而被当成"又是那条老毛病"（README 里记着的那条教训的再犯）。
check('② 画布右下角那条提示（.cv-toast）不再一直挂着：非错误 5 秒自动消失、报错留着',
  /const timer = setTimeout\(\(\) => setMessage\(''\), 5000\);/.test(workspace)
  && /if \(isErrorText\(message\)\) return undefined;/.test(workspace)
  && /isErrorText\(message\) \? 'is-error' : ''/.test(workspace)
  && /stripNoticeMark\(message\)/.test(workspace));

/* ── 提交/离开课堂的收口（用户 2026-09-21 报的四条里的三条；第②条「作品页看媒体」在 p64）──
   用户原话：「提交作品后，自动返回课包页面…这个逻辑有问题，老师如果没点结束课堂，应该留在原页面。
             点击结束课堂就返回到课程中心，而且点进入课堂还能进入到新画布，这个肯定是bug」/
             「老师只要点击结束课堂，学生端应该就要退出画布，跳转到课程中心」/
             「图6 从画布课堂点击课程中心会进入到这个旧页面」。 */
check('① 提交作品后**不再自动跳走**（老师没结束课堂就留在画布上；跳走那行已经删掉）',
  !/setTimeout\(\(\) => navigate\('\/learn\/canvas'\)/.test(workspace)
  && /老师可以看到你的课堂作品了。老师结束后回课程中心就行。/.test(workspace));
check('④ 画布会盯「老师还在不在上课」：轮询 session-state，一旦结束就提示并回课程中心',
  /student\/projects\/\$\{projectId\}\/session-state/.test(workspace)
  && /老师已结束课堂/.test(workspace)
  && /setTimeout\(\(\) => navigate\('\/learn'\), 1600\)/.test(workspace));
check('③ 顶栏按钮改叫「课程中心」且去 `/learn`（不再跳那个旧页面 `/learn/canvas`）',
  /onClick=\{\(\) => navigate\('\/learn'\)\}>课程中心</.test(workspace)
  && !/navigate\('\/learn\/canvas'\)/.test(workspace));
check('① 课时按钮按「本场课堂的项目」分三种文案：草稿→继续创作 / 已提交→**查看作品** / 没有→进入课堂',
  /function canvasEntryLabel\(lesson\)/.test(classroom)
  && classroom.includes("if (lesson.continueProject) return '继续创作';")
  && classroom.includes("if (lesson.sessionProject) return '查看作品';")
  && classroom.includes("return '进入课堂';")
  // 两处入口（画布上课页 + 学生课程中心）都要用它，别只改一处
  // ⚠️ 数**调用点**（都写成 `… ? canvasEntryLabel(lesson)`），别把函数定义那一行也算进来
  && (classroom.split('? canvasEntryLabel(lesson)').length - 1) === 2);

/* ── 生成框体一圈金环（2026-09-21 用户口径）────────────────────────────────
   用户原话：「图2 是画布左侧素材生成框体，如果是生成框体，都需要在图2 四周有点金色的环绕，
             可以跟其他素材区分开，一看就知道这个是生成框体。而不是其他的素材。只需要区分生成框体即可。」
   ⚠️ 只判两件事：**框体那一项**有金环、**其他素材项没有**；图标那套模态色（生图/生视频/生音乐）不动。 */
check('④ 生成框体那一项带 .is-gen-box，其他素材项是裸的 cv-item',
  /className="cv-item is-gen-box"/.test(workspace)
  && /className="cv-item" key=\{material\.id \|\| material\.title\}/.test(workspace));
check('④ 金环是四边完整的描边（border + box-shadow 各一圈），悬停换色也不会被吃掉',
  /\.cv-item\.is-gen-box \{ border-color: rgb\(246 199 92 \/ 62%\); box-shadow: 0 0 0 1px rgb\(246 199 92 \/ 24%\), 0 0 10px rgb\(246 199 92 \/ 16%\); \}/.test(sharedCss)
  && /\.cv-item\.is-gen-box:hover:not\(:disabled\) \{ border-color: rgb\(253 224 122 \/ 95%\)/.test(sharedCss));

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
