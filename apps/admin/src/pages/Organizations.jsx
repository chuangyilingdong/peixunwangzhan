import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, SearchSelect, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';
import { useAdminConfirm } from '../components/AdminConfirm.jsx';

function initialOrganizationForm() {
  return {
    name: '', contactName: '', contactPhone: '', contactEmail: '',
    contractStartAt: new Date().toISOString().slice(0, 10),
    contractExpiresAt: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
    contractNotes: '', status: 'ACTIVE', teacherSeats: 3, studentSeats: 0,
    adminLogin: '', adminDisplayName: '', adminPassword: '',
  };
}

function CreateOrganizationDialog({ form, setForm, saving, created, error, onClose, onSubmit, onView, onAuthorize }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.showModal();
    return () => { dialogRef.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={dialogRef} className="admin-confirm" style={{ width: 'min(760px, calc(100vw - 32px))' }} aria-labelledby="create-organization-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    {created ? <div>
      <h2 id="create-organization-title">机构已创建</h2>
      <p><strong>{created.name}</strong> · <Status value={created.status} /></p>
      <p>教师上限 {created.teacherSeats} 人，学生上限 {created.studentSeats} 人。接下来可查看机构详情，或前往授权课包。</p>
      <div className="row-actions"><button type="button" className="secondary-button" autoFocus onClick={onView}>继续查看机构</button><button type="button" className="primary-button" onClick={onAuthorize}>去授权课包</button></div>
    </div> : <form onSubmit={onSubmit}>
      <h2 id="create-organization-title">创建机构</h2>
      <div className="form-grid">
        <label>机构名称<input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={200} /></label>
        <label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">正常</option><option value="TRIAL">试用</option></select></label>
        <label>联系人姓名<input value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} maxLength={200} /></label>
        <label>联系人电话<input type="tel" value={form.contactPhone} onChange={(event) => setForm({ ...form, contactPhone: event.target.value })} maxLength={200} /></label>
        <label>联系人邮箱<input type="email" value={form.contactEmail} onChange={(event) => setForm({ ...form, contactEmail: event.target.value })} maxLength={200} /></label>
        <label>签约开始日期<input type="date" value={form.contractStartAt} onChange={(event) => setForm({ ...form, contractStartAt: event.target.value })} required /></label>
        <label>签约到期日期<input type="date" value={form.contractExpiresAt} onChange={(event) => setForm({ ...form, contractExpiresAt: event.target.value })} required /></label>
        <label>教师数量上限<input type="number" min="0" max="1000000" value={form.teacherSeats} onChange={(event) => setForm({ ...form, teacherSeats: event.target.value })} required /></label>
        <label>学生数量上限<input type="number" min="0" max="1000000" value={form.studentSeats} onChange={(event) => setForm({ ...form, studentSeats: event.target.value })} required /></label>
      </div>
      <label>签约备注<textarea rows={3} maxLength={5000} value={form.contractNotes} onChange={(event) => setForm({ ...form, contractNotes: event.target.value })} placeholder="填写签约服务、约定事项或合同备注" /></label>
      <div className="form-grid">
        <label>管理员账号<input autoComplete="username" value={form.adminLogin} onChange={(event) => setForm({ ...form, adminLogin: event.target.value })} required maxLength={100} /></label>
        <label>管理员姓名<input value={form.adminDisplayName} onChange={(event) => setForm({ ...form, adminDisplayName: event.target.value })} required maxLength={200} /></label>
        <label>管理员初始密码<input type="password" autoComplete="new-password" value={form.adminPassword} onChange={(event) => setForm({ ...form, adminPassword: event.target.value })} required minLength={6} /></label>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="row-actions"><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '创建中…' : '创建机构'}</button></div>
    </form>}
  </dialog>;
}

