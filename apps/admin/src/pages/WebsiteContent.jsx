import { useAdminConfirm } from '../components/AdminConfirm.jsx';
import { readSession } from '@platform/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function parseWebsiteDraft(value) {
  try { const result = JSON.parse(value); return result && typeof result === 'object' && !Array.isArray(result) ? result : null; } catch { return null; }
}

/** 草稿预览里图片的统一内联样式（原来这串在好几处重复写）。 */
const PREVIEW_IMAGE_STYLE = { display: 'block', maxWidth: '100%', marginTop: '8px', borderRadius: '8px' };

export function WebsitePreview({ content, selectedKey }) {
  if (!content) return <div className="cms-preview-empty">保存或修正 JSON 后可预览。</div>;
  if (selectedKey === 'HOME') return <div className="cms-preview-home"><span className="cms-preview-kicker">{content.heroKicker || '首页眉题'}</span><h3>{content.heroTitle || '首页标题'} <em>{content.heroAccent || '强调标题'}</em></h3><p>{content.heroDescription || '首页描述'}</p><div className="cms-preview-trust"><strong>{content.trustTitle || '信任区标题'}</strong><span>{content.trustDescription || '信任区描述'}</span></div>{content.coverImageUrl ? <img src={content.coverImageUrl} alt="首页封面预览" /> : null}</div>;
  // 常见问题：预览按**官网的真实结果**给（顺序 = audienceOrder；某一档为空则官网不显示那一档），
  // 这样运营在保存前就能看出"这一档删空之后官网会怎样"。
  if (selectedKey === 'FAQ') {
    const order = faqAudienceOrder(content);
    const visible = order.filter((key) => cmsListOf(content[key]).length);
    return <div className="cms-preview-faq">{visible.length ? visible.map((key) => <div className="cms-preview-faq-group" key={key}><h4>{FAQ_LABELS[key]}</h4>{cmsListOf(content[key]).map((item, index) => <details key={`${key}-${index}`}><summary>{item.question || `问题 ${index + 1}`}</summary><p>{item.answer || '答案待填写'}</p></details>)}</div>) : <p>三档都没有问题 —— 官网这一页只显示标题，不会出现空的档位。</p>}</div>;
  }
  if (selectedKey === 'BRAND') return <div className="cms-preview-brand"><strong>{content.name || '品牌名称'}</strong><span>{content.tagline || '品牌标语'}</span><small>{content.contactEmail || '联系邮箱'}</small></div>;
  if (selectedKey === 'MARKETPLACE') return <div className="cms-preview-faq"><h3>{content.title || '灵动Ai学院课包展示'}</h3>{content.lead ? <p>{content.lead}</p> : null}</div>;
  // 灵动介绍 / 机构手册：正文是「分节」结构，预览按可折叠列表展示，配图一起预览
  // 灵动介绍：分节结构（标题 + 正文 + 要点 + 配图）
  if (selectedKey === 'INTRO') return <div className="cms-preview-faq"><h3>{content.title || '灵动介绍'}</h3>{content.lead ? <p>{content.lead}</p> : null}{(Array.isArray(content.sections) ? content.sections : []).map((item, index) => <details key={`preview-section-${index}`}><summary>{item.title || `第 ${index + 1} 节`}</summary>{item.body ? <p>{item.body}</p> : null}{(Array.isArray(item.bullets) ? item.bullets.filter(Boolean) : []).length ? <ul>{item.bullets.filter(Boolean).map((bullet, bulletIndex) => <li key={bulletIndex}>{bullet}</li>)}</ul> : null}{item.imageUrl ? <img src={item.imageUrl} alt={item.imageAlt || ''} style={PREVIEW_IMAGE_STYLE} /> : null}</details>)}</div>;
  // 机构手册（2026-09-19 按设计稿重做成「分区」结构）：预览按官网的真实顺序走一遍，图也一起看
  if (selectedKey === 'HANDBOOK') {
    const hero = content.hero || {};
    const about = content.about || {};
    const poster = content.poster || {};
    const work = content.work || {};
    const cards = Array.isArray(work.cards) ? work.cards : [];
    const lines = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
    return <div className="cms-preview-faq">
      <h3>{[hero.line1, hero.line2].filter(Boolean).join(' ') || '机构手册'}</h3>
      {hero.imageUrl ? <img src={hero.imageUrl} alt={hero.imageAlt || ''} style={PREVIEW_IMAGE_STYLE} /> : null}
      {lines(about.headingLines).length ? <p>{lines(about.headingLines).join(' / ')}</p> : null}
      {about.body ? <p>{about.body}</p> : null}
      {poster.imageUrl ? <details><summary>{poster.title || '海报'}</summary><img src={poster.imageUrl} alt={poster.imageAlt || ''} style={PREVIEW_IMAGE_STYLE} /></details> : null}
      <p>横滑卡片 {cards.length} 张：{cards.map((card) => card.title).filter(Boolean).join(' / ') || '（未配置）'}</p>
      {lines(work.introLines).length ? <p>卡片区大标题：{lines(work.introLines).join(' ')}</p> : null}
      {content.compare?.body ? <p>对比区：{content.compare.body}</p> : null}
      {content.cta?.headline ? <p>结尾行动：{content.cta.headline}</p> : null}
    </div>;
  }
  return <pre className="cms-preview-json">{JSON.stringify(content, null, 2)}</pre>;
}

