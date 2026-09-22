import { useState } from 'react';
import { NavLink } from 'react-router-dom';
// 品牌标（「灵动ai」横标，蓝 + 橙）。三端外壳、登录页、官网导航与页脚共用这一张图，
// 不再各写一份「✦ + 文字」的临时标记 —— 那套符号当初只是占位，logo 到位后就该退休。
// 深色底（官网黑底首页、官网登录页）由各自的样式表补一层白底药丸，否则蓝色的「灵动」在深色上几乎看不清。
import brandLogo from './assets/lingdong-ai-logo.png';
// 提示语的语气标记（`errorText` / `isErrorText` / `stripNoticeMark`）在 `notice.js` 里 ——
// 放普通 .js 是为了让守卫能真跑那几个纯函数（见 scripts/p126）。
import { isErrorText, stripNoticeMark } from './notice.js';
// 标记三件套也在这里转出一次：老代码里 `from './ui.jsx'` 的写法继续可用（实现仍在 notice.js）。
export { errorText, isErrorText, stripNoticeMark, NOTICE_ERROR_MARK } from './notice.js';

export function BrandLogo({ height = 26 }) {
  return <img className="brand-logo" src={brandLogo} alt="灵动ai学院" style={{ height }} />;
}

const INTERNAL_TEST = typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEPLOYMENT_MODE === 'internal-test';
function InternalTestBanner() {
  return INTERNAL_TEST ? <div className="internal-test-banner" role="status">内部测试环境 · 不代表正式服务</div> : null;
}

export function AppShell({ product, roleLabel, user, navigation, onLogout, onChangePassword, children }) {
  // product 这个 prop 仍由调用方传（接口不变），但品牌区显示的是 logo —— 名字写在 img 的 alt 里。
  return <><InternalTestBanner/><div className="app-shell"><aside className="sidebar"><div className="sidebar-top"><div className="brand"><BrandLogo height={22} /></div><div className="role-chip">{roleLabel}</div></div><nav className="app-nav">{navigation.map((item) => item.heading ? <p className="nav-heading" key={item.heading}>{item.heading}</p> : <NavLink key={item.to} to={item.to} className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}><span className="nav-icon">{item.icon}</span>{item.label}{item.badge && <small>{item.badge}</small>}</NavLink>)}</nav><div className="sidebar-help"><span>✦</span><div><b>需要帮助？</b><small>查看开课与创作指南</small></div></div><div className="sidebar-footer"><div className="avatar">{(user?.displayName || user?.login || '?').slice(0, 1)}</div><div><strong>{user?.displayName || user?.login}</strong><small>{user?.login}</small></div>{onChangePassword ? <button className="icon-button" title="账号安全" onClick={onChangePassword}>🔑</button> : null}<button className="icon-button" title="退出登录" onClick={onLogout}>↪</button></div></aside><main className="app-main"><div className="app-topbar"><span className="crumb">灵动ai学院 / {roleLabel}</span><div><span className="top-status">● 服务正常</span><button className="top-help">?</button></div></div><div className="page-content">{children}</div></main></div></>;
}

