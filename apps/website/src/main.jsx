import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import '@platform/shared/styles.css';
import './styles.css';
import { LEGAL_DOCUMENTS, LEGAL_EFFECTIVE_DATE, LEGAL_OWNER, LEGAL_STATUS, LEGAL_VERSION } from './legal.js';
import { getAnalyticsConsent, setAnalyticsConsent, trackAnalytics } from './analytics.js';
import { LoginPanel, CanvasClassroom, CanvasWorkspace, LearnEntry, Notice, VibeCodingClassroom, VibeCodingWorkspace, createApiClient, readSession as readUserSession, writeSession as saveUserSession, clearSession as removeUserSession } from '@platform/shared';
import { MyCreditsPage } from './pages/MyCredits.jsx';
import { MyWorksPage } from './pages/MyWorks.jsx';
import { MyCoursesPage } from './pages/MyCourses.jsx';
import { MyStatsPage } from './pages/MyStats.jsx';
import { WorkDetailPage } from './pages/WorkDetail.jsx';

// 官网公开页面统一走共享 API client，保持错误解析与鉴权行为一致
const publicApi = createApiClient();

function LoginPage() {
  async function handleLogin({ login, password }) {
    let session;
    try {
      const data = await publicApi.post('auth/login', { login, password });
      session = saveUserSession(data);
    } catch (err) {
      throw new Error(err.message || '登录失败');
    }
    const role = session.user?.role;
    // 学生登录后返回官网首页，不再跳转到 /learn
    const target = role === 'STUDENT' ? '/' : role === 'TEACHER' || role === 'ORG_ADMIN' ? '/' : role === 'SUPER_ADMIN' || role === 'PLATFORM_ADMIN' ? '/admin/' : '/';
    window.location.assign(target);
  }
  return <div className='website-login'><Link className='login-back' to='/'>← 返回官网首页</Link><LoginPanel title='登录' description='使用机构分配的账号进入你的工作台。' onLogin={handleLogin} demos={[]} /></div>;
}

const ORG_APP_URL = import.meta.env?.VITE_ORG_APP_URL || '/org/';
const INTERNAL_TEST = import.meta.env?.VITE_DEPLOYMENT_MODE === 'internal-test';

const FALLBACK_WORKS=[['🫧','点泡泡','小游戏','30 秒内点爆所有泡泡，节奏轻快的点击小游戏。'],['🍂','山行 · 杜牧','语文互动','朗读、探索与闯关结合，把古诗学成可玩的互动课。'],['🧩','C++ 代码大冒险','编程启蒙','积木拼程序，边玩边看 3D 执行过程与代码。'],['🧱','我的世界 · 简化版','沙盒创意','浏览器里搭方块世界，保存自己的创意地图。']];


function Logo(){return <Link className="logo" to="/"><i>✦</i>AI魔法学院</Link>}
function Header({ user, userBadge }){
  const loc=useLocation();
  const nav=[['/','首页'],['/learn','学习上课'],['/marketplace','课程广场'],['/works','作品广场']];
  return <header><div className="bar"><Logo/><nav aria-label="主导航">{nav.map(([to,n])=><NavLink key={to} to={to} className={({isActive})=>isActive&&(to!=='/'||loc.pathname==='/')?'on':''}>{n}</NavLink>)}</nav><div className="head-actions"><Link className="top-button" to="/demo">预约演示 <b>↗</b></Link>{userBadge}</div></div></header>;
}
function Footer(){return <footer><div className="foot"><div><Logo/><p>面向教培机构与学校的<br/>青少年 AI 通识与 VibeCoding 开课平台。</p></div><div><strong>产品</strong><Link to="/marketplace">课程广场</Link><Link to="/org">机构方案</Link><Link to="/works">学员作品</Link></div><div><strong>合作</strong><Link to="/demo">预约演示</Link><a href={ORG_APP_URL}>机构后台</a></div><div><strong>了解更多</strong><Link to="/handbook">产品手册</Link><Link to="/compare">选型对比</Link><Link to="/terms">用户协议</Link><Link to="/privacy">隐私政策</Link><Link to="/minors">儿童 / 未成年人说明</Link><a href="mailto:hello@aimagc.cn">联系合作</a></div></div><div className="copyright">© 2026 五格殿下 · AI魔法学院 <span>面向 8–16 岁 · 浏览器即用</span></div></footer>}
function Button({children,to='/demo',soft=false}){return <Link onClick={()=>trackAnalytics('cta_click',{target:to})} to={to} className={'button '+(soft?'soft':'')}>{children}<b>↗</b></Link>}
function Kicker({children}){return <div className="kicker">✦ {children}</div>}
function Work({work,index=0}){const navigate=useNavigate();const url=work.publicUrl||(work.shareToken?'/works/'+work.shareToken:null);const emoji=work.canvasSnapshot?.nodes?.[0]?.data?.emoji||work.emoji||'✦';const title=work.title;const desc=work.description;const student=work.studentName||'小创作者';const isVibe=work.type==='VIBECODING';return <article className={'work w'+index%6}><div className="art"><span>{isVibe?'🎮':emoji}</span><i>✦</i><b>AI</b></div><div className="work-body"><small>{student}{isVibe?' · 可在线玩':''}</small><h3>{title}</h3><p>{desc}</p><button type="button" aria-label={`打开作品：${title}`} onClick={()=>{if(url){trackAnalytics('work_view',{resourceType:'work'});navigate(url);}}}>打开体验 <b>↗</b></button></div></article>}
function Title({eyebrow,title,desc}){return <section className="page-title"><div><Kicker>{eyebrow}</Kicker><h1>{title}</h1><p>{desc}</p></div></section>}


