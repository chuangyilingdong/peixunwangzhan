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
  { to: '/notifications', icon: '✉', label: '通知事件' },
  { to: '/client-releases', icon: '⤓', label: '客户端版本' },
  { to: '/inbox', icon: '✉', label: '站内信' },
  { to: '/leads', icon: '◔', label: '商机管理' },
  { to: '/admins', icon: '⚙', label: '平台管理员' },
  { to: '/audit', icon: '☉', label: '操作审计' },
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
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const [filters, setFilters] = useState({ orgId: '', from: '', to: '' });
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.orgId) params.set('orgId', filters.orgId);
    if (filters.from) params.set('from', new Date(filters.from).toISOString());
    if (filters.to) params.set('to', new Date(filters.to).toISOString());
    return params.toString();
  }, [filters]);
  const { loading, error, data, refresh } = useData(() => api.get(`admin/dashboard/overview${query ? `?${query}` : ''}`), [api, query]);
  const metrics = data?.metrics || {};
  const definitions = data?.meta?.metricDefinitions || {};
  const definition = (key) => definitions[key] || '';
  return <>
    <PageHeader eyebrow="平台控制台" title="运营总览" description="按机构和时间查看真实经营、课程、作品与模型调用指标。" actions={<button className="secondary-button" onClick={() => { organizations.refresh(); refresh(); }}>刷新</button>} />
    <Panel title="筛选条件">
      <div className="form-grid">
        <label>机构<select value={filters.orgId} onChange={(event) => setFilters({ ...filters, orgId: event.target.value })}>
          <option value="">全部机构</option>
          {(organizations.data?.items || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>开始日期<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
        <label>结束日期<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
        <button type="button" className="secondary-button" onClick={() => setFilters({ orgId: '', from: '', to: '' })}>重置</button>
      </div>
      {organizations.loading ? <Loading label="正在读取机构…" /> : organizations.error ? <ErrorState error={organizations.error} onRetry={organizations.refresh} /> : null}
    </Panel>
    {loading ? <Loading label="正在读取平台指标…" /> : error ? <ErrorState error={error} onRetry={refresh} /> : <>
      <Notice>
        统计区间：{formatDate(data.filters.from)} 至 {formatDate(data.filters.to)}（UTC，左闭右开）；生成时间 {formatDate(data.meta.generatedAt)}。
      </Notice>
      <div className="metrics">
        <MetricCard label="机构总数" value={metrics.organizations ?? 0} hint={definition('organizations')} />
        <MetricCard label="可用机构" value={metrics.activeOrganizations ?? 0} hint={definition('activeOrganizations')} tone="teal" />
        <MetricCard label="教师" value={metrics.teachers ?? 0} hint={definition('teachers')} tone="orange" />
        <MetricCard label="学生" value={metrics.students ?? 0} hint={definition('students')} tone="pink" />
        <MetricCard label="已发布课程" value={metrics.publishedCourses ?? 0} hint={definition('publishedCourses')} />
        <MetricCard label="课程授权" value={metrics.activeAssignments ?? 0} hint={definition('activeAssignments')} tone="teal" />
        <MetricCard label="进行中班级" value={metrics.activeClasses ?? 0} hint={definition('activeClasses')} tone="orange" />
        <MetricCard label="课堂场次" value={metrics.classSessions ?? 0} hint={definition('classSessions')} tone="pink" />
        <MetricCard label="新增项目" value={metrics.projects ?? 0} hint={definition('projects')} />
        <MetricCard label="提交作品" value={metrics.works ?? 0} hint={definition('works')} tone="teal" />
        <MetricCard label="AI 任务" value={metrics.aiTasks ?? 0} hint={definition('aiTasks')} tone="orange" />
        <MetricCard label="异常调用" value={metrics.abnormalTasks ?? 0} hint={definition('abnormalTasks')} tone="pink" />
        <MetricCard label="魔法石消耗" value={formatCredits(metrics.creditsSpent ?? 0)} hint={definition('creditsSpent')} />
        <MetricCard label="机构积分余额" value={formatCredits(metrics.creditBalance ?? 0)} hint={definition('creditBalance')} tone="teal" />
        <MetricCard label="冻结积分" value={formatCredits(metrics.frozenCredits ?? 0)} hint={definition('frozenCredits')} tone="orange" />
      </div>
      <div className="split">
        <Panel title="机构消耗 Top 10"><div className="table-wrap"><table><thead><tr><th>机构</th><th>调用次数</th><th>魔法石</th></tr></thead><tbody>{data.byOrg.length ? data.byOrg.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.calls}</td><td>{formatCredits(item.credits)}</td></tr>) : <tr><td colSpan={3}>所选区间暂无机构消耗</td></tr>}</tbody></table></div></Panel>
        <Panel title="能力调用"><div className="table-wrap"><table><thead><tr><th>能力</th><th>调用</th><th>成功</th><th>异常</th><th>魔法石</th></tr></thead><tbody>{data.byModality.length ? data.byModality.map((item) => <tr key={item.modality}><td>{item.modality}</td><td>{item.calls}</td><td>{item.successCalls}</td><td>{item.abnormalCalls}</td><td>{formatCredits(item.credits)}</td></tr>) : <tr><td colSpan={5}>所选区间暂无调用记录</td></tr>}</tbody></table></div></Panel>
      </div>
      <Panel title="统计口径"><div className="table-wrap"><table><thead><tr><th>指标</th><th>口径说明</th></tr></thead><tbody>{Object.entries(definitions).map(([key, text]) => <tr key={key}><td>{key}</td><td>{text}</td></tr>)}</tbody></table></div></Panel>
    </>}
  </>;
}
function isoDateInput(iso) {
  return iso ? new Date(iso).toISOString().slice(0, 10) : '';
}

