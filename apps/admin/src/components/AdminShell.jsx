import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { BrandLogo } from '@platform/shared';

export function AdminShell({ user, navigation = [], onLogout, children }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // ⚠️ 2026-09-26 全站审计：用 find 取"第一个前缀匹配"时，`/compute/names`（页签路由、不在菜单里）
  //    会落不到任何菜单项 → 顶栏与浏览器标题回落成「管理中心」，与页面自己的标题不一致。取**最长前缀**。
  const current = navigation
    .filter((item) => item.to && location.pathname.startsWith(item.to))
    .sort((a, b) => b.to.length - a.to.length)[0];
  useEffect(() => { setOpen(false); document.title = `${current?.label || '管理中心'} · 灵动ai学院`; }, [location.pathname, current?.label]);
  return <div className="admin-console">
    <a className="admin-skip" href="#admin-content">跳转到主要内容</a>
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-brand"><BrandLogo height={24} /><span>平台管理中心</span></div>
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
