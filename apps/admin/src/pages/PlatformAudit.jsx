import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatCredits, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function PlatformAudit({ api }) {
  const [filters, setFilters] = useState({ action: '', actorId: '', targetType: '', targetId: '', requestPath: '', from: '', to: '', orgId: '' });
  const [limit, setLimit] = useState(50);
  const [page, setPage] = useState(1);
  const auditQuery = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    params.set('limit', String(limit)); params.set('page', String(page));
    return params.toString();
  }, [filters, limit, page]);
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
  useEffect(() => { if (list.data?.totalPages && page > list.data.totalPages) setPage(list.data.totalPages); }, [list.data, page]);
  useEffect(() => { setPage(1); }, [filters, actionFilter, limit]);
  const [exporting, setExporting] = useState(false);
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  function reset() { setFilters({ action: '', actorId: '', targetType: '', targetId: '', requestPath: '', from: '', to: '', orgId: '' }); setActionFilter(''); setPage(1); setMessage(''); }
  async function exportCsv() {
    setExporting(true); setMessage('');
    try {
      const exportParams = new URLSearchParams(fullQuery); exportParams.delete('page'); exportParams.set('limit', '2000');
      const result = await api.get(`admin/audit-logs/export?${exportParams.toString()}`);
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
        <label>动作<select value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}><option value="">全部动作</option>{(actions.data?.items || []).map((item) => <option key={item.action} value={item.action}>{item.action}（{item.count}）</option>)}</select></label>
        <label>自定义动作<input value={filters.action} placeholder="覆盖上方选择，留空使用下拉" onChange={(e) => setFilters({ ...filters, action: e.target.value })} /></label>
        <label>机构<select value={filters.orgId} onChange={(e) => { setFilters({ ...filters, orgId: e.target.value }); setPage(1); }}><option value="">全部机构</option>{(organizations.data?.items || []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
        <label>操作者 ID<input value={filters.actorId} onChange={(e) => setFilters({ ...filters, actorId: e.target.value })} /></label>
        <label>目标类型<input value={filters.targetType} placeholder="如 COURSE_SERIES / USER" onChange={(e) => setFilters({ ...filters, targetType: e.target.value })} /></label>
        <label>目标 ID<input value={filters.targetId} onChange={(e) => setFilters({ ...filters, targetId: e.target.value })} /></label>
        <label>请求路径（包含）<input value={filters.requestPath} placeholder="如 /admin/course-series" onChange={(e) => setFilters({ ...filters, requestPath: e.target.value })} /></label>
        <label>开始时间（UTC ISO）<input value={filters.from} placeholder="2026-09-01T00:00:00Z" onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
        <label>结束时间（UTC ISO）<input value={filters.to} placeholder="2026-09-04T00:00:00Z" onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
        <label>返回条数<select value={String(limit)} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}><option value="20">20</option><option value="50">50</option><option value="100">100</option><option value="200">200</option></select></label>
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
    <Panel title="审计记录">
      {list.loading || actions.loading ? <Loading label="正在读取审计记录…" /> : list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : list.data?.items.length ? <><ListResultSummary total={list.data.total} page={list.data.page} totalPages={list.data.totalPages} label="条记录" /><div className="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>角色</th><th>机构</th><th>动作</th><th>目标</th><th>请求路径</th><th>IP</th><th>变更前</th><th>变更后</th></tr></thead><tbody>{list.data.items.map((item) => <tr key={item.id}>
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
      </tr>)}</tbody></table></div><Pagination page={list.data.page} totalPages={list.data.totalPages} onChange={setPage} disabled={list.loading} /></> : <Empty title="当前筛选条件下无审计记录" body="可以调整动作、机构、操作者、目标或时间范围后重试。" />}
    </Panel>
  </>;
}