function Organizations({ api }) {
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const [selectedId, setSelectedId] = useState('');
  const detail = useData(() => selectedId ? api.get(`admin/organizations/${selectedId}/detail`) : Promise.resolve(null), [api, selectedId]);
  const [form, setForm] = useState({ name: '', adminLogin: '', adminPassword: 'org123', baseTeacherSeats: 3 });
  const [editForm, setEditForm] = useState(null);
  const [adminForm, setAdminForm] = useState({ login: '', displayName: '', password: '' });
  const [passwordForm, setPasswordForm] = useState({});
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const selected = detail.data?.organization || null;

  function selectOrg(item) {
    setSelectedId(item.id);
    setMessage('');
    const contact = item.contact || {};
    setEditForm({
      name: item.name,
      contractStartAt: isoDateInput(item.contractStartAt),
      contractExpiresAt: isoDateInput(item.contractExpiresAt),
      baseTeacherSeats: item.baseTeacherSeats,
      purchasedTeacherSeats: item.purchasedTeacherSeats,
      contactName: contact.name || '',
      contactPhone: contact.phone || '',
      contactEmail: contact.email || '',
    });
  }

  async function create(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      await api.post('admin/organizations', { ...form, baseTeacherSeats: Number(form.baseTeacherSeats) });
      setForm({ name: '', adminLogin: '', adminPassword: 'org123', baseTeacherSeats: 3 });
      setMessage('机构已创建。'); organizations.refresh();
    } catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }

  async function saveEdit(event) {
    event.preventDefault(); if (!selectedId || !editForm) return;
    setDetailBusy(true); setMessage('');
    try {
      await api.put(`admin/organizations/${selectedId}`, {
        name: editForm.name,
        contractStartAt: new Date(editForm.contractStartAt).toISOString(),
        contractExpiresAt: new Date(editForm.contractExpiresAt + 'T23:59:59.999Z').toISOString(),
        baseTeacherSeats: Number(editForm.baseTeacherSeats),
        purchasedTeacherSeats: Number(editForm.purchasedTeacherSeats),
        contact: {
          name: editForm.contactName,
          phone: editForm.contactPhone,
          email: editForm.contactEmail,
        },
      });
      setMessage('机构资料已保存。'); organizations.refresh(); detail.refresh();
    } catch (err) { setMessage(err.message); } finally { setDetailBusy(false); }
  }

  async function changeStatus(item, action) {
    const text = action === 'disable'
      ? `确认停用「${item.name}」？该机构全部用户会立即无法登录、新建课堂和使用 AI。`
      : `确认执行「${action}」？恢复服务要求合同未到期，成功后机构服务立即恢复。`;
    if (!window.confirm(text)) return;
    setDetailBusy(true); setMessage('');
    try {
      await api.post(`admin/organizations/${item.id}/status`, { action });
      setMessage(action === 'disable' ? '机构已停用，该机构用户会立即无法访问机构端功能。' : '机构状态已更新。');
      organizations.refresh(); if (item.id === selectedId) detail.refresh();
    } catch (err) { setMessage(err.message); } finally { setDetailBusy(false); }
  }

  async function createAdmin(event) {
    event.preventDefault(); if (!selectedId) return;
    setDetailBusy(true); setMessage('');
    try {
      await api.post(`admin/organizations/${selectedId}/admins`, adminForm);
      setAdminForm({ login: '', displayName: '', password: '' });
      setMessage('机构管理员已创建。'); detail.refresh();
    } catch (err) { setMessage(err.message); } finally { setDetailBusy(false); }
  }

  async function updateAdmin(admin, payload, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setDetailBusy(true); setMessage('');
    try {
      await api.put(`admin/organizations/${selectedId}/admins/${admin.id}`, payload);
      setPasswordForm({ ...passwordForm, [admin.id]: '' });
      setMessage('管理员信息已更新。'); detail.refresh();
    } catch (err) { setMessage(err.message); } finally { setDetailBusy(false); }
  }

  return <>
    <PageHeader eyebrow="平台教务" title="机构管理" description="创建和维护机构资料、服务状态、管理员、配额、套餐与审计记录。" actions={<button className="secondary-button" onClick={() => { organizations.refresh(); if (selectedId) detail.refresh(); }}>刷新</button>} />
    <div className="split">
      <Panel title="新建机构"><form onSubmit={create}>
        <label>机构名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label>管理员登录名（可选）<input value={form.adminLogin} onChange={(e) => setForm({ ...form, adminLogin: e.target.value })} /></label>
        <div className="form-grid">
          <label>初始密码<input value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} /></label>
          <label>基础教师席位<input type="number" min="0" value={form.baseTeacherSeats} onChange={(e) => setForm({ ...form, baseTeacherSeats: e.target.value })} /></label>
        </div>
        <button className="primary-button" disabled={saving}>{saving ? '创建中…' : '创建机构'}</button>
      </form></Panel>
      <Panel title="服务规则说明"><Notice tone="info">停用机构后，该机构全部现有登录会话立即失效，无法新建班级、开课堂或调用 AI；恢复服务要求合同未到期，成功后机构用户可重新登录或继续使用未失效会话。所有状态和资料变更都会写入审计。</Notice></Panel>
    </div>
    {message && <Notice tone={message.includes('已') || message.includes('成功') ? 'success' : 'danger'}>{message}</Notice>}
    <Panel title="机构列表">
      {organizations.loading ? <Loading /> : organizations.error ? <ErrorState error={organizations.error} onRetry={organizations.refresh} /> : organizations.data.items.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>状态</th><th>合同</th><th>教师席位</th><th>服务</th><th>操作</th></tr></thead><tbody>{organizations.data.items.map((item) => {
        const disabled = item.status === 'DISABLED';
        return <tr key={item.id}>
          <td><button className="text-button" onClick={() => selectOrg(item)}><strong>{item.name}</strong></button><div className="muted">{item.id}</div></td>
          <td><Status value={item.status} /></td>
          <td>{formatDate(item.contractExpiresAt)}{item.contractExpiresAt && new Date(item.contractExpiresAt).getTime() - Date.now() < 30 * 86400000 ? <span className="status warning">即将到期</span> : null}</td>
          <td>{item.teacherUsedSeats} / {item.teacherSeats}</td>
          <td>{['TRIAL', 'ACTIVE'].includes(item.status) && (!item.contractExpiresAt || new Date(item.contractExpiresAt).getTime() > Date.now()) ? <span className="status success">可用</span> : <span className="status danger">不可用</span>}</td>
          <td><div className="row-actions">
            <button className="secondary-button" onClick={() => selectOrg(item)}>详情</button>
            {disabled
              ? <button className="secondary-button" disabled={detailBusy} onClick={() => changeStatus(item, 'recover')}>恢复服务</button>
              : <button className="secondary-button" disabled={detailBusy} onClick={() => changeStatus(item, 'disable')}>停用</button>}
            {item.status === 'TRIAL' ? <button className="secondary-button" disabled={detailBusy} onClick={() => changeStatus(item, 'activate')}>试用转正</button> : null}
          </div></td>
        </tr>;
      })}</tbody></table></div> : <Empty title="还没有机构" />}
    </Panel>
    {selectedId ? (
      detail.loading ? <Loading label="正在读取机构详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : detail.data ? <>
        <div className="metrics">
          <MetricCard label="服务状态" value={selected.serviceAvailable ? '可用' : '不可用'} hint={selected.status} tone={selected.serviceAvailable ? 'teal' : 'pink'} />
          <MetricCard label="合同剩余天数" value={selected.daysUntilContractExpires ?? '—'} hint={selected.contractExpiringSoon ? '30 天内到期，需提醒续约' : '按合同到期时间计算'} tone={selected.contractExpiringSoon ? 'orange' : undefined} />
          <MetricCard label="积分余额" value={formatCredits(detail.data.billing.balance)} hint={`冻结 ${formatCredits(detail.data.billing.frozenCredits)} · 累计消耗 ${formatCredits(detail.data.billing.totalCreditsSpent)}`} />
          <MetricCard label="教师席位" value={`${selected.teacherUsedSeats} / ${selected.teacherSeats}`} hint={`基础 ${selected.baseTeacherSeats} + 增购 ${selected.purchasedTeacherSeats}`} tone="orange" />
        </div>
        {selected.contractExpiringSoon ? <Notice tone="warning">该机构合同将在 {selected.daysUntilContractExpires} 天内到期，请尽快联系续约。</Notice> : null}
        <div className="split">
          <Panel title="编辑机构资料">{editForm ? <form onSubmit={saveEdit}>
            <label>机构名称<input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required /></label>
            <div className="form-grid">
              <label>合同开始日期<input type="date" value={editForm.contractStartAt} onChange={(e) => setEditForm({ ...editForm, contractStartAt: e.target.value })} required /></label>
              <label>合同到期日期<input type="date" value={editForm.contractExpiresAt} onChange={(e) => setEditForm({ ...editForm, contractExpiresAt: e.target.value })} required /></label>
              <label>基础教师席位<input type="number" min="0" value={editForm.baseTeacherSeats} onChange={(e) => setEditForm({ ...editForm, baseTeacherSeats: e.target.value })} required /></label>
              <label>购买教师席位<input type="number" min="0" value={editForm.purchasedTeacherSeats} onChange={(e) => setEditForm({ ...editForm, purchasedTeacherSeats: e.target.value })} required /></label>
            </div>
            <div className="form-grid">
              <label>联系人<input value={editForm.contactName} onChange={(e) => setEditForm({ ...editForm, contactName: e.target.value })} /></label>
              <label>联系电话<input value={editForm.contactPhone} onChange={(e) => setEditForm({ ...editForm, contactPhone: e.target.value })} /></label>
              <label>联系邮箱<input value={editForm.contactEmail} onChange={(e) => setEditForm({ ...editForm, contactEmail: e.target.value })} /></label>
            </div>
            <button className="primary-button" disabled={detailBusy}>{detailBusy ? '保存中…' : '保存机构资料'}</button>
            <p className="muted">机构服务状态请使用列表中的停用 / 恢复 / 转正动作。</p>
          </form> : null}</Panel>
          <Panel title="业务汇总"><div className="table-wrap"><table><thead><tr><th>指标</th><th>数量</th></tr></thead><tbody>
            <tr><td>教师</td><td>{detail.data.summary.teachers}</td></tr>
            <tr><td>学生</td><td>{detail.data.summary.students}</td></tr>
            <tr><td>进行中班级</td><td>{detail.data.summary.activeClasses}</td></tr>
            <tr><td>进行中课堂</td><td>{detail.data.summary.activeSessions}</td></tr>
            <tr><td>项目</td><td>{detail.data.summary.projects}</td></tr>
            <tr><td>作品</td><td>{detail.data.summary.works}</td></tr>
          </tbody></table></div></Panel>
        </div>
        <div className="split">
          <Panel title="机构管理员"><form onSubmit={createAdmin}>
            <div className="form-grid">
              <label>登录名<input value={adminForm.login} onChange={(e) => setAdminForm({ ...adminForm, login: e.target.value })} required /></label>
              <label>姓名<input value={adminForm.displayName} onChange={(e) => setAdminForm({ ...adminForm, displayName: e.target.value })} required /></label>
              <label>初始密码（至少6位）<input value={adminForm.password} onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })} required /></label>
              <button className="primary-button" disabled={detailBusy}>新增管理员</button>
            </div>
          </form>
          <div className="table-wrap"><table><thead><tr><th>登录名</th><th>姓名</th><th>状态</th><th>重置密码</th><th>操作</th></tr></thead><tbody>{detail.data.admins.map((admin) => <tr key={admin.id}>
            <td>{admin.login}</td><td>{admin.displayName}</td><td><Status value={admin.status} /></td>
            <td><input placeholder="新密码" value={passwordForm[admin.id] || ''} onChange={(e) => setPasswordForm({ ...passwordForm, [admin.id]: e.target.value })} /></td>
            <td><div className="row-actions">
              <button className="secondary-button" disabled={detailBusy || (passwordForm[admin.id] || '').length < 6} onClick={() => updateAdmin(admin, { password: passwordForm[admin.id] })}>保存新密码</button>
              {admin.status === 'ACTIVE'
                ? <button className="secondary-button" disabled={detailBusy} onClick={() => updateAdmin(admin, { status: 'DISABLED' }, `确认停用管理员「${admin.displayName}」？停用后该账号立即无法登录。`)}>停用</button>
                : <button className="secondary-button" disabled={detailBusy} onClick={() => updateAdmin(admin, { status: 'ACTIVE' })}>启用</button>}
            </div></td>
          </tr>)}</tbody></table></div></Panel>
          <Panel title="套餐与课程授权">
            <h3>套餐（{detail.data.packages.length}）</h3>
            {detail.data.packages.length ? <div className="table-wrap"><table><thead><tr><th>套餐</th><th>月度积分</th><th>学员席位</th><th>状态</th></tr></thead><tbody>{detail.data.packages.map((item) => <tr key={item.id}><td>{item.name}</td><td>{formatCredits(item.monthlyCredits)}</td><td>{item.studentSeats}</td><td><Status value={item.status} /></td></tr>)}</tbody></table></div> : <Empty title="暂无机构套餐" />}
            <h3>课程授权（{detail.data.courseAssignments.length}）</h3>
            {detail.data.courseAssignments.length ? <div className="table-wrap"><table><thead><tr><th>课包</th><th>状态</th><th>授权时间</th></tr></thead><tbody>{detail.data.courseAssignments.map((item) => <tr key={item.id}><td>{item.title}</td><td><Status value={item.status} /></td><td>{formatDate(item.assignedAt)}</td></tr>)}</tbody></table></div> : <Empty title="暂无课程授权" />}
          </Panel>
        </div>
        <Panel title="最近审计记录">
          {detail.data.audits.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>动作</th><th>操作者</th><th>目标</th><th>变更摘要</th></tr></thead><tbody>{detail.data.audits.map((item) => <tr key={item.id}>
            <td>{formatDate(item.createdAt)}</td><td><code>{item.action}</code></td><td>{item.actorRole || '—'}</td><td>{item.targetType}{item.targetId ? ` · ${item.targetId}` : ''}</td>
            <td>{JSON.stringify(item.afterData || {})}</td>
          </tr>)}</tbody></table></div> : <Empty title="暂无审计记录" />}
        </Panel>
      </> : null
    ) : <Panel title="机构详情"><Empty title="选择机构查看详情" body="点击机构列表中的名称或“详情”按钮，可查看合同、管理员、套餐、配额和审计。" /></Panel>}
  </>;
}
function Courses({ api }) {
  const courses = useData(() => api.get('admin/course-series'), [api]);
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const [form, setForm] = useState({ title: '', description: '', visibility: 'ALL_ORGS', lessons: '' });
  const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const detail = useData(() => selectedId ? api.get(`admin/course-series/${selectedId}/detail`) : Promise.resolve(null), [api, selectedId]);
  const [editForm, setEditForm] = useState(null);
  const [lessonDraft, setLessonDraft] = useState({ title: '', summary: '', durationMinutes: 45 });
  const [lessonEdits, setLessonEdits] = useState({});
  const [assignOrgId, setAssignOrgId] = useState('');
  const [busy, setBusy] = useState(false);
  const series = detail.data?.series || null;
  const visibilityLabels = { ALL_ORGS: '所有机构', ASSIGNED_ORGS: '仅已授权机构', PRIVATE: '私有' };

  function selectCourse(course) {
    setSelectedId(course.id);
    setMessage('');
    setEditForm({ title: course.title, description: course.description || '', coverImageUrl: course.coverImageUrl || '', visibility: course.visibility, sort: course.sort });
    setLessonEdits({});
  }
  async function create(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try { const lessons = form.lessons.split('\n').map((title) => title.trim()).filter(Boolean).map((title) => ({ title })); await api.post('admin/course-series', { title: form.title, description: form.description, visibility: form.visibility, lessons }); setForm({ title: '', description: '', visibility: 'ALL_ORGS', lessons: '' }); setMessage('平台课包已创建。'); courses.refresh(); }
    catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  async function run(path, method, body, successMessage, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setMessage('');
    try { await api.request(path, { method, body }); setMessage(successMessage); courses.refresh(); if (selectedId) detail.refresh(); }
    catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function saveEdit(event) {
    event.preventDefault(); if (!selectedId || !editForm) return;
    await run(`admin/course-series/${selectedId}`, 'PUT', { title: editForm.title, description: editForm.description, coverImageUrl: editForm.coverImageUrl || null, visibility: editForm.visibility, sort: Number(editForm.sort) }, '课包资料已保存，版本号已递增。');
  }
  async function changeStatus(course, action) {
    const text = action === 'archive'
      ? `确认归档「${course.title}」？归档后机构端不再可见该课包，历史班级数据保留，可随时重新发布。`
      : `确认发布「${course.title}」？发布后按可见范围对机构生效。`;
    await run(`admin/course-series/${course.id}/status`, 'POST', { action }, action === 'archive' ? '课包已归档。' : '课包已发布。', text);
  }
  async function addLesson(event) {
    event.preventDefault(); if (!selectedId) return;
    await run(`admin/course-series/${selectedId}/lessons`, 'POST', { lessons: [lessonDraft] }, `已添加课时「${lessonDraft.title}」。`);
    setLessonDraft({ title: '', summary: '', durationMinutes: 45 });
  }
  async function saveLesson(lesson) {
    const edit = lessonEdits[lesson.id] || {};
    await run(`admin/course-lessons/${lesson.id}`, 'PUT', { title: edit.title ?? lesson.title, summary: edit.summary ?? lesson.summary, durationMinutes: Number(edit.durationMinutes ?? lesson.durationMinutes), status: edit.status ?? lesson.status }, `课时「${edit.title ?? lesson.title}」已保存。`);
  }
  async function deleteLesson(lesson) {
    await run(`admin/course-lessons/${lesson.id}`, 'DELETE', undefined, `课时「${lesson.title}」已删除，剩余课时已重新排序。`, `确认删除课时「${lesson.title}」？已被班级课单或课堂引用的课时无法删除。`);
  }
  async function moveLesson(lesson, direction) {
    if (!series) return;
    const ids = series.lessons.map((item) => item.id);
    const index = ids.indexOf(lesson.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await run(`admin/course-series/${selectedId}/lessons/reorder`, 'PUT', { lessonIds: ids }, '课时顺序已更新。');
  }
  async function assign(courseId) { if (!assignOrgId) return; try { await api.post(`admin/course-series/${courseId}/assignments`, { orgIds: [assignOrgId] }); setMessage('课包授权成功。'); setAssignOrgId(''); detail.refresh(); } catch (err) { setMessage(err.message); } }
  async function revokeAssign(orgId, orgName) {
    await run(`admin/course-series/${selectedId}/assignments/revoke`, 'POST', { orgId }, `已撤销 ${orgName} 的授权，该机构将立即看不到此课包。`, `确认撤销「${orgName}」对此课包的授权？撤销后该机构课程中心与班级课单立即不可见此课包。`);
  }
  return <>
    <PageHeader eyebrow="课程资产" title="平台课包" description="维护平台级课程资料、课时、发布状态与机构授权，内容变更自动递增版本号。" />
    <div className="split"><Panel title="新建平台课包"><form onSubmit={create}>
      <label>课包标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label><label>课程简介<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label>可见范围<select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}><option value="ALL_ORGS">所有机构</option><option value="ASSIGNED_ORGS">仅已授权机构</option><option value="PRIVATE">私有</option></select></label>
      <label>课时标题（每行一课）<textarea placeholder={'第 1 课：认识 AI\n第 2 课：创意表达'} value={form.lessons} onChange={(e) => setForm({ ...form, lessons: e.target.value })} /></label>
      {message && <Notice tone={message.includes('已') || message.includes('成功') ? 'success' : 'danger'}>{message}</Notice>}<button className="primary-button" disabled={saving}>{saving ? '保存中…' : '创建课包'}</button>
    </form></Panel><Panel title="规则说明"><Notice>“仅已授权机构”课包必须完成授权后才能出现在机构端；未发布（DRAFT）与已归档课包对机构和学生不可见；被班级课单或课堂引用的课时不能删除，只能归档；编辑资料、课时或排序会自动递增课包版本号并写入审计。</Notice></Panel></div>
    <Panel title="已创建课包" actions={<button className="secondary-button" onClick={() => { courses.refresh(); if (selectedId) detail.refresh(); }}>刷新</button>}>
      {courses.loading || organizations.loading ? <Loading /> : courses.error ? <ErrorState error={courses.error} onRetry={courses.refresh} /> : courses.data.items.length ? <div className="table-wrap"><table><thead><tr><th>课包</th><th>状态</th><th>可见范围</th><th>版本</th><th>课时</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{courses.data.items.map((course) => <tr key={course.id}><td><button className="text-button" onClick={() => selectCourse(course)}><strong>{course.title}</strong></button><div className="muted">{course.id}</div></td><td><Status value={course.status} /></td><td>{visibilityLabels[course.visibility] || course.visibility}</td><td>{course.version}</td><td>{course.lessonCount}</td><td>{formatDate(course.updatedAt)}</td><td><div className="row-actions"><button className="secondary-button" onClick={() => selectCourse(course)}>详情</button>{course.status === 'PUBLISHED' || course.status === 'DRAFT' ? <button className="secondary-button" disabled={busy} onClick={() => changeStatus(course, 'archive')}>归档</button> : null}{course.status !== 'PUBLISHED' ? <button className="secondary-button" disabled={busy} onClick={() => changeStatus(course, 'publish')}>发布</button> : null}</div></td></tr>)}</tbody></table></div> : <Empty title="尚未创建平台课包" />}
    </Panel>
    {selectedId ? (
      detail.loading ? <Loading label="正在读取课包详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : detail.data && series ? <>
        <div className="metrics">
          <MetricCard label="引用班级" value={detail.data.usage.classesUsingSeries} hint="以该课包为默认课程的班级数" />
          <MetricCard label="班级课单项" value={detail.data.usage.curriculumItems} hint="班级课单引用的课时条目数" tone="teal" />
          <MetricCard label="关联课堂" value={detail.data.usage.classSessions} hint="使用该课包课时的课堂场次" tone="orange" />
          <MetricCard label="学生作品" value={detail.data.usage.studentWorks} hint="基于该课包课时提交的作品数" tone="pink" />
        </div>
        <div className="split">
          <Panel title="编辑课包资料">{editForm ? <form onSubmit={saveEdit}>
            <label>课包标题<input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required /></label>
            <label>课程简介<textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} /></label>
            <label>封面地址（HTTPS，可选）<input value={editForm.coverImageUrl} placeholder="https://…" onChange={(e) => setEditForm({ ...editForm, coverImageUrl: e.target.value })} /></label>
            <div className="form-grid">
              <label>可见范围<select value={editForm.visibility} onChange={(e) => setEditForm({ ...editForm, visibility: e.target.value })}><option value="ALL_ORGS">所有机构</option><option value="ASSIGNED_ORGS">仅已授权机构</option><option value="PRIVATE">私有</option></select></label>
              <label>排序<input type="number" min="0" value={editForm.sort} onChange={(e) => setEditForm({ ...editForm, sort: e.target.value })} /></label>
            </div>
            <button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存课包资料'}</button>
            <p className="muted">当前版本 {series.version}；保存后版本号自动递增。状态变更请使用列表中的发布 / 归档。</p>
          </form> : null}</Panel>
          <Panel title={`机构授权（${detail.data.assignedOrgs.length}）`}>
            <div className="form-grid">
              <label>授权给机构<select value={assignOrgId} onChange={(e) => setAssignOrgId(e.target.value)}><option value="">选择机构</option>{organizations.data?.items?.map((org) => <option key={org.id} value={org.id}>{org.name}</option>) || null}</select></label>
              <button type="button" className="secondary-button" disabled={!assignOrgId || busy} onClick={() => assign(selectedId)}>授权</button>
            </div>
            {detail.data.assignedOrgs.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>授权时间</th><th>操作</th></tr></thead><tbody>{detail.data.assignedOrgs.map((item) => <tr key={item.id}><td>{item.orgName}</td><td>{formatDate(item.assignedAt)}</td><td><button className="text-button" disabled={busy} onClick={() => revokeAssign(item.orgId, item.orgName)}>撤销授权</button></td></tr>)}</tbody></table></div> : <Empty title="暂无机构授权" body="“仅已授权机构”课包需完成授权后机构端才可见。" />}
          </Panel>
        </div>
        <Panel title={`课时管理（${series.lessons.length}）`}>
          <form onSubmit={addLesson} className="form-grid">
            <label>新课时标题<input value={lessonDraft.title} onChange={(e) => setLessonDraft({ ...lessonDraft, title: e.target.value })} required /></label>
            <label>时长（分钟）<input type="number" min="1" max="1440" value={lessonDraft.durationMinutes} onChange={(e) => setLessonDraft({ ...lessonDraft, durationMinutes: e.target.value })} /></label>
            <label>简介<input value={lessonDraft.summary} onChange={(e) => setLessonDraft({ ...lessonDraft, summary: e.target.value })} /></label>
            <button className="primary-button" disabled={busy}>添加课时</button>
          </form>
          {series.lessons.length ? <div className="table-wrap"><table><thead><tr><th>#</th><th>标题</th><th>时长</th><th>状态</th><th>操作</th></tr></thead><tbody>{series.lessons.map((lesson) => { const edit = lessonEdits[lesson.id] || {}; return <tr key={lesson.id}>
            <td>{lesson.sort}</td>
            <td><input value={edit.title ?? lesson.title} onChange={(e) => setLessonEdits({ ...lessonEdits, [lesson.id]: { ...edit, title: e.target.value } })} /></td>
            <td><input type="number" min="1" max="1440" style={{ width: '5rem' }} value={edit.durationMinutes ?? lesson.durationMinutes} onChange={(e) => setLessonEdits({ ...lessonEdits, [lesson.id]: { ...edit, durationMinutes: e.target.value } })} /></td>
            <td><select value={edit.status ?? lesson.status} onChange={(e) => setLessonEdits({ ...lessonEdits, [lesson.id]: { ...edit, status: e.target.value } })}><option value="PUBLISHED">已发布</option><option value="DRAFT">草稿</option><option value="ARCHIVED">已归档</option></select></td>
            <td><div className="row-actions">
              <button className="text-button" disabled={busy} onClick={() => moveLesson(lesson, -1)}>上移</button>
              <button className="text-button" disabled={busy} onClick={() => moveLesson(lesson, 1)}>下移</button>
              <button className="text-button" disabled={busy} onClick={() => saveLesson(lesson)}>保存</button>
              <button className="text-button" disabled={busy} onClick={() => deleteLesson(lesson)}>删除</button>
            </div></td>
          </tr>; })}</tbody></table></div> : <Empty title="暂无课时" body="课包至少需要一个课时才能发布。" />}
        </Panel>
      </> : <Empty title="选择课包查看详情" />
    ) : <Panel title="课包详情"><Empty title="选择课包查看详情" body="点击课包标题或“详情”按钮，可编辑资料、管理课时、发布归档和维护机构授权。" /></Panel>}
  </>;
}


