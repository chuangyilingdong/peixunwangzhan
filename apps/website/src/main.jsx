import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import { LEGAL_DOCUMENTS, LEGAL_EFFECTIVE_DATE, LEGAL_OWNER, LEGAL_STATUS, LEGAL_VERSION } from './legal.js';

const courses=[
['🪄','小创作家养成计划','AI 创作启蒙',14,'8–16 岁','从认识 AI 魔法师开始，完成绘画、故事、视频、编程与 AI 素养的第一份作品集。'],
['📖','AI绘本创作大师营','故事与绘本',8,'8–16 岁','从故事种子到新书发布会，做一本属于自己的绘本。'],
['📜','AI古诗词创意营','语文跨学科',8,'8–16 岁','让古诗活起来：用 AI 画诗、诵诗、做动画。'],
['🎉','AI节日创意工坊','主题创作',8,'8–16 岁','围绕节日文化做海报、故事、小游戏与祝福视频。'],
['🚪','选择之门','互动故事',5,'10–16 岁','设计分叉剧情、统一画风与互动选择，完成能玩的故事书。'],
['🎮','AI游戏设计师训练营','游戏创作',8,'10–16 岁','从游戏策划、角色场景到核心玩法，做出真正可以玩的小游戏。'],
['🔬','AI科学探险家','科学探究',8,'8–16 岁','探索太空、海洋、恐龙、人体与气象，产出 AI 科学百科。'],
['🎤','AI小记者训练营','表达与传播',8,'8–16 岁','从选题采访到新闻发布会，完成一份完整的 AI 新闻作品。'],
['🎬','AI微电影导演训练营','视频创作',8,'10–16 岁','从剧本、分镜到配音、特效，拍出一部属于自己的 AI 微电影。'],
['🔧','AI智能硬件发明营','Arduino',8,'10–12 岁','用对话写代码，做出会发光、会响、会动、会感知的小发明。'],
['📟','AI Micro:bit 发明营','MicroPython',8,'10–13 岁','板载超能力加金手指外接，用说话写出 MicroPython。']
];
const FALLBACK_WORKS=[['🫧','点泡泡','小游戏','30 秒内点爆所有泡泡，节奏轻快的点击小游戏。'],['🍂','山行 · 杜牧','语文互动','朗读、探索与闯关结合，把古诗学成可玩的互动课。'],['🧩','C++ 代码大冒险','编程启蒙','积木拼程序，边玩边看 3D 执行过程与代码。'],['🧱','我的世界 · 简化版','沙盒创意','浏览器里搭方块世界，保存自己的创意地图。']];

function Logo(){return <Link className="logo" to="/"><i>✦</i>AI魔法学院</Link>}
function Header(){const loc=useLocation();const nav=[['/','首页'],['/marketplace','课程广场'],['/courses','课程体系'],['/org','机构方案'],['/works','学员作品'],['/handbook','产品手册'],['/compare','选型对比']];return <header><div className="bar"><Logo/><nav>{nav.map(([to,n])=><NavLink key={to} to={to} className={({isActive})=>isActive&&(to!=='/'||loc.pathname==='/')?'on':''}>{n}</NavLink>)}</nav><div className="head-actions"><Link className="download" to="/download">下载客户端</Link><Link className="top-button" to="/demo">预约演示 <b>↗</b></Link></div></div></header>}
function Footer(){return <footer><div className="foot"><div><Logo/><p>面向教培机构与学校的<br/>青少年 AI 通识与 VibeCoding 开课平台。</p></div><div><strong>产品</strong><Link to="/courses">课程体系</Link><Link to="/org">机构方案</Link><Link to="/works">学员作品</Link></div><div><strong>合作</strong><Link to="/demo">预约演示</Link><Link to="/download">下载客户端</Link><a href="http://localhost:5175">机构后台</a></div><div><strong>了解更多</strong><Link to="/handbook">产品手册</Link><Link to="/compare">选型对比</Link><Link to="/terms">用户协议</Link><Link to="/privacy">隐私政策</Link><Link to="/minors">儿童 / 未成年人说明</Link><a href="mailto:hello@aimagc.cn">联系合作</a></div></div><div className="copyright">© 2026 五格殿下 · AI魔法学院 <span>面向 8–16 岁 · Mac / Windows</span></div></footer>}
function Button({children,to='/demo',soft=false}){return <Link to={to} className={'button '+(soft?'soft':'')}>{children}<b>↗</b></Link>}
function Kicker({children}){return <div className="kicker">✦ {children}</div>}
function Work({work,index=0}){const[url,setUrl]=useState(null);useEffect(()=>{if(work.publicUrl) setUrl(work.publicUrl);else if(work.id&&work.title){const tok=work.shareToken||work.id;setUrl('/works/shared/'+tok);}},[work]);const emoji=work.canvasSnapshot?.nodes?.[0]?.props?.emoji||work.emoji||'✦';const title=work.title;const desc=work.description;const student=work.studentName||'小创作者';return <article className={'work w'+index%6}><div className="art"><span>{emoji}</span><i>✦</i><b>AI</b></div><div className="work-body"><small>{student}</small><h3>{title}</h3><p>{desc}</p><button onClick={()=>url&&(window.location.href=url)}>打开体验 <b>↗</b></button></div></article>}
function Title({eyebrow,title,desc}){return <section className="page-title"><div><Kicker>{eyebrow}</Kicker><h1>{title}</h1><p>{desc}</p></div></section>}

