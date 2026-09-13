import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
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
  // 统计三层：经营（metrics）/ 算力（compute，单位元）/ 内容（content）
  const compute = data?.compute || { totalYuan: 0, calls: 0, successCalls: 0, byModality: [], pools: { counted: 0, nearLimit: 0, exhausted: 0, unlimited: 0, usedYuan: 0 }, topStudents: [] };
  const content = data?.content || { lessonHot: [], submittedWorks: 0, onPlaza: 0, featured: 0, unpublished: 0, lessonsPublished: 0 };
  // B5：官网转化漏斗并入统计板块（与「转化分析」同一个后端实现，口径只此一处）
  const site = data?.site || { totals: { events: 0, visitors: 0 }, funnel: [], byEvent: [], retentionDays: 0 };
  const yuan = (value) => `¥${Number(value || 0).toFixed(2)}`;
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
        统计区间：{formatDate(data.filters.from)} 至 {formatDate(data.filters.to)}（本地时间显示，接口按 UTC 左闭右开统计）；生成时间 {formatDate(data.meta.generatedAt)}。
      </Notice>
      <div className="metrics">
        <MetricCard label="活跃学生" value={metrics.activeStudents ?? 0} hint="查询区间内有学习活动的学生" />
        <MetricCard label="课堂场次（查询期）" value={metrics.classSessions ?? 0} hint="查询区间内的课堂场次" />
        <MetricCard label="已知成本小计" value={yuan(compute.knownCostYuan)} hint="不含未知成本；估算不代表真实账单" />
        <MetricCard label="异常调用" value={metrics.abnormalTasks ?? 0} hint="查询区间内失败或被拦截的调用" />
      </div>
      <Panel title="运营关注">
        <div className="row-actions"><span>课堂成本未知 <strong>{compute.pools.unknown}</strong></span><span>超额预警 <strong>{compute.pools.exhausted}</strong></span><Link className="text-button" to="/compute/usage">查看用量与成本</Link><Link className="text-button" to="/organizations">管理机构</Link></div>
      </Panel>
      <details className="admin-detail"><summary>机构、教学与内容规模</summary><div className="metrics">
        {[['organizations', '机构总数'], ['activeOrganizations', '可用机构'], ['teachers', '教师'], ['students', '学生'], ['publishedCourses', '已发布课程'], ['activeAssignments', '课程授权'], ['projects', '新增项目'], ['works', '提交作品'], ['aiTasks', 'AI 任务'], ['newStudents', '新增学生'], ['lessonCompletions', '完成课时']].map(([key, label]) => <MetricCard key={key} label={label} value={metrics[key] ?? 0} hint={definition(key)} />)}
      </div></details>
      <div className="split">
        <Panel title="平台成本与课堂预警">
          <p>四种模态已知成本小计 {yuan(compute.knownCostYuan)}，共 {compute.calls} 次使用（成功 {compute.successCalls} 次）。未知成本未计入小计，历史售价不作为成本。用户包算力，课堂预算超额仅告警。</p>
          <table><thead><tr><th>模态</th><th>调用</th><th>已知成本小计</th></tr></thead><tbody>{compute.byModality.map(item=><tr key={item.modality}><td>{item.modality}</td><td>{item.calls}</td><td>{yuan(item.yuan)}</td></tr>)}</tbody></table>
          <p>课堂 {compute.pools.counted} 场 · 成本未知 {compute.pools.unknown || 0} 场 · 超额预警 {compute.pools.exhausted} 场 · 未配置基准 {compute.pools.unlimited} 场</p>
        </Panel>
        <Panel title="内容（课包与课时的使用热度）">
          <div className="muted" style={{ marginBottom: 8 }}>
            已发布课时 {content.lessonsPublished} 节 · 区间内提交作品 {content.submittedWorks} 件 ·
            在广场 {content.onPlaza} 件 · 精选 {content.featured} 件 · 已下架 {content.unpublished} 件
          </div>
          <div className="table-wrap"><table><thead><tr><th>课时（开课最多 Top 5）</th><th>所属课包</th><th>课堂场次</th></tr></thead><tbody>
            {content.lessonHot.length ? content.lessonHot.map((item) => <tr key={item.id}><td><strong>{item.title}</strong></td><td className="muted">{item.seriesTitle}</td><td>{item.sessions}</td></tr>) : <tr><td colSpan={3}>所选区间内没有开过课堂</td></tr>}
          </tbody></table></div>
        </Panel>
      </div>
      <Panel title="官网转化（第一方匿名分析）">
        <div className="muted" style={{ marginBottom: 8 }}>
          区间内匿名事件 {site.totals?.events || 0} 条 · 去重访客 {site.totals?.visitors || 0} 人 ·
          数据保留 {site.retentionDays || 90} 天。访客同意匿名分析后才记录，不含 IP / 姓名 / 电话。
        </div>
        <div className="table-wrap"><table><thead><tr><th>步骤</th><th>匿名访客</th><th>事件数</th><th>较上一步</th></tr></thead><tbody>
          {site.funnel?.length ? site.funnel.map((item) => <tr key={item.eventName}><td><strong>{item.label}</strong><div className="muted">{item.eventName}</div></td><td>{item.visitors}</td><td>{item.events}</td><td>{item.rateFromPrevious == null ? '—' : `${item.rateFromPrevious}%`}</td></tr>) : <tr><td colSpan={4}>所选区间暂无已同意的分析事件</td></tr>}
        </tbody></table></div>
        {site.byEvent?.length ? <div className="top-gap"><h4>事件明细</h4><div className="table-wrap"><table><thead><tr><th>事件</th><th>匿名访客</th><th>次数</th></tr></thead><tbody>{site.byEvent.map((item) => <tr key={item.eventName}><td>{item.eventName}</td><td>{item.visitors}</td><td>{item.events}</td></tr>)}</tbody></table></div></div> : null}
      </Panel>
      <details className="admin-detail"><summary>查看统计口径</summary><Panel title="统计口径"><div className="table-wrap"><table><thead><tr><th>指标</th><th>口径说明</th></tr></thead><tbody>{Object.entries(definitions).map(([key, text]) => <tr key={key}><td>{key}</td><td>{text}</td></tr>)}</tbody></table></div></Panel></details>
    </>}
  </>;
}