function PlatformUsers({ api }) {
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const [filters, setFilters] = useState({ role: '', orgId: '', search: '' });
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)), [filters]);
  const users = useData(() => api.get(`admin/platform-users?${query.toString()}`), [api, query]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordInput, setPasswordInput] = useState({});
  const roleLabels = { SUPER_ADMIN: '平台超管', ORG_ADMIN: '机构管理员', TEACHER: '教师', STUDENT: '学员' };
  async function run(target, action, body, successMessage, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setMessage('');
    try { await api.put(`admin/platform-users/${target.id}/${action}`, body); setPasswordInput({ ...passwordInput, [target.id]: '' }); setMessage(successMessage); users.refresh(); }
    catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  return <>
    <PageHeader eyebrow="平台教务" title="平台用户" description="按角色、机构和关键词查看全平台真实账号、套餐与状态，并可执行启停、重置密码与解绑手机。" actions={<button className="secondary-button" onClick={users.refresh}>刷新</button>} />
    <Panel title="筛选条件">
      <div className="form-grid">
        <label>角色<select value={filters.role} onChange={(e) => setFilters({ ...filters, role: e.target.value })}><option value="">全部角色</option>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>机构<select value={filters.orgId} onChange={(e) => setFilters({ ...filters, orgId: e.target.value })}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) || null}</select></label>
        <label>关键词<input value={filters.search} placeholder="登录名 / 姓名 / 手机号" onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
      </div>
      {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
    </Panel>
    <Panel title="用户列表">
      {users.loading || organizations.loading ? <Loading /> : users.error ? <ErrorState error={users.error} onRetry={users.refresh} /> : users.data.items.length ? <div className="table-wrap"><table><thead><tr><th>用户</th><th>角色</th><th>机构</th><th>套餐</th><th>状态</th><th>有效期至</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{users.data.items.map((item) => <tr key={item.id}><td><strong>{item.displayName}</strong><div className="muted">{item.login}{item.phone ? ` · ${item.phone}` : ''}</div></td><td>{roleLabels[item.role] || item.role}</td><td>{item.organizationName || '平台'}</td><td>{item.role === 'STUDENT' ? (item.billingPackageName || '未绑定') : '—'}</td><td><Status value={item.status} /></td><td>{formatDate(item.expiresAt) || '长期'}</td><td>{formatDate(item.createdAt)}</td><td><div className="row-actions">
        {item.status === 'ACTIVE'
          ? <button className="text-button" disabled={busy} onClick={() => run(item, 'status', { status: 'DISABLED' }, `已停用 ${item.displayName}，该账号现有登录会话立即失效。`, `确认停用「${item.displayName}」？停用后该账号现有登录会话立即失效，将无法登录和使用平台功能。`)}>停用</button>
          : <button className="text-button" disabled={busy} onClick={() => run(item, 'status', { status: 'ACTIVE' }, `已启用 ${item.displayName}。`)}>启用</button>}
        <input placeholder="新密码（≥6位）" value={passwordInput[item.id] || ''} onChange={(e) => setPasswordInput({ ...passwordInput, [item.id]: e.target.value })} />
        <button className="text-button" disabled={busy || (passwordInput[item.id] || '').length < 6} onClick={() => run(item, 'password', { password: passwordInput[item.id] }, `已重置 ${item.displayName} 的密码，该账号全部会话已失效。`)}>重置密码</button>
        {item.phone ? <button className="text-button" disabled={busy} onClick={() => run(item, 'phone', { phone: '' }, `已解绑 ${item.displayName} 的手机号。`, `确认解绑「${item.displayName}」的手机号 ${item.phone}？`)}>解绑手机</button> : null}
      </div></td></tr>)}</tbody></table></div> : <Empty title="没有符合条件的用户" />}
    </Panel>
  </>;
}

