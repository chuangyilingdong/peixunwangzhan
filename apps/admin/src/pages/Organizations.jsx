import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function Organizations({ api }) {
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
  const [form, setForm] = useState({ name: '', adminLogin: '', adminPassword: '', contractNotes: '', contractStartAt: new Date().toISOString().slice(0,10), contractExpiresAt: new Date(Date.now()+365*86400000).toISOString().slice(0,10) });
  const [editForm, setEditForm] = useState(null);
  const [adminForm, setAdminForm] = useState({ login: '', displayName: '', password: '' });
  const [passwordForm, setPasswordForm] = useState({});
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
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
      baseTeacherSeats: item.baseTeacherSeats,
      purchasedTeacherSeats: item.purchasedTeacherSeats,
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
      await api.post('admin/organizations', { ...form, contact: { contractNotes: form.contractNotes } });
      setForm({ name: '', adminLogin: '', adminPassword: '', contractNotes: '', contractStartAt: new Date().toISOString().slice(0,10), contractExpiresAt: new Date(Date.now()+365*86400000).toISOString().slice(0,10) });
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
    <PageHeader eyebrow="平台教务" title="机构管理" description="创建和维护机构资料、服务状态、管理员、人数上限与审计记录。" actions={<><button className="secondary-button" disabled={exporting} onClick={exportOrganizations}>{exporting ? '导出中…' : '导出 CSV'}</button><button className="secondary-button" onClick={() => { organizations.refresh(); if (selectedId) detail.refresh(); }}>刷新</button></>} />
    <div className="split">
      <Panel title="新建机构"><form onSubmit={create}>
        <label>机构名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label>管理员账号<input value={form.adminLogin} onChange={(e) => setForm({ ...form, adminLogin: e.target.value })} required /></label>
        <div className="form-grid">
          <label>初始密码<input type="password" autoComplete="new-password" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} required minLength={6} /></label>
          <label>签约开始日期<input type="date" value={form.contractStartAt} onChange={(e) => setForm({ ...form, contractStartAt: e.target.value })} required /></label><label>签约到期日期<input type="date" value={form.contractExpiresAt} onChange={(e) => setForm({ ...form, contractExpiresAt: e.target.value })} required /></label>
        </div>
        <label>签约内容<textarea rows={4} maxLength={5000} value={form.contractNotes} onChange={(e) => setForm({ ...form, contractNotes: e.target.value })} placeholder="填写签约服务、约定事项或合同备注" /></label>
        <button className="primary-button" disabled={saving}>{saving ? '创建中…' : '创建机构'}</button>
      </form></Panel>
      <Panel title="服务规则说明"><Notice tone="info">停用机构后，该机构全部现有登录会话立即失效，无法新建课堂、开课堂或调用 AI；恢复服务要求合同未到期，成功后机构用户可重新登录或继续使用未失效会话。所有状态和资料变更都会写入审计。</Notice></Panel>
    </div>
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
          <MetricCard label="教师席位" value={`${selected.teacherUsedSeats} / ${selected.totalTeacherSeats}`} hint={`基础 ${selected.baseTeacherSeats} + 购买 ${selected.purchasedTeacherSeats}`} tone={selected.totalTeacherSeats - selected.teacherUsedSeats < 3 ? 'orange' : undefined} />
        </div>

        {selected.contractExpiringSoon ? <Notice tone="warning">该机构合同将在 {selected.daysUntilContractExpires} 天内到期，请尽快联系续约。</Notice> : null}
        <div className="split">
          <Panel title="编辑机构资料">{editForm ? <form onSubmit={saveEdit}>
            <label>机构名称<input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required /></label>
            <div className="form-grid">
              <label>合同开始日期<input type="date" value={editForm.contractStartAt} onChange={(e) => setEditForm({ ...editForm, contractStartAt: e.target.value })} required /></label>
              <label>合同到期日期<input type="date" value={editForm.contractExpiresAt} onChange={(e) => setEditForm({ ...editForm, contractExpiresAt: e.target.value })} required /></label>
              <label>学生数量上限<input type="number" min="0" value={editForm.studentSeats} onChange={(e) => setEditForm({ ...editForm, studentSeats: e.target.value })} required /></label>
              <label>基础教师席位<input type="number" min="0" value={editForm.baseTeacherSeats} onChange={(e) => setEditForm({ ...editForm, baseTeacherSeats: e.target.value })} required /></label>
              <label>购买教师席位<input type="number" min="0" value={editForm.purchasedTeacherSeats} onChange={(e) => setEditForm({ ...editForm, purchasedTeacherSeats: e.target.value })} required /></label>
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
            <Link to="/authorizations">前往授权管理</Link>
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
  const inventory = useData(() => api.get('admin/authorizations'), [api]);
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const [seriesId, setSeriesId] = useState('');
  const [orgIds, setOrgIds] = useState([]);
  const [quota, setQuota] = useState('');
  const [days, setDays] = useState(365);
  const [stock, setStock] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selected = inventory.data?.items.find((item) => item.id === seriesId);
  async function save(kind) {
    setBusy(true); setMessage('');
    try {
      if (kind === 'stock') await api.put(`admin/course-series/${seriesId}/stock`, { stockTotal: Number(stock) });
      else await api.post(`admin/course-series/${seriesId}/assignments`, { orgIds, validityDays: Number(days), ...(quota === '' ? {} : { quotaTotal: Number(quota) }) });
      setMessage('已保存。'); inventory.refresh();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  return <><PageHeader title="授权管理" description="维护已发布课包库存，记录机构购买次数、学生分配与余额。每名学生的首次许可消耗一次。" />
    {message && <Notice>{message}</Notice>}
    {inventory.loading ? <Loading /> : inventory.error ? <ErrorState error={inventory.error} onRetry={inventory.refresh} /> : <Panel title="已发布课包库存"><div className="table-wrap"><table><thead><tr><th>课包</th><th>库存总次数</th><th>已分配或消耗</th><th>可分配库存</th></tr></thead><tbody>{inventory.data.items.map((item) => <tr key={item.id}><td><button className="text-button" onClick={() => { setSeriesId(item.id); setStock(String(item.stockTotal)); setOrgIds([]); setQuota(''); }}>{item.title}</button></td><td>{item.stockTotal}</td><td>{item.reserved}</td><td>{item.available}</td></tr>)}</tbody></table></div></Panel>}
    {selected ? <><div className="metrics"><MetricCard label="库存" value={selected.stockTotal} /><MetricCard label="剩余可分配" value={selected.available} /></div>
      <div className="split"><Panel title={`${selected.title} · 库存设置`}><form onSubmit={(e) => { e.preventDefault(); save('stock'); }}><label>库存总次数<input type="number" min={selected.reserved} max="100000000" required value={stock} onChange={(e) => setStock(e.target.value)} /></label><button className="primary-button" disabled={busy}>保存库存</button></form></Panel>
      <Panel title="机构购买与续期"><form onSubmit={(e) => { e.preventDefault(); save('assign'); }}>
        {organizations.error ? <ErrorState error={organizations.error} onRetry={organizations.refresh} /> : <label>选择机构（可多选）<select multiple required value={orgIds} onChange={(e) => setOrgIds(Array.from(e.target.selectedOptions, (option) => option.value))}>{organizations.data?.items.map((org) => <option value={org.id} key={org.id}>{org.name}</option>)}</select></label>}
        <label>每家机构购买总次数<input type="number" min="1" max="100000000" value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="续期留空保留原额度" /></label>
        <p className="muted">填写总额度，包含已分配学生的次数；首次购买必须填写正数。续期留空保留原额度，零次不代表不限。</p>
        <label>有效天数<input type="number" min="1" max="3650" required value={days} onChange={(e) => setDays(e.target.value)} /></label><button className="primary-button" disabled={busy || !orgIds.length}>保存购买 / 续期</button>
      </form></Panel></div>
      <Panel title="机构分配明细"><div className="table-wrap"><table><thead><tr><th>机构</th><th>状态</th><th>购买次数</th><th>已分配</th><th>余额</th><th>到期时间</th></tr></thead><tbody>{selected.allocations.map((item) => <tr key={item.id}><td>{item.orgName}</td><td><Status value={item.status} /></td><td>{item.quotaTotal}</td><td>{item.quotaUsed}</td><td>{item.remaining}</td><td>{formatDate(item.expiresAt)}</td></tr>)}</tbody></table></div></Panel>
    </> : <Empty title="选择课包管理库存和机构授权" />}</>;
}
