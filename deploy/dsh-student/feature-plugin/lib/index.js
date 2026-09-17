/**
 * 灵动ai 学生端「功能」开关 —— 宿主侧。
 *
 * 用户口径：学生干活的地方就是 dsh 这个页面，一个页面里分成不同的功能
 * （对话 / 写代码 / 做网页），像豆包输入框那一排那样点了就切。三个功能的差别**只在于
 * AI 的角色与默认产出**，能力边界一样（同一个 agent、同一套工具与技能）。
 *
 * ⚠️⚠️ 一句话教训（2026-09-17 真机上炸过一次，务必别再走回去）：
 *   **绝对不要往会话日志里 append 自定义事件类型。**
 *   这个 harness（0.1.5-rc.1）在加载会话日志时有一条硬规则：
 *   事件类型要么是它**已知**的，要么信封上带 `ignorable: true`；否则它**拒绝解释整份日志**
 *   （`failed to observe session … unknown to this harness and not marked ignorable`）——
 *   学生的历史直接打不开。而 `session.append()` **没有任何办法**设置那个标记
 *   （它只转发 sourceEventSeqs / surfaceOp），也就是说第三方插件在运行时**写不出**合规的自定义事件。
 *   我第一版就是 `session.append('studentFeature/mode', …)` + 一个投影，功能是好的，
 *   但每个用过这个开关的会话都变成了打不开的历史。
 *
 * 所以现在的做法：**只靠插件自己的状态文件**，会话日志一个字节都不写。
 *   · 状态：`$DSH_HOME/lingdong-feature.json`，形如 `{ "<sessionId>": "web" }`（按会话隔离，
 *     重启环境也在；会话被分叉/复制时新会话回落到默认「对话」）。
 *   · 让功能影响模型：`systemPrompt.section`，`text` 是函数（拿得到 agent）→ 按会话逐轮变。
 *   · 浏览器怎么切：注册 `/feature <id>` 命令；**不带参数**时回报当前值（客户端挂载时问它）。
 *   · 这个 apply 绝不能抛：插件坏掉只该让开关失效，不能让学生的创作环境起不来。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FEATURES = ['chat', 'code', 'web'];

/** 三个功能的角色说明：选哪个就把哪一段放进系统提示词。 */
const FEATURE_TEXT = {
  chat: [
    '【本节功能：对话】学生选的是「对话」：讲清概念、答疑、给思路、检查他的做法对不对。',
    '默认**不要**产出文件 —— 除非他明确要你写代码或做个东西，那就照常产出。',
  ].join('\n'),
  code: [
    '【本节功能：写代码】学生选的是「写代码」：陪他把代码写出来，产出完整可运行的文件，',
    '并**讲清每段关键代码在干什么**，让他看懂而不是只拿到一堆代码。允许多文件工程，但要说明文件之间的关系。',
  ].join('\n'),
  web: [
    '【本节功能：做网页】学生选的是「做网页」：做出一个能直接打开的页面。',
    '优先**单文件 `index.html`**（CSS 与 JS 内联在里面），桌面和手机都不能横向溢出；',
    '**不要依赖外网资源**（CDN 上的库、图、字体在课堂网络里常常加载失败）：需要图标/插画就用内联 SVG 或 CSS 画出来。',
  ].join('\n'),
};

/** 学生端整体的人设：三个功能共用（选哪个功能都该带上它）。 */
const STUDENT_PERSONA = [
  '你是「灵动ai」课堂里的编程助手，面向 8–16 岁的学生。用中文回答，避免任何危险或不适龄内容。',
  '学生做的东西在工作区里，用工具去读、去改、去跑，别凭空猜。',
].join('\n');

const LABELS = { chat: '对话', code: '写代码', web: '做网页' };

const normalizeFeature = (value) => {
  const text = String(value || '').trim().toLowerCase();
  return FEATURES.includes(text) ? text : '';
};

/** 没选过时用哪个功能。 */
const DEFAULT_FEATURE = 'chat';

/**
 * 状态文件：一个学生一份（$DSH_HOME 下），里面按会话 id 记当前功能。
 * 读失败一律当「没有状态」（返回 {}），不抛 —— 顶多是回落到默认功能。
 */
function storePath() {
  return join(process.env.DSH_HOME || process.cwd(), 'lingdong-feature.json');
}

function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeStore(store) {
  try { writeFileSync(storePath(), JSON.stringify(store, null, 2)); } catch { /* 忽略：写不进去就只是切完不记 */ }
}

export const name = 'lingdong-feature';
export const inject = ['systemPrompt', 'commands'];

/** 当前功能（按会话 id）。状态文件每次都读：这个插件不在热路径上，读一次文件比缓存失效好懂。 */
function featureOf(sessionId, fallback) {
  return normalizeFeature(readStore()[String(sessionId ?? '')]) || fallback;
}

/**
 * 宿主插件体：注册系统提示词段落与切换命令。**不碰会话日志**（见文件头那条教训）。
 * @param ctx - 宿主根上下文（两个服务由 inject 保证就绪）。
 * @param config - 加载器这一行的 config（本部署没配，留作以后放默认功能）。
 */
export function apply(ctx, config = {}) {
  try {
    applyInner(ctx, config);
  } catch (error) {
    // 兜住：插件坏掉只该让「功能开关」失效，绝不能连带整个创作环境起不来。
    ctx.logger?.warn?.('lingdong-feature: 挂钩失败，功能开关不生效（创作环境不受影响）：%o', error);
  }
}

function applyInner(ctx, config = {}) {
  const fallback = normalizeFeature(config.default) || DEFAULT_FEATURE;

  // 系统提示词里按当前功能加一段。函数形式 = 每次组装都按那个会话的当前值重算。
  // order 100：紧跟部署人设（0）之后、工具说明之前 —— 它是「这一节要做什么」的定调。
  ctx.systemPrompt.section({
    name: 'lingdong:feature',
    order: 100,
    text: (context) => {
      const agent = context?.agent;
      if (agent === undefined) return STUDENT_PERSONA;
      return `${STUDENT_PERSONA}\n\n${FEATURE_TEXT[featureOf(agent.session?.id, fallback)] || ''}`;
    },
  });

  // 浏览器那半边就靠这条命令切功能：`/feature chat|code|web`；**不带参数**时回报当前值
  //（客户端挂载时用它把按钮的选中态对齐 —— 状态在宿主这边，客户端只是显示）。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'feature',
      description: '切换本节功能（对话 / 写代码 / 做网页）；不带参数则回报当前功能',
      input: { hint: '[chat|code|web]' },
      // 它是界面上的开关，不是学生说的话 —— 别把这次输入记成学生发的
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const sessionId = agent?.session?.id;
        const raw = String(rawInput || '').trim();
        if (!raw) {
          const current = featureOf(sessionId, fallback);
          // 回报格式固定成 `feature=<id>`：客户端按这个前缀取值，别写成散文（那样没法解析）
          return { kind: 'success', text: `feature=${current}` };
        }
        const wanted = normalizeFeature(raw);
        if (!wanted) {
          return {
            kind: 'error',
            text: `不认识的课堂功能：${raw || '(空)'}；可选 chat / code / web`,
          };
        }
        const store = readStore();
        store[String(sessionId ?? '')] = wanted;
        writeStore(store);
        // ⚠️ 命令的结果会作为一张**卡片留在对话里**（dsh 的既定行为，没有「不显示」开关），
        // 所以文案是给学生看的一句话，不要把上面那段角色说明回显出去。
        return { kind: 'success', text: `已切到「${LABELS[wanted]}」` };
      },
    });
  });
}