function PlatformAdmins({ api, currentUser }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const adminQuery = useMemo(() => new URLSearchParams(Object.entries({ search, status: statusFilter }).filter(([, value]) => value)), [search, statusFilter]);
  const admins = useData(() => api.get(`admin/platform-admins?${adminQuery.toString()}`), [api, adminQuery]);
  const permissionOptions = ['ADMIN_DASHBOARD', 'ADMIN_ORGANIZATIONS', 'ADMIN_USERS', 'ADMIN_COURSES', 'ADMIN_WORKS', 'ADMIN_HACKATHON', 'ADMIN_BILLING', 'ADMIN_MATERIALS', 'ADMIN_INBOX', 'ADMIN_ADMINS', 'ADMIN_ADJUSTMENT'];
  const [form, setForm] = useState({ login: '', displayName: '', password: '', permissions: [] });
  const [editing, setEditing] = useState(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [logs, setLogs] = useState(null);
  const [logsLoading, setLogsLoading] = useState(false);
  function toggle(permission) { setForm((current) => ({ ...current, permissions: current.permissions.includes(permission) ? current.permissions.filter((item) => item !== permission) : [...current.permissions, permission] })); }
  async function create(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try { await api.post('admin/platform-admins', form); setForm({ login: '', displayName: '', password: '', permissions: [] }); setMessage('平台管理员已创建。'); admins.refresh(); }
    catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  async function update(target, payload, successMessage, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    try { await api.put(`admin/platform-admins/${target.id}`, payload); setMessage(successMessage); admins.refresh(); if (editing?.id === target.id) setEditing(null); }
    catch (err) { setMessage(err.message); }
  }
  async function save(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try { await api.put(`admin/platform-admins/${editing.id}`, { displayName: form.displayName, permissions: form.permissions }); setMessage('平台管理员已更新。'); setEditing(null); admins.refresh(); }
    catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  async function showLogs(target) {
    setLogsLoading(true);
    try { const result = await api.get(`admin/platform-admins/${target.id}/audit-logs?limit=50`); setLogs({ admin: target, ...result }); }
    catch (err) { setMessage(err.message); } finally { setLogsLoading(false); }
  }
  return <>
    <PageHeader eyebrow="平台系统" title="平台管理员" description="维护平台运营账号、权限码和登录安全，查看最近登录、活跃会话与操作日志。" actions={<button className="secondary-button" onClick={admins.refresh}>刷新</button>} />
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
      <Panel title="权限说明"><Notice>当前本地安全基线仍按 SUPER_ADMIN 角色放行；权限码先完成数据结构、白名单和页面配置能力，后续再逐域收紧 API 判定。不能停用当前登录账号和最后一个有效管理员由后端强制校验；停用或重置密码会立即使该账号全部会话失效。</Notice></Panel>
    </div>
    <Panel title="筛选条件">
      <div className="form-grid">
        <label>关键词<input value={search} placeholder="登录名 / 姓名" onChange={(e) => setSearch(e.target.value)} /></label>
        <label>状态<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">全部状态</option><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label>
      </div>
    </Panel>
    <Panel title="管理员列表">
      {admins.loading ? <Loading /> : admins.error ? <ErrorState error={admins.error} onRetry={admins.refresh} /> : admins.data.items.length ? <div className="table-wrap"><table><thead><tr><th>账号</th><th>状态</th><th>权限码</th><th>最近登录</th><th>活跃会话</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{admins.data.items.map((item) => <tr key={item.id}><td><strong>{item.displayName}</strong><div className="muted">{item.login}</div>{item.id === currentUser?.id && <span className="muted">当前账号</span>}</td><td><Status value={item.status} /></td><td>{item.permissions.length ? item.permissions.join(', ') : '全量（本地基线）'}</td><td>{formatDate(item.lastLoginAt) || '从未登录'}</td><td>{item.activeSessions}</td><td>{formatDate(item.updatedAt)}</td><td><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setForm({ login: '', displayName: item.displayName, password: '', permissions: item.permissions }); setLogs(null); }}>编辑</button><button className="text-button" onClick={() => { const password = window.prompt('请输入至少 6 位新密码'); if (password) update(item, { password }, '管理员密码已重置，该账号全部会话已失效。'); }}>重置密码</button>{item.status === 'ACTIVE' ? <button className="text-button" onClick={() => update(item, { status: 'DISABLED' }, '管理员已停用，该账号全部会话已失效。', `确认停用管理员「${item.displayName}」？停用后该账号现有登录会话立即失效。`)}>停用</button> : <button className="text-button" onClick={() => update(item, { status: 'ACTIVE' }, '管理员已启用。')}>启用</button>}<button className="text-button" disabled={logsLoading} onClick={() => showLogs(item)}>操作日志</button></div></td></tr>)}</tbody></table></div> : <Empty title="暂无平台管理员" />}
    </Panel>
    {logs ? (
      <Panel title={`操作日志：${logs.admin.displayName}（最近 ${logs.items.length} 条）`}>
        {logs.items.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>动作</th><th>目标</th><th>请求路径</th><th>变更摘要</th></tr></thead><tbody>{logs.items.map((item) => <tr key={item.id}>
          <td>{formatDate(item.createdAt)}</td><td><code>{item.action}</code></td><td>{item.targetType}{item.targetName ? ` · ${item.targetName}` : item.targetId ? ` · ${item.targetId}` : ''}</td><td>{item.requestPath || '—'}</td><td>{JSON.stringify(item.after || {})}</td>
        </tr>)}</tbody></table></div> : <Empty title="该管理员暂无操作记录" />}
      </Panel>
    ) : null}
  </>;
}

function PlatformAudit({ api }) {
  const [filters, setFilters] = useState({ action: '', actorId: '', targetType: '', targetId: '', requestPath: '', from: '', to: '', orgId: '' });
  const [limit, setLimit] = useState(50);
  const auditQuery = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    params.set('limit', String(limit));
    return params.toString();
  }, [filters, limit]);
  const [actionFilter, setActionFilter] = useState('');
  const fullQuery = useMemo(() => {
    const params = new URLSearchParams(auditQuery);
    if (actionFilter) params.set('action', actionFilter);
    return params.toString();
  }, [auditQuery, actionFilter]);
  const actions = useData(() => api.get('admin/audit-logs/actions'), [api]);
  const list = useData(() => api.get(`admin/audit-logs?${fullQuery}`), [api, fullQuery]);
  const summary = useData(() => api.get(`admin/audit-logs/summary?${fullQuery}`), [api, fullQuery]);
  const [message, setMessage] = useState('');
  const [exporting, setExporting] = useState(false);
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  function reset() { setFilters({ action: '', actorId: '', targetType: '', targetId: '', requestPath: '', from: '', to: '', orgId: '' }); setActionFilter(''); setMessage(''); }
  async function exportCsv() {
    setExporting(true); setMessage('');
    try {
      const result = await api.get(`admin/audit-logs/export?${fullQuery}&limit=2000`);
      const blob = new Blob([result.content], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = result.filename || 'audit-logs.csv';
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setMessage(`已导出 ${result.count} 条审计记录。`);
    } catch (err) { setMessage(err.message); } finally { setExporting(false); }
  }
  return <>
    <PageHeader eyebrow="平台系统" title="操作审计中心" description="按机构、动作、操作者、目标、时间和请求路径检索全平台审计记录，导出 CSV 供归档与合规使用。" actions={<><button className="secondary-button" onClick={() => { list.refresh(); summary.refresh(); actions.refresh(); }}>刷新</button><button className="primary-button" disabled={exporting} onClick={exportCsv}>{exporting ? '导出中…' : '导出 CSV'}</button></>} />
    <Panel title="筛选条件">
      <div className="form-grid">
        <label>动作<select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}><option value="">全部动作</option>{(actions.data?.items || []).map((item) => <option key={item.action} value={item.action}>{item.action}（{item.count}）</option>)}</select></label>
        <label>自定义动作<input value={filters.action} placeholder="覆盖上方选择，留空使用下拉" onChange={(e) => setFilters({ ...filters, action: e.target.value })} /></label>
        <label>机构<select value={filters.orgId} onChange={(e) => setFilters({ ...filters, orgId: e.target.value })}><option value="">全部机构</option>{(organizations.data?.items || []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
        <label>操作者 ID<input value={filters.actorId} onChange={(e) => setFilters({ ...filters, actorId: e.target.value })} /></label>
        <label>目标类型<input value={filters.targetType} placeholder="如 COURSE_SERIES / USER" onChange={(e) => setFilters({ ...filters, targetType: e.target.value })} /></label>
        <label>目标 ID<input value={filters.targetId} onChange={(e) => setFilters({ ...filters, targetId: e.target.value })} /></label>
        <label>请求路径（包含）<input value={filters.requestPath} placeholder="如 /admin/course-series" onChange={(e) => setFilters({ ...filters, requestPath: e.target.value })} /></label>
        <label>开始时间（UTC ISO）<input value={filters.from} placeholder="2026-09-01T00:00:00Z" onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
        <label>结束时间（UTC ISO）<input value={filters.to} placeholder="2026-09-04T00:00:00Z" onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
        <label>返回条数<select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}><option value="20">20</option><option value="50">50</option><option value="100">100</option><option value="200">200</option></select></label>
      </div>
      <div className="row-actions"><button type="button" className="secondary-button" onClick={reset}>重置筛选</button></div>
      {message && <Notice tone={message.includes('已') || message.includes('成功') ? 'success' : 'danger'}>{message}</Notice>}
    </Panel>
    {summary.loading ? <Loading label="正在汇总审计指标…" /> : summary.error ? <ErrorState error={summary.error} onRetry={summary.refresh} /> : summary.data ? <>
      <div className="metrics">
        <MetricCard label="匹配记录数" value={summary.data.total} hint="按当前筛选条件统计" />
        <MetricCard label="主要动作" value={summary.data.byAction?.[0]?.action || '—'} hint={summary.data.byAction?.[0] ? `${summary.data.byAction[0].count} 次` : '无数据'} tone="teal" />
        <MetricCard label="主要操作者" value={summary.data.byActor?.[0]?.actorName || '—'} hint={summary.data.byActor?.[0] ? `${summary.data.byActor[0].count} 次` : '无数据'} tone="orange" />
        <MetricCard label="主要机构" value={summary.data.byOrg?.[0]?.orgName || '—'} hint={summary.data.byOrg?.[0] ? `${summary.data.byOrg[0].count} 次` : '无数据'} tone="pink" />
      </div>
      <div className="split">
        <Panel title={`动作分布（Top ${summary.data.byAction?.length || 0}）`}>
          {summary.data.byAction?.length ? <div className="table-wrap"><table><thead><tr><th>动作</th><th>次数</th></tr></thead><tbody>{summary.data.byAction.map((item) => <tr key={item.action}><td><code>{item.action}</code></td><td>{item.count}</td></tr>)}</tbody></table></div> : <Empty title="无动作分布" />}
        </Panel>
        <Panel title={`操作者分布（Top ${summary.data.byActor?.length || 0}）`}>
          {summary.data.byActor?.length ? <div className="table-wrap"><table><thead><tr><th>操作者</th><th>次数</th></tr></thead><tbody>{summary.data.byActor.map((item) => <tr key={item.actorId || item.actorName}><td>{item.actorName}</td><td>{item.count}</td></tr>)}</tbody></table></div> : <Empty title="无操作者分布" />}
        </Panel>
        <Panel title={`机构分布（Top ${summary.data.byOrg?.length || 0}）`}>
          {summary.data.byOrg?.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>次数</th></tr></thead><tbody>{summary.data.byOrg.map((item) => <tr key={item.orgId || item.orgName}><td>{item.orgName}</td><td>{item.count}</td></tr>)}</tbody></table></div> : <Empty title="无机构分布" />}
        </Panel>
      </div>
    </> : null}
    <Panel title={`审计记录（${list.data?.total ?? 0} 条匹配，返回前 ${limit} 条）`}>
      {list.loading || actions.loading ? <Loading label="正在读取审计记录…" /> : list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : list.data?.items.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>角色</th><th>机构</th><th>动作</th><th>目标</th><th>请求路径</th><th>IP</th><th>变更前</th><th>变更后</th></tr></thead><tbody>{list.data.items.map((item) => <tr key={item.id}>
        <td>{formatDate(item.createdAt)}</td>
        <td>{item.actorName}</td>
        <td>{item.actorRole || '—'}</td>
        <td>{item.orgName || '平台'}</td>
        <td><code>{item.action}</code></td>
        <td>{item.targetType}{item.targetId ? ` · ${item.targetId.slice(0, 12)}` : ''}</td>
        <td>{item.requestPath || '—'}</td>
        <td>{item.ip || '—'}</td>
        <td><code>{item.before ? JSON.stringify(item.before) : '{}'}</code></td>
        <td><code>{item.after ? JSON.stringify(item.after) : '{}'}</code></td>
      </tr>)}</tbody></table></div> : <Empty title="当前筛选条件下无审计记录" />}
    </Panel>
  </>;
}

