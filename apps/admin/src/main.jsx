import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AppShell, ApiError, clearSession, createApiClient, LoginPanel, readSession, writeSession } from '@platform/shared';
import { CourseSeriesDetailPage, CourseSeriesListPage } from './components/CourseManagement.jsx';
import { ModelCompute } from './pages/ModelCompute.jsx';
import { AdminPermissionGate, visibleNavigation } from './shared.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { Organizations, Authorizations } from './pages/Organizations.jsx';
// P03（2026-09-18 按线框图对齐）：机构拆成「列表 / 详情 / 课包与授权次数 / 授权次数变更记录」四条路由，
// 各有自己的地址（可深链、可刷新、可后退）—— 与 /courses、/courses/:seriesId 的做法一致。
import { OrganizationDetail } from './pages/OrganizationDetail.jsx';
import { OrganizationQuota } from './pages/OrganizationQuota.jsx';
import { OrganizationQuotaChanges } from './pages/OrganizationQuotaChanges.jsx';
import { PlatformUsers } from './pages/PlatformUsers.jsx';
// 联系我们（商机）：官网「联系我们」表单的提交落在 leads 表，这个页面是它的收件箱。
import { Leads } from './pages/Leads.jsx';
import { PlatformAdmins } from './pages/PlatformAdmins.jsx';
import { PlatformAudit } from './pages/PlatformAudit.jsx';
import { PlatformNotifications } from './pages/PlatformNotifications.jsx';
import { PlatformWorks } from './pages/PlatformWorks.jsx';
import { AdminInbox } from './pages/AdminInbox.jsx';
import { AdminMaterials } from './pages/AdminMaterials.jsx';
import { WebsiteContent } from './pages/WebsiteContent.jsx';
import { Security } from './pages/Security.jsx';
import { ClientUpdate } from './pages/ClientUpdate.jsx';
import '@platform/shared/styles.css';
import './admin.css';
import { AdminShell } from './components/AdminShell.jsx';

const APP_BASENAME = (import.meta.env?.VITE_APP_BASE || '/admin').replace(/\/$/, '');

export function App() {
  const [session, setSession] = useState(readSession); const navigate = useNavigate();
  const api = useMemo(() => createApiClient({ getToken: () => session?.token, onUnauthorized: () => { clearSession(); setSession(null); navigate('/login'); } }), [session?.token, navigate]);
  useEffect(() => { if (!session?.token) return; api.me().then((user) => setSession(writeSession({ ...session, user, organization: user.organization }))).catch(() => {}); }, [session?.token]);
  async function login(credentials) { const data = await api.login(credentials); if (data.user.role !== 'SUPER_ADMIN') throw new ApiError('该账号没有平台管理权限', { code: 'ROLE_MISMATCH' }); setSession(writeSession(data)); navigate('/dashboard'); }
  async function logout() { try { await api.logout(); } catch { /* local logout still succeeds */ } clearSession(); setSession(null); navigate('/login'); }
  if (!session) return <Routes><Route path="*" element={<LoginPanel title="平台管理中心" description="为课程、机构和算力运营提供统一的控制台。" clientType="admin" onLogin={login} />} /></Routes>;
  if (session.user?.role !== 'SUPER_ADMIN') return <LoginPanel title="平台管理中心" description="当前会话没有平台管理权限。" clientType="admin" onLogin={login} />;
  const page = (permission, element) => <AdminPermissionGate user={session.user} permission={permission}>{element}</AdminPermissionGate>;
  return <AdminShell product="灵动ai学院" roleLabel="平台管理员" user={session.user} navigation={visibleNavigation(session.user)} onLogout={logout} onChangePassword={() => navigate('/security')}><Routes>
    <Route path="/dashboard" element={page('ADMIN_ANALYTICS', <Dashboard api={api} />)} />
    <Route path="/organizations" element={page('ADMIN_ORGANIZATIONS', <Organizations api={api} />)} />
    <Route path="/leads" element={page('ADMIN_ORGANIZATIONS', <Leads api={api} />)} />
    <Route path="/organizations/:orgId" element={page('ADMIN_ORGANIZATIONS', <OrganizationDetail api={api} />)} />
    <Route path="/organizations/:orgId/quota" element={page('ADMIN_ORGANIZATIONS', <OrganizationQuota api={api} />)} />
    <Route path="/organizations/:orgId/quota-changes" element={page('ADMIN_ORGANIZATIONS', <OrganizationQuotaChanges api={api} />)} />
    <Route path="/authorizations" element={page('ADMIN_BILLING', <Authorizations api={api} />)} />
    {/* 课包拆成两条路由：列表与详情各有自己的地址（可深链、可刷新、可后退） */}
    <Route path="/courses" element={page('ADMIN_COURSES', <CourseSeriesListPage api={api} />)} />
    <Route path="/courses/:seriesId" element={page('ADMIN_COURSES', <CourseSeriesDetailPage api={api} />)} />
    <Route path="/users" element={page('ADMIN_ORGANIZATIONS', <PlatformUsers api={api} />)} />
    <Route path="/works" element={page('ADMIN_WORKS', <PlatformWorks api={api} />)} />
    {/* 2026-09-13：原「算力网关」与「计费与模型」合并成一页 —— 两个页面让人来回跳，理解成本太高。
        2026-09-18 路由收敛（用户口径「一个页面一个名字」「两个僵尸重定向删掉」）：
        删掉 /billing → /compute、/compute → /compute/config 这两条二层跳转（路径名跟页面名也对不上），
        只留两条直达路由 —— /compute/config（渠道与价格）、/compute/usage（用量与成本）。 */}
    <Route path="/compute/config" element={page('ADMIN_BILLING', <ModelCompute api={api} />)} />
    <Route path="/compute/usage" element={page('ADMIN_BILLING', <ModelCompute api={api} />)} />
    <Route path="/materials" element={page('ADMIN_CONTENT', <AdminMaterials api={api} />)} />
    <Route path="/website-content" element={page('ADMIN_CONTENT', <WebsiteContent api={api} />)} />
    <Route path="/inbox" element={page('ADMIN_CONTENT', <AdminInbox api={api} />)} />
    <Route path="/admins" element={page('ADMIN_AUDIT', <PlatformAdmins api={api} currentUser={session.user} />)} />
    <Route path="/audit" element={page('ADMIN_AUDIT', <PlatformAudit api={api} />)} />
    <Route path="/notifications" element={page('ADMIN_CONTENT', <PlatformNotifications api={api} />)} />
    <Route path="/client-update" element={page('ADMIN_AUDIT', <ClientUpdate api={api} />)} />
    <Route path="/security" element={<Security api={api} onSignedOut={() => { clearSession(); setSession(null); navigate('/login'); }} />} />
    <Route path="*" element={<Navigate to="/dashboard" replace />} />
  </Routes>
  </AdminShell>;
}

createRoot(document.getElementById('root')).render(<BrowserRouter basename={APP_BASENAME}><App /></BrowserRouter>);