const cmsListOf = (value) => (Array.isArray(value) ? value : []);
/**
 * 常见问题的三个档位（2026-09-18 晚用户口径：「最好3个选项，学生端、老师端、机构端，
 * 可以配置3个端的不同的问题」）。**字段名就是档位 key**；这里只定义**有哪三档、叫什么名字**。
 *
 * ⚠️ **顺序不在这一行**（2026-09-19 用户口径：「这 3 个标签可以在后台排序优先级，优先级高的排在最前面」）：
 *    真实顺序存在内容的 `audienceOrder` 里，由下面表单的 ↑/↓ 改；官网按它排 tab。
 *    FAQ_AUDIENCES 的排列只是**没配时的默认值**，所以改顺序**不用再改官网代码**。
 * ⚠️ 官网**只显示有内容的档位**：某一档问题删光 = 官网那一档不出现（同一条口径）。
 */
const FAQ_AUDIENCES = [['student', '学生端'], ['teacher', '老师端'], ['org', '机构端']];
const FAQ_LABELS = Object.fromEntries(FAQ_AUDIENCES);
/** 档位的实际显示顺序：CMS 的 `audienceOrder` 打头，没排到的按默认顺序补在后。
 *  **表单与预览共用这一份规则**，所以「后台看到的顺序」和「官网的顺序」不会各说各话。 */
