// 平台端「素材与宣传物料」（2026-09-20 重做）。
//
// 用户口径：「这个页面进入应该就是卡片展示，然后右上角有个添加按钮，然后一步步上传物料等等。
// 逻辑布局全部要重做一下，要更合理」。
//
// 重做前那张页面的问题（不是配色，是**信息架构**）：
//   · 一进页面先看到的是「安全上传」和一张 9 字段的长表单 —— 而这一页真正要管的是**已有的物料**；
//   · 三块面板（安全上传 / 新增 / 物料授权）与下方的表格各说各话，上传完的文件与新建的物料没有关系，
//     运营得自己在两个面板之间来回看；
//   · 表格里点「统计」才会在**另一个面板**里出结果，视线要来回跳。
//
// 现在的形状：
//   右上角「+ 添加物料」→ **三步向导**（① 上传文件（可选）② 填写信息与授权 ③ 确认保存），
//   主体是**物料卡片网格**（封面/分类/范围/资源是否就绪/使用次数），统计与启停在卡片上就地打开。
//
// 口径没变（别在这页里改）：物料与文件**分别登记** —— 上传只产出文件资产，物料的 `resourceUrl`
// 仍是外部存储地址（留空就是"资源待配置"）；「全部机构」对所有状态正常的机构开放，
// 「指定机构」只在服务端向授权机构返回。
import { useMemo, useState } from 'react';
import { Empty, ErrorState, formatDate, Loading, ListResultSummary, MetricCard, Notice, PageHeader, Panel, Pagination, Status, useData } from '@platform/shared';

export const MATERIAL_CATEGORIES = [['GENERAL', '通用'], ['COURSE', '课程'], ['POSTER', '海报'], ['ACTIVITY', '活动'], ['PARTNERSHIP', '合作']];
const CATEGORY_LABELS = Object.fromEntries(MATERIAL_CATEGORIES);
/** 分类 → 色相：卡片没封面时用它画一块底，一排物料不至于一个样。 */
const CATEGORY_HUE = { GENERAL: 262, COURSE: 212, POSTER: 322, ACTIVITY: 28, PARTNERSHIP: 168 };
const CATEGORY_GLYPH = { GENERAL: '◆', COURSE: '▤', POSTER: '▣', ACTIVITY: '✦', PARTNERSHIP: '⬡' };
const EMPTY_FORM = { title: '', description: '', category: 'GENERAL', visibility: 'ALL_ORGS', orgIds: [], mimeType: '', resourceUrl: '', coverUrl: '' };

/** 裸文件上传面板（保留导出：这一页之外还有调用方）。 */
export function FileUploadPanel({ api, onDone }) {
  const [file, setFile] = useState(null); const [progress, setProgress] = useState(0); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event) { event.preventDefault(); if (!file) return setMessage('请选择文件'); setBusy(true); setProgress(10); setMessage(''); try { await api.upload('admin/file-assets/upload', file, { category: 'MEDIA_ASSET', visibility: 'PUBLIC_PLATFORM' }, { onProgress: setProgress }); setMessage('文件上传成功'); setFile(null); onDone?.(); } catch (error) { setMessage(error.message); } finally { setBusy(false); } }
  return <Panel title="安全上传"><form onSubmit={submit} className="form-grid"><label>选择图片、音频、视频或 PDF<input type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} disabled={busy} /></label><div className="row-actions"><button className="primary-button" disabled={busy || !file}>{busy ? `上传中 ${progress}%` : '上传文件'}</button>{message ? <span className="muted">{message}</span> : null}</div></form></Panel>;
}

