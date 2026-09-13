import { useAdminConfirm } from '../components/AdminConfirm.jsx';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function PlatformAdmins({ api, currentUser }) {
  const [confirm, confirmation] = useAdminConfirm();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [sort, setSort] = useState('created');
  const adminQuery = useMemo(() => {
    const params = new URLSearchParams(Object.entries({ search, status: statusFilter }).filter(([, value]) => value));
    params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort);
    return params;
  }, [search, statusFilter, page, limit, sort]);
  const admins = useData(() => api.get(`admin/platform-admins?${adminQuery.toString()}`), [api, adminQuery]);
  const permissionOptions = ['ADMIN_ORGANIZATIONS', 'ADMIN_COURSES', 'ADMIN_WORKS', 'ADMIN_BILLING', 'ADMIN_CONTENT', 'ADMIN_ANALYTICS', 'ADMIN_AUDIT'];
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
    const execute = async () => {
      setSaving(true);
      try { await api.put(`admin/platform-admins/${target.id}`, payload); setMessage(successMessage); admins.refresh(); if (editing?.id === target.id) setEditing(null); }
      finally { setSaving(false); }
    };
    if (confirmText) return confirm({ message: confirmText, execute });
    try { await execute(); } catch (error) { setMessage(error.message); }
  }
  function resetPassword(item) {
    return confirm({ title: '重置管理员密码', message: `重置「${item.displayName}」的密码后，该账号全部登录会话将立即失效。`, password: true, confirmLabel: '确认重置', execute: async (password) => {
      await api.put(`admin/platform-admins/${item.id}`, { password });
      setMessage('管理员密码已重置，该账号全部会话已失效。'); admins.refresh();
    } });
  }
  async function save(event) {
    event.preventDefault();
    await confirm({ title: '更新管理员权限', message: `确认更新「${editing.displayName}」的姓名与管理权限？`, execute: async () => {
      await api.put(`admin/platform-admins/${editing.id}`, { displayName: form.displayName, permissions: form.permissions });
      setMessage('平台管理员已更新。'); setEditing(null); admins.refresh();
    } });
  }
  async function showLogs(target) {
    setLogsLoading(true);
    try { const result = await api.get(`admin/platform-admins/${target.id}/audit-logs?limit=50`); setLogs({ admin: target, ...result }); }
    catch (err) { setMessage(err.message); } finally { setLogsLoading(false); }
  }
  return <>
    {confirmation}
    <PageHeader eyebrow="平台系统" title="平台管理员" description="维护平台运营账号、权限码和登录安全，查看最近登录、活跃会话与操作日志。" actions={<button className="secondary-button" onClick={admins.refresh}>刷新</button>} />
    <div className="split">
      <Panel title={editing ? `编辑管理员：${editing.displayName}` : '新建平台管理员'}>
        <form onSubmit={editing ? save : create}>
          {!editing && <div className="form-grid"><label>登录名<input value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required /></label><label>初始密码<input type="password" autoComplete="new-password" value={form.password} minLength={6} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label></div>}
          <label>姓名<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></label>
          <label>权限码</label>
          <div className="row-actions">{permissionOptions.map((permission) => <label key={permission} className="checkbox-option"><input type="checkbox" checked={form.permissions.includes(permission)} onChange={() => toggle(permission)} />{ADMIN_PERMISSION_LABELS[permission] || permission}</label>)}</div>
          {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
          <div className="row-actions">
            <button className="primary-button" disabled={saving}>{saving ? '保存中…' : editing ? '保存管理员' : '创建管理员'}</button>
            {editing && <button type="button" className="secondary-button" onClick={() => { setEditing(null); setForm({ login: '', displayName: '', password: '', permissions: [] }); }}>取消编辑</button>}
          </div>
        </form>
      </Panel>
      <Panel title="权限说明"><Notice>平台接口按业务域权限码判定；默认 root 账号保留完整权限。没有权限的菜单会隐藏，直接访问页面或接口会返回拒绝提示 / 403 PERMISSION_DENIED。不能停用当前登录账号和最后一个有效管理员由后端强制校验；停用或重置密码会立即使该账号全部会话失效。</Notice></Panel>
    </div>
    <Panel title="筛选条件">
      <div className="form-grid">
        <label>关键词<input value={search} placeholder="登录名 / 姓名" onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></label>
        <label>状态<select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}><option value="">全部状态</option><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label>
        <label>排序<select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="created">创建时间</option><option value="name">姓名</option><option value="status">状态</option></select></label>
        <label>每页<select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}><option value="10">10 条</option><option value="20">20 条</option><option value="50">50 条</option><option value="100">100 条</option></select></label>
      </div>
    </Panel>
    <Panel title="管理员列表">
      {admins.loading ? <Loading /> : admins.error ? <ErrorState error={admins.error} onRetry={admins.refresh} /> : admins.data?.items?.length ? <><ListResultSummary total={admins.data.total} page={admins.data.page} totalPages={admins.data.totalPages} label="名管理员" /><div className="table-wrap"><table><thead><tr><th>账号</th><th>状态</th><th>二次验证</th><th>权限码</th><th>最近登录</th><th>活跃会话</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{admins.data.items.map((item) => <tr key={item.id}><td><strong>{item.displayName}</strong><div className="muted">{item.login}</div>{item.id === currentUser?.id && <span className="muted">当前账号</span>}</td><td><Status value={item.status} /></td><td>{item.mfaEnabled ? <span className="status success">已开启</span> : <span className="status">未开启</span>}</td><td>{item.permissions.length ? item.permissions.join(', ') : '全量（本地基线）'}</td><td>{formatDate(item.lastLoginAt) || '从未登录'}</td><td>{item.activeSessions}</td><td>{formatDate(item.updatedAt)}</td><td><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setForm({ login: '', displayName: item.displayName, password: '', permissions: item.permissions }); setLogs(null); }}>编辑</button><button className="text-button" disabled={saving} onClick={() => resetPassword(item)}>重置密码</button>{item.status === 'ACTIVE' ? <button className="text-button" onClick={() => update(item, { status: 'DISABLED' }, '管理员已停用，该账号全部会话已失效。', `确认停用管理员「${item.displayName}」？停用后该账号现有登录会话立即失效。`)}>停用</button> : <button className="text-button" onClick={() => update(item, { status: 'ACTIVE' }, '管理员已启用。')}>启用</button>}<button className="text-button" disabled={logsLoading} onClick={() => showLogs(item)}>操作日志</button></div></td></tr>)}</tbody></table></div><Pagination page={admins.data.page} totalPages={admins.data.totalPages} onChange={setPage} disabled={admins.loading} /></> : <Empty title="没有符合条件的平台管理员" body="可以调整关键词或状态筛选条件。" />}
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

