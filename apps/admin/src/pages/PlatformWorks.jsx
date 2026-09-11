import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatCredits, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function PlatformWorks({ api }) {
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const [filters, setFilters] = useState({ status: '', orgId: '', search: '' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [sort, setSort] = useState('featured');
  const [message, setMessage] = useState(''); const [action, setAction] = useState(null); const [reason, setReason] = useState(''); const [saving, setSaving] = useState(false);
  const reports = useData(() => api.get('admin/work-reports?status=PENDING'), [api]);
  const [reportAction, setReportAction] = useState(null); const [reportForm, setReportForm] = useState({ status: 'RESOLVED', actionTaken: 'NONE', resolution: '' }); const [reportBusy, setReportBusy] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const detail = useData(() => detailId ? api.get(`admin/works/${detailId}/detail`) : Promise.resolve(null), [api, detailId]);
  const [exporting, setExporting] = useState(false);
  async function exportWorks() {
    setExporting(true); setMessage('');
    try {
      const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const result = await api.get(`admin/works/export?${params.toString()}`);
      downloadCsv(result.filename, result.content);
      setMessage(`已导出 ${result.count} 件作品。`);
    } catch (error) { setMessage(error.message); } finally { setExporting(false); }
  }
  const [detailTab, setDetailTab] = useState('basic');
  const [detailFeatureReason, setDetailFeatureReason] = useState('');
  const query = useMemo(() => { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)); params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort); return params; }, [filters, page, limit, sort]);
  const works = useData(() => api.get(`admin/works?${query.toString()}`), [api, query]);
  const vibeWorks = useData(() => api.get('admin/vibecoding-works?limit=20'), [api]);
  async function toggleVibePlaza(item) {
    setSaving(true); setMessage('');
    try {
      await api.put(`admin/vibecoding-works/${item.id}/plaza`, { published: !item.isPublic });
      setMessage(item.isPublic ? `已将《${item.title}》从作品广场移除。` : `已将《${item.title}》发布到作品广场，官网可点开直接玩。`);
      vibeWorks.refresh();
    } catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  const statusLabels = { PENDING: '已提交待发布', APPROVED: '已通过', REJECTED: '已下架', PUBLISHED: '已发布到作品广场' };
  const reportCategoryLabels = { INAPPROPRIATE: '内容不当', COPYRIGHT: '版权', PRIVACY: '隐私', OTHER: '其他' };
  const reportStatusLabels = { PENDING: '待处理', RESOLVED: '已处理', DISMISSED: '已驳回' };
  async function unpublish() { if (!action) return; setSaving(true); setMessage(''); try { await api.put(`admin/works/${action.id}/unpublish`, { reason }); setMessage(`已下架《${action.title}》。`); setAction(null); setReason(''); works.refresh(); reports.refresh(); if (detailId === action.id) detail.refresh(); } catch (err) { setMessage(err.message); } finally { setSaving(false); } }
  async function toggleFeature(item) { setSaving(true); setMessage(''); try { await api.put(`admin/works/${item.id}/feature`, { featured: !item.featured, reason: !item.featured ? '平台精选推荐' : '' }); setMessage(item.featured ? `已取消《${item.title}》的精选。` : `已将《${item.title}》设为精选。`); works.refresh(); if (detailId === item.id) detail.refresh(); } catch (err) { setMessage(err.message); } finally { setSaving(false); } }
  async function togglePlaza(item) { setSaving(true); setMessage(''); try { await api.put(`admin/works/${item.id}/plaza`, { published: !item.plazaPublished }); setMessage(item.plazaPublished ? `已将《${item.title}》从学生作品广场移除。` : `已将《${item.title}》发布到学生作品广场。`); works.refresh(); if (detailId === item.id) detail.refresh(); } catch (err) { setMessage(err.message); } finally { setSaving(false); } }
  async function handleReport() { if (!reportAction) return; setReportBusy(true); setMessage(''); try { await api.put(`admin/work-reports/${reportAction.id}`, reportForm); setMessage(`举报《${reportAction.workTitle}》已处理。`); setReportAction(null); setReportForm({ status: 'RESOLVED', actionTaken: 'NONE', resolution: '' }); reports.refresh(); works.refresh(); if (detailId === reportAction.workId) detail.refresh(); } catch (err) { setMessage(err.message); } finally { setReportBusy(false); } }
  function openDetail(item) { setDetailId(item.id); setDetailTab('basic'); setDetailFeatureReason(item.featuredReason || ''); }
  function closeDetail() { setDetailId(null); }
  return <>
    <PageHeader eyebrow="内容治理" title="平台作品库" description="学生提交的作品会汇总到这里；由平台选择「发布到作品广场」的作品才会出现在官网学生作品广场（画布作品与 VibeCoding 作品都在本页，不再需要机构先审核）。" actions={<><button className="secondary-button" disabled={exporting} onClick={exportWorks}>{exporting ? '导出中…' : '导出 CSV'}</button><button className="secondary-button" onClick={() => { works.refresh(); reports.refresh(); if (detailId) detail.refresh(); }}>刷新</button></>} />
    <Panel title="筛选条件"><div className="form-grid"><label>状态<select value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>机构<select value={filters.orgId} onChange={(e) => { setFilters({ ...filters, orgId: e.target.value }); setPage(1); }}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) || null}</select></label><label>关键词<input value={filters.search} placeholder="作品 / 学员 / 机构" onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} /></label><label>排序<select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="featured">精选 / 提交时间</option><option value="submitted">最近提交</option><option value="title">作品名称</option></select></label><label>每页条数<select value={String(limit)} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label></div>{message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}</Panel>
    <Panel title={`作品列表（${works.data?.total ?? 0} 条）`}>{works.loading || organizations.loading ? <Loading /> : works.error ? <ErrorState error={works.error} onRetry={works.refresh} /> : works.data.items.length ? <><ListResultSummary total={works.data.total} page={works.data.page} totalPages={works.data.totalPages} label="件作品" /><div className="table-wrap"><table><thead><tr><th>作品</th><th>学员 / 机构</th><th>状态与授权</th><th>举报（暂缓）</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{works.data.items.map((item) => <tr key={item.id}><td><button className="text-button" onClick={() => openDetail(item)}><strong>{item.title}</strong></button><div className="muted">{item.description || '暂无描述'}</div></td><td><strong>{item.studentName || item.studentId}</strong><div className="muted">{item.organizationName || '未绑定机构'} · {item.className || '—'}</div></td><td><Status value={item.status} />{item.featured && <span className="status success">精选</span>}{item.plazaPublished ? <span className="status success">作品广场</span> : null}<div className="muted">{item.copyrightConfirmedAt ? '已确认展示授权' : '未确认展示授权'}</div></td><td>{item.pendingReportCount ? <span className="status danger">待处理 {item.pendingReportCount}</span> : '—'}</td><td>{formatDate(item.submittedAt)}</td><td><div className="row-actions">{['PENDING', 'APPROVED', 'PUBLISHED'].includes(item.status) ? <button className="text-button" disabled={saving} onClick={() => togglePlaza(item)}>{item.plazaPublished ? '从作品广场移除' : '发布到作品广场'}</button> : null}{item.status === 'PUBLISHED' && <><button className="text-button" disabled={saving} onClick={() => toggleFeature(item)}>{item.featured ? '取消精选' : '设为精选'}</button><button className="text-button" onClick={() => { setAction(item); setReason(''); }}>平台下架</button></>}</div></td></tr>)}</tbody></table></div><Pagination page={works.data.page} totalPages={works.data.totalPages} onChange={setPage} disabled={works.loading} /></> : <Empty title="没有符合条件的作品" />}</Panel>
    <Panel title={`VibeCoding 作品（${vibeWorks.data?.total ?? 0} 条）`} actions={<button className="secondary-button" onClick={vibeWorks.refresh}>刷新</button>}>
      {vibeWorks.loading ? <Loading /> : vibeWorks.error ? <ErrorState error={vibeWorks.error} onRetry={vibeWorks.refresh} /> : vibeWorks.data?.items?.length ? <>
        <Notice>学生提交后就能在这里发布到作品广场（已没有「老师点评」这一环）；发布后官网 /works 会显示卡片：网页点开直接玩，PPT / Word / Excel 先在站内预览、再下载真文件。</Notice>
        <div className="table-wrap"><table><thead><tr><th>作品</th><th>学员 / 机构</th><th>课时</th><th>状态与授权</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{vibeWorks.data.items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><div className="muted">{item.description || '暂无描述'} · 第 {item.round} 次提交 · 主产物 {item.preview?.name || item.entryFile}</div></td><td><strong>{item.studentName || item.studentId}</strong><div className="muted">{item.organizationName || '未绑定机构'} · {item.className || '—'}</div></td><td>{item.lessonTitle || '—'}</td><td><Status value={item.status} />{item.isPublic ? <span className="status success">作品广场</span> : null}<div className="muted">{item.copyrightConfirmedAt ? '已确认展示授权' : '未确认展示授权'}</div></td><td>{formatDate(item.submittedAt)}</td><td><div className="row-actions">{item.copyrightConfirmedAt ? <button className="text-button" disabled={saving} onClick={() => toggleVibePlaza(item)}>{item.isPublic ? '从作品广场移除' : '发布到作品广场'}</button> : <span className="muted">学生未确认展示授权</span>}{item.isPublic ? <a className="text-button" href={`/works/${item.shareToken}`} target="_blank" rel="noreferrer">打开体验 ↗</a> : null}</div></td></tr>)}</tbody></table></div>
      </> : <Empty title="暂无 VibeCoding 作品" body="学生在 VibeCoding 课堂提交作品后，会显示在这里。" />}
    </Panel>
    <Panel title={`举报记录（当前暂缓，仅保留历史只读） · ${reports.data?.pending || 0} 条`}>{reports.loading ? <Loading /> : reports.error ? <ErrorState error={reports.error} onRetry={reports.refresh} /> : reports.data.items.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>举报人</th><th>类型 / 说明</th><th>时间</th><th>操作（暂缓）</th></tr></thead><tbody>{reports.data.items.map((item) => <tr key={item.id}><td>{item.workTitle}<div className="muted"><Status value={item.workStatus} /></div></td><td>{item.reporterName || '学生'}</td><td>{item.category}<div className="muted">{item.details || '未补充说明'}</div></td><td>{formatDate(item.createdAt)}</td><td><button className="text-button" disabled title="举报治理按当前决策暂缓">暂缓</button></td></tr>)}</tbody></table></div> : <Empty title="暂无待处理举报" />}</Panel>
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
        <button type="button" className={`tab-button ${detailTab === 'reports' ? 'active' : ''}`} style={{ padding: '6px 12px', border: '1px solid #cbd5e1', borderRadius: 6, background: detailTab === 'reports' ? '#0f172a' : '#fff', color: detailTab === 'reports' ? '#fff' : '#0f172a', cursor: 'pointer' }} onClick={() => setDetailTab('reports')}>举报记录（暂缓） · {detail.data.reports.length}</button>
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

