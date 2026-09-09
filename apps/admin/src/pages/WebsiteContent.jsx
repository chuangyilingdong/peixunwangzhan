import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatCredits, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function parseWebsiteDraft(value) {
  try { return JSON.parse(value || '{}'); } catch { return null; }
}

export function WebsitePreview({ content, selectedKey }) {
  if (!content) return <div className="cms-preview-empty">保存或修正 JSON 后可预览。</div>;
  if (selectedKey === 'HOME') return <div className="cms-preview-home"><span className="cms-preview-kicker">{content.heroKicker || '首页眉题'}</span><h3>{content.heroTitle || '首页标题'} <em>{content.heroAccent || '强调标题'}</em></h3><p>{content.heroDescription || '首页描述'}</p><div className="cms-preview-trust"><strong>{content.trustTitle || '信任区标题'}</strong><span>{content.trustDescription || '信任区描述'}</span></div>{content.coverImageUrl ? <img src={content.coverImageUrl} alt="首页封面预览" /> : null}</div>;
  if (selectedKey === 'FAQ') return <div className="cms-preview-faq"><h3>{content.title || '常见问题'}</h3>{(Array.isArray(content.items) ? content.items : []).map((item, index) => <details key={`${item.question || 'faq'}-${index}`}><summary>{item.question || `问题 ${index + 1}`}</summary><p>{item.answer || '答案待填写'}</p></details>)}</div>;
  if (selectedKey === 'BRAND') return <div className="cms-preview-brand"><strong>{content.name || '品牌名称'}</strong><span>{content.tagline || '品牌标语'}</span><small>{content.contactEmail || '联系邮箱'}</small></div>;
  if (selectedKey === 'COURSES') return <div className="cms-preview-home"><span className="cms-preview-kicker">{content.eyebrow || '课程体系'}</span><h3>{content.title || '页面标题'} <em>{content.titleAccent || '强调标题'}</em></h3><p>{content.description || '页面描述'}</p><div className="cms-preview-trust"><strong>{(Array.isArray(content.stats) ? content.stats : []).map((item) => `${item.value || '—'} ${item.label || ''}`.trim()).join(' · ') || '数据条'}</strong><span>共 {(Array.isArray(content.courses) ? content.courses : []).length} 门课包 · 每节 {content.durationMinutes || 90} 分钟</span></div>{(Array.isArray(content.courses) ? content.courses : []).slice(0, 3).map((course, index) => <div className="cms-preview-trust" key={`${course.title || 'course'}-${index}`}><strong>{course.icon || '✦'} {course.title || `课包 ${index + 1}`}</strong><span>{course.category || '分类'} · {course.lessonCount || 0} 节 · {course.summary || '简介'}</span></div>)}</div>;
  return <pre className="cms-preview-json">{JSON.stringify(content, null, 2)}</pre>;
}