export function Organizations({ api }) {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ search: '', status: '' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [sort, setSort] = useState('created');
  const query = useMemo(() => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort);
    return params;
  }, [filters, page, limit, sort]);
  const organizations = useData(() => api.get(`admin/organizations?${query.toString()}`), [api, query]);
  const [selectedId, setSelectedId] = useState('');
  const detail = useData(() => selectedId ? api.get(`admin/organizations/${selectedId}/detail`) : Promise.resolve(null), [api, selectedId]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [form, setForm] = useState(initialOrganizationForm);
  const [createdOrganization, setCreatedOrganization] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [adminForm, setAdminForm] = useState({ login: '', displayName: '', password: '' });
  const [passwordForm, setPasswordForm] = useState({});
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirm, confirmation] = useAdminConfirm();
  async function exportOrganizations() {
    setExporting(true); setMessage('');
    try {
      const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const result = await api.get(`admin/organizations/export?${params.toString()}`);
      downloadCsv(result.filename, result.content);
      setMessage(`已导出 ${result.count} 家机构。`);
    } catch (error) { setMessage(error.message); } finally { setExporting(false); }
  }
  const [detailBusy, setDetailBusy] = useState(false);
  const [showRechargeDialog, setShowRechargeDialog] = useState(false);
  const [showRechargeHistory, setShowRechargeHistory] = useState(false);
  const selected = detail.data?.organization || null;

  function selectOrg(item) {
    setSelectedId(item.id);
    setMessage('');
    setShowRechargeHistory(false);
    const contact = item.contact || {};
    setEditForm({
      name: item.name,
      contractStartAt: isoDateInput(item.contractStartAt),
      contractExpiresAt: isoDateInput(item.contractExpiresAt),
      teacherSeats: item.teacherSeats,
      studentSeats: item.studentSeats,
      contactName: contact.name || '',
      contactPhone: contact.phone || '',
      contactEmail: contact.email || '',
      contractNotes: contact.contractNotes || '',
    });
  }

  async function create(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      const created = await api.post('admin/organizations', {
        name: form.name,
        adminLogin: form.adminLogin,
        adminDisplayName: form.adminDisplayName,
        adminPassword: form.adminPassword,
        isTrial: form.status === 'TRIAL',
        contractStartAt: form.contractStartAt,
        contractExpiresAt: form.contractExpiresAt,
        teacherSeats: Number(form.teacherSeats),
        studentSeats: Number(form.studentSeats),
        contact: { name: form.contactName, phone: form.contactPhone, email: form.contactEmail, contractNotes: form.contractNotes },
      });
      setCreatedOrganization(created);
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
        teacherSeats: Number(editForm.teacherSeats),
        studentSeats: Number(editForm.studentSeats),
        contact: {
          name: editForm.contactName,
          phone: editForm.contactPhone,
          email: editForm.contactEmail,
          contractNotes: editForm.contractNotes,
        },
      });
      setMessage('机构资料已保存。'); organizations.refresh(); detail.refresh();
    } catch (err) { setMessage(err.message); } finally { setDetailBusy(false); }
  }

  async function changeStatus(item, action) {
    const text = action === 'disable'
      ? `确认停用「${item.name}」？该机构全部用户会立即无法登录、新建课堂和使用 AI。`
      : `确认执行「${action}」？恢复服务要求合同未到期，成功后机构服务立即恢复。`;
    const approved = await confirm({ title: action === 'disable' ? '停用机构' : '确认机构状态变更', message: text, confirmLabel: action === 'disable' ? '确认停用' : '确认执行' });
    if (!approved) return;
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
    if (confirmText) {
      const approved = await confirm({ title: '停用机构管理员', message: confirmText, confirmLabel: '确认停用' });
      if (!approved) return;
    }
    setDetailBusy(true); setMessage('');
    try {
      await api.put(`admin/organizations/${selectedId}/admins/${admin.id}`, payload);
      setPasswordForm({ ...passwordForm, [admin.id]: '' });
      setMessage('管理员信息已更新。'); detail.refresh();
    } catch (err) { setMessage(err.message); } finally { setDetailBusy(false); }
  }

  return <>
    <PageHeader eyebrow="平台教务" title="机构管理" description="创建和维护机构资料、服务状态、管理员、人数上限与审计记录。" actions={<><button className="primary-button" onClick={() => { setForm(initialOrganizationForm()); setCreatedOrganization(null); setShowCreateDialog(true); setMessage(''); }}>创建机构</button><button className="secondary-button" disabled={exporting} onClick={exportOrganizations}>{exporting ? '导出中…' : '导出 CSV'}</button><button className="secondary-button" onClick={() => { organizations.refresh(); if (selectedId) detail.refresh(); }}>刷新</button></>} />
    {showCreateDialog ? <CreateOrganizationDialog form={form} setForm={setForm} saving={saving} created={createdOrganization} error={!createdOrganization ? message : ''} onClose={() => setShowCreateDialog(false)} onSubmit={create} onView={() => { selectOrg(createdOrganization); setShowCreateDialog(false); }} onAuthorize={() => { const orgId = createdOrganization.id; setShowCreateDialog(false); navigate(`/authorizations?orgId=${encodeURIComponent(orgId)}`); }} /> : null}
    {confirmation}
    <Panel title="服务规则说明"><Notice tone="info">停用机构后，该机构全部现有登录会话立即失效，无法新建课堂、开课堂或调用 AI；恢复服务要求合同未到期，成功后机构用户可重新登录或继续使用未失效会话。所有状态和资料变更都会写入审计。</Notice></Panel>
    {message && <Notice tone={message.includes('已') || message.includes('成功') ? 'success' : 'danger'}>{message}</Notice>}
    <Panel title="机构列表">
      <div className="form-grid">
        <label>关键词<input value={filters.search} placeholder="机构名称 / ID" onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} /></label>
        <label>状态<select value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}><option value="">全部状态</option><option value="TRIAL">试用</option><option value="ACTIVE">正常</option><option value="DISABLED">已停用</option></select></label>
        <label>排序<select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="created">创建时间</option><option value="name">机构名称</option><option value="expires">合同到期</option></select></label>
        <label>每页<select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}><option value="10">10 条</option><option value="20">20 条</option><option value="50">50 条</option><option value="100">100 条</option></select></label>
      </div>
      {organizations.loading ? <Loading /> : organizations.error ? <ErrorState error={organizations.error} onRetry={organizations.refresh} /> : organizations.data?.items?.length ? <><ListResultSummary total={organizations.data.total} page={organizations.data.page} totalPages={organizations.data.totalPages} label="家机构" /><div className="table-wrap"><table><thead><tr><th>机构</th><th>状态</th><th>合同</th><th>教师席位</th><th>学生使用 / 上限</th><th>服务</th><th>操作</th></tr></thead><tbody>{organizations.data.items.map((item) => {
        const disabled = item.status === 'DISABLED';
        return <tr key={item.id}>
          <td><button className="text-button" onClick={() => selectOrg(item)}><strong>{item.name}</strong></button><div className="muted">{item.id}</div></td>
          <td><Status value={item.status} /></td>
          <td>{formatDate(item.contractExpiresAt)}{item.contractExpiresAt && new Date(item.contractExpiresAt).getTime() - Date.now() < 30 * 86400000 ? <span className="status warning">即将到期</span> : null}</td>
          <td>{item.teacherUsedSeats} / {item.teacherSeats}</td>
          <td>{item.studentUsedSeats} / {item.studentSeats}</td>
          <td>{['TRIAL', 'ACTIVE'].includes(item.status) && (!item.contractExpiresAt || new Date(item.contractExpiresAt).getTime() > Date.now()) ? <span className="status success">可用</span> : <span className="status danger">不可用</span>}</td>
          <td><div className="row-actions">
            <button className="secondary-button" onClick={() => selectOrg(item)}>详情</button>
            {disabled
              ? <button className="secondary-button" disabled={detailBusy} onClick={() => changeStatus(item, 'recover')}>恢复服务</button>
              : <button className="secondary-button" disabled={detailBusy} onClick={() => changeStatus(item, 'disable')}>停用</button>}
            {item.status === 'TRIAL' ? <button className="secondary-button" disabled={detailBusy} onClick={() => changeStatus(item, 'activate')}>试用转正</button> : null}
          </div></td>
        </tr>;
      })}</tbody></table></div><Pagination page={organizations.data.page} totalPages={organizations.data.totalPages} onChange={setPage} disabled={organizations.loading} /></> : <Empty title="没有符合条件的机构" body="可以调整关键词或状态筛选条件。" />}
    </Panel>
    {selectedId ? (
      detail.loading ? <Loading label="正在读取机构详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : detail.data ? <>
        <div className="metrics">
          <MetricCard label="学生数量" value={`${selected.studentUsedSeats} / ${selected.studentSeats}`} hint="按机构设置限制，停用账号仍占容量" />
          <MetricCard label="服务状态" value={selected.serviceAvailable ? '可用' : '不可用'} hint={selected.status} tone={selected.serviceAvailable ? 'teal' : 'pink'} />
          <MetricCard label="合同剩余天数" value={selected.daysUntilContractExpires ?? '—'} hint={selected.contractExpiringSoon ? '30 天内到期，需提醒续约' : '按合同到期时间计算'} tone={selected.contractExpiringSoon ? 'orange' : undefined} />
          <MetricCard label="教师数量" value={`${selected.teacherUsedSeats} / ${selected.teacherSeats}`} hint={`基础 ${selected.baseTeacherSeats} + 购买 ${selected.purchasedTeacherSeats}`} tone={selected.teacherSeats - selected.teacherUsedSeats < 3 ? 'orange' : undefined} />
        </div>

        {selected.contractExpiringSoon ? <Notice tone="warning">该机构合同将在 {selected.daysUntilContractExpires} 天内到期，请尽快联系续约。</Notice> : null}
        <div className="split">
          <Panel title="编辑机构资料">{editForm ? <form onSubmit={saveEdit}>
            <label>机构名称<input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required /></label>
            <div className="form-grid">
              <label>合同开始日期<input type="date" value={editForm.contractStartAt} onChange={(e) => setEditForm({ ...editForm, contractStartAt: e.target.value })} required /></label>
              <label>合同到期日期<input type="date" value={editForm.contractExpiresAt} onChange={(e) => setEditForm({ ...editForm, contractExpiresAt: e.target.value })} required /></label>
              <label>学生数量上限<input type="number" min="0" value={editForm.studentSeats} onChange={(e) => setEditForm({ ...editForm, studentSeats: e.target.value })} required /></label>
              <label>教师数量上限<input type="number" min={selected.teacherUsedSeats} max="1000000" value={editForm.teacherSeats} onChange={(e) => setEditForm({ ...editForm, teacherSeats: e.target.value })} required /></label>
            </div>
            <div className="form-grid">
              <label>联系人<input value={editForm.contactName} onChange={(e) => setEditForm({ ...editForm, contactName: e.target.value })} /></label>
              <label>联系电话<input value={editForm.contactPhone} onChange={(e) => setEditForm({ ...editForm, contactPhone: e.target.value })} /></label>
              <label>联系邮箱<input value={editForm.contactEmail} onChange={(e) => setEditForm({ ...editForm, contactEmail: e.target.value })} /></label>
            </div>
            <label>签约内容<textarea rows={4} maxLength={5000} value={editForm.contractNotes} onChange={(e) => setEditForm({ ...editForm, contractNotes: e.target.value })} placeholder="填写签约服务、约定事项或合同备注" /></label>
            <button className="primary-button" disabled={detailBusy}>{detailBusy ? '保存中…' : '保存机构资料'}</button>
            <p className="muted">机构服务状态请使用列表中的停用 / 恢复 / 转正动作。</p>
          </form> : null}</Panel>
          <Panel title="业务汇总"><div className="table-wrap"><table><thead><tr><th>指标</th><th>数量</th></tr></thead><tbody>
            <tr><td>教师</td><td>{detail.data.summary.teachers}</td></tr>
            <tr><td>学生</td><td>{detail.data.summary.students}</td></tr>

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
              <label>初始密码（至少6位）<input type="password" autoComplete="new-password" minLength={6} value={adminForm.password} onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })} required /></label>
              <button className="primary-button" disabled={detailBusy}>新增管理员</button>
            </div>
          </form>
          <div className="table-wrap"><table><thead><tr><th>登录名</th><th>姓名</th><th>状态</th><th>重置密码</th><th>操作</th></tr></thead><tbody>{detail.data.admins.map((admin) => <tr key={admin.id}>
            <td>{admin.login}</td><td>{admin.displayName}</td><td><Status value={admin.status} /></td>
            <td><input type="password" autoComplete="new-password" aria-label={`${admin.displayName} 的新密码`} placeholder="新密码" value={passwordForm[admin.id] || ''} onChange={(e) => setPasswordForm({ ...passwordForm, [admin.id]: e.target.value })} /></td>
            <td><div className="row-actions">
              <button className="secondary-button" disabled={detailBusy || (passwordForm[admin.id] || '').length < 6} onClick={() => updateAdmin(admin, { password: passwordForm[admin.id] })}>保存新密码</button>
              {admin.status === 'ACTIVE'
                ? <button className="secondary-button" disabled={detailBusy} onClick={() => updateAdmin(admin, { status: 'DISABLED' }, `确认停用管理员「${admin.displayName}」？停用后该账号立即无法登录。`)}>停用</button>
                : <button className="secondary-button" disabled={detailBusy} onClick={() => updateAdmin(admin, { status: 'ACTIVE' })}>启用</button>}
            </div></td>
          </tr>)}</tbody></table></div></Panel>
          <Panel title="课包授权与余额">
            <Link to={`/authorizations?orgId=${encodeURIComponent(selectedId)}`}>前往授权管理</Link>
            {detail.data.courseAssignments.length ? <div className="table-wrap"><table><thead><tr><th>课包</th><th>状态</th><th>购买次数</th><th>已分配</th><th>余额</th><th>到期时间</th></tr></thead><tbody>{detail.data.courseAssignments.map((item) => <tr key={item.id}><td>{item.title}</td><td><Status value={item.status} /></td><td>{item.quotaTotal}</td><td>{item.quotaUsed}</td><td>{item.remaining}</td><td>{formatDate(item.expiresAt)}</td></tr>)}</tbody></table></div> : <Empty title="暂无课包授权" />}
          </Panel>
        </div>
        <Panel title="最近审计记录">
          {detail.data.audits.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>动作</th><th>操作者</th><th>目标</th><th>变更摘要</th></tr></thead><tbody>{detail.data.audits.map((item) => <tr key={item.id}>
            <td>{formatDate(item.createdAt)}</td><td><code>{item.action}</code></td><td>{item.actorRole || '—'}</td><td>{item.targetType}{item.targetId ? ` · ${item.targetId}` : ''}</td>
            <td>{JSON.stringify(item.afterData || {})}</td>
          </tr>)}</tbody></table></div> : <Empty title="暂无审计记录" />}
        </Panel>
      </> : null
    ) : <Panel title="机构详情"><Empty title="选择机构查看详情" body="点击机构列表中的名称或“详情”按钮，可查看合同、管理员、课包余额和审计。" /></Panel>}
  </>;
}



