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
 *   · 三个功能（对话 / 写代码 / 做网页）做在 **dsh 那边**（见 deploy/dsh-student/feature-plugin）：
 *     输入框那一排三个按钮，点了就切，宿主侧把当前功能放进系统提示词 —— 不在平台里再造一套；
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
import { stripComments } from './lib/sourceText.mjs';
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

/* ── ⑤ 功能开关插件本身：三个按钮做在 dsh 那边（deploy/dsh-student/feature-plugin）──
   这一段是 2026-09-17 补的，钉的都是**实测踩过的坑**，一条都别再踩：

   · **apply 里读服务必须先 inject**。曾经把 inject 清空做诊断、apply 里照读
     ctx.sessionProjections —— cordis 直接抛「cannot get property … without inject」，
     而加载器遇到插件 apply 抛错会让**整个 profile 起不来**（学生白屏）。所以：
     ① inject 必须列全它读的服务；② apply 只能用列进去的服务；③ 宿主半个包要自己兜异常。
   · **诊断代码不许留在包里**（appendFileSync / 调试 console.log）。上一轮往文件里写诊断，
     得靠「文件出没出现」判断插件有没有加载 —— 那个判断还建立在一次没重启的部署上，
     直接导致了「宿主插件挂不上」这个**错误结论**，整个方向都跟着错了一轮。
   · **品牌包只管品牌**。功能开关曾被并进品牌包（因为上面那个错误结论），已拆回来：
     品牌是承重的，它挂了整个外观都没了。
   · **三个功能的角色说明不许回显给客户端**：命令的结果会作为卡片留在对话里，
     所以返回的必须是给学生看的一句话，不是内部那段角色提示词。
*/
const featurePlugin = 'deploy/dsh-student/feature-plugin';
const featureHost = read(`${featurePlugin}/lib/index.js`);
const featureClient = read(`${featurePlugin}/lib/client.js`);
const featurePkg = JSON.parse(read(`${featurePlugin}/package.json`));
const brandHost = read('deploy/dsh-student/brand-plugin/lib/index.js');
const brandClient = read('deploy/dsh-student/brand-plugin/lib/client.js');
const patchLayer = read('deploy/dsh-student/student-runtime.cordis.yml');

check('功能包两个半边都在，而且 package.json 声明了客户端那一半（没这一行 dsh 不会下发它）',
  featurePkg.name === '@lingdong/dsh-feature' && featurePkg.exports['./client'] !== undefined
  && featurePkg.dsh?.client?.platform === 'web' && featurePkg.dsh?.bundle?.patch === './cordis.patch.yml');

const injected = /export const inject = \[([^\]]*)\]/.exec(featureHost)?.[1] ?? '';
check('宿主侧 inject 列全了它读的三个服务（少一个 cordis 就会抛，进而整个环境起不来）',
  ['sessionProjections', 'systemPrompt', 'commands'].every((name) => injected.includes(name)), injected);

// 先把注释剥掉再查 —— 注释里提到「客户端用 ctx.remote…」不是代码，别把它当成违规
const hostCode = stripComments(featureHost);
const readServices = [...hostCode.matchAll(/[A-Za-z]*[Cc]tx\.([a-zA-Z]+)/g)]
  .map((match) => match[1])
  .filter((name) => name !== 'logger' && name !== 'inject');
check('宿主侧只读它 inject 过的服务（读别的同样会抛）',
  readServices.length > 0 && readServices.every((name) => injected.includes(name)),
  `读到：${[...new Set(readServices)].join(', ')}`);