function PlatformNotifications({ api }) {
  const [tab, setTab] = useState('dispatch');
  const [eventForm, setEventForm] = useState({ eventKey: '', eventType: '', title: '', body: '', audience: 'TEACHER,STUDENT', orgId: '' });
  const [lastEvent, setLastEvent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failFilters, setFailFilters] = useState({ orgId: '', eventType: '' });
  const failQuery = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(failFilters).forEach(([key, value]) => { if (value) params.set(key, value); });
    params.set('limit', '50');
    return params.toString();
  }, [failFilters]);
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const summary = useData(() => api.get('admin/notification-events/summary'), [api]);
  const queueSummary = useData(() => api.get('admin/notification-queue/summary'), [api]);
  const deadLetters = useData(() => api.get('admin/notification-queue/dead-letters?limit=50'), [api]);
  const events = useData(() => api.get('admin/notification-events?limit=50'), [api]);
  const failures = useData(() => api.get(`admin/notification-failures?${failQuery}`), [api, failQuery]);
  const [selected, setSelected] = useState({});
  const [dlSelected, setDlSelected] = useState({});
  function reset() { setEventForm({ eventKey: '', eventType: '', title: '', body: '', audience: 'TEACHER,STUDENT', orgId: '' }); setMessage(''); }
  async function dispatch(event) {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const audience = { roles: eventForm.audience.split(',').map((s) => s.trim()).filter(Boolean) };
      const payload = {
        eventKey: eventForm.eventKey.trim(),
        eventType: eventForm.eventType.trim(),
        title: eventForm.title.trim(),
        body: eventForm.body.trim(),
        audience,
      };
      if (eventForm.orgId) payload.orgId = eventForm.orgId;
      const result = await api.post('admin/notification-events', payload);
      setLastEvent(result);
      setMessage(`事件已发布：${result.delivered} 投递 / ${result.suppressed} 抑制（共 ${result.totalTargets} 个目标）。`);
      events.refresh(); summary.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function retryFailures() {
    const ids = Object.values(selected).filter(Boolean);
    if (ids.length === 0) { setMessage('请勾选要重试的失败记录。'); return; }
    setBusy(true); setMessage('');
    try {
      const result = await api.post('admin/notification-failures/retry', { recipientIds: ids });
      setMessage(`已重试 ${result.retried} 条，${result.skipped} 条被跳过（已忽略或达最大次数）。`);
      setSelected({});
      failures.refresh(); summary.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function ignoreFailures() {
    const ids = Object.values(selected).filter(Boolean);
    if (ids.length === 0) { setMessage('请勾选要忽略的失败记录。'); return; }
    if (!window.confirm(`确认忽略 ${ids.length} 条失败记录？忽略后将从失败列表中移除。`)) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.post('admin/notification-failures/ignore', { recipientIds: ids, reason: 'MANUAL_IGNORE' });
      setMessage(`已忽略 ${result.ignored} 条失败记录。`);
      setSelected({});
      failures.refresh(); summary.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function tickQueue() {
    setBusy(true); setMessage('');
    try {
      const result = await api.post('admin/notification-queue/tick');
      setMessage(`队列扫描：处理 ${result.processed ?? 0}，成功 ${result.succeeded ?? 0}，失败 ${result.failed ?? 0}。`);
      queueSummary.refresh(); deadLetters.refresh(); failures.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function requeueSelectedDeadLetters() {
    const ids = Object.values(dlSelected).filter(Boolean);
    if (ids.length === 0) { setMessage('请勾选要恢复的死信。'); return; }
    setBusy(true); setMessage('');
    try {
      const result = await api.post('admin/notification-queue/dead-letters/requeue', { jobIds: ids, reason: 'MANUAL_REQUEUE' });
      setMessage(`已恢复 ${result.requeued} 条死信，${result.skipped} 条跳过。`);
      setDlSelected({});
      queueSummary.refresh(); deadLetters.refresh(); failures.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  return <>
    <PageHeader eyebrow="平台系统" title="通知事件与失败运营" description="按 eventKey 投递事件并自动抑制重复投递；查看、批量重试和忽略失败投递。" actions={<button className="secondary-button" onClick={() => { summary.refresh(); events.refresh(); failures.refresh(); }}>刷新</button>} />
    <Panel title="概要指标">
      {summary.loading ? <Loading /> : summary.error ? <ErrorState error={summary.error} onRetry={summary.refresh} /> : summary.data ? <div className="metrics">
        <MetricCard label="事件总数" value={summary.data.total} hint="已记录的事件源" />
        <MetricCard label="投递总数" value={summary.data.totalRecipients} hint="所有 recipient 记录" tone="teal" />
        <MetricCard label="当前失败" value={summary.data.failed} hint="delivery_status=FAILED 且未忽略" tone="orange" />
        <MetricCard label="已忽略" value={summary.data.suppressed} hint="已手动忽略的失败" tone="pink" />
      </div> : null}
    </Panel>
    <Panel title="投递队列状态">
      {queueSummary.loading ? <Loading /> : queueSummary.error ? <ErrorState error={queueSummary.error} onRetry={queueSummary.refresh} /> : queueSummary.data ? <div>
        <div className="metrics">
          <MetricCard label="待执行" value={queueSummary.data.pending ?? 0} hint="等待 worker 拉取" tone="blue" />
          <MetricCard label="进行中" value={queueSummary.data.inProgress ?? 0} hint="worker 正在处理" tone="teal" />
          <MetricCard label="失败重试" value={queueSummary.data.failed ?? 0} hint="正在指数退避重试" tone="orange" />
          <MetricCard label="死信" value={queueSummary.data.deadLetter ?? 0} hint="达到最大重试次数" tone="red" />
          <MetricCard label="已成功" value={queueSummary.data.succeeded ?? 0} hint="全部投递成功" tone="green" />
        </div>
        <div className="row-actions top-gap">
          <button className="primary-button" disabled={busy} onClick={tickQueue}>立即扫描</button>
          {queueSummary.data.deadLetter > 0 ? <button className="secondary-button" disabled={busy || !Object.values(dlSelected).filter(Boolean).length} onClick={requeueSelectedDeadLetters}>恢复选中死信（{Object.values(dlSelected).filter(Boolean).length}）</button> : null}
          <span className="muted" style="font-size:0.8em">Worker: {queueSummary.data.workerId || '—'}</span>
        </div>
        {queueSummary.data.deadLetter > 0 ? <div className="table-wrap top-gap"><table><thead><tr><th></th><th>用户</th><th>通知标题</th><th>尝试/上限</th><th>错误码</th><th>错误信息</th><th>更新于</th></tr></thead><tbody>{deadLetters.data?.items?.map ? deadLetters.data.items.map((item) => <tr key={item.id}>
          <td><input type="checkbox" checked={!!dlSelected[item.id]} onChange={(e) => setDlSelected({ ...dlSelected, [item.id]: e.target.checked ? item.id : null })} /></td>
          <td>{item.userName || item.userLogin || item.userId}</td>
          <td>{item.title || '—'}</td>
          <td>{item.attempt}/{item.maxAttempts}</td>
          <td><span className="status danger">{item.lastErrorCode || '—'}</span></td>
          <td className="muted">{item.lastErrorMessage || '—'}</td>
          <td>{formatDate(item.updatedAt)}</td>
        </tr>) : <tr><td colSpan="7" className="muted">加载中…</td></tr>}</tbody></table></div> : null}
      </div> : null}
    </Panel>
    <div className="row-actions">
      <button className={tab === 'dispatch' ? 'primary-button' : 'secondary-button'} onClick={() => setTab('dispatch')}>事件投递</button>
      <button className={tab === 'events' ? 'primary-button' : 'secondary-button'} onClick={() => setTab('events')}>事件列表</button>
      <button className={tab === 'failures' ? 'primary-button' : 'secondary-button'} onClick={() => setTab('failures')}>失败运营（{summary.data?.failed ?? 0}）</button>
    </div>
    {message && <Notice tone={message.includes('已') || message.includes('成功') ? 'success' : 'danger'}>{message}</Notice>}
    {tab === 'dispatch' ? (
      <div className="split">
        <Panel title="投递事件（按 eventKey 抑制重复）">
          <form onSubmit={dispatch}>
            <label>eventKey（4-128 字符）<input value={eventForm.eventKey} placeholder="enrollment-2024-001-abc" onChange={(e) => setEventForm({ ...eventForm, eventKey: e.target.value })} required /></label>
            <label>eventType<input value={eventForm.eventType} placeholder="STUDENT_ENROLLED" onChange={(e) => setEventForm({ ...eventForm, eventType: e.target.value })} required /></label>
            <label>标题<input value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} required /></label>
            <label>内容<textarea value={eventForm.body} onChange={(e) => setEventForm({ ...eventForm, body: e.target.value })} required /></label>
            <label>角色（逗号分隔）<input value={eventForm.audience} placeholder="TEACHER,STUDENT" onChange={(e) => setEventForm({ ...eventForm, audience: e.target.value })} required /></label>
            <label>机构 ID（留空 = 全平台）<select value={eventForm.orgId} onChange={(e) => setEventForm({ ...eventForm, orgId: e.target.value })}><option value="">全平台</option>{(organizations.data?.items || []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
            <div className="row-actions">
              <button type="submit" className="primary-button" disabled={busy}>{busy ? '投递中…' : '投递事件'}</button>
              <button type="button" className="secondary-button" onClick={reset}>重置</button>
            </div>
          </form>
        </Panel>
        <Panel title="最近投递结果">
          {lastEvent ? <>
            <div className="metrics">
              <MetricCard label="事件 ID" value={(lastEvent.id || '').slice(0, 12) + '…'} hint={lastEvent.eventKey} />
              <MetricCard label="状态" value={lastEvent.status} hint={lastEvent.eventType} tone="teal" />
              <MetricCard label="已投递" value={lastEvent.delivered ?? 0} hint="成功插入 recipient 记录" tone="orange" />
              <MetricCard label="已抑制" value={lastEvent.suppressed ?? 0} hint="同 eventKey 已存在" tone="pink" />
            </div>
            <p className="muted">事件总目标：{lastEvent.totalTargets}</p>
          </> : <Empty title="尚未投递事件" body="填写左侧表单，提交后系统会按 eventKey 抑制重复投递。" />}
        </Panel>
      </div>
    ) : null}
    {tab === 'events' ? <Panel title={`事件列表（共 ${events.data?.total ?? 0}）`}>
      {events.loading ? <Loading /> : events.error ? <ErrorState error={events.error} onRetry={events.refresh} /> : events.data?.items.length ? <div className="table-wrap"><table><thead><tr><th>eventKey</th><th>类型</th><th>状态</th><th>机构</th><th>标题</th><th>创建时间</th></tr></thead><tbody>{events.data.items.map((item) => <tr key={item.id}>
        <td><code>{item.eventKey}</code></td>
        <td>{item.eventType}</td>
        <td><Status value={item.status} /></td>
        <td>{item.orgId ? item.orgId.slice(0, 12) + '…' : '平台'}</td>
        <td>{item.title}</td>
        <td>{formatDate(item.createdAt)}</td>
      </tr>)}</tbody></table></div> : <Empty title="暂无事件记录" />}
    </Panel> : null}
    {tab === 'failures' ? <>
      <Panel title="筛选">
        <div className="form-grid">
          <label>机构<select value={failFilters.orgId} onChange={(e) => setFailFilters({ ...failFilters, orgId: e.target.value })}><option value="">全部机构</option>{(organizations.data?.items || []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
          <label>事件类型（kind）<input value={failFilters.eventType} placeholder="NOTICE / ANNOUNCEMENT" onChange={(e) => setFailFilters({ ...failFilters, eventType: e.target.value })} /></label>
        </div>
        <div className="row-actions">
          <button className="primary-button" disabled={busy || Object.values(selected).filter(Boolean).length === 0} onClick={retryFailures}>重试选中（{Object.values(selected).filter(Boolean).length}）</button>
          <button className="secondary-button" disabled={busy || Object.values(selected).filter(Boolean).length === 0} onClick={ignoreFailures}>忽略选中</button>
        </div>
      </Panel>
      <Panel title={`失败投递（${failures.data?.total ?? 0}）`}>
        {failures.loading ? <Loading /> : failures.error ? <ErrorState error={failures.error} onRetry={failures.refresh} /> : failures.data?.items.length ? <div className="table-wrap"><table><thead><tr><th></th><th>用户</th><th>机构</th><th>通知</th><th>原因</th><th>重试</th><th>创建时间</th></tr></thead><tbody>{failures.data.items.map((item) => <tr key={item.id}>
          <td><input type="checkbox" checked={!!selected[item.id]} onChange={(e) => setSelected({ ...selected, [item.id]: e.target.checked ? item.id : null })} /></td>
          <td>{item.userName}<div className="muted">{item.userLogin}</div></td>
          <td>{item.orgName || '平台'}</td>
          <td>{item.title}<div className="muted"><code>{item.kind}</code></div></td>
          <td><span className="status danger">{item.failureCode}</span><div className="muted">{item.failureReason}</div></td>
          <td>{item.retryCount}/{item.maxRetries}</td>
          <td>{formatDate(item.createdAt)}</td>
        </tr>)}</tbody></table></div> : <Empty title="当前无失败投递" />}
      </Panel>
    </> : null}
  </>;
}

function PlatformWorks({ api }) {
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const [filters, setFilters] = useState({ status: '', orgId: '', search: '' });
  const [message, setMessage] = useState(''); const [action, setAction] = useState(null); const [reason, setReason] = useState(''); const [saving, setSaving] = useState(false);
  const reports = useData(() => api.get('admin/work-reports?status=PENDING'), [api]);
  const [reportAction, setReportAction] = useState(null); const [reportForm, setReportForm] = useState({ status: 'RESOLVED', actionTaken: 'NONE', resolution: '' }); const [reportBusy, setReportBusy] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const detail = useData(() => detailId ? api.get(`admin/works/${detailId}/detail`) : Promise.resolve(null), [api, detailId]);
  const [detailTab, setDetailTab] = useState('basic');
  const [detailFeatureReason, setDetailFeatureReason] = useState('');
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)), [filters]);
  const works = useData(() => api.get(`admin/works?${query.toString()}`), [api, query]);
  const statusLabels = { PENDING: '待审核', APPROVED: '已通过', REJECTED: '已下架', PUBLISHED: '已发布' };
  const reportCategoryLabels = { INAPPROPRIATE: '内容不当', COPYRIGHT: '版权', PRIVACY: '隐私', OTHER: '其他' };
  const reportStatusLabels = { PENDING: '待处理', RESOLVED: '已处理', DISMISSED: '已驳回' };
  const reviewStatusLabels = { PENDING: '待审核', APPROVED: '已通过', REJECTED: '已驳回', PUBLISHED: '已发布' };
  async function unpublish() { if (!action) return; setSaving(true); setMessage(''); try { await api.put(`admin/works/${action.id}/unpublish`, { reason }); setMessage(`已下架《${action.title}》。`); setAction(null); setReason(''); works.refresh(); reports.refresh(); if (detailId === action.id) detail.refresh(); } catch (err) { setMessage(err.message); } finally { setSaving(false); } }
  async function toggleFeature(item) { setSaving(true); setMessage(''); try { await api.put(`admin/works/${item.id}/feature`, { featured: !item.featured, reason: !item.featured ? '平台精选推荐' : '' }); setMessage(item.featured ? `已取消《${item.title}》的精选。` : `已将《${item.title}》设为精选。`); works.refresh(); if (detailId === item.id) detail.refresh(); } catch (err) { setMessage(err.message); } finally { setSaving(false); } }
  async function handleReport() { if (!reportAction) return; setReportBusy(true); setMessage(''); try { await api.put(`admin/work-reports/${reportAction.id}`, reportForm); setMessage(`举报《${reportAction.workTitle}》已处理。`); setReportAction(null); setReportForm({ status: 'RESOLVED', actionTaken: 'NONE', resolution: '' }); reports.refresh(); works.refresh(); if (detailId === reportAction.workId) detail.refresh(); } catch (err) { setMessage(err.message); } finally { setReportBusy(false); } }
  function openDetail(item) { setDetailId(item.id); setDetailTab('basic'); setDetailFeatureReason(item.featuredReason || ''); }
  function closeDetail() { setDetailId(null); }
  return <>
    <PageHeader eyebrow="内容治理" title="平台作品库" description="聚合各机构作品；精选只允许已发布作品，举报处理可保留作品或执行平台下架。" actions={<button className="secondary-button" onClick={() => { works.refresh(); reports.refresh(); if (detailId) detail.refresh(); }}>刷新</button>} />
    <Panel title="筛选条件"><div className="form-grid"><label>状态<select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>机构<select value={filters.orgId} onChange={(e) => setFilters({ ...filters, orgId: e.target.value })}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) || null}</select></label><label>关键词<input value={filters.search} placeholder="作品 / 学员 / 机构" onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label></div>{message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}</Panel>
    <Panel title="作品列表">{works.loading || organizations.loading ? <Loading /> : works.error ? <ErrorState error={works.error} onRetry={works.refresh} /> : works.data.items.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>学员 / 机构</th><th>状态与授权</th><th>举报</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{works.data.items.map((item) => <tr key={item.id}><td><button className="text-button" onClick={() => openDetail(item)}><strong>{item.title}</strong></button><div className="muted">{item.description || '暂无描述'}</div></td><td><strong>{item.studentName || item.studentId}</strong><div className="muted">{item.organizationName || '未绑定机构'} · {item.className || '—'}</div></td><td><Status value={item.status} />{item.featured && <span className="status success">精选</span>}<div className="muted">{item.copyrightConfirmedAt ? '已确认展示授权' : '未确认展示授权'}</div></td><td>{item.pendingReportCount ? <span className="status danger">待处理 {item.pendingReportCount}</span> : '—'}</td><td>{formatDate(item.submittedAt)}</td><td><div className="row-actions">{item.status === 'PUBLISHED' && <><button className="text-button" disabled={saving} onClick={() => toggleFeature(item)}>{item.featured ? '取消精选' : '设为精选'}</button><button className="text-button" onClick={() => { setAction(item); setReason(''); }}>平台下架</button></>}</div></td></tr>)}</tbody></table></div> : <Empty title="没有符合条件的作品" />}</Panel>
    <Panel title={`待处理举报 · ${reports.data?.pending || 0} 条`}>{reports.loading ? <Loading /> : reports.error ? <ErrorState error={reports.error} onRetry={reports.refresh} /> : reports.data.items.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>举报人</th><th>类型 / 说明</th><th>时间</th><th>操作</th></tr></thead><tbody>{reports.data.items.map((item) => <tr key={item.id}><td>{item.workTitle}<div className="muted"><Status value={item.workStatus} /></div></td><td>{item.reporterName || '学生'}</td><td>{item.category}<div className="muted">{item.details || '未补充说明'}</div></td><td>{formatDate(item.createdAt)}</td><td><button className="text-button" onClick={() => { setReportAction(item); setReportForm({ status: 'RESOLVED', actionTaken: 'NONE', resolution: '' }); }}>处理</button></td></tr>)}</tbody></table></div> : <Empty title="暂无待处理举报" />}</Panel>
    {detailId ? <Panel title={`作品详情 · ${detail.data?.title || ''}`} actions={<button className="secondary-button" onClick={closeDetail}>关闭</button>}>{detail.loading ? <Loading /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : detail.data ? <>
      <div className="metric-row" style={{ marginBottom: 12 }}>
        <span><Status value={detail.data.status} /></span>
        {detail.data.featured ? <span className="status success">精选</span> : null}
        <span className="muted">提交 {formatDate(detail.data.submittedAt)}</span>
        {detail.data.reviewedAt ? <span className="muted">最近审核 {formatDate(detail.data.reviewedAt)} · {detail.data.reviewerName || '—'}</span> : null}
      </div>
      <div className="tabs" style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
        <button type="button" className={`tab-button ${detailTab === 'basic' ? 'active' : ''}`} style={{ padding: '6px 12px', border: '1px solid #cbd5e1', borderRadius: 6, background: detailTab === 'basic' ? '#0f172a' : '#fff', color: detailTab === 'basic' ? '#fff' : '#0f172a', cursor: 'pointer' }} onClick={() => setDetailTab('basic')}>基本</button>
        <button type="button" className={`tab-button ${detailTab === 'submissions' ? 'active' : ''}`} style={{ padding: '6px 12px', border: '1px solid #cbd5e1', borderRadius: 6, background: detailTab === 'submissions' ? '#0f172a' : '#fff', color: detailTab === 'submissions' ? '#fff' : '#0f172a', cursor: 'pointer' }} onClick={() => setDetailTab('submissions')}>提交历史 · {detail.data.submissions.length}</button>
        <button type="button" className={`tab-button ${detailTab === 'reports' ? 'active' : ''}`} style={{ padding: '6px 12px', border: '1px solid #cbd5e1', borderRadius: 6, background: detailTab === 'reports' ? '#0f172a' : '#fff', color: detailTab === 'reports' ? '#fff' : '#0f172a', cursor: 'pointer' }} onClick={() => setDetailTab('reports')}>举报记录 · {detail.data.reports.length}</button>
      </div>
      {detailTab === 'basic' ? <div className="split">
        <div>
          <h4>作品信息</h4>
          <p><strong>标题：</strong>{detail.data.title}</p>
          <p><strong>描述：</strong>{detail.data.description || '暂无描述'}</p>
          <p><strong>课程课时：</strong>{detail.data.courseLessonTitle || '—'}</p>
          <p><strong>当前点评：</strong>{detail.data.teacherComment || '—'}</p>
          <p><strong>版权授权：</strong>{detail.data.copyrightConfirmedAt ? `${formatDate(detail.data.copyrightConfirmedAt)} 已确认` : '未确认'}</p>
          <p><strong>画布节点：</strong>{detail.data.canvasSnapshot?.nodes?.length || 0} 个 / 连线 {detail.data.canvasSnapshot?.edges?.length || 0} 条</p>
        </div>
        <div>
          <h4>学生与上下文</h4>
          <p><strong>学生：</strong>{detail.data.studentName || '—'}（{detail.data.studentLogin}）</p>
          <p><strong>机构：</strong>{detail.data.organizationName || '未绑定'}</p>
          <p><strong>班级：</strong>{detail.data.className || '—'}</p>
          <p><strong>精选授权：</strong>{detail.data.studentAllowFeature ? '已授权' : '已关闭'}</p>
          <p><strong>作品墙匿名：</strong>{detail.data.studentShowcaseAnonymous ? '是' : '否'}</p>
          <p><strong>批注数量：</strong>{detail.data.annotationCount}（展示最新 {detail.data.annotations.length} 条）</p>
          {detail.data.featured ? <>
            <p><strong>精选时间：</strong>{formatDate(detail.data.featuredAt)}</p>
            <p><strong>精选理由：</strong>{detail.data.featuredReason || '—'}</p>
          </> : <p className="muted">未设精选</p>}
          {detail.data.latestPublishRequest ? <p><strong>最近发布申请：</strong>{detail.data.latestPublishRequest.status} · {formatDate(detail.data.latestPublishRequest.requestedAt)}{detail.data.latestPublishRequest.status === 'PENDING' ? '（待处理）' : ''}</p> : <p className="muted">无发布申请</p>}
        </div>
      </div> : null}
      {detailTab === 'basic' && detail.data.canvasSnapshot ? <div style={{ marginTop: 12 }}>
        <h4>画布快照（只读预览）</h4>
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, maxHeight: 360, overflow: 'auto' }}>
          <div className="muted" style={{ marginBottom: 8 }}>节点 {detail.data.canvasSnapshot.nodes?.length || 0} 个 / 连线 {detail.data.canvasSnapshot.edges?.length || 0} 条</div>
          <pre style={{ fontSize: 12, lineHeight: 1.5, margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(detail.data.canvasSnapshot, null, 2).slice(0, 2000)}{JSON.stringify(detail.data.canvasSnapshot).length > 2000 ? '\n…（已截断）' : ''}</pre>
        </div>
      </div> : null}
      {detailTab === 'submissions' ? detail.data.submissions.length ? <div className="table-wrap"><table><thead><tr><th>轮次</th><th>标题</th><th>审核</th><th>审核说明</th><th>提交时间</th></tr></thead><tbody>{detail.data.submissions.map((s) => <tr key={s.id}><td>第 {s.round} 轮</td><td>{s.title}<div className="muted">{s.description || '无描述'}</div></td><td>{s.reviewStatus ? <><Status value={s.reviewStatus} />{s.reviewerName ? <div className="muted">{s.reviewerName}</div> : null}</> : <span className="muted">未审核</span>}</td><td>{s.reviewComment || '—'}</td><td>{formatDate(s.submittedAt)}{s.reviewedAt ? <div className="muted">审核 {formatDate(s.reviewedAt)}</div> : null}</td></tr>)}</tbody></table></div> : <Empty title="暂无提交历史" /> : null}
      {detailTab === 'reports' ? detail.data.reports.length ? <div className="table-wrap"><table><thead><tr><th>类型</th><th>说明</th><th>举报人</th><th>状态</th><th>处理说明</th><th>时间</th></tr></thead><tbody>{detail.data.reports.map((r) => <tr key={r.id}><td>{reportCategoryLabels[r.category] || r.category}</td><td>{r.details || '—'}</td><td>{r.reporterName || '—'}</td><td><span className={`status ${r.status === 'PENDING' ? 'danger' : r.status === 'RESOLVED' ? 'success' : 'muted'}`}>{reportStatusLabels[r.status] || r.status}</span>{r.actionTaken === 'UNPUBLISH' ? <div className="muted">已下架</div> : null}</td><td>{r.resolution || '—'}{r.handlerName ? <div className="muted">{r.handlerName}</div> : null}</td><td>{formatDate(r.createdAt)}{r.handledAt ? <div className="muted">处理 {formatDate(r.handledAt)}</div> : null}</td></tr>)}</tbody></table></div> : <Empty title="暂无举报记录" /> : null}
      <div className="row-actions top-gap" style={{ marginTop: 12 }}>
        {detail.data.status === 'PUBLISHED' ? <>
          <button className="text-button" disabled={saving} onClick={() => toggleFeature(detail.data)}>{detail.data.featured ? '取消精选' : '设为精选'}</button>
          <button className="text-button" onClick={() => { setAction(detail.data); setReason(''); }}>平台下架</button>
        </> : null}
        <button className="secondary-button" onClick={detail.refresh}>刷新详情</button>
      </div>
    </> : null}</Panel> : null}
    {action ? <Panel title={`下架《${action.title}》`}><label>下架原因<input value={reason} required maxLength={2000} placeholder="例如：内容不适合公开展示" onChange={(e) => setReason(e.target.value)} /></label><div className="row-actions top-gap"><button className="primary-button" disabled={saving || !reason.trim()} onClick={unpublish}>{saving ? '处理中…' : '确认下架'}</button><button className="secondary-button" disabled={saving} onClick={() => { setAction(null); setReason(''); }}>取消</button></div></Panel> : null}
    {reportAction ? <Panel title={`处理举报 · ${reportAction.workTitle}`}><div className="form-grid"><label>处理结果<select value={reportForm.status} onChange={(event) => setReportForm({ ...reportForm, status: event.target.value })}><option value="RESOLVED">已处理</option><option value="DISMISSED">驳回举报</option></select></label><label>作品动作<select value={reportForm.actionTaken} onChange={(event) => setReportForm({ ...reportForm, actionTaken: event.target.value })}><option value="NONE">保留作品</option><option value="UNPUBLISH">下架作品</option></select></label></div><label>处理说明<textarea value={reportForm.resolution} required maxLength={2000} placeholder="说明处理结论；下架时该说明会作为学生可见的下架原因。" onChange={(event) => setReportForm({ ...reportForm, resolution: event.target.value })} /></label><div className="row-actions top-gap"><button className="primary-button" disabled={reportBusy || !reportForm.resolution.trim()} onClick={handleReport}>{reportBusy ? '处理中…' : '确认处理'}</button><button className="secondary-button" disabled={reportBusy} onClick={() => setReportAction(null)}>取消</button></div></Panel> : null}
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

function AdminInbox({ api }) {
  const inbox = useData(() => api.get('admin/inbox'), [api]);
  const organizations = useData(() => api.get('admin/organizations'), [api]);
  const templates = useData(() => api.get('admin/notification-templates'), [api]);
  const emptyForm = { title: '', body: '', kind: 'NOTICE', scope: 'ALL_ORGS', orgIds: [], roles: ['ORG_ADMIN', 'TEACHER', 'STUDENT'], targetUrl: '', pinned: false, status: 'DRAFT', publishAt: '' };
  const [form, setForm] = useState(emptyForm);
  const [templateName, setTemplateName] = useState('');
  const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false);
  async function create(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      const publishAt = form.status === 'SCHEDULED' && form.publishAt ? new Date(form.publishAt).toISOString() : null;
      await api.post('admin/inbox', { title: form.title, body: form.body, kind: form.kind, targetUrl: form.targetUrl || null, pinned: form.pinned, status: form.status, publishAt, audience: { scope: form.scope, orgIds: form.orgIds, roles: form.roles } });
      setForm(emptyForm); setMessage(form.status === 'PUBLISHED' ? '通知已发布并生成投递记录。' : form.status === 'SCHEDULED' ? '通知已加入定时发布队列。' : '通知草稿已保存。'); inbox.refresh();
    } catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  async function update(item, status) {
    try { await api.put(`admin/inbox/${item.id}`, { status }); setMessage(status === 'PUBLISHED' ? '通知已发布。' : status === 'RECALLED' ? '通知已撤回。' : '通知已更新。'); inbox.refresh(); } catch (err) { setMessage(err.message); }
  }
  async function saveTemplate() {
    setMessage('');
    try {
      await api.post('admin/notification-templates', { name: templateName, title: form.title, body: form.body, kind: form.kind, targetUrl: form.targetUrl || null, audience: { scope: form.scope, orgIds: form.orgIds, roles: form.roles } });
      setTemplateName(''); setMessage('通知模板已保存。'); templates.refresh();
    } catch (err) { setMessage(err.message); }
  }
  async function toggleTemplate(item) {
    try { await api.put(`admin/notification-templates/${item.id}`, { status: item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }); templates.refresh(); } catch (err) { setMessage(err.message); }
  }
  function applyTemplate(item) {
    setForm((old) => ({ ...old, title: item.title, body: item.body, kind: item.kind, targetUrl: item.targetUrl || '', scope: item.audience?.scope || 'ALL_ORGS', orgIds: item.audience?.orgIds || [], roles: item.audience?.roles || ['ORG_ADMIN', 'TEACHER', 'STUDENT'] }));
    setMessage(`已套用模板“${item.name}”。`);
  }
  function toggleRole(role) { setForm((old) => ({ ...old, roles: old.roles.includes(role) ? old.roles.filter((item) => item !== role) : [...old.roles, role] })); }
  return <>
    <PageHeader eyebrow="平台运营" title="站内信" description="向机构管理员、教师和学员投递可追踪的站内通知。" actions={<button className="secondary-button" onClick={() => { inbox.refresh(); templates.refresh(); }}>刷新</button>} />
    <div className="split"><Panel title="新建通知"><form onSubmit={create}>
      <label>标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label>
      <label>内容<textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required /></label>
      <div className="form-grid"><label>类型<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="NOTICE">通知</option><option value="ANNOUNCEMENT">公告</option><option value="REMINDER">提醒</option></select></label><label>保存状态<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="DRAFT">草稿</option><option value="PUBLISHED">立即发布</option><option value="SCHEDULED">定时发布</option></select></label></div>
      {form.status === 'SCHEDULED' ? <label>发布时间<input type="datetime-local" value={form.publishAt} onChange={(e) => setForm({ ...form, publishAt: e.target.value })} required /></label> : null}
      <label>接收机构<select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value, orgIds: [] })}><option value="ALL_ORGS">全部可用机构</option><option value="ORG_IDS">指定机构</option></select></label>
      {form.scope === 'ORG_IDS' ? <label>指定机构<select multiple value={form.orgIds} onChange={(e) => setForm({ ...form, orgIds: [...e.target.selectedOptions].map((option) => option.value) })}>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
      <div className="row-actions top-gap"><span className="muted">接收角色：</span>{[['ORG_ADMIN', '机构管理员'], ['TEACHER', '教师'], ['STUDENT', '学员']].map(([role, label]) => <button type="button" className={form.roles.includes(role) ? 'secondary-button' : 'text-button'} key={role} onClick={() => toggleRole(role)}>{label}</button>)}</div>
      <label>跳转地址（可选）<input value={form.targetUrl} placeholder="例如 /courses" onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} /></label>
      <label className="row-actions"><input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} /> 置顶通知</label>
      {message ? <Notice tone={message.includes('失败') || message.includes('不能为空') || message.includes('必须') ? 'danger' : 'success'}>{message}</Notice> : null}
      <button className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存通知'}</button>
    </form></Panel><Panel title="通知模板">
      <div className="form-grid"><label>模板名称<input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="例如：课程更新提醒" /></label><label>保存当前内容<button type="button" className="secondary-button top-gap" onClick={saveTemplate}>保存为模板</button></label></div>
      {templates.loading ? <Loading /> : templates.error ? <ErrorState error={templates.error} onRetry={templates.refresh} /> : templates.data.items.length ? <div className="card-list">{templates.data.items.map((item) => <article className="item-card" key={item.id}><div className="row-actions"><strong>{item.name}</strong><Status value={item.status} /></div><p>{item.title}</p><div className="row-actions"><button className="secondary-button" disabled={item.status !== 'ACTIVE'} onClick={() => applyTemplate(item)}>套用</button><button className="text-button" onClick={() => toggleTemplate(item)}>{item.status === 'ACTIVE' ? '停用' : '启用'}</button></div></article>)}</div> : <Empty title="暂无通知模板" body="填写左侧通知内容后可保存为复用模板。" />}
      <Notice tone="info">定时通知由服务进程内调度器发布，并在站内信请求到达时补偿扫描；邮件、短信和微信通道仍未接入。</Notice>
    </Panel></div>
    <Panel title="平台通知记录">{inbox.loading || organizations.loading ? <Loading /> : inbox.error ? <ErrorState error={inbox.error} onRetry={inbox.refresh} /> : inbox.data.items.length ? <div className="table-wrap"><table><thead><tr><th>通知</th><th>范围</th><th>投递 / 未读</th><th>状态</th><th>发布时间</th><th>操作</th></tr></thead><tbody>{inbox.data.items.map((item) => <tr key={item.id}><td><strong>{item.pinned ? '置顶 · ' : ''}{item.title}</strong><div className="muted">{item.kind} · {item.body}</div></td><td>{item.audience?.scope === 'ALL_ORGS' ? '全部机构' : `${item.audience?.orgIds?.length || 0} 家机构`}<div className="muted">{item.audience?.roles?.join(' / ')}</div></td><td>{item.recipientCount} / {item.unreadCount}</td><td><Status value={item.status} /></td><td>{item.publishAt ? formatDate(item.publishAt) : '—'}</td><td><div className="row-actions">{['DRAFT', 'SCHEDULED', 'RECALLED'].includes(item.status) ? <button className="secondary-button" onClick={() => update(item, 'PUBLISHED')}>立即发布</button> : null}{item.status === 'PUBLISHED' ? <button className="text-button" onClick={() => update(item, 'RECALLED')}>撤回</button> : null}</div></td></tr>)}</tbody></table></div> : <Empty title="还没有平台通知" body="可先保存草稿、立即发布或设置定时发布。" />}</Panel>
  </>;
}