const IC_NAV = [
  { id: 'hero', label: '首页', progress: 0 },
  { id: 'projects', label: '课程', progress: 0.28 },
  { id: 'expertise', label: '方法', progress: 0.52 },
  { id: 'about', label: '关于', progress: 0.95 },
  { id: 'contact', label: '预约演示', progress: 3.5 },
];
const DRUM_LINES = [
  '欢迎进入 [AI 创作课堂]','这里有 [真实问题]、[创作灵感]','和 [能被看见的作品]，等你完成','我们不追逐 [标准答案]','而是让 [好奇心] 先出发','让 [中文对话] 变成可运行的想法','让每一次 [尝试] 都留下痕迹','让每一节课都有 [作品交付]','从 [故事]、[游戏]、[动画]','到 [智能硬件] 与 [互动网页]','孩子拥有完整的 [创作闭环]','老师拥有清晰的 [课堂节奏]','机构拥有可复制的 [课程产品]','家长看见持续发生的 [成长]','在这里，学习不是 [旁观]','', '这是 [AI 魔法学院]','给 8–16 岁孩子的 [创作入口]','用 [项目式学习] 替代机械练习','用 [VibeCoding] 点亮编程兴趣','用 [阿飞] 陪伴每一次提问','把复杂技术变成 [可理解的步骤]','把零散灵感变成 [完整的作品]','把一次体验沉淀为 [长期能力]','我们相信 [做中学] 才会真正发生','我们相信 [表达] 本身就是创造','我们相信孩子值得 [更好的工具]','让老师轻松开课，专注 [陪伴]','让机构稳定交付，持续 [扩展]','让每个孩子都能 [发布自己的作品]','现在，就从一个 [想法] 开始','[一起把灵感做出来]。',
];
function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function easeInOutCubic(value) { return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2; }
function updateInnerSection(progress) { if (progress < 0.18) return 'hero'; if (progress < 0.45) return 'projects'; if (progress < 0.68) return 'expertise'; if (progress < 1.15) return 'about'; return 'contact'; }
function InnerCircleLogo({ onClick }) { return <button type="button" className="ic-logo" onClick={onClick} aria-label="回到首页"><span className="ic-logo-mark">✦</span><span><b>AI 魔法学院</b><small>INNER CIRCLE / 创作课堂</small></span></button>; }
const WEBSITE_NAV = [['/', '首页'], ['/learn', '学习上课'], ['/marketplace', '课程广场'], ['/works', '作品广场']];
function InnerCircleHeader({ userBadge, session, logout }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // 学生下拉菜单的开关必须在这里声明：下面 finalUserBadge 的「学生分支」要用它，
  // 漏了这行 → 学生登录状态打开首页时 ReferenceError: showStudentMenu is not defined → 整页白屏。
  const [showStudentMenu, setShowStudentMenu] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  
  // 学生用户下拉菜单（在 InnerCircle 首页也需要）
  const studentMenuItems = [
    { to: '/learn', icon: '🎨', label: '进入学习' },
    { to: '/my-works', icon: '✧', label: '我的作品' },
    { to: '/my-credits', icon: '◆', label: '我的积分' },
    { to: '/my-courses', icon: '◇', label: '我的课程' },
    { to: '/my-stats', icon: '◈', label: '学习统计' },
  ];
  
  const roleBadge = { STUDENT: '小小创作者', TEACHER: '教师', ORG_ADMIN: '机构管理员', SUPER_ADMIN: '平台管理员', PLATFORM_ADMIN: '平台管理员' };
  
  const finalUserBadge = session ? (
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
  ) : <Link className='top-button' to='/login'>登录</Link>;
  
  return <><header className="ic-header"><InnerCircleLogo onClick={closeMenu} /><p className="ic-subtitle">Full Workflow for Kids.<br />We Make Everything. You<br />Unwind.</p><nav className="ic-nav" aria-label="主导航">{WEBSITE_NAV.map(([to, label]) => <Link key={to} to={to} className={to === '/' ? 'active' : ''}>{label}</Link>)}</nav><div className="ic-auth">{finalUserBadge}</div><button type="button" className="ic-menu-trigger" aria-label={menuOpen ? '关闭菜单' : '打开菜单'} aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}>{menuOpen ? '×' : '☰'}</button></header>{menuOpen && <div className="ic-menu-overlay"><div className="ic-menu-head"><span>AI MAGIC CIRCLE</span><button type="button" onClick={closeMenu}>关闭 ×</button></div><div className="ic-menu-items">{WEBSITE_NAV.map(([to, label]) => <Link key={to} to={to} className={to === '/' ? 'active' : ''} onClick={closeMenu}>{label}<span>↗</span></Link>)}</div><div className="ic-menu-login">{finalUserBadge}</div><p>让孩子从灵感进入作品<br />让机构拥有一套能落地的 AI 课</p></div>}</>;
}
function ScrubVideo({ src, progress, variant = 'hero', poster, autoplay = false }) {
  const videoRef = useRef(null); const currentTimeRef = useRef(0); const durationRef = useRef(4.2); const [status, setStatus] = useState('loading');
  useEffect(() => {
    const video = videoRef.current; if (!video) return undefined;
    let active = true;
    const ready = () => {
      if (!active) return;
      if (Number.isFinite(video.duration) && video.duration > 0) durationRef.current = video.duration;
      setStatus('ready');
    };
    const failed = () => { if (active) setStatus('fallback'); };
    const timeout = window.setTimeout(failed, 3500);
    video.addEventListener('loadedmetadata', ready); video.addEventListener('loadeddata', ready); video.addEventListener('canplay', ready);
    video.addEventListener('error', failed); video.addEventListener('abort', failed);
    if (video.readyState >= 1) ready();
    return () => { active = false; window.clearTimeout(timeout); video.removeEventListener('loadedmetadata', ready); video.removeEventListener('loadeddata', ready); video.removeEventListener('canplay', ready); video.removeEventListener('error', failed); video.removeEventListener('abort', failed); };
  }, [src]);
  useEffect(() => { if (autoplay) return undefined; const video = videoRef.current; if (!video) return undefined; let active = true; let frame; const tick = () => { if (!active) return; const target = clamp01(progress) * durationRef.current; currentTimeRef.current += (target - currentTimeRef.current) * 0.15; if (status === 'ready' && !video.seeking && Math.abs(video.currentTime - currentTimeRef.current) > 0.01) { try { video.currentTime = currentTimeRef.current; } catch {} } frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick); return () => { active = false; cancelAnimationFrame(frame); }; }, [autoplay, progress, status]);
  return <div className={'ic-video-wrap ic-video-' + variant + ' ic-video-status-' + status}>{variant === 'hero' && <div className="ic-video-fallback" aria-hidden="true"><span /><i>✦</i><b>AI MAGIC CIRCLE</b></div>}{poster && <img className={'ic-video-poster ' + (status === 'ready' ? 'is-hidden' : '')} src={poster} alt="" aria-hidden="true" />}{<video ref={videoRef} className={'ic-scrub-video ' + (status === 'ready' ? 'is-ready' : '')} src={src} poster={poster} autoPlay={autoplay} loop={autoplay} playsInline muted preload={autoplay ? 'auto' : 'metadata'} aria-hidden="true" />}</div>;
}

