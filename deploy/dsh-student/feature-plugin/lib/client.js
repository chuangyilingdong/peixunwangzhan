/**
 * 灵动ai 学生端「功能」开关 —— 浏览器侧。
 *
 * 往输入框工具行左侧（`conversation.input.left`，官方留白、没有占用者的 list 插槽）放三个按钮：
 * 对话 / 写代码 / 做网页。点了就切，切了 AI 的角色跟着变（宿主侧把它放进系统提示词）。
 *
 * 几条来自 dsh 自身的约束（照做，别绕）：
 *   · 浏览器里**只能 require 极少的种子模块**（react / react/jsx-runtime），别的包根本不在磁盘上
 *     （它们被打进 shell 了）—— 所以只 require 这两个，其余全靠 cordis 服务拿。
 *   · 插槽给的标准 props 是 **`sessionId` / `useSession` / `useProjection`** 三个
 *     （见 dsh-client-ui-session 里那行 `keyedHooks: ["projection"]`），当前功能从
 *     `useProjection('studentFeature', …)` 读 —— 这正是官方「计划模式」按钮读 `useProjection('plan')` 的写法。
 *   · **不自建 RPC**：切功能走宿主注册好的 `/feature` 命令
 *     （`ctx.remote.commands.execute(sessionId, '/feature web', [])`），与官方 dsh-client-ui-plan 同一个通道。
 *     返回值形状也是官方的：`{ok, value:{result:{kind,text}}}` / `{ok:false, error:{code,message}}`。
 *   · 插槽是 `scope: session` 的：**新会话首页（hero）不渲染它**，所以这一排按钮在
 *     「已经有一个会话」之后才出现（第一条消息之前用默认功能）。
 */
window.__ModuleLoader__.load({
  id: '@lingdong/dsh-feature',
  factory: (require) => {
    const react = require('react');

    /** 与宿主侧 FEATURES / FEATURE_TEXT 一一对应；label 是学生看到的按钮文字。 */
    const FEATURES = [
      { id: 'chat', label: '对话', hint: '讲解、答疑、帮你想思路' },
      { id: 'code', label: '写代码', hint: '一起写代码，逐段讲清楚' },
      { id: 'web', label: '做网页', hint: '做出一个能直接打开的页面' },
    ];
    const FALLBACK = 'chat';

    /**
     * 三个按钮。放在输入框工具行左侧、和附件键同一排 —— 一眼看到这个页面能做什么。
     *
     * ⚠️ 样式一律**内联**：dsh 的客户端没有给我们注入样式表的通道，
     * 写 class 名而指望某份 css 被加载，是这里最容易踩空的地方。
     * @param props - 插槽给的标准 props + 我们 inject 进去的 select。
     */
    function FeatureSwitch({ sessionId, useProjection, select }) {
      const active = useProjection('studentFeature', (value) => (
        typeof value === 'string' ? value : undefined
      )) || FALLBACK;
      const [pending, setPending] = react.useState('');
      const [error, setError] = react.useState('');

      const choose = react.useCallback(async (id) => {
        if (!sessionId || id === active || pending) return;
        setPending(id);
        setError('');
        try {
          const result = await select(id, sessionId);
          if (result === undefined) { setError('切换通道不可用'); return; }
          if (!result.ok) { setError(`${result.error.message}（${result.error.code}）`); return; }
          if (result.value === undefined) { setError('这条切换命令没注册上'); return; }
          if (result.value.result?.kind === 'error') setError(result.value.result.text || '切换失败');
        } catch (cause) {
          setError(String(cause?.message || cause));
        } finally {
          setPending('');
        }
      }, [sessionId, active, pending, select]);

      const chipStyle = (isActive) => ({
        display: 'inline-flex', alignItems: 'center',
        padding: '5px 10px', borderRadius: '999px', fontSize: '12px', lineHeight: 1.2,
        whiteSpace: 'nowrap', cursor: 'pointer', font: 'inherit',
        border: `1px solid ${isActive ? 'rgba(255,138,42,.55)' : 'transparent'}`,
        background: isActive ? 'rgba(255,138,42,.14)' : 'transparent',
        color: isActive ? '#ff8a2a' : 'inherit',
        opacity: pending !== '' && pending !== isActive ? 0.6 : 1,
      });

      return react.createElement('div', {
        role: 'group',
        'aria-label': '本节功能',
        style: { display: 'inline-flex', alignItems: 'center', gap: '4px', marginRight: '4px' },
      }, ...FEATURES.map((item) => react.createElement('button', {
        key: item.id,
        type: 'button',
        style: chipStyle(item.id === active),
        'aria-pressed': item.id === active,
        title: item.hint,
        disabled: pending !== '',
        onClick: () => { choose(item.id); },
      }, item.label)), error
        ? react.createElement('span', { style: { fontSize: '12px', color: '#ff8a2a' } }, error)
        : null);
    }

    /** 需要插槽注册表与「命令」这条现成的 RPC 通道（官方 dsh-client-ui-plan 同款）。 */
    const inject = ['slots', 'remote', 'remote.commands'];

    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'lingdong-feature',
        order: 10,
        // sessionId 由插槽给我们；切功能走宿主注册的 /feature 命令
        inject: (sessionId) => ({
          select: (feature, target) => ctx.remote.commands.execute(target || sessionId, `/feature ${feature}`, []),
        }),
      }, FeatureSwitch));
    }

    return { name: 'lingdong-feature', inject, apply };
  },
});
