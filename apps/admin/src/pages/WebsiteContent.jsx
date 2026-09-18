import { useAdminConfirm } from '../components/AdminConfirm.jsx';
import { readSession } from '@platform/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function parseWebsiteDraft(value) {
  try { const result = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result : null; } catch { return null; }
}

export function WebsitePreview({ content, selectedKey }) {
  if (!content) return <div className="cms-preview-empty">保存或修正 JSON 后可预览。</div>;
  if (selectedKey === 'HOME') return <div className="cms-preview-home"><span className="cms-preview-kicker">{content.heroKicker || '首页眉题'}</span><h3>{content.heroTitle || '首页标题'} <em>{content.heroAccent || '强调标题'}</em></h3><p>{content.heroDescription || '首页描述'}</p><div className="cms-preview-trust"><strong>{content.trustTitle || '信任区标题'}</strong><span>{content.trustDescription || '信任区描述'}</span></div>{content.coverImageUrl ? <img src={content.coverImageUrl} alt="首页封面预览" /> : null}</div>;
  if (selectedKey === 'FAQ') return <div className="cms-preview-faq"><h3>{content.title || '常见问题'}</h3>{(Array.isArray(content.items) ? content.items : []).map((item, index) => <details key={`${item.question || 'faq'}-${index}`}><summary>{item.question || `问题 ${index + 1}`}</summary><p>{item.answer || '答案待填写'}</p></details>)}</div>;
  if (selectedKey === 'BRAND') return <div className="cms-preview-brand"><strong>{content.name || '品牌名称'}</strong><span>{content.tagline || '品牌标语'}</span><small>{content.contactEmail || '联系邮箱'}</small></div>;
  if (selectedKey === 'MARKETPLACE') return <div className="cms-preview-faq"><h3>{content.title || '灵动Ai学院课包展示'}</h3>{content.lead ? <p>{content.lead}</p> : null}</div>;
  // 灵动介绍 / 机构手册：正文是「分节」结构，预览按可折叠列表展示，配图一起预览
  if (selectedKey === 'INTRO' || selectedKey === 'HANDBOOK') return <div className="cms-preview-faq"><h3>{content.title || (selectedKey === 'INTRO' ? '灵动介绍' : '机构手册')}</h3>{content.lead ? <p>{content.lead}</p> : null}{(Array.isArray(content.sections) ? content.sections : []).map((item, index) => <details key={`preview-section-${index}`}><summary>{item.title || `第 ${index + 1} 节`}</summary>{item.body ? <p>{item.body}</p> : null}{(Array.isArray(item.bullets) ? item.bullets.filter(Boolean) : []).length ? <ul>{item.bullets.filter(Boolean).map((bullet, bulletIndex) => <li key={bulletIndex}>{bullet}</li>)}</ul> : null}{item.imageUrl ? <img src={item.imageUrl} alt={item.imageAlt || ''} style={{ display: 'block', maxWidth: '100%', marginTop: '8px', borderRadius: '8px' }} /> : null}</details>)}{Array.isArray(content.compareRows) && content.compareRows.length ? <p>对比表 {content.compareRows.length} 行（{content.compareRows.map((row) => row.label).filter(Boolean).join(' / ')}）</p> : null}</div>;
  return <pre className="cms-preview-json">{JSON.stringify(content, null, 2)}</pre>;
}

const cmsListOf = (value) => (Array.isArray(value) ? value : []);
/**
 * 「分节」编辑器（灵动介绍 / 机构手册共用）。
 * 两份内容的正文形状一样：{ title, body, bullets[], imageUrl, imageAlt }，所以只用一套表单。
 * 配图两个来源都支持：直接贴已有资源地址，或点「上传配图」走平台的文件资产接口
 * （上传后拿到的是 /api/public/file-assets/<id>/download 这种公开可读地址）。
 * ⚠️ 要点用「一行一条」的 textarea，**不要**在 onChange 里过滤空行：那样用户按回车想开新行时
 * 空行会被立刻吃掉，永远敲不出第二行。空行由官网渲染侧过滤（main.jsx 的 cmsList）。
 */
