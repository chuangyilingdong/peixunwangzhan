import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty, ErrorState, formatDate, Loading, Notice, PageHeader, Panel, Pagination, ListResultSummary, useData } from '@platform/shared';
import { downloadCsv } from '../shared.jsx';

const publicationLabels = { SUBMITTED: '已提交待发布', PUBLISHED: '已发布到官网', UNPUBLISHED: '已下架' };
import { WorkPreview } from '../components/WorkPreview.jsx';
// 只用于**后台显示**的类型中文名 —— 判断哪个类型算哪一类的是服务端（services/plazaCategories.js），
// 这里只是别让管理员对着一串英文 key 做选择。与官网的 PL_TYPE_META 是两处，都只影响显示。
const typeLabels = { image: '图片', video: '视频', webpage: '网页', miniGame: '小游戏', ppt: 'PPT', brandDesign: '品牌设计', music: '音乐', podcast: 'AI播客', agent: '智能体', workflow: '工作流', pictureBook: '绘本' };
const emptyFilters = { publicationState: '', published: '', orgId: '', student: '', packageName: '', lesson: '', search: '' };

export function PlatformWorks({ api }) {
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const [kind, setKind] = useState('canvas');
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [sort, setSort] = useState('submitted');
  const [message, setMessage] = useState(null);
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  // 作品预览（用户口径：「平台能看到作品，但是也要能预览吧。现在只有个标题」）
  const [previewItem, setPreviewItem] = useState(null);
  const busy = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const reports = useData(() => historyOpen ? api.get('admin/work-reports') : Promise.resolve(null), [api, historyOpen]);
  const detail = useData(() => detailId ? api.get(`admin/works/${detailId}/detail`) : Promise.resolve(null), [api, detailId]);
  // 编辑（标题/描述）与彻底删除（2026-09-19 用户点名）。两者都带 kind：画布/导入件在 works 表，
  // VibeCoding 在 vibecoding_submissions 表，接口前缀不同但形状一样。
  const [edit, setEdit] = useState(null);
  const [purge, setPurge] = useState(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapDraft, setMapDraft] = useState(null);
  const plazaMap = useData(() => mapOpen ? api.get('admin/plaza-category-map') : Promise.resolve(null), [api, mapOpen]);
  // 拿到接口就铺进草稿一次；之后以草稿为准（别让刷新把管理员正在改的选择冲掉）
  useEffect(() => { if (mapOpen && plazaMap.data && !mapDraft) setMapDraft({ ...plazaMap.data.map }); }, [mapOpen, plazaMap.data, mapDraft]);
  const query = useMemo(() => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort);
    return params.toString();
  }, [filters, page, limit, sort]);
  const endpoint = kind === 'canvas' ? 'admin/works' : 'admin/vibecoding-works';
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState({ key: '', loading: true, data: null, error: null });
  const requestKey = `${endpoint}?${query}`;
  // Switching modes or rapidly editing filters must not show an older request's rows.
  useEffect(() => {
    let active = true;
    setResult({ key: requestKey, loading: true, data: null, error: null });
    api.get(requestKey).then((data) => { if (active) setResult({ key: requestKey, loading: false, data, error: null }); }, (error) => { if (active) setResult({ key: requestKey, loading: false, data: null, error }); });
    return () => { active = false; };
  }, [api, requestKey, revision]);
  const refresh = () => setRevision((value) => value + 1);
  const loading = result.loading || result.key !== requestKey;
  function filter(key, value) { setFilters((old) => ({ ...old, [key]: value })); setPage(1); }
  function changeKind(next) { setKind(next); setPage(1); setAction(null); setDetailId(null); setMessage(null); setEdit(null); setPurge(null); }
  function confirmPublication(item) { setAction({ item, kind, published: item.publicationState !== 'PUBLISHED' }); setReason(''); setMessage(null); }
  async function publish() {
    if (!action || busy.current || (!action.published && !reason.trim())) return;
    busy.current = true; setSaving(true); setMessage(null);
    try {
      const base = action.kind === 'canvas' ? 'admin/works' : 'admin/vibecoding-works';
      const path = action.kind === 'canvas' && !action.published ? 'unpublish' : 'plaza';
      await api.put(`${base}/${action.item.id}/${path}`, { published: action.published, reason: reason.trim() });
      setMessage({ tone: 'success', text: `已${action.published ? '发布到官网' : '下架'}《${action.item.title}》。` });
      setAction(null); setReason(''); refresh();
      if (detailId) detail.refresh();
    } catch (error) { setMessage({ tone: 'danger', text: error.message || '操作失败，请重试。' }); }
    finally { busy.current = false; setSaving(false); }
  }
  async function toggleFeature(item) {
    if (busy.current || !window.confirm(`确认${item.featured ? '取消' : '设置'}《${item.title}》的精选推荐？`)) return;
    busy.current = true; setSaving(true); setMessage(null);
    try {
      await api.put(`admin/works/${item.id}/feature`, { featured: !item.featured, reason: item.featured ? '' : '平台精选推荐' });
      setMessage({ tone: 'success', text: `已${item.featured ? '取消' : '设置'}精选。` }); refresh();
    } catch (error) { setMessage({ tone: 'danger', text: error.message || '精选操作失败，请重试。' }); }
    finally { busy.current = false; setSaving(false); }
  }
  // 编辑只改**展示文案**（标题 + 描述）：发布状态、授权、精选各有专门动作与审计，不从这条走。
  function openEdit(item, kind) { setEdit({ item, kind, title: item.title || '', description: item.description || '' }); setPurge(null); setAction(null); setMessage(null); }
  async function saveEdit() {
    if (!edit || busy.current || !edit.title.trim()) return;
    busy.current = true; setSaving(true); setMessage(null);
    try {
      const base = edit.kind === 'canvas' ? 'admin/works' : 'admin/vibecoding-works';
      await api.put(`${base}/${edit.item.id}`, { title: edit.title.trim(), description: edit.description.trim() });
      setMessage({ tone: 'success', text: `已保存《${edit.title.trim()}》的标题与描述。` });
      setEdit(null); refresh();
      if (detailId) detail.refresh();
    } catch (error) { setMessage({ tone: 'danger', text: error.message || '保存失败，请重试。' }); }
    finally { busy.current = false; setSaving(false); }
  }
  // 彻底删除：不可恢复，所以要求填原因（进审计日志）+ 显式确认按钮。
  // 「下架」那条软删才是默认路径（后台还看得到、能改回），不要把它和这条混在一起。
  function openPurge(item, kind) { setPurge({ item, kind, reason: '' }); setEdit(null); setAction(null); setMessage(null); }
  async function confirmPurge() {
    if (!purge || busy.current || !purge.reason.trim()) return;
    busy.current = true; setSaving(true); setMessage(null);
    try {
      const base = purge.kind === 'canvas' ? 'admin/works' : 'admin/vibecoding-works';
      const result = await api.delete(`${base}/${purge.item.id}`, { body: { confirm: true, reason: purge.reason.trim() } });
      const media = result?.media?.action === 'quarantined' ? `；媒体目录已挪到 ${result.media.trash}`
        : result?.media ? `；媒体目录未挪动（${result.media.note || result.media.action}）` : '';
      setMessage({ tone: 'success', text: `已彻底删除《${purge.item.title}》${media}。` });
      if (detailId === purge.item.id) setDetailId(null);
      setPurge(null); refresh();
    } catch (error) { setMessage({ tone: 'danger', text: error.message || '删除失败，请重试。' }); }
    finally { busy.current = false; setSaving(false); }
  }
  async function saveCategoryMap() {
    if (!mapDraft || busy.current) return;
    busy.current = true; setSaving(true); setMessage(null);
    try {
      await api.put('admin/plaza-category-map', { map: mapDraft });
      setMessage({ tone: 'success', text: '分类映射已保存 —— 广场即时生效，不用发版。' });
      plazaMap.refresh(); refresh();
    } catch (error) { setMessage({ tone: 'danger', text: error.message || '保存失败，请重试。' }); }
    finally { busy.current = false; setSaving(false); }
  }
  async function exportWorks() {
    setExporting(true); setMessage(null);
    try {
      const result = await api.get(`admin/works/export?${query}`);
      downloadCsv(result.filename, result.content);
      setMessage({ tone: 'success', text: `已导出 ${result.count} 件画布作品。` });
    } catch (error) { setMessage({ tone: 'danger', text: error.message || '导出失败，请重试。' }); }
    finally { setExporting(false); }
  }
  return <>
    <PageHeader eyebrow="作品发布" title="平台作品库" description="查看学生提交的作品，选择发布到官网学生作品广场。由平台管理发布，教师无需审核。" actions={<>{kind === 'canvas' && <button className="secondary-button" disabled={exporting} onClick={exportWorks}>{exporting ? '导出中…' : '导出画布 CSV'}</button>}<button className="secondary-button" onClick={refresh}>刷新</button></>} />
    <Panel title="作品筛选">
      <div className="row-actions" role="group" aria-label="作品类型">
        <button className={kind === 'canvas' ? 'primary-button' : 'secondary-button'} aria-pressed={kind === 'canvas'} disabled={saving} onClick={() => changeKind('canvas')}>画布作品</button>
        <button className={kind === 'vibecoding' ? 'primary-button' : 'secondary-button'} aria-pressed={kind === 'vibecoding'} disabled={saving} onClick={() => changeKind('vibecoding')}>VibeCoding 作品</button>
      </div>
      <div className="form-grid top-gap">
        <label>发布状态<select value={filters.publicationState} onChange={(e) => filter('publicationState', e.target.value)}><option value="">全部状态</option>{Object.entries(publicationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>发布到官网<select value={filters.published} onChange={(e) => filter('published', e.target.value)}><option value="">全部</option><option value="1">已发布到官网</option><option value="0">未发布到官网</option></select></label>
        <label>机构<select value={filters.orgId} onChange={(e) => filter('orgId', e.target.value)}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>学生姓名 / 账号<input value={filters.student} onChange={(e) => filter('student', e.target.value)} placeholder="输入姓名或登录账号" /></label>
        <label>课包名称<input value={filters.packageName} onChange={(e) => filter('packageName', e.target.value)} placeholder="按课包名称筛选" /></label>
        <label>课时名称<input value={filters.lesson} onChange={(e) => filter('lesson', e.target.value)} placeholder="按课时名称筛选" /></label>
        <label>关键词<input value={filters.search} onChange={(e) => filter('search', e.target.value)} placeholder="作品 / 学生 / 机构" /></label>
        <label>排序<select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="submitted">最近提交</option><option value="title">作品名称</option></select></label>
        <label>每页条数<select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label>
      </div>
      <button className="text-button" onClick={() => { setFilters(emptyFilters); setPage(1); }}>清空筛选</button>
      {organizations.error && <ErrorState error={organizations.error} onRetry={organizations.refresh} />}
    </Panel>
    {message && <div role={message.tone === 'danger' ? 'alert' : 'status'}><Notice tone={message.tone}>{message.text}</Notice></div>}
    {action && <Panel title={`${action.published ? '发布到官网' : '下架'}《${action.item.title}》`}>
      <p>{action.published ? '确认后，所有官网访客都可以查看此作品。' : '确认后，作品将不再展示在官网；下架原因会告知学生。'}</p>
      {!action.published && <label>下架原因<textarea value={reason} required maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="请填写学生可见的下架原因" /></label>}
      <div className="row-actions top-gap"><button className="primary-button" disabled={saving || (!action.published && !reason.trim())} onClick={publish}>{saving ? '处理中…' : action.published ? '确认发布' : '确认下架'}</button><button className="secondary-button" disabled={saving} onClick={() => setAction(null)}>取消</button></div>
    </Panel>}
    {edit && <Panel title={`编辑《${edit.item.title}》`} actions={<button className="secondary-button" disabled={saving} onClick={() => setEdit(null)}>取消</button>}>
      <p>这里只改<strong>展示文案</strong>（标题与描述）。发布状态、展示授权、精选各有自己的操作，不会因为改标题而跟着变。</p>
      <div className="form-grid top-gap"><label>作品标题<input value={edit.title} maxLength={200} required onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="学生在作品广场看到的标题" /></label></div>
      <label className="top-gap">作品描述<textarea value={edit.description} maxLength={2000} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="可留空" /></label>
      <div className="row-actions top-gap"><button className="primary-button" disabled={saving || !edit.title.trim()} onClick={saveEdit}>{saving ? '保存中…' : '保存'}</button></div>
    </Panel>}
    {purge && <Panel title={`彻底删除《${purge.item.title}》`} actions={<button className="secondary-button" disabled={saving} onClick={() => setPurge(null)}>取消</button>}>
      <p><strong>这一步不可恢复。</strong>只删这条作品记录（学生的项目还在，可以重新提交）；导入件的媒体目录会被<strong>挪进 <code>_trash/</code></strong>（挪走而不是删掉，但广场上不再有这件作品）。如果只是想让它从广场消失、之后还可能恢复，请用「下架」。</p>
      <label>删除原因（进审计日志，学生看不到）<textarea value={purge.reason} required maxLength={200} onChange={(e) => setPurge({ ...purge, reason: e.target.value })} placeholder="例如：重复导入 / 内容不合适 / 误传" /></label>
      <div className="row-actions top-gap"><button className="primary-button" disabled={saving || !purge.reason.trim()} onClick={confirmPurge}>{saving ? '删除中…' : '确认彻底删除'}</button></div>
    </Panel>}
    <Panel title={`${kind === 'canvas' ? '画布' : 'VibeCoding'}作品`}>
      {loading ? <Loading /> : result.error ? <ErrorState error={result.error} onRetry={refresh} /> : result.data?.items?.length ? <>
        <ListResultSummary total={result.data.total} page={result.data.page} totalPages={result.data.totalPages} label="件作品" />
        <div className="table-wrap"><table><thead><tr><th>作品</th><th>学生账号 / 机构</th><th>课包 / 课时 / 课堂</th><th>发布状态</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{result.data.items.map((item) => <tr key={`${kind}-${item.id}`}>
          <td>{kind === 'canvas' ? <button className="text-button" onClick={() => setDetailId(item.id)}><strong>{item.title}</strong></button> : <strong>{item.title}</strong>}<div className="muted">{item.description || '暂无描述'}</div></td>
          <td><strong>{item.studentName || item.studentId}</strong><div>{item.studentLogin || '账号未记录'}</div><div className="muted">{item.organizationName || '未绑定机构'}</div></td>
          <td><strong>{item.packageName || '课包未记录'}</strong><div>{item.courseLessonTitle || item.lessonTitle || '课时未记录'}</div><div className="muted">{item.sessionTitle || '课堂未记录'}</div></td>
          <td><span className={`status ${item.publicationState === 'PUBLISHED' ? 'success' : ''}`}>{publicationLabels[item.publicationState] || '已提交待发布'}</span>{item.featured && <span className="status success">精选</span>}{item.publicationState === 'UNPUBLISHED' && item.unpublishReason && <div className="muted">下架原因：{item.unpublishReason}</div>}<div className="muted">{item.copyrightConfirmedAt ? '已确认展示授权' : '未确认展示授权'}</div></td>
          <td>{formatDate(item.submittedAt)}</td>
          <td><div className="row-actions"><button className="text-button" disabled={saving || (item.publicationState !== 'PUBLISHED' && (!item.copyrightConfirmedAt || (kind === 'canvas' && item.status === 'REJECTED')))} onClick={() => confirmPublication(item)}>{item.publicationState === 'PUBLISHED' ? '下架' : '发布到官网'}</button>{item.publicationState === 'PUBLISHED' && item.shareToken && <a className="text-button" href={`/works/${item.shareToken}`} target="_blank" rel="noreferrer">查看官网作品</a>}{kind === 'canvas' && item.publicationState === 'PUBLISHED' && <button className="text-button" disabled={saving} onClick={() => toggleFeature(item)}>{item.featured ? '取消精选' : '设为精选'}</button>}{kind === 'vibecoding' && <button className="text-button" disabled={saving} onClick={() => setPreviewItem(item)}>预览</button>}<button className="text-button" disabled={saving} onClick={() => openEdit(item, kind)}>编辑</button><button className="text-button" disabled={saving} onClick={() => openPurge(item, kind)}>彻底删除</button></div>{kind === 'canvas' && item.status === 'REJECTED' && <span className="muted">历史退回作品，需学生重新提交</span>}</td>
        </tr>)}</tbody></table></div>
        <Pagination page={result.data.page} totalPages={result.data.totalPages} onChange={setPage} disabled={loading} />
      </> : <Empty title="没有符合条件的作品" body="可调整筛选条件，或切换作品类型。" />}
    </Panel>
    {detailId && <Panel title={`画布作品详情 · ${detail.data?.title || ''}`} actions={<button className="secondary-button" onClick={() => setDetailId(null)}>关闭</button>}>
      {detail.loading ? <Loading /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : detail.data && <>
        <p>{detail.data.description || '暂无描述'}</p><p>学生：{detail.data.studentName}（{detail.data.studentLogin}） · {detail.data.organizationName || '未绑定机构'}</p>
        <p>课时：{detail.data.courseLessonTitle || '未记录'}</p>
        <details><summary>画布快照（只读）</summary><pre style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(detail.data.canvasSnapshot, null, 2)}</pre></details>
        <details><summary>提交历史（只读） · {detail.data.submissions?.length || 0}</summary>{detail.data.submissions?.map((item) => <p key={item.id}>第 {item.round} 次 · {item.title} · {formatDate(item.submittedAt)}</p>)}</details>
      </>}
    </Panel>}
    {/* 作品预览（VibeCoding 产物）：网页在不带 allow-same-origin 的沙箱里真跑，文档给服务端转的 PDF */}
    {previewItem ? <WorkPreview api={api} workId={previewItem.id} title={previewItem.title} onClose={() => setPreviewItem(null)} /> : null}
    <details onToggle={(event) => setMapOpen(event.currentTarget.open)}><summary>作品广场分类映射（改完即时生效，不用发版）</summary>
      {mapOpen && <Panel title="类型 → 分类">
        {plazaMap.loading ? <Loading /> : plazaMap.error ? <ErrorState error={plazaMap.error} onRetry={plazaMap.refresh} /> : plazaMap.data && mapDraft ? <>
          <p>这里决定每种作品类型落进哪个分类。广场的每个作品都会带上算好的分类，前端不自己判类型 —— 所以这里一改，刷新广场就变了。</p>
          <div className="form-grid">{plazaMap.data.types.map((type) => <label key={type}>{typeLabels[type] || type}<select value={mapDraft[type] || plazaMap.data.defaults[type] || 'CANVAS'} disabled={saving} onChange={(e) => setMapDraft({ ...mapDraft, [type]: e.target.value })}>{plazaMap.data.categories.map((value) => <option key={value} value={value}>{plazaMap.data.labels[value]}</option>)}</select></label>)}</div>
          <div className="row-actions top-gap"><button className="primary-button" disabled={saving} onClick={saveCategoryMap}>{saving ? '保存中…' : '保存映射'}</button><button className="secondary-button" disabled={saving} onClick={() => setMapDraft({ ...plazaMap.data.map })}>还原为当前生效值</button></div>
        </> : null}
      </Panel>}
    </details>
    <details onToggle={(event) => setHistoryOpen(event.currentTarget.open)}><summary>历史举报记录（只读，治理暂缓）</summary>
      {historyOpen && <Panel title="历史举报记录">{reports.loading ? <Loading /> : reports.error ? <ErrorState error={reports.error} onRetry={reports.refresh} /> : reports.data?.items?.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>举报人</th><th>说明</th><th>历史状态</th><th>时间</th></tr></thead><tbody>{reports.data.items.map((item) => <tr key={item.id}><td>{item.workTitle}</td><td>{item.reporterName || '学生'}</td><td>{item.details || item.category}</td><td>{{ PENDING: '待处理（暂缓）', RESOLVED: '已处理', DISMISSED: '已驳回' }[item.status] || item.status}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div> : <Empty title="暂无历史举报记录" />}</Panel>}
    </details>
  </>;
}