function AdminMaterials({ api }) {
  const materials = useData(() => api.get('admin/materials'), [api]); const organizations = useData(() => api.get('admin/organizations'), [api]);
  const [form, setForm] = useState({ title: '', description: '', category: 'GENERAL', visibility: 'ALL_ORGS', orgIds: [], mimeType: '', resourceUrl: '', coverUrl: '' });
  const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false); const [stats, setStats] = useState({ loading: false, data: null, error: null });
  async function create(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try { await api.post('admin/materials', { ...form, orgIds: form.visibility === 'ALL_ORGS' ? [] : form.orgIds }); setForm({ title: '', description: '', category: 'GENERAL', visibility: 'ALL_ORGS', orgIds: [], mimeType: '', resourceUrl: '', coverUrl: '' }); setMessage('物料元数据已保存。'); materials.refresh(); } catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  async function toggle(item) { try { await api.put(`admin/materials/${item.id}`, { status: item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }); materials.refresh(); } catch (err) { setMessage(err.message); } }
  async function loadStats(item) { setStats({ loading: true, data: null, error: null }); try { setStats({ loading: false, data: await api.get(`admin/materials/${item.id}/stats`), error: null }); } catch (error) { setStats({ loading: false, data: null, error }); } }
  return <>
    <PageHeader eyebrow="平台内容" title="素材与宣传物料" description="维护招生海报、课程介绍和活动资料的元数据、授权范围与真实使用统计。" actions={<button className="secondary-button" onClick={materials.refresh}>刷新</button>} />
    <Notice tone="info">当前只维护文件元数据和外部资源地址，不提供虚假的上传、OSS 或下载能力；未配置真实资源的物料会在机构端明确显示为“资源待配置”。</Notice>
    <div className="split"><Panel title="新增宣传物料"><form onSubmit={create}>
      <label>名称<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label><label>说明<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <div className="form-grid"><label>分类<select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option value="GENERAL">通用</option><option value="COURSE">课程</option><option value="POSTER">海报</option><option value="ACTIVITY">活动</option><option value="PARTNERSHIP">合作</option></select></label><label>可见范围<select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value, orgIds: [] })}><option value="ALL_ORGS">全部机构</option><option value="ASSIGNED_ORGS">指定机构</option></select></label></div>
      {form.visibility === 'ASSIGNED_ORGS' ? <label>指定机构<select multiple value={form.orgIds} onChange={(e) => setForm({ ...form, orgIds: [...e.target.selectedOptions].map((option) => option.value) })}>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
      <div className="form-grid"><label>MIME 类型（可选）<input value={form.mimeType} placeholder="application/pdf" onChange={(e) => setForm({ ...form, mimeType: e.target.value })} /></label><label>真实资源地址（可选）<input value={form.resourceUrl} placeholder="由外部存储决策后填写" onChange={(e) => setForm({ ...form, resourceUrl: e.target.value })} /></label></div>
      <label>封面地址（可选）<input value={form.coverUrl} onChange={(e) => setForm({ ...form, coverUrl: e.target.value })} /></label>
      {message ? <Notice tone={message.includes('失败') || message.includes('不能为空') ? 'danger' : 'success'}>{message}</Notice> : null}<button className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存物料'}</button>
    </form></Panel><Panel title="物料授权"><Notice tone="info">“全部机构”会对所有状态正常的机构开放；“指定机构”只会在服务端向授权机构返回。教师与机构管理员均可查看机构可见物料。</Notice>{stats.loading ? <Loading label="正在读取统计…" /> : stats.error ? <ErrorState error={stats.error} /> : stats.data ? <><h3>{stats.data.material.title}</h3><div className="metrics"><MetricCard label="事件总数" value={stats.data.summary.totalEvents} hint={`${stats.data.summary.organizationCount} 家机构`} /><MetricCard label="查看" value={stats.data.summary.viewCount} hint="VIEW" tone="teal" /><MetricCard label="使用" value={stats.data.summary.useCount} hint="USE" tone="orange" /><MetricCard label="下载" value={stats.data.summary.downloadCount} hint="DOWNLOAD" tone="pink" /></div>{stats.data.organizations.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>查看</th><th>使用</th><th>下载</th><th>最近事件</th></tr></thead><tbody>{stats.data.organizations.map((item) => <tr key={item.orgId}><td>{item.organizationName}</td><td>{item.viewCount}</td><td>{item.useCount}</td><td>{item.downloadCount}</td><td>{formatDate(item.lastEventAt)}</td></tr>)}</tbody></table></div> : <Empty title="暂无使用事件" />}</> : <Empty title="选择一条物料查看统计" />}</Panel></div>
    <Panel title="物料列表">{materials.loading || organizations.loading ? <Loading /> : materials.error ? <ErrorState error={materials.error} onRetry={materials.refresh} /> : materials.data.items.length ? <div className="table-wrap"><table><thead><tr><th>物料</th><th>范围</th><th>资源</th><th>状态</th><th>使用次数</th><th>操作</th></tr></thead><tbody>{materials.data.items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><div className="muted">{item.category} · {item.description || '暂无说明'}</div></td><td>{item.visibility === 'ALL_ORGS' ? '全部机构' : `指定 ${item.assignedOrgCount} 家机构`}</td><td>{item.resourceConfigured ? <span className="status success">已配置</span> : <span className="muted">待配置</span>}</td><td><Status value={item.status} /></td><td>{item.eventCount}</td><td><div className="row-actions"><button className="secondary-button" onClick={() => loadStats(item)}>统计</button><button className="secondary-button" onClick={() => toggle(item)}>{item.status === 'ACTIVE' ? '停用' : '启用'}</button></div></td></tr>)}</tbody></table></div> : <Empty title="还没有宣传物料" body="先保存一条物料元数据，再决定是否配置外部资源。" />}</Panel>
  </>;
}

