/**
 * 灵动ai 学生端「功能」开关 —— 宿主侧（2026-09-17）。
 *
 * 背景（用户口径）：学生干活的地方就是 dsh 这个页面，一个页面里分成不同的功能
 * （对话 / 写代码 / 做网页），像豆包输入框那一排那样点了就切。三个功能的差别**只在于
 * AI 的角色与默认产出**，能力边界一样（都是同一个 agent、同一套工具与技能）。
 *
 * 三件事各用 dsh 现成的机制，不自己造：
 *   ① **按会话记住选了哪个功能** → `sessionProjections` 注册一个投影 + `session.append`
 *      （一个会话一个 agent，状态天然隔离；恢复/分叉会话时会话日志能重建，见 dsh 的 plan-mode 同款做法）。
 *   ② **让功能影响模型** → `systemPrompt.section`，它的 `text` 是一个**函数**（拿到 agent），
 *      所以能按会话逐轮变化，而且进的是系统提示词，不是对话轮次。
 *      ⚠️ 不要试图用 `agent/request` 改消息：官方在它自己的注册说明里写死了
 *      「Model-visible content must use logged channels; this waterfall cannot mutate messages.」
 *   ③ **客户端怎么切** → 注册一条 `/feature <id>` 命令；客户端用现成的
 *      `ctx.remote.commands.execute(sessionId, '/feature web')` 调它（不必自建 RPC 命名空间）。
 */
import { appendFileSync } from 'node:fs';

const FEATURES = ['chat', 'code', 'web'];

/** 三个功能的角色说明。选哪个就把哪一段放进系统提示词（空值也算 chat，见 defaultFeature）。 */
const FEATURE_TEXT = {
  chat: [
    '【当前功能：对话】学生选的是「对话」：讲清概念、答疑、给思路、检查他的做法对不对。',
    '默认**不要**产出文件 —— 除非他明确要你写代码或做个东西，那就照常产出。',
  ].join('\n'),
  code: [
    '【当前功能：写代码】学生选的是「写代码」：陪他把代码写出来，产出完整可运行的文件，',
    '并**讲清每段关键代码在干什么**，让他看懂而不是只拿到一堆代码。允许多文件工程，但要说明文件之间的关系。',
  ].join('\n'),
  web: [
    '【当前功能：做网页】学生选的是「做网页」：做出一个能直接打开的页面。',
    '优先**单文件 `index.html`**（CSS 与 JS 内联在里面），桌面和手机都不能横向溢出；',
    '**不要依赖外网资源**（CDN 上的库、图、字体在课堂网络里常常加载失败）：需要图标/插画就用内联 SVG 或 CSS 画出来。',
  ].join('\n'),
};

const normalizeFeature = (value) => {
  const text = String(value || '').trim().toLowerCase();
  return FEATURES.includes(text) ? text : '';
};
const defaultFeature = () => normalizeFeature(process.env.DSH_STUDENT_FEATURE) || 'chat';

/** 投影：把「当前功能」这件事钉在会话日志上（而不是进程内存里）。 */
const featureProjection = {
  key: 'studentFeature',
  stateVersion: 1,
  // 宿主侧的 schema 只被当作「形状检查」，直通即可（客户端与宿主都拿不到 zod，见 dsh 的客户端种子表）
  stateSchema: { parse: (value) => value },
  init: () => ({ feature: defaultFeature() }),
  apply: (state, event) => (event.type === 'studentFeature/mode' && event.data
    ? { ...state, feature: normalizeFeature(event.data.feature) || state.feature }
    : state),
  // 客户端要读它：投影注册了 wire 才会发到浏览器（键名不对也不会报错，只是读不到）
  wire: { viewSchema: { parse: (value) => value }, view: (state) => state.feature },
};

export const name = 'lingdong-feature';
// ⚠️ 临时诊断：先不声明 inject，确认插件体本身能不能跑（inject 里只要有一个名字在这个组合里
// 不存在，cordis 就会一直等，插件体永不执行 —— 而且**什么都不打印**，非常难查）。
export const inject = [];

// ⚠️ 临时诊断（用 fs 写文件，不依赖 console —— dsh 可能把插件里的 console 收走了）
const DIAG = '/tmp/lingdong-feature.diag';
const diag = (text) => { try { appendFileSync(DIAG, `${new Date().toISOString()} ${text}
`); } catch { /* 忽略 */ } };
diag('模块被 import 了');

export function apply(ctx, config = {}) {
  diag('apply 被调用了；服务：sessionProjections=' + typeof ctx.sessionProjections + ' systemPrompt=' + typeof ctx.systemPrompt + ' commands=' + typeof ctx.commands);
  console.log('[lingdong-feature] apply 起来了');
  try { return applyInner(ctx, config); } catch (error) { console.log('[lingdong-feature] 挂了：' + String(error?.stack || error)); throw error; }
}

function applyInner(ctx, config = {}) {
  console.log('[lingdong-feature] 可用的服务：sessionProjections=' + typeof ctx.sessionProjections + ' systemPrompt=' + typeof ctx.systemPrompt + ' commands=' + typeof ctx.commands);
  const fallback = normalizeFeature(config.default) || defaultFeature();

  const featureOf = (session) => {
    const state = ctx.sessionProjections?.stateOf?.(session, 'studentFeature');
    return normalizeFeature(typeof state === 'string' ? state : state?.feature) || fallback;
  };

  ctx.sessionProjections.register(featureProjection);

  // 系统提示词里按当前功能加一段。函数形式 = 每次组装都按那个会话的当前值重算。
  ctx.systemPrompt.section({
    name: 'lingdong:feature',
    order: 550,
    text: (context) => {
      const session = context?.agent?.session;
      if (session === undefined) return '';
      return FEATURE_TEXT[featureOf(session)] || '';
    },
  });

  // 客户端就靠这条命令切功能：/feature chat|code|web
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'feature',
      description: '切换学生端功能（对话 / 写代码 / 做网页）',
      input: { hint: '[chat|code|web]' },
      // 不把这次输入记进对话轮次：它是界面上的开关，不是学生说的话
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const wanted = normalizeFeature(rawInput);
        if (!wanted) {
          return { kind: 'error', text: `不认识的课堂功能：${String(rawInput || '').trim() || '(空)'}；可选 chat / code / web` };
        }
        agent.session.append('studentFeature/mode', { feature: wanted });
        return { kind: 'success', text: FEATURE_TEXT[wanted] };
      },
    });
  });
}
