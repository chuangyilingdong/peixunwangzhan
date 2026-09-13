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
  return <pre className="cms-preview-json">{JSON.stringify(content, null, 2)}</pre>;
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
    <PageHeader eyebrow="官网运营" title="官网内容 CMS" description="用结构化表单维护首页、常见问题、品牌信息与课程体系；公开端只读取已发布版本，保留历史版本供回滚。" actions={<button className="secondary-button" disabled={busy} onClick={reloadContent}>刷新</button>} />
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
          </div>}
          {selectedKey === 'FAQ' && <div className="cms-form"><label>FAQ 标题<input value={structured?.title || ''} onChange={(event) => updateStructured({ title: event.target.value })} maxLength={150} /></label><div className="cms-faq-list">{(Array.isArray(structured?.items) ? structured.items : []).map((item, index) => <div className="cms-faq-item" key={`faq-${index}`}><div className="cms-faq-heading"><strong>问题 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveFaqItem(index, -1)} aria-label={`问题 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === structured.items.length - 1} onClick={() => moveFaqItem(index, 1)} aria-label={`问题 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeFaqItem(index)}>删除</button></div></div><label>问题<input value={item.question || ''} onChange={(event) => updateFaqItem(index, { question: event.target.value })} maxLength={200} /></label><label>答案<textarea value={item.answer || ''} onChange={(event) => updateFaqItem(index, { answer: event.target.value })} maxLength={1000} /></label></div>)}</div><button type="button" className="secondary-button top-gap" onClick={addFaqItem}>新增问题</button></div>}
          {selectedKey === 'BRAND' && <div className="cms-form"><div className="form-grid"><label>品牌名称<input value={structured?.name || ''} onChange={(event) => updateStructured({ name: event.target.value })} maxLength={100} /></label><label>联系邮箱<input type="email" value={structured?.contactEmail || ''} onChange={(event) => updateStructured({ contactEmail: event.target.value })} maxLength={200} /></label></div><label>品牌标语<input value={structured?.tagline || ''} onChange={(event) => updateStructured({ tagline: event.target.value })} maxLength={200} /></label></div>}
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

