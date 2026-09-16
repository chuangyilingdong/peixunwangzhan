import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { buildPreviewDocument, ReplayDocument, ReplayFiles, ReplayPreview } from '@platform/shared';
import { Empty, ErrorState, Loading, MetricCard, Notice, PageHeader, Panel, SearchSelect, formatDate, formatYuan, useData } from '@platform/shared';
import './Classrooms.css';

const SESSION_STATE = {
  PENDING: { label: '待上课', tone: 'warning' },
  ACTIVE: { label: '上课中', tone: 'success' },
  ENDED: { label: '已结束', tone: 'muted' },
  DISSOLVED: { label: '已解散', tone: 'danger' },
};
const STUDENT_STATE = {
  ...SESSION_STATE,
  COMPLETED: { label: '已完课', tone: 'success' },
  INCOMPLETE: { label: '未完课', tone: 'danger' },
  REMOVED: { label: '被移除', tone: 'muted' },
};
const DELIVERY_LABEL = { CANVAS: '画布课堂', VIBECODING: 'VibeCoding 课堂' };
const emptyForm = { seriesId: '', lessonId: '', title: '', teacherId: '', deliveryMode: 'CANVAS' };

function removedReasonLabel(reason) {
  const labels = {
    SESSION_LESSON_SWAP: "课程已更换，原名单已移除",
    SESSION_DISSOLVE: "课堂已解散，学员已移除",
    SESSION_DISSOLVED: "课堂已解散，学员已移除",
    DISSOLVED: "课堂已解散，学员已移除",
    SESSION_STUDENT_REMOVE: "老师已移除该学员",
    MANUAL: "老师手动移除",
  };
  return labels[reason] || (/^[A-Z][A-Z0-9_]*$/.test(reason) ? "学员已移除" : reason);
}

function publishedModes(lesson) {
  return (lesson?.deliveryModes?.length ? lesson.deliveryModes : [lesson?.deliveryMode])
    .filter((mode) => Object.hasOwn(DELIVERY_LABEL, mode));
}

function StateBadge({ value, map = SESSION_STATE }) {
  const item = map[value] || { label: value || '未知状态', tone: 'muted' };
  return <span className={'status ' + (item.tone === 'muted' ? '' : item.tone)}>{item.label}</span>;
}

function Modal({ title, description, children, onClose, footer, busy, error, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => { ref.current?.close(); previous?.focus?.(); };
  }, []);
  return <dialog ref={ref} className={`classroom-dialog${wide ? ' classroom-dialog-wide' : ''}`} aria-labelledby={titleId} aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h3 id={titleId}>{title}</h3>
    {description ? <p className="muted">{description}</p> : null}
    {error ? <div role="alert"><Notice tone="danger">{error}</Notice></div> : null}
    <fieldset disabled={busy} className="classroom-dialog-fields">{children}</fieldset>
    <fieldset disabled={busy} className="classroom-dialog-fields row-actions top-gap">{footer}</fieldset>
  </dialog>;
}

function Duration({ runtime, status }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (status !== 'ACTIVE') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status, runtime]);
  const started = Date.parse(runtime?.startedAt);
  const ended = Date.parse(runtime?.endedAt);
  const snapshot = Date.parse(runtime?.asOf);
  let seconds = Number.isFinite(started) && (status === 'ACTIVE' || Number.isFinite(ended))
    ? Math.max(0, Math.floor(((status === 'ACTIVE' ? now : ended) - started) / 1000)) : null;
  if (Number.isFinite(runtime?.durationSeconds)) {
    seconds = Math.max(0, Math.floor(runtime.durationSeconds + (status === 'ACTIVE' && Number.isFinite(snapshot) ? Math.max(0, now - snapshot) / 1000 : 0)));
  }
  return <span>{seconds === null ? '尚未开始' : `${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`}</span>;
}

function AiUsage({ ai }) {
  if (!ai) return <span className="muted">暂无用量数据</span>;
  return <><span>成功 {ai.successCount ?? 0} · 失败 {ai.failedCount ?? 0}</span>
    <div className="muted">售价消耗 {ai.salePriceFen == null ? '待确定' : formatYuan(ai.salePriceFen)}</div></>;
}

function previewHref(value) {
  if (!value || typeof value !== 'string') return null;
  return /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value) ? value : null;
}

// 作品图片一律转成 data: 地址：学生代码跑在 opaque 起源的 sandbox iframe 里，
// 拿不到父页面的 blob: 地址（实测 <img src="blob:..."> 在该文档内必然 onerror），
// 而 data: 在沙箱内和父页面都能显示（两处 CSP 都允许 img-src data:）。
async function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('作品图片读取失败。'));
    reader.readAsDataURL(blob);
  });
}

