import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ApiError, AppShell, clearSession, createApiClient, Empty, ErrorState, formatCredits, formatDate, Loading, LoginPanel, MetricCard, Notice, PageHeader, Panel, readSession, Status, writeSession } from '@platform/shared';
import '@platform/shared/styles.css';

const navigation = [
  { heading: '运营中心' },
  { to: '/dashboard', icon: '◈', label: '平台概览' },
  { to: '/organizations', icon: '♙', label: '机构管理' },
  { to: '/users', icon: '◉', label: '平台用户' },
  { heading: '内容与活动' },
  { to: '/courses', icon: '▦', label: '平台课程' },
  { to: '/marketplace', icon: '✦', label: '课程广场' },
  { to: '/works', icon: '◇', label: '作品库' },
  { to: '/hackathon', icon: '⚑', label: '黑客松' },
  { heading: '计费与设置' },
  { to: '/billing', icon: '◌', label: '计费与模型' },
  { to: '/materials', icon: '▤', label: '素材与物料' },
  { to: '/inbox', icon: '✉', label: '站内信' },
  { to: '/admins', icon: '⚙', label: '平台管理员' },
];
const demos = [{ label: '平台超管', login: 'root', password: 'admin123' }];

function useData(load, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const refresh = async () => {
    setState((old) => ({ ...old, loading: true, error: null }));
    try { setState({ loading: false, error: null, data: await load() }); }
    catch (error) { setState({ loading: false, error, data: null }); }
  };
  useEffect(() => { refresh(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh };
}

function Dashboard({ api }) {
  const { loading, error, data, refresh } = useData(async () => {
    const [organizations, usage] = await Promise.all([api.get('admin/organizations'), api.get('admin/billing/usage-overview')]);
    return { organizations: organizations.items, usage };
  }, [api]);
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  const active = data.organizations.filter((item) => ['ACTIVE', 'TRIAL'].includes(item.status)).length;
  return <>
    <PageHeader eyebrow="平台控制台" title="运营总览" description="集中查看机构规模、积分余额与模型用量。" />
    <div className="metrics">
      <MetricCard label="机构总数" value={data.organizations.length} hint={`${active} 个可用机构`} />
      <MetricCard label="机构积分池" value={formatCredits(data.usage.totalCredits)} hint="所有机构当前余额" tone="teal" />
      <MetricCard label="调用类型" value={data.usage.usage.length} hint="已产生用量的能力类型" tone="orange" />
      <MetricCard label="Top 机构" value={data.usage.topOrgs[0]?.name || '—'} hint="按累计消耗排序" tone="pink" />
    </div>
    <div className="split">
      <Panel title="用量最高的机构"><table><thead><tr><th>机构</th><th>累计积分</th></tr></thead><tbody>{data.usage.topOrgs.map((item) => <tr key={item.id}><td>{item.name}</td><td>{formatCredits(item.credits)}</td></tr>)}</tbody></table></Panel>
      <Panel title="能力用量"><table><thead><tr><th>能力</th><th>调用次数</th><th>积分</th></tr></thead><tbody>{data.usage.usage.map((item) => <tr key={item.modality}><td>{item.modality}</td><td>{item.calls}</td><td>{formatCredits(item.credits)}</td></tr>)}</tbody></table></Panel>
    </div>
  </>;
}

function Organizations({ api }) {
  const { loading, error, data, refresh } = useData(() => api.get('admin/organizations'), [api]);
  const [form, setForm] = useState({ name: '', adminLogin: '', adminPassword: 'org123', baseTeacherSeats: 3 });
  const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false);
  async function create(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try { await api.post('admin/organizations', { ...form, baseTeacherSeats: Number(form.baseTeacherSeats) }); setForm({ name: '', adminLogin: '', adminPassword: 'org123', baseTeacherSeats: 3 }); setMessage('机构已创建。'); refresh(); }
    catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  return <>
    <PageHeader eyebrow="平台教务" title="机构管理" description="创建机构并查看合同、教师席位与服务状态。" />
    <div className="split"><Panel title="新建机构"><form onSubmit={create}>
      <label>机构名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
      <label>管理员登录名（可选）<input value={form.adminLogin} onChange={(e) => setForm({ ...form, adminLogin: e.target.value })} /></label>
      <div className="form-grid"><label>初始密码<input value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} /></label><label>基础教师席位<input type="number" min="0" value={form.baseTeacherSeats} onChange={(e) => setForm({ ...form, baseTeacherSeats: e.target.value })} /></label></div>
      {message && <Notice tone={message === '机构已创建。' ? 'success' : 'danger'}>{message}</Notice>}<button className="primary-button" disabled={saving}>{saving ? '创建中…' : '创建机构'}</button>
    </form></Panel><Panel title="使用说明"><Notice>创建机构后，可通过平台课包页向该机构授权课程；机构管理员再创建班级与学员。</Notice></Panel></div>
    <Panel title="已有机构" actions={<button className="secondary-button" onClick={refresh}>刷新</button>}>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={refresh} /> : data.items.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>状态</th><th>合同到期</th><th>教师席位</th><th>创建时间</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><div className="muted">{item.id}</div></td><td><Status value={item.status} /></td><td>{formatDate(item.contractExpiresAt)}</td><td>{item.teacherUsedSeats} / {item.teacherSeats}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div> : <Empty />}
    </Panel>
  </>;
}

