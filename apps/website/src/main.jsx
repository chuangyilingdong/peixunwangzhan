import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import '@platform/shared/styles.css';
import './styles.css';
import { LEGAL_DOCUMENTS, LEGAL_EFFECTIVE_DATE, LEGAL_OWNER, LEGAL_STATUS, LEGAL_VERSION } from './legal.js';
import { LoginPanel, BrandLogo, CanvasClassroom, CanvasWorkspace, StudentCourseCenter, Icon, Notice, createApiClient, readSession as readUserSession, writeSession as saveUserSession, clearSession as removeUserSession } from '@platform/shared';
import { MyWorksPage } from './pages/MyWorks.jsx';
import { MyWorkDetailPage } from './pages/MyWorkDetail.jsx';
import { WorkDetailPage } from './pages/WorkDetail.jsx';
// 首页按钮用 React Bits 的 SpecularButton（WebGL 镜面高光），见组件文件顶部的来源与注意事项
import SpecularButton from './components/SpecularButton.jsx';

// 官网公开页面统一走共享 API client，保持错误解析与鉴权行为一致
const publicApi = createApiClient();

function LoginPage() {
  const loc = useLocation();
  // 登录入口分「机构 / 老师」与「学生」两个（用户口径 2026-09-18）。这里**不按入口拦人**：
  // 入口只决定提示文案与交叉链接，鉴权仍由登录接口按角色判定，登录后按角色落到各自工作台。
  const asStudent = new URLSearchParams(loc.search).get('as') === 'student';
  async function handleLogin({ login, password }) {
    let session;
    try {
      const data = await publicApi.post('auth/login', { login, password });
      session = saveUserSession(data);
    } catch (err) {
      throw new Error(err.message || '登录失败');
    }
    const role = session.user?.role;
    // 线框主流程：学生登录后直接进入「我的课包」，官网公开首页仍可从品牌入口返回。
    const target = role === 'STUDENT' ? '/learn' : role === 'TEACHER' || role === 'ORG_ADMIN' ? '/' : role === 'SUPER_ADMIN' || role === 'PLATFORM_ADMIN' ? '/admin/' : '/';
    window.location.assign(target);
  }
  // 背景按首页来做（用户口径 2026-09-18）：同一份视频资产、同一套「视频 + 压暗层」叠法。
  // 平台端/机构端登录页没有这个视频资源，所以视频只铺在官网这一侧（共享面板只给底色）。
  return <div className='website-login'><div className='login-bg' aria-hidden='true'><video src='/assets/hero-animal.mp4' poster='/assets/hero-animal-poster.webp' autoPlay muted loop playsInline preload='auto' /><div className='login-scrim' /></div><Link className='login-back' to='/'>← 返回官网首页</Link><LoginPanel title={asStudent ? '学生登录' : '机构 / 老师登录'} description={asStudent ? '登录后继续你的创作旅程。' : '登录后进入机构工作台。'} onLogin={handleLogin} demos={[]} /><p className='login-switch'>{asStudent ? <>我是机构 / 老师，<a href={ORG_APP_URL}>去机构后台</a></> : <>我是学生，<Link to='/login?as=student'>去学生登录</Link></>}</p></div>;
}

const ORG_APP_URL = import.meta.env?.VITE_ORG_APP_URL || '/org/';
const INTERNAL_TEST = import.meta.env?.VITE_DEPLOYMENT_MODE === 'internal-test';

const FALLBACK_WORKS=[['🫧','点泡泡','小游戏','30 秒内点爆所有泡泡，节奏轻快的点击小游戏。'],['🍂','山行 · 杜牧','语文互动','朗读、探索与闯关结合，把古诗学成可玩的互动课。'],['🧩','C++ 代码大冒险','编程启蒙','积木拼程序，边玩边看 3D 执行过程与代码。'],['🧱','我的世界 · 简化版','沙盒创意','浏览器里搭方块世界，保存自己的创意地图。']];


// 平台统一名称：2026-09-18 用户口径「我们平台的名字叫：灵动ai学院」。
// 此前官网同一站点内并存「AI魔法学院」（无空格，Logo/标题/协议）与「AI 魔法学院」（有空格，
// 首页滚动区/首页 logo 区）两种写法，画布页又是第三种「灵动ai」——所以品牌名只认这一个常量。
const BRAND_NAME = '灵动ai学院';
const BRAND_TAGLINE = '青少年 AI 创作开课平台';
// 官网主导航：桌面端与移动端抽屉共用这一份。
// 此前 main.jsx 里有两份内容相同的硬编码导航（Header 的 nav 与 WEBSITE_NAV），改文案要改两处。
const WEBSITE_NAV = [['/', '首页'], ['/learn', '灵动学习'], ['/marketplace', '灵动课程'], ['/works', '灵动作品'], ['/handbook', '机构手册'], ['/faq', '常见问题'], ['/download', 'VibeCoding客户端下载']];
// 未登录时的两个登录入口（用户口径 2026-09-18）。机构/老师与学生是**同一套账号体系、同一个登录接口**，
// 两个入口只决定落点，不参与鉴权判定——所以不往 auth/login 里传 clientType，
// 避免「老师从学生入口进来就被拒」这类按入口拦人的行为。
// ⚠️ 2026-09-18 晚用户口径：「机构和老师登录应该是到后台」——所以机构/老师这条**直接进机构后台**
//    （`/org/`，那边有自己的一套登录页）。原来它指向官网自己的 `/login?as=staff`，而那个页面铺的是
//    首页那支视频，点进去看着还像首页（用户就是这么报的：「为什么还在首页」）。
//    学生入口留在官网上 —— 学生登录后进自己的课包中心。
//    第三条 `true` = **跨应用跳转**（机构后台是另一个 SPA），必须整页跳、不能走前端路由。
const LOGIN_ENTRIES = [['机构 / 老师登录', ORG_APP_URL, true], ['学生登录', '/login?as=student', false]];
// 品牌区用真正的 logo（灵动ai 横标，三端共用同一张图）；不再用「✦ + 文字」的占位标记。
function Logo(){return <Link className="logo" to="/"><BrandLogo height={26} /></Link>}
function AuthEntries({ onDark, onNavigate }){
  // 未登录时导航右侧的两个入口。登录后这里换成账号徽标（由 App 传 userBadge 进来）。
  // 黑底首页上用 SpecularButton；浅底内页仍用原来的描边胶囊 —— 光效是「白线在暗面上扫」。
  const go = (to, external) => { if (external) window.location.assign(to); else onNavigate(to); };
  if (onDark) return <>{LOGIN_ENTRIES.map(([label, to, external]) => <SpecularButton key={label} className="site-specular-btn" size="sm" radius={999} tint="#ffffff" tintOpacity={0.06} blur={6} textColor="#ffffff" lineColor="#ffffff" baseColor="#7c7c85" intensity={0.8} shineSize={15} shineFade={45} thickness={1} speed={0.45} followMouse proximity={160} onClick={() => go(to, external)}>{label}</SpecularButton>)}</>;
  return <>{LOGIN_ENTRIES.map(([label, to, external]) => external ? <a key={label} className='site-login' href={to}>{label}</a> : <Link key={label} className='site-login' to={to}>{label}</Link>)}</>;
}
function Header({ userBadge, signedIn }){
  const loc=useLocation();
  const navigate=useNavigate();
  const [menuOpen,setMenuOpen]=useState(false);
  // 路由变化后收起抽屉：否则从抽屉点进新页面，抽屉会留在上面盖住内容。
  useEffect(()=>{ setMenuOpen(false); },[loc.pathname]);
  const onDark=loc.pathname==='/';
  // ⚠️ 登录之后**必须换成账号徽标，黑底首页也不例外**（用户 2026-09-18 晚报的 bug：
  //    「我用学生登录后，为什么到首页右上角不显示」）。原来这里是 `onDark ? <AuthEntries/> : userBadge`
  //    —— 深色首页上**永远**渲染两个登录入口、永远不渲染 userBadge，所以已登录用户看着像没登录。
  //    徽标在深色底上的配色早就在 styles.css 里备好了（`.site-topbar.on-dark .header-user` 那组）。
  // 顶栏右侧**只保留两个登录入口**：右上角那个「联系我们」在 2026-09-18 晚按用户口径删除。
  // 原因是导航用 `position:absolute; left:50%` 在页面里居中，视口一窄它就和右侧按钮组叠在一起 ——
  // 用户在内页截图报的「联系我们被遮挡」就是这一处（浅底那个实心胶囊被玻璃导航压住）。
  // ⚠️ 只删右上角这一个：首页 hero 的两个 CTA、页脚「合作」列、各页结尾的「联系我们」都保留。
  return <header className={'site-topbar'+(onDark?' on-dark':'')}><div className="bar"><Logo/><nav aria-label="主导航">{WEBSITE_NAV.map(([to,n])=><NavLink key={to} to={to} end={to==='/'} className={({isActive})=>isActive?'on':''}>{n}</NavLink>)}</nav><div className="head-actions">{!signedIn && onDark ? <AuthEntries onDark onNavigate={navigate}/> : userBadge}</div><button type="button" className="site-burger" aria-label={menuOpen?'关闭菜单':'打开菜单'} aria-expanded={menuOpen} onClick={()=>setMenuOpen(v=>!v)}>{menuOpen?'×':'☰'}</button></div>{menuOpen && <div className="site-menu-overlay"><div className="site-menu-head"><span>{BRAND_NAME}</span><button type="button" onClick={()=>setMenuOpen(false)}>关闭 ×</button></div><div className="site-menu-items">{WEBSITE_NAV.map(([to,n])=><NavLink key={to} to={to} end={to==='/'} className={({isActive})=>isActive?'active':''} onClick={()=>setMenuOpen(false)}>{n}<span>↗</span></NavLink>)}</div><div className="site-menu-login">{userBadge}</div></div>}</header>;
}
function Footer(){return <footer><div className="foot"><div><Logo/><p>面向教培机构与学校的<br/>青少年 AI 通识与 VibeCoding 开课平台。</p></div><div><strong>产品</strong><Link to="/marketplace">灵动课程</Link><Link to="/org">机构方案</Link><Link to="/works">灵动作品</Link></div><div><strong>合作</strong><Link to="/demo">联系我们</Link><Link to="/handbook">机构手册</Link><a href={ORG_APP_URL}>机构后台</a></div><div><strong>了解更多</strong><Link to="/download">下载客户端</Link><Link to="/faq">常见问题</Link><Link to="/compare">选型对比</Link><Link to="/terms">用户协议</Link><Link to="/privacy">隐私政策</Link><Link to="/minors">儿童 / 未成年人说明</Link><a href="mailto:hello@aimagc.cn">联系合作</a></div></div><div className="copyright">© 2026 {BRAND_NAME} <span>面向 8–16 岁 · 浏览器即用</span></div></footer>}
function Button({children,to='/demo',soft=false}){return <Link to={to} className={'button '+(soft?'soft':'')}>{children}<b>↗</b></Link>}
function Kicker({children}){return <div className="kicker">✦ {children}</div>}
// 作品卡片：按用户给的 zip（Figma Make 导出）重做 —— 白卡 + 10px 内边距 + **1.43:1 圆角封面**
// + **单行标题**（超出省略）+ 底部一行（左：学生名 / 右：机构）。
// ⚠️ 两处如实说明：
//   ①我们**没有作品封面图**（公开接口不下发任何缩略图），所以封面位沿用原来的「渐变 + emoji」画布块，
//     几何（比例/圆角/悬停放大/底部渐隐）照 zip；将来有真缩略图就把 .art 换成 <img> 即可。
//   ②zip 参考图里那套「星级评价 + 浏览数 + 作者皇冠」我们没有对应数据，**不假装有**；
//     只把 exists 的 featured 用一颗小星标出来（列表本来就按 featured 排序）。
// 整张卡可点（zip 的卡里没有按钮）：铺一层透明的 Link 覆盖整卡，键盘也能进。
// ── 作品广场的卡片与筛选（2026-09-19 晚按用户给的参考站重做）────────────────────────
// 用户口径：「我们现在灵动作品的展示有问题，参考这个网站的展示来设计」——参考站
// （ltai.cc/works-square，也是用户自己的站）的版式是：
//   类型筛选行（全部分类 + 各类型，各带一个小图标）→ 封面卡片网格
//   卡片 = 封面（左上角一枚类型角标、视频中间一个播放键）+ 标题 + 日期 + 作者
// 我们这边比它多两类**站内作品**（画布 / VibeCoding，它们没有封面图，仍用原来的渐变占位），
// 并且比它多一个搜索框（原来就有，保留）。
//
// ⚠️ 导入件（服务端 `scripts/import-plaza-works.mjs` 扒过来的）点开是**看图 / 播视频 / 跳原平台**，
//    站内作品点开仍是进详情页 —— 两种作品在同一个网格里，靠 `work.imported` 分支。
// 作品广场的**两个分类**（2026-09-19 用户口径：分类就 2 个；哪一个类型算哪一类由后台配置）。
// ⚠️ 每个作品属于哪一类**由服务端算好**（`work.plazaCategory`，见 services/plazaCategories.js），
//    前端不自己判类型 —— 否则后台一改分类，前端还按老规矩算。
const PL_CATEGORY_LABEL = { CANVAS: '画布作品', VIBECODING: 'VibeCoding作品' };
// 图标一律用 shared 的线性 SVG（packages/shared/src/icons.jsx），**不用 emoji**
//（用户口径：「网站需要用到的 icon 材质的，直接从这里取。我们的 AI 味太重了」）。
const PL_CATEGORY_ICON = { CANVAS: 'brush', VIBECODING: 'code' };
const plCategoryOf = (w) => (w.plazaCategory || (w.type === 'VIBECODING' ? 'VIBECODING' : 'CANVAS'));
/** 一页 12 件（用户口径：「每一页 12 个作品然后翻页」）。 */
const PL_PER_PAGE = 12;
const PL_TYPE_ORDER = ['canvas','VIBECODING','image','video','webpage','miniGame','ppt','brandDesign','music','podcast','agent','workflow','pictureBook'];
const PL_TYPE_META = {
  canvas:{label:'画布',icon:'brush'}, VIBECODING:{label:'VibeCoding',icon:'code'},
  image:{label:'图片',icon:'image'}, video:{label:'视频',icon:'video'}, webpage:{label:'网页',icon:'globe'},
  miniGame:{label:'小游戏',icon:'gamepad'}, ppt:{label:'PPT',icon:'monitor'}, brandDesign:{label:'品牌设计',icon:'palette'},
  music:{label:'音乐',icon:'music'}, podcast:{label:'AI播客',icon:'mic'}, agent:{label:'智能体',icon:'cpu'},
  workflow:{label:'工作流',icon:'flow'}, pictureBook:{label:'绘本',icon:'book'},
};
const plTypeOf = (w) => (w.imported ? (w.workType || 'image') : (w.type === 'VIBECODING' ? 'VIBECODING' : 'canvas'));
const plDateOf = (w) => {
  const raw = w.imported ? (w.createdAt || w.submittedAt) : w.submittedAt;
  if (!raw) return '';
  const text = String(raw).replace(' ', 'T');
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return String(raw).slice(0, 10);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
};
// 哪些类型是「看图」、哪些是「播放」——**先看类型，再看扩展名**。
// ⚠️ 光看扩展名会漏：导入的数据里图片有不少是**没有扩展名**的图床链接
//    （形如 `https://space.coze.cn/api/coze_space/gen_image?...`），视频也有 `.mov` 之外的写法。
//    类型是第一判据，扩展名只在「类型没给出线索」时兜底。
const PL_IMAGE_TYPES = new Set(['image', 'brandDesign', 'pictureBook', 'workflow']);
// 音频（音乐 / AI播客）：有本体文件就直接播
const PL_AUDIO_TYPES = new Set(['music', 'podcast']);
const plIsAudio = (w) => (w.contentUrls || []).some((url) => /\.(mp3|m4a|wav|aac|ogg|flac)(\?|$)/i.test(url));
// ⚠️ 外链作品能不能"在我们页面里打开"，**取决于对方允不允许被 iframe 嵌入**：
//    实测 lingguang.com 没写 frame-ancestors（可以嵌），而 qianwen.com / doubao.com 都写了
//    frame-ancestors 只允许自家域名（嵌不进去，浏览器会拒）。所以这里的策略是：
//    先试 iframe 内嵌，同时**永远给一个「在新窗口打开」的出口** —— 对方拒绝时页面里是空白，
//    学生至少还有路可走（不装作能嵌）。
const PL_EMBED_TYPES = new Set(['webpage', 'miniGame', 'agent', 'workflow', 'ppt', 'podcast', 'music']);
const plIsVideo = (w) => w.workType === 'video' || (w.contentUrls || []).some((url) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url));
const plImageUrls = (w) => {
  const urls = w.contentUrls || [];
  const looksImage = (url) => /^data:image\//i.test(url) || /\.(png|jpe?g|gif|webp|bmp|avif|svg)(\?|$)/i.test(url);
  if (PL_IMAGE_TYPES.has(w.workType)) return urls.filter((url) => looksImage(url) || !/\.(mp4|mov|webm|m4v|pdf|zip)(\?|$)/i.test(url));
  return urls.filter(looksImage);
};
/** 这条作品点开之后干什么：图片看图、视频播放、只有外链的跳原平台、站内作品进详情页。 */
const plOpenKind = (w) => {
  if (!w.imported) return 'detail';
  // ⭐ 托管的可运行网页作品（入口页在我们自己的 `/media/` 下）→ 在**沙箱**里跑。
  //    判据放在最前面：这类作品的 `contentUrls` 是空的、`externalUrl` 是 null，
  //    只有 `entryUrl` 有值 —— 不加这一支它会掉到 'none'（点开什么都不发生）。
  if (w.entryUrl) return 'webwork';
  if (plIsVideo(w) && (w.contentUrls || []).length) return 'video';
  if (plIsAudio(w)) return 'audio';
  if (plImageUrls(w).length) return 'image';
  if (w.externalUrl) return PL_EMBED_TYPES.has(w.workType) ? 'embed' : 'external';
  return 'none';
};