function ClassroomWork({ api, sessionId, work, onClose }) {
  const detail = useData(() => api.get(`org/sessions/${encodeURIComponent(sessionId)}/works/${encodeURIComponent(work.source)}/${encodeURIComponent(work.id)}`), [api, sessionId, work.source, work.id]);
  const [activeName, setActiveName] = useState('');
  const [images, setImages] = useState({});
  const [imageError, setImageError] = useState('');
  const data = detail.data;
  useEffect(() => {
    let cancelled = false;
    setImages({});
    setImageError('');
    const prefix = `/api/org/sessions/${encodeURIComponent(sessionId)}/works/${encodeURIComponent(work.source)}/${encodeURIComponent(work.id)}/images/`;
    Promise.allSettled(Object.entries(data?.imageUrls || {}).map(async ([id, path]) => {
      if (typeof path !== 'string' || !path.startsWith(prefix)) throw new Error('图片地址不属于此作品。');
      const blobUrl = await api.fetchBlobUrl(path);
      try {
        const dataUrl = await readAsDataUrl(await (await fetch(blobUrl)).blob());
        if (cancelled) return null;
        return [id, dataUrl];
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    })).then((entries) => {
      if (cancelled) return;
      setImages(Object.fromEntries(entries.filter((entry) => entry.status === 'fulfilled' && entry.value).map((entry) => entry.value)));
      if (entries.some((entry) => entry.status === 'rejected')) setImageError('部分作品图片不可用，已保留其余图片。');
    }).catch((error) => {
      if (!cancelled) setImageError(error.message || '作品图片读取失败。');
    });
    return () => { cancelled = true; };
  }, [api, data, sessionId, work.id, work.source]);
  const snapshotImage = (value) => {
    const raw = String(value || '');
    const match = raw.match(/^\/api\/student\/file-assets\/([\w-]+)\/download(?:[?#].*)?$/);
    if (match) return images[match[1]] || null;
    const entry = Object.entries(data?.imageUrls || {}).find(([, path]) => path === raw);
    return entry ? images[entry[0]] || null : null;
  };
  const files = Object.fromEntries(Object.entries(data?.files || {}).map(([name, content]) => {
    let resolved = String(content ?? '');
    for (const [id, url] of Object.entries(images)) {
      resolved = resolved.split(`/api/student/file-assets/${id}/download`).join(url);
    }
    return [name, resolved];
  }));
  const artifacts = data?.artifacts || [];
  const views = artifacts.filter((item) => item.document || ['pptx', 'docx', 'xlsx', 'html', 'htm'].includes(String(item.kind).toLowerCase()) || /\.html?$/i.test(item.name));
  const selected = views.find((item) => item.name === activeName)
    || views.find((item) => item.name === data?.preview?.name)
    || views.find((item) => item.name === data?.entryFile)
    || views[0];
  const entry = selected?.name || data?.entryFile;
  const document = selected && (selected.document || ['pptx', 'docx', 'xlsx'].includes(String(selected.kind).toLowerCase()));
  // Run private student code in the existing opaque-origin sandbox, with network access blocked.
  const html = data?.source === 'VIBECODING' && entry && !document
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">${buildPreviewDocument(files, entry)}`
    : '';
  return <Modal title={`只读作品 · ${work.title || '未命名作品'}`} wide onClose={onClose}
    footer={<button className="secondary-button" onClick={onClose}>关闭预览</button>}>
    {detail.loading ? <Loading label="正在读取私有作品…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : data ? <>
      <p className="muted">{data.studentName || '—'} · {formatDate(data.submittedAt)}</p>
      {imageError ? <Notice tone="warning">{imageError}</Notice> : null}
      {data.source === 'CANVAS' ? data.canvasSnapshot
        ? <CanvasEditor key={data.id} initialSnapshot={data.canvasSnapshot} readOnly showStarter={false} resolveAssetUrl={snapshotImage} />
        : <Empty title="暂无画布快照" />
        : <div data-console="vibecoding" className="classroom-work-preview">
          {views.length > 1 ? <label>作品文件<select value={entry || ''} onChange={(event) => setActiveName(event.target.value)}>
            {views.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select></label> : null}
          {document ? <ReplayDocument artifact={{ ...selected, content: String(files[selected.name] ?? selected.content ?? '') }} resolveImage={(slide, slideIndex) => {
            const generated = selected.generatedImages?.find((item) => Number(item.slideIndex) === slideIndex && !item.error && images[item.fileId]);
            if (generated && images[generated.fileId]) return images[generated.fileId];
            const ordinal = Number(slide?.image?.attachment ?? slide?.imageAttachment);
            const attachment = ordinal > 0 && selected.attachmentImages?.find((item) => Number(item.index) === ordinal && images[item.fileId]);
            if (attachment) return images[attachment.fileId];
            // Embedded HTML images have only fileId; use explicit snapshot references, never an arbitrary image.
            const reference = typeof slide?.image === 'string' ? slide.image : slide?.image?.url || slide?.image?.src;
            const embedded = selected.embeddedImages?.find((item) => item.fileId === slide?.image?.fileId && images[item.fileId]);
            return (embedded && images[embedded.fileId]) || snapshotImage(reference);
          }} />
            : entry && Object.hasOwn(files, entry) ? <>
              <Notice tone="info">外部网络资源已禁用；依赖 CDN 或在线接口的内容可能无法运行。</Notice>
              <ReplayPreview html={html} title={data.title || '课堂作品'} />
            </> : <Empty title="暂无可预览产物" />}
          <details className="top-gap"><summary>查看作品源文件</summary><ReplayFiles files={files} entryFile={entry} /></details>
        </div>}
    </> : null}
  </Modal>;
}

export function Classrooms({ api, user }) {
  const isAdmin = user.role === 'ORG_ADMIN';
  const navigate = useNavigate();
  const { sessionId: openId = '' } = useParams();
  const [status, setStatus] = useState('');
  const [days, setDays] = useState('90');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [titleDraft, setTitleDraft] = useState('');
  const [swapForm, setSwapForm] = useState({ seriesId: '', lessonId: '' });
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const [picked, setPicked] = useState([]);
  const [search, setSearch] = useState('');
  const query = new URLSearchParams({ days });
  if (status) query.set('status', status);
  const list = useData(() => api.get('org/sessions?' + query), [api, status, days]);
  const sessions = list.data?.items || [];
  const ongoingSession = !isAdmin ? list.data?.ongoingSession : null;
  const detail = useData(() => openId ? api.get('org/sessions/' + encodeURIComponent(openId)) : Promise.resolve(null), [api, openId, list.data]);
  // Never authorize a detail operation from the list or a previous route's response.
  const current = !detail.loading && !detail.error && detail.data?.id === openId ? detail.data : null;
  const permissions = current?.permissions || {};
  const canManage = permissions.canManage === true;
  const allowed = (key) => canManage && permissions[key] === true;
  const canAdd = allowed('canAddStudents') && ['PENDING', 'ACTIVE'].includes(current?.status);
  const candidates = useData(() => canAdd ? api.get(`org/sessions/${encodeURIComponent(openId)}/candidates`) : Promise.resolve(null), [api, openId, canAdd, current?.lessonId]);
  const candidatesReady = canAdd && !candidates.loading && !candidates.error && candidates.data?.sessionId === openId && candidates.data?.lessonId === current?.lessonId;
  const selectable = candidatesReady ? candidates.data.selectable || [] : [];
  const blocked = candidatesReady ? candidates.data.blocked || [] : [];
  const matches = (item) => `${item.name || ''} ${item.login || ''}`.toLowerCase().includes(search.trim().toLowerCase());
  const visibleSelectable = selectable.filter(matches);
  const visibleBlocked = blocked.filter(matches);
  const summary = current?.studentSummary || {};
  const roster = current?.students || [];
  const terminal = ['ENDED', 'DISSOLVED'].includes(current?.status);
  const series = useData(() => api.get('org/course-series?limit=200'), [api]);
  const seriesItems = series.data?.items || [];
  const teachers = useData(() => isAdmin ? api.get('org/users?role=TEACHER') : Promise.resolve({ items: [] }), [api, isAdmin]);
  const lessonsFor = (id) => (seriesItems.find((item) => item.id === id)?.lessons || []).filter((item) => item.status === 'PUBLISHED');
  const lessonOptions = lessonsFor(form.seriesId);
  const selectedLesson = lessonOptions.find((item) => item.id === form.lessonId);
  const swapLessons = lessonsFor(swapForm.seriesId);
  const swapLesson = swapLessons.find((item) => item.id === swapForm.lessonId);
  const swapModes = publishedModes(swapLesson);
  const lessonChanged = Boolean(swapLesson && swapLesson.id !== current?.lessonId);
  const mustClearStudents = lessonChanged && Number(summary.total || 0) > 0;
  const titleValidation = !titleDraft.trim() ? '课堂名称不能为空。' : titleDraft.trim() === current?.title?.trim() ? '名称没有变化。' : '';
  const swapValidation = !swapLesson ? '请选择已发布的课程。'
    : !swapModes.includes(swapForm.deliveryMode) ? '请选择该课程已发布的课堂环境。'
    : !lessonChanged && swapForm.deliveryMode === current?.deliveryMode ? '课程和环境均没有变化。'
    : mustClearStudents && !clearConfirmed ? '请明确确认清空当前名单。' : '';

  useEffect(() => { setPicked([]); }, [openId, candidates.data, candidates.loading, current?.lessonId]);
  useEffect(() => { setModal(null); setPicked([]); setSearch(''); setError(''); }, [openId]);

  function openSession(id) {
    navigate('/classrooms/' + encodeURIComponent(id), { state: { fromClassroomList: true } });
    setPicked([]); setMessage(''); setError('');
  }
  function closeSession() {
    if (busyRef.current) return;
    if (window.history.state?.usr?.fromClassroomList) navigate(-1);
    else navigate('/classrooms', { replace: true });
  }
  function showModal(value) { setError(''); setModal(value); }
  function closeModal() { if (!busyRef.current) { setModal(null); setError(''); } }

  async function run(action, fallback = '操作完成。', permission = 'canManage') {
    if (busyRef.current) return;
    if (permission && !allowed(permission)) { setError('课堂详情未就绪或当前操作无权限，请刷新后重试。'); return; }
    busyRef.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const feedback = await action();
      setMessage(typeof feedback === 'string' ? feedback : fallback);
      setPicked([]);
      await list.refresh();
      if (openId) await detail.refresh();
    } catch (err) {
      setError(err.message || '操作失败，请重试。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function createSession() {
    if (!selectedLesson || series.loading || series.error) { setError('请选择有效的已发布课程。'); return; }
    await run(async () => {
      const created = await api.post('org/sessions', { lessonId: form.lessonId, title: form.title.trim() || undefined, deliveryMode: form.deliveryMode, ...(isAdmin && form.teacherId ? { teacherId: form.teacherId } : {}) });
      setModal(null); setForm(emptyForm); openSession(created?.id || '');
    }, '课堂已创建，添加学员后即可开始上课。', null);
  }
  async function addStudents() {
    if (!candidatesReady || !picked.length || picked.some((id) => !selectable.some((item) => item.id === id))) { setError('候选名单已变化，请刷新并重新勾选学员。'); return; }
    await run(async () => {
      const result = await api.post(`org/sessions/${encodeURIComponent(openId)}/students`, { studentIds: picked });
      const skipped = result?.skipped?.length || 0;
      return `已加入 ${result?.added?.length || 0} 名学员。${skipped ? `跳过 ${skipped} 人，候选状态已变化。` : ''}`;
    }, '', 'canAddStudents');
  }
  async function saveTitle() {
    if (titleValidation) { setError(titleValidation); return; }
    await run(async () => {
      await api.put(`org/sessions/${encodeURIComponent(openId)}`, { title: titleDraft.trim() });
      setModal(null);
    }, '课堂名称已更新。', 'canEdit');
  }
  async function swapLessonSubmit() {
    if (swapValidation) { setError(swapValidation); return; }
    await run(async () => {
      await api.put(`org/sessions/${encodeURIComponent(openId)}`, {
        lessonId: swapForm.lessonId,
        deliveryMode: swapForm.deliveryMode,
        confirmClearStudents: mustClearStudents && clearConfirmed,
      });
      setModal(null); setPicked([]); setSearch('');
    }, lessonChanged ? '课程与环境已更新，请重新添加学员。' : '课堂环境已更新，学员名单保持不变。', 'canEdit');
  }
  async function actAndClose() {
    const kind = modal?.kind;
    const permission = { remove: 'canRemoveStudents', start: 'canStart', end: 'canEnd', dissolve: 'canDissolve' }[kind];
    if (!permission) return;
    await run(async () => {
      if (kind === 'remove') {
        if (current?.status !== 'PENDING' || !modal.student?.studentId) throw new Error('当前不能移除该学员，请刷新名单。');
        await api.delete(`org/sessions/${encodeURIComponent(openId)}/students/${encodeURIComponent(modal.student.studentId)}`);
      } else {
        await api.post(`org/sessions/${encodeURIComponent(openId)}/${kind}`);
      }
      setModal(null);
    }, { remove: '学员已移除，可以被其他课堂添加。', start: '课堂已开始。', end: '课堂已结束，完课结果已结算。', dissolve: '课堂已解散，学员已解除占用。' }[kind], permission);
  }

  const actionCopy = {
    remove: ['确认移除学员？', `将 ${modal?.student?.studentName || modal?.student?.studentLogin || '该学员'} 移出当前课堂，保留历史记录并解除课堂占用。`, '确认移除'],
    start: ['确认开始上课？', `名单上的 ${summary.pending ?? 0} 名学员将可进入操作环境。开始之后不能再移除学员。`, '确认开始'],
    end: ['确认结束课堂？', '按结课时已记录的真实成功 AI 调用结算完课结果。结束后课堂只读，完课结果固定；迟到回执仅计入用量账目，不改变完课结果。', '确认结束'],
    dissolve: ['确认解散课堂？', '当前名单将全部置为被移除并解除占用，课堂保留只读历史。', '确认解散'],
  };
  const confirmCopy = actionCopy[modal?.kind];

  return <div className="classrooms-page">
    {openId ? <nav aria-label="面包屑" className="breadcrumb row-actions"><button className="text-button" disabled={busy} onClick={closeSession}>课堂</button><span>/</span><span>{current?.title || '课堂详情'}</span></nav> : null}
    <PageHeader eyebrow="开课与上课" title={openId ? '课堂详情' : '课堂'} description={openId ? undefined : '创建课堂、组织学员与查看课堂记录。'} actions={<>
      {!openId ? <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="按状态筛选"><option value="">全部状态</option>{Object.entries(SESSION_STATE).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select> : null}
      <button className="secondary-button" disabled={busy || list.loading || (Boolean(openId) && detail.loading)} onClick={() => { setPicked([]); list.refresh(); }}>刷新</button>
      {!openId ? <button className="primary-button" disabled={busy || list.loading || Boolean(ongoingSession)} onClick={() => showModal({ kind: 'create' })}>创建课堂</button> : null}
    </>} />
    {!openId && ongoingSession ? <Notice tone="info">当前课堂：{ongoingSession.title} · {SESSION_STATE[ongoingSession.status]?.label}<button className="text-button" onClick={() => openSession(ongoingSession.id)}>查看当前课堂</button></Notice> : null}
    {message ? <div role="status"><Notice tone="success">{message}</Notice></div> : null}
    {error && !modal ? <div role="alert"><Notice tone="danger">{error}</Notice></div> : null}
    {!openId ? <>
      <div className="metrics">{Object.entries(SESSION_STATE).map(([key, item]) => <MetricCard key={key} label={item.label} value={sessions.filter((session) => session.status === key).length} hint={`近 ${days} 天`} />)}</div>
      <Panel title={`课堂列表（近 ${days} 天）`} actions={<select value={days} onChange={(event) => setDays(event.target.value)} aria-label="时间范围">{['7', '30', '90', '365'].map((value) => <option key={value} value={value}>近 {value} 天</option>)}</select>}>
        {list.loading ? <Loading label="正在读取课堂…" /> : list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : sessions.length ? <div className="table-wrap"><table>
          <thead><tr><th>课堂</th><th>课包 / 课时</th><th>老师</th><th>状态</th><th>学员</th><th>时间</th><th /></tr></thead>
          <tbody>{sessions.map((item) => <tr key={item.id}>
            <td><strong>{item.title || '未命名课堂'}</strong><div className="muted">{DELIVERY_LABEL[item.deliveryMode]}</div></td>
            <td>{item.seriesTitle || '—'}<div className="muted">{item.lessonTitle || '—'}</div></td><td>{item.teacherName || '—'}</td>
            <td><StateBadge value={item.status} /></td><td>{item.studentCount ?? 0}<div className="muted">完课 {item.completedCount ?? 0}</div></td>
            <td>{formatDate(item.startedAt || item.createdAt)}</td><td><button className="text-button" onClick={() => openSession(item.id)}>查看详情</button></td>
          </tr>)}</tbody>
        </table></div> : <Empty title="还没有课堂" body="创建课堂后可添加学员。" />}
      </Panel>
    </> : <Panel title={current?.title || '课堂详情'} actions={<div className="row-actions">
      {previewHref(current?.coursewareUrl) ? <a className="secondary-button" href={current.coursewareUrl} target="_blank" rel="noreferrer">查看课件</a> : null}
      {current?.status === 'PENDING' && allowed('canEdit') ? <>
        <button className="secondary-button" disabled={busy} onClick={() => { setTitleDraft(current.title || ''); showModal({ kind: 'title' }); }}>编辑名称</button>
        <button className="secondary-button" disabled={busy} onClick={() => {
          setSwapForm({ seriesId: current.seriesId || '', lessonId: current.lessonId || '', deliveryMode: current.deliveryMode || '' });
          setClearConfirmed(false);
          showModal({ kind: 'swap' });
        }}>更换课程与环境</button>
      </> : null}
      {allowed('canStart') && current?.status === 'PENDING' ? <button className="primary-button" disabled={busy || !summary.pending} onClick={() => showModal({ kind: 'start' })}>开始上课</button> : null}
      {allowed('canDissolve') && current?.status === 'PENDING' ? <button className="secondary-button" disabled={busy} onClick={() => showModal({ kind: 'dissolve' })}>解散课堂</button> : null}
      {allowed('canEnd') && current?.status === 'ACTIVE' ? <button className="primary-button" disabled={busy} onClick={() => showModal({ kind: 'end' })}>结束课堂</button> : null}
      <button className="secondary-button" disabled={busy} onClick={closeSession}>返回列表</button>
    </div>}>
      {detail.loading || (!detail.error && !current) ? <Loading label="正在读取课堂详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : <>
        <div className="row-actions"><StateBadge value={current.status} /><span>{DELIVERY_LABEL[current.deliveryMode]}</span><span>{current.seriesTitle} · {current.lessonTitle}</span><span className="muted">负责老师：{current.teacherName || '—'}</span></div>
        {!canManage && !terminal ? <Notice tone="info">只读课堂：仅负责老师可以管理此课堂。</Notice> : null}
        {current.status === 'PENDING' && canManage && !summary.pending ? <Notice tone="warning">名单为空，添加学员后才能开始上课。</Notice> : null}
        {current.status === 'ACTIVE' ? <Notice tone="info">课堂进行中，开始后不可移除学员。最近活动来自真实记录，不代表学员当前在线。</Notice> : null}
        {terminal ? <Notice tone="info">{current.status === 'ENDED' ? '课堂已结束，完课结果固定。结课时已记录的真实成功 AI 调用计入完课，零费用也计入；迟到回执仅计入用量账目。' : '课堂已解散，学员占用已解除。'} 结果、作品与事件均为只读记录。</Notice> : null}
        <dl className="classroom-runtime">
          <div><dt>课堂时长</dt><dd><Duration runtime={current.runtime || { startedAt: current.startedAt, endedAt: current.endedAt }} status={current.status} /></dd></div>
          <div><dt>开始时间</dt><dd>{formatDate(current.runtime?.startedAt || current.startedAt)}</dd></div>
          <div><dt>{terminal ? '结束时间' : '最近活动'}</dt><dd>{formatDate(terminal ? current.runtime?.endedAt || current.endedAt : current.runtime?.lastActivityAt)}</dd></div>
          <div><dt>课堂 AI 使用</dt><dd><AiUsage ai={current.runtime?.ai} /></dd></div>
        </dl>
        <section className="classroom-section">
          <h3>学员名单 · {summary.total ?? 0} 人</h3>
          <p className="muted">完课 {summary.completed ?? 0} · 未完课 {summary.incomplete ?? 0} · 已移除 {summary.removed ?? 0}</p>
          {roster.length ? <div className="table-wrap"><table>
            <thead><tr><th>学员</th><th>状态 / 结果</th><th>AI 使用</th><th>最近活动</th><th>作品</th><th>加入时间</th><th /></tr></thead>
            <tbody>{roster.map((student) => <tr key={student.id}>
              <td><strong>{student.studentName || student.studentLogin}</strong><div className="muted">{student.studentLogin}</div></td>
              <td><StateBadge value={student.status} map={STUDENT_STATE} />{student.removedReason ? <div className="muted">{removedReasonLabel(student.removedReason)}</div> : null}{student.completedAt ? <div className="muted">{formatDate(student.completedAt)}</div> : null}</td>
              <td><AiUsage ai={student.ai} /></td><td>{student.lastActivityAt ? formatDate(student.lastActivityAt) : '暂无活动记录'}</td><td>{student.workCount ?? '—'}</td>
              <td>{formatDate(student.addedAt)}</td><td>{allowed('canRemoveStudents') && current.status === 'PENDING' && student.status !== 'REMOVED' ? <button className="text-button" disabled={busy} onClick={() => showModal({ kind: 'remove', student })}>移除</button> : <span className="muted">只读</span>}</td>
            </tr>)}</tbody>
          </table></div> : <Empty title="暂无学员" body={canAdd ? '从下方候选名单中添加学员。' : '此课堂没有学员记录。'} />}
        </section>
        {canAdd ? <section className="classroom-section">
          <div className="row-actions"><h3>添加学员</h3><input type="search" aria-label="搜索候选学员" placeholder="搜索姓名或账号" value={search} disabled={busy} onChange={(event) => setSearch(event.target.value)} /><button className="text-button" disabled={busy || candidates.loading} onClick={() => { setPicked([]); candidates.refresh(); }}>刷新候选</button></div>
          {candidates.loading ? <Loading label="正在读取候选人…" /> : candidates.error ? <ErrorState error={candidates.error} onRetry={candidates.refresh} /> : <div className="classroom-candidates">
            <div><div className="row-actions"><h4>可加（{visibleSelectable.length}）</h4><button className="text-button" disabled={busy || !visibleSelectable.length} onClick={() => setPicked(visibleSelectable.every((item) => picked.includes(item.id)) ? picked.filter((id) => !visibleSelectable.some((item) => item.id === id)) : [...new Set([...picked, ...visibleSelectable.map((item) => item.id)])])}>全选 / 取消当前结果</button></div>
              {visibleSelectable.length ? visibleSelectable.map((student) => <label key={student.id} className="classroom-candidate"><input type="checkbox" disabled={busy} checked={picked.includes(student.id)} onChange={(event) => setPicked((old) => event.target.checked ? [...old, student.id] : old.filter((id) => id !== student.id))} /><strong>{student.name || student.login}</strong><span className="muted">{student.login}</span></label>) : <p className="muted">{search ? '没有匹配的可加学员。' : '暂无可加学员，请检查课包许可和课堂占用。'}</p>}
              <button className="primary-button top-gap" disabled={busy || !candidatesReady || !picked.length} onClick={addStudents}>加入课堂（已选 {picked.length} 人）</button>
            </div>
            <div><h4>不可加（{visibleBlocked.length}）</h4>{visibleBlocked.length ? visibleBlocked.map((student) => <div key={student.id} className="classroom-blocked"><strong>{student.name || student.login}</strong><span className="muted"> · {student.login}</span><p>{student.reasonText || '不可加入'}</p>{student.session?.title ? <small className="muted">占用课堂：{student.session.title} · {student.session.teacherName || '未知老师'}</small> : null}</div>) : <p className="muted">没有匹配的不可加学员。</p>}</div>
          </div>}
        </section> : null}
        <section className="classroom-section"><h3>课堂作品（{current.works?.length ?? 0}）</h3>
          {current.works?.length ? <div className="table-wrap"><table>
            <thead><tr><th>作品</th><th>学员</th><th>类型</th><th>状态</th><th>更新时间</th><th /></tr></thead>
            <tbody>{current.works.map((work) => <tr key={work.source + work.id}>
              <td>{work.title || '未命名作品'}</td><td>{work.studentName || '—'}</td>
              <td>{DELIVERY_LABEL[work.source] || work.source}</td><td>{work.status}</td>
              <td>{formatDate(work.updatedAt || work.submittedAt || work.createdAt)}</td>
              <td>{['CANVAS', 'VIBECODING'].includes(work.source)
                ? <button className="text-button" onClick={() => showModal({ kind: 'work', work })}>查看作品</button>
                : <span className="muted">暂不支持预览</span>}</td>
            </tr>)}</tbody>
          </table></div> : <p className="muted">暂无作品记录。</p>}
        </section>
        <section className="classroom-section"><h3>课堂事件</h3>{current.events?.length ? <ol className="classroom-events">{current.events.map((event) => <li key={event.id}><time>{formatDate(event.createdAt)}</time><div><strong>{event.summary || event.action}</strong><p className="muted">{event.actorName || '系统'}</p></div></li>)}</ol> : <p className="muted">暂无事件记录。</p>}</section>
      </>}
    </Panel>}

    {modal?.kind === 'work' ? <ClassroomWork api={api} sessionId={openId} work={modal.work} onClose={closeModal} /> : null}
    {modal?.kind === 'title' ? <Modal title="编辑课堂名称" busy={busy} error={error} onClose={closeModal} footer={<><button className="secondary-button" onClick={closeModal}>取消</button><button className="primary-button" disabled={!allowed('canEdit') || Boolean(titleValidation)} onClick={saveTitle}>{busy ? '保存中…' : '保存名称'}</button></>}>
      <label>课堂名称<input value={titleDraft} maxLength={120} onChange={(event) => setTitleDraft(event.target.value)} /></label>{titleValidation ? <p className="muted">{titleValidation}</p> : null}
    </Modal> : null}
    {modal?.kind === 'swap' ? <Modal title="更换课程与环境" description="同一课程切换环境保留学员名单；更换课程则清空名单并保留移除记录。" busy={busy} error={error || series.error?.message} onClose={closeModal} footer={<><button className="secondary-button" onClick={closeModal}>取消</button><button className="primary-button" disabled={!allowed('canEdit') || series.loading || Boolean(series.error) || Boolean(swapValidation)} onClick={swapLessonSubmit}>{busy ? '更换中…' : '确认更换'}</button></>}>
      <label>课包<SearchSelect ariaLabel="更换课包" value={swapForm.seriesId} options={seriesItems} getLabel={(item) => item.title} onChange={(seriesId) => {
        setSwapForm({ seriesId, lessonId: '', deliveryMode: '' });
        setClearConfirmed(false);
      }} /></label>
      <label>课程<select value={swapForm.lessonId} disabled={!swapForm.seriesId} onChange={(event) => {
        const lesson = swapLessons.find((item) => item.id === event.target.value);
        setSwapForm({ ...swapForm, lessonId: event.target.value, deliveryMode: lesson?.id === current?.lessonId ? current.deliveryMode : lesson?.deliveryMode || '' });
        setClearConfirmed(false);
      }}>
        <option value="">请选择课程</option>
        {swapLessons.map((lesson) => <option key={lesson.id} value={lesson.id}>第 {lesson.sort} 节 · {lesson.title}</option>)}
      </select></label>
      {swapLesson ? <label>课堂环境<select value={swapForm.deliveryMode || ''} onChange={(event) => setSwapForm({ ...swapForm, deliveryMode: event.target.value })}>
        <option value="" disabled>请选择已发布环境</option>
        {swapModes.map((mode) => <option key={mode} value={mode}>{DELIVERY_LABEL[mode]}</option>)}
      </select></label> : null}
      {swapLesson && !lessonChanged ? <p className="muted">仅切换环境，当前学员名单保持不变。</p> : null}
      {mustClearStudents ? <label className="classroom-candidate"><input type="checkbox" checked={clearConfirmed} onChange={(event) => setClearConfirmed(event.target.checked)} /><span>我确认清空当前 {summary.total} 人名单，更换后重新添加学员。</span></label> : null}
      {swapValidation ? <p className="muted">{swapValidation}</p> : null}
      {series.loading ? <Loading label="正在读取课程…" /> : null}
    </Modal> : null}
    {modal?.kind === 'create' ? <Modal title="创建课堂" busy={busy} error={error || series.error?.message || teachers.error?.message} onClose={closeModal} footer={<><button className="secondary-button" onClick={closeModal}>取消</button><button className="primary-button" disabled={!selectedLesson || series.loading || Boolean(series.error)} onClick={createSession}>{busy ? '创建中…' : '创建课堂'}</button></>}>
      <label>课包<SearchSelect ariaLabel="搜索课包" value={form.seriesId} options={seriesItems} placeholder="请选择课包" getLabel={(item) => item.title} onChange={(seriesId) => setForm({ ...form, seriesId, lessonId: '', deliveryMode: 'CANVAS' })} /></label>
      {series.loading ? <Loading label="正在读取课程…" /> : null}
      {!series.loading && !seriesItems.length ? <Notice tone="warning">本机构暂无已授权课包。</Notice> : null}
      <label>第几节课<select value={form.lessonId} disabled={!form.seriesId} onChange={(event) => { const lesson = lessonOptions.find((item) => item.id === event.target.value); setForm({ ...form, lessonId: event.target.value, deliveryMode: lesson?.deliveryMode || 'CANVAS' }); }}><option value="">请选择课程</option>{lessonOptions.map((lesson) => <option key={lesson.id} value={lesson.id}>第 {lesson.sort} 节 · {lesson.title}</option>)}</select></label>
      {selectedLesson ? <label>课堂模式<select value={form.deliveryMode} onChange={(event) => setForm({ ...form, deliveryMode: event.target.value })}>{(selectedLesson.deliveryModes?.length ? selectedLesson.deliveryModes : [selectedLesson.deliveryMode || 'CANVAS']).map((mode) => <option key={mode} value={mode}>{DELIVERY_LABEL[mode] || mode}</option>)}</select></label> : null}
      {isAdmin ? <label>负责老师<SearchSelect ariaLabel="搜索负责老师" value={form.teacherId} options={teachers.data?.items || []} placeholder="挂在我自己名下" getLabel={(item) => item.displayName || item.login} onChange={(teacherId) => setForm({ ...form, teacherId })} /></label> : null}
      <label>课堂名称（可留空）<input value={form.title} maxLength={120} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="留空自动生成" /></label>
      <p className="muted">仅负责老师可以管理课堂；机构管理员查看其他老师课堂时为只读。</p>
    </Modal> : null}
    {confirmCopy ? <Modal title={confirmCopy[0]} description={confirmCopy[1]} busy={busy} error={error} onClose={closeModal} footer={<><button className="secondary-button" onClick={closeModal}>取消</button><button className="primary-button" disabled={!allowed({ remove: 'canRemoveStudents', start: 'canStart', end: 'canEnd', dissolve: 'canDissolve' }[modal.kind])} onClick={actAndClose}>{busy ? '处理中…' : confirmCopy[2]}</button></>}>
      <div className="row-actions"><StateBadge value={current?.status} /><span>{current?.title} · {current?.lessonTitle}</span></div>
    </Modal> : null}
  </div>;
}
