import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatCredits, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function AdminInbox({ api }) {
  const [filters, setFilters] = useState({ search: '', status: '' });
  const [page, setPage] = useState(1); const [limit, setLimit] = useState(20); const [sort, setSort] = useState('created');
  const query = useMemo(() => { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)); params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort); return params; }, [filters, page, limit, sort]);
  const inbox = useData(() => api.get(`admin/inbox?${query.toString()}`), [api, query]);
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
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
    <Panel title="平台通知记录">{inbox.loading || organizations.loading ? <Loading /> : inbox.error ? <ErrorState error={inbox.error} onRetry={inbox.refresh} /> : inbox.data?.items?.length ? <>
      <div className="filters"><input value={filters.search} placeholder="搜索通知标题或内容" onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} /><select value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}><option value="">全部状态</option><option value="DRAFT">草稿</option><option value="SCHEDULED">已排期</option><option value="PUBLISHED">已发布</option><option value="RECALLED">已撤回</option></select><select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="created">创建时间</option><option value="updated">更新时间</option><option value="publish">发布时间</option><option value="title">标题</option><option value="pinned">置顶优先</option></select><select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}><option value="10">10 条/页</option><option value="20">20 条/页</option><option value="50">50 条/页</option></select></div>
      <ListResultSummary total={inbox.data.total} page={inbox.data.page} totalPages={inbox.data.totalPages} label="条通知" /><div className="table-wrap"><table><thead><tr><th>通知</th><th>范围</th><th>投递 / 未读</th><th>状态</th><th>发布时间</th><th>操作</th></tr></thead><tbody>{inbox.data.items.map((item) => <tr key={item.id}><td><strong>{item.pinned ? '置顶 · ' : ''}{item.title}</strong><div className="muted">{item.kind} · {item.body}</div></td><td>{item.audience?.scope === 'ALL_ORGS' ? '全部用户' : `${item.audience?.orgIds?.length || 0} 家机构`}<div className="muted">{item.audience?.roles?.join(' / ')}</div></td><td>{item.recipientCount} / {item.unreadCount}</td><td><Status value={item.status} /></td><td>{item.publishAt ? formatDate(item.publishAt) : '—'}</td><td><div className="row-actions">{['DRAFT', 'SCHEDULED', 'RECALLED'].includes(item.status) ? <button className="secondary-button" onClick={() => update(item, 'PUBLISHED')}>立即发布</button> : null}{item.status === 'PUBLISHED' ? <button className="text-button" onClick={() => update(item, 'RECALLED')}>撤回</button> : null}</div></td></tr>)}</tbody></table></div><Pagination page={inbox.data.page} totalPages={inbox.data.totalPages} onChange={setPage} disabled={inbox.loading} /></> : <><div className="filters"><input value={filters.search} placeholder="搜索通知标题或内容" onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} /><select value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}><option value="">全部状态</option><option value="DRAFT">草稿</option><option value="SCHEDULED">已排期</option><option value="PUBLISHED">已发布</option><option value="RECALLED">已撤回</option></select></div><Empty title="当前筛选条件下无通知" body="可以调整关键词或状态筛选条件。" /></>}</Panel>
  </>;
}