check('宿主 apply 自己兜异常（插件坏掉只让功能开关失效，不能连带学生进不去）',
  /export function apply\(ctx, config = \{\}\) \{\s*try \{/.test(featureHost) && /catch \(error\)/.test(featureHost));

check('没有诊断/调试残留（appendFileSync / 调试 console.log）',
  !/appendFileSync/.test(featureHost + featureClient)
  && !/console\.log\('\[lingdong/.test(featureHost + featureClient));

// 两边写法不同（宿主是 `const FEATURES = ['chat', …]`，客户端是 `{ id: 'chat', label: '对话' }`），
// 所以钉的是「同一组 id」与「学生看到的那三个中文名」
check('三个功能的 id 两边一致，且学生看到的就是这三个名字',
  ['chat', 'code', 'web'].every((id) => new RegExp(`'${id}'`).test(featureHost) && featureClient.includes(`id: '${id}'`))
  && ['对话', '写代码', '做网页'].every((label) => featureClient.includes(`label: '${label}'`)));

check('切换命令回显给学生的是短句，不是内部那段角色说明',
  /已切到「\$\{LABELS\[wanted\]\}」/.test(featureHost) && !/kind: 'success', text: FEATURE_TEXT/.test(featureHost));

check('客户端挂在输入框那一排（conversation.input.left），不去占别人的插槽',
  /ctx\.slots\.inject\('conversation\.input\.left'/.test(featureClient)
  && (featureClient.match(/ctx\.slots\.inject\(/g) || []).length === 1);

check('当前功能从会话投影读（useProjection），不是自己另存一份状态',
  /useProjection\('studentFeature'/.test(featureClient) && /wire: \{ viewSchema/.test(featureHost));

check('切功能走现成的命令通道（remote.commands.execute），不自建 RPC',
  /remote\.commands\.execute\(target \|\| sessionId, `\/feature \$\{feature\}`/.test(featureClient)
  && /inject = \['slots', 'remote', 'remote\.commands'\]/.test(featureClient));

check('品牌包只管品牌：不再含功能开关那段（已拆回功能包）',
  !/FEATURE_TEXT|studentFeature|FeatureSwitch/.test(brandHost + brandClient)
  && /export function apply\(\) \{\}/.test(brandHost));

check('补丁层不再配 dsh 原生 preset（那是「宿主插件挂不上」这个错误结论下的替代方案，已撤）',
  !/id: agent-presets/.test(patchLayer) && !/name: '@deepseek-ai\/dsh-agent-presets'/.test(patchLayer));

// 三个 preset 目录也不该还在宿主上（装机脚本若被重新执行会再拉回来，所以这里只钉仓库侧）
check('仓库里没有残留的 preset 目录', !fs.existsSync(path.join(root, 'deploy/dsh-student/agent-presets')));

/* ── ⑥ 镜像侧：功能包必须随镜像走（2026-09-17 补）────────────────────────────
   为什么单独钉这一段：`provision-user-runtime.sh` 会从镜像里 `tar` 出 `etc/dsh` 与
   `home/student/.dsh` **覆盖**到宿主上 —— 也就是说**镜像才是那些文件的源头**。
   而本轮这套是先在宿主上手工接通的（`/opt/feature-plugin` + profile 软链 + bundles），
   镜像里当时没有它：**换台机器或重跑一次 provision，这一排按钮就没了**
   （更坏的情况是 profile 里留了 bundles 却缺软链 —— 那样整个环境起不来）。
   所以这三条钉的是「镜像重建之后它还在」。 */
const dockerfile = read('deploy/dsh-student/Dockerfile');
const provision = read('deploy/dsh-student/host-user/provision-user-runtime.sh');

check('Dockerfile 把功能包烤进镜像', /COPY feature-plugin\/ \/opt\/feature-plugin\//.test(dockerfile));
check('Dockerfile 用 `dsh plugin add` 把它装进 profile，并断言 bundles 与 dependencies 都有',
  /dsh plugin --profile web add \/opt\/feature-plugin/.test(dockerfile)
  && /功能开关包没进 bundles/.test(dockerfile) && /功能开关包没进 dependencies/.test(dockerfile));
check('装功能包这一步排在 PPT 那一步之前（排后面会把 dsh-ppt 又加回 bundles → 整棵插件树起不来）',
  dockerfile.indexOf('add /opt/feature-plugin') > 0
  && dockerfile.indexOf('add /opt/feature-plugin') < dockerfile.indexOf('ARG PPT_BUNDLE='));
check('provision 会抽取 opt/feature-plugin 并补上根路径软链',
  /-cf - opt\/node opt\/brand-plugin opt\/feature-plugin home\/student\/\.dsh etc\/dsh/.test(provision)
  && /ln -sfn "\$\{RUNTIME_ROOT\}\/opt\/feature-plugin" \/opt\/feature-plugin/.test(provision));
check('「补丁层与 profile 的源头是镜像」这件事写在部署 README 里了（否则下一个人会去改宿主上的文件）',
  /补丁层的源头是镜像/.test(read('deploy/dsh-student/README.md')));

// Univer 办公插件（2026-09-17）：让 dsh 里能预览 pptx/xlsx/docx。
// 三条实测约束必须随镜像走，不然下一轮会踩：`dsh plugin add` 会把 dsh-ppt 加回 bundles、
// 没有 Chromium 则 PDF/截图那几项不可用、一个学生环境内存 +~290MB。
check('Dockerfile 装了 dsh-univer-office，并把 dsh-ppt 从 bundles 再摘一次（否则抢注册、整棵树起不来）',
  /dsh plugin --profile web add dsh-univer-office/.test(dockerfile)
  && /j\.dsh\.profile\.bundles=j\.dsh\.profile\.bundles\.filter\(\(b\)=>b!=='dsh-ppt'\)/.test(dockerfile)
  && /univer 没进 bundles/.test(dockerfile));
check('装 univer 排在**最后一条 dsh plugin add**（PPT 那步）之后：bundles 的最终状态由它自己的断言收口',
  dockerfile.indexOf('add dsh-univer-office') > 0
  && dockerfile.indexOf('add dsh-univer-office') > dockerfile.indexOf('ARG PPT_BUNDLE='));
check('「没有 Chromium → PDF/截图不可用」与「内存 +~290MB」两条实测都写进 Dockerfile 注释了',
  /需要本机有 Chromium/.test(dockerfile) && /\+~290MB/.test(dockerfile));
check('部署 README 也记了内存这笔账（1.6GB 机器本来就只塞得下 1-2 个环境）',
  /univer/i.test(read('deploy/dsh-student/README.md')) && /290MB/.test(read('deploy/dsh-student/README.md')));

console.log(failures ? `\n结果：${failures} 项失败\n` : '\n结果：全部通过\n');
process.exit(failures ? 1 : 0);
