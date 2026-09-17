/**
 * 灵动ai 学生端「功能」开关 —— 浏览器侧。
 *
 * 往输入框工具行左侧（`conversation.input.left`，官方留白、没有占用者的 list 插槽）放三个按钮：
 * 对话 / 写代码 / 做网页。点了就切，切了 AI 的角色跟着变（宿主侧把它放进系统提示词）。
 *
 * 状态在**宿主**那边（插件自己的状态文件，按会话记），客户端只负责显示与切换：
 *   · 挂载时调一次 `/feature`（不带参数）问当前值 —— 宿主回报 `feature=<id>`；
 *   · 点击时调 `/feature <id>`，成功后把本地显示状态改掉。
 * ⚠️ 这里**不能**读会话投影（`useProjection`）：那要求宿主往会话日志里写自定义事件，
 *    而那个 harness 会因此拒绝加载整份历史（详见宿主侧文件头的教训）。所以显示状态是本地的，
 *    真值以宿主为准、切换时对齐。
 *
 * 几条来自 dsh 自身的约束（照做，别绕）：
 *   · 浏览器里**只能 require 极少的种子模块**（react / react/jsx-runtime），别的包根本不在磁盘上。
 *   · 插槽给的标准 props 是 **`sessionId` / `useSession` / `useProjection`** 三个。
 *   · **不自建 RPC**：切换走宿主注册好的 `/feature` 命令，与官方 dsh-client-ui-plan 同一个通道。
 *     返回值形状：`{ok, value:{result:{kind,text}}}` / `{ok:false, error:{code,message}}`。
 *   · 插槽是 `scope: session` 的：**新会话首页不渲染它**，所以这一排按钮在「已经有一个会话」
 *     之后才出现（第一条消息之前用默认功能）。
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
    const KNOWN = FEATURES.map((item) => item.id);
    /** 宿主回报的格式（见宿主侧 handler）：`feature=<id>` */
    const REPORT_PREFIX = 'feature=';

    /**
     * 三个按钮。放在输入框工具行左侧、和附件键同一排 —— 一眼看到这个页面能做什么。
     *
     * ⚠️ 样式一律**内联**：dsh 的客户端没有给我们注入样式表的通道。
     * @param props - 插槽给的标准 props + 我们 inject 进去的 call。
     */
    function FeatureSwitch({ sessionId, call }) {
      const [active, setActive] = react.useState(FALLBACK);
      const [ready, setReady] = react.useState(false);
      const [pending, setPending] = react.useState('');
      const [error, setError] = react.useState('');

      // 挂载（或换会话）时问一次宿主的当前值。问不到就一直显示默认「对话」——
      // 显示错了也不要紧：真正的角色由宿主决定，这里只是别让按钮看起来没选。
      react.useEffect(() => {
        let alive = true;
        if (!sessionId) return undefined;
        setReady(false);
        Promise.resolve(call('', sessionId)).then((result) => {
          if (!alive) return;
          const text = String(result?.value?.result?.text || '');
          const id = text.startsWith(REPORT_PREFIX) ? text.slice(REPORT_PREFIX.length).trim() : '';
          if (KNOWN.includes(id)) setActive(id);
          setReady(true);
        }).catch(() => { if (alive) setReady(true); });
        return () => { alive = false; };
      }, [sessionId, call]);

      const choose = react.useCallback(async (id) => {
        if (!sessionId || id === active || pending) return;
        setPending(id);
        setError('');
        try {
          const result = await call(id, sessionId);
          if (result === undefined) { setError('切换通道不可用'); return; }
          if (!result.ok) { setError(`${result.error.message}（${result.error.code}）`); return; }
          if (result.value === undefined) { setError('这条切换命令没注册上'); return; }
          if (result.value.result?.kind === 'error') { setError(result.value.result.text || '切换失败'); return; }
          setActive(id);
        } catch (cause) {
          setError(String(cause?.message || cause));
        } finally {
          setPending('');
        }
      }, [sessionId, active, pending, call]);

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
        disabled: pending !== '' || !ready,
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
        // feature 为空字符串 = 问当前值；否则切换。sessionId 由插槽给我们。
        inject: (sessionId) => ({
          call: (feature, target) => ctx.remote.commands.execute(
            target || sessionId,
            String(feature || '').trim() ? `/feature ${feature}` : '/feature',
            [],
          ),
        }),
      }, FeatureSwitch));
    }

    return { name: 'lingdong-feature', inject, apply };
  },
});