export function Authorizations({ api }) {
  const location = useLocation();
  const inventory = useData(() => api.get('admin/authorizations'), [api]);
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const deepLink = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const [seriesId, setSeriesId] = useState(() => deepLink.get('seriesId') || '');
  const [orgId, setOrgId] = useState(() => deepLink.get('orgId') || '');
  const [additionalQuota, setAdditionalQuota] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [stock, setStock] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirm, confirmation] = useAdminConfirm();
  const selected = inventory.data?.items.find((item) => item.id === seriesId) || null;
  const selectedOrg = organizations.data?.items.find((item) => item.id === orgId) || null;
  const assignment = selected?.allocations.find((item) => item.orgId === orgId) || null;

  useEffect(() => {
    const requested = deepLink.get('seriesId');
    if (requested && inventory.data?.items.some((item) => item.id === requested)) setSeriesId(requested);
  }, [deepLink, inventory.data]);
  useEffect(() => {
    const requested = deepLink.get('orgId');
    if (requested && organizations.data?.items.some((item) => item.id === requested)) setOrgId(requested);
  }, [deepLink, organizations.data]);
  useEffect(() => {
    setStock(selected ? String(selected.stockTotal) : '');
    setAdditionalQuota('');
    setExpiresAt(assignment?.expiresAt ? isoDateInput(assignment.expiresAt) : '');
  }, [seriesId, orgId, selected?.stockTotal, assignment?.expiresAt]);

  async function saveStock(event) {
    event.preventDefault();
    const next = Number(stock);
    await confirm({ title: '确认调整课包库存', message: `${selected.title}：库存总次数 ${selected.stockTotal} → ${next}。`, confirmLabel: '确认调整', execute: async () => {
      setBusy(true); setMessage('');
      try { await api.put(`admin/course-series/${seriesId}/stock`, { stockTotal: next }); setMessage('库存已更新。'); inventory.refresh(); }
      finally { setBusy(false); }
    } });
  }

  async function appendQuota(event) {
    event.preventDefault();
    const added = Number(additionalQuota);
    const currentTotal = assignment?.quotaTotal || 0;
    const currentUsed = assignment?.quotaUsed || 0;
    const activeAssignment = assignment?.status === 'ACTIVE';
    const nextTotal = (activeAssignment ? currentTotal : currentUsed) + added;
    const currentRemaining = activeAssignment ? assignment.remaining : 0;
    await confirm({
      title: assignment ? '确认追加授权次数' : '确认首次授权',
      message: `${selected.title} / ${selectedOrg.name}：总次数 ${currentTotal} → ${nextTotal}，已分配保持 ${currentUsed}，剩余 ${currentRemaining} → ${currentRemaining + added}。${activeAssignment ? `有效期保持 ${formatDate(assignment.expiresAt)}。` : assignment ? `授权将恢复，原有效期保持 ${formatDate(assignment.expiresAt)}；如已过期，请随后单独调整。` : '首次授权默认有效 365 天，可随后单独调整。'}`,
      confirmLabel: assignment ? '确认追加' : '确认授权',
      execute: async () => {
        setBusy(true); setMessage('');
        try { await api.post(`admin/course-series/${seriesId}/assignments/append`, { orgId, additionalQuota: added }); setAdditionalQuota(''); setMessage(assignment ? '授权次数已追加。' : '机构授权已创建。'); inventory.refresh(); }
        finally { setBusy(false); }
      },
    });
  }

  async function updateValidity(event) {
    event.preventDefault();
    const nextExpiresAt = new Date(`${expiresAt}T23:59:59.999Z`).toISOString();
    await confirm({
      title: '确认调整授权有效期',
      message: `${selected.title} / ${selectedOrg.name}：有效期 ${formatDate(assignment.expiresAt)} → ${formatDate(nextExpiresAt)}。总次数保持 ${assignment.quotaTotal}，已分配保持 ${assignment.quotaUsed}，剩余保持 ${assignment.remaining}。`,
      confirmLabel: '确认调整',
      execute: async () => {
        setBusy(true); setMessage('');
        try { await api.put(`admin/course-series/${seriesId}/assignments/validity`, { orgId, expiresAt: nextExpiresAt }); setMessage('授权有效期已更新。'); inventory.refresh(); }
        finally { setBusy(false); }
      },
    });
  }

  return <>
    <PageHeader title="授权管理" description="选择一个课包和一家机构，查看当前授权后再追加次数或调整有效期。" />
    {confirmation}
    {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
    {inventory.loading || organizations.loading ? <Loading /> : inventory.error ? <ErrorState error={inventory.error} onRetry={inventory.refresh} /> : organizations.error ? <ErrorState error={organizations.error} onRetry={organizations.refresh} /> : <>
      <Panel title="选择授权对象"><div className="form-grid">
        <label>课包<SearchSelect ariaLabel="搜索课包" value={seriesId} onChange={(value) => { setSeriesId(value); setMessage(''); }} options={inventory.data?.items || []} placeholder="选择已发布课包" searchPlaceholder="搜索课包名称" /></label>
        <label>机构<SearchSelect ariaLabel="搜索机构" value={orgId} onChange={(value) => { setOrgId(value); setMessage(''); }} options={organizations.data?.items || []} placeholder="选择一家机构" searchPlaceholder="搜索机构名称" /></label>
      </div></Panel>
      {selected ? <Panel title={`${selected.title} · 库存`}><div className="split">
        <div className="metrics"><MetricCard label="库存总次数" value={selected.stockTotal} /><MetricCard label="已分配或消耗" value={selected.reserved} /><MetricCard label="可分配库存" value={selected.available} /></div>
        <form onSubmit={saveStock}><label>调整库存总次数<input type="number" min={selected.reserved} max="100000000" required value={stock} onChange={(event) => setStock(event.target.value)} /></label><button className="secondary-button" disabled={busy || Number(stock) === selected.stockTotal}>调整库存</button></form>
      </div></Panel> : null}
      {selected && selectedOrg ? <>
        <div className="metrics">
          <MetricCard label="库存" value={selected.stockTotal} hint={`可分配 ${selected.available}`} />
          <MetricCard label="当前总次数" value={assignment?.quotaTotal || 0} hint={assignment ? '该机构现有授权' : '尚未授权'} />
          <MetricCard label="已分配" value={assignment?.quotaUsed || 0} hint="已发放给学生" />
          <MetricCard label="剩余" value={assignment?.remaining || 0} hint="机构仍可分配" />
          <MetricCard label="有效期" value={assignment?.expiresAt ? formatDate(assignment.expiresAt) : '未设置'} hint={assignment?.status || '未授权'} />
        </div>
        <div className="split">
          <Panel title="追加次数"><form onSubmit={appendQuota}>
            <label>本次追加次数<input type="number" min="1" max={Math.min(100000000, selected.available)} required value={additionalQuota} onChange={(event) => setAdditionalQuota(event.target.value)} /></label>
            <p className="muted">{Number(additionalQuota) > 0 ? `追加后总次数为 ${(assignment?.status === 'ACTIVE' ? assignment.quotaTotal : (assignment?.quotaUsed || 0)) + Number(additionalQuota)}，不会改变有效授权的当前有效期。` : '填写本次购买并追加的次数；有效期可在右侧单独调整。'}</p>
            <button className="primary-button" disabled={busy || !additionalQuota || Number(additionalQuota) > selected.available}>{assignment ? '追加次数' : '创建授权并追加'}</button>
          </form></Panel>
          <Panel title="调整有效期"><form onSubmit={updateValidity}>
            <label>新的到期日期<input type="date" required min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
            <p className="muted">仅调整到期时间，不改变总次数、已分配和剩余次数。</p>
            <button className="secondary-button" disabled={busy || !assignment || assignment.status !== 'ACTIVE' || !expiresAt}>调整有效期</button>
          </form></Panel>
        </div>
        {!assignment ? <Notice tone="info">该机构尚未获得此课包。先追加正数次数即可创建授权，默认有效期为 365 天。</Notice> : null}
      </> : <Empty title="选择课包和机构查看授权" body="普通授权流程一次只操作一家机构。" />}
      {selected ? <Panel title="该课包机构授权明细">{selected.allocations.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>状态</th><th>购买次数</th><th>已分配</th><th>余额</th><th>到期时间</th></tr></thead><tbody>{selected.allocations.map((item) => <tr key={item.id}><td>{item.orgName}</td><td><Status value={item.status} /></td><td>{item.quotaTotal}</td><td>{item.quotaUsed}</td><td>{item.remaining}</td><td>{formatDate(item.expiresAt)}</td></tr>)}</tbody></table></div> : <Empty title="暂无机构授权" />}</Panel> : null}
    </>}
  </>;
}