function Home(){return <><section className="hero"><div className="hero-copy"><Kicker>教培机构青少年 AI 开课平台</Kicker><h1>给机构一套<br/><em>能落地的青少年 AI 课</em></h1><p>AI魔法学院把课程、桌面客户端、机构账号、魔法石计费与作品展厅放在一个平台里。学生用中文与 AI 伙伴「阿飞」对话，当堂做出游戏、动画与硬件作品。</p><div className="buttons"><Button>预约演示 · 开通试用</Button><Button soft to="/courses">查看课程体系</Button></div><div className="proof"><span><b>11</b>门系统课包</span><i/><span><b>87</b>节精品课时</span><i/><span><b>8–16</b>岁适学</span></div></div><div className="hero-art"><div className="ring a"/><div className="ring b"/><div className="back-card"><i>✦</i><b>做中学</b><small>真实问题驱动</small></div><div className="chat-card"><div className="chat-head"><i>阿</i>阿飞创作助手 <b>•••</b></div><div className="bubble user">帮我做一个会下雪的小游戏</div><div className="bubble ai">✦ 好的！我们一起把想法变成作品吧。</div><div className="preview"><div>● ● ●</div><section><b>❄</b><strong>冬日魔法屋</strong><small>点击开始创作</small><i>✦</i></section></div></div><span className="star one">✦</span><span className="star two">✧</span></div></section><div className="trust"><b>响应教育部「做中学」领航行动</b><span>真实问题 · 项目式探究 · 每节课都有作品</span></div><section className="section center"><Kicker>一套平台，四类角色都能用</Kicker><h2>把 AI 课从「能讲」<br/><em>变成「能落地」</em></h2><p>不是再给机构多一个聊天网页，而是把创作、课程、账号、计费、作品统一成一套可复制的课堂产品。</p><div className="roles">{[['🏫','对机构','标准课包、机构账号与积分管控，降低开课和机房运维成本，校区更容易复制扩张。'],['👩‍🏫','对老师','课件和课程结构化分发，学员作品集中展示，老师把时间留给教学和陪伴创作。'],['🧒','对学生','只需说出想法，就能在预览区看到游戏、动画、故事和硬件作品，零代码门槛。'],['👨‍👩‍👧','对家长','每一节课都有看得见的作品，学习过程可感知，成果能分享、能展示、能沉淀。']].map(x=><article key={x[1]}><i>{x[0]}</i><h3>{x[1]}</h3><p>{x[2]}</p><b>↗</b></article>)}</div></section><section className="cap"><div className="cap-orb"><div>✦<small>AI创作魔法</small></div><span className="p1">中文对话</span><span className="p2">实时预览</span><span className="p3">作品沉淀</span></div><div><Kicker>专为青少年课堂设计</Kicker><h2>学生专注创作<br/><em>老师轻松开课</em></h2><p>桌面端为课堂场景深度优化，隐藏复杂运维，保留创作核心。平台提供标准课包、账号体系与用量管控，让每个人都专注自己的角色。</p>{[['AI 对话创作','和阿飞聊天即可生成、修改、运行代码，步骤化引导让孩子看懂正在发生什么。'],['分屏预览与项目管理','网页、图片、代码结果即时呈现，孩子像小开发者一样管理作品。'],['语音互动与智能硬件','支持语音表达、Arduino 一键烧录与 micro:bit 上传，软硬一体做科创。']].map(x=><div className="feature" key={x[0]}><i>✓</i><div><b>{x[0]}</b><p>{x[1]}</p></div></div>)}</div></section><section className="section"><div className="split-title"><div><Kicker>学员作品</Kicker><h2>孩子们用 AI 做出的<br/><em>好玩项目</em></h2></div><div><p>来自课堂与作品社区的真实创作，打开就能体验。</p><Link to="/works">查看全部作品 ↗</Link></div></div><div className="works">{works.slice(0,4).map((w,i)=><Work key={w[1]} work={w} index={i}/>)}</div></section><section className="course-teaser"><div><Kicker>示范课包</Kicker><h2>11 门系统课程<br/><em>从启蒙到创作</em></h2><p>覆盖 AI 创作启蒙、绘本、古诗词、互动故事、游戏、科学、新闻、微电影，以及 Arduino 与 micro:bit 智能硬件发明营。</p><Button soft to="/courses">查看全部课程大纲</Button></div><div className="stack">{courses.slice(0,3).map((c,i)=><article key={c[1]}><small>0{i+1}</small><i>{c[0]}</i><div><b>{c[1]}</b><span>{c[3]} 节课 · {c[4]}</span></div><strong>↗</strong></article>)}</div></section><CTA/></>}
function CTA(){return <section className="cta"><div><Kicker>准备好把 AI 课开起来了吗？</Kicker><h2>让每个孩子<br/><em>用 AI 做出自己的作品</em></h2><p>获取演示账号、试用魔法石额度与示范课包清单。</p></div><Button>预约产品演示</Button></section>}