function Courses({ api }) {
  const courses = useData(() => api.get('admin/course-series'), [api]);
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const [form, setForm] = useState({ title: '', description: '', visibility: 'ALL_ORGS', lessons: '' });
  const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false); const [assignment, setAssignment] = useState({});
  async function create(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try { const lessons = form.lessons.split('\n').map((title) => title.trim()).filter(Boolean).map((title) => ({ title })); await api.post('admin/course-series', { title: form.title, description: form.description, visibility: form.visibility, lessons }); setForm({ title: '', description: '', visibility: 'ALL_ORGS', lessons: '' }); setMessage('平台课包已创建。'); courses.refresh(); }
    catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  async function assign(courseId) { const orgId = assignment[courseId]; if (!orgId) return; try { await api.post(`admin/course-series/${courseId}/assignments`, { orgIds: [orgId] }); setMessage('课包授权成功。'); } catch (err) { setMessage(err.message); } }
  return <>
    <PageHeader eyebrow="课程资产" title="平台课包" description="维护平台级课程，并按机构精确授权。" />
    <div className="split"><Panel title="新建平台课包"><form onSubmit={create}>
      <label>课包标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label><label>课程简介<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label>可见范围<select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}><option value="ALL_ORGS">所有机构</option><option value="ASSIGNED_ORGS">仅已授权机构</option><option value="PRIVATE">私有</option></select></label>
      <label>课时标题（每行一课）<textarea placeholder={'第 1 课：认识 AI\n第 2 课：创意表达'} value={form.lessons} onChange={(e) => setForm({ ...form, lessons: e.target.value })} /></label>
      {message && <Notice tone={message.includes('成功') || message.includes('创建') ? 'success' : 'danger'}>{message}</Notice>}<button className="primary-button" disabled={saving}>{saving ? '保存中…' : '创建课包'}</button>
    </form></Panel><Panel title="授权说明"><Notice>“仅已授权机构”课包必须完成授权后，才能出现在机构端课程列表和班级课单中。</Notice></Panel></div>
    <Panel title="已创建课包" actions={<button className="secondary-button" onClick={courses.refresh}>刷新</button>}>
      {courses.loading || organizations.loading ? <Loading /> : courses.error ? <ErrorState error={courses.error} onRetry={courses.refresh} /> : courses.data.items.length ? <div className="card-list">{courses.data.items.map((course) => <article className="item-card" key={course.id}><div className="row-actions"><h3>{course.title}</h3><Status value={course.status} /><span className="muted">{course.visibility}</span></div><p>{course.description || '暂无课程简介'}</p><ol className="course-lessons">{course.lessons.map((lesson) => <li key={lesson.id}>{lesson.title} · {lesson.durationMinutes} 分钟</li>)}</ol><div className="row-actions top-gap"><select value={assignment[course.id] || ''} onChange={(e) => setAssignment({ ...assignment, [course.id]: e.target.value })}><option value="">选择机构进行授权</option>{organizations.data.items.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</select><button className="secondary-button" onClick={() => assign(course.id)}>授权给机构</button></div></article>)}</div> : <Empty title="尚未创建平台课包" />}
    </Panel>
  </>;
}


