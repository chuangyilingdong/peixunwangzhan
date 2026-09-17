/**
 * 灵动ai 学生端品牌 —— 浏览器侧。
 *
 * 两部分：
 *   ① 品牌：占住侧边栏的两个品牌插槽（与官方包同名，所以我们关掉官方那一行即可，不必动 dsh 源码）
 *      · sidebar.brand.mark —— 方标：品牌图按高度缩放、装在一个方形窗口里（收起侧栏时只看得见它）
 *      · sidebar.brand.name —— 字标：完整的「灵动ai」横标
 *   ② 功能开关（2026-09-17）：往输入框那一排（conversation.input.left，官方留白、无占用者）
 *      放三个按钮 对话 / 写代码 / 做网页，点了就切（走宿主注册好的 /feature 命令）。
 *      ⚠️ 浏览器里只能 require 极少的种子模块（react / react/jsx-runtime / react-dom…），
 *        别的包根本不在磁盘上（它们被打进 shell 了）—— 所以这里只 require react 与 jsx-runtime。
 *
 * LOGO 的 data URL 由构建期注入（见 build.mjs）：把品牌图内联进来，
 * 容器里不必再放一个静态文件，也就不依赖 dsh 怎么对外发静态资源。
 */
window.__ModuleLoader__.load({
  id: '@lingdong/dsh-brand',
  factory: (require) => {
    const react = require('react');
    const react_jsx_runtime = require('react/jsx-runtime');
    /** 构建期替换：assets/lingdong-ai-logo-480.png 的 data URL */
    const LOGO = '__LINGDONG_LOGO_DATA_URL__';
    /** 侧边栏插槽服务。⚠️ 只声明 slots：remote 在点击时才取 —— 品牌是承重的（它挂了整个外观都没了），
     *  不该为了一个按钮去等一个可能不存在的服务。 */
    const inject = ['slots'];

    /** 三个功能：与宿主侧 lib/index.js 的 FEATURES / FEATURE_TEXT 一一对应。 */
    const FEATURES = [
      { id: 'chat', label: '对话', hint: '讲解、答疑、帮你想思路' },
      { id: 'code', label: '写代码', hint: '一起写代码，逐段讲清楚' },
      { id: 'web', label: '做网页', hint: '做出一个能直接打开的页面' },
    ];

    /** 当前功能从会话投影里读（宿主侧 wire 出来的那个字符串）；读不到就当默认「对话」。 */
    function useFeature(session) {
      const raw = session?.projectionValues?.studentFeature;
      const id = typeof raw === 'string' ? raw : '';
      return FEATURES.some((item) => item.id === id) ? id : 'chat';
    }

    /**
     * 输入框那一排的三个功能按钮。
     * ⚠️ 样式一律**内联**：dsh 的客户端没有给我们注入样式表的通道，写 class 名而指望某份 css 被加载，
     *    是这里最容易踩空的地方。
     * @param props - dsh 给的会话相关 props（sessionId / useSession / t）+ 我们 inject 进去的 ctx
     */
    function FeatureSwitch({ sessionId, useSession, ctx }) {
      const session = useSession ? useSession((state) => state) : undefined;
      const active = useFeature(session);
      const [pending, setPending] = react.useState('');
      const [error, setError] = react.useState('');

      const choose = async (id) => {
        if (!sessionId || id === active || pending) return;
        setPending(id); setError('');
        try {
          const remote = ctx?.remote?.commands;
          if (!remote?.execute) { setError('切换通道不可用'); return; }
          const result = await remote.execute(sessionId, `/feature ${id}`, []);
          if (result && result.ok === false) setError(result.error?.message || '切换失败');
        } catch (cause) {
          setError(String(cause?.message || cause));
        } finally {
          setPending('');
        }
      };

      const chipStyle = (isActive) => ({
        display: 'inline-flex', alignItems: 'center', padding: '5px 10px', marginRight: '4px',
        borderRadius: '999px', fontSize: '12px', lineHeight: 1.2, whiteSpace: 'nowrap', cursor: 'pointer',
        border: '1px solid ' + (isActive ? 'rgba(255,138,42,.55)' : 'transparent'),
        background: isActive ? 'rgba(255,138,42,.14)' : 'transparent',
        color: isActive ? '#ff8a2a' : 'inherit',
        opacity: pending && pending !== id ? 0.6 : 1,
      });

      const chips = FEATURES.map((item) => react.createElement('button', {
        key: item.id, type: 'button', style: chipStyle(item.id === active),
        'aria-pressed': item.id === active, title: item.hint,
        disabled: pending !== '', onClick: () => { choose(item.id); },
      }, item.label));

      return react.createElement('div', {
        role: 'group', 'aria-label': '功能',
        style: { display: 'inline-flex', alignItems: 'center' },
      }, ...chips, error ? react.createElement('span', { style: { fontSize: '12px', color: '#ff8a2a' } }, error) : null);
    }

    /**
     * 方标：正方形窗口里放品牌图的左半（「灵动」两个字），收起侧栏时看到的就是它。
     * @param props - 宿主给的尺寸（侧栏收起/展开时会变）。
     */
    function LingdongBrandMark({ size }) {
      const px = Number(size) > 0 ? Number(size) : 24;
      return react_jsx_runtime.jsx('span', {
        role: 'img',
        'aria-label': '灵动ai',
        style: {
          width: `${px}px`, height: `${px}px`, overflow: 'hidden',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-start', flex: '0 0 auto',
        },
      }, react_jsx_runtime.jsx('img', {
        src: LOGO, alt: '', draggable: false,
        style: { height: `${px}px`, width: 'auto', display: 'block' },
      }));
    }

    /** 字标：完整的「灵动ai」横标。 */
    function LingdongBrandName() {
      return react_jsx_runtime.jsx('img', {
        src: LOGO, alt: '灵动ai', draggable: false,
        style: { height: '20px', width: 'auto', display: 'block' },
      });
    }

    /**
     * 欢迎页上那个标（官方是有一条会动的鲸鱼做兜底）。这里换成我们的品牌图。
     * @param props - 宿主给的尺寸（34）与自己的样式类名。
     */
    function LingdongHeroMark({ size, className }) {
      const px = Number(size) > 0 ? Number(size) : 34;
      return react_jsx_runtime.jsx('img', {
        src: LOGO, alt: '灵动ai', className, draggable: false,
        style: { height: `${Math.round(px * 1.15)}px`, width: 'auto', display: 'block' },
      });
    }

    /**
     * 填品牌插槽（写法照抄官方包，只是换成我们的组件）。
     * 覆盖三处：侧边栏的方标/字标、欢迎页的标 —— 官方那套（鲸鱼标）因此不会再出现。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      // 功能按钮：输入框那一排（list 插槽，官方留白）。插槽是 session 作用域的 ——
      // **新会话首页不渲染**，所以它在「会话已经存在」之后出现（第一条消息用默认功能）。
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'lingdong-feature',
        order: 10,
        inject: () => ({ ctx }),
      }, FeatureSwitch));
      ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, LingdongBrandMark);
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, LingdongBrandName);
      }));
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, LingdongHeroMark);
      });
    }

    return { apply, inject };
  },
});
