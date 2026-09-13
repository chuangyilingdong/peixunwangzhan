import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function Analytics({ api }) {
  const [filters, setFilters] = useState({ from: '', to: '' });
  const query = useMemo(() => { const params = new URLSearchParams(); if (filters.from) params.set('from', new Date(filters.from).toISOString()); if (filters.to) { const end = new Date(filters.to); end.setDate(end.getDate() + 1); params.set('to', end.toISOString()); } return params.toString(); }, [filters]);
  const report = useData(() => api.get(`admin/analytics/overview${query ? `?${query}` : ''}`), [api, query]);
  const data = report.data || {};
  return <>
    <PageHeader eyebrow="官网运营" title="转化漏斗与匿名分析" description="仅展示获得访客选择同意后的第一方匿名事件；不含 IP、姓名、电话或完整查询参数。" actions={<button className="secondary-button" onClick={report.refresh}>刷新</button>} />
    <Panel title="统计区间">
      <div className="form-grid"><label>开始日期<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label><label>结束日期<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label><button type="button" className="secondary-button" onClick={() => setFilters({ from: '', to: '' })}>重置</button></div>
      <small className="muted">默认最近 30 天；数据保留 {data.retentionDays || 90} 天。</small>
    </Panel>
    {report.loading ? <Loading label="正在读取匿名分析…" /> : report.error ? <ErrorState error={report.error} onRetry={report.refresh} /> : <>
      <div className="metric-grid"><MetricCard label="匿名访客" value={data.totals?.visitors || 0} hint="按匿名访问标识去重" /><MetricCard label="事件总量" value={data.totals?.events || 0} hint="只统计已同意记录" /><MetricCard label="预约提交" value={data.funnel?.find((item) => item.eventName === 'demo_submitted')?.visitors || 0} hint="不含预约表单内容" /></div>
      <Panel title="转化漏斗"><div className="table-wrap"><table><thead><tr><th>步骤</th><th>匿名访客</th><th>事件数</th><th>较上一步</th></tr></thead><tbody>{(data.funnel || []).map((item) => <tr key={item.eventName}><td><strong>{item.label}</strong><div className="muted">{item.eventName}</div></td><td>{item.visitors}</td><td>{item.events}</td><td>{item.rateFromPrevious == null ? '—' : `${item.rateFromPrevious}%`}</td></tr>)}</tbody></table></div></Panel>
      <Panel title="事件明细"><div className="table-wrap"><table><thead><tr><th>事件</th><th>匿名访客</th><th>次数</th></tr></thead><tbody>{(data.byEvent || []).map((item) => <tr key={item.eventName}><td>{item.eventName}</td><td>{item.visitors}</td><td>{item.events}</td></tr>)}{!(data.byEvent || []).length && <tr><td colSpan="3"><Empty title="暂无已同意的分析事件" body="访客选择同意匿名分析后，这里才会出现汇总数据。" /></td></tr>}</tbody></table></div></Panel>
      <Notice>统计工具：平台内置第一方存储，不接入第三方广告或跨站跟踪。事件字段采用白名单，页面路径会去掉查询参数。</Notice>
    </>}
  </>;
}