function PlatformUsers({ api }) {
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const [filters, setFilters] = useState({ role: '', orgId: '', search: '' });
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)), [filters]);
  const users = useData(() => api.get(`admin/platform-users?${query.toString()}`), [api, query]);
  const [message, setMessage] = useState('');
  const roleLabels = { SUPER_ADMIN: '平台超管', ORG_ADMIN: '机构管理员', TEACHER: '教师', STUDENT: '学员' };
  return <>
    <PageHeader eyebrow="平台教务" title="平台用户" description="按角色、机构和关键词查看全平台真实账号、套餐与状态。" actions={<button className="secondary-button" onClick={users.refresh}>刷新</button>} />
    <Panel title="筛选条件">
      <div className="form-grid">
        <label>角色<select value={filters.role} onChange={(e) => setFilters({ ...filters, role: e.target.value })}><option value="">全部角色</option>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>机构<select value={filters.orgId} onChange={(e) => setFilters({ ...filters, orgId: e.target.value })}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) || null}</select></label>
        <label>关键词<input value={filters.search} placeholder="登录名 / 姓名 / 手机号" onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
      </div>
      {message && <Notice tone="info">{message}</Notice>}
    </Panel>
    <Panel title="用户列表">
      {users.loading || organizations.loading ? <Loading /> : users.error ? <ErrorState error={users.error} onRetry={users.refresh} /> : users.data.items.length ? <div className="table-wrap"><table><thead><tr><th>用户</th><th>角色</th><th>机构</th><th>套餐</th><th>状态</th><th>有效期至</th><th>创建时间</th></tr></thead><tbody>{users.data.items.map((item) => <tr key={item.id}><td><strong>{item.displayName}</strong><div className="muted">{item.login}</div></td><td>{roleLabels[item.role] || item.role}</td><td>{item.organizationName || '平台'}</td><td>{item.role === 'STUDENT' ? (item.billingPackageName || '未绑定') : '—'}</td><td><Status value={item.status} /></td><td>{formatDate(item.expiresAt) || '长期'}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div> : <Empty title="没有符合条件的用户" />}
    </Panel>
  </>;
}

function PlatformAdmins({ api, currentUser }) {
  const admins = useData(() => api.get('admin/platform-admins'), [api]);
  const permissionOptions = ['ADMIN_DASHBOARD', 'ADMIN_ORGANIZATIONS', 'ADMIN_USERS', 'ADMIN_COURSES', 'ADMIN_WORKS', 'ADMIN_HACKATHON', 'ADMIN_BILLING', 'ADMIN_MATERIALS', 'ADMIN_INBOX', 'ADMIN_ADMINS', 'ADMIN_ADJUSTMENT'];
  const [form, setForm] = useState({ login: '', displayName: '', password: '', permissions: [] });
  const [editing, setEditing] = useState(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  function toggle(permission) { setForm((current) => ({ ...current, permissions: current.permissions.includes(permission) ? current.permissions.filter((item) => item !== permission) : [...current.permissions, permission] })); }
  async function create(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try { await api.post('admin/platform-admins', form); setForm({ login: '', displayName: '', password: '', permissions: [] }); setMessage('平台管理员已创建。'); admins.refresh(); }
    catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  async function update(target, payload, successMessage) {
    try { await api.put(`admin/platform-admins/${target.id}`, payload); setMessage(successMessage); admins.refresh(); if (editing?.id === target.id) setEditing(null); }
    catch (err) { setMessage(err.message); }
  }
  async function save(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try { await api.put(`admin/platform-admins/${editing.id}`, { displayName: form.displayName, permissions: form.permissions }); setMessage('平台管理员已更新。'); setEditing(null); admins.refresh(); }
    catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  return <>
    <PageHeader eyebrow="平台系统" title="平台管理员" description="维护平台运营账号、权限码和登录安全。" actions={<button className="secondary-button" onClick={admins.refresh}>刷新</button>} />
    <div className="split">
      <Panel title={editing ? `编辑管理员：${editing.displayName}` : '新建平台管理员'}>
        <form onSubmit={editing ? save : create}>
          {!editing && <div className="form-grid"><label>登录名<input value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required /></label><label>初始密码<input value={form.password} minLength={6} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label></div>}
          <label>姓名<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></label>
          <label>权限码</label>
          <div className="row-actions">{permissionOptions.map((permission) => <label key={permission} className="checkbox-option"><input type="checkbox" checked={form.permissions.includes(permission)} onChange={() => toggle(permission)} />{permission}</label>)}</div>
          {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
          <div className="row-actions">
            <button className="primary-button" disabled={saving}>{saving ? '保存中…' : editing ? '保存管理员' : '创建管理员'}</button>
            {editing && <button type="button" className="secondary-button" onClick={() => { setEditing(null); setForm({ login: '', displayName: '', password: '', permissions: [] }); }}>取消编辑</button>}
          </div>
        </form>
      </Panel>
      <Panel title="权限说明"><Notice>当前本地安全基线仍按 SUPER_ADMIN 角色放行；权限码先完成数据结构、白名单和页面配置能力，后续再逐域收紧 API 判定。不能停用当前登录账号由后端强制校验。</Notice></Panel>
    </div>
    <Panel title="管理员列表">
      {admins.loading ? <Loading /> : admins.error ? <ErrorState error={admins.error} onRetry={admins.refresh} /> : admins.data.items.length ? <div className="table-wrap"><table><thead><tr><th>账号</th><th>状态</th><th>权限码</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{admins.data.items.map((item) => <tr key={item.id}><td><strong>{item.displayName}</strong><div className="muted">{item.login}</div>{item.id === currentUser?.id && <span className="muted">当前账号</span>}</td><td><Status value={item.status} /></td><td>{item.permissions.length ? item.permissions.join(', ') : '全量（本地基线）'}</td><td>{formatDate(item.updatedAt)}</td><td><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setForm({ login: '', displayName: item.displayName, password: '', permissions: item.permissions }); }}>编辑</button><button className="text-button" onClick={() => { const password = window.prompt('请输入至少 6 位新密码'); if (password) update(item, { password }, '管理员密码已重置。'); }}>重置密码</button>{item.status === 'ACTIVE' ? <button className="text-button" onClick={() => update(item, { status: 'DISABLED' }, '管理员已停用。')}>停用</button> : <button className="text-button" onClick={() => update(item, { status: 'ACTIVE' }, '管理员已启用。')}>启用</button>}</div></td></tr>)}</tbody></table></div> : <Empty title="暂无平台管理员" />}
    </Panel>
  </>;
}

function PlatformWorks({ api }) {
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const [filters, setFilters] = useState({ status: '', orgId: '', search: '' });
  const [message, setMessage] = useState('');
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)), [filters]);
  const works = useData(() => api.get(`admin/works?${query.toString()}`), [api, query]);
  const statusLabels = { PENDING: '待审核', APPROVED: '已通过', REJECTED: '已下架', PUBLISHED: '已发布' };
  async function unpublish() {
    if (!action) return;
    setSaving(true); setMessage('');
    try {
      await api.put(`admin/works/${action.id}/unpublish`, { reason });
      setMessage(`已下架《${action.title}》。`);
      setAction(null); setReason(''); works.refresh();
    } catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  return <>
    <PageHeader eyebrow="内容治理" title="平台作品库" description="聚合查看各机构作品状态，并对公开发布作品执行平台下架。" actions={<button className="secondary-button" onClick={works.refresh}>刷新</button>} />
    <Panel title="筛选条件">
      <div className="form-grid">
        <label>状态<select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>机构<select value={filters.orgId} onChange={(e) => setFilters({ ...filters, orgId: e.target.value })}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) || null}</select></label>
        <label>关键词<input value={filters.search} placeholder="作品 / 学员 / 机构" onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
      </div>
      {message && <Notice tone={message.includes('已下架') ? 'success' : 'danger'}>{message}</Notice>}
    </Panel>
    <Panel title="作品列表">
      {works.loading || organizations.loading ? <Loading /> : works.error ? <ErrorState error={works.error} onRetry={works.refresh} /> : works.data.items.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>学员 / 机构</th><th>班级 / 课时</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{works.data.items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><div className="muted">{item.description || '暂无描述'}</div></td><td><strong>{item.studentName || item.studentId}</strong><div className="muted">{item.organizationName || '未绑定机构'}</div></td><td>{item.className || '—'}{item.courseLessonTitle ? <div className="muted">{item.courseLessonTitle}</div> : null}</td><td><Status value={item.status} />{item.status === 'REJECTED' && item.teacherComment ? <div className="muted">{item.teacherComment}</div> : null}</td><td>{formatDate(item.submittedAt)}</td><td>{item.status === 'PUBLISHED' ? <button className="secondary-button" onClick={() => { setAction(item); setReason(''); }}>平台下架</button> : <span className="muted">—</span>}</td></tr>)}</tbody></table></div> : <Empty title="没有符合条件的作品" />}
    </Panel>
    {action ? <Panel title={`下架《${action.title}》`}>
      <label>下架原因<input value={reason} placeholder="例如：内容不适合公开展示" onChange={(e) => setReason(e.target.value)} /></label>
      <div className="row-actions top-gap"><button className="primary-button" disabled={saving} onClick={unpublish}>{saving ? '处理中…' : '确认下架'}</button><button className="secondary-button" disabled={saving} onClick={() => { setAction(null); setReason(''); }}>取消</button></div>
    </Panel> : null}
  </>;
}

