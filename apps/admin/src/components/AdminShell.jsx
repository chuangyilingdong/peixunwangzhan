import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

export function AdminShell({ user, navigation = [], onLogout, children }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const current = navigation.find((item) => item.to && location.pathname.startsWith(item.to));
  useEffect(() => { setOpen(false); document.title = `${current?.label || '管理中心'} · AI 魔法学院`; }, [location.pathname, current?.label]);
  return <div className="admin-console">
    <a className="admin-skip" href="#admin-content">跳转到主要内容</a>
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-brand"><strong>AI 魔法学院</strong><span>平台管理中心</span></div>
        <button className="secondary-button admin-menu" aria-expanded={open} aria-controls="admin-navigation" onClick={() => setOpen(!open)}>导航菜单</button>
        <nav id="admin-navigation" className={`admin-navigation ${open ? 'is-open' : ''}`} aria-label="平台管理导航">
          {navigation.map((item) => item.heading ? <h2 key={item.heading}>{item.heading}</h2> : <NavLink key={item.to} to={item.to}>{item.label}</NavLink>)}
        </nav>
        <div className="admin-account"><strong>{user?.displayName || user?.login}</strong><span>{user?.login}</span><div className="row-actions"><NavLink to="/security">账号安全</NavLink><button onClick={onLogout}>退出登录</button></div></div>
      </aside>
      <main className="admin-main" id="admin-content" tabIndex={-1}>
        <div className="admin-topbar"><span>平台管理 / <strong>{current?.label || '管理中心'}</strong></span><span>平台管理员</span></div>
        <div className="page-content">{children}</div>
      </main>
    </div>
  </div>;
}
