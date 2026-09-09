import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatCredits, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function Dashboard({ api }) {
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
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
