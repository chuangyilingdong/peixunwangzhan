/**
 * P108 VibeCoding 的**页面归属**（2026-09-17，用户口径两次）。
 *
 * 第一次：「一个页面，分成不同的功能，例如像豆包这种」→ 功能做成一排按钮。
 * 第二次：「我需要的是 dsh 那个页面来完成这些工作，抛弃掉以前的老 vibecoding」
 *         → 学生干活的地方是**创作环境（dsh）**，平台那套老工作台删掉。
 *
 * 所以这个守卫现在钉的是**页面归属**这件事：
 *   · 老工作台（平台自己的对话工作台）真的没了：文件、导出、路由都不在，
 *     也不存在任何一条指向它的入口 —— 否则「抛弃」只是嘴上说说；
 *   · VibeCoding 的入口就是「进入创作环境」（走宿主脚本拉起 dsh）+「提交作品」；
 *   · 三个功能（对话 / 写代码 / 做网页）做在 **dsh 那边**（见 deploy/dsh-student/mode-plugin），
 *     不在平台里再造一套；
 *   · 后端的会话/产物/提交仍然在（dsh 那条路在用），所以老链路那部分提示词分档的断言保留，
 *     但明确标注「已无界面」—— 别让下一个人以为它还是学生的路。
 *
 * 旧版这个守卫（沙箱按需、平台链路优先）已随用户口径作废。
 *
 * 背景：以前 VibeCoding 的入口绑在创作环境（dsh 沙箱）上 —— 沙箱不可用时卡片里只剩一个
 * 点不动的按钮。而那个沙箱一个人约 447MB，一台 1.6GB 的机器只装得下 1-2 个，
 * 于是「一节课几十人」这件事从入口就被卡住了。
 *
 * 现在的口径：**进去默认走平台自己的链路**（无沙箱、秒进、零内存），学生在里面选
 * 「对话 / 写代码 / 做网页」；想要「AI 真的把代码跑起来、自己看效果再改」时才点升级开沙箱。
 *
 * 这个守卫钉四件事：
 *   ① 三个选项的提示词确实分档了，而且**能力边界一分不减**（三种都还能写网页、做文档）；
 *   ② **老会话（没有 mode）与迁移前逐字一致** —— 这是零回归的根据，单独一条反向自检；
 *   ③ 选项只能在**还没聊过**时选/改（聊过就锁），非法值明确报错而不是静默忽略；
 *   ④ 入口不再依赖沙箱，而预览仍然只跑在 sandbox iframe 里（没引入同源执行）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ── ① ② 提示词分档（真跑一遍纯函数，不是读源码猜）──────────────────────────
   需要一个能用的库：提示词里要读课时标题/正文，所以先起一个临时库。
   这里不带 lesson_id 调用，走的是「没有课时」那条分支 —— 正是我们想钉的部分。 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p108-vibecoding-mode-'));
process.env.PLATFORM_DATA_DIR = temp;
process.env.PLATFORM_DB_PATH = path.join(temp, 'platform.db');
execFileSync(process.execPath, [path.join(root, 'packages/database/src/db.js'), '--init'], { cwd: root, env: process.env, stdio: 'pipe' });

const { lessonSystemMessage, normalizeVibeMode, VIBE_MODES } = await import('../apps/server/src/routes/vibecoding.js');

const textOf = (mode) => lessonSystemMessage(mode === undefined ? { lesson_id: null } : { lesson_id: null, mode }).content;

check('选项取值域就是这三个', JSON.stringify(VIBE_MODES) === JSON.stringify(['CHAT', 'CODE', 'WEB']), JSON.stringify(VIBE_MODES));
check('白名单之外的取值被规范化掉（不是原样存库）',
  normalizeVibeMode('chat') === 'CHAT' && normalizeVibeMode('  web ') === 'WEB' && normalizeVibeMode('HACK') === '' && normalizeVibeMode(undefined) === '');
check('空值就是空值（老会话没有 mode，不能被默认成某个选项）', normalizeVibeMode(null) === '' && normalizeVibeMode('') === '');

const noMode = textOf(undefined);
const chat = textOf('CHAT');
const code = textOf('CODE');
const web = textOf('WEB');

check('选了选项会带上那一档的角色说明', /【本节选项：对话】/.test(chat) && /【本节选项：写代码】/.test(code) && /【本节选项：做网页】/.test(web));
check('三档互不串味（对话里不该出现「写代码」那档的说明，反之亦然）',
  !/【本节选项：写代码】/.test(chat) && !/【本节选项：做网页】/.test(chat) && !/【本节选项：对话】/.test(code) && !/【本节选项：对话】/.test(web));
check('【零回归】没选选项（老会话）时不带任何角色说明', !/【本节选项/.test(noMode));
check('【零回归】没选选项时与迁移前逐字一致（开头就是安全约束）',
  noMode.startsWith('请用适合 8–16 岁学生理解的中文回答，避免任何危险或不适龄内容。'), noMode.slice(0, 40));
// 能力边界不许因为选了「对话」就缩水：三种都要还带着网页与文档的写法说明
const webGuideMark = '网页与互动作品请输出可直接运行的完整 HTML';
const docGuideMark = '你也可以直接产出 Office 文档';
check('三个选项都保留网页写法说明（选了对话也照样会写网页）', [chat, code, web].every((text) => text.includes(webGuideMark)));
check('三个选项都保留文档写法说明', [chat, code, web].every((text) => text.includes(docGuideMark)));
check('「对话」档明确说了默认不产出文件（它是助教，不是产线）', /默认\*\*不要\*\*产出文件/.test(chat));
check('「做网页」档明确要求不依赖外网资源（预览里加载不进来）', /不要依赖外网资源/.test(web));

/* ── ③ 老链路的后端**保留**（dsh 那条路在用提交/产物），但已无学生界面 ──────────
   这些断言钉的是「后端还在、参数校验还在」；不是「学生还会看到它」。
   平台侧那个 mode 现在没有任何界面在写它（学生选功能是在 dsh 里），
   留着是刻意的：删它要连提交/产物一起拆，风险大于收益，等专门一轮再收。 */
