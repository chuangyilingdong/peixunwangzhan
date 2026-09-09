import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatCredits, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function PlatformUsers({ api }) {
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const [filters, setFilters] = useState({ role: '', orgId: '', search: '' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [sort, setSort] = useState('created');
  const query = useMemo(() => { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)); params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort); return params; }, [filters, page, limit, sort]);
  const users = useData(() => api.get(`admin/platform-users?${query.toString()}`), [api, query]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordInput, setPasswordInput] = useState({});
  const [detailId, setDetailId] = useState('');
  const [roleDraft, setRoleDraft] = useState('');
  const detail = useData(() => detailId ? api.get(`admin/platform-users/${detailId}`) : Promise.resolve(null), [api, detailId]);
  const [exporting, setExporting] = useState(false);
  async function exportUsers() {
    setExporting(true); setMessage('');
    try {
      const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const result = await api.get(`admin/platform-users/export?${params.toString()}`);
      downloadCsv(result.filename, result.content);
      setMessage(`已导出 ${result.count} 名用户。`);
    } catch (error) { setMessage(error.message); } finally { setExporting(false); }
  }
  const roleLabels = { SUPER_ADMIN: '平台超管', ORG_ADMIN: '机构管理员', TEACHER: '教师', STUDENT: '学员' };
  async function run(target, action, body, successMessage, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setMessage('');
    try { await api.put(`admin/platform-users/${target.id}/${action}`, body); setPasswordInput({ ...passwordInput, [target.id]: '' }); setMessage(successMessage); users.refresh(); }
    catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  return <>
    <PageHeader eyebrow="平台教务" title="平台用户" description="按角色、机构和关键词查看全平台真实账号、套餐与状态，并可执行启停、重置密码与解绑手机。" actions={<><button className="secondary-button" disabled={exporting} onClick={exportUsers}>{exporting ? '导出中…' : '导出 CSV'}</button><button className="secondary-button" onClick={users.refresh}>刷新</button></>} />
    <Panel title="筛选条件">
      <div className="form-grid">
        <label>角色<select value={filters.role} onChange={(e) => { setFilters({ ...filters, role: e.target.value }); setPage(1); }}><option value="">全部角色</option>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>机构<select value={filters.orgId} onChange={(e) => { setFilters({ ...filters, orgId: e.target.value }); setPage(1); }}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) || null}</select></label>
        <label>关键词<input value={filters.search} placeholder="登录名 / 姓名 / 手机号" onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} /></label>
        <label>排序<select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="created">创建时间</option><option value="name">姓名</option><option value="status">状态</option></select></label>
        <label>每页数量<select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}><option value={10}>10 条/页</option><option value={20}>20 条/页</option><option value={50}>50 条/页</option></select></label>
      </div>
      {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
    </Panel>
    <Panel title="用户列表">
      {users.loading || organizations.loading ? <Loading /> : users.error ? <ErrorState error={users.error} onRetry={users.refresh} /> : users.data.items.length ? <><ListResultSummary total={users.data.total} page={users.data.page} totalPages={users.data.totalPages} label="名用户" /><div className="table-wrap"><table><thead><tr><th>用户</th><th>角色</th><th>机构</th><th>套餐</th><th>状态</th><th>有效期至</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{users.data.items.map((item) => <tr key={item.id}><td><strong>{item.displayName}</strong><div className="muted">{item.login}{item.phone ? ` · ${item.phone}` : ''}</div></td><td>{roleLabels[item.role] || item.role}</td><td>{item.organizationName || '平台'}</td><td>{item.role === 'STUDENT' ? (item.billingPackageName || '未绑定') : '—'}</td><td><Status value={item.status} /></td><td>{formatDate(item.expiresAt) || '长期'}</td><td>{formatDate(item.createdAt)}</td><td><div className="row-actions">
        <button className="text-button" onClick={() => { setDetailId(item.id); setRoleDraft(item.role); setMessage(''); }}>详情</button>
        {item.status === 'ACTIVE'
          ? <button className="text-button" disabled={busy} onClick={() => run(item, 'status', { status: 'DISABLED' }, `已停用 ${item.displayName}，该账号现有登录会话立即失效。`, `确认停用「${item.displayName}」？停用后该账号现有登录会话立即失效，将无法登录和使用平台功能。`)}>停用</button>
          : <button className="text-button" disabled={busy} onClick={() => run(item, 'status', { status: 'ACTIVE' }, `已启用 ${item.displayName}。`)}>启用</button>}
        <input placeholder="新密码（≥6位）" value={passwordInput[item.id] || ''} onChange={(e) => setPasswordInput({ ...passwordInput, [item.id]: e.target.value })} />
        <button className="text-button" disabled={busy || (passwordInput[item.id] || '').length < 6} onClick={() => run(item, 'password', { password: passwordInput[item.id] }, `已重置 ${item.displayName} 的密码，该账号全部会话已失效。`)}>重置密码</button>
        {item.phone ? <button className="text-button" disabled={busy} onClick={() => run(item, 'phone', { phone: '' }, `已解绑 ${item.displayName} 的手机号。`, `确认解绑「${item.displayName}」的手机号 ${item.phone}？`)}>解绑手机</button> : null}
      </div></td></tr>)}</tbody></table></div><Pagination page={users.data.page} totalPages={users.data.totalPages} onChange={setPage} disabled={users.loading} /></> : <Empty title="没有符合条件的用户" body="可以调整角色、机构、关键词、排序或每页数量。" />}
    </Panel>
    {detailId ? <Panel title="用户详情" actions={<button className="secondary-button" onClick={() => setDetailId('')}>关闭</button>}>
      {detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : detail.loading || !detail.data ? <Loading /> : <>
        <div className="metrics-row">
          <div className="metric-item"><span className="metric-label">账号</span><span className="metric-value">{detail.data.displayName || detail.data.login}</span></div>
          <div className="metric-item"><span className="metric-label">登录名</span><span className="metric-value">{detail.data.login}</span></div>
          <div className="metric-item"><span className="metric-label">角色</span><span className="metric-value">{roleLabels[detail.data.role] || detail.data.role}</span></div>
          <div className="metric-item"><span className="metric-label">机构</span><span className="metric-value">{detail.data.organizationName || '平台'}</span></div>
          <div className="metric-item"><span className="metric-label">状态</span><span className="metric-value"><Status value={detail.data.status} /></span></div>
          <div className="metric-item"><span className="metric-label">活跃会话</span><span className="metric-value">{detail.data.activeSessions ?? 0}</span></div>
        </div>
        <div className="muted">最近登录：{formatDate(detail.data.lastLoginAt) || '从未登录'} · 创建于 {formatDate(detail.data.createdAt)} · 更新于 {formatDate(detail.data.updatedAt)}</div>
        <div className="form-grid top-gap">
          <label>调整角色<select value={roleDraft} onChange={(e) => setRoleDraft(e.target.value)} disabled={detail.data.role === 'SUPER_ADMIN'}>
            {['STUDENT', 'TEACHER', 'ORG_ADMIN'].map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
          </select></label>
          <div><button className="primary-button" disabled={busy || detail.data.role === 'SUPER_ADMIN' || roleDraft === detail.data.role}
            onClick={async () => {
              setBusy(true); setMessage('');
              try {
                await api.put(`admin/platform-users/${detail.data.id}/role`, { role: roleDraft });
                setMessage(`已把 ${detail.data.displayName} 的角色改为${roleLabels[roleDraft]}，该账号全部会话已失效。`);
                users.refresh(); detail.refresh();
              } catch (err) { setMessage(err.message); } finally { setBusy(false); }
            }}>保存角色</button></div>
        </div>
        {detail.data.role === 'SUPER_ADMIN' ? <Notice tone="info">平台管理员角色在「平台管理员」页管理，这里不提供修改。</Notice> : null}
      </>}
    </Panel> : null}
  </>;
}

