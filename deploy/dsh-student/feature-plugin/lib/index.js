/**
 * 灵动ai 学生端「功能」开关 —— 宿主侧。
 *
 * 用户口径：学生干活的地方就是 dsh 这个页面，一个页面里分成不同的功能
 * （对话 / 写代码 / 做网页），像豆包输入框那一排那样点了就切。三个功能的差别**只在于
 * AI 的角色与默认产出**，能力边界一样（同一个 agent、同一套工具与技能）。
 *
 * 三件事各用 dsh 现成的机制，不自己造（写法照抄官方 dsh-plan-mode —— 它做的就是同一件事）：
 *   ① **按会话记住选了哪个功能** → `sessionProjections.register` 注册一个投影，
 *      切换时往会话日志 append 一个事件（`agent.session.append('studentFeature/mode', …)`）。
 *      状态因此钉在会话日志上而不是进程内存里，恢复/分叉会话能重建。
 *   ② **让功能影响模型** → `systemPrompt.section`，它的 `text` 是**函数**（拿得到 agent），
 *      所以能按会话逐轮变化，而且进的是系统提示词，不是对话轮次。
 *      ⚠️ 不要试图用 `agent/request` 改消息：官方在它自己的注册说明里写死了
 *      「Model-visible content must use logged channels; this waterfall cannot mutate messages.」
 *   ③ **浏览器怎么切** → 注册一条 `/feature <id>` 命令；客户端那半边用现成的
 *      `ctx.remote.commands.execute(sessionId, '/feature web', [])` 调它（不自建 RPC 命名空间）。
 *
 * ⚠️ **这个 apply 绝不能抛**。dsh 的加载器遇到插件 apply 抛错时，会让**整个 profile 起不来**
 * （实测：学生打开创作环境直接白屏）。所以这里自己兜住所有异常：最坏情况是「功能开关不生效」，
 * 而不是「学生进不去创作环境」。
 */
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

/** 学生看到的按钮文字（与客户端那一排一一对应）。 */
const LABELS = { chat: '对话', code: '写代码', web: '做网页' };

const normalizeFeature = (value) => {
  const text = String(value || '').trim().toLowerCase();
  return FEATURES.includes(text) ? text : '';
};

/** 没选过时用哪个功能。 */
const DEFAULT_FEATURE = 'chat';

/**
 * 投影：把「当前功能」钉在会话日志上（而不是进程内存里）。
 *
 * ⚠️ `stateSchema` 在官方插件里是 zod schema，而这个包不装依赖（拿不到 zod），
 * 所以给一个只有 `parse` 的直通壳 —— 注册表拿它做形状检查，直通即可。
 */
const featureProjection = {
  key: 'studentFeature',
  stateVersion: 1,
  stateSchema: { parse: (value) => value },
  init: () => ({ feature: DEFAULT_FEATURE }),
  apply: (state, event) => (event?.type === 'studentFeature/mode' && event.data
    ? { ...state, feature: normalizeFeature(event.data.feature) || state.feature }
    : state),
  // 注册了 wire，浏览器那半边才读得到（客户端用 useProjection('studentFeature')）
  wire: { viewSchema: { parse: (value) => value }, view: (state) => state.feature },
};

export const name = 'lingdong-feature';
export const inject = ['sessionProjections', 'systemPrompt', 'commands'];

/**
 * 宿主插件体：注册投影、系统提示词段落与切换命令。
 * @param ctx - 宿主根上下文（三个服务由 inject 保证就绪）。
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
  const featureOf = (session) => {
    const state = ctx.sessionProjections.stateOf(session, 'studentFeature');
    return normalizeFeature(typeof state === 'string' ? state : state?.feature) || fallback;
  };

  ctx.sessionProjections.register(featureProjection);

  // 系统提示词里按当前功能加一段。函数形式 = 每次组装都按那个会话的当前值重算。
  // order 100：紧跟部署人设（0）之后、工具说明之前 —— 它是「这一节要做什么」的定调。
  ctx.systemPrompt.section({
    name: 'lingdong:feature',
    order: 100,
    text: (context) => {
      const agent = context?.agent;
      if (agent === void 0) return STUDENT_PERSONA;
      return `${STUDENT_PERSONA}\n\n${FEATURE_TEXT[featureOf(agent.session)] || ''}`;
    },
  });

  // 浏览器那半边就靠这条命令切功能：/feature chat|code|web
  // （注入 commands 的理由与官方 dsh-plan-mode 相同：命令注册表可能比本级上下文晚就绪）
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'feature',
      description: '切换本节功能（对话 / 写代码 / 做网页）',
      input: { hint: '[chat|code|web]' },
      // 它是界面上的开关，不是学生说的话 —— 别把这次输入记成学生发的
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const wanted = normalizeFeature(rawInput);
        if (!wanted) {
          return {
            kind: 'error',
            text: `不认识的课堂功能：${String(rawInput || '').trim() || '(空)'}；可选 chat / code / web`,
          };
        }
        agent.session.append('studentFeature/mode', { feature: wanted });
        // ⚠️ 这条命令的结果会作为一张**卡片留在对话里**（dsh 的既定行为，没有「不显示」开关），
        // 所以文案是给学生看的一句话，不要把上面那段角色说明回显出去。
        return { kind: 'success', text: `已切到「${LABELS[wanted]}」` };
      },
    });
  });
}