// ⭐ 跑网页作品 / 外链作品时给内层页面用的**最小逻辑视口**：页面按这个尺寸渲染，再整体等比缩放到可用空间。
//    为什么必须这样：学生页自带固定尺寸（实测贪吃蛇那页要 600px 高、会动的彩色小猫要 560px 宽），
//    而 iframe 是刻意的 opaque origin（不许带 allow-same-origin，见下面那段的注释），
//    外部读不到它内部滚没滚 —— 只能在**外面**缩。不缩的话小屏上就只能在框里往下滚
//    （用户报的「这游戏我根本无法玩，不可能玩的过程中还要去滚轮往下」）。
//    实测广场上 9 件带 entryUrl 的作品，不滚所需的最小视口 ≤ 560×600，这里留足余量取 640×768 ——
//    结果就是"逻辑视口的高度永远 ≥768"，实测最"高"的那件（贪吃蛇要 600）也不会再出现滚动条。
//    ⚠️ 有空间时（宽高都够）缩放封顶 1，按原生尺寸渲染，不做无谓放大。
const PL_FRAME_MIN = { w: 640, h: 768 };

// 作品查看器：图片看大图（多张可翻）、视频直接播。参考站卡片点开没有动作，我们做成能看/能播。
function WorkViewer({ work, onClose }) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // 开着查看层时锁住背后页面的滚动 —— 否则小屏上手指/滚轮一滑，动的是底下的广场页
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);
  const images = plImageUrls(work);
  const kind = plOpenKind(work);
  const isVideo = kind === 'video';
  const isAudio = kind === 'audio';
  const isEmbed = kind === 'embed';
  const isWebWork = kind === 'webwork';
  const hasFrame = isWebWork || isEmbed;
  // ⭐ 把内层页面等比缩放到这块可用空间：量出可用宽高 → 算出"至少 PL_FRAME_MIN"的逻辑视口 → 整体缩放。
  //    这样无论屏幕多小，学生页都是**完整可见**的（缩放到装下为止），不会出现任何滚动条。
  //    有空间时不放大（scale 封顶 1）；量不到（DOM 桩里没有 ResizeObserver）就退回 CSS 的 100% 铺满。
  const frameBoxRef = useRef(null);
  const [frameFit, setFrameFit] = useState(null);
  useLayoutEffect(() => {
    const box = frameBoxRef.current;
    if (!box || !hasFrame || typeof ResizeObserver !== 'function') return undefined;
    const measure = () => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h) return;
      const scale = Math.min(1, w / PL_FRAME_MIN.w, h / PL_FRAME_MIN.h);
      setFrameFit({ scale, w: w / scale, h: h / scale });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [hasFrame, work]);
  const frameStyle = frameFit
    ? { width: `${Math.round(frameFit.w)}px`, height: `${Math.round(frameFit.h)}px`, transform: `scale(${frameFit.scale})` }
    : undefined;
  return <div className="pl-viewer" role="dialog" aria-modal="true" aria-label={`查看作品：${work.title}`} onClick={onClose}>
    <div className={'pl-viewer-box' + (hasFrame ? ' has-frame' : '')} onClick={(event) => event.stopPropagation()}>
      <div className="pl-viewer-head">
        <div><span className="pl-badge">{(PL_TYPE_META[plTypeOf(work)] || {}).label || ''}</span><h3>{work.title}</h3></div>
        <button type="button" className="pl-viewer-close" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="pl-viewer-body">
        {isVideo
          ? <video className="pl-video" src={work.contentUrls[0]} controls autoPlay playsInline />
          : isAudio
            ? <audio className="pl-audio" src={(work.contentUrls || [])[0]} controls autoPlay />
            : hasFrame
              // ⭐ 跑网页作品 / 外链作品：内层页面按"不小于 PL_FRAME_MIN 的逻辑视口"渲染，
              //    再整体缩放到这块空间（见 PL_FRAME_MIN 的注释）—— 保证任何屏幕都**完整可见、没有滚动条**。
              ? <div className="pl-frame-fit" ref={frameBoxRef}>
                {isWebWork
                  // ⭐ 托管在**我们自己源**上的可运行网页作品（`/media/web-works/…`）。
                  //    ⚠️ 这里的 sandbox **绝不能**带 `allow-same-origin`：它与主站同源，
                  //    带上以后学生 HTML 就能读我们的 cookie / localStorage、甚至以我们的身份发请求。
                  //    不带时文档是 opaque origin，作品里的 three.js / p5 / CDN 依赖照样能加载，
                  //    相对路径资源也照常解析（sandbox 不影响 base URL）。
                  //    ⚠️ 同理**不给**「在新窗口打开」的出口（见下方 foot）——那等于把学生代码
                  //    提到我们源上当顶层页面跑，正好绕过这层沙箱。
                  ? <iframe className="pl-frame" src={work.entryUrl} title={work.title} loading="lazy" sandbox="allow-scripts allow-modals allow-forms allow-popups" style={frameStyle} />
                  // 外链作品的"在我们页面里打开"：能嵌的嵌进来（对方 CSP 挡掉时这里是空白，
                  // 所以下面永远跟着一个「在新窗口打开」的出口）
                  : <iframe className="pl-frame" src={work.externalUrl} title={work.title} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation" referrerPolicy="no-referrer" style={frameStyle} />}
              </div>
              : images.length ? <img className="pl-image" src={images[active]} alt={work.title} /> : null}
        {/* 缩略图只给「看图片」那条分支：框体件（hasFrame）里放的是一整个可运行页面，
            它的 contentUrls 是空的（见 plOpenKind 注释），而且那块空间被绝对定位的缩放容器占满 ——
            真渲染出来也只会藏在它后面。 */}
        {!isVideo && !hasFrame && images.length > 1 ? <div className="pl-thumbs">
          {images.map((url, index) => <button type="button" key={url} className={'pl-thumb' + (index === active ? ' on' : '')} onClick={() => setActive(index)} aria-label={`第 ${index + 1} 张`}>
            <img src={url} alt="" loading="lazy" />
          </button>)}
        </div> : null}
      </div>
      <div className="pl-viewer-foot">
        <span>{work.studentName || '小创作者'}{work.orgName ? ` · ${work.orgName}` : ''}</span>
        {/* 出口只给**外链**作品（新窗口打开的是别人的域名，不涉及我们的源）。
            ⭐ 托管的网页作品（entryUrl）刻意没有出口：它的入口页在我们自己源上，
            在新窗口打开就是拿我们的源跑学生代码，等于绕开上面那层沙箱。 */}
        {work.externalUrl ? <a className="pl-outlink" href={work.externalUrl} target="_blank" rel="noreferrer">打不开？在新窗口打开 ↗</a> : <span>{work.orgName || ''}</span>}
      </div>
    </div>
  </div>;
}

/** 翻页条上的页码：页数多时只显示「首 / 当前附近 / 末」，中间用 null 表示省略号。 */
function plPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(total - 1, current + 1);
  if (from > 2) out.push(null);
  for (let n = from; n <= to; n += 1) out.push(n);
  if (to < total - 1) out.push(null);
  out.push(total);
  return out;
}
function Work({work,index=0,onOpen}){
  const url=work.publicUrl||(work.shareToken?'/works/'+work.shareToken:null);
  const emoji=work.canvasSnapshot?.nodes?.[0]?.data?.emoji||work.emoji||'✦';
  const title=work.title;const student=work.studentName||'小创作者';const isVibe=work.type==='VIBECODING';
  const docKind=isVibe&&work.preview?.document?String(work.preview.kind||'').toLowerCase():'';
  const vibeHint=docKind==='pptx'?'演示文稿':docKind==='xlsx'?'表格':docKind==='docx'?'文档':isVibe?'可在线玩':'';
  const typeKey=plTypeOf(work);
  const typeMeta=PL_TYPE_META[typeKey]||{label:typeKey,icon:'✦'};
  const openKind=plOpenKind(work);
  const cover=work.coverUrl||null;
  const date=plDateOf(work);
  // 封面：导入件用真封面；站内作品没有封面图，沿用原来的渐变占位（按序号换色）
  const coverNode=cover
    ? <img className="pl-cover-img" src={cover} alt="" loading="lazy"/>
    // 没有封面图的站内作品：用同一套线性图标占位（不再用 emoji）
    : <span className="pl-cover-ph"><Icon name={isVibe?(docKind==='pptx'?'monitor':docKind?'text':'gamepad'):'brush'} size={46} strokeWidth={1.2} /></span>;
  const body=<>
    <div className={'pl-cover w'+(index%6)}>
      {coverNode}
      <span className="pl-badge">{typeMeta.label}</span>
      {openKind==='video'?<i className="pl-play" aria-hidden="true">▶</i>:null}
      <span className="pl-mark">灵动ai</span>
    </div>
    <div className="pl-meta">
      <h3 className="pl-title" title={title}>{title}</h3>
      {date?<span className="pl-date">{date}</span>:null}
    </div>
    <div className="pl-author">{work.featured?<i className="work-featured" title="精选作品" aria-label="精选作品">★</i>:null}
      <span className="pl-student">{student}</span>
      {/* 右下角那一格：机构名（用户给的图2 红框位置）。站内作品没有机构名时退回类型提示。 */}
      <span className="pl-org">{work.orgName || vibeHint || ''}</span>
    </div>
  </>;
  // 什么都能点：站内作品进详情页（<Link>，右键新标签照旧可用）；导入件弹出看图/播放层。
  return <article className="pl-card" data-type={typeKey} data-category={plCategoryOf(work)}>
    {openKind==='detail'&&url
      ? <Link className="pl-hit" to={url} aria-label={`打开作品：${title}`}>{body}</Link>
      : openKind==='external'
        ? <a className="pl-hit" href={work.externalUrl} target="_blank" rel="noreferrer" aria-label={`在原平台打开：${title}`}>{body}</a>
        : <button type="button" className="pl-hit" onClick={()=>onOpen(work)} aria-label={`查看作品：${title}`}>{body}</button>}
  </article>;
}
function Title({eyebrow,title,desc}){return <section className="page-title"><div><Kicker>{eyebrow}</Kicker><h1>{title}</h1><p>{desc}</p></div></section>}


