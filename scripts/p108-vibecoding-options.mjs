/**
 * P108 VibeCoding 的三个选项（对话 / 写代码 / 做网页）与「沙箱改为按需」（2026-09-17）。
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

/* ── ③ 选项只能在还没聊过时选，非法值要明确报错 ───────────────────────────── */
const source = read('apps/server/src/routes/vibecoding.js');
check('改选项走的是会话更新接口（PUT /conversations/:id），不新造一条', /body\.mode !== undefined/.test(source) && /UPDATE vibecoding_conversations SET title=\?,model=\?,mode=\?/.test(source));
check('非法选项明确报错（INVALID_VIBE_MODE），不静默忽略', /INVALID_VIBE_MODE/.test(source));
check('聊过之后锁定（VIBECODING_MODE_LOCKED），并且是**按消息数**判的',
  /VIBECODING_MODE_LOCKED/.test(source) && /COUNT\(\*\) n FROM vibecoding_messages WHERE conversation_id/.test(source));
check('会话下发带上了 mode（界面才能显示已选哪个）', /mode: normalizeVibeMode\(value\.mode\) \|\| null/.test(source));
check('库里有这一列：新库建表带 mode，老库走 ALTER',
  /mode TEXT,/.test(read('packages/database/src/schema.js')) && /ALTER TABLE vibecoding_conversations ADD COLUMN mode TEXT/.test(read('packages/database/src/schema.js')));

/* ── ④ 入口不再依赖沙箱；预览仍在沙箱 iframe 里 ───────────────────────────── */
const classroom = read('packages/shared/src/classroom.jsx');
check('VibeCoding 入口按钮**不在** runtime.ready 分支里', /offersVibe \? <button/.test(classroom));
check('那个「点不动的兜底按钮」已经删掉（它的存在本身就是那个 bug）', !/只开 VibeCoding、而创作环境不可用时的兜底/.test(classroom));
check('沙箱按钮仍保留，并且只在运行时可用时出现（它是升级点，不是入口）',
  /\{runtime\.ready && offersVibe \? <RuntimeActions/.test(classroom));
const center = classroom.split('export function StudentCourseCenter')[1] || '';
check('入口由按钮**显式指定**目标（两种都开时才不会点 VibeCoding 进了画布）',
  /async function enter\(lesson, target\)/.test(center)
  && /if \(target === 'VIBECODING'\)/.test(center)
  && /enter\(lesson, 'VIBECODING'\)/.test(center) && /enter\(lesson, 'CANVAS'\)/.test(center));
{
  // 反向自检：enter() 内部**不许**再出现按课时单值分支的写法 —— 那正是「点 VibeCoding 却进画布」的来源。
  // （modeOf 仍然可以用于徽标与提示文案，所以这里只看 enter 的函数体。）
  const from = center.indexOf('async function enter(lesson, target)');
  const body = from < 0 ? '' : center.slice(from, from + 1200);
  check('enter() 内部不再按 modeOf 推分支', Boolean(body) && !/modeOf\(lesson\)/.test(body));
}

const workspace = read('packages/shared/src/vibecodingWorkspace.jsx');
check('三张选项卡片在工作台里（还没聊过时出现）', /c-mode-grid/.test(workspace) && /canPickMode/.test(workspace) && /chooseMode\(/.test(workspace));
check('「让 AI 真的做出来」在工作台里也有一份，且与入口共用同一个 hook',
  /useRuntimeLaunch/.test(workspace) && /upgradeToSandbox/.test(workspace) && /export function useRuntimeLaunch/.test(read('packages/shared/src/runtimeWorkspace.jsx')));
check('升级前会把当前要求复制给剪贴板（沙箱是另一段对话，不带过去就得重说）', /navigator\.clipboard\.writeText\(handoffText\(\)\)/.test(workspace));
check('工作台里升级失败会**说出来**（我第一版漏了这段，浏览器实检时抓到：点了没反应）',
  /launch\.message/.test(workspace) && /toast\.error\(launch\.message\)/.test(workspace));

// 宿主脚本失败的原因必须传到学生眼前：500「服务器内部错误」把「装不下新环境 / 端口占满」全吞了
const runtime = read('apps/server/src/services/studentRuntime.js');
check('宿主脚本失败映射成「说得清」的答复（不再是 500 内部错误）',
  /errors\.serviceUnavailable\(`创作环境没开起来：\$\{tail\}`/.test(runtime) && /console\.error\(`\[studentRuntime\] 宿主操作失败/.test(runtime));

// 预览：学生的代码只能跑在 sandbox iframe（allow-scripts）里，不能进主文档
const frame = read('packages/shared/src/console/PreviewFrame.jsx');
check('预览仍是 sandbox="allow-scripts" 的 iframe（不引入同源执行）', /sandbox="allow-scripts"/.test(frame));
check('预览仍走 /vibe-preview.html 那个放宽 CSP 的外壳（主站 CSP 会拦 srcdoc 的内联脚本）',
  /PREVIEW_SHELL_URL = '\/vibe-preview\.html'/.test(frame) && /postMessage/.test(frame));
check('预览文档仍由 buildPreviewDocument 统一拼（学生看到的与作品广场看到的一致）',
  /buildPreviewDocument/.test(read('packages/shared/src/vibecodingWorkspace.jsx')) && /export function buildPreviewDocument/.test(read('packages/shared/src/vibecodingProject.js')));

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