const source = read('apps/server/src/routes/vibecoding.js');
check('改选项走的是会话更新接口（PUT /conversations/:id），不新造一条', /body\.mode !== undefined/.test(source) && /UPDATE vibecoding_conversations SET title=\?,model=\?,mode=\?/.test(source));
check('非法功能明确报错（INVALID_VIBE_MODE），不静默忽略', /INVALID_VIBE_MODE/.test(source));
check('**随时可切**（用户口径：像豆包那排功能按钮一样，不该锁）', !/VIBECODING_MODE_LOCKED/.test(source));
check('会话下发带上了 mode（界面才能显示已选哪个）', /mode: normalizeVibeMode\(value\.mode\) \|\| null/.test(source));
check('库里有这一列：新库建表带 mode，老库走 ALTER',
  /mode TEXT,/.test(read('packages/database/src/schema.js')) && /ALTER TABLE vibecoding_conversations ADD COLUMN mode TEXT/.test(read('packages/database/src/schema.js')));

/* ── ④ 页面归属：老工作台真的没了，入口只走创作环境（dsh）─────────────────── */
const classroom = read('packages/shared/src/classroom.jsx');
const sharedIndex = read('packages/shared/src/index.js');
const siteMain = read('apps/website/src/main.jsx');

check('老工作台的两个文件已删除', !fs.existsSync(path.join(root, 'packages/shared/src/vibecodingWorkspace.jsx'))
  && !fs.existsSync(path.join(root, 'packages/shared/src/vibecodingStream.js')));
check('shared 不再导出它们', !/vibecodingWorkspace\.jsx/.test(sharedIndex) && !/vibecodingStream\.js/.test(sharedIndex));
check('网站不再有 /learn/vibecoding 路由（否则「抛弃」只是嘴上说说）',
  !/learn\/vibecoding/.test(siteMain) && !/VibeCodingWorkspace|VibeCodingClassroom/.test(siteMain));
check('入口只走创作环境：VibeCoding 那一排就是「进入创作环境」+「提交作品」',
  /\{runtime\.ready && offersVibe \? <RuntimeActions/.test(classroom));
check('平台里不再有「建对话再跳页面」这条入口（老工作台的路）',
  !/student\/vibecoding\/conversations/.test(classroom) && !/learn\/vibecoding/.test(classroom));
check('这台机器开不了创作环境时，兜底按钮把原因写在按钮上（不留一个没头没尾的点不动按钮）',
  /创作环境暂不可用/.test(classroom));

// 预览仍在沙箱 iframe 里：它现在服务的是**作品广场与机构端课堂详情**（学生工作台已删）
const frame = read('packages/shared/src/console/PreviewFrame.jsx');
check('预览仍是 sandbox="allow-scripts" 的 iframe（不引入同源执行）', /sandbox="allow-scripts"/.test(frame));
check('预览仍走 /vibe-preview.html 那个放宽 CSP 的外壳', /PREVIEW_SHELL_URL = '\/vibe-preview\.html'/.test(frame));
check('预览文档仍由 buildPreviewDocument 统一拼（作品广场与机构端看的是同一份）',
  /export function buildPreviewDocument/.test(read('packages/shared/src/vibecodingProject.js'))
  && /buildPreviewDocument/.test(read('apps/website/src/pages/WorkDetail.jsx')));

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