function MaterialCard({ item, onStats, onToggle, busy }) {
  const hue = CATEGORY_HUE[item.category] ?? CATEGORY_HUE.GENERAL;
  const cover = item.coverUrl || '';
  return <article className="material-card">
    <div className="material-card__cover" style={cover ? { backgroundImage: `url(${cover})` } : { background: `linear-gradient(140deg,hsl(${hue} 55% 58%),hsl(${(hue + 24) % 360} 70% 76%))` }}>
      {cover ? null : <span className="material-card__glyph" aria-hidden="true">{CATEGORY_GLYPH[item.category] || CATEGORY_GLYPH.GENERAL}</span>}
      <span className="material-card__cat">{CATEGORY_LABELS[item.category] || item.category}</span>
      {item.status === 'ACTIVE' ? null : <span className="material-card__off">已停用</span>}
    </div>
    <div className="material-card__body">
      <h3>{item.title}</h3>
      <p className="muted">{item.description || '暂无说明'}</p>
      <div className="material-card__meta">
        <span>{item.visibility === 'ALL_ORGS' ? '全部机构' : `指定 ${item.assignedOrgCount} 家`}</span>
        <span className={item.resourceConfigured ? 'status success' : 'muted'}>{item.resourceConfigured ? '资源已配置' : '资源待配置'}</span>
        <span>使用 {item.eventCount} 次</span>
      </div>
    </div>
    <div className="material-card__foot">
      <button className="text-button" onClick={() => onStats(item)}>使用统计</button>
      <button className="text-button" disabled={busy} onClick={() => onToggle(item)}>{item.status === 'ACTIVE' ? '停用' : '启用'}</button>
    </div>
  </article>;
}

