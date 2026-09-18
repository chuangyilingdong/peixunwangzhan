import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import '@platform/shared/styles.css';
import './styles.css';
import { LEGAL_DOCUMENTS, LEGAL_EFFECTIVE_DATE, LEGAL_OWNER, LEGAL_STATUS, LEGAL_VERSION } from './legal.js';
import { LoginPanel, BrandLogo, CanvasClassroom, CanvasWorkspace, StudentCourseCenter, Notice, createApiClient, readSession as readUserSession, writeSession as saveUserSession, clearSession as removeUserSession } from '@platform/shared';
import { MyWorksPage } from './pages/MyWorks.jsx';
import { MyStatsPage } from './pages/MyStats.jsx';
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
const WEBSITE_NAV = [['/', '首页'], ['/learn', '灵动学习'], ['/marketplace', '灵动课程'], ['/works', '灵动作品'], ['/intro', '灵动介绍'], ['/handbook', '机构手册'], ['/faq', '常见问题']];
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
function Footer(){return <footer><div className="foot"><div><Logo/><p>面向教培机构与学校的<br/>青少年 AI 通识与 VibeCoding 开课平台。</p></div><div><strong>产品</strong><Link to="/marketplace">灵动课程</Link><Link to="/org">机构方案</Link><Link to="/works">灵动作品</Link><Link to="/intro">灵动介绍</Link></div><div><strong>合作</strong><Link to="/demo">联系我们</Link><Link to="/handbook">机构手册</Link><a href={ORG_APP_URL}>机构后台</a></div><div><strong>了解更多</strong><Link to="/faq">常见问题</Link><Link to="/compare">选型对比</Link><Link to="/terms">用户协议</Link><Link to="/privacy">隐私政策</Link><Link to="/minors">儿童 / 未成年人说明</Link><a href="mailto:hello@aimagc.cn">联系合作</a></div></div><div className="copyright">© 2026 {BRAND_NAME} <span>面向 8–16 岁 · 浏览器即用</span></div></footer>}
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
function Work({work,index=0}){
  const url=work.publicUrl||(work.shareToken?'/works/'+work.shareToken:null);
  const emoji=work.canvasSnapshot?.nodes?.[0]?.data?.emoji||work.emoji||'✦';
  const title=work.title;const student=work.studentName||'小创作者';const isVibe=work.type==='VIBECODING';
  // VibeCoding 作品可能是能玩的网页，也可能是 PPT / Word / Excel（站内预览 + 下载真文件）；
  // 是哪一种由服务端的 preview 说了算（最近产出的那份），前端不再自己猜。
  const docKind=isVibe&&work.preview?.document?String(work.preview.kind||'').toLowerCase():'';
  const vibeHint=docKind==='pptx'?'演示文稿':docKind==='xlsx'?'表格':docKind==='docx'?'文档':isVibe?'可在线玩':'';
  return <article className={'work w'+index%6}>
    {url?<Link className="work-hit" to={url} aria-label={`打开作品：${title}`}/>:null}
    <div className="art" aria-hidden="true"><span>{isVibe?(docKind?'📊':'🎮'):emoji}</span></div>
    <div className="work-body">
      <h3 className="work-title" title={title}>{title}</h3>
      {/* ⚠️ 这里用 div 而不是 <footer>：站点有一条**全局** `footer{padding:64px 28px 24px;background:#f8f7fc}`
          （页脚用的），挂在 <footer> 上会被它撑到 108px 还带一层灰底（实测踩过）。 */}
      <div className="work-foot">
        <span className="work-student">{work.featured?<i className="work-featured" title="精选作品" aria-label="精选作品">★</i>:null}{student}</span>
        <span className="work-org">{work.orgName||vibeHint}</span>
      </div>
    </div>
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
const HOME_STATS_FALLBACK = [
  { icon: '◆', value: 3, suffix: ' 门', label: '标准课包' },
  { icon: '◇', value: 48, suffix: ' 节', label: '课时总量' },
  { icon: '✧', value: 2, suffix: ' 类', label: '课堂形式' },
  { icon: '⌘', value: 1, suffix: ' 套', label: '机构工作台' },
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
    {ready && stats.length ? <section className="hp-stats" aria-label="平台数据">{stats.map((item, index) => <div className="hp-stat" key={index + '-' + (item.label || '')}><i>{item.icon || '✦'}</i><strong><StatValue value={item.value} suffix={item.suffix || ''} /></strong><span>{item.label || ''}</span></div>)}</section> : null}
  </main>;
}
function Home(_props) { return <HomeLanding />; }
function CTA(){return <section className="cta"><div><Kicker>准备好把 AI 课开起来了吗？</Kicker><h2>让每个孩子<br/><em>用 AI 做出自己的作品</em></h2><p>获取演示账号与示范课包清单。</p></div><Button>联系我们</Button></section>}

function Org(){const faqCms=useWebsiteContent('FAQ');const modules=[['机构账号','管理员、教师、学员分级；学员无需自备 API Key','课堂零配置，避免密钥泄露'],['授权次数','按机构开通、按班分给学生；剩余次数不足友好提示','用量可控，适合班级教学'],['课程中心','11 门 / 87 节标准课包；PPT 与 HTML 互动课件','标准化交付，校区可复制'],['管理后台','账号开通、课包浏览、作品发布、用量记录','运营数据透明'],['作品展厅','机构内作品聚合展示与在线预览','成果可视化，利于续费与招新']];return <><Title eyebrow="机构方案" title={<>教培机构如何开<br/><em>青少年 AI 通识课</em></>} desc="平台提供课程、机构账号与用量计费；机构负责招生和教学。8–16 岁学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的作品。"/><main className="inner"><section className="org-intro"><div><i>“</i><h2>不是再找一个聊天网站，<br/>而是一套<span>可管、可教、可展示</span>的课堂产品。</h2><p>学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的游戏、动画、互动故事和硬件作品。</p></div><div className="steps">{[['01','平台开通机构','配置席位、开通授权次数、发布课包权限。'],['02','老师创建学员账号','学生用机构账号登录，即可开始创作。'],['03','按课包授课','从课程中心进入课时，结合阿飞完成当堂作品。'],['04','作品沉淀与展示','优秀作业进入作品社区，形成校区案例库。']].map(x=><div key={x[0]}><b>{x[0]}</b><p><strong>{x[1]}</strong>{x[2]}</p></div>)}</div></section><section className="modules">{modules.map((m,i)=><article key={m[0]}><small>0{i+1}</small><h3>{m[0]}</h3><p>{m[1]}</p><b>{m[2]}</b></article>)}</section><section className="faq"><div><Kicker>常见问题</Kicker><h2>{faqCms.data?.title||'开课前，你可能想知道'}</h2></div><div>{(faqCms.data?.items||[['需要学员自备 API Key 或对话平台账号？','不需要。机构账号登录即可使用平台统一模型能力，学生不持有 API Key，机构用授权次数管理课堂用量。'],['机房和教室的电脑都能用吗？','可以。课堂通过浏览器访问，Chrome / Edge 最新版本即可，机房不需要额外安装环境。'],['能否做 Arduino 和 micro:bit 硬件课？','支持 Arduino Uno 一键烧录，以及 micro:bit 的 MicroPython 上传与串口监视。']].map((item)=>({question:item[0],answer:item[1]}))).map((item,i)=><details key={item.question} open={i===0}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div></section><End title="让你的校区拥有一门可复制的 AI 课" text="联系我们，获取试用账号与示范课包清单。"/></main></>}
function Works(){
  const [items,setItems]=useState(FALLBACK_WORKS.map(w=>({title:w[1],description:w[3],studentName:'小创作者',emoji:w[0]})));
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState(null);
  const [query,setQuery]=useState('');
  const [kind,setKind]=useState('');
  useEffect(()=>{
    // 作品广场同时展示画布作品（public/works）与平台已发布的 VibeCoding 作品（public/vibecoding-works）
    Promise.allSettled([publicApi.get('public/works'), publicApi.get('public/vibecoding-works')]).then(([canvas, vibe])=>{
      const canvasItems = canvas.status === 'fulfilled' && Array.isArray(canvas.value?.items) ? canvas.value.items : [];
      const vibeItems = vibe.status === 'fulfilled' && Array.isArray(vibe.value?.items) ? vibe.value.items : [];
      const merged = [...vibeItems, ...canvasItems].sort((left, right) => Number(Boolean(right.featured)) - Number(Boolean(left.featured)));
      if (merged.length) setItems(merged);
      else if (canvas.status === 'rejected' && vibe.status === 'rejected') setError(canvas.reason?.message || '作品加载失败');
      setLoaded(true);
    });
  },[]);
  // ⚠️ 2026-09-18 晚更正：用户说的「筛选就分为 2 个板块：画布、VibeCoding」是**这一页**的，
  //    我上一轮做错地方了（做到了灵动课程上），现在挪到这里。默认两个都不选 = 全部；
  //    再点一次已选中的那个取消选择（否则选完就没有回到「全部」的路）。
  //    分类与搜索是**叠加**关系：先按类型筛，再按标题/学生名字搜。
  //    画布作品的接口对象没有 `type` 字段，VibeCoding 的是 `type:'VIBECODING'`，就按这个分。
  const isVibe = (w) => w.type === 'VIBECODING';
  const byKind = kind ? items.filter((w) => (kind === 'VIBECODING' ? isVibe(w) : !isVibe(w))) : items;
  // 搜索按「标题 / 学生名字」匹配（大小写不敏感、去首尾空格）
  const keyword=query.trim().toLowerCase();
  const visible=keyword?byKind.filter((w)=>String(w.title||'').toLowerCase().includes(keyword)||String(w.studentName||'').toLowerCase().includes(keyword)):byKind;
  // 页头（「学员作品」+「孩子们的灵感，正在发光」+ 描述）与底部那条
  // 「作品来自真实课堂 / 了解机构作品展厅」提示，都按用户口径 2026-09-18 晚**删掉了** ——
  // 这一页只留「分类 + 搜索 + 卡片」（用户：「灵动作品这里全部不要」「图2也要删除」）。
  return <main className="inner works-page">
    <div className="works-bar">
      {/* 筛选：只留两个板块（画布 / VibeCoding），见上面注释 */}
      <div className="works-cats">
        {[['CANVAS','画布'],['VIBECODING','VibeCoding']].map(([value,label])=>(
          <button type="button" key={value} aria-pressed={kind===value} className={'works-cat'+(kind===value?' on':'')} onClick={()=>setKind(kind===value?'':value)}>{label}</button>
        ))}
      </div>
      {/* 搜索：按作品的「标题 / 学生名字」过滤。作品列表本来就是前端把画布作品与 VibeCoding 作品
          合并出来的，所以过滤也在前端做 —— 不用改接口。 */}
      <div className="works-search">
        <label className="sr-only" htmlFor="works-search">搜索作品标题或学生名字</label>
        <input id="works-search" value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="搜索作品标题或学生名字…" autoComplete="off"/>
        {query?<button type="button" className="works-search-clear" onClick={()=>setQuery('')}>清空</button>:null}
        {loaded?<span className="works-search-count">共 <b>{visible.length}</b> 件</span>:null}
      </div>
    </div>
    <div className="works all">{visible.map((w,i)=><Work key={w.id||w.title} work={w} index={i}/>)}</div>
    {!loaded&&<div className="note">✦ <p>正在加载作品…</p></div>}
    {loaded&&items.length===0&&<div className="note">✦ <p>{error||'暂无公开作品，学生可在作品页开启公开后展示。'}</p></div>}
    {loaded&&items.length>0&&visible.length===0&&<div className="note">✦ <p>{keyword?'没有搜到匹配的作品。换个标题或学生名字试试，或者':'这个分类下暂时没有作品。点'} <b>{keyword?'清空搜索词':'取消分类'}</b> 看看全部。</p></div>}
  </main>;
}
// ── 机构手册 / 灵动介绍 / 常见问题（2026-09-18 起三个页面都由后台 CMS 维护）───────────
// 用户口径：「灵动介绍、机构手册、常见问题尽量做成后台可配置的」，机构手册的图与文字
// 「基本都是平台后台可以配置的」。所以这三页**不硬编码文案**：读 CMS 对应键（INTRO / HANDBOOK / FAQ），
// 前端只留一个精简 fallback（见 CMS_FALLBACK）。后台在「官网内容」里按区块编辑 + 传图，官网立即生效。
// 三个键的字段形状（后台表单与公开端渲染共用，改动要同步 apps/admin/src/pages/WebsiteContent.jsx）：
//   INTRO    { title, lead, highlights:[{title,desc}], sections:[{title,body,bullets[],imageUrl,imageAlt}], cta:{title,text} }
//   HANDBOOK { title, lead, sections:[{title,body,bullets[],imageUrl,imageAlt}], compareRows:[{label,left,right}], cta:{title,text} }
//   FAQ      { title, items:[{question,answer}] }
const cmsList = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
function CmsSections({ sections }) {
  const list = cmsList(sections);
  if (!list.length) return null;
  return <section className="hb-sections">{list.map((item, index) => <article className="hb-section" key={index + '-' + (item.title || '')}>
    <small>{String(index + 1).padStart(2, '0')}</small>
    <h2>{item.title || ''}</h2>
    {item.body && <p>{item.body}</p>}
    {cmsList(item.bullets).length ? <ul>{cmsList(item.bullets).map((bullet, bulletIndex) => <li key={bulletIndex}>{String(bullet)}</li>)}</ul> : null}
    {item.imageUrl && <img className="hb-image" src={item.imageUrl} alt={item.imageAlt || item.title || ''} loading="lazy" />}
  </article>)}</section>;
}
function CmsCompare({ rows }) {
  const list = cmsList(rows);
  if (!list.length) return null;
  return <section className="compare"><div className="compare-head"><span>对比维度</span><span>分散拼凑</span><b>{BRAND_NAME}</b></div>{list.map((row, index) => <div key={index + '-' + (row.label || '')}><strong>{row.label || ''}</strong><span>{row.left || ''}</span><b>✓ {row.right || ''}</b></div>)}</section>;
}
function Handbook() {
  const cms = useWebsiteContent('HANDBOOK');
  const content = cms.data || {};
  return <><Title eyebrow="机构手册 · 2026" title={<>{content.title || '机构合作手册'}</>} desc={content.lead || ''} /><main className="inner handbook-page"><CmsSections sections={content.sections} /><CmsCompare rows={content.compareRows} /><End title={content.cta?.title || '获取完整机构手册'} text={content.cta?.text || '先联系我们，我们会把最新版本、课件示例与合作说明发给你。'} /></main></>;
}
function Intro() {
  const cms = useWebsiteContent('INTRO');
  const content = cms.data || {};
  const highlights = cmsList(content.highlights);
  return <><Title eyebrow="灵动介绍" title={<>{content.title || '灵动介绍'}</>} desc={content.lead || ''} /><main className="inner intro-page">{highlights.length ? <section className="modules">{highlights.map((item, index) => <article key={index + '-' + (item.title || '')}><small>0{index + 1}</small><h3>{item.title || ''}</h3><p>{item.desc || ''}</p></article>)}</section> : null}<CmsSections sections={content.sections} /><End title={content.cta?.title || '把 AI 课开起来'} text={content.cta?.text || '联系我们，我们会按你的班型给出课包与开通方案。'} /></main></>;
}
// 常见问题 /faq：黑底 + 卡片式手风琴（2026-09-18 晚按用户给的参考稿重做）。
// ⚠️ 参考稿是 Tailwind + framer-motion 写的，这里**不引入这两个依赖**：官网是纯 CSS 的一套
//    （依赖里只有 ogl，没有 Tailwind），为一张页面把它引进来会与全局 styles.css 打架；
//    展开动画改用 CSS 的 grid-template-rows 0fr→1fr 复现，时长与缓动跟参考稿一致（见 .fq-panel）。
// ⚠️ 主色用站内那支粉（同 .mp 的 --mp-accent），**不引入参考稿里的紫 #A855F7** —— 官网已经统一过
//    一套主色，再放第二支会看着不像同一个站（/marketplace 那条口径的延续）。
// ⚠️ 页头只在这一处渲染 CMS 标题：上一版「页头 + 区块」两处都渲染，同一句话出现两遍（第十五轮实测到）。
//    现在 h1 说页面名（常见问题），CMS 的 title 是它下面那句说明，只出现一次。
function Faq() {
  const cms = useWebsiteContent('FAQ');
  const content = cms.data || {};
  const items = cmsList(content.items);
  // 初始态照参考稿：**一条都不展开**（参考稿是 useState<number | null>(null)，不是默认开第一条）。
  const [openIndex, setOpenIndex] = useState(null);
  const ready = !cms.loading;
  const group = cmsPick(content, 'title', CMS_FALLBACK.FAQ.title);
  return <main className="fq">
    <div className="fq-aura" aria-hidden="true" />
    <div className="fq-inner">
      {/* 与首页 / 课程广场同一口径：接口回来前不渲染文案，否则强刷会先闪一帧与后台不符的字 */}
      <header className="fq-head">
        {ready ? <><div className="fq-eyebrow"><i aria-hidden="true" /><span>帮助中心</span><i aria-hidden="true" /></div><h1 className="fq-title">常见问题</h1>{group ? <p className="fq-lead">{group}</p> : null}</> : <div className="fq-head-hold" aria-hidden="true" />}
      </header>
      <div className="fq-list">
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
      </div>
      <p className="fq-note">没有找到答案？<Link to="/demo">联系我们</Link>，我们按你的班型回答。</p>
    </div>
  </main>;
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
  FAQ: { title: '开课前，你可能想知道', items: [{ question: '需要学员自备 API Key 或对话平台账号吗？', answer: '不需要。机构账号登录即可使用平台统一模型能力，学生不持有 API Key，机构用授权次数管理课堂用量。' }, { question: '机房和教室的电脑都能用吗？', answer: '可以。课堂通过浏览器访问，Chrome / Edge 最新版本即可，机房不需要额外安装环境。' }, { question: '能否做 Arduino 和 micro:bit 硬件课？', answer: '支持 Arduino Uno 一键烧录，以及 micro:bit 的 MicroPython 上传与串口监视。' }] },
  INTRO: { title: '灵动介绍', lead: BRAND_NAME + '是面向 8–16 岁的 AI 创作开课平台：学生用中文与 AI 伙伴「阿飞」对话，当堂做出能运行、能展示的作品。', highlights: [], sections: [], cta: { title: '把 AI 课开起来', text: '联系我们，我们会按你的班型给出课包与开通方案。' } },
  HANDBOOK: { title: '机构合作手册', lead: '把「一门 AI 课」变成能复制的校区产品：课程、账号、授权次数与作品沉淀在同一套平台里。', sections: [], compareRows: [], cta: { title: '获取完整机构手册', text: '先联系我们，我们会把最新版本、课件示例与合作说明发给你。' } },
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
function ageLabel(min,max){
  if(!min&&!max) return null;
  if(min&&max) return `${min}–${max} 岁`;
  if(min) return `${min}+ 岁`;
  return `≤${max} 岁`;
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
       // 没定价（price_fen=0，默认值）时不假装是 0 元，写「价格面议」。
       const priceFen=Number(item.priceFen||0);const yuan=priceFen/100;
       const priceText=priceFen>0?'¥ '+(Number.isInteger(yuan)?yuan:yuan.toFixed(2)):'价格面议';
       // 那四个参数位（用户口径 2026-09-18 晚）：难度 / **版本号** / 课时 / 课堂形式。
       // ⚠️ 原来第二格是「适学年龄」，但线上 4 个课包全是「未设置」（课包编辑表单里能填、
       //    只是没人填），于是用户要求换成**版本号** —— 版本号在编辑表单里是有的。
       //    换的时候顺手补了列表接口的 version 字段（它以前没下发，不然这格又会是「未设置」）。
       const params=[['难度',item.difficultyLevel?item.difficultyLevel+' / 5':'未设置'],['版本',item.version||'未设置'],['课时',(item.lessonCount||0)+' 节'],['课堂形式',item.deliveryMode==='VIBECODING'?'VibeCoding 课程':'画布课程']];
       return <article className="mp-row" key={item.id}>
         <div className="mp-main">
           <div className={'mp-cover'+(cover?' has-image':'')} style={cover?{backgroundImage:'url('+cover+')'}:undefined}>{cover?null:<span>{item.title?.charAt(0)||'课'}</span>}</div>
           <div className="mp-info"><h2 className="mp-name">{item.title}</h2><p className="mp-desc">{item.description||'课包简介待补充。'}</p></div>
           {/* 价格与按钮**同一行、价格在左**（用户口径：参考稿是「价格 + 按钮」并排，不是上下堆叠） */}
           <div className="mp-side">
             <div className="mp-price"><strong>{priceText}</strong><span>{priceFen>0?'按课包开通':'开通方案请联系我们'}</span></div>
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
        <div className="mkt-detail-row"><span className="mkt-label2">适学年龄</span><span>{ageLabel(d.ageRangeMin,d.ageRangeMax)||'未设置'}</span></div>
        {(d.tags||[]).length>0&&<div className="mkt-detail-row"><span className="mkt-label2">标签</span><div className="mkt-chips">{(d.tags||[]).map(t=><span key={t} className="mkt-tag">{t}</span>)}</div></div>}
        {d.version&&<div className="mkt-detail-row"><span className="mkt-label2">版本</span><span>{d.version}</span></div>}
        <div className="mkt-detail-row"><span className="mkt-label2">课时</span><span>{d.lessonCount||0} 节</span></div>
        {/* 参考价格：**不带小数、不带「（线下购买）」**（用户口径：「直接写 ￥8000 即可」） */}
        {d.priceFen>0&&<div className="mkt-detail-row"><span className="mkt-label2">参考价格</span><span className="mkt-price">{'¥'+(Number.isInteger(d.priceFen/100)?d.priceFen/100:(d.priceFen/100).toFixed(2))}</span></div>}
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
      '/intro': '灵动介绍 · ' + BRAND_NAME,
      '/handbook': '机构手册 · ' + BRAND_NAME,
      '/faq': '常见问题 · ' + BRAND_NAME,
      '/compare': '选型对比 · ' + BRAND_NAME,
      '/demo': '联系我们 · ' + BRAND_NAME,
      '/terms': '用户协议 · ' + BRAND_NAME,
      '/privacy': '隐私政策 · ' + BRAND_NAME,
      '/minors': '儿童 / 未成年人说明 · ' + BRAND_NAME,
      '/learn': '灵动学习 · ' + BRAND_NAME,
      '/my-courses': '我的课程 · ' + BRAND_NAME,
      '/my-works': '我的作品 · ' + BRAND_NAME,
      '/my-stats': '学习统计 · ' + BRAND_NAME,
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
  const studentMenuItems = [
    { to: '/learn', label: '我的课程' },
    { to: '/my-works', label: '我的作品' },
    { to: '/my-stats', label: '学习统计' },
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
        <Route path='/intro' element={<Intro/>}/>
        <Route path='/faq' element={<Faq/>}/>
        <Route path='/compare' element={<Compare/>}/>
        <Route path='/demo' element={<Demo/>}/>
        <Route path='/terms' element={<LegalPage type='terms'/>}/>
        <Route path='/privacy' element={<LegalPage type='privacy'/>}/>
        <Route path='/minors' element={<LegalPage type='minors'/>}/>
        <Route path='/learn' element={<LearnPageInner api={api}/>}/>
        <Route path='/learn/canvas' element={<LearnCanvasPage api={api}/>}/>
        <Route path='/learn/canvas/:projectId' element={<LearnProjectPage api={api}/>}/>
        <Route path='/my-works' element={session ? <MyWorksPage api={api} /> : <Navigate to='/login?as=student' replace />}/>
        {/* ⚠️ 这两条是**老地址的重定向**：`/my-courses`（指标卡 + 课时列表那一版）已按用户口径删掉，
            学生端的「我的课程」就是 /learn 那个页面。留着重定向是为了老链接/老书签不 404。
            别把这两行删了 —— 删了就真的 404。 */}
        <Route path='/my-courses' element={<Navigate to='/learn' replace/>}/>
        <Route path='/my-courses/:courseId' element={<Navigate to='/learn' replace/>}/>
        <Route path='/my-stats' element={session ? <MyStatsPage api={api} /> : <Navigate to='/login?as=student' replace />}/>
        <Route path='*' element={<Home/>}/>
      </Routes>
      {!isFullPage && loc.pathname !== '/' && <Footer/>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