export function WebsiteContent({ api }) {
  const list = useData(() => api.get('admin/website-content'), [api]);
  const [selectedKey, setSelectedKey] = useState('');
  const [draft, setDraft] = useState('');
  const [structured, setStructured] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const detail = useData(() => selectedKey ? api.get(`admin/website-content/${selectedKey}`) : Promise.resolve(null), [api, selectedKey]);
  useEffect(() => {
    const first = list.data?.items?.[0]?.key;
    if (!selectedKey && first) setSelectedKey(first);
  }, [list.data, selectedKey]);
  useEffect(() => {
    if (detail.data) {
      const content = detail.data.content || {};
      setDraft(JSON.stringify(content, null, 2));
      setStructured(content);
      setAdvancedOpen(false);
    }
  }, [detail.data]);
  function updateStructured(patch) {
    setStructured((current) => {
      const next = { ...(current || {}), ...patch };
      setDraft(JSON.stringify(next, null, 2));
      return next;
    });
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
      setMessage('草稿已保存。'); await detail.refresh(); await list.refresh();
    } catch (error) { setMessage(error instanceof SyntaxError ? 'JSON 格式无效。' : error.message); }
    finally { setBusy(false); }
  }
  async function publish() {
    setBusy(true); setMessage('');
    try { await api.post(`admin/website-content/${selectedKey}/publish`, { reason: '官网内容管理台发布' }); setMessage('已发布，官网公开接口将读取新版本。'); await detail.refresh(); await list.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  async function rollback(version) {
    if (!window.confirm(`确认回滚到版本 ${version} 并立即发布吗？`)) return;
    setBusy(true); setMessage('');
    try { await api.post(`admin/website-content/${selectedKey}/rollback`, { version, reason: `官网内容管理台回滚到版本 ${version}` }); setMessage(`已回滚到版本 ${version}。`); await detail.refresh(); await list.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  const preview = parseWebsiteDraft(draft);
  return <>
    <PageHeader eyebrow="官网运营" title="官网内容 CMS" description="用结构化表单维护首页、常见问题、品牌信息与课程体系；公开端只读取已发布版本，保留历史版本供回滚。" actions={<button className="secondary-button" onClick={() => { list.refresh(); detail.refresh(); }}>刷新</button>} />
    {message && <Notice tone={message.includes('已') || message.includes('保存') ? 'success' : 'danger'}>{message}</Notice>}
    <div className="split website-cms">
      <Panel title="内容区块">
        {list.loading ? <Loading label="正在读取内容…" /> : list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : <div className="card-list">{(list.data?.items || []).map((item) => <button type="button" key={item.key} className={`item-card cms-key ${selectedKey === item.key ? 'selected' : ''}`} onClick={() => setSelectedKey(item.key)}><strong>{WEBSITE_CONTENT_LABELS[item.key] || item.key}</strong><span>{item.key} · {item.status === 'PUBLISHED' ? '已发布' : item.status === 'DEFAULT' ? '内置默认' : '仅草稿'} · 草稿 v{item.draftVersion}</span></button>)}</div>}
      </Panel>
      <Panel title={selectedKey ? `编辑 ${WEBSITE_CONTENT_LABELS[selectedKey] || selectedKey}` : '选择区块'}>
        {!selectedKey ? <Empty title="暂无内容区块" desc="请先创建或运行 seed 初始化默认区块。" /> : detail.loading ? <Loading label="正在读取详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : <>
          <div className="cms-meta"><span>公开状态：{detail.data?.status === 'PUBLISHED' ? '已发布' : detail.data?.status === 'DEFAULT' ? '内置默认' : '草稿'}</span><span>草稿 v{detail.data?.draftVersion}</span><span>发布 v{detail.data?.publishedVersion || '—'}</span></div>
          {detail.data?.isDefault ? <Notice tone="info">该区块还没有草稿：当前展示的是平台内置默认内容。改动后点「保存草稿」，再点「发布」才会对官网生效。</Notice> : null}
          {selectedKey === 'HOME' && <div className="cms-form">
            <div className="form-grid"><label>首页眉题<input value={structured?.heroKicker || ''} onChange={(event) => updateStructured({ heroKicker: event.target.value })} maxLength={100} /></label><label>首页标题<input value={structured?.heroTitle || ''} onChange={(event) => updateStructured({ heroTitle: event.target.value })} maxLength={100} /></label><label>强调标题<input value={structured?.heroAccent || ''} onChange={(event) => updateStructured({ heroAccent: event.target.value })} maxLength={100} /></label><label>封面 / 真实资源 URL（可选）<input value={structured?.coverImageUrl || ''} onChange={(event) => updateStructured({ coverImageUrl: event.target.value })} placeholder="仅填写已有真实资源地址，不会上传文件" /></label></div>
            <label>首页描述<textarea value={structured?.heroDescription || ''} onChange={(event) => updateStructured({ heroDescription: event.target.value })} maxLength={500} /></label>
            <div className="form-grid"><label>信任区标题<input value={structured?.trustTitle || ''} onChange={(event) => updateStructured({ trustTitle: event.target.value })} maxLength={150} /></label><label>信任区描述<input value={structured?.trustDescription || ''} onChange={(event) => updateStructured({ trustDescription: event.target.value })} maxLength={300} /></label></div>
          </div>}
          {selectedKey === 'FAQ' && <div className="cms-form"><label>FAQ 标题<input value={structured?.title || ''} onChange={(event) => updateStructured({ title: event.target.value })} maxLength={150} /></label><div className="cms-faq-list">{(Array.isArray(structured?.items) ? structured.items : []).map((item, index) => <div className="cms-faq-item" key={`faq-${index}`}><div className="cms-faq-heading"><strong>问题 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveFaqItem(index, -1)} aria-label={`问题 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === structured.items.length - 1} onClick={() => moveFaqItem(index, 1)} aria-label={`问题 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeFaqItem(index)}>删除</button></div></div><label>问题<input value={item.question || ''} onChange={(event) => updateFaqItem(index, { question: event.target.value })} maxLength={200} /></label><label>答案<textarea value={item.answer || ''} onChange={(event) => updateFaqItem(index, { answer: event.target.value })} maxLength={1000} /></label></div>)}</div><button type="button" className="secondary-button top-gap" onClick={addFaqItem}>新增问题</button></div>}
          {selectedKey === 'BRAND' && <div className="cms-form"><div className="form-grid"><label>品牌名称<input value={structured?.name || ''} onChange={(event) => updateStructured({ name: event.target.value })} maxLength={100} /></label><label>联系邮箱<input type="email" value={structured?.contactEmail || ''} onChange={(event) => updateStructured({ contactEmail: event.target.value })} maxLength={200} /></label></div><label>品牌标语<input value={structured?.tagline || ''} onChange={(event) => updateStructured({ tagline: event.target.value })} maxLength={200} /></label></div>}
          {selectedKey === 'COURSES' && <div className="cms-form">
            <div className="form-grid"><label>页面眉题<input value={structured?.eyebrow || ''} onChange={(event) => updateStructured({ eyebrow: event.target.value })} maxLength={50} /></label><label>每节课时长（分钟）<input type="number" min={1} max={300} value={structured?.durationMinutes ?? 90} onChange={(event) => updateStructured({ durationMinutes: Number(event.target.value) || 0 })} /></label><label>页面标题<input value={structured?.title || ''} onChange={(event) => updateStructured({ title: event.target.value })} maxLength={80} /></label><label>标题强调（斜体部分）<input value={structured?.titleAccent || ''} onChange={(event) => updateStructured({ titleAccent: event.target.value })} maxLength={80} /></label></div>
            <label>页面描述<textarea value={structured?.description || ''} onChange={(event) => updateStructured({ description: event.target.value })} maxLength={500} /></label>
            <div className="cms-section-heading top-gap"><strong>数据条</strong><button type="button" className="text-button" onClick={addStat}>新增数据</button></div>
            {(Array.isArray(structured?.stats) ? structured.stats : []).map((item, index) => <div className="cms-faq-item" key={`stat-${index}`}><div className="cms-faq-heading"><strong>数据 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button danger-text" onClick={() => removeStat(index)}>删除</button></div></div><div className="form-grid"><label>数值<input value={item.value || ''} onChange={(event) => updateStat(index, { value: event.target.value })} maxLength={20} /></label><label>说明<input value={item.label || ''} onChange={(event) => updateStat(index, { label: event.target.value })} maxLength={30} /></label></div></div>)}
            <div className="cms-section-heading top-gap"><strong>课包列表（官网按此顺序展示）</strong><button type="button" className="secondary-button" onClick={addCourse}>新增课包</button></div>
            {(Array.isArray(structured?.courses) ? structured.courses : []).map((course, index) => <div className="cms-faq-item" key={`course-${index}`}><div className="cms-faq-heading"><strong>课包 {index + 1}{course.title ? ` · ${course.title}` : ''}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveCourse(index, -1)} aria-label={`课包 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === structured.courses.length - 1} onClick={() => moveCourse(index, 1)} aria-label={`课包 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeCourse(index)}>删除</button></div></div><div className="form-grid"><label>图标（emoji）<input value={course.icon || ''} onChange={(event) => updateCourse(index, { icon: event.target.value })} maxLength={8} /></label><label>课包名<input value={course.title || ''} onChange={(event) => updateCourse(index, { title: event.target.value })} maxLength={60} /></label><label>分类<input value={course.category || ''} onChange={(event) => updateCourse(index, { category: event.target.value })} maxLength={30} /></label><label>课时数<input type="number" min={1} max={99} value={course.lessonCount ?? ''} onChange={(event) => updateCourse(index, { lessonCount: Number(event.target.value) || 0 })} /></label><label>适学年龄<input value={course.ageRange || ''} onChange={(event) => updateCourse(index, { ageRange: event.target.value })} maxLength={20} /></label></div><label>一句话简介<textarea value={course.summary || ''} onChange={(event) => updateCourse(index, { summary: event.target.value })} maxLength={200} /></label><label>课时列表（每行一节，留空则按内置课时名生成）<textarea value={(Array.isArray(course.lessons) ? course.lessons : []).join('\n')} onChange={(event) => updateCourse(index, { lessons: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })} /></label></div>)}
            <div className="form-grid"><label>底部标题<input value={structured?.ctaTitle || ''} onChange={(event) => updateStructured({ ctaTitle: event.target.value })} maxLength={100} /></label><label>底部说明<input value={structured?.ctaText || ''} onChange={(event) => updateStructured({ ctaText: event.target.value })} maxLength={200} /></label></div>
          </div>}
          <div className="cms-preview-wrap"><div className="cms-section-heading"><strong>草稿预览</strong><span>未保存内容仅在本页预览</span></div><WebsitePreview content={preview} selectedKey={selectedKey} /></div>
          <details className="cms-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary>高级 JSON 编辑（其他区块或复杂字段）</summary><label>JSON 内容<textarea className="cms-editor" value={draft} onChange={(event) => { setDraft(event.target.value); setStructured(parseWebsiteDraft(event.target.value)); }} spellCheck="false" aria-label={`${selectedKey} JSON 内容`} /></label></details>
          <div className="row-actions top-gap"><button className="primary-button" disabled={busy} onClick={saveDraft}>保存草稿</button><button className="secondary-button" disabled={busy} onClick={publish}>发布</button></div>
          <div className="top-gap"><strong>历史版本</strong><div className="card-list top-gap">{(detail.data?.revisions || []).map((revision) => <div className="cms-revision" key={`${revision.key}-${revision.version}`}><span>v{revision.version} · {revision.action} · {formatDate(revision.createdAt)}</span><button className="text-button" disabled={busy || revision.version === detail.data?.publishedVersion} onClick={() => rollback(revision.version)}>回滚并发布</button></div>)}</div></div>
        </>}
      </Panel>
    </div>
  </>;
}