function CmsSectionsFields({ structured, onList, onMove, onAdd, onRemove, uploading, onUpload }) {
  const sections = cmsListOf(structured?.sections);
  return <>
    <div className="cms-section-heading top-gap"><strong>正文分节（标题 + 正文 + 要点 + 配图）</strong><span>留空的字段官网不显示，条目多少都不会变形</span></div>
    <div className="cms-faq-list">{sections.map((item, index) => <div className="cms-faq-item" key={`section-${index}`}>
      <div className="cms-faq-heading"><strong>第 {index + 1} 节</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={`第 ${index + 1} 节上移`}>↑</button><button type="button" className="text-button" disabled={index === sections.length - 1} onClick={() => onMove(index, 1)} aria-label={`第 ${index + 1} 节下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => onRemove(index)}>删除</button></div></div>
      <label>标题<input value={item.title || ''} onChange={(event) => onList(index, { title: event.target.value })} maxLength={120} /></label>
      <label>正文<textarea value={item.body || ''} onChange={(event) => onList(index, { body: event.target.value })} maxLength={2000} /></label>
      <label>要点（一行一条）<textarea value={cmsListOf(item.bullets).join('\n')} onChange={(event) => onList(index, { bullets: event.target.value.split('\n') })} maxLength={2000} /></label>
      <div className="form-grid"><label>配图地址<input value={item.imageUrl || ''} onChange={(event) => onList(index, { imageUrl: event.target.value })} placeholder="留空则不显示图片" /></label><label>图片说明（无障碍用）<input value={item.imageAlt || ''} onChange={(event) => onList(index, { imageAlt: event.target.value })} maxLength={120} /></label></div>
      <div className="row-actions top-gap"><label className="inline-file-upload">{uploading === `section-${index}` ? '上传中…' : '上传配图'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onUpload(file, index); }} /></label></div>
      {item.imageUrl ? <img src={item.imageUrl} alt="" style={{ display: 'block', maxWidth: '260px', marginTop: '10px', border: '1px solid #ece8f2', borderRadius: '10px' }} /> : null}
    </div>)}</div>
    <button type="button" className="secondary-button top-gap" onClick={() => onAdd({ title: '', body: '', bullets: [], imageUrl: '', imageAlt: '' })}>新增一节</button>
  </>;
}

export function WebsiteContent({ api }) {
  const [confirm, confirmation] = useAdminConfirm();
  const navigate = useNavigate();
  const [savedDraft, setSavedDraft] = useState('');
  const [storageError, setStorageError] = useState('');
  const storageKey = (key) => `admin.cms.${readSession()?.user?.id || 'current'}.${key}`;
  function readRecovery(key) { try { return JSON.parse(sessionStorage.getItem(storageKey(key)) || 'null'); } catch { return null; } }
  function clearRecovery() { try { sessionStorage.removeItem(storageKey(selectedKey)); } catch { /* beforeunload still protects edits */ } }
  function keepDraft(text, preview) {
    setDraft(text);
    if (preview) setStructured(preview);
    try { sessionStorage.setItem(storageKey(selectedKey), JSON.stringify({ draft: text, preview: preview || structured })); setStorageError(''); }
    catch { setStorageError('浏览器无法暂存草稿，请在离开前保存或复制 JSON。'); }
  }
  const list = useData(() => api.get('admin/website-content'), [api]);
  const [selectedKey, setSelectedKey] = useState('');
  const [draft, setDraft] = useState('');
  const [structured, setStructured] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailState, setDetailState] = useState({ loading: false, data: null, error: null });
  const [revision, setRevision] = useState(0);
  // 图片上传中的标识（记「哪个字段在上传」），据此禁用按钮并显示进度
  const [uploading, setUploading] = useState('');
  const detail = { ...detailState, refresh: () => setRevision((value) => value + 1) };
  const dirty = draft !== savedDraft;
  const valid = Boolean(parseWebsiteDraft(draft));
  useEffect(() => {
    if (!selectedKey) return;
    let cancelled = false;
    setDetailState({ loading: true, data: null, error: null });
    api.get(`admin/website-content/${selectedKey}`).then((data) => {
      if (cancelled) return;
      const content = data.content || {};
      const original = JSON.stringify(content, null, 2);
      const recovery = readRecovery(selectedKey);
      setSavedDraft(original); setDraft(recovery?.draft ?? original);
      setStructured(parseWebsiteDraft(recovery?.draft) || recovery?.preview || content);
      setAdvancedOpen(Boolean(recovery));
      setDetailState({ loading: false, data, error: null });
    }).catch((error) => { if (!cancelled) setDetailState({ loading: false, data: null, error }); });
    return () => { cancelled = true; };
  }, [api, selectedKey, revision]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const intercept = (event) => {
      const link = event.target.closest?.('a[href]');
      if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || link.target === '_blank') return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      event.preventDefault(); event.stopPropagation();
      confirm({ title: '离开内容编辑', message: '当前改动尚未保存到服务器。草稿会保留在当前标签页，返回时恢复。是否继续离开？', confirmLabel: '保留并离开' }).then((accepted) => {
        if (accepted) navigate(url.pathname.replace(/^\/admin(?=\/|$)/, '') + url.search + url.hash);
      });
    };
    document.addEventListener('click', intercept, true);
    return () => document.removeEventListener('click', intercept, true);
  }, [dirty, navigate, confirm]);
  async function selectContent(key) {
    if (key === selectedKey || busy) return;
    if (dirty && !await confirm({ title: '切换内容区块', message: '当前改动尚未保存到服务器。草稿会暂存在当前浏览器标签页，返回时恢复；是否继续切换？', confirmLabel: '保留并切换' })) return;
    setSelectedKey(key); setMessage('');
  }
  async function reloadContent() {
    if (dirty && !await confirm({ title: '重新读取内容', message: '刷新将放弃当前未保存改动，读取服务器内容。', confirmLabel: '放弃并刷新' })) return;
    clearRecovery(); list.refresh(); detail.refresh();
  }
  useEffect(() => {
    const first = list.data?.items?.[0]?.key;
    if (!selectedKey && first) setSelectedKey(first);
  }, [list.data, selectedKey]);
  function updateStructured(patch) {
    if (!valid) return;
    const next = { ...(structured || {}), ...patch };
    keepDraft(JSON.stringify(next, null, 2), next);
  }
  function updateFaqItem(index, patch) {
    const items = Array.isArray(structured?.items) ? structured.items : [];
    updateStructured({ items: items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  }
  function moveFaqItem(index, direction) {
    const items = Array.isArray(structured?.items) ? [...structured.items] : [];
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
    updateStructured({ items });
  }
  function addFaqItem() { updateStructured({ items: [...(Array.isArray(structured?.items) ? structured.items : []), { question: '', answer: '' }] }); }
  function removeFaqItem(index) { updateStructured({ items: (structured?.items || []).filter((_, itemIndex) => itemIndex !== index) }); }
  function updateStat(index, patch) {
    const stats = Array.isArray(structured?.stats) ? structured.stats : [];
    updateStructured({ stats: stats.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  }
  function addStat() { updateStructured({ stats: [...(Array.isArray(structured?.stats) ? structured.stats : []), { value: '', label: '' }] }); }
  function removeStat(index) { updateStructured({ stats: (structured?.stats || []).filter((_, itemIndex) => itemIndex !== index) }); }
  function updateCourse(index, patch) {
    const list = Array.isArray(structured?.courses) ? structured.courses : [];
    updateStructured({ courses: list.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  }
  function moveCourse(index, direction) {
    const list = Array.isArray(structured?.courses) ? [...structured.courses] : [];
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= list.length) return;
    [list[index], list[nextIndex]] = [list[nextIndex], list[index]];
    updateStructured({ courses: list });
  }
  function addCourse() { updateStructured({ courses: [...(Array.isArray(structured?.courses) ? structured.courses : []), { icon: '✨', title: '', category: '', lessonCount: 8, ageRange: '8–16 岁', summary: '', lessons: [] }] }); }
  function removeCourse(index) { updateStructured({ courses: (structured?.courses || []).filter((_, itemIndex) => itemIndex !== index) }); }
  // ── 列表字段的通用增删改 ──────────────────────────────────────────────
  // 灵动介绍的 highlights / 机构手册的 compareRows / 首页的 stats 都是「数组里放对象」，
  // 一份代码管多种字段，免得每加一个区块就把同样的四个函数再抄一遍。
  function updateList(field, index, patch) {
    const items = cmsListOf(structured?.[field]);
    updateStructured({ [field]: items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  }
  function moveList(field, index, direction) {
    const items = [...cmsListOf(structured?.[field])];
    const next = index + direction;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    updateStructured({ [field]: items });
  }
  function addList(field, blank) { updateStructured({ [field]: [...cmsListOf(structured?.[field]), blank] }); }
  function removeList(field, index) { updateStructured({ [field]: cmsListOf(structured?.[field]).filter((_, itemIndex) => itemIndex !== index) }); }
  // 配图上传：走平台已有的文件资产接口（与课程封面上传同一条路），拿到公开可读地址后写回字段。
  async function uploadImage(file, apply, key) {
    setUploading(key); setMessage('');
    try {
      const asset = await api.upload('admin/file-assets/upload', file, { category: 'PROMO_COVER', visibility: 'PUBLIC_PLATFORM' });
      apply(`/api/public/file-assets/${asset.id}/download`);
    } catch (error) { setMessage('图片上传失败：' + (error.message || '未知错误')); }
    finally { setUploading(''); }
  }
  async function saveDraft() {
    setBusy(true); setMessage('');
    try {
      const content = parseWebsiteDraft(draft);
      if (!content || Array.isArray(content) || typeof content !== 'object') throw new Error('内容必须是 JSON 对象。');
      await api.put(`admin/website-content/${selectedKey}`, { content });
      clearRecovery(); setSavedDraft(draft); setMessage('草稿已保存。'); await detail.refresh(); await list.refresh();
    } catch (error) { setMessage(error instanceof SyntaxError ? 'JSON 格式无效。' : error.message); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!valid || dirty || busy) return;
    await confirm({ title: '发布官网内容', message: `确认发布「${WEBSITE_CONTENT_LABELS[selectedKey] || selectedKey}」草稿 v${detail.data?.draftVersion}？官网将立即读取此版本。`, confirmLabel: '确认发布', execute: async () => {
      setBusy(true); setMessage('');
      try { await api.post(`admin/website-content/${selectedKey}/publish`, { reason: '官网内容管理台发布' }); setMessage('已发布，官网公开接口将读取新版本。'); detail.refresh(); list.refresh(); }
      finally { setBusy(false); }
    } });
  }
  async function rollback(version) {
    await confirm({ title: '回滚并发布', message: `确认回滚到版本 ${version} 并立即发布？${dirty ? '当前未保存改动将被覆盖。' : '官网内容将替换为该历史版本。'}`, confirmLabel: '确认回滚', execute: async () => {
      setBusy(true); setMessage('');
      try { await api.post(`admin/website-content/${selectedKey}/rollback`, { version, reason: `官网内容管理台回滚到版本 ${version}` }); clearRecovery(); setMessage(`已回滚到版本 ${version}。`); detail.refresh(); list.refresh(); }
      finally { setBusy(false); }
    } });
  }
  const preview = structured;
  return <>
    {confirmation}
    <PageHeader eyebrow="官网运营" title="官网内容 CMS" description="用结构化表单维护首页、灵动介绍、灵动课程、机构手册、常见问题与品牌信息；公开端只读取已发布版本，保留历史版本供回滚。" actions={<button className="secondary-button" disabled={busy} onClick={reloadContent}>刷新</button>} />
    {message && <Notice tone={message.includes('已') || message.includes('保存') ? 'success' : 'danger'}>{message}</Notice>}
    <div className="split website-cms">
      <Panel title="内容区块">
        {list.loading ? <Loading label="正在读取内容…" /> : list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : <div className="card-list">{(list.data?.items || []).map((item) => <button type="button" key={item.key} className={`item-card cms-key ${selectedKey === item.key ? 'selected' : ''}`} disabled={busy} aria-pressed={selectedKey === item.key} onClick={() => selectContent(item.key)}><strong>{WEBSITE_CONTENT_LABELS[item.key] || item.key}</strong><span>{item.key} · {item.status === 'PUBLISHED' ? '已发布' : item.status === 'DEFAULT' ? '内置默认' : '仅草稿'} · 草稿 v{item.draftVersion}</span></button>)}</div>}
      </Panel>
      <Panel title={selectedKey ? `编辑 ${WEBSITE_CONTENT_LABELS[selectedKey] || selectedKey}` : '选择区块'}>
        {!selectedKey ? <Empty title="暂无内容区块" desc="请先创建或运行 seed 初始化默认区块。" /> : detail.loading ? <Loading label="正在读取详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : <>
          <div className="cms-meta"><span>公开状态：{detail.data?.status === 'PUBLISHED' ? '已发布' : detail.data?.status === 'DEFAULT' ? '内置默认' : '草稿'}</span><span>草稿 v{detail.data?.draftVersion}</span><span>发布 v{detail.data?.publishedVersion || '—'}</span></div>
          {detail.data?.isDefault ? <Notice tone="info">该区块还没有草稿：当前展示的是平台内置默认内容。改动后点「保存草稿」，再点「发布」才会对官网生效。</Notice> : null}
          <div role="status" className="notice info">{dirty ? '有未保存改动 · 当前标签页会暂存草稿，返回时恢复。请保存后再发布。' : '当前内容已与服务器草稿同步。'}</div>
          {storageError && <Notice tone="danger">{storageError}</Notice>}
          {!valid && <div role="alert" id="cms-json-error" className="notice danger">JSON 无效：内容必须是 JSON 对象。预览保留最后有效内容；请修正 JSON 后保存或发布。</div>}
          <fieldset disabled={busy || !valid} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {selectedKey === 'HOME' && <div className="cms-form">
            <div className="form-grid"><label>首页眉题<input value={structured?.heroKicker || ''} onChange={(event) => updateStructured({ heroKicker: event.target.value })} maxLength={100} /></label><label>首页标题<input value={structured?.heroTitle || ''} onChange={(event) => updateStructured({ heroTitle: event.target.value })} maxLength={100} /></label><label>强调标题<input value={structured?.heroAccent || ''} onChange={(event) => updateStructured({ heroAccent: event.target.value })} maxLength={100} /></label><label>封面 / 真实资源 URL（可选）<input value={structured?.coverImageUrl || ''} onChange={(event) => updateStructured({ coverImageUrl: event.target.value })} placeholder="仅填写已有真实资源地址，不会上传文件" /></label></div>
            <label>首页描述<textarea value={structured?.heroDescription || ''} onChange={(event) => updateStructured({ heroDescription: event.target.value })} maxLength={500} /></label>
            <div className="form-grid"><label>信任区标题<input value={structured?.trustTitle || ''} onChange={(event) => updateStructured({ trustTitle: event.target.value })} maxLength={150} /></label><label>信任区描述<input value={structured?.trustDescription || ''} onChange={(event) => updateStructured({ trustDescription: event.target.value })} maxLength={300} /></label></div>
            <div className="cms-section-heading top-gap"><strong>首页数据区（官网首页底部那一排）</strong><span>图标 / 数值 / 后缀 / 名称</span></div>
            <div className="cms-faq-list">{cmsListOf(structured?.stats).map((item, index) => <div className="cms-faq-item" key={`stat-${index}`}><div className="cms-faq-heading"><strong>第 {index + 1} 项</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveList('stats', index, -1)} aria-label={`第 ${index + 1} 项上移`}>↑</button><button type="button" className="text-button" disabled={index === cmsListOf(structured?.stats).length - 1} onClick={() => moveList('stats', index, 1)} aria-label={`第 ${index + 1} 项下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeList('stats', index)}>删除</button></div></div><div className="form-grid"><label>图标<input value={item.icon || ''} onChange={(event) => updateList('stats', index, { icon: event.target.value })} maxLength={4} /></label><label>数值<input value={item.value ?? ''} onChange={(event) => updateList('stats', index, { value: event.target.value })} maxLength={12} /></label><label>后缀<input value={item.suffix || ''} onChange={(event) => updateList('stats', index, { suffix: event.target.value })} maxLength={8} /></label><label>名称<input value={item.label || ''} onChange={(event) => updateList('stats', index, { label: event.target.value })} maxLength={24} /></label></div></div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={() => addList('stats', { icon: '✦', value: '', suffix: '', label: '' })}>新增数据项</button>
          </div>}
          {selectedKey === 'FAQ' && <div className="cms-form"><label>FAQ 标题<input value={structured?.title || ''} onChange={(event) => updateStructured({ title: event.target.value })} maxLength={150} /></label><div className="cms-faq-list">{(Array.isArray(structured?.items) ? structured.items : []).map((item, index) => <div className="cms-faq-item" key={`faq-${index}`}><div className="cms-faq-heading"><strong>问题 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveFaqItem(index, -1)} aria-label={`问题 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === structured.items.length - 1} onClick={() => moveFaqItem(index, 1)} aria-label={`问题 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeFaqItem(index)}>删除</button></div></div><label>问题<input value={item.question || ''} onChange={(event) => updateFaqItem(index, { question: event.target.value })} maxLength={200} /></label><label>答案<textarea value={item.answer || ''} onChange={(event) => updateFaqItem(index, { answer: event.target.value })} maxLength={1000} /></label></div>)}</div><button type="button" className="secondary-button top-gap" onClick={addFaqItem}>新增问题</button></div>}
          {selectedKey === 'BRAND' && <div className="cms-form"><div className="form-grid"><label>品牌名称<input value={structured?.name || ''} onChange={(event) => updateStructured({ name: event.target.value })} maxLength={100} /></label><label>联系邮箱<input type="email" value={structured?.contactEmail || ''} onChange={(event) => updateStructured({ contactEmail: event.target.value })} maxLength={200} /></label></div><label>品牌标语<input value={structured?.tagline || ''} onChange={(event) => updateStructured({ tagline: event.target.value })} maxLength={200} /></label></div>}
          {selectedKey === 'MARKETPLACE' && <div className="cms-form">
            <label>页面大标题<input value={structured?.title || ''} onChange={(event) => updateStructured({ title: event.target.value })} maxLength={100} /></label>
            <label>副标题<textarea value={structured?.lead || ''} onChange={(event) => updateStructured({ lead: event.target.value })} maxLength={400} /></label>
            <p className="muted">这里只改「灵动课程」页头这两句。课包本身（价格、封面、难度、适学年龄、课时、上下架）在「课包与课程编排」里维护 —— 官网列表读的就是那些字段。</p>
          </div>}
          {selectedKey === 'INTRO' && <div className="cms-form">
            <label>页面标题<input value={structured?.title || ''} onChange={(event) => updateStructured({ title: event.target.value })} maxLength={100} /></label>
            <label>一句话说明<textarea value={structured?.lead || ''} onChange={(event) => updateStructured({ lead: event.target.value })} maxLength={600} /></label>
            <div className="cms-section-heading top-gap"><strong>三块要点（官网显示为顶部三张卡）</strong><span>标题 + 说明</span></div>
            <div className="cms-faq-list">{cmsListOf(structured?.highlights).map((item, index) => <div className="cms-faq-item" key={`hl-${index}`}><div className="cms-faq-heading"><strong>要点 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveList('highlights', index, -1)} aria-label={`要点 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === cmsListOf(structured?.highlights).length - 1} onClick={() => moveList('highlights', index, 1)} aria-label={`要点 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeList('highlights', index)}>删除</button></div></div><div className="form-grid"><label>标题<input value={item.title || ''} onChange={(event) => updateList('highlights', index, { title: event.target.value })} maxLength={40} /></label><label>说明<input value={item.desc || ''} onChange={(event) => updateList('highlights', index, { desc: event.target.value })} maxLength={200} /></label></div></div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={() => addList('highlights', { title: '', desc: '' })}>新增要点</button>
            <CmsSectionsFields structured={structured} onList={(index, patch) => updateList('sections', index, patch)} onMove={(index, direction) => moveList('sections', index, direction)} onAdd={(blank) => addList('sections', blank)} onRemove={(index) => removeList('sections', index)} uploading={uploading} onUpload={(file, index) => uploadImage(file, (url) => updateList('sections', index, { imageUrl: url }), `section-${index}`)} />
            <div className="form-grid top-gap"><label>结尾行动标题<input value={structured?.cta?.title || ''} onChange={(event) => updateStructured({ cta: { ...(structured?.cta || {}), title: event.target.value } })} maxLength={120} /></label><label>结尾说明<input value={structured?.cta?.text || ''} onChange={(event) => updateStructured({ cta: { ...(structured?.cta || {}), text: event.target.value } })} maxLength={300} /></label></div>
          </div>}
          {selectedKey === 'HANDBOOK' && <div className="cms-form">
            <label>页面标题<input value={structured?.title || ''} onChange={(event) => updateStructured({ title: event.target.value })} maxLength={100} /></label>
            <label>一句话说明<textarea value={structured?.lead || ''} onChange={(event) => updateStructured({ lead: event.target.value })} maxLength={600} /></label>
            <CmsSectionsFields structured={structured} onList={(index, patch) => updateList('sections', index, patch)} onMove={(index, direction) => moveList('sections', index, direction)} onAdd={(blank) => addList('sections', blank)} onRemove={(index) => removeList('sections', index)} uploading={uploading} onUpload={(file, index) => uploadImage(file, (url) => updateList('sections', index, { imageUrl: url }), `section-${index}`)} />
            <div className="cms-section-heading top-gap"><strong>对比表（维度 / 分散拼凑 / 灵动ai学院）</strong><span>整张表为空时官网不显示对比区</span></div>
            <div className="cms-faq-list">{cmsListOf(structured?.compareRows).map((row, index) => <div className="cms-faq-item" key={`row-${index}`}><div className="cms-faq-heading"><strong>第 {index + 1} 行</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveList('compareRows', index, -1)} aria-label={`第 ${index + 1} 行上移`}>↑</button><button type="button" className="text-button" disabled={index === cmsListOf(structured?.compareRows).length - 1} onClick={() => moveList('compareRows', index, 1)} aria-label={`第 ${index + 1} 行下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeList('compareRows', index)}>删除</button></div></div><div className="form-grid"><label>对比维度<input value={row.label || ''} onChange={(event) => updateList('compareRows', index, { label: event.target.value })} maxLength={40} /></label><label>分散拼凑<input value={row.left || ''} onChange={(event) => updateList('compareRows', index, { left: event.target.value })} maxLength={160} /></label><label>灵动ai学院<input value={row.right || ''} onChange={(event) => updateList('compareRows', index, { right: event.target.value })} maxLength={160} /></label></div></div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={() => addList('compareRows', { label: '', left: '', right: '' })}>新增对比行</button>
            <div className="form-grid top-gap"><label>结尾行动标题<input value={structured?.cta?.title || ''} onChange={(event) => updateStructured({ cta: { ...(structured?.cta || {}), title: event.target.value } })} maxLength={120} /></label><label>结尾说明<input value={structured?.cta?.text || ''} onChange={(event) => updateStructured({ cta: { ...(structured?.cta || {}), text: event.target.value } })} maxLength={300} /></label></div>
          </div>}
          </fieldset>
          <div className="cms-preview-wrap"><div className="cms-section-heading"><strong>草稿预览</strong><span>未保存内容仅在本页预览</span></div><WebsitePreview content={preview} selectedKey={selectedKey} /></div>
          <details className="cms-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary>高级 JSON 编辑（其他区块或复杂字段）</summary><label>JSON 内容<textarea className="cms-editor" value={draft} disabled={busy} aria-invalid={!valid} aria-describedby={!valid ? 'cms-json-error' : undefined} onChange={(event) => keepDraft(event.target.value, parseWebsiteDraft(event.target.value))} spellCheck="false" aria-label={`${selectedKey} JSON 内容`} /></label></details>
          <div className="row-actions top-gap"><button className="primary-button" disabled={busy || !valid || !dirty} onClick={saveDraft}>保存草稿</button><button className="secondary-button" disabled={busy || !valid || dirty || !detail.data} onClick={publish}>发布</button></div>
          <div className="top-gap"><strong>历史版本</strong><div className="card-list top-gap">{(detail.data?.revisions || []).map((revision) => <div className="cms-revision" key={`${revision.key}-${revision.version}`}><span>v{revision.version} · {revision.action} · {formatDate(revision.createdAt)}</span><button className="text-button" disabled={busy || revision.version === detail.data?.publishedVersion} onClick={() => rollback(revision.version)}>回滚并发布</button></div>)}</div></div>
        </>}
      </Panel>
    </div>
  </>;
}