function PlatformBilling({ api }) {
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const overview = useData(() => api.get('admin/billing/usage-overview'), [api]);
  const [filters, setFilters] = useState({ days: '30', orgId: '', modality: '', status: '', search: '' });
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)), [filters]);
  const records = useData(() => api.get(`admin/billing/usage-records?${query.toString()}`), [api, query]);
  return <>
    <PageHeader eyebrow="平台计费" title="计费与模型" description="查看全平台魔法石余额、能力消耗与逐条调用明细。" actions={<button className="secondary-button" onClick={() => { overview.refresh(); records.refresh(); }}>刷新</button>} />
    <div className="metrics">
      <MetricCard label="机构积分池" value={formatCredits(overview.data?.totalCredits || 0)} hint="所有机构当前余额合计" />
      <MetricCard label="能力类型" value={overview.data?.usage?.length || 0} hint="已产生用量的模型能力" tone="teal" />
      <MetricCard label="Top 机构" value={overview.data?.topOrgs?.[0]?.name || '—'} hint={overview.data?.topOrgs?.[0] ? `累计消耗 ${formatCredits(overview.data.topOrgs[0].credits)}` : '暂无消耗'} tone="orange" />
      <MetricCard label="当前明细" value={records.data?.total || 0} hint="按筛选条件命中的记录数" tone="pink" />
    </div>
    <div className="split">
      <Panel title="能力消耗"><table><thead><tr><th>能力</th><th>调用次数</th><th>积分</th></tr></thead><tbody>{(overview.data?.usage || []).map((item) => <tr key={item.modality}><td>{item.modality}</td><td>{item.calls}</td><td>{formatCredits(item.credits)}</td></tr>)}</tbody></table></Panel>
      <Panel title="机构消耗 Top 10"><table><thead><tr><th>机构</th><th>累计积分</th></tr></thead><tbody>{(overview.data?.topOrgs || []).map((item) => <tr key={item.id}><td>{item.name}</td><td>{formatCredits(item.credits)}</td></tr>)}</tbody></table></Panel>
    </div>
    <Panel title="用量明细筛选">
      <div className="form-grid">
        <label>时间范围<select value={filters.days} onChange={(e) => setFilters({ ...filters, days: e.target.value })}><option value="1">今日</option><option value="7">近 7 日</option><option value="30">近 30 日</option><option value="365">近一年</option></select></label>
        <label>机构<select value={filters.orgId} onChange={(e) => setFilters({ ...filters, orgId: e.target.value })}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) || null}</select></label>
        <label>能力<input value={filters.modality} placeholder="TEXT / IMAGE / MUSIC" onChange={(e) => setFilters({ ...filters, modality: e.target.value })} /></label>
        <label>状态<select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">全部状态</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="BLOCKED">拦截</option></select></label>
        <label>关键词<input value={filters.search} placeholder="机构 / 用户 / 项目 / 作品" onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
      </div>
    </Panel>
    <Panel title="调用明细">
      {overview.loading || records.loading || organizations.loading ? <Loading label="正在读取计费数据…" /> : records.error ? <ErrorState error={records.error} onRetry={records.refresh} /> : records.data.items.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>机构 / 用户</th><th>能力 / 模型</th><th>上下文</th><th>积分</th><th>状态</th></tr></thead><tbody>{records.data.items.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}</td><td><strong>{item.organizationName || item.orgId}</strong><div className="muted">{item.userName || item.userLogin || item.userId}</div></td><td>{item.modality}<div className="muted">{item.model}</div></td><td>{item.className || '非课堂调用'}{item.projectTitle ? <div className="muted">项目：{item.projectTitle}</div> : null}{item.workTitle ? <div className="muted">作品：{item.workTitle}</div> : null}</td><td>{formatCredits(item.credits)}</td><td><Status value={item.status} /></td></tr>)}</tbody></table></div> : <Empty title="所选范围内暂无调用记录" />}
    </Panel>
  </>;
}