// ── 首页（2026-09-18 按用户给的样式提示词重做）────────────────────────────
// 设计语言：单屏、黑底、全屏循环视频打底；上方导航 / 中间主张 / 底部数据三区。
// 两处「照提示词写但不能照抄」的地方（都是被现实约束卡住的，写在代码里免得下一轮又被改回去）：
//   ① 字体：提示词要从 Google Fonts / OnlineWebFonts / cdnjs 引「复古点阵显示字体」。但生产 CSP 是
//      `default-src 'self'; script-src 'self'`，且**没有 font-src**（回落 `'self'`）——外链字体/样式
//      会被浏览器直接拒收。CSP 是安全边界，不为换字体放宽，所以这里用**自托管**的 Geist / Noto Sans SC，
//      靠字重、字距与大写复刻那套显示字体的气质。
//   ② 背景视频：提示词给的是 r2.motionsites.dev 的 CloudFront 地址；这里换成站内已有的
//      `/assets/hero-animal.mp4`（自托管，不受第三方可用性影响，也不把访客 IP/UA 带给外域）。
// 文案与数据全部走 CMS 的 HOME 键（`heroKicker/heroTitle/heroAccent/heroDescription/trustTitle/
// trustDescription/stats`），后台「官网内容 → 首页」可改；没配就用下面的 fallback。
// ⚠️ 数据区**不要**改成 IntersectionObserver 触发：首页是单屏不滚动，没有交叉可言；
//    而且渲染守卫（scripts/p70）的 DOM 桩里没有这个全局，用了会让守卫直接报未定义。
// ⚠️ 这一组数字**必须与线上 CMS 的 HOME.stats 一致**（口径①）。
// 怎么定的：2026-09-18 晚用真浏览器打线上量出来的（首页数据区显示 3 门 / 48 节）——
//   代码里三处来源必须是同一组：CMS_FALLBACK.HOME.stats / HOME_STATS_FALLBACK /
//   packages/database/src/websiteContentDefaults.js 的 HOME.stats。
//   当时这里与 CMS_FALLBACK 一个写 11 门/87 节、一个写 3 门/48 节，于是**同一页会因为
//   「接口通 / 断」显示两套数字**；而 11 门/87 节只出现在 /org 与 /demo 的硬编码文案里
//   （那两处与线上 CMS 也不一致，已记在交接文档里等用户定）。
// ⚠️ 判断哪一组是对的，**只能打线上量**：p115 跑的是全新种子库（CMS = 种子），
//   只要两个兜底互相一致它就绿 —— 它看不见生产 CMS 里那份不同的数字。
/* 首页数据区那四个图标（用户 2026-09-23 口径：「用这些 logo，把官网首页图1这4个logo换一下」，
   指的是 https://github.com/topics/svg-icon 那一页的图标集）。
   取的是那一页排第一的 **css.gg**（MIT，https://github.com/astrit/css.gg ）——
   与站内其它图标同一条做法：**内联 SVG、不引依赖**（官网依赖里没有图标库，也不想为四个图标加一个）。
   ⚠️ MIT 要求保留出处：以后换图标时，把上面这两行许可说明一起换掉并注明新的来源。
   ⚠️ 统一 `fill: currentColor`：颜色跟着 `.hp-stat i` 那层走（深色首页上是 rgba(255,255,255,.72)），
      尺寸用 `1em` 跟着那一层的 font-size（clamp(18px,2.4vw,28px)）—— 改样式时只改 CSS。 */
const HOME_STAT_ICONS = {
  // gg-album → 标准课包（一本带书签的书）
  package: <path fillRule="evenodd" clipRule="evenodd" d="M2 19C2 20.6569 3.34315 22 5 22H19C20.6569 22 22 20.6569 22 19V5C22 3.34315 20.6569 2 19 2H5C3.34315 2 2 3.34315 2 5V19ZM20 19C20 19.5523 19.5523 20 19 20H5C4.44772 20 4 19.5523 4 19V5C4 4.44772 4.44772 4 5 4H10V12.0111L12.395 12.0112L14.0001 9.86419L15.6051 12.0112H18.0001L18 4H19C19.5523 4 20 4.44772 20 5V19ZM16 4H12V9.33585L14.0001 6.66046L16 9.33571V4Z" />,
  // gg-notes → 课时总量（一叠带行的纸）
  lessons: <>
    <path d="M6 6C6 5.44772 6.44772 5 7 5H17C17.5523 5 18 5.44772 18 6C18 6.55228 17.5523 7 17 7H7C6.44771 7 6 6.55228 6 6Z" />
    <path d="M6 10C6 9.44771 6.44772 9 7 9H17C17.5523 9 18 9.44771 18 10C18 10.5523 17.5523 11 17 11H7C6.44771 11 6 10.5523 6 10Z" />
    <path d="M7 13C6.44772 13 6 13.4477 6 14C6 14.5523 6.44771 15 7 15H17C17.5523 15 18 14.5523 18 14C18 13.4477 17.5523 13 17 13H7Z" />
    <path d="M6 18C6 17.4477 6.44772 17 7 17H11C11.5523 17 12 17.4477 12 18C12 18.5523 11.5523 19 11 19H7C6.44772 19 6 18.5523 6 18Z" />
    <path fillRule="evenodd" clipRule="evenodd" d="M2 4C2 2.34315 3.34315 1 5 1H19C20.6569 1 22 2.34315 22 4V20C22 21.6569 20.6569 23 19 23H5C3.34315 23 2 21.6569 2 20V4ZM5 3H19C19.5523 3 20 3.44771 20 4V20C20 20.5523 19.5523 21 19 21H5C4.44772 21 4 20.5523 4 20V4C4 3.44772 4.44771 3 5 3Z" />
  </>,
  // gg-board → 课堂形式（一块分成几栏的板 = 两种上课形式）
  format: <path fillRule="evenodd" clipRule="evenodd" d="M6 4C3.79086 4 2 5.79086 2 8V16C2 18.2091 3.79086 20 6 20H18C20.2091 20 22 18.2091 22 16V8C22 5.79086 20.2091 4 18 4H6ZM14 6H10V18H14V6ZM16 6V18H18C19.1046 18 20 17.1046 20 16V8C20 6.89543 19.1046 6 18 6H16ZM6 18H8V6H6C4.89543 6 4 6.89543 4 8V16C4 17.1046 4.89543 18 6 18Z" />,
  // gg-briefcase → 机构工作台（公文包）
  console: <>
    <path d="M14 11H10V13H14V11Z" />
    <path fillRule="evenodd" clipRule="evenodd" d="M7 5V4C7 2.89545 7.89539 2 9 2H15C16.1046 2 17 2.89545 17 4V5H20C21.6569 5 23 6.34314 23 8V18C23 19.6569 21.6569 21 20 21H4C2.34314 21 1 19.6569 1 18V8C1 6.34314 2.34314 5 4 5H7ZM9 4H15V5H9V4ZM4 7C3.44775 7 3 7.44769 3 8V14H21V8C21 7.44769 20.5522 7 20 7H4ZM3 18V16H21V18C21 18.5523 20.5522 19 20 19H4C3.44775 19 3 18.5523 3 18Z" />
  </>,
};

/* ⚠️ **老数据要能平滑升级**：生产 CMS 的 HOME.stats 里存的就是那几个字符（◆ ◇ ✧ ⌘，
   2026-09-18 那次改版写进去的），所以只改代码兜底的话**线上一个图标都不会变**。
   这里把它们按位映射到新图标 —— **不用动生产数据**就能立刻看到新图标；
   运维在后台重新保存时仍存这几个字符，照样渲染成图标。
   写了别的字符（emoji 之类）就按文字渲染，不进这张表。 */
const LEGACY_HOME_STAT_ICONS = { '◆': 'package', '◇': 'lessons', '✧': 'format', '⌘': 'console' };

function HomeStatIcon({ name }) {
  const raw = String(name || '').trim();
  const key = HOME_STAT_ICONS[raw] ? raw : LEGACY_HOME_STAT_ICONS[raw];
  // 认不出来就照旧当文字（运维在后台写了个 emoji 也不该被吃掉）
  if (!key) return <i>{raw || '✦'}</i>;
  return <i className="hp-stat-icon"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{HOME_STAT_ICONS[key]}</svg></i>;
}

// ⚠️ 这里的 `icon` 是**图标名**（HOME_STAT_ICONS 里的键），不再是字符 ——
//    2026-09-23 用户口径：把 ◆ ◇ ✧ ⌘ 那几个字符换成真图标（见上面 HOME_STAT_ICONS）。
//    老字符仍认（LEGACY_HOME_STAT_ICONS），所以生产 CMS 里那份老数据不用动。
const HOME_STATS_FALLBACK = [
  { icon: 'package', value: 3, suffix: ' 门', label: '标准课包' },
  { icon: 'lessons', value: 48, suffix: ' 节', label: '课时总量' },
  { icon: 'format', value: 2, suffix: ' 类', label: '课堂形式' },
  { icon: 'console', value: 1, suffix: ' 套', label: '机构工作台' },
];
function StatValue({ value, suffix }) {
  const target = Number(value) || 0;
  const [shown, setShown] = useState(target);
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduce || !target) { setShown(target); return undefined; }
    let raf; const started = performance.now(); const duration = 900;
    const tick = (now) => { const p = Math.min(1, (now - started) / duration); setShown(target * (1 - Math.pow(1 - p, 3))); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  const text = Number.isInteger(target) ? String(Math.round(shown)) : shown.toFixed(1);
  return <>{text}{suffix}</>;
}
// CMS 字段取值规则（2026-09-18 用户报的 bug）：**空串 = 运营故意清空 → 官网不显示**，
// 只有「字段不存在」或「接口失败」才用内置 fallback。
// ⚠️ 别写 `content.x || fallback`：空串是 falsy，后台清空后官网会继续显示内置默认文案，
//    用户看到的就是「我在后台清空了为什么还显示」。
// 首页大标题的字号自适应（**撤回 MaskedHeading 之后又回来了**，见上面那段说明）：
// 标题是后台可改的，写长了会被裁。按最长那一行的「字宽」估算（中文 1、拉丁 0.58），
// 再用 min(6vw, 92vw/字宽) 压到一行放得下；真放不下还有 CSS 换行兜底（绝不裁字）。
const titleWeight = (text) => [...String(text || '')].reduce((n, ch) => n + (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.58), 0);
function cmsPick(content, key, fallback) {
  const value = content?.[key];
  return value === undefined || value === null ? (fallback ?? '') : value;
}
function HomeLanding() {
  const cms = useWebsiteContent('HOME');
  const navigate = useNavigate();
  const content = cms.data || {};
  // stats 同理：后台把整排删空（空数组）就是不要这一排，不再退回内置那四项。
  const stats = Array.isArray(content.stats) ? content.stats : HOME_STATS_FALLBACK;
  const trustTitle = cmsPick(content, 'trustTitle', CMS_FALLBACK.HOME.trustTitle);
  const trustDescription = cmsPick(content, 'trustDescription', CMS_FALLBACK.HOME.trustDescription);
  const kicker = cmsPick(content, 'heroKicker', CMS_FALLBACK.HOME.heroKicker);
  const title = cmsPick(content, 'heroTitle', CMS_FALLBACK.HOME.heroTitle);
  const accent = cmsPick(content, 'heroAccent', CMS_FALLBACK.HOME.heroAccent);
  const description = cmsPick(content, 'heroDescription', CMS_FALLBACK.HOME.heroDescription);
  // 文案要等 CMS 接口回来才渲染：否则会先画一帧兜底文案（可能与后台里改过的不同）再被替换掉，
  // 强刷时看起来就是「旧版内容闪一下」。视频与按钮（不依赖 CMS）照常立刻出现，所以不会白屏。
  const ready = !cms.loading;
  // ⚠️⚠️ 2026-09-18 晚：这里**一度**换成了 React Bits 的 MaskedHeading（字形遮罩、视频从字里透出来，
  // 见提交 ab859a2），但用户看过实际页面后要求撤回：**「文字效果不好，而且看不清了」**。
  // 原因很实在：那个效果的原理就是「字 = 媒体」，而首页那支视频本身又暗又花，
  // 字里透出来的画面深浅不一 → 大标题必然不好读。所以又换回这套**按字数自适应字号**的实心字。
  // 📌 如果以后还想用那个效果：**别用在首页这句暗底长文案上**，找一句短的、媒体用亮且干净的画面
  //    （纯色渐变/亮图），可读性才立得住。组件源码在 git 历史里（ab859a2），要恢复照那个提交拿。
  const longestLine = Math.max(titleWeight(title), titleWeight(accent), 1);
  const titleStyle = { fontSize: `clamp(26px, min(6vw, ${(92 / longestLine).toFixed(2)}vw), 76px)` };
  return <main className="hp">
    <div className="hp-bg" aria-hidden="true"><video className="hp-video" src="/assets/hero-animal.mp4" poster="/assets/hero-animal-poster.webp" autoPlay muted loop playsInline preload="auto" /><div className="hp-scrim" /></div>
    <section className="hp-hero">
      {ready && (trustTitle || trustDescription) && <div className="hp-trust"><span className="hp-trust-mark">✦</span><div>{trustTitle ? <strong>{trustTitle}</strong> : null}{trustDescription ? <span>{trustDescription}</span> : null}</div></div>}
      {ready && kicker ? <p className="hp-kicker">{kicker}</p> : null}
      {ready && (title || accent) && <h1 className="hp-title" style={titleStyle}>{title ? <span>{title}</span> : null}{accent ? <em>{accent}</em> : null}</h1>}
      {ready && description ? <p className="hp-sub">{description}</p> : null}
      {/* 首页两个 CTA 用 SpecularButton（用户口径：两个**背景要一样**，主次只靠光效区分）：
          都是透明玻璃面（tintOpacity 0.08 + blur 8），主按钮高光常亮并缓慢扫过、次按钮只在光标靠近时亮起。
          ⚠️ 它渲染的是 <button>，所以导航走 onClick + navigate，不再是 <a>；
          代价是右键「新标签打开」不再可用（首页 CTA 影响很小，接受）。 */}
      <div className="hp-actions">
        <SpecularButton size="md" radius={999} tint="#ffffff" tintOpacity={0.08} blur={8} textColor="#ffffff" lineColor="#ffffff" baseColor="#8a8a92" intensity={1.15} shineSize={17} shineFade={40} thickness={1} speed={0.7} followMouse proximity={250} autoAnimate onClick={() => navigate('/demo')}>联系我们</SpecularButton>
        <SpecularButton size="md" radius={999} tint="#ffffff" tintOpacity={0.08} blur={8} textColor="#ffffff" lineColor="#ffffff" baseColor="#8a8a92" intensity={0.9} shineSize={15} shineFade={45} thickness={1} speed={0.55} followMouse proximity={250} onClick={() => navigate('/marketplace')}>查看课程</SpecularButton>
      </div>
    </section>
    {ready && stats.length ? <section className="hp-stats" aria-label="平台数据">{stats.map((item, index) => <div className="hp-stat" key={index + '-' + (item.label || '')}><HomeStatIcon name={item.icon} /><strong><StatValue value={item.value} suffix={item.suffix || ''} /></strong><span>{item.label || ''}</span></div>)}</section> : null}
  </main>;
}
function Home(_props) { return <HomeLanding />; }
function CTA(){return <section className="cta"><div><Kicker>准备好把 AI 课开起来了吗？</Kicker><h2>让每个孩子<br/><em>用 AI 做出自己的作品</em></h2><p>获取演示账号与示范课包清单。</p></div><Button>联系我们</Button></section>}

