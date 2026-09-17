/**
 * 灵动ai 学生端 —— 宿主侧。
 *
 * 这个包现在管两件事（都在「学生看到的那一层」）：
 *   ① **品牌**：只贡献浏览器里的呈现（品牌插槽的占用者），宿主侧本来没有行为 ——
 *      留一个 apply 是为了让加载器有这一行、从而把 client 半边挂上去（官方同款包也是这么写的）。
 *   ② **功能开关**（2026-09-17）：对话 / 写代码 / 做网页 三个功能做在 dsh 自己的输入框那一排，
 *      点了就切，切了 AI 的角色跟着变。
 *
 * ⚠️ 为什么功能开关并进这个包、而不是单独一个包：**新包挂不上**。
 * 三条路都试过（`link:` 手工软链、照品牌补 pnpm-lock 条目、加进 dsh.profile.bundles），
 * 症状一模一样：**模块压根不被 import**（宿主侧往文件里写诊断，那个文件从未生成），
 * 而品牌包一切正常。独立成包是更干净的目标，等把加载器那一段弄明白再拆（见交接文档「还欠着的」）。
 *
 * 功能开关用的都是 dsh 现成的机制，不自己造：
 *   · **按会话记住选了哪个功能** → `sessionProjections` 注册一个投影 + `session.append`
 *     （一个会话一个 agent，状态天然隔离；恢复/分叉会话时能靠会话日志重建）。
 *   · **让功能影响模型** → `systemPrompt.section`：它的 `text` 是**函数**（拿得到 agent），
 *     所以能按会话逐轮变化；而且进的是系统提示词，不是对话轮次。
 *     ⚠️ 不要试图用 `agent/request` 改消息：官方在它自己的注册说明里写死了
 *     「Model-visible content must use logged channels; this waterfall cannot mutate messages.」
 *   · **客户端怎么切** → 注册一条 `/feature <id>` 命令，客户端用现成的
 *     `ctx.remote.commands.execute(sessionId, '/feature web')` 调它（不自建 RPC 命名空间）。
 */
import { appendFileSync } from 'node:fs';

const FEATURES = ['chat', 'code', 'web'];

/** 三个功能的角色说明：选哪个就把哪一段放进系统提示词。 */
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

/** 投影：把「当前功能」钉在会话日志上（而不是进程内存里）。 */
const featureProjection = {
  key: 'studentFeature',
  stateVersion: 1,
  // schema 只当形状检查，直通即可（宿主与浏览器两侧都拿不到 zod）
  stateSchema: { parse: (value) => value },
  init: () => ({ feature: defaultFeature() }),
  apply: (state, event) => (event?.type === 'studentFeature/mode' && event.data
    ? { ...state, feature: normalizeFeature(event.data.feature) || state.feature }
    : state),
  // 注册了 wire，客户端才读得到当前值
  wire: { viewSchema: { parse: (value) => value }, view: (state) => state.feature },
};

export const name = 'lingdong-brand';
export const inject = ['sessionProjections', 'systemPrompt', 'commands'];

/** 宿主插件体。 */
export function apply(ctx) {
  // 临时诊断：确认这个 apply 有没有被调用（写文件，不依赖 console —— dsh 可能把插件的 console 收走）
  try { appendFileSync('/tmp/lingdong-brand.diag', `${new Date().toISOString()} apply 被调用；服务：projections=${typeof ctx.sessionProjections} prompt=${typeof ctx.systemPrompt} commands=${typeof ctx.commands}\n`); } catch { /* 忽略 */ }

  const fallback = defaultFeature();
  const featureOf = (session) => {
    const state = ctx.sessionProjections?.stateOf?.(session, 'studentFeature');
    return normalizeFeature(typeof state === 'string' ? state : state?.feature) || fallback;
  };

  ctx.sessionProjections.register(featureProjection);

  // 系统提示词里按当前功能加一段（函数形式 = 每次组装都按那个会话的当前值重算）
  ctx.systemPrompt.section({
    name: 'lingdong:feature',
    order: 550,
    text: (context) => {
      const session = context?.agent?.session;
      return session === undefined ? '' : (FEATURE_TEXT[featureOf(session)] || '');
    },
  });

  // 客户端就靠这条命令切功能：/feature chat|code|web
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'feature',
      description: '切换学生端功能（对话 / 写代码 / 做网页）',
      input: { hint: '[chat|code|web]' },
      // 它是界面上的开关，不是学生说的话 —— 不记进对话轮次
      recordInput: false,
      handler: ({ agent, rawInput }) => {
        const wanted = normalizeFeature(rawInput);
        if (!wanted) return { kind: 'error', text: `不认识的课堂功能：${String(rawInput || '').trim() || '(空)'}；可选 chat / code / web` };
        agent.session.append('studentFeature/mode', { feature: wanted });
        return { kind: 'success', text: FEATURE_TEXT[wanted] };
      },
    });
  });
}