function PlatformPage({ kind }) {
  const pages = {
    users: ['平台用户', '统一查看机构管理员、教师与学员的账号状态，支持后续接入筛选、启停和变更记录。', [['机构账号', '按机构归属查看管理者、教师和学员'], ['账号安全', '登录状态、有效期与权限将统一在此管理']]],
    marketplace: ['课程广场', '集中浏览可下发的主题课包、课时与示范素材，支持机构授权和版本管理。', [['标准课包', '11 门系统课程、87 节课时'], ['授课资源', 'PPT、互动课件与课堂素材统一管理']]],
    works: ['平台作品库', '聚合机构作品展厅的公开成果，便于审核、运营和沉淀优质案例。', [['作品审核', '查看发布状态与机构归属'], ['精选推荐', '后续可配置推荐位与展示专题']]],
    hackathon: ['黑客松', '配置赛季、作品征集、审核与奖励，帮助机构把课堂作品延展为创作活动。', [['赛季管理', '创建主题、时间范围与参与机构'], ['作品审核', '待审、入选、驳回与撤回统一记录']]],
    billing: ['计费与模型', '统一维护机构积分池、能力开关、模型矩阵和用量规则，让课堂 AI 可用可管。', [['魔法石用量', '机构充值、按调用扣减、余额提醒'], ['模型能力', '文本、图像、音频与视频按权限配置']]],
    materials: ['素材与宣传物料', '管理课程素材、机构可下载物料与招生内容包。', [['素材中心', '按课程、主题与类型组织素材'], ['宣传物料', '海报、课程介绍与合作资料统一分发']]],
    inbox: ['站内信', '平台向机构发送开课、运营与系统通知的统一入口。', [['通知中心', '未读数、已读与跳转链接'], ['消息模板', '后续可按场景配置消息模板']]],
    admins: ['平台管理员', '管理平台运营账号与权限码，重要业务权限由后端继续校验。', [['角色权限', '按运营、课程、计费等域配置访问范围'], ['账号安全', '启停、重置密码与操作记录']]],
  };
  const [title, desc, cards] = pages[kind];
  return <><PageHeader eyebrow="AI魔法学院 · 平台控制台" title={title} description={desc} actions={<button className="primary-button">新建 / 配置</button>} /><div className="metrics">{cards.map((item, index) => <MetricCard key={item[0]} label={item[0]} value={index ? '待配置' : '准备就绪'} hint={item[1]} tone={['violet','teal'][index]} />)}</div><Panel title="建设说明"><Notice tone="info">此页面已按 AI魔法学院的信息架构接入平台端导航与视觉壳层；需要服务端数据的筛选、编辑和审批操作将在对应 API 完成后接入，不会伪造业务数据。</Notice></Panel></>;
}