function Org(){const faqCms=useWebsiteContent('FAQ');
  // ⚠️ FAQ 的 CMS 内容 2026-09-18 晚改成**按端三档**（student / teacher / org），`title` 字段已废弃。
  //    机构页这块原来读的是那份通用列表（= 现在的 student 档），所以这里继续用 student 档、保持一致；
  //    标题回到固定文案（`title` 没了之后 `faqCms.data?.title` 恒为 undefined，渲染结果与改动前相同）。
  //    ⚠️ 别把这里改成 `.items` —— 那个字段已经不存在了，页面会静默退回写死的兜底、后台改了也不生效。
  // ⚠️ 2026-09-19：**去掉这里的兜底**。原来「student 为空 → 显示内置的 CMS_FALLBACK.FAQ.student」，
  //    于是运营把学生端问题删光之后，/faq 那边那一档没了、这里反而还在显示旧问答 —— 同一份 CMS
  //    在两个页面表现相反。按口径③（空 = 运营故意清空，不回退显示兜底）：空了就整块不显示。
  const faqItems=cmsList(faqCms.data?.student);const modules=[['机构账号','管理员、教师、学员分级；学员无需自备 API Key','课堂零配置，避免密钥泄露'],['授权次数','按机构开通、按班分给学生；剩余次数不足友好提示','用量可控，适合班级教学'],['课程中心','11 门 / 87 节标准课包；PPT 与 HTML 互动课件','标准化交付，校区可复制'],['管理后台','账号开通、课包浏览、作品发布、用量记录','运营数据透明'],['作品展厅','机构内作品聚合展示与在线预览','成果可视化，利于续费与招新']];return <><Title eyebrow="机构方案" title={<>教培机构如何开<br/><em>青少年 AI 通识课</em></>} desc="平台提供课程、机构账号与用量计费；机构负责招生和教学。8–16 岁学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的作品。"/><main className="inner"><section className="org-intro"><div><i>“</i><h2>不是再找一个聊天网站，<br/>而是一套<span>可管、可教、可展示</span>的课堂产品。</h2><p>学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的游戏、动画、互动故事和硬件作品。</p></div><div className="steps">{[['01','平台开通机构','配置席位、开通授权次数、发布课包权限。'],['02','老师创建学员账号','学生用机构账号登录，即可开始创作。'],['03','按课包授课','从课程中心进入课时，结合阿飞完成当堂作品。'],['04','作品沉淀与展示','优秀作业进入作品社区，形成校区案例库。']].map(x=><div key={x[0]}><b>{x[0]}</b><p><strong>{x[1]}</strong>{x[2]}</p></div>)}</div></section><section className="modules">{modules.map((m,i)=><article key={m[0]}><small>0{i+1}</small><h3>{m[0]}</h3><p>{m[1]}</p><b>{m[2]}</b></article>)}</section>{faqItems.length?<section className="faq"><div><Kicker>常见问题</Kicker><h2>开课前，你可能想知道</h2></div><div>{faqItems.map((item,i)=><details key={item.question||i} open={i===0}><summary>{item.question||''}</summary><p>{item.answer||''}</p></details>)}</div></section>:null}<End title="让你的校区拥有一门可复制的 AI 课" text="联系我们，获取试用账号与示范课包清单。"/></main></>}
