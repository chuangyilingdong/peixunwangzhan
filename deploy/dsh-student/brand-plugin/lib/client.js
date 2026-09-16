/**
 * 灵动ai 学生端品牌 —— 浏览器侧。
 *
 * 占住侧边栏的两个品牌插槽（与官方包同名，所以我们关掉官方那一行即可，不必动 dsh 源码）：
 *   · sidebar.brand.mark —— 方标：品牌图按高度缩放、装在一个方形窗口里（收起侧栏时只看得见它）
 *   · sidebar.brand.name —— 字标：完整的「灵动ai」横标
 *
 * LOGO 的 data URL 由构建期注入（见 build.mjs）：把品牌图内联进来，
 * 容器里不必再放一个静态文件，也就不依赖 dsh 怎么对外发静态资源。
 */
window.__ModuleLoader__.load({
  id: '@lingdong/dsh-brand',
  factory: (require) => {
    const react_jsx_runtime = require('react/jsx-runtime');
    /** 构建期替换：assets/lingdong-ai-logo-480.png 的 data URL */
    const LOGO = '__LINGDONG_LOGO_DATA_URL__';
    /** 侧边栏插槽服务 */
    const inject = ['slots'];

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