function App() {
  const [session, setSession] = useState(readSession); const navigate = useNavigate();
  const api = useMemo(() => createApiClient({ getToken: () => session?.token, onUnauthorized: () => { clearSession(); setSession(null); navigate('/login'); } }), [session?.token, navigate]);
  useEffect(() => { if (!session?.token) return; api.me().then((user) => setSession(writeSession({ ...session, user, organization: user.organization }))).catch(() => {}); }, [session?.token]);
  async function login(credentials) { const data = await api.login(credentials); if (data.user.role !== 'SUPER_ADMIN') throw new ApiError('该账号没有平台管理权限', { code: 'ROLE_MISMATCH' }); setSession(writeSession(data)); navigate('/dashboard'); }
  async function logout() { try { await api.logout(); } catch { /* local logout still succeeds */ } clearSession(); setSession(null); navigate('/login'); }
  if (!session) return <Routes><Route path="*" element={<LoginPanel title="平台管理中心" description="为课程、机构和积分运营提供统一的控制台。" clientType="admin" demos={demos} onLogin={login} />} /></Routes>;
  if (session.user?.role !== 'SUPER_ADMIN') return <LoginPanel title="平台管理中心" description="当前会话没有平台管理权限。" clientType="admin" demos={demos} onLogin={login} />;
  return <AppShell product="AI 魔法学院" roleLabel="平台超管" user={session.user} navigation={navigation} onLogout={logout}><Routes><Route path="/dashboard" element={<Dashboard api={api} />} /><Route path="/organizations" element={<Organizations api={api} />} /><Route path="/courses" element={<Courses api={api} />} /><Route path="/users" element={<PlatformUsers api={api} />} /><Route path="/marketplace" element={<PlatformPage kind="marketplace" />} /><Route path="/works" element={<PlatformWorks api={api} />} /><Route path="/hackathon" element={<PlatformPage kind="hackathon" />} /><Route path="/billing" element={<PlatformBilling api={api} />} /><Route path="/materials" element={<PlatformPage kind="materials" />} /><Route path="/inbox" element={<PlatformPage kind="inbox" />} /><Route path="/admins" element={<PlatformAdmins api={api} currentUser={session.user} />} /><Route path="*" element={<Navigate to="/dashboard" replace />} /></Routes></AppShell>;
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