function Works(){
  const [items,setItems]=useState(FALLBACK_WORKS.map(w=>({title:w[1],description:w[3],studentName:'小创作者',emoji:w[0]})));
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState(null);
  const [query,setQuery]=useState('');
  const [kind,setKind]=useState('');
  const [page,setPage]=useState(1);
  const [viewing,setViewing]=useState(null);
  useEffect(()=>{
    // 作品广场同时展示三类：画布作品（public/works）、平台已发布的 VibeCoding 作品
    // （public/vibecoding-works）、以及导入件（它们在 public/works 里，带 imported 标记）。
    // ⚠️ limit=500：作品广场要**一次取全**（类型胶囊上的件数与筛选都建立在这份列表上）。
//    服务端那条公开接口的上限就是 500（见 routes/communication/public.js 的注释），
//    图片都是 loading="lazy"，所以列表长不等于首屏重。
    Promise.allSettled([publicApi.get('public/works?limit=500'), publicApi.get('public/vibecoding-works?limit=100')]).then(([canvas, vibe])=>{
      const canvasItems = canvas.status === 'fulfilled' && Array.isArray(canvas.value?.items) ? canvas.value.items : [];
      const vibeItems = vibe.status === 'fulfilled' && Array.isArray(vibe.value?.items) ? vibe.value.items : [];
      const merged = [...vibeItems, ...canvasItems].sort((left, right) => Number(Boolean(right.featured)) - Number(Boolean(left.featured)));
      if (merged.length) setItems(merged);
      else if (canvas.status === 'rejected' && vibe.status === 'rejected') setError(canvas.reason?.message || '作品加载失败');
      setLoaded(true);
    });
  },[]);
  // 类型筛选（2026-09-19 晚按参考站重做）：参考站是一排「全部分类 + 各类型」的胶囊，各自带图标。
  // 我们这边多两类站内作品（画布 / VibeCoding），所以类型集合要按**当前数据里真有的**来排，
  // 不能写死 —— 否则广场上会挂着一堆点开是空的分类（参考站也是这个做法）。
  // 分类只有两个：画布作品 / VibeCoding作品（哪一个类型算哪一类由后台配，见服务端 plazaCategories.js）
  const catCounts = items.reduce((acc, w) => { const key = plCategoryOf(w); acc[key] = (acc[key] || 0) + 1; return acc; }, {});
  const byKind = kind ? items.filter((w) => plCategoryOf(w) === kind) : items;
  // 搜索按「标题 / 学生名字」匹配（大小写不敏感、去首尾空格）
  const keyword=query.trim().toLowerCase();
  const matched=keyword?byKind.filter((w)=>String(w.title||'').toLowerCase().includes(keyword)||String(w.studentName||'').toLowerCase().includes(keyword)):byKind;
  // 翻页：每页 12 件。⚠️ 换分类/换搜索词要把页码**收回第 1 页**（否则在第 40 页时切到只有 3 件的分类，
  // 页面会空着，看着像"这个分类没作品"）。
  const pageCount = Math.max(1, Math.ceil(matched.length / PL_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const visible = matched.slice((currentPage - 1) * PL_PER_PAGE, currentPage * PL_PER_PAGE);
  // 分类或搜索词一变就回第 1 页（见上面 currentPage 的注释）
  useEffect(()=>{ setPage(1); },[kind, query]);
  // 页头（「学员作品」+「孩子们的灵感，正在发光」+ 描述）与底部那条
  // 「作品来自真实课堂 / 了解机构作品展厅」提示，都按用户口径 2026-09-18 晚**删掉了**
  // （用户：「灵动作品这里全部不要」「图2也要删除」）。2026-09-19 晚只换展示，不再加回来。
  return <main className="inner works-page">
    <div className="works-bar">
      {/* 类型筛选：全部 + 数据里真有的类型（点一次选中，再点一次取消回「全部」） */}
      <div className="pl-types">
        <button type="button" data-type="all" aria-pressed={kind===''} className={'pl-type'+(kind===''?' on':'')} onClick={()=>setKind('')}>
          全部<span className="pl-type-n">{items.length}</span>
        </button>
        {['CANVAS','VIBECODING'].map((key)=><button type="button" key={key} data-type={key} aria-pressed={kind===key} className={'pl-type'+(kind===key?' on':'')} onClick={()=>setKind(kind===key?'':key)}>
          <Icon name={PL_CATEGORY_ICON[key]} size={15} className="pl-type-ico" />{PL_CATEGORY_LABEL[key]}<span className="pl-type-n">{catCounts[key]||0}</span>
        </button>)}
      </div>
      {/* 搜索：按作品的「标题 / 学生名字」过滤。作品列表本来就是前端把三类作品合并出来的，
          所以过滤也在前端做 —— 不用改接口。 */}
      <div className="works-search">
        <label className="sr-only" htmlFor="works-search">搜索作品标题或学生名字</label>
        <input id="works-search" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="搜索作品标题或学生名字…" autoComplete="off"/>
        {query?<button type="button" className="works-search-clear" onClick={()=>setQuery('')}>清空</button>:null}
        {loaded?<span className="works-search-count">共 <b>{matched.length}</b> 件</span>:null}
      </div>
    </div>
    <div className="works all">{visible.map((w,i)=><Work key={w.id||w.title} work={w} index={i} onOpen={setViewing}/>)}</div>
    {matched.length>PL_PER_PAGE?<div className="pl-pager">
      <button type="button" className="pl-page" disabled={currentPage<=1} onClick={()=>{setPage(currentPage-1);window.scrollTo({top:0,behavior:'smooth'});}}>上一页</button>
      {plPageNumbers(currentPage,pageCount).map((n,idx)=>n===null
        ? <span className="pl-page-gap" key={'gap'+idx}>…</span>
        : <button type="button" key={n} className={'pl-page'+(n===currentPage?' on':'')} aria-current={n===currentPage?'page':undefined} onClick={()=>{setPage(n);window.scrollTo({top:0,behavior:'smooth'});}}>{n}</button>)}
      <button type="button" className="pl-page" disabled={currentPage>=pageCount} onClick={()=>{setPage(currentPage+1);window.scrollTo({top:0,behavior:'smooth'});}}>下一页</button>
      <span className="pl-page-info">第 {currentPage} / {pageCount} 页</span>
    </div>:null}
    {!loaded&&<div className="note">✦ <p>正在加载作品…</p></div>}
    {loaded&&items.length===0&&<div className="note">✦ <p>{error||'暂无公开作品，学生可在作品页开启公开后展示。'}</p></div>}
    {loaded&&items.length>0&&visible.length===0&&<div className="note">✦ <p>{keyword?'没有搜到匹配的作品。换个标题或学生名字试试，或者':'这个分类下暂时没有作品。点'} <b>{keyword?'清空搜索词':'取消分类'}</b> 看看全部。</p></div>}
    {viewing?<WorkViewer work={viewing} onClose={()=>setViewing(null)}/>:null}
  </main>;
}
// ── 机构手册 / 常见问题（由后台 CMS 维护）────────────────────────────────────
// 用户口径：「灵动介绍、机构手册、常见问题尽量做成后台可配置的」，机构手册的图与文字
// 「基本都是平台后台可以配置的」。所以这些页面**不硬编码文案**：读 CMS 对应键（HANDBOOK / FAQ），
// 前端只留一份精简兜底（见 CMS_FALLBACK）。后台在「官网内容」里按区块编辑 + 传图，官网立即生效。
// ⚠️ 兜底与 packages/database/src/websiteContentDefaults.js 必须**逐字一致**（口径①）。
// 两个键的字段形状（后台表单与公开端渲染共用，改动要同步 apps/admin/src/pages/WebsiteContent.jsx）：
//   HANDBOOK { hero{line1,line2,loaderWord,imageUrl,imageAlt}, about{index,headingLines[],body,imageUrl,imageAlt},
//              poster{eyebrow,title,caption,imageUrl,imageAlt}, work{introLines[],cards[{title,desc,imageUrl,imageAlt}]},
//              compare{eyebrow,headingLines[],body}, cta{headline,text,buttonLabel,buttonTo} }
//   FAQ      { audienceOrder[], student[], teacher[], org[] }（每档是 [{question,answer}]）
// ⚠️ 2026-09-19 用户口径：**灵动介绍（INTRO）整页删除** —— 页面 / 导航 / 页脚入口 / 路由 / CMS 键一起撤，
//    旧内容留底在 docs/operations/灵动介绍-旧内容留底-20260919.md。
const cmsList = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
// ── 机构手册 /handbook（2026-09-19 按用户给的设计稿 design (1).zip 重做）────────────────
// 设计稿是 Tailwind + GSAP + Lenis + 热链远程图片的静态页。这里按本项目一贯的做法**移植**，不照抄依赖：
//   ① **不引 GSAP / Lenis / Tailwind**：官网是纯 CSS 一套；而且生产 CSP 是 `script-src 'self'`，
//      设计稿里那几个 `<script src>`（gsap / ScrollTrigger / lenis）在我们站上**一个都加载不了**。
//      入场、视差、横向滚动钉住、粒子、自定义光标全部用原生 CSS + rAF 复刻。
//   ② **图片自托管**：设计稿热链 `a.lovart.ai`（那域名本机与服务器都连不通，口径也不许热链），
//      7 张配图压成 webp 放进 `public/assets/handbook/`（合计 ~750KB），海报同理。
//   ③ **文案与图片全部读 CMS**（沿用「机构手册的图与文字都能后台配」那条口径）。
//      逐字段与兜底合并，所以**改版期间库里还是老内容时页面也不会变空**。
// ⚠️ 浏览器 API 只出现在 `useEffect` 里，且每处都 `typeof … !== 'undefined'` 兜底 ——
//    p70 的 DOM 桩里没有 `IntersectionObserver` / `ResizeObserver` / canvas，
//    在渲染期碰它们会让渲染守卫直接报未定义（首页那段注释记过这个坑）。
/** 系统要求减少动效时，入场/视差/横向钉住/粒子全部不启用（内容照常可读，不是"藏起来"）。 */
const hbReducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/**
 * 多行标题：新形状是**字符串数组**（`headingLines` / `introLines` —— 后台每行一个输入框，
 * 运营不用在一个框里敲换行）。这里同时兼容"带换行的字符串"那种老写法（改版期间库里可能还是老内容）。
 * 每行在 CSS 里是一个块级 span，所以**不用写 `<br/>`**。
 */
const hbLines = (value) => (Array.isArray(value) ? value : String(value || '').split('\n')).map((line) => String(line).trim()).filter(Boolean);
function Handbook() {
  const cms = useWebsiteContent('HANDBOOK');
  const stored = cms.data || {};
  const fallback = CMS_FALLBACK.HANDBOOK;
  const hero = { ...fallback.hero, ...(stored.hero || {}) };
  const about = { ...fallback.about, ...(stored.about || {}) };
  const poster = { ...fallback.poster, ...(stored.poster || {}) };
  const work = { ...fallback.work, ...(stored.work || {}) };
  const compare = { ...fallback.compare, ...(stored.compare || {}) };
  const cta = { ...fallback.cta, ...(stored.cta || {}) };
  const cards = cmsList(stored.work?.cards).length ? cmsList(stored.work.cards) : cmsList(fallback.work.cards);
  const workLines = hbLines(work.introLines);
  const compareLines = hbLines(compare.headingLines);

  const sectionRef = useRef(null);
  const trackRef = useRef(null);
  const canvasRef = useRef(null);
  // ① 横向滚动钉住（设计稿用 ScrollTrigger pin + scrub 做的）。
  //    这里等价实现：section 的高度 = 一屏 + 轨道多出来的宽度，里面那层 sticky 钉住一屏，
  //    滚动进度 → translateX。窗口变化时重量一次；窄屏（<901px）完全交给 CSS 的竖排，不设高度。
  useEffect(() => {
    const section = sectionRef.current; const track = trackRef.current;
    if (!section || !track || hbReducedMotion()) return undefined;
    const isDesktop = () => typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 901px)').matches : true;
    let frame = 0;
    const measure = () => {
      if (!isDesktop()) { section.style.height = ''; track.style.transform = ''; return; }
      const distance = Math.max(0, track.scrollWidth - window.innerWidth);
      section.style.height = `${window.innerHeight + distance}px`;
    };
    const paint = () => {
      frame = 0;
      if (!isDesktop()) return;
      const budget = Math.max(1, section.offsetHeight - window.innerHeight);
      const progress = Math.min(1, Math.max(0, -section.getBoundingClientRect().top / budget));
      const distance = Math.max(0, track.scrollWidth - window.innerWidth);
      track.style.transform = `translate3d(${-progress * distance}px, 0, 0)`;
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(paint); };
    const onResize = () => { measure(); paint(); };
    measure(); paint();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onResize); if (frame) window.cancelAnimationFrame(frame); };
  }, [cards.length]);
  // ② 入场：设计稿靠 GSAP 从下方推上来。这里用 IntersectionObserver 加个类，CSS 负责动画；
  //    没有这个 API（或要求减少动效）时**直接给上类**，内容永远可见 —— 动画只是锦上添花。
  useEffect(() => {
    const nodes = document.querySelectorAll ? [...document.querySelectorAll('.hb-reveal')] : [];
    if (!nodes.length) return undefined;
    if (hbReducedMotion() || typeof IntersectionObserver !== 'function') { nodes.forEach((node) => node.classList.add('is-in')); return undefined; }
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add('is-in'); observer.unobserve(entry.target); } }), { rootMargin: '0px 0px -12% 0px' });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);
  // ③ 对比区的粒子（设计稿的 #particle-canvas）：纯装饰，画不出来也不影响任何信息。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.getContext !== 'function' || hbReducedMotion()) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    const section = canvas.parentElement;
    const pointer = { x: 0, y: 0, active: false };
    let particles = []; let width = 1; let height = 1; let frame = 0; let visible = true;
    const build = () => {
      const rect = section.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(170, Math.round(width * height / 9000));
      particles = Array.from({ length: count }, () => ({ baseX: Math.random() * width, baseY: Math.random() * height, x: Math.random() * width, y: Math.random() * height, radius: .5 + Math.random() * 1.7, density: 8 + Math.random() * 22 }));
    };
    const draw = () => {
      if (visible) {
        context.clearRect(0, 0, width, height);
        context.fillStyle = 'rgba(188, 164, 108, .72)';
        for (const particle of particles) {
          if (pointer.active) {
            const dx = pointer.x - particle.x; const dy = pointer.y - particle.y;
            const squared = dx * dx + dy * dy;
            if (squared > .0001 && squared < 48400) {
              const distance = Math.sqrt(squared); const force = (220 - distance) / 220;
              particle.x -= (dx / distance) * force * particle.density;
              particle.y -= (dy / distance) * force * particle.density;
            }
          }
          particle.x += (particle.baseX - particle.x) * .035;
          particle.y += (particle.baseY - particle.y) * .035;
          if (!Number.isFinite(particle.x) || !Number.isFinite(particle.y)) { particle.x = particle.baseX; particle.y = particle.baseY; }
          context.beginPath(); context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2); context.fill();
        }
      }
      frame = window.requestAnimationFrame(draw);
    };
    const onPointerMove = (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left; pointer.y = event.clientY - rect.top;
      pointer.active = Number.isFinite(pointer.x) && Number.isFinite(pointer.y);
    };
    const onPointerLeave = () => { pointer.active = false; };
    section.addEventListener('pointermove', onPointerMove);
    section.addEventListener('pointerleave', onPointerLeave);
    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') { resizeObserver = new ResizeObserver(() => { build(); }); resizeObserver.observe(section); }
    if (typeof IntersectionObserver === 'function') new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(section);
    build(); draw();
    return () => {
      section.removeEventListener('pointermove', onPointerMove);
      section.removeEventListener('pointerleave', onPointerLeave);
      resizeObserver?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, []);
  // ④ 预加载幕布：**幕布本身由 CSS 动画自动收起**（animation-fill-mode forwards → 最终
  //    visibility:hidden + pointer-events:none），所以就算 JS 没跑起来也不会把页面盖住；
  //    JS 只负责把那个计数器从 00 数到 100。
  useEffect(() => {
    const counter = document.getElementById('hb-count');
    if (!counter || hbReducedMotion()) return undefined;
    const started = performance.now(); const total = 1100;
    let frame = 0;
    const step = (now) => {
      const ratio = Math.min(1, (now - started) / total);
      counter.textContent = String(Math.round(ratio * 100)).padStart(2, '0');
      if (ratio < 1) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return <main className="hb">
    {/* 幕布（纯装饰）：CSS 自动收起，见上面的说明 */}
    <div className="hb-preloader" aria-hidden="true"><span className="hb-preloader__rule" /><p>{hero.loaderWord}</p><span className="hb-preloader__count" id="hb-count">00</span></div>
    <section className="hb-hero" id="hb-hero">
      <div className="hb-hero__media"><img src={hero.imageUrl} alt={hero.imageAlt || ''} fetchPriority="high" /></div>
      {/* 背景特效三层（纯 CSS，见 styles.css 的 .hb-hero）：遮罩 / 网格 / 缓慢扫过的一道光 */}
      <div className="hb-hero__grid" aria-hidden="true" />
      <div className="hb-hero__veil" aria-hidden="true" />
      <div className="hb-hero__sheen" aria-hidden="true" />
      <div className="hb-hero__copy">
        <h1>
          {/* 逐字升起（2026-09-19 用户口径：「文字应该有点动效」）：
              每个字一个 span、靠 inline 的 animation-delay 错开，比整行一起动更像"字一个个落下来"。
              空格换成不换行空格，否则行内块里的空格会被吃掉。 */}
          {[hero.line1, hero.line2].filter(Boolean).map((line, lineIndex) => <span className="hb-mask" key={lineIndex}><span className="hb-line">
            {[...String(line)].map((char, charIndex) => <span className="hb-char" key={charIndex} style={{ animationDelay: `${.18 + lineIndex * .16 + charIndex * .035}s` }}>{char === ' ' ? '\u00A0' : char}</span>)}
          </span></span>)}
        </h1>
      </div>
    </section>

    <section className="hb-about">
      <div className="hb-about__media hb-reveal"><img src={about.imageUrl} alt={about.imageAlt || ''} loading="lazy" />{about.index ? <span className="hb-index">{about.index}</span> : null}</div>
      <div className="hb-about__copy">
        <h2 className="hb-reveal">{hbLines(about.headingLines).map((line, index) => <span key={index}>{line}</span>)}</h2>
        <p className="hb-reveal">{about.body}</p>
      </div>
    </section>

    {/* 海报（用户 2026-09-19 让「找个合适的放」）：它是**信息图**，密密麻麻全是字，
        所以在纸色底上**整张显示**（object-fit: contain），不裁不灰 —— 放进上面那个
        会裁切的满幅槽位会把字切没。点开可看原图大小。 */}
    {poster.imageUrl ? <section className="hb-poster hb-reveal">
      <div className="hb-poster__head">{poster.eyebrow ? <span className="hb-eyebrow">{poster.eyebrow}</span> : null}<h2>{poster.title}</h2></div>
      {/* 海报：2026-09-19 用户口径「这个图不需要放大」——不再可点开，也不再挂「点开看大图」的链接。
          整张显示、不加滤镜（那张是带字的信息图）。 */}
      <div className="hb-poster__frame"><img src={poster.imageUrl} alt={poster.imageAlt || poster.title || ''} loading="lazy" /></div>
      {poster.caption ? <p className="hb-poster__cap">{poster.caption}</p> : null}
    </section> : null}

    <section className="hb-work" id="hb-work" ref={sectionRef}>
      <div className="hb-work__pin">
        <div className="hb-work__track" ref={trackRef}>
          <article className="hb-intro">
            <h2>{workLines.map((line, index) => <span className={index === 1 ? 'hb-outline' : ''} key={index}>{line}</span>)}</h2>
            <span className="hb-intro__rule" />
          </article>
          {cards.map((card, index) => <article className="hb-card hb-interactive" key={index + '-' + (card.title || '')}>
            <img src={card.imageUrl} alt={card.imageAlt || card.title || ''} loading="lazy" />
            <div className="hb-card__meta">
              <span>{String(index + 1).padStart(2, '0')}</span>
              <h3>{card.title}</h3>
              <p>{card.desc}</p>
            </div>
          </article>)}
        </div>
      </div>
    </section>

    <section className="hb-compare">
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="hb-compare__copy hb-reveal">
        {compare.eyebrow ? <p className="hb-eyebrow">{compare.eyebrow}</p> : null}
        <h2>{compareLines.map((line, index) => <span className={index === 1 ? 'hb-outline' : ''} key={index}>{line}</span>)}</h2>
        <p>{compare.body}</p>
      </div>
    </section>

    <section className="hb-cta hb-reveal">
      <h2>{cta.headline}</h2>
      <p>{cta.text}</p>
      {/* 按钮去常见问题页（2026-09-19 用户口径：「改成：点击进入常见问题，跳转到常见问题页面」）。
          文案与去向都从 CMS 读（`cta.buttonLabel` / `cta.buttonTo`），运营想换回「联系我们」不用发版。 */}
      <Button to={cta.buttonTo || '/faq'}>{cta.buttonLabel || '点击进入常见问题'}</Button>
    </section>
  </main>;
}
// 常见问题 /faq：黑底 + 卡片式手风琴，**按端分三档**（2026-09-18 晚用户口径）。
// ⚠️ 参考稿是 Tailwind + framer-motion 写的，这里**不引入这两个依赖**：官网是纯 CSS 的一套
//    （依赖里只有 ogl，没有 Tailwind），为一张页面把它引进来会与全局 styles.css 打架；
//    展开动画改用 CSS 的 grid-template-rows 0fr→1fr 复现，时长与缓动跟参考稿一致（见 .fq-panel）。
// ⚠️ 主色用站内那支粉（同 .mp 的 --mp-accent），**不引入参考稿里的紫 #A855F7** —— 官网已经统一过
//    一套主色，再放第二支会看着不像同一个站（/marketplace 那条口径的延续）。
// ⚠️ 页头只剩「常见问题」一行。参考稿那个眉题「帮助中心」、标题下那句说明、以及列表下那行
//    「没有找到答案？联系我们」都是用户看过实际页面后要求删掉的（2026-09-18 晚）—— 别再加回来。
//    顺带：这一页现在**没有任何 CMS 文案**在接口回来前需要门控（标题与档位名都是常量），
//    所以不再有「强刷先闪一帧与后台不符的字」的问题（那是 mp / 首页才需要的 ready 门控）。
// 档位：字段名就是 CMS 里的 key，**名字**写在这里（不由 CMS 改）；**顺序**改由 CMS 的
// `audienceOrder` 决定（2026-09-19 用户口径：「这 3 个标签可以在后台排序优先级，优先级高的排在最前面」），
// FAQ_AUDIENCES 只作为「后台没配时的默认顺序」。
const FAQ_AUDIENCES = [['student', '学生端'], ['teacher', '老师端'], ['org', '机构端']];
const FAQ_LABELS = Object.fromEntries(FAQ_AUDIENCES);
const FAQ_DEFAULT_ORDER = FAQ_AUDIENCES.map(([key]) => key);
function Faq() {
  const cms = useWebsiteContent('FAQ');
  const content = cms.data || {};
  const [audience, setAudience] = useState('student');
  // 初始态照参考稿：**一条都不展开**；切换档位时也收起 —— 否则会把这一档的第 N 条
  // 当成那一档的第 N 条继续展开（两档的问题条数本来就不一样）。
  const [openIndex, setOpenIndex] = useState(null);
  // ⚠️ 存量库兼容：生产库里 FAQ 过去是老的 { title, items } 形状。这一行是「代码先上、迁移后跑」
  //    那个窗口的兜底（老形状读不出 student）—— 迁移脚本早就跑完了，保留着以防还有老库。
  const legacyItems = cmsList(content.items);
  const itemsOf = (key) => { const own = cmsList(content[key]); return own.length ? own : (key === 'student' ? legacyItems : own); };
  // 顺序：先按 CMS 的 audienceOrder（认不出的 key 丢掉），没排到的按默认顺序补在后面。
  const configuredOrder = cmsList(content.audienceOrder).filter((key) => FAQ_LABELS[key]);
  const orderedKeys = [...configuredOrder, ...FAQ_DEFAULT_ORDER.filter((key) => !configuredOrder.includes(key))];
  // ⭐ 只显示**有内容**的档位（2026-09-19 用户口径：「如果没有内容就隐藏，有内容才出现」）：
  //    后台把某一档的问题全删了，官网就不该再出现那个空档位 —— 否则点进去是一片空白，
  //    访客还以为页面坏了。空 = 运营故意清空（口径③），所以这里**不回退**任何兜底内容。
  const visible = orderedKeys.filter((key) => itemsOf(key).length).map((key) => [key, FAQ_LABELS[key]]);
  // 选中的那一档可能已经被清空/被隐藏了：这时落到第一个还有内容的档位，而不是死守一个空档位。
  const active = visible.some(([key]) => key === audience) ? audience : (visible[0]?.[0] ?? null);
  const items = active ? itemsOf(active) : [];
  const pickAudience = (key) => { setAudience(key); setOpenIndex(null); };
  // 键盘左右要在**看得见**的档位之间走，不能按完整清单走（否则焦点会跳到不存在的 tab 上）
  const stepAudience = (direction) => {
    const index = visible.findIndex(([key]) => key === active);
    const next = (index + direction + visible.length) % visible.length;
    pickAudience(visible[next][0]);
    document.getElementById('fq-tab-' + visible[next][0])?.focus();
  };
  return <main className="fq">
    <div className="fq-aura" aria-hidden="true" />
    <div className="fq-inner">
      <header className="fq-head"><h1 className="fq-title">常见问题</h1></header>
      {/* 档位切换。用真 tablist：点击、键盘左右、读屏都能用（不用参考稿那种纯 div 点击）。
          ⚠️ 渲染的是 visible 而不是 FAQ_AUDIENCES —— 空档位在这一步就已经被剔掉了。
          一档都不剩时整条 tablist 不渲染（页面上只剩标题）。 */}
      {visible.length ? <div className="fq-tabs" role="tablist" aria-label="按角色查看常见问题">
        {visible.map(([key, label]) => <button key={key} type="button" role="tab" id={'fq-tab-' + key} aria-selected={active === key} aria-controls={'fq-panel-' + active} className={'fq-tab' + (active === key ? ' on' : '')} onClick={() => pickAudience(key)} onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); stepAudience(1); } else if (event.key === 'ArrowLeft') { event.preventDefault(); stepAudience(-1); } }}>{label}</button>)}
      </div> : null}
      {/* key={active} 让切档时整列重挂载，CSS 入场动画随之重放（纯 keyframes，不用 IntersectionObserver） */}
      {active ? <div className="fq-list" key={active} role="tabpanel" id={'fq-panel-' + active} aria-labelledby={'fq-tab-' + active}>
        {items.map((item, index) => {
          const isOpen = openIndex === index;
          return <article className={'fq-card' + (isOpen ? ' on' : '')} key={item.question || index}>
            <span className="fq-bar" aria-hidden="true" />
            {/* 参考稿是 div + onClick；这里用真按钮：点整行照样展开，但键盘和读屏也能用。
                ⚠️ 问题文字与图标都用带类名的 span，**不要用 em** —— styles.css 里 `h2 em`
                是全局规则（会把 h2 里的 em 染成紫色），而它们正在 h2 里。 */}
            <h2 className="fq-q">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpenIndex(isOpen ? null : index)}>
                <span className="fq-qtext">{item.question || ''}</span>
                <span className="fq-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg></span>
              </button>
            </h2>
            <div className="fq-panel"><div className="fq-answer"><p>{item.answer || ''}</p></div></div>
          </article>;
        })}
      </div> : null}
    </div>
  </main>;
}
// 下载创作客户端（/download，2026-09-19）。
// 安装包放在**发布目录之外**（服务器 /srv/ai-kids-platform/downloads/，nginx 的 /downloads/），
// 所以每次发布换代都不会把它冲掉；这里读同目录的 manifest.json 拿到当前版本/体积/校验值，
// 而不是把文件名写死在这份代码里（否则每次出包都得改官网并重发）。
function Download() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/downloads/manifest.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data) => { if (live) setManifest(data); })
      .catch((reason) => { if (live) setError(reason.message || '读取失败'); });
    return () => { live = false; };
  }, []);
  const windows = manifest?.files?.['win-x64'] || null;
  const mac = manifest?.files?.['mac-arm64'] || null;
  const mb = (bytes) => (bytes ? (bytes / 1048576).toFixed(0) + ' MB' : '');
  return <><Title eyebrow="创作客户端" title={<>把课堂装进<br/><em>学生的电脑</em></>} desc="VibeCoding 课堂用客户端上：老师开始上课后，学生用账号登录即可进入自己的创作环境。" /><main className="inner">
    <section className="dl">
      <article className="dl-card">
        <i>🪟</i>
        <h3>Windows 版</h3>
        {windows
          ? <><p>版本 {manifest.version} · {mb(windows.size)}</p><a className="button" href={'/downloads/' + windows.name}>下载安装包</a>
            <small>下载后双击安装；首次打开若提示「未知发布者」，选择「仍要运行」即可（我们正在办理代码签名证书）。</small></>
          : <><p>{error ? '安装包暂时取不到（' + error + '）' : '正在读取安装包信息…'}</p><small>稍后再试，或联系我们获取安装包。</small></>}
      </article>
      <article className="dl-card">
        <i>🍎</i>
        <h3>Mac 版（Apple 芯片）</h3>
        {mac ? <><p>版本 {manifest.version} · {mb(mac.size)}</p><a className="button" href={'/downloads/' + mac.name}>下载安装包</a></> : <><p>正在准备中</p><small>需要 macOS 12 以上、Apple 芯片（M 系列）。做好会在这一页放出。</small></>}
      </article>
    </section>
    <section className="dl-steps">
      <h2>装上以后怎么用</h2>
      <ol>
        <li><b>用学生账号登录</b> —— 和网页端同一个账号。</li>
        <li><b>等老师开始上课</b> —— 老师没点「立即上课」时，客户端只会显示你的课程。</li>
        <li><b>进入课堂</b> —— 课堂开始后点进入，就在客户端里和 AI 一起做作品。</li>
        <li><b>交作品</b> —— 做好的网页 / 文档直接提交，老师和你都能在「我的作品」里看到。</li>
      </ol>
      <p className="dl-note">还没有学生账号？<Link to="/demo">联系我们</Link>，我们会按你的班型开通。</p>
      {/* 深链：装了客户端的人点一下就能把它叫起来（没装则什么都不会发生，所以下面说明这一点）。
          客户端侧注册 lingdong:// 见 deploy/desktop/（electron-builder 的 protocols + setAsDefaultProtocolClient）。 */}
      <p className="dl-note">已经装好了？<a href="lingdong://open">打开客户端</a>（点了没反应，说明这台电脑还没装）。</p>
    </section>
  </main></>;
}
function Compare(){const rows=[['工具形态','多个网站 / App 来回切换','同一个工作台里完成：对话 + 预览 + 项目文件'],['课程交付','机构自建教案，平台不管课','课程中心标准课包，课时与课件一体'],['账号与安全','学生自备账号 / API Key，易泄露','机构账号分级，学员无需自备 Key'],['成本控制','个人账号各买各的，月底才知道超支','机构授权次数按班分配，用量有记录和提醒'],['成果沉淀','作业散落在群聊和个人电脑','作品展厅聚合展示，形成校区案例库'],['硬件实践','外部工具和环境另行配置','Arduino / micro:bit 软硬一体课程']];return <><Title eyebrow="选型对比" title={<>为什么不是<br/><em>再找个对话平台</em>？</>} desc="机构评估 AI 课程时，真正要比较的不是一个聊天框，而是一套能不能长期交付的课堂产品。"/><main className="inner"><section className="compare"><div className="compare-head"><span>对比维度</span><span>分散拼凑</span><b>{BRAND_NAME}</b></div>{rows.map(r=><div key={r[0]}><strong>{r[0]}</strong><span>{r[1]}</span><b>✓ {r[2]}</b></div>)}</section><section className="compare-end"><div><small>一句话总结</small><h2>把「创作、课程、账号、计费、作品」<em>统一起来</em>。</h2></div><Button>联系我们</Button></section></main></>}
// 官网公开端的内容兜底：公开接口不可用、或后台还没发布过该区块时，官网仍要有东西可看。
// 键必须与后台「官网内容」的白名单一致（apps/admin/src/shared.jsx 的 WEBSITE_CONTENT_LABELS）。
// ⚠️ 这里只放**精简可用**的文案；对外那份丰富内容存在数据库（website_contents）里，由后台维护，
// 所以「改内容」应该去后台改，而不是改这个 fallback（改了也只影响接口挂掉时的显示）。
const CMS_FALLBACK = {
  // CMS 兜底（**要与线上 CMS 里那份保持一致**）：公开接口挂掉时官网照常可用。
  // ⚠️ 2026-09-18 教训：这里原来还留着更早的营销文案（「给机构一套 / 能落地的青少年 AI 课」
  // 与「响应教育部…领航行动」）。用户在 CMS 里改过首页之后，**接口没回来之前官网会先渲染这一份**，
  // 于是每次强刷都会闪一下旧内容（他报的「强制刷新出现的残留，还带有之前的旧版内容」就是这个）。
  // 两处一起治：①这份兜底对齐成 CMS 当前的内容；②渲染前确认接口已回来（见下面的 ready）。
  // ⚠️ stats 必须与 HOME_STATS_FALLBACK 是**同一个常量**：以前这里另写了一份 3 门 / 48 节，
  // 而别处是 11 门 / 87 节 —— 于是同一页会因为「接口通 / 断」显示两套数字
  // （接口断 → 用这份；接口通但行里没有 stats → 用 HOME_STATS_FALLBACK）。
  // scripts/p115-website-ui-check.mjs 会把两条路径各渲染一遍并逐字对比，就是为了钉住这条。
  HOME: { heroKicker: '', heroTitle: '培养青少年Ai思维', heroAccent: '掌握Ai时代的创造方式', heroDescription: 'AI 画布创作 + Vibe Coding 对话编程，从兴趣到独立创作', trustTitle: '', trustDescription: '', stats: HOME_STATS_FALLBACK },
  // 常见问题（/faq）：按端三档，与 packages/database/src/websiteContentDefaults.js 的 FAQ **逐字一致**
  // （口径①：接口通/断不能显示两套内容）。student 取的是**生产 CMS 已发布的原文** ——
  // 原来这里只有 3 条、且少了「授权次数用完会怎样」，与线上那份对不上，正是那条口径要防的隐患。
  FAQ: {
    audienceOrder: ['student', 'teacher', 'org'],
    student: [{ question: '需要学员自备 API Key 或对话平台账号吗？', answer: '不需要。机构账号登录即可使用平台统一模型能力。' }, { question: '机房和教室的电脑都能用吗？', answer: '可以，公开客户端支持 macOS Apple 芯片版与 Windows 64 位。' }, { question: '能否做 Arduino 和 micro:bit 硬件课？', answer: '支持 Arduino Uno 与 micro:bit 的课堂实践。' }, { question: '机构的授权次数用完了会怎样？', answer: '机构端会提示老师补足授权次数，补足后学生即可继续上课；平台不会因为算力用量去拦学生。' }],
    teacher: [{ question: '上课前需要做什么准备？', answer: '学生用机构账号登录，浏览器打开课堂即可开始；机房电脑不需要额外安装环境。' }, { question: '学生的作品和用量在哪里看？', answer: '机构后台可以查看学生的用量记录与作品，并把优秀作品发布到作品展厅。' }],
    org: [{ question: '学生需要自己买账号或自备 API Key 吗？', answer: '不需要。机构账号分级，学员无需自备 Key，由机构统一开通与管理。' }, { question: '平台提供哪些课程？', answer: '课程中心提供标准课包（含 PPT 与 HTML 互动课件），机构可按课包直接排课。' }],
  },
  HANDBOOK: {"hero":{"line1":"让AI创作课、编程课","line2":"真正进课堂","loaderWord":"让Ai真正进入课堂","imageUrl":"/assets/handbook/hero.webp","imageAlt":"暗色科技氛围中的创作路径主视觉"},"about":{"index":"01 / 关于","headingLines":["从试点走向普及，","机构需要的不只是工具"],"body":"国家和教育部门连续推动中小学人工智能教育，课程要能开齐开足，生成式AI要可用、可管。机构真正需要的是：能进课表、能管住账号与用量、每节课都有作品的完整方案。","imageUrl":"/assets/handbook/about.webp","imageAlt":"AI 创意思维与数据面板"},"poster":{"eyebrow":"一页看懂","title":"为什么现在就是开 AI 课的好时机","caption":"政策、家长认知、市场供给与窗口期判断 —— 一页看完。","imageUrl":"/assets/handbook/poster.webp","imageAlt":"AI 时代的孩子从这里起步：政策层面 / 家长认知 / 市场供给 / 窗口期判断"},"work":{"introLines":["开课管课","沉作品","一体化交付"],"cards":[{"title":"中文对话创作","desc":"学生与 AI 伙伴「阿飞」对话，做出可运行的作品","imageUrl":"/assets/handbook/card-1.webp","imageAlt":"学生在 AI 辅助下创作"},{"title":"课堂即开即用","desc":"标准课包与互动课件直接进课堂","imageUrl":"/assets/handbook/card-2.webp","imageAlt":"课件与课堂流程"},{"title":"账号用量可控","desc":"分级账号、授权次数、用量记录","imageUrl":"/assets/handbook/card-3.webp","imageAlt":"统一平台下的多端能力"},{"title":"作品进展厅","desc":"校区案例库与招生素材自动沉淀","imageUrl":"/assets/handbook/card-4.webp","imageAlt":"作品与案例展台"},{"title":"体验课转正班","desc":"90 分钟出作品，家长当场看得见","imageUrl":"/assets/handbook/card-5.webp","imageAlt":"一步一步的成长路径"}]},"compare":{"eyebrow":"对比","headingLines":["别再","东拼西凑"],"body":"对话用一家、写代码换一个编译器、课件散在网盘和群聊里——老师每换一门课就要重新教学生用哪个网站。灵动AI课堂把对话创作、代码运行、课件管理、作品沉淀整合在同一平台。"},"cta":{"headline":"把 AI 课开起来","text":"联系我们，我们会按你的班型给出课包与开通方案。","buttonLabel":"点击进入常见问题","buttonTo":"/faq"}},
  // 灵动课程（/marketplace）的页头：大标题 + 副标题。用户在后台「官网内容 → 灵动课程」可改
  // （用户口径 2026-09-18 晚：这两句要能后台配置）。
  MARKETPLACE: { title: '灵动Ai学院课包展示', lead: '灵动Ai坚持自研国内精品Ai课程，持续探索适合青少年Ai培训体系。' },
};
function useWebsiteContent(key) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  // 接口返回的是 { key, content, version, status } 包装体，这里统一解包成 content，
  // 调用方直接用字段（此前的写法把包装体当内容用，导致 CMS 内容一直没生效）。
  useEffect(() => { let live = true; publicApi.get('public/website-content/' + encodeURIComponent(key)).then((payload) => { if (live) setState({ loading: false, data: payload?.content ?? payload ?? null, error: null }); }).catch((error) => { if (live) setState({ loading: false, data: CMS_FALLBACK[key] || null, error }); }); return () => { live = false; }; }, [key]);
  return { ...state, data: state.data || CMS_FALLBACK[key] || null };
}