const faqAudienceOrder = (content) => {
  const configured = cmsListOf(content?.audienceOrder).filter((key) => FAQ_LABELS[key]);
  return [...configured, ...FAQ_AUDIENCES.map(([key]) => key).filter((key) => !configured.includes(key))];
};
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
  // 常见问题原来是「一个 items 列表」配四个专用 handler（updateFaqItem / moveFaqItem / addFaqItem /
  // removeFaqItem）。2026-09-18 晚改成分档后，档位 key 就是字段名，直接走下面那套通用列表 handler
  // （updateList / moveList / addList / removeList），所以那四个函数删掉了。
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
  /** 某一档整体上下移一位 = 改它的显示优先级（官网 tab 顺序跟着变，改完发布即生效）。 */
  function moveAudience(index, direction) {
    const order = faqAudienceOrder(structured);
    const next = index + direction;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    updateStructured({ audienceOrder: order });
  }
  // 机构手册（2026-09-19 按设计稿重做成「分区」结构）用的几个 helper：
  // 它的字段是**嵌套**的（hero/about/poster/work/compare/cta 各一小块），
  // 上面那套 updateList/moveList 只认顶层字段，所以这里补一层「分区内的字段」操作。
  function updateSection(section, patch) {
    updateStructured({ [section]: { ...(structured?.[section] || {}), ...patch } });
  }
  /** 多行标题里的一行（headingLines / introLines）。 */
  function updateSectionLine(section, field, index, value) {
    const lines = cmsListOf(structured?.[section]?.[field]);
    updateSection(section, { [field]: lines.map((line, lineIndex) => (lineIndex === index ? value : line)) });
  }
  /** 分区里的列表（现在只有 work.cards）：增删改 + 上下移。 */
  function updateSectionList(section, field, index, patch) {
    const items = cmsListOf(structured?.[section]?.[field]);
    updateSection(section, { [field]: items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) });
  }
  function moveSectionList(section, field, index, direction) {
    const items = [...cmsListOf(structured?.[section]?.[field])];
    const next = index + direction;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    updateSection(section, { [field]: items });
  }
  function addSectionList(section, field, blank) { updateSection(section, { [field]: [...cmsListOf(structured?.[section]?.[field]), blank] }); }
  function removeSectionList(section, field, index) { updateSection(section, { [field]: cmsListOf(structured?.[section]?.[field]).filter((_, itemIndex) => itemIndex !== index) }); }
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
          {selectedKey === 'FAQ' && (() => {
            // 三个档位各配一套问答（2026-09-18 晚用户口径）。三组共用同一套增删改 + 上下移，
            // 档位 key 直接当字段名用（与官网 /faq 的 tab 一一对应）。
            // ⚠️ 这里按 `audienceOrder`（= 官网真实显示顺序）渲染，所以**后台看到的顺序就是官网的顺序**；
            //    每组标题右边的 ↑/↓ 改的就是它（2026-09-19 用户口径：「可以排序优先级，优先级高的排在最前面」）。
            // ⚠️ 某一档问题为空 = 官网**不显示**那一档（口径：「没有内容就隐藏，有内容才出现」）；
            //    空档位不回退任何兜底内容（口径③：空 = 运营故意清空）。
            const order = faqAudienceOrder(structured);
            return <div className="cms-form">
              <div className="cms-section-heading"><strong>档位显示顺序</strong><span>优先级高的排在最前，官网 tab 按这个顺序；某一档问题为空则官网不显示那一档</span></div>
              {order.map((key, position) => {
                const label = FAQ_LABELS[key];
                const items = cmsListOf(structured?.[key]);
                return <div className="cms-faq-group" key={key}>
                  <div className="cms-faq-group-head"><strong>第 {position + 1} 位 · {label}</strong><span>{items.length} 条 · 字段 {key} · {items.length ? '官网会显示' : '⚠️ 官网不显示这一档'}</span><div className="row-actions"><button type="button" className="text-button" disabled={position === 0} onClick={() => moveAudience(position, -1)} aria-label={`把${label}的显示优先级上移`}>↑</button><button type="button" className="text-button" disabled={position === order.length - 1} onClick={() => moveAudience(position, 1)} aria-label={`把${label}的显示优先级下移`}>↓</button></div></div>
                  <div className="cms-faq-list">{items.map((item, index) => <div className="cms-faq-item" key={`faq-${key}-${index}`}><div className="cms-faq-heading"><strong>问题 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveList(key, index, -1)} aria-label={`${label} 第 ${index + 1} 个问题上移`}>↑</button><button type="button" className="text-button" disabled={index === items.length - 1} onClick={() => moveList(key, index, 1)} aria-label={`${label} 第 ${index + 1} 个问题下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeList(key, index)}>删除</button></div></div><label>问题<input value={item.question || ''} onChange={(event) => updateList(key, index, { question: event.target.value })} maxLength={200} /></label><label>答案<textarea value={item.answer || ''} onChange={(event) => updateList(key, index, { answer: event.target.value })} maxLength={1000} /></label></div>)}</div>
                  <button type="button" className="secondary-button top-gap" onClick={() => addList(key, { question: '', answer: '' })}>给{label}新增问题</button>
                </div>;
              })}
            </div>;
          })()}
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
            <div className="form-grid top-gap">
              {/* ⚠️ 原来这里绑的是 `cta.title`，而官网渲染的是 `cta.headline` —— 后台改了没反应（已修）。
                  按钮的文案与去向也在这里（2026-09-19 用户口径：按钮改成「点击进入常见问题」跳 /faq）。 */}
              <label>结尾行动大标题<input value={structured?.cta?.headline || ''} onChange={(event) => updateSection('cta', { headline: event.target.value })} maxLength={40} /></label>
              <label>结尾说明<input value={structured?.cta?.text || ''} onChange={(event) => updateSection('cta', { text: event.target.value })} maxLength={200} /></label>
              <label>按钮文案<input value={structured?.cta?.buttonLabel || ''} onChange={(event) => updateSection('cta', { buttonLabel: event.target.value })} maxLength={24} /></label>
              <label>按钮去向（站内路径）<input value={structured?.cta?.buttonTo || ''} onChange={(event) => updateSection('cta', { buttonTo: event.target.value })} maxLength={80} placeholder="例如 /faq、/demo" /></label>
            </div>
          </div>}
          {selectedKey === 'HANDBOOK' && <div className="cms-form">
            {/* 2026-09-19 按用户给的设计稿（design (1).zip）重做：整页换成
                「主视觉 + 关于 + 海报 + 横滑卡片 + 对比 + 结尾行动」。字段与官网一一对应
                （apps/website/src/main.jsx 的 Handbook()）。
                ⚠️ 带 Lines 的是**多行标题**：官网把**第 2 行**渲染成描边字（设计稿如此），
                   所以这里**一行一个输入框**，不要合并成一个 textarea、也不要在里面敲换行。
                ⚠️ 图片留空时官网用内置的默认图（public/assets/handbook/）；换图可以直接贴地址，
                   也可以点「上传图片」走平台的文件资产接口。 */}
            {[['hero', '主视觉（首屏）', '两行大标题 + 通屏背景图'], ['about', '关于（纸色区块）', '左侧图 + 右侧标题与正文'], ['poster', '海报（信息图）', '用户给的那张「AI 时代的孩子」——整张显示，不裁切，点开可看大图']].map(([section, title, hint]) => {
              const block = structured?.[section] || {};
              const lines = cmsListOf(block.headingLines);
              return <div key={`hb-${section}`}>
                <div className="cms-section-heading top-gap"><strong>{title}</strong><span>{hint}</span></div>
                <div className="form-grid">
                  <label>图片地址<input value={block.imageUrl || ''} onChange={(event) => updateSection(section, { imageUrl: event.target.value })} placeholder="留空则用默认图" /></label>
                  <label>图片说明（无障碍用）<input value={block.imageAlt || ''} onChange={(event) => updateSection(section, { imageAlt: event.target.value })} maxLength={160} /></label>
                  {section === 'about' && <label>角标文字<input value={block.index || ''} onChange={(event) => updateSection(section, { index: event.target.value })} maxLength={24} placeholder="例如 01 / 关于" /></label>}
                  {section === 'poster' && <label>眉题<input value={block.eyebrow || ''} onChange={(event) => updateSection(section, { eyebrow: event.target.value })} maxLength={24} /></label>}
                </div>
                {section === 'hero' && <div className="form-grid">
                  <label>进场幕布文案<input value={block.loaderWord || ''} onChange={(event) => updateSection('hero', { loaderWord: event.target.value })} maxLength={30} placeholder="进场那一秒盖在整页上的那行字" /></label>
                  <label>标题第 1 行<input value={block.line1 || ''} onChange={(event) => updateSection('hero', { line1: event.target.value })} maxLength={40} /></label>
                  <label>标题第 2 行<input value={block.line2 || ''} onChange={(event) => updateSection('hero', { line2: event.target.value })} maxLength={40} /></label>
                </div>}
                {section === 'about' && <>
                  <div className="form-grid">
                    <label>标题第 1 行<input value={lines[0] || ''} onChange={(event) => updateSectionLine('about', 'headingLines', 0, event.target.value)} maxLength={40} /></label>
                    <label>标题第 2 行<input value={lines[1] || ''} onChange={(event) => updateSectionLine('about', 'headingLines', 1, event.target.value)} maxLength={40} /></label>
                  </div>
                  <label>正文<textarea value={block.body || ''} onChange={(event) => updateSection('about', { body: event.target.value })} maxLength={800} /></label>
                </>}
                {section === 'poster' && <>
                  <label>海报标题<input value={block.title || ''} onChange={(event) => updateSection('poster', { title: event.target.value })} maxLength={60} /></label>
                  <label>图注<textarea value={block.caption || ''} onChange={(event) => updateSection('poster', { caption: event.target.value })} maxLength={200} /></label>
                </>}
                <div className="row-actions top-gap"><label className="inline-file-upload">{uploading === `hb-${section}` ? '上传中…' : '上传图片'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url) => updateSection(section, { imageUrl: url }), `hb-${section}`); }} /></label></div>
              </div>;
            })}
            <div className="cms-section-heading top-gap"><strong>横滑卡片区（向右滚动的 5 张）</strong><span>标题 + 一句话 + 配图；第 2 行标题官网是描边字</span></div>
            <div className="form-grid">{cmsListOf(structured?.work?.introLines).map((line, index) => <label key={`hb-intro-${index}`}>大标题第 {index + 1} 行{index === 1 ? '（描边）' : ''}<input value={line || ''} onChange={(event) => updateSectionLine('work', 'introLines', index, event.target.value)} maxLength={20} /></label>)}</div>
            <div className="cms-faq-list">{cmsListOf(structured?.work?.cards).map((card, index) => <div className="cms-faq-item" key={`hb-card-${index}`}><div className="cms-faq-heading"><strong>卡片 {index + 1}</strong><div className="row-actions"><button type="button" className="text-button" disabled={index === 0} onClick={() => moveSectionList('work', 'cards', index, -1)} aria-label={`卡片 ${index + 1} 上移`}>↑</button><button type="button" className="text-button" disabled={index === cmsListOf(structured?.work?.cards).length - 1} onClick={() => moveSectionList('work', 'cards', index, 1)} aria-label={`卡片 ${index + 1} 下移`}>↓</button><button type="button" className="text-button danger-text" onClick={() => removeSectionList('work', 'cards', index)}>删除</button></div></div>
              <div className="form-grid"><label>标题<input value={card.title || ''} onChange={(event) => updateSectionList('work', 'cards', index, { title: event.target.value })} maxLength={40} /></label><label>一句话说明<input value={card.desc || ''} onChange={(event) => updateSectionList('work', 'cards', index, { desc: event.target.value })} maxLength={120} /></label><label>配图地址<input value={card.imageUrl || ''} onChange={(event) => updateSectionList('work', 'cards', index, { imageUrl: event.target.value })} /></label><label>配图说明<input value={card.imageAlt || ''} onChange={(event) => updateSectionList('work', 'cards', index, { imageAlt: event.target.value })} maxLength={160} /></label></div>
              <div className="row-actions top-gap"><label className="inline-file-upload">{uploading === `hb-card-${index}` ? '上传中…' : '上传配图'}<input type="file" accept="image/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) uploadImage(file, (url) => updateSectionList('work', 'cards', index, { imageUrl: url }), `hb-card-${index}`); }} /></label></div>
            </div>)}</div>
            <button type="button" className="secondary-button top-gap" onClick={() => addSectionList('work', 'cards', { title: '', desc: '', imageUrl: '', imageAlt: '' })}>新增卡片</button>
            <div className="cms-section-heading top-gap"><strong>对比区（粒子背景）</strong><span>眉题 + 两行标题（第 2 行描边）+ 正文</span></div>
            <div className="form-grid">
              <label>眉题<input value={structured?.compare?.eyebrow || ''} onChange={(event) => updateSection('compare', { eyebrow: event.target.value })} maxLength={24} /></label>
              <label>标题第 1 行<input value={cmsListOf(structured?.compare?.headingLines)[0] || ''} onChange={(event) => updateSectionLine('compare', 'headingLines', 0, event.target.value)} maxLength={30} /></label>
              <label>标题第 2 行（描边）<input value={cmsListOf(structured?.compare?.headingLines)[1] || ''} onChange={(event) => updateSectionLine('compare', 'headingLines', 1, event.target.value)} maxLength={30} /></label>
            </div>
            <label>正文<textarea value={structured?.compare?.body || ''} onChange={(event) => updateSection('compare', { body: event.target.value })} maxLength={800} /></label>
            <div className="cms-section-heading top-gap"><strong>结尾行动</strong><span>大标题 + 说明（按钮与联系方式由官网统一）</span></div>
            <div className="form-grid"><label>标题<input value={structured?.cta?.headline || ''} onChange={(event) => updateSection('cta', { headline: event.target.value })} maxLength={40} /></label><label>说明<input value={structured?.cta?.text || ''} onChange={(event) => updateSection('cta', { text: event.target.value })} maxLength={200} /></label></div>
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