const CLIENT_PLATFORM_LABELS = { MACOS_APPLE: 'macOS（Apple 芯片）', WINDOWS_X64: 'Windows（64 位）' };
const CLIENT_CHANNEL_LABELS = { STABLE: '正式版', BETA: '测试版', INTERNAL: '内测版' };

function ClientReleases({ api }) {
  const releases = useData(() => api.get('admin/client-releases'), [api]);
  const [form, setForm] = useState({ platform: 'WINDOWS_X64', channel: 'STABLE', version: '', downloadUrl: '', releaseNotes: '', publishNow: false });
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  async function createRelease(event) {
    event.preventDefault(); setBusy('create');
    try { await api.post('admin/client-releases', form); setMessage('客户端版本配置已保存。只有发布后才会在官网和学生帮助中心展示。'); setForm({ ...form, version: '', downloadUrl: '', releaseNotes: '', publishNow: false }); releases.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(''); }
  }
  async function toggleRelease(item, action) {
    setBusy(item.id);
    try { await api.put(`admin/client-releases/${item.id}`, { action }); setMessage(action === 'PUBLISH' ? '版本已发布，官网和学生帮助中心开始展示真实下载地址。' : '版本已下架，所有下载入口不再展示。'); releases.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(''); }
  }
  const items = releases.data?.items || [];
  return <>
    <PageHeader eyebrow="AI 魔法学院 · 平台控制台" title="客户端版本管理" description="只登记真实安装包的 HTTPS 下载地址和版本元数据，不做文件上传，也不生成虚假客户端。" actions={<button className="secondary-button" onClick={releases.refresh}>刷新</button>} />
    <div className="metrics"><MetricCard label="版本配置" value={items.length} hint="平台登记的全部版本" /><MetricCard label="已发布" value={items.filter((item) => item.publishedAt).length} hint="官网与学生帮助中心可见" tone="teal" /><MetricCard label="未发布" value={items.filter((item) => !item.publishedAt).length} hint="仅平台内部可见" tone="orange" /></div>
    {message ? <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice> : null}
    <Panel title="新增客户端版本">
      <Notice tone="warning">请仅在真实安装包可公开访问后登记。下载地址必须是 HTTPS；未发布版本不会出现在官网和学生帮助中心。</Notice>
      <form onSubmit={createRelease}>
        <div className="form-grid">
          <label>平台<select value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value })}>{Object.entries(CLIENT_PLATFORM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>通道<select value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value })}>{Object.entries(CLIENT_CHANNEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>版本号<input value={form.version} required maxLength={60} placeholder="例如：1.0.0" onChange={(event) => setForm({ ...form, version: event.target.value })} /></label>
          <label>HTTPS 下载地址<input value={form.downloadUrl} required maxLength={1000} placeholder="https://cdn.example.com/ai-magic-school-1.0.0.dmg" onChange={(event) => setForm({ ...form, downloadUrl: event.target.value })} /></label>
        </div>
        <label>版本说明<textarea value={form.releaseNotes} required maxLength={4000} placeholder="写明真实更新内容、兼容系统和已知问题。" onChange={(event) => setForm({ ...form, releaseNotes: event.target.value })} /></label>
        <label className="checkbox"><input type="checkbox" checked={form.publishNow} onChange={(event) => setForm({ ...form, publishNow: event.target.checked })} />保存后立即发布到下载页</label>
        <button className="primary-button" type="submit" disabled={busy === 'create'}>{busy === 'create' ? '保存中…' : '保存版本配置'}</button>
      </form>
    </Panel>
    <Panel title="版本列表">
      {releases.loading ? <Loading /> : releases.error ? <ErrorState error={releases.error} onRetry={releases.refresh} /> : items.length ? <div className="table-wrap"><table><thead><tr><th>平台 / 通道</th><th>版本</th><th>下载地址</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{CLIENT_PLATFORM_LABELS[item.platform] || item.platform}<div className="muted">{CLIENT_CHANNEL_LABELS[item.channel] || item.channel}</div></td><td><strong>v{item.version}</strong><div className="muted">{item.releaseNotes}</div></td><td><a href={item.downloadUrl} target="_blank" rel="noreferrer">查看地址</a></td><td>{item.publishedAt ? <span className="status success">已发布</span> : <span className="status warning">未发布</span>}</td><td><div className="muted">创建：{formatDate(item.createdAt)}</div><div className="muted">发布：{item.publishedAt ? formatDate(item.publishedAt) : '—'}</div></td><td><button className="text-button" disabled={busy === item.id} onClick={() => toggleRelease(item, item.publishedAt ? 'UNPUBLISH' : 'PUBLISH')}>{item.publishedAt ? '下架' : '发布'}</button></td></tr>)}</tbody></table></div> : <Empty title="尚未登记客户端版本" body="官网与学生帮助中心会明确显示“暂无真实安装包”，不会提供虚假下载。" />}
    </Panel>
  </>;
}