function LegalPage({ type }){
  const document = LEGAL_DOCUMENTS[type] || LEGAL_DOCUMENTS.privacy;
  return <><Title eyebrow="协议与隐私" title={<>{document.title}</>} desc={document.intro}/><main className="inner legal-page"><div className="legal-meta"><span className="status-pill">{LEGAL_STATUS}</span><span>版本 {LEGAL_VERSION}</span><span>生效日期 {LEGAL_EFFECTIVE_DATE}</span><span>主体：{LEGAL_OWNER}</span></div><div className="legal-notice">本页面是上线准备稿。正式对外服务前，运营主体、备案信息和法务审核结果应由业务方确认并替换；如与正式发布版本不一致，以正式发布版本为准。</div>{document.sections.map(([heading,body])=><section className="legal-section" key={heading}><h2>{heading}</h2><p>{body}</p></section>)}<div className="legal-links"><b>相关入口</b><Link to="/terms">用户协议</Link><Link to="/privacy">隐私政策</Link><Link to="/minors">儿童 / 未成年人说明</Link><Link to="/demo">联系我们</Link></div></main></>;
}

function Demo(){
  const [state,setState]=useState('idle');
  const [error,setError]=useState('');
  const [legalConsent,setLegalConsent]=useState(false);
  async function submit(e){
    e.preventDefault();
    const form=e.currentTarget;
    const orgName=form.orgName.value.trim();
    const contactName=form.contactName.value.trim();
    const contactPhone=form.contactPhone.value.trim();
    if(!orgName||!contactName||!contactPhone){setError('请填写完整信息');return;}
    if(!legalConsent){setError('请先阅读并同意用户协议、隐私政策和未成年人说明');return;}
    if(!/^1[3-9]\d{9}$/.test(contactPhone)){setError('请输入正确的手机号');return;}
    setState('loading');setError('');
    try{
      await publicApi.post('public/contact',{orgName,contactName,contactPhone,intent:form.intent.value,notes:form.notes.value,legalConsentVersion:LEGAL_VERSION,legalConsentAt:new Date().toISOString()});
      setState('success');
    }catch(err){setError(err.message);setState('error');}
  }
  if(state==='success') return <><Title eyebrow="联系我们 · 开通试用" title={<>已提交！</>} desc="我们会在 1 个工作日内联系你。"/><main className="inner"><section className="demo"><div className="success"><i>✦</i><h2>已收到你的信息！</h2><p>我们会在 1 个工作日内联系你，发送演示安排与资料。</p></div></section></main></>;
  return <><Title eyebrow="联系我们 · 开通试用" title={<>把 AI 课开起来</>} desc="欢迎教培机构、学校与区域合作伙伴联系，获取演示账号与课包清单。"/><main className="inner"><section className="demo"><div><h2>联系我们后，你将获得</h2>{['产品演示与开课流程讲解','11 门标准课包与课件清单','体验课包与演示账号'].map((x,i)=><p key={x}><b>0{i+1}</b>{x}</p>)}</div><form onSubmit={submit}><label>机构 / 学校名称<input name="orgName" required placeholder="请输入机构名称"/></label><label>联系人<input name="contactName" required placeholder="请输入姓名"/></label><label>联系电话<input name="contactPhone" required placeholder="请输入手机号" maxLength={20}/></label><label>你想了解什么？<select name="intent" defaultValue=""><option value="" disabled>请选择合作方向</option><option>少儿编程 / AI 素养课程</option><option>学校拓展课 / 社团</option><option>寒暑假科创营</option><option>区域合作</option></select></label><label>补充说明<textarea name="notes" placeholder="例如：校区数量、预计班级规模……"/></label><label className="check-row legal-consent"><input type="checkbox" checked={legalConsent} onChange={e=>setLegalConsent(e.target.checked)}/><span>我已阅读并同意 <Link to="/terms" target="_blank">用户协议</Link>、<Link to="/privacy" target="_blank">隐私政策</Link>和<Link to="/minors" target="_blank">儿童 / 未成年人说明</Link></span></label>{error&&<small style={{color:'#e74c3c'}}>{error}</small>}<button className="button" disabled={state==='loading'}>{state==='loading'?'提交中…':'提交信息 ↗'}</button><small>提交即表示同意我们用于联系你的信息。</small></form></section></main></>;
}

