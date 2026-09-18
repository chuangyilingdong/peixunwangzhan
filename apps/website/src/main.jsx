import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import '@platform/shared/styles.css';
import './styles.css';
import { LEGAL_DOCUMENTS, LEGAL_EFFECTIVE_DATE, LEGAL_OWNER, LEGAL_STATUS, LEGAL_VERSION } from './legal.js';
import { LoginPanel, BrandLogo, CanvasClassroom, CanvasWorkspace, StudentCourseCenter, Notice, createApiClient, readSession as readUserSession, writeSession as saveUserSession, clearSession as removeUserSession } from '@platform/shared';
import { MyWorksPage } from './pages/MyWorks.jsx';
import { MyCoursesPage } from './pages/MyCourses.jsx';
import { MyStatsPage } from './pages/MyStats.jsx';
import { CourseDetailPage } from './pages/CourseDetail.jsx';
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
    const target = role === 'STUDENT' ? '/my-courses' : role === 'TEACHER' || role === 'ORG_ADMIN' ? '/' : role === 'SUPER_ADMIN' || role === 'PLATFORM_ADMIN' ? '/admin/' : '/';
    window.location.assign(target);
  }
  return <div className='website-login'><Link className='login-back' to='/'>← 返回官网首页</Link><LoginPanel title={asStudent ? '学生登录' : '机构 / 老师登录'} description={asStudent ? '使用机构分配给你的学员账号进入课堂。' : '使用机构分配给老师或管理员的账号进入工作台。'} onLogin={handleLogin} demos={[]} /><p className='login-switch'>{asStudent ? <>我是机构 / 老师，<Link to='/login?as=staff'>去机构登录</Link></> : <>我是学生，<Link to='/login?as=student'>去学生登录</Link></>}</p></div>;
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
// 这两个入口只决定默认提示文案与登录后的落点，不参与鉴权判定——所以不往 auth/login 里传 clientType，
// 避免「老师从学生入口进来就被拒」这类按入口拦人的行为。
const LOGIN_ENTRIES = [['/login?as=staff', '机构 / 老师登录'], ['/login?as=student', '学生登录']];
// 品牌区用真正的 logo（灵动ai 横标，三端共用同一张图）；不再用「✦ + 文字」的占位标记。
function Logo(){return <Link className="logo" to="/"><BrandLogo height={26} /></Link>}
function AuthEntries(){
  // 未登录时导航右侧的两个入口。登录后这里换成账号徽标（由 App 传 userBadge 进来）。
  return <>{LOGIN_ENTRIES.map(([to, label]) => <Link key={to} className='site-login' to={to}>{label}</Link>)}</>;
}
function Header({ userBadge }){
  const loc=useLocation();
  const [menuOpen,setMenuOpen]=useState(false);
  // 路由变化后收起抽屉：否则从抽屉点进新页面，抽屉会留在上面盖住内容。
  useEffect(()=>{ setMenuOpen(false); },[loc.pathname]);
  const onDark=loc.pathname==='/';
  return <header className={'site-topbar'+(onDark?' on-dark':'')}><div className="bar"><Logo/><nav aria-label="主导航">{WEBSITE_NAV.map(([to,n])=><NavLink key={to} to={to} end={to==='/'} className={({isActive})=>isActive?'on':''}>{n}</NavLink>)}</nav><div className="head-actions"><Link className="top-button" to="/demo">联系我们 <b>↗</b></Link>{userBadge}</div><button type="button" className="site-burger" aria-label={menuOpen?'关闭菜单':'打开菜单'} aria-expanded={menuOpen} onClick={()=>setMenuOpen(v=>!v)}>{menuOpen?'×':'☰'}</button></div>{menuOpen && <div className="site-menu-overlay"><div className="site-menu-head"><span>{BRAND_NAME}</span><button type="button" onClick={()=>setMenuOpen(false)}>关闭 ×</button></div><div className="site-menu-items">{WEBSITE_NAV.map(([to,n])=><NavLink key={to} to={to} end={to==='/'} className={({isActive})=>isActive?'active':''} onClick={()=>setMenuOpen(false)}>{n}<span>↗</span></NavLink>)}</div><div className="site-menu-login">{userBadge}</div></div>}</header>;
}
function Footer(){return <footer><div className="foot"><div><Logo/><p>面向教培机构与学校的<br/>青少年 AI 通识与 VibeCoding 开课平台。</p></div><div><strong>产品</strong><Link to="/marketplace">灵动课程</Link><Link to="/org">机构方案</Link><Link to="/works">灵动作品</Link><Link to="/intro">灵动介绍</Link></div><div><strong>合作</strong><Link to="/demo">联系我们</Link><Link to="/handbook">机构手册</Link><a href={ORG_APP_URL}>机构后台</a></div><div><strong>了解更多</strong><Link to="/faq">常见问题</Link><Link to="/compare">选型对比</Link><Link to="/terms">用户协议</Link><Link to="/privacy">隐私政策</Link><Link to="/minors">儿童 / 未成年人说明</Link><a href="mailto:hello@aimagc.cn">联系合作</a></div></div><div className="copyright">© 2026 {BRAND_NAME} <span>面向 8–16 岁 · 浏览器即用</span></div></footer>}
function Button({children,to='/demo',soft=false}){return <Link to={to} className={'button '+(soft?'soft':'')}>{children}<b>↗</b></Link>}
function Kicker({children}){return <div className="kicker">✦ {children}</div>}
function Work({work,index=0}){const navigate=useNavigate();const url=work.publicUrl||(work.shareToken?'/works/'+work.shareToken:null);const emoji=work.canvasSnapshot?.nodes?.[0]?.data?.emoji||work.emoji||'✦';const title=work.title;const desc=work.description;const student=work.studentName||'小创作者';const isVibe=work.type==='VIBECODING';
    // VibeCoding 作品可能是能玩的网页，也可能是 PPT / Word / Excel（站内预览 + 下载真文件）；
    // 是哪一种由服务端的 preview 说了算（最近产出的那份），前端不再自己猜。
    const docKind=isVibe&&work.preview?.document?String(work.preview.kind||'').toLowerCase():'';
    const vibeHint=docKind==='pptx'?' · 演示文稿':docKind==='xlsx'?' · 表格':docKind==='docx'?' · 文档':isVibe?' · 可在线玩':'';
    return <article className={'work w'+index%6}><div className="art"><span>{isVibe?(docKind?'📊':'🎮'):emoji}</span><i>✦</i><b>AI</b></div><div className="work-body"><small>{student}{vibeHint}</small><h3>{title}</h3><p>{desc}</p><button type="button" aria-label={`打开作品：${title}`} onClick={()=>{if(url)navigate(url);}}>打开体验 <b>↗</b></button></div></article>}
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
const HOME_STATS_FALLBACK = [
  { icon: '◆', value: 11, suffix: ' 门', label: '标准课包' },
  { icon: '◇', value: 87, suffix: ' 节', label: '课时总量' },
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
// 首页大标题的字号自适应：标题是**后台可改**的，用户写长了就会被裁 ——
// 2026-09-18 实测：他写的那行「不只是学工具，而是掌握Ai时代的创造方式」宽 1471px 而视口 1440px，
// 左右各被 overflow:hidden 裁掉 15px（没有滚动条，所以肉眼不容易发现）。
// 做法：按最长那一行的「字宽」估算（中文 1、拉丁 0.58），再用 min(6vw, 92vw/字宽) 压到一行放得下；
// ≤1120px 由 min() 与 26px 下限接管；真放不下还有 CSS 换行兜底（绝不裁字）。
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
  const longestLine = Math.max(titleWeight(title), titleWeight(accent), 1);
  const titleStyle = { fontSize: `clamp(26px, min(6vw, ${(92 / longestLine).toFixed(2)}vw), 76px)` };
  return <main className="hp">
    <div className="hp-bg" aria-hidden="true"><video className="hp-video" src="/assets/hero-animal.mp4" poster="/assets/hero-animal-poster.webp" autoPlay muted loop playsInline preload="auto" /><div className="hp-scrim" /></div>
    <section className="hp-hero">
      {(trustTitle || trustDescription) && <div className="hp-trust"><span className="hp-trust-mark">✦</span><div>{trustTitle ? <strong>{trustTitle}</strong> : null}{trustDescription ? <span>{trustDescription}</span> : null}</div></div>}
      {kicker ? <p className="hp-kicker">{kicker}</p> : null}
      {(title || accent) && <h1 className="hp-title" style={titleStyle}>{title ? <span>{title}</span> : null}{accent ? <em>{accent}</em> : null}</h1>}
      {description ? <p className="hp-sub">{description}</p> : null}
      {/* 首页两个 CTA 用 SpecularButton：主按钮 autoAnimate（高光常亮 + 缓慢扫过），
          次按钮只在光标靠近时亮起 —— 一强一弱，两个都是药丸形状（radius 会按高度自动夹成胶囊）。
          ⚠️ 它渲染的是 <button>，所以导航走 onClick + navigate，不再是 <a>；
          代价是右键「新标签打开」不再可用（首页 CTA 影响很小，接受）。 */}
      <div className="hp-actions">
        <SpecularButton size="md" radius={999} tint="#ffffff" tintOpacity={0.94} textColor="#0b0b0d" lineColor="#ffffff" baseColor="#9a9aa2" intensity={1.1} shineSize={17} shineFade={40} thickness={1} speed={0.7} followMouse proximity={250} autoAnimate onClick={() => navigate('/demo')}>联系我们</SpecularButton>
        <SpecularButton size="md" radius={999} tint="#ffffff" tintOpacity={0.08} blur={8} textColor="#ffffff" lineColor="#ffffff" baseColor="#6f6f78" intensity={0.85} shineSize={14} shineFade={45} thickness={1} speed={0.55} followMouse proximity={250} onClick={() => navigate('/marketplace')}>查看课程</SpecularButton>
      </div>
    </section>
    {stats.length ? <section className="hp-stats" aria-label="平台数据">{stats.map((item, index) => <div className="hp-stat" key={index + '-' + (item.label || '')}><i>{item.icon || '✦'}</i><strong><StatValue value={item.value} suffix={item.suffix || ''} /></strong><span>{item.label || ''}</span></div>)}</section> : null}
  </main>;
}
function Home(_props) { return <HomeLanding />; }
function CTA(){return <section className="cta"><div><Kicker>准备好把 AI 课开起来了吗？</Kicker><h2>让每个孩子<br/><em>用 AI 做出自己的作品</em></h2><p>获取演示账号与示范课包清单。</p></div><Button>联系我们</Button></section>}