export function LoginPanel({ title, description, clientType, demos = [], onLogin }) {
  const [login, setLogin] = useState(demos[0]?.login || '');
  const [password, setPassword] = useState(demos[0]?.password || '');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setPending(true); setError('');
    try {
      await onLogin({ login, password, clientType, mfaCode: mfaRequired ? mfaCode : undefined });
    } catch (err) {
      // 服务端要求二次验证（MFA_REQUIRED）时切到验证码步骤，密码保持已填状态
      if (err?.code === 'MFA_REQUIRED' || err?.code === 'MFA_INVALID_CODE') {
        setMfaRequired(true); setMfaCode('');
        setError(err.code === 'MFA_REQUIRED' ? '' : (err.message || '动态验证码不正确'));
      } else {
        setError(err.message || '登录失败');
      }
    } finally {
      setPending(false);
    }
  }
  // 密码框的「显示 / 隐藏」：纯前端切换 input 的 type，不改变任何鉴权行为。
  const [showPassword, setShowPassword] = useState(false);
  return <div className="login-page">
    {/* 左侧品牌区：logo 放大到 52px 高（约 166px 宽，与设计稿的 clamp(120px,12vw,165px) 一致）、
        两行品牌主张 + 一行说明 + 底部品牌行。这里放的是**品牌文案**（固定），
        页面级标题（学生登录 / 机构 · 老师登录）放在右侧卡片里 —— 两个入口靠它区分。 */}
    <section className="login-intro">
      <div className="login-brand"><BrandLogo height={52} /></div>
      <div className="login-copy">
        <p className="login-headline">培养青少年 <span className="login-accent">Ai</span> 思维</p>
        <p className="login-headline"><span className="login-accent">掌握 Ai 时代的创造方式</span></p>
        <p className="login-note">从灵感到创造，让每一次探索都有回响。</p>
      </div>
      <div className="login-foot"><span />灵动ai学院 · 创造力教育平台</div>
    </section>
    <section className="login-side">
      <div className="login-card">
        <span className="login-kicker">WELCOME BACK</span>
        <h1>{title}</h1>
        <p className="login-sub">{description}</p>
        <form onSubmit={submit}>
          <label><span className="login-label">账号</span>
            <span className="login-field">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3" /><path d="M3.5 9h17M7 13h6" /></svg>
              <input value={login} onChange={e=>setLogin(e.target.value)} autoComplete="username" placeholder="请输入登录名" required/>
            </span>
          </label>
          <label><span className="login-label">密码</span>
            <span className="login-field">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10.5" rx="2.5" /><path d="M8 10V7.2A4 4 0 0 1 16 7.2V10" /></svg>
              <input type={showPassword?'text':'password'} value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" placeholder="请输入密码" required/>
              <button className="login-eye" type="button" onClick={()=>setShowPassword(v=>!v)} aria-label={showPassword?'隐藏密码':'显示密码'}>{showPassword?'隐藏':'显示'}</button>
            </span>
          </label>
          {mfaRequired&&<label><span className="login-label">动态验证码 / 恢复码</span>
            <span className="login-field">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M10 8h4M10 12h4M10 16h2" /></svg>
              <input value={mfaCode} onChange={e=>setMfaCode(e.target.value)} autoComplete="one-time-code" placeholder="6 位动态码，或 XXXX-XXXXX 恢复码" required/>
            </span>
          </label>}
          {mfaRequired&&<p className="login-hint">该账号已开启二次验证：请输入验证器 App 当前显示的动态码；验证器不可用时可用一枚恢复码。</p>}
          {error&&<Notice tone="danger">{error}</Notice>}
          <button className="login-submit" disabled={pending} aria-busy={pending}>{pending?<i className="btn-spinner" aria-hidden="true"/>:null}{pending?'正在验证…':(mfaRequired?'验证并进入':'进入工作台')}<span>→</span></button>
        </form>
        {demos.length>0&&<div className="demo-list"><span>演示账号</span>{demos.map(d=><button key={d.login} type="button" onClick={()=>{setLogin(d.login);setPassword(d.password);setMfaRequired(false);setMfaCode('')}}><strong>{d.label}</strong><small>{d.login}</small><b>使用</b></button>)}</div>}
      </div>
    </section>
  </div>;
}
export function PageHeader({ eyebrow, title, description, actions }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description&&<p className="page-description">{description}</p>}</div>{actions&&<div className="header-actions">{actions}</div>}</header> }
export function MetricCard({ label, value, hint, tone='violet' }) { return <article className={'metric-card '+tone}><span className="metric-symbol">✦</span><p>{label}</p><strong>{value}</strong>{hint&&<small>{hint}</small>}</article> }
export function Notice({ tone='info', children }) {
  // 消息里带错误标记 → 一律按危险色（压过调用方给的 tone，那些 tone 大多是猜出来的）
  if (typeof children === 'string' && isErrorText(children)) return <div className="notice danger">{stripNoticeMark(children)}</div>;
  return <div className={'notice '+tone}>{children}</div>;
}
export function Loading({ label='正在加载数据…' }) { return <div className="loading"><span>✦</span>{label}</div> }
export function Empty({ title='暂时没有数据', body='数据出现后会显示在这里。' }) { return <div className="empty"><span>✦</span><strong>{title}</strong><p>{body}</p></div> }
export function ErrorState({ error,onRetry }) { return <Notice tone="danger">{error?.message||'加载失败'} {onRetry&&<button className="text-button" onClick={onRetry}>重试</button>}</Notice> }
export function Panel({ title, children, actions, className='' }) { return <section className={'panel '+className}><div className="panel-heading"><h2>{title}</h2>{actions}</div>{children}</section> }
export function Status({ value }) {const text=String(value||'UNKNOWN');const tone=/ACTIVE|PUBLISHED|APPROVED|SUCCESS|HOME_PRACTICE|ALWAYS_AVAILABLE/.test(text)?'success':/DRAFT|PENDING|TRIAL/.test(text)?'warning':'muted';return <span className={'status '+tone}>{text.replaceAll('_',' ')}</span> }

export function ListResultSummary({ total = 0, page = 1, totalPages = 1, label = '条' }) {
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  return <div className="list-result-summary">共 <strong>{Number(total) || 0}</strong> {label} · 第 <strong>{Math.min(Math.max(1, Number(page) || 1), safeTotalPages)}</strong> / <strong>{safeTotalPages}</strong> 页</div>;
}

export function Pagination({ page = 1, totalPages = 1, onChange, disabled = false }) {
  const current = Math.max(1, Number(page) || 1);
  const pages = Math.max(1, Number(totalPages) || 1);
  if (pages <= 1) return null;
  return <nav className="pagination" aria-label="分页">
    <button type="button" className="secondary-button" disabled={disabled || current <= 1} onClick={() => onChange(current - 1)}>上一页</button>
    <span>第 {current} / {pages} 页</span>
    <button type="button" className="secondary-button" disabled={disabled || current >= pages} onClick={() => onChange(current + 1)}>下一页</button>
  </nav>;
}