// ---- Marketplace ----
function DifficultyStars({level}){
  if(!level) return null;
  return <span className="diff-stars">{Array.from({length:5},(_,i)=><b key={i} style={{color:i<level?'#ffb800':'#e0d9f0',fontSize:'13px'}}>★</b>)}</span>;
}
// ⚠️ 2026-09-20：这里原来有个 `ageLabel()`，唯一调用点是课包详情里那行「适学年龄」——
//    那行已按用户口径删除，没人调的函数一并删掉（留着会让下一个读代码的人以为它还活着）。
// 课包的「课堂形式」：一个课包**可以同时有**画布与 VibeCoding 两类课时（课时之间可不同），
// 所以显示哪几种以接口下发的 `deliveryModes`（已发布课时的并集）为准 —— 有几类显示几类
// （用户口径 2026-09-20：「课包里其中 1 个课程包含 2 类，这里就要显示 2 种课程形式」）。
// ⚠️ 别退回按 `item.deliveryMode` 单值判断：那是课包自己的字段，与课时会不一致
//    （线上有 series=CANVAS 而课时是 VIBECODING 的错配，会被显示成「画布课程」）。
const MKT_DELIVERY_LABEL = { CANVAS: '画布课程', VIBECODING: 'VibeCoding 课程' };
function deliveryModeText(item){
  const modes = (item?.deliveryModes?.length ? item.deliveryModes : [item?.deliveryMode]).filter((mode) => MKT_DELIVERY_LABEL[mode]);
  return modes.length ? modes.map((mode) => MKT_DELIVERY_LABEL[mode]).join('/') : '未设置';
}
function Marketplace(){
  const headCms = useWebsiteContent('MARKETPLACE');
  const content = headCms.data || {};
  const [items,setItems]=useState([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  // 2026-09-18 晚用户口径：**课程广场的筛选区整体删除**（参考稿首屏只有「页头 + 课包行」）。
  // 所以这里不再维护难度/年龄/标签/搜索/排序这些筛选态，只留分页。
  // ⚠️ 公开接口仍然支持这些查询参数（别的调用方在用），删掉的只是官网这一处的入口。
  const limit=20;
  const buildParams=()=>{
    const p=new URLSearchParams();
    p.set('sort','popular');
    p.set('page',page);
    p.set('limit',limit);
    return p;
  };
  useEffect(()=>{let live=true;setLoading(true);setError(null);
    publicApi.get('public/marketplace?'+buildParams())
      .then((j)=>{if(live){const d=j||{};setItems(d.items||[]);setTotal(d.total||0);setLoading(false);}})
      .catch(e=>{if(live){setError(e.message);setLoading(false);}});
    return()=>{live=false};
  },[page]);
  const totalPages=Math.ceil(total/limit)||1;
  // 页头（大标题 + 副标题）走 CMS 的 MARKETPLACE 键，后台「官网内容 → 灵动课程」可改；
  // 没配就用 CMS_FALLBACK.MARKETPLACE。与首页同一套口径：**接口回来前不渲染文案**（ready），
  // 否则强刷会先闪一帧与后台不符的字。
  const headReady = !headCms.loading;
  const headTitle = cmsPick(content, 'title', CMS_FALLBACK.MARKETPLACE.title);
  const headLead = cmsPick(content, 'lead', CMS_FALLBACK.MARKETPLACE.lead);
  return <main className="mp">
    <div className="mp-aura" aria-hidden="true" />
    <div className="mp-inner">
    <header className="mp-head">
      {headReady ? <><h1 className="mp-title">{headTitle}</h1>{headLead ? <p className="mp-lead">{headLead}</p> : null}</> : <div className="mp-head-hold" aria-hidden="true" />}
    </header>
    {/* ⚠️ 2026-09-18 晚更正：那两个「画布 / VibeCoding」分类按钮**不属于这一页** ——
        用户说的是「灵动作品」那一页（见 Works 里的 .works-cats）。这一页按之前的删改口径
        仍然**没有任何筛选**（参考稿首屏就是「页头 + 课包行」）。别再往这里加回来。 */}
    {loading?<div className="mp-rows">{Array.from({length:4},(_,i)=><div key={i} className="mp-skeleton"/>)}</div>:
     error?<div className="mp-note">⚠ <div><b>加载失败</b><p>{error}</p></div></div>:
     items.length===0?<div className="mp-note">✦ <div><b>暂无课包，敬请期待</b><p>灵动课程会陆续上线优质 AI 课包。</p></div></div>:
     <><div className="mp-rows">{items.map(item=>{
       // 缩略图两个来源：后台上传的封面资产（coverAssetId）优先，其次贴的外链地址。
       // ⚠️ 公开接口以前**两个都不下发**，所以这个位置一直是空的（只有首字占位块）。
       const cover=item.coverAssetId?('/api/public/file-assets/'+item.coverAssetId+'/download'):(item.coverImageUrl||'');
       // 课包目前没有折扣：只显示现价，不做划线原价（用户口径 2026-09-18）。
       // ⚠️ 2026-09-20：**价格整块不再显示**（用户口径：「官网灵动课程这里不要显示价格和按课包开通，删除即可」）
       //    —— 所以这里连 priceText 一起删掉，别再留一个算好了没人用的变量。
       // 那四个参数位（用户口径 2026-09-18 晚）：难度 / **版本号** / 课时 / 课堂形式。
       // ⚠️ 原来第二格是「适学年龄」，但线上 4 个课包全是「未设置」（课包编辑表单里能填、
       //    只是没人填），于是用户要求换成**版本号** —— 版本号在编辑表单里是有的。
       //    换的时候顺手补了列表接口的 version 字段（它以前没下发，不然这格又会是「未设置」）。
       const params=[['难度',item.difficultyLevel?item.difficultyLevel+' / 5':'未设置'],['版本',item.version||'未设置'],['课时',(item.lessonCount||0)+' 节'],['课堂形式',deliveryModeText(item)]];
       return <article className="mp-row" key={item.id}>
         <div className="mp-main">
           <div className={'mp-cover'+(cover?' has-image':'')} style={cover?{backgroundImage:'url('+cover+')'}:undefined}>{cover?null:<span>{item.title?.charAt(0)||'课'}</span>}</div>
           <div className="mp-info"><h2 className="mp-name">{item.title}</h2><p className="mp-desc">{item.description||'课包简介待补充。'}</p></div>
           {/* 价格整块已删（用户口径 2026-09-20：「不要显示价格和按课包开通」）：
               这一行现在只有右边那个按钮。 */}
           <div className="mp-side">
             {/* ⚠️ 按钮里**不要箭头**（用户口径 2026-09-18 晚：「我们还有个箭头也要去掉」） */}
             <Link className="mp-cta" to={'/marketplace/'+item.id}>查看课程列表</Link>
           </div>
         </div>
         <div className="mp-features"><div className="mp-feature-grid">{params.map(([label,value])=><div className="mp-feature" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></div>
       </article>;
     })}</div>
     {totalPages>1&&<div className="mkt-pages mp-pages"><button type="button" disabled={page<=1} aria-label="上一页" onClick={()=>setPage(p=>p-1)}>上一页</button><span>{page} / {totalPages}</span><button type="button" disabled={page>=totalPages} aria-label="下一页" onClick={()=>setPage(p=>p+1)}>下一页</button></div>}
     </>}
    </div>
  </main>;
}

function MarketplaceDetail(){
  const params=new URLSearchParams(window.location.search);
  const pathParts=window.location.pathname.split('/');
  const id=pathParts[pathParts.length-1];
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  // 2026-09-18 晚：这里原来有个 startLearning()，给详情页底部那个「开始学习」按钮用；
  // 按用户口径那个按钮整条删掉了（「图1 红框…开始学习和旁边的文字」），所以这个函数也一起删。
  useEffect(()=>{let live=true;
    publicApi.get('public/marketplace/'+id)
      .then((j)=>{if(live){setData(j||null);setLoading(false);}})
      .catch(e=>{if(live){setError(e.message);setLoading(false);}});
    return()=>{live=false};
  },[id]);
  if(loading) return <><Title eyebrow="课程详情" title={<>加载中…</>} desc=""/><main className="inner"><div className="mkt-grid">{Array.from({length:4},(_,i)=><div key={i} className="mkt-skeleton"/>)}</div></main></>;
  if(error) return <><Title eyebrow="课程详情" title={<>未找到</>} desc={error}/><main className="inner"><div className="note">⚠ <div><b>无法加载课程</b><p>{error}</p></div><Link to="/marketplace" className="button" style={{marginTop:'20px'}}>返回课程广场</Link></div></main></>;
  const d=data;
  // ⚠️ 2026-09-18 晚用户口径（图2）：**原来那个页头整块删掉了**（「课程广场」眉题 + 课包标题 + 简介）——
  // 课包名称改到下面那排信息（图3）里当标题，「开始学习」那一条也一起删（图1 红框）。
  return <main className="inner">
    <Link to="/marketplace" className="back-link">← 返回课程广场</Link>
    <div className="mkt-detail">
      {(d.coverAssetId || d.coverImageUrl)&&<div className="mkt-detail-cover" role="img" aria-label={`${d.title || '课程'}封面`} style={{backgroundImage:'url('+(d.coverAssetId ? '/api/public/file-assets/'+d.coverAssetId+'/download' : d.coverImageUrl)+')'}}/>}
      <div className="mkt-detail-info">
        <h1 className="mkt-detail-title">{d.title}</h1>
        {d.description&&<p className="mkt-detail-desc">{d.description}</p>}
        <div className="mkt-detail-row"><span className="mkt-label2">难度</span><DifficultyStars level={d.difficultyLevel}/></div>
        {/* 适学年龄整行已删（用户口径 2026-09-20：「适学年龄删除」）——
            线上 4 个课包全是「未设置」，留着只是一行空话。 */}
        {(d.tags||[]).length>0&&<div className="mkt-detail-row"><span className="mkt-label2">标签</span><div className="mkt-chips">{(d.tags||[]).map(t=><span key={t} className="mkt-tag">{t}</span>)}</div></div>}
        {d.version&&<div className="mkt-detail-row"><span className="mkt-label2">版本</span><span>{d.version}</span></div>}
        <div className="mkt-detail-row"><span className="mkt-label2">课时</span><span>{d.lessonCount||0} 节</span></div>
        {/* 参考价格整行已删（用户口径 2026-09-20：「参考价格也删除」） */}
      </div>
    </div>
    {/* 课时列表：**不显示那个「01 / 02」编号块**（用户口径：图1 红框那个编号删除） */}
    {(d.lessons||[]).length>0&&<div className="mkt-lessons"><h2>课程内容</h2>{(d.lessons||[]).map((l)=><div key={l.id} className="mkt-lesson"><div className="mkt-lesson-body"><h3>{l.title}</h3>{l.summary&&<p className="mkt-lesson-summary">{l.summary}</p>}{l.lessonContent&&<p className="mkt-lesson-content">{String(l.lessonContent).slice(0,300)}{l.lessonContent&&l.lessonContent.length>300?'…':''}</p>}</div></div>)}</div>}
  </main>;
}
function End({title,text}){return <section className="end"><h2>{title}</h2><p>{text}</p><Button>联系我们 · 开通试用</Button></section>}
// 官网匿名统计（含同意横幅与埋点）已按用户要求**彻底删除**（2026-09-16）：
// 前端不再有任何上报入口，服务端的接收端点与平台端「官网转化」看板也一并下线，只保留历史表与数据。
//
// ⚠️⚠️ 2026-09-18 晚的页面取舍（**我上一轮做反了一次，这里是最终口径**）：
//   学生端的「我的课程」**只保留这一个页面**（`StudentCourseCenter`：学习上课 / 刷新课程 / 课程卡片 +
//   查看课程 → 选课时 → 进入课堂）。另一条 `/my-courses`（指标卡 + 课时列表那一版）**删掉**，
//   现在只做重定向过来。用户原话：「把图3的页面删了，留图4这个页面」。
//   ⚠️ 我上一轮理解反了（以为留 /my-courses、删这个），所以把两边的入口来回改了一次 ——
//   判断这种"两页同名"的问题时，**以用户截图里的 URL 为准**，别按"哪个更像我改过的"猜。
function LearnPageInner({ api }) {
  return <main className='learn-page-shell'><StudentCourseCenter api={api} homeHref='/' onEnterCanvas={(id) => { window.location.assign('/learn/canvas/' + id); }} /></main>;
}
function LearnCanvasPage({ api }) {
  return <CanvasClassroom api={api} onEnterProject={(id) => { window.location.assign('/learn/canvas/' + id); }} />;
}
function LearnProjectPage({ api }) {
  return <CanvasWorkspace api={api} />;
}
export function App(){
  const loc = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState(readUserSession);
  const api = useMemo(() => createApiClient({ getToken: () => session?.token || null, onUnauthorized: () => { removeUserSession(); setSession(null); } }), [session]);
  function logout() {
    removeUserSession();
    setSession(null);
  }
  useEffect(() => {
    const titles = {
      '/': BRAND_NAME + ' · ' + BRAND_TAGLINE,
      '/login': '登录 · ' + BRAND_NAME,
      '/marketplace': '灵动课程 · ' + BRAND_NAME,
      '/org': '机构方案 · ' + BRAND_NAME,
      '/works': '灵动作品 · ' + BRAND_NAME,
      '/handbook': '机构手册 · ' + BRAND_NAME,
      '/faq': '常见问题 · ' + BRAND_NAME,
      '/download': '下载创作客户端 · ' + BRAND_NAME,
      '/compare': '选型对比 · ' + BRAND_NAME,
      '/demo': '联系我们 · ' + BRAND_NAME,
      '/terms': '用户协议 · ' + BRAND_NAME,
      '/privacy': '隐私政策 · ' + BRAND_NAME,
      '/minors': '儿童 / 未成年人说明 · ' + BRAND_NAME,
      '/learn': '灵动学习 · ' + BRAND_NAME,
      '/my-courses': '我的课程 · ' + BRAND_NAME,
      '/my-works': '我的作品 · ' + BRAND_NAME,
      '/learn/canvas': '画布上课 · ' + BRAND_NAME,
    };
    // 动态路由（课程/作品详情）按前缀回落：否则它们会退到首页标题，浏览器标签上看着不像同一个站。
    const title = titles[loc.pathname]
      || (loc.pathname.startsWith('/marketplace/') ? '课程详情 · ' + BRAND_NAME : '')
      || (loc.pathname.startsWith('/works/') ? '作品详情 · ' + BRAND_NAME : '')
      || titles['/'];
    document.title = title;
    const robots = document.querySelector('meta[name=robots]');
    if (robots) robots.setAttribute('content', INTERNAL_TEST ? 'noindex, nofollow, noarchive' : 'index,follow');
    const description = document.querySelector('meta[name=description]');
    if (description) description.setAttribute('content', BRAND_NAME + '：面向教培机构与学校的青少年 AI 创作课堂，用中文对话、VibeCoding 与项目式学习，让孩子从灵感进入作品。');
    const canonical = document.querySelector('link[rel=canonical]');
    if (canonical) canonical.setAttribute('href', window.location.origin + (loc.pathname === '/' ? '' : loc.pathname));
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', title);
    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute('content', window.location.origin + (loc.pathname === '/' ? '' : loc.pathname));
  }, [loc.pathname]);
  // ⚠️ hook 必须全部写在下面的提前 return 之前：学生会话过期时 App 会在这里提前返回，
  // 若 hook 在其后，同一次渲染里 hook 数从 7 变 6，React 抛 #300 直接白屏（而不是跳登录页）。
  const [showStudentMenu, setShowStudentMenu] = useState(false);
  const studentMenuRef = useRef(null);
  // 学生下拉「开着不关」的两条兜底（用户 2026-09-18 晚报的 bug：
  // 「我在首页点开这个下拉框，我切换页面还存在」）：
  //   ① 路由一变就收起 —— 顶栏是常驻的，靠 state 的下拉不会自己跟着路由走；
  //   ② 点空白处或按 Esc 也收起 —— 只靠"再点一次按钮"太隐蔽。
  // ⚠️ 这两个 hook 必须在下面那个提前 return **之前**（React #300，见下条注释）。
  useEffect(() => { setShowStudentMenu(false); }, [loc.pathname]);
  useEffect(() => {
    if (!showStudentMenu) return undefined;
    const closeOnOutside = (event) => { if (!studentMenuRef.current?.contains(event.target)) setShowStudentMenu(false); };
    const closeOnEscape = (event) => { if (event.key === 'Escape') setShowStudentMenu(false); };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('mousedown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [showStudentMenu]);
  // ⚠️ 2026-09-18 晚用户口径：「未登录点灵动学习跳的是机构/老师登录，应该跳学生登录」——
  // 这些 `/learn*`、`/my-*` 都是**学生**的页面，所以未登录时统一带去**学生登录**（`?as=student`）。
  // 原来落到 `/login` 会走默认那一支（机构/老师登录），学生点进来第一眼就看到老师的表单。
  if (loc.pathname.startsWith('/learn') && !session) {
    return <Navigate to='/login?as=student' replace />;
  }
  const displayName = session?.user?.displayName || session?.user?.login || '用户';
  const userName = String(displayName);
  // 「我的课程」页（学生登录后的落地页）；原先这里写的是 '/learn'，见下面路由处的口径变更
  // 用户口径 2026-09-20：「学习统计」整个删掉（下拉项、页面、路由、标题一并去掉）
  const studentMenuItems = [
    { to: '/learn', label: '我的课程' },
    { to: '/my-works', label: '我的作品' },
  ];

  // 账号徽标（用户口径 2026-09-18 晚，第三次调整）：
  //   **那个圆形头像删掉**（首页徽标 + 下拉里那两处「学」字圆头像都删，用户：「图4 这个图标删除」）；
  //   名字给一个有质感的底色凸显；下拉箭头放大（深色首页上换成白色 —— 他截图里就是那个场景）。
  const userBadge = session ? (
    session.user?.role === 'STUDENT' ? (
      <div className='header-user-menu' ref={studentMenuRef}>
        <button className='header-user' aria-haspopup='menu' aria-expanded={showStudentMenu} onClick={() => setShowStudentMenu(!showStudentMenu)}>
          <span className='header-user-name'>{userName}</span>
          <span className='dropdown-arrow' aria-hidden='true'>⌄</span>
        </button>
        {showStudentMenu && (
          <div className='student-dropdown-menu' role='menu'>
            {/* 参考图的下拉：顶部是名字，一条分隔线，然后是纯文字菜单项（不带图标、不带头像） */}
            <div className='dropdown-head'><strong>{userName}</strong></div>
            <div className='menu-divider'></div>
            {studentMenuItems.map(item => (
              <Link key={item.to} to={item.to} className='menu-item' role='menuitem' onClick={() => setShowStudentMenu(false)}>
                <span className='menu-label'>{item.label}</span>
              </Link>
            ))}
            <div className='menu-divider'></div>
            <button className='menu-item logout-item' role='menuitem' onClick={() => { setShowStudentMenu(false); logout(); }}>
              <span className='menu-label'>退出登录</span>
            </button>
          </div>
        )}
      </div>
    ) : (
      <span className='header-user'>
        <span className='header-user-name'>{userName}</span>
        <button className='text-button' onClick={logout}>退出</button>
      </span>
    )
  ) : <AuthEntries/>;
  if (loc.pathname === '/login') return <LoginPage/>;
  // 2026-09-18 晚用户口径：「点击『灵动课程』上方都有导航栏，点击『灵动学习』应该也要有导航栏才对」。
  // 所以 /learn（我的课程）是**普通页面**——顶栏 + 页脚都在。
  // ⚠️ 只有真正的课堂（/learn/canvas、/learn/canvas/:projectId）才当全屏页：那是学生干活的环境，
  //    要让出整屏高度、不能再叠一层站内导航。
  const isFullPage = loc.pathname.startsWith('/learn/canvas');
  return (
    <div className='site'>
      {INTERNAL_TEST && <div className='internal-test-banner' role='status'>内部测试环境 · 不代表正式服务</div>}
      {!isFullPage && <Header userBadge={userBadge} signedIn={Boolean(session)} />}
      <Routes>
        <Route path='/' element={<Home/>}/>
        <Route path='/login' element={<LoginPage/>}/>
        <Route path='/marketplace' element={<Marketplace/>}/>
        <Route path='/marketplace/:id' element={<MarketplaceDetail/>}/>
        <Route path='/courses' element={<Navigate to='/marketplace' replace/>}/>
        <Route path='/org' element={<Org/>}/>
        <Route path='/works' element={<Works/>}/>
        <Route path='/works/shared/:token' element={<WorkDetailPage api={publicApi}/>}/>
        <Route path='/works/:token' element={<WorkDetailPage api={publicApi}/>}/>
        <Route path='/handbook' element={<Handbook/>}/>
        {/* 2026-09-19 用户口径：灵动介绍这一页**整个删掉**（页面 / 导航 / 页脚入口一起）。
            留一条重定向，老链接与老书签不会 404（与 /my-courses → /learn 同一套做法）。 */}
        <Route path='/intro' element={<Navigate to='/' replace/>}/>
        <Route path='/faq' element={<Faq/>}/>
        <Route path='/download' element={<Download/>}/>
        <Route path='/compare' element={<Compare/>}/>
        <Route path='/demo' element={<Demo/>}/>
        <Route path='/terms' element={<LegalPage type='terms'/>}/>
        <Route path='/privacy' element={<LegalPage type='privacy'/>}/>
        <Route path='/minors' element={<LegalPage type='minors'/>}/>
        <Route path='/learn' element={<LearnPageInner api={api}/>}/>
        <Route path='/learn/canvas' element={<LearnCanvasPage api={api}/>}/>
        <Route path='/learn/canvas/:projectId' element={<LearnProjectPage api={api}/>}/>
        <Route path='/my-works' element={session ? <MyWorksPage api={api} /> : <Navigate to='/login?as=student' replace />}/>
        <Route path='/my-works/:source/:id' element={session ? <MyWorkDetailPage api={api} /> : <Navigate to='/login?as=student' replace />}/>
        {/* ⚠️ 这两条是**老地址的重定向**：`/my-courses`（指标卡 + 课时列表那一版）已按用户口径删掉，
            学生端的「我的课程」就是 /learn 那个页面。留着重定向是为了老链接/老书签不 404。
            别把这两行删了 —— 删了就真的 404。 */}
        <Route path='/my-courses' element={<Navigate to='/learn' replace/>}/>
        <Route path='/my-courses/:courseId' element={<Navigate to='/learn' replace/>}/>
        {/* 「学习统计」整页已按用户口径删除（2026-09-20：下拉项 / 页面 / 标题映射一并去掉）。
            ⚠️ 照口径㉒「删一整页要一处不落、路由留重定向」，这里**留着重定向**给老书签，
            删掉这一行老链接就真的 404 了。去向选 /learn：学生看进度的地方就是「我的课程」。 */}
        <Route path='/my-stats' element={<Navigate to='/learn' replace/>}/>
        <Route path='*' element={<Home/>}/>
      </Routes>
      {!isFullPage && loc.pathname !== '/' && <Footer/>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