function Courses(){return <><Title eyebrow="课程体系" title={<>标准课包，<em>马上开课</em></>} desc="给教培机构和学校用的课包清单，不是面向个人家长的选课商城。共 11 门、87 节，建议每节 90 分钟，适学 8–16 岁。"/><main className="inner"><div className="stats">{[['11','门系统课程'],['87','节精品课时'],['8–16','岁适学年龄'],['90′','每节课时长']].map(x=><div key={x[1]}><b>{x[0]}</b><span>{x[1]}</span></div>)}</div><div className="courses">{courses.map((c,i)=><article key={c[1]}><div className="course-head"><small>{String(i+1).padStart(2,'0')}</small><i>{c[0]}</i><div><span>{c[2]}</span><h2>{c[1]}</h2><p>{c[5]}</p></div><b>{c[3]}<small>节课</small><br/>90<small>分钟</small></b></div><div className="lessons">{['认识 AI 魔法师','创意与提示词','角色与场景设计','让画面动起来','代码魔法实践','作品打磨与发布','同伴分享与互评','结课展示与颁奖'].slice(0,Math.min(c[3],8)).map((x,n)=><span key={x}>{String(n+1).padStart(2,'0')} · {x}</span>)}</div></article>)}</div><End title="想看完整课包与课件示例？" text="预约演示，获取课程清单、客户端安装包与试用账号。"/></main></>}
function Org(){const modules=[['机构账号','管理员、教师、学员分级；学员无需自备 API Key','课堂零配置，避免密钥泄露'],['魔法石积分','按机构充值、按用量扣减；余额不足友好提示','成本可控，适合班级教学'],['课程中心','11 门 / 87 节标准课包；PPT 与 HTML 互动课件','标准化交付，校区可复制'],['管理后台','账号开通、课包浏览、作品发布、用量记录','运营数据透明'],['作品展厅','机构内作品聚合展示与在线预览','成果可视化，利于续费与招新'],['桌面客户端','macOS Apple 芯片与 Windows 64 位；应用与引擎可更新','减少机房装环境时间']];return <><Title eyebrow="机构方案" title={<>教培机构如何开<br/><em>青少年 AI 通识课</em></>} desc="平台提供课程、桌面客户端、机构账号与用量计费；机构负责招生和教学。8–16 岁学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的作品。"/><main className="inner"><section className="org-intro"><div><i>“</i><h2>不是再找一个聊天网站，<br/>而是一套<span>可管、可教、可展示</span>的课堂产品。</h2><p>学生用中文与 AI 伙伴「阿飞」对话，当堂做出可展示的游戏、动画、互动故事和硬件作品。</p></div><div className="steps">{[['01','平台开通机构','配置席位、赠送魔法石、发布课包权限。'],['02','老师创建学员账号','学生安装客户端，登录机构账号即可创作。'],['03','按课包授课','从课程中心进入课时，结合阿飞完成当堂作品。'],['04','作品沉淀与展示','优秀作业进入作品社区，形成校区案例库。']].map(x=><div key={x[0]}><b>{x[0]}</b><p><strong>{x[1]}</strong>{x[2]}</p></div>)}</div></section><section className="modules">{modules.map((m,i)=><article key={m[0]}><small>0{i+1}</small><h3>{m[0]}</h3><p>{m[1]}</p><b>{m[2]}</b></article>)}</section><section className="faq"><div><Kicker>常见问题</Kicker><h2>开课前，<em>你可能想知道</em></h2></div><div>{[['需要学员自备 API Key 或对话平台账号吗？','不需要。机构账号登录即可使用平台统一模型能力，学生不持有 API Key，机构用魔法石管理课堂用量。'],['Windows 机房和 Mac 教室都能用吗？','可以。公开客户端支持 macOS Apple 芯片版与 Windows 64 位，安装后按引导完成引擎初始化。'],['能否做 Arduino 和 micro:bit 硬件课？','支持 Arduino Uno 一键烧录，以及 micro:bit 的 MicroPython 上传与串口监视。']].map((x,i)=><details key={x[0]} open={i===0}><summary>{x[0]}</summary><p>{x[1]}</p></details>)}</div></section><End title="让你的校区拥有一门可复制的 AI 课" text="预约演示，获取试用账号、魔法石体验额度与示范课包清单。"/></main></>}
function Works(){
  const [items,setItems]=useState(FALLBACK_WORKS.map(w=>({title:w[1],description:w[3],studentName:'小创作者',emoji:w[0]})));
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState(null);
  useEffect(()=>{
    fetch(API_BASE+'/public/works').then(r=>r.json()).then(j=>{
      if(Array.isArray(j.data?.items)&&j.data.items.length) setItems(j.data.items);
      setLoaded(true);
    }).catch(e=>{setError(e.message);setLoaded(true);});
  },[]);
  return <><Title eyebrow="学员作品" title={<>孩子们的灵感，<em>正在发光</em></>} desc="来自课堂与作品社区的真实 HTML 创作。点击卡片即可打开体验，游戏、古诗、3D、单词闯关都能在浏览器里直接玩。"/><main className="inner"><div className="filters"><b>全部作品</b><span>小游戏</span><span>互动故事</span><span>AI 绘本</span><span>智能硬件</span></div><div className="works all">{items.map((w,i)=><Work key={w.id||w.title} work={w} index={i}/>)}</div>{!loaded&&<div className="note">✦ <p>正在加载作品…</p></div>}{loaded&&items.length===0&&<div className="note">✦ <p>{error||'暂无公开作品，学生可在作品页开启公开后展示。'}</p></div>}<div className="note">✦ <div><b>作品来自真实课堂</b><p>每一份作品都记录着孩子从想法、对话到实现的创作过程。机构开通后，可拥有自己的校区作品展厅。</p></div><Button soft to="/org">了解机构作品展厅</Button></div></main></>;
}
function Handbook(){return <><Title eyebrow="产品手册 · 2026" title={<>一站式 AI 创作<br/><em>开课方案</em></>} desc="让每个孩子用 AI 做出自己的作品。面向教培机构、学校与青少年科创营。"/><main className="inner"><section className="cover"><div><b>AI魔法学院</b><h2>让每个孩子<br/>用 AI 做出<br/><em>自己的作品</em></h2><p>青少年 AI 编程创作平台<br/>游戏 · 动画 · 开源硬件</p><small>五格殿下 · 机构合作手册 · 2026</small></div><aside><i>✦</i><span>创作<br/>课程<br/>账号<br/>计费<br/>作品</span></aside></section><section className="points">{[['01','统一平台','创作、课程、账号、计费、作品，一个入口完成。'],['02','机构即可开班','标准课包 + 魔法石管控，老师专心带课。'],['03','政策窗口对齐','素养课好落地，生成式 AI 可用可管。']].map(x=><div key={x[0]}><b>{x[0]}</b><strong>{x[1]}</strong><p>{x[2]}</p></div>)}</section><End title="下载完整机构合作手册" text="先预约演示，我们会把最新版本、课件示例与合作说明发给你。"/></main></>}
function Compare(){const rows=[['工具形态','多个网站 / App 来回切换','原生桌面端一体：对话 + 预览 + 项目文件'],['课程交付','机构自建教案，平台不管课','课程中心标准课包，课时与课件一体'],['账号与安全','学生自备账号 / API Key，易泄露','机构账号分级，学员无需自备 Key'],['成本控制','个人账号各买各的，月底才知道超支','机构魔法石池，按用量记录和提醒'],['成果沉淀','作业散落在群聊和个人电脑','作品展厅聚合展示，形成校区案例库'],['硬件实践','外部工具和环境另行配置','Arduino / micro:bit 软硬一体课程']];return <><Title eyebrow="选型对比" title={<>为什么不是<br/><em>再找个对话平台</em>？</>} desc="机构评估 AI 课程时，真正要比较的不是一个聊天框，而是一套能不能长期交付的课堂产品。"/><main className="inner"><section className="compare"><div className="compare-head"><span>对比维度</span><span>分散拼凑</span><b>AI魔法学院</b></div>{rows.map(r=><div key={r[0]}><strong>{r[0]}</strong><span>{r[1]}</span><b>✓ {r[2]}</b></div>)}</section><section className="compare-end"><div><small>一句话总结</small><h2>把「创作、课程、账号、计费、作品」<em>统一起来</em>。</h2></div><Button>预约机构演示</Button></section></main></>}
const DOWNLOAD_PLATFORMS=[['MACOS_APPLE','⌘','macOS 版','适用于 Apple 芯片 Mac 电脑'],['WINDOWS_X64','⊞','Windows 版','适用于 Windows 10 / 11 64 位']];
const API_BASE=(import.meta.env&&import.meta.env.VITE_API_BASE?String(import.meta.env.VITE_API_BASE).replace(/\/$/,''):'/api');
function Download(){
  const [state,setState]=useState({loading:true,error:null,data:null});
  useEffect(()=>{
    let live=true;
    fetch(API_BASE+'/public/downloads')
      .then((response)=>response.ok?response.json():Promise.reject(new Error('暂时无法读取下载配置')))
      .then((body)=>{if(live)setState({loading:false,error:null,data:body.data});})
      .catch((error)=>{if(live)setState({loading:false,error:error.message,data:null});});
    return()=>{live=false};
  },[]);
  const platforms=DOWNLOAD_PLATFORMS.map(([key,icon,title,desc])=>({key,icon,title,desc,release:state.data?.byPlatform?.[key]||null}));
  const releaseState=(platform)=>{
    if(state.loading)return <small className="download-state">正在读取版本状态…</small>;
    if(platform.release)return <>
      <a className="button" href={platform.release.downloadUrl}>下载 v{platform.release.version} <b>↗</b></a>
      <small>{platform.release.channel==='STABLE'?'正式版':platform.release.channel==='BETA'?'测试版':'内测版'} · {platform.release.releaseNotes}</small>
    </>;
    return <>
      <button className="button" disabled>暂无真实安装包</button>
      <small>平台尚未配置该平台安装包，不提供虚假下载；可先使用浏览器访问 Web 版。</small>
    </>;
  };
  return <>
    <Title eyebrow="下载客户端" title={<>安装一次，<em>课堂开箱即用</em></>} desc={state.loading?'正在读取平台真实发布状态…':'支持 macOS（Apple 芯片）与 Windows 64 位。仅当平台配置真实安装包后才提供下载。'}/>
    <main className="inner">
      <section className="downloads">{platforms.map((platform)=>(
        <article key={platform.key}><i>{platform.icon}</i><h2>{platform.title}</h2><p>{platform.desc}</p>{releaseState(platform)}</article>
      ))}</section>
      {state.error?<div className="note">⚠ <div><b>下载状态读取失败</b><p>{state.error} 请稍后刷新，或联系平台管理员确认客户端发布状态。</p></div></div>:null}
      {state.data?.status==='NOT_CONFIGURED'?<div className="note">✦ <div><b>当前尚未发布桌面客户端</b><p>{state.data.statement} 课堂可先使用现代浏览器访问 Web 版完成创作。</p></div></div>:null}
      <div className="note">✦ <div><b>第一次使用？</b><p>机构学员使用管理员提供的账号登录。课堂依赖在线服务，建议提前检查机房网络。</p></div><Link to="/org">查看机构开课方案 ↗</Link></div>
    </main>
  </>;
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
      const res=await fetch(API_BASE+'/public/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orgName,contactName,contactPhone,intent:form.intent.value,notes:form.notes.value,legalConsentVersion:LEGAL_VERSION,legalConsentAt:new Date().toISOString()})});
      if(!res.ok){const d=await res.json();throw new Error(d.error?.message||'提交失败');}
      setState('success');
    }catch(err){setError(err.message);setState('error');}
  }
  if(state==='success') return <><Title eyebrow="预约演示 · 开通试用" title={<>预约成功！</>} desc="我们会在 1 个工作日内联系你。"/><main className="inner"><section className="demo"><div className="success"><i>✦</i><h2>收到你的预约啦！</h2><p>我们会在 1 个工作日内联系你，发送演示安排与资料。</p></div></section></main></>;
  return <><Title eyebrow="预约演示 · 开通试用" title={<>把 AI 课开起来</>} desc="欢迎教培机构、学校与区域合作伙伴联系，获取演示账号、课包清单与客户端安装包。"/><main className="inner"><section className="demo"><div><h2>预约后，你将获得</h2>{['产品演示与开课流程讲解','11 门标准课包与课件清单','魔法石体验额度与演示账号','Mac / Windows 客户端安装包'].map((x,i)=><p key={x}><b>0{i+1}</b>{x}</p>)}</div><form onSubmit={submit}><label>机构 / 学校名称<input name="orgName" required placeholder="请输入机构名称"/></label><label>联系人<input name="contactName" required placeholder="请输入姓名"/></label><label>联系电话<input name="contactPhone" required placeholder="请输入手机号" maxLength={20}/></label><label>你想了解什么？<select name="intent" defaultValue=""><option value="" disabled>请选择合作方向</option><option>少儿编程 / AI 素养课程</option><option>学校拓展课 / 社团</option><option>寒暑假科创营</option><option>区域合作</option></select></label><label>补充说明<textarea name="notes" placeholder="例如：校区数量、预计班级规模……"/></label><label className="check-row legal-consent"><input type="checkbox" checked={legalConsent} onChange={e=>setLegalConsent(e.target.checked)}/><span>我已阅读并同意 <Link to="/terms" target="_blank">用户协议</Link>、<Link to="/privacy" target="_blank">隐私政策</Link>和<Link to="/minors" target="_blank">儿童 / 未成年人说明</Link></span></label>{error&&<small style={{color:'#e74c3c'}}>{error}</small>}<button className="button" disabled={state==='loading'}>{state==='loading'?'提交中…':'提交预约 ↗'}</button><small>提交即表示同意我们用于联系你的预约信息。</small></form></section></main></>;
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
  const [filters,setFilters]=useState({difficulty:'',ageMin:'',ageMax:'',tag:'',search:'',sort:'popular'});
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
    if(filters.search) p.set('search',filters.search);
    p.set('sort',filters.sort);
    p.set('page',page);
    p.set('limit',limit);
    return p;
  };
  useEffect(()=>{let live=true;setLoading(true);setError(null);
    fetch(API_BASE+'/public/marketplace?'+buildParams())
      .then(r=>r.ok?r.json():Promise.reject(new Error('加载失败')))
      .then(j=>{if(live){const d=j.data||j;setItems(d.items||[]);setTotal(d.total||0);setLoading(false);
        if(d.items){const tags=new Set();d.items.forEach(item=>{(item.tags||[]).forEach(t=>tags.add(t));});setAllTags(Array.from(tags));}
      }})
      .catch(e=>{if(live){setError(e.message);setLoading(false);}});
    return()=>{live=false};
  },[filters,page]);
  const totalPages=Math.ceil(total/limit)||1;
  return <><Title eyebrow="课程广场" title={<>发现优质<em>AI 编程课程</em></>} desc="精选平台优质课程，涵盖 AI 创作、游戏设计、绘本故事与智能硬件，适合 6–16 岁青少年。"/><main className="inner">
    <div className="mkt-filters">
      <div className="mkt-row"><span className="mkt-label">难度</span><div className="mkt-chips">{difficultyOptions.map(o=><button key={o.value} className={'mkt-chip'+(filters.difficulty===o.value?' on':'')} onClick={()=>{setFilters(f=>({...f,difficulty:o.value}));setPage(1);}}>{o.label}</button>)}</div></div>
      <div className="mkt-row"><span className="mkt-label">适学年龄</span><div className="mkt-chips">{ageOptions.map(o=><button key={o.value} className={'mkt-chip'+(activeAge===o.value?' on':'')} onClick={()=>{setActiveAge(activeAge===o.value?'':o.value);setPage(1);}}>{o.label}</button>)}</div></div>
      {allTags.length>0&&<div className="mkt-row"><span className="mkt-label">标签</span><div className="mkt-chips">{allTags.slice(0,12).map(t=><button key={t} className={'mkt-chip small'+(filters.tag===t?' on':'')} onClick={()=>{setFilters(f=>({...f,tag:f.tag===t?'':t}));setPage(1);}}>{t}</button>)}</div></div>}
      <div className="mkt-row"><span className="mkt-label">排序</span><div className="mkt-chips"><button className={'mkt-chip'+(filters.sort==='popular'?' on':'')} onClick={()=>{setFilters(f=>({...f,sort:'popular'}));setPage(1);}}>综合推荐</button><button className={'mkt-chip'+(filters.sort==='recent'?' on':'')} onClick={()=>{setFilters(f=>({...f,sort:'recent'}));setPage(1);}}>最新上线</button></div></div>
      <div className="mkt-search"><input placeholder="搜索课程名称…" value={filters.search} onChange={e=>{setFilters(f=>({...f,search:e.target.value}));setPage(1);}}/><button onClick={()=>{setFilters(f=>({...f,search:'',difficulty:'',tag:'',sort:'popular'}));setActiveAge('');setPage(1);}} className="mkt-reset">重置</button></div>
    </div>
    {loading?<div className="mkt-grid">{Array.from({length:8},(_,i)=><div key={i} className="mkt-skeleton"/>)}</div>:
     error?<div className="note">⚠ <div><b>加载失败</b><p>{error}</p></div></div>:
     items.length===0?<div className="note">✦ <div><b>暂无课程，敬请期待</b><p>课程广场将陆续上线优质 AI 编程课程。</p></div></div>:
     <><div className="mkt-grid">{items.map(item=><Link key={item.id} to={'/marketplace/'+item.id} className="mkt-card">
       <div className="mkt-cover" style={item.coverImageUrl?{backgroundImage:'url('+item.coverImageUrl+')'}:{}}>{!item.coverImageUrl&&<span>{item.title?.charAt(0)||'课'}</span>}</div>
       <div className="mkt-body"><h3>{item.title}</h3>
         <div className="mkt-meta"><DifficultyStars level={item.difficultyLevel}/>{ageLabel(item.ageRangeMin,item.ageRangeMax)?<span className="mkt-age">{ageLabel(item.ageRangeMin,item.ageRangeMax)}</span>:null}</div>
         {(item.tags||[]).slice(0,3).map(t=><span key={t} className="mkt-tag">{t}</span>)}
         {(item.tags||[]).length>3&&<span className="mkt-tag-more">+{item.tags.length-3}</span>}
         {item.marketplaceRewardCredits>0&&<span className="mkt-credits">奖励 {item.marketplaceRewardCredits} 积分</span>}
       </div>
     </Link>)}</div>
     {totalPages>1&&<div className="mkt-pages"><button disabled={page<=1} onClick={()=>setPage(p=>p-1)}>上一页</button><span>{page} / {totalPages}</span><button disabled={page>=totalPages} onClick={()=>setPage(p=>p+1)}>下一页</button></div>}
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
    const user=localStorage.getItem('user');
    if(!user){window.location.href='/login';return;}
    let u=null;
    try{u=JSON.parse(user);}catch(e){window.location.href='/login';return;}
    if(u&&u.role==='STUDENT') window.location.href='/student';
    else window.location.href='/demo';
  }
  useEffect(()=>{let live=true;
    fetch(API_BASE+'/public/marketplace/'+id)
      .then(r=>r.ok?r.json():Promise.reject(new Error('课程不存在')))
      .then(j=>{if(live){setData(j.data||j);setLoading(false);}})
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
      {d.coverImageUrl&&<div className="mkt-detail-cover" style={{backgroundImage:'url('+d.coverImageUrl+')'}}/>}
      <div className="mkt-detail-info">
        <div className="mkt-detail-row"><span className="mkt-label2">难度</span><DifficultyStars level={d.difficultyLevel}/></div>
        <div className="mkt-detail-row"><span className="mkt-label2">适学年龄</span><span>{ageLabel(d.ageRangeMin,d.ageRangeMax)||'未设置'}</span></div>
        {(d.tags||[]).length>0&&<div className="mkt-detail-row"><span className="mkt-label2">标签</span><div className="mkt-chips">{(d.tags||[]).map(t=><span key={t} className="mkt-tag">{t}</span>)}</div></div>}
        {d.version&&<div className="mkt-detail-row"><span className="mkt-label2">版本</span><span>{d.version}</span></div>}
        <div className="mkt-detail-row"><span className="mkt-label2">课时</span><span>{d.lessonCount||0} 节</span></div>
        {d.marketplaceRewardCredits>0&&<div className="mkt-detail-row"><span className="mkt-label2">奖励</span><span className="mkt-credits">奖励 {d.marketplaceRewardCredits} 积分</span></div>}
      </div>
    </div>
    {(d.lessons||[]).length>0&&<div className="mkt-lessons"><h2>课程内容</h2>{(d.lessons||[]).map((l,i)=><div key={l.id} className="mkt-lesson"><div className="mkt-lesson-num">{String(i+1).padStart(2,'0')}</div><div className="mkt-lesson-body"><h3>{l.title}</h3>{l.summary&&<p className="mkt-lesson-summary">{l.summary}</p>}{l.lessonContent&&<p className="mkt-lesson-content">{String(l.lessonContent).slice(0,300)}{l.lessonContent&&l.lessonContent.length>300?'…':''}</p>}</div></div>)}</div>}
    <div className="mkt-cta"><button className="button mkt-start" onClick={startLearning}>开始学习</button></div>
  </main></>;
}
function End({title,text}){return <section className="end"><h2>{title}</h2><p>{text}</p><Button>预约演示 · 开通试用</Button></section>}
function App(){return <div className="site"><Header/><Routes><Route path="/" element={<Home/>}/><Route path="/marketplace" element={<Marketplace/>}/><Route path="/marketplace/:id" element={<MarketplaceDetail/>}/><Route path="/courses" element={<Courses/>}/><Route path="/org" element={<Org/>}/><Route path="/works" element={<Works/>}/><Route path="/handbook" element={<Handbook/>}/><Route path="/compare" element={<Compare/>}/><Route path="/download" element={<Download/>}/><Route path="/demo" element={<Demo/>}/><Route path="/terms" element={<LegalPage type="terms"/>}/><Route path="/privacy" element={<LegalPage type="privacy"/>}/><Route path="/minors" element={<LegalPage type="minors"/>}/><Route path="*" element={<Home/>}/></Routes><Footer/></div>};
createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);