function ScrollExitTitle({ progress }) { return <h1 className="ic-hero-title" aria-label="AI Magic Circle">{'AI MAGIC CIRCLE'.split('').map((char, index) => char === ' ' ? <span className="ic-title-space" key={index} /> : <span key={index} className="ic-title-char" style={{ '--exit': clamp01(progress), '--char-delay': (index * 0.03) + 's' }}>{char}</span>)}</h1>; }
function SoapTiles({ progress }) {
  const [hovered, setHovered] = useState(-1); const entry = clamp01((progress - 0.75) / 0.22); const labels = [['课程与教研', '11 门系统课包 · 可复制交付'], ['课堂实时预览', '中文对话 · 当堂见作品'], ['作品长期沉淀', '展厅展示 · 成长可感知']];
  return <div className={'ic-soap-tiles ' + (entry > 0 ? 'is-visible' : '')}>{labels.map(([title, desc], index) => { const shift = hovered >= 0 && hovered !== index ? (index < hovered ? -13.8 : 13.8) : 0; const offset = [120, 180, 240][index] * (window.innerWidth < 768 ? 0.25 : 1); return <button type="button" key={title} className={'ic-soap-tile ' + (hovered === index ? 'is-hovered' : '')} onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(-1)} style={{ '--entry-x': ((entry - 1) * offset) + 'px', '--hover-y': shift + 'px', '--entry-opacity': entry }}>{title}<span>{desc}</span></button>; })}</div>;
}
function parseDrumLine(line) { if (!line) return [{ text: '\u00a0', highlight: false }]; const parts = []; let cursor = 0; const pattern = /\[([^\]]+)\]/g; let match; while ((match = pattern.exec(line))) { if (match.index > cursor) parts.push({ text: line.slice(cursor, match.index), highlight: false }); parts.push({ text: match[1], highlight: true }); cursor = match.index + match[0].length; } if (cursor < line.length) parts.push({ text: line.slice(cursor), highlight: false }); return parts; }
function CylindricalDrum({ progress }) { const targetIndex = clamp01((progress - 1.45) / 2.05) * (DRUM_LINES.length - 1); return <div className="ic-drum"><div className="ic-drum-inner">{DRUM_LINES.map((line, index) => { const diff = index - targetIndex; const translateY = diff * 32; const angle = translateY / 380; const z = Math.cos(angle) * 380 - 380; const scale = 0.78 + Math.cos(angle) * 0.22; const opacity = Math.max(0, (Math.cos(angle) - 0.2) / 0.8); const blur = Math.min(8, Math.max(0, (Math.abs(diff) - 1.5) * 0.75)); return <p key={index} style={{ transform: 'translateY(' + translateY + 'px) translateZ(' + z + 'px) rotateX(' + (-angle * 180 / Math.PI * 0.8) + 'deg) scale(' + scale + ')' , opacity: line ? opacity : opacity * 0.3, filter: blur > 0.1 ? 'blur(' + blur + 'px)' : 'none' }}>{parseDrumLine(line).map((part, partIndex) => <span key={partIndex} className={part.highlight ? 'highlight' : ''}>{part.text}</span>)}</p>; })}</div></div>; }
function LogoMarquee() { const marks = ['AI MAGIC ACADEMY', 'VIBECODING', '阿飞 AI', 'PROJECT CLASSROOM', '作品展厅', '机构工作台']; const track = <div className="ic-marquee-track">{[...marks, ...marks].map((mark, index) => <span key={index}>{mark}</span>)}</div>; return <div className="ic-marquee"><div className="ic-marquee-line" /><div className="ic-marquee-window"><div className="ic-marquee-moving">{track}{track}</div></div></div>; }
function InnerCircleHome({ session, logout }) {
  const [scrollProgress, setScrollProgress] = useState(0); const [lerpedProgress, setLerpedProgress] = useState(0); const [activeSection, setActiveSection] = useState('hero'); const targetRef = useRef(0); const animationRef = useRef(null); const touchYRef = useRef(null); const parallaxRef = useRef(null);
  useEffect(() => { const root = document.documentElement; const body = document.body; const oldRootOverflow = root.style.overflow; const oldBodyOverflow = body.style.overflow; root.style.overflow = 'hidden'; body.style.overflow = 'hidden'; let running = true; let current = 0; let frame; const tick = () => { if (!running) return; current += (targetRef.current - current) * 0.08; if (Math.abs(targetRef.current - current) < 0.0001) current = targetRef.current; setLerpedProgress(current); setActiveSection(updateInnerSection(current)); frame = requestAnimationFrame(tick); }; const stopAnimation = () => { if (animationRef.current) { cancelAnimationFrame(animationRef.current); animationRef.current = null; } }; const onWheel = event => { event.preventDefault(); stopAnimation(); targetRef.current = Math.max(0, Math.min(3.5, targetRef.current + event.deltaY * 0.0006)); setScrollProgress(targetRef.current); }; const onTouchStart = event => { stopAnimation(); touchYRef.current = event.touches[0]?.clientY ?? null; }; const onTouchMove = event => { if (touchYRef.current == null) return; event.preventDefault(); const currentY = event.touches[0]?.clientY ?? touchYRef.current; targetRef.current = Math.max(0, Math.min(3.5, targetRef.current + (touchYRef.current - currentY) * 0.0015)); touchYRef.current = currentY; setScrollProgress(targetRef.current); }; const onTouchEnd = () => { touchYRef.current = null; }; const onMouseMove = event => { const mx = event.clientX / window.innerWidth - 0.5; const my = event.clientY / window.innerHeight - 0.5; if (parallaxRef.current) parallaxRef.current.style.transform = 'translate(' + (-mx * 40) + 'px, ' + (-my * 40) + 'px) scale(1.05)'; }; frame = requestAnimationFrame(tick); window.addEventListener('wheel', onWheel, { passive: false }); window.addEventListener('touchstart', onTouchStart, { passive: false }); window.addEventListener('touchmove', onTouchMove, { passive: false }); window.addEventListener('touchend', onTouchEnd); window.addEventListener('mousemove', onMouseMove); return () => { running = false; if (frame) cancelAnimationFrame(frame); stopAnimation(); window.removeEventListener('wheel', onWheel); window.removeEventListener('touchstart', onTouchStart); window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('touchend', onTouchEnd); window.removeEventListener('mousemove', onMouseMove); root.style.overflow = oldRootOverflow; body.style.overflow = oldBodyOverflow; }; }, []);
  const navigate = item => { if (animationRef.current) cancelAnimationFrame(animationRef.current); const from = targetRef.current; const started = performance.now(); const run = now => { const p = Math.min(1, (now - started) / 1200); targetRef.current = from + (item.progress - from) * easeInOutCubic(p); setScrollProgress(targetRef.current); if (p < 1) animationRef.current = requestAnimationFrame(run); else animationRef.current = null; }; animationRef.current = requestAnimationFrame(run); };
  const secondProgress = clamp01((lerpedProgress - 1.15) / 0.5); const rising = 1 - Math.pow(1 - secondProgress, 3); const blur = Math.sin(secondProgress * Math.PI / 2) * 64;
  return <main className="ic-home"><div className="ic-stage"><div className="ic-first-screen" style={{ filter: secondProgress > 0 ? 'blur(' + blur + 'px)' : 'none' }}><div ref={parallaxRef} className="ic-hero-video"><ScrubVideo src="/assets/hero-animal.mp4" poster="/assets/hero-animal-poster.webp" progress={Math.min(1, lerpedProgress)} variant="hero" autoplay /></div><div className="ic-hero-wash" /><div className="ic-hero-copy"><span className="ic-eyebrow">青少年 AI 创作开课平台</span><strong>从灵感进入作品</strong><p>AI 对话、VibeCoding 与项目式课程<br />让孩子当堂做出游戏、动画和智能硬件。</p><div className="ic-hero-actions"><a href="/demo" onClick={() => trackAnalytics('cta_click', { target: '/demo' })}>预约演示 <b>↗</b></a><a href="/marketplace">查看课程 <b>↗</b></a></div></div><div className="ic-title-wrap"><ScrollExitTitle progress={lerpedProgress} /></div><SoapTiles progress={lerpedProgress} /><div className="ic-progress-hint"><span>SCROLL / DRAG</span><i>{String(Math.round(lerpedProgress / 3.5 * 100)).padStart(2, '0')}</i></div></div><InnerCircleHeader session={session} logout={logout} /><div className="ic-second-screen" style={{ transform: 'translateY(' + ((1 - rising) * 100) + '%)', visibility: secondProgress > 0 ? 'visible' : 'hidden' }}><div className="ic-grab" /><div className="ic-second-video"><ScrubVideo src="/assets/hero-animal.mp4" poster="/assets/hero-animal-poster.webp" progress={clamp01((lerpedProgress - 1.45) / 2.05)} variant="second" /></div><div className="ic-second-wash" /><CylindricalDrum progress={lerpedProgress} /><LogoMarquee /><div className="ic-second-caption"><span>02 / MANIFESTO</span><h2>把复杂技术<br /><em>变成孩子的表达。</em></h2><a href="/demo">和我们聊聊你的课堂 ↗</a></div></div></div></main>;
}
function Home({ session, logout }){ return <InnerCircleHome session={session} logout={logout} />; }
function CTA(){return <section className="cta"><div><Kicker>准备好把 AI 课开起来了吗？</Kicker><h2>让每个孩子<br/><em>用 AI 做出自己的作品</em></h2><p>获取演示账号、试用魔法石额度与示范课包清单。</p></div><Button>预约产品演示</Button></section>}

