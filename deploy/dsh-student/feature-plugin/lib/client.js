/**
 * 灵动ai 学生端「功能」开关 —— 浏览器侧（2026-09-17）。
 *
 * 往输入框那一排（`conversation.input.left`，官方留白、无占用者的 list 插槽）放三个按钮：
 *   对话 / 写代码 / 做网页。点了就切，切完 AI 的角色跟着变（宿主侧把这段放进系统提示词）。
 *
 * 几条来自 dsh 自身的约束（照做，别绕）：
 *   · 浏览器里 **只能 require 极少几个种子模块**（react / react/jsx-runtime / react-dom…
 *     slots/primitives 那几个包根本不在磁盘上，它们被打进 shell 了），所以这里只 require
 *     react/jsx-runtime，其余全靠 cordis 服务（ctx.slots / ctx.remote / ctx.locale）拿。
 *   · **不自建 RPC 命名空间**：切功能走宿主注册好的 `/feature` 命令
 *     （`ctx.remote.commands.execute(sessionId, '/feature web', [])`），这条通道是现成的。
 *   · 插槽是 `scope: session` 的：**新会话首页（hero）不渲染**，所以这一排按钮在
 *     「会话已经存在」之后才出现（第一条消息之前用默认功能，见交接文档）。
 */
window.__ModuleLoader__.load({
  id: '@lingdong/dsh-feature',
  factory: (require) => {
    const react = require('react');
    const jsx = require('react/jsx-runtime');

    const NS = 'lingdong-feature';
    /** 与宿主侧 FEATURES / FEATURE_TEXT 一一对应；label 是学生看到的按钮文字。 */
    const FEATURES = [
      { id: 'chat', label: '对话', hint: '讲解、答疑、帮你想思路' },
      { id: 'code', label: '写代码', hint: '一起写代码，逐段讲清楚' },
      { id: 'web', label: '做网页', hint: '做出一个能直接打开的页面' },
    ];

    /** 当前功能：从会话投影里读（宿主侧 wire 出来的那个字符串），读不到就当默认。 */
    function useFeature(session) {
      return react.useMemo(() => {
        const value = session?.projectionValues?.studentFeature;
        const id = typeof value === 'string' ? value : '';
        return FEATURES.some((item) => item.id === id) ? id : 'chat';
      }, [session?.projectionValues?.studentFeature]);
    }

    /**
     * 三个按钮。放在输入框工具行左侧，和附件键同一排 —— 一眼看到这个页面能做什么。
     *
     * ⚠️ 样式一律**内联**（品牌插件同款做法）：dsh 的客户端没有给我们注入样式表的通道，
     * 写 class 名而指望某个 css 会被加载，是这次最容易踩空的地方。
     * @param props - dsh 给的会话相关 props（sessionId / useSession / t / 我们 inject 进去的 select）
     */
    function FeatureSwitch({ sessionId, useSession, select, t }) {
      const session = useSession?.((state) => state);
      const active = useFeature(session);
      const [pending, setPending] = react.useState('');
      const [error, setError] = react.useState('');

      const choose = react.useCallback(async (id) => {
        if (!sessionId || id === active) return;
        setPending(id); setError('');
        try {
          const result = await select(id, sessionId);
          if (result && result.ok === false) setError(result.error?.message || '切换失败');
        } catch (cause) {
          setError(String(cause?.message || cause));
        } finally {
          setPending('');
        }
      }, [sessionId, active, select]);

      const chipStyle = (isActive) => ({
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        padding: '5px 10px', borderRadius: '999px', fontSize: '12px', lineHeight: 1.2,
        whiteSpace: 'nowrap', cursor: 'pointer',
        border: `1px solid ${isActive ? 'rgba(255,138,42,.55)' : 'transparent'}`,
        background: isActive ? 'rgba(255,138,42,.14)' : 'transparent',
        color: isActive ? '#ff8a2a' : 'inherit',
        opacity: pending && pending !== 'idle' ? 0.6 : 1,
      });

      const children = FEATURES.map((item) => react.createElement('button', {
        key: item.id,
        type: 'button',
        style: chipStyle(item.id === active),
        'aria-pressed': item.id === active,
        title: item.hint,
        disabled: pending !== '',
        onClick: () => { choose(item.id); },
      }, item.label));

      return react.createElement('div', {
        role: 'group',
        'aria-label': t ? t('group') : '功能',
        style: { display: 'inline-flex', alignItems: 'center', gap: '4px', marginRight: '4px' },
      },
      ...children,
      error ? react.createElement('span', { style: { fontSize: '12px', color: '#ff8a2a' } }, error) : null);
    }

    const inject = ['slots', 'remote', 'remote.commands'];

    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'lingdong-feature',
        order: 10,
        locale: NS,
        // 切功能的那条路：现成的命令通道（宿主注册了 /feature）。sessionId 由插槽给我们。
        inject: (sessionId) => ({
          select: async (feature, target) => ctx.remote.commands.execute(target || sessionId, `/feature ${feature}`, []),
        }),
      }, FeatureSwitch));
    }

    return { name: 'lingdong-feature', inject, apply };
  },
});