function LeadsPanel({ api }) {
  const [filters, setFilters] = useState({ status: '' });
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ status: 'CONTACTED', adminNotes: '', assignedTo: '' });
  const [message, setMessage] = useState('');
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, v]) => v)), [filters]);
  const leads = useData(() => api.get(`admin/leads?${query.toString()}`), [api, query.toString()]);
  const statusLabels = { NEW: '新建', CONTACTED: '已联系', DEMO_SCHEDULED: '已排演示', CONVERTED: '已转化', CLOSED: '已关闭' };
  const validTransitions = {
    NEW: ['CONTACTED', 'CLOSED'],
    CONTACTED: ['DEMO_SCHEDULED', 'CLOSED'],
    DEMO_SCHEDULED: ['CONVERTED', 'CONTACTED', 'CLOSED'],
    CONVERTED: ['CLOSED'],
    CLOSED: ['CONTACTED'],
  };
  async function update() {
    if (!editing) return;
    setMessage('');
    try {
      await api.put(`admin/leads/${editing.id}`, { status: form.status, adminNotes: form.adminNotes, assignedTo: form.assignedTo || null });
      setMessage(`商机《${editing.orgName}》已更新。`);
      setEditing(null);
      leads.refresh();
    } catch (err) { setMessage(err.message); }
  }
  return <>
    <PageHeader eyebrow="线索与商机" title="演示预约管理" description="来自官网 /demo 的预约线索。" actions={<button className="secondary-button" onClick={leads.refresh}>刷新</button>} />
    <Panel title="筛选条件"><div className="form-grid"><label>状态<select value={filters.status} onChange={(e) => setFilters({ status: e.target.value })}><option value="">全部</option>{Object.entries(statusLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label></div>{message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}</Panel>
    <Panel title={`商机列表 · ${leads.data?.total || 0} 条`}>
      {leads.loading ? <Loading /> : leads.error ? <ErrorState error={leads.error} onRetry={leads.refresh} />
       : leads.data?.items?.length ? <div className="table-wrap"><table><thead><tr><th>提交时间</th><th>机构 / 联系人</th><th>手机号</th><th>合作方向</th><th>状态</th><th>分配</th><th>操作</th></tr></thead><tbody>
        {leads.data.items.map((item) => <tr key={item.id}><td><div className="muted">{formatDate(item.createdAt)}</div></td><td><strong>{item.orgName}</strong><div className="muted">{item.contactName}</div></td><td><a href={`tel:${item.contactPhone}`}>{item.contactPhone}</a></td><td>{item.intent || <span className="muted">—</span>}</td><td><Status value={item.status} /></td><td><div className="muted">{item.assignedTo || '—'}</div></td><td><button className="text-button" onClick={() => { setEditing(item); setForm({ status: validTransitions[item.status]?.[0] || item.status, adminNotes: item.adminNotes || '', assignedTo: item.assignedTo || '' }); }}>处理</button></td></tr>)}
       </tbody></table></div> : <Empty title="无商机" desc="等待官网 /demo 提交。" />}
    </Panel>
    {editing ? <Panel title={`处理《${editing.orgName}》`}><div className="form-grid"><label>状态<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{[editing.status, ...(validTransitions[editing.status] || [])].filter((v, i, a) => a.indexOf(v) === i).map((v) => <option key={v} value={v}>{statusLabels[v] || v}</option>)}</select></label><label>分配给<input value={form.assignedTo} onChange={(e) => setForm({ ...form, assignedTo: e.target.value })} placeholder="如：张经理" /></label></div><label>处理备注<textarea value={form.adminNotes} maxLength={2000} onChange={(e) => setForm({ ...form, adminNotes: e.target.value })} placeholder="联系情况、跟进要点…" /></label><div className="row-actions top-gap"><button className="primary-button" onClick={update}>保存</button><button className="secondary-button" onClick={() => setEditing(null)}>取消</button></div></Panel> : null}
  </>;
}

function PlatformPage({ kind }) {
  const pages = {
    users: ['平台用户', '统一查看机构管理员、教师与学员的账号状态，支持后续接入筛选、启停和变更记录。', [['机构账号', '按机构归属查看管理者、教师和学员'], ['账号安全', '登录状态、有效期与权限将统一在此管理']]],
    marketplace: ['课程广场', '集中浏览可下发的主题课包、课时与示范素材，支持机构授权和版本管理。', [['标准课包', '11 门系统课程、87 节课时'], ['授课资源', 'PPT、HTML 互动课件与课堂备注']]],
    works: ['平台作品库', '聚合机构作品展厅的公开成果，便于审核、运营和沉淀优质案例。', [['作品审核', '查看发布状态与机构归属'], ['精选推荐', '后续可配置推荐位与展示专题']]],
    hackathon: ['黑客松', '配置赛季、作品征集、审核与奖励，帮助机构把课堂作品延展为创作活动。', [['赛季管理', '创建主题、时间范围与参与机构'], ['作品审核', '待审、入选、驳回与撤回统一记录']]],
    billing: ['计费与模型', '统一维护机构积分池、能力开关、模型矩阵和用量规则，让课堂 AI 可用可管。', [['魔法石用量', '机构充值、按调用扣减、余额提醒'], ['模型能力', '文本、图像、音频与视频按权限配置']]],
    admins: ['平台管理员', '管理平台运营账号与权限码，重要业务权限由后端继续校验。', [['角色权限', '按运营、课程、计费等域配置访问范围'], ['账号安全', '启停、重置密码与操作记录']]],
  };
  const [title, desc, cards] = pages[kind];
  return <><PageHeader eyebrow="AI魔法学院 · 平台控制台" title={title} description={desc} actions={<button className="primary-button">新建 / 配置</button>} /><div className="metrics">{cards.map((item, index) => <MetricCard key={item[0]} label={item[0]} value={index ? '待配置' : '准备就绪'} hint={item[1]} tone={['violet', 'teal'][index]} />)}</div><Panel title="建设说明"><Notice tone="info">此页面已按 AI魔法学院的信息架构接入平台端导航与视觉壳层；需要服务端数据的筛选、编辑和审批操作将在对应 API 完成后接入，不会伪造业务数据。</Notice></Panel></>;
}
function App() {
  const [session, setSession] = useState(readSession); const navigate = useNavigate();
  const api = useMemo(() => createApiClient({ getToken: () => session?.token, onUnauthorized: () => { clearSession(); setSession(null); navigate('/login'); } }), [session?.token, navigate]);
  useEffect(() => { if (!session?.token) return; api.me().then((user) => setSession(writeSession({ ...session, user, organization: user.organization }))).catch(() => {}); }, [session?.token]);
  async function login(credentials) { const data = await api.login(credentials); if (data.user.role !== 'SUPER_ADMIN') throw new ApiError('该账号没有平台管理权限', { code: 'ROLE_MISMATCH' }); setSession(writeSession(data)); navigate('/dashboard'); }
  async function logout() { try { await api.logout(); } catch { /* local logout still succeeds */ } clearSession(); setSession(null); navigate('/login'); }
  if (!session) return <Routes><Route path="*" element={<LoginPanel title="平台管理中心" description="为课程、机构和积分运营提供统一的控制台。" clientType="admin" demos={demos} onLogin={login} />} /></Routes>;
  if (session.user?.role !== 'SUPER_ADMIN') return <LoginPanel title="平台管理中心" description="当前会话没有平台管理权限。" clientType="admin" demos={demos} onLogin={login} />;
  return <AppShell product="AI 魔法学院" roleLabel="平台超管" user={session.user} navigation={navigation} onLogout={logout}><Routes><Route path="/dashboard" element={<Dashboard api={api} />} /><Route path="/organizations" element={<Organizations api={api} />} /><Route path="/courses" element={<Courses api={api} />} /><Route path="/users" element={<PlatformUsers api={api} />} /><Route path="/marketplace" element={<PlatformPage kind="marketplace" />} /><Route path="/works" element={<PlatformWorks api={api} />} /><Route path="/hackathon" element={<PlatformPage kind="hackathon" />} /><Route path="/billing" element={<PlatformBilling api={api} />} /><Route path="/materials" element={<AdminMaterials api={api} />} /> <Route path="/client-releases" element={<ClientReleases api={api} />} /><Route path="/inbox" element={<AdminInbox api={api} />} /><Route path="/leads" element={<LeadsPanel api={api} />} /><Route path="/admins" element={<PlatformAdmins api={api} currentUser={session.user} />} /><Route path="/audit" element={<PlatformAudit api={api} />} /><Route path="/notifications" element={<PlatformNotifications api={api} />} /><Route path="*" element={<Navigate to="/dashboard" replace />} /></Routes></AppShell>;
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
