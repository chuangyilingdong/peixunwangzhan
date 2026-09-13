import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AppShell, clearSession, createApiClient, LoginPanel, readSession, writeSession } from '@platform/shared';
import { CourseSeriesDetailPage, CourseSeriesListPage } from './components/CourseManagement.jsx';
import { ModelCompute } from './pages/ModelCompute.jsx';
import { AdminPermissionGate, demos, visibleNavigation } from './shared.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { Organizations } from './pages/Organizations.jsx';
import { PlatformUsers } from './pages/PlatformUsers.jsx';
import { PlatformAdmins } from './pages/PlatformAdmins.jsx';
import { PlatformAudit } from './pages/PlatformAudit.jsx';
import { PlatformNotifications } from './pages/PlatformNotifications.jsx';
import { PlatformWorks } from './pages/PlatformWorks.jsx';
import { AdminInbox } from './pages/AdminInbox.jsx';
import { AdminMaterials } from './pages/AdminMaterials.jsx';
import { WebsiteContent } from './pages/WebsiteContent.jsx';
import { Security } from './pages/Security.jsx';
import '@platform/shared/styles.css';

const APP_BASENAME = (import.meta.env?.VITE_APP_BASE || '/admin').replace(/\/$/, '');

export function App() {
  const [session, setSession] = useState(readSession); const navigate = useNavigate();
  const api = useMemo(() => createApiClient({ getToken: () => session?.token, onUnauthorized: () => { clearSession(); setSession(null); navigate('/login'); } }), [session?.token, navigate]);
  useEffect(() => { if (!session?.token) return; api.me().then((user) => setSession(writeSession({ ...session, user, organization: user.organization }))).catch(() => {}); }, [session?.token]);
  async function login(credentials) { const data = await api.login(credentials); if (data.user.role !== 'SUPER_ADMIN') throw new ApiError('该账号没有平台管理权限', { code: 'ROLE_MISMATCH' }); setSession(writeSession(data)); navigate('/dashboard'); }
  async function logout() { try { await api.logout(); } catch { /* local logout still succeeds */ } clearSession(); setSession(null); navigate('/login'); }
  if (!session) return <Routes><Route path="*" element={<LoginPanel title="平台管理中心" description="为课程、机构和算力运营提供统一的控制台。" clientType="admin" demos={demos} onLogin={login} />} /></Routes>;
  if (session.user?.role !== 'SUPER_ADMIN') return <LoginPanel title="平台管理中心" description="当前会话没有平台管理权限。" clientType="admin" demos={demos} onLogin={login} />;
  const page = (permission, element) => <AdminPermissionGate user={session.user} permission={permission}>{element}</AdminPermissionGate>;
  return <AppShell product="AI 魔法学院" roleLabel="平台管理员" user={session.user} navigation={visibleNavigation(session.user)} onLogout={logout} onChangePassword={() => navigate('/security')}><Routes>
    <Route path="/dashboard" element={page('ADMIN_ANALYTICS', <Dashboard api={api} />)} />
    <Route path="/organizations" element={page('ADMIN_ORGANIZATIONS', <Organizations api={api} />)} />
    {/* 课包拆成两条路由：列表与详情各有自己的地址（可深链、可刷新、可后退） */}
    <Route path="/courses" element={page('ADMIN_COURSES', <CourseSeriesListPage api={api} />)} />
    <Route path="/courses/:seriesId" element={page('ADMIN_COURSES', <CourseSeriesDetailPage api={api} />)} />
    <Route path="/users" element={page('ADMIN_ORGANIZATIONS', <PlatformUsers api={api} />)} />
    <Route path="/works" element={page('ADMIN_WORKS', <PlatformWorks api={api} />)} />
    {/* 2026-09-13：原「算力网关」与「计费与模型」合并成一页 —— 两个页面让人来回跳，理解成本太高 */}
    <Route path="/compute" element={page('ADMIN_BILLING', <ModelCompute api={api} />)} />
    <Route path="/billing" element={<Navigate to="/compute" replace />} />
    <Route path="/materials" element={page('ADMIN_CONTENT', <AdminMaterials api={api} />)} />
    <Route path="/website-content" element={page('ADMIN_CONTENT', <WebsiteContent api={api} />)} />
    <Route path="/inbox" element={page('ADMIN_CONTENT', <AdminInbox api={api} />)} />
    <Route path="/admins" element={page('ADMIN_AUDIT', <PlatformAdmins api={api} currentUser={session.user} />)} />
    <Route path="/audit" element={page('ADMIN_AUDIT', <PlatformAudit api={api} />)} />
    <Route path="/notifications" element={page('ADMIN_CONTENT', <PlatformNotifications api={api} />)} />
    <Route path="/security" element={<Security api={api} onSignedOut={() => { clearSession(); setSession(null); navigate('/login'); }} />} />
    <Route path="*" element={<Navigate to="/dashboard" replace />} />
  </Routes>
  </AppShell>;
}

createRoot(document.getElementById('root')).render(<BrowserRouter basename={APP_BASENAME}><App /></BrowserRouter>);