/** 三步添加向导：① 上传文件（可选）② 填写信息与授权 ③ 确认保存。 */
function AddMaterialWizard({ api, organizations, onClose, onDone }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(EMPTY_FORM);
  const [upload, setUpload] = useState({ file: null, progress: 0, busy: false, asset: null, message: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const patch = (values) => setForm((current) => ({ ...current, ...values }));

  async function doUpload() {
    if (!upload.file) return;
    setUpload((current) => ({ ...current, busy: true, progress: 10, message: '' }));
    try {
      const asset = await api.upload('admin/file-assets/upload', upload.file, { category: 'MEDIA_ASSET', visibility: 'PUBLIC_PLATFORM' }, { onProgress: (value) => setUpload((current) => ({ ...current, progress: value })) });
      setUpload({ file: null, progress: 0, busy: false, asset, message: '文件已上传（下面可以把它的公开地址当封面）' });
      // 上传拿到的是**文件资产**（不是物料的资源地址）—— 两者仍分别登记（口径没变）；
      // 但平台的公开文件资产可以直接当封面用，这里顺手把 MIME 也带过去，省一次手填。
      if (asset?.mimeType && !form.mimeType) patch({ mimeType: asset.mimeType });
    } catch (err) {
      setUpload((current) => ({ ...current, busy: false, message: err.message || '上传失败' }));
    }
  }
  const coverFromAsset = upload.asset ? `/api/public/file-assets/${encodeURIComponent(upload.asset.id)}/download` : '';

  async function save() {
    if (!form.title.trim()) { setError('请填写物料名称'); setStep(1); return; }
    setSaving(true); setError('');
    try {
      await api.post('admin/materials', { ...form, title: form.title.trim(), orgIds: form.visibility === 'ALL_ORGS' ? [] : form.orgIds });
      onDone?.();
    } catch (err) { setError(err.message || '保存失败'); } finally { setSaving(false); }
  }

  const steps = ['上传文件', '填写信息', '确认保存'];
  return <div className="modal-overlay" onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div className="modal-content" role="dialog" aria-label="添加物料">
      <header className="modal-header">
        <div><h3>添加宣传物料</h3><p className="muted">分三步：先传文件（可跳过），再填信息与授权范围。</p></div>
        <button className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
      </header>
      <div className="material-steps">
        {steps.map((label, index) => <div key={label} className={`material-step${index === step ? ' is-current' : ''}${index < step ? ' is-done' : ''}`}>
          <span className="material-step__no">{index + 1}</span><span>{label}</span>
        </div>)}
      </div>
      <div className="modal-body">
        {step === 0 ? <>
          <p className="muted">这一步只为<strong>上传文件</strong>（图片 / 音频 / 视频 / PDF），可以跳过直接下一步 —— 物料的资源地址是另一件事。</p>
          <label>选择文件<input type="file" disabled={upload.busy} onChange={(event) => setUpload((current) => ({ ...current, file: event.target.files?.[0] || null, message: '' }))} /></label>
          <div className="row-actions">
            <button className="secondary-button" disabled={upload.busy || !upload.file} onClick={doUpload}>{upload.busy ? `上传中 ${upload.progress}%` : '上传文件'}</button>
            {upload.message ? <span className="muted">{upload.message}</span> : null}
          </div>
          {upload.asset ? <Notice tone="info">已上传：{upload.asset.fileName || upload.asset.id}
            {coverFromAsset ? <div className="row-actions"><button className="text-button" onClick={() => patch({ coverUrl: coverFromAsset })}>把它的公开地址用作封面</button></div> : null}
          </Notice> : null}
        </> : null}
        {step === 1 ? <>
          <label>物料名称 *<input value={form.title} maxLength={200} onChange={(event) => patch({ title: event.target.value })} /></label>
          <label>说明<textarea value={form.description} onChange={(event) => patch({ description: event.target.value })} /></label>
          <div className="form-grid">
            <label>分类<select value={form.category} onChange={(event) => patch({ category: event.target.value })}>{MATERIAL_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>可见范围<select value={form.visibility} onChange={(event) => patch({ visibility: event.target.value, orgIds: [] })}><option value="ALL_ORGS">全部机构</option><option value="ASSIGNED_ORGS">指定机构</option></select></label>
          </div>
          {form.visibility === 'ASSIGNED_ORGS' ? <label>指定机构（可多选）<select multiple value={form.orgIds} onChange={(event) => patch({ orgIds: [...event.target.selectedOptions].map((option) => option.value) })}>{(organizations?.items || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
          <div className="form-grid">
            <label>MIME 类型（可选）<input value={form.mimeType} placeholder="application/pdf" onChange={(event) => patch({ mimeType: event.target.value })} /></label>
            <label>真实资源地址（可选）<input value={form.resourceUrl} placeholder="留空则显示「资源待配置」" onChange={(event) => patch({ resourceUrl: event.target.value })} /></label>
          </div>
          <label>封面地址（可选）<input value={form.coverUrl} onChange={(event) => patch({ coverUrl: event.target.value })} /></label>
        </> : null}
        {step === 2 ? <>
          <p className="muted">确认后立即生效：{form.visibility === 'ALL_ORGS' ? '所有状态正常的机构都能看到' : `只对选中的 ${form.orgIds.length} 家机构返回`}。</p>
          <dl className="material-summary">
            <div><dt>名称</dt><dd>{form.title || '（未填写）'}</dd></div>
            <div><dt>分类</dt><dd>{CATEGORY_LABELS[form.category] || form.category}</dd></div>
            <div><dt>可见范围</dt><dd>{form.visibility === 'ALL_ORGS' ? '全部机构' : `指定 ${form.orgIds.length} 家`}</dd></div>
            <div><dt>资源</dt><dd>{form.resourceUrl ? '已填写资源地址' : '未填 —— 卡片会显示「资源待配置」'}</dd></div>
            <div><dt>封面</dt><dd>{form.coverUrl ? '已填写' : '未填 —— 用分类底色'}</dd></div>
          </dl>
        </> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <footer className="modal-footer">
        {step > 0 ? <button className="secondary-button" disabled={saving} onClick={() => setStep(step - 1)}>上一步</button> : null}
        {step < 2 ? <button className="primary-button" disabled={upload.busy} onClick={() => { setError(''); setStep(step + 1); }}>下一步</button>
          : <button className="primary-button" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存物料'}</button>}
      </footer>
    </div>
  </div>;
}

export function AdminMaterials({ api }) {
  const [filters, setFilters] = useState({ search: '', status: '', category: '', visibility: '' });
  const [page, setPage] = useState(1); const [limit, setLimit] = useState(20); const [sort, setSort] = useState('created');
  const [adding, setAdding] = useState(false);
  const [statsFor, setStatsFor] = useState(null);
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const query = useMemo(() => { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)); params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort); return params; }, [filters, page, limit, sort]);
  const materials = useData(() => api.get(`admin/materials?${query.toString()}`), [api, query]);
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const stats = useData(() => statsFor ? api.get(`admin/materials/${encodeURIComponent(statsFor.id)}/stats`) : Promise.resolve(null), [api, statsFor]);
  const items = materials.data?.items || [];

  async function toggle(item) {
    setBusy(true); setMessage('');
    try { await api.put(`admin/materials/${encodeURIComponent(item.id)}`, { status: item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }); setMessage(item.status === 'ACTIVE' ? `《${item.title}》已停用。` : `《${item.title}》已启用。`); materials.refresh(); }
    catch (err) { setMessage(err.message || '操作失败'); } finally { setBusy(false); }
  }
  const filterChange = (values) => { setFilters({ ...filters, ...values }); setPage(1); };

  return <>
    <PageHeader eyebrow="平台内容" title="素材与宣传物料" description="招生海报、课程介绍与活动资料：授权范围与真实使用统计。"
      actions={<><button className="primary-button" onClick={() => setAdding(true)}>+ 添加物料</button><button className="secondary-button" onClick={materials.refresh}>刷新</button></>} />
    {message ? <Notice tone={message.includes('失败') ? 'danger' : 'success'}>{message}</Notice> : null}
    <div className="filters">
      <input value={filters.search} placeholder="搜索物料名称或说明" onChange={(event) => filterChange({ search: event.target.value })} />
      <select value={filters.status} onChange={(event) => filterChange({ status: event.target.value })}><option value="">全部状态</option><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select>
      <select value={filters.category} onChange={(event) => filterChange({ category: event.target.value })}><option value="">全部分类</option>{MATERIAL_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select value={filters.visibility} onChange={(event) => filterChange({ visibility: event.target.value })}><option value="">全部范围</option><option value="ALL_ORGS">全部机构</option><option value="ASSIGNED_ORGS">指定机构</option></select>
      <select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="created">按创建时间</option><option value="updated">按更新时间</option><option value="title">按标题</option><option value="events">按使用次数</option></select>
      <select value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setPage(1); }}><option value="10">10 条/页</option><option value="20">20 条/页</option><option value="50">50 条/页</option></select>
    </div>

    {materials.loading ? <Loading label="正在读取物料…" /> : materials.error ? <ErrorState error={materials.error} onRetry={materials.refresh} />
      : items.length ? <>
        <div className="material-grid">{items.map((item) => <MaterialCard key={item.id} item={item} busy={busy} onStats={setStatsFor} onToggle={toggle} />)}</div>
        <ListResultSummary total={materials.data.total} page={materials.data.page} totalPages={materials.data.totalPages} label="个物料" />
        <Pagination page={materials.data.page} totalPages={materials.data.totalPages} onChange={setPage} disabled={materials.loading} />
      </> : <Empty title="还没有宣传物料" body="点右上角「添加物料」：先传文件（可跳过），再填名称与授权范围。" />}

    {adding ? <AddMaterialWizard api={api} organizations={organizations.data} onClose={() => setAdding(false)}
      onDone={() => { setAdding(false); setMessage('物料已添加。'); materials.refresh(); }} /> : null}

    {statsFor ? <div className="modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) setStatsFor(null); }}>
      <div className="modal-content modal-large" role="dialog" aria-label="物料使用统计">
        <header className="modal-header">
          <div><h3>{statsFor.title} · 使用统计</h3><p className="muted">{CATEGORY_LABELS[statsFor.category] || statsFor.category} · {statsFor.visibility === 'ALL_ORGS' ? '全部机构' : `指定 ${statsFor.assignedOrgCount} 家`}</p></div>
          <button className="secondary-button" onClick={() => setStatsFor(null)}>关闭</button>
        </header>
        <div className="modal-body">
          {stats.loading ? <Loading label="正在读取统计…" /> : stats.error ? <ErrorState error={stats.error} onRetry={stats.refresh} /> : stats.data ? <>
            <div className="metrics">
              <MetricCard label="事件总数" value={stats.data.summary.totalEvents} hint={`${stats.data.summary.organizationCount} 家机构`} />
              <MetricCard label="查看" value={stats.data.summary.viewCount} hint="VIEW" tone="teal" />
              <MetricCard label="使用" value={stats.data.summary.useCount} hint="USE" tone="orange" />
              <MetricCard label="下载" value={stats.data.summary.downloadCount} hint="DOWNLOAD" tone="pink" />
            </div>
            {stats.data.organizations.length ? <div className="table-wrap"><table><thead><tr><th>机构</th><th>查看</th><th>使用</th><th>下载</th><th>最近事件</th></tr></thead><tbody>{stats.data.organizations.map((row) => <tr key={row.orgId}><td>{row.organizationName}</td><td>{row.viewCount}</td><td>{row.useCount}</td><td>{row.downloadCount}</td><td>{formatDate(row.lastEventAt)}</td></tr>)}</tbody></table></div>
              : <Empty title="暂无使用事件" body="机构在客户端打开过这个物料后，这里会有记录。" />}
          </> : null}
        </div>
      </div>
    </div> : null}
  </>;
}