function Org(){const faqCms=useWebsiteContent('FAQ');const modules=[['机构账号','管理员、教师、学员分级；学员无需自备 API Key','课堂零配置，避免密钥泄露'],['魔法石积分','按机构充值、按用量扣减；余额不足友好提示','成本可控，适合班级教学'],['课程中心','11 门 / 87 节标准课包；PPT 与 HTML 互动课件','标准化交付，校区可复制'],['管理后台','账号开通、课包浏览、作品发布、用量记录','运营数据透明'],['作品展厅','机构内作品聚合展示与在线预览','成果可视化，利于续费与招新']];return <><Title eyebrow="机构方案" title={<>教培机构如何开<br/><em>青少年 AI 通识课</em></>} desc="平台提供课程、机构账号与用量计费；机构负责招生和教学。8–16 岁学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的作品。"/><main className="inner"><section className="org-intro"><div><i>“</i><h2>不是再找一个聊天网站，<br/>而是一套<span>可管、可教、可展示</span>的课堂产品。</h2><p>学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的游戏、动画、互动故事和硬件作品。</p></div><div className="steps">{[['01','平台开通机构','配置席位、赠送魔法石、发布课包权限。'],['02','老师创建学员账号','学生用机构账号登录，即可开始创作。'],['03','按课包授课','从课程中心进入课时，结合阿飞完成当堂作品。'],['04','作品沉淀与展示','优秀作业进入作品社区，形成校区案例库。']].map(x=><div key={x[0]}><b>{x[0]}</b><p><strong>{x[1]}</strong>{x[2]}</p></div>)}</div></section><section className="modules">{modules.map((m,i)=><article key={m[0]}><small>0{i+1}</small><h3>{m[0]}</h3><p>{m[1]}</p><b>{m[2]}</b></article>)}</section><section className="faq"><div><Kicker>常见问题</Kicker><h2>{faqCms.data?.title||'开课前，你可能想知道'}</h2></div><div>{(faqCms.data?.items||[['需要学员自备 API Key 或对话平台账号？','不需要。机构账号登录即可使用平台统一模型能力，学生不持有 API Key，机构用魔法石管理课堂用量。'],['机房和教室的电脑都能用吗？','可以。课堂通过浏览器访问，Chrome / Edge 最新版本即可，机房不需要额外安装环境。'],['能否做 Arduino 和 micro:bit 硬件课？','支持 Arduino Uno 一键烧录，以及 micro:bit 的 MicroPython 上传与串口监视。']].map((item)=>({question:item[0],answer:item[1]}))).map((item,i)=><details key={item.question} open={i===0}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div></section><End title="让你的校区拥有一门可复制的 AI 课" text="预约演示，获取试用账号、魔法石体验额度与示范课包清单。"/></main></>}
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
function Handbook(){return <><Title eyebrow="产品手册 · 2026" title={<>一站式 AI 创作<br/><em>开课方案</em></>} desc="让每个孩子用 AI 做出自己的作品。面向教培机构、学校与青少年科创营。"/><main className="inner"><section className="cover"><div><b>AI魔法学院</b><h2>让每个孩子<br/>用 AI 做出<br/><em>自己的作品</em></h2><p>青少年 AI 编程创作平台<br/>游戏 · 动画 · 开源硬件</p><small>五格殿下 · 机构合作手册 · 2026</small></div><aside><i>✦</i><span>创作<br/>课程<br/>账号<br/>计费<br/>作品</span></aside></section><section className="points">{[['01','统一平台','创作、课程、账号、计费、作品，一个入口完成。'],['02','机构即可开班','标准课包 + 魔法石管控，老师专心带课。'],['03','政策窗口对齐','素养课好落地，生成式 AI 可用可管。']].map(x=><div key={x[0]}><b>{x[0]}</b><strong>{x[1]}</strong><p>{x[2]}</p></div>)}</section><End title="下载完整机构合作手册" text="先预约演示，我们会把最新版本、课件示例与合作说明发给你。"/></main></>}
function Compare(){const rows=[['工具形态','多个网站 / App 来回切换','原生桌面端一体：对话 + 预览 + 项目文件'],['课程交付','机构自建教案，平台不管课','课程中心标准课包，课时与课件一体'],['账号与安全','学生自备账号 / API Key，易泄露','机构账号分级，学员无需自备 Key'],['成本控制','个人账号各买各的，月底才知道超支','机构魔法石池，按用量记录和提醒'],['成果沉淀','作业散落在群聊和个人电脑','作品展厅聚合展示，形成校区案例库'],['硬件实践','外部工具和环境另行配置','Arduino / micro:bit 软硬一体课程']];return <><Title eyebrow="选型对比" title={<>为什么不是<br/><em>再找个对话平台</em>？</>} desc="机构评估 AI 课程时，真正要比较的不是一个聊天框，而是一套能不能长期交付的课堂产品。"/><main className="inner"><section className="compare"><div className="compare-head"><span>对比维度</span><span>分散拼凑</span><b>AI魔法学院</b></div>{rows.map(r=><div key={r[0]}><strong>{r[0]}</strong><span>{r[1]}</span><b>✓ {r[2]}</b></div>)}</section><section className="compare-end"><div><small>一句话总结</small><h2>把「创作、课程、账号、计费、作品」<em>统一起来</em>。</h2></div><Button>预约机构演示</Button></section></main></>}
const CMS_FALLBACK = { HOME: { heroKicker: '教培机构青少年 AI 开课平台', heroTitle: '给机构一套', heroAccent: '能落地的青少年 AI 课', heroDescription: 'AI魔法学院把课程、机构账号、魔法石计费与作品展厅放在一个平台里。', trustTitle: '响应教育部「做中学」领航行动', trustDescription: '真实问题 · 项目式探究 · 每节课都有作品' } };
function useWebsiteContent(key) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  // 接口返回的是 { key, content, version, status } 包装体，这里统一解包成 content，
  // 调用方直接用字段（此前的写法把包装体当内容用，导致 CMS 内容一直没生效）。
  useEffect(() => { let live = true; publicApi.get('public/website-content/' + encodeURIComponent(key)).then((payload) => { if (live) setState({ loading: false, data: payload?.content ?? payload ?? null, error: null }); }).catch((error) => { if (live) setState({ loading: false, data: CMS_FALLBACK[key] || null, error }); }); return () => { live = false; }; }, [key]);
  return { ...state, data: state.data || CMS_FALLBACK[key] || null };
}

function LegalPage({ type }){
  const document = LEGAL_DOCUMENTS[type] || LEGAL_DOCUMENTS.privacy;
  return <><Title eyebrow="协议与隐私" title={<>{document.title}</>} desc={document.intro}/><main className="inner legal-page"><div className="legal-meta"><span className="status-pill">{LEGAL_STATUS}</span><span>版本 {LEGAL_VERSION}</span><span>生效日期 {LEGAL_EFFECTIVE_DATE}</span><span>主体：{LEGAL_OWNER}</span></div><div className="legal-notice">本页面是上线准备稿。正式对外服务前，运营主体、备案信息和法务审核结果应由业务方确认并替换；如与正式发布版本不一致，以正式发布版本为准。</div>{document.sections.map(([heading,body])=><section className="legal-section" key={heading}><h2>{heading}</h2><p>{body}</p></section>)}<div className="legal-links"><b>相关入口</b><Link to="/terms">用户协议</Link><Link to="/privacy">隐私政策</Link><Link to="/minors">儿童 / 未成年人说明</Link><Link to="/demo">预约演示</Link></div></main></>;
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
      trackAnalytics('demo_submitted');setState('success');
    }catch(err){setError(err.message);setState('error');}
  }
  if(state==='success') return <><Title eyebrow="预约演示 · 开通试用" title={<>预约成功！</>} desc="我们会在 1 个工作日内联系你。"/><main className="inner"><section className="demo"><div className="success"><i>✦</i><h2>收到你的预约啦！</h2><p>我们会在 1 个工作日内联系你，发送演示安排与资料。</p></div></section></main></>;
  return <><Title eyebrow="预约演示 · 开通试用" title={<>把 AI 课开起来</>} desc="欢迎教培机构、学校与区域合作伙伴联系，获取演示账号与课包清单。"/><main className="inner"><section className="demo"><div><h2>预约后，你将获得</h2>{['产品演示与开课流程讲解','11 门标准课包与课件清单','魔法石体验额度与演示账号'].map((x,i)=><p key={x}><b>0{i+1}</b>{x}</p>)}</div><form onSubmit={submit}><label>机构 / 学校名称<input name="orgName" required placeholder="请输入机构名称"/></label><label>联系人<input name="contactName" required placeholder="请输入姓名"/></label><label>联系电话<input name="contactPhone" required placeholder="请输入手机号" maxLength={20}/></label><label>你想了解什么？<select name="intent" defaultValue=""><option value="" disabled>请选择合作方向</option><option>少儿编程 / AI 素养课程</option><option>学校拓展课 / 社团</option><option>寒暑假科创营</option><option>区域合作</option></select></label><label>补充说明<textarea name="notes" placeholder="例如：校区数量、预计班级规模……"/></label><label className="check-row legal-consent"><input type="checkbox" checked={legalConsent} onChange={e=>setLegalConsent(e.target.checked)}/><span>我已阅读并同意 <Link to="/terms" target="_blank">用户协议</Link>、<Link to="/privacy" target="_blank">隐私政策</Link>和<Link to="/minors" target="_blank">儿童 / 未成年人说明</Link></span></label>{error&&<small style={{color:'#e74c3c'}}>{error}</small>}<button className="button" disabled={state==='loading'}>{state==='loading'?'提交中…':'提交预约 ↗'}</button><small>提交即表示同意我们用于联系你的预约信息。</small></form></section></main></>;
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
        if(d.items){const tags=new Set();d.items.forEach(item=>{(item.tags||[]).forEach(t=>tags.add(t));});setAllTags(Array.from(tags));trackAnalytics('marketplace_view',{resultCount:d.total||0,sort:filters.sort});}
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
         {item.marketplaceRewardCredits>0&&<span className="mkt-credits">奖励 {item.marketplaceRewardCredits} 积分</span>}
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
      .then((j)=>{if(live){setData(j||null);setLoading(false);trackAnalytics('marketplace_detail_view',{resourceType:'course',resourceId:id});}})
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
        {d.estimatedCreditsPerPerson>0&&<div className="mkt-detail-row"><span className="mkt-label2">预估消耗</span><span className="mkt-credits">{d.estimatedCreditsPerPerson} 积分/人</span></div>}
        {d.marketplaceRewardCredits>0&&<div className="mkt-detail-row"><span className="mkt-label2">奖励</span><span className="mkt-credits">奖励 {d.marketplaceRewardCredits} 积分</span></div>}
      </div>
    </div>
    {(d.lessons||[]).length>0&&<div className="mkt-lessons"><h2>课程内容</h2>{(d.lessons||[]).map((l,i)=><div key={l.id} className="mkt-lesson"><div className="mkt-lesson-num">{String(i+1).padStart(2,'0')}</div><div className="mkt-lesson-body"><h3>{l.title}</h3>{l.summary&&<p className="mkt-lesson-summary">{l.summary}</p>}{l.lessonContent&&<p className="mkt-lesson-content">{String(l.lessonContent).slice(0,300)}{l.lessonContent&&l.lessonContent.length>300?'…':''}</p>}</div></div>)}</div>}
    <div className="mkt-cta">
      <button className="button mkt-start" onClick={startLearning}>开始学习</button>
      {d.priceFen>0&&<p className="mkt-contact-note">如需购买课程包，请联系客服办理</p>}
    </div>
  </main></>;
}
function End({title,text}){return <section className="end"><h2>{title}</h2><p>{text}</p><Button>预约演示 · 开通试用</Button></section>}
function AnalyticsConsentBanner({ onDecision }) { return <aside className="analytics-consent" role="dialog" aria-label="统计分析选择"><div><strong>帮助我们改进官网体验</strong><p>我们只在你选择同意后记录匿名页面访问与转化事件，不记录 IP、姓名、电话或完整查询参数；数据最多保留 90 天。详见<Link to="/privacy">隐私政策</Link>。</p></div><div className="analytics-consent-actions"><button type="button" className="consent-muted" onClick={() => onDecision(false)}>仅使用必要功能</button><button type="button" className="button" onClick={() => onDecision(true)}>同意匿名分析</button></div></aside> }
function LearnPageInner({ api, navigate }) {
  return <main className='learn-page-shell'><LearnEntry role="STUDENT" onSelectCanvas={() => navigate('/learn/canvas')} onSelectVibeCoding={() => navigate('/learn/vibecoding')} /></main>;
}
function LearnCanvasPage({ api }) {
  return <CanvasClassroom api={api} onEnterProject={(id) => { window.location.assign('/learn/canvas/' + id); }} />;
}
function LearnProjectPage({ api }) {
  return <CanvasWorkspace api={api} />;
}
function LearnVibeCodingPage({ api }) {
  return <VibeCodingClassroom api={api} onEnterConversation={(id) => { window.location.assign('/learn/vibecoding/' + id); }} />;
}
function LearnVibeCodingConversationPage({ api }) {
  return <VibeCodingWorkspace api={api} />;
}
function App(){
  const loc = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState(readUserSession);
  const [analyticsConsent, setAnalyticsConsentState] = useState(getAnalyticsConsent());
  const api = useMemo(() => createApiClient({ getToken: () => session?.token || null, onUnauthorized: () => { removeUserSession(); setSession(null); } }), [session]);
  function logout() {
    removeUserSession();
    setSession(null);
  }
  useEffect(() => {
    const titles = {
      '/': 'AI魔法学院 · AI 创作课堂 Inner Circle',
      '/marketplace': '课程广场 · AI魔法学院',
      '/org': '机构方案 · AI魔法学院',
      '/works': '作品广场 · AI魔法学院',
      '/handbook': '产品手册 · AI魔法学院',
      '/compare': '选型对比 · AI魔法学院',
      '/demo': '预约演示 · AI魔法学院',
      '/terms': '用户协议 · AI魔法学院',
      '/privacy': '隐私政策 · AI魔法学院',
      '/minors': '儿童 / 未成年人说明 · AI魔法学院',
      '/learn': '学习上课 · AI魔法学院',
      '/learn/canvas': '画布上课 · AI魔法学院',
      '/learn/vibecoding': 'VibeCoding 上课 · AI魔法学院',
    };
    const title = titles[loc.pathname] || titles['/'];
    document.title = title;
    const robots = document.querySelector('meta[name=robots]');
    if (robots) robots.setAttribute('content', INTERNAL_TEST ? 'noindex, nofollow, noarchive' : 'index,follow');
    const description = document.querySelector('meta[name=description]');
    if (description) description.setAttribute('content', 'AI魔法学院：面向教培机构与学校的青少年 AI 创作课堂，用中文对话、VibeCoding 与项目式学习，让孩子从灵感进入作品。');
    const canonical = document.querySelector('link[rel=canonical]');
    if (canonical) canonical.setAttribute('href', window.location.origin + (loc.pathname === '/' ? '' : loc.pathname));
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', title);
    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute('content', window.location.origin + (loc.pathname === '/' ? '' : loc.pathname));
    if (analyticsConsent === true) trackAnalytics('page_view', { title });
  }, [loc.pathname, analyticsConsent]);
  // ⚠️ hook 必须全部写在下面的提前 return 之前：学生会话过期时 App 会在这里提前返回，
  // 若 hook 在其后，同一次渲染里 hook 数从 7 变 6，React 抛 #300 直接白屏（而不是跳登录页）。
  const [showStudentMenu, setShowStudentMenu] = useState(false);
  if (loc.pathname.startsWith('/learn') && !session) {
    return <Navigate to='/login' replace />;
  }
  function decide(value) { setAnalyticsConsent(value); setAnalyticsConsentState(value); if (value) trackAnalytics('analytics_consent_granted'); }
  const roleBadge = { STUDENT: '小小创作者', TEACHER: '教师', ORG_ADMIN: '机构管理员', SUPER_ADMIN: '平台管理员', PLATFORM_ADMIN: '平台管理员' };
  // 学生用户下拉菜单（showStudentMenu 这个 state 在上面统一声明，必须在提前 return 之前）
  const studentMenuItems = [
    { to: '/learn', icon: '🎨', label: '进入学习' },
    { to: '/my-works', icon: '✧', label: '我的作品' },
    { to: '/my-credits', icon: '◆', label: '我的积分' },
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
  ) : <Link className='top-button' to='/login'>登录</Link>;
  if (loc.pathname === '/login') return <LoginPage/>;
  const isFullPage = loc.pathname.startsWith('/learn');
  return (
    <div className='site'>
      {INTERNAL_TEST && <div className='internal-test-banner' role='status'>内部测试环境 · 不代表正式服务</div>}
      {!isFullPage && loc.pathname !== '/' && <Header user={session ? { displayName: session.user?.displayName, role: session.user?.role } : null} userBadge={userBadge} logout={logout} />}
      <Routes>
        <Route path='/' element={<Home session={session} logout={logout}/>}/>
        <Route path='/login' element={<LoginPage/>}/>
        <Route path='/marketplace' element={<Marketplace/>}/>
        <Route path='/marketplace/:id' element={<MarketplaceDetail/>}/>
        <Route path='/courses' element={<Navigate to='/marketplace' replace/>}/>
        <Route path='/org' element={<Org/>}/>
        <Route path='/works' element={<Works/>}/>
        <Route path='/works/shared/:token' element={<WorkDetailPage api={publicApi}/>}/>
        <Route path='/works/:token' element={<WorkDetailPage api={publicApi}/>}/>
        <Route path='/handbook' element={<Handbook/>}/>
        <Route path='/compare' element={<Compare/>}/>
        <Route path='/demo' element={<Demo/>}/>
        <Route path='/terms' element={<LegalPage type='terms'/>}/>
        <Route path='/privacy' element={<LegalPage type='privacy'/>}/>
        <Route path='/minors' element={<LegalPage type='minors'/>}/>
        <Route path='/learn' element={<LearnPageInner api={api} navigate={navigate}/>}/>
        <Route path='/learn/canvas' element={<LearnCanvasPage api={api}/>}/>
        <Route path='/learn/canvas/:projectId' element={<LearnProjectPage api={api}/>}/>
        <Route path='/learn/vibecoding' element={<LearnVibeCodingPage api={api}/>}/>
        <Route path='/learn/vibecoding/:conversationId' element={<LearnVibeCodingConversationPage api={api}/>}/>
        <Route path='/my-credits' element={session ? <MyCreditsPage api={api} /> : <Navigate to='/login' replace />}/>
        <Route path='/my-works' element={session ? <MyWorksPage api={api} /> : <Navigate to='/login' replace />}/>
        <Route path='/my-courses' element={session ? <MyCoursesPage api={api} /> : <Navigate to='/login' replace />}/>
        <Route path='/my-stats' element={session ? <MyStatsPage api={api} /> : <Navigate to='/login' replace />}/>
        <Route path='*' element={<Home session={session} logout={logout}/>}/>
      </Routes>
      {!isFullPage && loc.pathname !== '/' && <Footer/>}
      {analyticsConsent === null && <AnalyticsConsentBanner onDecision={decide}/>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