function Org(){const faqCms=useWebsiteContent('FAQ');const modules=[['机构账号','管理员、教师、学员分级；学员无需自备 API Key','课堂零配置，避免密钥泄露'],['授权次数','按机构开通、按班分给学生；剩余次数不足友好提示','用量可控，适合班级教学'],['课程中心','11 门 / 87 节标准课包；PPT 与 HTML 互动课件','标准化交付，校区可复制'],['管理后台','账号开通、课包浏览、作品发布、用量记录','运营数据透明'],['作品展厅','机构内作品聚合展示与在线预览','成果可视化，利于续费与招新']];return <><Title eyebrow="机构方案" title={<>教培机构如何开<br/><em>青少年 AI 通识课</em></>} desc="平台提供课程、机构账号与用量计费；机构负责招生和教学。8–16 岁学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的作品。"/><main className="inner"><section className="org-intro"><div><i>“</i><h2>不是再找一个聊天网站，<br/>而是一套<span>可管、可教、可展示</span>的课堂产品。</h2><p>学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的游戏、动画、互动故事和硬件作品。</p></div><div className="steps">{[['01','平台开通机构','配置席位、开通授权次数、发布课包权限。'],['02','老师创建学员账号','学生用机构账号登录，即可开始创作。'],['03','按课包授课','从课程中心进入课时，结合阿飞完成当堂作品。'],['04','作品沉淀与展示','优秀作业进入作品社区，形成校区案例库。']].map(x=><div key={x[0]}><b>{x[0]}</b><p><strong>{x[1]}</strong>{x[2]}</p></div>)}</div></section><section className="modules">{modules.map((m,i)=><article key={m[0]}><small>0{i+1}</small><h3>{m[0]}</h3><p>{m[1]}</p><b>{m[2]}</b></article>)}</section><section className="faq"><div><Kicker>常见问题</Kicker><h2>{faqCms.data?.title||'开课前，你可能想知道'}</h2></div><div>{(faqCms.data?.items||[['需要学员自备 API Key 或对话平台账号？','不需要。机构账号登录即可使用平台统一模型能力，学生不持有 API Key，机构用授权次数管理课堂用量。'],['机房和教室的电脑都能用吗？','可以。课堂通过浏览器访问，Chrome / Edge 最新版本即可，机房不需要额外安装环境。'],['能否做 Arduino 和 micro:bit 硬件课？','支持 Arduino Uno 一键烧录，以及 micro:bit 的 MicroPython 上传与串口监视。']].map((item)=>({question:item[0],answer:item[1]}))).map((item,i)=><details key={item.question} open={i===0}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div></section><End title="让你的校区拥有一门可复制的 AI 课" text="联系我们，获取试用账号与示范课包清单。"/></main></>}
function Works(){
  const [items,setItems]=useState(FALLBACK_WORKS.map(w=>({title:w[1],description:w[3],studentName:'小创作者',emoji:w[0]})));
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState(null);
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
  return <><Title eyebrow="学员作品" title={<>孩子们的灵感，<em>正在发光</em></>} desc="来自课堂与作品社区的真实 HTML 创作。点击卡片即可打开体验，游戏、古诗、3D、单词闯关都能在浏览器里直接玩。"/><main className="inner"><div className="filters"><b>全部作品</b><span>小游戏</span><span>互动故事</span><span>AI 绘本</span><span>智能硬件</span></div><div className="works all">{items.map((w,i)=><Work key={w.id||w.title} work={w} index={i}/>)}</div>{!loaded&&<div className="note">✦ <p>正在加载作品…</p></div>}{loaded&&items.length===0&&<div className="note">✦ <p>{error||'暂无公开作品，学生可在作品页开启公开后展示。'}</p></div>}<div className="note">✦ <div><b>作品来自真实课堂</b><p>每一份作品都记录着孩子从想法、对话到实现的创作过程。机构开通后，可拥有自己的校区作品展厅。</p></div><Button soft to="/org">了解机构作品展厅</Button></div></main></>;
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
function Faq() {
  const cms = useWebsiteContent('FAQ');
  const content = cms.data || {};
  const items = cmsList(content.items);
  // ⚠️ 页头与区块**不要都渲染 CMS 标题**：那样同一句话会在首屏出现两遍（2026-09-18 真浏览器实测到）。
  // 页头说页面名（常见问题），区块说这组问答自己的名字（CMS 的 title）。
  return <><Title eyebrow="帮助中心" title="常见问题" desc="开课前、上课中、课后最常被问到的事，都在这里。" /><main className="inner faq-page"><section className="faq"><div><h2>{content.title || '常见问题'}</h2><p className="faq-note">没有找到答案？<Link to="/demo">联系我们</Link>，我们按你的班型回答。</p></div><div>{items.map((item, index) => <details key={item.question || index} open={index === 0}><summary>{item.question || ''}</summary><p>{item.answer || ''}</p></details>)}</div></section><End title="把 AI 课开起来" text="联系我们，获取演示账号与示范课包清单。" /></main></>;
}
function Compare(){const rows=[['工具形态','多个网站 / App 来回切换','同一个工作台里完成：对话 + 预览 + 项目文件'],['课程交付','机构自建教案，平台不管课','课程中心标准课包，课时与课件一体'],['账号与安全','学生自备账号 / API Key，易泄露','机构账号分级，学员无需自备 Key'],['成本控制','个人账号各买各的，月底才知道超支','机构授权次数按班分配，用量有记录和提醒'],['成果沉淀','作业散落在群聊和个人电脑','作品展厅聚合展示，形成校区案例库'],['硬件实践','外部工具和环境另行配置','Arduino / micro:bit 软硬一体课程']];return <><Title eyebrow="选型对比" title={<>为什么不是<br/><em>再找个对话平台</em>？</>} desc="机构评估 AI 课程时，真正要比较的不是一个聊天框，而是一套能不能长期交付的课堂产品。"/><main className="inner"><section className="compare"><div className="compare-head"><span>对比维度</span><span>分散拼凑</span><b>{BRAND_NAME}</b></div>{rows.map(r=><div key={r[0]}><strong>{r[0]}</strong><span>{r[1]}</span><b>✓ {r[2]}</b></div>)}</section><section className="compare-end"><div><small>一句话总结</small><h2>把「创作、课程、账号、计费、作品」<em>统一起来</em>。</h2></div><Button>联系我们</Button></section></main></>}
// 官网公开端的内容兜底：公开接口不可用、或后台还没发布过该区块时，官网仍要有东西可看。
// 键必须与后台「官网内容」的白名单一致（apps/admin/src/shared.jsx 的 WEBSITE_CONTENT_LABELS）。
// ⚠️ 这里只放**精简可用**的文案；对外那份丰富内容存在数据库（website_contents）里，由后台维护，
// 所以「改内容」应该去后台改，而不是改这个 fallback（改了也只影响接口挂掉时的显示）。
const CMS_FALLBACK = {
  HOME: { heroKicker: '教培机构青少年 AI 开课平台', heroTitle: '给机构一套', heroAccent: '能落地的青少年 AI 课', heroDescription: BRAND_NAME + '把课程、机构账号、授权次数与作品展厅放在一个平台里。', trustTitle: '响应教育部「做中学」领航行动', trustDescription: '真实问题 · 项目式探究 · 每节课都有作品' },
  FAQ: { title: '开课前，你可能想知道', items: [{ question: '需要学员自备 API Key 或对话平台账号吗？', answer: '不需要。机构账号登录即可使用平台统一模型能力，学生不持有 API Key，机构用授权次数管理课堂用量。' }, { question: '机房和教室的电脑都能用吗？', answer: '可以。课堂通过浏览器访问，Chrome / Edge 最新版本即可，机房不需要额外安装环境。' }, { question: '能否做 Arduino 和 micro:bit 硬件课？', answer: '支持 Arduino Uno 一键烧录，以及 micro:bit 的 MicroPython 上传与串口监视。' }] },
  INTRO: { title: '灵动介绍', lead: BRAND_NAME + '是面向 8–16 岁的 AI 创作开课平台：学生用中文与 AI 伙伴「阿飞」对话，当堂做出能运行、能展示的作品。', highlights: [], sections: [], cta: { title: '把 AI 课开起来', text: '联系我们，我们会按你的班型给出课包与开通方案。' } },
  HANDBOOK: { title: '机构合作手册', lead: '把「一门 AI 课」变成能复制的校区产品：课程、账号、授权次数与作品沉淀在同一套平台里。', sections: [], compareRows: [], cta: { title: '获取完整机构手册', text: '先联系我们，我们会把最新版本、课件示例与合作说明发给你。' } },
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
  const [items,setItems]=useState([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  const [filters,setFilters]=useState({difficulty:'',ageMin:'',ageMax:'',tag:'',search:'',sort:'popular',category:''});
  const limit=20;
  const difficultyOptions=[{label:'全部',value:''},{label:'1-2',value:'1'},{label:'3',value:'3'},{label:'4-5',value:'4'}];
  const ageOptions=[{label:'全部',value:'',ageMin:'',ageMax:''},{label:'6-8岁',value:'age6-8',ageMin:'6',ageMax:'8'},{label:'9-12岁',value:'age9-12',ageMin:'9',ageMax:'12'},{label:'13+岁',value:'age13plus',ageMin:'13',ageMax:''}];
  const [activeAge,setActiveAge]=useState('');
  const [allTags,setAllTags]=useState([]);
  const buildParams=()=>{
    const p=new URLSearchParams();
    if(filters.difficulty) p.set('difficulty',filters.difficulty);
    const ageOpt=ageOptions.find(o=>o.value===activeAge);
    if(ageOpt){if(ageOpt.ageMin) p.set('ageMin',ageOpt.ageMin);if(ageOpt.ageMax) p.set('ageMax',ageOpt.ageMax);}
    if(filters.tag) p.set('tag',filters.tag);
    if(filters.category) p.set('category',filters.category);
    if(filters.search) p.set('search',filters.search);
    p.set('sort',filters.sort);
    p.set('page',page);
    p.set('limit',limit);
    return p;
  };
  useEffect(()=>{let live=true;setLoading(true);setError(null);
    publicApi.get('public/marketplace?'+buildParams())
      .then((j)=>{if(live){const d=j||{};setItems(d.items||[]);setTotal(d.total||0);setLoading(false);
        if(d.items){const tags=new Set();d.items.forEach(item=>{(item.tags||[]).forEach(t=>tags.add(t));});setAllTags(Array.from(tags));}
      }})
      .catch(e=>{if(live){setError(e.message);setLoading(false);}});
    return()=>{live=false};
  },[filters,page]);
  const totalPages=Math.ceil(total/limit)||1;
  return <><Title eyebrow="课程广场" title={<>发现优质<em>AI 编程课程</em></>} desc="平台已发布的课程都会自动出现在这里，分为画布课程与 VibeCoding 课程两类，涵盖 AI 创作、游戏设计与互动故事。"/><main className="inner">
    <div className="mkt-filters">
      <div className="mkt-row"><span className="mkt-label">课程类型</span><div className="mkt-chips">{[{label:'全部课程',value:''},{label:'画布课程',value:'CANVAS'},{label:'VibeCoding 课程',value:'VIBECODING'}].map(o=><button type="button" key={o.value||'all'} aria-pressed={filters.category===o.value} className={'mkt-chip'+(filters.category===o.value?' on':'')} onClick={()=>{setFilters(f=>({...f,category:o.value}));setPage(1);}}>{o.label}</button>)}</div></div>
      <div className="mkt-row"><span className="mkt-label">难度</span><div className="mkt-chips">{difficultyOptions.map(o=><button type="button" key={o.value} aria-pressed={filters.difficulty===o.value} className={'mkt-chip'+(filters.difficulty===o.value?' on':'')} onClick={()=>{setFilters(f=>({...f,difficulty:o.value}));setPage(1);}}>{o.label}</button>)}</div></div>
      <div className="mkt-row"><span className="mkt-label">适学年龄</span><div className="mkt-chips">{ageOptions.map(o=><button type="button" key={o.value} aria-pressed={activeAge===o.value} className={'mkt-chip'+(activeAge===o.value?' on':'')} onClick={()=>{setActiveAge(activeAge===o.value?'':o.value);setPage(1);}}>{o.label}</button>)}</div></div>
      {allTags.length>0&&<div className="mkt-row"><span className="mkt-label">标签</span><div className="mkt-chips">{allTags.slice(0,12).map(t=><button type="button" key={t} aria-pressed={filters.tag===t} className={'mkt-chip small'+(filters.tag===t?' on':'')} onClick={()=>{setFilters(f=>({...f,tag:f.tag===t?'':t}));setPage(1);}}>{t}</button>)}</div></div>}
      <div className="mkt-row"><span className="mkt-label">排序</span><div className="mkt-chips"><button type="button" aria-pressed={filters.sort==='popular'} className={'mkt-chip'+(filters.sort==='popular'?' on':'')} onClick={()=>{setFilters(f=>({...f,sort:'popular'}));setPage(1);}}>综合推荐</button><button type="button" aria-pressed={filters.sort==='recent'} className={'mkt-chip'+(filters.sort==='recent'?' on':'')} onClick={()=>{setFilters(f=>({...f,sort:'recent'}));setPage(1);}}>最新上线</button></div></div>
      <div className="mkt-search"><label className="sr-only" htmlFor="marketplace-search">搜索课程名称</label><input id="marketplace-search" placeholder="搜索课程名称…" value={filters.search} onChange={e=>{setFilters(f=>({...f,search:e.target.value}));setPage(1);}}/><button type="button" aria-label="重置课程筛选" onClick={()=>{setFilters(f=>({...f,search:'',difficulty:'',tag:'',sort:'popular'}));setActiveAge('');setPage(1);}} className="mkt-reset">重置</button></div>
    </div>
    {loading?<div className="mkt-grid">{Array.from({length:8},(_,i)=><div key={i} className="mkt-skeleton"/>)}</div>:
     error?<div className="note">⚠ <div><b>加载失败</b><p>{error}</p></div></div>:
     items.length===0?<div className="note">✦ <div><b>暂无课程，敬请期待</b><p>课程广场将陆续上线优质 AI 编程课程。</p></div></div>:
     <><div className="mkt-grid">{items.map(item=><Link key={item.id} to={'/marketplace/'+item.id} className="mkt-card">
       <div className="mkt-cover" style={(item.coverAssetId || item.coverImageUrl)?{backgroundImage:'url('+(item.coverAssetId ? '/api/public/file-assets/'+item.coverAssetId+'/download' : item.coverImageUrl)+')'}:{}}>{!item.coverAssetId && !item.coverImageUrl&&<span>{item.title?.charAt(0)||'课'}</span>}</div>
       <div className="mkt-body"><h3>{item.title}</h3>
         <span className="mkt-tag">{item.deliveryMode==='VIBECODING'?'VibeCoding 课程':'画布课程'}</span>
         <div className="mkt-meta"><DifficultyStars level={item.difficultyLevel}/>{ageLabel(item.ageRangeMin,item.ageRangeMax)?<span className="mkt-age">{ageLabel(item.ageRangeMin,item.ageRangeMax)}</span>:null}</div>
         {(item.tags||[]).slice(0,3).map(t=><span key={t} className="mkt-tag">{t}</span>)}
         {(item.tags||[]).length>3&&<span className="mkt-tag-more">+{item.tags.length-3}</span>}
       </div>
     </Link>)}</div>
     {totalPages>1&&<div className="mkt-pages"><button type="button" disabled={page<=1} aria-label="上一页" onClick={()=>setPage(p=>p-1)}>上一页</button><span>{page} / {totalPages}</span><button type="button" disabled={page>=totalPages} aria-label="下一页" onClick={()=>setPage(p=>p+1)}>下一页</button></div>}
     </>}
  </main></>;
}

function MarketplaceDetail(){
  const params=new URLSearchParams(window.location.search);
  const pathParts=window.location.pathname.split('/');
  const id=pathParts[pathParts.length-1];
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  function startLearning(){
    const session=readUserSession();
    if(!session){window.location.href='/login';return;}
    if(session.user?.role==='STUDENT') window.location.href='/learn';
    else window.location.href='/demo';
  }
  useEffect(()=>{let live=true;
    publicApi.get('public/marketplace/'+id)
      .then((j)=>{if(live){setData(j||null);setLoading(false);}})
      .catch(e=>{if(live){setError(e.message);setLoading(false);}});
    return()=>{live=false};
  },[id]);
  if(loading) return <><Title eyebrow="课程详情" title={<>加载中…</>} desc=""/><main className="inner"><div className="mkt-grid">{Array.from({length:4},(_,i)=><div key={i} className="mkt-skeleton"/>)}</div></main></>;
  if(error) return <><Title eyebrow="课程详情" title={<>未找到</>} desc={error}/><main className="inner"><div className="note">⚠ <div><b>无法加载课程</b><p>{error}</p></div><Link to="/marketplace" className="button" style={{marginTop:'20px'}}>返回课程广场</Link></div></main></>;
  const d=data;
  return <><Title eyebrow="课程广场" title={<>{d.title}</>} desc={d.description||''}/>
  <main className="inner">
    <Link to="/marketplace" className="back-link">← 返回课程广场</Link>
    <div className="mkt-detail">
      {(d.coverAssetId || d.coverImageUrl)&&<div className="mkt-detail-cover" role="img" aria-label={`${d.title || '课程'}封面`} style={{backgroundImage:'url('+(d.coverAssetId ? '/api/public/file-assets/'+d.coverAssetId+'/download' : d.coverImageUrl)+')'}}/>}
      <div className="mkt-detail-info">
        <div className="mkt-detail-row"><span className="mkt-label2">难度</span><DifficultyStars level={d.difficultyLevel}/></div>
        <div className="mkt-detail-row"><span className="mkt-label2">适学年龄</span><span>{ageLabel(d.ageRangeMin,d.ageRangeMax)||'未设置'}</span></div>
        {(d.tags||[]).length>0&&<div className="mkt-detail-row"><span className="mkt-label2">标签</span><div className="mkt-chips">{(d.tags||[]).map(t=><span key={t} className="mkt-tag">{t}</span>)}</div></div>}
        {d.version&&<div className="mkt-detail-row"><span className="mkt-label2">版本</span><span>{d.version}</span></div>}
        <div className="mkt-detail-row"><span className="mkt-label2">课时</span><span>{d.lessonCount||0} 节</span></div>
        {d.priceFen>0&&<div className="mkt-detail-row"><span className="mkt-label2">参考价格</span><span className="mkt-price">¥ {(d.priceFen/100).toFixed(2)} <span className="mkt-price-note">（线下购买）</span></span></div>}
      </div>
    </div>
    {(d.lessons||[]).length>0&&<div className="mkt-lessons"><h2>课程内容</h2>{(d.lessons||[]).map((l,i)=><div key={l.id} className="mkt-lesson"><div className="mkt-lesson-num">{String(i+1).padStart(2,'0')}</div><div className="mkt-lesson-body"><h3>{l.title}</h3>{l.summary&&<p className="mkt-lesson-summary">{l.summary}</p>}{l.lessonContent&&<p className="mkt-lesson-content">{String(l.lessonContent).slice(0,300)}{l.lessonContent&&l.lessonContent.length>300?'…':''}</p>}</div></div>)}</div>}
    <div className="mkt-cta">
      <button className="button mkt-start" onClick={startLearning}>开始学习</button>
      {d.priceFen>0&&<p className="mkt-contact-note">如需购买课程包，请联系客服办理</p>}
    </div>
  </main></>;
}
function End({title,text}){return <section className="end"><h2>{title}</h2><p>{text}</p><Button>联系我们 · 开通试用</Button></section>}
// 官网匿名统计（含同意横幅与埋点）已按用户要求**彻底删除**（2026-09-16）：
// 前端不再有任何上报入口，服务端的接收端点与平台端「官网转化」看板也一并下线，只保留历史表与数据。
function LearnPageInner({ api }) {
  // 以课程为先：先选课包，再选这一节课；上课形式由课包/这节课决定，学生不选。
  return <main className='learn-page-shell'><StudentCourseCenter api={api} onEnterCanvas={(id) => { window.location.assign('/learn/canvas/' + id); }} /></main>;
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
  if (loc.pathname.startsWith('/learn') && !session) {
    return <Navigate to='/login' replace />;
  }
  const roleBadge = { STUDENT: '小小创作者', TEACHER: '教师', ORG_ADMIN: '机构管理员', SUPER_ADMIN: '平台管理员', PLATFORM_ADMIN: '平台管理员' };
  // 学生用户下拉菜单（showStudentMenu 这个 state 在上面统一声明，必须在提前 return 之前）
  const studentMenuItems = [
    { to: '/learn', icon: '🎨', label: '进入学习' },
    { to: '/my-works', icon: '✧', label: '我的作品' },
    { to: '/my-courses', icon: '◇', label: '我的课程' },
    { to: '/my-stats', icon: '◈', label: '学习统计' },
  ];
  
  const userBadge = session ? (
    session.user?.role === 'STUDENT' ? (
      <div className='header-user-menu'>
        <button className='header-user' onClick={() => setShowStudentMenu(!showStudentMenu)}>
          <span>{session.user?.displayName || session.user?.login || '用户'}</span>
          <span className='role-tag'>{roleBadge[session.user?.role]}</span>
          <span className='dropdown-arrow'>{showStudentMenu ? '▲' : '▼'}</span>
        </button>
        {showStudentMenu && (
          <div className='student-dropdown-menu'>
            {studentMenuItems.map(item => (
              <Link key={item.to} to={item.to} className='menu-item' onClick={() => setShowStudentMenu(false)}>
                <span className='menu-icon'>{item.icon}</span>
                <span className='menu-label'>{item.label}</span>
              </Link>
            ))}
            <div className='menu-divider'></div>
            <button className='menu-item logout-item' onClick={() => { setShowStudentMenu(false); logout(); }}>
              <span className='menu-icon'>🚪</span>
              <span className='menu-label'>退出登录</span>
            </button>
          </div>
        )}
      </div>
    ) : (
      <span className='header-user'>
        <span>{session.user?.displayName || session.user?.login || '用户'}</span>
        <span className='role-tag'>{roleBadge[session.user?.role] || session.user?.role}</span>
        <button className='text-button' onClick={logout}>退出</button>
      </span>
    )
  ) : <AuthEntries/>;
  if (loc.pathname === '/login') return <LoginPage/>;
  const isFullPage = loc.pathname.startsWith('/learn');
  return (
    <div className='site'>
      {INTERNAL_TEST && <div className='internal-test-banner' role='status'>内部测试环境 · 不代表正式服务</div>}
      {!isFullPage && <Header userBadge={userBadge} />}
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
        <Route path='/my-works' element={session ? <MyWorksPage api={api} /> : <Navigate to='/login' replace />}/>
        <Route path='/my-courses' element={session ? <MyCoursesPage api={api} /> : <Navigate to='/login' replace />}/>
        <Route path='/my-courses/:courseId' element={session ? <CourseDetailPage api={api} /> : <Navigate to='/login' replace />}/>
        <Route path='/my-stats' element={session ? <MyStatsPage api={api} /> : <Navigate to='/login' replace />}/>
        <Route path='*' element={<Home/>}/>
      </Routes>
      {!isFullPage && loc.pathname !== '/' && <Footer/>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
